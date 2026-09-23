"use strict";

/**
 * plugin-check-mobile-remote.js —— 在**临时环境**里真跑一遍手机遥控插件。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须真跑（而不是"语法过了 / 文件都在 / 配进 bundles 了"）
 * ══════════════════════════════════════════════════════════════════
 * `$DSH_HOME/AGENTS.md` 第二条硬规矩：验证必须**真让它工作**。
 * 本项目上一版插件就是死在这条上：文件都在、profile 里也登记了，
 * 但 `lib/index.js` 里写着 TypeScript 的 `export interface`（**语法都不合法**）、
 * `lib/client.js` 有顶层 `export`（经典脚本里是语法错误）、
 * 还 import 了本机根本不存在的 `jsonwebtoken`。
 * 这些都是"静态看一眼就能发现、但没人真跑"的故障。
 *
 * ══════════════════════════════════════════════════════════════════
 * 四层证据，一层比一层硬（后三层刻意**不看插件自己的说法**）
 * ══════════════════════════════════════════════════════════════════
 *  ① 结构：`window.__DSH_BOOT__.entries` 里有 `dsh-int-mobile-remote`
 *  ② 动态：页面里出现插件注入的 `<style data-plugin-css>`，且调试钩子存在
 *     ⇒ `apply()` 真的跑了（"bundle 被下载"不算）
 *  ③ **端到端（真 HTTP）**：配对 → 列会话 → 新建会话 → 发消息 → 中断，
 *     全部走**真实的局域网 HTTP 接口**，不是内部函数调用。
 *  ④ **磁盘交叉核对**：不信接口返回的"已受理"，去临时 DSH_HOME 的
 *     `sessions/` 里找那串标记文本 —— 提示词真的落盘了才算数。
 *
 * ══════════════════════════════════════════════════════════════════
 * 与用户的真实环境严格隔离
 * ══════════════════════════════════════════════════════════════════
 * · 临时 DSH_HOME（`runtime/plugin-check-mobile-remote/<时间戳>/`），**不碰 B、不碰 A**
 * · 局域网端口用 `DSH_MOBILE_REMOTE_PORT` 指到一个空闲端口（**不抢 3110**，
 *   否则"验证"会连到用户正在跑的那个实例上）
 * · 新会话建在临时家里，**绝不往用户正在用的会话里发测试提示词**
 *
 * 用法：
 *   node scripts/plugin-check-mobile-remote.js
 *   node scripts/plugin-check-mobile-remote.js --keep    # 保留临时目录
 *
 * 退出码：0 全过；1 有 FAIL；2 环境/启动失败。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
/**
 * ★ 包名与目录名**必须分开**（2026-09-22 改名时踩到的分界）：
 *   · 包名 = dsh-int-mobile-remote —— profile 的 dependencies 键、bundles 条目、
 *     node_modules 里的联接名、启动图 entries、CSS 标记，全都用它。
 *   · 目录名 = dsh-mobile-remote —— **不动**。仓库里的 `plugin\<目录>` 是个指向
 *     `D:\DSH工作区002\3.dsh-mobile-remote` 的**目录联接**，且已装插件的 `link:` 与
 *     联接都是**写死的绝对路径**，改目录名 = 当场弄坏这个插件（全局规矩）。
 *   合成一个常量就会出现"改包名把路径一起改掉、脚本再也找不到源码"这种静默故障。
 */
const PLUGIN_NAME = "@zjh18477514055/dsh-int-mobile-remote";
const PLUGIN_DIR_NAME = "dsh-mobile-remote";
const PLUGIN_DIR = path.join(ROOT, "plugin", PLUGIN_DIR_NAME);
const CDP_PORT = Number(process.env.DSH_MMR_CDP || 9346);
const FREE_PORT = Number(process.env.DSH_MMR_PORT || 3181);      // 官方界面
const LAN_PORT = Number(process.env.DSH_MMR_LAN || 3182);        // 本插件的局域网服务
const KEEP = process.argv.includes("--keep");
const MARK = "MMR-PROBE-" + Date.now();
const IMG_MARK = "MMR-IMG-PROBE-" + Date.now();

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
function cdpEval(wsUrl, expression, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch { } reject(new Error("CDP 超时")); }, timeoutMs);
    ws.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket 错误")); };
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
/**
 * 在**浏览器级** CDP 上开一个新标签页（`Target.createTarget`）。
 *
 * ★ 为什么不用 HTTP 的 `/json/new`（第一版就是那么写的，实测失败）：
 *   Electron 的远程调试**不实现**那个 HTTP 端点 —— 请求返回的是纯文本
 *   `Could not create new page`（不是 JSON），于是 `res.json()` 抛
 *   `Unexpected token 'C', "Could not "... is not valid JSON`。
 *   症状看着像"我的代码写错了"，其实是**用错了接口**。
 *   浏览器级 CDP（`/json/version` 给的 `webSocketDebuggerUrl`）上的
 *   `Target.createTarget` 才是可移植的做法，Chrome 与 Electron 都认。
 */
function cdpNewTab(browserWsUrl, url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(browserWsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch { } reject(new Error("开标签页超时")); }, timeoutMs);
    ws.onerror = () => { clearTimeout(timer); reject(new Error("浏览器级 WebSocket 错误")); };
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: "Target.createTarget", params: { url },
    }));
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch { }
      if (m.error) return reject(new Error("Target.createTarget: " + JSON.stringify(m.error)));
      resolve(m.result && m.result.targetId);
    };
  });
}

/**
 * 让**已存在的** page target 导航到另一个地址（`Page.navigate`）。
 *
 * ★ 为什么不用"新开一个标签页"（我连试两种写法都失败了，都是实测）：
 *   · HTTP `PUT /json/new?url=…` ⇒ 返回纯文本 `Could not create new page`（不是 JSON）；
 *   · 浏览器级 CDP `Target.createTarget` ⇒ `{"code":-32000,"message":"Not supported"}`。
 *   Electron 的远程调试**两者都不支持**（它只调试自己的窗口，不提供"开新窗口"的能力）。
 *   ⇒ 改成**复用官方界面那个 target**：它在本段之前的断言（启动图、注入 CSS、
 *     悬浮按钮、/state）已经全部跑完了，而本段之后的"磁盘交叉核对"只用 fs、不再用 CDP，
 *     所以把这一页导航走是安全的。
 */
function cdpNavigate(wsUrl, url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch { } reject(new Error("Page.navigate 超时")); }, timeoutMs);
    ws.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket 错误")); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url } }));
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch { }
      if (m.error) return reject(new Error("Page.navigate: " + JSON.stringify(m.error)));
      resolve(m.result || {});
    };
  });
}

async function waitForPage(match, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    try {
      const ts = await listTargets();
      last = ts.filter((t) => t.type === "page");
      for (const t of last) if (match(t)) return t;
    } catch { /* CDP 还没起来 */ }
    await sleep(400);
  }
  throw new Error(`等页面超时（看到 ${last.length} 个: ${last.map((t) => t.url).join(" | ")}）`);
}

