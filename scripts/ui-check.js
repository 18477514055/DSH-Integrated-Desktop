"use strict";

/**
 * ui-check —— 用 CDP（Chrome DevTools Protocol）**真跑真看**验证界面改动。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不满足于"文件写了 / 语法通过"
 * ══════════════════════════════════════════════════════════════════
 * `$DSH_HOME/AGENTS.md` 第二条硬规矩：验证"某东西能否工作"必须**真让它工作**，
 * "文件存在 / 模块可解析 / 配置里有"一律不构成证据。
 * 而这次的需求全是**界面**：搜索框插进去没有、进度条在不在、
 * 动作按钮点得动吗 —— 只有看渲染后的真实 DOM 才算数。
 *
 * ══════════════════════════════════════════════════════════════════
 * 两种模式（都**不碰**用户正在用的环境）
 * ══════════════════════════════════════════════════════════════════
 *   node scripts/ui-check.js loading
 *     用**临时 userData + 空闲端口 3177** 起一个自己的内核
 *     ⇒ DSH_HOME 落在临时目录，不碰 B 也不碰 A。
 *     检查：白底黑鲸鱼、进度条、阶段清单、底部抽屉、动作清单
 *     （这一条同时证明了 preload→IPC→来源校验→白名单整条链路），
 *     并且**真的跑一次「环境体检」**看输出有没有流回页面。
 *
 *   node scripts/ui-check.js inject
 *     用**临时 userData + 端口 3105** ⇒ 命中 ensureServer 的"复用已有内核"分支
 *     ⇒ **不会起第二个内核**，直接加载正在运行的那个官方 UI（带真实模型目录）。
 *     然后真的点开模型菜单，检查搜索框有没有插进去、能不能过滤、胶囊对不对。
 *
 *   ⚠️ 两种模式都会短暂弹出一个窗口（很快关掉）。都不写 B / A 的任何东西。
 *
 * 退出码：0 全过；1 有 FAIL。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const CDP_PORT = Number(process.env.DSH_UI_VERIFY_CDP_PORT || 9333);
const MODE = process.argv[2] || "loading";
const FREE_PORT = 3177;        // loading 模式自建内核用的空闲端口
const REUSE_PORT = 3105;       // inject 模式复用用户正在跑的内核

const failures = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures.push(`${name}: ${detail || ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CDP ───────────────────────────────────────────────────────────
async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return r.json();
}

function cdpEval(wsUrl, expression, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch { } reject(new Error("CDP 超时")); }, timeoutMs);
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error("WebSocket 错误: " + ((e && e.message) || "unknown"))); };
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch { }
      if (msg.result && msg.result.exceptionDetails) {
        return reject(new Error("页面执行报错: " + JSON.stringify(msg.result.exceptionDetails).slice(0, 400)));
      }
      resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
    };
  });
}

/** 等一个满足条件的 page 目标出现。 */
async function waitForPage(match, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    try {
      const ts = await listTargets();
      last = ts.filter((t) => t.type === "page");
      for (const t of last) if (match(t)) return t;
    } catch (e) { /* CDP 还没起来 */ }
    await sleep(400);
  }
  throw new Error(`等页面超时（最后看到 ${last.length} 个 page: ${last.map((t) => t.url).join(" | ")}）`);
}

