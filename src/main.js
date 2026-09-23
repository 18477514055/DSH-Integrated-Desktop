"use strict";

/**
 * main.js —— DSH 集成桌面端 · Electron 主进程
 *
 * ══════════════════════════════════════════════════════════════════
 * 本外壳的职责
 * ══════════════════════════════════════════════════════════════════
 *   ✅ 找内核、起内核、探活、自愈、换档案重启
 *   ✅ 窗口 / 托盘 / 快捷键 / 单实例
 *   ✅ 自己的启动加载页（白底黑鲸鱼 + 进度）与设置页
 *   ✅ 把官方 UI 一比一加载进来
 *   ✅ 在官方 UI 里**运行时注入**一个模型搜索框（见 src/inject/model-search.js）
 *   ❌ 不含任何内核代码
 *   ❌ **不改内核的任何文件**（一个字节都不写）
 *
 * 这样做的理由：内核可以独立升级，外壳不需要跟着改。
 * （社区版把内核嵌进安装目录，升级内核就等于拆自己的地基，
 *   2026-09-19 因此出过一次"客户端完全起不来"的事故。）
 *
 * ★ 关于"注入"这件事要说清楚，别把它说成没发生：
 *   模型搜索框是外壳在页面加载后**在内存里**改 DOM 加进去的，
 *   不写内核文件、不改内核 bundle，**失败就安静退出**（最坏是没搜索框，
 *   官方界面照常用）。项目历史上（2026-09-17）曾经直接改过官方安装目录里的
 *   `dsh-client-ui-model-selection/lib/client.js`，结果那个改动被版本升级
 *   冲掉了 —— 所以这里不再走那条路。
 *
 * ══════════════════════════════════════════════════════════════════
 * 与内核的**唯一接口**是进程边界
 * ══════════════════════════════════════════════════════════════════
 *   spawn 内核 → 读它 stdout 里的 URL → loadURL 加载它
 *   内核内部怎么变，对外壳都是黑盒。
 */

const {
  app, BrowserWindow, Tray, Menu, Notification, dialog, shell, nativeImage,
  ipcMain, clipboard,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const K = require("./kernel");
const KU = require("./kernel-update");
const diagnostics = require("./diagnostics");
const P = require("./plugins");
const SITES = require("./sites");
const U = require("./update");
const PC = require("./plugin-catalog");
const PI = require("./plugin-install");
const PP = require("./plugin-pack");
const FR = require("./first-run");
const WHALE = require("./whale-path.json");

// ── 最早期的错误捕获 ──────────────────────────────────────────────
// 主进程若在 app ready 之前抛错，Electron 会**静默退出**（不打印、不写日志），
// 表现为"双击没反应"。这里在一切之前挂上捕获，把原因落到文件，
// 否则完全无法排查（实测踩过：退出码 1、零输出、无 shell.log）。
function writeCrash(tag, err) {
  try {
    const dir = path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "dsh-integrated-desktop");
    fs.mkdirSync(dir, { recursive: true });
    const text = [
      `[${new Date().toISOString()}] ${tag}`,
      String((err && err.stack) || err),
      "",
      `argv: ${JSON.stringify(process.argv)}`,
      `execPath: ${process.execPath}`,
      `cwd: ${process.cwd()}`,
      `versions: ${JSON.stringify(process.versions)}`,
      "",
    ].join("\n");
    fs.appendFileSync(path.join(dir, "crash.log"), text);
  } catch { /* 连日志都写不了就只能放弃 */ }
  try { process.stderr.write(`[crash] ${tag}: ${(err && err.stack) || err}\n`); } catch { /* 忽略 */ }
}

process.on("uncaughtException", (e) => {
  writeCrash("uncaughtException", e);
  // 冒烟模式下用退出码 3 区分"崩溃"（否则会与校验失败/超时混淆）
  if (process.argv.includes("--smoke")) process.exit(3);
});
process.on("unhandledRejection", (e) => writeCrash("unhandledRejection", e));

// ── 命令行开关 ────────────────────────────────────────────────────
const SMOKE = process.argv.includes("--smoke");
const DEV = process.argv.includes("--dev");
/** 关掉模型搜索框注入（出问题时可以不改代码先关掉它） */
const NO_INJECT = process.argv.includes("--no-inject");

const DEFAULT_PORT = 3080;
const HOST = "127.0.0.1";

// ── 运行状态 ──────────────────────────────────────────────────────
let mainWindow = null;
let settingsWindow = null;
/** 外部网站视图宿主（本机 DSH / DeepSeek 网页版 / 开放平台 三页切换），见 src/sites.js */
let siteHost = null;
let tray = null;
let kernelProc = null;
let serverUrl = null;
let serverOwned = false;
let quitting = false;
let restarting = null;
let healthTimer = null;
let healthFails = 0;
let statusPageActive = false;
/** 内核起不来时的自动重试（20 秒一次，最多 5 次） */
let retryTimer = null;
let retryCount = 0;

/** 内核发现结果（诊断信息与"关于"要用） */
let kernelInfo = { version: null, dir: null, source: null };
/** 本次内核启动写哪个日志文件（诊断信息要抓尾部） */
let kernelLogFile = null;
/**
 * 复用的是**别人内核的裸 origin**（拿不到 token）⇒ 加载后要确认一次是否被 401 挡住。
 * 见 ensureServer 的 ①b 与 verifyUiLoaded。
 */
let reuseUnverified = false;
/**
 * **认领来的内核 pid** —— 不是我 spawn 的，但已证实是本应用拉起来的（见 claimAdoptedKernel）。
 *
 * ★ 2026-09-23 用户报「我现在无法彻底退出 dsh，从托盘退出也不行」的根因就在这条链上：
 *   复用（`serverOwned = false`）之后，退出时**只关 `kernelProc`** ⇒
 *   复用的那个内核永远没人关、端口一直占着、下次启动又把它复用回来
 *   —— 在用户看来就是"根本没退"。任务管理器里 `DSH Integrated.exe` 还在
 *   （内核用的就是同一个 exe，见 kernel.js 的 spawnKernel）。
 *
 * 认领的原则：**能证明才认领**（kernel.ourKernelProcess）；
 * 认不出的一律不认领 ⇒ 退出时一个字都不动它（用户自己 `dsh web` 起的那个内核
 * 就属于这一类，命令行是 node.exe ⇒ 天然不匹配）。
 */
let adoptedKernelPid = null;

/**
 * 认领一个"已经在端口上跑、但不是我这次 spawn 的内核"。
 *
 * ★ 异步：判据要查一次 WMI（PowerShell 冷启动几百毫秒），
 *   **不能挡住启动** —— 调用方一律 `void claimAdoptedKernel(...)` 发出去就走，
 *   认领结果在几百毫秒后落到 `adoptedKernelPid`。退出时读的就是它。
 *
 * @param {number} pid 端口持有者
 * @param {number} port
 * @param {string} why 从哪条路发现的（只进日志）
 * @returns {Promise<boolean>} 认领成功没有（调用方通常不 await）
 */
async function claimAdoptedKernel(pid, port, why) {
  let chk;
  try { chk = await K.ourKernelProcess(pid, port); }
  catch (e) { log(`不认领内核 pid=${pid}（${why}）：判据抛异常 ${(e && e.message) || e}`); return false; }
  if (!chk.ok) {
    log(`不认领内核 pid=${pid}（${why}）：${chk.why} ⇒ 退出时不会关它`);
    return false;
  }
  // 父进程还活着 ⇒ 它是**另一个外壳实例**正在用的内核，不是孤儿。
  //   杀了它等于替别的实例关内核（那个实例还会自己再拉一个），所以不碰。
  if (chk.info && chk.info.ppid && chk.info.ppid !== process.pid && isPidAlive(chk.info.ppid)) {
    log(`不认领内核 pid=${pid}（${why}）：它的父进程 ${chk.info.ppid} 还活着（属于另一个外壳实例）`);
    return false;
  }
  adoptedKernelPid = pid;
  log(`已认领内核 pid=${pid}（${why}，父进程 ${chk.info ? chk.info.ppid : "?"} 已不在）⇒ 退出时会一并关掉它`);
  return true;
}

/**
 * 加载页状态。`seq` 单调递增：页面先订阅事件、再拉快照，
 * 没有序号的话可能用一份**更旧**的快照把新事件盖掉（进度条倒退）。
 */
let statusSeq = 0;
let statusState = null;

/** 当前显示的是不是外壳自有页面 —— 由 `assertShellSender` 按 frame URL 判定，不再手工维护标志 */

// ── 配置 ──────────────────────────────────────────────────────────
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
let settings = { closeToTray: true, port: DEFAULT_PORT, profile: "web", workspace: null };

function loadSettings() {
  try {
    let raw = fs.readFileSync(settingsFile(), "utf8");
    // ★ 容错：Windows PowerShell 的 Set-Content -Encoding UTF8 会写 BOM，
    //   JSON.parse 遇到 BOM 会抛 "Unexpected token"。这里剥掉再解析。
    //   （2026-09-19 实测：settings.json 带 BOM 导致端口配置读不进来，回退成 3080。）
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    settings = { ...settings, ...JSON.parse(raw) };
  } catch (e) {
  }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* 忽略 */ }
}

// ── 日志 ──────────────────────────────────────────────────────────
const LOG_MAX = 4 * 1024 * 1024;
function log(...args) {
  const line = "[shell] " + args.map((a) => {
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(" ");
  const stamped = `[${new Date().toISOString()}] ${line}`;
  try {
    const f = path.join(app.getPath("userData"), "shell.log");
    try { if (fs.statSync(f).size > LOG_MAX) fs.renameSync(f, f + ".1"); } catch { /* 不存在 */ }
    fs.appendFileSync(f, stamped + "\n");
  } catch { /* 忽略 */ }
  if (DEV) { try { console.log(line); } catch { /* 忽略 */ } }
}

// ── DSH_HOME 解析（见 kernel.js 里为什么刻意不读环境变量）──────────
function getDshHome() {
  return K.resolveDshHome({
    userDataDir: app.getPath("userData"),
    useSystemDefault: settings.useSystemDshHome === true,
  });
}

// ── 内置插件（见 src/plugins.js 的完整说明）───────────────────────
//
// 用户装完 exe 就该能用 —— 不许他再敲命令装插件。这里在**内核启动前后**各做一次：
//   · 启动前：profile 已存在（绝大多数情况）⇒ 装好再起内核，一步到位、零重启。
//   · 启动后：全新机器上 profile 是内核刚建的 ⇒ 补装，然后重启一次内核让它生效。
//
// ★ 只有**打包版**默认开启。开发机（`npm start`）默认不动，免得把
//   install-plugin.js 建的开发用联接（→ 仓库目录）悄悄改写掉。
//   想验证打包行为：设 DSH_BUNDLED_PLUGINS=auto 即可强制打开。
function bundledPluginsRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "plugins")
    : path.join(__dirname, "..", "plugin");
}

function bundledPluginsEnabled() {
  const env = String(process.env.DSH_BUNDLED_PLUGINS || "").toLowerCase();
  if (env === "off" || env === "0" || env === "false") return false;
  if (env === "auto" || env === "1" || env === "true") return true;
  return app.isPackaged === true;
}

/**
 * 「首次安装向导」要不要**自动**弹出来。
 *
 * ★ 开发机默认不弹，`app.isPackaged` 才自动弹 —— 与 `bundledPluginsEnabled()` 同一条思路，
 *   但这里还有第二个、更硬的理由：**本项目有五个验收脚本会用一个全新的临时
 *   `--user-data-dir` 起真客户端**（`ui-check` 的六个模式、`plugin-check`、
 *   `plugin-check-archive`、`plugin-check-mobile-remote`）。那些临时家全都是"全新家"
 *   ⇒ 如果开发模式下也自动弹，每个脚本都会多出一个设置窗口、多一个 CDP page 目标，
 *   把它们的 `waitForPage` 判据全搅乱。
 *   ⇒ 默认只在打包版弹；要**主动验**它，用 `DSH_FIRST_RUN=force`
 *     （`scripts/ui-check.js firstrun` 就是这么干的），不必改任何别的脚本。
 *
 * 取值：`force`/`on`/`1`/`true` = 一定弹；`off`/`0`/`false` = 一定不弹（给用户的逃生阀）。
 * `DSH_FIRST_RUN=off` 也让用户能自己关掉它，不必等我们发新版本。
 */
function firstRunAutoEnabled() {
  const env = String(process.env.DSH_FIRST_RUN || "").toLowerCase();
  if (env === "off" || env === "0" || env === "false") return false;
  if (env === "force" || env === "on" || env === "1" || env === "true") return true;
  return app.isPackaged === true;
}

/** 这一次是不是"自动弹出的首启向导" —— 决定关窗口时要不要记 `dismissed`。 */
let firstRunWizardAuto = false;

/**
 * 首启向导**该不该自动弹**（三个条件同时成立）。
 *
 * ① 这一份 userData 还没走过向导（`<userData>/first-run.json` 里没有 `done:true`）；
 * ② `firstRunAutoEnabled()`（见上，开发机默认不弹）；
 * ③ **这个家里一个插件都没有** —— 这条是为了"从 0.2.5 升上来的老用户"：
 *    他们的插件是随包落位/开发联接装好的，本来就不需要挑。判据**只看本机磁盘**，
 *    不联网（`listInstalled` 是纯本地扫描）⇒ 断网也不会误判成"全新用户"而骚扰他。
 *    家里一个插件都没有 = 真正的全新用户，才该看到菜单。
 */
function firstRunDue() {
  if (FR.isDone(app.getPath("userData"))) return false;
  if (!firstRunAutoEnabled()) return false;
  try {
    const inst = PI.listInstalled({ dshHome: getDshHome(), profile: settings.profile || "web" });
    if (inst.plugins.length > 0) {
      log(`[首启向导] 这个家里已经有 ${inst.plugins.length} 个插件 ⇒ 不当作全新用户，不弹向导`);
      return false;
    }
  } catch (e) {
    // 读不到（profile 还没建、家是空的）就当"全新" —— 那正是我们要处理的场景
    log(`[首启向导] 扫本机插件时出错（按全新处理）：${(e && e.message) || e}`);
  }
  return true;
}

