"use strict";

/**
 * preload.js —— 外壳自有页面（加载页 / 设置页）与主进程之间的**唯一**通道。
 *
 * ══════════════════════════════════════════════════════════════════
 * 安全设计（这份文件是外壳的信任边界，改之前先读完）
 * ══════════════════════════════════════════════════════════════════
 * 1. **渲染进程永远拿不到命令字符串。**
 *    它只能提交一个**动作 id**；id → 具体做什么，写死在主进程的
 *    `diagnostics.js` 白名单里。就算这个页面被注入了脚本，
 *    它能做的也只是"点一下我们本来就提供的那几个按钮"。
 *
 * 2. **主进程还会再判一次来源**（`main.js` 的 `assertShellSender`）：
 *    只有"当前正在显示外壳自有页面"时才受理。官方 UI 页面（http://…）
 *    即使拿到了 window.dshShell，调用也会被拒。
 *
 * 3. 只暴露必须的几件事，**不暴露 ipcRenderer 本身**，
 *    也没有 `require` / `process` / 任意 `invoke(channel, ...)` 的通道。
 */

const { contextBridge, ipcRenderer } = require("electron");

/** 订阅一个主进程事件，返回退订函数。 */
function subscribe(channel, cb) {
  if (typeof cb !== "function") return () => { };
  const handler = (_event, payload) => {
    try { cb(payload); } catch (e) { /* 页面自己的异常不该炸掉通道 */ }
  };
  ipcRenderer.on(channel, handler);
  return () => { try { ipcRenderer.removeListener(channel, handler); } catch (e) { } };
}