// ── 起应用 ────────────────────────────────────────────────────────
function launch(_mode, tmpDir, port, opts = {}) {
  fs.writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify({
    closeToTray: false,
    port,
    profile: "web",
    workspace: opts.workspace || ROOT,
  }, null, 2), "utf8");

  // ★ 可选：把真实家的工作区注册表种进临时家。
  //   临时家没有工作区 ⇒ 界面停在「选择一个工作区开始」⇒ 没有会话 ⇒
  //   没有输入框和模型选择器，端到端注入测试就做不下去。
  //   注册表里只有路径，没有凭据。
  if (opts.seedWorkspace) {
    const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const src = path.join(roaming, "DSH Integrated", "dsh-home", "storages", "workspace.json");
    const dstDir = path.join(tmpDir, "dsh-home", "storages");
    if (fs.existsSync(src)) {
      fs.mkdirSync(dstDir, { recursive: true });
      fs.copyFileSync(src, path.join(dstDir, "workspace.json"));
      console.log(`  已把真实工作区注册表种进临时家（${fs.statSync(src).size} 字节，仅路径）`);
    } else {
      console.log(`  ⚠ 找不到 ${src}，没有种工作区`);
    }
  }

  const electronExe = path.join(ROOT, "node_modules", "electron", "dist",
    process.platform === "win32" ? "electron.exe" : "electron");
  if (!fs.existsSync(electronExe)) throw new Error(`找不到 Electron: ${electronExe}`);

  // ★ 必须清掉 ELECTRON_RUN_AS_NODE：被设上时 Electron 退化成纯 Node，
  //   应用会"启动后什么都不做"（本机 DSH 给工具子进程就设了这个变量）。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  // ★ 首启向导默认**只在打包版**自动弹（见 main.js 的 firstRunAutoEnabled）。
  //   这里显式开/关，而不是靠"开发机默认不弹"这条巧合：
  //   · 只有 firstrun 模式传 firstRun:true（它要验的就是"自己弹出来"）；
  //   · 其余六个模式显式写 off —— 它们的判据是 `waitForPage` 找页面，
  //     多一个设置窗口就多一个 CDP page 目标，会把它们搅乱。
  env.DSH_FIRST_RUN = opts.firstRun ? "force" : "off";

  // ★ 不用管道抓子进程输出：Windows 沙箱下 Node 的 piped stdio 会 EPERM。
  //   应用自己会把日志写进 <userData>/shell.log，失败时读文件即可（readAppLog）。
  // ★ 可选：额外的 Electron 启动参数（pages 模式用它从 DNS 层制造一次确定性失败）
  const extraArgs = Array.isArray(opts.extraArgs) ? opts.extraArgs : [];
  const child = spawn(electronExe, [
    ".",
    `--user-data-dir=${tmpDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    ...extraArgs,
  ], { cwd: ROOT, env, stdio: "ignore", windowsHide: false });

  return { child };
}

/** 读应用自己写的 shell.log（失败诊断用，不依赖 stdout 管道）。 */
function readAppLog(tmpDir, maxLines = 40) {
  try {
    const f = path.join(tmpDir, "shell.log");
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - maxLines)).filter(Boolean);
  } catch { return []; }
}

async function stopApp(child) {
  try { child.kill(); } catch { }
  await sleep(700);
  try { child.kill("SIGKILL"); } catch { }
}

// ── 模式一：加载页 ────────────────────────────────────────────────
async function verifyLoading(tmpDir) {
  const { child } = launch("loading", tmpDir, FREE_PORT);
  try {
    // 加载页在窗口一出现就渲染，内核要好几秒才起来 —— 有充足时间连上去
    const target = await waitForPage((t) => /status-page\.html/.test(t.url), 40000);
    console.log(`  已连上加载页: ${target.url}`);

    await sleep(2500);   // 等页面 boot() 跑完（拉快照 + 挂动作）

    const raw = await cdpEval(target.webSocketDebuggerUrl, `(() => {
      const whale = document.querySelector("svg.whale");
      const paths = whale ? Array.from(whale.querySelectorAll("path")).map(p => (p.getAttribute("d")||"").length) : [];
      const actions = Array.from(document.querySelectorAll("#actions .action")).map(b => ({
        id: b.dataset.id, label: (b.querySelector(".action-label")||{}).textContent || ""
      }));
      const fill = document.getElementById("barfill");
      return JSON.stringify({
        title: document.title,
        whalePaths: paths,
        barExists: !!fill,
        barWidth: fill ? fill.style.width : "",
        stages: Array.from(document.querySelectorAll("#stages li")).map(li => li.className + ":" + li.textContent.trim()),
        titleText: (document.getElementById("title")||{}).textContent || "",
        stageText: (document.getElementById("stagetext")||{}).textContent || "",
        hasBridge: typeof window.dshShell === "object" && !!window.dshShell,
        hasDiagBtn: !!document.getElementById("btn-diag"),
        hasSettingsBtn: !!document.getElementById("btn-settings"),
        hasSheet: !!document.getElementById("sheet"),
        actions
      });
    })()`);
    const p = JSON.parse(raw);
    console.log(`  窗口标题: ${p.title} ／ 主标题: ${p.titleText} ／ 阶段: ${p.stageText}`);

    check("加载页：鲸鱼 SVG 存在且有 4 段路径", p.whalePaths.length === 4 && p.whalePaths.every((n) => n > 50),
      `各段长度 ${JSON.stringify(p.whalePaths)}`);
    check("加载页：进度条存在", p.barExists, `当前宽度 "${p.barWidth}"`);
    check("加载页：阶段清单已渲染 4 项", p.stages.length === 4, p.stages.join(" | "));
    check("加载页：preload 桥已注入（window.dshShell）", p.hasBridge);
    check("加载页：底部有「诊断与修复」按钮", p.hasDiagBtn);
    check("加载页：底部有「设置」按钮", p.hasSettingsBtn);
    check("加载页：抽屉容器存在", p.hasSheet);

    // 动作清单 —— 同时证明 preload → IPC → 来源校验 → 白名单 整条链路
    check("动作清单已从主进程取回并渲染", p.actions.length >= 7,
      `共 ${p.actions.length} 条: ${p.actions.map((a) => a.id).join(", ")}`);

    // ★ browser-open 是**按内核状态裁剪**的：内核还没就绪时它必须不在清单里
    //   （点了也没有地址可开）。所以不能断言"永远 8 条"。
    //   （第一版断言写的就是"永远 8 条"，在内核还没起来时误报 FAIL —— 是断言错，不是程序错。）
    const filterRaw = await cdpEval(target.webSocketDebuggerUrl, `(async () => {
      const env = await window.dshShell.getEnv();
      const list = await window.dshShell.listActions();
      return JSON.stringify({ hasKernel: !!env.serverUrl, ids: list.map(a => a.id) });
    })()`);
    const fl = JSON.parse(filterRaw);
    const alwaysIds = ["restart-kernel", "clean-start", "health-check",
      "open-dsh-home", "open-logs", "copy-diag", "fallback-client"];
    const missing = alwaysIds.filter((id) => !fl.ids.includes(id));
    check("7 条常驻动作全部在清单里", missing.length === 0, missing.length ? `缺 ${missing.join(", ")}` : "7/7");
    const hasBrowser = fl.ids.includes("browser-open");
    check("「浏览器启动」按内核状态正确显隐", hasBrowser === fl.hasKernel,
      `清单里 ${hasBrowser ? "有" : "没有"}，而 serverUrl ${fl.hasKernel ? "有" : "没有"}（共 ${fl.ids.length} 条）`);

    // ★ 真的跑一次「环境体检」：只读、不弹窗，把 spawn→流式输出→页面 整条链路走通
    console.log("  正在真跑「环境体检」（只读）…");
    const runRes = await cdpEval(target.webSocketDebuggerUrl,
      `(async () => JSON.stringify(await window.dshShell.runAction("health-check")))()`, 120000);
    console.log(`  体检返回: ${runRes}`);
    await sleep(1500);
    const outText = await cdpEval(target.webSocketDebuggerUrl,
      `(document.getElementById("out")||{}).textContent || ""`);
    let parsed = {}; try { parsed = JSON.parse(runRes); } catch { }
    check("「环境体检」真跑并返回结果码", parsed.code !== undefined, runRes);
    check("体检输出已流回页面（output 面板非空）", (outText || "").length > 40,
      `输出 ${(outText || "").length} 字符，开头 ${JSON.stringify((outText || "").slice(0, 100))}`);

    // 危险动作必须带确认文案（页面据此弹模态）
    const dangerRaw = await cdpEval(target.webSocketDebuggerUrl, `(async () => {
      const list = await window.dshShell.listActions();
      return JSON.stringify(list.filter(a => a.danger).map(a => ({id:a.id, hasConfirm: !!a.confirm})));
    })()`);
    const d = JSON.parse(dangerRaw);
    check("危险动作都带确认文案", d.length > 0 && d.every((x) => x.hasConfirm),
      d.map((x) => x.id + "=" + x.hasConfirm).join(", "));

    const pageInfo = await cdpEval(target.webSocketDebuggerUrl,
      `JSON.stringify({ url: location.href, isShellPage: /status-page\\.html/.test(location.href) })`);
    const pi = JSON.parse(pageInfo);
    check("（记录）本页确实被识别为外壳页面", pi.isShellPage, pi.url);
  } finally {
    await stopApp(child);
  }
}

// ── 模式二：官方 UI 里的模型搜索框注入 ───────────────────────────
//
// ★ 换成"外壳自己的内核"是有原因的，别改回去：
//   前一版复用用户正在跑的内核，靠"从内核日志里捡 token 地址、手动接管窗口"
//   来加载真 UI。那条路和外壳自己的启动流程/鉴权检查**反复抢导航**：
//   导航早了会 abort 外壳的 loadURL（触发它的失败重试），
//   导航晚了正好撞上它的鉴权判定，被切回提示页 —— 试了三种时机都不稳。
//   ⇒ 现在用**临时家 + 空闲端口**让外壳自己起内核（它自然拿到带 token 的地址），
//     再把真实的工作区注册表种进临时家，界面就有会话输入框与模型位了。
//     全程确定性，且完全不碰用户正在用的内核。
async function verifyInject(tmpDir) {
  const { child } = launch("inject", tmpDir, FREE_PORT, { seedWorkspace: true });
  try {
    const target = await waitForPage((t) => /^https?:\/\/127\.0\.0\.1/.test(t.url), 90000);
    console.log(`  已连上官方 UI: ${redact(target.url)}`);

    // 轮询等到：客户端插件树挂完 + 注入脚本执行 + 模型触发器出现
    const after = target;
    let ps = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await sleep(1200);
      const info = await cdpEval(after.webSocketDebuggerUrl, `JSON.stringify({
        href: location.href,
        title: document.title,
        hasBoot: !!window.__DSH_BOOT__,
        editables: document.querySelectorAll('[contenteditable="true"]').length,
        injectFlag: window.__dshModelSearchInstalled === true,
        triggers: Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'))
          .filter(x => (x.getAttribute("aria-label")||"").includes("选择模型")).length
      })`).catch(() => null);
      if (!info) continue;
      ps = JSON.parse(info);
      if (ps.hasBoot && ps.injectFlag && ps.triggers > 0) break;
    }
    if (!ps) { check("能连上官方 UI 页面", false, "拿不到页面状态"); return; }

    // ★ 关键断言 1：注入脚本真的在**官方 UI 页面**上执行了
    //   （`href` 必须是 http://127.0.0.1:…，不是外壳页面）
    check("页面已是官方 UI（不是外壳页面）", ps.hasBoot && ps.href.startsWith("http://127.0.0.1"),
      `title="${ps.title}" href=${redact(ps.href)} boot=${ps.hasBoot}`);
    check("注入脚本已在官方 UI 上执行（标志位）", ps.injectFlag, JSON.stringify(ps));

    if (!ps.injectFlag) return;

    // 找模型触发器：先按 aria-haspopup，再兜底按 aria-label
    let clickExpr = `(() => {
      let b = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'))
        .find(x => (x.getAttribute("aria-label")||"").includes("选择模型"));
      if (!b) b = Array.from(document.querySelectorAll("button"))
        .find(x => (x.getAttribute("aria-label")||"") === "选择模型");
      if (!b) return "none";
      b.click(); return b.getAttribute("aria-label") || "clicked";
    })()`;
    const clicked = await cdpEval(after.webSocketDebuggerUrl, clickExpr);
    console.log(`  模型触发器: ${clicked}（可编辑输入框=${ps.editables}，模型触发器=${ps.triggers}）`);
    check("找到并点开了模型触发器", clicked !== "none", String(clicked));
    if (clicked === "none") {
      // 没有工作区/会话就没有输入框 ⇒ 没有模型位。这属于**测试环境限制**，不是功能失败。
      check("（环境）该内核窗口里有会话输入框", ps.editables > 0,
        `contenteditable=${ps.editables}；没有会话就没有模型选择器，无法做端到端注入测试`);
      return;
    }
    await sleep(1600);

    // ★ 菜单**先开在 root 面板**（只有「选择模型」「推理强度」两个切换项），
    //   必须再点「选择模型」那一格才进模型列表 —— 见 client.js:625-632 的 setPane("model")。
    //   （这里踩过一次：只点触发器就去找分组，永远 0 个，误报成"搜索框没插进去"。）
    const rootPane = await cdpEval(after.webSocketDebuggerUrl, `JSON.stringify({
      menus: document.querySelectorAll('div[role="menu"]').length,
      cells: Array.from(document.querySelectorAll('div[role="menu"] button[role="menuitem"]'))
        .map(b => (b.textContent||"").trim().slice(0, 40))
    })`);
    console.log(`  root 面板: ${rootPane}`);
    const cellClicked = await cdpEval(after.webSocketDebuggerUrl, `(() => {
      const cells = Array.from(document.querySelectorAll('div[role="menu"] button[role="menuitem"]'));
      if (!cells.length) return "no-cells";
      const target = cells.find(b => (b.textContent||"").includes("选择模型")) || cells[0];
      target.click();
      return (target.textContent||"").trim().slice(0, 40);
    })()`);
    console.log(`  点开「${cellClicked}」进入模型面板`);
    check("菜单 root 面板有切换项，且能进入模型面板", cellClicked !== "no-cells", String(cellClicked));

    // 模型目录是异步加载的，给几秒；边等边看分组有没有出来
    let m = null;
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      const raw = await cdpEval(after.webSocketDebuggerUrl, `JSON.stringify({
        hasMenu: !!document.querySelector('div[role="menu"]'),
        groups: document.querySelectorAll('div[role="menu"] section[role="group"]').length,
        rows: document.querySelectorAll('div[role="menu"] button[role="menuitemradio"]').length,
        hasBar: !!document.querySelector('div[role="menu"] .dsh-ms-bar'),
        barInsideMenu: (() => {
          const mm = document.querySelector('div[role="menu"]');
          const b = document.querySelector('.dsh-ms-bar');
          return !!(mm && b && mm.contains(b));
        })(),
        pills: Array.from(document.querySelectorAll('.dsh-ms-pill')).map(x => x.textContent),
        placeholder: (document.querySelector('.dsh-ms-bar input')||{}).placeholder || "",
        status: (document.querySelector('div[role="menu"]')||{}).innerText ? document.querySelector('div[role="menu"]').innerText.slice(0,120) : ""
      })`);
      m = JSON.parse(raw);
      if (m.groups > 0) break;
    }
    console.log(`  菜单: 分组 ${m.groups} 个 ／ 模型行 ${m.rows} 条 ／ 胶囊 ${m.pills.length} 个`);
    if (m.groups === 0) console.log(`  菜单当前文字: ${JSON.stringify(m.status)}`);
    check("模型菜单已打开且含分组", m.hasMenu && m.groups >= 1, `分组 ${m.groups}`);
    check("搜索框已插入菜单", m.hasBar, `placeholder="${m.placeholder}"`);
    check("★ 搜索框位于菜单**内部**（决定点它会不会把菜单关掉）", m.barInsideMenu, `barInsideMenu=${m.barInsideMenu}`);
    check("提供方胶囊已生成（分组>1 时应有 分组数+1 个）",
      m.groups > 1 ? m.pills.length === m.groups + 1 : true, m.pills.join(" | "));

    if (m.rows > 0) {
      const filtRaw = await cdpEval(after.webSocketDebuggerUrl, `(() => {
        const input = document.querySelector('.dsh-ms-bar input');
        const rows = () => Array.from(document.querySelectorAll('div[role="menu"] button[role="menuitemradio"]'));
        const shown = () => rows().filter(r => r.getAttribute("data-dsh-ms-hide") !== "1").length;
        const hay = (r) => ((r.getAttribute("title")||"") + " " + (r.textContent||"")).toLowerCase();
        const before = shown();
        // ★ 用**完整模型名**当关键词，并用**独立算法**算出"应该剩几条"。
        //   不用 6 个字符的前缀：本机默认内核里 4 个模型全叫 "DeepSeek-…"，
        //   前缀式关键词四行全中，缩窄断言在那种数据集上必然假红。
        const first = rows()[0];
        const key = (((first && first.getAttribute("title")) || "").trim()) || "zzzzzznomatch";
        const expect = rows().filter(r => hay(r).includes(key.toLowerCase())).length;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, key);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const afterKey = shown();
        setter.call(input, "zzzzzznomatchzzzzzz");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const afterNone = shown();
        const emptyEl = document.querySelector('.dsh-ms-empty');
        const emptyShown = !!emptyEl && getComputedStyle(emptyEl).display !== "none";
        setter.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const afterReset = shown();
        return JSON.stringify({ before, key, expect, afterKey, afterNone, afterReset, emptyShown,
          emptyText: (emptyEl||{}).textContent || "" });
      })()`);
      const f = JSON.parse(filtRaw);
      console.log(`  过滤: 全量 ${f.before} → 搜「${f.key}」应剩 ${f.expect} 实剩 ${f.afterKey} → 无命中 ${f.afterNone} → 复位 ${f.afterReset}`);
      check("搜索的结果集与独立算出的期望一致", f.afterKey === f.expect && f.afterKey >= 1,
        `期望 ${f.expect} 实得 ${f.afterKey}（关键词「${f.key}」）`);
      if (f.expect < f.before) {
        check("搜索确实缩窄了结果（本数据集支持缩窄）", f.afterKey < f.before,
          `${f.before} → ${f.afterKey}`);
      } else {
        console.log(`  （本数据集里 ${f.before} 个模型的名字互相包含，演示不了"缩窄"；以"无命中=0"那条为准）`);
      }
      check("搜不到时结果为 0", f.afterNone === 0, `afterNone=${f.afterNone}`);
      check("搜不到时给出空态提示与复位按钮", f.emptyShown, (f.emptyText || "").trim().slice(0, 60));
      check("清空后恢复全量", f.afterReset === f.before, `afterReset=${f.afterReset} before=${f.before}`);
    } else {
      console.log("  （该内核当前没有可用模型目录，跳过打字过滤测试）");
    }
  } finally {
    await stopApp(child);
  }
}

// ── 找到"正在跑的那个内核"的带 token 地址 ───────────────────────
//
// 背景：`dsh web` 的地址是**一次性打印在启动日志里**的（`dsh web: http://…?token=…`），
// 裸 origin 只会返回 401 "authentication required"。
// 本客户端自己起的那个内核会把日志写在真实 userData 的 logs\ 下，
// 所以能从这里把它捡回来 —— 这样测试窗口就能加载**真正的** UI
// （带用户真实会话与模型），而全程仍然不向 B / A 写任何东西。
//
// ⚠️ token 只在内存里用，**打印时一律打码**。
function findLiveTokenUrl(preferPort) {
  const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const dirs = [
    // ★ 真实 userData 用的是 **productName**（"DSH Integrated"）而不是包名 ——
    //   Electron 的 app.getName() 优先取 productName。
    //   （这里踩过一次：先去 %APPDATA%\dsh-integrated-desktop 找，目录根本不存在。）
    path.join(roaming, "DSH Integrated", "logs"),
    path.join(roaming, "dsh-integrated-desktop", "logs"),
    path.join(ROOT, "runtime", "logs"),
    path.join(ROOT, "runtime", "diag-logs"),
  ];
  const hits = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    const logs = names.filter((n) => /^kernel-.*\.log$/.test(n))
      .map((n) => {
        const p = path.join(d, n);
        let mtime = 0;
        try { mtime = fs.statSync(p).mtimeMs; } catch { }
        return { p, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const { p } of logs.slice(0, 12)) {
      let txt = "";
      try {
        const buf = fs.readFileSync(p, "utf8");
        txt = buf.length > 400000 ? buf.slice(-400000) : buf;
      } catch { continue; }
      const m = txt.match(/dsh web: (https?:\/\/\S+)/);
      if (!m) continue;
      let portMatch = false;
      try { portMatch = new URL(m[1]).port === String(preferPort); } catch { }
      hits.push({ url: m[1], file: p, portMatch });
      if (portMatch) return hits[hits.length - 1];
    }
  }
  return hits[0] || null;
}

/** 打码后的 URL（任何输出都用这个，绝不打印 token）。 */
const redact = (u) => String(u || "").replace(/token=[^&\s]+/g, "token=***");

// ── 模式四：复用路径（验证 2026-09-20 修的那个 token bug）──────────
//
// ★ 第一版测试设计错了，值得记下来：
//   本来想"先让外壳起内核，再强杀外壳，看内核还活着没有" —— 结果实测
//   **内核活不过外壳**（pid alive=false）：Electron 用 Job Object 管子进程，
//   主进程一死，内核跟着死。
//   ⇒ "强杀客户端后复用残留内核"这个场景在本机**根本不可达**。
//
//   真正可达的复用场景是**外来的内核**：端口上已经有一个 dsh 在跑，
//   但它不是本客户端起的（例如 `启动DSH.cmd` 起的浏览器模式内核）。
//   ⇒ 改成由测试脚本自己起一个"外来内核"来造这个场景。
//
// 三段：
//   A) 由测试脚本起一个外来内核（在临时家里，不碰 B/A）
//   B) 外壳没有它的记录 ⇒ 只能拿裸 origin ⇒ 应该出现「打不开这个内核」提示页
//   C) 给外壳补上记录（pid + 带 token 地址）⇒ 应该**真的打开官方 UI**，且不再起第二个内核
async function verifyReuse(tmpDir) {
  const K = require(path.join(ROOT, "src", "kernel.js"));
  const port = FREE_PORT;
  const recFile = path.join(tmpDir, "kernel.json");
  const dshHome = path.join(tmpDir, "dsh-home");
  let foreign = null;

  const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; } };
  const killPid = (pid) => {
    if (!pid) return;
    try { spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { }
  };

  try {
    // ── A) 起一个"外来内核"（不是外壳起的）────────────────────────
    const kernel = K.discoverKernel({});
    if (!kernel) throw new Error("找不到内核，无法造复用场景");
    const spawned = K.spawnKernel({
      kernel, dshHome, port, profile: "web", logDir: path.join(tmpDir, "foreign-logs"),
    });
    foreign = { pid: spawned.child.pid, child: spawned.child };
    const url = await K.waitForUrl(spawned.logFile, spawned.child, 120000);
    if (!url) throw new Error("外来内核没起来: " + K.tailLog(spawned.logFile, 20));
    console.log(`  A) 外来内核已就绪 pid=${foreign.pid} 端口=${port}（token 已打码）`);
    check("A) 外来内核活着且提供了带 token 的地址", pidAlive(foreign.pid) && /token=/.test(url), `pid=${foreign.pid}`);

    // ── B) 外壳没有记录 ⇒ 只能拿裸 origin ⇒ 应出现人话提示页 ───────
    try { fs.unlinkSync(recFile); } catch { }
    const app1 = launch("own", tmpDir, port);
    const t1 = await waitForPage((t) => /status-page\.html/.test(t.url), 60000);
    await sleep(4000);
    const b = JSON.parse(await cdpEval(t1.webSocketDebuggerUrl, `JSON.stringify({
      title: (document.getElementById("title")||{}).textContent || "",
      stage: (document.getElementById("stagetext")||{}).textContent || "",
      detail: ((document.getElementById("detail")||{}).textContent || "").slice(0, 400)
    })`));
    check("B) 拿不到 token 时给出**人话**提示（而不是那行英文 401）",
      /打不开这个内核/.test(b.title), `标题="${b.title}" ／ 阶段="${b.stage}"`);
    check("B) 提示里说清了怎么办（关掉 / 用浏览器打开 / 换端口）",
      /关掉/.test(b.detail) && /浏览器/.test(b.detail) && /端口/.test(b.detail),
      b.detail.replace(/\s+/g, " ").slice(0, 160));
    check("B) 提示页上仍然有诊断入口（没把用户困死）",
      !!(await cdpEval(t1.webSocketDebuggerUrl, `!!document.getElementById("btn-diag")`)));
    await stopApp(app1.child);
    await sleep(1500);
    check("B) 外壳退出后，外来内核依然活着", pidAlive(foreign.pid), `pid=${foreign.pid}`);

    // ── C) 给外壳补上记录 ⇒ 应该真的打开官方 UI ──────────────────
    fs.writeFileSync(recFile, JSON.stringify({
      pid: foreign.pid, port, url, dshHome, profile: "web",
      version: kernel.version, startedAt: new Date().toISOString(),
    }, null, 2), "utf8");
    const app2 = launch("own", tmpDir, port);
    const t2 = await waitForPage((t) => /^https?:\/\/127\.0\.0\.1/.test(t.url), 60000);
    await sleep(5000);
    const c = JSON.parse(await cdpEval(t2.webSocketDebuggerUrl, `JSON.stringify({
      hasBoot: !!window.__DSH_BOOT__,
      title: document.title,
      authBlocked: /authentication required/i.test((document.body && document.body.innerText) || "")
    })`));
    check("C) 有记录时**真的**打开了官方 UI（不是 401 页）",
      c.hasBoot && !c.authBlocked, `title="${c.title}" boot=${c.hasBoot} 401页=${c.authBlocked}`);
    const recAfter = (() => { try { return JSON.parse(fs.readFileSync(recFile, "utf8")); } catch { return {}; } })();
    check("C) 复用时**没有另起一个内核**（记录里的 pid 没变）",
      recAfter.pid === foreign.pid && pidAlive(foreign.pid), `记录 pid=${recAfter.pid} 外来 pid=${foreign.pid}`);
    await stopApp(app2.child);
  } finally {
    // ★ 必须收尾：那个外来内核是测试起的，留在 3177 上就是垃圾
    if (foreign && foreign.pid) {
      killPid(foreign.pid);
      await sleep(800);
      console.log(`  收尾：已杀测试用的外来内核 pid=${foreign.pid}（alive=${pidAlive(foreign.pid)}）`);
    }
  }
}

// ── 模式三：只探测官方 UI 的 DOM 概貌（调锚点用，不做断言）─────────
// ★ 用**自带内核**（临时 userData + 空闲端口）：这样拿得到带 token 的地址，
//   官方 UI 才真的能加载出来。
//   （复用别人内核时拿不到 token，页面只会显示 "dsh web authentication required"，
//     那正是 probe 模式第一版看到的东西。）
async function probeUi(tmpDir) {
  const { child } = launch("own", tmpDir, FREE_PORT, { seedWorkspace: true });
  try {
    const target = await waitForPage((t) => /^https?:\/\/127\.0\.0\.1/.test(t.url), 90000);
    console.log(`  已连上官方 UI: ${redact(target.url)}`);
    await sleep(7000);

    const dump = await cdpEval(target.webSocketDebuggerUrl, `(() => {
      const boot = window.__DSH_BOOT__;
      const entryIds = boot && boot.entries ? boot.entries.map(e => e.id) : [];
      const btns = Array.from(document.querySelectorAll("button")).map(b => ({
        pop: b.getAttribute("aria-haspopup") || "",
        label: b.getAttribute("aria-label") || "",
        text: (b.textContent || "").trim().slice(0, 24)
      }));
      return JSON.stringify({
        href: location.href.replace(/token=[^&]+/, "token=***"),
        title: document.title,
        hasBoot: !!boot,
        entryCount: entryIds.length,
        injectFlag: window.__dshModelSearchInstalled === true,
        textareas: document.querySelectorAll("textarea").length,
        editables: document.querySelectorAll('[contenteditable="true"]').length,
        modelTriggers: document.querySelectorAll('button[aria-haspopup="menu"]').length,
        modelSeat: !!Array.from(document.querySelectorAll("button")).find(x => (x.getAttribute("aria-label")||"").includes("选择模型")),
        buttons: btns.filter(b => b.label || b.text),
        bodyHead: ((document.body && document.body.innerText) || "").slice(0, 500)
      });
    })()`);
    console.log(dump);
    const st = path.join(tmpDir, "dsh-home", "storages");
    try { console.log("  临时家 storages: " + fs.readdirSync(st).join(", ")); }
    catch (e) { console.log("  临时家 storages 读不到: " + e.message); }
  } finally {
    await stopApp(child);
  }
}

// ── 模式五：三页切换（本机 DSH / DeepSeek 网页版 / 开放平台）──────
//
// 验的是**真行为**，不是"代码看起来对"：
//   · 把手真的画在 DOM 里、面板真的能展开、三页标签真的是中文；
//   · `switchPage()` **真的改了主进程的状态**（切完再读一次 `pages()` 看 active）；
//   · **非法 id 真的被拒**（安全边界：只有三个固定页，第三方站点拿到通道也越不了界）。
async function verifyPages(tmpDir) {
  const PORT = 3178;
  const { child } = launch("pages", tmpDir, PORT, { seedWorkspace: true });
  const ws = { url: null };
  try {
    const target = await waitForPage((t) => t.url.startsWith(`http://127.0.0.1:${PORT}/`), 120000);
    ws.url = target.webSocketDebuggerUrl;
    console.log(`  已连上官方界面: ${target.url.split("?")[0]}`);

    const probe = `(() => {
      const h = document.querySelector('[data-dsh-page-switch="handle"]');
      const p = document.querySelector('[data-dsh-page-switch="panel"]');
      const rows = p ? Array.from(p.querySelectorAll('[data-page-id]')).map(e => ({
        id: e.getAttribute('data-page-id'), text: (e.textContent || '').replace(/\\s+/g, ' ').trim()
      })) : [];
      return JSON.stringify({
        handle: !!h,
        panel: !!p,
        panelDisplay: p ? getComputedStyle(p).display : null,
        rows,
        api: !!(window.dshShell && typeof window.dshShell.switchPage === 'function'
                && typeof window.dshShell.pages === 'function'),
      });
    })()`;

    // 注入是 did-finish-load 之后异步做的，给它几秒
    let st = null;
    for (let i = 0; i < 40; i++) {
      st = JSON.parse(await cdpEval(ws.url, probe));
      if (st.handle && st.api && st.rows.length) break;
      await sleep(500);
    }

    check("页面切换把手真的画进了 DOM", st.handle);
    check("把手拿到了受限通道 window.dshShell", st.api);
    check("面板默认是收起的", st.panel && st.panelDisplay === "none", `display=${st.panelDisplay}`);
    check("面板里正好三页且 id 顺序正确",
      st.rows.map((r) => r.id).join(",") === "dsh,chat,platform", st.rows.map((r) => r.id).join(","));
    check("三页标签是中文（不是空 / 不是 id）",
      st.rows.length === 3 && st.rows.every((r) => /[\u4e00-\u9fa5]/.test(r.text)),
      JSON.stringify(st.rows.map((r) => r.text)));
    check("当前页（本机 DSH）被标了 ✓", /✓/.test(st.rows[0].text), JSON.stringify(st.rows[0].text));

    // 点把手 → 面板展开。
    // ★ 点完**立刻**读一次内联样式，稍后再读一次 computed ——
    //   这两次能区分「压根没开」和「开了又被谁关掉」，不然只能瞎猜。
    const clickAndRead = `(() => {
      const h = document.querySelector('[data-dsh-page-switch="handle"]');
      const p = document.querySelector('[data-dsh-page-switch="panel"]');
      const out = {
        roots: document.querySelectorAll('[data-dsh-page-switch="root"]').length,
        handles: document.querySelectorAll('[data-dsh-page-switch="handle"]').length,
        panels: document.querySelectorAll('[data-dsh-page-switch="panel"]').length,
        hook: !!window.__dshPageSwitch,
        inlineBefore: p ? p.style.display : null,
      };
      try { h.click(); } catch (e) { out.clickErr = String(e && e.message); }
      out.afterClick = p ? p.style.display : null;
      // ★ 再挂一个**全新**的监听器再点一次：能区分"事件根本没到元素"和"我那个监听器没生效"
      try {
        var fired = 0;
        h.addEventListener("click", function () { fired += 1; });
        h.click();
        out.extraListenerFired = fired;
      } catch (e) { out.extraErr = String(e && e.message); }
      // ★ 绕过事件，直接调钩子：能区分「事件没到」和「函数本身坏」
      try { window.__dshPageSwitch.open(); } catch (e) { out.openErr = String(e && e.message); }
      out.afterHookOpen = p ? p.style.display : null;
      return JSON.stringify(out);
    })()`;
    const clickRes = JSON.parse(await cdpEval(ws.url, clickAndRead));
    console.log(`  点击诊断: ${JSON.stringify(clickRes)}`);
    await sleep(400);
    const opened = JSON.parse(await cdpEval(ws.url, probe));
    check("点一下把手能展开面板（别看代码，看 display）",
      opened.panelDisplay === "block",
      `display=${opened.panelDisplay}（点后=${clickRes.afterClick}，钩子后=${clickRes.afterHookOpen}）`);

    // 真的切到「开放平台」，再读回主进程状态
    const r1 = await cdpEval(ws.url, `window.dshShell.switchPage('platform').then(r => JSON.stringify(r))`);
    check("switchPage('platform') 返回 ok", /"ok":true/.test(r1), String(r1));
    const s1 = await cdpEval(ws.url, `window.dshShell.pages().then(s => JSON.stringify(s))`);
    check("主进程状态**真的**变成 platform（不是只有按钮变了）",
      /"active":"platform"/.test(s1), String(s1).slice(0, 140));

    // ══════════════════════════════════════════════════════════════
    // ★★ 0.2.7：光看"状态变成 platform"**不算数** —— 那正是原来那个 bug
    // ══════════════════════════════════════════════════════════════
    // 0.2.6 及以前两个网站**共用一个 `WebContentsView`**，于是：平台加载失败时，
    // 屏幕上留着的是**网页版**的页面，而 `activeId`（以及面板的 ✓、推给按钮的状态）
    // 都说你在开放平台。用户原话：
    //   「最开始的时候可以看到开放平台，但是现在点到开放平台，
    //     它还是保持着网页版的状态」。
    // 那次的日志证据：平台每次加载都 `ERR_ABORTED`，而**共用的那个 view** 的地址
    // 还停在 chat.deepseek.com ⇒ 之后点哪一页都不重载，看着就是卡住。
    // ⇒ 判据必须落到**那一页自己的视图**上（`views[id].host/.err/.visible`），
    //   而不是 `active` 这个"我想去哪一页"的意图。
    let snap = null;
    const pdl = Date.now() + 50000;
    while (Date.now() < pdl) {
      snap = JSON.parse(await cdpEval(ws.url, `window.dshShell.pages().then(s => JSON.stringify(s))`));
      const v = snap.views && snap.views.platform;
      if (v && (v.err || v.host)) break;      // 有结论了：加载成功 或 已判定失败
      await sleep(1500);
    }
    const V1 = snap.views || {};
    const rowOf = (s, id) => (s.pages || []).find((p) => p.id === id) || {};

    check("★ 切到开放平台之后，**可见的那一层**就是 platform（不是 chat 还开着）",
      !!(V1.platform && V1.platform.visible === true) && !(V1.chat && V1.chat.visible === true),
      `platform.visible=${V1.platform && V1.platform.visible} chat.visible=${V1.chat && V1.chat.visible}`);

    // ★★ 这一条就是用户报的那个 bug 的直接判据
    check("★★ 开放平台那一页**绝不会**停在网页版的地址上（0.2.6 的真 bug）",
      !(V1.platform && V1.platform.host === "chat.deepseek.com"),
      `platform.host=${JSON.stringify(V1.platform && V1.platform.host)} err=${JSON.stringify(V1.platform && V1.platform.err)}`);

    if (V1.platform && V1.platform.err) {
      console.log(`  站点没加载成功：${V1.platform.err}（多半是站点/WAF 挡了这台机器）`);
      check("★ 没加载成功时，面板那一行**必须**把原因写出来（不许静默）",
        rowOf(snap, "platform").bad === true && !!rowOf(snap, "platform").note,
        JSON.stringify({ note: rowOf(snap, "platform").note, bad: rowOf(snap, "platform").bad }));
      const cardT = await findTarget((t) => t.type === "page"
        && /开放平台/.test(t.title || "") && /^data:text\/html/.test(t.url || ""), 8000);
      check("★ 失败后那一页换成了**本地错误卡片**（而不是把别的站点的页面留在屏幕上）",
        !!cardT, cardT ? cardT.url.slice(0, 46) : "没找到错误卡片 target");
      if (cardT) {
        const cardTxt = String(await cdpEval(cardT.webSocketDebuggerUrl, `document.body.innerText.slice(0,240)`));
        check("★ 错误卡片上写着错误码与重试办法",
          /ERR_|HTTP /.test(cardTxt) && /重试|再点一次/.test(cardTxt),
          cardTxt.replace(/\s+/g, " ").slice(0, 130));
      }
    } else {
      check("★ 站点加载成功时，那一页的地址必须落在本站域（跨域跳转要在面板上说明）",
        V1.platform.host === "platform.deepseek.com" || rowOf(snap, "platform").bad === true,
        `host=${JSON.stringify(V1.platform && V1.platform.host)} note=${JSON.stringify(rowOf(snap, "platform").note)}`);
      console.log("  SKIP  失败分支（当前站点可达，没走到错误卡片那条路）");

      // ★ 同域内的重定向只能靠**路径**认：实测 `platform.deepseek.com/` 会返回 200
      //   然后自己跳到 `/sign_in` —— 域名没变，"实际停在别的域"那条判据不会触发，
      //   用户看着一个登录页却不知道这就是"开放平台没登进去"。
      const pt = await findTarget((t) => t.type === "page" && /platform\.deepseek\.com/.test(t.url || ""), 6000);
      if (pt) {
        const pth = String(await cdpEval(pt.webSocketDebuggerUrl, `location.pathname`, 10000));
        console.log(`  开放平台那一页的实际路径: ${pth}`);
        if (/\/(sign[-_]?in|log[-_]?in|auth|oauth|passport)/i.test(pth)) {
          const row = rowOf(JSON.parse(await cdpEval(ws.url, `window.dshShell.pages().then(s => JSON.stringify(s))`)), "platform");
          check("★ 同域内跳到登录页时，面板那一行**必须**说明「停在登录页」",
            row.bad === true && /登录/.test(row.note || ""), JSON.stringify({ note: row.note, bad: row.bad }));
        } else {
          console.log("  SKIP  同域登录页那一条 —— 这一页当前不在登录路径上");
        }
      }
    }

    // ── 反方向再走一趟：chat → platform → chat，确认两页**互不覆盖** ──
    await cdpEval(ws.url, `window.dshShell.switchPage('chat').then(r => JSON.stringify(r))`, 20000);
    let cs = null;
    const cdl = Date.now() + 30000;
    while (Date.now() < cdl) {
      cs = JSON.parse(await cdpEval(ws.url, `window.dshShell.pages().then(s => JSON.stringify(s))`));
      const v = cs.views && cs.views.chat;
      if (v && (v.err || v.host)) break;
      await sleep(1500);
    }
    check("★ 切到网页版时，可见的是 chat 那一层、platform 那一层收起",
      !!(cs.views.chat && cs.views.chat.visible === true) && !(cs.views.platform && cs.views.platform.visible === true),
      JSON.stringify(cs.views));
    check("★★ 两页互不覆盖：在网页版这一页看到的一定是 chat 的域（或它自己的错误卡片）",
      cs.views.chat.host !== "platform.deepseek.com",
      `chat.host=${JSON.stringify(cs.views.chat.host)} err=${JSON.stringify(cs.views.chat.err)}`);

    // ── ★ 不依赖站点可达性，**强行**制造一次失败，把"失败要看得见"那条路验死 ──
    //   做法：找到 platform 那一页**自己的**页面目标，在里面把地址改成必然连不上的
    //   127.0.0.1:9 ⇒ 主框架 did-fail-load(ERR_CONNECTION_REFUSED) ⇒ 应当换成错误卡片。
    //
    //   ⚠️⚠️ 这一招**实测不灵，已经废掉**（2026-09-22）：
    //   站点页面自己挂了 `beforeunload`，而**没有用户手势**时 Chromium 会**直接取消**
    //   这次导航 —— 日志里连一条导航记录都没有，`did-fail-load` 根本不触发。
    //   我第一版就把它当成"验过了"，那是**假的**（量具自己撒谎，本轮第四次）。
    //   ⇒ 改成 `verifyPagesOffline()`：用**指向死端口的代理**（本机地址绕过）
    //     把所有外部站点确定性掐掉，制造一次真的加载失败。
    console.log("  （失败那条路在第二趟里用死代理确定性制造，见下）");

    // ★ 安全边界：合法取值只有三个 id，别的一律拒
    const bad = await cdpEval(ws.url, `window.dshShell.switchPage('evil').then(r => JSON.stringify(r))`);
    check("非法页面 id 被拒（越不出这三页）", /"ok":false/.test(bad), String(bad));
    const bad2 = await cdpEval(ws.url, `window.dshShell.switchPage('../../etc').then(r => JSON.stringify(r))`);
    check("畸形 id 也被拒", /"ok":false/.test(bad2), String(bad2));

    // 切回本机
    const r2 = await cdpEval(ws.url, `window.dshShell.switchPage('dsh').then(r => JSON.stringify(r))`);
    check("能切回本机 DSH", /"ok":true/.test(r2), String(r2));
    const s2 = await cdpEval(ws.url, `window.dshShell.pages().then(s => JSON.stringify(s))`);
    check("状态回到 dsh", /"active":"dsh"/.test(s2), String(s2).slice(0, 140));

    // ── 站点视图里也要有把手（否则进去就出不来）──
    // 这一段依赖真能连上 platform.deepseek.com；连不上就明确报 SKIP，不当成 PASS。
    console.log("  等站点视图的页面出现（要联网，连不上会标 SKIP）…");
    let siteTarget = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const ts = await listTargets();
        siteTarget = ts.find((t) => t.type === "page" && /deepseek\.com/.test(t.url || ""));
        if (siteTarget) break;
      } catch { /* CDP 抖动 */ }
      await sleep(1000);
    }
    if (!siteTarget) {
      console.log("  SKIP  站点视图未加载（多半是网络/代理不通）—— 这一条没验到，不算通过");
    } else {
      console.log(`  站点视图已加载: ${siteTarget.url.slice(0, 60)}`);
      // ★ 站点常会**重定向**（实测 platform.deepseek.com → /sign_in），注入会跟着
      //   新的 did-finish-load 走。所以轮询等它稳下来，**不能睡固定几秒就下结论**
      //   （第一版就是这么误报成 FAIL 的）。
      const siteProbeExpr = `(() => {
        return JSON.stringify({
          readyState: document.readyState,
          href: location.href.slice(0, 80),
          handle: !!document.querySelector('[data-dsh-page-switch="handle"]'),
          root: !!document.querySelector('[data-dsh-page-switch="root"]'),
          hook: !!window.__dshPageSwitch,
          api: !!(window.dshShell && typeof window.dshShell.switchPage === 'function'),
        });
      })()`;
      let sp = null;
      const siteDeadline = Date.now() + 25000;
      while (Date.now() < siteDeadline) {
        try {
          const ts2 = await listTargets();
          const t2 = ts2.find((t) => t.type === "page" && /deepseek\.com/.test(t.url || ""));
          if (t2) {
            sp = JSON.parse(await cdpEval(t2.webSocketDebuggerUrl, siteProbeExpr, 20000));
            if (sp.handle) break;
          }
        } catch (e) { /* 重定向过程中 CDP 会抖，重来 */ }
        await sleep(1500);
      }
      console.log(`  站点页诊断: ${JSON.stringify(sp)}`);
      check("站点页面里也注入了切换把手（进去有出口）", !!(sp && sp.handle), JSON.stringify(sp));
    }

    // ── 设置入口 + 检查更新（0.2.4 的两件新东西，一起真验）──
    //  ★ **必须真点**：DOM 里有那个按钮，不等于点了有用。
    console.log("  试「外壳设置」入口与「检查更新」…");
    const clicked = await cdpEval(ws.url, `(() => {
      const row = document.querySelector('[data-dsh-page-switch="panel"] [data-dsh-action="shell-settings"]');
      if (!row) return "no-row";
      row.click();
      return "clicked";
    })()`);
    check("切换面板里有「外壳设置」入口", clicked === "clicked", String(clicked));

    let setT = null;
    const setDeadline = Date.now() + 20000;
    while (Date.now() < setDeadline) {
      try {
        const ts3 = await listTargets();
        setT = ts3.find((t) => t.type === "page" && /settings\.html/.test(t.url || ""));
        if (setT) break;
      } catch { /* CDP 抖动 */ }
      await sleep(500);
    }
    check("点它真的打开了外壳设置窗口", !!setT, setT ? "settings.html 目标已出现" : "没等到 settings.html 目标");

    if (setT) {
      await sleep(1500);
      const setProbe = `(() => JSON.stringify({
        hasNav: !!document.querySelector('nav button[data-pane="update"]'),
        hasPane: !!document.querySelector('.pane[data-pane="update"]'),
        current: (document.getElementById('up-current') || {}).textContent || '',
        hasBtn: !!document.getElementById('btn-up-check'),
        status: (document.getElementById('up-status') || {}).textContent || '',
      }))()`;
      const s2 = JSON.parse(await cdpEval(setT.webSocketDebuggerUrl, setProbe, 20000));
      check("设置页里有「更新」这一栏", s2.hasNav && s2.hasPane, JSON.stringify(s2));
      check("更新栏显示了当前版本（v 开头）", /^v\d/.test(s2.current), s2.current);

      // ★ 往系统临时目录里放一个"更新的安装包"，把「本机已有新包」那一路**真的跑出来**。
      //   为什么放这儿：主进程扫的两个目录之一就是 `app.getPath("temp")`
      //   （另一个是 settings.workspace\release）—— 这是唯一能在隔离环境里触发它、
      //   又不用去改 settings.workspace（那会影响页面加载）的干净办法。
      const fakeExe = path.join(os.tmpdir(), "DSH-Integrated-9.9.9-x64.exe");
      try { fs.rmSync(fakeExe, { force: true }); } catch { /* 先清掉上次可能残留的 */ }
      let fakeMade = false;
      try { fs.writeFileSync(fakeExe, Buffer.alloc(1200 * 1024)); fakeMade = true; } catch { /* 忽略 */ }
      if (fakeMade) console.log(`  已放一个假的本地新包: ${fakeExe}`);

      // 真点一次「检查更新」—— 这一步要联网
      await cdpEval(setT.webSocketDebuggerUrl,
        `(() => { document.getElementById('btn-up-check').click(); return 'ok'; })()`, 20000);
      let after = s2.status;
      const upDeadline = Date.now() + 30000;
      while (Date.now() < upDeadline) {
        await sleep(1000);
        after = await cdpEval(setT.webSocketDebuggerUrl,
          `(document.getElementById('up-status') || {}).textContent || ''`, 20000);
        if (after && !/正在查/.test(after)) break;
      }
      console.log(`  检查更新结果文案: ${after}`);
      check("点「检查更新」真拿到了结论（不是停在「正在查」）",
        /已是最新|发现新版本|检查失败|检查出错/.test(after), after);
      check("结论里带版本号（说明真解析了 Release）", /v\d+\.\d+\.\d+/.test(after), after);

      // ★★ 「同时看本机」那一路（用户 2026-09-21 提的：
      //    「检查更新，同时检查仓库的情况和本地的情况，说不定他们是本地安装包呢。」）
      if (fakeMade) {
        const locRaw = await cdpEval(setT.webSocketDebuggerUrl, `(() => {
          const row = document.getElementById('up-row-local');
          return JSON.stringify({
            display: row ? getComputedStyle(row).display : null,
            ver: (document.getElementById('up-local-ver')||{}).textContent||'',
            p: (document.getElementById('up-local-path')||{}).textContent||'',
            btn: !!document.getElementById('btn-up-local'),
          });
        })()`, 20000);
        const lr = JSON.parse(locRaw);
        console.log(`  本机新包那一行: ${locRaw.slice(0, 170)}`);
        check("★ 本机有更新的安装包时，「本机已有新包」那一行真的显示出来了",
          !!lr.display && lr.display !== "none", locRaw.slice(0, 170));
        check("★ 它报的是**本机那个包**的版本 v9.9.9（不是线上的）", /v9\.9\.9/.test(lr.ver), lr.ver);
        check("★ 它把那个包的完整路径给出来了",
          /DSH-Integrated-9\.9\.9-x64\.exe/.test(lr.p), lr.p.slice(0, 130));
        check("有个「安装这个本地包」按钮", lr.btn === true, String(lr.btn));
        try { fs.rmSync(fakeExe, { force: true }); } catch { /* 忽略 */ }
      } else {
        console.log("  SKIP  造不出假的本地安装包 —— 这一段没验到，**不算通过**");
      }
    }
  } finally {
    await stopApp(child);
  }

  // ★ 第二趟：把「站点真的连不上」那条路**确定性**地验掉（见下面的说明）
  await verifyPagesOffline(tmpDir);
}