/**
 * 跑一次内置插件落位。**只改磁盘，绝不重启内核**（重启由调用方决定）。
 * 任何异常都吞掉并记日志 —— 内置插件失败不该让用户连客户端都打不开。
 */
function provisionPlugins(tag) {
  if (!bundledPluginsEnabled()) {
    log(`[内置插件/${tag}] 跳过（未打包且未显式开启）`);
    return { ok: false, skipped: true, changed: [], pending: null, plugins: [], errors: [] };
  }
  try {
    const r = P.provision({
      dshHome: getDshHome(),
      profile: settings.profile || "web",
      srcRoot: bundledPluginsRoot(),
      dev: !app.isPackaged,
      appVersion: app.getVersion(),
      log: (m) => log(`[内置插件/${tag}] ${m}`),
    });
    log(`[内置插件/${tag}] ok=${r.ok} pending=${r.pending || "-"} `
      + `plugins=[${r.plugins.join(",")}] changed=[${r.changed.join(",")}] `
      + `errors=[${r.errors.join(" | ")}]`);
    return r;
  } catch (e) {
    const msg = (e && e.message) || String(e);
    log(`[内置插件/${tag}] 异常（已忽略，不影响启动）: ${msg}`);
    return { ok: false, changed: [], pending: null, plugins: [], errors: [msg] };
  }
}

// ── 加载页（白底黑鲸鱼 + 进度条 + 诊断修复抽屉）────────────────────
//
// 页面是**真实文件** `src/status-page.html`，不是 `data:` URL：
//   · data: 页面没有稳定来源，IPC 来源判据没法写；
//   · data: 页面下 preload 是否注入在各 Electron 版本间有过差异。
// 动态内容由下面的 pushStatus() 通过 executeJavaScript 推过去。

/** 外壳自有页面的目录（IPC 来源判据要用） */
const SHELL_PAGES = ["status-page.html", "settings.html"];

function isShellPageUrl(u) {
  if (!u || typeof u !== "string") return false;
  try {
    if (!u.startsWith("file://")) return false;
    const p = decodeURIComponent(new URL(u).pathname).replace(/^\//, "").replace(/\//g, "\\");
    return SHELL_PAGES.some((f) => p.toLowerCase().endsWith(f.toLowerCase()));
  } catch { return false; }
}

/** 内核启动的 4 个真实阶段 —— 进度条只在这些边界上推进（不谎报进度） */
const START_STAGES = [
  { key: "config", label: "读取配置" },
  { key: "kernel", label: "查找内核" },
  { key: "spawn", label: "启动内核进程" },
  { key: "ready", label: "等待内核就绪" },
];
/** 阶段 → 进度百分比。中间不自己爬升，只靠真实事件跳动。 */
const STAGE_PERCENT = { idle: 0, config: 12, kernel: 30, spawn: 52, ready: 78, done: 100, fail: 100 };

function stagesFor(currentKey, failKey) {
  const order = START_STAGES.map((s) => s.key);
  const ci = order.indexOf(currentKey);
  const fi = failKey ? order.indexOf(failKey) : -1;
  return START_STAGES.map((s, i) => {
    let state = "pending";
    if (fi >= 0) state = i < fi ? "done" : (i === fi ? "fail" : "pending");
    else if (ci >= 0 && i < ci) state = "done";
    else if (ci >= 0 && i === ci) state = "active";
    else if (currentKey === "done") state = "done";
    return { label: s.label, state };
  });
}

function statusSnapshot() {
  return statusState || {
    seq: statusSeq,
    title: "正在启动…",
    stage: "",
    percent: 0,
    percentLabel: "",
    stages: stagesFor("config", null),
    detail: "",
    failed: false,
    settled: false,
    whale: WHALE,
  };
}

/** 把状态推给加载页（页面没起来就忽略）。 */
function pushStatus(patch) {
  const cur = statusSnapshot();
  statusSeq += 1;
  statusState = { ...cur, ...patch, seq: statusSeq, whale: WHALE };
  if (typeof patch.stageKey === "string") {
    statusState.stages = stagesFor(patch.stageKey, patch.failKey || null);
    if (typeof patch.percent !== "number" && STAGE_PERCENT[patch.stageKey] != null) {
      statusState.percent = STAGE_PERCENT[patch.stageKey];
    }
  }
  if (!mainWindow || mainWindow.isDestroyed() || !statusPageActive) return;
  const payload = JSON.stringify(statusState);
  mainWindow.webContents.executeJavaScript(`window.__dshRender && window.__dshRender(${payload})`)
    .catch(() => { /* 页面正在换掉，正常 */ });
}

/** 切到加载页。已经在状态页上时只推状态，不重复导航。 */
function showStatus(patch) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  pushStatus(patch || {});        // 状态先记下来（不管此刻在哪个页面）
  if (statusPageActive) return;   // 已经在状态页上，推状态就够了
  statusPageActive = true;
  loadStatusPage(0);
}

/**
 * 真正把 status-page.html 载进来。
 *
 * ★ 为什么要重试（2026-09-20 实测踩到）：`loadFile` 会以
 *   `ERR_ABORTED (-3)` 失败 —— 当 webContents 此刻正在加载别的页面时
 *   （例如刚 loadURL 了内核地址、或用户/脚本正好触发了一次导航）。
 *   而 `showStatus` 已经把 `statusPageActive` 置成了 true，
 *   于是一次失败就让外壳**永远认为自己在状态页上**，再也不导航
 *   ⇒ 界面卡在那个中途的页面，症状是"什么都没有"。
 */
function loadStatusPage(attempt) {
  if (!mainWindow || mainWindow.isDestroyed() || quitting) return;
  // ★ 先确认"现在还需要状态页"。`loadUi()` 会把它置 false 并去加载内核地址，
  //   此时任何重试都必须让路 —— 否则重试会把刚导航过去的官方 UI 抢回来。
  //   （2026-09-20 由 `ui-check reuse` 的 C 段实测抓到：有记录、本该直接打开
  //     官方 UI，结果被这里的状态页重试反复抢走。）
  if (!statusPageActive) return;
  mainWindow.loadFile(path.join(__dirname, "status-page.html"))
    .then(() => { if (statusPageActive) pushStatus({ }); })
    .catch((e) => {
      if (!statusPageActive) return;   // 已被接管，别再抢
      log(`加载状态页失败(第 ${attempt + 1} 次):`, (e && e.message) || e);
      if (attempt >= 4) {
        log("状态页多次加载失败，放弃导航（界面可能停在中间态）");
        return;
      }
      setTimeout(() => loadStatusPage(attempt + 1), 400);
    });
}

/** 页面 onload 时也会主动来拉一次快照（status-page.js 的 boot()）。 */

// ── 窗口 ──────────────────────────────────────────────────────────
const boundsFile = () => path.join(app.getPath("userData"), "window-state.json");
function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), "utf8"));
    if (typeof b.width === "number" && typeof b.height === "number") return b;
  } catch { /* 首次运行 */ }
  return null;
}
function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { fs.writeFileSync(boundsFile(), JSON.stringify(mainWindow.getBounds())); } catch { /* 忽略 */ }
}

function createWindow() {
  const b = loadBounds();
  mainWindow = new BrowserWindow({
    ...(b ? { x: b.x, y: b.y, width: b.width, height: b.height }
         : { width: 1280, height: 820, center: true }),
    minWidth: 900,
    minHeight: 600,
    show: false,
    // ★ 白色：加载页是白底黑鲸鱼。原来这里是深色 #0b0e14，
    //   窗口出现到页面画出来的那一瞬间会闪一下黑，很难看。
    backgroundColor: "#ffffff",
    title: "DSH Integrated",
    icon: iconPath() || undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // ★ 外壳自有页面（加载页/设置页）靠它拿到 window.dshShell。
      //   暴露面很小：只能提交**动作 id**，见 preload.js 与 diagnostics.js。
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  showStatus({ title: "正在启动…", stage: "准备中…", stageKey: "config" });

  // 外链交给系统浏览器，保持页面一比一
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("data:")) return;
    if (isShellPageUrl(url)) return;                       // 外壳自有页面，放行
    if (serverUrl && url.startsWith(serverUrl.split("?")[0])) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  // 每次官方 UI 加载完成就注入（模型搜索框 + 页面切换把手，见 src/inject/）。
  // 失败不影响任何东西：注入脚本自己会安静退出。
  mainWindow.webContents.on("did-finish-load", () => {
    const u = mainWindow.webContents.getURL();
    if (isShellPageUrl(u)) return;      // 外壳自己的页面不注入
    injectLocalUi();
    // 注入是异步的：稍等一下再把"当前在哪一页"推给把手，否则它不知道高亮谁
    setTimeout(() => { try { if (siteHost) siteHost.broadcast(); } catch { /* 忽略 */ } }, 400);
  });

  // 快捷键（无菜单栏，替代原生菜单）。站点视图是**另一个 webContents**，
  // 所以抽成函数、两边都挂 —— 否则进了网站就按不出 Ctrl+1 回不来。
  attachShortcuts(mainWindow.webContents);

  // ── 三页切换：建外部网站视图宿主（见 src/sites.js）─────────────
  //   视图是**独立一层**：切到网站时铺满内容区、盖住本机页面
  //   （本机页面继续活着 —— 内核不断线、会话照跑）；切回来只是隐藏，
  //   网站页面**不销毁** ⇒ 来回切不丢滚动位置与登录态。
  if (siteHost) { try { siteHost.destroy(); } catch { /* 旧窗口正在拆 */ } }
  siteHost = SITES.createSiteHost({
    mainWindow,
    preloadPath: path.join(__dirname, "preload.js"),
    log,
    // 当前页变了 ⇒ 托盘勾选要跟着变
    onChanged: () => { try { rebuildTrayMenu(); } catch { /* 托盘还没建好 */ } },
    onViewCreated: (wc) => {
      // ★ 外部站点也必须注入把手、也必须挂快捷键：
      //   否则用户进网站之后就没有出口了（托盘是最后一道保险，但不该是唯一出路）
      wc.on("did-finish-load", () => {
        injectInto("pages", wc, "页面切换把手（站点）");
        setTimeout(() => { try { if (siteHost) siteHost.broadcast(); } catch { /* 忽略 */ } }, 400);
      });
      wc.on("did-fail-load", () => {
        // 站点没加载成功时也尽力注入：否则用户面对一个报错页、却没有任何切换入口
        injectInto("pages", wc, "页面切换把手（站点加载失败）");
      });
      attachShortcuts(wc);
    },
  });

  mainWindow.on("close", (e) => {
    if (settings.closeToTray && !quitting && !SMOKE) { e.preventDefault(); mainWindow.hide(); return; }
    saveBounds();
  });
  mainWindow.on("closed", () => {
    try { if (siteHost) siteHost.destroy(); } catch { /* 忽略 */ }
    siteHost = null;
    mainWindow = null;
  });
  mainWindow.on("move", saveBounds);
  mainWindow.on("resize", () => {
    saveBounds();
    // 窗口尺寸变了要把网站视图跟着铺满，否则右边/下边会露出一块本机页面
    try { if (siteHost) siteHost.resize(); } catch { /* 忽略 */ }
  });
}

// ── 图标 ──────────────────────────────────────────────────────────
// 白底 + 黑色鲸鱼，由 scripts/make-icon.js 生成、scripts/verify-icon.js 逐像素验证。
// 窗口/打包用 icon.png / icon.ico；托盘单独用 tray.png（@2x 会被 Electron 自动选用）。
function iconPath() {
  const p = path.join(__dirname, "..", "assets", "icon.png");
  return fs.existsSync(p) ? p : null;
}
function trayIconPath() {
  const p = path.join(__dirname, "..", "assets", "tray.png");
  return fs.existsSync(p) ? p : iconPath();
}

// ── 页面注入（模型搜索框 + 页面切换把手 + 侧栏文件真打开）──────────
//
// 三份脚本都是「读一次就缓存 → 页面加载完成后 executeJavaScript」，失败只记日志：
// 注入挂掉不该影响页面本身（最坏是少个功能，官方界面照常用）。
const INJECT_FILES = {
  model: path.join(__dirname, "inject", "model-search.js"),
  pages: path.join(__dirname, "inject", "page-switch.js"),
  files: path.join(__dirname, "inject", "sidebar-open.js"),
};
const injectSources = {};

function injectSourceOf(key) {
  if (injectSources[key] === undefined) {
    try {
      injectSources[key] = fs.readFileSync(INJECT_FILES[key], "utf8");
    } catch (e) {
      log(`读不到注入脚本 ${key}（跳过）:`, (e && e.message) || e);
      injectSources[key] = "";
    }
  }
  return injectSources[key];
}

/** 往任意 webContents 注入一份脚本。 */
function injectInto(key, wc, note) {
  if (!wc || wc.isDestroyed()) return;
  const src = injectSourceOf(key);
  if (!src) return;
  wc.executeJavaScript(src, true)
    .catch((e) => log(`${note}注入失败（不影响使用）:`, (e && e.message) || e));
}

/**
 * 本机官方 UI 的注入。
 *
 * ★ `--no-inject` 只关**模型搜索框**（它就是为"模型搜索框出问题不想改代码"准备的开关）；
 *   **页面切换把手一定会注入** —— 它是用户从 DeepSeek 网站回到本机界面的路，
 *   关掉它等于把人锁在网站页里（虽然托盘与 Ctrl+1 还能救，但没必要冒这个险）。
 */
function injectLocalUi() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (NO_INJECT) log("已按 --no-inject 跳过模型搜索框注入");
  else injectInto("model", mainWindow.webContents, "模型搜索框");
  injectInto("pages", mainWindow.webContents, "页面切换把手");
  // ★ 侧栏文件「真打开」只注入**本机内核界面**：两个外部站点没有这个通道
  //   （主进程的 `assertLocalFileUi` 也不放行它们），注了也只是白画。
  injectInto("files", mainWindow.webContents, "侧栏文件真打开");
}

