#!/usr/bin/env node
/**
 * quit-check —— 「退出」这条路径的**真跑**验收。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────
 * 托盘那条「退出」以前**一条断言都没有**（`npm run` 里根本没有这项）。
 * 后果就是 2026-09-23 用户报的那个 bug：
 *   「我现在无法彻底退出 dsh，从托盘退出也不行」
 * 真相不是"退不掉"，而是**退不干净**：
 *   外壳退出了，但它**复用的那个内核还活着**（还占着 3105 端口），
 *   下次启动又把这个内核复用回来 ⇒ 同一个会话、同一个状态，
 *   在用户看来就是"根本没退"。任务管理器里 `DSH Integrated.exe` 也还在
 *   （内核用的就是同一个 exe —— `spawnKernel` 拿 `process.execPath`
 *   配 `ELECTRON_RUN_AS_NODE=1` 当 node 用，见 src/kernel.js:212）。
 *
 * ── 它真跑什么（全程临时 userData + 临时 DSH_HOME，不碰 B、不碰 A）──
 *   阶段一：造一个「孤儿内核」（父进程已死、但还在端口上服务）
 *   阶段二：起一个外壳去复用这个孤儿 ⇒ 走「复用」分支（①a 或 ①b，两种现场都跑）
 *   阶段三：让外壳走一次**真实的退出路径**，然后断言：
 *           **外壳退出后，那个内核也必须退出**
 *
 * 阶段三为什么可信：外壳导出了一个退出开关（`armQuitOnFileHook`，只在开发态生效），
 * 它调的 `quitApp()` 就是托盘那条「退出」用的**同一个函数**
 * （`{ label: "退出", click: () => quitApp("托盘") }`）。
 * 用文件开关而不是定时器：**"该断言的都断言完了"由本脚本决定**，两者不会抢跑。
 * 另外 ⑧ 自己也验证了一件事：外壳必须**真的退出**——若 `quitting` 没在关窗口前
 * 置上，窗口 close 会 preventDefault 把它藏起来，外壳就不会退出。
 *
 * 用法：
 *   node scripts/quit-check.js                # 两种现场都跑（推荐）
 *   node scripts/quit-check.js --mode=record  # 只跑「kernel.json 还在」（带记录复用 ①a）
 *   node scripts/quit-check.js --mode=norecord# 只跑「kernel.json 丢了」（裸 origin 复用 ①b，用户现场）
 *   node scripts/quit-check.js --keep         # 保留临时目录，便于事后翻日志
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const REAL_USER_DATA = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "DSH Integrated");
/** ★ 红线：这个端口是用户**此刻正在用的**内核，本脚本任何一步都不许碰它 */
const REAL_PORT = 3105;

const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const MODE = (argv.find((a) => a.startsWith("--mode=")) || "--mode=both").split("=")[1];

