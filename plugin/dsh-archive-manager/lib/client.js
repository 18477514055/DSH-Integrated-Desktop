/**
 * dsh-int-archive-manager —— 浏览器半边（客户端插件）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个插件做一件什么事
 * ═══════════════════════════════════════════════════════════════════════════
 * 在侧边栏**新增一个顶层分组**「已归档」（与"两个工作区 + 未分组"并列，成为第 4 个），
 * 点进去是归档管理器：搜索框（标题 + 正文）、按天筛选、每条可永久删除（送回收站，需二次确认）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 界面是怎么挂上去的（**两条槽位，缺一不可**）
 * ═══════════════════════════════════════════════════════════════════════════
 *   ① `sidebar.panellist`（kind: list, scope: root）
 *      → 侧边栏"全局面板"区多出一行：图标 + 「已归档」标题。
 *      出处：`dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:39-43`，
 *      以及内核内嵌的槽位手册 `dsh-cordis-client-runner/lib/client.js:4116-4158`。
 *      ★ 这是**唯一**能新增"侧边栏顶层行"的槽位 —— `sidebar.workspaces` 是
 *        `kind: single`（官方 WorkspaceBrowser 独占，注册即**替换**掉整个会话列表），
 *        我们绝不能碰它。这一点是本次最关键的架构判断。
 *
 *   ② `main`（kind: keyed, scope: root）
 *      → 点那一行时，中间的大面板显示我们的归档管理器。
 *      ★ 关键机制：`panellist` 的 `id` 与 `main` 的 `key` **必须是同一个字符串**
 *        （`slots.d.ts:95` 的 `id: MainPanelId`，手册里 "Each list id addresses the matching
 *        main panel"）。内核的 `layout.selectPanel(id)` 会校验这个 id 在 main 槽位里
 *        真的注册过（`dsh-client-ui-layout/lib/client.js:413`：没注册就抛
 *        `main panel "x" is not registered`）。所以两条注册**成对存在**，不能只写一条。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 数据从哪来
 * ═══════════════════════════════════════════════════════════════════════════
 * 浏览器里读不到磁盘，所以归档清单走 HTTP 问宿主半边：`GET /dsh-archive/list.json`
 * （宿主用 `ctx.webServer.register` 挂的，与已装插件 `dsh-whale-widget` 同一套做法）。
 * 删除走 `POST /dsh-archive/remove`。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 已核实的官方契约（每条都有出处，勿凭记忆改）
 * ═══════════════════════════════════════════════════════════════════════════
 * ① 平台共享模块表只有 9 个词 ⇒ `require()` 只能用：
 *      react / react/jsx-runtime / react-dom / react-dom/client / @deepseek-ai/cordis /
 *      dsh-client-store / dsh-client-ui-slots / dsh-client-ui-primitives / dsh-client-ui-dockkit
 *    （`dsh-web-frontend/dist/assets/index-*.js` 的 `function by()`；
 *      multi-session 插件文件头第 26-30 行也记了同一条）
 * ② `ctx.slots.inject(槽位名, () => ctx.slots.register({...}, 组件))` —— **必须方法调用形式**，
 *    摘成局部变量会丢 `this.ctx`（dsh-crosshub 踩过）。槽位未被父级声明时 register
 *    **同步抛错**，所以必须包在 inject 回调里。
 * ③ `usePanelInfo` 是标准注入 prop（手册 `standardProps` 里逐字列出），
 *    用它读当前选中的面板 —— 比自己存 state 可靠（面板切换可能来自托盘/快捷键）。
 * ④ 样式：往 `<head>` 插 `<style data-plugin data-plugin-css>`，用 `ctx.effect` 管生命周期。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 从 multi-session 插件继承来的硬教训（**每一条都是真踩出来的**）
 * ═══════════════════════════════════════════════════════════════════════════
 * · **大弹窗必须 portal 到 document.body**：`shell.overlay` 那层是 z-index:20，
 *   任何 z-index>20 的官方 UI 会盖在我们上面（实测官方"开发者预览"对话框是 z-index:1000）。
 * · **不用官方 `primitives.Modal` 当最外层**：它在 document 上挂 Escape 监听会调 onClose
 *   ⇒ 在搜索框里按 Esc 会把整个弹窗关掉、丢掉输入。
 * · **下拉菜单不用 absolute**（会被三层 overflow 祖先裁掉）；本插件的菜单用 fixed 定位。
 * · **不继承槽位 owner 传来的 `disabled`**：会话忙时按钮会变灰，而那正是最想用的时候。
 * · **槽位注册失败必须记进 diagnostics**，不许静默吞 —— 否则表现是"bundle 加载了、
 *   界面一个挂载点都没有、且不报错"。
 */

