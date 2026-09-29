/**
 * port-plugin-check.js —— 注入→插件 移植后的**真跑验收**（2026-09-29）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不能只看"文件生成了 / 语法过了 / 列进 bundles 了"
 * ══════════════════════════════════════════════════════════════════
 * 项目铁律第二条：**"静态可解析" ≠ "动态可加载"**。对客户端插件尤其致命 ——
 * 装错了的典型表现是「bundle 加载了、宿主侧全好、界面上什么都没有」，**而且不报错**。
 * 2026-09-27 02:26 那次真事故更是反过来的：profile 的 `link:` 一断，内核**逐条**
 * `skipping profile bundle …`，界面上 9 个插件全没了。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三层证据（一层比一层硬，**最后一层完全不看插件自己的报告**）
 * ══════════════════════════════════════════════════════════════════
 *  ① **组合**：镜像 profile 起真内核 → 自解析**完整** `__DSH_BOOT__` 载荷
 *     ⇒ 两个新插件在 `entries` 里，且 stderr 里 `skipping profile bundle` = 0。
 *  ② **挂载**：用真 Chrome 打开那个内核的 UI → 断言两个客户端半边**真的跑到了**：
 *     `window.__dshModelSearchStats.src === "plugin"`、`window.__dshSidebarOpen.src === "plugin"`、
 *     浮层根节点真在 DOM 里。★ 这一层专治"bundle 加载了但什么都没挂"。
 *  ③ **行为**：在**真实页面**里合成官方菜单 / 文件行的 DOM，让**跑着的插件代码**去装饰它，
 *     断言搜索框被建出来、筛选真的生效、悬停真的出图标、点击真的走通宿主（失败路径也要有答案）。
 *     ⇒ 不看插件自己的文案，看 **DOM 与宿主返回值**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 环境（**不碰 B 也不碰官方端的家**）
 * ══════════════════════════════════════════════════════════════════
 *   <临时家>/profiles/node_modules        → 【联接】B 的工作家（模块解析兜底层）
 *   <临时家>/profiles/web/**              → 文件原样复制、子目录联接
 *   <临时家>/profiles/web/package.json    → 在副本里**追加**两个新插件的依赖与 bundles
 *   <临时家>/profiles/web/node_modules/<新插件> → 【联接】本仓库 plugin/<名字>
 *   <临时家>/storages/settings/sessions   → 只为 UI 能起来的最小型夹具
 *
 * 用法：node scripts/port-plugin-check.js [--keep] [--no-ui] [--port 3113] [--cdp 9333]
 * 退出码：0 全过；1 有 FAIL；2 环境/启动失败。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const { spawn, spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");

const ROOT = path.join(__dirname, "..");
const HOME = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "DSH Integrated", "dsh-home");
const PROFILE = "web";
const K = require(path.join(ROOT, "src", "kernel.js"));

const NEW_PLUGINS = ["dsh-int-model-search", "dsh-int-sidebar-open"];
const KEEP = process.argv.includes("--keep");
const NO_UI = process.argv.includes("--no-ui");
const PORT = Number((process.argv.find((a) => a.startsWith("--port=")) || "").slice(7) || 3113);
const CDP = Number((process.argv.find((a) => a.startsWith("--cdp=")) || "").slice(6) || 9333);
const CHROME_CANDS = [
  path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

let passN = 0, failN = 0, skipN = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passN++; console.log(`  PASS  ${name}${detail ? "  — " + detail : ""}`); }
  else { failN++; failures.push(name + (detail ? " / " + detail : "")); console.log(`  FAIL  ${name}${detail ? "  — " + detail : ""}`); }
  return !!ok;
}
function skip(name, why) { skipN++; console.log(`  SKIP  ${name}  — ${why}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url, headers = {}) {
  return new Promise((resolve) => {
    const r = http.get(url, { headers }, (res) => {
      let b = ""; res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on("error", (e) => resolve({ status: 0, headers: {}, body: "", error: e.code }));
    r.setTimeout(20000, () => { r.destroy(); resolve({ status: 0, headers: {}, body: "", error: "TIMEOUT" }); });
  });
}

/** 从 HTML 里抠出 __DSH_BOOT__ 的 JSON（花括号配平、跳过字符串里的括号）。 */
function extractBoot(html) {
  const i = html.indexOf("__DSH_BOOT__");
  if (i < 0) return null;
  const s = html.indexOf("{", html.indexOf("=", i));
  if (s < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = s; j < html.length; j++) {
    const c = html[j];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { try { return JSON.parse(html.slice(s, j + 1)); } catch { return null; } } }
  }
  return null;
}

