"use strict";

/**
 * plugin-install.js —— 把「一份插件」装进 DSH profile（**只做三处契约**）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 与 plugins.js 的分工
 * ═══════════════════════════════════════════════════════════════════════════
 *   · plugins.js        = **随包内置**的插件（它自己把插件复制到 <dshHome>\plugins\<名字>）
 *   · 本模块             = **用户自己挑**的插件（插件已经在本机了，或从 .tgz 解出来）
 *
 * 两者最终写出的磁盘状态**必须一模一样** —— scripts/plugin-install-check.js 里有一条
 * **交叉断言**：同一个插件，分别用 provision() 和 installFromDir() 装进两个临时家，
 * 然后把两份 profile\package.json **逐字节**比一次。对不上就是两套实现分叉了。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★ 本模块**不认识任何「索引 / 商店」格式**
 * ═══════════════════════════════════════════════════════════════════════════
 * 「索引里的一条」→「磁盘上的一份插件目录」那一步在 plugin-catalog.js。
 * 那道缝是故意的：索引格式由生产端（插件上传器 / DSH-Plugin-Hub）决定，
 * 那边还在改，所以本模块的入参只有**目录 / 压缩包 / sha256** 这些不会变的东西。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 安全边界（**每一条都有真实事故垫底**，别删）
 * ═══════════════════════════════════════════════════════════════════════════
 *   ① 绝不写 A 环境（%USERPROFILE%\.dsh）—— assertNotCommunityHome。
 *      A 是出事后唯一的维修通道；0.1.5 内核碰过它一次，198 个联接被跨世代改写，
 *      社区版当场报废（2026-09-19 22:18:14 真实事故）。
 *   ② 只动**自己点名的**那一个插件。别人的 dependencies / bundles / 真实目录一个字节不动。
 *   ③ 改 profile 前**必须备份**到 <dshHome>\safety\plugin-install-backup\<时间戳>\。
 *      备份失败 ⇒ 拒绝往下写（宁可装不上，也不留一个改坏了又退不回去的家）。
 *   ④ profile package.json 必须**无 BOM** 落盘。带 BOM = 整台 DSH 起不来
 *      （历史上真实发生过，手工写 profile 时带上 BOM）。
 *   ⑤ **装之前必须校验插件目录**。坏插件不是"这个插件没界面"，而是
 *      `dsh: plugin tree failed to load` ⇒ **连累用户所有插件一起起不来**，
 *      而且"纯净模式"只绕第三方层、绕不过清单坏掉。
 *   ⑥ 解 tar 用**数组参数、不经 shell**。本机数据目录
 *      `%APPDATA%\DSH Integrated\…` **必然含空格**，而内核/`dsh.cmd` 内部
 *      `spawnSync(..., {shell:true})` 会在空格处把参数劈开（实测把
 *      `…\dshplugintest- 9633\DSH` 劈成两半）。
 *   ⑦ 删目录前先 `lstat`：**目录联接绝不用 recursive 删**，否则删掉的是目标本体
 *      （插件本体可能在别的盘/工作区，这里只留一个 junction）。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const P = require("./plugins.js");

/** 插件在用户数据目录里的落点：<dshHome>\plugins\<名字>（与 plugins.js 的 storeDir 一致） */
const PLUGINS_SUBDIR = "plugins";
const BACKUP_SUBDIR = path.join("safety", "plugin-install-backup");

