"use strict";

/**
 * plugins.js —— 把**随包分发**的客户端插件"内置"进 DSH profile
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ══════════════════════════════════════════════════════════════════
 *
 * 用户拿到 exe 装完，客户端里**必须已经有我们的插件** —— 不能让用户
 * 自己敲 pnpm / 改 profile / 建联接。原来唯一的安装途径是
 * `scripts/install-plugin.js`，而它写进 profile 的是
 *
 *     "dsh-multi-session": "link:D:\\deepseek-workspace\\5.DSH集成桌面端\\plugin\\dsh-multi-session"
 *
 * 那是**开发机上的绝对路径** —— 别人机器上根本不存在 ⇒ 装完什么插件都没有
 * （插件确实随包发布，但落在 app.asar 里，且没有任何东西把它接进 profile）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 契约：和 install-plugin.js 一字不差的三处，漏一处就"文件都在、界面什么都没有"
 * ══════════════════════════════════════════════════════════════════
 *
 *   ① profile/package.json → dependencies[name] = "link:<dest>"
 *   ② profile/package.json → dsh.profile.bundles 里含 name
 *      （内核只在 `dsh plugin` 成功时才自动重建这个列表；手写的会被原样尊重）
 *   ③ profile/node_modules/<name> 真的指向那个包（目录联接）
 *
 * ══════════════════════════════════════════════════════════════════
 * 打包 / 开发的差别（**刻意不一样**）
 * ══════════════════════════════════════════════════════════════════
 *
 *   · 打包后（app.isPackaged）
 *       srcRoot = <resources>/plugins     ← electron-builder 的 extraResources 放出来的**真实目录**
 *       插件**复制**到 <dshHome>/plugins/<name>，profile 的 link 指向**那里**。
 *       ⇒ 与应用安装目录彻底解耦：装完即用；应用升级/卸载都不会把插件带走或留成死链。
 *       （直接 link 进 resources/ 也能跑，但应用一卸载联接就悬空、内核直接解析不到包。）
 *
 *   · 未打包（开发）
 *       srcRoot = <仓库>/plugin，**直接挂仓库目录** —— 改源码即时生效，
 *       也就是 install-plugin.js 一贯的行为。开发机上不会被内置逻辑悄悄改写。
 *
 * ══════════════════════════════════════════════════════════════════
 * 安全边界
 * ══════════════════════════════════════════════════════════════════
 *
 *   · **只碰我们随包分发的插件**：dependencies / bundles / node_modules 里
 *     其它条目一个字节都不动。
 *   · 改 profile package.json 前**必先备份**到 <dshHome>/safety/plugin-provision-backup/<时间戳>/。
 *   · 目标已存在但不是我们的联接时，**默认拒绝覆盖**（真实目录只在名字恰好是我们分发的
 *     插件名时才替换 —— 那种情况只可能是上一版脚本的"退回复制"遗留）。
 *   · **幂等**：第二次跑必须 changed=[]（有断言脚本 provision-check.js 盯着这一条）。
 *   · **绝不重启内核** —— 重启由调用方（main.js）决定；本模块只改磁盘。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

/** 记录"这份副本是从哪来的"的状态文件（放在 plugins 目录下，**不放进插件目录本身**，
 *  否则会污染内容指纹 ⇒ 每次启动都判定"变了"，永远重装）。 */
