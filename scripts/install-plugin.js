/**
 * install-plugin.js —— 把本仓库的客户端插件装进 DSH profile（可预演、可回滚）。
 *
 * 背景（为什么要写成脚本，而不是让人照着 README 敲）：
 *   装一个 dsh 客户端插件要同时改三处，漏一处就"文件都在、界面什么都没有"：
 *     ① profile 的 `package.json` → `dependencies` 里能被解析到；
 *     ② profile 的 `package.json` → `dsh.profile.bundles` 里被列上
 *        （内核只在 `dsh plugin` 成功时才自动重建这个列表，手写的会被原样尊重）；
 *     ③ `node_modules` 里真的有那个包（否则 ① 只是纸上写着）。
 *
 * ★ 为什么**不用** `pnpm install` 建 ③：
 *   - 本插件**零依赖**，不需要解析任何东西；
 *   - 本机 `dsh plugin add` 这条路已被证明走不通：它在 Windows 下用 `shell: true` 起 pnpm
 *     且不给参数加引号 ⇒ 含空格的路径被 cmd 切开（本机 userData 就叫 `DSH Integrated`）。
 *   - 直接用**目录联接（junction）**把仓库里的插件目录挂进 profile 的 node_modules，
 *     零网络、零解析、零构建；改仓库里的源码 = 立即生效，回滚就是删一个联接。
 *   记录进 package.json 用 `link:` 规格 —— 本 profile 已有先例（`@dsh-pet/bridge`）。
 *
 * ★ 本脚本**绝不重启内核**，也绝不调用任何重启端点。
 *   原因不是"风险高"，而是**本会话的 AI 自己就跑在内核里** —— 重启内核 = 把自己连同用户的
 *   在场感一起杀掉（AGENTS.md 第一条：这条命令跑下去之后如果用户就看不见我了，就不该跑）。
 *   所以它只把"磁盘上的状态"改对，最后打印用户需要按的那一下（重启客户端）。
 *
 * 用法：
 *   node scripts/install-plugin.js                 # 预演（默认，什么都不写）
 *   node scripts/install-plugin.js --apply         # 落盘
 *   node scripts/install-plugin.js --revert        # 卸载（恢复备份 + 删联接）
 *   node scripts/install-plugin.js --status        # 只读：现在装没装、装的是哪个路径
 *   node scripts/install-plugin.js --apply --home "C:\别的\dsh-home"
 *
 *   ★ 装**别的**插件（2026-09-20 泛化；默认仍是 dsh-multi-session，行为完全不变）：
 *   node scripts/install-plugin.js --plugin dsh-mobile-remote --status
 *   node scripts/install-plugin.js --plugin dsh-mobile-remote --apply
 *   node scripts/install-plugin.js --plugin dsh-mobile-remote --revert
 *
 * 退出码：0=成功  2=参数/环境问题  3=预检失败  4=落盘失败
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

/**
 * 插件名：默认仍是 dsh-multi-session（**向后兼容**，老的 `npm run plugin:*`
 * 与既有调用行为一字不变）。
 *
 * 为什么允许 `--plugin`：本仓库现在有不止一个客户端插件，而"装一个插件要同时改三处"
 * 对所有插件是同一套逻辑。复制一份脚本只会让两处以后分叉
 * （项目 AGENTS.md 的规矩：装/验/退只走脚本，不手敲）。
 */
const PLUGIN_NAME = val("--plugin", "dsh-multi-session");
const REPO = path.join(__dirname, "..");
const PLUGIN_SRC = path.join(REPO, "plugin", PLUGIN_NAME);

const APPLY = has("--apply");
const REVERT = has("--revert");
const STATUS = has("--status");
const DSH_HOME = val("--home", path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "DSH Integrated", "dsh-home"));
const PROFILE = val("--profile", "web");

const profileDir = path.join(DSH_HOME, "profiles", PROFILE);
const pkgFile = path.join(profileDir, "package.json");
const linkPath = path.join(profileDir, "node_modules", PLUGIN_NAME);
const backupRoot = path.join(DSH_HOME, "safety", "plugin-install-backup");

const say = (...a) => console.log(...a);
const fail = (msg, code = 3) => { console.error("\n✗ " + msg); process.exit(code); };

function readPkg() {
  if (!fs.existsSync(pkgFile)) fail(`profile package.json 不存在：${pkgFile}\n  （--home 指错了？现在指：${DSH_HOME}）`, 2);
  const raw = fs.readFileSync(pkgFile, "utf8");
  let json;
  try { json = JSON.parse(raw); } catch (e) { fail(`profile package.json 不是合法 JSON：${e.message}`, 2); }
  return { raw, json };
}

