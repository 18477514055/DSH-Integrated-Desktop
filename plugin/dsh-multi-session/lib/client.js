/**
 * dsh-multi-session —— 浏览器半边（客户端插件）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个文件是什么
 * ═══════════════════════════════════════════════════════════════════════════
 * 一个"多会话同时开工"的大弹窗：弹窗里有 N 个输入框（默认 1 个，点「新增会话」加），
 * 每个输入框都是一个独立提示词（可带附件、可各自选模型），弹窗**右下角一键发送** ——
 * 一次创建 N 个会话并把 N 条提示词分别发出去，它们并行跑。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么是"客户端插件"而不是"注入脚本"（这是本次的关键架构判断）
 * ═══════════════════════════════════════════════════════════════════════════
 * 本仓库原有的做法是往官方页面里注入 JS（见 `src/inject/model-search.js`）。那对"改一个已存在
 * 的 DOM"够用，但**要创建会话、要发消息、要拿模型目录，就必须拿到官方的一等公民服务**。
 * 官方给插件作者的正规入口是这个（本机已有 4 个活例：dsh-plugin-install / dsh-crosshub /
 * dsh-qoder-connect / dsh-connect-workbuddy）：
 *
 *     window.__ModuleLoader__.load({ id, factory: (require) => { ...; return {name, inject, apply} } })
 *
 * 装法见 `scripts/install-plugin.js`；能力边界与依据见同目录 README。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 已核实的官方契约（每条都有出处，勿凭记忆改）
 * ═══════════════════════════════════════════════════════════════════════════
 * ① 平台共享模块表只有 9 个词（`dsh-web-frontend/dist/assets/index-*.js` 里 `function by()`）：
 *      react / react/jsx-runtime / react-dom / react-dom/client / @deepseek-ai/cordis /
 *      dsh-client-store / dsh-client-ui-slots / dsh-client-ui-primitives / dsh-client-ui-dockkit
 *    ⇒ `require()` 只能要这几个（加上别的插件包 id）。**Lexical 不在其中**，所以官方那套
 *      富文本编辑器拿不到 ⇒ 文本面只能用 textarea 自己实现。
 * ② 注册 UI：`ctx.slots.inject(槽位名, () => ctx.slots.register({name, id, order, label}, 组件))`。
 *    ★ 必须写成**方法调用**（`ctx.slots.inject(...)`）；摘成局部变量会让 `this.ctx` 丢失
 *      （dsh-crosshub 踩过这个坑，源码里留了注释）。槽位由父级 entry 声明，声明前 register
 *      会**同步抛错** ⇒ 必须包在 inject 回调里。
 * ③ 槽位（61 个里挑的两个）：
 *      `shell.overlay`            list / root    —— 全帧浮动层、z-index 20、默认点击穿透，
 *                                                    "新 id 是叠加而非替换"，正是弹窗的家。
 *      `conversation.input.right` list / session —— "发送键之前的紧凑控件"，正是按钮的家。
 * ④ 创建会话：`ctx.sessions.create({workspaceId}) -> Promise<SessionId>`。
 *    官方保证：promise 解析时该会话已进列表且 binding 可解析（`service.d.ts` 的 resolution guarantee）。
 *    ⚠ `sessions` 命名空间**没有 delete** ⇒ 绝不能在用户没决定发送时就建会话，否则取消会留下
 *      一堆删不掉的空会话（本实现因此把建会话推迟到"一键发送"那一刻）。
 * ⑤ 发送（官方完整路径，含乐观回显/图片编码/文件凭据/结算）：
 *      `ctx.conversation.createDrafts(sessionId, File[]) -> ComposerAttachment[]`
 *      `ctx.conversation.sendSession(sessionFace, text, draftIds, 'queue') -> SubmitOutcome`
 *    退路（更底层但更稳）：`binding.session.prompt([{type:'text',text}],'queue')`。
 * ⑥ 选模型：`ctx.remote.session.selectModel({sessionId, provider, model, reasoningEffort?})`。
 * ⑦ 样式：往 `<head>` 插 `<style data-plugin data-plugin-css>`，用 `ctx.effect` 管生命周期
 *    （四个第三方插件与官方自己的包都是这个写法；模块系统会认领这些标签做 HMR）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 诚实的边界（README 里也写了一遍，别把它说成"和官方 1:1"）
 * ═══════════════════════════════════════════════════════════════════════════
 * - 文本面是 textarea，不是官方的 Lexical 编辑器：没有引用 chip 的原子节点、没有装饰器。
 * - `/` 与 `@` 菜单是本插件自己弹的；能列出候选并插入文本，但不是官方那套 popup 组件。
 * - 每行是"提示词 + 附件 + 模型"，没有权限预设 / Agent 预设 / Plan 模式（不在本次范围内）。
 */