const STATE_FILE = ".provisioned.json";

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function readJson(p) {
  try {
    let raw = fs.readFileSync(p, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 剥 BOM（PowerShell 写过的 JSON 会带）
    return JSON.parse(raw);
  } catch { return null; }
}

/**
 * 目录内容指纹：相对路径 + 内容，按路径排序后一起 sha256。
 *
 * 为什么不用 mtime：拷来拷去 mtime 会变，用它判"变没变"必然误报。
 * 为什么跳过 node_modules：我们的插件是零依赖的，真有 node_modules 也不该参与判定
 * （pnpm 生成的软链在不同机器上形态不同）。
 */
function fingerprint(dir) {
  if (!isDir(dir)) return null;
  const files = [];
  (function walk(cur) {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(cur, e.name);
      // ★ 与 listBundledPlugins 同一个坑：Dirent 对联接 isDirectory()=false。
      //   指纹必须用**跟随联接**的 statSync 判，否则联接里的文件一个都不进指纹
      //   ⇒ 内容变了判不出"变了"，落位逻辑会漏更新。
      if (isDir(p)) {
        if (e.name !== "node_modules") walk(p);
      } else if (isFile(p)) {
        files.push(p);
      }
    }
  })(dir);

  const h = crypto.createHash("sha256");
  for (const f of files) {
    h.update(path.relative(dir, f).replace(/\\/g, "/"));
    h.update("\0");
    try { h.update(fs.readFileSync(f)); } catch { h.update("<unreadable>"); }
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * 列出随包分发的插件：目录里有 package.json，且 `dsh` 里声明了 bundle 或 client。
 * 以 `_` 或 `.` 开头的目录跳过（`_retired` 就是这么被排除的）。
 */
function listBundledPlugins(srcRoot) {
  const out = [];
  if (!isDir(srcRoot)) return out;
  let entries;
  try { entries = fs.readdirSync(srcRoot, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
    // ★ 目录联接（junction）必须**当成目录**，不能信 Dirent。
    //   实测（2026-09-21，本机 node 24）：readdirSync 的 Dirent 对联接返回
    //     isDirectory()=false / isSymbolicLink()=true
    //   而 lstatSync 同样 isDirectory()=false —— 只有 statSync（跟随联接）才是 true。
    //   原写法 `!e.isDirectory()` 会因此把"本体在别处、这里只留联接"的插件
    //   **整批静默跳过** ⇒ 打包版里少插件，且不报错。
    //   活例：plugin/dsh-archive-manager 是联接 → D:\DSH工作区002\2.归档管理器。
    if (!isDir(path.join(srcRoot, e.name))) continue;
    const dir = path.join(srcRoot, e.name);
    const j = readJson(path.join(dir, "package.json"));
    if (!j) continue;
    const dsh = j.dsh || {};
    if (!dsh.bundle && !dsh.client) continue;
    out.push({ name: j.name || e.name, dir, version: j.version || "0.0.0", pkg: j });
  }
  return out;
}

/** 该路径现在指向哪（联接会解析到真实目录）；不是联接/不存在返回 null。 */
function linkTarget(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * 保证 <linkPath> 是一个指向 <target> 的目录联接。
 * 返回 true = 这次动过手（新建 / 修好）。
 */
function ensureJunction(linkPath, target, { ownNames = [] } = {}) {
  const cur = linkTarget(linkPath);
  if (samePath(cur, target)) return false;

  if (cur || fs.existsSync(linkPath)) {
    let st = null;
    try { st = fs.lstatSync(linkPath); } catch { /* 下面按"不存在"处理 */ }
    const isLink = !!st && (st.isSymbolicLink() || !!st.isSymbolicLink());
    const name = path.basename(linkPath);
    const ours = ownNames.includes(name);
    // 真实目录只在"名字恰好是我们分发的插件"时才敢替换（上一版的退回复制遗留）
    if (!isLink && !ours) {
      throw new Error(`node_modules\\${name} 已存在且不是联接（真实目录）——拒绝覆盖`);
    }
    fs.rmSync(linkPath, { recursive: true, force: true });
  }

  const r = spawnSync("cmd", ["/c", "mklink", "/J", linkPath, target], {
    encoding: "utf8", windowsHide: true,
  });
  if (r.status !== 0 || !linkTarget(linkPath)) {
    // 退路：复制（与 install-plugin.js 同一套退路）
    fs.rmSync(linkPath, { recursive: true, force: true });
    // ★ dereference 同上：target 可能是联接（本体在别的工作区），默认 cpSync 会 EPERM。
    fs.cpSync(target, linkPath, { recursive: true, dereference: true });
    return true;
  }
  return true;
}

/**
 * 物化时**必须**排除的路径（与打包流程的排除规则一一对应）。
 * 定义在这里而不是打包脚本里，是为了让"打包产物该有什么"只有一处定义。
 *
 * ⚠️ 这份清单与 `scripts/materialize-plugins.js` 的调用点绑在一起 ——
 * 打包的 extraResources 现在读 `runtime/materialized-plugins`，
 * 排除**只在这里做**（见 materialize-plugins.js 文件头）。
 */
const DEFAULT_EXCLUDES = [
  "_retired", "_retired/**",
  "**/.gradle/**", "**/android/build/**", "**/android/app/build/**",
];

/**
 * 路径是否命中排除规则。
 *
 * 为什么不直接用 `minimatch`：`src/plugins.js` 会被打包版在**运行时** require
 * （src/main.js → provision），而 build.files 里排除了整个 node_modules
 * 且 dependencies 为空 ⇒ 打包产物里**没有** minimatch，顶层 require 会直接
 * ERR_MODULE_NOT_FOUND。所以这里自带一个极小的等价实现。
 */
function isExcluded(rel, globs = DEFAULT_EXCLUDES) {
  if (!rel || rel === "") return false;
  const r = rel.replace(/\\/g, "/");
  for (const raw of globs) {
    if (raw.startsWith("!")) continue;            // filter 里只用到排除项
    const g = raw.replace(/\\/g, "/");
    if (globToRegExp(g).test(r)) return true;
    // `android/build/**` 这类写法也要命中的**目录本身**（否则 cpSync 会照样走进去、
    // 建出一个空目录；更糟的是白白遍历那些 232 字符深的路径）
    if (g.endsWith("/**") && globToRegExp(g.slice(0, -3)).test(r)) return true;
  }
  return false;
}

/**
 * 把带 `*` / `**` 的模式转成正则。
 *
 * ★ `**` 的语义与 minimatch 一致：匹配**零个或多个**路径段
 *   （写成"至少一个"是本文件踩过的真错 —— 那样 `**\/android/build/**`
 *    就匹配不上 `android/build/x.txt`，排除规则整个失效）。
 */
function globToRegExp(pattern) {
  let rx = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i += 2;
        if (pattern[i] === "/") { i += 1; rx += "(?:.*/)?"; }   // `**/` 可匹配零段
        else { rx += ".*"; }
      } else {
        i += 1; rx += "[^/]*";
      }
    } else if (c === "?") {
      i += 1; rx += "[^/]";
    } else {
      rx += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp("^" + rx + "$");
}

/**
 * 物化：把 `plugin/` 里所有**目录联接**展开成真实目录，写到一个临时目录。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它（2026-09-21 实测，不是理论问题）
 * ══════════════════════════════════════════════════════════════════
 * 2026-09-21 起，插件的**本体搬到了第三工作区**（`D:\DSH工作区002\`），
 * 仓库里的 `plugin/<名字>` 只是一个 **Junction**。而 electron-builder 拷
 * `extraResources` 时用的 `copyDir` **不解引用联接** —— 它走的是
 * `lstat().isSymbolicLink()` 分支，把联接**原样重建**在产物里：
 *
 *   实测（用与 package.json **完全相同**的 filter 跑 builder-util 的 copyDir）：
 *     dest/dsh-mobile-remote 存在 = true
 *     它是符号链接（Junction）    = true
 *     → 指向 C:\Users\...\WORKSPACE3\1.手机遥控     ← **开发机专属绝对路径**
 *
 * ⇒ 别人装完，`<安装目录>\resources\plugins\<名字>` 是**指向我机器的死链**，
 *   落位逻辑一个插件都找不到，界面上什么都没有。
 *   （同一个坑 `provision-check.js` 第 ⑦ 段也踩到了：`fs.cpSync` 对联接默认抛 EPERM。）
 *
 * 所以打包**之前**先物化：只有这一处实现，`scripts/materialize-plugins.js` 与
 * `scripts/provision-check.js` 都调它，避免两处实现悄悄分叉。
 *
 * @param {string} srcRoot 仓库里的 `plugin/` 目录
 * @param {string} destRoot 目标目录（会被创建；调用方负责清理）
 * @param {string[]} [excludeGlobs] 排除规则（与 electron-builder 的 filter 同一套；
 *        物化必须**沿用**它，否则被排除的构建产物会被物化进来 ——
 *        实测 `dsh-mobile-remote` 5.18 MB / 179 文件里，有 4.04 MB / 141 个文件
 *        是 `android/build/**`，而那里有 **232 字符深**的路径，超过 Windows 260 的
 *        经典上限，`cpSync` 有真实失败风险，AGENTS.md §7 点过名）。
 * @returns {{ok:boolean, copied:string[], links:string[], errors:string[]}}
 *          `links` = 被解引用展开的联接名字（没物化到东西时就是空数组）
 */
function materializePlugins(srcRoot, destRoot, excludeGlobs = DEFAULT_EXCLUDES) {
  const out = { ok: true, copied: [], links: [], errors: [] };
  if (!isDir(srcRoot)) {
    out.ok = false;
    out.errors.push(`来源目录不存在：${srcRoot}`);
    return out;
  }
  const plugins = listBundledPlugins(srcRoot);
  fs.mkdirSync(destRoot, { recursive: true });
  for (const p of plugins) {
    const dest = path.join(destRoot, p.name);
    try {
      const st = fs.lstatSync(p.dir);
      if (st.isSymbolicLink()) out.links.push(p.name);
      // dereference:true —— 联接（和符号链接）都按真实目录展开
      fs.cpSync(p.dir, dest, {
        recursive: true,
        dereference: true,
        filter: (src) => !isExcluded(path.relative(p.dir, src), excludeGlobs),
      });
      out.copied.push(p.name);
    } catch (e) {
      out.ok = false;
      out.errors.push(`${p.name}: ${(e && e.message) || e}`);
    }
  }
  return out;
}

/** 原子替换目录：先拷到同级 .tmp 再改名（中途失败不会留下半个插件）。 */
function replaceDir(src, dest) {
  const tmp = dest + ".tmp-" + process.pid + "-" + Date.now();
  fs.rmSync(tmp, { recursive: true, force: true });
  // ★ `dereference: true` 是必需的，不是优化。
  //   实测（2026-09-21，本机 node 24）：源目录若是**目录联接**（本体在别的盘/工作区，
  //   这里只留一个 junction），`fs.cpSync` **默认直接抛 EPERM**；加了 dereference
  //   才把联接当目录展开、把真实文件拷出来。
  //   两个后果都验过：不加 ⇒ 打包版落位失败（进 catch 变成 errors、插件缺失）；
  //   加了 ⇒ 落位出来的是**真实目录**（正确 —— 用户数据目录下不该留指向开发机的联接）。
  fs.cpSync(src, tmp, { recursive: true, dereference: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
}

/**
 * 把随包分发的插件装进 profile。
 *
 * @param {object} opts
 * @param {string} opts.dshHome   目标 DSH_HOME
 * @param {string} [opts.profile] profile 名（默认 web）
 * @param {string} opts.srcRoot   插件来源目录（打包 = <resources>/plugins；开发 = <仓库>/plugin）
 * @param {boolean} [opts.dev]    true = 不复制，直接把 link 指向 srcRoot 里的目录
 * @param {string} [opts.appVersion]
 * @param {(m:string)=>void} [opts.log]
 * @returns {{ok:boolean, pending:?string, changed:string[], plugins:string[], errors:string[], dests:object}}
 */
function provision(opts = {}) {
  const {
    dshHome, profile = "web", srcRoot, dev = false, appVersion = "?", log = () => {},
  } = opts;

  const result = { ok: false, pending: null, changed: [], plugins: [], errors: [], dests: {} };
  if (!dshHome || !srcRoot) {
    result.errors.push("provision 需要 dshHome 与 srcRoot");
    return result;
  }

  const profileDir = path.join(dshHome, "profiles", profile);
  const pkgFile = path.join(profileDir, "package.json");
  const nmDir = path.join(profileDir, "node_modules");

  // profile 还不存在（全新机器：内核尚未跑过第一次）⇒ 调用方稍后重试
  if (!fs.existsSync(pkgFile)) {
    result.pending = "profile-missing";
    return result;
  }
  if (!isDir(nmDir)) {
    result.pending = "node_modules-missing";
    return result;
  }

  const plugins = listBundledPlugins(srcRoot);
  result.plugins = plugins.map((p) => p.name);
  if (!plugins.length) {
    result.ok = true;
    log(`来源目录里没有可分发的插件：${srcRoot}`);
    return result;
  }

  // ── 读 profile package.json ──
  const json = readJson(pkgFile);
  if (!json) { result.errors.push(`profile package.json 解析失败：${pkgFile}`); return result; }
  const bundles = ((json.dsh || {}).profile || {}).bundles;
  if (!Array.isArray(bundles)) {
    result.errors.push("dsh.profile.bundles 不是数组 —— 结构变了，本模块拒绝动手");
    return result;
  }

  const storeDir = path.join(dshHome, "plugins");
  const changed = new Set();
  const ownNames = plugins.map((p) => p.name);
  let pkgDirty = false;

  for (const p of plugins) {
    // ── 已有的、指向**别处**的合法 link：尊重它，不接管 ──
    //
    // 为什么要有这条：开发机用 `npm run plugin:install` 把插件联到**仓库目录**
    // （改源码即时生效）。如果打包版每次启动都把它改写成 <DSH_HOME>\plugins\...，
    // 就会变成"装了打包版 → 开发用联接被冲掉"的拉锯。
    // 判据很硬：必须是真的 `link:`、目标目录真的在、且那里的 package.json 名字对得上。
    // 目标已经失效（项目挪走了）时**不**尊重 ⇒ 照常接管，把用户救回来。
    const depNow = (json.dependencies || {})[p.name];
    const respected = (() => {
      if (typeof depNow !== "string" || !depNow.startsWith("link:")) return null;
      const t = depNow.slice("link:".length);
      if (!isDir(t)) return null;
      const j = readJson(path.join(t, "package.json"));
      if (!j || j.name !== p.name) return null;
      // 指向我们自己的 store 目录不算"别处"（那正是我们上次写的）
      if (path.resolve(t).toLowerCase().startsWith(path.resolve(storeDir).toLowerCase())) return null;
      return t;
    })();

    // ── dest：插件在磁盘上的最终落点 ──
    let dest;
    if (respected) {
      dest = respected;
      log(`尊重已有的 link（不接管）：${p.name} → ${dest}`);
    } else if (dev) {
      dest = p.dir;                       // 开发：直接挂仓库目录，改源码即时生效
    } else {
      dest = path.join(storeDir, p.name);
      const want = fingerprint(p.dir);
      const have = fingerprint(dest);
      if (want !== have) {
        try {
          fs.mkdirSync(storeDir, { recursive: true });
          replaceDir(p.dir, dest);
          changed.add(p.name);
          log(`已内置/更新插件 ${p.name} v${p.version} → ${dest}`);
        } catch (e) {
          result.errors.push(`复制 ${p.name} 失败：${(e && e.message) || e}`);
          continue;
        }
      }
    }
    result.dests[p.name] = dest;

    // ── ① dependencies ──
    json.dependencies = json.dependencies || {};
    const wantSpec = "link:" + dest;
    if (json.dependencies[p.name] !== wantSpec) {
      json.dependencies[p.name] = wantSpec;
      pkgDirty = true;
    }

    // ── ② dsh.profile.bundles ──
    if (!bundles.includes(p.name)) {
      bundles.push(p.name);
      pkgDirty = true;
    }

    // ── ③ node_modules 联接 ──
    try {
      if (ensureJunction(path.join(nmDir, p.name), dest, { ownNames })) changed.add(p.name);
    } catch (e) {
      result.errors.push(`${p.name}: ${(e && e.message) || e}`);
    }
  }

  // ── 落盘（改前必先备份）──
  if (pkgDirty) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const bdir = path.join(dshHome, "safety", "plugin-provision-backup", stamp);
      fs.mkdirSync(bdir, { recursive: true });
      fs.copyFileSync(pkgFile, path.join(bdir, "package.json"));
      log(`profile package.json 已备份 → ${bdir}`);
    } catch (e) {
      result.errors.push(`备份失败，为安全起见不写 package.json：${(e && e.message) || e}`);
      result.changed = [...changed];
      return result;
    }
    try {
      fs.writeFileSync(pkgFile, JSON.stringify(json, null, 2) + "\n", "utf8");
    } catch (e) {
      result.errors.push(`写 profile package.json 失败：${(e && e.message) || e}`);
      result.changed = [...changed];
      return result;
    }
  }

  // ── 状态留痕（给人看 / 给诊断页看）──
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, STATE_FILE), JSON.stringify({
      appVersion,
      profile,
      dev,
      srcRoot,
      at: new Date().toISOString(),
      plugins: plugins.map((p) => ({ name: p.name, version: p.version, dest: result.dests[p.name] })),
    }, null, 2) + "\n", "utf8");
  } catch { /* 留痕失败不影响功能 */ }

  result.changed = [...changed];
  result.ok = result.errors.length === 0;
  return result;
}

module.exports = {
  provision, listBundledPlugins, fingerprint, ensureJunction,
  materializePlugins, isExcluded, DEFAULT_EXCLUDES, STATE_FILE,
};
