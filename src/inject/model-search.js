"use strict";

/**
 * inject/model-search.js —— 给官方「选择模型」下拉加**搜索框 + 提供方筛选**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一段是怎么送到页面里去的（以及为什么这么送）
 * ══════════════════════════════════════════════════════════════════
 * 由 `main.js` 在官方 UI **每次加载完成后**用 `webContents.executeJavaScript()`
 * 执行一次（跑在页面主世界，不受 CSP 限制）。
 *
 * ★ 为什么不用"改内核 bundle"这条老路：
 *   2026-09-17 那次就是直接改社区端安装目录里的官方包
 *   `@deepseek-ai/dsh-client-ui-model-selection/lib/client.js`
 *   （改后 46903 字节 / sha256 E7EB10AB…）。结果那个文件**现在已经被覆盖回
 *   40020 字节**了 —— 装目录里的东西升级/重装就会被冲掉，改了个寂寞。
 *   本外壳的架构前提是"**不改内核任何文件**、内核可独立升级"，所以那条路不走。
 *
 * ★ 这是注入，所以**必须有体面的失败方式**：
 *   下面所有 DOM 查找都在 try 里；找不到就**安静退出，官方界面照常用**。
 *   最坏的结果是"没有搜索框"，不会把菜单弄坏。
 *
 * ══════════════════════════════════════════════════════════════════
 * 锚点：只用官方**语义属性**，不用 CSS module 的哈希类名
 * ══════════════════════════════════════════════════════════════════
 * 官方 `client.js` 里菜单的 DOM 结构是（2026-09-20 读 0.1.5-rc.2 源码确认）：
 *
 *   <div role="menu" aria-label="…">                 ← createPortal 到 body，position:fixed
 *     <button role="menuitem">选择模型 …</button>      ← pane === "root" 时的两个切换项
 *     <button role="menuitem">推理强度 …</button>
 *     …（pane === "model" 时）
 *     <div class="…groups scrollable">
 *       <section role="group" aria-labelledby="<id>">  ← 一个提供方一组
 *         <div id="<id>" class="…groupTitle">提供方名</div>
 *         <button role="menuitemradio" title="模型名" aria-checked="…">…</button>
 *         …
 *       </section>
 *       …
 *     </div>
 *   </div>
 *
 * ⇒ 锚点用 `div[role="menu"]` + `section[role="group"][aria-labelledby]` +
 *   `button[role="menuitemradio"][title]`，**一个哈希类名都不碰**。
 *   提供方名字从 `aria-labelledby` 指向的那个元素取，也完全不依赖类名。
 *
 * `/model` 那个命令弹窗走的是另一套（`commandUi` 的 popupSelect，没有
 * `section[role="group"]`），所以**不会被这里误伤**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么"隐藏行"而不是"重画列表"
 * ══════════════════════════════════════════════════════════════════
 * 列表是 React 渲染的，动它的 children 有机会把 React 弄乱。
 * 这里只给不匹配的行加一个 `data-dsh-ms-hide` 属性，用**我们自己的样式表**
 * 把它们 `display:none` —— React 不管理这个属性，re-render 也不会把它删掉；
 * 万一某个节点被重建了，MutationObserver 会再补一次。
 *
 * ★ 进度条 / 搜索框都是"**先让它能安静地不工作**"的设计：
 *   官方改版 → 这里什么都不做 → 用户看到的就是官方原样。
 */