let OK = 0, FAIL = 0, HARNESS = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { OK += 1; console.log(`  PASS  ${name}`); }
  else {
    FAIL += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${extra ? `  ← ${extra}` : ""}`);
  }
}
function failed(name, why) {
  HARNESS += 1;
  console.log(`  FAILED ${name}  ← 验收脚手架自己的问题: ${why}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 进程 / 端口 探测 ─────────────────────────────────────────────
function runPs(script) {
  const r = spawnSync("powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 20000 });
  return String(r.stdout || "").trim();
}

function procInfo(pid) {
  if (!pid) return null;
  const out = runPs(
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue; ` +
    `if ($null -eq $p) { 'null' } else { $p | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress }`);
  if (!out || out === "null") return null;
  try {
    const o = JSON.parse(out);
    return { pid: o.ProcessId, ppid: o.ParentProcessId, cmd: String(o.CommandLine || "") };
  } catch { return null; }
}

const isAlive = (pid) => !!procInfo(pid);

function portOwner(port) {
  const r = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
  const m = String(r.stdout || "").match(new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "i"));
  return m ? Number(m[1]) : null;
}

function killPid(pid, tree) {
  if (!pid) return;
  const args = ["/pid", String(pid), "/F"];
  if (tree) args.push("/T");
  spawnSync("taskkill", args, { windowsHide: true, stdio: "ignore" });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitFor(label, fn, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    await sleep(intervalMs);
  }
  return null;
}

// ── 触发退出：走外壳**自己**的真实退出路径 ───────────────────────
//
// 为什么不是从外面"按一下"：
//   托盘的「退出」是主进程里的一个闭包（`quitApp("托盘")`），外面按不到。
//   从 CDP 去调 `app.quit()` 也走不通 —— 主进程 inspector 的上下文里
//   `require` / `process.mainModule` / `module` **一个都拿不到**
//   （2026-09-23 实测三种写法全是 NO_LOADER，见下面那次失败记录）。
// ⇒ 用外壳自己开的、**只对开发态生效**的文件开关（main.js 的 armQuitOnFileHook）：
//   出现标记文件就调 `quitApp()` —— **与托盘那条是同一个函数**。
//   好处是"该断言的都断言完了"由本脚本决定，检查与退出不会抢跑。
//
// ★ 第一版走的是 CDP（`--inspect` 连主进程 + Runtime.evaluate），实测返回
//   `NO_LOADER`：`require` / `process.mainModule` / `module.constructor._load`
//   三个候选在主进程 inspector 的上下文里一个都不存在。那条路已废弃。

// ── 外壳与日志 ───────────────────────────────────────────────────
function shellExe() {
  const p = path.join(ROOT, "node_modules", "electron", "dist",
    process.platform === "win32" ? "electron.exe" : "electron");
  if (!fs.existsSync(p)) throw new Error(`找不到 Electron: ${p}`);
  return p;
}

/** 起子进程用的环境：必须清掉继承来的 ELECTRON_RUN_AS_NODE（否则 Electron 退化成纯 Node） */
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.DSH_FIRST_RUN = "off";
  return env;
}

function launchShell(tmpDir, port, extraEnv) {
  fs.writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify({
    closeToTray: false, port, profile: "web", workspace: tmpDir,
  }, null, 2), "utf8");
  const args = [".", `--user-data-dir=${tmpDir}`];
  return spawn(shellExe(), args, {
    cwd: ROOT, env: { ...cleanEnv(), ...(extraEnv || {}) }, stdio: "ignore", windowsHide: false,
  });
}

const logFile = (tmpDir) => path.join(tmpDir, "shell.log");
function readLog(tmpDir) {
  try { return fs.readFileSync(logFile(tmpDir), "utf8"); } catch { return ""; }
}
function readRecord(tmpDir) {
  try { return JSON.parse(fs.readFileSync(path.join(tmpDir, "kernel.json"), "utf8")); }
  catch { return null; }
}

/**
 * 收尾用的身份判据：**只有开发态的 electron.exe 才是本脚本造出来的**。
 * ★ 绝不允许按 pid 盲杀 —— pid 会被系统复用，而真实内核用的那个 exe
 *   路径是 `%LOCALAPPDATA%\Programs\DSH Integrated\DSH Integrated.exe`，
 *   与这条判据天然不重叠。这是本脚本唯一有可能伤到用户现场的地方，必须锁死。
 */
const DEV_EXE = path.join("node_modules", "electron", "dist",
  process.platform === "win32" ? "electron.exe" : "electron");
/** 本脚本自己拉起来的两个中间进程（用 node 跑，命令行里带脚本名） */
const OWN_SCRIPTS = ["quit-orphan.js", "quit-check.js"];
const isOurs = (pid) => {
  const info = procInfo(pid);
  if (!info) return false;
  return info.cmd.includes(DEV_EXE) || OWN_SCRIPTS.some((s) => info.cmd.includes(s));
};

// ── 一个现场（record / norecord）的完整流程 ──────────────────────
async function scenario(name, { dropRecord }) {
  console.log(`\n══ 现场：${name} ═════════════════════════════════════`);
  const port = await freePort();
  if (port === REAL_PORT) throw new Error("抽到的端口正好是真实内核的 3105，拒绝继续");
  // ★ 目录名只用 ASCII —— 中文/箭头/空格进路径，出问题时最难查的一环就是它
  const slug = dropRecord ? "norecord" : "record";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-quit-${slug}-`));
  const home = path.join(tmpDir, "dsh-home");
  const orphanJson = path.join(tmpDir, "orphan.json");
  console.log(`  临时环境: ${tmpDir}`);
  console.log(`  端口: ${port}（真实内核在 ${REAL_PORT}，本脚本不碰它）`);

  const spawnedPids = [];
  let shellB = null, orphanPid = null;

  try {
    // ── 阶段一：造一个「孤儿内核」（父进程已死、但还在服务）────────
    //   ⚠️ 不能靠"杀掉外壳、留下内核"来复现：本机实测 taskkill /F 外壳时，
    //      它 spawn 的内核会被一起带走（job 对象）。成因与取舍见 scripts/quit-orphan.js。
    console.log("\n  [1] 用一次性父进程起内核，然后让它走人（留下孤儿内核）…");
    const helper = spawn(process.execPath, [
      path.join(ROOT, "scripts", "run-electron.js"),
      path.join(ROOT, "scripts", "quit-orphan.js"),
      `--home=${home}`, `--port=${port}`, `--workspace=${tmpDir}`, `--out=${orphanJson}`,
    ], { cwd: ROOT, env: cleanEnv(), stdio: "ignore", windowsHide: false });
    spawnedPids.push(helper.pid);

    const info = await waitFor("孤儿内核就绪", async () => {
      try {
        const j = JSON.parse(fs.readFileSync(orphanJson, "utf8"));
        return j && j.ok ? j : null;
      } catch { return null; }
    }, 300000, 2000);
    if (!info) {
      failed(`[${name}] 阶段一：孤儿内核没能在 300 秒内起来`,
        fs.existsSync(orphanJson) ? fs.readFileSync(orphanJson, "utf8") : "连 orphan.json 都没写出来");
      return;
    }

    orphanPid = info.pid;
    spawnedPids.push(orphanPid);
    const oi = procInfo(orphanPid);
    console.log(`      孤儿内核 pid=${orphanPid} 父进程=${oi && oi.ppid}（必须已不在）`);
    console.log(`      命令行: ${((oi && oi.cmd) || "").slice(0, 150)}`);

    check(`[${name}] ① 孤儿内核活着，且端口 ${port} 由它持有`,
      isAlive(orphanPid) && portOwner(port) === orphanPid,
      `活着=${isAlive(orphanPid)} 端口持有者=${portOwner(port)}`);
    check(`[${name}] ② 它的父进程真的已经不在（这才是"孤儿"）`,
      !!oi && !isAlive(oi.ppid), `父进程 pid=${oi && oi.ppid} 活着=${oi ? isAlive(oi.ppid) : "?"}`);
    // ★ 这一条是给修复打底：外壳能不能认出"这是我拉起来的"，全靠命令行这两个特征
    check(`[${name}] ③ 它的命令行带着可认领的特征（同一个 electron + --expose-internals + 这个端口）`,
      !!oi && oi.cmd.includes(DEV_EXE) && /--expose-internals/i.test(oi.cmd)
      && new RegExp(`--port\\s+${port}(\\s|$)`).test(oi.cmd),
      (oi && oi.cmd) || "取不到命令行");

    const recPath = path.join(tmpDir, "kernel.json");
    if (dropRecord) {
      try { fs.unlinkSync(recPath); } catch { /* 本来就没有 */ }
      console.log("      现场设定：不放 kernel.json（走裸 origin 复用 —— 用户现场）");
    } else {
      fs.writeFileSync(recPath, JSON.stringify({
        pid: orphanPid, port, url: `http://127.0.0.1:${port}`, profile: "web",
        dshHome: home, version: info.kernelVersion, startedAt: new Date().toISOString(),
      }, null, 2), "utf8");
      console.log("      现场设定：放一份 kernel.json（走带记录的复用）");
    }
    check(`[${name}] ④ 现场设定已就位（${dropRecord ? "无" : "有"} kernel.json）`,
      fs.existsSync(recPath) === !dropRecord);

    // ── 阶段三：外壳 B 复用这个孤儿内核 ─────────────────────────
    console.log("\n  [2] 外壳 B 启动，去复用那个孤儿内核…");
    shellB = launchShell(tmpDir, port, { DSH_QUIT_ON_FILE: path.join(tmpDir, "quit-now") });
    spawnedPids.push(shellB.pid);

    const reused = await waitFor("复用已有内核", async () => {
      const t = readLog(tmpDir);
      return /复用已有内核/.test(t) ? t : null;
    }, 180000, 1500);
    if (!reused) { failed(`[${name}] 阶段二：外壳 B 没能复用上孤儿内核`, "见 shell.log"); return; }

    const line = (reused.match(/.*复用已有内核.*/) || [""])[0].trim();
    console.log(`      ${line.slice(0, 190)}`);
    check(`[${name}] ⑤ 外壳 B 复用了已有内核`, true);
    check(`[${name}] ⑥ 复用时没有起第二个内核（端口持有者仍是同一个 pid）`,
      portOwner(port) === orphanPid, `端口持有者=${portOwner(port)} 原内核=${orphanPid}`);

    // ★ 复用就得认账：外壳必须知道"这个内核是我拉起来的"，否则它永远不敢关。
    //   这一步要查一次 WMI（PowerShell，几百毫秒），所以给它足够的时间。
    const claimLog = await waitFor("认领判定", async () => {
      const t = readLog(tmpDir);
      return /(已认领内核|不认领内核)/.test(t) ? t : null;
    }, 40000, 500);
    const claimLine = (String(claimLog || "").match(/.*(已认领内核|不认领内核).*/) || ["(没有认领日志)"])[0].trim();
    console.log(`      ${claimLine.slice(0, 190)}`);
    check(`[${name}] ⑦ ★ 外壳**认领**了这个内核（认定它是自己人 ⇒ 退出时才敢关它）`,
      /已认领内核/.test(String(claimLog || "")), claimLine.slice(0, 160));

    // 认领成功的话还应该补一份记录（下次启动能一眼看出它的归属与 pid）
    const recAfter = readRecord(tmpDir);
    check(`[${name}] ⑧ 认领后把归属记了下来（kernel.json 里是同一个 pid）`,
      !!recAfter && recAfter.pid === orphanPid,
      `kernel.json=${JSON.stringify(recAfter)}`);

    // ── 阶段三：走「托盘退出」同一条路径 ────────────────────────
    console.log("\n  [3] 写下退出开关文件，让外壳走一次真实的退出路径…");
    fs.writeFileSync(path.join(tmpDir, "quit-now"), "go\n", "utf8");

    const exited = await waitFor("外壳B退出", async () => (!isAlive(shellB.pid) ? true : null), 60000, 400);
    check(`[${name}] ⑨ 外壳 B 真的退出了（窗口全关了）`, !!exited,
      "没退出 ⇒ quitting 没在关窗口前置上，或窗口 close 被 preventDefault");
    // 退出这条路以前**一行日志都不写**，所以用户报"退不掉"时无从查起。
    // 现在它必须留下痕迹，而且要说清来源。
    const quitLog = readLog(tmpDir);
    check(`[${name}] ⑩ 退出留下了可查的日志（来源写明了）`,
      /退出：开始了（来源：验收 DSH_QUIT_ON_FILE）/.test(quitLog)
      && /退出：收尾完成/.test(quitLog),
      (quitLog.match(/.*退出：.*/) || ["(没有退出日志)"])[0].slice(0, 140));

    const kernelGone = await waitFor("内核退出", async () => (!isAlive(orphanPid) ? true : null), 25000, 500);
    check(`[${name}] ⑪ ★ 它复用的那个内核也退出了（这才是「退干净」）`, !!kernelGone,
      `内核 pid=${orphanPid} 仍然活着（端口 ${port} 还被它占着）`);
  } finally {
    // ── 收尾：不留孤儿、不弄脏机器 ──────────────────────────────
    for (const pid of spawnedPids.slice().reverse()) {
      if (!isAlive(pid)) continue;
      if (isOurs(pid)) killPid(pid, true);
      else console.log(`      （跳过 pid=${pid}：命令行不像本脚本造的，坚决不盲杀）`);
      await sleep(150);
    }
    if (!KEEP) {
      // 端口还占着就先等它放开 —— 文件句柄没释放时删目录必留残渣
      for (let i = 0; i < 20 && portOwner(port); i++) await sleep(300);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 还被占着 */ }
    }
    const left = isAlive(orphanPid) || isAlive(shellB && shellB.pid);
    check(`[${name}] ⑫ 收尾干净：本次造的进程一个不留`, !left);
    check(`[${name}] ⑬ 收尾后端口 ${port} 已释放`, !portOwner(port));
    if (KEEP) console.log(`  （--keep）临时目录保留在: ${tmpDir}`);
  }
}

