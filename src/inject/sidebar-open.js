/**
 * sidebar-open.js —— 注入到官方 UI 里的「侧边栏文件树：真打开」装饰层
 *
 * 由外壳在页面加载完成后用 `webContents.executeJavaScript` 注入
 * （见 main.js 的 INJECT_FILES.files / injectLocalUi），**只注入本机内核页面**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 用户要的是什么（2026-09-23 原话）
 * ══════════════════════════════════════════════════════════════════
 *   「点击这个动作，有两个功能，一个功能是打开，然后读它，另外一个功能就是，
 *     相当于在文件管理器中点击他的能力。」
 *   ⇒ **单击照旧 = 在侧栏里读它**（内核自带，一个字都不改）；
 *     本脚本补上**第二件事**：真用系统默认应用打开 / 真在资源管理器里把它选中。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不改内核插件（`dsh-client-ui-sidebar-files`）
 * ══════════════════════════════════════════════════════════════════
 *   ① 那是官方包（`@deepseek-ai/dsh-client-ui-sidebar-files`），改它 = 内核升级当场被冲掉
 *      —— 项目铁律：**不改内核任何文件**（见 AGENTS.md §1）。
 *   ② 它其实**已经**把门画好了：每一行 `<li data-files-entry="file|directory|other">`
 *      上带着 `data-files-path="<绝对路径>"`（源码实测：`childPath(state.root, entry.name)`，
 *      root 取的是会话 cwd ⇒ 是**绝对路径**）。所以外壳只要在旁边加控件即可。
 *   ③ 打开这件事**只有外壳做得到**：网页拿不到 Electron 的 `shell`；
 *      内核的 `sessionController.openWorkspacePath` 走的是另一条 Remote，
 *      外挂客户端插件也调不动它（那是 host 半边的一等公民服务）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 四条硬约束（都是本项目踩过的，别再改回去）
 * ══════════════════════════════════════════════════════════════════
 *   ① **样式一律走 CSSOM**（`el.style.foo = …`），不用 `<style>`、不用 `style="…"`
 *      属性：官方页面可能下发严格 `style-src`，那两种写法会被拒。
 *   ② **不碰 innerHTML**：有些页面开了 Trusted Types，赋 `innerHTML` 直接抛错。
 *      全部 `createElement` + `textContent`。
 *   ③ **事件拦截挂在根节点 + 「冒泡」阶段**，不是在自身元素上用捕获阶段
 *      `stopPropagation` —— 在目标元素上用捕获会让**同一元素冒泡阶段的监听器
 *      全部不执行**（Chromium 把目标节点的捕获监听器放在捕获趟里跑，
 *      一旦那里 stop 掉，后面的目标趟被整个跳过）。
 *      症状极具误导性：元素在、监听器也在、`el.click()` 什么都不发生。
 *      （2026-09-20 `ui-check pages` 实测，见 page-switch.js 的 swallowFromRoot。）
 *   ④ **不往 React 的 DOM 里塞子节点**：树是 React 画的，我们 append 进去的图标
 *      会在它重渲染那一行时被抹掉。所以控件**挂在 `document.documentElement` 上的
 *      独立浮层**里，靠 `getBoundingClientRect()` 跟着行跑
 *      —— 顺带绕开了侧栏那几层 `overflow`（绝对定位的子节点会被裁掉）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 「看得见」的判据用 elementFromPoint，不用 getBoundingClientRect
 * ══════════════════════════════════════════════════════════════════
 *   矩形是**未裁切**的几何：行被祖先滚出可视区、或被别的层盖住时，矩形照样正常。
 *   所以每次出图标前都问一句 `elementFromPoint(行内一点)`「这一点上最上面的是谁」，
 *   命中的不是那一行就不出控件（项目铁律：假 PASS 比 FAIL 更糟）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 拿不到 window.dshShell 时**安静退出**
 * ══════════════════════════════════════════════════════════════════
 *   两个外部站点页（chat / platform）也挂了 preload，但**没有**这个新通道 ——
 *   主进程只放行本机内核界面（`assertLocalFileUi`）。这里再加一道：
 *   没有 `openWorkspaceFile` 就什么都不画，避免在别人页面上留个点了没用的图标。
 */
