/**
 * page-switch.js —— 注入到页面里的「切换页面」把手
 *
 * 由外壳在页面加载完成后用 `webContents.executeJavaScript` 注入
 * （见 main.js 的 injectScript），本机 DSH 页面与两个外部站点**都注入同一份**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 位置：贴在窗口**右侧边缘**、垂直居中
 * ══════════════════════════════════════════════════════════════════
 *   手机端的做法是"点屏幕外侧"切页，桌面这里照同一个手感做：
 *   右侧边缘一个细把手（默认 20px，悬停展开到 34px），点一下弹出三页清单。
 *   刻意不做成常规按钮 —— 它要能出现在**任何**页面上而不占正文空间。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条硬约束（每一条都是踩过才知道的）
 * ══════════════════════════════════════════════════════════════════
 *   ① **CSP 安全**：chat.deepseek.com / platform.deepseek.com 都可能下发严格的
 *      `style-src` ⇒ `<style>` 元素与 `style="…"` 属性会被浏览器拒绝。
 *      所以样式**一律走 CSSOM**（`el.style.foo = …`）—— CSSOM 不受 CSP 约束。
 *   ② **不碰 innerHTML**：有些站点开了 Trusted Types，赋 `innerHTML` 会直接抛错。
 *      全部用 `createElement` + `textContent` 搭。
 *   ③ **挂在 `document.documentElement` 上**，不是 body：官方前端会重建 body 内容，
 *      挂 body 有被一起清掉的风险；html 层不会。
 *
 * ══════════════════════════════════════════════════════════════════
 * 拿不到 window.dshShell 时**安静退出**
 * ══════════════════════════════════════════════════════════════════
 *   弹出的登录子窗口没有挂我们的 preload ⇒ 那里不该出现把手。
 */
