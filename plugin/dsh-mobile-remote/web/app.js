/* 手机遥控 · 前端逻辑（无框架、无外部依赖）
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一版相比上一版改了什么（对着用户提的四条）
 * ══════════════════════════════════════════════════════════════════
 * ① 会话列表太素 → 标题（读日志里的 session/title）+ 工作区胶囊 + 相对时间
 *    + "运行中"标记 + 空会话置灰；顶部还有搜索框。
 * ② 聊天区不好用 → 思考过程做成**可折叠**（默认收起）、工具调用单独成卡、
 *    代码围栏 ``` 渲染成等宽代码块（不再糊成一坨）。
 * ③ 发消息 → 历史输入（🕘，本机 localStorage）、**回车=换行 / Ctrl+回车=发送**
 *    （刻意区分，避免手滑发出去）、可发图片（🖼，base64 直传，宿主提升为持久附件）。
 * ④ 操控感 → 会话里可切模型/思考强度（⚙）、可新建会话并选工作区（＋）、
 *    审批请求会推到这里（允许/拒绝）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 鉴权方式（上一版死在这上面）
 * ══════════════════════════════════════════════════════════════════
 * 不用 WebSocket：浏览器 `new WebSocket()` **无法设置请求头**。
 * 事件流用 **EventSource**（token 走查询参数），动作请求用 **fetch**（token 走 Authorization 头）。
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

  var token = null;
  var es = null;
  var sessions = [];        // 最近一次 list 的结果
  var titles = {};          // sessionId -> 标题
  var workspaces = [];
  var current = null;       // 当前会话 id
  var currentTitle = '';
  var pendingImages = [];   // [{mediaType, data, name, url}]
  var streamBuf = '';       // 流式助手文本
  var streamEl = null;      // 流式气泡
  var streamReason = '';    // 流式思考
  var reasonEl = null;
  var activeApproval = null;

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
  /** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / 月-日 */
  function relTime(ts) {
    if (!ts) return '';
    var d = Date.now() - ts;
    if (d < 0) d = 0;
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
          throw e;
        }
        return j.result;
      });
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
        try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* 隐私模式 */ }
        setMsg(pairMsg, '');
        openStream();
        loadAll();
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
    es.onerror = function () { /* EventSource 自己会重连 */ };
  }

  /* ── 会话列表 ───────────────────────────────────────── */

  function loadAll() {
    loadWorkspaces();
    return loadList();
  }

  function loadWorkspaces() {
    return api('workspace.list').then(function (v) {
      workspaces = (v && v.items) || [];
    }).catch(function () { workspaces = []; });
  }

  function loadList() {
    setMsg(listMsg, '读取中…');
    return api('session.list').then(function (v) {
      sessions = (v && v.items) || [];
      setMsg(listMsg, '');
      renderList();
      var ids = sessions.map(function (s) { return s.sessionId; });
      if (ids.length) {
        api('session.titles', { sessionIds: ids }).then(function (r) {
          titles = Object.assign(titles, (r && r.titles) || {});
          renderList();
        }).catch(function () { /* 标题拿不到就用兜底显示 */ });
      }
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
      var title = titles[s.sessionId] || '';
      var ws = workspaceOf(s.sessionId);
      var wsName = ws ? ws.title : (s.cwd ? baseName(s.cwd) : '');
      var hay = (title + ' ' + wsName + ' ' + (s.cwd || '')).toLowerCase();
      if (q && hay.indexOf(q) < 0) return;
      shown++;

      var row = el('button', 'row' + (s.running ? ' running' : '') + (s.blank && !title ? ' blank' : ''));
      row.appendChild(el('span', 'row-dot'));
      var main = el('div', 'row-main');

      var displayTitle = title || (s.blank ? '（空会话）' : s.sessionId.slice(0, 14));
      main.appendChild(el('div', 'row-title', displayTitle));

      var meta = el('div', 'row-meta');
      if (wsName) meta.appendChild(el('span', 'chip ws', '📁 ' + wsName));
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

  /* ── 会话详情 ───────────────────────────────────────── */

  function openSession(sessionId, title) {
    current = sessionId;
    currentTitle = title || titles[sessionId] || '';
    streamBuf = ''; streamEl = null; streamReason = ''; reasonEl = null;
    messages.innerHTML = '';
    pendingImages = []; renderAttach();
    hideApproval();
    detailTitle.textContent = currentTitle || sessionId.slice(0, 12);
    var s = sessions.filter(function (x) { return x.sessionId === sessionId; })[0];
    detailSub.textContent = (s && s.cwd) ? s.cwd : '';
    show(detailView);
    api('session.watch', { sessionId: sessionId }).catch(function (e) { addNote('⚠ ' + e.message, true); });
    setTimeout(scrollDown, 60);
  }

  function addNote(text, bad) {
    var n = el('div', 'note' + (bad ? ' bad' : ''), text);
    messages.appendChild(n); scrollDown();
    return n;
  }
  function addBubble(role, text) {
    var b = el('div', 'bubble ' + (role === 'user' ? 'me' : 'ai'));
    b.textContent = text;
    messages.appendChild(b); scrollDown();
    return b;
  }

  /* ── 内容块渲染 ─────────────────────────────────────── */

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

  /** 思考过程 → 可折叠块（默认收起，不刷屏） */
  function addThink(text) {
    var d = document.createElement('details');
    d.className = 'think';
    var sm = document.createElement('summary');
    sm.textContent = '💭 思考过程' + (text ? '（' + text.length + ' 字，点击展开）' : '…');
    d.appendChild(sm);
    d.appendChild(el('div', 'think-body', text || ''));
    messages.appendChild(d);
    return d;
  }

  /** 工具调用 → 紧凑卡片 */
  function addTool(name, body) {
    var d = el('div', 'tool');
    var head = el('div');
    head.appendChild(el('span', 'tool-name', '🔧 ' + (name || '工具')));
    d.appendChild(head);
    if (body) d.appendChild(el('div', 'tool-body', body));
    messages.appendChild(d); scrollDown();
    return d;
  }

  /**
   * 把助手正文按 ``` 代码围栏切成"文本段 + 代码块"。
   * 刻意只做这一件事 —— 不引 Markdown 库，也不假装支持完整 Markdown。
   */
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

  /* ── 渲染会话帧 ─────────────────────────────────────── */

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
      // 流式已经逐字打过的，这里可能重复 ⇒ 只有不一致时才补
      if (txt.trim() && txt !== streamBuf) {
        if (streamEl) { streamEl.remove(); streamEl = null; }
        renderAssistantText(txt);
      }
      streamBuf = ''; streamEl = null; streamReason = ''; reasonEl = null;
      return;
    }

    if (event.type === 'tool/call') {
      addTool(d.name, d.arguments ? String(d.arguments).slice(0, 600) : '');
      return;
    }

    if (event.type === 'tool/result') {
      var m = d.message || {};
      var s = textOfContent(m.content);
      if (s.trim()) {
        var cards = messages.querySelectorAll('.tool');
        var last = cards[cards.length - 1];
        if (last && !last.querySelector('.tool-body')) {
          last.appendChild(el('div', 'tool-body', s.slice(0, 800)));
          scrollDown();
        } else {
          addNote(s.slice(0, 800));
        }
      }
      return;
    }
  }

  function renderFrame(frame) {
    if (!frame) return;
    if (frame.type === 'snapshot') {
      (frame.records || []).forEach(function (r) { if (r.type === 'event') renderEvent(r.event); });
      scrollDown();
      return;
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
        if (streamEl && streamBuf) {
          streamEl.remove();
          renderAssistantText(streamBuf);
        }
        streamEl = null; streamBuf = '';
        reasonEl = null; streamReason = '';
      }
      return;
    }
  }

  /* ── 抽屉（模型 / 工作区 / 历史 / 菜单） ─────────────── */

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

  /** 模型选择：按提供方分组，含思考强度 */
  function openModelSheet() {
    if (!current) return;
    openSheet('切换模型', function (body) {
      body.appendChild(el('div', 'sec', '正在读取模型目录…'));
      api('modelCatalog').then(function (cat) {
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
        body.appendChild(el('div', 'empty', '读取失败：' + e.message));
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
    }).catch(function (e) { addNote('⚠ 切换失败：' + e.message, true); });
  }

  /** 新建会话：选工作区 */
  function openNewSessionSheet() {
    openSheet('新建会话', function (body) {
      if (!workspaces.length) {
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

  /** 历史输入 */
  function getHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (e) { return []; }
  }
  function pushHistory(text) {
    try {
      var h = getHistory().filter(function (x) { return x !== text; });
      h.unshift(text);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 30)));
    } catch (e) { /* 隐私模式 */ }
  }
  function openHistorySheet() {
    openSheet('历史输入', function (body) {
      var h = getHistory();
      if (!h.length) { body.appendChild(el('div', 'empty', '还没有历史输入')); return; }
      h.forEach(function (t) {
        var b = el('button', 'btn block', t.length > 70 ? t.slice(0, 70) + '…' : t);
        b.onclick = function () {
          promptInput.value = t;
          promptInput.focus();
          autoGrow();
          closeSheet();
        };
        body.appendChild(b);
      });
      var c = el('button', 'btn block', '🗑 清空历史');
      c.onclick = function () {
        try { localStorage.removeItem(HISTORY_KEY); } catch (e) { }
        closeSheet();
      };
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
    });
  }

  /* ── 审批 ───────────────────────────────────────────── */

  function showApproval(d) {
    activeApproval = d;
    approvalTool.textContent = '需要批准：' + (d.toolName || '工具');
    approvalReason.textContent = d.reason || '';
    approvalBar.classList.remove('hidden');
  }
  function hideApproval() {
    activeApproval = null;
    approvalBar.classList.add('hidden');
  }
  function answerApproval(approve) {
    if (!activeApproval) return;
    var id = activeApproval.id;
    var name = activeApproval.toolName;
    api('approval.answer', { id: id, approve: approve }).then(function () {
      addNote(approve ? '✅ 已允许 ' + name : '⛔ 已拒绝 ' + name);
      hideApproval();
    }).catch(function (e) {
      addNote('⚠ ' + e.message, true);
      hideApproval();
    });
  }

  /* ── 图片 ───────────────────────────────────────────── */

  function renderAttach() {
    attachBar.innerHTML = '';
    if (!pendingImages.length) { attachBar.classList.add('hidden'); return; }
    attachBar.classList.remove('hidden');
    pendingImages.forEach(function (img, i) {
      var w = el('div', 'thumb');
      var im = document.createElement('img');
      im.src = img.url;
      w.appendChild(im);
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
          mediaType: f.type,
          data: url.slice(comma + 1),   // 去掉 data:image/png;base64, 前缀
          name: f.name,
          url: url,                      // 仅用于本地预览
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
    var label = text.trim() || ('（' + pendingImages.length + ' 张图片）');
    addBubble('user', label);
    if (text.trim()) pushHistory(text.trim());

    var payload = { sessionId: current, text: text };
    if (pendingImages.length) {
      payload.images = pendingImages.map(function (i) {
        return { mediaType: i.mediaType, data: i.data, name: i.name };
      });
    }
    promptInput.value = '';
    autoGrow();
    pendingImages = []; renderAttach();

    api('session.prompt', payload)
      .catch(function (err) { addNote('⚠ 发送失败：' + err.message, true); })
      .then(function () { sendBtn.disabled = false; });
  };

  // 回车=换行（默认行为），Ctrl/Cmd+Enter=发送。刻意区分，避免手滑。
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
    token = null; current = null;
    sessions = []; titles = {};
    setMsg(pairMsg, '已断开，请重新扫码');
    show(pairView);
  }

  /* ── 启动 ───────────────────────────────────────────── */

  var fromUrl = new URLSearchParams(location.search).get('c');
  if (fromUrl) {
    codeInput.value = fromUrl.trim().toUpperCase();
    pair(codeInput.value);
  } else {
    try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { }
    if (token) {
      openStream();
      loadAll();
      show(listView);
    }
  }
})();
