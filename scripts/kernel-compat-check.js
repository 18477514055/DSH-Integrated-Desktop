"use strict";

/**
 * kernel-compat-check.js —— **某一版官方内核，能不能跟外壳这一版一起跑？**
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要这个工具（2026-09-25）
 * ══════════════════════════════════════════════════════════════════
 * 用户问：「你这个检查内核更新的功能可靠吗？我现在只检测到了一个 0.1.5 的一个小版本，
 *   但是现在不是已经跑到 0.1.7 了吗？」
 *
 * 查清"上游把 0.1.7 发在 `next` 标签上"之后，浮出来一个**更要紧**的问题：
 * **0.1.7 在外壳上根本起不来。** 而这句话不能靠读文档推断 ——
 * 本项目 `$DSH_HOME/AGENTS.md` 第二条铁律写得很清楚：
 * 「验证'某东西能否工作'，**必须真让它工作**；'文件存在 / 模块可解析 / 版本号对'
 *   一律不构成证据」。
 *
 * ── 真跑查到的结论（2026-09-25，**两轮**）───────────────────────────
 *
 * 第一轮，外壳当时是 Electron **37.10.3**：
 *
 *   | 内核版本      | 渠道      | 结果 |
 *   |---------------|-----------|------|
 *   | 0.1.5-rc.2    | （在用）  | ✅ 就绪 |
 *   | 0.1.5-rc.3    | `latest`  | ✅ 就绪 |
 *   | 0.1.7-rc.2    | `next`    | ❌ `Unsupported/no-context` |
 *   | 0.1.7-alpha.2 | `alpha`   | ❌ `Unsupported/no-context` |
 *   | 0.1.7-rc.2    | （用**系统 node 24** 跑）| ✅ 就绪 ⇒ 卡的是 **Electron**，不是内核本身 |
 *
 * 第二轮，把外壳升到 Electron **44.0.0**（`--electron=<目录>` 那次试验）：
 * **四个版本全部 ✅ 就绪** —— 这一版外壳因此顺带解开了 0.1.6+ 内核。
 * ⚠️ 中途试过 **44.4.5（当时的最新）——照样起不来**：
 *   unsupported Electron runtime fingerprint: Node 24.21.0, V8 15.2.124.28-electron.0
 *   (supported Electron versions: 43.0.0, 44.0.0, 45.0.0-alpha.6)
 * ⇒ 「升到最新」在这里**是错的**：校验比的是 **V8 运行时的精确指纹**，不是版本区间。
 *   所以 `package.json` 把 electron 钉成**精确的 `44.0.0`**（不带 `^`）。
 *
 * 失败原文（内核自己打的）：
 *
 *   dsh: fatal uncaught exception: Error: dsh: host preparation failed:
 *   node-addon-require-builtin unsupported: Unsupported/no-context
 *   (unsupported Electron runtime fingerprint: Node 22.21.1,
 *    V8 13.8.258.32-electron.0 (supported Electron versions: 43.0.0, 44.0.0, 45.0.0-alpha.6))
 *
 * ── 机制（不是猜的，是逐文件数出来的）───────────────────────────────
 *   · `0.1.5-rc.3` 的 `dsh-app-boot/lib/index.js` 里 `installRuntimeInterception` 出现 **0 次**；
 *   · `0.1.7-rc.2` 的同一文件里出现 **3 次**（`requireBuiltin` 相关 5 处）。
 *   ⇒ 0.1.6/0.1.7 世代**新增了运行时拦截**：要 hook V8 内部去 `require` 内置模块，
 *     而它依赖的 `node-addon-native-custom-loader@0.1.6` 只认上面那三个**精确**指纹
 *     （两个内核带的是**同一个** 0.1.6 版加载器 ⇒ 差别在调用方）。
 *   ★ 那个加载器在 npm 上的**最新版就是 0.1.6**（2026-09-14 发布）
 *     ⇒ 没有"换个新加载器就能支持更多 Electron"这条路。
 *   ⇒ 结论：**外壳用哪个 Electron，是一个被内核硬约束的版本**，不是随便升的实现细节。
 */
 * ══════════════════════════════════════════════════════════════════
 * 用法
 * ══════════════════════════════════════════════════════════════════
 *   node scripts/kernel-compat-check.js --version=0.1.7-rc.2
 *   node scripts/kernel-compat-check.js --version=0.1.5-rc.3 --version=0.1.7-rc.2
 *   node scripts/kernel-compat-check.js --version=0.1.7-rc.2 --runtime=node   # 对照实验
 *
 *   --runtime=electron （默认）用**外壳这一版的 Electron** 跑（这才是"外壳能不能用"的答案）
 *   --runtime=node             用系统 node 跑（对照组：把"内核自己的问题"和"Electron 的问题"分开）
 *   --both                     两个都跑
 *   --keep                     保留临时目录（看内核日志用）
 *
 * ★ 全程只写 `%TEMP%\dsh-kernel-compat\<版本>\`：
 *   不碰用户正在用的内核、不碰全局 npm、不碰 B / A 两个 DSH 家。
 *   DSH_HOME 指向那个临时目录下的一个空家 ⇒ 内核会当一个全新环境启动。
 *
 * 退出码：0 = 全部**能跑**；2 = 有版本起不来；3 = 装不上；4 = 用法错。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const DSH_PKG = "@deepseek-ai/dsh";

const argv = process.argv.slice(2);
const versions = argv.filter((a) => a.startsWith("--version="))
  .map((a) => a.slice("--version=".length).trim()).filter(Boolean);
const runtimeArg = (argv.find((a) => a.startsWith("--runtime=")) || "").slice("--runtime=".length).trim();
const runtimes = runtimeArg === "both" ? ["electron", "node"] : [runtimeArg || "electron"];
const ELECTRON_SPEC = (argv.find((a) => a.startsWith("--electron=")) || "")
  .slice("--electron=".length).trim();
const KEEP = argv.includes("--keep");
const PORT_BASE = Number(process.env.DSH_COMPAT_PORT || 3190);

if (!versions.length) {
  console.error("用法: node scripts/kernel-compat-check.js --version=<版本> [--version=<版本>…]");
  console.error("     可选: --runtime=electron|node|both   --electron=<路径>   --keep");
  console.error("     --electron 可以是 electron.exe 本身，也可以是**装着 electron 的目录**");
  process.exit(4);
}
for (const r of runtimes) {
  if (r !== "electron" && r !== "node") {
    console.error(`--runtime 只认 electron / node / both，给的是「${r}」`);
    process.exit(4);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 解析要用哪个 Electron。
 * ★ `--electron=<新版本目录>` 就是"**换一版 Electron 行不行**"那次试验的入口 ——
 *   内核 0.1.6+ 的兼容性完全由它决定（见文件开头那张真跑表）。
 */
function resolveElectronExe(spec) {
  const exe = process.platform === "win32" ? "electron.exe" : "electron";
  const cands = spec
    ? [path.resolve(spec),
      path.join(path.resolve(spec), exe),
      path.join(path.resolve(spec), "dist", exe),
      path.join(path.resolve(spec), "node_modules", "electron", "dist", exe)]
    : [path.join(ROOT, "node_modules", "electron", "dist", exe)];
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* 继续找 */ }
  }
  return null;
}

/** 去问 **Electron 本体**它是几版（`process.execPath` 是这个脚本的 node，不是它）。 */
function electronVersion(exe) {
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;      // 带着它 Electron 会退化成纯 Node，打印的是 node 的版本
    const r = spawnSync(exe, ["--version"], { env, encoding: "utf8", windowsHide: true, timeout: 30000 });
    return String((r.stdout || "")).trim().replace(/^v/i, "") || "(读不到)";
  } catch { return "(读不到)"; }
}

/** 上面那段 fatal 里最关键的一行（内核自己打出来的），拿不到就退回首行错误。 */
function keyLine(stderr) {
  const lines = String(stderr || "").split(/\r?\n/);
  const fatal = lines.find((l) => /dsh: fatal/.test(l));
  if (fatal) return fatal.trim();
  return (lines.find((l) => /\S/.test(l)) || "").trim();
}

/**
 * 真跑一次：按 `src/kernel.js:347` **完全相同**的方式起内核，看能不能拿到本机地址。
 *
 * @returns {Promise<{ready:boolean, exit:object|null, stdout:string, stderr:string, url:string}>}
 */
async function launch(kernelBin, dshHome, port, runtime, electron) {
  const exe = runtime === "node" ? process.execPath : electron;
  const env = { ...process.env, DSH_HOME: dshHome };
  if (runtime === "node") delete env.ELECTRON_RUN_AS_NODE;
  else env.ELECTRON_RUN_AS_NODE = "1";

  // ★ 参数语法：`--expose-internals` 只有走 Electron 当 Node 时才加（那是内核的启动方式）
  const args = runtime === "electron"
    ? ["--expose-internals", kernelBin, "web", "--host", "127.0.0.1", "--port", String(port), "--no-open"]
    : [kernelBin, "web", "--host", "127.0.0.1", "--port", String(port), "--no-open"];

  const child = spawn(exe, args, { cwd: dshHome, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", exit = null;
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("exit", (code, sig) => { exit = { code, sig }; });

  const deadline = Date.now() + Number(process.env.DSH_COMPAT_WAIT_MS || 90000);
  let url = "";
  while (Date.now() < deadline && !exit) {
    const m = (stdout + stderr).match(/https?:\/\/127\.0\.0\.1:\d+\S*/);
    if (m) { url = m[0]; break; }
    await sleep(1000);
  }
  await sleep(1200);

  try { child.kill(); } catch { /* 已退 */ }
  await sleep(400);
  if (process.platform === "win32" && child.pid) {
    try { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); }
    catch { /* 已经没了 */ }
  }
  return { ready: !!url, exit, stdout, stderr, url };
}

(async () => {
  const root = path.join(os.tmpdir(), "dsh-kernel-compat");
  fs.mkdirSync(root, { recursive: true });
  const electron = resolveElectronExe(ELECTRON_SPEC);
  if (!electron) {
    throw new Error(`找不到 Electron：${ELECTRON_SPEC || path.join(ROOT, "node_modules", "electron", "dist")}`
      + "（先 npm install，或用 --electron=<装着 electron 的目录>）");
  }
  const ev = electronVersion(electron);

  console.log("=== 内核 × 外壳运行时 兼容性（真跑）===");
  console.log(`  外壳项目: ${ROOT}`);
  console.log(`  Electron: ${ev}   ${electron}`);
  console.log(`  系统 node: ${process.version}`);
  console.log(`  临时根目录: ${root}`);
  console.log("  （不碰用户正在用的内核 / 全局 npm / B / A）");
  console.log("");

  const results = [];
  let port = PORT_BASE;
  let installFailed = false;

  for (const version of versions) {
    const { provision } = require("../src/kernel-provision");
    const bin = path.join(root, "kernel", version, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

    console.log(`── ${DSH_PKG}@${version} ──`);
    if (!fs.existsSync(bin)) {
      console.log(`  还没装 ⇒ 用**随包的 npm + Electron 自带的 Node** 装一次（与外壳同一条路）…`);
      // ★ 故意用 Electron 跑 npm（`electronPath`）—— 这正是用户机器上的情形
      const r = await provision({
        userDataDir: root, version, electronPath: electron,
        onLine: (s) => console.log(`    [npm] ${s}`),
      });
      if (!r.ok) {
        console.log(`  ✗ 装不上：${r.reason}`);
        results.push({ version, runtime: "-", ready: false, key: `装不上：${r.reason}` });
        installFailed = true;
        continue;
      }
      console.log(`  ✓ 装好了 → ${r.dir}`);
    } else {
      console.log(`  已经装过，复用 ${bin}`);
    }

    // 内核自己声明的依赖版本（这一栏就是"为什么起不来"的线索来源）
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(root, "kernel", version,
        "node_modules", "node-addon-native-custom-loader", "package.json"), "utf8"));
      console.log(`  它带的 node-addon-native-custom-loader = ${pj.version}`);
    } catch { /* 没有就算了 */ }

    for (const runtime of runtimes) {
      port += 1;
      const dshHome = path.join(root, `home-${version}-${runtime}`);
      fs.mkdirSync(dshHome, { recursive: true });
      console.log(`  ▸ 用 ${runtime} 起一次（端口 ${port}，DSH_HOME=${dshHome}）…`);
      const r = await launch(bin, dshHome, port, runtime, electron);
      const label = runtime === "electron" ? `Electron ${ev}` : `系统 node ${process.version}`;
      if (r.ready) {
        console.log(`    ✅ **起来了** —— ${label}：${r.url}`);
      } else {
        console.log(`    ❌ **起不来** —— ${label}`
          + `（${r.exit ? `退出 ${JSON.stringify(r.exit)}` : "还活着但一直没给地址"}）`);
        console.log(`       ${keyLine(r.stderr).slice(0, 400)}`);
      }
      const logFile = path.join(root, "logs", `${version}-${runtime}.err.log`);
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, r.stderr);
      results.push({ version, runtime, ready: r.ready, key: r.ready ? "" : keyLine(r.stderr), log: logFile });
    }
    console.log("");
  }

  console.log("── 汇总 ──");
  for (const r of results) {
    console.log(`  ${r.ready ? "✅ 能跑" : "❌ 起不来"}  ${r.version.padEnd(14)} `
      + `${r.runtime.padEnd(9)} ${r.ready ? "" : r.key.slice(0, 150)}`);
  }
  if (!KEEP) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
    catch { console.log(`  （临时目录没删干净: ${root}）`); }
  } else {
    console.log(`  （--keep：临时目录保留在 ${root}）`);
  }

  const bad = results.filter((r) => !r.ready && r.runtime === "electron");
  console.log("");
  if (installFailed) { console.error("[kernel-compat-check] 有版本装不上"); process.exit(3); }
  if (bad.length) {
    console.error(`[kernel-compat-check] ${bad.length} 个组合**起不来** —— 别把它们标成"可推荐"`);
    process.exit(2);
  }
  console.log("[kernel-compat-check] 全部**真跑起来了**");
  process.exit(0);
})().catch((e) => {
  console.error(`[kernel-compat-check] 无法完成: ${(e && e.stack) || e}`);
  process.exit(1);
});
