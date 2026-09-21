/* dsh手机遥控 · 前端逻辑（无框架、无外部依赖）
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一版修了什么（对着用户报的问题）
 * ══════════════════════════════════════════════════════════════════
 * ① **会话标题**：★ 标题**本来就在** `session.list` 返回的
 *    `projections.values.title` 里（实测 134/138 个会话都带）。
 *    上一版却另外发一个 `session.titles` 去翻会话日志 —— 既多余，
 *    又正好在旧宿主上不存在 ⇒ 标题全丢、回退成 sessionId（用户看到"全是代码开头"）。
 *    **现在直接用 list 里的 title，不再发那个请求。**
 * ② **浅色主题**：整站改白底（见 styles.css）。
 * ③ **布局不再错位/溢出**：`100dvh` + 滚动层 `min-height:0` + `overflow-x:hidden`
 *    + 安全区（详见 styles.css 文件头）。
 * ④ **能力探测**：启动时探测宿主支持哪些方法；不支持的功能**明确提示**
 *    "需要重启客户端"，而不是点了没反应或静默失败。
 * ⑤ 名字改成「dsh手机遥控」。
 * ⑥ **键盘不再挡住输入框**：见下面 `syncViewport()` 的长注释 ——
 *    Android 15 起强制 edge-to-edge，`windowSoftInputMode="adjustResize"` **已失效**，
 *    光靠 CSS 治不好，必须在 JS 里跟 `visualViewport`。
 * ⑦ **图标换成单色 SVG**（原来是 emoji 🖼 / 🕘，用户说"不知道是干什么用的"）。
 * ⑧ **工具调用 / 思考过程默认折叠**（用户："像电脑那样子做成折叠的样式会好一点"）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 鉴权（上一版死在这上面）
 * ══════════════════════════════════════════════════════════════════
 * 不用 WebSocket：浏览器 `new WebSocket()` **无法设置请求头**。
 * 事件流用 EventSource（token 走查询参数），动作请求用 fetch（token 走 Authorization 头）。
 */
'use strict';