// ── 快捷键（无菜单栏，替代原生菜单）──────────────────────────────
/**
 * 给一个 webContents 挂快捷键。
 *
 * ★ 必须对**每个** webContents 各挂一次：`before-input-event` 是 per-webContents 的，
 *   主窗口那一份管不到站点视图 ⇒ 进了 DeepSeek 网站就按不出 Ctrl+1 回不来。
 */
function attachShortcuts(wc) {
  wc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const ctrl = input.control || input.meta;
    const key = String(input.key).toLowerCase();
    if (ctrl && input.shift && key === "i") { wc.toggleDevTools(); e.preventDefault(); }
    else if (ctrl && key === "r") { wc.reload(); e.preventDefault(); }
    else if (input.key === "F5") { wc.reload(); e.preventDefault(); }
    else if (ctrl && input.shift && key === "o") { if (serverUrl) shell.openExternal(serverUrl); e.preventDefault(); }
    else if (ctrl && key === ",") { openSettingsWindow(); e.preventDefault(); }
    else if (ctrl && /^[123]$/.test(key)) {
      // Ctrl+1/2/3 = 本机 DSH / DeepSeek 网页版 / DeepSeek 开放平台
      const ids = SITES.PAGES.map((p) => p.id);
      const id = ids[Number(key) - 1];
      if (id) { switchPage(id); e.preventDefault(); }
    }
  });
}

// ── 页面切换：本机 DSH / DeepSeek 网页版 / DeepSeek 开放平台 ──────
/**
 * 三页清单 + 当前页。
 *
 * ★ 0.2.7 起除了静态的 label/hint，还带上**每一页此刻的真相**
 *   （`host` / `note` / `bad` / `err`）—— 见 `sites.js` 的 `pagesUi()`。
 *   原来的 bug 就是这里只说"你想去哪一页"，从不报告"那一页到底显示成了什么"。
 *   `views` 是给验收脚本核对用的真实地址（**不推给网站页面的脚本**，见 pagesUi 的注释）。
 */
function pageState() {
  const active = siteHost ? siteHost.active() : SITES.LOCAL_ID;
  const pages = siteHost
    ? siteHost.pagesUi()
    : SITES.PAGES.map((p) => ({ id: p.id, label: p.label, hint: p.hint, host: "", note: "", bad: false, err: "" }));
  const views = {};
  if (siteHost) {
    for (const p of SITES.PAGES) {
      if (p.kind !== "web") continue;
      const s = siteHost.statusOf(p.id);
      // ★ 只外发**非敏感**的那几项。这个 payload 会经 `dsh:page:list` 回到两个网站页面的
      //   脚本里（切换把手要用它），而完整 URL 的路径/查询串上可能带登录跳转参数
      //   ⇒ 不外发完整地址。要完整地址的是**验收脚本**，它直接去那一页自己的
      //   webContents 上读 `location.href`（那是"屏幕上到底是什么"最硬的证据）。
      views[p.id] = { host: s.host, http: s.http, err: s.err, visible: s.visible };
    }
  }
  return { active, pages, views };
}

/** 切页。任何异常都吞掉并记日志 —— 切页失败不该让外壳崩掉。 */
function switchPage(id) {
  if (!siteHost) return { ok: false, id: SITES.LOCAL_ID, reason: "窗口还没建好" };
  try {
    const r = siteHost.show(String(id));
    if (!r.ok) log(`切页失败：${r.reason || "未知原因"}`);
    return r;
  } catch (e) {
    const msg = (e && e.message) || String(e);
    log(`切页异常：${msg}`);
    return { ok: false, id: siteHost.active(), reason: msg };
  }
}

/**
 * 页面切换 IPC 的来源判定。
 *
 * ⚠️ 与 `assertShellSender` **刻意不同**：那一组只放行外壳自有页面；
 *    而切换把手是注入在**官方 UI 与两个外部站点**里的，这里必须放行它们。
 *    安全边界靠"取值写死"而不是靠来源：`switchPage` → `sites.js` 的 `pageById`
 *    只认 PAGES 里那三个 id ⇒ 第三方站点即使拿到这个通道，
 *    也只能在这三页之间切，**不能执行命令、不能读写文件**。
 */
