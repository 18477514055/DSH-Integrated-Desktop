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
const diagnostics = require("./diagnostics");
const P = require("./plugins");
const SITES = require("./sites");
const U = require("./update");
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

// ── 页面注入（模型搜索框 + 页面切换把手）──────────────────────────
//
// 两份脚本都是「读一次就缓存 → 页面加载完成后 executeJavaScript」，失败只记日志：
// 注入挂掉不该影响页面本身（最坏是少个功能，官方界面照常用）。
const INJECT_FILES = {
  model: path.join(__dirname, "inject", "model-search.js"),
  pages: path.join(__dirname, "inject", "page-switch.js"),
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
function pageState() {
  const active = siteHost ? siteHost.active() : SITES.LOCAL_ID;
  return {
    active,
    pages: SITES.PAGES.map((p) => ({ id: p.id, label: p.label, hint: p.hint })),
  };
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
      reuseUnverified = false;
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
    throw new Error(
      `端口 ${port} 已被占用，但上面探测到的不是 dsh 服务。\n` +
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
/** 停掉**本应用自己拉起的**内核，并清空服务地址。 */
function stopOwnedKernel() {
  if (kernelProc) {
    try { K.killTree(kernelProc); } catch (e) { log("杀内核失败:", (e && e.message) || e); }
    kernelProc = null;
  }
  serverUrl = null;
  serverOwned = false;
  reuseUnverified = false;
  clearKernelRecord();
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
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
  stopOwnedKernel();

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
      stopOwnedKernel();
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
    if (kernelProc) { K.killTree(kernelProc); kernelProc = null; }
    serverUrl = null;
    serverOwned = false;
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
          "",
          "外壳只负责窗口、托盘与进程管理，不改内核的任何文件。",
        ].join("\n"),
        buttons: ["确定"],
      }),
    },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
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
  settingsWindow = new BrowserWindow({
    width: 940,
    height: 700,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: "#ffffff",
    title: "设置 · DSH 集成桌面端",
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
  settingsWindow.on("closed", () => { settingsWindow = null; });
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // 页面加载完再把"跳到哪一栏"告诉她 —— 加载前发会丢（页面还没订阅）
  if (pane) {
    settingsWindow.webContents.once("did-finish-load", () => {
      try { settingsWindow.webContents.send("dsh:settings:focus-pane", String(pane)); } catch { /* 忽略 */ }
    });
  }
  settingsWindow.loadFile(path.join(__dirname, "settings.html"))
    .catch((e) => log("加载设置页失败:", (e && e.message) || e));
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

  // ── 检查更新（实现全在 src/update.js；这里只做来源判定与转发）──
  // 这三条会下载文件、启动安装包 ⇒ 只放行**外壳自有页面**（也就是设置页）。
  ipcMain.handle("dsh:update:check", async (e) => {
    assertShellSender(e);
    log("检查更新…");
    const r = await U.check();
    log(`检查更新：ok=${r.ok} 当前=${r.current} 最新=${r.latest || "-"} 有更新=${r.hasUpdate} ${r.reason || ""}`);
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
    // ★ 只允许启动**我们自己下到临时目录**里的那个安装包，不接受任意路径 ——
    //   否则"检查更新"就变成了一个"运行任意 exe"的通道。
    const tmp = path.resolve(app.getPath("temp")).toLowerCase();
    if (!f || path.dirname(path.resolve(f)).toLowerCase() !== tmp) {
      return { ok: false, reason: "拒绝：安装包不在本应用的临时目录里" };
    }
    const r = await U.launchInstaller(f);
    if (r.ok) {
      log("已启动安装包；外壳稍后退出，好让安装器替换正在运行的文件");
      // 外壳不退出的话，安装器替换不了正在运行的 exe。
      // 给安装器一点起来的时间再退（装完它会自己把新版本拉起来）。
      setTimeout(() => { quitting = true; app.quit(); }, 1500);
    }
    return r;
  });

  ipcMain.handle("dsh:update:open-page", (e) => {
    assertShellSender(e);
    return U.openReleasesPage();
  });
}

// ── 冒烟测试（打包后自检用）───────────────────────────────────────
function finishSmoke(code, note) {
  try {
    fs.writeFileSync(
      path.join(app.getPath("userData"), "smoke-result.json"),
      JSON.stringify({ code, ok: code === 0, note, time: Date.now() }));
  } catch { /* 忽略 */ }
  if (kernelProc) K.killTree(kernelProc);
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
    if (kernelProc && serverOwned) K.killTree(kernelProc);
    // 自己起的那个内核已经被杀了 ⇒ 记录也必须删掉，
    // 否则下次启动会拿一个死 pid 去复用（虽然有 isPidAlive 兜着，但留着是垃圾）
    if (serverOwned) clearKernelRecord();
  });
  app.on("window-all-closed", () => { /* 驻留托盘 */ });
  app.whenReady().then(bootstrap);
}
