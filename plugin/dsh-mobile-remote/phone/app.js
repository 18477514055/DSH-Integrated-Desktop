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
  var detailModel = $('detailModel');
  var approvalBar = $('approvalBar'), approvalTool = $('approvalTool'), approvalReason = $('approvalReason');
  var attachBar = $('attachBar'), fileInput = $('fileInput');
  var uploadInput = $('uploadInput');
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
  function fmtBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
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

  /* ── 401 自动静默重配对（2026-09-22 用户需求："连接过之后不要再断掉"）──
   *
   * 场景：电脑端插件升级 / 设备台账被清（换机器、点了"断开全部手机"）后，
   * 手机 localStorage 里的旧 token 在服务端已不存在 ⇒ 所有请求 401 ⇒
   * 旧版直接 logout() 回到配对页，用户只能拿手机去重新扫码 —— 烦。
   *
   * 修法分两层（都不需要用户动手）：
   * ① **地址里有现成配对码时**（/pair?c=XXXX 链接、App 二维码带的 u 参数）：
   *    拿那个码静默重新配对一次（一次性码本来就是给这一刻用的）。
   *    App 场景尤其顺：App 记住的 URL 含 ?c=，重进 App 即自动恢复。
   * ② **没有现成码时**：回配对页但**保留提示**"在电脑上点换一张码后输入 8 位码"
   *    —— 手输 8 位码比拿相机扫码快得多（不用离开手机）。
   *
   * 安全边界：自动重配对用的也是**一次性码**，且只在 401（服务端明确拒绝）
   * 时尝试一次，不存在"拿旧 token 续命"的通道。 */
  var pairCodeFromUrl = new URLSearchParams(location.search).get('c');

  function autoRepair() {
    if (pairCodeFromUrl) {
      var c = pairCodeFromUrl;
      pairCodeFromUrl = null;         // 只试一次：码是一次性的，失败别死循环
      pair(c);
      return true;
    }
    return false;
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
      if (e.unauthorized) { if (!autoRepair()) logout(); }   // ★ 有现成码先静默重配对
    });
  }

  function workspaceOf(sessionId) {
    for (var i = 0; i < workspaces.length; i++) {
      var w = workspaces[i];
      if (w.sessionIds && w.sessionIds.indexOf(sessionId) >= 0) return w;
    }
    return null;
  }

  /* ── 会话列表：按工作区分组 + 折叠 + 过滤子代理 ──────────────
   * 2026-09-22 用户三条要求（都在这一段）：
   *   ①「所有的对话按照工作区分成几类，现在这样子看着太乱了，并且可以折叠。」
   *   ②「子代理引起的那些对话，基本没有必要展示出来，只展示主模型对话。」
   *
   * ★ 怎么判断"是不是子代理"：`session.list` 的条目里**本来就有** `origin` 字段
   *   （旧代码第 344 行已经在用 `s.origin === 'subagent'` 打标签了），
   *   所以这里直接按它过滤 —— 不猜、不额外请求。
   *
   * ★ 折叠状态存 localStorage：按工作区标题记，刷新/重进保持用户的展开习惯。
   *   默认**全部收起**（列表一眼看清有几个工作区、各自多少会话），
   *   但"正在运行"的工作区默认展开 —— 那是最可能需要点进去的。 */
  var COLLAPSE_KEY = 'dsh-mmr-collapsed';
  var collapsedWs = {};
  try { collapsedWs = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {}; } catch (e) { collapsedWs = {}; }
  function saveCollapsed() {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsedWs)); } catch (e) { }
  }

  /** 子代理会话是否显示（默认隐藏）。存 localStorage。 */
  var SHOW_SUB_KEY = 'dsh-mmr-show-sub';
  var showSubagents = false;
  try { showSubagents = localStorage.getItem(SHOW_SUB_KEY) === '1'; } catch (e) { }

  function renderList() {
    var q = (searchInput.value || '').trim().toLowerCase();
    sessionList.innerHTML = '';
    var shown = 0, hiddenSub = 0;

    // 先分组：key = 工作区标题（没有工作区的按 cwd 末段，再没有就归"未绑定工作区"）
    var groups = [], byKey = {};
    sessions.forEach(function (s) {
      var title = titleOf(s);
      var ws = workspaceOf(s.sessionId);
      var wsName = ws ? ws.title : (s.cwd ? baseName(s.cwd) : '');
      var isSub = s.origin === 'subagent';
      var hay = (title + ' ' + wsName + ' ' + (s.cwd || '')).toLowerCase();
      if (q && hay.indexOf(q) < 0) return;
      if (isSub && !showSubagents && !q) { hiddenSub++; return; }   // ★ 搜索时不过滤，否则"搜不到"很费解
      var key = wsName || '（未绑定工作区）';
      if (!byKey[key]) { byKey[key] = { name: key, items: [], running: 0 }; groups.push(byKey[key]); }
      byKey[key].items.push({ s: s, title: title, wsName: wsName });
      if (s.running) byKey[key].running++;
    });

    // 组内按更新时间倒序（最近的在上面）
    groups.forEach(function (g) {
      g.items.sort(function (a, b) { return (b.s.updatedAt || 0) - (a.s.updatedAt || 0); });
    });
    // 组间：有运行中的排前面，然后按该组最新更新时间
    groups.sort(function (a, b) {
      if ((b.running > 0) !== (a.running > 0)) return (b.running > 0 ? 1 : -1);
      var ta = a.items[0] ? (a.items[0].s.updatedAt || 0) : 0;
      var tb = b.items[0] ? (b.items[0].s.updatedAt || 0) : 0;
      return tb - ta;
    });

    groups.forEach(function (g) {
      // 折叠状态：显式记过就用记的，否则默认收起（运行中的默认展开）
      var isCollapsed = (g.name in collapsedWs) ? collapsedWs[g.name] : !(g.running > 0);

      var head = el('button', 'wsgroup-head');
      head.appendChild(el('span', 'wsgroup-caret', isCollapsed ? '▸' : '▾'));
      head.appendChild(el('span', 'wsgroup-name', g.name));
      head.appendChild(el('span', 'wsgroup-count', String(g.items.length)));
      if (g.running) head.appendChild(el('span', 'chip run', '● ' + g.running));
      head.onclick = function () {
        collapsedWs[g.name] = !isCollapsed;
        saveCollapsed();
        renderList();
      };
      sessionList.appendChild(head);

      if (isCollapsed) return;
      g.items.forEach(function (it) {
        shown++;
        var s = it.s;
        var row = el('button', 'row' + (s.running ? ' running' : '') + (s.blank && !it.title ? ' blank' : ''));
        row.appendChild(el('span', 'row-dot'));
        var main = el('div', 'row-main');
        var displayTitle = it.title || (s.blank ? '（空会话）' : (it.wsName || s.sessionId.slice(0, 12)));
        main.appendChild(el('div', 'row-title', displayTitle));

        var meta = el('div', 'row-meta');
        if (s.running) meta.appendChild(el('span', 'chip run', '● 运行中'));
        if (s.origin === 'subagent') meta.appendChild(el('span', 'chip sub', '子代理'));
        meta.appendChild(el('span', 'chip time', relTime(s.updatedAt)));
        main.appendChild(meta);

        row.appendChild(main);
        row.onclick = function () { openSession(s.sessionId, it.title); };
        sessionList.appendChild(row);
      });
    });

    if (!shown) {
      if (q) setMsg(listMsg, '没有匹配的会话');
      else if (hiddenSub) setMsg(listMsg, '只有子代理会话（默认隐藏，可在「更多」里打开）');
      else setMsg(listMsg, '还没有会话，点右上角 ＋ 新建');
    } else {
      setMsg(listMsg, hiddenSub ? ('已隐藏 ' + hiddenSub + ' 个子代理会话') : '');
    }
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
    detailModel.textContent = '';
    loadModelLine();     // ★ 当前模型与推理强度（异步填，不挡开页面）
    show(detailView);
    api('session.watch', { sessionId: sessionId }).catch(function (e) { addNote('⚠ ' + e.message, true); });
    setTimeout(scrollDown, 60);
  }

  /* ── 当前模型 / 推理强度（2026-09-22 用户需求）──────────────
   * 显示规则（宿主已经把两个字段都给了，这里只做取舍）：
   *   · 有 next（刚切过、还没生效）⇒ 显示 next，并标"下一条生效"
   *   · 否则显示 lastUsed（真正在用）
   *   · 都没有 ⇒ 显示"未选模型"（新会话可能还没发过消息）
   * 点这一行 = 打开模型抽屉（比让用户找按钮快）。 */
  function loadModelLine() {
    if (!current) return;
    api('session.model', { sessionId: current }).then(function (r) {
      if (!r || !r.effective) {
        detailModel.textContent = '未选模型';
        detailModel.className = 'model-line dim';
        return;
      }
      var m = r.effective;
      var txt = (m.model || m.provider || '未知');
      if (m.reasoningEffort) txt += ' · ' + m.reasoningEffort;
      if (r.pending) txt += '（下一条生效）';
      detailModel.textContent = txt;
      detailModel.className = 'model-line' + (r.pending ? ' pending' : '');
      detailModel.title = m.provider + ' / ' + m.model;
    }).catch(function () {
      detailModel.textContent = '';
      detailModel.className = 'model-line dim';
    });
  }
  detailModel.onclick = function () { openModelSheet(); };

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

  /* ── Markdown → 纯文本（2026-09-22 用户需求）──────────────────
   * 用户原话：「手机上同步到的对话全都是 Markdown 文档，我希望它变成纯文本形式。」
   * 也就是说：**要的是内容，不是标记语法**。`**粗体**`、`## 标题`、`| 表格 |`、
   * `[文字](链接)` 这些符号在窄屏上既占宽度又难读。
   *
   * ★ 为什么自己写而不是引 markdown 库：本插件零依赖（手机页就三个文件、
   *   由宿主现读现发）。而这里**不需要解析器** —— 只需要"把标记去掉"，
   *   正则足够，且不会因为语法边界把正文吃掉（下面每条的取舍都写清了）。
   *
   * ★ 哪些**故意保留**：
   *   · 代码块（``` 围栏）仍然渲染成等宽块 —— 那是内容不是标记，
   *     而且代码必须等宽才看得懂（见 renderAssistantText 的分段逻辑）。
   *   · 列表符号转成 `•`（保留"这是一条列表"的信息，只去掉 markdown 的符号）。
   *   · 表格转成 `a  ·  b  ·  c`（保留分列语义，去掉竖线噪音）。 */
  function plainify(md) {
    var t = String(md == null ? '' : md);
    t = t.replace(/```[^\n]*\n?/g, '');                     // 残留围栏
    t = t.replace(/`([^`]+)`/g, '$1');                       // 行内代码
    t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, function (_, a) {  // 图片
      return a ? '[图片：' + a + ']' : '[图片]';
    });
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, txt, url) {  // 链接
      return txt === url ? url : txt + '（' + url + '）';
    });
    t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
    t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2');
    t = t.replace(/__([^_]+)__/g, '$1');
    t = t.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1$2');
    t = t.replace(/~~([^~]+)~~/g, '$1');
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');                // 标题
    t = t.replace(/^\s{0,3}>\s?/gm, '');                     // 引用
    t = t.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, '————');    // 分隔线
    t = t.replace(/^(\s*)[-*+]\s+/gm, '$1• ');               // 无序列表
    t = t.replace(/^\s*\|?[\s:|-]{3,}\|[\s:|-]*$/gm, '');    // 表格分隔行
    t = t.replace(/^\s*\|(.+)\|\s*$/gm, function (_, row) {  // 表格行 → · 分隔
      /* ★ 必须自己补一个换行：这条正则匹配的是"整行"，替换结果不带 \n，
       *   而 `.` 不跨行 ⇒ 相邻两行的替换结果会**首尾粘在一起**
       *   （实测："| 名称 | 值 |\n| a | 1 |" 变成 "名称 · 值a · 1"）。
       *   探针脚本 runtime/plainify-probe.cjs 抓到的就是这个。 */
      return row.split('|').map(function (c) { return c.trim(); })
        .filter(Boolean).join('  ·  ') + '\n';
    });
    t = t.replace(/<\/?[a-zA-Z][^>]*>/g, '');                // 残留 HTML
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.replace(/^\n+|\n+$/g, '');
  }

  /** 显示开关：纯文本（默认）/ 原始 Markdown。存 localStorage，刷新后保持。 */
  var PLAIN_KEY = 'dsh-mmr-plain';
  var plainMode = true;
  try { plainMode = localStorage.getItem(PLAIN_KEY) !== '0'; } catch (e) { }

  function renderAssistantText(text) {
    var parts = String(text).split(/```/);
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (!seg) continue;
      if (i % 2 === 1) {
        // 代码块：保留等宽渲染（内容不是标记），但去掉语言标签那行
        var nl = seg.indexOf('\n');
        var lang = '', code = seg;
        if (nl >= 0) { lang = seg.slice(0, nl).trim(); code = seg.slice(nl + 1); }
        var pre = el('pre', 'code');
        if (!plainMode && lang && lang.length < 20) pre.setAttribute('data-lang', lang);
        pre.textContent = code.replace(/\s+$/, '');
        messages.appendChild(pre);
      } else {
        var t = seg.replace(/^\n+|\n+$/g, '');
        if (!t) continue;
        if (plainMode) t = plainify(t);
        if (t) addBubble('assistant', t);
      }
    }
    scrollDown();
  }

  /* ── 发出去的消息"显示两条一模一样的"——去重 ─────────────
   *
   * 真因（用户 2026-09-22 报告，怀疑得对）：
   *   手机上发送时，本地**立即** addBubble('user', ...)（乐观回显，保证"点了就有反应"）；
   *   同一条消息随后经 SSE 的 user/message 事件（或重连时的 snapshot 快照）再次到达，
   *   又画一条 ⇒ 两条一模一样。电脑端发的消息只走事件流，所以**只有手机自己发的**会双份。
   *
   * 修法：发送时把文本与时间戳记进 lastSent；事件流再推同文时，若落在时间窗内则跳过。
   *   · 窗口 15 秒：覆盖正常回显（毫秒级）与断线重连后的 snapshot 补发（秒级）；
   *   · 只匹配**完全相同**的文本 ⇒ 电脑端发同样内容（同文不同源）在窗口内也会被
     ·   正确合并，这在"手机发了、电脑再发一句一样的"这种罕见场景下是可接受的取舍；
   *   · 窗口过后同文不再拦（防错杀：用户故意重发同样的内容应正常显示）。 */
  var lastSent = { text: '', at: 0 };
  var SENT_WINDOW_MS = 15000;

  function markSent(text) {
    lastSent.text = text;
    lastSent.at = Date.now();
  }
  /** 事件流推来的用户消息是否是"刚从本机发出去的那条"（是则跳过不画）。 */
  function isEchoOfSent(text) {
    var fresh = (Date.now() - lastSent.at) < SENT_WINDOW_MS;
    return fresh && lastSent.text && text && text === lastSent.text;
  }

  function renderEvent(event) {
    if (!event || !event.type) return;
    var d = event.data || {};

    if (event.type === 'user/message') {
      if (d.source && d.source.kind === 'user') {
        var t = textOfContent(d.content);
        if (t.trim() && !isEchoOfSent(t.trim())) addBubble('user', t);
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
    /* ★ 用 closest 而不是 e.target：✕ 按钮里是 <svg><path>，手指点下去
     *   e.target 是 path（它没有 data-close）⇒ 旧写法点叉叉毫无反应、
     *   只有蒙层能关（蒙层没有子元素，target 就是它自己）。
     *   closest 沿祖先链找最近一个带 data-close 的元素，按钮整体热区生效。
     *   这是与 §3 AGENTS.md「事件拦截挂根节点+冒泡」同源的坑：
     *   委托判据必须落在"语义元素"上，不能落在"物理命中节点"上。 */
    var hit = e.target && e.target.closest ? e.target.closest('[data-close]') : null;
    if (hit) closeSheet();
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

        /* ★ 搜索 + 平台筛选（对齐电脑端，2026-09-22 用户要求）：
         *   「在选择模型那里加一个搜索框，然后一个按标签（各大平台）筛选。」
         *   groups 里每组的 name/id 就是平台名（DeepSeek / 智谱 / OpenRouter…），
         *   正好当标签用；选中哪个平台就只显示哪一组的模型，「全部」恢复。 */
        var activeTag = '';            // '' = 全部
        var q = '';

        var bar = el('div', 'model-filter');
        var si = el('input', 'search model-search');
        si.type = 'search'; si.placeholder = '搜模型名…';
        si.autocomplete = 'off';
        bar.appendChild(si);
        var tags = el('div', 'model-tags');
        bar.appendChild(tags);
        body.appendChild(bar);

        var listBox = el('div', 'model-list');
        body.appendChild(listBox);

        function tagLabel(g) { return g.name || g.id; }
        function match(m) {
          if (!q) return true;
          return ((m.name || '') + ' ' + (m.id || '')).toLowerCase().indexOf(q) >= 0;
        }

        function renderTags() {
          tags.innerHTML = '';
          var all = el('button', 'tag' + (activeTag === '' ? ' on' : ''), '全部');
          all.onclick = function () { activeTag = ''; renderTags(); renderModels(); };
          tags.appendChild(all);
          groups.forEach(function (g) {
            var t = el('button', 'tag' + (activeTag === tagLabel(g) ? ' on' : ''), tagLabel(g));
            t.onclick = function () { activeTag = (activeTag === tagLabel(g)) ? '' : tagLabel(g); renderTags(); renderModels(); };
            tags.appendChild(t);
          });
        }

        function renderModels() {
          listBox.innerHTML = '';
          var shown = 0;
          groups.forEach(function (g) {
            if (activeTag && tagLabel(g) !== activeTag) return;
            var models = (g.models || []).filter(match);
            if (!models.length) return;
            shown += models.length;
            listBox.appendChild(el('div', 'sec', tagLabel(g)));
            models.forEach(function (m) {
              var b = el('button', 'btn block', m.name || m.id);
              b.onclick = function () {
                var efforts = (m.reasoning && m.reasoning.efforts) || [];
                if (efforts.length) openEffortSheet(g, m, efforts);
                else doSelectModel(g.id, m.id, null);
              };
              listBox.appendChild(b);
            });
          });
          if (!shown) listBox.appendChild(el('div', 'empty', q ? '没有匹配的模型' : '这个平台下没有模型'));
        }

        si.addEventListener('input', function () { q = (si.value || '').trim().toLowerCase(); renderModels(); });
        renderTags();
        renderModels();
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
      loadModelLine();     // ★ 顶栏那行"当前模型"跟着更新（否则要退出重进才变）
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
  /* 「＋」动作列表：输入区的所有附加功能集中在这一个抽屉里。
   * 用户原话：「以后所有的功能全部集中在一个列表中，而不是分成什么图片啊、
   *   历史输入啊，两个按键……输入框的位置也宽一点。」
   * 以后加新能力 = 往下面 ACTIONS 里加一条，**不再动输入区布局**。
   *
   * 2026-09-22 新增四类（用户要求）：
   *   · 权限选择   —— 走官方 permissionPresets（沙箱模式+审批策略的预设）
   *   · 文件选择   —— 走官方 fileReferences（电脑上的文件/目录）
   *   · 指令选择   —— 走官方 commands（斜杠命令目录）
   *   · 上下文容量 —— 走官方 contextPressure 投影
   * 每一条都是**先探测再显示**：宿主不支持就不显示（而不是点了报错）。 */
  function openPlusSheet() {
    openSheet('添加', function (body) {
      var ACTIONS = [
        { icon: '🖼', label: '发图片', hint: '最多 6 张', run: function () { fileInput.click(); } },
        { icon: '🕘', label: '历史输入', hint: '最近 30 条', run: openHistorySheet },
        { icon: '📄', label: '选电脑文件', hint: '引用 / 下载电脑上的文件', run: openFileSheet },
        { icon: '⬆', label: '传到电脑', hint: '把手机文件存进工作区', run: openUploadSheet },
        { icon: '⌘', label: '指令', hint: '斜杠命令', run: openCommandSheet },
        { icon: '🛡', label: '权限', hint: '沙箱 / 审批档位', run: openPermissionSheet },
        { icon: '📊', label: '上下文容量', hint: '当前占用与窗口', run: openContextSheet },
        { icon: '🔑', label: '添加 API', hint: '给电脑加一个模型通道', run: openAddApiSheet },
      ];
      /* 「重启 App」：只在跑在手机 App（WebView 壳）里时显示。
       * 原理：壳里注册了 JS 桥 window.dshNative.forceRestart()（MainActivity），
       * 浏览器里没有这个对象 ⇒ 探测不到就不显示（浏览器刷新页面即可，用不上重启）。
       * 用途：电脑端插件升级后，点一下 App 原地重启，不用去系统设置砍后台。 */
      var isNativeShell = false;
      try { isNativeShell = !!(window.dshNative && window.dshNative.forceRestart); } catch (e) { }
      if (isNativeShell) {
        ACTIONS.push({
          icon: '↻', label: '重启 App', hint: '电脑端升级后用',
          run: function () { try { window.dshNative.forceRestart(); } catch (e) { location.reload(); } },
        });
      }
      ACTIONS.forEach(function (a) {
        var b = el('button', 'btn block plus-item');
        b.appendChild(el('span', 'plus-ico', a.icon));
        var t = el('span', 'plus-label', a.label);
        b.appendChild(t);
        b.appendChild(el('span', 'plus-hint', a.hint));
        b.onclick = function () { closeSheet(); a.run(); };
        body.appendChild(b);
      });
    });
  }

  /* ── 上下文容量（抽屉）─────────────────────────────────
   * 显示与电脑端**同源**的数字：usedTokens / contextWindow，百分比照抄官方
   * 前端算法（`dsh-client-ui-conversation/lib/client.js:15330-15334`）。 */
  function openContextSheet() {
    if (!current) { addNote('⚠ 先打开一个会话'); return; }
    openSheet('上下文容量', function (body) {
      body.appendChild(el('div', 'empty', '读取中…'));
      api('context.usage', { sessionId: current }).then(function (u) {
        body.innerHTML = '';
        if (u.usedTokens == null || !u.contextWindow) {
          body.appendChild(el('div', 'empty', '还没有请求过 —— 发一条消息后就有数据了'));
        } else {
          var pct = u.percent == null ? 0 : u.percent;
          var wrap = el('div', 'ctx-wrap');
          wrap.appendChild(el('div', 'ctx-num',
            fmtTokens(u.usedTokens) + ' / ' + fmtTokens(u.contextWindow)));
          var bar = el('div', 'ctx-bar');
          var fill = el('div', 'ctx-fill' + (pct >= 80 ? ' hot' : (pct >= 60 ? ' warm' : '')));
          fill.style.width = Math.max(2, pct) + '%';
          bar.appendChild(fill);
          wrap.appendChild(bar);
          wrap.appendChild(el('div', 'ctx-pct', pct + '%'));
          body.appendChild(wrap);
          if (u.projectedTokens != null) {
            body.appendChild(el('div', 'sec', '下一轮预计'));
            body.appendChild(el('div', 'empty',
              fmtTokens(u.projectedTokens) + '（含本轮新增内容）'));
          }
          if (pct >= 80) {
            body.appendChild(el('div', 'warnbox',
              '已接近压缩线：这个客户端到窗口的 80% 会自动压缩，压缩后早期对话会被摘要替换。'));
          }
        }
        if (u.totals) {
          body.appendChild(el('div', 'sec', '本会话累计计费'));
          body.appendChild(el('div', 'empty',
            '输入 ' + fmtTokens(u.totals.uncachedInputTokens || 0)
            + '　输出 ' + fmtTokens(u.totals.outputTokens || 0)
            + '　缓存读 ' + fmtTokens(u.totals.cacheReadTokens || 0)));
        }
        var r = el('button', 'btn block', '刷新');
        r.onclick = openContextSheet;
        body.appendChild(r);
      }).catch(function (e) {
        body.innerHTML = '';
        if (e.unknownMethod) unsupportedBox(body, '上下文容量');
        else body.appendChild(el('div', 'empty', '读取失败：' + e.message));
      });
    });
  }

  /** 大数字缩写（与电脑端观感一致）。 */
  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n);
  }

  /* ── 权限选择（抽屉）───────────────────────────────────
   * 走官方 permissionPresets：沙箱模式 + 审批策略的成对预设。
   * danger 那一档标红并在点选时二次确认 —— 那是"完全放行"的意思。 */
  function openPermissionSheet() {
    if (!current) { addNote('⚠ 先打开一个会话'); return; }
    openSheet('权限', function (body) {
      body.appendChild(el('div', 'empty', '读取中…'));
      api('permission.list', { sessionId: current }).then(function (r) {
        body.innerHTML = '';
        body.appendChild(el('div', 'sec', '当前：' + (r.current || '未知')));
        (r.options || []).forEach(function (o) {
          var danger = o.value === 'danger-full-access';
          var b = el('button', 'btn block' + (o.value === r.current ? ' on' : '') + (danger ? ' danger' : ''));
          b.appendChild(el('div', 'perm-name', o.name || o.value));
          if (o.description) b.appendChild(el('div', 'perm-desc', o.description));
          b.onclick = function () {
            if (danger && !window.confirm('切到「' + (o.name || o.value) + '」= 完全放行文件访问、且不再询问审批。确定吗？')) return;
            api('permission.set', { sessionId: current, preset: o.value }).then(function (res) {
              closeSheet();
              addNote('已切换权限：' + (res.current || o.value));
            }).catch(function (e) { addNote('⚠ 切换失败：' + e.message, true); });
          };
          body.appendChild(b);
        });
        body.appendChild(el('div', 'empty',
          '权限是**按会话**的；这里改的只影响当前会话，电脑端其它会话不受影响。'));
      }).catch(function (e) {
        body.innerHTML = '';
        if (e.unknownMethod) unsupportedBox(body, '权限选择');
        else body.appendChild(el('div', 'empty', '读取失败：' + e.message));
      });
    });
  }

  /* ── 指令选择（抽屉）───────────────────────────────────
   * 列出官方斜杠命令；点一条就把 `/name ` 填进输入框（不直接执行 ——
   * 需要参数的命令得让人先填参数，而且"填进输入框"是可反悔的）。 */
  function openCommandSheet() {
    if (!current) { addNote('⚠ 先打开一个会话'); return; }
    openSheet('指令', function (body) {
      body.appendChild(el('div', 'empty', '读取中…'));
      api('command.list', { sessionId: current }).then(function (r) {
        body.innerHTML = '';
        var items = (r && r.items) || [];
        if (!items.length) { body.appendChild(el('div', 'empty', '这个会话没有可用命令')); return; }
        items.forEach(function (c) {
          var b = el('button', 'btn block');
          b.appendChild(el('div', 'cmd-name', '/' + c.name));
          if (c.description) b.appendChild(el('div', 'cmd-desc', c.description));
          if (c.takesInput && c.hint) b.appendChild(el('div', 'cmd-hint', '参数：' + c.hint));
          b.onclick = function () {
            var t = '/' + c.name + (c.takesInput ? ' ' : '');
            promptInput.value = t;
            promptInput.focus();
            autoGrow();
            closeSheet();
            if (c.takesInput) addNote('已填入 /' + c.name + '，补上参数再发送');
          };
          body.appendChild(b);
        });
        body.appendChild(el('div', 'empty',
          '命令由电脑端内核执行（与电脑上打 / 完全一样）。'));
      }).catch(function (e) {
        body.innerHTML = '';
        if (e.unknownMethod) unsupportedBox(body, '指令列表');
        else body.appendChild(el('div', 'empty', '读取失败：' + e.message));
      });
    });
  }

  /* ── 添加 API 通道（抽屉）────────────────────────────────
   * 两步式，与电脑端设置页的"新增提供方"同一条路：
   *   ① 填 ID / 地址 / 协议 / key → 「探测模型」（**只读，不写任何东西**）
   *   ② 在结果里勾选要加的模型 → 「添加」→ 才真正写进电脑
   * 为什么不一步到位：端点填错、协议选错时，一步式会**先把错配置写进电脑**。
   * 先探测能把"这个地址到底能不能用"在落盘之前问清楚。 */
  function openAddApiSheet() {
    openSheet('添加 API', function (body) {
      var wrap = el('div', 'api-form');

      function field(label, hint, value) {
        var f = el('div', 'api-field');
        f.appendChild(el('label', 'api-label', label));
        var i = document.createElement('input');
        i.className = 'search';
        i.type = 'text';
        i.autocomplete = 'off';
        i.spellcheck = false;
        if (hint) i.placeholder = hint;
        if (value) i.value = value;
        f.appendChild(i);
        wrap.appendChild(f);
        return i;
      }

      var idIn = field('通道 ID', '小写字母/数字/连字符，例 acme-gateway');
      var urlIn = field('接口地址', 'https://api.example.com/v1');
      var nameIn = field('显示名（可选）', 'Acme');

      var pf = el('div', 'api-field');
      pf.appendChild(el('label', 'api-label', '协议'));
      var proto = document.createElement('select');
      proto.className = 'search';
      ['openai-completions', 'openai-responses', 'anthropic-messages'].forEach(function (p) {
        var o = document.createElement('option');
        o.value = p; o.textContent = p;
        proto.appendChild(o);
      });
      pf.appendChild(proto);
      wrap.appendChild(pf);

      var keyIn = field('API Key', 'sk-…（只存在电脑上，不回显）');
      keyIn.type = 'password';

      body.appendChild(wrap);
      body.appendChild(el('div', 'empty',
        'Key 会写进电脑的凭据文件（.credentials.yaml 的 refs 段），手机不留副本。'));

      var found = [];          // 探测结果
      var picked = {};         // id -> true
      var listBox = el('div', 'api-list');
      body.appendChild(listBox);

      var probeBtn = el('button', 'btn block primary', '① 探测模型（只读，不写电脑）');
      probeBtn.onclick = function () {
        var providerId = idIn.value.trim();
        var baseURL = urlIn.value.trim();
        var api = proto.value;
        if (!providerId || !baseURL) { listBox.innerHTML = ''; listBox.appendChild(el('div', 'empty', '先填通道 ID 和接口地址')); return; }
        probeBtn.disabled = true;
        listBox.innerHTML = '';
        listBox.appendChild(el('div', 'empty', '正在问端点有哪些模型…'));
        api('llm.discover', { provider: providerId, baseURL: baseURL, api: api, apiKey: keyIn.value })
          .then(function (r) {
            found = (r && r.models) || [];
            picked = {};
            listBox.innerHTML = '';
            if (!found.length) {
              listBox.appendChild(el('div', 'empty', '端点没报出任何模型（地址/协议/key 对不上？）'));
              return;
            }
            listBox.appendChild(el('div', 'sec', '探测到 ' + found.length + ' 个模型（勾选要加的）'));
            found.forEach(function (m) {
              picked[m.id] = true;      // 默认全选：官方设置页也是"添加所选"
              var row = el('button', 'btn block api-model on');
              row.appendChild(el('span', 'api-check', '✓'));
              row.appendChild(el('span', 'api-mid', m.name ? (m.name + '  (' + m.id + ')') : m.id));
              if (m.contextWindow) row.appendChild(el('span', 'api-ctx', fmtTokens(m.contextWindow)));
              row.onclick = function () {
                picked[m.id] = !picked[m.id];
                row.className = 'btn block api-model' + (picked[m.id] ? ' on' : '');
                row.firstChild.textContent = picked[m.id] ? '✓' : '○';
              };
              listBox.appendChild(row);
            });
          })
          .catch(function (e) {
            listBox.innerHTML = '';
            listBox.appendChild(el('div', 'empty', '探测失败：' + e.message));
          })
          .then(function () { probeBtn.disabled = false; });
      };
      body.appendChild(probeBtn);

      var addBtn = el('button', 'btn block primary', '② 添加到电脑');
      addBtn.onclick = function () {
        var providerId = idIn.value.trim();
        var baseURL = urlIn.value.trim();
        var api = proto.value;
        var chosen = found.filter(function (m) { return picked[m.id]; });
        if (!chosen.length) { addNote('⚠ 先探测并勾选模型'); return; }
        if (!window.confirm('把这 ' + chosen.length + ' 个模型加到电脑的通道「' + providerId + '」？\n'
          + '（会写入电脑的 settings.yaml 与 .credentials.yaml，立刻生效、不用重启）')) return;
        addBtn.disabled = true;
        api('llm.add', {
          providerId: providerId,
          baseURL: baseURL,
          api: api,
          displayName: nameIn.value.trim(),
          apiKey: keyIn.value,
          models: chosen.map(function (m) {
            return { id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens };
          }),
        }).then(function (r) {
          closeSheet();
          addNote('✅ 已添加通道 ' + (r.displayName || providerId) + '（' + r.models + ' 个模型）'
            + (r.keyStored ? '，key 已保存' : '') + '。' + (r.note || ''));
        }).catch(function (e) {
          addNote('⚠ 添加失败：' + e.message, true);
        }).then(function () { addBtn.disabled = false; });
      };
      body.appendChild(addBtn);

      // 已有通道（避免重复添加 / 看清单）
      var existBox = el('div', 'api-exist');
      body.appendChild(existBox);
      api('llm.providers').then(function (r) {
        var ps = (r && r.providers) || [];
        if (!ps.length) return;
        existBox.appendChild(el('div', 'sec', '电脑上已有的通道'));
        ps.forEach(function (p) {
          existBox.appendChild(el('div', 'empty',
            (p.displayName || p.id) + '　' + p.models.length + ' 个模型　' + (p.baseURL || '')));
        });
      }).catch(function () { /* 读不到就不显示 */ });
    });
  }

  /* ── 电脑文件选择（抽屉）───────────────────────────────
   * 用官方文件引用服务逐层浏览电脑目录；选中后把官方 @ 提及语法填进输入框
   * （内核自己会把它解析成文件引用 —— 与电脑端 @ 完全同一条路）。
   *
   * ★ 2026-09-22 扩展：**可以切换工作区**（用户原话：「我们的整个工作其实已经
   *   迁移到第2个工作区了，有没有办法让手机可以下载三个工作区的文件？
   *   以及向三个工作区发送文件。」）
   *   工作区列表来自官方 `workspace.list`（与"新建会话"同一个来源，早就在用了）。
   *   `root` 一路透传给宿主；宿主**只认已注册工作区**（见 desktop/index.js 的
   *   `resolveTargetRoot`），手机端传别的路径一律被拒。 */
  function openFileSheet(startPath, root) {
    if (!current) { addNote('⚠ 先打开一个会话'); return; }
    var path = startPath || '';
    var curRoot = root || '';          // '' = 本会话自己的工作区
    function render(body) {
      body.innerHTML = '';
      body.appendChild(el('div', 'empty', '读取中…'));
      var params = { sessionId: current, path: path };
      if (curRoot) params.root = curRoot;
      api('file.list', params).then(function (r) {
        body.innerHTML = '';

        /* ── 工作区切换条 ────────────────────────────────
         * 只在**真的有多个工作区**时显示（一个的时候是噪音）。
         * 每台设备显示成一颗胶囊，当前所在的那颗高亮。 */
        if (workspaces.length > 1) {
          var wsbar = el('div', 'wsbar');
          // 本会话自己的工作区（用返回的 root 判断，比猜 cwd 可靠）
          var ownRoot = r && r.isOther === false ? (r.root || '') : '';
          var pills = [{ title: '本会话', root: '', active: !curRoot }];
          workspaces.forEach(function (w) {
            pills.push({
              title: w.title || w.path,
              root: w.path,
              active: !!curRoot && curRoot === w.path,
            });
          });
          pills.forEach(function (p) {
            var c = el('button', 'wspill' + (p.active ? ' on' : ''), p.title);
            c.title = p.root || '（当前会话的工作区）';
            c.onclick = function () {
              if (p.active) return;
              openFileSheet('', p.root);       // 换工作区 ⇒ 回到那个工作区的根
            };
            wsbar.appendChild(c);
          });
          body.appendChild(wsbar);
        }

        // 面包屑：支持逐层返回
        var crumb = el('div', 'crumb');
        var up = el('button', 'crumb-up', path ? '↑ 上一级' : (r && r.rootName ? r.rootName : '工作区根目录'));
        up.onclick = function () { openFileSheet(r.parent || '', curRoot); };
        crumb.appendChild(up);
        if (path) crumb.appendChild(el('span', 'crumb-path', path));
        body.appendChild(crumb);

        /* 跨工作区时明确提示一句 —— 否则用户会以为"我明明在本会话里，
         * 怎么看到的是别的工作区的文件"。 */
        if (r && r.isOther) {
          body.appendChild(el('div', 'xfer-note', '正在浏览别的工作区：' + (r.root || '')));
        }

        var items = (r && r.items) || [];
        if (!items.length) body.appendChild(el('div', 'empty', '这个目录是空的'));
        items.forEach(function (it) {
          var isDir = it.kind === 'directory';
          var b = el('button', 'btn block file-item');
          b.appendChild(el('span', 'file-ico', isDir ? '📁' : '📄'));
          b.appendChild(el('span', 'file-name', it.name || it.path));
          // 文件大小（跨工作区那条路会带 size；本会话那条不带）
          if (!isDir && typeof it.size === 'number') {
            b.appendChild(el('span', 'file-size', fmtBytes(it.size)));
          }
          b.onclick = function () {
            if (isDir) { openFileSheet(it.path, curRoot); return; }
            /* 文件有三种用法，让用户选（图片尤其需要 —— 直接引用图片路径
             * 模型只能看到路径，而"读成图片发出去"它才真的看得见图）：
             *   · 引用路径：把官方 @提及 文本填进输入框（纯文本，内核靠系统
             *     提示词让模型用 read 工具读 —— 官方就是这么设计的）
             *   · 读成图片：走 workspaceFiles.readAll 拿 base64，塞进待发图片
             *     列表（与手机相册发的图走**完全相同**的发送路径）
             *   · 下载到手机：交给系统下载器（2026-09-22 新增）
             * 2026-09-22 改：**所有文件**都进这个抽屉，不再只给图片。
             * 旧写法对非图片直接 insertMention，于是"下载"这个动作
             * 在非图片上根本没有入口 —— 而用户要下载的恰恰是 zip / 源码。 */
            openFileActions(it, curRoot);
          };
          body.appendChild(b);
        });
      }).catch(function (e) {
        body.innerHTML = '';
        if (e.unknownMethod) unsupportedBox(body, '选文件');
        else body.appendChild(el('div', 'empty', '读取失败：' + e.message));
      });
    }
    openSheet('选电脑文件', render);
  }

  /** 把 @提及 填进输入框（官方语法：目录补 /，含空白用 @"…"）。 */
  function insertMention(it, root) {
    promptInput.value = (promptInput.value ? promptInput.value.replace(/\s*$/, ' ') : '') + it.mention + ' ';
    promptInput.focus();
    autoGrow();
    closeSheet();
    /* 跨工作区的提及是**绝对路径**（宿主那边拼的，见 desktop/index.js 的
     * `tr.isOther` 分支）—— 因为 `@相对路径` 的语义是"相对**本会话**工作区根"，
     * 拿别的工作区的相对路径在当前会话里根本解析不到。这里如实告诉用户。 */
    addNote('已引用：' + (root ? it.mention : it.path));
  }

  /** 文件：问"引用路径 / 读成图片 / 下载到手机"。 */
  function openFileActions(it, root) {
    var isImg = /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(it.path);
    openSheet(isImg ? '这张图怎么用' : '这个文件怎么用', function (body) {
      body.appendChild(el('div', 'empty', root ? it.mention : it.path));
      var a = el('button', 'btn block');
      a.appendChild(el('div', 'cmd-name', '引用路径'));
      a.appendChild(el('div', 'cmd-desc', root
        ? '填绝对路径进输入框（别的工作区只能用绝对路径）'
        : '把 @路径 填进输入框，模型自己用工具去读'));
      a.onclick = function () { insertMention(it, root); };
      body.appendChild(a);

      if (isImg) {
        var b = el('button', 'btn block');
        b.appendChild(el('div', 'cmd-name', '读成图片发出去'));
        b.appendChild(el('div', 'cmd-desc', '直接把文件内容读过来，像相册图片一样发给模型看'));
        b.onclick = function () {
          b.disabled = true;
          var rp = { sessionId: current, path: it.path };
          if (root) rp.root = root;
          api('file.read', rp).then(function (r) {
            if (!r || !r.data) throw new Error('文件是空的');
            var ext = (it.path.split('.').pop() || 'png').toLowerCase();
            var mt = ext === 'jpg' ? 'jpeg' : ext;
            pendingImages.push({
              mediaType: 'image/' + mt,
              data: r.data,
              name: it.name || 'file',
              url: 'data:image/' + mt + ';base64,' + r.data,
            });
            renderAttach();
            closeSheet();
            addNote('已加入待发图片：' + (it.name || it.path)
              + (r.bytes ? '（' + Math.round(r.bytes / 1024) + ' KB）' : ''));
          }).catch(function (e) {
            addNote('⚠ 读取失败：' + e.message, true);
          }).then(function () { b.disabled = false; });
        };
        body.appendChild(b);
      }

      /* ★ 下载到手机（2026-09-22 新增，用户需求"随时下载电脑那边的文件"）。
       *   放在这里而不是「＋」里：下载的对象**永远是"某个具体的文件"**，
       *   而用户在文件列表里点到它的时候，正好就是"我想要这个"的那一刻。
       *   从「＋」进的话还要重新逐层找到它一遍。 */
      var d = el('button', 'btn block');
      d.appendChild(el('div', 'cmd-name', '下载到手机'));
      d.appendChild(el('div', 'cmd-desc', '用系统下载器下载（有进度、可断点续传）'));
      d.onclick = function () { startDownload(it, root); };
      body.appendChild(d);
    });
  }

  /* ── 文件互传（2026-09-22 用户需求）───────────────────────
   * 用户原话：「允许连接之后的手机和电脑DSH互传文件。这方便了一些跨端项目中，
   *   我可以随时下载电脑那边的文件。」
   *
   * ══════════════════════════════════════════════════════════════
   * 下载为什么**不用 fetch**（这是本功能唯一的设计要点）
   * ══════════════════════════════════════════════════════════════
   * 若用 fetch 把字节拉进 JS 再转 blob：
   *   · 整个文件**进 WebView 内存**（手机上传 200 MB 必被系统杀掉）；
   *   · 没有任何进度（用户只看到"没反应"）；
   *   · 拿不到系统下载器的断点续传与通知栏。
   * 所以这里只做两件事：
   *   ① 向宿主要一张**一次性票据**（`file.download`，只回 JSON）；
   *   ② 把票据 URL 交给**系统下载管理器**（Android 壳里走 JS 桥
   *      `dshNative.download`；浏览器里退化成 `location.href`，
   *      由浏览器自己的下载器接管）。
   * 字节全程不经过 JS。 */
  function isNative() {
    try { return !!(window.dshNative && window.dshNative.download); } catch (e) { return false; }
  }

  /** 把宿主给的相对 URL 补成绝对 URL（票据 URL 是 `/api/file/dl?t=…`）。 */
  function absUrl(u) {
    if (/^https?:\/\//i.test(u)) return u;
    return location.origin + u;
  }

  function startDownload(it, root) {
    if (!current) { addNote('⚠ 先打开一个会话'); return; }
    var b = el('div', 'empty', '正在准备下载…');
    openSheet('下载到手机', function (body) { body.appendChild(b); });
    var params = { sessionId: current, path: it.path, name: it.name };
    if (root) params.root = root;      // ★ 跨工作区：指定要下载的那个工作区
    api('file.download', params)
      .then(function (r) {
        var url = absUrl(r.url);
        /* ★ 票据 URL 必须带 token：系统下载器**加不了 Authorization 头**，
         *   所以 token 只能走查询参数（宿主那边 `url.searchParams.get('token')`
         *   就是为这条路留的，SSE 同理）。 */
        url += (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
        if (isNative()) {
          try { window.dshNative.download(url, r.name || 'file'); } catch (e) { }
          closeSheet();
          addNote('已交给系统下载：' + (r.name || '') + '（' + fmtBytes(r.bytes) + '）');
          return;
        }
        // 浏览器：交给浏览器自己的下载器（同样带原生进度）
        var a = document.createElement('a');
        a.href = url; a.download = r.name || 'file';
        a.rel = 'noopener';
        document.body.appendChild(a); a.click();
        setTimeout(function () { document.body.removeChild(a); }, 0);
        closeSheet();
        addNote('已开始下载：' + (r.name || '') + '（' + fmtBytes(r.bytes) + '）');
      })
      .catch(function (e) {
        closeSheet();
        if (e.unknownMethod) { addNote('⚠ 电脑端插件是旧版本，下载不可用（需重启客户端）', true); return; }
        addNote('⚠ 下载失败：' + e.message, true);
      });
  }

  /* ── 上传：手机 → 电脑 ────────────────────────────────────
   * 走 `POST /api/file/ul?…`（**裸字节流**，不是 JSON），用 XHR 而不是 fetch ——
   * 因为只有 XHR 有 `upload.onprogress`（fetch 的流式上传进度在 Android
   * WebView 131 上仍不可靠）。进度要显示给用户：几百 MB 的传输没有进度
   * 等于"卡死了"。
   *
   * ★ 落点是**某个工作区的目录**（默认本会话的），且由宿主强制校验
   *   （越界、以及"不是已注册工作区"一律拒绝）。
   *   这里先把落点问出来给用户看（`file.uploadTarget`），用户确认后才传。
   *
   * ★ 2026-09-22：加了**工作区切换**（用户："向三个工作区发送文件"）。 */
  function openUploadSheet(root) {
    if (!current) { addNote('⚠ 先打开一个会话'); return; }
    var sub = '';                       // 当前选择的子目录（相对工作区根）
    var curRoot = root || '';           // '' = 本会话自己的工作区
    function render(body) {
      body.innerHTML = '';
      body.appendChild(el('div', 'empty', '正在读取落点…'));
      var tp = { sessionId: current, dir: sub };
      if (curRoot) tp.root = curRoot;
      api('file.uploadTarget', tp).then(function (t) {
        body.innerHTML = '';

        // 工作区切换条（只有一个工作区时不显示，免得是噪音）
        if (workspaces.length > 1) {
          var wsbar = el('div', 'wsbar');
          var pills = [{ title: '本会话', root: '', active: !curRoot }];
          workspaces.forEach(function (w) {
            pills.push({ title: w.title || w.path, root: w.path, active: !!curRoot && curRoot === w.path });
          });
          pills.forEach(function (p) {
            var c = el('button', 'wspill' + (p.active ? ' on' : ''), p.title);
            c.title = p.root || '（当前会话的工作区）';
            c.onclick = function () {
              if (p.active) return;
              sub = '';                      // 换工作区 ⇒ 子目录重来（两个工作区的子目录无关）
              openUploadSheet(p.root);
            };
            wsbar.appendChild(c);
          });
          body.appendChild(wsbar);
        }

        var info = el('div', 'xfer-info');
        info.appendChild(el('div', 'xfer-row',
          '电脑上的落点' + (t.isOther ? '（别的工作区）' : '')));
        info.appendChild(el('div', 'xfer-path', t.absolutePath));
        info.appendChild(el('div', 'xfer-note',
          '上限 ' + fmtBytes(t.maxBytes) + '；重名不会覆盖，会自动加 -1、-2'));
        body.appendChild(info);

        // 子目录输入（相对工作区根；宿主会拒绝越出工作区）
        var row = el('div', 'xfer-sub');
        var inp = document.createElement('input');
        inp.type = 'text'; inp.className = 'xfer-input';
        inp.placeholder = '子目录（可留空 = 工作区根）';
        inp.value = sub;
        var go = el('button', 'btn small', '进入');
        go.onclick = function () { sub = inp.value.trim(); render(body); };
        row.appendChild(inp); row.appendChild(go);
        body.appendChild(row);

        var pick = el('button', 'btn block primary');
        pick.appendChild(el('div', 'cmd-name', '选择手机上的文件'));
        pick.appendChild(el('div', 'cmd-desc', '可以多选；传完可直接引用路径让模型读'));
        pick.onclick = function () { uploadPick = { dir: sub, root: curRoot }; uploadInput.click(); };
        body.appendChild(pick);
      }).catch(function (e) {
        body.innerHTML = '';
        if (e.unknownMethod) unsupportedBox(body, '文件上传');
        else body.appendChild(el('div', 'empty', '读取失败：' + e.message));
      });
    }
    openSheet('传到电脑', render);
  }

  /** 当前待上传的目标（由 openUploadSheet 设置；选择器回调要用）。 */
  var uploadPick = null;

  uploadInput.onchange = function () {
    var files = Array.prototype.slice.call(uploadInput.files || []);
    uploadInput.value = '';
    if (!files.length) return;
    var target = uploadPick || { dir: '', root: '' };
    uploadPick = null;
    closeSheet();
    uploadQueue(files, target.dir, target.root || '', 0, []);
  };

  /**
   * 逐个上传（**串行**，不并行）。
   * 为什么串行：并行会让"总进度"变成一笔糊涂账，而手机热点带宽本来就窄，
   * 并行只会让每个都变慢。串行还能让用户看清"现在传到第几个"。
   */
  function uploadQueue(files, dir, root, idx, done) {
    if (idx >= files.length) {
      var ok = done.filter(function (d) { return d.ok; });
      addNote('✅ 传到电脑：' + ok.length + '/' + files.length + ' 个'
        + (ok.length ? '（' + ok[0].name + (ok.length > 1 ? ' 等' : '') + '）' : ''));
      if (ok.length) {
        // 把落点相对路径记下来，方便用户立刻引用
        lastUploads = ok;
        showUploadResult(ok);
      }
      return;
    }
    var f = files[idx];
    var box = el('div', 'xfer-item');
    box.appendChild(el('div', 'xfer-name', (idx + 1) + '/' + files.length + '  ' + f.name));
    var bar = el('div', 'ctx-bar');
    var fill = el('div', 'ctx-fill');
    fill.style.width = '0%';
    bar.appendChild(fill);
    box.appendChild(bar);
    var pct = el('div', 'xfer-pct', '0%');
    box.appendChild(pct);
    openSheet('正在传到电脑', function (body) { body.appendChild(box); });

    var url = '/api/file/ul?sessionId=' + encodeURIComponent(current)
      + '&path=' + encodeURIComponent(dir || '')
      + '&name=' + encodeURIComponent(f.name)
      + (root ? '&root=' + encodeURIComponent(root) : '');   // ★ 跨工作区上传
    var xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('authorization', 'Bearer ' + token);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      var p = Math.round(e.loaded * 100 / e.total);
      fill.style.width = Math.max(2, p) + '%';
      pct.textContent = p + '%  ·  ' + fmtBytes(e.loaded) + ' / ' + fmtBytes(e.total);
    };
    xhr.onload = function () {
      var j = null;
      try { j = JSON.parse(xhr.responseText); } catch (e) { }
      if (xhr.status === 200 && j && j.ok) {
        done.push({
          ok: true, name: j.name, rel: j.relativePath, mention: j.mention,
          renamed: j.renamed, isOther: !!j.isOther,
        });
      } else {
        done.push({ ok: false, name: f.name });
        addNote('⚠ ' + f.name + ' 上传失败：' + ((j && j.message) || ('HTTP ' + xhr.status)), true);
      }
      uploadQueue(files, dir, root, idx + 1, done);
    };
    xhr.onerror = function () {
      done.push({ ok: false, name: f.name });
      addNote('⚠ ' + f.name + ' 上传中断（网络断了？）', true);
      uploadQueue(files, dir, root, idx + 1, done);
    };
    xhr.send(f);
  }

  /** 上传成功后的收尾抽屉：把相对路径摆出来，一键引用 / 复制。 */
  var lastUploads = [];
  function showUploadResult(items) {
    openSheet('已传到电脑', function (body) {
      var other = items.some(function (i) { return i.isOther; });
      body.appendChild(el('div', 'empty', other
        ? '传进了**别的工作区**，引用时用的是绝对路径：'
        : '落点在当前会话的工作区里，可以直接引用：'));
      items.forEach(function (it) {
        var b = el('button', 'btn block file-item');
        b.appendChild(el('span', 'file-ico', '📄'));
        b.appendChild(el('span', 'file-name',
          (it.isOther ? it.mention : it.rel) + (it.renamed ? '（重名已改名）' : '')));
        b.onclick = function () {
          promptInput.value = (promptInput.value ? promptInput.value.replace(/\s*$/, ' ') : '') + it.mention + ' ';
          promptInput.focus(); autoGrow(); closeSheet();
          addNote('已引用：' + (it.isOther ? it.mention : it.rel));
        };
        body.appendChild(b);
      });
      var c = el('button', 'btn block', '复制路径');
      c.onclick = function () {
        var txt = items.map(function (i) { return i.mention; }).join(' ');
        try {
          navigator.clipboard.writeText(txt);
          addNote('已复制到剪贴板');
        } catch (e) { addNote('复制失败，请长按选择', true); }
      };
      body.appendChild(c);
    });
  }

  function openHistorySheet() {
    openSheet('历史输入', function (body) {
      var h = getHistory();
      if (!h.length) { body.appendChild(el('div', 'empty', '还没有历史输入')); return; }
      h.forEach(function (t) {
        /* ★ 不再 slice(0,70) 截断：整段放进 .hist-text，CSS 负责**换行**展示
         *   （旧写法撞上 .btn 基类的 white-space:nowrap，长句直接溢出抽屉 ——
         *   用户报的「很多句话超出去了，已经超出页面了」。） */
        var b = el('button', 'btn block hist-item');
        b.appendChild(el('div', 'hist-text', t));
        b.onclick = function () {
          promptInput.value = t; promptInput.focus(); autoGrow(); closeSheet();
        };
        body.appendChild(b);
      });
      var c = el('button', 'btn block hist-clear', '清空历史');
      c.onclick = function () { try { localStorage.removeItem(HISTORY_KEY); } catch (e) { } closeSheet(); };
      body.appendChild(c);
    });
  }

  function openMenuSheet() {
    openSheet('更多', function (body) {
      var a = el('button', 'btn block', '刷新会话列表');
      a.onclick = function () { closeSheet(); loadAll(); };
      body.appendChild(a);

      // ── 显示开关（2026-09-22）──
      body.appendChild(el('div', 'sec', '显示'));

      var p = el('button', 'btn block plus-item');
      p.appendChild(el('span', 'plus-ico', plainMode ? '☑' : '☐'));
      p.appendChild(el('span', 'plus-label', '纯文本显示对话'));
      p.appendChild(el('span', 'plus-hint', plainMode ? '已开' : '原始 Markdown'));
      p.onclick = function () {
        plainMode = !plainMode;
        try { localStorage.setItem(PLAIN_KEY, plainMode ? '1' : '0'); } catch (e) { }
        closeSheet();
        addNote(plainMode ? '已切到纯文本显示（重新打开会话生效）' : '已切回原始 Markdown（重新打开会话生效）');
      };
      body.appendChild(p);

      var su = el('button', 'btn block plus-item');
      su.appendChild(el('span', 'plus-ico', showSubagents ? '☑' : '☐'));
      su.appendChild(el('span', 'plus-label', '显示子代理会话'));
      su.appendChild(el('span', 'plus-hint', showSubagents ? '已开' : '默认隐藏'));
      su.onclick = function () {
        showSubagents = !showSubagents;
        try { localStorage.setItem(SHOW_SUB_KEY, showSubagents ? '1' : '0'); } catch (e) { }
        closeSheet();
        renderList();
      };
      body.appendChild(su);

      var rl = el('button', 'btn block', '展开全部工作区');
      rl.onclick = function () { collapsedWs = {}; saveCollapsed(); closeSheet(); renderList(); };
      body.appendChild(rl);

      body.appendChild(el('div', 'sec', '连接'));
      var b = el('button', 'btn block', '断开并重新配对');
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
    if (text.trim()) { pushHistory(text.trim()); markSent(text.trim()); }   // ★ 记下"刚发的"，事件流回显时去重

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

  /* 「打开扫码器」按钮（配对页）：只在 App 壳里显示。
   * 浏览器 getUserMedia 在 http 明文页上不可用 ⇒ 网页自己扫不了，
   * 必须走 App 的原生扫码（dshNative.startScan → ScanActivity → onActivityResult
   * → MainActivity 直接 loadUrl 并带 #scan 回来）。 */
  var isNativeShell = false;
  try { isNativeShell = !!(window.dshNative && window.dshNative.startScan); } catch (e) { }
  if (isNativeShell) {
    var scanBtn = el('button', 'btn primary', '打开扫码器');
    scanBtn.type = 'button';
    scanBtn.style.marginTop = '10px';
    scanBtn.onclick = function () {
      try { window.dshNative.startScan(); } catch (e) { setMsg(pairMsg, '扫码不可用', 'bad'); }
    };
    pairForm.parentNode.insertBefore(scanBtn, pairForm.nextSibling);
  }

  $('refreshBtn').onclick = function () { loadAll(); };
  $('newSessionBtn').onclick = openNewSessionSheet;
  $('menuBtn').onclick = openMenuSheet;
  $('modelBtn').onclick = openModelSheet;
  $('plusBtn').onclick = openPlusSheet;
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
    pairCodeFromUrl = fromUrl.trim().toUpperCase();   // ★ 留给 autoRepair：以后 401 可用它静默恢复
    pair(codeInput.value);
  } else {
    try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { }
    if (token) {
      openStream(); loadAll(); probeCapabilities(); show(listView);
    }
  }
})();