// ─────────────────────────────────────────────────────────────────────────
// 基础小工具
// ─────────────────────────────────────────────────────────────────────────

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function readJson(p) {
  try {
    let raw = fs.readFileSync(p, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 前 BOM（PowerShell 写过的 JSON 会带）
    return JSON.parse(raw);
  } catch { return null; }
}

/** 流式算 sha256（插件包不大，但不一次性读进内存总是对的）。 */
function sha256File(abs) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/** 流式算 sha512，按 SRI 形状返回 `sha512-<base64>`（与 npm 的 dist.integrity 同形）。 */
function sha512SriFile(abs) {
  const h = crypto.createHash("sha512");
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return "sha512-" + h.digest("base64");
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
}

/**
 * 拒绝把任何东西写进 A 环境。
 * 判据用**规范化后的绝对路径**比较，避免 `D:\x\.dsh\` 与 `D:\x\.dsh` 这类写法绕过。
 */
function assertNotCommunityHome(home) {
  const norm = (s) => path.resolve(s).replace(/[\\/]+$/, "").toLowerCase();
  const target = norm(home);
  const userProfile = process.env.USERPROFILE || process.env.HOME || "";
  const aHome = userProfile ? norm(path.join(userProfile, ".dsh")) : null;
  if (aHome && target === aHome) {
    throw new Error(
      `拒绝：${home} 是 A 环境（社区版保底家，**只读**）。本模块只允许写 B` +
      `（%APPDATA%\\DSH Integrated\\dsh-home）。`
    );
  }
  return true;
}

/**
 * 删除一个路径，**联接只删链接本身**。
 * 这是 ⑦ 号边界：对 junction 用 rmSync(recursive) 删掉的是目标本体。
 */
function removePath(p) {
  let st = null;
  try { st = fs.lstatSync(p); } catch { return false; }
  if (st.isSymbolicLink()) {
    // Windows 的目录联接在 Node 里也报 isSymbolicLink() === true
    try { fs.unlinkSync(p); } catch { fs.rmSync(p, { recursive: true, force: true }); }
    return true;
  }
  fs.rmSync(p, { recursive: true, force: true });
  return true;
}

/** 原子替换目录：先拷到同级临时名再改名（中途失败不会留下半个插件）。 */
function swapDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.installing-${process.pid}-${Date.now()}`;
  removePath(tmp);
  // dereference:true —— 源可能是联接（插件本体在别的工作区），默认 cpSync 会抛 EPERM
  fs.cpSync(src, tmp, { recursive: true, dereference: true, force: true });
  removePath(dest);
  fs.renameSync(tmp, dest);
}

// ─────────────────────────────────────────────────────────────────────────
// 解包（走系统自带的 bsdtar，不引任何依赖）
// ─────────────────────────────────────────────────────────────────────────

function tarBin() {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const cand = path.join(root, "System32", "tar.exe");
  return isFile(cand) ? cand : "tar.exe";
}

/** 解出来的内容里，哪一层才是插件根（npm pack 会套一层 `package/`）。 */
function detectPluginRoot(dir) {
  if (isFile(path.join(dir, "package.json"))) return dir;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const dirs = entries.filter((e) => e.isDirectory() || isDir(path.join(dir, e.name)));
  if (dirs.length === 1) {
    const inner = path.join(dir, dirs[0].name);
    if (isFile(path.join(inner, "package.json"))) return inner;
  }
  // 再深一层（有些包会套 package/package/）—— 只多试一层，不做无限下钻
  for (const d of dirs) {
    const inner = path.join(dir, d.name);
    if (isFile(path.join(inner, "package.json"))) return inner;
    let sub = [];
    try { sub = fs.readdirSync(inner, { withFileTypes: true }); } catch { continue; }
    for (const s of sub) {
      const deep = path.join(inner, s.name);
      if (isDir(deep) && isFile(path.join(deep, "package.json"))) return deep;
    }
  }
  return null;
}

/**
 * 把 .tgz 解到 destDir，返回插件根目录。
 * ★ 数组参数、不经 shell —— 路径含空格也安全（见 ⑥ 号边界）。
 */
function extractTgz(tgzAbs, destDir, log = () => {}) {
  if (!isFile(tgzAbs)) throw new Error(`找不到压缩包：${tgzAbs}`);
  fs.mkdirSync(destDir, { recursive: true });
  const bin = tarBin();
  const r = spawnSync(bin, ["-xzf", tgzAbs, "-C", destDir], {
    encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw new Error(`解包失败（调用 ${bin}）：${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`解包失败（${bin} 退出码 ${r.status}）：${(r.stderr || "").trim()}`);
  }
  const root = detectPluginRoot(destDir);
  if (!root) throw new Error(`解包成功，但里面找不到 package.json：${tgzAbs}`);
  log(`已解包 → ${root}`);
  return root;
}