window.__ModuleLoader__.load({
  id: "dsh-multi-session",
  factory: (require) => {
    "use strict";

    const React = require("react");
    const P = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    // ─────────────────────────────────────────────────────────────────────
    // 常量
    // ─────────────────────────────────────────────────────────────────────
    const PLUGIN_ID = "dsh-multi-session";
    const CSS_ID = PLUGIN_ID + "/multi-session.css";
    const TRIGGER_SLOT = "conversation.input.right";
    const MODAL_SLOT = "shell.overlay";
    const TRIGGER_ID = "multi-session-trigger";
    const MODAL_ID = "multi-session-modal";
    const MAX_ROWS = 12;
    const MAX_FILES_PER_ROW = 10;

    // ─────────────────────────────────────────────────────────────────────
    // 小工具
    // ─────────────────────────────────────────────────────────────────────

    /** 安全取一个**可选**的 cordis 服务：没注入也不炸，拿不到就是 null。 */
    function optional(ctx, name) {
      try {
        const v = ctx.get(name);
        return v === undefined || v === null ? null : v;
      } catch {
        return null;
      }
    }

    /** 错误转成一句人话（内核的 RemoteResult 错误常是 {code,message}）。 */
    function errText(e) {
      if (e === undefined || e === null) return "未知错误";
      if (typeof e === "string") return e;
      if (e.message) return e.message;
      if (e.error && (e.error.message || e.error.code)) return (e.error.code ? e.error.code + ": " : "") + (e.error.message || "");
      try { return JSON.stringify(e); } catch { return String(e); }
    }

    let seq = 0;
    const nextKey = () => "r" + (++seq);

    /** 目录名（用于按钮上的短标签）。Windows 与 POSIX 分隔符都认。 */
    function baseName(p) {
      if (typeof p !== "string" || !p) return "";
      const s = p.replace(/[\\/]+$/, "");
      const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
      return i >= 0 ? s.slice(i + 1) || s : s;
    }

    /** 两个路径是不是同一个（Windows 大小写不敏感、分隔符混用）。 */
    function samePath(a, b) {
      if (typeof a !== "string" || typeof b !== "string") return false;
      const norm = (s) => s.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
      return norm(a) === norm(b);
    }

    function newRow(cwd, workspaceId) {
      return {
        key: nextKey(), text: "", files: [], model: null,
        cwd: cwd || null, workspaceId: workspaceId || null, pendingCaret: null,
      };
    }

    /**
     * 读"当前会话的目录"与"已知目录清单"。
     *
     * 依据（`dsh-api-session-controller/lib/types/client/sessions/service.d.ts:32-66`）：
     *   `SessionSummary` 有 `cwd?: string`（**没有** workspaceId）；
     *   `SessionListState = { ids, byId, current, ... }`。
     * 而 `ISessions.create(opts)` 接受 `{ workspaceId?, cwd?, sessionId? }`（同包 `contract/sessions.d.ts:33-37`），
     * 且 workspaceId 与 cwd **互斥**（宿主会报 `gateway/bad-request`）。
     * ⇒ 新会话跟随当前会话的 cwd 是最贴切的默认；顺手把列表里出现过的不同 cwd 收集成"目录候选"。
     */
    function readScope(ctx) {
      const out = { cwd: null, sessionId: null };
      try {
        const snap = ctx.sessions && ctx.sessions.list && typeof ctx.sessions.list.getSnapshot === "function"
          ? ctx.sessions.list.getSnapshot()
          : null;
        if (snap) {
          const cur = snap.current !== undefined && snap.byId ? snap.byId[snap.current] : null;
          if (cur) {
            out.sessionId = cur.id !== undefined ? cur.id : snap.current;
            if (typeof cur.cwd === "string" && cur.cwd) out.cwd = cur.cwd;
          }
        }
      } catch { /* 读不到就用默认（宿主自选目录） */ }
      return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 状态（模块级 store；组件用 useSyncExternalStore 订阅）
    //
    // 为什么不用 useState：弹窗挂在 shell.overlay（root 作用域），而触发按钮挂在
    // conversation.input.right（session 作用域）—— 两个槽位是**两棵 React 树**，
    // 没有共同的 React 祖先可以放 state。所以状态必须活在模块作用域。
    // ─────────────────────────────────────────────────────────────────────
    let state = {
      open: false,
      rows: [newRow()],
      sending: false,
      results: null,      // 发送后的结果清单（非 null 时弹窗显示结果而不是输入框）
      scope: { cwd: null, sessionId: null, workspaceId: null, workspaces: [] },   // 打开弹窗那一刻的上下文
      menu: null,         // 当前打开的斜杠/引用菜单 { rowKey, kind, token, items, active }
      notice: null,
    };
    const listeners = new Set();

    /**
     * 诊断记录。
     *
     * ★ 为什么必须有（不是给测试专用的）：槽位注册失败会被**静默吞掉** ——
     *   `ctx.slots.register` 在"槽位还没被父级声明"时是**同步抛错**的，而错误一旦没人接，
     *   表现就是"bundle 加载了、服务端全好、界面上一个挂载点都没有，且没有任何报错"。
     *   dsh-crosshub 的源码里留着这个事故的注释（它当时用 safeRegister 吞掉了一切，
     *   结果六个座位全没挂上）。所以这里把每一次注册的结果**记下来**，并挂到 window 上，
     *   让"没挂上"变成可查的事实而不是沉默。
     */
    const diagnostics = { slots: {}, errors: [], clicks: 0, at: new Date().toISOString() };

    function recordSlot(id, ok, message) {
      diagnostics.slots[id] = ok ? { ok: true } : { ok: false, message: String(message || "") };
      if (!ok) { diagnostics.errors.push(id + ": " + String(message || "")); }
    }

    /** 真的去注册；失败记下来但**不让插件整体挂掉**（另一半功能还能用）。 */
    function safeRegister(ctx, options, component) {
      try {
        const d = ctx.slots.register(options, component);
        recordSlot(options.id, true);
        return typeof d === "function" ? d : () => {};
      } catch (e) {
        recordSlot(options.id, false, (e && e.message) ? e.message : String(e));
        return () => {};
      }
    }

    function getState() { return state; }
    function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    function emit() { for (const fn of Array.from(listeners)) { try { fn(); } catch { /* 一个订阅者炸了不该拖垮别人 */ } } }
    function set(patch) { state = Object.assign({}, state, patch); emit(); }
    function useStore() { return React.useSyncExternalStore(subscribe, getState, getState); }

    function setRow(key, patch) {
      set({ rows: state.rows.map((r) => (r.key === key ? Object.assign({}, r, patch) : r)) });
    }
    function addRow() {
      if (state.rows.length >= MAX_ROWS) { set({ notice: `最多 ${MAX_ROWS} 个，够了 :)` }); return; }
      set({ rows: state.rows.concat([newRow(state.scope.cwd, state.scope.workspaceId)]), results: null });
    }
    function removeRow(key) {
      if (state.rows.length <= 1) return;
      set({ rows: state.rows.filter((r) => r.key !== key), results: null });
    }
    function resetRows() {
      set({
        rows: [newRow(state.scope.cwd, state.scope.workspaceId)],
        results: null, menu: null, notice: null, sending: false,
      });
    }
    function closeModal() { set({ open: false, menu: null, notice: null }); }

    // ─────────────────────────────────────────────────────────────────────
    // 样式
    // ─────────────────────────────────────────────────────────────────────
    const CSS = `
.dshms-mask{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:rgba(0,0,0,.45)}
.dshms-panel{width:min(1080px,94vw);max-height:88vh;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-layer-1,#1c1d21);color:var(--dsw-alias-label-primary,#e8e8ea);
  border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:14px;
  box-shadow:0 18px 60px rgba(0,0,0,.45);overflow:hidden}
.dshms-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l2,#36373b);flex:none}
.dshms-title{font-size:15px;font-weight:600;margin:0}
.dshms-sub{font-size:12px;opacity:.6;margin-left:2px}
.dshms-x{margin-left:auto;flex:none}
.dshms-body{padding:14px 18px;overflow:auto;display:flex;flex-direction:column;gap:12px;min-height:180px}
.dshms-row{border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.02));
  display:flex;flex-direction:column;overflow:hidden}
.dshms-row:focus-within{border-color:var(--dsw-alias-state-success-primary,#5b9dff)}
.dshms-rowhead{display:flex;align-items:center;gap:8px;padding:7px 10px;font-size:12px;opacity:.75;border-bottom:1px solid var(--dsw-alias-border-l2,#36373b)}
.dshms-idx{font-variant-numeric:tabular-nums;font-weight:600;opacity:.9}
.dshms-rhead-right{margin-left:auto;display:flex;align-items:center;gap:6px}
.dshms-ta{width:100%;box-sizing:border-box;border:0;outline:none;resize:none;background:transparent;color:inherit;
  font:inherit;font-size:13.5px;line-height:1.6;padding:10px 12px;min-height:76px;max-height:220px;overflow:auto}
.dshms-bar{display:flex;align-items:center;gap:8px;padding:7px 10px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);flex-wrap:wrap}
.dshms-chip{display:inline-flex;align-items:center;gap:6px;max-width:260px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:999px;padding:3px 8px;background:rgba(255,255,255,.03)}
.dshms-chip b{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshms-chip button{all:unset;cursor:pointer;opacity:.6;padding:0 2px}
.dshms-chip button:hover{opacity:1}
.dshms-foot{display:flex;align-items:center;gap:10px;padding:13px 18px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);flex:none}
.dshms-foot-right{margin-left:auto;display:flex;align-items:center;gap:10px}
.dshms-hint{font-size:12px;opacity:.6}
.dshms-err{color:var(--dsw-alias-state-error-primary,#ff6b6b);font-size:12px}
.dshms-ok{color:var(--dsw-alias-state-success-primary,#4ade80);font-size:12px}
.dshms-menu{position:absolute;z-index:70;min-width:260px;max-width:520px;max-height:260px;overflow:auto;
  background:var(--dsw-alias-bg-layer-1,#1c1d21);border:1px solid var(--dsw-alias-border-l2,#36373b);
  border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.4);padding:4px}
.dshms-menu-item{display:flex;align-items:baseline;gap:8px;padding:6px 9px;border-radius:7px;cursor:pointer;font-size:12.5px}
.dshms-menu-item[data-active="1"]{background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.08))}
.dshms-menu-item .mi-name{font-weight:600;white-space:nowrap}
.dshms-menu-item .mi-hint{opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshms-menu-empty{padding:8px 9px;font-size:12px;opacity:.6}
.dshms-res{display:flex;flex-direction:column;gap:8px;font-size:13px}
.dshms-res-row{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:9px;padding:9px 11px}
.dshms-res-msg{opacity:.85;white-space:pre-wrap;word-break:break-word}
.dshms-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;opacity:.75}
.dshms-select{background:var(--dsw-alias-bg-layer-2,#26272b);color:inherit;border:1px solid var(--dsw-alias-border-l2,#36373b);
  border-radius:7px;padding:3px 6px;font:inherit;font-size:12px;max-width:280px}
`;

    function installCss(ctx) {
      return ctx.effect(() => {
        if (typeof document === "undefined") return () => {};
        if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) return () => {};
        const tag = document.createElement("style");
        tag.dataset.plugin = PLUGIN_ID;
        tag.dataset.pluginCss = CSS_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      }, PLUGIN_ID + ": styles");
    }

    // ─────────────────────────────────────────────────────────────────────
    // 模型目录（每行可各自选模型）
    //
    // 官方契约（见文件头 ⑥）：`ctx.remote.session.selectModel({sessionId, provider, model,
    // reasoningEffort?})`；`ModelSelection = {provider, model, reasoningEffort?}`。
    // 目录条目形状的**来源**在这里做了两手准备：优先问官方的逐会话模型目录
    // （`ctx.modelDirectories.directoryFor(sessionId)`，dsh-client-ui-model-selection 提供），
    // 拿不到就退回 `ctx.remote.session.modelCatalog`。两者都拿不到时，模型下拉只显示
    // "用默认" —— **绝不编造模型名**（本机小模型编造文件内容的事故是前车之鉴）。
    // ─────────────────────────────────────────────────────────────────────
    const modelCache = { at: 0, items: null };

    /**
     * 把官方 `ModelCatalog` 归一成扁平列表。
     *
     * 官方形状（`dsh-api-session-controller/lib/types/types.d.ts:108-133`，已逐行核对）：
     *   ModelCatalog = { default: ModelSelection, routableProviders: string[],
     *                    groups: ModelProviderGroup[], failures: ModelCatalogFailure[] }
     *   ModelProviderGroup = { id, name, models: ModelCatalogModel[] }
     *   ModelCatalogModel  = { id, name, description?, reasoning?: { efforts: [{id,name,description?}], defaultEffort? } }
     * ★ 注意是 **groups**（我第一版按 providers/models 猜的，是错的 —— 归一化函数就是为这种
     *   版本差异准备的：认不出形状就返回 null，宁可没有下拉也不给错的下拉）。
     */
    function normalizeCatalog(raw) {
      const v = raw && raw.ok !== undefined ? raw.value : raw;
      if (!v || typeof v !== "object") return null;
      const out = [];
      const pushGroup = (gid, gname, list) => {
        for (const m of list || []) {
          const id = m && (m.id || m.model || m.name);
          if (typeof id !== "string" || !id) continue;
          const efforts = m && m.reasoning && Array.isArray(m.reasoning.efforts)
            ? m.reasoning.efforts.map((e) => (e && (e.id || e.name)) || "").filter(Boolean)
            : null;
          out.push({
            provider: String(gid || ""),
            model: id,
            label: (m && (m.name || m.label)) || id,
            description: (m && m.description) || "",
            efforts,
            defaultEffort: (m && m.reasoning && m.reasoning.defaultEffort) || null,
          });
        }
      };
      if (Array.isArray(v.groups)) {
        for (const g of v.groups) pushGroup(g && g.id, g && g.name, g && g.models);
      } else if (Array.isArray(v.providers)) {
        for (const p of v.providers) pushGroup(p && (p.id || p.provider), p && p.name, p && p.models);
      } else if (Array.isArray(v.models)) {
        pushGroup(null, null, v.models);
      }
      return out.length ? { items: out, def: v.default || null } : null;
    }

    /**
     * 取模型目录。
     *
     * ★ 出处的关键一条：`session/modelCatalog` **不需要 sessionId**
     *   （`typert.remote-client.d.ts:23` `modelCatalog: () => Promise<RemoteResult<ModelCatalog>>`；
     *    宿主文档 `types/catalog.d.ts:4` 明写 "Build the browser model catalog without requiring a Session"）。
     *   所以每行的模型下拉可以在**建会话之前**就有内容 —— 这正是本插件敢"发送时才建会话"的前提之一。
     *   而 `selectModel` **要** sessionId，所以选中的模型是在建完会话之后才应用的。
     */
    async function loadModels(ctx) {
      if (modelCache.items && Date.now() - modelCache.at < 60000) return modelCache.items;
      try {
        const rs = ctx.remote && ctx.remote.session;
        if (rs && typeof rs.modelCatalog === "function") {
          const res = await rs.modelCatalog();
          const norm = normalizeCatalog(res);
          if (norm) { modelCache.items = norm; modelCache.at = Date.now(); return norm; }
        }
      } catch { /* 拿不到就没有下拉 */ }
      return null;
    }

    // ─────────────────────────────────────────────────────────────────────
    // `/` 命令目录 与 `@` 文件引用
    //
    // 同样"拿不到就不显示"，不编造。命令来源与引用来源都是官方服务；两者都需要一个
    // **会话作用域**（官方契约如此），所以这里用"打开弹窗那一刻的当前会话"作作用域 ——
    // 默认情况下新会话与当前会话同工作区，所以候选是对的。
    // ─────────────────────────────────────────────────────────────────────
    async function loadCommands(ctx) {
      const sid = state.scope.sessionId;
      // ★ 官方契约：`commands.list(agentId, …)` 的**第一个位置参数**就是 sessionId
      //   （`dsh-commands/lib/typert.remote-client.d.ts:10-13` `list: (agentId: SessionId) => …`；
      //    官方调用点 `dsh-client-ui-commands/lib/client.js@19216` `ctx.remote.commands.list(sessionId)`）。
      //   没有会话作用域 ⇒ 拿不到，直接如实返回 null（不编造菜单）。
      if (!sid) return null;
      try {
        const rc = ctx.remote && ctx.remote.commands;
        if (rc && typeof rc.list === "function") {
          const res = await rc.list(sid);
          if (res && res.ok === false) return null;
          const v = res && res.ok !== undefined ? res.value : res;
          const arr = Array.isArray(v) ? v : null;
          if (arr) {
            return arr.map((c) => ({
              // CommandDescriptor = { name（不带斜杠）, description, input?: { hint, attachments? } }
              name: String((c && c.name) || ""),
              hint: String((c && c.description) || ""),
              takesInput: !!(c && c.input),
            })).filter((c) => c.name);
          }
        }
      } catch { /* 没有就没有 */ }
      return null;
    }

    async function loadReferences(ctx, query) {
      const sid = state.scope.sessionId;
      // ★ 同样是位置参数，且 sessionId **必填**：
      //   `fileReferences.list(agentId, query, signal)`
      //   （`dsh-api-session-controller/lib/typert.remote-client.d.ts:11-13`；
      //    官方调用点 `dsh-client-ui-reference/lib/client.js@4090`）。
      //   返回 FileReferenceCandidate = { path, kind: 'file'|'directory' }（只有路径，没有 name）。
      if (!sid) return null;
      try {
        const rf = ctx.remote && ctx.remote.fileReferences;
        if (rf && typeof rf.list === "function") {
          const res = await rf.list(sid, query === undefined ? "" : query);
          if (res && res.ok === false) return null;
          const v = res && res.ok !== undefined ? res.value : res;
          const arr = Array.isArray(v) ? v : null;
          if (arr) {
            return arr.map((r) => {
              const p = String((r && r.path) || "");
              const kind = (r && r.kind) || "file";
              return { path: p, kind, mention: formatFileMention(p, kind), label: p };
            }).filter((r) => r.path);
          }
        }
      } catch { /* 没有就没有 */ }
      return null;
    }

    /**
     * 文件提及的字面形式 —— 照抄官方的 6 行语法。
     *
     * 出处：`dsh-file-reference/lib/types/grammar.d.ts:32` 的 `formatFileMention`，
     * 运行时原文在 `dsh-client-ui-reference/lib/client.js@857`。为什么必须重写而不是 require：
     * `@deepseek-ai/dsh-file-reference` **不在平台共享模块表里**，插件 require 不到。
     * 规则：含空白 ⇒ 加引号；目录 ⇒ 路径尾部补 `/`；目录且含空白 ⇒ 只加左引号（`@"dir/`），
     * 因为引用会一直补全到目录内部。含控制字符或双引号 ⇒ 无法表达，返回 null。
     */
    function formatFileMention(path, kind) {
      if (typeof path !== "string" || !path) return null;
      const p = kind === "directory" ? path.replace(/[\\/]*$/, "") + "/" : path;
      if (/[\u0000-\u001f\u007f-\u009f"]/u.test(p)) return null;
      if (!/\s/u.test(p)) return "@" + p;
      if (kind === "directory") return '@"' + p;
      return '@"' + p + '"';
    }

    /**
     * 等文件附件后台上传完成。
     *
     * ★ 为什么必须等（2026-09-21 实测抓到的真错，原文）：
     *     conversation.sendSession: one or more files have not finished uploading
     *   官方契约：**"files upload on pick, not on send"**（`contract/slots.d.ts:37`）——
     *   `createDrafts()` 一调用就在后台上传，而 `sendSession()` 要求它们已经传完。
     *   官方输入框是靠"上传没完就把发送键禁掉"来规避的（`uploadsPending`），
     *   而本插件是"一键发 N 行"，不能靠禁用，只能**在这里等**。
     *
     * 状态出处：`ConversationController.fileUploads: SnapshotStore<Record<draftId, DraftFileUpload>>`，
     * 而 `DraftFileUpload = {status:'uploading',loaded,total?} | {status:'ready',receiptId,file} | {status:'error',message}`
     * （`contract/slots.d.ts:38-51`）。图片**不会**出现在这个表里（图片在发送时才 base64 编码），所以只等 file 类。
     */
    async function waitForUploads(conv, drafts, timeoutMs = 120000) {
      const fileIds = drafts.filter((d) => d && d.kind === "file" && d.id !== undefined).map((d) => d.id);
      if (!fileIds.length) return;
      const store = conv.fileUploads;
      if (!store || typeof store.getSnapshot !== "function") return;   // 拿不到状态就不硬等，让 sendSession 自己报错
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const snap = store.getSnapshot() || {};
        let pending = 0;
        for (const id of fileIds) {
          const st = snap[id];
          if (!st) { pending++; continue; }
          if (st.status === "error") throw new Error("附件上传失败：" + (st.message || "未知原因"));
          if (st.status !== "ready") pending++;
        }
        if (pending === 0) return;
        if (Date.now() > deadline) throw new Error(`等附件上传超时（还有 ${pending} 个没传完）`);
        set({ notice: `正在等附件上传完成（还有 ${pending} 个）…` });
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // 发送
    //
    // 分层：能走官方完整路径就走；任何一环缺失/失败就退到更底层的 prompt()。
    // 每一层都记进结果里（`via` 字段），这样"到底走通了哪条路"是可查的，而不是猜的。
    // ─────────────────────────────────────────────────────────────────────
    async function submitOneRow(ctx, row, index) {
      const text = row.text;
      const files = row.files || [];
      const hasText = text.trim().length > 0;

      if (!hasText && files.length === 0) {
        return { index, key: row.key, skipped: true, message: "这一行是空的，已跳过" };
      }

      // ① 建会话（**只在这一刻**建 —— sessions 没有 delete，早建会留下删不掉的空会话）
      //    官方契约：workspaceId 与 cwd **互斥**（宿主直接报 gateway/bad-request），
      //    优先 workspaceId；没选工作区时退回当前会话的 cwd。
      //    ⚠ 刻意**不用** `uiWorkspace.connectWorkspace()`：它会**复用该工作区里已存在的空会话**
      //      （官方源码里逐条找 `blank && cwd === workspace.path`），N 行会被塌缩成一个会话。
      let sessionId;
      try {
        const opts = row.workspaceId ? { workspaceId: row.workspaceId } : (row.cwd ? { cwd: row.cwd } : {});
        sessionId = await ctx.sessions.create(opts);
      } catch (e) {
        return { index, key: row.key, error: "创建会话失败：" + errText(e) };
      }

      // ② 选模型（失败不算致命：会话已经建好了，用默认模型继续）
      let modelNote = null;
      if (row.model && row.model.provider && row.model.model) {
        try {
          const rs = ctx.remote && ctx.remote.session;
          if (!rs || typeof rs.selectModel !== "function") throw new Error("当前内核没有 selectModel");
          const payload = { sessionId, provider: row.model.provider, model: row.model.model };
          if (row.model.reasoningEffort) payload.reasoningEffort = row.model.reasoningEffort;
          const res = await rs.selectModel(payload);
          if (res && res.ok === false) throw new Error(errText(res.error));
        } catch (e) {
          modelNote = "模型没选上（用默认模型继续）：" + errText(e);
        }
      }

      // ③ 拿到会话面
      let face = null;
      try {
        const b = ctx.sessions.binding(sessionId);
        face = b ? b.session : null;
      } catch { /* 下面报错 */ }
      if (!face) {
        return { index, key: row.key, sessionId, modelNote, error: "会话已创建，但拿不到它的会话面（binding 为空）" };
      }

      // ④ 送出去：优先官方完整路径（含乐观回显 / 图片编码 / 文件凭据 / 结算）
      //    `conversation.createDrafts` 与 `conversation.sendSession` 在 ConversationController
      //    的类声明里有（不是 IConversation 接口面），所以用 typeof 探，探不到就换路子。
      const conv = ctx.conversation;
      let via = null;
      try {
        if (typeof conv.createDrafts === "function" && typeof conv.sendSession === "function") {
          // 两个调用分开归因 —— 否则出错时分不清是"暂存附件"还是"提交"失败，
          // 而这两者的修法完全不同（前者是附件管线的用法问题，后者是提交路径的问题）。
          let drafts = [];
          if (files.length) {
            try {
              drafts = conv.createDrafts(sessionId, files);
            } catch (e) {
              throw new Error("createDrafts 失败：" + errText(e));
            }
          }
          const ids = drafts.map((d) => d && d.id).filter((x) => x !== undefined);
          if (files.length && ids.length !== files.length) {
            throw new Error(`createDrafts 返回了 ${drafts.length} 项但只有 ${ids.length} 项带 id`);
          }
          // ★ 必须等后台上传完成（见 waitForUploads 的注释：官方原文是
          //   "one or more files have not finished uploading"）
          try {
            await waitForUploads(conv, drafts);
          } catch (e) {
            throw new Error("等附件上传失败：" + errText(e));
          }
          let outcome;
          try {
            outcome = await conv.sendSession(face, text, ids, "queue");
          } catch (e) {
            throw new Error("sendSession 抛出：" + errText(e));
          }
          if (outcome && outcome.kind === "error") throw new Error("sendSession 返回错误：" + errText(outcome.error));
          if (outcome && outcome.ok === false) throw new Error("sendSession 返回错误：" + errText(outcome));
          via = files.length ? `sendSession(带 ${ids.length} 个附件)` : "sendSession";
          return { index, key: row.key, sessionId, modelNote, via };
        }
      } catch (e) {
        // 落到 ⑤；把 ④ 的失败原因留下（诊断用）
        modelNote = (modelNote ? modelNote + "；" : "") + "官方完整路径失败，已退到 prompt()：" + errText(e);
      }

      // ⑤ 退路：只能发文本（附件在这一层不支持 —— 明确说出来，不假装成功）
      try {
        if (files.length) {
          throw new Error("这条路不支持附件（要附件请检查内核是否提供 conversation.sendSession）");
        }
        const res = await face.prompt([{ type: "text", text }], "queue");
        if (res && res.ok === false) throw new Error(errText(res.error));
        via = "prompt()";
        return { index, key: row.key, sessionId, modelNote, via };
      } catch (e) {
        return { index, key: row.key, sessionId, modelNote, error: errText(e) };
      }
    }

    async function sendAll(ctx) {
      const rows = state.rows.slice();
      const sendable = rows.filter((r) => r.text.trim() || (r.files && r.files.length));
      if (!sendable.length) { set({ notice: "都是空的，先写点什么" }); return; }
      set({ sending: true, notice: null, menu: null });

      // 并行发。每行的失败被自己吞掉并记进结果，绝不让一行拖垮其它行。
      const settled = await Promise.all(sendable.map((row, i) => submitOneRow(ctx, row, i)));
      set({ sending: false, results: settled });
    }

    // ─────────────────────────────────────────────────────────────────────
    // 触发菜单（`/` 与 `@`）
    // ─────────────────────────────────────────────────────────────────────
    const MENU_MAX = 8;

    function detectToken(text, caret) {
      // 从光标往前找到空白/换行，得到"当前词"
      let i = caret;
      while (i > 0 && !/[\s\n]/.test(text[i - 1])) i--;
      const token = text.slice(i, caret);
      const start = i;
      if (token.startsWith("/") && start === 0) return { kind: "command", token, start, end: caret };
      if (token.startsWith("@")) return { kind: "reference", token, start, end: caret };
      return null;
    }

    async function openMenu(ctx, row, textarea) {
      const text = row.text;
      const caret = textarea && textarea.selectionStart !== undefined ? textarea.selectionStart : text.length;
      const found = detectToken(text, caret);
      if (!found) { if (state.menu) set({ menu: null }); return; }
      const query = found.token.slice(1);

      let items = null;
      if (found.kind === "command") {
        const all = await loadCommands(ctx);
        if (all) {
          const q = query.toLowerCase();
          items = all.filter((c) => !q || c.name.toLowerCase().includes(q)).slice(0, MENU_MAX)
            .map((c) => ({ id: "cmd:" + c.name, insert: "/" + c.name + " ", name: "/" + c.name, hint: c.hint }));
        }
      } else {
        const all = await loadReferences(ctx, query);
        if (all) {
          items = all.slice(0, MENU_MAX).map((r) => ({
            id: "ref:" + r.path,
            insert: (r.mention || ("@" + r.path)) + " ",
            name: r.label || r.path,
            hint: r.kind === "directory" ? "目录" : "文件",
          }));
        }
      }

      if (!items) {
        // 候选源拿不到：明说，而不是弹一个空菜单让人以为是"没有匹配"
        set({ menu: { rowKey: row.key, kind: found.kind, token: found.token, start: found.start, end: found.end, items: [], active: 0, unavailable: true } });
        return;
      }
      if (!items.length) { set({ menu: null }); return; }
      set({ menu: { rowKey: row.key, kind: found.kind, token: found.token, start: found.start, end: found.end, items, active: 0, unavailable: false } });
    }

    function applyMenuItem(row, menu, item) {
      const text = row.text;
      const next = text.slice(0, menu.start) + item.insert + text.slice(menu.end);
      const caret = menu.start + item.insert.length;
      // 把目标光标位置一起写进 state —— RowView 里的 effect 会把它落到真实 textarea 上，
      // 否则 React 重渲染后光标会跳到末尾（用户选了命令却丢了原来的位置）。
      setRow(row.key, { text: next, pendingCaret: caret });
      set({ menu: null });
      return caret;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 组件：触发按钮（conversation.input.right）
    // ─────────────────────────────────────────────────────────────────────
    function TriggerButton(props) {
      // ★ 必须把 ctx 从 props 里取出来用 —— 第一版直接在 onClick 里写 `ctx`，
      //   而那个名字在函数作用域里并不存在 ⇒ ReferenceError 被 React 的事件回调吞掉，
      //   表现就是"按钮在、点了没反应、控制台什么都不说"。
      //   scripts/plugin-check.js 第一轮就是靠"点击计数 + onClick 内 catch 记录"把它抓出来的。
      const ctx = props.ctx;
      const sessionId = props && props.sessionId ? props.sessionId : null;

      // ★ 刻意**不**继承槽位 owner 传来的 `disabled`。
      //   理由：这个按钮的行为与"当前会话能不能发消息"无关 —— 它只是打开一个弹窗，
      //   而弹窗自己会新建会话。把 owner 的 disabled 传下来会导致"当前会话忙碌/未就绪时
      //   按钮变灰、点不动"，而那恰恰是最想用它的时候。
      //   （第一版就是继承了它 —— scripts/plugin-check.js 实测点了没反应，state.open 仍是 false。
      //     这类"按钮在、但点不动"只有真跑才看得出来。）

      // ★ 工作区列表走官方的标准 prop `useWorkspaces`（由 `dsh-client-ui-workspace` 通过
      //   `ctx.slots.provideRoot({ hooks: { workspaces: list } })` 提供，插件不需要 import）。
      //   它是个 hook ⇒ 必须在组件里**无条件**调用。官方自己就是 `useWorkspaces((s) => s)`
      //   （`dsh-client-ui-workspace/lib/client.js` 与 `dsh-client-ui-conversation/lib/client.js` 实测原文）。
      //   同一个槽位的 props 形状是稳定的，所以调用顺序不会变。
      const useWs = props && typeof props.useWorkspaces === "function" ? props.useWorkspaces : null;
      const wsSnap = useWs ? useWs((s) => s) : null;
      const wsItems = wsSnap && Array.isArray(wsSnap.items) ? wsSnap.items : [];
      // 只留三个字段：workspaceId / path / title（官方 WorkspaceView 的字段名，不是 id/name）
      const workspaces = wsItems
        .filter((w) => w && typeof w.workspaceId === "string")
        .map((w) => ({ workspaceId: w.workspaceId, path: w.path || "", title: w.title || w.path || w.workspaceId }));

      return h(P.Button, {
        variant: "ghost",
        size: "sm",
        title: "多会话同时开工（一个大弹窗里写 N 条提示词，一键发出）",
        "aria-label": "多会话同时开工",
        icon: h(P.IconQueueOutline14, null),
        onClick: () => {
          diagnostics.clicks++;
          try {
            // 记下"打开那一刻的上下文"：
            //   sessionId   —— 命令/文件引用候选要一个会话作用域（官方契约如此，两者都必填 sessionId）；
            //   cwd         —— 当前会话所在目录（建会话时的兜底目标，以及匹配默认工作区用）；
            //   workspaceId —— 默认工作区（路径与当前会话 cwd 相同的那个，否则第一个）；
            //   workspaces  —— 供每行切换。
            const sc = readScope(ctx);
            const def = workspaces.find((w) => w.path && sc.cwd && samePath(w.path, sc.cwd)) || workspaces[0] || null;
            const workspaceId = def ? def.workspaceId : null;
            const rows = state.rows.length ? state.rows : [newRow(sc.cwd, workspaceId)];
            set({
              open: true, results: null, notice: null,
              scope: { sessionId: sessionId || sc.sessionId || null, cwd: sc.cwd, workspaceId, workspaces },
              rows,
            });
          } catch (e) {
            // ★ 不吞异常：记进 diagnostics（第一版这里如果抛错，表现就是"按钮在、点了没反应、
            //   控制台什么都不说"——scripts/plugin-check.js 第一轮实测就是这个现象）
            diagnostics.errors.push("trigger onClick: " + errText(e));
            set({ notice: "打开失败：" + errText(e) });
          }
        },
        children: "多会话",
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // 组件：一行输入框
    // ─────────────────────────────────────────────────────────────────────
    function RowView(props) {
      const { ctx, row, index, total, models, workspaces, onMenu } = props;
      const taRef = useRef(null);
      const [showModels, setShowModels] = useState(false);
      const [showCwd, setShowCwd] = useState(false);

      // 自动增高
      useEffect(() => {
        const el = taRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, 220) + "px";
      }, [row.text]);

      // 落光标（菜单插入之后）
      useEffect(() => {
        const el = taRef.current;
        if (!el || row.pendingCaret === null || row.pendingCaret === undefined) return;
        const pos = row.pendingCaret;
        setRow(row.key, { pendingCaret: null });
        try { el.focus(); el.setSelectionRange(pos, pos); } catch { /* 拿不到就算了 */ }
      }, [row.pendingCaret]);

      const onKeyDown = (e) => {
        const menu = state.menu;
        if (menu && menu.rowKey === row.key && menu.items.length) {
          if (e.key === "ArrowDown") { e.preventDefault(); set({ menu: Object.assign({}, menu, { active: (menu.active + 1) % menu.items.length }) }); return; }
          if (e.key === "ArrowUp") { e.preventDefault(); set({ menu: Object.assign({}, menu, { active: (menu.active - 1 + menu.items.length) % menu.items.length }) }); return; }
          if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyMenuItem(row, menu, menu.items[menu.active]); return; }
          if (e.key === "Escape") { e.preventDefault(); set({ menu: null }); return; }
        }
        // ★ 刻意**不**让 Enter 单行发送：本弹窗的语义是"写完 N 行一起发"，
        //   行内 Enter 必须是换行，否则会出现"某一行偷偷先跑了"。
        //   Ctrl/Cmd+Enter = 一键发送（与右下角按钮同义）。
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void sendAll(ctx); }
      };

      const onFilePick = (list) => {
        const files = Array.from(list || []).slice(0, MAX_FILES_PER_ROW - row.files.length);
        if (!files.length) return;
        setRow(row.key, { files: row.files.concat(files) });
      };

      const modelLabel = row.model ? row.model.label || row.model.model : "默认模型";

      return h("div", { className: "dshms-row" },
        h("div", { className: "dshms-rowhead" },
          h("span", { className: "dshms-idx" }, "会话 " + (index + 1)),
          h("span", { className: "dshms-rhead-right" },
            total > 1 ? h(P.Button, {
              variant: "ghost", size: "sm", icon: h(P.IconTrashOutline16, null),
              title: "删掉这一行（不会删掉任何会话）",
              onClick: () => removeRow(row.key),
            }) : null,
          ),
        ),

        h("textarea", {
          ref: taRef,
          className: "dshms-ta",
          value: row.text,
          placeholder: index === 0
            ? "写提示词…… 输入 / 选命令、@ 引用文件；Ctrl+Enter 一键发送"
            : "另一个会话的提示词……",
          onChange: (e) => {
            const el = e.target;
            const next = el.value;
            setRow(row.key, { text: next });
            void openMenu(ctx, Object.assign({}, row, { text: next }), el);
          },
          onKeyDown,
          onClick: (e) => { void openMenu(ctx, row, e.target); },
          onBlur: () => { /* 菜单靠 Esc / 选择 / 光标离开词来关，不用 blur 关（blur 会先于点击触发） */ },
        }),

        row.files.length ? h("div", { className: "dshms-bar" },
          row.files.map((f, i) => h("span", { className: "dshms-chip", key: i },
            h(P.IconPaperclipOutline16, null),
            h("b", { title: f.name }, f.name),
            h("button", { title: "移除", onClick: () => setRow(row.key, { files: row.files.filter((_, j) => j !== i) }) }, "×"),
          )),
        ) : null,

        h("div", { className: "dshms-bar" },
          h("label", { className: "dshms-chip", style: { cursor: "pointer" }, title: "加附件（图片会随提示词一起发；其它文件先上传拿凭据）" },
            h(P.IconPaperclipOutline16, null),
            h("b", null, "附件"),
            h("input", {
              type: "file", multiple: true, style: { display: "none" },
              onChange: (e) => { onFilePick(e.target.files); e.target.value = ""; },
            }),
          ),

          h("span", { style: { position: "relative" } },
            h(P.Button, {
              variant: "ghost", size: "sm", icon: h(P.IconFolderOpenOutline16, null),
              title: "这一行在哪个工作区开工",
              onClick: () => setShowCwd((v) => !v),
              children: (function () {
                const w = (workspaces || []).find((x) => x.workspaceId === row.workspaceId);
                if (w) return w.title;
                return row.cwd ? baseName(row.cwd) : "默认工作区";
              })(),
            }),
            showCwd ? h("div", { className: "dshms-menu", style: { position: "absolute", bottom: "120%", left: 0 } },
              h("div", {
                className: "dshms-menu-item", "data-active": !row.workspaceId ? "1" : "0",
                onClick: () => { setRow(row.key, { workspaceId: null }); setShowCwd(false); },
              },
              h("span", { className: "mi-name" }, "默认工作区"),
              h("span", { className: "mi-hint" }, row.cwd ? baseName(row.cwd) : "交给内核决定")),
              (workspaces || []).map((w, i) => h("div", {
                className: "dshms-menu-item", key: i,
                "data-active": row.workspaceId === w.workspaceId ? "1" : "0",
                title: w.path,
                onClick: () => { setRow(row.key, { workspaceId: w.workspaceId }); setShowCwd(false); },
              },
              h("span", { className: "mi-name" }, w.title),
              h("span", { className: "mi-hint" }, w.path))),
              (workspaces || []).length === 0
                ? h("div", { className: "dshms-menu-empty" }, "读不到工作区列表 —— 新会话跟随当前会话所在目录")
                : null,
            ) : null,
          ),

          h("span", { style: { position: "relative" } },
            h(P.Button, {
              variant: "ghost", size: "sm", icon: h(P.IconChevronDownOutline14, null),
              title: "这一行用哪个模型（选中后：先建会话再选模型，最后才发）",
              onClick: () => setShowModels((v) => !v),
              children: modelLabel,
            }),
            showModels ? h("div", { className: "dshms-menu", style: { position: "absolute", bottom: "120%", left: 0 } },
              h("div", {
                className: "dshms-menu-item", "data-active": row.model === null ? "1" : "0",
                onClick: () => { setRow(row.key, { model: null }); setShowModels(false); },
              }, h("span", { className: "mi-name" }, "默认模型"), h("span", { className: "mi-hint" }, "不干预，用环境默认")),
              models === null
                ? h("div", { className: "dshms-menu-empty" }, "拿不到模型目录（这个内核没提供）—— 只能用默认模型")
                : models.map((m, i) => h("div", {
                    className: "dshms-menu-item", key: i,
                    "data-active": row.model && row.model.model === m.model && row.model.provider === m.provider ? "1" : "0",
                    onClick: () => { setRow(row.key, { model: m }); setShowModels(false); },
                  },
                  h("span", { className: "mi-name" }, m.label),
                  h("span", { className: "mi-hint" }, m.provider + (m.efforts ? " · " + m.efforts.join("/") : "")),
                )),
            ) : null,
          ),

          row.text ? h(P.Button, {
            variant: "ghost", size: "sm", title: "清空这一行", icon: h(P.IconCloseOutline16, null),
            onClick: () => { setRow(row.key, { text: "", files: [] }); set({ menu: null }); },
          }) : null,
        ),

        // 触发菜单（定位在行内，跟着这一行走）
        state.menu && state.menu.rowKey === row.key
          ? h("div", { className: "dshms-menu", style: { position: "relative", margin: "0 10px 8px" } },
              state.menu.unavailable
                ? h("div", { className: "dshms-menu-empty" }, `拿不到${state.menu.kind === "command" ? "命令" : "文件引用"}候选（这个内核没提供对应服务）`)
                : state.menu.items.map((it, i) => h("div", {
                    className: "dshms-menu-item", key: it.id, "data-active": i === state.menu.active ? "1" : "0",
                    onMouseDown: (e) => { e.preventDefault(); applyMenuItem(row, state.menu, it); taRef.current && taRef.current.focus(); },
                  },
                  h("span", { className: "mi-name" }, it.name),
                  it.hint ? h("span", { className: "mi-hint" }, it.hint) : null,
                )),
            )
          : null,
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // 组件：弹窗（shell.overlay）
    // ─────────────────────────────────────────────────────────────────────
    function MultiSessionModal(props) {
      const st = useStore();
      const ctx = props && props.ctx;
      const [models, setModels] = useState(undefined);   // undefined=还没取, null=取不到, []=空

      // 打开时取一次模型目录
      useEffect(() => {
        if (!st.open) return;
        let alive = true;
        void (async () => {
          const m = await loadModels(ctx);
          if (alive) setModels(m ? m.items : null);   // null = 这个内核没提供目录
        })();
        return () => { alive = false; };
      }, [st.open, st.scope.sessionId]);

      // Esc 关闭
      useEffect(() => {
        if (!st.open) return;
        const onKey = (e) => { if (e.key === "Escape" && !state.menu) { e.stopPropagation(); closeModal(); } };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
      }, [st.open]);

      const onKey = (e) => {
        if (e.key === "Escape" && !state.menu) closeModal();
      };

      if (!st.open) return null;

      const failed = st.results ? st.results.filter((r) => r.error).length : 0;
      const okCount = st.results ? st.results.filter((r) => !r.error && !r.skipped).length : 0;

      const body = st.results
        ? h("div", { className: "dshms-res" },
            h("div", { style: { fontSize: 13 } },
              okCount ? `已创建并发出 ${okCount} 个会话。` : "没有会话被创建。",
              failed ? ` ${failed} 行失败。` : "",
            ),
            st.results.map((r, i) => h("div", { className: "dshms-res-row", key: r.key || i },
              h("span", { style: { flex: "none" } }, r.error ? h(P.IconWarningOutline16, null) : (r.skipped ? h(P.IconQuestionOutline14, null) : h(P.IconCheckOutline16, null))),
              h("div", { style: { minWidth: 0 } },
                h("div", { className: "dshms-res-msg" }, r.error ? r.error : (r.skipped ? r.message : "已发出")),
                r.sessionId ? h("div", { className: "dshms-mono" }, r.sessionId) : null,
                r.via ? h("div", { className: "dshms-mono" }, "路径：" + r.via) : null,
                r.modelNote ? h("div", { className: "dshms-mono" }, r.modelNote) : null,
              ),
            )),
          )
        : h(React.Fragment, null,
            st.rows.map((row, i) => h(RowView, { key: row.key, ctx, row, index: i, total: st.rows.length, models: models === undefined ? null : models, workspaces: st.scope.workspaces })),
            st.rows.length < MAX_ROWS
              ? h("div", null, h(P.Button, {
                  variant: "outline", size: "sm", icon: h(P.IconPlusOutline16, null),
                  title: "再加一个会话输入框",
                  onClick: () => addRow(),
                  children: "新增会话",
                }))
              : null,
          );

      const foot = st.results
        ? h(React.Fragment, null,
            h("span", { className: "dshms-hint" }, "新会话已经出现在左侧列表里，正在并行跑。"),
            h("span", { className: "dshms-foot-right" },
              h(P.Button, { variant: "ghost", onClick: () => resetRows(), children: "再开一批" }),
              h(P.Button, { variant: "primary", onClick: () => closeModal(), children: "关闭" }),
            ),
          )
        : h(React.Fragment, null,
            h("span", { className: "dshms-hint" },
              st.rows.length > 1 ? `${st.rows.length} 条提示词 → ${st.rows.length} 个新会话，并行跑` : "1 条提示词 → 1 个新会话",
            ),
            st.notice ? h("span", { className: "dshms-err" }, st.notice) : null,
            h("span", { className: "dshms-foot-right" },
              h(P.Button, {
                variant: "primary",
                disabled: st.sending,
                icon: st.sending ? h(P.IconLoadingOutline16, null) : h(P.IconSendOutline16, null),
                title: "创建 N 个会话并把每行发出去（Ctrl+Enter）",
                onClick: () => void sendAll(ctx),
                children: st.sending ? "发送中…" : "一键发送",
              }),
            ),
          );

      // 用 primitives 的 Modal + headless：遮罩、Esc、portal 到 body 都用官方的，
      // 内容完全自己画（这样才有"大弹窗"的自由度）。
      return h(P.Modal, {
        open: true,
        onClose: () => closeModal(),
        headless: true,
        className: "dshms-panel-wrap",
      },
        h("div", { className: "dshms-mask", onKeyDown: onKey, tabIndex: -1 },
          h("div", { className: "dshms-panel", role: "dialog", "aria-modal": "true", "aria-label": "多会话同时开工" },
            h("div", { className: "dshms-head" },
              h("h2", { className: "dshms-title" }, "多会话同时开工"),
              h("span", { className: "dshms-sub" }, "每个输入框 = 一个新会话"),
              h("span", { className: "dshms-x" },
                h(P.Button, { variant: "ghost", size: "sm", icon: h(P.IconCloseOutline16, null), title: "关闭", onClick: () => closeModal() }),
              ),
            ),
            h("div", { className: "dshms-body" }, body),
            h("div", { className: "dshms-foot" }, foot),
          ),
        ),
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // 插件本体
    // ─────────────────────────────────────────────────────────────────────
    const name = PLUGIN_ID;

    // ★ 只 inject **确定存在**的服务 —— cordis 的 inject 是"等这个服务出现才跑 apply"，
    //   写进一个不存在的服务名 = 插件永远不 apply = 界面上什么都没有，且没有报错。
    //   这里每一个都有出处：`slots`（renderer）、`sessions`（api-session-controller 客户端半边）、
    //   `conversation`（ui-conversation）、`remote` + `remote.*` 命名空间（api-gateway / api-remotes）——
    //   `remote.commands` 与 `remote.fileReferences` 由官方自己 inject（dsh-client-ui-commands /
    //   dsh-client-ui-reference 的 inject 列表里逐字可见），所以不是猜的。
    const inject = [
      "slots", "sessions", "conversation",
      "remote", "remote.session", "remote.commands", "remote.fileReferences",
    ];

    function apply(ctx) {
      installCss(ctx);

      // 触发按钮：主输入框右侧、发送键之前
      ctx.slots.inject(TRIGGER_SLOT, () => safeRegister(ctx,
        { name: TRIGGER_SLOT, id: TRIGGER_ID, order: 50, label: "多会话" },
        (props) => h(TriggerButton, Object.assign({}, props, { ctx })),
      ));

      // 大弹窗：全帧浮动层
      ctx.slots.inject(MODAL_SLOT, () => safeRegister(ctx,
        { name: MODAL_SLOT, id: MODAL_ID, order: 50 },
        () => h(MultiSessionModal, { ctx }),
      ));

      // 调试钩子：让"没挂上 / 没渲染"变成可查的事实（也供 scripts/plugin-check.js 用）
      try {
        globalThis.__dshMultiSession = {
          plugin: PLUGIN_ID,
          diagnostics,
          state: () => state,
          // 与按钮同一条路径地打开（会重新采一次 scope），便于自动化验证绕过按钮本身
          open: () => {
            const sc = readScope(ctx);
            set({
              open: true, results: null, notice: null,
              scope: { sessionId: sc.sessionId, cwd: sc.cwd, workspaceId: state.scope.workspaceId, workspaces: state.scope.workspaces },
              rows: state.rows.length ? state.rows : [newRow(sc.cwd, state.scope.workspaceId)],
            });
          },
          close: () => closeModal(),
          addRow: () => addRow(),
          reset: () => resetRows(),
          send: () => sendAll(ctx),
        };
      } catch { /* 没有 window 就算了（不该发生） */ }
    }

    return { name, inject, apply };
  },
});