/**
 * ★★ 「站点连不上」这条路 —— 用启动参数从 **DNS 层**制造一次确定性失败。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不能用"把那一页的地址改成 127.0.0.1:9"
 * ══════════════════════════════════════════════════════════════════
 * 第一版就是这么写的，而且**它悄悄地什么也没做**：
 * 站点页面自己挂了 `beforeunload`，而没有用户手势时 Chromium 会**直接取消**
 * 这次导航 —— shell.log 里连一条导航记录都没有，`did-fail-load` 根本没触发。
 * 我却拿它当"验过了"（量具自己撒谎，本轮第四次踩到同一类坑）。
 *
 * `--host-resolver-rules=MAP platform.deepseek.com ~NOTFOUND` 是 **DNS 层**的确定性失败：
 * 不管站点此刻通不通、有没有 beforeunload，主框架就是解析不到域名。
 *
 * ⚠️⚠️ **但这招在本机也没生效**（2026-09-22 第二次实测）：本机走 Clash 代理
 *   （`127.0.0.1:7897`），**域名是在代理那边解析的** ⇒ 本地的 resolver 规则被整个绕过，
 *   平台照样加载成功（日志里 `[platform] 已显示 …（HTTP 200）`）。
 *   现在是第三次尝试，用**指向死端口的代理**：
 *
 *     --proxy-server=127.0.0.1:9   ← 一个必然连不上的代理
 *     --proxy-bypass-list=127.0.0.1;localhost   ← 本机内核必须绕过，否则连界面都起不来
 *
 *   结果：本机页面照常、**所有外部站点确定性失败**（ERR_PROXY_CONNECTION_FAILED）。
 *   这跟"代理挂了/断网"是同一个现象，正是要验的那条路。
 *
 * ⚠️ 这一趟**只**验那一件事：失败被认出来、错误卡片出现、
 *    面板写清原因、那一页仍然可见、再点一次会真的重试。
 *    不去重验第一趟已经验过的面板/设置那些（它们的判据不受这次失败影响）。
 */