contextBridge.exposeInMainWorld("dshShell", {
  // ── 诊断与修复 ────────────────────────────────────────────────
  /** 列出可用动作（只有元数据，没有命令）。 */
  listActions: () => ipcRenderer.invoke("dsh:diag:list"),
  /** 执行一个动作 id。返回 { ok, code, message }。输出通过 onOutput 流式推送。 */
  runAction: (id) => ipcRenderer.invoke("dsh:diag:run", String(id)),
  /** 请求中止正在跑的动作。 */
  cancelAction: () => ipcRenderer.invoke("dsh:diag:cancel"),
  /** 动作的输出分片：{ id, stream: "out"|"err"|"sys", text } */
  onOutput: (cb) => subscribe("dsh:diag:out", cb),
  /** 动作开始/结束：{ id, phase: "start"|"end", ok?, code? } */
  onActionState: (cb) => subscribe("dsh:diag:state", cb),

  // ── 启动状态（加载页用） ──────────────────────────────────────
  /** 当前状态快照。带 seq，页面据此丢弃过期事件。 */
  getSnapshot: () => ipcRenderer.invoke("dsh:state"),
  /** 状态变化：{ seq, phase, title, detail, percent, stages, failed } */
  onStatus: (cb) => subscribe("dsh:status", cb),

  // ── 设置 ──────────────────────────────────────────────────────
  /** 写入一项设置。返回更新后的完整设置对象。 */
  setSetting: (key, value) => ipcRenderer.invoke("dsh:setting:set", String(key), value),
  /** 打开设置窗口（加载页底部入口用）。 */
  openSettings: () => ipcRenderer.invoke("dsh:settings:open"),
  /** 关掉当前窗口（设置窗口的"关闭"按钮用；主窗口忽略此调用）。 */
  closeSelf: () => ipcRenderer.invoke("dsh:window:close"),
  /** 用系统资源管理器打开一个**白名单内**的位置：'dsh-home' | 'logs' | 'app' */
  openLocation: (which) => ipcRenderer.invoke("dsh:open-location", String(which)),
  /** 弹系统目录选择框。返回 { ok, path?, message? }。 */
  pickDirectory: (startAt) => ipcRenderer.invoke("dsh:pick-directory", startAt ? String(startAt) : null),

  // ── 只读环境信息（关于页/诊断信息用） ────────────────────────
  getEnv: () => ipcRenderer.invoke("dsh:env"),

  // ── 页面切换：本机 DSH / DeepSeek 网页版 / DeepSeek 开放平台 ──
  //
  // ★ 这一组与上面所有通道**不一样**：它必须允许**官方 UI 页面与两个外部站点**调用，
  //   因为切换把手是注入到那些页面里去的（见 src/inject/page-switch.js），
  //   而 `assertShellSender` 只放行外壳自有页面。
  //   安全边界靠"取值写死"来保证：主进程只认三个固定 id
  //   （`dsh` / `chat` / `platform`，见 src/sites.js 的 PAGES）。
  //   所以即使第三方网站的脚本也拿到这个通道，它最多只能在这三页之间切，
  //   既不能执行命令、也不能读写文件。
  /** 页面清单 + 当前在哪一页：{ active, pages:[{id,label,hint}] } */
  pages: () => ipcRenderer.invoke("dsh:page:list"),
  /** 切到某一页。返回 { ok, id, reason? }。 */
  switchPage: (id) => ipcRenderer.invoke("dsh:page:switch", String(id)),
  /** 主进程主动推的页面变化：{ active, pages:[…] } */
  onPageState: (cb) => subscribe("dsh:page:state", cb),
  /** 打开外壳设置窗口（切换面板最后那一栏用；与 switchPage 同一套来源判定）。 */
  openShellSettings: () => ipcRenderer.invoke("dsh:page:open-settings"),

  // ── 侧边栏文件树：真打开（注入脚本 src/inject/sidebar-open.js）──────
  //
  // 用户要的：侧栏里点文件/文件夹，除了「在侧栏读它」（内核自带），
  // 还能**像在文件管理器里点它**——用默认应用打开、在资源管理器里选中。
  //
  // ⚠️ 这一组**只放行本机内核界面**（主进程的 `assertLocalFileUi` 按
  //    `event.senderFrame.url` 的 origin 判）。两个外部站点视图**共用本 preload**
  //    ⇒ 它们那里也能看到这个函数，但一调就被拒 —— 这是刻意的：
  //    否则第三方页面就拿到了"启动本机程序"的能力。
  // ⚠️ 路径还要过第二道闸：必须落在**已注册的工作区**里（`guardWorkspaceFilePath`），
  //    不是"页面说是什么就是什么"。
  /**
   * 打开一个工作区里的文件/文件夹。
   * @param {string} path 绝对路径
   * @param {"open"|"reveal"} action open=默认应用／reveal=在资源管理器中选中
   * @returns {Promise<{ok:boolean, path?:string, action?:string, reason?:string}>}
   */
  openWorkspaceFile: (p, action) => ipcRenderer.invoke(
    "dsh:file:open-workspace", String(p), action === "reveal" ? "reveal" : "open"),

  // ── 检查更新（实现全在主进程 src/update.js）────────────────────
  //
  // ⚠️ 这一组会**下载文件并启动安装包** ⇒ 主进程只放行**外壳自有页面**
  //    （也就是设置页）。官方 UI 与两个外部站点调它会被 `assertShellSender` 拒掉。
  /** 查 GitHub 上有没有比当前更新的版本。只读，不写任何东西。 */
  checkUpdate: () => ipcRenderer.invoke("dsh:update:check"),
  /** 下载安装包。进度通过 onUpdateProgress 推。返回 { ok, path?, reason? }。 */
  downloadUpdate: (asset) => ipcRenderer.invoke("dsh:update:download", asset),
  /** 启动已下载的安装包（只接受本应用临时目录里的那个文件），随后外壳会退出让安装器替换。 */
  installUpdate: (file) => ipcRenderer.invoke("dsh:update:install", String(file)),
  /** 用系统浏览器打开 Releases 页（想自己下的时候用）。 */
  openReleases: () => ipcRenderer.invoke("dsh:update:open-page"),
  /** 下载进度：{ got, total, percent } */
  onUpdateProgress: (cb) => subscribe("dsh:update:progress", cb),
  /** 托盘「检查更新…」让设置页跳到某一栏：pane 名 */
  onFocusPane: (cb) => subscribe("dsh:settings:focus-pane", cb),

  // ── 检查内核更新（实现全在 src/kernel-update.js）──────────────────
  //
  // 用户要求：「加一个检查按钮，可以检测内核更新，要从官方渠道下载。」
  //
  // ⚠️ 这一组**只放行外壳自有页面**（设置页）——
  //    它会往 userData 里写下载的包、并给出一条"装内核"的命令。
  //
  // ★★ 这里**故意没有「安装内核」这个通道**：装内核 = 往外壳此刻正在运行的
  //    目录（全局 npm）里换代码，而 2026-09-19 那次事故正是"无人值守地升级内核"
  //    （升级失败 → 回滚也失败 → 客户端完全起不来）。
  //    所以本组能做到的最大程度是「检查 + 下载 + 按官方 sha512 校验 + 给你命令」，
  //    **那条命令由用户自己在终端里执行**。
  /** 查官方渠道上的内核最新版。只读，不写任何东西。 */
  checkKernel: () => ipcRenderer.invoke("dsh:kernel:check"),
  /** 下载官方内核包到 userData\kernel-update\。进度通过 onKernelProgress 推。 */
  downloadKernel: (dist, version) => ipcRenderer.invoke(
    "dsh:kernel:download", dist || null, version ? String(version) : null),
  /** 给出那条**由你自己执行**的安装命令。返回 { ok, command, dir }。 */
  kernelCommand: (file) => ipcRenderer.invoke("dsh:kernel:command", file ? String(file) : ""),
  /** 在资源管理器里打开内核包下载目录。 */
  openKernelDir: () => ipcRenderer.invoke("dsh:kernel:open-dir"),
  /** 用系统浏览器打开官方 npm 页面（自己看版本历史时用）。 */
  openKernelPage: () => ipcRenderer.invoke("dsh:kernel:open-page"),
  /** 内核包下载进度：{ kind, got, total, percent } */
  onKernelProgress: (cb) => subscribe("dsh:kernel:progress", cb),

  // ── 集成版插件（清单 src/plugin-catalog.js；装/卸 src/plugin-install.js）──
  //
  // ⚠️ 这一组会**往 DSH 家里装东西、并改 profile** ⇒ 主进程只放行**外壳自有页面**。
  //    官方 UI 与两个外部站点调它会被 `assertShellSender` 拒掉。
  // ★ 这里只暴露"包名 + 版本"：**下载地址与 sha256 传不进去** ——
  //    主进程每次重新拉清单后自己取。否则这个通道就成了"从任意 URL 装任意代码"。
  /** 清单 × 本机已装的全貌（含 counts / stale / warnings / skipped）。 */
  plugins: () => ipcRenderer.invoke("dsh:plugins:list"),
  /** 强制重新拉一次远端清单（「检查插件更新」按钮用）。 */
  checkPlugins: () => ipcRenderer.invoke("dsh:plugins:check"),
  /** 装或更新一个插件。返回 { ok, errors, warnings, version, needsRestart }。 */
  installPlugin: (name, version) => ipcRenderer.invoke(
    "dsh:plugins:install", String(name), version ? String(version) : null),
  /** 首启向导用：一次装好几个（清单只下一次网）。返回 { ok, results, installed, needsRestart }。 */
  installPlugins: (names) => ipcRenderer.invoke(
    "dsh:plugins:install-many", Array.isArray(names) ? names.map(String) : []),
  /** 卸一个插件（撤 profile 三处 + 删落点）。 */
  uninstallPlugin: (name) => ipcRenderer.invoke("dsh:plugins:uninstall", String(name)),
  /** 用系统浏览器打开插件仓库主页。 */
  openPluginHub: () => ipcRenderer.invoke("dsh:plugins:open-page"),
  /** 插件下载/安装进度：{ kind:"start"|"progress"|"end", name, version?, got?, total?, percent?, ok? } */
  onPluginProgress: (cb) => subscribe("dsh:plugins:progress", cb),

  // ── 本地插件包（断网可用；src/plugin-pack.js）──────────────────────
  //
  // ★ 这三个通道**都不接受渲染进程递来的路径**：
  //   · packScan    —— 只读扫候选目录（用户设过的那一个优先）
  //   · pickPackDir —— 弹**原生**目录选择框，路径由主进程存进 settings
  //   · installLocal—— 只收**包名**，文件路径由主进程从本地索引里查
  //   所以"装本地插件"不会变成"从任意路径装任意代码"的通道。
  /** 扫一遍本机有没有插件包。返回 { ok, found, dir, count, items, missing, tried }。 */
  packScan: () => ipcRenderer.invoke("dsh:plugins:pack-scan"),
  /** 让用户挑一个插件包目录（原生对话框）。返回 { ok, path, hasIndex }。 */
  pickPackDir: () => ipcRenderer.invoke("dsh:plugins:pick-pack-dir"),
  /** 从**本地插件包**装（断网也走得通）。返回 { ok, results, installed, needsRestart }。 */
  installLocal: (names) => ipcRenderer.invoke(
    "dsh:plugins:install-local", Array.isArray(names) ? names.map(String) : []),

  // ── 首次安装向导（标记文件 src/first-run.js）────────────────────
  //
  // 0.2.6 起安装包**不带插件**（包干干净净），插件的入口变成"首启时勾选、从插件仓库拉"。
  // 这一组只读写 <userData>/first-run.json，不碰 DSH_HOME。
  /** 向导走过了没有。 */
  firstRunState: () => ipcRenderer.invoke("dsh:first-run:state"),
  /** 记成"收工了"（此后不再自动弹）。payload: { skipped?, installed? } */
  firstRunDone: (payload) => ipcRenderer.invoke("dsh:first-run:done", payload || {}),
});
