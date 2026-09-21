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
 *   切到网站时：那**一页自己的** view 铺满内容区（本机页面仍在下面活着，
 *   内核不断线、会话继续跑）；切回本机时只是 `setVisible(false)`，
 *   网站页面**不销毁** ⇒ 来回切不会丢滚动位置与登录态。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★ 2026-09-22（0.2.7）：两个网站**各有一个自己的 view**
 * ══════════════════════════════════════════════════════════════════
 * 原来两个网站**共用一个 `WebContentsView`**，于是出了这样一个真 bug
 * （用户原话：「最开始的时候可以看到开放平台，但是现在点到开放平台，
 * 它还是保持着网页版的状态」）：
 *
 *   1. 共用 view ⇒ 平台加载失败时，屏幕上留着的是**上一个站点的页面**（网页版）；
 *   2. 失败只写一行日志 ⇒ 界面上**看不出来**；
 *   3. `activeId` 无条件设成目标页 ⇒ 面板 ✓ 与推给按钮的状态**都说你在开放平台**；
 *   4. "已加载就不重载"拿 `wc.getURL()`（最后**提交成功**的地址）当判据 ⇒
 *      失败之后地址仍停在 chat，于是点哪一页都不重载、**看着就是卡住**。
 *
 * 修法就是这一节：**一页一个 view**，再加两件"不许撒谎"的事 ——
 *   · 加载**没提交成功**就把这一页自己的 view 换成一张**本地错误卡片**
 *     （错误码 + 重试提示），而不是让别的站点的页面留在屏幕上；
 *   · 提交成功了但**跳出本站域**（被重定向）或**返回 4xx/5xx**，
 *     不动站点的页面，但把真相放进面板那一行小字里（`note`）。
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

/**
 * 失败之后等多久才把它当"真失败"。
 *
 * ★ 为什么要等（这不是拖延，是去噪）：`ERR_ABORTED (-3)` 有**两种**来源 ——
 *   ① 用户/站点把这次导航**顶掉**了（站点的 WAF 挑战脚本、登录跳转、
 *      `location.replace` 都会这样），要紧的是**后面那一次**；
 *   ② 真的没加载出来。
 *   两者在 `did-fail-load` 那一刻长得一模一样。给 1.2 秒让"后面那一次"落地：
 *   只要期间有主框架**提交成功**，就把这次失败丢掉。
 *   （不这么做的话，站点的正常跳转会在屏幕上闪出一张假的错误卡片。）
 */
const FAIL_GRACE_MS = 1200;

/** Chromium 网络错误码 → 人看得懂的名字（只列本场景真会遇到的） */
const ERR_NAMES = {
  "-2": "ERR_FAILED",
  "-3": "ERR_ABORTED",
  "-6": "ERR_FILE_NOT_FOUND",
  "-7": "ERR_TIMED_OUT",
  "-20": "ERR_BLOCKED_BY_CLIENT",
  "-21": "ERR_NETWORK_CHANGED",
  "-100": "ERR_CONNECTION_CLOSED",
  "-101": "ERR_CONNECTION_RESET",
  "-102": "ERR_CONNECTION_REFUSED",
  "-104": "ERR_CONNECTION_FAILED",
  "-105": "ERR_NAME_NOT_RESOLVED",
  "-106": "ERR_INTERNET_DISCONNECTED",
  "-118": "ERR_CONNECTION_TIMED_OUT",
  "-130": "ERR_PROXY_CONNECTION_FAILED",
  "-137": "ERR_NAME_RESOLUTION_FAILED",
  "-324": "ERR_EMPTY_RESPONSE",
};

function pageById(id) {
  return PAGES.find((p) => p.id === id) || null;
}

/** 只对 http(s) 感兴趣：我们自己的错误卡片是 `data:`，不算"站点提交成功"。 */
function isSiteUrl(u) {
  return /^https?:/i.test(String(u || ""));
}

function hostOf(u) {
  try { return new URL(String(u)).host; } catch { return ""; }
}

/** 只要**路径**，不要查询串 —— 登录跳转的参数可能带 token，绝不外发。 */
function pathOf(u) {
  try { return new URL(String(u)).pathname || "/"; } catch { return ""; }
}

/**
 * 这一页是不是"停在登录/授权页"了。
 *
 * ★ 为什么值得单独认一下（2026-09-22 实测）：`platform.deepseek.com/` 会返回 200、
 *   然后**自己跳到 `/sign_in`** —— 域名没变，所以"实际停在别的域"那条判据**不会**触发，
 *   用户看着一个登录页，不知道这就是"开放平台没登进去"。
 *   这是**同域内的重定向**，只能靠路径认。
 */