/** 会话日志目录名（内核按 cwd 转义；实测反推、逐条核对过，见 ui-check.js 同名字段）。 */
function sessionDirName(p) {
  let s = "";
  for (const ch of p) {
    const c = ch.codePointAt(0);
    if (ch === ":") continue;
    if (ch === "\\" || ch === "/") { s += "-"; continue; }
    if (c < 128) { s += ch; continue; }
    for (let i = 0; i < ch.length; i++) s += "~" + ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0") + "~";
  }
  return "--" + s + "--";
}

// ── 极简 CDP 客户端 ───────────────────────────────────────────────────
async function cdpTargets() {
  const r = await get(`http://127.0.0.1:${CDP}/json/list`);
  if (r.status !== 200) return [];
  try { return JSON.parse(r.body); } catch { return []; }
}
async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP 连不上")); });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const myId = ++id;
    waiting.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    setTimeout(() => { if (waiting.has(myId)) { waiting.delete(myId); res(null); } }, 20000);
  });
  return { ws, send };
}
async function evalJs(conn, expr) {
  const r = await conn.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (!r || !r.result) return null;
  if (r.result.exceptionDetails) return null;
  return r.result.result ? r.result.result.value : null;
}
/** 真鼠标三连（mousedown→mouseup→click）：`el.click()` 测不出焦点类 bug（项目铁律）。 */
async function realClick(conn, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await conn.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    await sleep(30);
  }
}

// ── 搭镜像家 ──────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const MIRROR = path.join(os.tmpdir(), `dsh-portcheck-${stamp}`);
const WS = path.join(MIRROR, "ws");
const P = (...a) => path.join(MIRROR, ...a);
const B = (...a) => path.join(HOME, ...a);

