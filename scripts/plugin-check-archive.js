/**
 * plugin-check-archive.js —— 归档管理器插件的**真跑**验证。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么单独写这一个（而不是复用 plugin-check.js）
 * ═══════════════════════════════════════════════════════════════════════════
 * `plugin-check.js` 的断言**针对 dsh-multi-session 写死**（找「多会话」按钮、
 * `.dshms-panel`、`window.__dshMultiSession`）。它对归档管理器一无所知 ——
 * 跑它只能证明"内核没被我拖垮"，**证明不了归档管理器自己挂上了**。
 *
 * 全局规矩第二条：验证必须是**目标行为本身**。
 * 本插件的目标行为 = "侧边栏出现「已归档」，点进去能看到搜索框与日期框"。
 * 所以这里真的：起 Electron（与 plugin-check.js 同一套做法）→ CDP 连真界面 →
 * 在 DOM 里找那一行 → **真的点它** → 看主面板渲染 → **真的 fetch 一次接口**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三层证据
 * ═══════════════════════════════════════════════════════════════════════════
 *   ① 启动图 `window.__DSH_BOOT__.entries` 里有本插件（宿主公告了它）
 *   ② apply() 真的跑了（插件自己的 <style> 出现 + `window.__dshArchiveManager` 存在）
 *   ③ 界面上真的有「已归档」这一行，**点得动**，点完主面板渲染出搜索框/日期框，
 *      并且 HTTP 接口真的通
 *
 * ⚠ 全部在**临时 DSH 家**里跑（--user-data-dir 指向临时目录），真实环境不碰。
 *
 * 用法：node scripts/plugin-check-archive.js [--keep] [--minimal]
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PLUGIN_NAME = "@zjh18477514055/dsh-int-archive-manager";
/** ★ 目录名**不动**（2026-09-22 改名）：仓库里 `plugin\<目录>` 是指向
 *  `D:\DSH工作区002\2.归档管理器` 的目录联接，而已装插件的 link: 与 node_modules
 *  联接都是**写死的绝对路径** ⇒ 改目录名就当场弄坏这个插件。
 *  包名与目录名必须分成两个常量，否则会出现"改包名把源码路径一起改掉"的静默故障。 */
const PLUGIN_DIR_NAME = "dsh-archive-manager";
const CSS_ID = PLUGIN_NAME + "/archive-manager.css";
const KEEP = process.argv.includes("--keep");
const CDP_PORT = 9355;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name + (detail ? "  — " + detail : "")); }
  else { fail++; failures.push(name + (detail ? " — " + detail : "")); console.log("  FAIL  " + name + (detail ? " — " + detail : "")); }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

/** 建目录联接（照抄 plugin-check.js：cmd mklink /J）。 */
function junction(link, target) {
  if (fs.existsSync(link)) fs.rmSync(link, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const r = spawnSync("cmd", ["/c", "mklink", "/J", link, target], { encoding: "utf8", windowsHide: true });
  if (!fs.existsSync(link)) {
    throw new Error(`建目录联接失败：${link} -> ${target}\n  ${(r.stderr || r.stdout || "").trim()}`);
  }
}

/**
 * 搭临时家 —— **必须自己搭，不能只传 --user-data-dir**。
 *
 * ★ 这是我第一版踩的坑：只给 Electron 传了 `--user-data-dir`，
 *   结果那个临时家是**全新的 profile**，里面根本没有 `dsh-archive-manager`
 *   （真实 profile 的 bundles 不会自动跟过去）⇒ 启动图 53 条里没有它，
 *   13 条断言里 11 条红。**但那不是插件的问题，是我的验证环境搭错了。**
 *
 * 正确做法照抄 plugin-check.js 的 buildTempHome()：
 *   ① 拷工作区注册表（界面没工作区就会停在"选择工作区"，后面全做不下去）
 *   ② 联接共享依赖树（只读借用真实内核的 node_modules）
 *   ③ 镜像真实 profile 的 **bundles 清单**（我的插件就在这一份里）
 *   ④ 把本插件目录联接进去
 *   ⑤ 写外壳 settings.json（端口 / profile / workspace）
 */
function buildTempHome(base, port) {
  const userData = path.join(base, "userdata");
  const home = path.join(userData, "dsh-home");
  const profiles = path.join(home, "profiles");
  const web = path.join(profiles, "web");

  const roaming = process.env.APPDATA || "";
  const realHome = path.join(roaming, "DSH Integrated", "dsh-home");
  const realShared = path.join(realHome, "profiles", "node_modules");
  const realWeb = path.join(realHome, "profiles", "web");
  if (!fs.existsSync(realShared)) throw new Error("找不到真实内核依赖树：" + realShared);

  fs.mkdirSync(path.join(web, "node_modules"), { recursive: true });

  // ① 工作区注册表
  const wsSrc = path.join(realHome, "storages", "workspace.json");
  if (fs.existsSync(wsSrc)) {
    const dst = path.join(home, "storages");
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(wsSrc, path.join(dst, "workspace.json"));
  }

  // ② 共享依赖树（只读）
  junction(path.join(profiles, "node_modules"), realShared);

  // ③ 镜像真实 bundles
  let bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
  let mirrored = [];
  try {
    const real = JSON.parse(fs.readFileSync(path.join(realWeb, "package.json"), "utf8"));
    const list = (((real.dsh || {}).profile) || {}).bundles;
    if (Array.isArray(list) && list.length) {
      bundles = list.slice();
      for (const name of list) {
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
    console.log("  ⚠ 镜像真实 bundles 失败：" + e.message + "，退回最小清单");
  }

  if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME);

  fs.writeFileSync(path.join(web, "cordis.yml"), "[]\n", "utf8");
  fs.writeFileSync(path.join(web, "package.json"), JSON.stringify({
    name: "dsh-profile-web",
    private: true,
    dsh: { profile: { bundles, patchReload: "live" } },
  }, null, 2) + "\n", "utf8");

  // ④ 本插件联接进去
  junction(path.join(web, "node_modules", PLUGIN_NAME), path.join(ROOT, "plugin", PLUGIN_DIR_NAME));

  // ⑤ 外壳设置
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    closeToTray: false,
    port,
    profile: "web",
    workspace: ROOT,
  }, null, 2), "utf8");

  return { userData, home, web, bundles, mirrored };
}

