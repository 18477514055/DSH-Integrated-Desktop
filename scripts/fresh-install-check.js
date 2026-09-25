"use strict";

/**
 * fresh-install-check —— **全新机器**那条路：新用户到底装不装得上插件？
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么单独要有这一个脚本（2026-09-26）
 * ══════════════════════════════════════════════════════════════════
 * 起因是内核 0.1.7 换掉了 profile 的模块布局：
 *
 *   · 0.1.5 那代：内核启动时会往 `<DSH_HOME>\profiles\web\node_modules` 里
 *     装 `@deepseek-ai/dsh-base` 那一套 ⇒ 这个目录**总是存在**。
 *   · 0.1.7：模块解析改由 `<DSH_HOME>\profiles\node_modules` 那一层
 *     「拦截层」承担，**全新 profile 里根本没有 `node_modules`** ——
 *     要等 pnpm 真跑过一次（= 用户装第一个插件）才出现。
 *
 * 而我们的落位逻辑要往那个目录里建联接 ⇒ 旧代码直接报
 * `profile 的 node_modules 不存在` 就返回。实测证据（外壳自己的 shell.log，
 * 全新家 + 0.1.7，首启向导装插件）：
 *
 *   安装插件 dsh-int-archive-manager@0.2.0：ok=false changed=[…]
 *     profile 的 node_modules 不存在：…\dsh-home\profiles\web\node_modules
 *
 * **开发机上永远看不到这个 bug** —— 那里的 `node_modules` 早就存在了。
 * 所以它必须由一个**只走全新家**的脚本盯着，而不是靠人在老环境里回归。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个脚本证明什么（每一段都是**真跑**，不是"文件在那儿"）
 * ══════════════════════════════════════════════════════════════════
 *   ① 真起一次外壳 ＋ 真内核，让它把**全新** profile 建出来
 *      → 顺手把"全新 profile 到底有没有 node_modules"这件事实**测出来并打印**
 *        （这是那个 bug 的前提；前提变了这个脚本要能告诉你）
 *   ② 在这个**真的全新家**上跑我们真正的安装入口
 *      `plugin-install.js` 的 `installFromDir`（首启向导 / 设置页走的就是它）
 *   ③ 三处契约全查：dependencies / dsh.profile.bundles / node_modules 联接
 *      （并**穿过联接真读一次** lib/client.js —— 目录在 ≠ 读得到）
 *   ④ **再起一次内核**，去问内核自己："你加载的客户端插件清单里有它吗"
 *      （走 `boot-peek.js` 读 `__DSH_BOOT__` 的 entries ⇒ 内核自己给的真值，
 *        不是我们猜的）
 *
 * 全程：临时 userData + 临时 DSH_HOME，**不碰 B、不碰 A**。
 * 退出码：0 全过；1 有 FAIL。
 *
 * 用法：node scripts/fresh-install-check.js
 *       node scripts/fresh-install-check.js --keep     # 不删临时目录（排错用）
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const PI = require("../src/plugin-install.js");

/** 用哪个插件当夹具：**我们自己**的、稳定的、真实的插件（零依赖、客户端 + bundle 都声明的） */
const FIXTURE_DIR = path.join(ROOT, "plugin", "dsh-multi-session");
const FIXTURE_PKG = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "package.json"), "utf8"));
const FIXTURE_NAME = FIXTURE_PKG.name;              // dsh-int-multi-session
const PORT = 3184;                                  // 不与 pages3178/plugins3179/firstrun3180/files3181 撞
const KEEP = process.argv.includes("--keep");