function linkTarget(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function report({ raw, json }) {
  const dep = (json.dependencies || {})[PLUGIN_NAME];
  const bundles = ((json.dsh || {}).profile || {}).bundles || [];
  const inBundles = bundles.includes(PLUGIN_NAME);
  const target = linkTarget(linkPath);
  say(`  DSH_HOME      : ${DSH_HOME}`);
  say(`  profile 目录  : ${profileDir}`);
  say(`  package.json  : ${pkgFile}`);
  say(`  dependencies  : ${dep !== undefined ? dep : "（未登记）"}`);
  say(`  dsh.profile.bundles 含它 : ${inBundles ? "是" : "否"}   （共 ${bundles.length} 项）`);
  say(`  node_modules 联接指向    : ${target || "（不存在）"}`);
  const srcReal = fs.existsSync(PLUGIN_SRC) ? fs.realpathSync(PLUGIN_SRC) : null;
  if (target && srcReal) {
    const same = path.resolve(target).toLowerCase() === path.resolve(srcReal).toLowerCase();
    say(`  联接是否指向本仓库        : ${same ? "是 ✓" : `否 ✗（指向 ${target}，本仓库是 ${srcReal}）`}`);
  }
  const clientBundle = path.join(PLUGIN_SRC, "lib", "client.js");
  say(`  仓库里的 client bundle   : ${fs.existsSync(clientBundle) ? `${fs.statSync(clientBundle).size} 字节` : "缺失 ✗"}`);
  return { dep, inBundles, target, srcReal };
}

// ──────────────────────────────────────────────────────────────
say(`\n=== install-plugin：${PLUGIN_NAME} ===`);

if (!fs.existsSync(PLUGIN_SRC)) fail(`仓库里找不到插件源码目录：${PLUGIN_SRC}`, 2);
say(`  插件源码      : ${PLUGIN_SRC}\n`);

// ── --status：只读体检 ──
if (STATUS || (!APPLY && !REVERT)) {
  const st = report(readPkg());
  const wantDep = "link:" + PLUGIN_SRC;
  // ★ 2026-09-21 修：原来拿 `st.target`（联接**真实解析后**的路径）直接比 `PLUGIN_SRC`。
  //   归档管理器是**双层联接**：
  //     profiles\web\node_modules\dsh-archive-manager
  //       → 5.DSH集成桌面端\plugin\dsh-archive-manager   （junction）
  //         → D:\DSH工作区002\2.归档管理器                （junction，源码真身）
  //   那么 realpath 出来是第三工作区那个路径，与 PLUGIN_SRC 字符串当然不等
  //   ⇒ 三处契约明明都 ✓，状态却报"还没装"（**假阴性**，会误导人反复重装）。
  //   正确判据：**两边都 realpath 之后再比** —— 比的是"最终是不是同一份源码"。
  const sameTarget = (() => {
    if (!st.target) return false;
    const a = path.resolve(st.target).toLowerCase();
    const b = path.resolve(PLUGIN_SRC).toLowerCase();
    if (a === b) return true;
    try {
      const ra = fs.existsSync(st.target) ? fs.realpathSync(st.target).toLowerCase() : a;
      const rb = fs.existsSync(PLUGIN_SRC) ? fs.realpathSync(PLUGIN_SRC).toLowerCase() : b;
      return ra === rb || a === rb || ra === b;
    } catch {
      return false;
    }
  })();
  const already = st.dep === wantDep && st.inBundles && sameTarget;

  if (already) {
    say("\n  ✓ 这个插件**已经装好了**，而且指向的就是本仓库。");
    say("    生效条件：内核要重新读一次 profile —— 也就是重启一次客户端");
    say("    （本脚本刻意不替你重启：AI 自己就跑在那个内核里）。");
    say("    想撤掉：node scripts/install-plugin.js --revert");
  } else if (!APPLY && !REVERT) {
    say("\n  ✗ 现在**还没装**。--apply 会做：");
    say(`    ① 备份 ${pkgFile} → ${backupRoot}\\<时间戳>\\`);
    say(`    ② dependencies["${PLUGIN_NAME}"] = "${wantDep}"`);
    say(`    ③ dsh.profile.bundles 末尾追加 "${PLUGIN_NAME}"`);
    say(`    ④ 建目录联接 ${linkPath} → ${PLUGIN_SRC}`);
    say("  --revert 会做：从最近的备份恢复 package.json，并删掉那个联接。");
    say("\n  ⚠ 本脚本不会重启内核。装完要由你在客户端里按一次重启（托盘 → 退出，再打开）。");
  }
  process.exit(0);
}

// ── --revert ──
if (REVERT) {
  const backups = fs.existsSync(backupRoot)
    ? fs.readdirSync(backupRoot).filter((d) => d.startsWith(PLUGIN_NAME + "-")).sort()
    : [];
  if (!backups.length) fail(`找不到备份目录（${backupRoot}\\${PLUGIN_NAME}-*），无法自动恢复。\n  请手工把 package.json 里的 "${PLUGIN_NAME}" 两处删掉。`, 3);
  const latest = path.join(backupRoot, backups[backups.length - 1]);
  const src = path.join(latest, "package.json");
  if (!fs.existsSync(src)) fail(`备份里没有 package.json：${src}`, 3);
  fs.copyFileSync(src, pkgFile);
  say(`  ✓ 已从备份恢复 package.json：${src}`);
  if (fs.existsSync(linkPath)) {
    try {
      if (fs.lstatSync(linkPath).isSymbolicLink() || fs.lstatSync(linkPath).isDirectory()) fs.rmSync(linkPath, { recursive: true, force: true });
      say(`  ✓ 已删除联接：${linkPath}`);
    } catch (e) { say(`  ! 删联接失败（可手工删）：${e.message}`); }
  } else say("  · 联接本来就不存在");
  const after = report(readPkg());
  say(`\n  回滚后：dependencies=${after.dep !== undefined ? after.dep : "（未登记）"} | bundles 含它=${after.inBundles}`);
  say("  改动要生效，同样需要重启一次客户端。");
  process.exit(0);
}

// ── --apply ──
{
  const { raw, json } = readPkg();

  // 预检 1：profile 目录要在
  if (!fs.existsSync(path.join(profileDir, "node_modules"))) fail(`profile 的 node_modules 不存在：${path.join(profileDir, "node_modules")}`, 3);

  // 预检 2：不许踩到别的插件
  const bundles = ((json.dsh || {}).profile || {}).bundles;
  if (!Array.isArray(bundles)) fail(`profile package.json 里 dsh.profile.bundles 不是数组 —— 结构变了，本脚本拒绝动手`, 3);

  // 预检 3：联接位置不能是别人
  if (fs.existsSync(linkPath)) {
    const t = linkTarget(linkPath);
    const isOurs = t && path.resolve(t).toLowerCase() === path.resolve(PLUGIN_SRC).toLowerCase();
    if (!isOurs) {
      const stat = fs.lstatSync(linkPath);
      if (!stat.isSymbolicLink()) fail(`node_modules\\${PLUGIN_NAME} 已存在且**不是联接**（是真实目录）——拒绝覆盖：${linkPath}`, 3);
    }
  }

  // ① 备份
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bdir = path.join(backupRoot, `${PLUGIN_NAME}-${stamp}`);
  fs.mkdirSync(bdir, { recursive: true });
  fs.copyFileSync(pkgFile, path.join(bdir, "package.json"));
  for (const extra of ["pnpm-lock.yaml", "cordis.patch.yml"]) {
    const f = path.join(profileDir, extra);
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(bdir, extra));
  }
  say(`  ① 已备份 → ${bdir}`);

  // ② + ③ 改 package.json
  const next = JSON.parse(raw);
  next.dependencies = next.dependencies || {};
  next.dependencies[PLUGIN_NAME] = "link:" + PLUGIN_SRC;
  next.dsh = next.dsh || {};
  next.dsh.profile = next.dsh.profile || {};
  const list = Array.isArray(next.dsh.profile.bundles) ? next.dsh.profile.bundles.slice() : [];
  if (!list.includes(PLUGIN_NAME)) list.push(PLUGIN_NAME);
  next.dsh.profile.bundles = list;
  fs.writeFileSync(pkgFile, JSON.stringify(next, null, 2) + "\n", "utf8");
  say(`  ② dependencies["${PLUGIN_NAME}"] = "link:${PLUGIN_SRC}"`);
  say(`  ③ dsh.profile.bundles += "${PLUGIN_NAME}"  （现在 ${list.length} 项）`);

  // ④ 目录联接
  if (fs.existsSync(linkPath)) fs.rmSync(linkPath, { recursive: true, force: true });
  const r = spawnSync("cmd", ["/c", "mklink", "/J", linkPath, PLUGIN_SRC], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0 || !fs.existsSync(linkPath)) {
    // 退路：复制（编辑仓库后需要重跑本脚本）
    say(`  ! mklink 失败（${(r.stderr || r.stdout || "").trim() || "无输出"}）——退回复制模式`);
    fs.cpSync(PLUGIN_SRC, linkPath, { recursive: true });
    say(`  ④ 已复制（不是联接）：${linkPath}`);
  } else {
    say(`  ④ 已建目录联接：${linkPath} → ${PLUGIN_SRC}`);
  }

  // ⑤ 复核
  const st = report(readPkg());
  const okDep = st.dep === "link:" + PLUGIN_SRC;
  const okBundle = st.inBundles;
  const okLink = !!st.target;
  const okClient = fs.existsSync(path.join(PLUGIN_SRC, "lib", "client.js"));
  say(`\n  复核：dependencies=${okDep ? "✓" : "✗"}  bundles=${okBundle ? "✓" : "✗"}  联接=${okLink ? "✓" : "✗"}  client.js=${okClient ? "✓" : "✗"}`);
  if (!(okDep && okBundle && okLink && okClient)) fail("落盘后复核没全过 —— 请看上面逐项，别继续", 4);

  say(`\n  ✓ 磁盘状态已就位。**但还没有生效** —— 本脚本刻意不重启内核`);
  say(`    （本会话的 AI 自己就跑在那个内核里，重启等于把自己杀掉）。请你在客户端里做一下：`);
  say(`      托盘图标右键 → 退出  →  重新打开客户端`);
  say(`    或：设置 → 诊断与修复 → 「纯净启动」/「重启内核」（任一都会重新读 profile）。`);
  say(`    回来后可跑：node scripts/install-plugin.js --status   确认仍然是这套。`);
  say(`    不满意就：node scripts/install-plugin.js --revert      回到装之前。\n`);
}
