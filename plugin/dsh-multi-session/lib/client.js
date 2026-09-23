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
  id: "@zjh18477514055/dsh-multi-session",
  factory: (require) => {
    "use strict";

    const React = require("react");
    const ReactDOM = require("react-dom");
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
      popover: null,      // 当前打开的下拉（模型/工作区）：{ rowKey, kind } —— 同屏只允许一个
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
    const diagnostics = { slots: {}, errors: [], clicks: 0, sends: [], at: new Date().toISOString() };

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
        results: null, menu: null, popover: null, notice: null, sending: false,
      });
    }
    function closeModal() { set({ open: false, menu: null, popover: null, notice: null }); }

    // ─────────────────────────────────────────────────────────────────────
    // 样式
    // ─────────────────────────────────────────────────────────────────────
    const CSS = `
.dshms-mask{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:rgba(0,0,0,.45)}
.dshms-panel{width:min(1320px,96vw);max-height:93vh;display:flex;flex-direction:column;
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
/* 定位由内联 style 的 menuStyle() 给（默认 position:fixed —— 见那里的注释：
   absolute 会被 .dshms-body / .dshms-row / .dshms-panel 三层的 overflow 裁掉，
   模型菜单的搜索框在最顶部，首当其冲）。这里的 absolute 只是**兜底**。 */
.dshms-menu{position:absolute;z-index:70;box-sizing:border-box;min-width:260px;max-width:520px;max-height:min(48vh,460px);overflow:auto;
  background:var(--dsw-alias-bg-layer-1,#1c1d21);border:1px solid var(--dsw-alias-border-l2,#36373b);
  border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.4);padding:4px}
.dshms-menu-item{display:flex;align-items:baseline;gap:8px;padding:6px 9px;border-radius:7px;cursor:pointer;font-size:12.5px}
.dshms-menu-item[data-active="1"]{background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.08))}
.dshms-menu-item .mi-name{font-weight:600;white-space:nowrap}
.dshms-menu-item .mi-hint{opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshms-menu-empty{padding:8px 9px;font-size:12px;opacity:.6}
/* ── 模型下拉里的搜索框 / 提供方胶囊 / 分组标题 ─────────────────────────
   与 src/inject/model-search.js 那套视觉同一语言（同样的圆角、同样的选中色 #4d6bfe），
   这样"官方菜单里的搜索"和"我们弹窗里的搜索"看起来是同一个东西。 */
.dshms-modelmenu{display:flex;flex-direction:column;padding:0;min-width:340px;max-width:560px}
.dshms-searchwrap{padding:7px;border-bottom:1px solid var(--dsw-alias-border-l2,#36373b);flex:none}
.dshms-search{width:100%;box-sizing:border-box;height:30px;padding:0 10px;font:inherit;font-size:12.5px;
  color:inherit;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));
  border:1px solid transparent;border-radius:8px;outline:none}
.dshms-search:focus{border-color:#4d6bfe;background:var(--dsw-alias-bg-layer-1,#1c1d21)}
.dshms-search::placeholder{color:var(--dsw-alias-label-tertiary,#8c959f)}
.dshms-pills{display:flex;flex-wrap:wrap;gap:6px;padding:7px;border-bottom:1px solid var(--dsw-alias-border-l2,#36373b);flex:none}
.dshms-pill{font:inherit;font-size:12px;line-height:20px;padding:0 9px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l2,#36373b);background:transparent;color:inherit;
  opacity:.75;cursor:pointer;white-space:nowrap}
.dshms-pill:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dshms-pill[data-on="1"]{background:#4d6bfe;border-color:#4d6bfe;color:#fff;opacity:1}
.dshms-menulist{max-height:min(46vh,440px);overflow:auto;padding:4px}
.dshms-group{font-size:11px;font-weight:600;opacity:.55;padding:7px 9px 3px}
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
    // 模型过滤器 —— **与 `src/inject/model-search.js` 同一套语义**
    //
    // 为什么强调"同一套"：那一段是给官方「选择模型」菜单加的搜索框与筛选胶囊，
    // 这里要给它一个**行为一致**的孪生版本。两处如果各写各的，用户会在两个地方
    // 遇到不同的筛选规则（例如"搜提供方名能不能整组显示"），那是无声的不一致。
    // 照抄的语义（逐条对照注入那一版的 `apply()`）：
    //   · 关键词命中**提供方名** ⇒ 该提供方整组显示（不是只显示组标题）
    //   · 关键词命中模型名 / label / 描述 ⇒ 该行显示
    //   · 提供方胶囊 = 精确筛选；**再点一次已选中的胶囊 = 取消**
    //   · 胶囊只在**提供方多于一个**时出现（只有一个时它没意义、白占地方）
    //   · 空态只在"确实加了筛选条件且一条不剩"时出现，并给一个「清空搜索与筛选」
    //   · 胶囊上的数字是**该提供方的全部条数**（不受关键词影响）
    // 唯一的差异（写在明处）：关键词的匹配面比那边多了一个 `description`
    // （那边是 `title + textContent`，取不到描述），所以本版**略宽松**。
    // ─────────────────────────────────────────────────────────────────────
    function filterModels(models, query, group) {
      const list = Array.isArray(models) ? models : [];
      const q = String(query || "").trim().toLowerCase();
      const providers = [];
      const byName = new Map();
      for (const m of list) {
        const name = m.provider || "(未知来源)";
        let p = byName.get(name);
        if (!p) { p = { name, count: 0 }; byName.set(name, p); providers.push(p); }
        p.count++;
      }
      const groups = [];
      let shown = 0;
      for (const p of providers) {
        if (group && p.name !== group) continue;
        const groupHit = !!q && p.name.toLowerCase().includes(q);
        const items = [];
        for (const m of list) {
          if ((m.provider || "(未知来源)") !== p.name) continue;
          const hay = ((m.label || "") + " " + m.model + " " + (m.description || "")).toLowerCase();
          if (!q || groupHit || hay.includes(q)) { items.push(m); shown++; }
        }
        if (items.length) groups.push({ name: p.name, items });
      }
      return { total: list.length, providers, groups, shown };
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

    /** 官方受理的图片媒体类型（`dsh-attachment/lib/types/types.d.ts:5`，别的类型在官方那里也抛错）。 */
    const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

    /** 一个浏览器 File 是不是官方受理的图片；是就返回它的 mediaType。 */
    function imageMediaTypeOf(file) {
      const t = (file && file.type) || "";
      return IMAGE_MEDIA_TYPES.indexOf(t) >= 0 ? t : null;
    }

    /**
     * 原始文件字节的 base64。
     * 与官方一致（`dsh-client-ui-conversation/lib/client.js` 的 `base64ImageOf`）：
     * 走浏览器原生 FileReader 的 dataURL，**去掉 `data:…;base64,` 前缀**；
     * 不做缩放、不重编码。大文件也这么传（体积上限在宿主侧，默认单图 20 MiB）。
     */
    function base64Of(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => {
          const url = String(r.result || "");
          const i = url.indexOf(",");
          if (i < 0) reject(new Error("读取图片失败：dataURL 形状不对"));
          else resolve(url.slice(i + 1));
        };
        r.onerror = () => reject(r.error || new Error("读取图片失败"));
        r.readAsDataURL(file);
      });
    }

    /**
     * 把一行的附件变成 `prompt()` 能吃的 wire parts。
     *
     * 两条规则（照官方做法，逐条有出处）：
     *   · 图片 → `{ type:'image', mediaType, data, name? }`，`data` 是原始字节的 base64：
     *     `dsh-attachment/lib/types/types.d.ts:74-82` 的 `EncodedImageAttachment`。
     *   · 其它文件 → 先用 `ctx.fileUpload.upload(sessionId, file, name)` 换 `receiptId`，
     *     再 `{ type:'file', receiptId }`。契约：`dsh-client-file-upload/lib/types/client/contract.d.ts:11-26`，
     *     返回 `{ receiptId, file }`（`lib/types/types.d.ts:11-18`）。
     *     ★ 凭据**只属于一个精确的 Session**（该包 README 的运行时不变式），所以要放在建完会话之后。
     */
    async function uploadParts(ctx, sessionId, files) {
      const parts = [];
      for (const f of files) {
        const mediaType = imageMediaTypeOf(f);
        if (mediaType !== null) {
          const part = { type: "image", mediaType, data: await base64Of(f) };
          if (f.name) part.name = f.name;
          parts.push(part);
          continue;
        }
        const fu = ctx.fileUpload;
        if (!fu || typeof fu.upload !== "function") {
          throw new Error("这个内核没提供 fileUpload，非图片附件传不上去");
        }
        set({ notice: `正在上传附件 ${f.name}…` });
        const res = await fu.upload(sessionId, f, f.name);
        if (res && res.ok === false) throw new Error(`上传「${f.name}」失败：${errText(res.error)}`);
        const v = res && res.ok !== undefined ? res.value : res;
        if (!v || !v.receiptId) throw new Error(`上传「${f.name}」没有返回凭据（receiptId）`);
        parts.push({ type: "file", receiptId: v.receiptId });
      }
      return parts;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 发送
    //
    // 一条路径，但每一步都"失败可归因"：建会话 →（选了模型才）选模型 → 附件变 wire parts
    // → `prompt()` 提交。结果里逐行写明走了什么（`via`）与哪一步失败（`error`/`modelNote`）。
    // 刻意**不用** `conversation.sendSession`：它是官方完整路径，但在"会话没有被跟随"时会
    // await 乐观回显直到永不结算 ⇒ 按钮卡死（详见 ④ 那段注释里的实测证据）。
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

      // ④ 送出去。
      //
      // ★★ 为什么**不用** `conversation.sendSession`（它虽然是"官方完整路径"）—— 实测证据：
      //    带附件那一行会让整个"一键发送"**永久卡住**：发送键一直显示"发送中…"，
      //    而宿主其实早就受理并落盘了（磁盘上找得到提示词与附件字节）。
      //    真因：`sendSession` 在**有附件**时会 `await` 乐观回显的"退休"（等持久事件或队列行出现），
      //    而本插件的会话是刚建出来、**没有被跟随**（没有 live 事件流订阅）⇒ 那个 await 可能永不结算。
      //    命令语义上这是"回显没确认"，不是"没发出去"，但界面上表现为**按钮卡死**，这是不可接受的。
      //    ⇒ 改用完成语义**有界**的路径：自己把附件传成 wire parts，再 `face.prompt(...)`
      //      （官方文档：prompt 的返回值是 "Receipt after one prompt enters the target Agent inbox"，
      //       即"宿主受理"为止，不等回显、不等回合）。
      //    代价：失去乐观回显（消息要等宿主的持久事件回来才出现在会话里）。这个交换是划算的。
      //
      // 附件变成 wire parts 的两条规则（照官方的做法，逐条有出处）：
      //   · 图片 → `{ type:'image', mediaType, data, name? }`
      //     `data` 是**原始文件字节的 base64**（官方就是 FileReader dataURL 去掉前缀，不做缩放）；
      //     `mediaType` 只认 png/jpeg/webp/gif 四种，其余在官方那里也是抛错的。
      //   · 其它文件 → 先 `ctx.fileUpload.upload(sessionId, file, name)` 拿凭据，再 `{ type:'file', receiptId }`
      //     （上传凭据**只属于一个精确的 Session**，所以必须放在建完会话之后）。
      //   · 顺序：**附件在前、文本在后**（官方原文 `[...attachments, ...[text]]`）。
      let via = null;
      try {
        const parts = files.length ? await uploadParts(ctx, sessionId, files) : [];
        if (text && text.trim()) parts.push({ type: "text", text });
        if (!parts.length) throw new Error("这一行既没有文本也没有有效附件");
        const res = await face.prompt(parts, "queue");
        if (res && res.ok === false) throw new Error(errText(res.error));
        via = files.length ? `prompt(+${files.length} 个附件)` : "prompt";
        return { index, key: row.key, sessionId, modelNote, via };
      } catch (e) {
        return { index, key: row.key, sessionId, modelNote, error: errText(e) };
      }
    }

    async function sendAll(ctx) {
      const rows = state.rows.slice();
      const sendable = rows.filter((r) => r.text.trim() || (r.files && r.files.length));
      if (!sendable.length) { set({ notice: "都是空的，先写点什么" }); return; }
      const ticket = { at: Date.now(), rows: rows.length, sendable: sendable.length, done: false, ok: 0, failed: 0, error: null };
      diagnostics.sends.push(ticket);
      set({ sending: true, notice: null, menu: null, popover: null });

      try {
        // 并行发。每行的失败被自己吞掉并记进结果，绝不让一行拖垮其它行。
        const settled = await Promise.all(sendable.map((row, i) => submitOneRow(ctx, row, i)));
        ticket.done = true;
        ticket.ok = settled.filter((r) => !r.error && !r.skipped).length;
        ticket.failed = settled.filter((r) => r.error).length;
        // notice 一定要清掉：否则上一阶段的提示（例如"正在上传附件…"）会**残留**在结果视图上方，
        // 本轮排查时它就把我引偏过一次（看到"正在等附件上传"以为还卡在那一步，其实早就过了）。
        set({ sending: false, results: settled, notice: null });
      } catch (e) {
        // ★ 兜底：**任何**异常都不许把界面卡在"发送中…"（否则发送键从此点不动，用户以为还在跑）。
        //   本轮实测出现过两次「磁盘上明明发出去了、界面却没切到结果视图」，原因未能完全定位
        //   ⇒ 至少保证失败可见、状态一定被复位，并记进 diagnostics.sends
        //     供 scripts/plugin-check.js 复现时定位（它能读 window.__dshMultiSession.diagnostics）。
        ticket.done = true;
        ticket.error = errText(e);
        set({ sending: false, notice: "发送过程出错：" + errText(e) });
      }
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
              open: true, results: null, notice: null, popover: null,
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
    /**
     * 下拉菜单（工作区 / 模型）的定位。
     *
     * ★ 为什么用 `position:fixed` 而不是 `absolute`（2026-09-20 用户实测暴露的真 bug）：
     *   原来的写法是 `absolute; bottom:120%`（向上弹），而祖先链上有**三层** overflow：
     *   `.dshms-body`(auto) → `.dshms-row`(hidden) → `.dshms-panel`(hidden)
     *   ⇒ 菜单超出部分被**从顶部裁掉**，而**模型菜单的搜索框正好在最顶部**，
     *   症状就是用户说的"重启了也看不到搜索框、列表展不开、像被周围 UI 挡住"。
     *   `fixed` 的包含块是视口，不受非 transform 祖先的 overflow 裁切
     *   （祖先链上没有 transform —— 同层的 `.dshms-mask` 本来就是 `fixed;inset:0` 且显示正常，
     *    所以视口坐标可靠）。
     *   拿不到坐标时退回原来的 absolute（至少还能用）。
     */
    function menuStyle(anchor, kind) {
      if (!anchor) return { position: "absolute", bottom: "120%", left: 0 };
      const PAD = 8;
      const wantW = kind === "model" ? 460 : 320;   // 与 CSS 的 min/max-width 对齐
      const wantH = kind === "model" ? 440 : 300;
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;
      const left = Math.max(PAD, Math.min(anchor.left, vw - wantW - PAD));
      const roomBelow = vh - anchor.bottom - PAD;
      const roomAbove = anchor.top - PAD;
      // 下面放得下就往下弹，否则往上弹 —— 哪边宽敞用哪边，不再一律向上
      const below = roomBelow >= Math.min(wantH, 240) || roomBelow >= roomAbove;
      const maxHeight = Math.max(160, Math.min(wantH, below ? roomBelow : roomAbove));
      return below
        ? { position: "fixed", top: Math.round(anchor.bottom + 6), left: Math.round(left),
            maxHeight: Math.round(maxHeight), zIndex: 80 }
        : { position: "fixed", bottom: Math.round(vh - anchor.top + 6), left: Math.round(left),
            maxHeight: Math.round(maxHeight), zIndex: 80 };
    }

    function RowView(props) {
      const { ctx, row, index, total, models, workspaces, popover } = props;
      const taRef = useRef(null);
      const searchRef = useRef(null);

      // 下拉（模型 / 工作区）：**状态提到 store 里**，不是本组件的 useState。
      // 两个理由：① 同屏只允许一个下拉开着（各自 useState 的话两行可以同时开着）；
      // ② 弹窗那层的 Esc 处理要能知道"现在有没有下拉开着"（否则按 Esc 会把整个弹窗关掉、
      //    把所有已写内容一起丢掉 —— 这是本轮顺手修掉的一个真 bug）。
      const showModels = !!(popover && popover.rowKey === row.key && popover.kind === "model");
      const showCwd = !!(popover && popover.rowKey === row.key && popover.kind === "cwd");
      const openPop = (kind, el) => {
        const same = popover && popover.rowKey === row.key && popover.kind === kind;
        // ★ 记下按钮的**视口坐标**：下拉用 position:fixed 定位，靠它算位置
        //   （为什么不能用 absolute，见 menuStyle 的注释）
        const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        set({ popover: same ? null : {
          rowKey: row.key, kind,
          anchor: r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null,
        } });
      };
      const closePop = () => set({ popover: null });

      // 模型筛选条件（关键词 + 提供方胶囊）与键盘选中项
      const [modelQuery, setModelQuery] = useState("");
      const [modelGroup, setModelGroup] = useState(null);
      const [modelActive, setModelActive] = useState(0);
      const clearModelFilter = () => { setModelQuery(""); setModelGroup(null); setModelActive(0); };

      const filtered = useMemo(() => filterModels(models, modelQuery, modelGroup), [models, modelQuery, modelGroup]);
      // 键盘可达项：第 0 项是「默认模型」，之后按分组顺序铺开（与显示顺序一致）
      const navItems = useMemo(() => {
        const out = [null];
        for (const g of filtered.groups) for (const m of g.items) out.push(m);
        return out;
      }, [filtered]);

      // 打开模型下拉就聚焦搜索框（官方菜单也是"能打字就能筛"）
      useEffect(() => {
        if (!showModels) return;
        const el = searchRef.current;
        if (el) { try { el.focus(); } catch { /* 拿不到焦点就算了 */ } }
      }, [showModels]);

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

      const pickModel = (m) => {
        setRow(row.key, { model: m });
        closePop();
        clearModelFilter();
      };

      // 模型下拉里的键盘操作：↑↓ 移动、Enter 选中、Esc **先清筛选条件**再关
      // （最后这条与 src/inject/model-search.js 一致：那边也是"再按一次才关"）
      const onModelKeyDown = (e) => {
        const n = Math.max(navItems.length, 1);
        if (e.key === "ArrowDown") { e.preventDefault(); setModelActive((i) => (i + 1) % n); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); setModelActive((i) => (i - 1 + n) % n); return; }
        if (e.key === "Enter") {
          e.preventDefault();
          const m = navItems[modelActive];
          if (m !== undefined) pickModel(m);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          if (modelQuery || modelGroup) clearModelFilter();
          else closePop();
        }
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
              onClick: (e) => openPop("cwd", e.currentTarget),
              children: (function () {
                const w = (workspaces || []).find((x) => x.workspaceId === row.workspaceId);
                if (w) return w.title;
                return row.cwd ? baseName(row.cwd) : "默认工作区";
              })(),
            }),
            showCwd ? h("div", { className: "dshms-menu", style: menuStyle(popover.anchor, "cwd") },
              h("div", {
                className: "dshms-menu-item", "data-active": !row.workspaceId ? "1" : "0",
                onClick: () => { setRow(row.key, { workspaceId: null }); closePop(); },
              },
              h("span", { className: "mi-name" }, "默认工作区"),
              h("span", { className: "mi-hint" }, row.cwd ? baseName(row.cwd) : "交给内核决定")),
              (workspaces || []).map((w, i) => h("div", {
                className: "dshms-menu-item", key: i,
                "data-active": row.workspaceId === w.workspaceId ? "1" : "0",
                title: w.path,
                onClick: () => { setRow(row.key, { workspaceId: w.workspaceId }); closePop(); },
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
              title: "这一行用哪个模型（可搜索、可按来源筛选）",
              onClick: (e) => openPop("model", e.currentTarget),
              children: modelLabel,
            }),
            showModels ? h("div", { className: "dshms-menu dshms-modelmenu", style: menuStyle(popover.anchor, "model") },
              // ── 搜索框（与官方菜单里那个同一套语义与视觉）──
              h("div", { className: "dshms-searchwrap" },
                h("input", {
                  ref: searchRef,
                  type: "search",
                  className: "dshms-search",
                  placeholder: "搜索模型或提供方…",
                  spellCheck: false,
                  autoComplete: "off",
                  value: modelQuery,
                  onChange: (e) => { setModelQuery(e.target.value); setModelActive(0); },
                  onKeyDown: onModelKeyDown,
                }),
              ),

              // ── 提供方筛选胶囊：只在提供方多于一个时出现 ──
              filtered.providers.length > 1
                ? h("div", { className: "dshms-pills" },
                    h("button", {
                      type: "button", className: "dshms-pill",
                      "data-on": modelGroup === null ? "1" : "0",
                      onClick: () => { setModelGroup(null); setModelActive(0); },
                    }, `全部 ${filtered.total}`),
                    filtered.providers.map((p) => h("button", {
                      type: "button", className: "dshms-pill", key: p.name, title: p.name,
                      "data-on": modelGroup === p.name ? "1" : "0",
                      // 再点一次已选中的胶囊 = 取消（与官方菜单那边一致）
                      onClick: () => { setModelGroup(modelGroup === p.name ? null : p.name); setModelActive(0); },
                    }, `${p.name} ${p.count}`)),
                  )
                : null,

              // ── 列表 ──
              h("div", { className: "dshms-menulist" },
                models === null
                  ? h("div", { className: "dshms-menu-empty" }, "拿不到模型目录（这个内核没提供）—— 只能用默认模型")
                  : (function () {
                      const rows = [];
                      let nav = 0;   // 与 navItems 同步前进：0 = 默认模型，其后按分组顺序
                      rows.push(h("div", {
                        className: "dshms-menu-item", key: "__default",
                        "data-active": nav === modelActive ? "1" : (row.model === null ? "" : "0"),
                        onMouseDown: (e) => e.preventDefault(),
                        onClick: () => pickModel(null),
                      },
                      h("span", { className: "mi-name" }, "默认模型"),
                      h("span", { className: "mi-hint" }, "不干预，用环境默认")));
                      nav++;
                      for (const g of filtered.groups) {
                        rows.push(h("div", { className: "dshms-group", key: "g:" + g.name },
                          `${g.name} (${g.items.length})`));
                        for (const m of g.items) {
                          const on = nav === modelActive ? "1"
                            : (row.model && row.model.model === m.model && row.model.provider === m.provider ? "1" : "0");
                          const idx = nav;
                          rows.push(h("div", {
                            className: "dshms-menu-item", key: g.name + "/" + m.model,
                            "data-active": on,
                            title: m.description || m.model,
                            onMouseDown: (e) => e.preventDefault(),
                            onMouseEnter: () => setModelActive(idx),
                            onClick: () => pickModel(m),
                          },
                          h("span", { className: "mi-name" }, m.label),
                          h("span", { className: "mi-hint" }, (m.efforts ? m.efforts.join("/") : m.model))));
                          nav++;
                        }
                      }
                      // 空态：只在"确实加了筛选条件且一条不剩"时出现（与官方菜单一致）
                      if ((modelQuery || modelGroup) && filtered.shown === 0 && filtered.total > 0) {
                        rows.push(h("div", { className: "dshms-menu-empty", key: "__empty" },
                          h("span", null, `没有匹配的模型（共 ${filtered.total} 个）`),
                          h("button", { type: "button", onClick: () => clearModelFilter() }, "清空搜索与筛选")));
                      }
                      return rows;
                    })(),
              ),
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

      // Esc 的**优先顺序**（这条很重要，别改回去）：
      //   ① 斜杠/引用菜单开着  → 交给 textarea 自己的 onKeyDown 处理（这里不动）
      //   ② 有下拉开着（模型/工作区）→ **只关下拉**，不关弹窗
      //   ③ 都没有            → 才关弹窗
      // ★ ② 是这一轮修掉的真 bug：原来只判断 ①，于是模型下拉开着时按 Esc 会把**整个弹窗
      //   关掉** —— 用户刚写好的 N 条提示词一起没了。
      useEffect(() => {
        if (!st.open) return;
        const onKey = (e) => {
          if (e.key !== "Escape") return;
          if (state.menu) return;
          if (state.popover) {
            // 事件来自下拉**内部** ⇒ 让下拉自己走两级 Esc（先清筛选条件，再关下拉），
            // 这样在搜索框里按 Esc 是"取消搜索"而不是"把下拉整个关掉"——与官方菜单一致。
            if (e.target && typeof e.target.closest === "function" && e.target.closest(".dshms-menu")) return;
            e.stopPropagation();
            set({ popover: null });
            return;
          }
          e.stopPropagation();
          closeModal();
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
      }, [st.open]);

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
            st.rows.map((row, i) => h(RowView, { key: row.key, ctx, row, index: i, total: st.rows.length, models: models === undefined ? null : models, workspaces: st.scope.workspaces, popover: st.popover })),
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

      // ★ 刻意**不用**官方 primitives 的 `Modal` 包一层（第一版用了，实测踩坑）：
      //   官方 `Modal` 自己在 `document` 上挂了 keydown 监听，按 Escape 就调它的 `onClose`。
      //   于是"在搜索框里按 Esc"会沿着冒泡走到那个监听上，**把整个弹窗关掉、把已写好的
      //   N 条提示词一起丢掉** —— 而我的捕获处理里那条"让下拉自己处理"的分支是不阻断事件的。
      //   自己画遮罩就没有这个第二来源：Esc 只由我这一处决定（见上面 effect 里的三级优先顺序）。
      //   覆盖能力不受影响：`.dshms-mask` 是 `position:fixed; inset:0; z-index:9999`。
      //   另外遮罩**故意不响应点击关闭** —— 点空白就丢草稿太容易误触。
      //
      // ★★ 为什么要 portal 到 `document.body`（2026-09-20 用户实测暴露的**第二个**真 bug）：
      //   本插件注册在 `shell.overlay` 槽位，而**那一层是 z-index:20**
      //   ⇒ 任何 z-index > 20 的官方 UI 都会**盖在我们弹窗上面**。实测抓到的活例：
      //   官方那个"0.1 开发者预览"对话框是 `position:fixed; z-index:1000`，它正好压住
      //   模型下拉的搜索框 —— 在搜索框中心做 `elementFromPoint` 命中的是它的 `<p>`，
      //   而不是我们的 input。用户的原话就是"还会被周围的 UI 阻挡住"。
      //   挂到 body 之后，遮罩直接在**根层叠上下文**里跟官方对话框比大小（9999 > 1000）；
      //   而且 body 上没有 transform ⇒ 里面那些 `position:fixed` 下拉的坐标与视口严格一致。
      const mask = h("div", { className: "dshms-mask", tabIndex: -1 },
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
      );
      // 理论上 `document.body` 一定在；真拿不到就退回原地渲染，至少还能用
      return document.body ? ReactDOM.createPortal(mask, document.body) : mask;
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
      "slots", "sessions", "conversation", "fileUpload",
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
              open: true, results: null, notice: null, popover: null,
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