function assertPageSender(event) {
  if (!siteHost) throw new Error("拒绝：窗口还没建好");
  const sender = event.sender;
  if (!siteHost.allWebContents().some((wc) => wc === sender)) {
    throw new Error("拒绝：不是本应用的页面");
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════
// 「侧边栏文件树：真打开」（注入脚本 src/inject/sidebar-open.js）
// ══════════════════════════════════════════════════════════════════
//
// 用户要的是：侧栏里点文件夹/文件，除了**在侧栏读它**（内核自带，一个字没改），
// 还能**像在文件管理器里点它**——真用默认应用打开、真在资源管理器里选中。
//
// 这件事**只有外壳做得到**（网页拿不到 Electron 的 `shell`），所以走注入 + IPC。
//
// ⚠️ 三条边界，缺一条这功能就变成"从任意网页启动任意程序"：
//   ① **来源**必须是**本机内核界面**那几个 frame —— 两个外部站点（chat / platform）
//      用的是**同一个 preload**，所以 `window.dshShell.openWorkspaceFile` 在它们那儿
//      也**存在**；光靠"有 preload"判来源会被第三方站点白拿这个通道。
//   ② **路径**必须落在**已注册的工作区**里（读 `$DSH_HOME/storages/workspace.json`），
//      而不是"渲染进程说是什么就是什么"。
//   ③ 只认 `open` / `reveal` 两个动作，别的一律拒。

/** 只有这两个动作存在，别的一律拒（边界靠"取值写死"）。 */
const FILE_OPEN_ACTIONS = new Set(["open", "reveal"]);

/**
 * 来源判定：只有**主窗口正在显示的、本机内核界面**才能调。
 *
 * ★ 为什么不能用"有没有 preload"或者 `assertShellSender`：
 *   · 两个外部站点视图**共用同一份 preload** ⇒ 通道在它们那里也存在；
 *   · `assertShellSender` 只放行 `file://` 的外壳自有页面，而侧栏在
 *     `http://127.0.0.1:<内核端口>` 的官方 UI 里 ⇒ 两个都不适用。
 *   判据用"已提交的 URL 是不是本机内核的 origin"——渲染进程伪造不了
 *   `event.senderFrame.url`，而且它天然等于"屏幕上现在是什么"。
 */
function assertLocalFileUi(event) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("拒绝：窗口还没建好");
  if (event.sender !== mainWindow.webContents) {
    throw new Error("拒绝：只有本机内核界面能打开工作区文件");
  }
  let url = "";
  try {
    url = (event.senderFrame && event.senderFrame.url) || event.sender.getURL() || "";
  } catch { /* 取不到就当不是 */ }
  const base = serverUrl ? serverUrl.split("?")[0] : "";
  if (!base || !url.startsWith(base)) {
    throw new Error(`拒绝：当前页面不是本机内核界面（${url || "未知地址"}）`);
  }
  return true;
}

/**
 * 本机**已注册的工作区**根目录清单。
 *
 * 权威来源是 `$DSH_HOME/storages/workspace.json` 的 `tables.workspaces.<id>.path`
 * （见全局 AGENTS.md：注册表才是真值）。再并上设置里那个工作目录，作为兜底。
 * 读不到就**只认设置里那个**——宁可少放行，不可多放行。
 */
function workspaceRoots() {
  const out = [];
  try {
    const f = path.join(getDshHome(), "storages", "workspace.json");
    let raw = fs.readFileSync(f, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const j = JSON.parse(raw);
    const ws = (j && j.tables && j.tables.workspaces) || {};
    for (const id of Object.keys(ws)) {
      const p = ws[id] && ws[id].path;
      if (typeof p === "string" && p.trim()) out.push(p);
    }
  } catch (e) {
    log("读工作区注册表失败（只认设置里那个工作目录）:", (e && e.message) || e);
  }
  if (settings && typeof settings.workspace === "string" && settings.workspace.trim()) {
    out.push(settings.workspace);
  }
  return out;
}

/**
 * 校验一个待打开的路径，返回**解析过符号联接的真实路径**。
 *
 * ★ `realpathSync` 是刻意的：本机 `plugin/` 下有 Junction 指到别的工作区
 *   （见项目 AGENTS.md §7），解析完再判"在不在工作区里"，才不会漏判或误判。
 *   解析后落在工作区之外的一律拒 —— **fail closed**。
 */
function guardWorkspaceFilePath(target) {
  if (typeof target !== "string" || !target.trim()) throw new Error("拒绝：路径为空");
  if (target.indexOf("\0") >= 0) throw new Error("拒绝：路径含空字符");
  let real;
  try {
    real = fs.realpathSync(target);
  } catch (e) {
    throw new Error("这个文件不在了（可能已被移动或删除）");
  }
  const norm = (s) => path.resolve(s).replace(/[\\/]+$/, "").toLowerCase();
  const mine = norm(real);
  const hit = workspaceRoots()
    .map(norm)
    .filter((r) => r && r.length > 1)
    .some((r) => mine === r || mine.startsWith(r + "\\") || mine.startsWith(r + "/"));
  if (!hit) throw new Error("拒绝：这个路径不在任何已注册的工作区里");
  return real;
}

// ── 内核生命周期 ──────────────────────────────────────────────────
function logDir() { return path.join(app.getPath("userData"), "logs"); }

// ── 内核启动凭据的记录（修 2026-09-20 由 CDP 实测暴露出来的复用 bug）──
//
// 背景：`dsh web` 打印的那个带 token 的地址**只出现在启动日志里**，
//   裸 origin 一律回 401 "dsh web authentication required"。
//   原来的"复用已有内核"分支把 `serverUrl` 设成了**裸 origin**
//   ⇒ 复用时界面只会显示那行 401 文字，等于打不开。
//   这条路径平时不发作（客户端总是自己拉起内核、拿到带 token 的地址），
//   但只要**客户端被强杀而内核还活着**，下次启动就会踩中。
//
// 解法：自己起内核时把带 token 的地址记下来；复用前先核对记录
//   （pid 活着 + 端口一致 + DSH_HOME 一致 + 档案一致）再拿它当地址。

const kernelRecordFile = () => path.join(app.getPath("userData"), "kernel.json");

function saveKernelRecord(rec) {
  try { fs.writeFileSync(kernelRecordFile(), JSON.stringify(rec, null, 2)); }
  catch (e) { log("写内核记录失败:", (e && e.message) || e); }
}
function readKernelRecord() {
  try {
    let raw = fs.readFileSync(kernelRecordFile(), "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch { return null; }
}
function clearKernelRecord() {
  try { fs.unlinkSync(kernelRecordFile()); } catch { /* 本来就没有 */ }
}
function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
}

/**
 * 这个记录还能不能用？（每一条都是必要条件）
 * @returns {string|null} 可复用的带 token 地址，或 null
 */
function reusableRecordedUrl(port, dshHome, profile) {
  const rec = readKernelRecord();
  if (!rec || !rec.url) return null;
  const why = [];
  if (rec.port !== port) why.push(`端口 ${rec.port}≠${port}`);
  if (rec.dshHome !== dshHome) why.push("DSH_HOME 不一致");
  if ((rec.profile || "web") !== (profile || "web")) why.push(`档案 ${rec.profile}≠${profile}`);
  if (!isPidAlive(rec.pid)) why.push(`旧内核 pid ${rec.pid} 已不在`);
  if (why.length) {
    log(`内核记录不可复用（${why.join("；")}）`);
    return null;
  }
  return rec.url;
}

/**
 * 获取内核服务：优先复用已有的，否则自建。
 * 「复用」很重要 —— 避免同一台机器上起两个内核抢同一个 DSH_HOME。
 *
 * @param {{profile?: string, reuse?: boolean}} [opts]
 *   profile 覆盖本次使用的档案（纯净启动用）；reuse=false 时跳过复用探测。
 */
async function ensureServer(opts = {}) {
  const port = settings.port || DEFAULT_PORT;
  const primary = `http://${HOST}:${port}`;
  const profile = opts.profile || settings.profile || "web";
  const dshHomeForProbe = getDshHome();

  // ① 已经有内核在跑？复用，绝不起第二个。
  if (opts.reuse !== false) {
    // ①a 优先用**自己上次记下的带 token 地址**（见 reusableRecordedUrl 的注释）
    const recorded = reusableRecordedUrl(port, dshHomeForProbe, profile);
    if (recorded && K.isProbeAlive(await K.probeDsh(recorded))) {
      serverUrl = recorded;
      serverOwned = false;
      // ★ 带上 token 的地址只可能来自**我们自己写的记录** ⇒ 这个内核是本应用拉起来的。
      //   认领它：退出时才能把它一起关掉（否则就是用户报的"退不干净"）。
      const rec = readKernelRecord();
      // ★ 发出去就走：认领要查 WMI，不许挡住启动（见 claimAdoptedKernel 的注释）
      if (rec && rec.pid) void claimAdoptedKernel(rec.pid, port, "记录里的带 token 地址");
      // ★ 记录里可能是**裸 origin**（认领时补写的，见 ①b）—— 那种地址同样要过一遍
      //   "能不能看见界面"的检查，不能因为"有记录"就跳过。
      reuseUnverified = !/[?&]token=/.test(String(recorded));
      if (reuseUnverified) log("记录里的地址不带 token ⇒ 加载后仍要确认一次鉴权");
      log(`复用已有内核（用记录里的带 token 地址）: ${recorded.replace(/token=[^&]+/, "token=***")}`);
      return true;
    }
    if (recorded) log("记录里的地址探活没过，继续按裸 origin 判断");

    // ①b 退回裸 origin。★ 它只证明"有 dsh 在服务"，**不是能加载 UI 的地址**，
    //     所以打上 reuseUnverified，加载后要确认一次（见 verifyUiLoaded）。
    const probe = await K.probeDsh(primary);
    if (K.isProbeAlive(probe)) {
      serverUrl = primary;
      serverOwned = false;
      reuseUnverified = true;
      log(`复用已有内核（裸 origin，${probe}）: ${primary} —— 加载后需确认能否通过鉴权`);
      // ★ 走到这里说明**记录丢了或过期了**。端口上那个内核是谁的？
      //   能证明是我们自己拉起来的就认领（退出时关掉它），否则明确记一笔"不认领"。
      //   认领要查 WMI ⇒ **发出去就走**，绝不挡住启动（见 claimAdoptedKernel）。
      const owner = K.portOwner(port);
      if (owner) {
        void claimAdoptedKernel(owner, port, "裸 origin 复用").then((claimed) => {
          if (!claimed) return;
          // 补一份记录：下次启动就能带 token 复用，也能一眼看出它的归属与 pid
          saveKernelRecord({
            pid: owner, port, url: primary, dshHome: dshHomeForProbe, profile,
            version: (kernelInfo && kernelInfo.version) || "未知",
            startedAt: new Date().toISOString(),
            adopted: true,
          });
          log(`已为认领的内核补写记录（pid=${owner}，地址是裸 origin）`);
        }).catch((e) => log("认领流程异常:", (e && e.message) || e));
      } else {
        log("端口上探到了 dsh 服务，但读不出持有者 pid ⇒ 无法判断归属，退出时不会关它");
      }
      return true;
    }
  }

  // ② 找内核
  pushStatus({ stage: "正在查找内核…", stageKey: "kernel" });
  const kernel = K.discoverKernel({});
  if (!kernel) {
    throw new Error(
      "找不到 dsh 内核。\n\n" +
      "已尝试：DSH_KERNEL_PATH 环境变量 / 应用自带 vendor/dsh / 全局 npm。\n" +
      "安装方式（任选）：\n" +
      "  npm i -g @deepseek-ai/dsh\n" +
      "或把内核放到应用的 vendor/dsh 目录。",
    );
  }
  kernelInfo = { version: kernel.version, dir: kernel.dir, source: kernel.source };
  log(`使用内核: ${kernel.version}（来源 ${kernel.source}）`);
  log(`内核路径: ${kernel.dir}`);

  // ③ 端口被别的程序占了？
  if (K.isPortBusy(port)) {
    // ★ 先问一句"上面坐着的到底是不是 dsh" —— 原来不管是不是都报
    //   「上面探测到的不是 dsh 服务」，把"一个已经在跑的 dsh 内核"误报成
    //   "别的程序占着端口"，还叫人去关别的程序。2026-09-23 实测：
    //   诊断里的「重启内核」在复用状态下**永远失败**，报的就是这句错话。
    const busyProbe = await K.probeDsh(primary);
    const busyOwner = K.portOwner(port);
    if (K.isProbeAlive(busyProbe)) {
      throw new Error(
        `端口 ${port} 上已经有一个 dsh 内核在跑（pid ${busyOwner || "读不到"}），` +
        "而这一步要求**不复用**。\n" +
        (busyOwner && busyOwner === adoptedKernelPid
          ? "它就是本应用认领的那个内核（停止它之后端口会释放，请重试）。"
          : `如果那是你自己在终端里起的内核，请到那个终端里关它；` +
            "如果它其实是本客户端留下的，请点「诊断与修复」里的「重启内核」。"),
      );
    }
    throw new Error(
      `端口 ${port} 已被别的程序占用（pid ${busyOwner || "读不到"}，探活确认上面不是 dsh 服务）。\n` +
      "请关掉占用该端口的程序，或在设置里换一个端口。",
    );
  }

  const dshHome = getDshHome();
  log(`DSH_HOME: ${dshHome}`);

  // ④ 起内核
  pushStatus({ stage: `正在启动内核进程（档案 ${profile}）…`, stageKey: "spawn" });
  const spawned = K.spawnKernel({
    kernel,
    dshHome,
    port,
    profile,
    logDir: logDir(),
    workspace: settings.workspace || os.homedir(),
  });
  kernelProc = spawned.child;
  kernelLogFile = spawned.logFile;
  serverOwned = true;
  adoptedKernelPid = null;   // ★ 自己起了一个 ⇒ 之前认领的那个不再是我要负责的对象


  spawned.child.on("exit", (code, sig) => {
    log(`内核退出: code=${code} signal=${sig}`);
    if (kernelProc !== spawned.child) return;   // 已被替换
    kernelProc = null;
    if (quitting || SMOKE) return;
    handleServerDown().catch((e) => log("恢复异常:", e && e.message));
  });

  // ⑤ 等它打印出带 token 的地址
  pushStatus({ stage: "正在等待内核就绪…", stageKey: "ready" });
  const url = await K.waitForUrl(spawned.logFile, spawned.child, 90000);
  if (!url) {
    const tail = K.tailLog(spawned.logFile, 30);
    K.killTree(spawned.child);
    kernelProc = null;
    throw new Error(
      "内核启动失败。\n\n" +
      `内核: ${kernel.dir}\n版本: ${kernel.version}\n` +
      `DSH_HOME: ${dshHome}\n档案: ${profile}\n\n` +
      "── 内核日志尾部 ──\n" + (tail || "(无输出)"),
    );
  }

  serverUrl = url;
  serverOwned = true;
  reuseUnverified = false;
  // 记下带 token 的地址：客户端被强杀而内核还活着时，下次靠它复用（见 reusableRecordedUrl）
  saveKernelRecord({
    pid: spawned.child.pid,
    port,
    url,
    dshHome,
    profile,
    version: kernel.version,
    startedAt: new Date().toISOString(),
  });
  log(`内核就绪: ${url.replace(/token=[^&]+/, "token=***")}`);
  return true;
}

// ── 内核的停止 / 重启（诊断与修复用）──────────────────────────────
/**
 * 停掉**本应用自己拉起的**内核，并清空服务地址。
 *
 * @param {{adopted?:boolean}} [opts] `adopted: true` 时连**认领来的**那个也一起停。
 *   「重启内核」必须传它 —— 否则端口被认领的内核占着，
 *   `ensureServer({ reuse: false })` 起不了第二个，"重启"会**永远失败**
 *   （2026-09-23 实测：诊断里连点三次「重启内核」，三次都报端口被占用）。
 */
function stopOwnedKernel(opts = {}) {
  let killed = false;
  if (kernelProc) {
    try { K.killTree(kernelProc); killed = true; } catch (e) { log("杀内核失败:", (e && e.message) || e); }
    kernelProc = null;
  }
  if (opts.adopted && adoptedKernelPid) {
    log(`停掉认领来的内核 pid=${adoptedKernelPid}`);
    try { K.killTree({ pid: adoptedKernelPid }); killed = true; }
    catch (e) { log("杀认领的内核失败:", (e && e.message) || e); }
    adoptedKernelPid = null;
  }
  serverUrl = null;
  serverOwned = false;
  reuseUnverified = false;
  // ★ 记录只在**真的动了那个 pid**、或它已经不在了的时候才清。
  //   以前无条件清 ⇒ 在"复用"状态下点一次「重启内核」就把记录抹掉了，
  //   之后永远退回裸 origin、永远认不出那个内核是自己人
  //   （这正是用户现场 `kernel.json` 不见了的那条路）。
  const rec = readKernelRecord();
  if (killed || !rec || !isPidAlive(rec.pid)) clearKernelRecord();
  else log(`保留内核记录（pid=${rec.pid} 还活着，本次没动它）`);
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
}

/**
 * 退出时的内核收尾：**把本应用拉起来的（含认领来的）内核关掉**。
 *
 * ★ 这是用户 2026-09-23 报的那个 bug 的正解。判据只有一句：
 *   "这个内核是本应用拉起来的吗" —— 是就关，不是就一个字节都不动。
 *   认领的合法性在 `claimAdoptedKernel` 里已经证过了，这里只管关。
 *
 * 用 spawnSync 的 taskkill（同步）⇒ 退出前一定已经关完。
 */
function shutdownKernels(opts = {}) {
  const withAdopted = opts.adopted !== false;
  let touched = false;
  if (kernelProc) {
    log(`退出：关掉本应用启动的内核 pid=${kernelProc.pid}`);
    try { K.killTree(kernelProc); touched = true; } catch (e) { log("退出：关内核失败:", (e && e.message) || e); }
    kernelProc = null;
  }
  if (withAdopted && adoptedKernelPid) {
    log(`退出：关掉认领来的内核 pid=${adoptedKernelPid}`);
    try { K.killTree({ pid: adoptedKernelPid }); touched = true; } catch (e) { log("退出：关认领的内核失败:", (e && e.message) || e); }
    adoptedKernelPid = null;
  } else if (!withAdopted && adoptedKernelPid) {
    // ★ 冒烟（`npm run smoke`）用的是**真实 userData** —— 它会认领用户此刻
    //   正在用的那个内核。冒烟是"自检"，**不该把别人的客户端弄停**：
    //   它只负责关自己 spawn 的那个，认领来的一律放过。
    log(`冒烟收尾：不动认领来的内核 pid=${adoptedKernelPid}（自检不该打断正在用的客户端）`);
    adoptedKernelPid = null;
  }
  if (!touched) log("退出：没有需要关的内核（端口上那个不是本应用拉起来的）");
  // 记录指向的内核已经被我们关了 ⇒ 它是死的，留着是垃圾（下次启动会报"不可复用"）
  if (touched) clearKernelRecord();
}

/**
 * 退出客户端。**托盘那条「退出」、安装包那条、以及验收脚本用的都是它**
 * —— 只有一处实现，不会分叉（`scripts/quit-check.js` 就是靠这个拿到真实路径的）。
 */
function quitApp(reason) {
  quitting = true;
  log(`退出：开始了（来源：${reason}）`);
  app.quit();
}

/**
 * ★ 验收专用的退出开关（`npm run quit:check` 用）。
 *
 * 为什么需要它：主进程的 inspector 上下文里 `require` / `process.mainModule` / `module`
 * **一个都拿不到**（2026-09-23 实测三种写法全是 `NO_LOADER`），
 * 所以"从外面让外壳退出"没有别的入口。这里开一个**文件开关**而不是定时器：
 * 由验收脚本在"该检查的都检查完"之后再写文件 ⇒ 检查与退出**不会抢跑**。
 *
 * ⚠️ 两道闸：**打包版永远不读它**（`!app.isPackaged`），
 *    并且必须显式给环境变量 `DSH_QUIT_ON_FILE` 才武装。
 *    装到用户机器上的东西里，这段代码等于不存在。
 */
function armQuitOnFileHook() {
  if (app.isPackaged || SMOKE) return;
  if (!process.env.DSH_QUIT_ON_FILE) return;
  const marker = path.resolve(String(process.env.DSH_QUIT_ON_FILE));
  log(`[验收] 已武装退出开关：一旦出现文件 ${marker} 就走一次真实退出路径`);
  const timer = setInterval(() => {
    if (!fs.existsSync(marker)) return;
    clearInterval(timer);
    log("[验收] 看到退出开关文件 ⇒ 触发退出");
    quitApp("验收 DSH_QUIT_ON_FILE");
  }, 300);
}

/**
 * 加载完官方 UI 之后确认一次"真的能看见界面"。
 *
 * ★ 为什么需要它：复用别人内核时只有一个裸 origin，而它会返回
 *   401 "dsh web authentication required"。原来这里什么都不查，
 *   用户看到的就是那行英文 —— 既不知道发生了什么，也不知道怎么办。
 *   （2026-09-20 由 `scripts/ui-check.js inject` 实测暴露。）
 *
 * 只在 `reuseUnverified` 时检查，自己起的和带 token 复用的都不受影响。
 */
async function verifyUiLoaded() {
  if (!reuseUnverified) return;
  if (!mainWindow || mainWindow.isDestroyed() || !serverUrl) return;
  try {
    // ★ 多试几次再下结论：页面可能**正在加载**（此刻 innerText 还是上一页的残留），
    //   一次就判会误报。要求"连续几次都看到鉴权提示"才认定被挡住。
    //   （2026-09-20 实测：只查一次时，正好撞上加载中会得出错误结论。）
    let sawAuth = 0;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 700));
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const text = await mainWindow.webContents.executeJavaScript(
        "(document.body && document.body.innerText || '').slice(0, 400)");
      if (/authentication required|dsh web authentication/i.test(String(text))) {
        sawAuth += 1;
        continue;
      }
      if (String(text).trim().length > 0) {
        log(`复用内核的界面正常（第 ${i + 1} 次检查，正文 ${String(text).length} 字）`);
        reuseUnverified = false;
        return;
      }
      // 正文还是空的 —— 页面还在加载，继续等
    }
    if (sawAuth < 3) {   // 从没稳定看到鉴权提示 ⇒ 别吓唬用户
      log(`复用内核的界面看起来正常（鉴权提示只出现 ${sawAuth}/6 次）`);
      reuseUnverified = false;
      return;
    }

    log("复用内核被 401 挡住：拿不到 token，界面打不开");
    showStatus({
      title: "打不开这个内核",
      stage: `端口 ${settings.port || DEFAULT_PORT} 上已经有内核在跑，但本客户端没有它的访问令牌`,
      stageKey: "ready", failKey: "ready",
      settled: true, percent: 100, percentLabel: "需要处理",
      detail: [
        `端口 ${settings.port || DEFAULT_PORT} 上有一个 dsh 内核正在运行，但它**不是本客户端这次启动的**。`,
        "",
        "dsh web 的带 token 地址只在它启动时**打印一次**（在那次启动的日志里），",
        "裸地址一律返回 401，所以本客户端没法把它显示出来。",
        "",
        "三选一：",
        "  1) 关掉那个内核，然后重试 —— 本客户端会自己起一个（推荐）；",
        "  2) 直接用系统浏览器打开它：桌面上的「启动DSH.cmd」就是干这个的；",
        "  3) 在「设置」里换一个端口，本客户端会用新端口起自己的内核。",
        "",
        "（这条提示是 2026-09-20 实测加上去的：以前这里只会显示那行英文 401。）",
      ].join("\n"),
      failed: true,
    });
  } catch (e) {
    log("确认界面时出错（忽略）:", (e && e.message) || e);
  }
}

