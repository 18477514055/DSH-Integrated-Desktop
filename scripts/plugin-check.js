"use strict";

/**
 * plugin-check.js —— 在**临时环境**里真跑一遍多会话插件，用 CDP 看真实渲染结果。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须这么验（而不是"文件写了 / 语法过了 / 插件列进 bundles 了"）
 * ══════════════════════════════════════════════════════════════════
 * `$DSH_HOME/AGENTS.md` 第二条硬规矩：验证"某东西能否工作"必须**真让它工作**；
 * "文件存在 / 模块可解析 / 配置里有 / 版本号对"一律**不构成**兼容性证据
 * （2026-09-19 事故就是这么来的：静态可解析 ≠ 动态可加载）。
 * 对客户端插件尤其致命 —— 装错了的典型表现是"bundle 加载了、服务端全好、
 * 界面上一个挂载点都没挂上"，**而且不报错**（dsh-crosshub 源码里留着这个事故的注释）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三层证据，一层比一层硬（**最后两层刻意不看插件自己的报告**）
 * ══════════════════════════════════════════════════════════════════
 *  ① 结构：`window.__DSH_BOOT__.entries` 里有 `dsh-multi-session`
 *     ⇒ 宿主真的把它公告进了启动图（"装上了"的第一层证据）。
 *  ② 动态：页面里出现 `<style data-plugin-css="dsh-multi-session/…">`
 *     ⇒ 插件的 `apply()` **真的跑了**（不是"bundle 被下载了"）。★ 这一层才排除假阳性。
 *  ③ 端到端 + 交叉核对：点「一键发送」之后，**不信插件自己的结果文案**，
 *     而是去**临时 DSH_HOME 的磁盘**上找：
 *        · `sessions/` 下有没有那个新会话；
 *        · 整个家里有没有我输入的那串**标记文本**（证明提示词真的进了持久日志）。
 *     ⇒ 插件说"已创建 2 个会话"只能算线索，磁盘上有才是证据。
 *
 * ══════════════════════════════════════════════════════════════════
 * 临时环境长什么样（**不碰 B、不碰 A**）
 * ══════════════════════════════════════════════════════════════════
 *   runtime/plugin-check/<时间戳>/
 *     userdata/                        ← 传给 Electron 的 --user-data-dir
 *       settings.json                  ← 空闲端口 / closeToTray:false
 *       dsh-home/                      ← 外壳的 DSH_HOME = userData/dsh-home
 *         storages/workspace.json      ← 从 B 拷来的工作区注册表（只有路径，没有凭据）
 *         profiles/
 *           node_modules/              ← 【目录联接】B 的 profiles/node_modules
 *           web/
 *             cordis.yml               ← []
 *             package.json             ← bundles = dsh-base + dsh-web-app + 本插件
 *             node_modules/
 *               dsh-multi-session/     ← 【目录联接】本仓库的 plugin/dsh-multi-session
 * 用联接而不是拷贝/安装：零网络、零解析、零构建，且**跑的就是仓库里那份源码**。
 * 也不需要 B 的第三方插件（只挂 dsh-base + dsh-web-app 就是完整官方界面）。
 *
 * 用法：
 *   node scripts/plugin-check.js            # 跑一遍，结束删临时目录
 *   node scripts/plugin-check.js --keep     # 保留临时目录（排查用）
 *   node scripts/plugin-check.js --only 1,2 # 只跑到第 N 层证据
 *
 * 退出码：0 全过；1 有 FAIL；2 环境/启动失败。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const PLUGIN_DIR = path.join(ROOT, "plugin", "dsh-multi-session");
const PLUGIN_NAME = "dsh-multi-session";
const CDP_PORT = Number(process.env.DSH_PLUGIN_CHECK_CDP || 9344);
const FREE_PORT = Number(process.env.DSH_PLUGIN_CHECK_PORT || 3179);
const KEEP = process.argv.includes("--keep");
const onlyArg = process.argv.indexOf("--only");
const ONLY = onlyArg >= 0 && process.argv[onlyArg + 1] ? process.argv[onlyArg + 1].split(",").map(Number) : null;

const MARK1 = "DSHMS-PROBE-ALPHA-" + Date.now();
const MARK2 = "DSHMS-PROBE-BETA-" + Date.now();
const FILE_MARK = "DSHMS-ATTACH-GAMMA-" + Date.now();

const failures = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures.push(`${name}: ${detail || ""}`);
}
function want(step) { return !ONLY || ONLY.includes(step); }
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
        return reject(new Error("页面执行报错: " + JSON.stringify(msg.result.exceptionDetails).slice(0, 500)));
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
  throw new Error(`等页面超时（看到 ${last.length} 个 page: ${last.map((t) => t.url).join(" | ")}）`);
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

function buildTempHome(opts = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(ROOT, "runtime", "plugin-check", stamp);
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

  // 工作区注册表（界面没工作区就会停在"选择一个工作区开始"，后面全做不下去）
  const wsSrc = path.join(realHome, "storages", "workspace.json");
  if (fs.existsSync(wsSrc)) {
    const dst = path.join(home, "storages");
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(wsSrc, path.join(dst, "workspace.json"));
  }

  // 只借用内核依赖树（联接，只读使用）
  junction(path.join(profiles, "node_modules"), realShared);

  // ── bundle 清单：默认**镜像真实环境那一套**，这样验证的就是用户的实际配置 ──
  let bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
  let mirrored = [];
  if (!opts.minimal) {
    try {
      const real = JSON.parse(fs.readFileSync(path.join(realWeb, "package.json"), "utf8"));
      const list = (((real.dsh || {}).profile) || {}).bundles;
      if (Array.isArray(list) && list.length) {
        bundles = list.slice();
        // 真实 profile 里那些第三方插件在 **web/node_modules** 下（不是共享层）⇒ 逐个联接过来
        for (const name of list) {
          if (name.startsWith("@deepseek-ai/")) continue;
          const src = path.join(realWeb, "node_modules", ...name.split("/"));
          if (!fs.existsSync(src)) continue;
          const dst = path.join(web, "node_modules", ...name.split("/"));
          junction(dst, src);
          mirrored.push(name);
        }
        // 真实 profile 的补丁层（例如它 disable 了 crosshub）也要带上，否则配置不等价
        const rp = path.join(realWeb, "cordis.patch.yml");
        if (fs.existsSync(rp)) fs.copyFileSync(rp, path.join(web, "cordis.patch.yml"));
      }
    } catch (e) {
      console.log(`  ⚠ 镜像真实 bundle 清单失败（${e.message}），退回最小清单`);
    }
  }

  if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME);
  fs.writeFileSync(path.join(web, "cordis.yml"), "[]\n", "utf8");
  fs.writeFileSync(path.join(web, "package.json"), JSON.stringify({
    name: "dsh-profile-web",
    private: true,
    dsh: { profile: { bundles, patchReload: "live" } },
  }, null, 2) + "\n", "utf8");

  // 插件：目录联接 ⇒ 跑的就是仓库里那份源码
  junction(path.join(web, "node_modules", PLUGIN_NAME), PLUGIN_DIR);

  // 外壳自己的设置
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
  delete env.ELECTRON_RUN_AS_NODE;   // ★ 不删的话 Electron 退化成纯 Node，什么都不做
  const child = spawn(electronExe, [
    ".", `--user-data-dir=${userData}`, `--remote-debugging-port=${CDP_PORT}`,
  ], { cwd: ROOT, env, stdio: "ignore", windowsHide: false });
  return child;
}

function readAppLog(userData, maxLines = 30) {
  try {
    const f = path.join(userData, "shell.log");
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch { return []; }
}

// ── 磁盘交叉核对（第 ③ 层的硬证据）────────────────────────────────
function walk(dir, out = [], depth = 0) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 6) walk(p, out, depth + 1); }
    else out.push(p);
  }
  return out;
}

/** 在整个临时 DSH_HOME 里找一段标记文本（不区分大小写）。返回命中文件列表。 */
function findMarkerOnDisk(home, marker) {
  const hits = [];
  for (const f of walk(home)) {
    let stat;
    try { stat = fs.statSync(f); } catch { continue; }
    if (stat.size > 40 * 1024 * 1024) continue;
    let buf;
    try { buf = fs.readFileSync(f); } catch { continue; }
    if (buf.includes(Buffer.from(marker, "utf8"))) hits.push(f);
  }
  return hits;
}