function buildMirror() {
  fs.mkdirSync(P("profiles", PROFILE), { recursive: true });
  // 只把**上一层** `profiles\node_modules`（内核包的拦截层）做联接 —— 那一层只读。
  const up = B("profiles", "node_modules");
  if (fs.existsSync(up)) fs.symlinkSync(up, P("profiles", "node_modules"), "junction");
  for (const e of fs.readdirSync(B("profiles", PROFILE), { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const from = B("profiles", PROFILE, e.name), to = P("profiles", PROFILE, e.name);
    if (e.isDirectory()) fs.symlinkSync(from, to, "junction");
    else fs.copyFileSync(from, to);
  }
  // ★★ `profiles\<profile>\node_modules` 必须是**真目录**，里面**逐个**建联接。
  //   第一版把这一层也做成了指向 B 的联接 ⇒ 往里建插件联接时**透写进了 B 的活 profile**
  //   （EEXIST 才暴露出来）。这正是项目联接纪律警告的那类错误：联接是个洞，
  //   写它就等于写目标。⇒ 真目录 + 逐个联接（且只读地指向 B 的包）。
  const nm = P("profiles", PROFILE, "node_modules");
  fs.mkdirSync(nm, { recursive: true });
  const srcNm = B("profiles", PROFILE, "node_modules");

  // 两个新插件：写进**副本**的 package.json，并在副本 node_modules 里建联接
  const pkgFile = P("profiles", PROFILE, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  pkg.dependencies = pkg.dependencies || {};
  pkg.dsh = pkg.dsh || {}; pkg.dsh.profile = pkg.dsh.profile || {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  for (const name of NEW_PLUGINS) {
    pkg.dependencies[name] = "link:" + path.join(ROOT, "plugin", name);
    if (!bundles.includes(name)) bundles.push(name);
  }
  pkg.dsh.profile.bundles = bundles;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n", "utf8");

  let linked = 0, missed = [];
  for (const name of Object.keys(pkg.dependencies)) {
    const to = path.join(nm, name);
    fs.mkdirSync(path.dirname(to), { recursive: true });   // 作用域包（@scope/name）要先有父目录
    if (NEW_PLUGINS.includes(name)) { fs.symlinkSync(path.join(ROOT, "plugin", name), to, "junction"); linked++; continue; }
    const from = path.join(srcNm, name);
    if (fs.existsSync(from)) { fs.symlinkSync(from, to, "junction"); linked++; }
    else missed.push(name);
  }
  console.log(`  镜像 profile：依赖 ${Object.keys(pkg.dependencies).length} 条、bundles ${bundles.length} 条（含新插件 ${NEW_PLUGINS.length} 个）`);
  console.log(`  node_modules：建了 ${linked} 条联接（**真目录**，不往 B 透写）${missed.length ? "；B 里没有这些（" + missed.join(",") + "）" : ""}`);

  // UI 夹具（只为"界面能起来 + 有会话输入框 + 有文件树"；与 ui-check files 同一套做法）
  fs.mkdirSync(path.join(WS, "sub"), { recursive: true });
  fs.writeFileSync(path.join(WS, "note.txt"), "hello from port-plugin-check\n", "utf8");
  fs.writeFileSync(path.join(WS, "readme.md"), "# port check fixture\n", "utf8");
  fs.writeFileSync(path.join(WS, "sub", "deep.txt"), "deep\n", "utf8");
  const sid = "session-00000000-1111-2222-3333-444444444444";
  const wid = "ffffffff-1111-2222-3333-444444444444";
  fs.mkdirSync(P("storages"), { recursive: true });
  fs.writeFileSync(P("storages", "workspace.json"), JSON.stringify({
    unit: { name: "workspace", version: 2 },
    global: { initialized: true, workspaceIds: [wid], archivedSessionIds: [] },
    tables: { workspaces: { [wid]: { path: WS, title: "port-check-ws", sessionIds: [sid], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } },
  }, null, 2), "utf8");
  const sdir = P("sessions", sessionDirName(WS), sid);
  fs.mkdirSync(sdir, { recursive: true });
  const header = JSON.stringify({ type: "session", version: 3, id: sid, createdAt: Date.now(), cwd: WS, isSeeded: false, delegationDepth: 0, agentPreset: "standard" }) + "\n";
  fs.writeFileSync(path.join(sdir, "session.v3.jsonl.zstd"), zlib.zstdCompressSync(Buffer.from(header, "utf8")));
  // 内测声明确认（否则官方那个 fixed 遮罩会挡住一切）+ 一份**假**凭据（避免"添加 API Key"框反复弹）
  fs.writeFileSync(P("settings.yaml"), "ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\n", "utf8");
  fs.writeFileSync(P(".credentials.yaml"), "version: 1\nrefs:\n  DEEPSEEK_API_KEY: port-check-dummy-not-a-real-key\n", "utf8");
  console.log(`  夹具：工作区 ${WS}（1 子目录 + 3 文件 + 1 个真会话）`);
}

// ── 环境（Chrome 在不在）───────────────────────────────────────────────
function findChrome() { return CHROME_CANDS.find((p) => p && fs.existsSync(p)) || null; }

// ── 主流程 ────────────────────────────────────────────────────────────
(async () => {
  if (typeof WebSocket === "undefined") { console.error("这个 node 没有全局 WebSocket（需要 Node 22+）"); process.exit(2); }
  console.log(`移植验收 [${NEW_PLUGINS.join(", ")}]`);
  console.log(`  临时家: ${MIRROR}`);
  buildMirror();

  const kernel = K.discoverKernel();
  console.log(`  内核: ${kernel.version}（端口 ${PORT}）`);
  const spawned = K.spawnKernel({ kernel, dshHome: MIRROR, port: PORT, profile: PROFILE, logDir: path.join(ROOT, "runtime", "diag-logs") });
  let chrome = null, conn = null;
  try {
    const tokenUrl = await K.waitForUrl(spawned.logFile, spawned.child, 90000);
    if (!tokenUrl) { console.log("!! 内核没起来：\n" + K.tailLog(spawned.logFile, 25)); process.exit(2); }
    const origin = new URL(tokenUrl).origin;
    const r1 = await get(tokenUrl);
    const cookie = (r1.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");

    // ══ ① 组合层 ══════════════════════════════════════════════════
    console.log("\n── ① 组合：真内核的引导载荷里有没有这两个插件 ──");
    const r2 = await get(origin + "/", cookie ? { Cookie: cookie } : {});
    const boot = extractBoot(r2.body);
    const ids = boot ? (boot.entries || []).map((e) => e.id) : [];
    console.log(`  载荷：entries=${ids.length}、batches=${boot ? (boot.batches || []).length : "?"}`);
    for (const name of NEW_PLUGINS) check(`引导载荷 entries 里有 ${name}`, ids.includes(name));
    let err = "";
    try { err = fs.readFileSync(spawned.logFile.replace(/\.log$/, ".err.log"), "utf8"); } catch { }
    const skips = err.match(/skipping profile bundle[^\n]*/gi) || [];
    check('内核 stderr 里 "skipping profile bundle" 为 0 条', skips.length === 0, skips.slice(0, 3).join(" | "));

    if (NO_UI) { console.log("\n（--no-ui：跳过真浏览器那两层）"); return finish(); }

    // ══ ②③ 真浏览器：Chrome + CDP ═════════════════════════════════
    const chromeExe = findChrome();
    if (!chromeExe) { skip("真浏览器验收", "本机找不到 Chrome"); return finish(); }
    console.log(`\n── ② 挂载 / ③ 行为：真 Chrome（${chromeExe}）──`);
    const chromeProfile = path.join(MIRROR, "chrome-profile");
    chrome = spawn(chromeExe, [
      `--remote-debugging-port=${CDP}`, `--user-data-dir=${chromeProfile}`,
      "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
      "--window-size=1280,860", "about:blank",
    ], { stdio: "ignore", windowsHide: true });

    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(500);
      const ts = await cdpTargets();
      target = ts.find((t) => t.type === "page");
    }
    if (!target) { check("Chrome 的 CDP 起来了", false, "40 次轮询没拿到 page 目标"); return finish(); }
    conn = await cdpConnect(target.webSocketDebuggerUrl);
    await conn.send("Page.enable");
    await conn.send("Runtime.enable");
    await conn.send("Page.navigate", { url: tokenUrl });
    console.log(`  已导航到内核 UI: ${origin}/?token=***`);

    // 等客户端启动 + 两个插件各自的钩子出现
    let st = null;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const raw = await evalJs(conn, `JSON.stringify({
        boot: !!window.__DSH_BOOT__,
        ms: window.__dshModelSearchStats || null,
        sb: (window.__dshSidebarOpen && window.__dshSidebarOpen.state) ? window.__dshSidebarOpen.state() : null,
        sbSrc: window.__dshSidebarOpen ? window.__dshSidebarOpen.src : null,
        sbRoot: !!document.querySelector('[data-dsh-file-open="root"]'),
        editables: document.querySelectorAll('[contenteditable="true"]').length,
        triggers: Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).filter(x => (x.getAttribute("aria-label")||"").includes("选择模型")).length
      })`);
      if (!raw) continue;
      st = JSON.parse(raw);
      if (st.boot && st.ms && st.sb) break;
    }
    if (!st) { check("能读到页面状态", false, "CDP evaluate 一直失败"); return finish(); }
    // ★ 两个钩子一出现就跳出循环了，而 model-search 的 sweep 是 60 ms 后才跑的第一趟
    //   ⇒ 必须**再等一会儿**再读计数，否则 sweeps 恒为 0（第一版就是这么假 FAIL 的）。
    await sleep(1500);
    {
      const again = await evalJs(conn, `JSON.stringify({
        ms: window.__dshModelSearchStats || null,
        sb: (window.__dshSidebarOpen && window.__dshSidebarOpen.state) ? window.__dshSidebarOpen.state() : null,
        sbSrc: window.__dshSidebarOpen ? window.__dshSidebarOpen.src : null,
        sbRoot: !!document.querySelector('[data-dsh-file-open="root"]')
      })`);
      if (again) st = Object.assign({}, st, JSON.parse(again));
    }
    console.log(`  页面状态: boot=${st.boot} 可编辑输入框=${st.editables} 模型触发器=${st.triggers}（等 1.5s 后的计数）`);

    check("客户端启动图在页面里（__DSH_BOOT__）", st.boot);
    // ② 挂载层 —— 专治"bundle 加载了但什么都没挂"
    check("模型搜索插件真的跑了（钩子存在）", !!st.ms, JSON.stringify(st.ms));
    check('模型搜索钩子的 src === "plugin"（跑的是插件不是外壳注入）', st.ms && st.ms.src === "plugin", st.ms && st.ms.src);
    check("模型搜索的 MutationObserver 扫描在跑（sweeps > 0）", st.ms && st.ms.sweeps > 0, st.ms && "sweeps=" + st.ms.sweeps);
    check("侧栏插件真的跑了（钩子存在）", !!st.sb, st.sb && JSON.stringify({ installed: st.sb.installed }));
    check('侧栏钩子的 src === "plugin"', st.sbSrc === "plugin", String(st.sbSrc));
    check("侧栏浮层根节点真的建出来了（DOM 里有）", st.sbRoot);

    // ③ 行为层：**在真页面里合成官方菜单 DOM**，让跑着的插件代码去装饰它
    const menuProbe = await evalJs(conn, `(async () => {
      const NS = "data-dsh-ms-hide";
      // 先清掉可能存在的旧菜单
      document.querySelectorAll('div[role="menu"][data-probe]').forEach(x => x.remove());
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu"); menu.setAttribute("data-probe", "1");
      const wrap = document.createElement("div");             // section 的父（= groupsContainer）
      const inner = document.createElement("div");            // 再上一层（buildBar 需要 parentElement）
      inner.appendChild(wrap);
      for (const [pi, gname] of [["A", "提供方甲"], ["B", "提供方乙"]].entries()) {
        const sec = document.createElement("section");
        sec.setAttribute("role", "group"); sec.setAttribute("aria-labelledby", "g" + pi);
        const title = document.createElement("div"); title.id = "g" + pi; title.textContent = gname;
        sec.appendChild(title);
        for (const m of ["模型甲一", "模型甲二"]) {
          const b = document.createElement("button");
          b.setAttribute("role", "menuitemradio"); b.setAttribute("title", pi + "-" + m);
          b.textContent = pi + "-" + m; sec.appendChild(b);
        }
        wrap.appendChild(sec);
      }
      menu.appendChild(inner);
      document.body.appendChild(menu);
      await new Promise(r => setTimeout(r, 400));   // 等 MutationObserver → sweep
      const bar = menu.querySelector(".dsh-ms-bar");
      const pills = Array.from(menu.querySelectorAll(".dsh-ms-pill")).map(x => x.textContent);
      let filtered = null, keptMenu = null;
      if (bar) {
        const input = bar.querySelector("input");
        input.value = "甲一";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise(r => setTimeout(r, 250));
        const rows = Array.from(menu.querySelectorAll('button[role="menuitemradio"]'));
        filtered = rows.filter(r => r.getAttribute(NS) === "1").length;
        keptMenu = !!document.querySelector('div[role="menu"][data-probe]');
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return JSON.stringify({ hasBar: !!bar, pills, filtered, keptMenu, total: menu.querySelectorAll('button[role="menuitemradio"]').length });
    })()`);
    const mp = menuProbe ? JSON.parse(menuProbe) : null;
    console.log(`  合成菜单探针: ${menuProbe}`);
    check("插件在合成出来的官方菜单里**建出了搜索框**", mp && mp.hasBar, mp && JSON.stringify({ hasBar: mp.hasBar }));
    // 胶囊：实现里除了每个提供方一颗，还有一颗「全部 N」⇒ 断言"两颗提供方都在"，
    // 不锁死总颗数（第一版锁了 ===2，被真实的第三颗「全部」判成 FAIL —— 尺子错）
    const pillTxt = (mp && mp.pills || []).join("|");
    check("提供方胶囊被建出来（两颗提供方都在里面）",
      !!(mp && mp.pills && mp.pills.length >= 3 && pillTxt.includes("提供方甲") && pillTxt.includes("提供方乙")),
      mp && JSON.stringify(mp.pills));
    check("空态不出现（还有匹配的行）", !!(mp && mp.total > 0 && (mp.filtered || 0) < mp.total), mp && "total=" + mp.total + " hidden=" + mp.filtered);
    check("输入关键词后**真的筛掉了行**（隐藏 2 行 / 共 4 行）", mp && mp.filtered === 2, mp && "hidden=" + mp.filtered + " total=" + mp.total);

    // 侧栏：合成一个文件行 → 真鼠标移上去 → 出图标
    const sidebarProbe = await evalJs(conn, `(async () => {
      document.querySelectorAll('[data-probe-file]').forEach(x => x.remove());
      const li = document.createElement("li");
      li.setAttribute("data-files-entry", "file"); li.setAttribute("data-probe-file", "1");
      li.setAttribute("data-files-path", String.raw\`${WS.replace(/\\/g, "\\\\\\\\")}\\note.txt\`);
      const btn = document.createElement("button"); btn.textContent = "note.txt";
      li.style.cssText = "position:fixed;left:8px;top:120px;width:240px;height:28px";
      li.appendChild(btn); document.documentElement.appendChild(li);
      await new Promise(r => setTimeout(r, 100));
      const rc = btn.getBoundingClientRect();
      const x = rc.left + 12, y = rc.top + rc.height / 2;
      return JSON.stringify({ x, y, path: li.getAttribute("data-files-path") });
    })()`);
    const sp = sidebarProbe ? JSON.parse(sidebarProbe) : null;
    if (!sp) skip("侧栏合成行探针", "注入夹具失败");
    else {
      await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sp.x, y: sp.y, button: "none" });
      await sleep(400);
      const sbState = await evalJs(conn, `JSON.stringify({
        strip: !!document.querySelector('[data-dsh-file-open="strip"]'),
        visible: (() => { const s = document.querySelector('[data-dsh-file-open="strip"]'); return !!(s && s.style.display === "flex"); })(),
        hoverPath: window.__dshSidebarOpen.state().hoverPath,
        icons: Array.from(document.querySelectorAll('[data-dsh-file-open="strip"] [data-dsh-file-action]')).map(b => b.getAttribute("data-dsh-file-action"))
      })`);
      const sb = sbState ? JSON.parse(sbState) : null;
      console.log(`  侧栏探针: ${sbState}`);
      check("真鼠标移到文件行 ⇒ 浮出图标条", sb && sb.visible, sb && JSON.stringify({ strip: sb.strip, visible: sb.visible }));
      check("图标条认出了那一行的绝对路径（data-files-path）", sb && sb.hoverPath && sb.hoverPath.toLowerCase().endsWith("note.txt"), sb && sb.hoverPath);
      check("文件行给的是两个动作（用默认应用打开 / 在管理器中显示）",
        sb && sb.icons && sb.icons.includes("open") && sb.icons.includes("reveal"), sb && JSON.stringify(sb.icons));

      // 真点「打开」→ 走 bridge → 宿主；故意用**不存在的路径**，避免真启动程序
      const badPath = path.join(WS, "does-not-exist-port-check.txt");
      const before = await evalJs(conn, `window.__dshSidebarOpen.state().calls`);
      // ★ 先把鼠标移开（否则 onOver 会因为"指针还在我们自己的浮层里"而直接 return，
      //   换了 data-files-path 也不会刷新 hover.path —— 第一版就是这么测出个假象的）
      await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4, button: "none" });
      await sleep(200);
      await evalJs(conn, `(() => {
        const li = document.querySelector('[data-probe-file]');
        if (li) li.setAttribute("data-files-path", ${JSON.stringify(badPath)});
        return true;
      })()`);
      await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sp.x, y: sp.y, button: "none" });
      await sleep(400);
      const iconBox = await evalJs(conn, `(() => {
        const b = document.querySelector('[data-dsh-file-open="strip"] [data-dsh-file-action="open"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, hovered: window.__dshSidebarOpen.state().hoverPath });
      })()`);
      if (!iconBox) skip("真点图标那一条", "图标条没出来（上一条已 FAIL）");
      else {
        const ib = JSON.parse(iconBox);
        check("换成不存在的路径后，悬停真的跟着换了（hover.path 已更新）",
          typeof ib.hovered === "string" && ib.hovered.toLowerCase().includes("does-not-exist"), ib.hovered);
        await realClick(conn, ib.x, ib.y);
        // ★ 宿主往返要时间，别用固定 sleep 就下结论（第一版 700ms 读到 ok=null 就判 FAIL —— 又是尺子）
        let a = null;
        for (let i = 0; i < 12; i++) {
          await sleep(500);
          const after = await evalJs(conn, `JSON.stringify({ calls: window.__dshSidebarOpen.state().calls, last: window.__dshSidebarOpen.state().last })`);
          a = after ? JSON.parse(after) : null;
          if (a && a.last && a.last.ok !== null) break;
        }
        console.log(`  点击结果: ${JSON.stringify(a)}`);
        check("真点图标**真的发起了宿主调用**（calls 增加）", a && a.calls > (before || 0), `before=${before} after=${a && a.calls}`);
        check("宿主**给了答案**（往返真的走通了：last.ok 已落定，不是悬着的 null）",
          a && a.last && a.last.ok !== null, a && JSON.stringify(a.last));
        // ★★ 判据修正（2026-09-29 实测）：宿主**不校验路径是否存在** —— 拿一个不存在的路径去问，
        //   它照样回 ok:true（它的契约是"把路径交给本机打开器"，d.ts：SessionOpenWorkspacePathValue
        //   = { opened: true }）。所以"ok:true"才是**这条链走通**的证据，
        //   而"文件不存在"这件事**不会**由宿主报错（注入版当年靠外壳的 shell.openPath 才拿到错误串）。
        //   ⇒ 断言改成本条 + 下面那条"答案是 true"，并把边界写进 README。
        check("宿主受理了这次打开（ok === true ⇒ 路径已交给本机打开器）",
          a && a.last && a.last.ok === true, a && JSON.stringify(a.last));
        check("我们发出去的动作是 open（不是别的）", a && a.last && a.last.action === "open", a && a.last && a.last.action);
      }
    }
    return finish();
  } catch (e) {
    console.log(`!! 异常：${(e && e.stack) || e}`);
    failN++;
    failures.push("异常：" + ((e && e.message) || e));
    return finish();
  } finally {
    try { if (conn && conn.ws) conn.ws.close(); } catch { }
    try { if (chrome) spawnSync("taskkill", ["/pid", String(chrome.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { }
    try { K.killTree(spawned.child); } catch { }
    await sleep(800);
    if (!KEEP) { try { fs.rmSync(MIRROR, { recursive: true, force: true }); } catch { } }
    else console.log(`  （--keep：镜像留着 ${MIRROR}）`);
  }

  function finish() {
    console.log(`\n── 结果 ──\n  PASS ${passN} / FAIL ${failN} / SKIP ${skipN}`);
    if (failures.length) { console.log("  失败项："); for (const f of failures) console.log("    - " + f); }
    process.exit(failN ? 1 : 0);
  }
})().catch((e) => { console.error("失败:", e); process.exit(2); });