/** 切到官方 UI（内核已就绪时调用）。 */
async function loadUi() {
  if (!mainWindow || mainWindow.isDestroyed() || !serverUrl) return;
  statusPageActive = false;
  await mainWindow.loadURL(serverUrl);
  startHealthWatch();
  verifyUiLoaded().catch(() => { /* 已记录 */ });
}

/**
 * 按指定档案重启内核。
 *
 * ★ **失败会自动回退**：换档案（纯净启动）失败时不能让用户卡在
 *   一个起不来的档案里 —— 这是 2026-09-19 事故"回滚路径也踩同一个坑"
 *   那条教训的直接落实。
 *
 * @param {{profile?: string}} opts
 */
async function restartKernel(opts = {}) {
  const target = opts.profile || settings.profile || "web";
  const prev = settings.profile || "web";

  showStatus({ title: "正在重启内核…", stage: "停止旧内核…", stageKey: "config", failed: false, detail: "", percent: 0 });

  settings.profile = target;
  saveSettings();
  // ★ 连**认领来的**内核一起停（否则端口被它占着，下面 reuse:false 必撞 EADDRINUSE），
  //   并且**等端口真的放开**再起新的 —— 杀掉一个进程和它放开监听不是同一时刻，
  //   不等就会拿到 `listen EADDRINUSE`（2026-09-23 实测过：旧内核 00:34:07 退出、
  //   新内核 00:34:07.7 起来，直接崩在 webserver 那一层）。
  stopOwnedKernel({ adopted: true });
  if (!(await K.waitPortFree(settings.port || DEFAULT_PORT, 15000))) {
    log(`端口 ${settings.port || DEFAULT_PORT} 在 15 秒内没放开，仍然尝试启动新内核…`);
  }

  try {
    await ensureServer({ profile: target, reuse: false });
    await loadUi();
    return { ok: true, profile: target };
  } catch (e) {
    log(`重启到档案 ${target} 失败:`, (e && e.message) || e);
    if (target !== prev) {
      log(`自动回退到档案 ${prev} …`);
      settings.profile = prev;
      saveSettings();
      stopOwnedKernel({ adopted: true });
      await K.waitPortFree(settings.port || DEFAULT_PORT, 15000);
      try {
        await ensureServer({ profile: prev, reuse: false });
        await loadUi();
      } catch (e2) {
        log(`回退到 ${prev} 也失败:`, (e2 && e2.message) || e2);
        showStatus({
          title: "内核启动失败",
          stage: `档案 ${prev} 也起不来`,
          stageKey: "ready", failKey: "ready",
          detail: (e2 && e2.message) || String(e2),
          failed: true, settled: true, percent: 100,
          percentLabel: "失败",
        });
      }
      throw e;
    }
    showStatus({
      title: "内核启动失败",
      stage: "可以点下面的「诊断与修复」",
      stageKey: "ready", failKey: "ready",
      detail: (e && e.message) || String(e),
      failed: true, settled: true, percent: 100, percentLabel: "失败",
    });
    throw e;
  }
}

/** 服务不可用（内核崩溃 / 被外部关掉）时的自愈。 */
function handleServerDown() {
  if (quitting || SMOKE) return Promise.resolve();
  if (restarting) return restarting;

  restarting = (async () => {
    log("内核不可用，尝试恢复…");
    const killedOurs = !!kernelProc;
    if (kernelProc) { K.killTree(kernelProc); kernelProc = null; }
    // ★ 认领也会失效：它都掉线了，还留着这个 pid 只会让我在退出时去杀一个
    //   已经被系统复用了 pid 的**别的进程**。
    adoptedKernelPid = null;
    serverUrl = null;
    serverOwned = false;
    // 刚杀掉的进程不一定立刻放开端口 ⇒ 不等的话下一步会撞 EADDRINUSE，
    // 或者更糟：探活探到那个正在死的内核，把它又复用回来。
    if (killedOurs) await K.waitPortFree(settings.port || DEFAULT_PORT, 10000);
    showStatus({ title: "内核掉线，正在恢复…", stage: "重新拉起内核…", stageKey: "spawn", failed: false, detail: "" });
    try {
      await ensureServer();
      await loadUi();
      log("恢复成功:", serverUrl);
    } catch (e) {
      log("恢复失败:", e && e.message);
      showStatus({
        title: "内核启动失败",
        stage: "会自动重试；也可以点下面的「诊断与修复」",
        stageKey: "ready", failKey: "ready",
        detail: (e && e.message) || String(e),
        failed: true, settled: true, percent: 100, percentLabel: "失败",
      });
      // ★ 原来这里是"失败就停在状态页等用户重开"。现在加自动重试：
      //   内核偶发起不来时（插件竞态、端口刚释放）多试几次就起来了，
      //   不用用户来回点。20 秒一次，最多 5 次。
      if (!retryTimer) {
        retryCount = 0;
        retryTimer = setInterval(async () => {
          if (quitting || retryCount >= 5) {
            clearInterval(retryTimer); retryTimer = null; return;
          }
          retryCount += 1;
          log(`自动重试第 ${retryCount}/5 次…`);
          try {
            await ensureServer();
            await loadUi();
            clearInterval(retryTimer); retryTimer = null;
            log("自动重试成功");
          } catch (e2) {
            log("自动重试仍失败:", (e2 && e2.message) || e2);
          }
        }, 20000);
      }
    } finally {
      restarting = null;
    }
  })();

  return restarting;
}

/** 运行期探活：连续失败若干次才判定掉线（避免重活时误杀）。 */
const HEALTH_INTERVAL = 5000;
const HEALTH_TIMEOUT = 5000;
const HEALTH_FAIL_LIMIT = 3;

function startHealthWatch() {
  if (healthTimer) clearInterval(healthTimer);
  healthFails = 0;
  healthTimer = setInterval(async () => {
    if (quitting || !serverUrl || restarting) return;
    // ★ 探活必须用裸 origin，不能用 serverUrl（带一次性 token，会 303）—— 见 K.healthTargetUrl
    const r = await K.probeDsh(K.healthTargetUrl(serverUrl), HEALTH_TIMEOUT);
    if (K.isProbeAlive(r)) {
      if (healthFails > 0) log(`探活恢复（此前连续失败 ${healthFails} 次）`);
      healthFails = 0;
      return;
    }
    healthFails += 1;
    log(`探活失败 ${healthFails}/${HEALTH_FAIL_LIMIT}（判定 ${r}）`);
    if (healthFails >= HEALTH_FAIL_LIMIT) {
      healthFails = 0;
      handleServerDown().catch(() => { /* 已记录 */ });
    }
  }, HEALTH_INTERVAL);
}

// ── 托盘 ──────────────────────────────────────────────────────────
/**
 * 托盘菜单模板。
 * ★ 抽成函数是为了**当前页变化时能重建** —— radio 的勾选要跟着走。
 */
function trayTemplate() {
  const active = siteHost ? siteHost.active() : SITES.LOCAL_ID;
  return [
    { label: "显示 / 隐藏", click: toggleWindow },
    {
      label: "页面",
      submenu: SITES.PAGES.map((p, i) => ({
        label: p.label,
        type: "radio",
        checked: active === p.id,
        // ★ 这里只是**显示**提示：托盘菜单的 accelerator 不注册全局快捷键，
        //   真正生效的是 attachShortcuts 里的 before-input-event
        accelerator: `Ctrl+${i + 1}`,
        click: () => switchPage(p.id),
      })),
    },
    { label: "设置…", accelerator: "Ctrl+,", click: () => openSettingsWindow() },
    // ★ 检查更新只在设置页里实现一份：托盘这条只是**把设置页打开并跳到「更新」栏**，
    //   不在这里另写一套对话框逻辑（两处实现必然分叉）。
    { label: "检查更新…", click: () => openSettingsWindow("update") },
    { label: "在浏览器中打开", enabled: !!serverUrl, click: () => serverUrl && shell.openExternal(serverUrl) },
    { type: "separator" },
    {
      label: "关于",
      click: () => dialog.showMessageBox({
        type: "info",
        title: "关于 DSH Integrated",
        message: "DSH 集成桌面端",
        detail: [
          `外壳版本: ${app.getVersion()}`,
          `Electron : ${process.versions.electron}`,
          `内核     : ${serverUrl || "未启动"}`,
          `内核版本 : ${kernelInfo.version || "未知"}`,
          `档案     : ${settings.profile || "web"}`,
          `DSH_HOME : ${getDshHome()}`,
          `当前页面 : ${active === SITES.LOCAL_ID ? "本机 DSH" : active}`,
          // ★ 「这个内核归谁」直接决定「退出时会不会被一起关掉」——
          //   用户 2026-09-23 报"退不干净"时，最需要看到的就是这一行。
          `内核归属 : ${kernelProc ? "本应用启动（退出时会关掉它）"
            : adoptedKernelPid ? `认领来的本应用内核 pid=${adoptedKernelPid}（退出时会关掉它）`
            : serverUrl ? "不是本应用启动的（退出时不动它）" : "未启动"}`,
          "",
          "外壳只负责窗口、托盘与进程管理，不改内核的任何文件。",
        ].join("\n"),
        buttons: ["确定"],
      }),
    },
    { type: "separator" },
    { label: "退出", click: () => quitApp("托盘") },
  ];
}

/** 重建托盘菜单（当前页变了要更新勾选）。托盘还没建好时安静跳过。 */
function rebuildTrayMenu() {
  if (!tray) return;
  try { tray.setContextMenu(Menu.buildFromTemplate(trayTemplate())); }
  catch (e) { log("重建托盘菜单失败:", (e && e.message) || e); }
}

function createTray() {
  // ★ 托盘用 tray.png（白底黑鲸鱼，缩放 0.94，填得比应用图标满）；
  //   同目录的 tray@2x.png 会被 Electron 在 200% 缩放下自动选用。
  const p = trayIconPath();
  const img = p ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
  const fallback = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
  tray = new Tray(img.isEmpty() ? fallback : img);
  tray.setToolTip("DSH Integrated");
  rebuildTrayMenu();
  tray.on("click", toggleWindow);
}

// ── 设置窗口 ──────────────────────────────────────────────────────
/**
 * 打开（或聚焦）外壳设置窗口。
 *
 * @param {string} [pane] 想让设置页直接跳到哪一栏（`general` / `diag` / `update` / `about`）。
 *   托盘那条「检查更新…」就是这么用的 —— **更新流程只在设置页里实现一份**，
 *   托盘不另写一套对话框逻辑。
 */
function openSettingsWindow(pane) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    if (pane) {
      try { settingsWindow.webContents.send("dsh:settings:focus-pane", String(pane)); } catch { /* 忽略 */ }
    }
    return;
  }
  // 「首次安装向导」是**同一个窗口的另一个栏**，但它对用户是"欢迎页"而不是"设置页"
  // ⇒ 标题跟着换，别让人第一次打开客户端就看到「设置」两个字。
  const isWelcome = String(pane || "") === "welcome";
  settingsWindow = new BrowserWindow({
    width: 940,
    height: 700,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: "#ffffff",
    title: isWelcome ? "欢迎使用 · DSH 集成桌面端" : "设置 · DSH 集成桌面端",
    icon: iconPath() || undefined,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  settingsWindow.once("ready-to-show", () => settingsWindow.show());
  settingsWindow.on("closed", () => {
    settingsWindow = null;
    // ★ 自动弹出的首启向导，用户**什么都没点就把窗口关了** ⇒ 记成"见过向导了"。
    //   不记的话每次启动都会再弹一次 —— 那是骚扰，不是向导。
    //   手动打开的向导（firstRunWizardAuto=false）不记：用户只是关了个设置窗口。
    if (firstRunWizardAuto) {
      firstRunWizardAuto = false;
      if (!FR.isDone(app.getPath("userData"))) {
        const s = FR.mark(app.getPath("userData"), { dismissed: true, appVersion: app.getVersion() });
        log(`[首启向导] 用户直接关掉了向导 ⇒ 记为已看过（随时可在「集成版插件」里重开）：${JSON.stringify(s)}`);
      }
    }
  });
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // 页面加载完再把"跳到哪一栏"告诉她 —— 加载前发会丢（页面还没订阅）
  if (pane) {
    settingsWindow.webContents.once("did-finish-load", () => {
      // ★ 窗口标题必须**加载完之后**再设。
      //   `new BrowserWindow({ title })` 在页面自带 <title> 时会被文档标题盖掉 ——
      //   Electron 文档原话：If the HTML tag <title> is defined in the HTML file
      //   loaded by loadURL(), this property will be ignored.
      //   （实测：只传选项时窗口标题仍然是「设置 · DSH 集成桌面端」。）
      if (isWelcome && settingsWindow && !settingsWindow.isDestroyed()) {
        try {
          settingsWindow.setTitle("欢迎使用 · DSH 集成桌面端");
          log(`[首启向导] 窗口标题 → ${settingsWindow.getTitle()}`);
        } catch { /* 忽略 */ }
      }
      try { settingsWindow.webContents.send("dsh:settings:focus-pane", String(pane)); } catch { /* 忽略 */ }
    });
  }
  settingsWindow.loadFile(path.join(__dirname, "settings.html"))
    .catch((e) => log("加载设置页失败:", (e && e.message) || e));
}

/**
 * 自动弹首启向导。**只在 bootstrap 里、内核已经就绪之后调一次。**
 *
 * 时机是刻意的：勾选装插件要写 profile 的三处契约，而**全新机器上 profile 是内核
 * 第一次跑起来才建的** ⇒ 早于 `ensureServer()` 弹，用户勾完会发现"写不进去"。
 * 所以向导永远排在内核就绪之后。
 *
 * 它**不阻塞启动**：向导是一个独立窗口，主界面照常在后面加载完。
 */
function maybeAutoOpenFirstRun() {
  if (SMOKE) return;                                  // 冒烟测试不弹任何窗口
  if (!firstRunDue()) return;
  firstRunWizardAuto = true;
  log("[首启向导] 全新安装（家里没有插件、也没走过向导）⇒ 弹出集成版插件挑选向导");
  openSettingsWindow("welcome");
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else { mainWindow.show(); mainWindow.focus(); }
}

// ══════════════════════════════════════════════════════════════════
// IPC —— 渲染进程唯一能做事的通道
// ══════════════════════════════════════════════════════════════════
//
// 三重约束（任何一条单独都不够，所以三条一起上）：
//   ① preload 只暴露 **动作 id** 级接口，页面拿不到命令字符串；
//   ② 这里再验**来源**：必须是本应用的窗口、且当前显示的是外壳自有页面；
//   ③ 具体做什么写死在 `diagnostics.js` 的白名单里，未知 id 直接拒。
//
// ★ 第 ② 条用"这个 frame 真实提交的 URL"判定，**不要**改成"主进程自己维护的标志"：
//   标志表示的是**意图**（loadUi() 决定离开状态页的那一刻就翻掉了），
//   而页面此时还在屏幕上、脚本还在跑 ⇒ 一次正常的 getSnapshot 会被误拒，
//   界面上直接出现「读初始状态失败：拒绝…」。2026-09-20 实测踩过。
//   `event.senderFrame.url` 是主进程侧看到的已提交 URL，既伪造不了，
//   也天然等于"屏幕上现在是什么"。

function senderWindowOf(event) {
  const wc = event.sender;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === wc.id) return "main";
  if (settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.webContents.id === wc.id) return "settings";
  return null;
}

