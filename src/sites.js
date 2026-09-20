"use strict";

/**
 * sites.js —— 把外部网站作为**一层视图**装进主窗口，实现「三页切换」
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这件事只能在外壳里做（不能做成插件）
 * ══════════════════════════════════════════════════════════════════
 *   插件跑在官方前端的 React 树里，拿到的是**网页**的能力；
 *   而"把 chat.deepseek.com 装进同一个窗口"需要 Electron 的窗口/视图层
 *   （`WebContentsView`），插件根本碰不到。按项目 AGENTS.md §1 的判断顺序，
 *   这属于"进外壳"那一类。
 *
 *   ★ 顺带说明为什么**不能**用 `<iframe>`：DeepSeek 两个站点都带
 *     `X-Frame-Options` / `frame-ancestors`，内嵌会被浏览器直接拒绝；
 *     而且 iframe 里的登录态与主页面互相割裂。所以必须是独立的 view。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三个页面
 * ══════════════════════════════════════════════════════════════════
 *   · `dsh`      —— 本机内核界面。它就是**主窗口自己的 webContents**，不是 view。
 *   · `chat`     —— DeepSeek 网页版
 *   · `platform` —— DeepSeek 开放平台
 *
 *   切到网站时：`siteView` 覆盖整个内容区（本机页面仍在下面活着，
 *   内核不断线、会话继续跑）；切回本机时只是 `setVisible(false)`，
 *   网站页面**不销毁** ⇒ 来回切不会丢滚动位置与登录态。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么用 `preload` + 受限 IPC 而不是直接给网页开权限
 * ══════════════════════════════════════════════════════════════════
 *   切换按钮是**注入到页面里**的（见 `src/inject/page-switch.js`），
 *   它需要把"用户点了哪一页"告诉主进程。做法沿用外壳一贯的**动作 id** 模型：
 *   渲染进程只能提交一个 id，合法取值写死在主进程的表里 ——
 *   即使第三方网站的脚本也拿到这个通道，它最多只能在这**三个固定页面**之间切。
 */

const { WebContentsView } = require("electron");

/** 页面表 —— **单一出处**：注入脚本的按钮、托盘菜单、快捷键、IPC 白名单全都读它 */
const PAGES = [
  { id: "dsh", label: "本机 DSH", hint: "本机内核界面", kind: "local" },
  {
    id: "chat",
    label: "DeepSeek 网页版",
    hint: "chat.deepseek.com",
    kind: "web",
    url: "https://chat.deepseek.com/",
  },
  {
    id: "platform",
    label: "DeepSeek 开放平台",
    hint: "platform.deepseek.com",
    kind: "web",
    url: "https://platform.deepseek.com/",
  },
];

const LOCAL_ID = "dsh";

function pageById(id) {
  return PAGES.find((p) => p.id === id) || null;
}

/**
 * 建一个"外部网站宿主"。
 *
 * @param {object} opts
 * @param {import("electron").BrowserWindow} opts.mainWindow
 * @param {string} opts.preloadPath   注入切换按钮要用同一个 preload（受限通道）
 * @param {(m:string)=>void} [opts.log]
 * @param {(id:string)=>void} [opts.onChanged]  当前页变化时回调（推状态给按钮、更新托盘勾选）
 */
