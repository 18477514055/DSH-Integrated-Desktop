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
  document.querySelectorAll("nav button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("on", x === b));
      const which = b.dataset.pane;
      document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === which));
    });
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

    await ShellUI.mountActions($("actions"), { output, verdictEl: $("verdict") });
  }

  boot();
})();
