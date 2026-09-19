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

  // ★ 不用管道抓子进程输出：Windows 沙箱下 Node 的 piped stdio 会 EPERM。
  //   应用自己会把日志写进 <userData>/shell.log，失败时读文件即可（readAppLog）。
  const child = spawn(electronExe, [
    ".",
    `--user-data-dir=${tmpDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
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

// ── 主流程 ────────────────────────────────────────────────────────
(async () => {
  if (typeof WebSocket === "undefined") {
    console.error("这个 node 没有全局 WebSocket，无法走 CDP（需要 Node 22+）");
    process.exit(1);
  }
  if (MODE !== "loading" && MODE !== "inject" && MODE !== "probe" && MODE !== "reuse") {
    console.error("用法: node scripts/ui-check.js <loading|inject|probe|reuse>");
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