(function () {
  "use strict";

  var NS = "__dshPageSwitch";

  // 重复注入（页面内跳转后再注入一次）时只刷新，不叠一层
  if (window[NS] && typeof window[NS].refresh === "function") {
    try { window[NS].refresh(); } catch (e) { /* 忽略 */ }
    return;
  }

  var shell = window.dshShell;
  if (!shell || typeof shell.switchPage !== "function" || typeof shell.pages !== "function") {
    return; // 不是我们托管的页面（例如登录弹窗），不出按钮
  }

  var Z = "2147483647";
  var host = document.documentElement;
  var root = null;
  var handle = null;
  var panel = null;
  var listEl = null;
  var open = false;
  var state = { active: "dsh", pages: [] };

  function mk(tag, styles, text) {
    var el = document.createElement(tag);
    if (styles) { for (var k in styles) { if (Object.prototype.hasOwnProperty.call(styles, k)) el.style[k] = styles[k]; } }
    if (text != null) el.textContent = String(text);
    return el;
  }

  /**
   * 把我们自己的事件在**冒泡阶段**拦在组件根节点上，不让宿主页面（React）看到。
   *
   * ★★ 这里有一个实测踩到的坑，别再改回去（2026-09-20，`ui-check pages` 抓到）：
   *   第一版是在 `handle` **自身上**用**捕获阶段** `stopPropagation()`，结果
   *   **同一个元素上冒泡阶段的监听器全部不执行** —— 连现场新挂一个 `click`
   *   监听器都不触发（`extraListenerFired: 0`）。
   *   原因是 Chromium 把目标节点的捕获监听器放在**捕获趟**里跑，
   *   一旦那里 stop 掉，后面的**目标趟**就被整个跳过。
   *   症状极具误导性：元素在、监听器也在，`el.click()` 却什么都不发生。
   *   ⇒ 正确做法：挂在**根节点**、用**冒泡**阶段。自己的处理器先跑完，
   *     事件冒到根就止住，宿主页面收不到。
   */
  function swallowFromRoot(el) {
    ["mousedown", "mouseup", "click", "dblclick", "pointerdown", "pointerup",
      "keydown", "keyup", "wheel", "contextmenu"].forEach(function (t) {
      el.addEventListener(t, function (e) { e.stopPropagation(); }, false);
    });
  }

  function buildHandle() {
    handle = mk("div", {
      position: "fixed", right: "0", top: "50%", transform: "translateY(-50%)",
      width: "20px", height: "88px", zIndex: Z, boxSizing: "border-box",
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(15,23,42,0.72)", color: "#e2e8f0",
      border: "1px solid rgba(148,163,184,0.35)", borderRight: "none",
      borderRadius: "9px 0 0 9px", cursor: "pointer", userSelect: "none",
      font: "14px/1 system-ui,-apple-system,'Segoe UI',sans-serif",
      boxShadow: "0 2px 10px rgba(0,0,0,0.28)", transition: "width .12s ease, background .12s ease",
      WebkitAppRegion: "no-drag",
    }, "⇄");
    handle.title = "切换页面（本机 DSH / DeepSeek 网页版 / 开放平台）";
    handle.setAttribute("data-dsh-page-switch", "handle");

    handle.addEventListener("mouseenter", function () {
      handle.style.width = "34px";
      handle.style.background = "rgba(15,23,42,0.94)";
    });
    handle.addEventListener("mouseleave", function () {
      if (open) return;
      handle.style.width = "20px";
      handle.style.background = "rgba(15,23,42,0.72)";
    });
    handle.addEventListener("click", function (e) {
      e.preventDefault();
      toggle();
    });
    return handle;
  }

  function buildPanel() {
    panel = mk("div", {
      position: "fixed", right: "44px", top: "50%", transform: "translateY(-50%)",
      width: "248px", zIndex: Z, boxSizing: "border-box", display: "none",
      background: "#0f172a", color: "#e2e8f0",
      border: "1px solid rgba(148,163,184,0.35)", borderRadius: "12px",
      boxShadow: "0 12px 32px rgba(0,0,0,0.45)", overflow: "hidden",
      font: "13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif",
    });
    panel.setAttribute("data-dsh-page-switch", "panel");

    var head = mk("div", {
      padding: "10px 12px", fontWeight: "600", fontSize: "12px",
      letterSpacing: "0.04em", color: "#94a3b8",
      borderBottom: "1px solid rgba(148,163,184,0.2)",
    }, "切换页面");
    panel.appendChild(head);

    listEl = mk("div", { padding: "6px" });
    panel.appendChild(listEl);

    listEl.addEventListener("click", function (e) {
      var row = e.target;
      while (row && row !== listEl && !row.getAttribute("data-page-id")) row = row.parentNode;
      if (!row || row === listEl) return;
      var id = row.getAttribute("data-page-id");
      e.preventDefault();
      setOpen(false);
      Promise.resolve(shell.switchPage(id)).catch(function () { /* 主进程会记日志 */ });
    });
    return panel;
  }

  function renderList() {
    if (!listEl) return;
    listEl.textContent = "";
    state.pages.forEach(function (p) {
      var isActive = p.id === state.active;
      var row = mk("div", {
        display: "flex", alignItems: "center", gap: "8px",
        padding: "8px 10px", borderRadius: "8px", cursor: isActive ? "default" : "pointer",
        background: isActive ? "rgba(56,189,248,0.14)" : "transparent",
      });
      row.setAttribute("data-page-id", p.id);
      if (!isActive) {
        row.addEventListener("mouseenter", function () { row.style.background = "rgba(148,163,184,0.14)"; });
        row.addEventListener("mouseleave", function () { row.style.background = "transparent"; });
      }

      var mark = mk("span", {
        width: "14px", textAlign: "center", color: "#38bdf8", fontWeight: "700", flex: "0 0 auto",
      }, isActive ? "✓" : "");
      row.appendChild(mark);

      var box = mk("span", { display: "flex", flexDirection: "column", minWidth: "0" });
      box.appendChild(mk("span", {
        color: isActive ? "#e0f2fe" : "#e2e8f0", fontWeight: isActive ? "600" : "400",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }, p.label));
      if (p.hint) {
        box.appendChild(mk("span", {
          color: "#64748b", fontSize: "11px",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }, p.hint));
      }
      row.appendChild(box);
      listEl.appendChild(row);
    });
  }

  function setOpen(v) {
    open = !!v;
    if (panel) panel.style.display = open ? "block" : "none";
    if (handle) {
      handle.style.width = open ? "34px" : "20px";
      handle.style.background = open ? "rgba(15,23,42,0.94)" : "rgba(15,23,42,0.72)";
    }
  }

  function toggle() { setOpen(!open); }

  function refresh() {
    return Promise.resolve(shell.pages()).then(function (s) {
      if (s && s.pages) state = s;
      renderList();
      return state;
    }).catch(function () { return state; });
  }

  function mount() {
    root = mk("div", { position: "fixed", inset: "0", zIndex: Z, pointerEvents: "none" });
    root.setAttribute("data-dsh-page-switch", "root");
    root.appendChild(buildHandle());
    root.appendChild(buildPanel());
    // 把手与面板要能点，容器本身不吃事件
    handle.style.pointerEvents = "auto";
    panel.style.pointerEvents = "auto";
    host.appendChild(root);
    // ★ 事件拦截挂在**根节点 + 冒泡**，不是在 handle 自身上用捕获（见 swallowFromRoot 注释）
    swallowFromRoot(root);

    // Esc 关面板；点页面别处也关
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && open) { setOpen(false); e.stopPropagation(); }
    }, true);
    window.addEventListener("mousedown", function (e) {
      if (!open) return;
      if (root.contains(e.target)) return;
      setOpen(false);
    }, true);

    refresh();
  }

  // 主进程切页后会推状态过来 ⇒ 面板里的 ✓ 与高亮跟着变
  if (typeof shell.onPageState === "function") {
    try {
      shell.onPageState(function (s) {
        if (s && s.pages) { state = s; renderList(); }
      });
    } catch (e) { /* 忽略 */ }
  }

  try {
    mount();
    window[NS] = { refresh: refresh, open: function () { setOpen(true); }, close: function () { setOpen(false); } };
  } catch (e) {
    // 注入失败不该影响页面本身：官方界面照常用，只是没有切换把手
    try { console.warn("[dsh-page-switch] 注入失败：", e && e.message); } catch (e2) { /* 忽略 */ }
  }
})();