/**
 * 判据：**看这个 frame 真实提交的 URL 是不是外壳自有页面**。
 *
 * ★ 为什么不用"主进程自己维护的 `shellPageActive` 标志"（原来就是这么写的）：
 *   那个标志表示的是**意图**，不是**事实**。`loadUi()` 会在"决定离开状态页"
 *   的那一刻就把它置 false，而页面此时**还在屏幕上**、脚本还在跑 ——
 *   于是页面一次正常的 `getSnapshot()` 被拒，界面上出现
 *   「读初始状态失败：拒绝：主窗口当前显示的不是外壳页面」。
 *   （2026-09-20 由 `ui-check reuse` 实测抓到。）
 *   `event.senderFrame.url` 是主进程侧看到的**已提交 URL**，渲染进程伪造不了，
 *   而且它天然反映"现在屏幕上是什么"，不会和实际脱节。
 */
function assertShellSender(event) {
  const which = senderWindowOf(event);
  if (!which) throw new Error("拒绝：不是本应用的窗口");
  let url = "";
  try {
    url = (event.senderFrame && event.senderFrame.url) || event.sender.getURL() || "";
  } catch { /* 取不到就当不在外壳页面上 */ }
  if (!isShellPageUrl(url)) {
    throw new Error(`拒绝：当前显示的不是外壳自有页面（${url || "未知地址"}）`);
  }
  return which;
}

function diagEmit(stream, text) {
  for (const w of [mainWindow, settingsWindow]) {
    if (w && !w.isDestroyed()) {
      try { w.webContents.send("dsh:diag:out", { stream, text }); } catch { /* 窗口正在关 */ }
    }
  }
}

/** 更新进度只推给设置窗口（更新流程就实现在那里）。 */
function updateEmit(payload) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    try { settingsWindow.webContents.send("dsh:update:progress", payload); } catch { /* 忽略 */ }
  }
}

/**
 * 「检查更新」要顺带扫的本地目录 —— **只列目录、只 stat，不执行、不写**。
 *
 * ★ 为什么要有这一步（用户原话）：
 *   「检查更新，同时检查仓库的情况和本地的情况，说不定他们是本地安装包呢。」
 *   本机真实场景：自己 `npm run dist` 打出了新版本，但因为工作区不干净一直没发到
 *   GitHub ⇒ 线上还停在旧版本，只查线上就永远报「已是最新」。
 *
 *   ① 下载临时目录 —— 更新流程自己下过的那些；
 *   ② 设置里那个工作目录下的 `release\` —— 开发机上 `npm run dist` 的产出就在那儿。
 */
function localInstallerDirs() {
  const dirs = [app.getPath("temp")];
  if (settings && settings.workspace) dirs.push(path.join(settings.workspace, "release"));
  return dirs;
}

/**
 * 上一次「检查更新」在本机扫到的那个安装包路径。
 * ★ 装机那一步只认**主进程自己发现的这个路径** —— 渲染进程递进来的任意路径一律不接受，
 *   否则「检查更新」就成了一个"运行任意 exe"的通道。
 */
let localInstallerFound = null;

/**
 * 上一次「检查内核更新」查到的那个官方 dist（tarball + 校验值）。
 * ★ 同理：下载那一步只认**主进程自己查到的这个地址**，
 *   渲染进程递进来的任意 URL 一律拒 —— 否则就成了"从任意地址下任意文件"的通道。
 */
let lastKernelDist = null;
let lastKernelVersion = null;

/** 内核包下载进度只推给外壳自有窗口（设置页）。 */
function kernelUpdateEmit(payload) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    try { settingsWindow.webContents.send("dsh:kernel:progress", payload); } catch { /* 忽略 */ }
  }
}

/** 插件下载/安装进度只推给外壳自有窗口（设置页 / 首启向导）。 */
function pluginsEmit(payload) {
  for (const w of [mainWindow, settingsWindow]) {
    if (w && !w.isDestroyed()) {
      try { w.webContents.send("dsh:plugins:progress", payload); } catch { /* 窗口正在关 */ }
    }
  }
}

/**
 * 从**一份已经取好的清单快照**里装一个插件。
 *
 * ★ 抽出来是为了"单个装"与"首启向导整批装"共用同一份实现 ——
 *   复制一遍的话，将来只改一处（比如校验方式）就会让两条路悄悄分叉，
 *   而这两条路写的是同一个 profile 契约。
 *
 * ★ 版本与下载地址**只从清单快照里取**，渲染进程递进来的名字必须先在清单里找到。
 *   否则"装插件"就成了"从任意 URL 装任意代码"的通道。
 *
 * @param {object} st     `pluginState()` 的返回值（含 rows / dshHome / profile）
 * @param {string} name   包名
 * @param {?string} version 指定版本；null = 用清单里的 latest
 * @param {object} [extra] 额外塞进进度事件的字段（首启向导用它带 index/total）
 */
async function installOneFromIndex(st, name, version, extra = {}) {
  const row = st.rows.find((r) => r.name === name);
  if (!row) return { ok: false, errors: [`清单里没有 ${name}`] };
  const entry = version
    ? row.versions.find((v) => v.version === String(version))
    : row.latest;
  if (!entry) return { ok: false, errors: [`清单里没有 ${name}@${version}`] };

  log(`安装插件 ${entry.name}@${entry.version}（来自 ${entry.repo}）`);
  pluginsEmit({ kind: "start", name: entry.name, version: entry.version, ...extra });

  const dl = await PC.downloadArchive(entry, (p) => pluginsEmit({ kind: "progress", name: entry.name, ...extra, ...p }));
  if (!dl.ok) {
    pluginsEmit({ kind: "end", name: entry.name, ok: false, ...extra });
    log(`下载插件失败：${dl.error}`);
    return { ok: false, errors: [dl.error], version: entry.version };
  }

  let r;
  try {
    r = PI.installFromArchive({
      dshHome: st.dshHome,
      profile: st.profile,
      tgz: dl.path,
      // 索引给了哈希就一定要对得上；没给则 installFromArchive 会走"未校验"的降级路径并留警告
      expectedSha256: entry.sha256 || undefined,
      name: entry.name,
      log: (m) => log(`[插件] ${m}`),
    });
  } catch (err) {
    r = { ok: false, errors: [`安装出错：${(err && err.message) || err}`], warnings: [], changed: [] };
  } finally {
    // 下载的那个 tgz 装完就没用了：插件本体已经拷进 <DSH_HOME>\plugins\<名字>，
    // profile 里写的是 link 指过去 —— **不留悬空引用**（与上传器的 file: 方案不同）。
    PC.cleanupArchive(dl.path);
  }

  pluginsEmit({ kind: "end", name: entry.name, ok: !!r.ok, ...extra });
  log(`安装插件 ${entry.name}@${entry.version}：ok=${r.ok} changed=${JSON.stringify(r.changed || [])} ${(r.errors || []).join("；")}`);
  return { ...r, version: entry.version, needsRestart: !!r.ok };
}

/**
 * 「集成版插件」现在的全貌：**远端清单 × 本机已装**。
 *
 * ★ 这一份是**主进程算出来的唯一真相**，界面只负责画。
 *   渲染进程不许自己拼"要装哪个 URL、哈希是多少" —— 那些只从清单里取。
 */
async function pluginState({ force = false } = {}) {
  const dshHome = getDshHome();
  const profile = (settings && settings.profile) || "web";

  const inst = PI.listInstalled({ dshHome, profile });
  const cat = await PC.fetchIndex({ force });
  const rows = cat.ok ? PC.mergeInstalled(cat.groups, inst.plugins) : [];

  // ── 本地插件包（断网也能装的那条路，见 src/plugin-pack.js）──────────
  // ★ 只有在**网络来源没给出清单**时才拿它兜底。
  //   为什么不让它覆盖网络清单：网络那份是权威（能反映下架、新版本），
  //   本地这份是**快照**，混在一起会让人分不清"这个版本到底还在不在仓库里"。
  //   两者都有时，界面上本地那份单独显示成"本机插件包"，并标明路径。
  const pack = packState();

  return {
    ok: cat.ok,
    error: cat.error || "",
    stale: !!cat.stale,
    source: cat.source || "",
    fetchedAt: cat.fetchedAt || "",
    schema: cat.index ? cat.index.schema : "",
    knownSchema: cat.index ? cat.index.knownSchema : true,
    updatedAt: cat.index ? cat.index.updatedAt : "",
    warnings: cat.index ? cat.index.warnings : [],
    skipped: cat.index ? cat.index.skipped : [],
    rows,
    installed: inst.plugins,
    installErrors: inst.errors,
    repo: PC.HUB_REPO,
    dshHome,
    profile,
    // 本地插件包：有没有找到、在哪个目录、里面有几个包、能装哪几个
    pack: {
      found: pack.found,
      dir: pack.dir || "",
      updatedAt: pack.updatedAt || "",
      count: pack.entries ? pack.entries.length : 0,
      missing: pack.missing || [],
      warnings: pack.warnings || [],
      // ★ 只外发包名与版本（渲染进程**递不进路径**，只能拿名字回来）
      items: (pack.entries || []).map((e) => ({
        name: e.name, version: e.version, bytes: e.bytes, description: e.description,
      })),
      // 把本地的与已装的并一遍，让界面能显示"本机插件包里有但它还没装"
      rows: pack.found && pack.entries && pack.entries.length
        ? PC.mergeInstalled(PC.groupByName(pack.entries), inst.plugins).map((r) => ({ ...r, localPack: true }))
        : [],
    },
    counts: {
      total: rows.length,
      // ★ "已装"要把**本地装的**也算进去（dev 联接 / 本地 tgz / npm）——
      //   第一版只数我们装的那些，于是真机上显示「已装 0」而实际装着 11 个。
      installed: rows.filter((r) => ["installed", "update", "disabled", "local"].includes(r.state)).length,
      updatable: rows.filter((r) => r.state === "update").length,
      local: rows.filter((r) => r.state === "local").length,
      broken: rows.filter((r) => r.state === "broken").length,
    },
  };
}

/**
 * 本地插件包现在的样子 —— **只读**，纯磁盘扫描，不联网。
 *
 * 候选目录由 `PP.candidateDirs` 算（用户显式指定的那个排第一），
 * 这里只负责把 Electron 的路径概念喂给它。
 */
function packState() {
  const explicit = (settings && settings.pluginPackDir) || "";
  const dirs = PP.candidateDirs({
    userData: app.getPath("userData"),
    downloads: app.getPath("downloads"),
    desktop: app.getPath("desktop"),
    explicit,
  });
  try {
    return PP.scan({ dirs, explicit });
  } catch (e) {
    // 扫描出错绝不能把整个插件栏带崩 —— 它是**兜底**，不是主路径
    log(`扫描本地插件包出错：${(e && e.message) || e}`);
    return { ok: false, found: false, dir: "", entries: [], missing: [], warnings: [], updatedAt: "", error: String((e && e.message) || e) };
  }
}

/**
 * 从本地插件包里装一个（或整批）。
 *
 * ★ 与从索引装**走同一个咽喉**（PI.installFromArchive：sha256 + validatePluginDir），
 *   唯一区别是"文件从哪来"。这里还多做一件事：**安装前复算 sha256**，
 *   关掉"扫完到装之间文件被换掉"的 TOCTOU 窗口。
 */
function installFromLocalPack(names, extra = {}) {
  const pack = packState();
  if (!pack.found || !pack.entries.length) {
    return { ok: false, errors: ["本机没有可用的插件包"], results: [], installed: [], needsRestart: false };
  }
  const want = (Array.isArray(names) ? names : []).map((n) => String(n || "").trim()).filter(Boolean);
  const results = [];

  for (let i = 0; i < want.length; i += 1) {
    const name = want[i];
    const at = { itemIndex: i + 1, itemTotal: want.length, ...extra };
    // 同一个包名在包里可能有多版 —— 取版本最高的那一版（与 groupByName 的排序口径一致）
    const cands = pack.entries.filter((e) => e.name === name);
    if (!cands.length) {
      results.push({ name, ok: false, errors: [`本地插件包里没有 ${name}`] });
      continue;
    }
    const entry = cands.sort((a, b) => require("./update.js").cmpVersion(b.version, a.version))[0];

    pluginsEmit({ kind: "start", name, version: entry.version, ...at });
    const v = PP.verifyLocalFile(entry);
    if (!v.ok) {
      pluginsEmit({ kind: "end", name, ok: false, ...at });
      log(`本地安装 ${name}：校验失败 —— ${v.error}`);
      results.push({ name, ok: false, version: entry.version, errors: [v.error] });
      continue;
    }

    let r;
    try {
      r = PI.installFromArchive({
        dshHome: getDshHome(),
        profile: (settings && settings.profile) || "web",
        tgz: entry.localFile,
        expectedSha256: v.sha256 || entry.sha256 || undefined,
        name: entry.name,           // ★ 名字必须对得上（validatePluginDir 会核）
        log: (m) => log(`[本地插件] ${m}`),
      });
    } catch (e) {
      r = { ok: false, errors: [`安装出错：${(e && e.message) || e}`], warnings: [], changed: [] };
    }
    pluginsEmit({ kind: "end", name, ok: !!r.ok, ...at });
    log(`本地安装 ${entry.name}@${entry.version}：ok=${r.ok} ${(r.errors || []).join("；")}`);
    results.push({
      name, ok: !!r.ok, version: entry.version,
      errors: r.errors || [], warnings: r.warnings || [],
    });
  }

  const installed = results.filter((x) => x.ok).map((x) => x.name);
  return { ok: installed.length > 0, results, installed, needsRestart: installed.length > 0 };
}

