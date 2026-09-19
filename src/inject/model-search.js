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
.dsh-ms-pills{display:flex;flex-wrap:wrap;gap:6px}
.dsh-ms-pill{font:inherit;font-size:12px;line-height:20px;padding:0 9px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1,#e6e8eb);background:transparent;
  color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer;white-space:nowrap}
.dsh-ms-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.045))}
.dsh-ms-pill[data-on="1"]{background:#4d6bfe;border-color:#4d6bfe;color:#fff}
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

    const st = { bar, input, pills, empty, query: "", group: null, applying: false };
    menu.__dshMs = st;

    input.addEventListener("input", () => {
      st.query = input.value || "";
      apply(menu);
    });

    input.addEventListener("keydown", (e) => {
      // Esc 先清空搜索/筛选，而不是直接把菜单关掉（再按一次才关）
      if (e.key === "Escape" && (st.query || st.group)) {
        e.stopPropagation();
        e.preventDefault();
        st.query = "";
        st.group = null;
        input.value = "";
        apply(menu);
      }
    });

    return st;
  }

  // ── 应用过滤 ──────────────────────────────────────────────────────
  function apply(menu) {
    const st = menu.__dshMs;
    if (!st || st.applying) return;
    st.applying = true;
    try {
      const q = (st.query || "").trim().toLowerCase();
      const sections = Array.from(menu.querySelectorAll('section[role="group"][aria-labelledby]'));

      // 提供方清单（每次重算：插件可能热更新出新提供方）
      const names = sections.map(groupTitleOf);

      // 胶囊按钮：只在分组 > 1 时出现（只有一个分组时它没意义、白占地方）
      if (names.length > 1) {
        st.pills.style.display = "";
        const counts = sections.map((s) => rowsOf(s).length);
        const total = counts.reduce((a, b) => a + b, 0);
        const want = [`\u5168\u90e8 ${total}`].concat(names.map((n, i) => `${n} ${counts[i]}`));
        if (st.pills.__dshWant !== want.join("|")) {
          st.pills.__dshWant = want.join("|");
          st.pills.innerHTML = "";
          const mk = (label, value) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "dsh-ms-pill";
            b.textContent = label;
            b.dataset.value = value == null ? "" : value;
            b.addEventListener("click", () => {
              const v = b.dataset.value || null;
              st.group = st.group === v ? null : v;
              apply(menu);
            });
            return b;
          };
          st.pills.appendChild(mk(want[0], null));
          names.forEach((n, i) => st.pills.appendChild(mk(want[i + 1], n)));
        }
        Array.from(st.pills.children).forEach((b) => {
          const v = b.dataset.value || null;
          b.dataset.on = (v === st.group) ? "1" : "0";
        });
      } else {
        st.pills.style.display = "none";
        st.group = null;
      }

      let shown = 0;
      let totalRows = 0;
      for (const sec of sections) {
        const gname = groupTitleOf(sec);
        const groupOk = !st.group || gname === st.group;
        const groupHitByQuery = !!q && gname.toLowerCase().includes(q);
        const rows = rowsOf(sec);
        let shownInGroup = 0;
        for (const row of rows) {
          totalRows++;
          const hit = !q || groupHitByQuery || haystackOf(row).includes(q);
          const show = groupOk && hit;
          if (show) { row.removeAttribute(HIDE); shownInGroup++; shown++; }
          else row.setAttribute(HIDE, "1");
        }
        // 空分组整段藏掉（连提供方标题一起），但"没搜索条件时不藏"
        const secShow = groupOk && (shownInGroup > 0 || !q);
        if (secShow) sec.removeAttribute(GHIDE);
        else sec.setAttribute(GHIDE, "1");
      }

      // 空态：只有"筛到 0 条"才显示（真的没有模型是官方自己的空态，别抢）
      const filtering = !!q || !!st.group;
      if (filtering && shown === 0 && totalRows > 0) {
        st.empty.style.display = "";
        st.empty.innerHTML = "";
        const span = document.createElement("span");
        span.textContent = `\u6ca1\u6709\u5339\u914d\u7684\u6a21\u578b\uff08\u5171 ${totalRows} \u4e2a\uff09`;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = "\u6e05\u7a7a\u641c\u7d22\u4e0e\u7b5b\u9009";
        btn.addEventListener("click", () => {
          st.query = "";
          st.group = null;
          st.input.value = "";
          apply(menu);
        });
        st.empty.appendChild(span);
        st.empty.appendChild(btn);
      } else {
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
  function sweep() {
    timer = null;
    try {
      const menu = findModelMenu();
      if (!menu) return;
      if (!menu.__dshMs) {
        const groupsContainer = menu.querySelector('section[role="group"][aria-labelledby]').parentElement;
        if (!groupsContainer || !groupsContainer.parentElement) return;
        buildBar(menu, groupsContainer);
      }
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
