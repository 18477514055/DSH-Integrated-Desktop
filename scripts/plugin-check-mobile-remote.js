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
const PLUGIN_NAME = "dsh-int-mobile-remote";
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

    // ── ④ 磁盘交叉核对：不信接口的说法，去磁盘找标记文本 ──
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
