"use strict";

/**
 * packaged-npm-check.js —— 证明**产物里那份 npm 真的能装出一个能跑的内核**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么还要单独有这一个脚本（`kernel-provision-check` 已经验过一遍了）
 * ═══════════════════════════════════════════════════════════════════════════
 * 因为那一个验的是**开发机**那条路 —— `bundledNpmDir()` 在开发机上读到的是
 * `<repo>/runtime/npm`。而打包版读的是 **`process.resourcesPath/npm`**
 * （= `<安装目录>\resources\npm`）。**两条路是两个不同的目录。**
 *
 * ★★ 2026-09-25 实测：这个区别当场抓到一个会让整条链断掉的 bug ——
 *    electron-builder 的 `extraResources` 把 `node_modules` **整个丢掉了**
 *    （`runtime/npm` 1943 个文件 → 产物里只剩 **418 个 / 3.2 MB**，
 *     `node_modules` 目录**根本不存在**）。
 *    而 `kernel-provision-check` 在开发机上跑一万遍都是绿的 —— 它压根没看产物。
 *
 *    根因（读源码坐实的，不是猜的）：`app-builder-lib/out/util/filter.js:43-45`
 *      if (relative === "node_modules") { return false; }
 *    对 `from` 目录下**正好叫 node_modules** 的那一层**无条件拒绝**。
 *    ⇒ 修法是把里层 node_modules 拆成**第二条 extraResources**
 *      （`from: runtime/npm/node_modules` → `to: npm/node_modules`），
 *      那样它的相对路径不再是 "node_modules"，就能过。
 *    ⇒ 所以**必须有一个脚本回读产物**，否则这个 bug 只会在用户机器上暴露。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 判据（全部是"真跑"，不是"文件在那儿"）
 * ═══════════════════════════════════════════════════════════════════════════
 *   ① 产物里 `resources\npm` 存在且**文件数与 runtime/npm 一致**（尺子先对一遍）
 *   ② 用**产物里那个 electron.exe** 跑**产物里那个 npm-cli.js** `--version` ⇒ 拿到版本号
 *      （两个都取自产物 ⇒ 这才等价于"用户拿到 exe 之后的那次运行"）
 *   ③ 用**产物里的 npm** 真装一次内核到临时目录 ⇒ 装出来的内核真能跑（`--version`）
 *
 * 用法：
 *   node scripts/packaged-npm-check.js              # 用默认产物 release/win-unpacked
 *   node scripts/packaged-npm-check.js <安装目录>    # 指定别的产物
 *   node scripts/packaged-npm-check.js --quick      # 跳过 ③（不真下 214 MB）
 *
 * ⚠️ 需要先 `npm run pack`。它**只写临时目录**，绝不碰用户的真家。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const QUICK = process.argv.includes("--quick");

let OK = 0;
const FAILS = [];
const SKIPS = [];
function chk(cond, label, extra) {
  if (cond) { OK++; console.log(`  OK   ${label}`); }
  else { FAILS.push(label + (extra ? `  <-- ${extra}` : "")); console.log(`  FAIL ${label}${extra ? "  <-- " + extra : ""}`); }
}
function skip(label, why) { SKIPS.push(label); console.log(`  SKIP ${label}  （${why}）`); }
function section(t) { console.log(`\n=== ${t} ===`); }

/** 数一个目录里的文件数（跟随联接 —— 本项目踩过 Dirent 对 Junction 返回 false 的坑）。 */
function countFiles(dir) {
  let n = 0;
  (function w(d) {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      let isDir = false;
      try { isDir = fs.statSync(p).isDirectory(); } catch { continue; }
      if (isDir) w(p); else n += 1;
    }
  })(dir);
  return n;
}

const argDir = process.argv.find((a) => a && !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]);
const INSTALL_DIR = argDir ? path.resolve(argDir) : path.join(REPO, "release", "win-unpacked");
const RES = path.join(INSTALL_DIR, "resources");
const NPM_DIR = path.join(RES, "npm");
const NPM_CLI = path.join(NPM_DIR, "bin", "npm-cli.js");
const EXE = path.join(INSTALL_DIR, "DSH Integrated.exe");

console.log("packaged-npm-check —— 产物里那份 npm 真能装出一个能跑的内核吗");
console.log(`产物目录: ${INSTALL_DIR}`);

// ═════════════════════════════════════════════════════════════════════════
section("① 产物里有没有那份 npm（`kernel-provision-check` 看不见这一层）");
// ═════════════════════════════════════════════════════════════════════════
if (!fs.existsSync(INSTALL_DIR)) {
  console.error(`找不到产物目录：${INSTALL_DIR}`);
  console.error("（先跑 `npm run pack`）");
  process.exit(1);
}
console.log(`  安装目录存在: ${fs.existsSync(INSTALL_DIR)}`);
console.log(`  resources 存在: ${fs.existsSync(RES)}`);
chk(fs.existsSync(NPM_DIR), "★ 产物里有 resources\\npm（extraResources 生效了）", NPM_DIR);
chk(fs.existsSync(NPM_CLI), "★ 产物里有 bin\\npm-cli.js（npm 的入口）", NPM_CLI);
chk(fs.existsSync(path.join(NPM_DIR, "node_modules")),
  "★★ 产物里有 node_modules（**这一条就是 2026-09-25 抓到的那个 bug**）",
  path.join(NPM_DIR, "node_modules"));

