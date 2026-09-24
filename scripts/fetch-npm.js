"use strict";

/**
 * fetch-npm.js —— 打包前把 **npm 本体**拉到 `runtime/npm/`，随包分发。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 它解决什么问题（2026-09-25，用户分发后反馈的真问题）
 * ═══════════════════════════════════════════════════════════════════════════
 * 用户原话：「我们这个纯粹的外壳下载之后还得麻烦用户自己去跑命令行下载
 * 前面这两个东西才能用，这里就不比社区版简便了。」
 *
 * 那两个"东西"其实是：
 *   · **Node.js**  → ❌ **不需要**。外壳早就是用 Electron 自己当 Node 跑内核的
 *                    （`src/kernel.js` 的 `spawn(process.execPath, …, ELECTRON_RUN_AS_NODE:"1")`）。
 *   · **dsh 内核** → ✅ 真缺。发现链里 `vendor/dsh` 不存在，只能退到"全局 npm"，
 *                    而新用户机器上没有它。
 *
 * 要把内核装上，最省事的办法是跑 npm。**但 npm 命令需要 Node.js** ——
 * 对方机器上没有 ⇒ 死循环。
 *
 * ★ 解法（2026-09-25 真跑验证过）：
 *   npm 本体是**纯 JS**（零平台二进制、11.7 MB），可以用 **Electron 自带的 Node** 跑：
 *     electron.exe  <npm 目录>/bin/npm-cli.js  install …
 *   实测：`npm view @deepseek-ai/dsh version` → `0.1.5-rc.3` ✅
 *        真装一次内核 → 518 个包 / 89 秒 / 214 MB，装完 `dsh --version` 能跑 ✅
 *
 * ⇒ 于是"用户要装 node"这件事**彻底消失**：npm 随外壳走，Electron 当 Node。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三条刻意的决定
 * ═══════════════════════════════════════════════════════════════════════════
 * ① **从 registry 拉，不从本机 Node.js 拷。**
 *    拷本机的看起来更省事，但会把"构建机上碰巧装的 npm 版本"烙进产物 ——
 *    换台机器构建就得到不同的包，而且本机 npm 可能带着全局配置的痕迹。
 *    从 registry 拉 ⇒ **可复现、版本可钉**，和拉插件是同一种做法。
 * ② **解包用系统自带 `tar.exe`**（与 `plugin-install.js` 同一条路）——
 *    不引任何依赖，也不需要 node/npm 就能解。
 * ③ **幂等**：已经拉过同一个版本就跳过（除非 `--force`）。
 *    判据是 `.npm-version` 文件里的版本号，不是"目录存在" ——
 *    目录存在但版本不对时**必须重拉**，否则升了版本还发旧 npm。
 *
 * 用法（由 package.json 的 pack / dist / dist:portable 自动调用）：
 *   node scripts/fetch-npm.js              # 拉（已有同版本就跳过）
 *   node scripts/fetch-npm.js --force      # 强制重拉
 *   node scripts/fetch-npm.js --check      # 只读：现在打包的话，npm 齐不齐
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const OUT = path.join(REPO, "runtime", "npm");
const STAMP = path.join(OUT, ".npm-version");

const REGISTRY = "https://registry.npmjs.org";
/**
 * 钉住的 npm 版本。**故意写死** —— 见上面决定①（可复现）。
 *
 * ★★ 为什么是 11.x 而不是最新的 12.x（2026-09-25 实测，别随手升上去）
 * ─────────────────────────────────────────────────────────────────────
 * 我们要用 **Electron 自带的 Node** 跑这个 npm，而 Electron 37.10.3 带的是
 * **Node 22.21.1**。两个版本的 `engines.node` 对不上：
 *
 *   npm 12.1.0 → `^22.22.2 || ^24.15.0 || >=26.0.0`   ← 22.21.1 **不满足**
 *   npm 11.20.0 → `^20.17.0 || >=22.9.0`              ← 22.21.1 **满足**
 *
 * 实测 npm 12.1.0 虽然**仍然装得成**（真装过一次内核，见 packaged-npm-check），
 * 但每次调用都会打一行警告：
 *   `npm warn cli npm v12.1.0 does not support Node.js v22.21.1.`
 * ⇒ 那行警告会出现在**用户的安装日志**里（我们把它原样流到界面上），
 *   看起来像出了故障；而且"不支持"是上游的明确声明，**不能拿"这次碰巧成了"当保证**。
 *
 * ⇒ 选 11.20.0：官方声明支持这个 Node 版本，且仍是维护中的现代 npm。
 *   ⚠️ 将来若要升到 12.x，**先确认 Electron 带的 Node ≥ 22.22.2**
 *   （`electron.exe -e "console.log(process.versions.node)"`），
 *   然后跑 `node scripts/fetch-npm.js --force` 重拉，并重跑 packaged-npm-check。
 */