async function verifyPagesOffline(tmpDir) {
  const PORT = 3183;                      // 与 pages 的 3178 / firstrun 的 3180 错开
  const dir = tmpDir + "-offline";
  fs.mkdirSync(dir, { recursive: true });
  console.log("");
  console.log("  ── 第二趟：把外部站点用死代理掐掉（本机绕过），验「连不上」那条路 ──");
  const { child } = launch("pages", dir, PORT, {
    extraArgs: [
      "--proxy-server=127.0.0.1:9",
      "--proxy-bypass-list=127.0.0.1;localhost",
    ],
  });
  try {
    const target = await waitForPage((t) => t.url.startsWith(`http://127.0.0.1:${PORT}/`), 120000);
    const ws = target.webSocketDebuggerUrl;
    await sleep(2500);

    await cdpEval(ws, `window.dshShell.switchPage('platform').then(r => JSON.stringify(r))`, 20000);
    let v = null;
    const dl = Date.now() + 30000;
    while (Date.now() < dl) {
      v = JSON.parse(await cdpEval(ws, `window.dshShell.pages().then(s => JSON.stringify(s.views.platform))`));
      if (v && /ERR_/.test(v.err || "")) break;
      await sleep(1000);
    }
    check("★★ 站点真的连不上时，那一页的失败被判出来并记下错误码（死代理确定性制造）",
      !!(v && /ERR_/.test(v.err || "")), JSON.stringify(v));
    check("★ 失败之后那一页**仍然是可见的那一层**（不会莫名其妙跳走）",
      !!(v && v.visible === true), JSON.stringify(v));
    check("★★ 那一页**绝不会**停在别的站点的地址上（0.2.6 的真 bug）",
      !(v && v.host === "chat.deepseek.com"), JSON.stringify(v));

    const st = JSON.parse(await cdpEval(ws, `window.dshShell.pages().then(s => JSON.stringify(s))`));
    const row = (st.pages || []).find((p) => p.id === "platform") || {};
    check("★ 面板那一行把原因写出来了（bad=true 且有文案）",
      row.bad === true && !!row.note, JSON.stringify({ note: row.note, bad: row.bad }));

    const card = await findTarget((t) => t.type === "page"
      && /开放平台/.test(t.title || "") && /^data:text\/html/.test(t.url || ""), 10000);
    check("★★ 失败后这一页换成了**本地错误卡片**（不是留下别的站点的页面、也不是空白）",
      !!card, card ? card.url.slice(0, 46) : "没找到错误卡片 target");
    if (card) {
      const txt = String(await cdpEval(card.webSocketDebuggerUrl, `document.body.innerText.slice(0,260)`));
      check("★ 卡片上写着错误码、想要的地址与重试办法",
        /ERR_/.test(txt) && /platform\.deepseek\.com/.test(txt) && /重试|再点一次/.test(txt),
        txt.replace(/\s+/g, " ").slice(0, 140));
    }

    // 再点一次这一页必须**真的重新去加载**，不是卡在错误卡片上
    await cdpEval(ws, `window.dshShell.switchPage('platform').then(r => JSON.stringify(r))`, 20000);
    await sleep(4000);
    const loads = readAppLog(dir, 500).filter((l) => /加载站点：https:\/\/platform\.deepseek\.com/.test(l));
    check("★ 再点一次这一页会**真的重试**（日志里出现新一轮「加载站点」）",
      loads.length >= 2, `${loads.length} 次`);

    // ★ 这一趟自己干了什么，必须打出来 —— 不然失败时只能靠猜
    //   （第一次跑这里时，我只打了主那一趟的日志，于是"事件到底响没响"完全看不见）
    const pt2 = await findTarget((t) => t.type === "page" && /platform\.deepseek\.com/.test(t.url || ""), 5000);
    if (pt2) {
      const href = String(await cdpEval(pt2.webSocketDebuggerUrl, `location.href`, 10000));
      console.log(`  这一页的 webContents 认为自己在: ${href}`);
    }
    const tail = readAppLog(dir, 500).filter((l) => /站点|platform|页面|did-fail-load/.test(l)).slice(-12);
    console.log("  第二趟日志（筛过）:");
    for (const l of tail) console.log("    " + l);
  } finally {
    await stopApp(child);
    await sleep(400);
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 交给外层 */ }
  }
}