// ── 主流程 ────────────────────────────────────────────────────────
(async () => {
  console.log("\n=== plugin-check：多会话插件真跑验证 ===");
  console.log(`  插件源码 : ${PLUGIN_DIR}`);
  console.log(`  空闲端口 : ${FREE_PORT}   CDP 端口: ${CDP_PORT}`);

  if (!fs.existsSync(path.join(PLUGIN_DIR, "lib", "client.js"))) {
    throw new Error(`插件源码不完整：缺 lib/client.js（${PLUGIN_DIR}）`);
  }

  const env = buildTempHome({ minimal: process.argv.includes("--minimal") });
  console.log(`  临时家   : ${env.home}`);
  console.log(`  临时 profile bundles (${env.bundles.length}): ${env.bundles.join(", ")}`);
  if (env.mirrored.length) console.log(`  其中从真实环境联接过来的第三方插件: ${env.mirrored.join(", ")}`);
  console.log("");

  const child = launch(env.userData);
  let target = null;
  try {
    // 等内核把官方界面加载出来（加载页不算）
    target = await waitForPage((t) => new RegExp(`127\\.0\\.0\\.1:${FREE_PORT}`).test(t.url), 120000);
    console.log(`  已连上官方界面: ${target.url}\n`);
    const ws = target.webSocketDebuggerUrl;
    await sleep(4000);   // 等客户端插件全部物化完

    // ── 第 ① 层：结构证据 ────────────────────────────────────────
    if (want(1)) {
      console.log("── 第 ① 层：宿主有没有把插件公告进启动图 ──");
      const raw = await cdpEval(ws, `JSON.stringify((window.__DSH_BOOT__&&window.__DSH_BOOT__.entries||[]).map(e=>e.id))`);
      let ids = [];
      try { ids = JSON.parse(raw); } catch { }
      check("启动图 entries 里有 dsh-multi-session", ids.includes(PLUGIN_NAME),
        `共 ${ids.length} 条；末 5 条: ${ids.slice(-5).join(", ")}`);
      const entry = await cdpEval(ws, `JSON.stringify(((window.__DSH_BOOT__||{}).entries||[]).find(e=>e.id===${JSON.stringify(PLUGIN_NAME)})||null)`);
      console.log(`  entry: ${entry}`);
    }

    // ── 第 ② 层：动态证据（apply 真的跑了）──────────────────────
    if (want(2)) {
      console.log("\n── 第 ② 层：插件的 apply() 有没有真的跑 ──");
      const cssOk = await cdpEval(ws, `!!document.querySelector('style[data-plugin-css="${PLUGIN_NAME}/multi-session.css"]')`);
      check("页面里出现了插件注入的 <style data-plugin-css>", cssOk === true,
        "只有 apply() 执行到 installCss 才会出现（bundle 被下载不会）");

      // ★ 先**等按钮出现**，不要睡固定时间就去找。
      //   实测（4 连跑里的第 3 次）：页面已经在了，但 composer 槽位还没渲染完 ⇒
      //   "按钮没找到"是**脚本的时序**问题，不是插件的故障（那一次后续全过、发送也成功）。
      //   所以这里改成轮询等待，把"没渲染完"与"真的没挂上"分开。
      const waitForTrigger = async (timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const ok = await cdpEval(ws, `(() => {
            const all = Array.from(document.querySelectorAll('button'));
            return all.some(b => (b.getAttribute('title')||'').includes('多会话同时开工') || (b.textContent||'').trim() === '多会话');
          })()`);
          if (ok === true) return true;
          if (Date.now() > deadline) return false;
          await sleep(600);
        }
      };
      const triggerSeen = await waitForTrigger(45000);

      const btn = await cdpEval(ws, `(() => {
        const all = Array.from(document.querySelectorAll('button'));
        const hit = all.find(b => (b.getAttribute('title')||'').includes('多会话同时开工') || (b.textContent||'').trim() === '多会话');
        return JSON.stringify({ found: !!hit, text: hit ? (hit.textContent||'').trim() : '', title: hit ? hit.getAttribute('title') : '', cls: hit ? hit.className : '' });
      })()`);
      const b = JSON.parse(btn);
      check("主输入框右侧出现了「多会话」触发按钮", triggerSeen === true && b.found === true,
        b.found ? `按钮文字「${b.text}」 class=${b.cls}` : "等 45 秒也没出现");

      // 调试钩子 + 槽位注册结果（"没挂上"必须看得见，不能被静默吞掉）
      const hookRaw = await cdpEval(ws, `JSON.stringify(window.__dshMultiSession ? {
        plugin: window.__dshMultiSession.plugin,
        slots: window.__dshMultiSession.diagnostics.slots,
        errors: window.__dshMultiSession.diagnostics.errors
      } : null)`);
      const hook = hookRaw ? JSON.parse(hookRaw) : null;
      check("插件暴露了调试钩子 window.__dshMultiSession（apply 跑到了最后）", hook !== null,
        hook ? JSON.stringify(hook.slots) : "没有这个全局对象 ⇒ apply() 中途抛错了");
      if (hook) {
        check("两个槽位都注册成功", hook.errors.length === 0, hook.errors.length ? hook.errors.join(" | ") : "trigger + modal 都 ok");
      }
    }

    // ── 第 ②+ 层：交互（开弹窗 / 加行 / 输入）────────────────────
    if (want(3)) {
      console.log("\n── 交互：开弹窗 → 加一行 → 输入标记文本 ──");
      const clickTrigger = await cdpEval(ws, `(() => {
        const all = Array.from(document.querySelectorAll('button'));
        const hit = all.find(b => (b.getAttribute('title')||'').includes('多会话同时开工') || (b.textContent||'').trim() === '多会话');
        if (!hit) return 'no-button';
        hit.click();
        return JSON.stringify({ r: 'clicked', disabled: hit.disabled, cls: hit.className });
      })()`);
      check("点得动触发按钮", String(clickTrigger).includes("clicked"), String(clickTrigger));
      await sleep(900);

      // 若点了没反应，用调试钩子直接开 —— 把"按钮接线"与"弹窗渲染"两个故障分开
      const clickDiag = await cdpEval(ws, `JSON.stringify({
        clicks: window.__dshMultiSession.diagnostics.clicks,
        errors: window.__dshMultiSession.diagnostics.errors,
        open: window.__dshMultiSession.state().open
      })`);
      console.log("  点击后诊断: " + clickDiag);
      check("触发按钮的 onClick 真的被调用了", JSON.parse(clickDiag).clicks > 0, clickDiag);

      let opened = JSON.parse(clickDiag).open;
      if (opened !== true) {
        console.log("  · 点击没改变状态，改用调试钩子直接开弹窗（用于区分故障点）");
        await cdpEval(ws, `window.__dshMultiSession.open(), true`);
        await sleep(800);
        opened = await cdpEval(ws, `!!(window.__dshMultiSession && window.__dshMultiSession.state().open)`);
        check("调试钩子能把 state.open 翻成 true", opened === true, String(opened));
      }

      const panel = await cdpEval(ws, `(() => {
        const p = document.querySelector('.dshms-panel');
        const rows = document.querySelectorAll('.dshms-row');
        const ta = document.querySelectorAll('.dshms-ta');
        return JSON.stringify({ panel: !!p, rows: rows.length, tas: ta.length, title: p ? (p.querySelector('.dshms-title')||{}).textContent : '' });
      })()`);
      const p1 = JSON.parse(panel);
      check("弹窗渲染出来了（.dshms-panel）", p1.panel === true, `标题「${p1.title}」`);
      if (p1.panel !== true) {
        // 失败时把"为什么"抓出来 —— 区分「state 没翻过去」与「槽位没挂上」
        const diag = await cdpEval(ws, `JSON.stringify({
          hook: !!window.__dshMultiSession,
          open: window.__dshMultiSession ? window.__dshMultiSession.state().open : null,
          slots: window.__dshMultiSession ? window.__dshMultiSession.diagnostics.slots : null,
          overlayChildren: (document.querySelector('[data-shell-overlay]')||{}).childElementCount,
          dialog: !!document.querySelector('[role="dialog"]'),
          bodyMasks: document.querySelectorAll('body > div').length
        })`);
        console.log("  诊断: " + diag);
      }
      check("默认 1 个输入框", p1.rows === 1 && p1.tas === 1, `rows=${p1.rows} textareas=${p1.tas}`);

      // 新增会话
      const addRes = await cdpEval(ws, `(() => {
        const btns = Array.from(document.querySelectorAll('.dshms-panel button'));
        const add = btns.find(b => (b.textContent||'').trim() === '新增会话');
        if (!add) return 'no-add-button';
        add.click();
        return 'clicked';
      })()`);
      check("有「新增会话」按钮且点得动", addRes === "clicked", String(addRes));
      await sleep(600);
      const after = await cdpEval(ws, `document.querySelectorAll('.dshms-row').length`);
      check("点一下「新增会话」变成 2 个输入框", after === 2, `现在 ${after} 个`);

      // ── 模型下拉：搜索框 + 来源胶囊 + 分组 + 空态 + Esc 两级语义 ──
      console.log("\n── 功能：每行各自的模型下拉（搜索框 / 来源胶囊 / 分组）──");
      const modelOpen = await cdpEval(ws, `(() => {
        const row = document.querySelectorAll('.dshms-row')[0];
        const b = Array.from(row.querySelectorAll('button')).find(x => (x.getAttribute('title')||'').includes('这一行用哪个模型'));
        if (!b) return 'no-model-button';
        b.click();
        return 'clicked';
      })()`);
      check("行内有模型选择按钮且点得动", modelOpen === "clicked", String(modelOpen));
      await sleep(800);

      const dumpModelMenu = `(() => {
        const rows = document.querySelectorAll('.dshms-row');
        const row = rows[0];
        if (!row) return JSON.stringify({
          rowsFound: 0,
          store: window.__dshMultiSession ? { open: window.__dshMultiSession.state().open, popover: window.__dshMultiSession.state().popover, menu: window.__dshMultiSession.state().menu } : null
        });
        const search = row.querySelector('.dshms-search');
        const pills = Array.from(row.querySelectorAll('.dshms-pill')).map(x => ({ text: x.textContent, on: x.getAttribute('data-on') }));
        const items = Array.from(row.querySelectorAll('.dshms-menu-item')).map(x => x.textContent);
        const names = Array.from(row.querySelectorAll('.dshms-menu-item .mi-name')).map(x => x.textContent);
        const groups = Array.from(row.querySelectorAll('.dshms-group')).map(x => x.textContent);
        const empty = row.querySelector('.dshms-menu-empty');
        return JSON.stringify({
          rowsFound: rows.length,
          hasSearch: !!search, query: search ? search.value : null,
          pills, items: items.length, names, groups,
          empty: empty ? empty.textContent : null,
          panelOpen: !!document.querySelector('.dshms-panel'),
          store: window.__dshMultiSession ? { open: window.__dshMultiSession.state().open, popover: window.__dshMultiSession.state().popover } : null
        });
      })()`;

      const mo = JSON.parse(await cdpEval(ws, dumpModelMenu));
      check("模型下拉里有搜索框", mo.hasSearch === true, "");
      check("模型下拉列出了真实模型目录（≥1 个模型 + 默认项）", mo.items >= 2, `${mo.items} 项`);
      check("有来源筛选胶囊（全部 + 各来源，且带条数）", mo.pills.length >= 2,
        `${mo.pills.length} 颗: ${mo.pills.slice(0, 5).map((p) => p.text).join(" | ")}`);
      check("模型按来源分组显示", mo.groups.length >= 1, mo.groups.slice(0, 4).join(" | "));
      const baselineItems = mo.items;

      // 取第一个真实模型名的一段做搜索词（这样断言不依赖具体模型叫什么）
      const firstModel = mo.names.length > 1 ? mo.names[1] : "";
      const term = firstModel.slice(0, Math.max(3, Math.min(6, firstModel.length))).toLowerCase();
      console.log(`  用搜索词 "${term}"（取自第一个模型名 ${JSON.stringify(firstModel)}）`);

      const setSearch = (v) => cdpEval(ws, `(() => {
        const el = document.querySelectorAll('.dshms-row')[0].querySelector('.dshms-search');
        if (!el) return 'no-search';
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        setter.call(el, ${JSON.stringify(v)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()`);

      await setSearch(term);
      await sleep(500);
      const mo2 = JSON.parse(await cdpEval(ws, dumpModelMenu));
      const allHit = mo2.names.slice(1).every((n) => n.toLowerCase().includes(term));
      check("搜索真的过滤了列表（条数变少）", mo2.items < baselineItems, `${baselineItems} → ${mo2.items} 项`);
      check("留下的每一条都真的含搜索词（不是乱留）", mo2.names.length <= 1 || allHit,
        mo2.names.slice(1, 5).join(" | "));

      await setSearch("zzz-不可能匹配的模型-zzz");
      await sleep(500);
      const mo3 = JSON.parse(await cdpEval(ws, dumpModelMenu));
      check("搜不到时给出空态提示", !!mo3.empty && mo3.empty.includes("没有匹配的模型"),
        String(mo3.empty).slice(0, 80));
      check("空态里有「清空搜索与筛选」", !!mo3.empty && mo3.empty.includes("清空搜索与筛选"), "");

      // Esc 第一下：清筛选、下拉还在、弹窗还在
      const esc1 = await cdpEval(ws, `(() => {
        const row = document.querySelectorAll('.dshms-row')[0];
        const el = row && row.querySelector('.dshms-search');
        if (!el) return 'no-search-input';
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return 'sent';
      })()`);
      await sleep(500);
      const mo4 = JSON.parse(await cdpEval(ws, dumpModelMenu));
      if (mo4.rowsFound === 0) console.log("  !! Esc 之后弹窗不见了，store=" + JSON.stringify(mo4.store) + " esc=" + esc1);
      check("Esc 第一下只清掉筛选条件，不关下拉、也不关弹窗",
        mo4.rowsFound > 0 && mo4.hasSearch === true && !mo4.query && mo4.panelOpen === true && mo4.items >= baselineItems,
        `esc=${esc1} rows=${mo4.rowsFound} query=${JSON.stringify(mo4.query)} 下拉在=${mo4.hasSearch} 弹窗在=${mo4.panelOpen} 项=${mo4.items}`);

      // 点来源胶囊：只剩该来源（条数应与胶囊上的数字一致）
      const pillRes = await cdpEval(ws, `(() => {
        const pills = Array.from(document.querySelectorAll('.dshms-row')[0].querySelectorAll('.dshms-pill'));
        const target = pills.find(p => !p.textContent.startsWith('全部'));
        if (!target) return 'no-pill';
        target.click();
        return JSON.stringify({ label: target.textContent });
      })()`);
      await sleep(500);
      const mo5 = JSON.parse(await cdpEval(ws, dumpModelMenu));
      let pillCount = null;
      if (pillRes !== "no-pill") {
        const m = /(\d+)\s*$/.exec(JSON.parse(pillRes).label);
        pillCount = m ? Number(m[1]) : null;
      }
      check("点来源胶囊后只剩该来源（条数 = 胶囊上的数字）",
        pillCount !== null && (mo5.items - 1) === pillCount,
        `胶囊=${pillRes} ⇒ 可见 ${mo5.items - 1} 个模型（「默认模型」那项不计）`);
      const onPills = mo5.pills.filter((p) => p.on === "1").map((p) => p.text);
      check("被选中的胶囊有高亮状态", onPills.length === 1, onPills.join(" | "));

      // Esc 第二下：清掉来源筛选（下拉仍在）
      const dispatchEsc = () => cdpEval(ws, `(() => {
        const row = document.querySelectorAll('.dshms-row')[0];
        const el = row && row.querySelector('.dshms-search');
        if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      })()`);
      await dispatchEsc();
      await sleep(450);
      const mo6 = JSON.parse(await cdpEval(ws, dumpModelMenu));
      const anyOn = mo6.pills.filter((p) => p.on === "1").map((p) => p.text);
      check("Esc 第二下清掉来源筛选（下拉仍在、弹窗仍在）",
        mo6.rowsFound > 0 && mo6.hasSearch === true && mo6.panelOpen === true
          && (anyOn.length === 0 || anyOn[0].startsWith("全部")),
        `选中胶囊=${JSON.stringify(anyOn)} 下拉在=${mo6.hasSearch} 弹窗在=${mo6.panelOpen}`);

      // Esc 第三下：才关掉下拉（弹窗仍在 —— 草稿不会丢）
      await dispatchEsc();
      await sleep(450);
      const mo7 = JSON.parse(await cdpEval(ws, dumpModelMenu));
      check("Esc 第三下关掉下拉，但**弹窗还在**（草稿不会丢）",
        mo7.rowsFound > 0 && mo7.hasSearch === false && mo7.panelOpen === true,
        `rows=${mo7.rowsFound} 下拉在=${mo7.hasSearch} 弹窗在=${mo7.panelOpen} store=${JSON.stringify(mo7.store)}`);

      // ── `/` 命令菜单 ──
      console.log("\n── 功能：`/` 命令菜单 ──");
      await cdpEval(ws, `(() => {
        const ta = document.querySelectorAll('.dshms-ta')[0];
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set;
        setter.call(ta, '/');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(1500);
      const slashMenu = await cdpEval(ws, `JSON.stringify(window.__dshMultiSession.state().menu)`);
      let sm = null; try { sm = JSON.parse(slashMenu); } catch { }
      check("输入 / 之后弹出了命令菜单", sm !== null && sm !== undefined, slashMenu ? String(slashMenu).slice(0, 140) : "menu=null");
      if (sm) {
        check("命令候选源是可用的（不是「这个内核没提供」）", sm.unavailable === false, `unavailable=${sm.unavailable}`);
        check("命令候选非空", Array.isArray(sm.items) && sm.items.length > 0,
          `${(sm.items || []).length} 条: ${(sm.items || []).slice(0, 3).map((i) => i.name).join(", ")}`);
      }

      // ── `@` 引用菜单 ──
      console.log("\n── 功能：`@` 文件引用菜单 ──");
      await cdpEval(ws, `(() => {
        const ta = document.querySelectorAll('.dshms-ta')[0];
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set;
        setter.call(ta, '@');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(1500);
      const atMenu = await cdpEval(ws, `JSON.stringify(window.__dshMultiSession.state().menu)`);
      let am = null; try { am = JSON.parse(atMenu); } catch { }
      check("输入 @ 之后弹出了引用菜单", am !== null && am !== undefined, atMenu ? String(atMenu).slice(0, 140) : "menu=null");
      if (am) {
        check("引用候选源是可用的（不是「这个内核没提供」）", am.unavailable === false, `unavailable=${am.unavailable}`);
        console.log(`  引用候选 ${(am.items || []).length} 条: ${(am.items || []).slice(0, 3).map((i) => i.name).join(", ")}`);
      }

      // ── 附件（第 2 行挂一个真实 File）──
      console.log("\n── 功能：附件 ──");
      const attach = await cdpEval(ws, `(() => {
        const inp = document.querySelectorAll('.dshms-row')[1].querySelector('input[type=file]');
        if (!inp) return 'no-file-input';
        const dt = new DataTransfer();
        dt.items.add(new File([${JSON.stringify(FILE_MARK)}], 'probe.txt', { type: 'text/plain' }));
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return 'attached';
      })()`);
      check("能往某一行挂上附件", attach === "attached", String(attach));
      await sleep(600);
      const chips = await cdpEval(ws, `JSON.stringify(Array.from(document.querySelectorAll('.dshms-chip b')).map(x=>x.textContent))`);
      check("附件以芯片形式显示出来", String(chips).includes("probe.txt"), String(chips).slice(0, 120));

      // 输入两段带标记的文本（React 受控组件：必须走原生 setter 再派发 input 事件）
      const typed = await cdpEval(ws, `(() => {
        const tas = Array.from(document.querySelectorAll('.dshms-ta'));
        if (tas.length < 2) return 'only-' + tas.length + '-textareas';
        const setVal = (el, v) => {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        setVal(tas[0], ${JSON.stringify(MARK1)});
        setVal(tas[1], ${JSON.stringify(MARK2)});
        return 'typed';
      })()`);
      check("两行都写得进去（原生 setter + input 事件）", typed === "typed", String(typed));
      await sleep(500);
      const vals = await cdpEval(ws, `JSON.stringify(Array.from(document.querySelectorAll('.dshms-ta')).map(t=>t.value))`);
      let arr = [];
      try { arr = JSON.parse(vals); } catch { }
      check("两行都写进去了（React 状态真的接住了）", arr.length === 2 && arr[0] === MARK1 && arr[1] === MARK2,
        `值: ${JSON.stringify(arr).slice(0, 160)}`);
    }

    // ── 第 ③ 层：端到端 + 磁盘交叉核对 ──────────────────────────
    if (want(4)) {
      console.log("\n── 第 ③ 层：一键发送 → 去磁盘上找证据（不看插件自己的报告）──");
      const sendRes = await cdpEval(ws, `(() => {
        const btns = Array.from(document.querySelectorAll('.dshms-panel button'));
        const send = btns.find(b => (b.textContent||'').includes('一键发送'));
        if (!send) return 'no-send-button';
        if (send.disabled) return 'send-disabled';
        send.click();
        return 'clicked';
      })()`, 60000);
      check("有「一键发送」按钮且可点", sendRes === "clicked", String(sendRes));

      // 等结果视图。
      // ★ 上限给到 180 秒，不是随便定的：插件里"等附件后台上传完成"的自身超时是 120 秒
      //   （waitForUploads），实测上传偶尔会拖到几十秒 —— 原来只等 60 秒会出现
      //   "磁盘上明明已经发出去了、结果视图却没等到"的假 FAIL（真的发生过一次）。
      let results = null;
      let lastStore = null;
      const t0 = Date.now();
      const deadline = t0 + 180000;
      while (Date.now() < deadline) {
        await sleep(1500);
        const raw = await cdpEval(ws, `(() => {
          const rows = Array.from(document.querySelectorAll('.dshms-res-row'));
          const st = window.__dshMultiSession ? window.__dshMultiSession.state() : null;
          const store = st ? { open: st.open, sending: st.sending, results: Array.isArray(st.results) ? st.results.length : st.results, notice: st.notice, rows: st.rows.length, sends: window.__dshMultiSession.diagnostics.sends } : null;
          if (!rows.length) return JSON.stringify({ none: true, store });
          return JSON.stringify({
            text: (document.querySelector('.dshms-res')||{}).textContent || '',
            rows: rows.map(r => r.textContent),
            store
          });
        })()`);
        if (raw) {
          const parsed = JSON.parse(raw);
          lastStore = parsed.store;
          if (!parsed.none) { results = parsed; break; }
        }
      }
      const sendMs = Date.now() - t0;
      check("发送后弹窗切到了结果视图", results !== null,
        results ? `耗时 ${(sendMs / 1000).toFixed(1)} 秒` : `180 秒内没出现；等待期间最后状态 store=${JSON.stringify(lastStore)}`);
      if (results) {
        console.log("  结果视图（逐行完整）:");
        for (const r of results.rows) console.log("    · " + r);
      }

      await sleep(4000);   // 给宿主落盘一点时间

      // ① 磁盘上有没有会话（独立于插件的说法）
      const sessDir = path.join(env.home, "sessions");
      const sessFiles = fs.existsSync(sessDir) ? walk(sessDir) : [];
      check("临时家的 sessions/ 下真的出现了会话文件", sessFiles.length > 0,
        `${sessFiles.length} 个文件；样例 ${sessFiles.slice(0, 2).map((f) => path.relative(env.home, f)).join(", ")}`);

      // ② 磁盘上有没有我们输入的两段标记文本（提示词真进了持久日志）
      const hit1 = findMarkerOnDisk(env.home, MARK1);
      const hit2 = findMarkerOnDisk(env.home, MARK2);
      check("标记文本 A 出现在磁盘上的持久数据里（提示词真的发出去了）", hit1.length > 0,
        hit1.length ? hit1.map((f) => path.relative(env.home, f)).slice(0, 3).join(", ") : "全盘没找到");
      check("标记文本 B 也出现在磁盘上（两条都真的发出去了）", hit2.length > 0,
        hit2.length ? hit2.map((f) => path.relative(env.home, f)).slice(0, 3).join(", ") : "全盘没找到");

      // ④ 附件字节是否真的到了宿主这边（附件不是"看起来挂上了"，要落到磁盘）
      const hitF = findMarkerOnDisk(env.home, FILE_MARK);
      check("附件的字节出现在宿主数据里（附件真的上传了）", hitF.length > 0,
        hitF.length ? hitF.map((f) => path.relative(env.home, f)).slice(0, 3).join(", ") : "全盘没找到附件内容");

      // ③ 官方界面没被搞坏（我们只往 list 槽位加东西，不该顶掉任何东西）
      const official = await cdpEval(ws, `(() => {
        const ta = document.querySelector('div[data-composer-input]') || document.querySelector('[contenteditable="true"]');
        return JSON.stringify({ composer: !!ta, sidebar: !!document.querySelector('[class*=sidebar],[class*=Sidebar]') });
      })()`);
      const off = JSON.parse(official);
      check("官方输入框仍然在（没有顶掉别人的槽位）", off.composer === true, `composer=${off.composer} sidebar=${off.sidebar}`);
    }

  } catch (e) {
    console.error("\n跑不下去：" + (e && e.message ? e.message : e));
    const log = readAppLog(env.userData);
    if (log.length) { console.error("\n── 外壳 shell.log 末 " + log.length + " 行 ──"); log.forEach((l) => console.error("  " + l)); }
    failures.push("运行异常: " + (e && e.message));
  } finally {
    try { child.kill(); } catch { }
    await sleep(800);
    try { child.kill("SIGKILL"); } catch { }
  }

  console.log("\n══════════════════════════════════════════");
  if (failures.length) {
    console.log(`结果：${failures.length} 项 FAIL`);
    failures.forEach((f) => console.log("  ✗ " + f));
  } else {
    console.log("结果：全部 PASS");
  }
  if (KEEP) console.log(`临时目录保留在：${env.base}`);
  else {
    try { fs.rmSync(env.base, { recursive: true, force: true }); console.log("临时目录已删除（要保留加 --keep）"); }
    catch (e) { console.log(`临时目录删不掉（可手工删）：${env.base} — ${e.message}`); }
  }
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error("环境/启动失败：" + (e && e.stack ? e.stack : e)); process.exit(2); });