// ─────────────────────────────────────────────────────────────────────────
// 装之前必须过的那道闸：这个目录到底是不是一个能用的插件
// ─────────────────────────────────────────────────────────────────────────

/**
 * 校验一份插件目录。
 *
 * ★ 为什么非校验不可：坏插件不是"这个插件没界面"，而是内核组合 profile 时**整个
 *   tree 加载失败** ⇒ 用户**所有**插件一起消失，且报错与用户装的那个插件看不出关系。
 *   本轮真事故（上传器 Tier 2 抓到）：
 *     `dsh: plugin tree failed to load: dsh-plugin-uploader: pending (waiting for service: logger)`
 *   所以宁可拒装，也不让一份缺件的东西进 profile。
 *
 * @returns {{ok:boolean, name:?string, version:?string, errors:string[], warnings:string[],
 *            dir:string, patchFile:?string, clientEntry:?string}}
 */
function validatePluginDir(dir) {
  const out = {
    ok: false, name: null, version: null, dir,
    patchFile: null, clientEntry: null, errors: [], warnings: [],
  };
  if (!isDir(dir)) { out.errors.push(`不是一个目录：${dir}`); return out; }

  const pkgFile = path.join(dir, "package.json");
  const pkg = readJson(pkgFile);
  if (!pkg) { out.errors.push(`package.json 缺失或不是合法 JSON（${pkgFile}）`); return out; }

  out.name = typeof pkg.name === "string" ? pkg.name.trim() : null;
  out.version = typeof pkg.version === "string" ? pkg.version.trim() : null;

  if (!out.name) out.errors.push("package.json 里没有 name（内核按名字认插件）");
  else if (!/^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(out.name)) {
    out.errors.push(`name 不像合法的包名：${out.name}`);
  }
  if (!out.version) out.warnings.push("package.json 里没有 version（不影响加载，界面会显示 0.0.0）");

  const dsh = pkg.dsh || {};
  const bundle = dsh.bundle || null;
  const client = dsh.client || null;

  if (!bundle && !client) {
    out.errors.push(
      "既没有 dsh.bundle 也没有 dsh.client —— 装上去内核会拒绝加载" +
      "（declares no dsh.bundle in its package.json）。这不是一个 DSH 插件。"
    );
    return out;
  }

  // ── dsh.bundle.patch：必须能落到一个真实文件上 ──
  if (bundle) {
    // 实测本机三种写法都存在：字符串、{patch:"./x.yml"}；对象里还可能没有 patch
    let rel = null;
    if (typeof bundle.patch === "string") rel = bundle.patch;
    else if (bundle.patch && typeof bundle.patch === "object" && typeof bundle.patch.path === "string") {
      rel = bundle.patch.path;
    }
    if (!rel) {
      out.errors.push("dsh.bundle 存在但读不出 patch 路径（内核组合 profile 会失败）");
    } else {
      const abs = path.resolve(dir, rel);
      if (!isFile(abs)) {
        out.errors.push(`dsh.bundle.patch 指向的文件不存在：${rel}（缺它 = 整棵 profile tree 加载失败）`);
      } else {
        out.patchFile = abs;
      }
    }
  }

  // ── 有 exports["./client"] 声明时，那个文件必须真的在 ──
  const exp = (pkg.exports && typeof pkg.exports === "object") ? pkg.exports : null;
  const clientRel = exp && typeof exp["./client"] === "string" ? exp["./client"] : null;
  if (clientRel) {
    const abs = path.resolve(dir, clientRel);
    if (!isFile(abs)) out.errors.push(`exports["./client"] 指向的文件不存在：${clientRel}`);
    else out.clientEntry = abs;
  }

  if (client) {
    if (!Array.isArray(client.inject)) {
      out.warnings.push("dsh.client 没有 inject 数组（能装上，但插件可能拿不到官方服务）");
    }
    if (client.platform && client.platform !== "web") {
      out.warnings.push(`dsh.client.platform = ${client.platform}（本外壳只跑 web profile）`);
    }
  }

  out.ok = out.errors.length === 0;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// profile 三处契约
// ─────────────────────────────────────────────────────────────────────────

function profilePaths(dshHome, profile = "web") {
  const profileDir = path.join(dshHome, "profiles", profile);
  return {
    profileDir,
    pkgFile: path.join(profileDir, "package.json"),
    nmDir: path.join(profileDir, "node_modules"),
  };
}

function backupProfile(dshHome, name, action, log = () => {}, profile = "web") {
  const { pkgFile } = profilePaths(dshHome, profile);
  const dir = path.join(dshHome, BACKUP_SUBDIR, `${stamp()}-${action}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(pkgFile, path.join(dir, "package.json"));
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ action, plugin: name, at: new Date().toISOString() }, null, 2) + "\n",
    "utf8"
  );
  log(`profile package.json 已备份 → ${dir}`);
  return dir;
}

/**
 * 把某几个**已经落在磁盘上**的插件目录接进 profile（三处契约）。
 *
 *   ① profile\package.json → dependencies[name] = "link:<dest>"
 *   ② profile\package.json → dsh.profile.bundles 里有 name
 *   ③ profile\node_modules\<name> → 目录联接指向 <dest>
 *
 * 只动 items 里点名的插件；别人的条目一个字节不改。
 *
 * @param {{dshHome:string, profile?:string, items:Array<{name:string,version?:string,dest:string}>,
 *          log?:Function}} opts
 */
function connectIntoProfile(opts = {}) {
  const { dshHome, profile = "web", items = [], log = () => {} } = opts;
  const result = { ok: false, changed: [], errors: [], backup: null, dests: {} };
  assertNotCommunityHome(dshHome);

  if (!items.length) { result.ok = true; return result; }

  const { pkgFile, nmDir } = profilePaths(dshHome, profile);
  if (!isFile(pkgFile)) { result.errors.push(`profile 还不存在（内核尚未第一次启动）：${pkgFile}`); return result; }
  if (!isDir(nmDir)) { result.errors.push(`profile 的 node_modules 不存在：${nmDir}`); return result; }

  const json = readJson(pkgFile);
  if (!json) { result.errors.push(`profile package.json 解析失败：${pkgFile}`); return result; }
  const bundles = ((json.dsh || {}).profile || {}).bundles;
  if (!Array.isArray(bundles)) {
    result.errors.push("dsh.profile.bundles 不是数组 —— 结构变了，本模块拒绝动手");
    return result;
  }

  const changed = new Set();
  const ownNames = items.map((i) => i.name);
  let dirty = false;

  for (const it of items) {
    const name = it.name;
    const dest = it.dest;
    result.dests[name] = dest;

    // ① dependencies
    json.dependencies = json.dependencies || {};
    const want = "link:" + dest;
    if (json.dependencies[name] !== want) { json.dependencies[name] = want; dirty = true; }

    // ② bundles
    if (!bundles.includes(name)) { bundles.push(name); dirty = true; }

    // ③ node_modules 联接
    try {
      if (P.ensureJunction(path.join(nmDir, name), dest, { ownNames })) changed.add(name);
    } catch (e) {
      result.errors.push(`${name}: ${(e && e.message) || e}`);
    }
  }

  if (dirty) {
    try {
      result.backup = backupProfile(dshHome, ownNames.join("+"), "install", log, profile);
    } catch (e) {
      // ③ 号边界：备份失败 ⇒ 拒绝往下写
      result.errors.push(`备份失败，为安全起见不写 package.json：${(e && e.message) || e}`);
      result.changed = [...changed];
      return result;
    }
    try {
      // ④ 号边界：无 BOM（writeFileSync + "utf8" 不带 BOM；绝不能换成带 BOM 的写法）
      fs.writeFileSync(pkgFile, JSON.stringify(json, null, 2) + "\n", "utf8");
    } catch (e) {
      result.errors.push(`写 profile package.json 失败：${(e && e.message) || e}`);
      result.changed = [...changed];
      return result;
    }
  }

  result.changed = [...changed];
  result.ok = result.errors.length === 0;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// 对外的四个动作
// ─────────────────────────────────────────────────────────────────────────

/**
 * 把一份插件目录装进 DSH 家。
 *
 * @param {{dshHome:string, profile?:string, dir:string, name?:string, log?:Function}} opts
 * @returns {{ok:boolean, name:?string, version:?string, dest:?string, changed:string[],
 *            errors:string[], warnings:string[], backup:?string, skipped?:string}}
 */
function installFromDir(opts = {}) {
  const { dshHome, profile = "web", dir, log = () => {} } = opts;
  const result = {
    ok: false, name: null, version: null, dest: null,
    changed: [], errors: [], warnings: [], backup: null,
  };
  try { assertNotCommunityHome(dshHome); } catch (e) { result.errors.push(e.message); return result; }

  const v = validatePluginDir(dir);
  result.name = v.name;
  result.version = v.version;
  result.warnings = v.warnings;
  if (!v.ok) { result.errors = v.errors; return result; }

  if (opts.name && v.name !== opts.name) {
    result.errors.push(`包名不符：期望 ${opts.name}，包里是 ${v.name}`);
    return result;
  }

  const name = v.name;
  const storeDir = path.join(dshHome, PLUGINS_SUBDIR);
  const dest = path.join(storeDir, name);
  result.dest = dest;

  // 落位：内容一样就不重拷（幂等判据用**目录指纹**，不用 mtime —— 拷来拷去 mtime 必变）
  const want = P.fingerprint(dir);
  const have = P.fingerprint(dest);
  if (want === have && isDir(dest)) {
    result.skipped = "内容一致，未重新落位";
    log(`${name}：内容一致，跳过落位`);
  } else {
    try {
      fs.mkdirSync(storeDir, { recursive: true });
      swapDir(dir, dest);
      result.changed.push(name);
      log(`已落位 ${name} v${v.version} → ${dest}`);
    } catch (e) {
      result.errors.push(`落位失败：${(e && e.message) || e}`);
      return result;
    }
  }

  const c = connectIntoProfile({ dshHome, profile, items: [{ name, version: v.version, dest }], log });
  result.errors.push(...c.errors);
  result.backup = c.backup;
  for (const n of c.changed) if (!result.changed.includes(n)) result.changed.push(n);
  result.ok = result.errors.length === 0;
  return result;
}

/**
 * 从 .tgz 装。**给了哈希就必须先对得上**才解包（装上半个包比装上错包更坏）。
 *
 * ★★ 2026-09-25 改：多认一种哈希 —— **sha512 SRI**（`sha512-<base64>`）。
 *
 *   起因：加了 npm 源之后，npm 只给 `dist.integrity`（sha512），**不给 sha256**。
 *   两种哈希**不能互相转换**，所以这里并存两条路：
 *     · `expectedSha256` —— GitHub 索引那条路（我们自己生产端算的）
 *     · `expectedIntegrity` —— npm 那条路（官方给的，同样逐字节可验）
 *   两个都给 ⇒ **两个都验**（宁可多验一次，也不放过）。
 *   两个都不给 ⇒ 仍然装，但**必须**留下"未校验"警告（沿用原有降级路径，不假装安全）。
 *
 * @param {{expectedSha256?:string, expectedIntegrity?:string}} opts
 */
function installFromArchive(opts = {}) {
  const { dshHome, profile = "web", tgz, expectedSha256, expectedIntegrity, name, tmpRoot, log = () => {} } = opts;
  const result = { ok: false, name: null, version: null, dest: null, changed: [], errors: [], warnings: [] };
  try { assertNotCommunityHome(dshHome); } catch (e) { result.errors.push(e.message); return result; }
  if (!isFile(tgz)) { result.errors.push(`找不到压缩包：${tgz}`); return result; }

  let verified = false;
  if (expectedSha256) {
    const got = sha256File(tgz);
    if (got.toLowerCase() !== String(expectedSha256).toLowerCase()) {
      result.errors.push(`sha256 不符：期望 ${expectedSha256}，实际 ${got} —— 拒绝安装`);
      return result;
    }
    log("sha256 已核对通过");
    verified = true;
  }
  if (expectedIntegrity) {
    const want = String(expectedIntegrity).trim();
    // 只认 sha512（npm 的 dist.integrity 就是它）；别的算法宁可跳过，也不瞎猜怎么算
    if (/^sha512-[A-Za-z0-9+/=]+$/.test(want)) {
      const got = sha512SriFile(tgz);
      if (got !== want) {
        result.errors.push(`integrity 不符：期望 ${want}，实际 ${got} —— 拒绝安装`);
        return result;
      }
      log("sha512 integrity 已核对通过");
      verified = true;
    } else {
      result.warnings.push(`integrity 格式不认识（${want.slice(0, 16)}…）⇒ 跳过这一项校验`);
    }
  }
  if (!verified) {
    // ★ 2026-09-25：措辞里**同时**提 sha256 与 integrity。
    //   起因：加了 npm 源之后两条来源各有各的哈希（GitHub→sha256，npm→sha512 integrity），
    //   而"一个哈希都没给"这件事必须让用户看见 —— 降级路径可以走，但**不许静默**。
    //   （验收脚本 scripts/plugin-install-check.js 按 /sha256/ 匹配这条警告，
    //     所以措辞里保留了 "sha256" —— 这不是将就，是那条断言表达的正是这个意思。）
    result.warnings.push(
      "没有提供可用的哈希（sha256 与 integrity 都没有）—— 只保证了传输完整" +
      "（tar 自身校验），没保证内容就是发布者那一份"
    );
  }

  const tmp = path.join(tmpRoot || require("node:os").tmpdir(), `dsh-plugin-unpack-${process.pid}-${Date.now()}`);
  // ★ 先把自己已攒下的警告留一份：下面 Object.assign(result, r) 会用 r.warnings 覆盖掉它
  //   （第一版就是这里把"没给 sha256"的警告吞了 —— 自查抓到的）
  const keptWarnings = result.warnings.slice();
  try {
    const root = extractTgz(tgz, tmp, log);
    const r = installFromDir({ dshHome, profile, dir: root, name, log });
    Object.assign(result, r);           // r 带 ok/name/version/dest/changed/errors/warnings
    result.warnings = [...(r.warnings || []), ...keptWarnings];
    return result;
  } catch (e) {
    result.errors.push(`解包失败：${(e && e.message) || e}`);
    return result;
  } finally {
    // 解包目录只用来读取，装完就没用了；插件本体已拷进 <dshHome>\plugins
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
  }
}

/**
 * 卸掉一个插件：三处契约一起撤，别人的条目一个字不动。
 * 只删 `<dshHome>\plugins\<名字>` 这个落点；如果 link 指向别处（例如开发机的仓库目录），
 * **不动那个目录**，只撤 profile 里的三处。
 */
function uninstall(opts = {}) {
  const { dshHome, profile = "web", name, log = () => {}, keepFiles = false } = opts;
  const result = { ok: false, name, changed: [], errors: [], backup: null, removedFiles: false };
  try { assertNotCommunityHome(dshHome); } catch (e) { result.errors.push(e.message); return result; }
  if (!name) { result.errors.push("uninstall 需要 name"); return result; }

  const { pkgFile, nmDir } = profilePaths(dshHome, profile);
  const json = readJson(pkgFile);
  if (!json) { result.errors.push(`profile package.json 读不到：${pkgFile}`); return result; }
  const bundles = ((json.dsh || {}).profile || {}).bundles;
  if (!Array.isArray(bundles)) { result.errors.push("dsh.profile.bundles 不是数组，拒绝动手"); return result; }

  let dirty = false;
  if (json.dependencies && Object.prototype.hasOwnProperty.call(json.dependencies, name)) {
    delete json.dependencies[name];
    dirty = true;
  }
  const idx = bundles.indexOf(name);
  if (idx >= 0) { bundles.splice(idx, 1); dirty = true; }

  const linkPath = path.join(nmDir, name);
  if (fs.existsSync(linkPath) || (() => { try { fs.lstatSync(linkPath); return true; } catch { return false; } })()) {
    removePath(linkPath);
    result.changed.push(name);
  }

  if (dirty) {
    try {
      result.backup = backupProfile(dshHome, name, "uninstall", log, profile);
      fs.writeFileSync(pkgFile, JSON.stringify(json, null, 2) + "\n", "utf8");
    } catch (e) {
      result.errors.push(`写 profile 失败：${(e && e.message) || e}`);
      return result;
    }
  }

  if (!keepFiles) {
    const dest = path.join(dshHome, PLUGINS_SUBDIR, name);
    if (isDir(dest) || (() => { try { fs.lstatSync(dest); return true; } catch { return false; } })()) {
      try { removePath(dest); result.removedFiles = true; } catch (e) { result.errors.push(`删落点失败：${e.message}`); }
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}

/**
 * 解析一条依赖 spec 到底指向哪里。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★ 为什么非得四种都认（2026-09-21 在**真实 B 家**上实测出来的）
 * ═══════════════════════════════════════════════════════════════════════════
 * 第一版只认"落点在 <dshHome>\plugins 下"的那一种，于是在真机上**一个都认不出来**
 * （报 `已装 0`，而那台机器实际装着 11 个插件）。本机同时存在这四种：
 *
 *   dsh-multi-session     = link:D:\...\plugin\dsh-multi-session    ← 开发机联接（本体在仓库）
 *   dsh-crosshub          = file:./plugin-src/dsh-crosshub-….tgz    ← 相对 profile 的本地包
 *   dsh-plugin-uploader   = file:C:/Users/…/published/….tgz         ← 上传器的归档
 *   dsh-connect-workbuddy = ^2.0.4                                  ← 从 npm 装的
 *
 * **后果不是"少显示几个"**：是会给已经装着的插件显示「安装」按钮，
 * 一点就把用户那条 dev link **覆盖掉** —— 他悄悄失去了"改源码即时生效"。
 */
function resolveDep(profileDir, nmDir, name, spec) {
  const raw = String(spec || "").trim();
  let kind = "unknown";
  let target = null;

  if (raw.startsWith("link:")) {
    kind = "link";
    target = raw.slice(5);
  } else if (raw.startsWith("file:")) {
    kind = "file";
    let t = raw.slice(5);
    // file: 的相对路径按 **profile 目录** 解析（pnpm 的规矩）
    if (!path.isAbsolute(t)) t = path.resolve(profileDir, t);
    target = t;
  } else if (/^[\^~]?\d/.test(raw) || raw === "*" || raw === "latest") {
    kind = "registry";
    target = path.join(nmDir, name);   // npm 装的就看 node_modules 里那一个
  } else {
    return null;                        // 认不出来的一律不猜
  }

  // 指向的是 tarball 而不是目录 ⇒ 去看 node_modules 里实际解出来的那一个
  let look = target;
  if (kind === "file" && /\.(tgz|tar\.gz)$/i.test(target)) look = path.join(nmDir, name);

  return { kind, target, look };
}

/** 它在磁盘上到底在不在、版本多少、**是不是一个 DSH 插件**。 */
function probePackage(dir) {
  const pj = readJson(path.join(dir, "package.json"));
  if (!pj) return { exists: false, version: null, isPlugin: false };
  const dsh = pj.dsh || {};
  return {
    exists: true,
    version: typeof pj.version === "string" ? pj.version : null,
    // ★ 与内核认插件的规矩一致：声明了 dsh.bundle 或 dsh.client 才叫插件。
    //   否则 dsh-base 这类框架包、以及一大堆普通依赖全会混进来。
    isPlugin: !!(dsh.bundle || dsh.client),
  };
}

/**
 * 这个家里现在装了哪些插件 —— **不管它是从哪来的**。
 *
 * `source` 四种：`hub`（我们装的，落点在 <dshHome>\plugins）、
 * `local-link`（开发机联接）、`local-file`（本地 tgz / 目录）、`registry`（npm 装的）。
 * `ours` 只表示「是不是我们从仓库装的那一份」；卸载对四种都可用，
 * 但界面据此区分措辞（本地装的那份要点「改用仓库版」并二次确认，不能长得像普通「安装」）。
 */
function listInstalled(opts = {}) {
  const { dshHome, profile = "web" } = opts;
  const out = { ok: false, plugins: [], errors: [], scanned: 0 };
  try { assertNotCommunityHome(dshHome); } catch (e) { out.errors.push(e.message); return out; }

  const { profileDir, pkgFile, nmDir } = profilePaths(dshHome, profile);
  const json = readJson(pkgFile);
  if (!json) { out.errors.push(`profile package.json 读不到：${pkgFile}`); return out; }

  const storeDir = path.join(dshHome, PLUGINS_SUBDIR);
  const storeLc = path.resolve(storeDir).toLowerCase();
  const bundles = (((json.dsh || {}).profile || {}).bundles) || [];

  for (const [name, spec] of Object.entries(json.dependencies || {})) {
    if (typeof spec !== "string") continue;
    out.scanned += 1;

    const r = resolveDep(profileDir, nmDir, name, spec);
    if (!r) continue;

    const linkPath = path.join(nmDir, name);
    let junctionOk = false;
    try { junctionOk = !!fs.realpathSync(linkPath); } catch { junctionOk = false; }

    const underStore = path.resolve(r.target).toLowerCase().startsWith(storeLc);
    const source = underStore ? "hub" : (r.kind === "registry" ? "registry" : `local-${r.kind}`);
    const probe = probePackage(r.look);

    // 落点在**我们的 store** 里 ⇒ 不管读不读得到 package.json，它就是我们装的。
    // 读不到 = 落点被删了 ⇒ 要让界面能报「落点丢了」，而不是当成没装。
    if (!underStore && !probe.isPlugin) continue;

    out.plugins.push({
      name,
      version: probe.version || "0.0.0",
      spec,
      target: r.target,
      kind: r.kind,
      source,
      ours: source === "hub",
      dirExists: probe.exists,
      junctionOk,
      enabled: bundles.includes(name),
    });
  }
  out.plugins.sort((a, b) => a.name.localeCompare(b.name));
  out.ok = out.errors.length === 0;
  return out;
}

module.exports = {
  // 对外动作
  installFromDir,
  installFromArchive,
  uninstall,
  listInstalled,
  // 零件（脚本与 UI 都要用）
  resolveDep,
  probePackage,
  validatePluginDir,
  extractTgz,
  detectPluginRoot,
  connectIntoProfile,
  backupProfile,
  profilePaths,
  assertNotCommunityHome,
  sha256File,
  sha512SriFile,
  removePath,
  swapDir,
  tarBin,
  PLUGINS_SUBDIR,
  BACKUP_SUBDIR,
};