// ── 临时环境 ──────────────────────────────────────────────────────
function junction(link, target) {
  if (fs.existsSync(link)) fs.rmSync(link, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const r = spawnSync("cmd", ["/c", "mklink", "/J", link, target], { encoding: "utf8", windowsHide: true });
  if (!fs.existsSync(link)) {
    throw new Error(`建目录联接失败：${link} -> ${target}\n  ${(r.stderr || r.stdout || "").trim()}`);
  }
}

function buildTempHome() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(ROOT, "runtime", "plugin-check-mobile-remote", stamp);
  const userData = path.join(base, "userdata");
  const home = path.join(userData, "dsh-home");
  const profiles = path.join(home, "profiles");
  const web = path.join(profiles, "web");

  const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const realHome = path.join(roaming, "DSH Integrated", "dsh-home");
  const realShared = path.join(realHome, "profiles", "node_modules");
  const realWeb = path.join(realHome, "profiles", "web");
  if (!fs.existsSync(realShared)) throw new Error(`找不到真实内核依赖树（只读借用）：${realShared}`);

  fs.mkdirSync(path.join(web, "node_modules"), { recursive: true });

  // 工作区注册表（界面没有工作区就会停在"选择一个工作区"）
  const wsSrc = path.join(realHome, "storages", "workspace.json");
  if (fs.existsSync(wsSrc)) {
    const dst = path.join(home, "storages");
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(wsSrc, path.join(dst, "workspace.json"));
  }

  // 只借用内核依赖树（联接，只读使用）
  junction(path.join(profiles, "node_modules"), realShared);

  // 镜像真实 bundle 清单（这样验的是用户实际那套），但**排除本插件自己**
  // —— 否则会从真实环境联接到旧副本上去
  let bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
  const mirrored = [];
  try {
    const real = JSON.parse(fs.readFileSync(path.join(realWeb, "package.json"), "utf8"));
    const list = (((real.dsh || {}).profile) || {}).bundles;
    if (Array.isArray(list) && list.length) {
      bundles = list.filter((n) => n !== PLUGIN_NAME);
      for (const name of bundles) {
        if (name.startsWith("@deepseek-ai/")) continue;
        const src = path.join(realWeb, "node_modules", ...name.split("/"));
        if (!fs.existsSync(src)) continue;
        junction(path.join(web, "node_modules", ...name.split("/")), src);
        mirrored.push(name);
      }
      const rp = path.join(realWeb, "cordis.patch.yml");
      if (fs.existsSync(rp)) fs.copyFileSync(rp, path.join(web, "cordis.patch.yml"));
    }
  } catch (e) {
    console.log(`  ⚠ 镜像真实 bundle 清单失败（${e.message}），退回最小清单`);
  }

  if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME);
  fs.writeFileSync(path.join(web, "cordis.yml"), "[]\n", "utf8");
  fs.writeFileSync(path.join(web, "package.json"), JSON.stringify({
    name: "dsh-profile-web",
    private: true,
    dsh: { profile: { bundles, patchReload: "live" } },
  }, null, 2) + "\n", "utf8");

  // 本插件：目录联接 ⇒ 跑的就是仓库里那份源码
  junction(path.join(web, "node_modules", PLUGIN_NAME), PLUGIN_DIR);

  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    closeToTray: false,
    port: FREE_PORT,
    profile: "web",
    workspace: ROOT,
  }, null, 2), "utf8");

  return { base, userData, home, web, bundles, mirrored };
}

function launch(userData) {
  const electronExe = path.join(ROOT, "node_modules", "electron", "dist",
    process.platform === "win32" ? "electron.exe" : "electron");
  if (!fs.existsSync(electronExe)) throw new Error(`找不到 Electron: ${electronExe}`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;              // 不删的话 Electron 退化成纯 Node
  env.DSH_MOBILE_REMOTE_PORT = String(LAN_PORT); // ★ 不抢真实环境的 3110
  const child = spawn(electronExe, [
    ".", `--user-data-dir=${userData}`, `--remote-debugging-port=${CDP_PORT}`,
  ], { cwd: ROOT, env, stdio: "ignore", windowsHide: false });
  return child;
}

// ── 磁盘交叉核对 ─────────────────────────────────────────────────
function walk(dir, out = [], depth = 0) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 8) walk(p, out, depth + 1); }
    else out.push(p);
  }
  return out;
}
function findMarkerOnDisk(home, marker) {
  const hits = [];
  for (const f of walk(home)) {
    let stat; try { stat = fs.statSync(f); } catch { continue; }
    if (stat.size > 60 * 1024 * 1024) continue;
    let buf; try { buf = fs.readFileSync(f); } catch { continue; }
    if (buf.includes(Buffer.from(marker, "utf8"))) hits.push(f);
  }
  return hits;
}

// ── 局域网接口客户端 ─────────────────────────────────────────────
const LAN = `http://127.0.0.1:${LAN_PORT}`;
async function lan(pathname, opts = {}) {
  const r = await fetch(LAN + pathname, opts);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { }
  return { status: r.status, json, text };
}
function rpc(token, method, params) {
  return lan("/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ method, params: params || {} }),
  });
}

