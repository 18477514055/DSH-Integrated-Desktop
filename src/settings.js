"use strict";

/**
 * settings.js —— 设置窗口页面逻辑。
 *
 * 栏位：常规 / 更新 / 集成版插件 / 首次安装向导（**不进导航**）/ 诊断与修复 / 关于。
 * 「诊断与修复」那一栏与加载页底部抽屉**用的是同一个动作白名单**
 * （都在主进程 `diagnostics.js` 里），所以两边永远一致，不会各写一份。
 *
 * ★ 「首次安装向导」为什么藏在页面里而不是导航里：它只对"还没有插件的全新用户"有意义
 *   （0.2.6 起安装包不带插件）。露出的两条路见 `wirePlugins()` 的 `btn-pl-wizard`
 *   与主进程的 `maybeAutoOpenFirstRun()`。
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const S = window.dshShell;
  const output = ShellUI.createOutput($("out"), $("btn-clear"));
  output.init($("btn-clear"));

  /**
   * 「跳到某一栏」的订阅 —— **必须在这里（同步执行期）就订上**。
   *
   * ★ 原来它写在 `wireUpdate()` 里，而那要等 `boot()` 先 `await S.getEnv()` 才走到。
   *   主进程那边却是在 `did-finish-load` 那一刻 `send()` 的 —— 两个时刻谁先谁后没有保证，
   *   实测那条消息**丢**了：托盘点「检查更新…」会把设置窗口打开，但停在「常规」栏、
   *   也不会自动查一次（看起来像"托盘那条菜单没接线"）。
   *   首启向导走的**是同一条路**（`openSettingsWindow("welcome")`）⇒ 不修的话
   *   自动弹出的向导会停在「常规」栏，用户根本看不到勾选清单。
   *
   * 所以：订阅提前到同步期，先记下来；等 `boot()` 把各栏都接好线了再执行。
   */
  let pendingPane = null;
  let paneHandler = null;
  if (S && S.onFocusPane) {
    S.onFocusPane((pane) => {
      if (!pane) return;
      if (paneHandler) paneHandler(String(pane));
      else pendingPane = String(pane);
    });
  }

  let env = null;
  let savedTimer = null;

  function flashSaved() {
    const el = $("saved");
    el.classList.add("on");
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.classList.remove("on"), 1200);
  }

  // ── 分栏 ──────────────────────────────────────────────────────────
  // 抽成函数是为了**从外面跳到某一栏**（托盘那条「检查更新…」要用）。
  function switchPane(which) {
    document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("on", x.dataset.pane === which));
    document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === which));
  }

  document.querySelectorAll("nav button").forEach((b) => {
    b.addEventListener("click", () => switchPane(b.dataset.pane));
  });

  $("btn-close").addEventListener("click", () => {
    if (S && S.closeSelf) S.closeSelf().catch(() => { });
  });

  // ── 设置项 ────────────────────────────────────────────────────────
  async function put(key, value) {
    try {
      const next = await S.setSetting(key, value);
      if (next) { env.settings = next; flashSaved(); }
      return next;
    } catch (e) {
      output.append("err", `保存 ${key} 失败：${(e && e.message) || e}\n`);
    }
  }

  function wire() {
    $("set-closeToTray").addEventListener("change", (e) => put("closeToTray", e.target.checked));

    $("set-port").addEventListener("change", (e) => {
      const n = parseInt(e.target.value, 10);
      if (!Number.isFinite(n) || n < 1024 || n > 65535) {
        e.target.value = env.settings.port;
        output.append("err", "端口必须是 1024~65535 之间的整数，已还原。\n");
        return;
      }
      put("port", n);
    });

    $("set-workspace").addEventListener("change", (e) => put("workspace", e.target.value.trim() || null));

    $("btn-pick-ws").addEventListener("click", async () => {
      try {
        const r = await S.pickDirectory(env.settings.workspace || undefined);
        if (r && r.ok && r.path) {
          $("set-workspace").value = r.path;
          await put("workspace", r.path);
        } else if (r && r.message) {
          output.append("sys", r.message + "\n");
        }
      } catch (e2) {
        output.append("err", `选目录失败：${(e2 && e2.message) || e2}\n`);
      }
    });

    $("btn-open-home").addEventListener("click", () => S.openLocation("dsh-home").catch(() => { }));
    $("btn-open-logs").addEventListener("click", () => S.openLocation("logs").catch(() => { }));

    $("btn-copy-diag").addEventListener("click", async () => {
      // 复用主进程里那一条动作，不在页面上另写一份逻辑
      document.querySelector('nav button[data-pane="diag"]').click();
      try { await S.runAction("copy-diag"); } catch (e) { /* 输出会由事件推过来 */ }
    });
  }

  // ── 更新（实现全在主进程 src/update.js）────────────────────────────
  // 用户原话：「外壳设置里面可以加一个检查更新，这样就不用我手动去装了。」
  let lastCheck = null;

  const upStatus = (t) => { $("up-status").textContent = t; };

  function fmtBytes(n) {
    if (!n) return "";
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  // ★ 「同时看本机」那一段：线上没发不等于本机没有（自己打的包一直没发出去时就是这样）
  function renderLocal(r) {
    const loc = r && r.localNewer ? r.localNewer : null;
    if (!loc) { $("up-row-local").style.display = "none"; return; }
    $("up-local-ver").textContent = `v${loc.version}`;
    $("up-local-path").textContent = loc.path;
    $("up-row-local").style.display = "";
  }

  async function doCheck() {
    upStatus("正在查 GitHub 与本机…");
    $("btn-up-check").disabled = true;
    try {
      const r = await S.checkUpdate();
      lastCheck = r;
      renderLocal(r);
      if (!r || !r.ok) {
        // 线上查不到**不代表本机没有** —— 本地那一段照样显示
        upStatus(`检查失败：${(r && r.reason) || "未知原因"}`
          + (r && r.localNewer ? "（不过本机扫到了更新的安装包，见下）" : ""));
        $("up-row-new").style.display = "none";
        return;
      }
      if (!r.hasUpdate) {
        upStatus(r.localNewer
          ? `线上已是最新（v${r.current}），但本机有更新的安装包 v${r.localNewer.version}`
          : `已是最新（v${r.current}）`);
        $("up-row-new").style.display = "none";
        return;
      }
      upStatus(`发现新版本 v${r.latest}（当前 v${r.current}）`);
      $("up-latest").textContent = `v${r.latest}`;
      $("up-asset").textContent = r.asset
        ? `${r.asset.name} · ${fmtBytes(r.asset.size)}`
        : "（这个 Release 没挂安装包）";
      $("up-notes").textContent = r.notes || "(没有说明)";
      $("btn-up-go").disabled = !r.asset;
      $("up-row-new").style.display = "";
    } catch (e) {
      upStatus(`检查出错：${(e && e.message) || e}`);
    } finally {
      $("btn-up-check").disabled = false;
    }
  }

  /** 用本机扫到的那一个安装包升级。路径是**主进程自己发现的**，页面只是回传它。 */
  async function doInstallLocal() {
    const loc = lastCheck && lastCheck.localNewer;
    if (!loc) return;
    $("btn-up-local").disabled = true;
    upStatus(`正在启动本地安装包 v${loc.version}…`);
    try {
      const r = await S.installUpdate(loc.path);
      if (!r || !r.ok) {
        upStatus(`启动失败：${(r && r.reason) || "未知"}`);
        $("btn-up-local").disabled = false;
        return;
      }
      upStatus("安装器已启动。外壳随即退出 —— 装完安装器会自己把新版本打开。");
    } catch (e) {
      upStatus(`出错：${(e && e.message) || e}`);
      $("btn-up-local").disabled = false;
    }
  }

  async function doInstall() {
    if (!lastCheck || !lastCheck.asset) return;
    $("btn-up-go").disabled = true;
    $("up-bar").style.display = "";
    upStatus(`正在下载 v${lastCheck.latest}…`);
    try {
      const d = await S.downloadUpdate(lastCheck.asset);
      if (!d || !d.ok) {
        upStatus(`下载失败：${(d && d.reason) || "未知"}`);
        $("btn-up-go").disabled = false;
        return;
      }
      upStatus(d.reused ? "本地已有这个安装包，直接安装…" : "下载完成，正在启动安装器…");
      $("up-prog").textContent = "";
      const r = await S.installUpdate(d.path);
      if (!r || !r.ok) {
        upStatus(`启动安装器失败：${(r && r.reason) || "未知"}`);
        $("btn-up-go").disabled = false;
        return;
      }
      upStatus("安装器已启动。外壳随即退出 —— 装完安装器会自己把新版本打开。");
    } catch (e) {
      upStatus(`出错：${(e && e.message) || e}`);
      $("btn-up-go").disabled = false;
    }
  }

  function wireUpdate() {
    $("up-current").textContent = (env && env.appVersion) ? `v${env.appVersion}` : "—";
    $("btn-up-check").addEventListener("click", doCheck);
    $("btn-up-page").addEventListener("click", () => S.openReleases().catch(() => { }));
    $("btn-up-go").addEventListener("click", doInstall);
    $("btn-up-local").addEventListener("click", doInstallLocal);

    S.onUpdateProgress((p) => {
      if (!p) return;
      const pct = Math.max(0, Math.min(100, p.percent || 0));
      $("up-fill").style.width = `${pct}%`;
      $("up-prog").textContent = p.total
        ? `${fmtBytes(p.got)} / ${fmtBytes(p.total)}（${pct}%）`
        : fmtBytes(p.got);
    });

    // 托盘那条「检查更新…」= 打开设置页 + 跳到这一栏 + 自动查一次；
    // 首启向导同一条路（跳到 welcome 并开始读清单）。
    // 订阅本身在文件开头（同步期）就订好了，这里只是把"收到之后做什么"接上。
    paneHandler = (pane) => {
      switchPane(pane);
      if (pane === "update") doCheck();
      if (pane === "plugins") loadPlugins(false);
      if (pane === "welcome") loadWizard();
    };
    // 订阅早于接线时收到的那一条，在这里补做
    if (pendingPane) { const p = pendingPane; pendingPane = null; paneHandler(p); }
  }

  // ── 集成版插件（清单在主进程 src/plugin-catalog.js；装/卸在 src/plugin-install.js）──
  //
  // 用户原话：「想用的时候打开清单，然后点击检查更新，就可以查到我最新推出来的集成版插件。」
  //
  // ★ 页面**不拼 URL、不算哈希**：只提交包名。下载地址与 sha256 由主进程
  //   每次重新拉清单后自己取（理由见 preload.js 那一节）。
  // ★ 清单是**远端数据** ⇒ 所有插进 DOM 的文本一律过 ShellUI.esc，不裸拼 innerHTML。
  let pluginBusy = false;

  const plStatus = (t) => { $("pl-status").textContent = t; };
  const plProg = (t) => { $("pl-prog").textContent = t; };

  function fmtTime(iso) {
    if (!iso) return "未知时间";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** 插件是"从哪来的" —— 这一栏是用户判断"该不该动它"的依据。 */
  function sourceLabel(src) {
    switch (src) {
      case "hub": return "从插件仓库装的";
      case "local-link": return "本地目录联接（开发用）";
      case "local-file": return "本地包文件";
      case "registry": return "从 npm 装的";
      default: return "本地";
    }
  }

  function stateTag(r) {
    switch (r.state) {
      case "installed": return '<span class="tag on">已装</span>';
      case "update": return '<span class="tag up">可更新</span>';
      case "disabled": return '<span class="tag up">没启用</span>';
      case "broken": return '<span class="tag bad">落点丢了</span>';
      case "local": return '<span class="tag on">已装（本地装的）</span>';
      default: return "";
    }
  }

  function cardHtml(r) {
    const e = ShellUI.esc;
    const latest = r.latest || {};
    const desc = latest.description
      ? e(latest.description)
      : '<i style="color:var(--fg-faint)">（发布者未填说明）</i>';

    const tags = [stateTag(r)];
    if (r.devOnly) tags.push('<span class="tag dev">开发者工具</span>');
    if (!r.compatible) tags.push('<span class="tag bad">不适用于本外壳</span>');

    const meta = [];
    meta.push(`线上 v${latest.version}`);
    if (r.local) {
      meta.push(`本机 v${r.local.version}`);
      meta.push(`装在：${sourceLabel(r.localSource)}`);
      if (r.local.target) meta.push(`→ ${r.local.target}`);
    }
    if (latest.repo) meta.push(`来自 ${latest.repo}`);
    if (latest.bytes) meta.push(fmtBytes(latest.bytes));
    if (latest.sha256) meta.push(`sha256 ${latest.sha256.slice(0, 12)}…`);
    else meta.push("这条没有 sha256，装上不校验内容");

    const ops = [];
    if (r.canInstall) {
      ops.push(`<button class="btn" data-pl-act="install" data-pl-name="${e(r.name)}">安装</button>`);
    }
    // ★ 本地已经装着的：**不**给"安装"，给"改用仓库版"并且界面会先问一句 ——
    //   否则一个看起来无害的「安装」会把用户的 dev link 悄悄换掉。
    if (r.canReplace) {
      ops.push(`<button class="btn" data-pl-act="install" data-pl-replace="1" data-pl-source="${e(sourceLabel(r.localSource))}" data-pl-name="${e(r.name)}">改用仓库版</button>`);
    }
    if (r.canUpdate) {
      ops.push(`<button class="btn" data-pl-act="install" data-pl-name="${e(r.name)}">更新到 v${e(r.remoteVersion)}</button>`);
    }
    if (r.canUninstall) {
      ops.push(`<button class="btn" data-pl-act="uninstall" data-pl-name="${e(r.name)}">卸载</button>`);
    }
    if (!ops.length) ops.push('<span class="note">已是最新</span>');

    return `<div class="pl-card">
      <div class="hd"><span class="nm">${e(r.name)}</span>${tags.join("")}</div>
      <p class="ds">${desc}</p>
      <div class="meta">${meta.map(e).join(" · ")}</div>
      <div class="ops">${ops.join("")}</div>
    </div>`;
  }

  function renderPlugins(st) {
    const list = $("pl-list");
    if (!st || !st.ok) {
      plStatus(`取清单失败：${(st && st.error) || "未知原因"}`);
      plProg("");
      list.innerHTML = '<div class="pl-empty">拿不到插件清单（连不上插件仓库，本机也没有缓存）。</div>';
      return;
    }

    const c = st.counts || {};
    $("pl-repo").textContent = st.repo || "—";
    $("pl-count").textContent = `已装 ${c.installed || 0} / 清单 ${c.total || 0}`;
    $("pl-upd").textContent = [
      c.updatable ? `${c.updatable} 个可更新` : "",
      c.local ? `${c.local} 个是本地装的` : "",
      c.broken ? `${c.broken} 个落点丢了` : "",
    ].filter(Boolean).join(" · ");
    plStatus(st.stale
      ? `这次没连上插件仓库，显示的是缓存（${fmtTime(st.fetchedAt)}）`
      : `清单更新于 ${fmtTime(st.fetchedAt)}`);

    // 读不懂的东西**明说**，不假装没发生
    const warn = [];
    if (!st.knownSchema) warn.push(`清单格式是 ${st.schema}，本外壳认识的是更早的一版 —— 可能读不全。`);
    for (const w of (st.warnings || []).slice(0, 3)) warn.push(w);
    for (const s of (st.skipped || []).slice(0, 3)) warn.push(`跳过一条：${s}`);
    $("pl-notice").innerHTML = warn.length
      ? `<div class="pl-warn">${warn.map(ShellUI.esc).join("<br>")}</div>`
      : "";

    if (!st.rows || !st.rows.length) {
      list.innerHTML = '<div class="pl-empty">清单是空的 —— 仓库里还没有插件。</div>';
      return;
    }
    list.innerHTML = st.rows.map(cardHtml).join("");
  }

  async function loadPlugins(force) {
    if (pluginBusy) return;
    pluginBusy = true;
    $("btn-pl-check").disabled = true;
    plStatus(force ? "正在查插件仓库…" : "正在读取…");
    try {
      const st = force ? await S.checkPlugins() : await S.plugins();
      renderPlugins(st);
    } catch (e) {
      plStatus(`出错：${(e && e.message) || e}`);
    } finally {
      pluginBusy = false;
      $("btn-pl-check").disabled = false;
    }
  }

  async function doInstallPlugin(name, btn) {
    if (pluginBusy) return;
    pluginBusy = true;
    btn.disabled = true;
    $("pl-row-prog").style.display = "";
    $("pl-fill").style.width = "0%";
    plProg(`正在准备 ${name}…`);
    let ok = false;
    try {
      const r = await S.installPlugin(name, null);
      if (!r || !r.ok) {
        plProg(`失败：${(r && r.errors && r.errors.join("；")) || "未知原因"}`);
        return;
      }
      $("pl-fill").style.width = "100%";
      plProg(`已装 ${name}${r.version ? " v" + r.version : ""} —— 重启一次客户端才生效`);
      for (const w of (r.warnings || [])) output.append("sys", `[插件] ${w}\n`);
      ok = true;
    } catch (e) {
      plProg(`出错：${(e && e.message) || e}`);
    } finally {
      pluginBusy = false;
      btn.disabled = false;
    }
    // ★ 刷新必须放在 finally **之后**：loadPlugins 开头就有 `if (pluginBusy) return`，
    //   放在 try 里会被自己刚设上的忙标志挡掉 —— 表现是"装成功了但卡片还是未装"，
    //   用户会以为失败然后再点一次。（`ui-check plugins` 实测抓到的真 bug）
    if (ok) await loadPlugins(false);
  }

  async function doUninstallPlugin(name, btn) {
    if (pluginBusy) return;
    pluginBusy = true;
    btn.disabled = true;
    $("pl-row-prog").style.display = "";
    plProg(`正在卸载 ${name}…`);
    let ok = false;
    try {
      const r = await S.uninstallPlugin(name);
      ok = !!(r && r.ok);
      plProg(ok
        ? `已卸载 ${name} —— 重启一次客户端才生效`
        : `失败：${(r && r.errors && r.errors.join("；")) || "未知原因"}`);
    } catch (e) {
      plProg(`出错：${(e && e.message) || e}`);
    } finally {
      pluginBusy = false;
      btn.disabled = false;
    }
    if (ok) await loadPlugins(false);   // 同上：解锁之后再刷新
  }

  /**
   * 渲染「本地插件包」区块（断网也能装的那条路）。
   *
   * ★ 这里刻意**不复用** cardHtml：那张卡的动作是"下载 + 安装"，
   *   而这一张的动作是"从本机文件安装"，措辞必须能一眼分清，
   *   否则用户在断网时点了一个写着"安装"的按钮却不知道文件是从哪来的。
   */
  function renderPack(pack) {
    const list = $("pl-pack-list");
    const notice = $("pl-pack-notice");
    const st = $("pl-pack-status");
    const dirEl = $("pl-pack-dir");
    if (!list) return;

    if (!pack) { st.textContent = "还没扫描"; list.innerHTML = ""; notice.innerHTML = ""; dirEl.textContent = ""; return; }

    if (!pack.found) {
      st.textContent = "本机没找到插件包";
      dirEl.textContent = "";
      list.innerHTML = "";
      // 找过哪些地方也说出来 —— 用户才知道该往哪放
      const tried = (pack.tried || []).slice(0, 4);
      notice.innerHTML = tried.length
        ? `<div class="pl-warn">找过这些位置都没有 plugin-index.json：<br>${tried.map(ShellUI.esc).join("<br>")}</div>`
        : "";
      return;
    }

    const items = pack.items || [];
    st.textContent = `找到了：${items.length} 个包${pack.updatedAt ? "（" + fmtTime(pack.updatedAt) + "）" : ""}`;
    dirEl.textContent = pack.dir || "";

    const warn = [];
    for (const w of (pack.warnings || []).slice(0, 3)) warn.push(w);
    if (pack.missing && pack.missing.length) warn.push(`这些条目的文件不在包里：${pack.missing.join("、")}`);
    if (pack.error) warn.push(pack.error);
    notice.innerHTML = warn.length
      ? `<div class="pl-warn">${warn.map(ShellUI.esc).join("<br>")}</div>`
      : "";

    list.innerHTML = items.length ? items.map((it) => {
      const e = ShellUI.esc;
      const desc = it.description ? e(it.description) : '<i style="color:var(--fg-faint)">（发布者未填说明）</i>';
      const meta = [`v${it.version}`];
      if (it.bytes) meta.push(fmtBytes(it.bytes));
      meta.push("来自本机插件包");
      return `<div class="pl-card">
        <div class="hd"><span class="nm">${e(it.name)}</span><span class="tag dev">本机插件包</span></div>
        <p class="ds">${desc}</p>
        <div class="meta">${meta.map(e).join(" · ")}</div>
        <div class="ops"><button class="btn" data-pack-act="install" data-pack-name="${e(it.name)}">从插件包装</button></div>
      </div>`;
    }).join("") : '<div class="pl-empty">插件包是空的（里面没有可装的条目）。</div>';
  }

  async function loadPack() {
    $("btn-pl-pack").disabled = true;
    $("pl-pack-status").textContent = "正在扫描…";
    try {
      const p = await S.packScan();
      // 扫描结果里没有 rows（那是 pluginState 才算的）—— 这里够了，本区块只列出包内条目
      renderPack(p);
    } catch (e) {
      $("pl-pack-status").textContent = `扫描出错：${(e && e.message) || e}`;
    } finally {
      $("btn-pl-pack").disabled = false;
    }
  }

  async function doInstallFromPack(name, btn) {
    if (pluginBusy) return;
    pluginBusy = true;
    btn.disabled = true;
    $("pl-row-prog").style.display = "";
    $("pl-fill").style.width = "0%";
    plProg(`正在从本机插件包安装 ${name}…`);
    let ok = false;
    try {
      const r = await S.installLocal([name]);
      ok = !!(r && r.installed && r.installed.length);
      plProg(ok
        ? `已从插件包装上 ${name} —— 重启一次客户端才生效`
        : `失败：${((r && r.results && r.results[0] && r.results[0].errors) || (r && r.errors) || ["未知原因"]).join("；")}`);
    } catch (e) {
      plProg(`出错：${(e && e.message) || e}`);
    } finally {
      pluginBusy = false;
      btn.disabled = false;
    }
    if (ok) await loadPlugins(false);
  }

  function wirePack() {
    const scan = $("btn-pl-pack");
    const pick = $("btn-pl-pack-dir");
    if (scan) scan.addEventListener("click", () => loadPack());
    if (pick) {
      pick.addEventListener("click", async () => {
        pick.disabled = true;
        try {
          const r = await S.pickPackDir();
          if (r && r.ok) {
            plStatus(`插件包目录已设为 ${r.path}${r.hasIndex ? "" : "（但这个目录里没找到 plugin-index.json）"}`);
            await loadPack();
          }
        } catch (e) {
          plStatus(`选择目录出错：${(e && e.message) || e}`);
        } finally {
          pick.disabled = false;
        }
      });
    }
    const list = $("pl-pack-list");
    if (list) {
      list.addEventListener("click", (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest("button[data-pack-act]") : null;
        if (!btn) return;
        if (btn.dataset.packAct === "install") doInstallFromPack(btn.dataset.packName, btn);
      });
    }
  }

  function wirePlugins() {
    $("btn-pl-check").addEventListener("click", () => loadPlugins(true));
    $("btn-pl-hub").addEventListener("click", () => S.openPluginHub().catch(() => { }));
    // 安装包不带插件 ⇒ 新用户唯一的入口就是向导。这里给它一个随时能回去的按钮。
    $("btn-pl-wizard").addEventListener("click", () => {
      switchPane("welcome");
      loadWizard();
    });

    // 事件委托：卡片是 innerHTML 画出来的，逐张挂监听会在重画后丢掉
    $("pl-list").addEventListener("click", (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest("button[data-pl-act]") : null;
      if (!btn) return;
      const act = btn.dataset.plAct;
      const name = btn.dataset.plName;
      if (act === "install") {
        // ★ "改用仓库版"是个**会覆盖**的动作（把 dev link 换成从仓库装的那一份），
        //   必须让用户明确点过一次确认 —— 不能长得跟普通「安装」一样。
        if (btn.dataset.plReplace === "1") {
          const go = window.confirm(
            `「${name}」现在装的是本地那一份（${btn.dataset.plSource || "本地"}）。\n\n` +
            "改用仓库版会把它在档案里的指向换成从插件仓库装下来的那一份。\n" +
            "本地那份文件不会被删，但不会再被客户端加载。\n\n继续吗？"
          );
          if (!go) return;
        }
        doInstallPlugin(name, btn);
      } else if (act === "uninstall") {
        doUninstallPlugin(name, btn);
      }
    });

    S.onPluginProgress((p) => {
      if (!p) return;
      if (p.kind === "start") {
        $("pl-row-prog").style.display = "";
        plProg(`正在下载 ${p.name}${p.version ? " v" + p.version : ""}…`);
      } else if (p.kind === "progress") {
        const pct = Math.max(0, Math.min(100, p.percent || 0));
        $("pl-fill").style.width = `${pct}%`;
        plProg(p.total ? `${fmtBytes(p.got)} / ${fmtBytes(p.total)}（${pct}%）` : fmtBytes(p.got));
      } else if (p.kind === "end" && !p.ok) {
        plProg(`${p.name} 安装失败`);
      }
    });
  }

  // ── 首次安装向导（0.2.6：安装包不带插件，插件在这一屏勾）────────────
  //
  // 用户原话：「我们发出去的包干干净净的，有本体客户端就足够了……如果他们在下载的时候
  // 或者安装的时候勾选，他们就从我的仓库的其他链接拉取他们。」
  //
  // 与「集成版插件」栏的分工：
  //   · 那一栏是**长期管理**：单个装 / 更 / 卸，看每一条的来路与状态；
  //   · 这一屏是**第一次的挑选**：一屏勾完、一次装一批、装完收工。
  // 两屏读的是**同一份** pluginState（主进程算出来的唯一真相）⇒ 不会互相矛盾。
  //
  // ★ 这一屏**不进左侧导航**：它只对"还没有插件的新用户"有意义，对老用户是噪音。
  //   入口只有两个：主进程 firstRunDue() 判定后的自动弹出，
  //   以及「集成版插件」栏里的「打开首次安装向导」按钮。
  let frBusy = false;

  const frStatus = (t) => { $("fr-status").textContent = t; };
  const frProg = (t) => { $("fr-prog").textContent = t; };

  /** 这一条**现在能不能装**。不能装的画成灰的，而不是给一个点了必然失败的按钮。 */
  function frInstallable(r) {
    if (!r || !r.compatible) return false;
    if (!r.latest || !r.latest.version) return false;
    // ★ 本地插件包的条目 state 一定是 "local"（本机装着它自己那份源码联接）——
    //   那是**正常**的，不是"已经装好了"，所以也要能勾（否则离线路径永远勾不上）。
    if (r.localPack) return true;
    return ["not-installed", "broken"].includes(r.state);
  }

  /** 不能装的话，为什么 —— 直接印在卡片上，省得用户猜。 */
  function frWhyNot(r) {
    if (!r.compatible) return "不适用于本外壳";
    if (!r.latest || !r.latest.version) return "清单里没有可装的版本";
    if (r.localPack) return "";
    switch (r.state) {
      case "installed": return "已经装好了";
      case "update": return "已经装好了（有新版，去「集成版插件」里更新）";
      case "disabled": return "已经装好了（没启用）";
      case "local": return "本机已经装了（本地那一份）";
      default: return "";
    }
  }

  function frItemHtml(r) {
    const e = ShellUI.esc;
    const latest = r.latest || {};
    const can = frInstallable(r);
    // 默认勾上"能装的、且不是开发者工具"的那些 —— 一进来就是一个可用的默认选择
    const checked = can && !r.devOnly;
    const desc = latest.description
      ? e(latest.description)
      : '<i style="color:var(--fg-faint)">（发布者未填说明）</i>';

    const tags = [];
    if (r.devOnly) tags.push('<span class="tag dev">开发者工具</span>');
    if (!r.compatible) tags.push('<span class="tag bad">不适用于本外壳</span>');
    else if (!can) tags.push('<span class="tag on">已装</span>');
    // ★ 这一条来自本机插件包（网盘那份），不是仓库 —— 说出来，别让人以为是线上版本
    if (r.localPack) tags.push('<span class="tag dev">本机插件包</span>');

    // 措辞跟着来源走：来自插件包的**不能**写"线上 v…"，那会误导
    const meta = [r.localPack ? `本机插件包 v${latest.version}` : `线上 v${latest.version}`];
    if (r.local && !r.localPack) meta.push(`本机 v${r.local.version}`);
    if (latest.repo && !r.localPack) meta.push(`来自 ${latest.repo}`);
    if (latest.bytes) meta.push(fmtBytes(latest.bytes));
    if (r.alsoLocalPack) meta.push("本机插件包里也有这一份");
    if (!can) meta.push(frWhyNot(r));

    // ★ 整张卡片就是一个 <label> ⇒ 点卡片任何地方都能勾/取消（不必瞄准那个小方块）。
    //   不可装的给 disabled：<label> 点它不会有任何反应，也就不会"看着能点其实点不动"。
    return `<label class="pl-card fr-item${can ? "" : " off"}">
      <div class="hd">
        <input type="checkbox" class="fr-ck" data-fr-name="${e(r.name)}"${checked ? " checked" : ""}${can ? "" : " disabled"}>
        <span class="nm">${e(r.name)}</span>${tags.join("")}
      </div>
      <p class="ds">${desc}</p>
      <div class="meta">${meta.map(e).join(" · ")}</div>
    </label>`;
  }

  const frSelected = () => [...document.querySelectorAll("#fr-list input.fr-ck:checked")]
    .map((x) => x.dataset.frName);

  function frSyncActions() {
    const sel = frSelected();
    const btn = $("btn-fr-install");
    btn.disabled = frBusy || sel.length === 0;
    btn.textContent = sel.length ? `安装选中的 ${sel.length} 个插件` : "安装选中的插件";
    $("fr-sel").textContent = sel.length ? "" : "（上面一条都没勾）";
  }

  /**
   * 把"本地插件包"并进向导的候选里。
   *
   * 为什么要有：用户从网盘下的插件包解压出来，**断网也该能勾着装**。
   * 网络清单与本地包可能重叠（同一个包两处都有）——那时以网络那条为准
   * （网络能反映下架与新版本），但给本地那条打上标记，让人知道本机也有一份。
   *
   * ★ 本地条目与网络条目**同形**（plugin-pack.js 刻意复用同一套 groupByName /
   *   mergeInstalled），所以这里只是并集 + 去重，界面代码一行都不用改。
   */
  function frMergePack(st) {
    const net = (st && st.rows) || [];
    const pack = (st && st.pack) || null;
    const packRows = (pack && pack.rows) || [];
    if (!packRows.length) return { rows: net, pack: pack || null, source: "net" };

    const have = new Set(net.map((r) => r.name));
    const extra = packRows.filter((r) => !have.has(r.name));
    const merged = net.map((r) => {
      const hit = packRows.find((p) => p.name === r.name);
      return hit ? { ...r, alsoLocalPack: true } : r;
    }).concat(extra);
    // 全部来自本地包（网络那条彻底拿不到）时才算"离线模式"
    return { rows: merged, pack, source: net.length ? "both" : "pack" };
  }

  function renderWizard(st) {
    const list = $("fr-list");
    const m = frMergePack(st);
    const rows = m.rows;
    const pack = m.pack;

    // ★ 这一栏的措辞分三种情形，别混：
    //   ① 网络拿到了           → 照旧
    //   ② 网络没拿到，但有本地包 → **明确说"离线可用"**，这是 0.2.8 的重点
    //   ③ 两个都没有           → 才说"先跳过"
    if (!st || (!st.ok && !rows.length)) {
      $("fr-repo").textContent = "—";
      frStatus(`取清单失败：${(st && st.error) || "未知原因"}`);
      list.innerHTML = '<div class="pl-empty">连不上插件仓库，本机也没有缓存、没找到插件包 —— '
        + '先点「先跳过」把客户端用起来。装了插件包之后，在「集成版插件」里点'
        + '「扫描本机插件包」就能离线装。</div>';
      $("fr-actions").style.display = "";
      frSyncActions();
      return;
    }

    $("fr-repo").textContent = (m.source === "pack")
      ? "本机插件包"
      : (st.repo || "—");
    frStatus(m.source === "pack"
      ? `连不上插件仓库，改用**本机插件包**（${pack.dir || ""}${pack.updatedAt ? "，" + fmtTime(pack.updatedAt) : ""}）`
      : (st.stale
        ? `这次没连上插件仓库，显示的是缓存（${fmtTime(st.fetchedAt)}）`
        : `清单更新于 ${fmtTime(st.fetchedAt)}`));

    // 读不懂的东西**明说**，不假装没发生（与「集成版插件」栏同一套措辞）
    const warn = [];
    if (!st.knownSchema) warn.push(`清单格式是 ${st.schema}，本外壳认识的是更早的一版 —— 可能读不全。`);
    for (const w of (st.warnings || []).slice(0, 3)) warn.push(w);
    if (m.source !== "net" && pack && pack.found) {
      warn.push(`本机插件包：${pack.dir}（${pack.entries ? pack.entries.length : 0} 个包${pack.updatedAt ? "，" + fmtTime(pack.updatedAt) : ""}）`);
    }
    if (pack && pack.missing && pack.missing.length) {
      warn.push(`插件包里这些条目的文件不在：${pack.missing.slice(0, 4).join("、")}${pack.missing.length > 4 ? " …" : ""}`);
    }
    $("fr-notice").innerHTML = warn.length
      ? `<div class="pl-warn">${warn.map(ShellUI.esc).join("<br>")}</div>`
      : "";

    list.innerHTML = rows.length
      ? rows.map(frItemHtml).join("")
      : '<div class="pl-empty">仓库里现在还没有插件，本机插件包里也没有。</div>';
    $("fr-actions").style.display = "";
    frSyncActions();
  }

  async function loadWizard() {
    if (frBusy) return;
    $("fr-done").style.display = "none";
    $("fr-actions").style.display = "";
    $("fr-row-prog").style.display = "none";
    $("fr-notice").innerHTML = "";
    $("fr-list").innerHTML = "";
    $("btn-fr-install").disabled = true;
    frStatus("正在读清单…");
    try {
      renderWizard(await S.plugins());
    } catch (e) {
      frStatus(`出错：${(e && e.message) || e}`);
    }
  }

  /** 装完之后的收工块：说清"装了什么 / 有没有失败 / 下一步点哪"。 */
  function showWizardDone(okList, bad) {
    $("fr-actions").style.display = "none";
    $("fr-row-prog").style.display = "none";
    $("fr-done").style.display = "";
    const lines = [`已经把 ${okList.join("、")} 装进 DSH 档案了。`];
    if (bad.length) {
      lines.push("这几个没装上：" + bad
        .map((x) => `${x.name}（${(x.errors || []).join("；") || "未知原因"}）`).join("；"));
    }
    lines.push("插件要内核重读一次档案才会加载 —— 点下面的按钮重启一次内核就生效了。");
    $("fr-done-text").innerHTML = lines.map(ShellUI.esc).join("<br>");
  }

  async function doInstallSelected() {
    if (frBusy) return;
    const names = frSelected();
    if (!names.length) return;

    frBusy = true;
    $("btn-fr-install").disabled = true;
    $("fr-row-prog").style.display = "";
    $("fr-fill").style.width = "0%";
    frProg(`正在准备 ${names.length} 个插件…`);
    try {
      // ★ 断网兜底：网络那条拿不到清单，但本机插件包里有 ⇒ 走**本地文件**装。
      //   两条路走的是同一个咽喉（installFromArchive：sha256 + validatePluginDir），
      //   区别只有"文件从哪来"。渲染进程在这条路上同样只递包名。
      //
      //   先定来源、再报进度：反过来的话，安装一开始推送进度就会把这个提示覆盖掉，
      //   用户永远看不到"这次走的是本地包"（第一版就是这么写错的）。
      const st = await S.plugins();
      const usePack = !!(st && !st.ok && st.pack && st.pack.found && st.pack.count);
      if (usePack) frProg(`连不上插件仓库 —— 改用本机插件包（${names.length} 个）…`);

      const r = usePack ? await S.installLocal(names) : await S.installPlugins(names);
      const okList = (r && r.installed) || [];
      const bad = ((r && r.results) || []).filter((x) => !x.ok);

      if (!okList.length) {
        const why = (r && r.errors && r.errors.join("；"))
          || bad.map((x) => `${x.name}：${(x.errors || []).join("；")}`).join(" | ")
          || "未知原因";
        frProg(`一个都没装上：${why}`);
        $("fr-fill").style.width = "0%";
        frBusy = false;
        frSyncActions();
        return;
      }

      // ★ 先把账记了再报喜：记不上最多下次再弹一次向导，比"装完了却没记账"轻。
      try { await S.firstRunDone({ installed: okList }); } catch { /* 见上 */ }
      showWizardDone(okList, bad);
    } catch (e) {
      frProg(`出错：${(e && e.message) || e}`);
      frBusy = false;
      frSyncActions();
    }
  }

  /**
   * 「先跳过，直接开始用」—— 真的把路让开：记成收工，然后关掉这个窗口。
   *
   * ★ 必须 **await 完记账再关窗口**：关窗口会触发主进程的 `closed` 处理器，
   *   而它会把"用户直接关掉了向导"记成 `dismissed` —— 两条 IPC 谁先被处理没有保证，
   *   先关窗口就可能把标记写成 `{skipped:true, dismissed:true}`（两种收工方式混在一起）。
   *   实测大部分时候是 skipped 先到，但那是运气，不是保证。
   */
  async function doSkip() {
    if (frBusy) return;
    $("btn-fr-skip").disabled = true;
    try { await S.firstRunDone({ skipped: true }); } catch { /* 记不上最多下次再弹 */ }
    S.closeSelf().catch(() => { });
  }

  /**
   * 重启内核让插件生效。
   *
   * ★ 走的是**诊断白名单里那一个** `restart-kernel`（与「诊断与修复」栏同一个动作），
   *   不另写一套重启逻辑 —— 那条路上的失败回退（换档案起不来时退回原档案）
   *   是 2026-09-19 事故后专门补的，重写一遍必然漏掉。
   * ★ 先让用户确认：重启会打断正在生成的回答。
   */
  async function doRestartForPlugins() {
    const go = await ShellUI.confirmModal(
      "要重启内核吗？\n\n"
      + "正在生成的回答会中断；新内核起来时会重新读一遍 DSH 档案，刚装的插件就生效了。");
    if (!go) return;
    $("btn-fr-restart").disabled = true;
    $("fr-done-text").innerHTML = ShellUI.esc("正在重启内核…（这个窗口马上会关掉，请看主界面）");
    S.runAction("restart-kernel").catch(() => { });
    // 不等它跑完：动作一执行主界面就会切回加载页，这个窗口留着只会挡在前面
    setTimeout(() => { S.closeSelf().catch(() => { }); }, 400);
  }

  function wireWizard() {
    // 勾选变化 → 更新计数与按钮文字（事件委托：卡片是 innerHTML 画出来的）
    $("fr-list").addEventListener("change", (ev) => {
      const t = ev.target;
      if (t && t.classList && t.classList.contains("fr-ck")) frSyncActions();
    });

    $("btn-fr-install").addEventListener("click", doInstallSelected);
    $("btn-fr-skip").addEventListener("click", doSkip);
    $("btn-fr-restart").addEventListener("click", doRestartForPlugins);
    $("btn-fr-finish").addEventListener("click", () => { S.closeSelf().catch(() => { }); });

    S.onPluginProgress((p) => {
      if (!p) return;
      // itemIndex/itemTotal 是整批的第几个；got/total 是**这一个**的字节数。
      // 两个都用上，别混：`p.total` 只可能是字节数。
      const at = p.itemTotal ? `第 ${p.itemIndex || "?"}/${p.itemTotal} 个 · ` : "";
      if (p.kind === "start") {
        $("fr-row-prog").style.display = "";
        frProg(`${at}正在下载 ${p.name}${p.version ? " v" + p.version : ""}…`);
      } else if (p.kind === "progress") {
        const pct = Math.max(0, Math.min(100, p.percent || 0));
        $("fr-fill").style.width = `${pct}%`;
        frProg(at + (p.total
          ? `${fmtBytes(p.got)} / ${fmtBytes(p.total)}（${pct}%）`
          : fmtBytes(p.got)));
      } else if (p.kind === "end" && !p.ok) {
        frProg(`${at}${p.name} 安装失败`);
      }
    });
  }

  // ── 关于 ──────────────────────────────────────────────────────────
  function renderAbout(e) {
    const kv = [
      ["外壳版本", e.appVersion],
      ["Electron", e.electronVersion],
      ["Chrome", e.chromeVersion],
      ["Node", e.nodeVersion],
      ["平台", `${e.platform} ${e.arch}`],
      ["内核版本", e.kernelVersion || "(未知)"],
      ["内核地址", e.serverUrl || "(未启动)"],
      ["内核来源", e.kernelSource || "(未知)"],
      ["DSH_HOME", e.dshHome],
      ["档案", e.profile],
      ["userData", e.userDataDir],
    ];
    $("about-kv").innerHTML = kv
      .map(([k, v]) => `<dt>${ShellUI.esc(k)}</dt><dd>${ShellUI.esc(v)}</dd>`)
      .join("");
    $("ver").textContent = "v" + e.appVersion;
  }

  // ── 启动 ──────────────────────────────────────────────────────────
  async function boot() {
    if (!S) {
      document.querySelector(".panes").innerHTML = "<p>外壳通道未就绪（preload 没跑起来）。</p>";
      return;
    }

    S.onOutput((m) => { if (m) output.append(m.stream || "out", m.text || ""); });

    try {
      env = await S.getEnv();
    } catch (e) {
      output.append("err", `读环境信息失败：${(e && e.message) || e}\n`);
      return;
    }

    ShellUI.setWhale(document.querySelector("header.top .whale"), env.whale, 0.94);
    renderAbout(env);

    $("set-closeToTray").checked = env.settings.closeToTray !== false;
    $("set-port").value = env.settings.port;
    $("set-profile").textContent = env.profile;
    $("set-workspace").value = env.settings.workspace || "";
    $("set-dshhome").textContent = env.dshHome;
    $("set-logdir").textContent = env.logDir;

    wire();
    wireUpdate();
    wirePlugins();
    wireWizard();
    wirePack();
    loadPlugins(false);
    // 本地插件包是"兜底"，开机顺手扫一次（纯磁盘读，不联网、不花钱）。
    // 扫到了就在那一栏显示出来 —— 用户从网盘解压完，不必再点一次才知道能装。
    loadPack();

    await ShellUI.mountActions($("actions"), { output, verdictEl: $("verdict") });
  }

  boot();
})();