const AUTH_PATH_RE = /\/(sign[-_]?in|sign[-_]?up|log[-_]?in|log[-_]?out|auth|oauth[0-9]*|sso|passport)(\/|$)/i;
function isAuthPath(u) {
  const p = pathOf(u);
  return !!p && AUTH_PATH_RE.test(p);
}

/**
 * 失败原因的一句话（**不含完整 URL** —— 它会进面板，而路径上可能带登录跳转参数）。
 * @param {{code?:number, desc?:string, http?:number}|null} e
 */
function shortErr(e) {
  if (!e) return "";
  if (e.http) return `站点返回 HTTP ${e.http}`;
  const name = ERR_NAMES[String(e.code)] || (e.desc || "加载失败");
  return `${name}（${e.code}）`;
}

/** 自己画的那张错误卡片。纯静态、不依赖网络、内容全部转义。 */
function errorCardHtml(page, err, detail) {
  const esc = (s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(page.label)} · 没加载成功</title></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f7f9;color:#1f2933;font:14px/1.7 system-ui,-apple-system,'Segoe UI',sans-serif">
<div style="max-width:560px;padding:28px 30px;background:#fff;border:1px solid #e3e6ea;border-radius:14px;box-shadow:0 8px 30px rgba(16,20,26,.08)">
  <div style="font-size:16px;font-weight:600;margin-bottom:10px">${esc(page.label)} 没加载成功</div>
  <div style="color:#a4341f;background:#fdf1ee;border:1px solid #f3d3ca;border-radius:8px;padding:8px 10px;margin-bottom:12px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px">${esc(shortErr(err))}</div>
  <div style="color:#52606d">${esc(page.url)}</div>
  ${detail ? `<div style="color:#52606d;margin-top:8px;font-size:12.5px">${esc(detail)}</div>` : ""}
  <div style="color:#52606d;margin-top:14px">
    在右侧的 <b>⇄</b> 把手面板里<b>再点一次这一页</b>就会重试；也可以先切到别的页去。
  </div>
  <div style="color:#9aa5b1;margin-top:10px;font-size:12.5px">
    如果是「HTTP 429 / 请求被拒绝」，那多半是站点临时把你这台机器/这条线路挡住了 ——
    换一个网络（或换代理节点）再试通常就好，与我们这个客户端无关。
  </div>
</div></body></html>`;
}

/**
 * 建一个"外部网站宿主"。
 *
 * @param {object} opts
 * @param {import("electron").BrowserWindow} opts.mainWindow
 * @param {string} opts.preloadPath   注入切换按钮要用同一个 preload（受限通道）
 * @param {(m:string)=>void} [opts.log]
 * @param {(id:string)=>void} [opts.onChanged]  当前页变化时回调（推状态给按钮、更新托盘勾选）
 * @param {(wc:import("electron").WebContents)=>void} [opts.onViewCreated] 每个新 view 建好时回调一次
 */
function createSiteHost(opts) {
  const { mainWindow, preloadPath, log = () => {}, onChanged = () => {}, onViewCreated = () => {} } = opts;

  /**
   * 每个网站**一个自己的 view**，外加它自己的状态。
   * @type {Map<string, {id:string, view:?import("electron").WebContentsView,
   *   wanted:string, url:string, http:number, error:?object, settled:boolean, failTimer:any}>}
   */
  const states = new Map();
  let activeId = LOCAL_ID;

  function stateOf(id) {
    let st = states.get(id);
    if (!st) {
      st = { id, view: null, wanted: "", url: "", http: 0, error: null, settled: true, failTimer: null };
      states.set(id, st);
    }
    return st;
  }

  function clearFailTimer(st) {
    if (st.failTimer) { clearTimeout(st.failTimer); st.failTimer = null; }
  }

  /** view 要铺满的区域 = 窗口内容区（不含标题栏/边框） */
  function contentBounds() {
    const b = mainWindow.getContentBounds();
    return { x: 0, y: 0, width: b.width, height: b.height };
  }

  function liveView(st) {
    return st && st.view && !st.view.webContents.isDestroyed() ? st.view : null;
  }

  function ensureView(id) {
    const st = stateOf(id);
    if (liveView(st)) return st.view;

    const page = pageById(id);
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        // ★ 与主窗口同一个 preload：切换按钮靠它拿到受限的 window.dshShell
        preload: preloadPath,
      },
    });
    st.view = view;

    const wc = view.webContents;

    // 站内跳转放行；非 http(s)（file:、自定义协议…）一律拒绝，不给网页越界的机会。
    // ⚠️ `loadURL()` 由主进程发起时**不触发**这个事件 ⇒ 我们自己的 data: 错误卡片不受影响。
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

    // ── 主框架**提交成功** ⇒ 这一页现在真的在显示站点内容 ──
    wc.on("did-navigate", (_e, url, httpCode) => {
      if (!isSiteUrl(url)) return;              // 我们自己的错误卡片不算
      st.url = url;
      st.http = Number(httpCode) || 0;
      st.settled = true;
      clearFailTimer(st);                        // 期间提交成功 ⇒ 丢掉那次 ERR_ABORTED
      st.error = st.http >= 400 ? { http: st.http, url } : null;
      log(`[${st.id}] 已显示 ${st.url}（HTTP ${st.http || "?"}）`
        + (st.error ? " —— 站点返回了错误码，页面照常显示，但在面板上标出来" : ""));
      broadcast();
    });

    // ── ⚠️ 这里**故意没有** did-finish-load 处理器 ──
    //
    // ★★ 2026-09-22 实测（`ui-check pages` 第二趟 + 一个 30 秒的独立探针）：
    //   **`did-finish-load` 不是"加载成功"的信号。** 导航失败时 Chromium 会**提交一个
    //   内部错误页**（页面自己的 `location.href` 是 `chrome-error://chromewebdata/`），
    //   于是 `did-finish-load` **照样触发** —— 而 `webContents.getURL()` 此刻**仍然返回
    //   那次失败想去的地址**：
    //
    //     探针：加载 https://platform.deepseek.com/（代理连不上）
    //       did-fail-load  code=-130 ERR_PROXY_CONNECTION_FAILED  main=true
    //       8 秒后 getURL = https://platform.deepseek.com/     ← 不是空的、也不是 chrome-error
    //
    //   原来这里写的是「did-finish-load ⇒ settled=true, 丢掉待判定的失败」，
    //   结果是**每一次真失败都被它自己取消掉**：日志里 `did-fail-load` 有，
    //   但"换成错误卡片"永远不执行 ⇒ 界面上静默卡住（正是用户报的那个症状）。
    //
    //   ⇒ 可信的"提交成功"信号只有 `did-navigate`（主框架提交；
    //     失败时**不会**触发，探针实测）与 `did-navigate-in-page`。
    //     两个都已经接上了。
    //
    //   （main.js 那边另有自己的 `did-finish-load`，用途是**注入切换把手** ——
    //     那个必须保留：加载失败时用户更需要有出口。两者互不相干。）

    // ── 同文档内跳转（SPA）也要跟 ──
    // ★ 2026-09-22 实测踩到：`platform.deepseek.com/` 提交成功后**自己把地址推到了
    //   `/sign_in`**，而这次跳转**不触发** `did-navigate`（它是 history.pushState 那一类）
    //   ⇒ `st.url` 一直停在 `/`，"停在登录页"就永远认不出来，用户看着一个登录页
    //   却不知道这就是"开放平台没登进去"。（`ui-check pages` 抓到的那条 FAIL。）
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (isMainFrame === false || !isSiteUrl(url)) return;
      st.url = url;
      st.settled = true;
      st.error = null;          // 页面还活着、能自己跳转 ⇒ 没在"加载失败"状态
      clearFailTimer(st);
      log(`[${st.id}] 页内跳转到 ${st.url}`);
      broadcast();
    });

    // ── 主框架**没提交成功** ⇒ 屏幕上不会有这一页的内容，换成本地错误卡片 ──
    wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame === false) return;         // 子框架（广告/统计）失败不打扰用户
      const u = String(url || "");
      // ★ 先记一行**原始**记录再过滤。过滤规则一旦写错，界面表现是"静默卡住"，
      //   而日志里什么都没有 —— 这一行是唯一能事后分清"没触发"和"被我自己丢了"的东西。
      log(`[${st.id}] did-fail-load code=${code} desc=${desc} url=${u || "(空)"} main=${isMainFrame}`);
      if (u.startsWith("data:")) return;         // 我们自己的错误卡片加载失败（正常不会）
      // ★★ **不能**用"地址是不是 http(s)"当守卫 —— 实测（2026-09-22）：
      //   代理连不上（ERR_PROXY_CONNECTION_FAILED）与某些网络层失败时
      //   `validatedURL` 是**空串**，原来那句 `if (!isSiteUrl(url)) return;`
      //   会把它们**全丢掉** ⇒ 用户看到的是"点了一页，一直白着、也不报错"。
      //   地址空就退回我们**想要的那个地址**（`st.wanted`）。
      if (!u && !st.wanted) return;
      noteFailure(st, code, desc, u || st.wanted);
    });

    mainWindow.contentView.addChildView(view);
    view.setVisible(false);
    try { onViewCreated(wc); } catch (e) { log(`onViewCreated 回调出错：${(e && e.message) || e}`); }
    log(`已创建站点视图层：${page.label}`);
    return view;
  }

  /**
   * 记一次失败，但**等一小会儿**再判定（见 `FAIL_GRACE_MS` 的说明）。
   * 真失败 ⇒ 把这一页自己的 view 换成本地错误卡片。
   */
  function noteFailure(st, code, desc, url) {
    clearFailTimer(st);
    st.settled = false;
    st.failTimer = setTimeout(() => {
      st.failTimer = null;
      if (st.settled) return;                    // 期间被一次成功导航顶掉了 ⇒ 不是真失败
      st.error = { code: Number(code) || 0, desc, url };
      log(`[${st.id}] 加载失败：${shortErr(st.error)} ${url} —— 换成错误卡片`);
      showErrorCard(st);
      broadcast();
    }, FAIL_GRACE_MS);
  }

  function showErrorCard(st) {
    const page = pageById(st.id);
    const view = liveView(st);
    if (!view) return;
    const detail = st.wanted && st.wanted !== st.error.url ? `想打开的是：${st.wanted}` : "";
    try {
      view.webContents.loadURL(
        "data:text/html;charset=utf-8," + encodeURIComponent(errorCardHtml(page, st.error, detail)));
    } catch (e) {
      log(`显示错误卡片失败：${(e && e.message) || e}`);
    }
  }

  /** 发起一次加载（并把这页的状态复位成"正在加载"）。 */
  function loadInto(st, url) {
    clearFailTimer(st);
    st.error = null;
    st.http = 0;
    st.settled = false;
    st.wanted = url;
    log(`加载站点：${url}`);
    st.view.webContents.loadURL(url).catch((e) => {
      // 与 did-fail-load 是同一件事的两条路；去重靠 noteFailure 里那个宽限定时器
      log(`站点加载失败（继续显示，用户可重试）: ${(e && e.message) || e}`);
    });
  }

  /** 把当前页面 id 与**每一页的真实状态**推给所有页面里的切换按钮 */
  function broadcast() {
    const payload = { active: activeId, pages: pagesUi() };
    for (const wc of allWebContents()) {
      try { wc.send("dsh:page:state", payload); } catch { /* 正在销毁 */ }
    }
  }

  /**
   * 给界面用的页面清单：静态的 label/hint + **每页此刻的真相**。
   *
   * ★ 只给 `host`，**不给完整 URL** —— 它会被推到两个网站页面的脚本里，
   *   而登录跳转的路径上可能带查询参数。要完整地址的地方（验收脚本）
   *   自己去那页的 webContents 上读 `location.href`。
   */
  function pagesUi() {
    return PAGES.map((p) => {
      if (p.kind !== "web") {
        return { id: p.id, label: p.label, hint: p.hint, host: "", note: "", bad: false, err: "" };
      }
      const st = states.get(p.id);
      const host = st ? hostOf(st.url) : "";
      const wantHost = hostOf(p.url);
      let note = "";
      let bad = false;
      if (st && st.error) {
        note = st.error.http
          ? `${shortErr(st.error)}（页面照常显示）`
          : `没加载成功：${shortErr(st.error)}`;
        bad = true;
      } else if (host && host !== wantHost) {
        // 提交成功了，但不在本站域 ⇒ 多半是站点的重定向（例如要求先登录）。
        // 不拦它（拦了会弄坏登录），但**必须说出来**。
        note = `实际停在 ${host}`;
        bad = true;
      } else if (host && isAuthPath(st.url)) {
        // 同域内跳到了登录页 —— 这类只能靠路径认（见 isAuthPath 的说明）
        note = `停在登录页（${pathOf(st.url)}）—— 登录后就能看到内容`;
        bad = true;
      }
      return {
        id: p.id, label: p.label, hint: p.hint,
        host, note, bad,
        err: st && st.error ? shortErr(st.error) : "",
      };
    });
  }

  function allWebContents() {
    const out = [];
    if (mainWindow && !mainWindow.isDestroyed()) out.push(mainWindow.webContents);
    for (const st of states.values()) {
      const view = liveView(st);
      if (view) out.push(view.webContents);
    }
    return out;
  }

  /** 只让某一页的 view 可见（本机页 = 全部隐藏）。 */
  function showOnly(id) {
    for (const [sid, st] of states) {
      const view = liveView(st);
      if (!view) continue;
      try { view.setVisible(sid === id); } catch { /* 正在拆 */ }
    }
    // 该页还没有 view（本机页、或还没建过）时，上面什么都不做 —— 本机页本来就是"没有 view"
  }

  function hideAllWebViews() {
    for (const st of states.values()) {
      const view = liveView(st);
      if (!view) continue;
      try { view.setVisible(false); } catch { /* 忽略 */ }
    }
  }

  /**
   * 切到某一页。
   * @returns {{ok:boolean, id:string, reason?:string}}
   */
  function show(id) {
    const page = pageById(id);
    if (!page) return { ok: false, id: activeId, reason: `未知页面：${id}` };

    if (page.kind === "local") {
      hideAllWebViews();
      activeId = page.id;
      log(`切到页面：${page.label}（本机）`);
      broadcast();
      onChanged(activeId);
      return { ok: true, id: activeId };
    }

    ensureView(id);
    const st = stateOf(id);
    const view = liveView(st);
    if (!view) return { ok: false, id: activeId, reason: `${page.label} 的视图层建不起来` };
    view.setBounds(contentBounds());

    // ★ 什么时候才重新加载？**只在这两种**：
    //   ① 这一页从来没提交成功过（`st.url` 还空着）；
    //   ② 上一次尝试以失败告终（`st.error` 还在）。
    //   刻意**不**用"当前地址和想去的地址同不同源"当判据 —— 那正是 0.2.6 那个 bug：
    //   加载失败时 getURL() 还停在**上一个站点的地址**上，于是点哪一页都不重载、
    //   屏幕上留着别的站点的页面，而状态却说你已经切过去了。
    const retry = !st.url || !!st.error;
    if (retry) loadInto(st, page.url);

    showOnly(id);
    activeId = page.id;
    log(`切到页面：${page.label}${retry && st.url ? "（上次没成功，重试中）" : ""}`);
    broadcast();
    onChanged(activeId);
    return { ok: true, id: activeId };
  }

  /** 窗口尺寸变了要把 view 跟着铺满（否则会露出一块本机页面） */
  function resize() {
    for (const st of states.values()) {
      const view = liveView(st);
      if (!view) continue;
      if (typeof view.getVisible === "function" && !view.getVisible()) continue;
      try { view.setBounds(contentBounds()); } catch { /* 窗口正在关 */ }
    }
  }

  function destroy() {
    for (const st of states.values()) {
      clearFailTimer(st);
      const view = liveView(st);
      if (view) {
        try { mainWindow.contentView.removeChildView(view); } catch { /* 已在拆 */ }
        try { view.webContents.close(); } catch { /* 忽略 */ }
      }
      st.view = null;
    }
    states.clear();
  }

  /**
   * 验收脚本用的只读状态：**每一页真实的地址与失败情况**。
   * 这是"屏幕上到底是什么"的唯一可核对来源 —— `activeId` 只说"你想去哪一页"。
   */
  function statusOf(id) {
    const st = states.get(id);
    if (!st) return { id, url: "", host: "", http: 0, error: null, err: "", settled: true, visible: false, viewId: null };
    const view = liveView(st);
    let visible = false;
    try { visible = !!(view && typeof view.getVisible === "function" && view.getVisible()); } catch { visible = false; }
    return {
      id,
      url: view ? view.webContents.getURL() : "",
      host: hostOf(st.url),
      http: st.http,
      error: st.error || null,
      err: st.error ? shortErr(st.error) : "",
      settled: st.settled,
      visible,
      viewId: view ? view.webContents.id : null,
    };
  }

  return {
    pages: () => PAGES,
    pagesUi,
    active: () => activeId,
    show,
    resize,
    destroy,
    statusOf,
    /** 供主进程做来源判定：这些 webContents 才允许调页面切换 IPC */
    allWebContents,
    /** 页面加载完成后推一次状态（按钮要靠它显示"当前在哪一页"） */
    broadcast,
    pageById,
  };
}

module.exports = {
  createSiteHost, PAGES, LOCAL_ID, pageById,
  // 纯函数，验收脚本也要用同一份实现（别在脚本里再抄一遍错误码表）
  hostOf, pathOf, isAuthPath, shortErr, isSiteUrl, ERR_NAMES, FAIL_GRACE_MS,
};