window.__ModuleLoader__.load({
  id: "dsh-int-archive-manager",
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
    const PLUGIN_ID = "dsh-int-archive-manager";
    const CSS_ID = PLUGIN_ID + "/archive-manager.css";

    /**
     * 面板 id —— 必须同时用作 `sidebar.panellist` 的 id 与 `main` 的 key。
     * ★ 字符串里不能有特殊字符：它会出现在槽位键里，也会进 aria 标签。
     */
    const PANEL_ID = "dsh-int-archive-manager";
    const PANELIST_SLOT = "sidebar.panellist";
    const MAIN_SLOT = "main";
    const PANEL_LABEL = "已归档";

    const PANELIST_ICON_ID = PANEL_ID + "-icon";
    const PANEL_BODY_ID = PANEL_ID + "-body";
    const CONFIRM_ID = PANEL_ID + "-confirm";

    const API_LIST = "/dsh-archive/list.json";
    const API_PLAN = "/dsh-archive/plan.json";
    const API_REMOVE = "/dsh-archive/remove";
    const API_CONFIG = "/dsh-archive/config.json";
    const API_SET_CONFIG = "/dsh-archive/config";
    const API_TRASH = "/dsh-archive/trash.json";
    const API_RESTORE = "/dsh-archive/restore";
    const API_PURGE = "/dsh-archive/purge";

    // ─────────────────────────────────────────────────────────────────────
    // 诊断（别静默吞失败 —— 见文件头教训）
    // ─────────────────────────────────────────────────────────────────────
    const diagnostics = {
      slots: {}, errors: [],
      api: { lastList: null, lastRemove: null },
      at: new Date().toISOString(),
    };

    function recordSlot(id, ok, message) {
      diagnostics.slots[id] = ok ? { ok: true } : { ok: false, message: String(message || "") };
      if (!ok) diagnostics.errors.push(id + ": " + String(message || ""));
    }

    function safeRegister(ctx, options, component) {
      try {
        const d = ctx.slots.register(options, component);
        recordSlot(options.id || options.key || "(unnamed)", true);
        return typeof d === "function" ? d : () => {};
      } catch (e) {
        recordSlot(options.id || options.key || "(unnamed)", false, (e && e.message) ? e.message : String(e));
        return () => {};
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // 小工具
    // ─────────────────────────────────────────────────────────────────────

    function errText(e) {
      if (e === undefined || e === null) return "未知错误";
      if (typeof e === "string") return e;
      if (e.message) return e.message;
      if (e.error && (e.error.message || e.error.code)) return (e.error.code ? e.error.code + ": " : "") + (e.error.message || "");
      try { return JSON.stringify(e); } catch { return String(e); }
    }

    function fmtBytes(n) {
      if (typeof n !== "number" || !isFinite(n)) return "-";
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      return (n / 1024 / 1024).toFixed(2) + " MB";
    }

    /**
     * 取「本地日期」的 YYYY-MM-DD。
     *
     * ★ **不能用 toISOString()**：那是 UTC。实测本机 UTC+8，
     *   `2026-09-18 05:30` 本地时间的 UTC 串是 `2026-09-17T21:30Z`
     *   ⇒ 用 UTC 算日期会把晚上/早上的会话**算到前一天去**。
     *   "按天筛选"算错一天，用户就会以为"我那天明明有对话，怎么筛不出来"。
     */
    function dayKey(ms) {
      if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return null;
      const d = new Date(ms);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return y + "-" + m + "-" + day;
    }

    function fmtDayLabel(key) {
      if (!key) return "未知日期";
      const p = key.split("-");
      if (p.length !== 3) return key;
      return Number(p[1]) + " 月 " + Number(p[2]) + " 日";
    }

    function fmtTime(ms) {
      if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "-";
      const d = new Date(ms);
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }

    // ─────────────────────────────────────────────────────────────────────
    // 远端数据
    // ─────────────────────────────────────────────────────────────────────

    async function fetchJson(url, options) {
      const res = await fetch(url, Object.assign({ credentials: "same-origin" }, options || {}));
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = { ok: false, error: "响应不是 JSON：" + text.slice(0, 120) }; }
      if (!res.ok && json && json.ok !== false) json.ok = false;
      return json;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 样式
    // ─────────────────────────────────────────────────────────────────────
    const CSS = `
.dsham-panel{height:100%;display:flex;flex-direction:column;box-sizing:border-box;
  padding:18px 22px;gap:14px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-1,#14151a);color:var(--dsw-alias-label-primary,#e8e8ea)}
.dsham-head{display:flex;align-items:baseline;gap:10px;flex:none}
.dsham-title{font-size:16px;font-weight:600;margin:0}
.dsham-sub{font-size:12px;opacity:.6}
.dsham-spacer{margin-left:auto}
.dsham-btn{font:inherit;font-size:12.5px;line-height:28px;padding:0 12px;border-radius:8px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,#36373b);background:transparent;color:inherit}
.dsham-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dsham-btn:disabled{opacity:.45;cursor:default}
.dsham-bar{display:flex;align-items:center;gap:10px;flex:none;flex-wrap:wrap}
.dsham-search{width:260px;box-sizing:border-box;height:32px;padding:0 10px;font:inherit;font-size:13px;
  color:inherit;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));
  border:1px solid transparent;border-radius:8px;outline:none}
.dsham-search:focus{border-color:#4d6bfe;background:var(--dsw-alias-bg-layer-1,#1c1d21)}
.dsham-search::placeholder{color:var(--dsw-alias-label-tertiary,#8c959f)}
.dsham-date{height:32px;box-sizing:border-box;font:inherit;font-size:13px;padding:0 8px;border-radius:8px;
  color:inherit;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));
  border:1px solid transparent;outline:none;color-scheme:dark}
.dsham-date:focus{border-color:#4d6bfe}
.dsham-days{display:flex;gap:6px;flex-wrap:wrap}
.dsham-daypill{font:inherit;font-size:12px;line-height:24px;padding:0 10px;border-radius:999px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,#36373b);background:transparent;color:inherit;opacity:.75;white-space:nowrap}
.dsham-daypill:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dsham-daypill[data-on="1"]{background:#4d6bfe;border-color:#4d6bfe;color:#fff;opacity:1}
.dsham-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:4px}
.dsham-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.02))}
.dsham-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.dsham-row-title{font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsham-row-meta{font-size:11.5px;opacity:.6;display:flex;gap:10px;flex-wrap:wrap}
.dsham-row-actions{flex:none;display:flex;gap:8px}
.dsham-del{border-color:var(--dsw-alias-state-error-primary,#ff6b6b);color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.dsham-empty{padding:28px;text-align:center;font-size:13px;opacity:.6}
.dsham-err{color:var(--dsw-alias-state-error-primary,#ff6b6b);font-size:12.5px}
.dsham-ok{color:var(--dsw-alias-state-success-primary,#4ade80);font-size:12.5px}
.dsham-note{font-size:11.5px;opacity:.55;line-height:1.6;flex:none}
/* ── 二次确认：portal 到 body，z-index 9999（见文件头"必须 portal"那条）── */
.dsham-mask{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;
  box-sizing:border-box;background:rgba(0,0,0,.45)}
.dsham-dlg{width:min(560px,94vw);box-sizing:border-box;display:flex;flex-direction:column;gap:14px;padding:18px 20px;
  background:var(--dsw-alias-bg-layer-1,#1c1d21);color:var(--dsw-alias-label-primary,#e8e8ea);
  border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.5)}
.dsham-dlg-title{font-size:15px;font-weight:600;margin:0}
.dsham-dlg-body{font-size:13px;line-height:1.7;opacity:.9}
.dsham-dlg-body b{font-weight:600;opacity:1;word-break:break-all}
.dsham-plan{margin:0;padding:9px 11px;border-radius:8px;font-size:11.5px;line-height:1.7;
  background:rgba(255,255,255,.03);border:1px solid var(--dsw-alias-border-l2,#36373b);
  max-height:150px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.dsham-input{width:100%;box-sizing:border-box;height:32px;padding:0 10px;font:inherit;font-size:13px;
  color:inherit;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));
  border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px;outline:none}
.dsham-input:focus{border-color:#4d6bfe}
.dsham-dlg-foot{display:flex;align-items:center;gap:10px}
.dsham-dlg-foot .dsham-spacer{margin-left:auto}
.dsham-danger{background:var(--dsw-alias-state-error-primary,#e5484d);border-color:transparent;color:#fff}
.dsham-danger:hover:not(:disabled){filter:brightness(1.08)}
/* ── Tab 按钮选中态 / 转储夹设置行 ─────────────────────────────────── */
.dsham-btn[data-on="1"]{background:#4d6bfe;border-color:#4d6bfe;color:#fff}
.dsham-cfg{flex:none;display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l2,#36373b);background:rgba(255,255,255,.02)}
.dsham-cfg-row{display:flex;align-items:center;gap:8px}
.dsham-cfg-label{font-size:12.5px;opacity:.8;flex:none}
.dsham-cfg-input{flex:1;min-width:0;height:30px;box-sizing:border-box;padding:0 10px;font:inherit;font-size:12.5px;
  color:inherit;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));
  border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px;outline:none;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dsham-cfg-input:focus{border-color:#4d6bfe}
.dsham-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;opacity:.7;word-break:break-all}
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
    // 图标（纯 SVG，不依赖官方图标集 —— 共享模块表只有 9 个词，图标不保证能拿到）
    // ─────────────────────────────────────────────────────────────────────
    function ArchiveIcon({ size }) {
      const s = size || 16;
      return h("svg", {
        width: s, height: s, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: "1.8",
        strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
      },
        h("rect", { x: "3", y: "4", width: "18", height: "4", rx: "1" }),
        h("path", { d: "M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" }),
        h("path", { d: "M10 12h4" })
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // 二次确认弹窗
    //
    // ★ 为什么自己写而不用官方 `primitives.Modal`：它在 document 上挂 Escape 监听，
    //   在里面的输入框按 Esc 会把整个弹窗关掉（multi-session 插件踩过，文件头有记）。
    // 这里 Esc 由**自己**处理，且只在没在输入时才关。
    // ─────────────────────────────────────────────────────────────────────
    function ConfirmDialog({ item, plan, trashDir, onCancel, onConfirm, busy }) {
      const [typed, setTyped] = useState("");
      const inputRef = useRef(null);
      const want = (item.title || "").trim();

      useEffect(() => {
        if (inputRef.current) inputRef.current.focus();
      }, []);

      /**
       * 确认条件：标题非空的会话，必须**手打标题**才允许删。
       * 无标题的会话（实测有 1 条）没有可打的字 ⇒ 退化为只按按钮，但仍有这一步弹窗挡着。
       */
      const needType = want.length > 0;
      const canConfirm = !busy && (!needType || typed.trim() === want);

      const onKeyDown = useCallback((e) => {
        if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
      }, [onCancel]);

      const body = h("div", {
        className: "dsham-mask",
        onMouseDown: (e) => { if (e.target === e.currentTarget) onCancel(); },
      },
        h("div", {
          className: "dsham-dlg", role: "dialog", "aria-modal": "true",
          "data-dsham": CONFIRM_ID, onKeyDown,
        },
          h("h3", { className: "dsham-dlg-title" }, "把这条归档对话移出 DSH？"),
          h("div", { className: "dsham-dlg-body" },
            h("div", null, "即将移出：", h("b", null, item.title || "(无标题)")),
            h("div", { style: { marginTop: "6px" } },
              "时间 " + fmtDayLabel(dayKey(item.at)) + " " + fmtTime(item.at) +
              "，日志 " + fmtBytes(item.logBytes) + "。"
            ),
            h("div", { style: { marginTop: "8px" } },
              "文件会**搬到你的转储文件夹**（不是抹除）：",
              h("b", null, trashDir || "(未设置)")
            ),
            h("div", { style: { marginTop: "6px", opacity: ".7" } },
              "之后你去那个文件夹里全选删除，空间才会真正释放。在此之前随时可以在这里点「还原」。"
            )
          ),
          plan && plan.targets && plan.targets.length
            ? h("div", { className: "dsham-plan" },
                plan.targets.map((t, i) => h("div", { key: i }, "· " + t.path)))
            : null,
          needType
            ? h("div", null,
                h("div", { style: { fontSize: "12.5px", marginBottom: "6px", opacity: ".85" } },
                  "请输入对话标题以确认：", h("b", null, want)),
                h("input", {
                  ref: inputRef, className: "dsham-input", value: typed,
                  placeholder: "照抄上面的标题",
                  onChange: (e) => setTyped(e.target.value),
                  "data-dsham": "confirm-input",
                })
              )
            : h("div", { style: { fontSize: "12.5px", opacity: ".7" } },
                "这条会话没有标题，无需输入；点右侧按钮即删除。"),
          plan && plan.error ? h("div", { className: "dsham-err" }, plan.error) : null,
          h("div", { className: "dsham-dlg-foot" },
            h("div", { className: "dsham-spacer" }),
            h("button", {
              type: "button", className: "dsham-btn", onClick: onCancel, disabled: busy,
              "data-dsham": "confirm-cancel",
            }, "取消"),
            h("button", {
              type: "button", className: "dsham-btn dsham-danger",
              onClick: () => onConfirm(typed), disabled: !canConfirm,
              "data-dsham": "confirm-ok",
            }, busy ? "删除中…" : "永久删除")
          )
        )
      );

      // portal 到 body：绕开 shell.overlay 的 z-index:20 层叠上下文
      return ReactDOM.createPortal(body, document.body);
    }

    // ─────────────────────────────────────────────────────────────────────
    // 主面板：归档管理器
    // ─────────────────────────────────────────────────────────────────────
    function ArchivePanel() {
      const [items, setItems] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [query, setQuery] = useState("");
      const [day, setDay] = useState("");        // "" = 全部；否则 YYYY-MM-DD
      const [confirm, setConfirm] = useState(null); // { item, plan }
      const [busyId, setBusyId] = useState(null);
      const [notice, setNotice] = useState(null);
      const [tab, setTab] = useState("archived"); // archived | trash

      // 转储文件夹
      const [trashDir, setTrashDir] = useState("");
      const [trashEdit, setTrashEdit] = useState("");
      const [trash, setTrash] = useState(null);  // { slots, bytes, exists }
      const [savingDir, setSavingDir] = useState(false);

      const loadConfig = useCallback(async () => {
        try {
          const j = await fetchJson(API_CONFIG);
          if (j && j.ok) { setTrashDir(j.trashDir || ""); setTrashEdit(j.trashDir || ""); }
        } catch (e) {
          diagnostics.errors.push("config: " + errText(e));
        }
      }, []);

      const loadTrash = useCallback(async () => {
        try {
          const j = await fetchJson(API_TRASH);
          if (j && j.ok) setTrash(j);
        } catch (e) {
          diagnostics.errors.push("trash: " + errText(e));
        }
      }, []);

      const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
          const j = await fetchJson(API_LIST);
          diagnostics.api.lastList = { at: new Date().toISOString(), ok: j && j.ok, n: j && j.items ? j.items.length : 0 };
          if (j && j.ok) setItems(j.items || []);
          else setError((j && j.error) || "读取归档列表失败");
        } catch (e) {
          setError(errText(e));
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => { load(); loadConfig(); loadTrash(); }, [load, loadConfig, loadTrash]);

      async function saveTrashDir() {
        setSavingDir(true);
        setNotice(null);
        try {
          const j = await fetchJson(API_SET_CONFIG, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trashDir: trashEdit }),
          });
          if (j && j.ok) {
            setTrashDir(trashEdit);
            setNotice({ ok: true, text: "转储文件夹已设为：" + trashEdit });
            await loadTrash();
          } else {
            setNotice({ ok: false, text: (j && j.error) || "设置失败" });
            setTrashEdit(trashDir);
          }
        } catch (e) {
          setNotice({ ok: false, text: "设置失败：" + errText(e) });
        } finally {
          setSavingDir(false);
        }
      }

      async function doRestore(slot) {
        setNotice(null);
        try {
          const j = await fetchJson(API_RESTORE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slot }),
          });
          if (j && j.ok) {
            setNotice({ ok: true, text: "已还原。重新登记：" + ((j.registered && j.registered.ok) ? "成功" : (j.registered && j.registered.error) || "未登记") });
            await load(); await loadTrash();
          } else {
            setNotice({ ok: false, text: (j && j.error) || "还原失败" });
          }
        } catch (e) {
          setNotice({ ok: false, text: "还原失败：" + errText(e) });
        }
      }

      // 可选日期（按条数从多到少，方便一点就筛到那天）
      const dayOptions = useMemo(() => {
        const m = new Map();
        for (const it of items) {
          const k = dayKey(it.at);
          if (!k) continue;
          m.set(k, (m.get(k) || 0) + 1);
        }
        return Array.from(m.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
      }, [items]);

      const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return items.filter((it) => {
          if (day && dayKey(it.at) !== day) return false;
          if (!q) return true;
          const hay = ((it.title || "") + " " + (it.cwd || "") + " " + (it.workspaceTitle || "")).toLowerCase();
          return hay.includes(q);
        });
      }, [items, query, day]);

      const totalBytes = useMemo(() => filtered.reduce((n, x) => n + (x.logBytes || 0), 0), [filtered]);

      async function openConfirm(item) {
        setNotice(null);
        let plan = null;
        try {
          plan = await fetchJson(API_PLAN + "?sessionId=" + encodeURIComponent(item.id));
        } catch (e) {
          plan = { ok: false, error: "无法读取删除计划：" + errText(e) };
        }
        setConfirm({ item, plan });
      }

      async function doRemove(typed) {
        if (!confirm) return;
        const item = confirm.item;
        setBusyId(item.id);
        try {
          const j = await fetchJson(API_REMOVE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: item.id, confirmTitle: typed || "" }),
          });
          diagnostics.api.lastRemove = { at: new Date().toISOString(), id: item.id, ok: j && j.ok };
          if (j && j.ok) {
            setNotice({
              ok: true,
              text: "已移到转储文件夹：" + (item.title || "(无标题)") + "（" + fmtBytes(item.logBytes) + "）→ " + (j.trashPath || ""),
            });
            setConfirm(null);
            await load(); await loadTrash();
          } else {
            const detail = (j && j.failed && j.failed.length)
              ? "；失败：" + j.failed.map((f) => f.kind + " " + (f.error || "")).join("，")
              : "";
            setNotice({ ok: false, text: "移出未完成：" + ((j && j.error) || "未知错误") + detail });
          }
        } catch (e) {
          setNotice({ ok: false, text: "请求失败：" + errText(e) });
        } finally {
          setBusyId(null);
        }
      }

      const trashSlots = (trash && trash.slots) || [];
      const trashBytes = (trash && trash.bytes) || 0;

      return h("div", { className: "dsham-panel", "data-dsham": PANEL_BODY_ID },
        h("div", { className: "dsham-head" },
          h("h2", { className: "dsham-title" }, "已归档的对话"),
          h("span", { className: "dsham-sub" },
            loading ? "读取中…" : (filtered.length + " 条 · " + fmtBytes(totalBytes))),
          h("div", { className: "dsham-spacer" }),
          h("button", {
            type: "button", className: "dsham-btn", "data-on": tab === "archived" ? "1" : "0",
            onClick: () => setTab("archived"), "data-dsham": "tab-archived",
          }, "归档列表"),
          h("button", {
            type: "button", className: "dsham-btn", "data-on": tab === "trash" ? "1" : "0",
            onClick: () => setTab("trash"), "data-dsham": "tab-trash",
          }, "转储文件夹" + (trashSlots.length ? " (" + trashSlots.length + ")" : "")),
          h("button", {
            type: "button", className: "dsham-btn", onClick: () => { load(); loadTrash(); }, disabled: loading,
            "data-dsham": "refresh",
          }, loading ? "刷新中…" : "刷新")
        ),

        // ── 转储文件夹设置（两个 tab 都显示 —— 它决定了"删除"到底搬到哪）──
        h("div", { className: "dsham-cfg" },
          h("div", { className: "dsham-cfg-row" },
            h("span", { className: "dsham-cfg-label" }, "转储文件夹"),
            h("input", {
              className: "dsham-cfg-input", value: trashEdit, spellCheck: false,
              onChange: (e) => setTrashEdit(e.target.value),
              "aria-label": "转储文件夹路径", "data-dsham": "trashdir",
            }),
            h("button", {
              type: "button", className: "dsham-btn", onClick: saveTrashDir,
              disabled: savingDir || trashEdit === trashDir,
              "data-dsham": "trashdir-save",
            }, savingDir ? "保存中…" : "保存"),
            trashDir !== trashEdit
              ? h("button", {
                  type: "button", className: "dsham-btn", onClick: () => setTrashEdit(trashDir),
                }, "还原输入")
              : null
          ),
          h("div", { className: "dsham-note" },
            "「永久删除」= 把会话文件搬到这里。要真正腾出空间，请自己打开这个文件夹全选删除；在那之前都可以点「还原」搬回去。",
            trashDir ? h("div", { className: "dsham-mono" }, "当前：" + trashDir) : null
          )
        ),

        error ? h("div", { className: "dsham-err" }, error) : null,
        notice ? h("div", { className: notice.ok ? "dsham-ok" : "dsham-err" }, notice.text) : null,

        // ══ Tab 1：归档列表（搜索 + 按天筛选 + 删除）══
        tab === "archived"
          ? h(React.Fragment, null,
              h("div", { className: "dsham-bar" },
                h("input", {
                  className: "dsham-search", type: "search", value: query,
                  placeholder: "搜索标题 / 目录…",
                  onChange: (e) => setQuery(e.target.value),
                  "data-dsham": "search",
                }),
                h("input", {
                  className: "dsham-date", type: "date", value: day,
                  onChange: (e) => setDay(e.target.value || ""),
                  "aria-label": "按日期筛选", "data-dsham": "date",
                }),
                h("div", { className: "dsham-days" },
                  h("button", {
                    type: "button", className: "dsham-daypill", "data-on": day === "" ? "1" : "0",
                    onClick: () => setDay(""), "data-dsham": "day-all",
                  }, "全部"),
                  dayOptions.slice(0, 8).map(([k, n]) =>
                    h("button", {
                      key: k, type: "button", className: "dsham-daypill",
                      "data-on": day === k ? "1" : "0",
                      onClick: () => setDay(day === k ? "" : k),
                      "data-dsham": "day-pill",
                    }, fmtDayLabel(k) + " (" + n + ")")
                  )
                )
              ),
              h("div", { className: "dsham-list", "data-dsham": "list" },
                loading
                  ? h("div", { className: "dsham-empty" }, "读取中…")
                  : filtered.length === 0
                    ? h("div", { className: "dsham-empty" },
                        items.length === 0 ? "还没有已归档的对话。" : "没有符合筛选条件的对话。")
                    : filtered.map((it) =>
                        h("div", { className: "dsham-row", key: it.id, "data-dsham": "row", "data-id": it.id },
                          h("div", { className: "dsham-row-main" },
                            h("div", { className: "dsham-row-title" }, it.title || "(无标题)"),
                            h("div", { className: "dsham-row-meta" },
                              h("span", null, fmtDayLabel(dayKey(it.at)) + " " + fmtTime(it.at)),
                              h("span", null, fmtBytes(it.logBytes)),
                              it.workspaceTitle ? h("span", null, it.workspaceTitle) : null
                            )
                          ),
                          h("div", { className: "dsham-row-actions" },
                            h("button", {
                              type: "button", className: "dsham-btn dsham-del",
                              onClick: () => openConfirm(it),
                              disabled: busyId === it.id,
                              "data-dsham": "delete",
                            }, busyId === it.id ? "处理中…" : "永久删除")
                          )
                        )
                      )
              )
            )
          : null,

        // ══ Tab 2：转储文件夹（可还原 / 看路径）══
        tab === "trash"
          ? h("div", { className: "dsham-list", "data-dsham": "trashlist" },
              h("div", { className: "dsham-note" },
                "共 " + trashSlots.length + " 项 · " + fmtBytes(trashBytes) + "。",
                h("br"),
                "要真正释放空间：复制上面的路径到文件资源管理器，全选删除。"
              ),
              trashSlots.length === 0
                ? h("div", { className: "dsham-empty" }, "转储文件夹是空的。")
                : trashSlots.map((s) =>
                    h("div", { className: "dsham-row", key: s.slot, "data-dsham": "trashrow" },
                      h("div", { className: "dsham-row-main" },
                        h("div", { className: "dsham-row-title" }, s.title || "(无标题)"),
                        h("div", { className: "dsham-row-meta" },
                          h("span", null, fmtBytes(s.bytes)),
                          h("span", null, s.count + " 个文件"),
                          s.restorable ? null : h("span", null, "（不可还原）")
                        ),
                        h("div", { className: "dsham-mono" }, s.dir)
                      ),
                      h("div", { className: "dsham-row-actions" },
                        h("button", {
                          type: "button", className: "dsham-btn",
                          onClick: () => doRestore(s.slot),
                          disabled: !s.restorable,
                          "data-dsham": "restore",
                        }, "还原")
                      )
                    )
                  )
            )
          : null,

        h("div", { className: "dsham-note" },
          "删除会同时清掉会话日志、标题缓存与归档登记。文件先搬到转储文件夹 —— 你在那里删掉之后，空间才会真正释放。"),

        confirm ? h(ConfirmDialog, {
          item: confirm.item, plan: confirm.plan, trashDir,
          busy: busyId === confirm.item.id,
          onCancel: () => setConfirm(null),
          onConfirm: doRemove,
        }) : null
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // 插件本体
    // ─────────────────────────────────────────────────────────────────────
    const name = PLUGIN_ID;

    /**
     * inject 列表：只写**确定存在**的服务。
     * ★ `slots` 是渲染器提供的一等服务（所有插件都用它）。
     * ★ **不**写 `sessions` / `conversation`：本插件不需要它们（只读自己的 HTTP 接口），
     *   而 inject 写进不存在的服务 = 插件**永远不 apply** = 界面什么都没有且不报错
     *   （multi-session 插件文件头的警告）。少写比多写安全。
     */
    const inject = ["slots"];

    function apply(ctx) {
      installCss(ctx);

      // ① 侧边栏：新增一行「已归档」
      //    `id` 必须是主面板 id —— 它与下面 main 的 `key` 配对（见文件头说明）。
      ctx.slots.inject(PANELIST_SLOT, () => safeRegister(ctx,
        { name: PANELIST_SLOT, id: PANEL_ID, order: 100, label: PANEL_LABEL },
        ({ size, active }) => h("span", {
          "data-dsham": PANELIST_ICON_ID,
          style: { display: "inline-flex", color: active ? "currentColor" : "inherit" },
        }, h(ArchiveIcon, { size }))
      ));

      // ② 主面板：点击后中间显示的归档管理器
      ctx.slots.inject(MAIN_SLOT, () => safeRegister(ctx,
        { name: MAIN_SLOT, key: PANEL_ID },
        () => h(ArchivePanel)
      ));

      // 调试钩子：让"没挂上 / 挂上了但拿不到数据"变成可查的事实
      try {
        globalThis.__dshArchiveManager = {
          plugin: PLUGIN_ID,
          panelId: PANEL_ID,
          diagnostics,
          // 供自动化验证：直接读一次列表接口，绕开 UI 渲染
          apiList: () => fetchJson(API_LIST),
          apiPlan: (id) => fetchJson(API_PLAN + "?sessionId=" + encodeURIComponent(id)),
        };
      } catch { /* 没有 window 就算了 */ }
    }

    return { name, inject, apply };
  },
});