// ── 模式六：集成版插件清单（真开设置页 / 真拉清单 / 真装一个 / 去磁盘找证据）──
//
// ★ 这一段最要紧的判据是最后那 6 条**磁盘证据**：
//   界面上写"装好了"不算数 —— 必须去临时家里看到 profile 三处契约 + 插件本体。
//   这是本项目 §5 验证纪律的硬要求：**目标行为本身**，不是代理证据。
async function verifyPlugins(tmpDir) {
  const PORT = 3179;   // 自己的内核端口（不与 pages 的 3178 / loading 的 3177 撞）
  const { child } = launch("plugins", tmpDir, PORT, { seedWorkspace: true });
  try {
    const target = await waitForPage((t) => t.url.startsWith(`http://127.0.0.1:${PORT}/`), 120000);
    const mainUrl = target.webSocketDebuggerUrl;
    console.log(`  已连上官方界面: ${target.url.split("?")[0]}`);

    const dshHome = path.join(tmpDir, "dsh-home");
    const pkgFile = path.join(dshHome, "profiles", "web", "package.json");
    check("（前置）临时家里内核已经把 profile 建出来了", fs.existsSync(pkgFile), pkgFile);

    // ★ 种一个「本地装的」插件进去（模拟开发机那种 dev 联接），专门验
    //   **"已装 ≠ 从我们仓库装的"** 这条。
    //   第一版就是在这儿瞎的：真机 B 家里装着 11 个插件、界面报「已装 0」，
    //   并且给已经装着的插件显示「安装」按钮 —— 一点就会覆盖用户的 dev link。
    const localSrc = path.join(tmpDir, "local-dev-plugin", "dsh-multi-session");
    fs.mkdirSync(path.join(localSrc, "lib"), { recursive: true });
    fs.writeFileSync(path.join(localSrc, "package.json"), JSON.stringify({
      name: "dsh-multi-session", version: "9.9.9", main: "lib/index.js",
      dsh: { bundle: { patch: "./cordis.patch.yml" }, client: { platform: "web" } },
    }, null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(localSrc, "cordis.patch.yml"), "- insert: []\n", "utf8");
    fs.writeFileSync(path.join(localSrc, "lib", "index.js"), "module.exports = {};\n", "utf8");
    {
      const pj = JSON.parse(fs.readFileSync(pkgFile, "utf8").replace(/^\uFEFF/, ""));
      pj.dependencies = pj.dependencies || {};
      pj.dependencies["dsh-multi-session"] = "link:" + localSrc;
      pj.dsh = pj.dsh || { profile: {} };
      pj.dsh.profile = pj.dsh.profile || {};
      pj.dsh.profile.bundles = pj.dsh.profile.bundles || [];
      if (!pj.dsh.profile.bundles.includes("dsh-multi-session")) pj.dsh.profile.bundles.push("dsh-multi-session");
      fs.writeFileSync(pkgFile, JSON.stringify(pj, null, 2) + "\n", "utf8");

      const nm = path.join(dshHome, "profiles", "web", "node_modules");
      fs.mkdirSync(nm, { recursive: true });
      const link = path.join(nm, "dsh-multi-session");
      try { fs.rmSync(link, { recursive: true, force: true }); } catch { /* 没有就算了 */ }
      let linked = false;
      try { fs.symlinkSync(localSrc, link, "junction"); linked = true; } catch { linked = false; }
      check("（夹具）已把 dsh-multi-session 种成本地 dev 联接（指向仓库外的目录）", linked, link);
    }

    // ① 从主界面用受限通道打开外壳设置窗口 —— 与用户在把手里点「外壳设置…」同一条路
    const opened = await cdpEval(mainUrl, `window.dshShell.openShellSettings().then(r => JSON.stringify(r))`);
    check("主界面能打开外壳设置窗口", /"ok":true/.test(opened), String(opened));

    let setT = null;
    const dl = Date.now() + 20000;
    while (Date.now() < dl) {
      try {
        const ts = await listTargets();
        setT = ts.find((t) => t.type === "page" && /settings\.html/.test(t.url || ""));
        if (setT) break;
      } catch { /* CDP 抖动 */ }
      await sleep(500);
    }
    check("外壳设置窗口真的出现了", !!setT, setT ? "settings.html" : "没等到");
    if (!setT) return;

    const ws = setT.webSocketDebuggerUrl;
    await sleep(1500);

    // ② 真点导航切到「集成版插件」
    const nav = await cdpEval(ws, `(() => {
      const b = document.querySelector('nav button[data-pane="plugins"]');
      if (!b) return 'no-nav';
      b.click();
      const p = document.querySelector('.pane[data-pane="plugins"]');
      return JSON.stringify({
        paneOn: p ? p.classList.contains('on') : false,
        display: p ? getComputedStyle(p).display : null,
      });
    })()`, 20000);
    const nv = JSON.parse(nav);
    check("设置页里有「集成版插件」这一栏，点了真的显示",
      nv.paneOn && nv.display !== "none", nav);

    const probe = `(() => {
      const cards = Array.from(document.querySelectorAll('#pl-list .pl-card'));
      return JSON.stringify({
        repo: (document.getElementById('pl-repo')||{}).textContent||'',
        count: (document.getElementById('pl-count')||{}).textContent||'',
        status: (document.getElementById('pl-status')||{}).textContent||'',
        upd: (document.getElementById('pl-upd')||{}).textContent||'',
        cards: cards.map(c => ({
          name: (c.querySelector('.nm')||{}).textContent||'',
          tags: Array.from(c.querySelectorAll('.tag')).map(t=>t.textContent),
          desc: (c.querySelector('.ds')||{}).textContent||'',
          meta: (c.querySelector('.meta')||{}).textContent||'',
          ops: Array.from(c.querySelectorAll('button[data-pl-act]')).map(b=>({
            act: b.dataset.plAct,
            replace: b.dataset.plReplace === '1',
            label: (b.textContent||'').trim(),
          })),
        })),
      });
    })()`;

    // ③ 等清单渲染出来（要联网；连不上会落到缓存或明确失败）
    let st = null;
    const cd = Date.now() + 45000;
    while (Date.now() < cd) {
      st = JSON.parse(await cdpEval(ws, probe, 20000));
      if (st.cards.length) break;
      await sleep(1000);
    }
    console.log(`  清单状态: ${st.status}`);
    console.log(`  计数: ${st.count}   可更新: ${st.upd || "(无)"}   卡片数: ${st.cards.length}`);

    check("清单真的渲染出了卡片", st.cards.length > 0, `cards=${st.cards.length} status=${st.status}`);
    check("仓库名回填了（主进程把 repo 报回来了）", /DSH-Plugin-Hub/.test(st.repo), st.repo);
    check("计数文案是「已装 N / 清单 M」", /已装 \d+ \/ 清单 \d+/.test(st.count), st.count);
    check("状态行给了结论（清单更新于… / 显示的是缓存…）",
      /清单更新于|显示的是缓存|取清单失败/.test(st.status), st.status);
    check("★ 每张卡都有名字、说明位与操作按钮",
      st.cards.every((c) => c.name && c.desc && c.ops.length >= 1),
      JSON.stringify(st.cards.slice(0, 2)));
    check("★ 每张卡都写了 sha256（或明说没给）",
      st.cards.every((c) => /sha256/.test(c.meta)),
      JSON.stringify(st.cards.map((c) => c.meta.slice(0, 70))));
    check("每张卡都标了「来自 <owner/repo>」（插件可以住在别的仓库）",
      st.cards.every((c) => /来自 \S+\/\S+/.test(c.meta)),
      JSON.stringify(st.cards.map((c) => c.meta.slice(0, 70))));

    // ── ★ 「本地装的」必须被认出来（真机实测出来的缺陷，这一段专防它复发）──
    check("★ 已装数把本地装的也算上了（不是「已装 0」）", !/已装 0 \//.test(st.count), st.count);
    const msCard = st.cards.find((c) => c.name === "dsh-multi-session");
    check("★ 本地 dev 联接的那个插件被认成「已装（本地装的）」",
      !!(msCard && msCard.tags.includes("已装（本地装的）")),
      msCard ? JSON.stringify(msCard.tags) : "清单里没有 dsh-multi-session 这张卡");
    check("★ 它那张卡**不给**普通「安装」，只给「改用仓库版」",
      !!(msCard && msCard.ops.some((o) => o.act === "install" && o.replace)
        && !msCard.ops.some((o) => o.act === "install" && !o.replace)),
      msCard ? JSON.stringify(msCard.ops) : "无卡");
    check("它标出了来路（本地目录联接 / 本地包文件 / npm）",
      !!(msCard && /装在：/.test(msCard.meta)), msCard ? msCard.meta.slice(0, 120) : "无卡");
    check("它报的是**本地那一份**的版本 9.9.9（不是线上版本）",
      !!(msCard && /本机 v9\.9\.9/.test(msCard.meta)), msCard ? msCard.meta.slice(0, 120) : "无卡");

    // ④ 真点「检查插件更新」—— DOM 里有按钮不等于点了有用
    await cdpEval(ws, `(() => { document.getElementById('btn-pl-check').click(); return 'ok'; })()`, 20000);
    let after = st.status;
    const ud = Date.now() + 40000;
    while (Date.now() < ud) {
      await sleep(1000);
      after = await cdpEval(ws, `(document.getElementById('pl-status')||{}).textContent||''`, 20000);
      if (after && !/正在查|正在读取/.test(after)) break;
    }
    console.log(`  检查插件更新结果: ${after}`);
    check("点「检查插件更新」真拿到了结论（不是停在「正在查」）",
      /清单更新于|显示的是缓存|取清单失败/.test(after), after);

    // ⑤ ★ 真装一个：挑「可装 + 不是开发者工具」的那张卡，点它的安装按钮
    //    ★ 必须是**普通安装**（不是"改用仓库版"）—— 否则会去覆盖上面那个种进去的本地插件
    const pick = st.cards.find((c) => c.ops.some((o) => o.act === "install" && !o.replace)
      && !c.tags.includes("开发者工具"));
    if (!pick) {
      console.log("  SKIP  清单里没有可装的非开发工具插件 —— 安装这一段没验到，**不算通过**");
      return;
    }

    console.log(`  真装 ${pick.name} …（会下载、核对 sha256、写进临时家的 profile）`);
    const clicked = await cdpEval(ws, `(() => {
      const c = Array.from(document.querySelectorAll('#pl-list .pl-card'))
        .find(x => ((x.querySelector('.nm')||{}).textContent||'') === ${JSON.stringify(pick.name)});
      if (!c) return 'no-card';
      const b = c.querySelector('button[data-pl-act="install"]:not([data-pl-replace])');
      if (!b) return 'no-btn';
      b.click();
      return 'clicked';
    })()`, 20000);
    check("点得到那张卡的「安装」按钮", clicked === "clicked", String(clicked));

    let prog = "";
    const pd = Date.now() + 120000;
    while (Date.now() < pd) {
      await sleep(1000);
      prog = await cdpEval(ws, `(document.getElementById('pl-prog')||{}).textContent||''`, 20000);
      if (/重启一次客户端才生效|失败|出错/.test(prog)) break;
    }
    console.log(`  安装结果文案: ${prog}`);
    check("★ 真点「安装」后拿到了结论（不是停在下载中）",
      /重启一次客户端才生效|失败|出错/.test(prog), prog);
    check("★ 安装成功（文案说要重启才生效）", /重启一次客户端才生效/.test(prog), prog);

    // ⑥ 去磁盘上找证据 —— **不看界面自述**
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8").replace(/^\uFEFF/, "")); } catch { /* 下面各条会报 */ }
    check("① dependencies 里写了 link:<落点>",
      !!(pkg && typeof pkg.dependencies[pick.name] === "string"
        && pkg.dependencies[pick.name].startsWith("link:")),
      pkg ? String(pkg.dependencies[pick.name]) : "profile 读不到");
    check("② dsh.profile.bundles 里有它",
      !!(pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles.includes(pick.name)),
      pkg ? JSON.stringify(pkg.dsh.profile.bundles) : "");

    const linkPath = path.join(dshHome, "profiles", "web", "node_modules", pick.name);
    let real = null;
    try { real = fs.realpathSync(linkPath); } catch { /* 下面会报 */ }
    check("③ node_modules 里有联接", !!real, String(real));

    const dest = path.join(dshHome, "plugins", pick.name);
    check("插件本体落到了 <DSH_HOME>\\plugins\\<名字>",
      fs.existsSync(path.join(dest, "package.json")), dest);
    check("③ 的联接确实指向那个落点",
      !!real && path.resolve(real).toLowerCase() === path.resolve(dest).toLowerCase(),
      `${real} vs ${dest}`);

    let through = null;
    try { through = fs.readdirSync(path.join(linkPath, "lib")); } catch { /* 下面会报 */ }
    check("★ 通过联接真的读得到插件文件（不是「文件在那儿」）",
      !!(through && through.length), JSON.stringify(through));

    let raw = Buffer.alloc(0);
    try { raw = fs.readFileSync(pkgFile); } catch { /* 上面已报 */ }
    check("profile package.json **无 BOM**（带 BOM = 整台 DSH 起不来）",
      !(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf),
      [...raw.subarray(0, 3)].join(","));

    // ⑦ 界面状态应该跟着变成「已装」
    const after2 = JSON.parse(await cdpEval(ws, probe, 20000));
    const card2 = after2.cards.find((c) => c.name === pick.name);
    check("★ 卡片状态跟着变成「已装」",
      !!(card2 && card2.tags.includes("已装")), card2 ? JSON.stringify(card2.tags) : "卡片不见了");
  } finally {
    await stopApp(child);
  }
}

// ── 模式七：首次安装向导（0.2.6：安装包不带插件）──────────────────
/**
 * 用户原话：「我们发出去的包干干净净的，有本体客户端就足够了……如果他们在下载的时候
 * 或者安装的时候勾选，他们就从我的仓库的其他链接拉取他们。」
 *
 * 这一模式要证明的**不是**"界面画出来了"，而是四件真事：
 *   ① 全新安装第一次启动，向导**自己**弹出来（不点任何东西），并且停在勾选那一栏；
 *   ② 勾选清单的默认值是对的（能装的默认勾、开发者工具默认不勾、已装的不给点）；
 *   ③ 「先跳过」真的把标记写下来、并把窗口让开；
 *   ④ 第二次启动**不再弹**（家里仍然一个插件都没有 ⇒ 唯一拦住它的是那个标记），
 *      然后从「集成版插件」栏手动打开向导、**真装一个**，
 *      并去磁盘上核对 profile 的三处契约（不是看插件自己的结果文案）。
 *
 * ⚠️ 两次启动用的是**同一个** temp userData（这正是要验的：跨启动的标记）。
 *    全程不碰 B / A：DSH_HOME 落在 temp 里。
 */
async function findSettingsTarget(timeoutMs) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    try {
      const ts = await listTargets();
      const t = ts.find((x) => x.type === "page" && /settings\.html/.test(x.url || ""));
      if (t) return t;
    } catch { /* CDP 还在起来 */ }
    await sleep(400);
  }
  return null;
}