(function () {
  var TOKEN_KEY = 'dsh-mmr-token';
  var HISTORY_KEY = 'dsh-mmr-history';

  var $ = function (id) { return document.getElementById(id); };
  var pairView = $('pairView'), listView = $('listView'), detailView = $('detailView');
  var pairForm = $('pairForm'), codeInput = $('codeInput'), pairMsg = $('pairMsg');
  var sessionList = $('sessionList'), listMsg = $('listMsg'), searchInput = $('searchInput');
  var messages = $('messages'), promptForm = $('promptForm'), promptInput = $('promptInput');
  var detailTitle = $('detailTitle'), detailSub = $('detailSub'), sendBtn = $('sendBtn');
  var approvalBar = $('approvalBar'), approvalTool = $('approvalTool'), approvalReason = $('approvalReason');
  var attachBar = $('attachBar'), fileInput = $('fileInput');
  var sheet = $('sheet'), sheetTitle = $('sheetTitle'), sheetBody = $('sheetBody');
  var hostBanner = $('hostBanner'), hostBannerText = $('hostBannerText');

  var token = null, es = null;
  var sessions = [];          // 最近一次 list（**已含标题**）
  var workspaces = [];
  var current = null, currentTitle = '';
  var pendingImages = [];
  var streamBuf = '', streamEl = null, streamReason = '', reasonEl = null;
  var activeApproval = null;
  var caps = { workspace: null, catalog: null };   // 能力探测结果（null=未知）

  /* ── 小工具 ─────────────────────────────────────────── */

  function show(view) {
    [pairView, listView, detailView].forEach(function (v) { v.classList.add('hidden'); });
    view.classList.remove('hidden');
  }
  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function baseName(p) {
    if (typeof p !== 'string' || !p) return '';
    var s = p.replace(/[\\/]+$/, '');
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? (s.slice(i + 1) || s) : s;
  }
  function relTime(ts) {
    if (!ts) return '';
    var d = Date.now() - ts; if (d < 0) d = 0;
    var m = Math.floor(d / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    if (h < 48) return '昨天';
    var dt = new Date(ts);
    return (dt.getMonth() + 1) + '-' + dt.getDate();
  }
  function scrollDown() { messages.scrollTop = messages.scrollHeight; }

  /* ── 键盘：让页面跟着可视视口缩，输入框永不被盖 ──────────
   *
   * ══════════════════════════════════════════════════════════════════
   * 用户报的问题
   * ══════════════════════════════════════════════════════════════════
   * 「手机上点击输入框弹出键盘之后，键盘会把那个输入框挡住，整个页面也会被挡住一半，
   *   你尝试正常的聊天那样子，然后整个页面往上抬。」
   *
   * ══════════════════════════════════════════════════════════════════
   * 真因（三层叠在一起，所以只改一层治不好）
   * ══════════════════════════════════════════════════════════════════
   * ① **Android 15（API 35）起强制 edge-to-edge**：
   *    `windowSoftInputMode="adjustResize"` 对它是**失效**的（哪怕 Manifest 里写了，
   *    见 android/app/src/main/AndroidManifest.xml:39）。WebView 不再因为键盘而缩高度
   *     ⇒ 键盘**盖**在页面上，`100dvh` 量到的还是"没有键盘"的高度，
   *    底部输入框正好落在键盘底下。这是本 bug 的主因，**纯 CSS 治不了**。
   * ② `interactive-widget=resizes-content`（viewport 里写了）能帮上忙，
   *    但只有较新的、且尊重该提示的 ROM 才生效 ⇒ 不能只靠它。
   * ③ `100dvh` 跟随的是"动态视口"，而键盘弹出时它**不一定**变
   *    （取决于 ① 的行为）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 解法：把可视视口的高度**显式**写到 CSS 变量上
   * ══════════════════════════════════════════════════════════════════
   * `visualViewport` 是唯一能拿到"键盘占了多少"的接口：
   *   · `height`      = 真正看得见的高度（键盘弹出后它**会**变小）
   *   · `offsetTop`   = 可视区相对布局视口上移了多少
   * 把它写进 `--app-h`，让 body 用它当高度（而不是 100dvh）⇒ 键盘一弹，
   * body 立刻变矮，flex 布局把输入框顶到键盘之上 —— 就是用户要的"整个页面上抬"。
   *
   * ★ 为什么用 CSS 变量而不是直接改 body.style.height：
   *   变量能让 styles.css 里的 `height: var(--app-h, 100dvh)` 在**没有 JS**
   *   （或 JS 报错）时自然回退到 dvh，不会出现"脚本挂了页面高度变 0"。
   *
   * ★ 为什么监听 3 个事件：不同 ROM 触发的时机不一样
   *   （`resize` 最常见、`scroll` 在部分机型上才动、`focusin/focusout` 兜底）。
   *   重复触发无害（写的是同一个值）。
   */
  function syncViewport() {
    var vv = window.visualViewport;
    var root = document.documentElement;
    if (!vv) return;                       // 老浏览器：CSS 里的 100dvh 兜底
    var h = Math.round(vv.height);
    if (!h || h < 80) return;              // 明显异常的值不要写进去
    root.style.setProperty('--app-h', h + 'px');
    // 键盘高度（供将来需要时用；也让"是否需要额外上抬"可判断）
    var kb = Math.max(0, Math.round(window.innerHeight - h - vv.offsetTop));
    root.style.setProperty('--kb-h', kb + 'px');
  }

  function installViewportSync() {
    if (!window.visualViewport) return;
    var vv = window.visualViewport;
    syncViewport();
    vv.addEventListener('resize', syncViewport);
    vv.addEventListener('scroll', syncViewport);
    window.addEventListener('orientationchange', function () { setTimeout(syncViewport, 120); });
    // 聚焦输入框时再补一次：键盘动画有延迟，resize 可能早于最终高度
    document.addEventListener('focusin', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
        setTimeout(syncViewport, 60);
        setTimeout(syncViewport, 320);
        // 聚焦后把输入框滚进可视区（部分机型键盘弹出不自动滚）
        setTimeout(function () {
          try { t.scrollIntoView({ block: 'nearest' }); } catch (err) { }
        }, 340);
      }
    });
    document.addEventListener('focusout', function () {
      setTimeout(syncViewport, 60);
      setTimeout(syncViewport, 320);
    });
  }

  /** 从 session.list 的条目里取标题（**这就是官方给的标题来源**）。 */
  function titleOf(s) {
    var v = s && s.projections && s.projections.values;
    return (v && typeof v.title === 'string' && v.title) ? v.title : '';
  }

  /* ── 宿主版本提示 ───────────────────────────────────── */

  function warnHost(msg) {
    hostBannerText.textContent = msg;
    hostBanner.classList.remove('hidden');
  }
  $('hostBannerClose').onclick = function () { hostBanner.classList.add('hidden'); };

  /* ── 网络 ───────────────────────────────────────────── */

  function api(method, params) {
    return fetch('/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ method: method, params: params || {} }),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || j.ok === false) {
          var e = new Error(j.message || j.error || ('HTTP ' + r.status));
          e.unauthorized = (r.status === 401);
          e.unknownMethod = (j.error === 'unknown_method');
          throw e;
        }
        return j.result;
      });
    });
  }

  /** 探测宿主支持哪些方法 —— 旧宿主缺的方法要**明确告知**，不能静默。 */
  function probeCapabilities() {
    api('workspace.list').then(function () { caps.workspace = true; })
      .catch(function (e) { caps.workspace = !e.unknownMethod; });
    api('modelCatalog').then(function () { caps.catalog = true; })
      .catch(function (e) {
        caps.catalog = !e.unknownMethod;
        if (e.unknownMethod) {
          warnHost('电脑端插件是旧版本：选模型 / 选工作区 / 审批 暂时不可用。'
            + '请在电脑上重启一次客户端（托盘图标 → 退出 → 重新打开）后刷新本页。');
        }
      });
  }

  function pair(code) {
    setMsg(pairMsg, '正在连接…');
    return fetch('/api/pair/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code, deviceName: navigator.userAgent.slice(0, 60) }),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || !j.token) throw new Error(j.message || '配对失败');
        token = j.token;
        try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { }
        setMsg(pairMsg, '');
        openStream();
        loadAll();
        probeCapabilities();
        show(listView);
      });
    }).catch(function (e) { setMsg(pairMsg, e.message, 'bad'); });
  }

  /* ── 事件流（SSE） ──────────────────────────────────── */

  function openStream() {
    if (es) { try { es.close(); } catch (e) { } }
    es = new EventSource('/api/events?token=' + encodeURIComponent(token));
    es.addEventListener('session', function (ev) {
      var d = JSON.parse(ev.data);
      if (d.sessionId === current) renderFrame(d.frame);
    });
    es.addEventListener('approval', function (ev) {
      var d = JSON.parse(ev.data);
      if (d.sessionId && current && d.sessionId !== current) {
        addNote('⚠ 另一个会话有审批请求：' + d.toolName, true);
        return;
      }
      showApproval(d);
    });
    es.addEventListener('approval-expired', function () {
      if (activeApproval) { hideApproval(); addNote('审批已超时，交回电脑端处理'); }
    });
    es.addEventListener('error', function (ev) {
      if (ev.data) { try { addNote('⚠ ' + JSON.parse(ev.data).message, true); } catch (e) { } }
    });
    es.onerror = function () { };
  }

  /* ── 列表 ───────────────────────────────────────────── */

  function loadAll() { loadWorkspaces(); return loadList(); }

  function loadWorkspaces() {
    return api('workspace.list').then(function (v) {
      workspaces = (v && v.items) || [];
      caps.workspace = true;
    }).catch(function (e) {
      workspaces = [];
      caps.workspace = !e.unknownMethod;
    });
  }

  function loadList() {
    setMsg(listMsg, '读取中…');
    return api('session.list').then(function (v) {
      sessions = (v && v.items) || [];
      setMsg(listMsg, '');
      renderList();          // ★ 标题就在 sessions 里，直接渲染，不再额外请求
    }).catch(function (e) {
      setMsg(listMsg, e.message, 'bad');
      if (e.unauthorized) logout();
    });
  }

  function workspaceOf(sessionId) {
    for (var i = 0; i < workspaces.length; i++) {
      var w = workspaces[i];
      if (w.sessionIds && w.sessionIds.indexOf(sessionId) >= 0) return w;
    }
    return null;
  }

  function renderList() {
    var q = (searchInput.value || '').trim().toLowerCase();
    sessionList.innerHTML = '';
    var shown = 0;
    sessions.forEach(function (s) {
      var title = titleOf(s);
      var ws = workspaceOf(s.sessionId);
      var wsName = ws ? ws.title : (s.cwd ? baseName(s.cwd) : '');
      var hay = (title + ' ' + wsName + ' ' + (s.cwd || '')).toLowerCase();
      if (q && hay.indexOf(q) < 0) return;
      shown++;

      var row = el('button', 'row' + (s.running ? ' running' : '') + (s.blank && !title ? ' blank' : ''));
      row.appendChild(el('span', 'row-dot'));
      var main = el('div', 'row-main');

      // 有标题用标题；没有才退回路径名 / 会话号（并说明是空会话）
      var displayTitle = title || (s.blank ? '（空会话）' : (wsName || s.sessionId.slice(0, 12)));
      main.appendChild(el('div', 'row-title', displayTitle));

      var meta = el('div', 'row-meta');
      if (wsName && wsName !== displayTitle) meta.appendChild(el('span', 'chip ws', '📁 ' + wsName));
      if (s.running) meta.appendChild(el('span', 'chip run', '● 运行中'));
      if (s.origin === 'subagent') meta.appendChild(el('span', 'chip', '子代理'));
      meta.appendChild(el('span', 'chip time', relTime(s.updatedAt)));
      main.appendChild(meta);

      row.appendChild(main);
      row.onclick = function () { openSession(s.sessionId, title); };
      sessionList.appendChild(row);
    });
    if (!shown) setMsg(listMsg, sessions.length ? '没有匹配的会话' : '还没有会话，点右上角 ＋ 新建');
  }

  /* ── 详情 ───────────────────────────────────────────── */

  function openSession(sessionId, title) {
    current = sessionId;
    currentTitle = title || '';
    streamBuf = ''; streamEl = null; streamReason = ''; reasonEl = null;
    messages.innerHTML = '';
    pendingImages = []; renderAttach();
    hideApproval();
    // ★ 换会话必须把分组状态一起清掉，否则新会话的头几个工具会被并进
    //   上一个会话的组里（那个组已经不在 DOM 上了，等于**凭空消失**）。
    curGroup = null; toolCards = {};
    detailTitle.textContent = currentTitle || sessionId.slice(0, 12);
    var s = sessions.filter(function (x) { return x.sessionId === sessionId; })[0];
    detailSub.textContent = (s && s.cwd) ? s.cwd : '';
    show(detailView);
    api('session.watch', { sessionId: sessionId }).catch(function (e) { addNote('⚠ ' + e.message, true); });
    setTimeout(scrollDown, 60);
  }

  function addNote(text, bad) {
    var n = el('div', 'note' + (bad ? ' bad' : ''), text);
    messages.appendChild(n); scrollDown(); return n;
  }
  function addBubble(role, text) {
    // ★ 出现正文 ⇒ 结束当前工具组（见 toolGroup 的注释：组与"回答段落"对齐）
    endToolGroup();
    var b = el('div', 'bubble ' + (role === 'user' ? 'me' : 'ai'));
    b.textContent = text;
    messages.appendChild(b); scrollDown(); return b;
  }

  function textOfContent(content) {
    if (!Array.isArray(content)) return '';
    return content.map(function (b) {
      if (!b) return '';
      if (b.type === 'text') return b.text || '';
      if (b.type === 'image') return '[图片]';
      if (b.type === 'file') return '[文件]';
      return '';
    }).filter(Boolean).join('\n');
  }
  function reasoningOfContent(content) {
    if (!Array.isArray(content)) return '';
    return content.map(function (b) {
      return (b && b.type === 'reasoning') ? (b.text || '') : '';
    }).filter(Boolean).join('\n');
  }

  function addThink(text) {
    var d = document.createElement('details');
    d.className = 'think';
    var sm = document.createElement('summary');
    // 收起时给出"有多少字"，让人判断值不值得展开（电脑端也是这个思路）
    sm.textContent = text
      ? '思考过程 · ' + text.length + ' 字'
      : '思考过程…';
    d.appendChild(sm);
    d.appendChild(el('div', 'think-body', text || ''));
    // ★ 思考也进同一个组：它与紧随其后的工具调用属于同一段"干活"过程，
    //   分开堆会让条数翻倍（实测 20 个思考块 + 42 个工具卡）。
    toolGroup().appendChild(d);
    if (curGroup) {
      curGroup.thinks++;
      curGroup.n++;
      var bodyEl = d.querySelector('.think-body');
      if (bodyEl && !curGroup.thinkEl) {
        curGroup.thinkEl = { el: d, body: bodyEl };
      }
      refreshGroupTitle();
    }
    return d;
  }

  /* ── 工具调用 / 思考：分组折叠（对齐电脑端的观感）──────────
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么"每张卡各自折叠"还不够（实测数据，不是感觉）
   * ══════════════════════════════════════════════════════════════════
   * 用户原话："手机上这个界面有一点偏大"。我按**真机尺寸**（375×834dp，
   * 取自真机规格书）量了一下，问题不在字号，而在**条数**：
   *
   *     42 个工具卡 + 20 个思考块，即使**全部收起**，也占 2317px
   *     = 消息区可视高的 **323%**（就是 3.2 屏）
   *     ⇒ 一屏只能看到约 6 条消息
   *
   * 也就是说：把每张卡折叠起来只是让它"不再展开"，但**条数**没变 ——
   * 一次带 40 个工具调用的回答，仍然会铺出 40 行。
   *
   * ══════════════════════════════════════════════════════════════════
   * 做法：把**连续**的工具/思考合并成一个组，组本身再折叠
   * ══════════════════════════════════════════════════════════════════
   *   · 组 = `<details class="toolgroup">`，标题写「工具调用 ×12 · 思考 ×3」，
   *     **默认收起**，整组只占一行（约 34px）—— 40 行塌成 1 行；
   *   · 展开后里面还是原来的逐张卡（每张自己也还能再展开看参数/结果）；
   *   · 一旦出现**正文**（助手回复 / 用户消息 / 提示），就结束当前组；
   *     后面再有工具调用就另起一组 ⇒ 组与"回答的段落"天然对齐，
   *     不会把整场会话的工具堆成一个巨大的组。
   *   · 组标题里带**运行中**标记：收起状态下也能看出"现在还在干活"。
   */
  var toolCards = {};        // callId -> { el, name, state }
  var curGroup = null;       // 当前正在累积的组（遇到正文就置 null）

  function toolIconSvg() {
    // 扳手：与顶栏图标同一套线性风格（不依赖系统 emoji 字体）
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'icon-svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M14.7 6.3a4.6 4.6 0 0 0 6 6l-8.4 8.4a2.6 2.6 0 0 1-3.7-3.7z');
    svg.appendChild(p);
    var p2 = document.createElementNS(NS, 'path');
    p2.setAttribute('d', 'M14.7 6.3l3-3');
    svg.appendChild(p2);
    return svg;
  }

  /** 取当前组；没有就新建一个（并追加到消息流）。 */
  function toolGroup() {
    if (curGroup) return curGroup.body;
    var g = document.createElement('details');
    g.className = 'toolgroup';
    var sm = document.createElement('summary');
    var ic = el('span', 'tool-icon'); ic.appendChild(toolIconSvg());
    sm.appendChild(ic);
    var title = el('span', 'toolgroup-title', '工具调用');
    sm.appendChild(title);
    var running = el('span', 'toolgroup-running', '');
    sm.appendChild(running);
    g.appendChild(sm);
    var body = el('div', 'toolgroup-body');
    g.appendChild(body);
    messages.appendChild(g);
    curGroup = { el: g, body: body, title: title, running: running, tools: 0, thinks: 0, n: 0 };
    return body;
  }

  /** 组的标题随内容更新（收起时也能看出这组里发生了什么、是不是还在跑）。 */
  function refreshGroupTitle() {
    if (!curGroup) return;
    var parts = [];
    if (curGroup.tools) parts.push('工具调用 ×' + curGroup.tools);
    if (curGroup.thinks) parts.push('思考 ×' + curGroup.thinks);
    curGroup.title.textContent = parts.length ? parts.join(' · ') : '工具调用';
  }

  /** 结束当前组：出现正文时调用，让之后的工具另起一组。 */
  function endToolGroup() {
    if (!curGroup) return;
    curGroup.running.textContent = '';
    curGroup.running.className = 'toolgroup-running';
    curGroup = null;
  }

  function addTool(callId, name, args) {
    var d = document.createElement('details');
    d.className = 'tool';
    var sm = document.createElement('summary');
    var ic = el('span', 'tool-icon'); ic.appendChild(toolIconSvg());
    sm.appendChild(ic);
    sm.appendChild(el('span', 'tool-name', name || '工具'));
    var state = el('span', 'tool-state running', '运行中…');
    sm.appendChild(state);
    d.appendChild(sm);

    if (args) {
      var part = el('div', 'tool-part');
      part.appendChild(el('div', 'lbl', '参数'));
      var pre = el('pre', 'tool-pre', String(args).slice(0, 2000));
      part.appendChild(pre);
      d.appendChild(part);
    }
    toolGroup().appendChild(d);
    if (curGroup) {
      curGroup.tools++;
      curGroup.n++;
      curGroup.running.textContent = '运行中…';
      curGroup.running.className = 'toolgroup-running on';
      refreshGroupTitle();
    }
    scrollDown();
    var rec = { el: d, name: name, state: state };
    if (callId) toolCards[callId] = rec;
    return rec;
  }

  /** 把结果并进对应的那张卡；找不到就新建一张（事件可能从快照中间开始）。 */
  function attachToolResult(callId, text, isError) {
    var rec = (callId && toolCards[callId]) || null;
    if (!rec) {
      var cards = messages.querySelectorAll('details.tool');
      var last = cards[cards.length - 1];
      if (last && last.querySelector('.tool-state.running')) {
        rec = { el: last, state: last.querySelector('.tool-state') };
      }
    }
    if (!rec) { addNote(text.slice(0, 800), isError); return; }

    var part = el('div', 'tool-part' + (isError ? ' err' : ''));
    part.appendChild(el('div', 'lbl', isError ? '结果（出错）' : '结果'));
    part.appendChild(el('pre', 'tool-pre', text.slice(0, 4000)));
    rec.el.appendChild(part);

    if (rec.state) {
      rec.state.className = 'tool-state' + (isError ? '' : '');
      rec.state.textContent = isError ? '出错' : '完成';
      if (isError) rec.state.style.color = 'var(--danger)';
    }
    rec.el.dataset.done = '1';
    if (callId) delete toolCards[callId];
    scrollDown();
  }

  function renderAssistantText(text) {
    var parts = String(text).split(/```/);
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (!seg) continue;
      if (i % 2 === 1) {
        var nl = seg.indexOf('\n');
        var lang = '', code = seg;
        if (nl >= 0) { lang = seg.slice(0, nl).trim(); code = seg.slice(nl + 1); }
        var pre = el('pre', 'code');
        if (lang && lang.length < 20) pre.setAttribute('data-lang', lang);
        pre.textContent = code.replace(/\s+$/, '');
        messages.appendChild(pre);
      } else {
        var t = seg.replace(/^\n+|\n+$/g, '');
        if (t) addBubble('assistant', t);
      }
    }
    scrollDown();
  }

  function renderEvent(event) {
    if (!event || !event.type) return;
    var d = event.data || {};

    if (event.type === 'user/message') {
      if (d.source && d.source.kind === 'user') {
        var t = textOfContent(d.content);
        if (t.trim()) addBubble('user', t);
      }
      return;
    }
    if (event.type === 'assistant/message') {
      var msg = d.message || {};
      var think = reasoningOfContent(msg.content);
      if (think.trim() && !reasonEl) addThink(think);
      var txt = textOfContent(msg.content);
      if (txt.trim() && txt !== streamBuf) {
        if (streamEl) { streamEl.remove(); streamEl = null; }
        renderAssistantText(txt);
      }
      streamBuf = ''; streamEl = null; streamReason = ''; reasonEl = null;
      return;
    }
    if (event.type === 'tool/call') {
      // callId 用于把随后的 tool/result 配回同一张卡（不同内核版本字段名不同，都兜一下）
      var cid = d.callId || d.toolCallId || d.id || null;
      addTool(cid, d.name, d.arguments);
      return;
    }
    if (event.type === 'tool/result') {
      var m = d.message || {};
      // 结果里对回调用的 id：优先顶层，其次消息体里
      var rid = d.callId || d.toolCallId || d.id || m.callId || m.toolCallId || null;
      var txt = textOfContent(m.content) || d.content || '';
      var isErr = d.isError === true || d.error != null || m.isError === true;
      if (typeof txt !== 'string') txt = String(txt || '');
      if (txt.trim()) attachToolResult(rid, txt, isErr);
      else if (isErr) attachToolResult(rid, '（工具报错，无输出）', true);
      return;
    }
  }

  function renderFrame(frame) {
    if (!frame) return;
    if (frame.type === 'snapshot') {
      (frame.records || []).forEach(function (r) { if (r.type === 'event') renderEvent(r.event); });
      scrollDown(); return;
    }
    if (frame.type === 'event') { renderEvent(frame.event); return; }
    if (frame.type === 'assistant-stream') {
      var f = frame.frame || {};
      if (f.type === 'chunk' && f.chunk) {
        if (f.chunk.type === 'text-delta') {
          if (!streamEl) streamEl = addBubble('assistant', '');
          streamBuf += f.chunk.text || '';
          streamEl.textContent = streamBuf;
          scrollDown();
        } else if (f.chunk.type === 'reasoning-delta') {
          streamReason += f.chunk.text || '';
          if (!reasonEl) reasonEl = addThink('');
          if (reasonEl) {
            var body = reasonEl.querySelector('.think-body');
            if (body) body.textContent = streamReason;
          }
        }
      } else if (f.type === 'end') {
        if (streamEl && streamBuf) { streamEl.remove(); renderAssistantText(streamBuf); }
        streamEl = null; streamBuf = ''; reasonEl = null; streamReason = '';
      }
    }
  }

  /* ── 抽屉 ───────────────────────────────────────────── */

  function openSheet(title, build) {
    sheetTitle.textContent = title;
    sheetBody.innerHTML = '';
    build(sheetBody);
    sheet.classList.remove('hidden');
  }
  function closeSheet() { sheet.classList.add('hidden'); }
  sheet.addEventListener('click', function (e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute('data-close')) closeSheet();
  });

  /** 宿主不支持某功能时的统一提示（**不静默**）。 */
  function unsupportedBox(body, what) {
    body.appendChild(el('div', 'warnbox',
      '电脑端插件是旧版本，' + what + '暂时不可用。\n请在电脑上重启一次客户端（托盘图标 → 退出 → 重新打开），然后刷新本页。'));
  }

  function openModelSheet() {
    if (!current) return;
    openSheet('切换模型', function (body) {
      body.appendChild(el('div', 'empty', '正在读取模型目录…'));
      api('modelCatalog').then(function (cat) {
        caps.catalog = true;
        body.innerHTML = '';
        var groups = (cat && cat.groups) || [];
        if (!groups.length) { body.appendChild(el('div', 'empty', '没有可用模型')); return; }
        groups.forEach(function (g) {
          body.appendChild(el('div', 'sec', g.name || g.id));
          (g.models || []).forEach(function (m) {
            var b = el('button', 'btn block', m.name || m.id);
            b.onclick = function () {
              var efforts = (m.reasoning && m.reasoning.efforts) || [];
              if (efforts.length) openEffortSheet(g, m, efforts);
              else doSelectModel(g.id, m.id, null);
            };
            body.appendChild(b);
          });
        });
      }).catch(function (e) {
        body.innerHTML = '';
        if (e.unknownMethod) { caps.catalog = false; unsupportedBox(body, '选模型'); }
        else body.appendChild(el('div', 'empty', '读取失败：' + e.message));
      });
    });
  }

  function openEffortSheet(group, model, efforts) {
    openSheet('思考强度 · ' + (model.name || model.id), function (body) {
      body.appendChild(el('div', 'sec', group.name || group.id));
      var def = (model.reasoning && model.reasoning.defaultEffort) || null;
      var b0 = el('button', 'btn block' + (!def ? ' on' : ''), '默认');
      b0.onclick = function () { doSelectModel(group.id, model.id, null); };
      body.appendChild(b0);
      efforts.forEach(function (ef) {
        var b = el('button', 'btn block' + (def === ef.id ? ' on' : ''), ef.name || ef.id);
        b.onclick = function () { doSelectModel(group.id, model.id, ef.id); };
        body.appendChild(b);
      });
    });
  }

  function doSelectModel(provider, model, effort) {
    var p = { sessionId: current, provider: provider, model: model };
    if (effort) p.reasoningEffort = effort;
    api('session.selectModel', p).then(function (r) {
      closeSheet();
      var sel = (r && r.selected) || {};
      addNote('已切换模型：' + (sel.model || model) + (sel.reasoningEffort ? ' · ' + sel.reasoningEffort : ''));
    }).catch(function (e) {
      closeSheet();
      addNote('⚠ 切换失败：' + e.message, true);
    });
  }

  function openNewSessionSheet() {
    openSheet('新建会话', function (body) {
      if (caps.workspace === false) {
        unsupportedBox(body, '选工作区');
      } else if (!workspaces.length) {
        body.appendChild(el('div', 'empty', '没有已注册的工作区；可直接新建一个不绑定的会话'));
      }
      workspaces.forEach(function (w) {
        var b = el('button', 'btn block', '📁 ' + (w.title || w.path));
        b.onclick = function () {
          closeSheet();
          api('session.create', { workspaceId: w.workspaceId }).then(function (r) {
            var sid = r && r.sessionId;
            if (sid) { loadList().then(function () { openSession(sid, ''); }); }
          }).catch(function (e) { setMsg(listMsg, '新建失败：' + e.message, 'bad'); });
        };
        body.appendChild(b);
      });
      var b2 = el('button', 'btn block', '＋ 不绑定工作区');
      b2.onclick = function () {
        closeSheet();
        api('session.create', {}).then(function (r) {
          var sid = r && r.sessionId;
          if (sid) { loadList().then(function () { openSession(sid, ''); }); }
        }).catch(function (e) { setMsg(listMsg, '新建失败：' + e.message, 'bad'); });
      };
      body.appendChild(b2);
    });
  }

  function getHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (e) { return []; }
  }
  function pushHistory(text) {
    try {
      var h = getHistory().filter(function (x) { return x !== text; });
      h.unshift(text);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 30)));
    } catch (e) { }
  }
  function openHistorySheet() {
    openSheet('历史输入', function (body) {
      var h = getHistory();
      if (!h.length) { body.appendChild(el('div', 'empty', '还没有历史输入')); return; }
      h.forEach(function (t) {
        var b = el('button', 'btn block', t.length > 70 ? t.slice(0, 70) + '…' : t);
        b.onclick = function () {
          promptInput.value = t; promptInput.focus(); autoGrow(); closeSheet();
        };
        body.appendChild(b);
      });
      var c = el('button', 'btn block', '🗑 清空历史');
      c.onclick = function () { try { localStorage.removeItem(HISTORY_KEY); } catch (e) { } closeSheet(); };
      body.appendChild(c);
    });
  }

  function openMenuSheet() {
    openSheet('更多', function (body) {
      var a = el('button', 'btn block', '⟳ 刷新会话列表');
      a.onclick = function () { closeSheet(); loadAll(); };
      body.appendChild(a);
      var b = el('button', 'btn block', '🔓 断开并重新配对');
      b.onclick = function () { closeSheet(); logout(); };
      body.appendChild(b);
      body.appendChild(el('div', 'sec', '诊断'));
      body.appendChild(el('div', 'empty',
        '选模型：' + (caps.catalog === null ? '未探测' : (caps.catalog ? '可用' : '不可用（宿主过旧）'))
        + '　选工作区：' + (caps.workspace === null ? '未探测' : (caps.workspace ? '可用' : '不可用（宿主过旧）'))));
    });
  }

  /* ── 审批 ───────────────────────────────────────────── */

  function showApproval(d) {
    activeApproval = d;
    approvalTool.textContent = '需要批准：' + (d.toolName || '工具');
    approvalReason.textContent = d.reason || '';
    approvalBar.classList.remove('hidden');
  }
  function hideApproval() { activeApproval = null; approvalBar.classList.add('hidden'); }
  function answerApproval(approve) {
    if (!activeApproval) return;
    var id = activeApproval.id, name = activeApproval.toolName;
    api('approval.answer', { id: id, approve: approve }).then(function () {
      addNote(approve ? '✅ 已允许 ' + name : '⛔ 已拒绝 ' + name);
      hideApproval();
    }).catch(function (e) { addNote('⚠ ' + e.message, true); hideApproval(); });
  }

  /* ── 图片 ───────────────────────────────────────────── */

  function renderAttach() {
    attachBar.innerHTML = '';
    if (!pendingImages.length) { attachBar.classList.add('hidden'); return; }
    attachBar.classList.remove('hidden');
    pendingImages.forEach(function (img, i) {
      var w = el('div', 'thumb');
      var im = document.createElement('img');
      im.src = img.url; w.appendChild(im);
      var rm = el('button', 'rm', '✕');
      rm.onclick = function () { pendingImages.splice(i, 1); renderAttach(); };
      w.appendChild(rm);
      attachBar.appendChild(w);
    });
  }

  fileInput.onchange = function () {
    var files = Array.prototype.slice.call(fileInput.files || []);
    files.slice(0, Math.max(0, 6 - pendingImages.length)).forEach(function (f) {
      if (!/^image\//.test(f.type)) return;
      var reader = new FileReader();
      reader.onload = function () {
        var url = String(reader.result);
        var comma = url.indexOf(',');
        pendingImages.push({
          mediaType: f.type, data: url.slice(comma + 1), name: f.name, url: url,
        });
        renderAttach();
      };
      reader.readAsDataURL(f);
    });
    fileInput.value = '';
  };

  /* ── 发送 ───────────────────────────────────────────── */

  function autoGrow() {
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(promptInput.scrollHeight, 132) + 'px';
  }

  promptForm.onsubmit = function (e) {
    e.preventDefault();
    var text = promptInput.value;
    if (!current) return;
    if (!text.trim() && !pendingImages.length) return;

    sendBtn.disabled = true;
    addBubble('user', text.trim() || ('（' + pendingImages.length + ' 张图片）'));
    if (text.trim()) pushHistory(text.trim());

    var payload = { sessionId: current, text: text };
    if (pendingImages.length) {
      payload.images = pendingImages.map(function (i) {
        return { mediaType: i.mediaType, data: i.data, name: i.name };
      });
    }
    promptInput.value = ''; autoGrow();
    pendingImages = []; renderAttach();

    api('session.prompt', payload)
      .catch(function (err) { addNote('⚠ 发送失败：' + err.message, true); })
      .then(function () { sendBtn.disabled = false; });
  };

  promptInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      promptForm.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });
  promptInput.addEventListener('input', autoGrow);

  /* ── 绑定 ───────────────────────────────────────────── */

  pairForm.onsubmit = function (e) {
    e.preventDefault();
    var code = codeInput.value.trim().toUpperCase();
    if (code.length < 4) { setMsg(pairMsg, '配对码不对', 'bad'); return; }
    pair(code);
  };

  $('refreshBtn').onclick = function () { loadAll(); };
  $('newSessionBtn').onclick = openNewSessionSheet;
  $('menuBtn').onclick = openMenuSheet;
  $('modelBtn').onclick = openModelSheet;
  $('historyBtn').onclick = openHistorySheet;
  $('imageBtn').onclick = function () { fileInput.click(); };
  $('approveBtn').onclick = function () { answerApproval(true); };
  $('rejectBtn').onclick = function () { answerApproval(false); };
  searchInput.addEventListener('input', renderList);

  $('cancelBtn').onclick = function () {
    if (!current) return;
    api('session.cancel', { sessionId: current })
      .then(function () { addNote('已请求中断'); })
      .catch(function (e) { addNote('⚠ 中断失败：' + e.message, true); });
  };
  $('backBtn').onclick = function () {
    if (current) api('session.unwatch', {}).catch(function () { });
    current = null;
    show(listView);
    loadList();
  };

  function logout() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { }
    if (es) { try { es.close(); } catch (e) { } es = null; }
    token = null; current = null; sessions = [];
    setMsg(pairMsg, '已断开，请重新扫码');
    show(pairView);
  }

  /* ── 启动 ───────────────────────────────────────────── */

  installViewportSync();   // ★ 键盘视口兜底：必须在渲染之前装好，见 syncViewport()

  var fromUrl = new URLSearchParams(location.search).get('c');
  if (fromUrl) {
    codeInput.value = fromUrl.trim().toUpperCase();
    pair(codeInput.value);
  } else {
    try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { }
    if (token) {
      openStream(); loadAll(); probeCapabilities(); show(listView);
    }
  }
})();