const NPM_VERSION = "11.20.0";

const FORCE = process.argv.includes("--force");
const CHECK = process.argv.includes("--check");

const say = (m) => console.log(m);
const problems = [];

// ── 小工具 ────────────────────────────────────────────────────────────

/** 算一个文件的 sha512 SRI（与 npm registry 的 `dist.integrity` 同格式）。 */
function sha512SriFile(abs) {
  const h = crypto.createHash("sha512");
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return "sha512-" + h.digest("base64");
}

function human(b) {
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + " MB";
  if (b >= 1024) return (b / 1024).toFixed(1) + " KB";
  return b + " B";
}

/** 递归列文件。★ 联接单独登记 —— 产物里带联接 = 打包会带死链（项目里踩过）。 */
function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    let isLink = false;
    try { isLink = fs.lstatSync(p).isSymbolicLink(); } catch { continue; }
    if (isLink) { out.push(p); continue; }        // 联接：登记但不进去
    let isDir = false;
    try { isDir = fs.statSync(p).isDirectory(); } catch { continue; }
    if (isDir) walk(p, out); else out.push(p);
  }
  return out;
}

/** 已有那一份的版本号（读不到返回空串）。 */
function installedVersion() {
  try {
    const v = fs.readFileSync(STAMP, "utf8").trim();
    return v;
  } catch { return ""; }
}

/** 校验一份 npm 目录**能不能用**：入口在、依赖在。 */
function validate(dir) {
  const cli = path.join(dir, "bin", "npm-cli.js");
  const nm = path.join(dir, "node_modules");
  if (!fs.existsSync(cli)) return "缺 bin/npm-cli.js";
  if (!fs.existsSync(nm)) return "缺 node_modules（npm 的依赖没解出来）";
  return "";
}

/**
 * ★★ 这份 npm 声明的 Node 版本，Electron 带的那一个满不满足？
 *
 * 为什么非要有这一条（2026-09-25 实测踩到）：
 *   我们要用 **Electron 自带的 Node** 跑这个 npm，而两者的版本可能对不上：
 *     Electron 37.10.3 → Node **22.21.1**
 *     npm 12.1.0       → `^22.22.2 || …`  ← **不满足**，每次调用都打一行警告
 *     npm 11.20.0      → `^20.17.0 || >=22.9.0`  ← 满足
 *   那行警告会被我们**原样流进用户的安装日志**，看起来像出了故障。
 *   而"这次碰巧装成了"不是保证 —— 所以把这条**机械判住**，不靠人记得。
 *
 * ★ 只做**区间判断**，不引 semver 依赖（外壳一直是零运行时依赖，脚本也不该拖一个进来）。
 *   能识别的形式：`^X.Y.Z`、`>=X.Y.Z`、`>=X.Y.Z <A.B.C`、`X.Y.Z`。
 *   识别不了的（如 `||` 组合里出现不认识的段）就**明确说"判不了"**，
 *   不假装通过 —— 本项目铁律：拿不到就写出来，不许编。
 *
 * @returns {{ok:boolean, verdict:string}} ok=false 表示**确定不满足**；
 *          verdict="unknown" 表示判不了（调用方自己决定怎么处置）
 */