function communityExe() {
  const r = diagnostics.findCommunityExe();
  return r.ok ? r.path : null;
}

/** 交给 diagnostics.js 的上下文（那里只做动作，不认识 Electron 细节）。 */
function buildDiagCtx() {
  return {
    emit: diagEmit,
    state: () => ({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      userDataDir: app.getPath("userData"),
      serverUrl,
      serverOwned,
      healthFails,
      kernelVersion: kernelInfo.version,
      kernelDir: kernelInfo.dir,
      kernelSource: kernelInfo.source,
      kernelLogFile,
      dshHome: getDshHome(),
      profile: settings.profile || "web",
      port: settings.port || DEFAULT_PORT,
      workspace: settings.workspace || os.homedir(),
      logDir: logDir(),
      communityExe: communityExe(),
      settings: { ...settings },
    }),
    restartKernel,
    openPath: (p) => shell.openPath(p),
    openExternal: (u) => shell.openExternal(u),
    clipboardWrite: (t) => clipboard.writeText(t),
  };
}

function registerIpc() {
  ipcMain.handle("dsh:diag:list", (e) => {
    assertShellSender(e);
    const st = buildDiagCtx().state();
    return diagnostics.list({ profile: st.profile, hasKernel: !!st.serverUrl });
  });

  ipcMain.handle("dsh:diag:run", async (e, id) => {
    assertShellSender(e);
    log(`诊断动作: ${id}`);
    return diagnostics.run(String(id), buildDiagCtx());
  });

  ipcMain.handle("dsh:diag:cancel", (e) => {
    assertShellSender(e);
    return diagnostics.cancel();
  });

  ipcMain.handle("dsh:state", (e) => {
    assertShellSender(e);
    return statusSnapshot();
  });

  ipcMain.handle("dsh:env", (e) => {
    assertShellSender(e);
    const st = buildDiagCtx().state();
    return { ...st, whale: WHALE };
  });

  ipcMain.handle("dsh:setting:set", (e, key, value) => {
    assertShellSender(e);
    const allowed = ["closeToTray", "port", "workspace", "useSystemDshHome"];
    if (!allowed.includes(key)) throw new Error(`不允许改这项设置: ${key}`);
    if (key === "port") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error("端口必须是 1024~65535 的整数");
      settings.port = n;
    } else if (key === "closeToTray" || key === "useSystemDshHome") {
      settings[key] = !!value;
    } else {
      settings.workspace = value ? String(value) : null;
    }
    saveSettings();
    log(`设置已改: ${key} = ${JSON.stringify(settings[key])}`);
    return { ...settings };
  });

  ipcMain.handle("dsh:settings:open", (e) => {
    assertShellSender(e);
    openSettingsWindow();
    return true;
  });

  ipcMain.handle("dsh:window:close", (e) => {
    const which = assertShellSender(e);
    if (which === "settings" && settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
    return true;
  });

  ipcMain.handle("dsh:open-location", async (e, which) => {
    assertShellSender(e);
    const map = {
      "dsh-home": getDshHome(),
      "logs": logDir(),
      "app": path.join(__dirname, ".."),
      "userdata": app.getPath("userData"),
    };
    const p = map[String(which)];
    if (!p) throw new Error(`不允许打开的位置: ${which}`);
    try { fs.mkdirSync(p, { recursive: true }); } catch { /* 只读目录就算了 */ }
    return await shell.openPath(p);
  });

  ipcMain.handle("dsh:pick-directory", async (e, startAt) => {
    assertShellSender(e);
    const r = await dialog.showOpenDialog(
      settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : mainWindow,
      {
        title: "选择工作目录",
        defaultPath: typeof startAt === "string" && startAt ? startAt : os.homedir(),
        properties: ["openDirectory", "createDirectory"],
      });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, message: "已取消" };
    return { ok: true, path: r.filePaths[0] };
  });

  // ── 页面切换：本机 DSH / DeepSeek 网页版 / DeepSeek 开放平台 ──
  //
  // ⚠️ 这两个**不用** `assertShellSender` —— 切换把手注入在官方 UI 与两个外部站点里，
  //    来源判定见 `assertPageSender` 的注释（安全边界靠 id 写死，不靠来源）。
  ipcMain.handle("dsh:page:list", (e) => {
    assertPageSender(e);
    return pageState();
  });

  ipcMain.handle("dsh:page:switch", (e, id) => {
    assertPageSender(e);
    return switchPage(id);
  });

  // ── 切换面板里的「外壳设置」入口 ──
  // 与 switchPage 同一个来源判定：把手注入在官方 UI 与两个外部站点里，
  // 所以这里也必须放行它们（否则用户在网站页里点设置会被拒）。
  ipcMain.handle("dsh:page:open-settings", (e) => {
    assertPageSender(e);
    openSettingsWindow();
    return { ok: true };
  });

  // ── 侧边栏文件树：真打开（注入脚本 src/inject/sidebar-open.js）──
  //
  // 三个动作各自都有边界（详见 `assertLocalFileUi` / `guardWorkspaceFilePath`）：
  //   来源 = 本机内核界面；路径 = 必须在已注册工作区里；动作 = open|reveal 之一。
  // ★ 一律用 Electron 的 `shell`，**不拼命令行**：路径里带空格、中文、`&` 都安全。
  // ★ 三个动作都**只读**：不写文件、不删文件、不改任何东西。
  ipcMain.handle("dsh:file:open-workspace", async (e, target, action) => {
    assertLocalFileUi(e);
    const act = FILE_OPEN_ACTIONS.has(String(action)) ? String(action) : "open";
    let real;
    try {
      real = guardWorkspaceFilePath(target);
    } catch (err) {
      const reason = (err && err.message) || String(err);
      log(`侧栏打开被拒：${reason}`);
      return { ok: false, reason };
    }
    try {
      if (act === "reveal") {
        // 在资源管理器里**选中**它（不是只打开上级目录）。
        // ★ 与内核 `revealNativePath` 同一口径：Explorer 收下请求后常常返回非 0
        //   退出码，那**不代表失败**（请求已经交出去了），所以这里用它、
        //   并且不把返回值当判据。
        shell.showItemInFolder(real);
      } else {
        const err = await shell.openPath(real);
        if (err) {
          log(`用默认应用打开失败：${err}（${real}）`);
          return { ok: false, reason: err };
        }
      }
      log(`侧栏${act === "reveal" ? "在资源管理器中显示" : "用默认应用打开"}：${real}`);
      return { ok: true, path: real, action: act };
    } catch (err) {
      const reason = (err && err.message) || String(err);
      log(`侧栏打开异常：${reason}`);
      return { ok: false, reason };
    }
  });

  // ── 检查更新（实现全在 src/update.js；这里只做来源判定与转发）──
  // 这三条会下载文件、启动安装包 ⇒ 只放行**外壳自有页面**（也就是设置页）。
  ipcMain.handle("dsh:update:check", async (e) => {
    assertShellSender(e);
    log("检查更新…（同时看线上与本机）");
    const r = await U.check({ localDirs: localInstallerDirs() });
    localInstallerFound = (r && r.localNewer && r.localNewer.path) ? r.localNewer.path : null;
    log(`检查更新：ok=${r.ok} 当前=${r.current} 线上最新=${r.latest || "-"} 线上有更新=${r.hasUpdate}`
      + ` 本地有更新=${localInstallerFound ? r.localNewer.version : "无"} ${r.reason || ""}`);
    return r;
  });

  ipcMain.handle("dsh:update:download", async (e, asset) => {
    assertShellSender(e);
    const a = asset && typeof asset === "object" ? asset : null;
    if (!a || !a.url) return { ok: false, reason: "没有可下载的附件" };
    log(`开始下载更新：${a.name}（${a.size || "?"} 字节）`);
    const r = await U.download(a, (p) => updateEmit({ kind: "progress", ...p }));
    log(`下载更新结果：ok=${r.ok} ${r.reason || r.path}`);
    return r;
  });

  ipcMain.handle("dsh:update:install", async (e, file) => {
    assertShellSender(e);
    const f = typeof file === "string" ? file : "";
    // ★ 只允许两条路启动安装包：
    //   ① 我们自己**下到临时目录**里的那一个；
    //   ② 上一次「检查更新」**主进程自己**在本机扫到的那个本地安装包。
    //   除此之外一律拒 —— 否则"检查更新"就变成了一个"运行任意 exe"的通道。
    const tmp = path.resolve(app.getPath("temp")).toLowerCase();
    const inTemp = !!f && path.dirname(path.resolve(f)).toLowerCase() === tmp;
    const isDiscovered = !!f && !!localInstallerFound
      && path.resolve(f).toLowerCase() === path.resolve(localInstallerFound).toLowerCase();
    if (!inTemp && !isDiscovered) {
      return { ok: false, reason: "拒绝：这个安装包既不是本应用下载的，也不是「检查更新」扫出来的那一个" };
    }
    const r = await U.launchInstaller(f);
    if (r.ok) {
      log("已启动安装包；外壳稍后退出，好让安装器替换正在运行的文件");
      // 外壳不退出的话，安装器替换不了正在运行的 exe。
      // 给安装器一点起来的时间再退（装完它会自己把新版本拉起来）。
      setTimeout(() => quitApp("安装包（让安装器替换文件）"), 1500);
    }
    return r;
  });

  ipcMain.handle("dsh:update:open-page", (e) => {
    assertShellSender(e);
    return U.openReleasesPage();
  });

  // ── 检查内核更新（实现全在 src/kernel-update.js）────────────────────
  //
  // 用户要求：「加一个检查按钮，可以检测内核更新，要从官方渠道下载。」
  //
  // ★ 只放行**外壳自有页面**（设置页）：这几条会给用户一条"装内核"的命令、
  //   并往 userData 里写下载的包 ⇒ 官方 UI 与两个外部站点一律不许碰。
  // ★ **这里没有「安装内核」这个通道** —— 装内核是往外壳此刻正在运行的目录里
  //   换代码（2026-09-19 那次事故就是这么来的），所以命令交给用户自己执行。
  //   本模块能做到的最大程度是「下载 + 按官方 sha512 校验 + 给命令」。
  ipcMain.handle("dsh:kernel:check", async (e) => {
    assertShellSender(e);
    log("检查内核更新…（官方渠道 = npm registry）");
    const r = await KU.check();
    // ★ 记下**主进程自己查到的**那个 dist 与版本号 —— 下载那一步只认它
    lastKernelDist = (r && r.ok && r.dist) ? r.dist : null;
    lastKernelVersion = (r && r.ok && r.latest) ? r.latest : null;
    log(`检查内核更新：ok=${r.ok} 本机=${(r.installed && r.installed.version) || "-"}`
      + `（${(r.installed && r.installed.source) || "-"}） 官方最新=${r.latest || "-"}`
      + ` 有更新=${r.hasUpdate} ${r.reason || ""}`);
    return r;
  });

  ipcMain.handle("dsh:kernel:download", async (e, dist, version) => {
    assertShellSender(e);
    // ★ 只接受"主进程上一次检查拿到的那个 dist" —— 不接受渲染进程递来的任意 URL，
    //   否则这个通道就成了"从任意地址下载任意文件"。比对 tarball 地址即可。
    const d = dist && typeof dist === "object" ? dist : null;
    if (!d || !d.tarball) return { ok: false, reason: "没有可下载的地址" };
    if (!lastKernelDist || d.tarball !== lastKernelDist.tarball) {
      return { ok: false, reason: "拒绝：这个下载地址不是「检查内核更新」查到的那一个" };
    }
    log(`开始下载内核包：${d.tarball}`);
    const r = await KU.download(lastKernelDist, String(version || lastKernelVersion || ""),
      (p) => kernelUpdateEmit({ kind: "progress", ...p }));
    log(`下载内核包结果：ok=${r.ok} ${r.reason || r.path}`
      + `${r.verified ? ` 校验=${r.verified}` : ""}`);
    return r;
  });

  /** 那条安装命令（**给用户自己执行**，不是替用户执行）。 */
  ipcMain.handle("dsh:kernel:command", (e, file) => {
    assertShellSender(e);
    // ★ 只认**我们自己下载目录里**的文件；递别的路径进来只当没给
    const f = typeof file === "string" && file ? file : "";
    const dir = path.resolve(KU.downloadDir()).toLowerCase();
    const inside = !!f && path.resolve(f).toLowerCase().startsWith(dir + path.sep);
    return { ok: true, command: KU.installHint(inside ? f : ""), dir: KU.downloadDir() };
  });

  ipcMain.handle("dsh:kernel:open-dir", async (e) => {
    assertShellSender(e);
    return KU.openDownloadDir();
  });

  ipcMain.handle("dsh:kernel:open-page", (e) => {
    assertShellSender(e);
    return KU.openOfficialPage();
  });

  // ── 集成版插件（清单 src/plugin-catalog.js；装/卸 src/plugin-install.js）──
  //
  // ⚠️ 这一组**会往用户家里装东西、还会改 profile** ⇒ 只放行**外壳自有页面**
  //    （设置页、首启向导）。官方 UI 与两个外部站点调它一律被 `assertShellSender` 拒掉。
  //
  // ★ 安装时**每次都重新拉一次清单再挑版本**，不接受渲染进程递过来的下载地址或哈希。
  //   否则"装插件"就变成了"从任意 URL 装任意代码"的通道 —— 那正是这套东西最危险的地方。
  ipcMain.handle("dsh:plugins:list", async (e) => {
    assertShellSender(e);
    return pluginState({ force: false });
  });

  ipcMain.handle("dsh:plugins:check", async (e) => {
    assertShellSender(e);
    log("检查插件更新…");
    const st = await pluginState({ force: true });
    log(`插件清单：ok=${st.ok} 条目=${st.counts.total} 可更新=${st.counts.updatable} ${st.error || ""}`);
    return st;
  });

  ipcMain.handle("dsh:plugins:install", async (e, name, version) => {
    assertShellSender(e);
    const want = String(name || "").trim();
    if (!want) return { ok: false, errors: ["没给插件名"] };

    const st = await pluginState({ force: true });
    if (!st.ok) return { ok: false, errors: [st.error || "取插件清单失败"] };
    return installOneFromIndex(st, want, version);
  });

  /**
   * 首启向导用：**一次装好几个**。
   *
   * ★ 只是把"循环"搬到主进程，**不是**多开一条能力更大的通道：
   *   渲染进程递进来的依旧只有包名，清单**只拉一次**，每个名字照样要在这份快照里找得到。
   *   这么做的两个实际好处：
   *     ① 清单只下一次网（否则装 4 个就拉 4 次索引）；
   *     ② 整批共享**同一份清单快照** —— 不会出现"装到第 3 个时索引变了"这种半新半旧。
   */
  ipcMain.handle("dsh:plugins:install-many", async (e, names) => {
    assertShellSender(e);
    const want = (Array.isArray(names) ? names : [])
      .map((n) => String(n || "").trim()).filter(Boolean);
    if (!want.length) return { ok: true, results: [], installed: [], needsRestart: false };
    if (want.length > 32) return { ok: false, errors: ["一次勾太多了（上限 32 个）"], results: [], installed: [], needsRestart: false };

    const st = await pluginState({ force: true });
    if (!st.ok) return { ok: false, errors: [st.error || "取插件清单失败"], results: [], installed: [], needsRestart: false };

    log(`[首启向导] 开始整批安装：${want.join(", ")}`);
    const results = [];
    for (let i = 0; i < want.length; i += 1) {
      // ★ 字段名是 `itemIndex`/`itemTotal` 而**不是** `index`/`total` ——
      //   `total` 已经被下载进度占用（字节总数，见 downloadArchive 的进度事件）。
      //   叫 `total` 会被 `...p` 覆盖掉，页面上就分不清"第几个"和"多少字节"。
      const extra = { itemIndex: i + 1, itemTotal: want.length };
      let r;
      try {
        r = await installOneFromIndex(st, want[i], null, extra);
      } catch (err) {
        r = { ok: false, errors: [`安装出错：${(err && err.message) || err}`] };
      }
      results.push({ name: want[i], ok: !!r.ok, version: r.version || "", errors: r.errors || [], warnings: r.warnings || [] });
    }
    const installed = results.filter((r) => r.ok).map((r) => r.name);
    log(`[首启向导] 整批装完：成功 ${installed.length}/${want.length} 个 [${installed.join(", ")}]`);
    return { ok: installed.length > 0, results, installed, needsRestart: installed.length > 0 };
  });

  ipcMain.handle("dsh:plugins:uninstall", async (e, name) => {
    assertShellSender(e);
    const want = String(name || "").trim();
    if (!want) return { ok: false, errors: ["没给插件名"] };
    const st = await pluginState({ force: false });
    const r = PI.uninstall({
      dshHome: st.dshHome,
      profile: st.profile,
      name: want,
      log: (m) => log(`[插件] ${m}`),
    });
    log(`卸载插件 ${want}：ok=${r.ok} ${(r.errors || []).join("；")}`);
    return { ...r, needsRestart: !!r.ok };
  });

  ipcMain.handle("dsh:plugins:open-page", (e) => {
    assertShellSender(e);
    return shell.openExternal(`https://github.com/${PC.HUB_REPO}`);
  });

  // ── 本地插件包（断网可用；见 src/plugin-pack.js）────────────────────
  //
  // ★ 这三条**都不接受渲染进程递来的路径**：
  //   · 扫描：目录只有"主进程算出来的候选"和"用户在原生选择框里点的那一个"两种来路；
  //   · 选目录：走 dialog.showOpenDialog，返回值由**主进程**写进 settings，
  //     渲染进程只是触发者，连自己选了什么路径都不需要知道；
  //   · 安装：渲染进程只能递**包名**，文件路径由主进程从本地索引里查出来。
  //   这样"装本地插件"就不会变成一条"从任意路径装任意代码"的通道。
  ipcMain.handle("dsh:plugins:pack-scan", (e) => {
    assertShellSender(e);
    const p = packState();
    log(`本地插件包：found=${p.found} dir=${p.dir || "-"} 条目=${p.entries ? p.entries.length : 0} ${p.error || ""}`);
    return {
      ok: p.ok, found: !!p.found, dir: p.dir || "",
      count: p.entries ? p.entries.length : 0,
      updatedAt: p.updatedAt || "", error: p.error || "",
      missing: p.missing || [], warnings: p.warnings || [],
      items: (p.entries || []).map((x) => ({ name: x.name, version: x.version, bytes: x.bytes, description: x.description })),
      tried: p.tried || [],
    };
  });

  ipcMain.handle("dsh:plugins:pick-pack-dir", async (e) => {
    assertShellSender(e);
    const r = await dialog.showOpenDialog(
      settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : mainWindow,
      {
        title: "选择插件包目录（里面有 plugin-index.json）",
        defaultPath: (settings && settings.pluginPackDir) || app.getPath("downloads"),
        properties: ["openDirectory"],
      });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, message: "已取消" };
    const picked = r.filePaths[0];
    // 先验一下再存 —— 免得用户点了个不相干的目录，之后一直"找到了但没内容"
    const probe = PP.inspectDir(picked);
    settings.pluginPackDir = picked;
    saveSettings();
    log(`插件包目录已设为：${picked}（里面有索引 = ${probe.found}）`);
    return { ok: true, path: picked, hasIndex: probe.found, dir: probe.dir || "" };
  });

  ipcMain.handle("dsh:plugins:install-local", async (e, names) => {
    assertShellSender(e);
    const want = (Array.isArray(names) ? names : []).map((n) => String(n || "").trim()).filter(Boolean);
    if (!want.length) return { ok: false, errors: ["没给插件名"], results: [], installed: [], needsRestart: false };
    if (want.length > 32) return { ok: false, errors: ["一次勾太多了（上限 32 个）"], results: [], installed: [], needsRestart: false };
    log(`[本地插件包] 开始安装：${want.join(", ")}`);
    const r = installFromLocalPack(want);
    log(`[本地插件包] 装完：成功 ${r.installed.length}/${want.length} [${r.installed.join(", ")}]`);
    return r;
  });

  // ── 首次安装向导（标记文件见 src/first-run.js）────────────────────
  //
  // 只读写 `<userData>/first-run.json`，**不碰 DSH_HOME**。
  // 判定"要不要自动弹"在主进程（firstRunDue），页面只负责"记成收工了"。
  ipcMain.handle("dsh:first-run:state", (e) => {
    assertShellSender(e);
    const s = FR.read(app.getPath("userData")) || {};
    return {
      done: s.done === true,
      at: s.at || "",
      installed: Array.isArray(s.installed) ? s.installed : [],
      skipped: s.skipped === true,
      dismissed: s.dismissed === true,
      autoEnabled: firstRunAutoEnabled(),
      userData: app.getPath("userData"),
    };
  });

  ipcMain.handle("dsh:first-run:done", (e, payload) => {
    assertShellSender(e);
    const p = payload && typeof payload === "object" ? payload : {};
    firstRunWizardAuto = false;   // 用户已经明确表态，关窗口时不必再记一次 dismissed
    const s = FR.mark(app.getPath("userData"), {
      appVersion: app.getVersion(),
      skipped: p.skipped === true,
      installed: Array.isArray(p.installed) ? p.installed.map(String).slice(0, 64) : [],
    });
    log(`[首启向导] 收工：${JSON.stringify(s)}`);
    return { ok: !!s, state: s };
  });
}