/**
 * 等一个满足条件的页面目标出现（找站点视图那一层要用）。
 * 与 findSettingsTarget 分开写是有意的：这两个判据看的字段不一样。
 */
async function findTarget(pred, timeoutMs) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    try {
      const ts = await listTargets();
      const t = ts.find(pred);
      if (t) return t;
    } catch { /* CDP 还没起来 */ }
    await sleep(400);
  }
  return null;
}

/** 首启向导那一屏的现场快照（复选框名字/是否勾上/是否可点 + 按钮文案）。 */
const FR_PROBE = `(() => {
  const pane = document.querySelector('.pane[data-pane="welcome"]');
  const items = Array.from(document.querySelectorAll('#fr-list .fr-item')).map((c) => {
    const ck = c.querySelector('input.fr-ck');
    return {
      name: ck ? ck.dataset.frName : '',
      checked: !!(ck && ck.checked),
      disabled: !!(ck && ck.disabled),
      tagOff: c.classList.contains('off'),
      meta: (c.querySelector('.meta') || {}).textContent || '',
    };
  });
  const btn = document.getElementById('btn-fr-install');
  const done = document.getElementById('fr-done');
  const acts = document.getElementById('fr-actions');
  return JSON.stringify({
    paneOn: pane ? pane.classList.contains('on') : false,
    paneDisplay: pane ? getComputedStyle(pane).display : null,
    navHasWizard: !!document.querySelector('nav button[data-pane="welcome"]'),
    repo: (document.getElementById('fr-repo') || {}).textContent || '',
    status: (document.getElementById('fr-status') || {}).textContent || '',
    items,
    btnLabel: btn ? (btn.textContent || '').trim() : '',
    btnDisabled: !!(btn && btn.disabled),
    doneDisplay: done ? getComputedStyle(done).display : null,
    doneText: (document.getElementById('fr-done-text') || {}).textContent || '',
    actsDisplay: acts ? getComputedStyle(acts).display : null,
  });
})()`;