// ── 主流程 ───────────────────────────────────────────────────────
/**
 * ★ `require.main === module` 这道闸不是形式主义：
 *   本脚本第一版没有它，我用 `node -e "require('./scripts/quit-check.js')"`
 *   做"真加载"检查时，它**当场就真跑起来了**（会起 Electron、起内核）。
 *   凡是有副作用的验收脚本都必须挡住这种误触发。
 */
async function main() {
  console.log("quit-check —— 「退出」真跑验收（临时环境，不碰 B / A，也不碰 3105）");
  if (!fs.existsSync(path.join(REAL_USER_DATA, "dsh-home"))) {
    console.log(`  ⚠ 没找到真实家 ${REAL_USER_DATA}（不影响本脚本，只是提醒）`);
  }

  const modes = MODE === "both"
    ? [["record（kernel.json 还在 → 走带 token 复用）", false],
       ["norecord（kernel.json 丢了 → 走裸 origin 复用，用户现场）", true]]
    : [[MODE, MODE === "norecord"]];

  for (const [label, drop] of modes) {
    try { await scenario(label, { dropRecord: drop }); }
    catch (e) { failed(`[${label}] 整个现场跑挂`, (e && e.message) || String(e)); }
  }

  console.log(`\n══ 汇总 ══`);
  console.log(`  PASS ${OK} / FAIL ${FAIL}${HARNESS ? ` / FAILED(脚手架) ${HARNESS}` : ""}`);
  if (failures.length) {
    console.log("  失败项：");
    for (const f of failures) console.log(`    · ${f}`);
  }
  process.exit(FAIL || HARNESS ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("quit-check 崩了:", (e && e.stack) || e);
    process.exit(2);
  });
} else {
  module.exports = { main };
}