/** CDP 上跑一段 JS（照抄 plugin-check.js 的做法：WebSocket + Runtime.evaluate）。 */
function cdpEval(wsUrl, expression, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("CDP 超时")); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: id++, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.id === 1) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve(m.result && m.result.result ? m.result.result.value : null);
        }
      } catch { /* 忽略非目标消息 */ }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP 连接失败")); };
  });
}

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* 还没好 */ }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return null;
}

async function main() {
  const electronExe = path.join(ROOT, "node_modules", "electron", "dist",
    process.platform === "win32" ? "electron.exe" : "electron");
  if (!fs.existsSync(electronExe)) { console.error("找不到 Electron: " + electronExe); process.exit(2); }

  const port = await freePort();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(ROOT, "runtime", "plugin-check-archive", stamp);
  const { userData, home: tempHome, bundles, mirrored } = buildTempHome(runDir, port);

  console.log("=== plugin-check-archive：" + PLUGIN_NAME + " ===");
  console.log("  插件源码 : " + path.join(ROOT, "plugin", PLUGIN_DIR_NAME));
  console.log("  端口     : " + port + "   CDP: " + CDP_PORT);
  console.log("  临时家   : " + tempHome);
  console.log("  bundles  : " + bundles.join(", "));
  console.log("  已镜像   : " + mirrored.join(", "));
  console.log("");

  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE; // ★ 不删的话 Electron 退化成纯 Node（项目 AGENTS.md §6）
  env.DSH_HOME = tempHome;
  // ★ 也告诉归档管理器自己（它现在会自己探测家）—— 不指定就可能落到真实环境
  env.DSH_ARCHIVE_HOME = tempHome;
  env.DSH_ARCHIVE_CONFIG_DIR = path.join(runDir, "cfg");

  const child = spawn(electronExe, [
    ".", `--user-data-dir=${userData}`, `--remote-debugging-port=${CDP_PORT}`,
  ], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });

  let log = "";
  child.stdout.on("data", (d) => { log += d.toString(); });
  child.stderr.on("data", (d) => { log += d.toString(); });
  const cleanup = () => { try { child.kill(); } catch {} };
  process.on("exit", cleanup);

  // 等 CDP 有页面
  const ws = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const list = await r.json();
    const page = list.find((t) => t.type === "page" && /^http/.test(t.url || "") && /127\.0\.0\.1|localhost/.test(t.url || ""));
    return page ? page.webSocketDebuggerUrl : null;
  }, 180000);

  if (!ws) {
    ok("浏览器起来了", false, "CDP 没有可用页面");
    console.log("── 日志尾部 ──");
    console.log(log.slice(-3000));
    cleanup();
    if (!KEEP) { try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {} }
    process.exit(1);
  }
  ok("浏览器起来了（临时家）", true, (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).map((t) => t.url).join(" | ").slice(0, 160));

  // 等官方前端渲染完
  await waitFor(async () => {
    const v = await cdpEval(ws, `!!(window.__DSH_BOOT__ && window.__DSH_BOOT__.entries)`, 8000);
    return v === true ? v : null;
  }, 120000);

  // ── ① 启动图 ────────────────────────────────────────────────────────
  const ids = await cdpEval(ws, `JSON.stringify((window.__DSH_BOOT__&&window.__DSH_BOOT__.entries||[]).map(e=>e.id))`);
  const hasEntry = typeof ids === "string" && ids.includes(PLUGIN_NAME);
  ok("① 启动图里有 " + PLUGIN_NAME, hasEntry,
    typeof ids === "string" ? `共 ${JSON.parse(ids).length} 条` : String(ids).slice(0, 120));

  // ── ② apply() 真的跑了 ───────────────────────────────────────────────
  const cssOk = await cdpEval(ws, `!!document.querySelector('style[data-plugin-css=${JSON.stringify(CSS_ID)}]')`);
  ok("② 插件注入了自己的 <style>（bundle 下载 ≠ apply 跑了；这个是 apply 的证据）", cssOk === true, String(cssOk));

  const hookOk = await cdpEval(ws, `!!window.__dshArchiveManager`);
  ok("② 调试钩子存在（apply 跑到了最后一行）", hookOk === true, String(hookOk));

  if (hookOk) {
    const diag = await cdpEval(ws, `JSON.stringify(window.__dshArchiveManager.diagnostics.slots)`);
    const noFail = typeof diag === "string" && !/"ok":false/.test(diag);
    ok("② 两个槽位都注册成功（没有静默失败）", noFail, String(diag).slice(0, 220));
  }

  // ── ③ 界面上真的有「已归档」，且点得动 ────────────────────────────────
  const rowText = await cdpEval(ws, `(() => {
    const els = Array.from(document.querySelectorAll('button,[role=button],a'));
    const hit = els.find(e => (e.textContent||'').includes('已归档') || (e.getAttribute('aria-label')||'').includes('已归档'));
    return hit ? (hit.textContent||'').trim() || hit.getAttribute('aria-label') : null;
  })()`);
  ok("③ 侧边栏出现了「已归档」这一行", !!rowText, String(rowText).slice(0, 80));

  const clicked = await cdpEval(ws, `(() => {
    const els = Array.from(document.querySelectorAll('button,[role=button]'));
    const hit = els.find(e => (e.textContent||'').includes('已归档'));
    if (!hit) return 'no-row';
    hit.click();
    return 'clicked';
  })()`);
  ok("③ 「已归档」这一行点得动", clicked === "clicked", String(clicked));

  await new Promise((r) => setTimeout(r, 2500));

  // ★ 这个属性的**值**来自插件的 PANEL_ID（= 包名），所以改名后必须跟着改。
  //   （属性**名** data-dsham 是固定选择器，不动。）
  const panelOk = await cdpEval(ws, `!!document.querySelector('[data-dsham="dsh-int-archive-manager-body"]')`);
  ok("③ 点完之后主面板真的渲染出来了", panelOk === true, String(panelOk));

  const hasSearch = await cdpEval(ws, `!!document.querySelector('[data-dsham="search"]')`);
  ok("③ 主面板里有搜索框", hasSearch === true, String(hasSearch));

  const hasDate = await cdpEval(ws, `!!document.querySelector('[data-dsham="date"]')`);
  ok("③ 主面板里有按天筛选（date input）", hasDate === true, String(hasDate));

  const hasTrashCfg = await cdpEval(ws, `!!document.querySelector('[data-dsham="trashdir"]')`);
  ok("③ 主面板里有转储文件夹设置框", hasTrashCfg === true, String(hasTrashCfg));

  // 真的调一次 HTTP（不是只看 DOM）
  const health = await cdpEval(ws, `(async () => {
    try { const r = await fetch('/dsh-archive/health.json'); return JSON.stringify(await r.json()); }
    catch (e) { return 'ERR ' + e.message; }
  })()`);
  ok("③ HTTP 接口通了（health.json）",
    typeof health === "string" && health.startsWith("{") && /"ok":true/.test(health),
    String(health).slice(0, 240));

  const list = await cdpEval(ws, `(async () => {
    try { const r = await fetch('/dsh-archive/list.json'); const j = await r.json();
          return JSON.stringify({ ok: j.ok, n: (j.items||[]).length, home: j.home }); }
    catch (e) { return 'ERR ' + e.message; }
  })()`);
  console.log("       list.json → " + String(list).slice(0, 240));
  ok("③ list.json 返回了清单结构",
    typeof list === "string" && /"ok":true/.test(list), String(list).slice(0, 200));

  // ★ 硬闸门：临时家里跑，绝不能解析到真实 DSH 家
  ok("③ 插件用的家是临时目录（不是真实环境）",
    typeof list === "string" && !/AppData\\\\Roaming\\\\DSH Integrated/i.test(list),
    String(list).slice(0, 200));

  cleanup();
  if (!KEEP) { try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {} }

  console.log("");
  console.log("================================================================");
  console.log("断言 " + (pass + fail) + " 条：PASS " + pass + " / FAIL " + fail);
  if (fail) { console.log(""); console.log("失败清单："); for (const f of failures) console.log("  · " + f); }
  console.log("================================================================");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("跑不下去：" + (e && e.message)); process.exit(1); });