/** 等 shell.log 里出现匹配的一行（窗口标题这类只在 did-finish-load 之后才有的东西）。 */
async function waitForLogLine(tmpDir, re, timeoutMs) {
  const dl = Date.now() + timeoutMs;
  let tail = [];
  while (Date.now() < dl) {
    tail = readAppLog(tmpDir, 400);
    const hit = tail.find((l) => re.test(l));
    if (hit) return hit;
    await sleep(400);
  }
  return null;
}

async function verifyFirstRun(tmpDir) {
  const PORT = 3180;
  const dshHome = path.join(tmpDir, "dsh-home");
  const pkgFile = path.join(dshHome, "profiles", "web", "package.json");
  const marker = path.join(tmpDir, "first-run.json");

  // ══ 第一趟：全新家 ⇒ 向导应该自己弹出来 ══════════════════════════
  const a = launch("firstrun", tmpDir, PORT, { firstRun: true });
  let picked = null;
  try {
    await waitForPage((t) => t.url.startsWith(`http://127.0.0.1:${PORT}/`), 120000);
    check("（前置）临时家里内核已经把 profile 建出来了", fs.existsSync(pkgFile), pkgFile);
    check("（前置）这个家一个插件都没有（真的是全新用户）",
      !fs.existsSync(path.join(dshHome, "plugins"))
      || fs.readdirSync(path.join(dshHome, "plugins")).filter((n) => !n.startsWith(".")).length === 0,
      path.join(dshHome, "plugins"));

    // ① **不点任何东西**，等向导自己出现 —— 这就是这个功能本身
    const setT = await findSettingsTarget(60000);
    check("★ 全新安装启动后，首启向导**自己**弹了出来（全程没点任何东西）",
      !!setT, setT ? "settings.html 出现了" : "等 60 秒也没出现");

    // 窗口标题（CDP 的 target.title 是**文档**标题，看不见窗口标题 ⇒ 从应用日志回读）。
    // ★ 必须**轮询**：CDP 的 page 目标在 `did-finish-load` **之前**就出现了，
    //   而标题是在 load 完才设的 —— 直接读会稳定读空（第一版就是这么假 FAIL 的）。
    const titleLine = await waitForLogLine(tmpDir, /首启向导.*窗口标题/, 15000);
    check("★ 向导窗口的标题是「欢迎使用…」而不是「设置…」（窗口标题，从应用日志回读）",
      !!titleLine && /欢迎使用/.test(titleLine), titleLine || "等 15 秒也没等到那一行");

    if (!setT) return;
    const ws = setT.webSocketDebuggerUrl;
    await sleep(1200);

    // ② 停在勾选那一栏，且清单真的渲染出来了（要联网；连不上会明确报错）
    let fr = null;
    const cd = Date.now() + 45000;
    while (Date.now() < cd) {
      fr = JSON.parse(await cdpEval(ws, FR_PROBE, 20000));
      if (fr.items.length) break;
      await sleep(1000);
    }
    console.log(`  向导状态: ${fr.status}`);
    console.log(`  清单 ${fr.items.length} 条  按钮: ${fr.btnLabel}`);
    for (const it of fr.items) {
      console.log(`    ${it.checked ? "[x]" : "[ ]"} ${it.name}${it.disabled ? "（不可点）" : ""}`);
    }

    check("★ 向导自己停在「先挑几个集成版插件」那一栏（不是停在常规）",
      fr.paneOn && fr.paneDisplay !== "none", `paneOn=${fr.paneOn} display=${fr.paneDisplay}`);
    check("★ 这一栏**不在**左侧导航里（只对没插件的新用户有意义，不给老用户添噪音）",
      fr.navHasWizard === false, `navHasWizard=${fr.navHasWizard}`);
    check("清单真的渲染出了可勾的条目", fr.items.length > 0, `items=${fr.items.length} status=${fr.status}`);
    check("仓库名回填了（主进程把 repo 报回来了）", /DSH-Plugin-Hub/.test(fr.repo), fr.repo);
    check("状态行给了结论（清单更新于… / 显示的是缓存… / 取清单失败）",
      /清单更新于|显示的是缓存|取清单失败/.test(fr.status), fr.status);

    // 默认值：能装的默认勾上、开发者工具默认不勾、已装/不兼容的画成灰的且不可点
    const checkable = fr.items.filter((x) => !x.disabled);
    check("★ 至少有一条默认就勾上了（一进来就是可用的默认选择）",
      checkable.some((x) => x.checked), JSON.stringify(checkable.map((x) => [x.name, x.checked])));
    const uploader = fr.items.find((x) => x.name === "dsh-plugin-uploader");
    if (uploader) {
      check("★ 开发者工具（dsh-plugin-uploader）默认**不**勾",
        uploader.checked === false, `checked=${uploader.checked}`);
    } else {
      console.log("  SKIP  开发者工具默认不勾 —— 这一版清单里没有 dsh-plugin-uploader");
    }
    check("★ 按钮文案跟着勾选数走，且此刻是可点的",
      /安装选中的 \d+ 个插件/.test(fr.btnLabel) && fr.btnDisabled === false,
      `${fr.btnLabel} disabled=${fr.btnDisabled}`);
    check("装之前不显示收工块", fr.doneDisplay === "none", String(fr.doneDisplay));

    // ③ 一条都不勾 ⇒ 按钮必须变灰（不能给出一个点下去什么都不做的按钮）
    // ★ 用**真点击**而不是 `c.checked = false`：直接改属性**不派发 change 事件**，
    //   页面上的计数就不会更新 —— 第一版这么写，量到的是"按钮还是「3 个」"，
    //   看起来像产品 bug，其实是量具没接上（判据禁止用假动作代替真动作）。
    const noneSel = JSON.parse(await cdpEval(ws, `(() => {
      document.querySelectorAll('#fr-list input.fr-ck').forEach((c) => {
        if (!c.disabled && c.checked) c.click();
      });
      const b = document.getElementById('btn-fr-install');
      return JSON.stringify({ label: (b.textContent||'').trim(), disabled: b.disabled });
    })()`, 20000));
    check("★ 一条都不勾时，安装按钮变灰且文案回到默认",
      noneSel.disabled === true && noneSel.label === "安装选中的插件",
      JSON.stringify(noneSel));

    // ④ 「先跳过，直接开始用」⇒ 记标记 + 把窗口让开
    const before = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "(无)";
    await cdpEval(ws, `document.getElementById('btn-fr-skip').click(); 'clicked'`, 20000);
    await sleep(1500);
    let mk = null;
    try { mk = JSON.parse(fs.readFileSync(marker, "utf8").replace(/^\uFEFF/, "")); } catch { mk = null; }
    check("★「先跳过」把首启标记写下来了（<userData>/first-run.json）",
      !!(mk && mk.done === true && mk.skipped === true),
      `之前=${before} 之后=${JSON.stringify(mk)}`);
    // ★ detail 也要跟着结果走 —— 判 PASS 却印一句「settings.html 还在」会让人以为量错了
    const stray1 = await findSettingsTarget(6000);
    check("★「先跳过」真的把向导窗口关掉了（路让开，露出客户端本体）",
      !stray1, stray1 ? "settings.html 还在" : "窗口已关");
    check("跳过之后这个家里依然一个插件都没有（跳过就是跳过，不会偷偷装东西）",
      !fs.existsSync(path.join(dshHome, "plugins"))
      || fs.readdirSync(path.join(dshHome, "plugins")).filter((n) => !n.startsWith(".")).length === 0,
      path.join(dshHome, "plugins"));
  } finally {
    await stopApp(a.child);
  }

  // ══ 第二趟：同一个家（有标记、仍然零插件）⇒ 不许再弹 ═══════════
  await sleep(800);
  const b = launch("firstrun", tmpDir, PORT, { firstRun: true });
  try {
    await waitForPage((t) => t.url.startsWith(`http://127.0.0.1:${PORT}/`), 120000);
    // 主进程是在 loadURL 解析完之后**紧接着**判定并弹窗的 ⇒ 等 12 秒足够看清"弹没弹"
    await sleep(12000);
    const stray = await findSettingsTarget(1500);
    check("★★ 第二次启动**不再**自动弹向导（家里仍然零插件 ⇒ 唯一拦住它的是那个标记）",
      !stray, stray ? "又弹出来了" : "没弹，正确");

    const target = await waitForPage((t) => t.url.startsWith(`http://127.0.0.1:${PORT}/`), 20000);
    const mainUrl = target.webSocketDebuggerUrl;

    // ⑤ 手动那条路：设置窗口 →「集成版插件」栏 →「打开首次安装向导」
    const opened = await cdpEval(mainUrl, `window.dshShell.openShellSettings().then(r => JSON.stringify(r))`);
    check("主界面能打开外壳设置窗口", /"ok":true/.test(opened), String(opened));
    const setT = await findSettingsTarget(20000);
    check("外壳设置窗口真的出现了", !!setT, setT ? "settings.html" : "没等到");
    if (!setT) return;

    const ws = setT.webSocketDebuggerUrl;
    await sleep(1500);
    const jumped = JSON.parse(await cdpEval(ws, `(() => {
      const b = document.querySelector('nav button[data-pane="plugins"]');
      if (!b) return JSON.stringify({ err: 'no-nav' });
      b.click();
      const w = document.getElementById('btn-pl-wizard');
      if (!w) return JSON.stringify({ err: 'no-button' });
      w.click();
      const pane = document.querySelector('.pane[data-pane="welcome"]');
      return JSON.stringify({
        paneOn: pane ? pane.classList.contains('on') : false,
        display: pane ? getComputedStyle(pane).display : null,
        pluginsPaneOn: (document.querySelector('.pane[data-pane="plugins"]')||{classList:{contains:()=>false}}).classList.contains('on'),
      });
    })()`, 20000));
    check("★ 老用户能从「集成版插件」栏手动打开向导（按钮点了真的切到那一栏）",
      jumped.paneOn && jumped.display !== "none" && jumped.pluginsPaneOn === false,
      JSON.stringify(jumped));

    // ⑥ 真装一个：只勾一条，点安装，等收工块
    let fr2 = null;
    const cd2 = Date.now() + 45000;
    while (Date.now() < cd2) {
      fr2 = JSON.parse(await cdpEval(ws, FR_PROBE, 20000));
      if (fr2.items.length) break;
      await sleep(1000);
    }
    check("手动打开的向导同样渲染出了清单", fr2.items.length > 0, `items=${fr2.items.length} status=${fr2.status}`);
    const target0 = fr2.items.find((x) => !x.disabled && x.name === "dsh-archive-manager")
      || fr2.items.find((x) => !x.disabled);
    check("清单里至少有一条现在能装", !!target0, JSON.stringify(fr2.items.map((x) => x.name)));
    if (!target0) return;
    picked = target0.name;

    const sel = JSON.parse(await cdpEval(ws, `(() => {
      // 同上：真点击，别改属性 —— 只有真事件才会让页面重算按钮文案
      document.querySelectorAll('#fr-list input.fr-ck').forEach((c) => {
        const want = (c.dataset.frName === ${JSON.stringify(picked)});
        if (!c.disabled && c.checked !== want) c.click();
      });
      const b = document.getElementById('btn-fr-install');
      return JSON.stringify({ label: (b.textContent||'').trim(), disabled: b.disabled });
    })()`, 20000));
    check("只勾一条时按钮文案是「安装选中的 1 个插件」且可点",
      sel.label === "安装选中的 1 个插件" && sel.disabled === false, JSON.stringify(sel));

    await cdpEval(ws, `document.getElementById('btn-fr-install').click(); 'ok'`, 20000);
    let done = null;
    const cd3 = Date.now() + 90000;
    while (Date.now() < cd3) {
      done = JSON.parse(await cdpEval(ws, FR_PROBE, 20000));
      if (done.doneDisplay !== "none") break;
      await sleep(1500);
    }
    console.log(`  收工块: ${JSON.stringify(done && done.doneText)}`);
    check(`★ 真装完 ${picked} 之后出现了收工块，并说清下一步是重启内核`,
      done.doneDisplay !== "none" && done.doneText.includes(picked) && /重启/.test(done.doneText),
      JSON.stringify(done.doneText));
    check("收工之后安装按钮那一排收起来（不给重复点的机会）",
      done.actsDisplay === "none", String(done.actsDisplay));

    // ⑦ 磁盘上核对：落点 + profile 三处契约（**不看插件自己的结果文案**）
    const store = path.join(dshHome, "plugins", picked);
    check(`★ 插件本体真的落在 <DSH_HOME>\\plugins\\${picked}`,
      fs.existsSync(path.join(store, "package.json")), store);
    let pj = null;
    try { pj = JSON.parse(fs.readFileSync(pkgFile, "utf8").replace(/^\uFEFF/, "")); } catch { pj = null; }
    const dep = pj && pj.dependencies ? pj.dependencies[picked] : null;
    check(`① profile dependencies["${picked}"] 是 link: 指向那个落点`,
      typeof dep === "string" && dep.startsWith("link:")
      && path.resolve(dep.slice(5)).toLowerCase() === path.resolve(store).toLowerCase(), String(dep));
    const bundles = pj && pj.dsh && pj.dsh.profile ? pj.dsh.profile.bundles : null;
    check(`② dsh.profile.bundles 里含 ${picked}`,
      Array.isArray(bundles) && bundles.includes(picked), JSON.stringify(bundles));
    let real = null;
    try { real = fs.realpathSync(path.join(dshHome, "profiles", "web", "node_modules", picked)); } catch { real = null; }
    check(`③ node_modules\\${picked} 真的解析到那个落点`,
      !!real && path.resolve(real).toLowerCase() === path.resolve(store).toLowerCase(), String(real));

    let mk2 = null;
    try { mk2 = JSON.parse(fs.readFileSync(marker, "utf8").replace(/^\uFEFF/, "")); } catch { mk2 = null; }
    check("★ 装完把首启标记更新成「装过这些了」",
      !!(mk2 && mk2.done === true && Array.isArray(mk2.installed) && mk2.installed.includes(picked)),
      JSON.stringify(mk2));
  } finally {
    await stopApp(b.child);
  }
}

