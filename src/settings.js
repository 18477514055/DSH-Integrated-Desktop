"use strict";

/**
 * settings.js —— 设置窗口页面逻辑。
 *
 * 三栏：常规 / 诊断与修复 / 关于。
 * 「诊断与修复」那一栏与加载页底部抽屉**用的是同一个动作白名单**
 * （都在主进程 `diagnostics.js` 里），所以两边永远一致，不会各写一份。
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const S = window.dshShell;
  const output = ShellUI.createOutput($("out"), $("btn-clear"));
  output.init($("btn-clear"));

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

  async function doCheck() {
    upStatus("正在查 GitHub…");
    $("btn-up-check").disabled = true;
    try {
      const r = await S.checkUpdate();
      lastCheck = r;
      if (!r || !r.ok) {
        upStatus(`检查失败：${(r && r.reason) || "未知原因"}`);
        return;
      }
      if (!r.hasUpdate) {
        upStatus(`已是最新（v${r.current}）`);
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

    S.onUpdateProgress((p) => {
      if (!p) return;
      const pct = Math.max(0, Math.min(100, p.percent || 0));
      $("up-fill").style.width = `${pct}%`;
      $("up-prog").textContent = p.total
        ? `${fmtBytes(p.got)} / ${fmtBytes(p.total)}（${pct}%）`
        : fmtBytes(p.got);
    });

    // 托盘那条「检查更新…」= 打开设置页 + 跳到这一栏 + 自动查一次
    if (S.onFocusPane) {
      S.onFocusPane((pane) => {
        if (!pane) return;
        switchPane(String(pane));
        if (String(pane) === "update") doCheck();
        if (String(pane) === "plugins") loadPlugins(false);
      });
    }
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

  function wirePlugins() {
    $("btn-pl-check").addEventListener("click", () => loadPlugins(true));
    $("btn-pl-hub").addEventListener("click", () => S.openPluginHub().catch(() => { }));

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
    loadPlugins(false);

    await ShellUI.mountActions($("actions"), { output, verdictEl: $("verdict") });
  }

  boot();
})();