function enginesVerdict(npmDir) {
  let engines = null;
  try {
    engines = JSON.parse(fs.readFileSync(path.join(npmDir, "package.json"), "utf8")).engines;
  } catch { return { ok: true, verdict: "unknown", reason: "读不到 npm 自己的 package.json" }; }
  const range = engines && engines.node;
  if (!range) return { ok: true, verdict: "unknown", reason: "这份 npm 没声明 engines.node" };

  // 当前 Electron 带的 Node
  //
  // ★★ 这里**必须问 Electron 本体**，不能读 `process.versions.node` ——
  //   这个脚本是用**系统 node** 跑的（`node scripts/fetch-npm.js`），
  //   而真正在用户机器上跑这份 npm 的是 `electron.exe` + `ELECTRON_RUN_AS_NODE=1`。
  //   两者版本**不一样**：本机实测系统 node = 24.20.0，Electron 37.10.3 带的是 22.21.1。
  //   （第一版就是拿 process.execPath 量的，于是打出"Electron 带 Node 24.20.0"
  //     这种**自相矛盾**的结论 —— 又一个"尺子撒谎"的活例。）
  const electronExe = path.join(REPO, "node_modules", "electron", "dist",
    process.platform === "win32" ? "electron.exe" : "electron");
  if (!fs.existsSync(electronExe)) {
    return { ok: true, verdict: "unknown", reason: `找不到 Electron（${electronExe}）⇒ 问不出它带哪个 Node` };
  }
  const r = spawnSync(electronExe, ["-e", "process.stdout.write(process.versions.node)"],
    { encoding: "utf8", timeout: 60000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  const cur = String(r.stdout || "").trim();
  if (!/^\d+\.\d+\.\d+/.test(cur)) {
    return { ok: true, verdict: "unknown", reason: `问不出 Electron 带的 Node 版本（got "${cur}"）` };
  }

  const cmp = (a, b) => {
    const A = a.split(".").map(Number), B = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) { if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) < (B[i] || 0) ? -1 : 1; }
    return 0;
  };

  // `||` 拆成若干子句；每个子句里可以有空格分隔的多个条件（全部要满足）
  const clauses = String(range).split("||").map((s) => s.trim()).filter(Boolean);
  let sawUnknown = false;
  for (const clause of clauses) {
    const conds = clause.split(/\s+/).filter(Boolean);
    let all = true;
    for (const c of conds) {
      const m = c.match(/^(\^|>=|>|<=|<|=)?\s*v?(\d+)\.(\d+)\.(\d+)$/);
      if (!m) { all = false; sawUnknown = true; break; }
      const [, op, mj, mn, pt] = m;
      const want = `${mj}.${mn}.${pt}`;
      const d = cmp(cur, want);
      if (op === "^") {
        // ^X.Y.Z ⇒ >=X.Y.Z 且 <(X+1).0.0
        if (!(d >= 0 && Number(mj) === Number(cur.split(".")[0]))) { all = false; break; }
      } else if (op === ">=") { if (!(d >= 0)) { all = false; break; } }
      else if (op === ">") { if (!(d > 0)) { all = false; break; } }
      else if (op === "<=") { if (!(d <= 0)) { all = false; break; } }
      else if (op === "<") { if (!(d < 0)) { all = false; break; } }
      else { if (d !== 0) { all = false; break; } }
    }
    if (all) return { ok: true, verdict: "satisfied", range, node: cur };
  }
  return {
    ok: false, verdict: sawUnknown ? "unknown" : "violated",
    range, node: cur,
    reason: `这份 npm 声明 engines.node = "${range}"，而 Electron 带的是 Node ${cur}`,
  };
}

// ── --check：只读体检 ─────────────────────────────────────────────────

if (CHECK) {
  say(`fetch-npm --check（只读）`);
  say(`  期望版本: ${NPM_VERSION}`);
  const cur = installedVersion();
  say(`  现有版本: ${cur || "(没有)"}`);
  if (cur !== NPM_VERSION) {
    say(`  ⇒ 现在打包会**不带 npm**（或带的是旧版）—— 先跑 node scripts/fetch-npm.js`);
    process.exit(2);
  }
  const bad = validate(OUT);
  if (bad) { say(`  ⇒ 现有那份不完整：${bad}`); process.exit(2); }
  const files = walk(OUT);
  const bytes = files.reduce((s, f) => { try { return s + fs.statSync(f).size; } catch { return s; } }, 0);
  say(`  ✓ 齐了：${files.length} 个文件 / ${human(bytes)}`);
  process.exit(0);
}

// ── 主流程 ────────────────────────────────────────────────────────────

say(`fetch-npm —— 把 npm ${NPM_VERSION} 拉进 runtime/npm（随包分发，用户就不必装 Node.js）\n`);

// ① 已经拉过同一个版本？跳过
if (!FORCE) {
  const cur = installedVersion();
  if (cur === NPM_VERSION) {
    const bad = validate(OUT);
    if (!bad) {
      const files = walk(OUT);
      const bytes = files.reduce((s, f) => { try { return s + fs.statSync(f).size; } catch { return s; } }, 0);
      say(`① 已就位：npm ${cur}（${files.length} 个文件 / ${human(bytes)}）—— 跳过`);
      say(`   （要强制重拉：node scripts/fetch-npm.js --force）`);
      process.exit(0);
    }
    say(`① 现有那份不完整（${bad}）⇒ 重拉`);
  } else if (cur) {
    say(`① 现有版本是 ${cur}，要的是 ${NPM_VERSION} ⇒ 重拉`);
  } else {
    say(`① 还没拉过 ⇒ 开始`);
  }
} else {
  say(`① --force ⇒ 强制重拉`);
}