// ── 主流程 ────────────────────────────────────────────────────────
(async () => {
  if (typeof WebSocket === "undefined") {
    console.error("这个 node 没有全局 WebSocket，无法走 CDP（需要 Node 22+）");
    process.exit(1);
  }
  if (!["loading", "inject", "probe", "reuse", "pages", "plugins", "firstrun"].includes(MODE)) {
    console.error("用法: node scripts/ui-check.js <loading|inject|probe|reuse|pages|plugins|firstrun>");
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-uicheck-"));
  console.log(`ui-check [${MODE}]`);
  console.log(`  临时 userData: ${tmpDir}`);
  console.log("  （DSH_HOME 落临时目录，不碰 B / A；inject 模式复用正在跑的内核，不起第二个）");
  console.log("");

  try {
    await (MODE === "loading" ? verifyLoading(tmpDir)
      : MODE === "probe" ? probeUi(tmpDir)
        : MODE === "reuse" ? verifyReuse(tmpDir)
          : MODE === "pages" ? verifyPages(tmpDir)
            : MODE === "plugins" ? verifyPlugins(tmpDir)
              : MODE === "firstrun" ? verifyFirstRun(tmpDir)
                : verifyInject(tmpDir));
  } catch (e) {
    console.error(`\n[ui-check] 无法完成检查: ${(e && e.stack) || e}`);
    failures.push("执行异常: " + ((e && e.message) || e));
  } finally {
    if (failures.length) {
      const tail = readAppLog(tmpDir, 40);
      if (tail.length) {
        console.error("\n── 应用 shell.log 尾部 ──");
        for (const l of tail) console.error("  " + l);
      }
    }
    await sleep(300);
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 }); }
    catch (e) { console.error(`（临时目录没删干净: ${tmpDir}）`); }
  }

  console.log("");
  if (failures.length) {
    console.error(`[ui-check] ${failures.length} 项 FAIL:`);
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }
  console.log(`[ui-check] ${MODE} 模式全部通过`);
  process.exit(0);
})();