(() => {
  const FLAG = "__dshModelSearchInstalled";
  if (window[FLAG]) return;          // 同一页面只装一次
  window[FLAG] = true;

  const STYLE_ID = "dsh-ms-style";
  const HIDE = "data-dsh-ms-hide";
  const GHIDE = "data-dsh-ms-group-hide";
  const BAR = "dsh-ms-bar";

  // 轻量自诊断计数（留在 window 上，出问题时**能被问出来**，不靠猜）：
  // 例如"胶囊名字怎么没跟着变"——看 sweeps/applies/pillBuilds 哪个没涨就知道了。
  // ★ `src` 是**身份标记**：注入版 = "inject"；插件版（dsh-int-model-search）的包装层会覆写成 "plugin"。
  //   两者共用同一段 DOM 逻辑与同一个钩子，只有这个字段能区分"现在跑的是哪一个"（验收脚本据此断言）。
  const stats = window.__dshModelSearchStats = window.__dshModelSearchStats || { sweeps: 0, applies: 0, pillBuilds: 0, src: "inject" };

  // 用官方主题变量、并给每个都带上兜底色，这样换主题时跟得上、变量没了也不瞎
  const CSS = `
[${HIDE}="1"]{display:none !important}
[${GHIDE}="1"]{display:none !important}
.${BAR}{display:flex;flex-direction:column;gap:8px;padding:8px 8px 7px;
  border-bottom:1px solid var(--dsw-alias-border-l1,#e6e8eb);flex:none}
.${BAR} input{width:100%;box-sizing:border-box;height:30px;padding:0 10px;font:inherit;font-size:13px;
  color:var(--dsw-alias-label-primary,#1f2328);
  background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.045));
  border:1px solid transparent;border-radius:8px;outline:none}
.${BAR} input:focus{border-color:var(--dsw-alias-border-l3,#4d6bfe);
  background:var(--dsw-specific-menu,#fff)}
.${BAR} input::placeholder{color:var(--dsw-alias-label-tertiary,#8c959f)}
.dsh-ms-pills{display:flex;flex-wrap:wrap;gap:6px;max-height:56px;overflow-y:auto;overscroll-behavior:contain}
.dsh-ms-pill{font:inherit;font-size:12px;line-height:20px;padding:0 9px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1,#e6e8eb);background:transparent;
  color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer;white-space:nowrap;
  flex:none;max-width:180px;overflow:hidden;text-overflow:ellipsis}
.dsh-ms-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.045))}
.dsh-ms-pill[data-on="1"]{background:#4d6bfe;border-color:#4d6bfe;color:#fff;font-weight:500}
.dsh-ms-empty{display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:10px;font-size:13px;color:var(--dsw-alias-label-tertiary,#8c959f)}
.dsh-ms-empty button{font:inherit;font-size:12px;padding:2px 9px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l1,#e6e8eb);background:transparent;
  color:inherit;cursor:pointer}
`;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  // ── 锚点查找 ──────────────────────────────────────────────────────
  /** 找到 composer 的「选择模型」菜单（必须有 role=group 的分组，才认它）。 */
  function findModelMenu() {
    const menus = document.querySelectorAll('div[role="menu"]');
    for (const m of menus) {
      if (m.querySelector('section[role="group"][aria-labelledby]')) return m;
    }
    return null;
  }

  function groupTitleOf(section) {
    const id = section.getAttribute("aria-labelledby");
    const el = id ? document.getElementById(id) : null;
    return (el && el.textContent ? el.textContent : "").trim();
  }

  function rowsOf(section) {
    let rows = Array.from(section.querySelectorAll(':scope > button[role="menuitemradio"]'));
    if (!rows.length) rows = Array.from(section.querySelectorAll('button[role="menuitemradio"]'));
    return rows;
  }

  function haystackOf(row) {
    const title = row.getAttribute("title") || "";
    const text = row.textContent || "";
    return (title + " " + text).toLowerCase();
  }

  // ── 建搜索条 ──────────────────────────────────────────────────────
  function buildBar(menu, groupsContainer) {
    ensureStyle();

    const bar = document.createElement("div");
    bar.className = BAR;
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "搜索模型或提供方…";
    input.spellcheck = false;
    input.autocomplete = "off";
    const pills = document.createElement("div");
    pills.className = "dsh-ms-pills";
    bar.appendChild(input);
    bar.appendChild(pills);

    // ★ 插在分组容器的**紧前面**（不是 menu 的第一个孩子）：
    //   menu 的第一个孩子可能是"选择模型 / 推理强度"那两个切换项，
    //   插到它们前面会跑到菜单最顶部，位置很怪。
    groupsContainer.parentElement.insertBefore(bar, groupsContainer);

    const empty = document.createElement("div");
    empty.className = "dsh-ms-empty";
    empty.style.display = "none";
    groupsContainer.parentElement.insertBefore(empty, groupsContainer.nextSibling);

    const st = { bar, input, pills, empty, query: "", groupEl: null, groupName: null, applying: false };
    menu.__dshMs = st;

    input.addEventListener("input", () => {
      st.query = input.value || "";
      apply(menu);
    });

    input.addEventListener("keydown", (e) => {
      // Esc 先清空搜索/筛选，而不是直接把菜单关掉（再按一次才关）
      if (e.key === "Escape" && (st.query || st.groupEl || st.groupName)) {
        e.stopPropagation();
        e.preventDefault();
        st.query = "";
        st.groupEl = null;
        st.groupName = null;
        input.value = "";
        apply(menu);
      }
    });

    return st;
  }

  // ── 应用过滤 ──────────────────────────────────────────────────────
  //
  // ★★ 2026-09-26：这里修的是一个**真 bug**（用户报的"点那些标签后整个列表会消失"），
  //    根因不在"筛选算错了"，而在**焦点**。完整链条：
  //
  //      ① 官方根节点上有 `onMouseDown: if (target.closest("button")) preventDefault()`
  //         （官方 client.js:709-711）。菜单是 portal 到 `document.body` 的，而 React
  //         的合成事件**沿 React 树冒泡**（不沿 DOM 树）⇒ 这条 preventDefault 对
  //         **我们的胶囊同样生效** ⇒ 真鼠标点胶囊时**焦点根本不会落到胶囊上**。
  //      ② 官方开菜单时会把焦点 `focus()` 到**当前选中的那一行**
  //         （client.js:547，`[role="menuitemradio"][aria-checked="true"]`）。
  //      ③ 于是我们一旦把**那一行所在的分组** `display:none`，焦点就无处可去、
  //         掉到 `<body>`；官方根节点的 `onBlur`（client.js:648-651）看到
  //         relatedTarget 既不在 rootRef 也不在 menuRef ⇒ **close() ⇒ 整个菜单消失**。
  //
  //    ⇒ 这也精确解释了"为什么只有「全部」和当前那个提供方能点"：
  //       点「全部」不藏任何东西；点**当前提供方**那一颗，被藏的是**别的**分组、
  //       焦点那一行还活着；点**任何别的提供方**，藏掉的正是焦点所在分组 ⇒ 菜单关闭。
  //    ⇒ 而 `el.click()` 不产生 mousedown/focus 序列，所以任何用 `el.click()` 的
  //       测试都测不出它 —— 这一条是**真鼠标**才暴露的（ui-check inject 已加永久断言）。
  //
  //    修法：**落 display 之前，先把焦点收回搜索框**（还在 menuRef 里 ⇒ onBlur 放过）。
  //    顺序绝不能反：先藏再收，焦点已经掉出去了，收不回来。
  function apply(menu) {
    const st = menu.__dshMs;
    if (!st || st.applying) return;
    st.applying = true;
    stats.applies++;
    try {
      const q = (st.query || "").trim().toLowerCase();
      const sections = Array.from(menu.querySelectorAll('section[role="group"][aria-labelledby]'));

      // 提供方清单（每次重算：插件可能热更新出新提供方）
      const names = sections.map(groupTitleOf);
      const counts = sections.map((s) => rowsOf(s).length);

      // ★ 选中的分组按**元素身份**认，不按名字字符串：
      //   官方把分组名渲染成 `group.name`，而提供方会重新注册 / 名册刷新 ——
      //   React 更新这种文本时只改文本节点（characterData），元素不换。
      //   名字一变，胶囊上留存的旧字符串就一个分组都匹配不上 ⇒ 整张列表被藏空。
      //   身份认领对"原地改名"天然免疫；元素真被重建了才退回按名字找。
      let selName = st.groupName || null;
      if (st.groupEl) {
        let at = sections.indexOf(st.groupEl);
        if (at < 0 && st.groupName) at = names.indexOf(st.groupName);
        if (at >= 0) { st.groupEl = sections[at]; selName = names[at]; }
        // 认不出来就放开筛选 —— 宁可显示全部，也绝不把列表藏空
        else { st.groupEl = null; selName = null; }
      } else if (selName && names.indexOf(selName) < 0) {
        selName = null;
      }
      st.groupName = selName;

      // 胶囊按钮：只在分组 > 1 时出现（只有一个分组时它没意义、白占地方）
      if (names.length > 1) {
        st.pills.style.display = "";
        const total = counts.reduce((a, b) => a + b, 0);
        const want = [`\u5168\u90e8 ${total}`].concat(names.map((n, i) => `${n} ${counts[i]}`));
        if (st.pills.__dshWant !== want.join("|")) {
          st.pills.__dshWant = want.join("|");
          stats.pillBuilds++;
          st.pills.innerHTML = "";
          const mk = (label, value, sec) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "dsh-ms-pill";
            b.textContent = label;
            b.title = label;                      // 名字被 max-width 截断时还能看到全名
            b.dataset.value = value == null ? "" : value;
            b.__dshSec = sec || null;             // ★ 身份：这颗胶囊代表哪一段
            b.addEventListener("click", () => {
              const on = b.__dshSec ? (st.groupEl === b.__dshSec) : (!st.groupEl && !st.groupName);
              if (on) { st.groupEl = null; st.groupName = null; }
              else { st.groupEl = b.__dshSec || null; st.groupName = b.dataset.value || null; }
              apply(menu);
            });
            return b;
          };
          st.pills.appendChild(mk(want[0], null, null));
          names.forEach((n, i) => st.pills.appendChild(mk(want[i + 1], n, sections[i])));
        }
        Array.from(st.pills.children).forEach((b) => {
          const on = b.__dshSec ? (st.groupEl === b.__dshSec) : (!st.groupEl && !st.groupName);
          b.dataset.on = on ? "1" : "0";
        });
      } else {
        st.pills.style.display = "none";
        st.groupEl = null;
        st.groupName = null;
      }

      // ① 先**只算**"谁会被藏"（不落属性）—— 必须先把结果算出来，
      //    才能在落属性**之前**把焦点从"即将被藏起来的那一段"里救走（见 ②）。
      let shown = 0;
      let totalRows = 0;
      const plan = sections.map((sec) => {
        const gname = groupTitleOf(sec);
        const groupOk = !selName || gname === selName;
        const groupHitByQuery = !!q && gname.toLowerCase().includes(q);
        const rows = rowsOf(sec);
        const show = rows.map((row) => {
          totalRows++;
          const hit = !q || groupHitByQuery || haystackOf(row).includes(q);
          return groupOk && hit;
        });
        const shownInGroup = show.filter(Boolean).length;
        shown += shownInGroup;
        // 空分组整段藏掉（连提供方标题一起），但"没搜索条件时不藏"
        return { sec, rows, show, secShow: groupOk && (shownInGroup > 0 || !q) };
      });

      // ② ★★ 焦点保护 —— 这一个 if 就是"点标签整张列表消失"的修复本体。
      //    官方开菜单时焦点坐在"当前选中那一行"上（client.js:547），而真鼠标点我们
      //    胶囊时焦点**不会**移过来（官方根节点的 onMouseDown 对 button 调了
      //    preventDefault，且 React 合成事件沿 React 树冒泡到 portal 里的我们）。
      //    所以：如果这一行（或它所在分组）马上要被 display:none，先把焦点收进
      //    搜索框 —— 仍在 menuRef 里，官方 onBlur 就会放过，菜单不会关。
      const ae = document.activeElement;
      if (ae && ae !== document.body && ae !== document.documentElement
        && menu.contains(ae) && !st.bar.contains(ae)) {
        for (const p of plan) {
          const at = p.rows.indexOf(ae);
          if (!p.secShow || (at >= 0 && !p.show[at])) {
            try { st.input.focus({ preventScroll: true }); } catch (e2) { }
            break;
          }
        }
      }

      // ③ 再落属性
      for (const p of plan) {
        for (let i = 0; i < p.rows.length; i++) {
          if (p.show[i]) p.rows[i].removeAttribute(HIDE);
          else p.rows[i].setAttribute(HIDE, "1");
        }
        if (p.secShow) p.sec.removeAttribute(GHIDE);
        else p.sec.setAttribute(GHIDE, "1");
      }

      // 空态：只有"筛到 0 条"才显示（真的没有模型是官方自己的空态，别抢）
      // ★ 只在内容真的变时才重建 DOM：每次 apply 都重写这里会产生 childList 变更，
      //   观察者又被触发 ⇒ 60ms 无限自我循环（真烧 CPU）。
      const filtering = !!q || !!selName;
      const emptyKey = (filtering && shown === 0 && totalRows > 0) ? `e${totalRows}` : "";
      if (emptyKey) {
        if (st.empty.__dshKey !== emptyKey) {
          st.empty.__dshKey = emptyKey;
          st.empty.innerHTML = "";
          const span = document.createElement("span");
          span.textContent = `\u6ca1\u6709\u5339\u914d\u7684\u6a21\u578b\uff08\u5171 ${totalRows} \u4e2a\uff09`;
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = "\u6e05\u7a7a\u641c\u7d22\u4e0e\u7b5b\u9009";
          btn.addEventListener("click", () => {
            st.query = "";
            st.groupEl = null;
            st.groupName = null;
            st.input.value = "";
            apply(menu);
          });
          st.empty.appendChild(span);
          st.empty.appendChild(btn);
        }
        st.empty.style.display = "";
      } else {
        if (st.empty.__dshKey) { st.empty.__dshKey = ""; st.empty.innerHTML = ""; }
        st.empty.style.display = "none";
      }
    } catch (e) {
      try { console.warn("[dsh-model-search] 过滤失败（已忽略）", e); } catch (e2) { }
    } finally {
      st.applying = false;
    }
  }

  // ── 观察菜单出现 / 内容变化 ───────────────────────────────────────
  let timer = null;
  // ★ 菜单**内部**的文本变化也要看（characterData）：
  //   官方把分组名渲染成 `group.name`（官方 client.js:829），提供方重新注册 /
  //   名册刷新时 React 只改文本节点、不换元素 ⇒ 只观察 childList 的话，
  //   胶囊上会一直挂着过期的名字（筛选本身已按元素身份认领，不受影响，
  //   但标签会骗人）。作用域只到菜单，别扫整页（正文流式输出会疯狂触发）。
  let menuMo = null;
  let menuMoOn = null;
  // ★ 菜单开着时每秒自查一次。为什么需要它：分组名"原地改名"只有 characterData
  //   变更，而实测（2026-09-26，ui-check inject 连跑 4 次）观察者**偶发漏掉**这类
  //   记录（那一跑 sweeps 5→5、胶囊标签停在旧名字）。筛选本身已按元素身份认领、
  //   不受影响，但标签会骗人 ⇒ 用一次廉价自查把它收敛。菜单一关就停。
  let menuTick = null;
  function startTick() {
    if (menuTick) return;
    menuTick = setInterval(() => {
      if (!menuMoOn || !menuMoOn.isConnected) { stopTick(); return; }
      schedule();
    }, 1000);
  }
  function stopTick() {
    if (menuTick) { clearInterval(menuTick); menuTick = null; }
  }
  function watchMenu(menu) {
    if (menuMo && menuMoOn === menu) return;
    if (menuMo) menuMo.disconnect();
    menuMoOn = menu;
    menuMo = new MutationObserver(schedule);
    menuMo.observe(menu, { childList: true, subtree: true, characterData: true });
    startTick();
    stats.watch = {
      on: true,
      isFirstMenu: menu === document.querySelector('div[role="menu"]'),
      hasSection: !!menu.querySelector('section[role="group"][aria-labelledby]'),
      menuClass: String(menu.className || "").slice(0, 40),
      childCount: menu.childElementCount
    };
  }
  function unwatchMenu() {
    if (menuMo) menuMo.disconnect();
    menuMo = null;
    menuMoOn = null;
    stopTick();
    stats.watch = { on: false };
  }
  function sweep() {
    timer = null;
    stats.sweeps++;
    try {
      const menu = findModelMenu();
      if (!menu) { unwatchMenu(); return; }
      if (!menu.__dshMs) {
        const groupsContainer = menu.querySelector('section[role="group"][aria-labelledby]').parentElement;
        if (!groupsContainer || !groupsContainer.parentElement) return;
        buildBar(menu, groupsContainer);
      }
      watchMenu(menu);
      apply(menu);
    } catch (e) {
      // ★ 失败就安静退出：官方界面照常用，最坏只是没有搜索框
      try { console.warn("[dsh-model-search] 跳过（已忽略）", e); } catch (e2) { }
    }
  }
  function schedule() {
    if (timer) return;
    timer = setTimeout(sweep, 60);   // 合并同一批 mutation
  }

  const mo = new MutationObserver(schedule);
  mo.observe(document.body, { childList: true, subtree: true });
  schedule();   // 页面加载时菜单可能已经开着（重载场景）
})();