// ★ 尺子先对一遍：产物里的文件数必须与 runtime/npm 一致。
//   只断言"node_modules 存在"不够 —— 它可能只拷进去一部分。
{
  const srcDir = path.join(REPO, "runtime", "npm");
  if (fs.existsSync(srcDir)) {
    const a = countFiles(NPM_DIR);
    const b = countFiles(srcDir);
    console.log(`  产物 ${a} 个文件 / runtime/npm ${b} 个文件`);
    chk(a === b, "★★ 产物里的 npm 与 runtime/npm **文件数一致**（没被 electron-builder 丢掉一部分）",
      `产物=${a} 源=${b}`);
    if (a !== b) {
      console.log("      ⇒ 差集（源有、产物没有）前 10 个：");
      const rel = (base, d, out) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          let isDir = false; try { isDir = fs.statSync(p).isDirectory(); } catch { continue; }
          if (isDir) rel(base, p, out); else out.add(path.relative(base, p));
        }
        return out;
      };
      const A = rel(NPM_DIR, NPM_DIR, new Set());
      const B = rel(srcDir, srcDir, new Set());
      for (const f of [...B].filter((x) => !A.has(x)).slice(0, 10)) console.log(`         - ${f}`);
    }
  } else {
    skip("产物 vs runtime/npm 文件数一致", "本机没有 runtime/npm（先跑 node scripts/fetch-npm.js）");
  }
}

// ═════════════════════════════════════════════════════════════════════════
section("② 用**产物里的** electron 跑**产物里的** npm（等价于用户机器上那一次）");
// ═════════════════════════════════════════════════════════════════════════
chk(fs.existsSync(EXE), "★ 产物里有主程序 exe", EXE);
if (!fs.existsSync(EXE)) {
  console.log("  ⇒ 后面无法进行");
  return finish();
}
{
  // ★ 必须清掉继承来的 ELECTRON_RUN_AS_NODE —— 本项目 AGENTS.md §6 记过：
  //   带着它起 electron.exe 时 Electron 会退化成纯 Node（但这里我们**故意**要它当 Node）。
  //   所以这里是**显式设成 1**，而不是"碰巧继承到了"。
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const r = spawnSync(EXE, [NPM_CLI, "--version"], { encoding: "utf8", timeout: 120000, env });
  const out = String(r.stdout || "").trim();
  console.log(`  npm 自报版本 = ${out}   status=${r.status}`);
  if (r.stderr) console.log(`  stderr: ${String(r.stderr).slice(0, 200)}`);
  chk(r.status === 0 && /^\d+\.\d+/.test(out),
    "★★ 真跑：产物里的 electron.exe + 产物里的 npm-cli.js ⇒ 拿到版本号",
    `status=${r.status} out=${out}`);
}

if (QUICK) {
  skip("③ 用产物里的 npm 真装一次内核", "--quick");
  return finish();
}

// ═════════════════════════════════════════════════════════════════════════
section("③ 用**产物里的 npm** 真装一次内核（约 214 MB / 1.5 分钟）");
// ═════════════════════════════════════════════════════════════════════════
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-pkg-npm-"));
console.log(`  临时落点: ${TMP}`);
{
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.npm_config_proxy; delete env.npm_config_https_proxy;
  delete env.HTTP_PROXY; delete env.HTTPS_PROXY;

  const t0 = Date.now();
  const r = spawnSync(EXE, [
    NPM_CLI, "install", "--prefix", TMP,
    "--no-save", "--no-audit", "--no-fund", "--loglevel=error", "--ignore-scripts",
    "@deepseek-ai/dsh",
  ], { encoding: "utf8", timeout: 20 * 60 * 1000, env, maxBuffer: 64 * 1024 * 1024 });
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`  用时 ${secs} 秒   status=${r.status}`);
  if (r.status !== 0) {
    console.log(`  stdout 尾部: ${String(r.stdout || "").slice(-600)}`);
    console.log(`  stderr 尾部: ${String(r.stderr || "").slice(-600)}`);
  }
  chk(r.status === 0, "★★ 产物里的 npm 真能把内核装下来", `status=${r.status}`);

  const bin = path.join(TMP, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  chk(fs.existsSync(bin), "★ 装出来的内核有 lib/bin.js", bin);

  // ★ 判据是"能不能跑"，不是"文件在不在"（本项目铁律）
  if (fs.existsSync(bin)) {
    const q = spawnSync(EXE, ["--expose-internals", bin, "--version"],
      { encoding: "utf8", timeout: 120000, env: { ...env, DSH_HOME: path.join(TMP, "probe-home") } });
    const v = String(q.stdout || "").trim();
    console.log(`  内核自报版本 = ${v}   status=${q.status}`);
    chk(q.status === 0 && /^\d+\.\d+/.test(v),
      "★★ 真跑：产物 npm 装出来的内核**真能起来**（拿到版本号）",
      `status=${q.status} out=${v} err=${String(q.stderr || "").slice(0, 160)}`);
  }
}

return finish();

function finish() {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 忽略 */ }
  console.log(`\n${"=".repeat(64)}`);
  console.log(`packaged-npm-check：${OK} OK / ${FAILS.length} FAIL / ${SKIPS.length} SKIP`);
  if (FAILS.length) { console.log("失败项："); for (const f of FAILS) console.log(`  · ${f}`); }
  if (SKIPS.length) { console.log("跳过项（**不算通过**）："); for (const s of SKIPS) console.log(`  · ${s}`); }
  process.exit(FAILS.length ? 1 : 0);
}