(function () {
  "use strict";

  var NS = "__dshSidebarOpen";

  // 重复注入（页面内跳转后再注入一次）时只刷新，不叠一层
  if (window[NS] && typeof window[NS].refresh === "function") {
    try { window[NS].refresh(); } catch (e) { /* 忽略 */ }
    return;
  }

  var shell = window.dshShell;
  if (!shell || typeof shell.openWorkspaceFile !== "function") {
    return; // 不是本机内核界面（两个外部站点没有这个通道），不出任何控件
  }

  var Z = "2147483647";
  var HOST = document.documentElement;
  var root = null;
  var strip = null;      // 悬停时行尾那排小图标
  var menu = null;       // 右键菜单
  var toast = null;      // 失败时的一行小提示
  var toastTimer = null;

  var hover = { path: "", type: "" };
  var last = { path: "", action: "", ok: null, reason: "", at: 0 };
  var calls = 0;
  var errors = [];

  // ── 小工具 ──────────────────────────────────────────────────────
  function mk(tag, styles, text) {
    var el = document.createElement(tag);
    if (styles) {
      for (var k in styles) {
        if (Object.prototype.hasOwnProperty.call(styles, k)) el.style[k] = styles[k];
      }
    }
    if (text != null) el.textContent = String(text);
    return el;
  }

  function note(msg) {
    if (errors.length < 20) errors.push(String(msg));
    try { console.warn("[dsh-sidebar-open] " + msg); } catch (e) { /* 忽略 */ }
  }

  /**
   * 把我们自己的事件在**冒泡阶段**拦在根节点上，不让宿主页面（React）看到。
   * 见文件头约束 ③ —— 千万别改成"在自身元素上用捕获阶段"。
   */
  function swallowFromRoot(el) {
    ["mousedown", "mouseup", "click", "dblclick", "pointerdown", "pointerup",
      "keydown", "keyup", "wheel", "contextmenu"].forEach(function (t) {
      el.addEventListener(t, function (e) { e.stopPropagation(); }, false);
    });
  }

  // ── 从 DOM 上读一个行是什么 ─────────────────────────────────────
  /**
   * 一行文件的身份。`data-files-path` 是**绝对路径**（内核用会话 cwd 拼出来的），
   * `data-files-entry` 是 `file` / `directory` / `other`。
   */
  function rowOf(target) {
    if (!target || typeof target.closest !== "function") return null;
    var row = target.closest("[data-files-entry]");
    if (!row) return null;
    var p = row.getAttribute("data-files-path") || "";
    var t = row.getAttribute("data-files-entry") || "";
    if (!p) return null;
    return { row: row, path: p, type: t };
  }

  /**
   * 那一行**可点的那块**。
   *
   * ★ 必须取里面的 `<button>`，不能用 `<li>`：目录展开时 `li` 里还包着**子层级的 ul**，
   *   拿 `li` 的矩形量出来是个很高的块，图标会飘到屏幕中间去。
   */
  function buttonOf(row) {
    return row.querySelector(":scope > button") || row.querySelector("button");
  }

  /**
   * 这一行此刻**真的看得见吗**（见文件头那一节）。
   *
   * ★ 取的是行内**靠左**的一点：我们自己的图标浮在行的右端，
   *   用右端点去问会命中我们自己的按钮，判据就自欺了。
   */
  function rowVisible(btn) {
    var r = btn.getBoundingClientRect();
    if (r.width < 24 || r.height < 8) return false;
    if (r.bottom < 0 || r.top > window.innerHeight) return false;
    var x = r.left + 12;
    var y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
    var top = document.elementFromPoint(x, y);
    if (!top) return false;
    return top === btn || btn.contains(top) || top === btn.parentNode;
  }

  // ── 悬停时行尾那排小图标 ────────────────────────────────────────
  function iconButton(action, glyph, title) {
    var b = mk("button", {
      width: "22px", height: "22px", padding: "0", margin: "0",
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "transparent", color: "#e2e8f0",
      border: "1px solid rgba(148,163,184,0.35)", borderRadius: "6px",
      cursor: "pointer", font: "12px/1 system-ui,-apple-system,'Segoe UI',sans-serif",
      flex: "0 0 auto",
    }, glyph);
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.setAttribute("data-dsh-file-action", action);
    b.addEventListener("mouseenter", function () { b.style.background = "rgba(148,163,184,0.28)"; });
    b.addEventListener("mouseleave", function () { b.style.background = "transparent"; });
    b.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      // ★ 这里**刻意不 hideStrip()**：鼠标此时还停在这一行上，收起来也会因为
      //   指针下面的元素变了而立刻再弹出来（实测过）。留着反而方便连点第二次
      //   （比如先「用默认应用打开」、再「在资源管理器中显示」）。
      doAction(hover.path, action);
    });
    return b;
  }

  /** 按行类型重建图标：目录一个（进去），文件两个（默认应用 / 在管理器中选中）。 */
  function fillStrip(type) {
    while (strip.firstChild) strip.removeChild(strip.firstChild);
    if (type === "directory") {
      strip.appendChild(iconButton("open", "📂", "在文件资源管理器中打开"));
    } else if (type === "file") {
      strip.appendChild(iconButton("open", "↗", "用默认应用打开"));
      strip.appendChild(iconButton("reveal", "📂", "在文件资源管理器中显示"));
    }
  }

  /**
   * 把图标摆到那一行的右端。
   * ★ `position: fixed` + `getBoundingClientRect()`：侧栏里有好几层 `overflow`，
   *   用 absolute 放进祖先里会被**裁掉**（DOM 里有、屏幕上没有）。
   */
  function showStripFor(btn, info) {
    if (!strip) return;
    if (hover.type !== info.type) { fillStrip(info.type); hover.type = info.type; }
    var r = btn.getBoundingClientRect();
    strip.style.display = "flex";
    var w = strip.offsetWidth || 54;
    var h = strip.offsetHeight || 26;
    var left = Math.max(r.left + 4, r.right - w - 6);
    var top = r.top + (r.height - h) / 2;
    strip.style.left = Math.round(left) + "px";
    strip.style.top = Math.round(Math.max(2, Math.min(top, window.innerHeight - h - 2))) + "px";
    hover.path = info.path;
  }

  function hideStrip() {
    if (strip && strip.style.display !== "none") strip.style.display = "none";
    hover.path = "";
  }

  // ── 右键菜单 ────────────────────────────────────────────────────
  function menuItem(action, label) {
    var row = mk("div", {
      display: "flex", alignItems: "center", gap: "8px",
      padding: "7px 10px", borderRadius: "7px", cursor: "pointer",
      color: "#e2e8f0", font: "13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif",
      whiteSpace: "nowrap",
    }, label);
    row.setAttribute("data-dsh-file-action", action);
    row.addEventListener("mouseenter", function () { row.style.background = "rgba(148,163,184,0.18)"; });
    row.addEventListener("mouseleave", function () { row.style.background = "transparent"; });
    row.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var p = menu.__path;
      hideMenu();
      if (action === "copy") copyPath(p);
      else doAction(p, action);
    });
    return row;
  }

  function openMenu(info, x, y) {
    if (!menu) return;
    while (menu.firstChild) menu.removeChild(menu.firstChild);
    menu.__path = info.path;

    var head = mk("div", {
      padding: "5px 10px 6px", color: "#94a3b8", fontSize: "11px",
      maxWidth: "320px", overflow: "hidden", textOverflow: "ellipsis",
      whiteSpace: "nowrap", borderBottom: "1px solid rgba(148,163,184,0.2)",
      font: "11px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif",
    }, info.path);
    head.title = info.path;
    menu.appendChild(head);

    var box = mk("div", { padding: "5px" });
    if (info.type === "directory") {
      box.appendChild(menuItem("open", "在文件资源管理器中打开"));
    } else if (info.type === "file") {
      box.appendChild(menuItem("open", "用默认应用打开"));
      box.appendChild(menuItem("reveal", "在文件资源管理器中显示"));
    }
    box.appendChild(menuItem("copy", "复制路径"));
    menu.appendChild(box);

    menu.style.display = "block";
    var w = menu.offsetWidth || 220;
    var h = menu.offsetHeight || 120;
    menu.style.left = Math.round(Math.max(4, Math.min(x, window.innerWidth - w - 6))) + "px";
    menu.style.top = Math.round(Math.max(4, Math.min(y, window.innerHeight - h - 6))) + "px";
  }

  function hideMenu() {
    if (menu && menu.style.display !== "none") menu.style.display = "none";
  }

  function copyPath(p) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(p).catch(function () { fallbackCopy(p); });
        return;
      }
    } catch (e) { /* 落到兜底 */ }
    fallbackCopy(p);
  }

  /** 兜底：临时 textarea + execCommand（剪贴板权限被拒时用）。 */
  function fallbackCopy(p) {
    try {
      var ta = mk("textarea", { position: "fixed", left: "-9999px", top: "0" });
      ta.value = p;
      HOST.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      HOST.removeChild(ta);
    } catch (e) { note("复制路径失败：" + ((e && e.message) || e)); }
  }

  // ── 真正干活的那一步：交给外壳 ──────────────────────────────────
  function doAction(p, action) {
    if (!p) return Promise.resolve(null);
    calls += 1;
    last = { path: p, action: action, ok: null, reason: "", at: Date.now() };
    return Promise.resolve(shell.openWorkspaceFile(p, action)).then(function (r) {
      var ok = !!(r && r.ok);
      last.ok = ok;
      last.reason = (r && (r.reason || r.message)) || "";
      if (!ok) {
        note("打开失败（" + action + "）：" + (last.reason || "未知原因"));
        showToast("打不开：" + (last.reason || "未知原因"));
      }
      return r;
    }).catch(function (e) {
      last.ok = false;
      last.reason = (e && e.message) || String(e);
      note("打开通道异常：" + last.reason);
      showToast("打不开：" + last.reason);
      return null;
    });
  }

  /** 失败时的一行小提示 —— 不说的话用户只会觉得"点了没反应"。 */
  function showToast(text) {
    if (!toast) return;
    toast.textContent = String(text);
    toast.style.display = "block";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (toast) toast.style.display = "none";
    }, 3000);
  }

  // ── 事件 ────────────────────────────────────────────────────────
  function onOver(e) {
    // 悬停在我们自己的浮层上：保持现状（否则鼠标一移到图标上图标就消失了）
    if (root && e.target && root.contains(e.target)) return;
    var info = rowOf(e.target);
    if (!info || info.type === "other") { hideStrip(); return; }
    var btn = buttonOf(info.row);
    if (!btn || !rowVisible(btn)) { hideStrip(); return; }
    showStripFor(btn, info);
  }

  function onContext(e) {
    // 在我们自己的控件上右键：吃掉，不给页面
    if (root && e.target && root.contains(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    var info = rowOf(e.target);
    if (!info) return;                       // 不是文件行 ⇒ 让页面自己的菜单出来
    var btn = buttonOf(info.row);
    if (!btn || !rowVisible(btn)) return;
    e.preventDefault();
    e.stopPropagation();
    hideStrip();
    openMenu(info, e.clientX, e.clientY);
  }

  function onMouseDown(e) {
    if (!menu || menu.style.display === "none") return;
    if (menu.contains(e.target)) return;
    hideMenu();
  }

  function onKeyDown(e) {
    if (e.key !== "Escape") return;
    if (menu && menu.style.display !== "none") {
      hideMenu();
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (strip && strip.style.display !== "none") { hideStrip(); e.stopPropagation(); }
  }

  // ── 搭浮层 ──────────────────────────────────────────────────────
  function build() {
    root = mk("div", { position: "fixed", inset: "0", zIndex: Z, pointerEvents: "none" });
    root.setAttribute("data-dsh-file-open", "root");

    strip = mk("div", {
      position: "fixed", display: "none", gap: "4px", padding: "2px",
      zIndex: Z, pointerEvents: "auto", boxSizing: "border-box",
      background: "rgba(15,23,42,0.92)",
      border: "1px solid rgba(148,163,184,0.35)", borderRadius: "8px",
      boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
    });
    strip.setAttribute("data-dsh-file-open", "strip");

    menu = mk("div", {
      position: "fixed", display: "none", zIndex: Z, pointerEvents: "auto",
      boxSizing: "border-box", minWidth: "180px",
      background: "#0f172a", color: "#e2e8f0",
      border: "1px solid rgba(148,163,184,0.35)", borderRadius: "10px",
      boxShadow: "0 12px 32px rgba(0,0,0,0.45)", overflow: "hidden",
    });
    menu.setAttribute("data-dsh-file-open", "menu");

    toast = mk("div", {
      position: "fixed", display: "none", zIndex: Z, pointerEvents: "none",
      left: "50%", bottom: "28px", transform: "translateX(-50%)",
      maxWidth: "70vw", padding: "8px 14px", boxSizing: "border-box",
      background: "rgba(127,29,29,0.95)", color: "#fee2e2",
      border: "1px solid rgba(248,113,113,0.5)", borderRadius: "10px",
      font: "12px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif",
      boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
    });
    toast.setAttribute("data-dsh-file-open", "toast");

    root.appendChild(strip);
    root.appendChild(menu);
    root.appendChild(toast);
    HOST.appendChild(root);
    // ★ 事件拦截：根节点 + 冒泡（见文件头约束 ③）
    swallowFromRoot(root);

    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("contextmenu", onContext, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    // 滚动/改尺寸时先收起来：位置会失效，下一次 mouseover 会重新算
    window.addEventListener("scroll", hideStrip, true);
    window.addEventListener("resize", function () { hideStrip(); hideMenu(); }, true);
    HOST.addEventListener("mouseleave", hideStrip, false);
  }

  function refresh() {
    hideStrip();
    hideMenu();
    return Promise.resolve(state());
  }

  function state() {
    return {
      installed: true,
      stripVisible: !!(strip && strip.style.display === "flex"),
      menuVisible: !!(menu && menu.style.display === "block"),
      hoverPath: hover.path,
      calls: calls,
      last: last,
      errors: errors.slice(),
    };
  }

  try {
    build();
    window[NS] = { refresh: refresh, state: state, rowOf: rowOf, buttonOf: buttonOf };
  } catch (e) {
    // 注入失败不该影响页面本身：官方界面照常用，只是少了这排图标
    note("注入失败：" + ((e && e.message) || e));
  }
})();