// ── 冒烟测试（打包后自检用）───────────────────────────────────────
function finishSmoke(code, note) {
  try {
    fs.writeFileSync(
      path.join(app.getPath("userData"), "smoke-result.json"),
      JSON.stringify({ code, ok: code === 0, note, time: Date.now() }));
  } catch { /* 忽略 */ }
  // ★ 冒烟收尾也要走同一套内核收尾 —— `app.exit()` 会**跳过 before-quit**，
  //   所以这里必须自己调（否则冒烟跑完同样会留下一个没人关的内核）。
  //   `adopted: false`：冒烟用**真实 userData**，会认领到用户此刻正在用的内核，
  //   而自检**不该把正在用的客户端弄停**（托盘退出那条才允许关认领来的）。
  shutdownKernels({ adopted: false });
  setTimeout(() => app.exit(code), 300);
}

function runSmoke() {
  mainWindow.webContents.once("did-finish-load", async () => {
    try {
      const r = await mainWindow.webContents.executeJavaScript(
        "({ title: document.title, boot: !!window.__DSH_BOOT__, url: location.href })");
      const origin = (() => { try { return new URL(serverUrl).origin; } catch { return serverUrl; } })();
      const ok = r.boot && String(r.url).startsWith(origin);
      log("[smoke]", JSON.stringify(r));
      finishSmoke(ok ? 0 : 1, JSON.stringify(r));
    } catch (e) {
      finishSmoke(1, String(e));
    }
  });
}

// ── 启动 ──────────────────────────────────────────────────────────
async function bootstrap() {
  loadSettings();
  registerIpc();          // ★ 必须在任何窗口加载之前注册，否则首屏 IPC 会 "No handler"
  createWindow();
  Menu.setApplicationMenu(null);

  if (!SMOKE) { try { createTray(); } catch (e) { log("托盘创建失败:", e && e.message); } }

  // ★ 内置插件（第一趟）：绝大多数情况下 profile 已经在了 —— 装好再起内核，
  //   内核第一次读 profile 就能看到它们，**不需要任何重启**。
  const preProvision = provisionPlugins("boot-pre");

  try {
    await ensureServer();

    // ★ 内置插件（第二趟）：全新机器上 profile 是内核**刚刚创建**的，
    //   第一趟只能报 pending="profile-missing"。这里补装，然后重启一次内核
    //   让它重读 profile —— 用户装的第一个客户端，打开就该有插件。
    //   只重启我们自己拉起的那一个；复用别人的内核时绝不打断（宁可他下次开才有）。
    if (preProvision.pending === "profile-missing") {
      const post = provisionPlugins("boot-post");
      if (post.changed.length && serverOwned && !SMOKE) {
        log(`内置插件首次就位（${post.changed.join(",")}），重启一次内核使其生效…`);
        showStatus({
          title: "正在装载内置插件…", stage: "重启内核…", stageKey: "config",
          failed: false, detail: "", percent: 0,
        });
        stopOwnedKernel();
        await K.waitPortFree(settings.port || DEFAULT_PORT, 15000);
        await ensureServer({ reuse: false });
      }
    }

    // ★ 修复：SMOKE 模式也必须先 loadURL(serverUrl) 再 runSmoke()。
    //   之前直接 runSmoke()，而窗口此时还停在外壳状态页，
    //   于是 did-finish-load 时 window.__DSH_BOOT__ 是 undefined，
    //   冒烟永远失败（且 finishSmoke 之前进程就退了，看不到任何结果）。
    statusPageActive = false;
    if (SMOKE) {
      // ★ 冒烟：必须先注册 did-finish-load 监听器，再 loadURL。
      //   反过来（先 loadURL 再注册）时，页面可能已经加载完、事件早已触发，
      //   监听器永远等不到 —— 表现为"超时"（2026-09-19 实测踩过）。
      runSmoke();          // 注册监听器 + 超时定时器
      await mainWindow.loadURL(serverUrl);
      return;
    }
    await mainWindow.loadURL(serverUrl);
    startHealthWatch();
    verifyUiLoaded().catch(() => { /* 已记录 */ });
    // ★ 首启向导排在这里：profile 此刻一定已经在了（内核就绪的副作用），
    //   而主界面已经加载完 —— 向导窗口浮在上面，用户关掉它就是客户端本体。
    maybeAutoOpenFirstRun();
  } catch (e) {
    const msg = (e && e.message) || String(e);
    log("启动失败:", msg);
    if (SMOKE) { finishSmoke(1, msg); return; }
    showStatus({
      title: "内核启动失败",
      stage: "可以点下面的「诊断与修复」；内核也会自动重试",
      stageKey: "ready", failKey: "ready",
      detail: msg, failed: true, settled: true, percent: 100, percentLabel: "失败",
    });
    // 与 handleServerDown 相同的自动重试：起不来不等于永远起不来
    if (!retryTimer) {
      retryCount = 0;
      retryTimer = setInterval(async () => {
        if (quitting || retryCount >= 5) { clearInterval(retryTimer); retryTimer = null; return; }
        retryCount += 1;
        log(`自动重试第 ${retryCount}/5 次…`);
        try {
          await ensureServer();
          await loadUi();
          clearInterval(retryTimer); retryTimer = null;
          log("自动重试成功");
        } catch (e2) {
          log("自动重试仍失败:", (e2 && e2.message) || e2);
        }
      }, 20000);
    }
  }
}

app.setAppUserModelId("com.18477514055.dsh-integrated");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(SMOKE ? 9 : 0);
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on("before-quit", () => {
    quitting = true;
    if (healthTimer) clearInterval(healthTimer);
    if (retryTimer) clearInterval(retryTimer);
    // ★ 内核收尾：本应用启动的 + **认领来的**，一起关（见 shutdownKernels）。
    //   以前这里只关 `kernelProc && serverOwned` ⇒ 复用的内核永远关不掉，
    //   用户看到的就"退不干净"（2026-09-23 报的 bug）。
    shutdownKernels();
    log("退出：收尾完成");
  });
  app.on("window-all-closed", () => { /* 驻留托盘 */ });
  armQuitOnFileHook();
  app.whenReady().then(bootstrap);
}