// ── 主流程 ───────────────────────────────────────────────────────
(async () => {
  console.log("\n=== plugin-check-mobile-remote：真跑验证 ===");
  console.log(`  插件源码   : ${PLUGIN_DIR}`);
  console.log(`  官方界面   : 127.0.0.1:${FREE_PORT}   CDP: ${CDP_PORT}`);
  console.log(`  局域网服务 : 127.0.0.1:${LAN_PORT}（刻意不用 3110，避免撞上真实实例）`);

  // ★ 2026-09-22：这份清单必须跟着包内结构走。
  //   插件已经分层成 desktop/（电脑侧宿主+界面）与 phone/（手机页面，由宿主现读磁盘托管），
  //   而这里原来还写着改名前的 `lib/*` 与 `web/*` ⇒ 一进门就报
  //   「插件源码不完整：缺 lib/index.js」，**看起来像插件坏了，其实是清单过时**。
  //   现在按 package.json 的 exports 解析入口，不再写死路径。
  const pkgNow = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "package.json"), "utf8").replace(/^\uFEFF/, ""));
  const entryOf = (k, fallback) => String((pkgNow.exports && pkgNow.exports[k]) || fallback).replace(/^\.\//, "");
  const REQUIRED = [
    entryOf(".", "desktop/index.js"),        // 宿主半边（exports["."] 是真值）
    entryOf("./client", "desktop/client.js"),
    "desktop/qr.cjs",
    "cordis.patch.yml",
    "package.json",
    "phone/index.html",
    "phone/app.js",
  ];
  for (const f of REQUIRED) {
    if (!fs.existsSync(path.join(PLUGIN_DIR, f))) throw new Error(`插件源码不完整：缺 ${f}`);
  }

  // ── ⓪ 语法自检：**在启动内核之前**先确认两个半边能被真正解析 ──
  //
  // ★★ 为什么必须有这一步（2026-09-22 实测踩坑，代价是两轮 8 分钟的验证）：
  //   我编辑 desktop/index.js 时在一段块注释里写了一个**不配对的反引号**，
  //   于是 `*/` 提前闭合、后面的注释行变成了裸代码 ⇒ 内核 **import 该模块时
  //   直接 SyntaxError**，整个内核起不来，而脚本只在最后报一句
  //   「等页面超时（看到 1 个: status-page.html）」——**症状离真因十万八千里**。
  //   更坑的是我当时用的自检方式本身在骗人：
  //     `node --input-type=module --eval "await import(...)"` → 打印 "语法 OK"
  //   因为那种写法把加载失败吞掉了。**只有 `node --check` 与真实 `import` 可信。**
  //   ⇒ 把这两条做成启动前的硬门槛，失败就立刻停，不再浪费一整轮内核启动。
  {
    const halves = [
      entryOf(".", "desktop/index.js"),
      entryOf("./client", "desktop/client.js"),
      "phone/app.js",
    ];
    for (const rel of halves) {
      const abs = path.join(PLUGIN_DIR, rel);
      if (!fs.existsSync(abs)) continue;
      // ① 词法/语法检查（--check 对 ESM 与经典脚本都有效）
      const r = spawnSync(process.execPath, ["--check", abs], { encoding: "utf8", windowsHide: true });
      check(`语法检查通过：${rel}`, r.status === 0,
        r.status === 0 ? "node --check OK" : String(r.stderr || "").split("\n").slice(0, 3).join(" | "));
      // ② 宿主半边还要能**真正被 import**（--check 过不了模块解析，真实加载才作数）
      if (/desktop[\\/]index\.js$/.test(rel)) {
        const url = require("node:url").pathToFileURL(abs).href;
        const probe = spawnSync(process.execPath, [
          "-e",
          `import(${JSON.stringify(url)}).then(m=>{if(typeof m.apply!=="function"){console.error("no apply export");process.exit(2)};process.exit(0)},e=>{console.error(String(e&&e.message||e));process.exit(1)})`,
        ], { encoding: "utf8", windowsHide: true });
        check(`宿主半边能被真实 import（exports.apply 是函数）：${rel}`, probe.status === 0,
          probe.status === 0 ? "import OK" : String(probe.stderr || "").trim().slice(0, 200));
      }
    }
  }

  const env = buildTempHome();
  console.log(`  临时家     : ${env.home}`);
  console.log(`  bundles(${env.bundles.length}) : ${env.bundles.join(", ")}`);
  if (env.mirrored.length) console.log(`  从真实环境联接过来的第三方插件: ${env.mirrored.join(", ")}`);
  console.log("");

  const child = launch(env.userData);
  let target = null;

  try {
    target = await waitForPage((t) => new RegExp(`127\\.0\\.0\\.1:${FREE_PORT}`).test(t.url), 120000);
    console.log(`  已连上官方界面: ${target.url}\n`);
    const ws = target.webSocketDebuggerUrl;
    await sleep(5000);   // 等客户端插件全部物化完

    // ── ① 结构 ──
    console.log("── ① 结构：宿主有没有把插件公告进启动图 ──");
    const raw = await cdpEval(ws, `JSON.stringify(((window.__DSH_BOOT__||{}).entries||[]).map(e=>e.id))`);
    let ids = [];
    try { ids = JSON.parse(raw); } catch { }
    check(`启动图 entries 里有 ${PLUGIN_NAME}`, ids.includes(PLUGIN_NAME),
      `共 ${ids.length} 条；末 5 条: ${ids.slice(-5).join(", ")}`);

    // ── ② 动态：apply 真的跑了 ──
    console.log("\n── ② 动态：插件的 apply() 有没有真的跑 ──");
    const cssOk = await cdpEval(ws, `!!document.querySelector('style[data-plugin-css="${PLUGIN_NAME}/styles.css"]')`);
    check("页面里出现了插件注入的 <style data-plugin-css>", cssOk === true,
      "只有 apply() 执行到 installCss 才会出现（bundle 被下载不会）");

    const hookRaw = await cdpEval(ws, `JSON.stringify(window.__dshMobileRemote ? {
      plugin: window.__dshMobileRemote.plugin,
      slots: window.__dshMobileRemote.diagnostics.slots,
      errors: window.__dshMobileRemote.diagnostics.errors
    } : null)`);
    const hook = hookRaw ? JSON.parse(hookRaw) : null;
    check("插件暴露了调试钩子 window.__dshMobileRemote（apply 跑到最后）", hook !== null,
      hook ? JSON.stringify(hook.slots) : "没有这个全局对象 ⇒ apply() 中途抛错了");
    if (hook) {
      check("槽位注册无错误", (hook.errors || []).length === 0, (hook.errors || []).join(" | ") || "ok");
    }

    // 悬浮按钮真的渲染出来了吗（用 elementFromPoint 判"看得见"，不信矩形）
    const fabSeen = await (async () => {
      const deadline = Date.now() + 45000;
      for (;;) {
        const ok = await cdpEval(ws, `(() => {
          const b = document.querySelector('.mmr-fab');
          if (!b) return 'no-fab';
          const r = b.getBoundingClientRect();
          const el = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
          const hit = el === b || (el && b.contains(el));
          return JSON.stringify({ found: true, visible: hit, topEl: el ? (el.className||el.tagName) : null, r: [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)] });
        })()`);
        if (ok !== 'no-fab') return JSON.parse(ok);
        if (Date.now() > deadline) return null;
        await sleep(600);
      }
    })();
    check("右下角出现了「📱」悬浮按钮", !!fabSeen && fabSeen.found === true,
      fabSeen ? `rect=${JSON.stringify(fabSeen.r)}` : "等 45 秒也没出现");
    check("悬浮按钮真的在屏幕最上层（elementFromPoint 命中它自己）",
      !!fabSeen && fabSeen.visible === true,
      fabSeen ? `命中 ${fabSeen.topEl}` : "没拿到");

    // ── ②+ 点开弹窗，看二维码是不是真的画出来了 ──
    console.log("\n── ②+ 交互：点开弹窗 → 二维码与配对码 ──");
    await cdpEval(ws, `document.querySelector('.mmr-fab').click(), true`);
    await sleep(1200);
    const panelRaw = await cdpEval(ws, `(() => {
      const p = document.querySelector('.mmr-panel');
      const svg = document.querySelector('.mmr-qr svg');
      const code = document.querySelector('.mmr-code');
      return JSON.stringify({
        panel: !!p,
        svg: !!svg,
        svgRects: svg ? svg.querySelectorAll('path,rect').length : 0,
        code: code ? code.textContent : null
      });
    })()`);
    const panel = JSON.parse(panelRaw);
    check("弹窗渲染出来了（.mmr-panel）", panel.panel === true, panelRaw);
    check("弹窗里有二维码 SVG", panel.svg === true && panel.svgRects > 0, `图形节点 ${panel.svgRects} 个`);
    check("弹窗里显示了 8 位配对码", typeof panel.code === 'string' && panel.code.length === 8, `「${panel.code}」`);
    // 关掉弹窗，避免挡住后面的断言
    await cdpEval(ws, `(document.querySelector('.mmr-x')||{click(){}}).click(), true`);
    await sleep(300);

    // ── ③ 端到端：真 HTTP 走完配对 → 列会话 → 建会话 → 发消息 → 中断 ──
    console.log("\n── ③ 端到端：局域网 HTTP 接口（真网络请求）──");

    // 手机端页面能不能取到
    const page = await lan("/");
    check("手机端页面可访问（GET /）", page.status === 200 && /手机遥控/.test(page.text),
      `HTTP ${page.status}, ${page.text.length} 字节`);
    const appJs = await lan("/app.js");
    check("手机端脚本可访问（GET /app.js）", appJs.status === 200 && appJs.text.length > 1000, `${appJs.text.length} 字节`);

    // 未配对必须被拒
    const noAuth = await rpc("bogus-token", "session.list");
    check("未配对请求被拒（401）", noAuth.status === 401, `HTTP ${noAuth.status} ${noAuth.json && noAuth.json.error}`);

    // 从官方界面拿到当前配对码（这就是用户扫码时看到的那个码）
    const stateRaw = await cdpEval(ws, `fetch('/dsh-int-mobile-remote/state').then(r=>r.json()).then(j=>JSON.stringify(j.data))`);
    const st = JSON.parse(stateRaw);
    check("同源路由 /state 可用，且带二维码与配对码",
      !!(st && st.qrSvg && st.code), `code=${st && st.code}, qrSvg=${st && st.qrSvg.length} 字节`);
    check("二维码内容是可扫的 URL（而不是裸码）",
      typeof st.url === 'string' && /^http:\/\/.+:\d+\/pair\?c=/.test(st.url), st.url);

    // 错码必须被拒
    const badPair = await lan("/api/pair/submit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "WRONGCOD" }),
    });
    check("错误的配对码被拒", badPair.status === 400, `HTTP ${badPair.status}`);

    // 真配对
    const goodPair = await lan("/api/pair/submit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: st.code, deviceName: "plugin-check" }),
    });
    const token = goodPair.json && goodPair.json.token;
    check("用正确配对码换到 token", goodPair.status === 200 && !!token, `token 长度 ${token ? token.length : 0}`);

    // 一次性：同一个码不能用第二次
    const reuse = await lan("/api/pair/submit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: st.code }),
    });
    check("同一个配对码不能重复使用（一次性）", reuse.status === 400, `HTTP ${reuse.status}`);

    // 列会话
    const list = await rpc(token, "session.list");
    check("已配对后能列会话", list.status === 200 && list.json && list.json.ok === true,
      list.status === 200 ? `会话数 ${((list.json.result||{}).items||[]).length}` : JSON.stringify(list.json));

    // 建一个新会话（建在临时家里，不碰用户会话）
    const created = await rpc(token, "session.create", { cwd: ROOT });
    const sid = created.json && created.json.result && created.json.result.sessionId;
    check("能新建会话", created.status === 200 && !!sid, `sessionId=${sid}`);

    // 跟随（开 SSE 之前先让 watch 建立订阅）
    if (sid) {
      const watch = await rpc(token, "session.watch", { sessionId: sid });
      check("能订阅会话事件流", watch.status === 200 && watch.json.ok === true, JSON.stringify(watch.json && watch.json.result));

      // 真发一条提示词
      const sent = await rpc(token, "session.prompt", { sessionId: sid, text: MARK });
      check("能发消息（提示词被受理）", sent.status === 200 && sent.json.ok === true,
        JSON.stringify(sent.json && (sent.json.result || sent.json.message)));

      // 真中断
      await sleep(1500);
      const cancel = await rpc(token, "session.cancel", { sessionId: sid });
      check("能中断当前任务", cancel.status === 200 && cancel.json.ok === true,
        JSON.stringify(cancel.json && (cancel.json.result || cancel.json.message)));
    }

    // ── ③+ 这一版新增的能力（界面四条痛点的后端） ──
    console.log("\n── ③+ 新增能力：工作区 / 标题 / 模型 / 审批 ──");

    const wsList = await rpc(token, "workspace.list");
    const wsItems = (wsList.json && wsList.json.result && wsList.json.result.items) || [];
    check("能列工作区（新建会话要选）", wsList.status === 200 && Array.isArray(wsItems),
      `${wsItems.length} 个：${wsItems.slice(0, 3).map((w) => w.title).join(", ")}`);

    const cat = await rpc(token, "modelCatalog");
    const groups = (cat.json && cat.json.result && cat.json.result.groups) || [];
    const modelCount = groups.reduce((n, g) => n + ((g.models || []).length), 0);
    check("能拿模型目录（切模型要用）", cat.status === 200 && modelCount > 0,
      `${groups.length} 个来源 / ${modelCount} 个模型`);

    // 标题：新建的会话应该能读到标题（或至少接口不报错）
    if (sid) {
      const t = await rpc(token, "session.titles", { sessionIds: [sid] });
      check("能批量读会话标题", t.status === 200 && t.json.ok === true,
        `返回 titles 键 ${Object.keys((t.json.result || {}).titles || {}).length} 个（新会话可能还没生成标题，属正常）`);

      // 切模型：挑目录里第一个带 provider 的
      const g0 = groups.find((g) => (g.models || []).length);
      if (g0) {
        const m0 = g0.models[0];
        const sel = await rpc(token, "session.selectModel", {
          sessionId: sid, provider: g0.id, model: m0.id,
        });
        check("能给会话切模型", sel.status === 200 && sel.json.ok === true,
          sel.status === 200 ? `选中 ${JSON.stringify((sel.json.result || {}).selected)}` : JSON.stringify(sel.json));
      }

      // 发图片：base64 直传，宿主应把它提升成持久附件。
      // ★ 这张 1×1 PNG 是**用 sharp 现生成**的（`create` → `png()`），不是从网上抄的
      //   常量。第一版这里贴了一个流传很广的 1×1 base64，它的 IDAT 其实是坏的：
      //   sharp 能读出 metadata（只看文件头），但**完整解码会失败**
      //   （`vipspng: libpng read error`）⇒ 内核报 `Unsupported or malformed image data.`。
      //   当时的 FAIL 是**我的测试夹具坏了**，不是插件的问题 —— 换掉夹具后即通过。
      const px = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC";
      const imgSent = await rpc(token, "session.prompt", {
        sessionId: sid,
        text: IMG_MARK,
        images: [{ mediaType: "image/png", data: px, name: "probe.png" }],
      });
      check("能发图片（base64 直传）", imgSent.status === 200 && imgSent.json.ok === true,
        JSON.stringify(imgSent.json && (imgSent.json.result || imgSent.json.message)));

      // 审批：手机回答一个不存在的 id，必须被明确拒绝（不是静默成功）
      const apBad = await rpc(token, "approval.answer", { id: "ap-does-not-exist", approve: true });
      check("回答不存在的审批会被明确拒绝", apBad.status === 500,
        `HTTP ${apBad.status} ${apBad.json && apBad.json.message}`);
    }

    // ── ③++ 2026-09-22 新增的「＋」里那几项（权限 / 上下文 / 指令 / 文件 / 加 API）──
    //
    // ★ 为什么每条都要"真调一次"：这几项全是**官方服务的包装**，
    //   服务名写错（如 sessionFileReferences 写成 fileReferences）、
    //   参数顺序写错（agent 与 query 谁在前）、字段名写错，
    //   在"文件存在/代码里有"这个层面**完全看不出来**，只有真调才会暴露。
    //   （历史教训：本仓库两次栽在"度量方式/证据层级"上，见 AGENTS.md 高风险纪律第二条。）
    console.log("\n── ③++ 新增能力：权限 / 上下文 / 指令 / 文件 / 加 API ──");

    if (sid) {
      // 权限：读要能列出档位，写要能真的切（切完再读必须变）
      const perm = await rpc(token, "permission.list", { sessionId: sid });
      const pOpts = (perm.json && perm.json.result && perm.json.result.options) || [];
      check("能列权限档位（官方 permissionPresets）",
        perm.status === 200 && pOpts.length > 0,
        `当前=${perm.json && perm.json.result && perm.json.result.current}，档位=${pOpts.map((o) => o.value).join("/")}`);
      if (pOpts.length) {
        // 挑一个**不是当前**的档位来切（避免"切到原值"这种假通过）
        const cur = perm.json.result.current;
        const target = pOpts.map((o) => o.value).filter((v) => v !== cur && v !== "custom")[0];
        if (target) {
          const setp = await rpc(token, "permission.set", { sessionId: sid, preset: target });
          const after = await rpc(token, "permission.list", { sessionId: sid });
          const nowCur = after.json && after.json.result && after.json.result.current;
          check("能切权限档位，且回读确实变了",
            setp.status === 200 && nowCur === target,
            `${cur} → ${nowCur}（期望 ${target}）`);
          // 切回去，别把临时会话留在危险档上
          if (cur) await rpc(token, "permission.set", { sessionId: sid, preset: cur });
        }
      }
      // 非法档位必须被拒（不是静默接受）
      const permBad = await rpc(token, "permission.set", { sessionId: sid, preset: "no-such-preset" });
      check("非法权限档位被拒", permBad.status === 500, `HTTP ${permBad.status}`);

      // 上下文容量：发过消息后应该有数字；字段名与官方投影一致
      const ctxu = await rpc(token, "context.usage", { sessionId: sid });
      const cu = (ctxu.json && ctxu.json.result) || {};
      check("能读上下文容量（官方 contextPressure 投影）",
        ctxu.status === 200 && (cu.contextWindow != null || cu.usedTokens != null),
        `used=${cu.usedTokens} window=${cu.contextWindow} pct=${cu.percent}%`);

      // 当前模型与推理强度（2026-09-22 用户需求）
      // ★ 必须在**上面切过模型之后**跑才有意义：那段已经切过一次，
      //   所以 lastUsed 或 next 至少该有一个有值。两个都空 ⇒ 投影没接上。
      const mdl = await rpc(token, "session.model", { sessionId: sid });
      const mv = (mdl.json && mdl.json.result) || {};
      const eff = mv.effective || {};
      check("能读当前模型与推理强度（官方 modelSelection 投影）",
        mdl.status === 200 && !!mv.effective && !!eff.model,
        `provider=${eff.provider} model=${eff.model} effort=${eff.reasoningEffort}`
        + `（lastUsed=${mv.lastUsed ? mv.lastUsed.model : "null"} next=${mv.next ? mv.next.model : "null"} pending=${mv.pending}）`);

      // 指令目录：官方 commands 注册表
      const cmds = await rpc(token, "command.list", { sessionId: sid });
      const cmdItems = (cmds.json && cmds.json.result && cmds.json.result.items) || [];
      check("能列斜杠命令（官方 commands 注册表）",
        cmds.status === 200 && cmdItems.length > 0,
        `${cmdItems.length} 条：${cmdItems.slice(0, 5).map((c) => "/" + c.name).join(" ")}`);

      // 文件浏览：**逐层**浏览是这套设计的关键，所以既验根目录、也验进子目录
      const fl = await rpc(token, "file.list", { sessionId: sid, path: "" });
      const fItems = (fl.json && fl.json.result && fl.json.result.items) || [];
      check("能列工作区文件（官方 fileReferences，空串=根）",
        fl.status === 200 && fItems.length > 0,
        `${fItems.length} 项，前几个：${fItems.slice(0, 4).map((i) => i.name).join(", ")}`);
      check("返回项带 kind 与 @提及文本（手机端要靠它拼引用）",
        fItems.length > 0 && fItems.every((i) => (i.kind === "file" || i.kind === "directory") && typeof i.mention === "string"),
        fItems.length ? `例：${fItems[0].name} → ${fItems[0].mention}` : "(无项)");

      // 找一个真目录钻进去 —— 这才是"手机上能选电脑文件夹"的实质证据
      const dirItem = fItems.find((i) => i.kind === "directory");
      if (dirItem) {
        const sub = await rpc(token, "file.list", { sessionId: sid, path: dirItem.path });
        const sItems = (sub.json && sub.json.result && sub.json.result.items) || [];
        const back = sub.json && sub.json.result && sub.json.result.parent;
        check("能钻进子目录（逐层浏览成立）",
          sub.status === 200 && Array.isArray(sItems) && typeof back === "string",
          `进 ${dirItem.path}/ 得 ${sItems.length} 项，parent="${back}"`);
      } else {
        console.log("  SKIP  钻进子目录（根目录下没有子目录）");
      }

      // 读文件字节：挑一个真文件读，拿到的 base64 必须能解回字节
      const fileItem = fItems.find((i) => i.kind === "file");
      if (fileItem) {
        const fr = await rpc(token, "file.read", { sessionId: sid, path: fileItem.path });
        const fd = fr.json && fr.json.result && fr.json.result.data;
        let decodedOk = false, nBytes = 0;
        try { const b = Buffer.from(String(fd || ""), "base64"); decodedOk = b.length > 0; nBytes = b.length; } catch { }
        check("能读电脑文件字节（官方 workspaceFiles.readAll，base64）",
          fr.status === 200 && decodedOk,
          `${fileItem.path} → ${nBytes} 字节`);
      } else {
        console.log("  SKIP  读文件字节（根目录下没有文件）");
      }

      /* ══════════════════════════════════════════════════════════════
       * 文件互传（2026-09-22）：**电脑 → 手机** 与 **手机 → 电脑** 两条真通路
       * ══════════════════════════════════════════════════════════════
       * ★ 这里刻意**不测 RPC 的返回值**，而是真的把字节搬一遍：
       *   · 下载：走 `/api/file/dl?t=<票据>` 把字节读回来，**逐字节比对** sha256；
       *   · 上传：走 `/api/file/ul` 真写一个文件进工作区，再**去磁盘上读回来**比对。
       *   "RPC 返回 ok:true" 只证明宿主愿意回答，不证明字节真的过去了。
       *   这是本项目验证纪律的第 2 条（必须真让它工作）。 */

      // ── ① 下载：先签票，再用票把字节拉回来 ──
      const dlSrc = path.join(ROOT, "scripts", "plugin-check-mobile-remote.js");
      const dlSrcHash = crypto.createHash("sha256").update(fs.readFileSync(dlSrc)).digest("hex");
      const dlTicket = await rpc(token, "file.download", { sessionId: sid, path: dlSrc });
      const tk = dlTicket.json && dlTicket.json.result;
      check("能签下载票据（file.download 只回 URL，不回字节）",
        dlTicket.status === 200 && !!(tk && tk.url && /^\/api\/file\/dl\?t=/.test(tk.url)),
        tk ? `${tk.name} ${tk.bytes} 字节 → ${tk.url.slice(0, 34)}…` : JSON.stringify(dlTicket.json));

      if (tk && tk.url) {
        // ★ token 走查询参数（系统下载器加不了 Authorization 头）—— 这本身也要验
        const got = await fetch(`${LAN}${tk.url}&token=${encodeURIComponent(token)}`);
        const buf = Buffer.from(await got.arrayBuffer());
        const gotHash = crypto.createHash("sha256").update(buf).digest("hex");
        check("下载回来的字节与原文件 sha256 完全一致（真搬了字节）",
          got.status === 200 && gotHash === dlSrcHash,
          `${buf.length} 字节, ${gotHash.slice(0, 16)}… vs ${dlSrcHash.slice(0, 16)}…`);
        check("下载响应带 content-disposition（手机端据此命名文件）",
          /attachment/i.test(got.headers.get("content-disposition") || ""),
          got.headers.get("content-disposition") || "(无)");

        // 票据一次性：同一张票再拉一次必须 404
        const again = await fetch(`${LAN}${tk.url}&token=${encodeURIComponent(token)}`);
        check("下载票据是一次性的（用过即焚）", again.status === 404, `HTTP ${again.status}`);
      }

      // 无票 / 假票必须被拒（否则就是"凭 token 读任意文件"的通用接口）
      const noTicket = await fetch(`${LAN}/api/file/dl?t=deadbeef&token=${encodeURIComponent(token)}`);
      check("伪造票据被拒（下载不能直接带路径）", noTicket.status === 404, `HTTP ${noTicket.status}`);

      // ── ② 上传：真把字节写进工作区，再去磁盘读回来比对 ──
      const upText = "dsh-mmr-upload-probe-" + Date.now() + "\n中文也要能原样落盘\n";
      const upBuf = Buffer.from(upText, "utf8");
      const upUrl = `${LAN}/api/file/ul?sessionId=${encodeURIComponent(sid)}`
        + `&path=${encodeURIComponent("mmr-probe")}&name=${encodeURIComponent("probe 空格.txt")}`;
      const upRes = await fetch(upUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", authorization: "Bearer " + token },
        body: upBuf,
      });
      const upJson = await upRes.json().catch(() => null);
      const landed = upJson && upJson.absolutePath;
      let onDisk = null;
      try { onDisk = landed ? fs.readFileSync(landed, "utf8") : null; } catch { }
      check("上传的字节真的落到电脑磁盘上（读回来逐字比对）",
        upRes.status === 200 && onDisk === upText,
        landed ? `${landed} → ${onDisk === upText ? "内容一致" : "内容不一致！"}` : JSON.stringify(upJson));
      check("上传返回 @提及文本（手机端可直接引用）",
        !!(upJson && typeof upJson.mention === "string" && upJson.mention.startsWith("@")),
        upJson ? upJson.mention : "(无)");
      check("含空格的路径被正确转义成 @\"…\"（官方提及语法）",
        !!(upJson && /^@".*"$/.test(upJson.mention)),
        upJson ? upJson.mention : "(无)");
      check("重名不覆盖：同名再传一次会改名",
        await (async () => {
          const r2 = await fetch(upUrl, {
            method: "POST",
            headers: { "content-type": "application/octet-stream", authorization: "Bearer " + token },
            body: upBuf,
          });
          const j2 = await r2.json().catch(() => null);
          return r2.status === 200 && j2 && j2.renamed === true && j2.name !== "probe 空格.txt";
        })(),
        "第二个文件拿到了新名字");

      // 越界必须被拒 —— 这是落盘方向唯一的安全边界，必须真撞一次
      const escape = await fetch(`${LAN}/api/file/ul?sessionId=${encodeURIComponent(sid)}`
        + `&path=${encodeURIComponent("../../../../Windows/Temp")}&name=x.txt`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", authorization: "Bearer " + token },
        body: Buffer.from("nope"),
      });
      check("越出工作区的上传被拒（.. 逃逸）", escape.status === 403, `HTTP ${escape.status}`);

      // 未配对 / 错 token 必须被拒（两条通路都要，别只守 RPC）
      const dlNoAuth = await fetch(`${LAN}/api/file/dl?t=whatever`);
      const ulNoAuth = await fetch(`${LAN}/api/file/ul?sessionId=x&name=y`, { method: "POST", body: "z" });
      check("下载/上传都要求 token（未配对一律 401）",
        dlNoAuth.status === 401 && ulNoAuth.status === 401,
        `dl=${dlNoAuth.status} ul=${ulNoAuth.status}`);

      // 上传落点信息（手机端选文件**之前**要显示"传去哪儿"）
      const tgt = await rpc(token, "file.uploadTarget", { sessionId: sid });
      check("能问出上传落点（含上限与重名策略）",
        tgt.status === 200 && !!(tgt.json.result && tgt.json.result.absolutePath
          && typeof tgt.json.result.maxBytes === "number" && tgt.json.result.onConflict === "rename"),
        tgt.json.result ? tgt.json.result.absolutePath : JSON.stringify(tgt.json));

      /* ══════════════════════════════════════════════════════════════
       * 跨工作区（2026-09-22 用户需求）
       * ══════════════════════════════════════════════════════════════
       * 用户原话：「我们的整个工作其实已经迁移到第2个工作区了，有没有办法让手机可以
       *   下载三个工作区的文件？以及向三个工作区发送文件。」
       *
       * ★ 这一段要验的是**三件事**，而且第三件最重要：
       *   ① 能列出工作区（官方注册表）；
       *   ② 能**真的**浏览 / 下载别的工作区的文件（字节级核对）；
       *   ③ **不能**访问没注册的目录（否则这道闸等于没有）——
       *      这是"我们比内核更严"的那一层，删了就等于凭 token 读整台机器。
       */
      const wsList = await rpc(token, "workspace.list");
      const wsItems = (wsList.json && wsList.json.result && wsList.json.result.items) || [];
      check("能列出已注册工作区（跨工作区浏览的依据）",
        wsList.status === 200 && wsItems.length > 0,
        `${wsItems.length} 个：${wsItems.map((w) => w.title).join(" / ")}`);

      // 找一个**与本会话不同**的工作区来真测
      const ownRoot = (tgt.json.result && tgt.json.result.workspaceRoot) || "";
      const otherWs = wsItems.find((w) => w.path && w.path.toLowerCase() !== String(ownRoot).toLowerCase());
      if (otherWs) {
        console.log(`     用另一个工作区真测：${otherWs.title} → ${otherWs.path}`);

        // ① 列它的根目录
        const oList = await rpc(token, "file.list", { sessionId: sid, path: "", root: otherWs.path });
        const oItems = (oList.json && oList.json.result && oList.json.result.items) || [];
        check("能列**别的工作区**的根目录（跨工作区浏览成立）",
          oList.status === 200 && oItems.length > 0,
          `${otherWs.title} → ${oItems.length} 项，前几个：${oItems.slice(0, 4).map((i) => i.name).join(", ")}`);
        check("跨工作区时返回里标了 root / isOther（手机端要显示「我在哪」）",
          !!(oList.json.result && oList.json.result.root && oList.json.result.isOther === true),
          oList.json.result ? `root=${oList.json.result.root} isOther=${oList.json.result.isOther}` : "(无)");

        /* ② 跨工作区的提及必须是**绝对路径**。
         *   为什么这条是硬要求：`@` 提及的语义是"相对**本会话**工作区根"
         *   （官方 FILE_REFERENCE_PROMPT 原话），拿别的工作区的相对路径
         *   在当前会话里根本解析不到 ⇒ 模型会去找一个不存在的文件。
         *   实测判据：提及里必须出现那个工作区的绝对路径前缀。 */
        const anyFile = oItems.find((i) => i.kind === "file");
        if (anyFile) {
          check("跨工作区的 @提及 用的是**绝对路径**（相对路径在本会话里解析不到）",
            anyFile.mention.includes(otherWs.path.replace(/\\/g, "\\")) || anyFile.mention.includes(otherWs.path),
            `${anyFile.name} → ${anyFile.mention}`);
        } else {
          console.log("  SKIP  跨工作区提及（那个工作区根目录下没有文件）");
        }

        // ③ 真下载别的工作区的一个文件（字节级核对）
        const oDir = oItems.find((i) => i.kind === "directory");
        let oFileItem = anyFile;
        if (!oFileItem && oDir) {
          const sub2 = await rpc(token, "file.list", { sessionId: sid, path: oDir.path, root: otherWs.path });
          const s2 = (sub2.json && sub2.json.result && sub2.json.result.items) || [];
          oFileItem = s2.find((i) => i.kind === "file");
        }
        if (oFileItem) {
          const tk2 = await rpc(token, "file.download",
            { sessionId: sid, path: oFileItem.path, root: otherWs.path });
          const t2 = tk2.json && tk2.json.result;
          if (t2 && t2.url) {
            const got2 = await fetch(`${LAN}${t2.url}&token=${encodeURIComponent(token)}`);
            const buf2 = Buffer.from(await got2.arrayBuffer());
            const h2 = crypto.createHash("sha256").update(buf2).digest("hex");
            const diskHash = crypto.createHash("sha256")
              .update(fs.readFileSync(t2.absolutePath)).digest("hex");
            check("能**真的下载**别的工作区的文件（sha256 与磁盘一致）",
              got2.status === 200 && h2 === diskHash,
              `${oFileItem.path} → ${buf2.length} 字节, ${h2.slice(0, 16)}…`);
          } else {
            check("能**真的下载**别的工作区的文件（sha256 与磁盘一致）", false,
              JSON.stringify(tk2.json));
          }
        } else {
          console.log("  SKIP  跨工作区下载（那个工作区里找不到文件）");
        }

        // ④ 真上传到别的工作区，再从磁盘读回来
        const probe2 = "dsh-mmr-xws-" + Date.now() + "\n跨工作区上传\n";
        const upUrl2 = `${LAN}/api/file/ul?sessionId=${encodeURIComponent(sid)}`
          + `&root=${encodeURIComponent(otherWs.path)}`
          + `&name=${encodeURIComponent("xws-probe.txt")}`;
        const up2 = await fetch(upUrl2, {
          method: "POST",
          headers: { "content-type": "application/octet-stream", authorization: "Bearer " + token },
          body: Buffer.from(probe2, "utf8"),
        });
        const j2 = await up2.json().catch(() => null);
        let back2 = null;
        try { back2 = j2 && j2.absolutePath ? fs.readFileSync(j2.absolutePath, "utf8") : null; } catch { }
        check("能**真的上传**到别的工作区（落盘后读回来逐字比对）",
          up2.status === 200 && back2 === probe2,
          j2 && j2.absolutePath ? j2.absolutePath : JSON.stringify(j2));
        check("跨工作区上传后提示语标明是绝对路径引用",
          !!(j2 && j2.isOther === true && j2.mention && j2.mention.includes(otherWs.path)),
          j2 ? j2.mention : "(无)");
        // 清理，别在别的工作区留垃圾
        try { if (j2 && j2.absolutePath) fs.unlinkSync(j2.absolutePath); } catch { }
      } else {
        console.log("  SKIP  跨工作区真测（只有一个工作区）");
      }

      /* ⑤ **负向**：没注册的目录必须被拒 —— 这道闸是本插件加的，必须真撞一次。
       *    用 C:\Windows 与用户主目录各试一次（都不是工作区）。 */
      for (const bad of ["C:\\Windows", "C:\\Users"]) {
        const r1 = await rpc(token, "file.list", { sessionId: sid, path: "", root: bad });
        const r2 = await rpc(token, "file.download",
          { sessionId: sid, path: "win.ini", root: bad });
        const up3 = await fetch(`${LAN}/api/file/ul?sessionId=${encodeURIComponent(sid)}`
          + `&root=${encodeURIComponent(bad)}&name=x.txt`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream", authorization: "Bearer " + token },
          body: Buffer.from("nope"),
        });
        check(`未注册的目录被拒：${bad}（浏览/下载/上传三条路都要挡）`,
          r1.status === 500 && r2.status === 500 && up3.status === 403,
          `list=${r1.status} dl=${r2.status} ul=${up3.status}`);
      }

      // 目录不能被下载（必须明确拒绝，而不是给一个 0 字节的"文件"）
      if (dirItem) {
        const dlDir = await rpc(token, "file.download", { sessionId: sid, path: dirItem.path });
        check("目录被拒绝下载（不是给个空文件）",
          dlDir.status === 500 && /目录/.test(String(dlDir.json && dlDir.json.message)),
          dlDir.json && dlDir.json.message);
      }

      /* ★ 收尾：把探针写进工作区的文件**删掉**。
       *   为什么必须删：这个工作区（5.DSH集成桌面端）是**多会话共用的 git 仓库**，
       *   验证脚本往里面丢文件会污染别人的 `git status` —— 而"工作区必须干净"
       *   是发布流程的硬前置。验证脚本**不许留下痕迹**。 */
      try {
        const probeDir = path.join(ROOT, "mmr-probe");
        if (fs.existsSync(probeDir)) fs.rmSync(probeDir, { recursive: true, force: true });
      } catch (e) {
        console.log(`  ⚠ 清理探针目录失败（请手动删 ${path.join(ROOT, "mmr-probe")}）：${e.message}`);
      }
    }

    // 加 API：只验**只读**的两个（列已有通道 / 非法参数被拒）。
    // ★ 为什么不真写一个通道：那会改这台机器的 settings.yaml 与 .credentials.yaml ——
    //   验证脚本绝不该改真实配置。写入路径的正确性由"字段名与官方 schema 一致"
    //   + 手机端两步确认流程保证，且真要用时用户会在电脑上看到结果。
    const provs = await rpc(token, "llm.providers");
    const pv = (provs.json && provs.json.result) || {};
    check("能列已有 API 通道（加 API 页要先显示已有的）",
      provs.status === 200 && Array.isArray(pv.providers) && Array.isArray(pv.protocols),
      `${(pv.providers || []).length} 个通道，协议白名单 ${(pv.protocols || []).join("/")}`);
    const discBad = await rpc(token, "llm.discover", { baseURL: "http://127.0.0.1:1", api: "no-such-api" });
    check("非法协议被拒（探测前先挡住，不写任何东西）",
      discBad.status === 500, `HTTP ${discBad.status} ${discBad.json && discBad.json.message}`);
    const addBad = await rpc(token, "llm.add", { providerId: "Bad_ID", baseURL: "http://x", api: "openai-completions", models: [{ id: "m" }] });
    check("非法通道 ID 被拒（大写/下划线不允许）",
      addBad.status === 500, `HTTP ${addBad.status} ${addBad.json && addBad.json.message}`);
    const addNoModels = await rpc(token, "llm.add", { providerId: "ok-id", baseURL: "http://x", api: "openai-completions", models: [] });
    check("空模型列表被拒（不允许建一个没有模型的通道）",
      addNoModels.status === 500, `HTTP ${addNoModels.status} ${addNoModels.json && addNoModels.json.message}`);

    // ── ④ 手机端**界面**：把"传到电脑"抽屉真开一次（对着**新宿主**）──
    //
    // ★ 为什么这一段必须在这里、而不是只放在 ui-check-mobile 里：
    //   ui-check-mobile 量的是**用户正在跑的那个 3110 实例**，而宿主半边的代码是
    //   内核启动时**快照**的 ⇒ 用户没重启客户端时，那里跑的是旧宿主，
    //   手机端会（按设计）显示"插件是旧版本"的提示，于是那几条断言只能 SKIP。
    //   而本脚本起的是**全新内核**（宿主就是当前源码）⇒ 只有这里能真验到
    //   "新功能在真浏览器里渲染出来"。两条尺子各管一段，缺一不可。
    //   （实测证据：对运行中的 3110 探测，`file.uploadTarget` / `file.download`
    //    返回 `{"error":"unknown_method"}`，而同一个实例的 `file.list` 正常。）
    console.log("\n── ④ 手机端界面：文件互传抽屉（对着新宿主真开一次）──");
    try {
      // 再要一个**新鲜**配对码（上一个已用过即废）；手机页靠 `?c=` 自动配对
      const freshRaw = await cdpEval(ws,
        `fetch('/dsh-int-mobile-remote/state').then(r=>r.json()).then(j=>j.data.code)`);
      const freshCode = String(freshRaw || "");
      if (!freshCode) throw new Error("拿不到新鲜配对码");

      // 让官方界面那一页**导航到手机页**（Electron 不支持开新标签页，见 cdpNavigate 注释）。
      // 这一段之前的断言都跑完了，之后的"磁盘交叉核对"不再用 CDP，所以安全。
      await cdpNavigate(ws, `http://127.0.0.1:${LAN_PORT}/?c=${freshCode}`);
      const pws = ws;   // 还是同一个 target，只是地址变了
      check("能把页面导航到手机端页面（复用同一个 target）", true,
        `→ http://127.0.0.1:${LAN_PORT}/?c=…`);

      // 等就绪：配对完成 + 列表**已渲染**（会话行 或 工作区分组头）
      //   ★ 注意"rows=0"不一定是坏：工作区分组**默认收起**（`renderList` 里
      //     `isCollapsed = (g.name in collapsedWs) ? collapsedWs[g.name] : !(g.running > 0)`），
      //     所以没在跑的组只显示一个组头、`.row` 一个都没有。
      //     判据因此要接受"组头已出现"，然后在下面**真点一下组头**把它展开。
      const readyExpr = `(() => {
        const lv = document.getElementById('listView');
        return JSON.stringify({
          hasPlus: !!document.getElementById('plusBtn'),
          paired: !!(lv && !lv.classList.contains('hidden')),
          rows: document.querySelectorAll('.row').length,
          groups: document.querySelectorAll('.wsgroup-head').length,
          title: document.title,
        });
      })()`;
      let R = null;
      const rd = Date.now() + 45000;
      while (Date.now() < rd) {
        try {
          R = JSON.parse(await cdpEval(pws, readyExpr, 8000));
          if (R.hasPlus && R.paired && (R.rows > 0 || R.groups > 0)) break;
        } catch { }
        await sleep(500);
      }
      check("手机页在真浏览器里配对成功并渲染出会话列表",
        !!(R && R.hasPlus && R.paired && (R.rows > 0 || R.groups > 0)),
        R ? `rows=${R.rows} groups=${R.groups} title="${R.title}"` : "(没就绪)");

      if (R && R.hasPlus && R.paired && (R.rows > 0 || R.groups > 0)) {
        // 先把所有工作区分组展开（默认是收起的），再点第一行进详情页
        // —— `openUploadSheet` 开头是 `if (!current) return`，必须先有当前会话。
        const drawerRaw = await cdpEval(pws, `(async () => {
          // 展开所有分组（组头是 button，点一下切换）
          for (const h of Array.from(document.querySelectorAll('.wsgroup-head'))) h.click();
          await new Promise(r => setTimeout(r, 800));
          const rowsNow = document.querySelectorAll('.row').length;
          const row = document.querySelector('.row');
          if (row) row.click();
          await new Promise(r => setTimeout(r, 2500));
          const inDetail = !document.getElementById('detailView').classList.contains('hidden');
          document.getElementById('plusBtn').click();
          const items = Array.from(document.querySelectorAll('#sheetBody .plus-item'));
          const t = items.find(b => (b.querySelector('.plus-label')||{}).textContent === '传到电脑');
          if (!t) return JSON.stringify({ err: 'no item', inDetail, rowsNow,
            labels: items.map(b=>(b.querySelector('.plus-label')||{}).textContent) });
          t.click();
          await new Promise(r => setTimeout(r, 3500));
          const b2 = document.getElementById('sheetBody');
          return JSON.stringify({
            inDetail, rowsNow,
            title: document.getElementById('sheetTitle').textContent,
            path: (b2.querySelector('.xfer-path')||{}).textContent || '',
            note: (b2.querySelector('.xfer-note')||{}).textContent || '',
            hasSubdir: !!b2.querySelector('.xfer-input'),
            hasPick: !!Array.from(b2.querySelectorAll('.cmd-name')).find(e=>/选择手机上的文件/.test(e.textContent)),
            unsupported: !!b2.querySelector('.warnbox'),
            empty: (b2.querySelector('.empty')||{}).textContent || '',
          });
        })()`, 60000);
        const D = JSON.parse(drawerRaw);
        console.log(`     展开后 ${D.rowsNow} 行，进详情页=${D.inDetail}，抽屉「${D.title}」落点=${D.path || D.empty}`);
        check("「传到电脑」抽屉渲染出电脑上的落点（真浏览器，新宿主）",
          !!D.path, D.path || D.empty || D.err || "(无)");
        check("抽屉里有「选择手机上的文件」与子目录输入",
          D.hasPick === true && D.hasSubdir === true, `选文件=${D.hasPick} 子目录=${D.hasSubdir}`);
        check("抽屉写明重名不覆盖（不静默覆盖用户文件）",
          /重名/.test(D.note || ""), D.note || "(无)");
        check("新宿主下**不该**出现「旧版本」提示", D.unsupported === false,
          D.unsupported ? "出现了 unsupportedBox" : "OK");

        /* ── 跨工作区切换条（2026-09-22 用户需求）──
         * 用户原话：「有没有办法让手机可以下载三个工作区的文件？以及向三个工作区发送文件。」
         * 这里在**真浏览器 + 新宿主**里真点一下别的工作区胶囊，断言**落点真的变了**
         * —— 只断言"胶囊出现了"是不够的（那可能只是个装饰）。 */
        const wsRaw2 = await cdpEval(pws, `(async () => {
          const b2 = document.getElementById('sheetBody');
          const pills = Array.from(b2.querySelectorAll('.wspill'));
          const before = (b2.querySelector('.xfer-path')||{}).textContent || '';
          const other = pills.find(p => !p.classList.contains('on'));
          if (!other) return JSON.stringify({ pills: pills.length,
            labels: pills.map(p=>p.textContent.trim()), switched: false, before });
          other.click();
          await new Promise(r => setTimeout(r, 3000));
          const b3 = document.getElementById('sheetBody');
          return JSON.stringify({
            pills: pills.length, labels: pills.map(p=>p.textContent.trim()),
            switched: true, otherLabel: other.textContent.trim(), before,
            after: (b3.querySelector('.xfer-path')||{}).textContent || '',
            isOtherNote: !!Array.from(b3.querySelectorAll('.xfer-row'))
              .find(e => /别的工作区/.test(e.textContent)),
          });
        })()`, 40000);
        const W2 = JSON.parse(wsRaw2);
        console.log(`     工作区胶囊 ${W2.pills} 颗：${(W2.labels || []).join(" / ")}`);
        console.log(`     点「${W2.otherLabel || "-"}」：${W2.before || "(空)"} → ${W2.after || "(空)"}`);
        check("上传抽屉里有工作区切换条（多个工作区时）",
          (W2.pills || 0) >= 2, `${W2.pills} 颗：${(W2.labels || []).join("、")}`);
        check("点别的工作区胶囊，落点**真的换了**（不是只有高亮变）",
          W2.switched === true && !!W2.after && W2.after !== W2.before,
          `${W2.before || "(空)"} → ${W2.after || "(空)"}`);
      }

      // 收尾：把这一页导航回官方界面（后面万一还有 CDP 断言也不至于踩到手机页）
      try { await cdpNavigate(ws, `http://127.0.0.1:${FREE_PORT}/`); } catch { }
    } catch (e) {
      check("手机端文件互传抽屉（真浏览器）", false, e.message);
    }

    // ── ⑤ 磁盘交叉核对：不信接口的说法，去磁盘找标记文本 ──
    console.log("\n── ④ 磁盘交叉核对：提示词真的落盘了吗 ──");
    let hits = [];
    for (let i = 0; i < 20 && hits.length === 0; i++) {
      hits = findMarkerOnDisk(env.home, MARK);
      if (!hits.length) await sleep(1000);
    }
    check("标记文本出现在临时 DSH_HOME 的磁盘上（提示词真的进了持久日志）",
      hits.length > 0,
      hits.length ? hits.map((f) => path.relative(env.home, f)).join(", ") : "等 20 秒也没找到");

    // 图片那条也要落盘（证明 base64 真的被提升成了附件，而不是被悄悄丢掉）
    let imgHits = [];
    for (let i = 0; i < 20 && imgHits.length === 0; i++) {
      imgHits = findMarkerOnDisk(env.home, IMG_MARK);
      if (!imgHits.length) await sleep(1000);
    }
    check("带图片那条提示词也落盘了（图片没被丢掉）", imgHits.length > 0,
      imgHits.length ? imgHits.map((f) => path.relative(env.home, f)).join(", ") : "等 20 秒也没找到");

    const attachDir = path.join(env.home, "attachments");
    let attachFiles = [];
    try { attachFiles = walk(attachDir); } catch { }
    check("图片字节落到了 attachments/ 下（宿主真的提升了它）", attachFiles.length > 0,
      attachFiles.length ? attachFiles.slice(0, 3).map((f) => path.relative(env.home, f)).join(", ") : "attachments/ 下没有文件");

    const sessDir = path.join(env.home, "sessions");
    let sessFiles = [];
    try { sessFiles = walk(sessDir).filter((f) => /session/.test(f)); } catch { }
    check("临时家的 sessions/ 下真的出现了会话文件", sessFiles.length > 0,
      sessFiles.slice(0, 3).map((f) => path.basename(f)).join(", "));

    console.log("");
  } catch (e) {
    check("验证流程未抛异常", false, e && e.message);
  } finally {
    try { child.kill(); } catch { }
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch { }
    await sleep(1200);
    if (!KEEP) {
      try { fs.rmSync(env.base, { recursive: true, force: true }); } catch (e) {
        console.log(`  · 临时目录没删干净（可手工删）：${env.base}`);
      }
    } else {
      console.log(`  · 临时目录已保留：${env.base}`);
    }
  }

  console.log("");
  if (failures.length) {
    console.log(`结果：${failures.length} 项 FAIL`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log("");
    process.exit(1);
  }
  console.log("结果：全部 PASS\n");
  process.exit(0);
})().catch((e) => {
  console.error("\n启动失败：" + (e && e.stack ? e.stack : e));
  process.exit(2);
});