// ② 查 registry 拿 tarball + integrity
let meta = null;
{
  const r = spawnSync(process.execPath, ["-e", `
    const https=require("https");
    https.get(${JSON.stringify(REGISTRY + "/npm/" + NPM_VERSION)}, {headers:{"User-Agent":"dsh-fetch-npm"}}, res=>{
      if(res.statusCode!==200){ console.error("HTTP "+res.statusCode); process.exit(3); }
      let s=""; res.setEncoding("utf8");
      res.on("data",d=>s+=d);
      res.on("end",()=>{ process.stdout.write(s); });
    }).on("error",e=>{ console.error(e.message); process.exit(3); });
  `], { encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(`   ✗ 取不到元数据：${(r.stderr || "").trim() || "未知"}`);
    process.exit(1);
  }
  try { meta = JSON.parse(r.stdout); } catch (e) {
    console.error(`   ✗ 元数据不是合法 JSON：${e.message}`);
    process.exit(1);
  }
}
const dist = meta.dist || {};
if (!dist.tarball || !/^https:\/\//.test(dist.tarball)) {
  console.error(`   ✗ 元数据里没有可用的 dist.tarball`);
  process.exit(1);
}
say(`   ✓ tarball = ${dist.tarball}`);
say(`   ✓ integrity = ${String(dist.integrity || "").slice(0, 32)}…`);

// ③ 下载
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-npm-"));
const tgz = path.join(tmp, `npm-${NPM_VERSION}.tgz`);
say(`\n③ 下载 → ${tgz}`);
{
  const r = spawnSync("curl.exe", [
    "-sS", "-L", "--fail", "--max-time", "300",
    "-o", tgz, dist.tarball,
  ], { encoding: "utf8", timeout: 320000 });
  if (r.status !== 0 || !fs.existsSync(tgz)) {
    console.error(`   ✗ 下载失败：${(r.stderr || "").trim() || `退出码 ${r.status}`}`);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
    process.exit(1);
  }
}
const gotBytes = fs.statSync(tgz).size;
say(`   ✓ 下载完成 ${human(gotBytes)}`);

// ④ 按官方 integrity 逐字节校验（**不过就删**）
say(`\n④ 校验 sha512 integrity`);
if (dist.integrity) {
  const got = sha512SriFile(tgz);
  if (got !== dist.integrity) {
    console.error(`   ✗ 校验不通过！`);
    console.error(`     期望 ${dist.integrity}`);
    console.error(`     实得 ${got}`);
    console.error(`     —— 已丢弃，请重试（网络截断或被中间人改过）`);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
    process.exit(1);
  }
  say(`   ✓ 与官方 integrity 逐字节一致`);
} else {
  say(`   ⚠ 官方没给 integrity ⇒ 跳过（但下面仍会做结构校验）`);
}

// ⑤ 解包（用系统自带 tar.exe，与 plugin-install 同一条路）
say(`\n⑤ 解包（tar.exe）`);
{
  const r = spawnSync("tar.exe", ["-xzf", tgz, "-C", tmp], { encoding: "utf8", timeout: 300000 });
  if (r.status !== 0) {
    console.error(`   ✗ 解包失败：${(r.stderr || "").trim() || `退出码 ${r.status}`}`);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
    process.exit(1);
  }
}
const pkgDir = path.join(tmp, "package");
if (!fs.existsSync(pkgDir)) {
  console.error(`   ✗ 解出来没有 package/ 目录`);
  process.exit(1);
}

// ⑥ 结构校验（**判据是"能不能跑"，不是"文件在不在"**）
say(`\n⑥ 结构校验`);
{
  const bad = validate(pkgDir);
  if (bad) {
    console.error(`   ✗ ${bad}`);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
    process.exit(1);
  }
  const v = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
  if (v !== NPM_VERSION) {
    console.error(`   ✗ 解出来的版本是 ${v}，要的是 ${NPM_VERSION}`);
    process.exit(1);
  }
  say(`   ✓ bin/npm-cli.js 在、node_modules 在、版本 = ${v}`);
}

// ⑦ 真跑一次（★ 这才是硬判据 —— 前几步只证明"文件在那儿"）
say(`\n⑦ 真跑一次（用 Electron 当 Node）`);
{
  const electron = path.join(REPO, "node_modules", "electron", "dist", "electron.exe");
  if (fs.existsSync(electron)) {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    const r = spawnSync(electron, [path.join(pkgDir, "bin", "npm-cli.js"), "--version"],
      { encoding: "utf8", timeout: 60000, env });
    const out = String(r.stdout || "").trim();
    const errText = String(r.stderr || "");
    if (r.status === 0 && out) {
      say(`   ✓ electron.exe + npm-cli.js --version => ${out}`);
      // ★★ 顺带把"上游说它不支持这个 Node"抓出来。
      //   实测 npm 12.1.0 会打：`npm warn cli npm v12.1.0 does not support Node.js v22.21.1.`
      //   它**仍然装得成**，但那行警告会被我们原样流进用户的安装日志，看起来像故障。
      if (/does not support Node\.js/i.test(errText)) {
        problems.push(`这份 npm 自己说它**不支持** Electron 带的那个 Node ——`
          + ` ${errText.split(/\r?\n/).find((l) => /does not support Node\.js/i.test(l)).trim()}`
          + `\n     ⇒ 请把 NPM_VERSION 换成声明支持该 Node 版本的 npm（见文件顶部的注释）`);
        say(`   ✗ 它自报不支持当前 Node（已记为问题）`);
      }
    } else {
      // ★ 不因此退出：构建机可能没装 electron（还没 npm install）。
      //   但必须**如实报出来**，别假装验过。
      say(`   ⚠ 没验成（退出码 ${r.status}）：${(errText || out || "").trim().slice(0, 200)}`);
      say(`     —— 这不影响产物；但"能不能真跑"这一条本轮**没验到**`);
    }
  } else {
    say(`   ⚠ 找不到 ${electron}（还没 npm install？）⇒ 真跑这一条**跳过**，没验到`);
  }
}

// ⑦.5 ★ 静态判一遍 engines.node（不依赖"跑起来碰巧没报错"）
//
// 为什么单列一条：⑦ 那次真跑**可能因为构建机没装 electron 而跳过**，
// 那时"版本兼容"就完全没人看了。engines 是**声明**，静态就能判，不受此影响。
say(`\n⑦.5 engines.node 兼容性（静态判，不依赖真跑）`);
{
  const v = enginesVerdict(pkgDir);
  if (v.verdict === "satisfied") {
    say(`   ✓ npm 声明 ${v.range}，Electron 带 Node ${v.node} ⇒ **满足**`);
  } else if (v.verdict === "unknown") {
    say(`   ⚠ 判不了：${v.reason}`);
    say(`     —— 不阻断构建，但"兼容"这一条本轮**没验到**`);
  } else {
    problems.push(`${v.reason}\n     ⇒ 请把 NPM_VERSION 换成声明支持该 Node 版本的 npm`
      + `（npm 12.x 要 Node ^22.22.2，而 Electron 37.10.3 只带 22.21.1）`);
    say(`   ✗ ${v.reason} ⇒ **不满足**（已记为问题）`);
  }
}

// ⑧ 落位（先删旧的，再整体搬过去 —— 避免上一次的残留混进来）
say(`\n⑧ 落位 → ${OUT}`);
try { fs.rmSync(OUT, { recursive: true, force: true }); } catch { /* 忽略 */ }
fs.mkdirSync(OUT, { recursive: true });
// 用 fs.cpSync 递归拷（同盘；不用联接）
fs.cpSync(pkgDir, OUT, { recursive: true });
fs.writeFileSync(STAMP, NPM_VERSION + "\n", "utf8");
say(`   ✓ 已落位，并写了 .npm-version = ${NPM_VERSION}`);

// ⑨ 回读核对（不信上面的自述）
say(`\n⑨ 回读核对`);
{
  const bad = validate(OUT);
  if (bad) problems.push(`回读发现：${bad}`);
  const files = walk(OUT);
  const links = files.filter((f) => { try { return fs.lstatSync(f).isSymbolicLink(); } catch { return false; } });
  const bytes = files.reduce((s, f) => { try { return s + fs.statSync(f).size; } catch { return s; } }, 0);
  say(`   文件 ${files.length} 个 / ${human(bytes)}`);
  if (links.length) problems.push(`产物里有 ${links.length} 个联接（打包会带死链）`);
  const cur = installedVersion();
  if (cur !== NPM_VERSION) problems.push(`.npm-version 读回是 "${cur}"，要的是 "${NPM_VERSION}"`);
  if (!problems.length) say(`   ✓ 齐了、版本对、无联接`);
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }

// ── 汇总 ──
say(`\n${"=".repeat(64)}`);
if (problems.length) {
  say(`✗ 有问题：`);
  for (const p of problems) say(`   · ${p}`);
  process.exit(1);
}
say(`✅ 完成。runtime/npm 已就绪 —— electron-builder 会把它拷进 resources/npm/。`);
say(`   用户因此**不需要安装 Node.js**。`);