function createSiteHost(opts) {
  const { mainWindow, preloadPath, log = () => {}, onChanged = () => {}, onViewCreated = () => {} } = opts;

  /** @type {import("electron").WebContentsView|null} */
  let view = null;
  let activeId = LOCAL_ID;

  /** view 要铺满的区域 = 窗口内容区（不含标题栏/边框） */
  function contentBounds() {
    const b = mainWindow.getContentBounds();
    return { x: 0, y: 0, width: b.width, height: b.height };
  }

  function ensureView() {
    if (view && !view.webContents.isDestroyed()) return view;

    view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        // ★ 与主窗口同一个 preload：切换按钮靠它拿到受限的 window.dshShell
        preload: preloadPath,
      },
    });

    const wc = view.webContents;

    // 站内跳转放行；非 http(s)（file:、自定义协议…）一律拒绝，不给网页越界的机会
    wc.on("will-navigate", (e, url) => {
      if (!/^https?:/i.test(url)) {
        e.preventDefault();
        log(`站点视图拦下非 http(s) 跳转: ${url}`);
      }
    });

    // 弹窗：DeepSeek 系的站内弹窗留在应用内（登录/授权要用），其余交给系统浏览器
    wc.setWindowOpenHandler(({ url }) => {
      try {
        const host = new URL(url).hostname;
        if (/(^|\.)deepseek\.com$/i.test(host)) {
          return {
            action: "allow",
            overrideBrowserWindowOptions: {
              width: 520, height: 720, autoHideMenuBar: true,
              webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
            },
          };
        }
      } catch { /* URL 解析失败就按外部处理 */ }
      if (/^https?:/i.test(url)) {
        try { require("electron").shell.openExternal(url); } catch { /* 忽略 */ }
      }
      return { action: "deny" };
    });

    mainWindow.contentView.addChildView(view);
    view.setVisible(false);
    try { onViewCreated(wc); } catch (e) { log(`onViewCreated 回调出错：${(e && e.message) || e}`); }
    log("已创建站点视图层");
    return view;
  }

  /** 把当前页面 id 推给**所有**页面里的切换按钮 */
  function broadcast() {
    const payload = { active: activeId, pages: PAGES.map((p) => ({ id: p.id, label: p.label, hint: p.hint })) };
    for (const wc of allWebContents()) {
      try { wc.send("dsh:page:state", payload); } catch { /* 正在销毁 */ }
    }
  }

  function allWebContents() {
    const out = [];
    if (mainWindow && !mainWindow.isDestroyed()) out.push(mainWindow.webContents);
    if (view && !view.webContents.isDestroyed()) out.push(view.webContents);
    return out;
  }

  /**
   * 切到某一页。
   * @returns {{ok:boolean, id:string, reason?:string}}
   */
  function show(id) {
    const page = pageById(id);
    if (!page) return { ok: false, id: activeId, reason: `未知页面：${id}` };

    if (page.kind === "local") {
      if (view && !view.webContents.isDestroyed()) view.setVisible(false);
      activeId = page.id;
      log(`切到页面：${page.label}（本机）`);
      broadcast();
      onChanged(activeId);
      return { ok: true, id: activeId };
    }

    const v = ensureView();
    const wc = v.webContents;
    v.setBounds(contentBounds());

    // 第一次打开 / 上次没加载成功 ⇒ 现行 load；已经加载过的**不重载**（保住滚动位置与登录态）
    const cur = wc.getURL();
    const want = page.url;
    const sameOriginLoaded = cur && cur.startsWith(want.split("/").slice(0, 3).join("/"));
    if (!sameOriginLoaded) {
      log(`加载站点：${want}`);
      wc.loadURL(want).catch((e) => log(`站点加载失败（继续显示，用户可重试）: ${(e && e.message) || e}`));
    }

    v.setVisible(true);
    activeId = page.id;
    log(`切到页面：${page.label}`);
    broadcast();
    onChanged(activeId);
    return { ok: true, id: activeId };
  }

  /** 窗口尺寸变了要把 view 跟着铺满（否则会露出一块本机页面） */
  function resize() {
    if (view && !view.webContents.isDestroyed() && view.getVisible && view.getVisible()) {
      try { view.setBounds(contentBounds()); } catch { /* 窗口正在关 */ }
    }
  }

  function destroy() {
    if (view && !view.webContents.isDestroyed()) {
      try { mainWindow.contentView.removeChildView(view); } catch { /* 已在拆 */ }
      try { view.webContents.close(); } catch { /* 忽略 */ }
    }
    view = null;
  }

  return {
    pages: () => PAGES,
    active: () => activeId,
    show,
    resize,
    destroy,
    /** 供主进程做来源判定：这些 webContents 才允许调页面切换 IPC */
    allWebContents,
    /** 页面加载完成后推一次状态（按钮要靠它显示"当前在哪一页"） */
    broadcast,
    pageById,
  };
}

module.exports = { createSiteHost, PAGES, LOCAL_ID, pageById };