let oks = 0;
const failures = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (ok) oks += 1; else failures.push(`${name}: ${detail || ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveElectronExe() {
  const exe = process.platform === "win32" ? "electron.exe" : "electron";
  const c = path.join(ROOT, "node_modules", "electron", "dist", exe);
  if (!fs.existsSync(c)) throw new Error(`找不到 Electron：${c}（先 npm i）`);
  return c;
}

/** 目录联接指向哪（读不到返回 null） */
function junctionTarget(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function readLog(file, tail = 6) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-tail);
  } catch { return []; }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-fresh-"));
const dshHome = path.join(tmpDir, "dsh-home");
const profileDir = path.join(dshHome, "profiles", "web");
const pkgFile = path.join(profileDir, "package.json");
const nmDir = path.join(profileDir, "node_modules");
const logFile = path.join(tmpDir, "shell.log");
const kernelRecord = path.join(tmpDir, "kernel.json");

let child = null;
/** 上一次启动前 shell.log 的长度 —— 日志**跨启动是累加的**，见 waitKernelReady 的注释 */
let logBase = 0;

function logText() {
  try { return fs.readFileSync(logFile, "utf8"); } catch { return ""; }
}

function launch() {
  // settings.json：端口与 profile 都钉死，免得落到 3105 上把**用户正在用的内核**当成自己的
  fs.writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify({
    closeToTray: false, port: PORT, profile: "web", workspace: ROOT,
  }, null, 2), "utf8");

  logBase = logText().length;           // ★ 只认这一次启动**之后**新写进去的那几行

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;      // 见项目 AGENTS.md §6：带着它 Electron 退化成纯 Node
  env.DSH_FIRST_RUN = "off";            // 首启向导不自动弹（本脚本自己走安装入口）
  child = spawn(resolveElectronExe(), [
    ".", `--user-data-dir=${tmpDir}`,
  ], { cwd: ROOT, env, stdio: "ignore", windowsHide: false });
}

async function waitKernelReady(secs = 150) {
  const deadline = Date.now() + secs * 1000;
  while (Date.now() < deadline) {
    // ★★ 必须只看**新增**的那一段。
    //   第一版直接 `readLog(...).some(l => l.includes("内核就绪"))` —— 而 shell.log
    //   是**同一个临时目录里跨启动累加**的，所以第二次启动时它**立刻**返回 true，
    //   内核其实还没起来 ⇒ boot-peek 连上去 `token 请求: 0`（连接被拒），
    //   报出来的却是"页面里没有 __DSH_BOOT__"，把人往错的方向带。
    //   （又是"判据量错了对象"那一类：量的应该是**这一次**启动。）
    const lines = logText().slice(logBase).split(/\r?\n/).filter(Boolean);
    if (lines.some((l) => l.includes("内核就绪"))) return true;
    if (lines.some((l) => /内核退出|启动失败|uncaught/.test(l))) return false;
    await sleep(1200);
  }
  return false;
}

async function stop() {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    // ★ 连进程树一起杀：只杀外壳会把内核留成孤儿（2026-09-26 真在 3181 上留过一个）
    try { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); }
    catch { /* 已经没了 */ }
  } else {
    try { child.kill("SIGKILL"); } catch { /* 已经没了 */ }
  }
  child = null;
  await sleep(1200);
}

(async () => {
  console.log("fresh-install-check —— 全新家 + 真内核：新用户装得上插件吗");
  console.log(`  临时 userData: ${tmpDir}`);
  console.log(`  （DSH_HOME 落在它下面，不碰 B / A；夹具插件 = ${FIXTURE_NAME} v${FIXTURE_PKG.version}）`);
  console.log("");

  // ═══ ① 真起一次，让内核把**全新** profile 建出来 ═══
  console.log("── ① 全新家：真起一次外壳 ＋ 内核 ──");
  launch();
  const ready1 = await waitKernelReady();
  check("全新家上内核真的起来了（读 shell.log 的「内核就绪」）", ready1,
    ready1 ? "" : JSON.stringify(readLog(logFile)));
  check("内核把 profile package.json 建出来了", fs.existsSync(pkgFile), pkgFile);
  if (!ready1) {
    await stop();
    console.log("\n⚠ 起不来就没法验下去；临时目录已保留：" + tmpDir);
    process.exitCode = 1;
    return;
  }

  // ★ 这一段就是那个 bug 的**前提**：全新 profile 到底有没有 node_modules？
  //   （0.1.5 有；0.1.7 没有 ⇒ 旧代码在这台机器上必然装不上任何插件。）
  const nmFresh = fs.existsSync(nmDir);
  console.log(`  实测：全新 profile 的 node_modules 存在=${nmFresh}`);
  check("★（事实记录）全新 profile **没有** node_modules —— 这就是那条 bug 的前提",
    !nmFresh,
    nmFresh ? "它现在有了 ⇒ 内核布局又变了，下面的用例仍然有效，但这条前提要重写" : "");

  await stop();

  // ═══ ② 在这个真·全新家上跑我们真正的安装入口 ═══
  console.log("\n── ② 用真正的安装入口装一个插件（首启向导 / 设置页走的就是它）──");
  const logs = [];
  const r = PI.installFromDir({ dshHome, profile: "web", dir: FIXTURE_DIR, log: (m) => logs.push(m) });
  for (const m of logs) console.log(`  · ${m}`);
  check("★ installFromDir 在**全新家**上成功了（修之前这里必失败）", r.ok === true,
    JSON.stringify({ ok: r.ok, errors: r.errors, skipped: r.skipped }));
  if (!r.ok) {
    console.log("\n失败细节：" + JSON.stringify(r, null, 2));
    if (!KEEP) fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }
  check("落点在 <DSH_HOME>\\plugins\\<名字>", fs.existsSync(path.join(dshHome, "plugins", FIXTURE_NAME, "package.json")),
    r.dest || "(无)");

  // ═══ ③ 三处契约 + 穿过联接真读一次 ═══
  console.log("\n── ③ 三处契约（并穿过联接真读一次）──");
  const nmMade = fs.existsSync(nmDir);
  check("★ node_modules 被**自己建出来**了（不是等内核）", nmMade, nmDir);
  const pj = JSON.parse(fs.readFileSync(pkgFile, "utf8").replace(/^\uFEFF/, ""));
  const dep = pj.dependencies ? pj.dependencies[FIXTURE_NAME] : null;
  check(`① dependencies["${FIXTURE_NAME}"] = link:<落点>`,
    typeof dep === "string" && dep.startsWith("link:")
    && path.resolve(dep.slice(5)).toLowerCase() === path.resolve(r.dest).toLowerCase(), String(dep));
  const bundles = ((pj.dsh || {}).profile || {}).bundles;
  check(`② dsh.profile.bundles 里含 ${FIXTURE_NAME}`,
    Array.isArray(bundles) && bundles.includes(FIXTURE_NAME), JSON.stringify(bundles));
  const link = path.join(nmDir, FIXTURE_NAME);
  const target = junctionTarget(link);
  check(`③ node_modules\\${FIXTURE_NAME} 解析到那个落点`,
    !!target && path.resolve(target).toLowerCase() === path.resolve(r.dest).toLowerCase(), String(target));
  // ★「目录在」不算证据：穿过联接**真读一次**插件自己的代码
  let through = null;
  try { through = fs.readFileSync(path.join(link, "lib", "client.js"), "utf8"); } catch { through = null; }
  check("★ 穿过联接**真读得到** lib/client.js（目录在 ≠ 读得到）",
    !!through && through.length > 200, through ? `${through.length} 字节` : "读不到");
  check("装之前先备份了 profile package.json（改前必先备份）", !!r.backup, String(r.backup));
  check("幂等：再跑一次不再改任何东西",
    (() => { const r2 = PI.installFromDir({ dshHome, profile: "web", dir: FIXTURE_DIR }); return r2.ok && r2.changed.length === 0 && !!r2.skipped; })(),
    "第二次 installFromDir 应 changed=[] 且 skipped");

  // ═══ ④ 再起一次内核，问它自己加载了没有 ═══
  console.log("\n── ④ 再起内核，问内核自己：客户端插件清单里有它吗 ──");
  launch();
  const ready2 = await waitKernelReady();
  check("第二次启动内核也起来了（它会读到刚改过的 profile）", ready2, ready2 ? "" : JSON.stringify(readLog(logFile)));
  if (ready2) {
    const peek = spawnSync(process.execPath, [path.join(__dirname, "boot-peek.js"), kernelRecord],
      { encoding: "utf8", windowsHide: true, timeout: 60000 });
    const out = `${peek.stdout || ""}${peek.stderr || ""}`;
    // ★ 失败时**把 boot-peek 的原始输出打出来** —— 否则只能看到"退出码 3"，
    //   下次还得从头猜（这条判据是"内核自己给的真值"，值得让它可解释）
    if (!out.includes(FIXTURE_NAME)) {
      console.log("  ── boot-peek 原始输出（前 900 字）──");
      console.log(out.slice(0, 900).split("\n").map((l) => "    " + l).join("\n"));
    }
    check(`内核的客户端插件清单（__DSH_BOOT__.entries）里真的有 ${FIXTURE_NAME}`,
      out.includes(FIXTURE_NAME), out.includes(FIXTURE_NAME) ? "" : `boot-peek 退出码=${peek.status}`);
    // 反面：清单**不是空的**（否则上面那条可能只是"谁都没加载"造成的巧合）
    const m = out.match(/entries\((\d+)\)/);
    check("（正对照）entries 不是空的 —— 上面那条不是空清单里的巧合",
      !!m && Number(m[1]) > 0, m ? `entries(${m[1]})` : "没读到 entries 计数");
  }

  await stop();

  console.log("");
  if (failures.length) {
    console.log(`[fresh-install] ${oks} OK / ${failures.length} FAIL`);
    for (const f of failures) console.log("  - " + f);
    process.exitCode = 1;
  } else {
    console.log(`[fresh-install] 全部通过（${oks} 条）`);
  }
  if (!KEEP) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  } else {
    console.log(`临时目录已保留：${tmpDir}`);
  }
})().catch(async (e) => {
  console.error("失败:", e && e.stack ? e.stack : e);
  await stop();
  if (!KEEP) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  process.exitCode = 1;
});
