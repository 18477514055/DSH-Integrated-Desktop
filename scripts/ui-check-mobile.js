"use strict";

/**
 * ui-check-mobile.js —— 真开一个浏览器，去看**手机端页面到底渲染成什么样**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须真看（而不是"代码里写了 titleOf()"）
 * ══════════════════════════════════════════════════════════════════
 * 用户报的是**界面**问题："所有会话都是代码开头，看不到标题"。
 * 这类问题**只有真渲染一次才能证实或证伪** —— 代码路径对、数据里有标题，
 * 都可能因为一个 DOM 层级/样式/时序问题而在屏幕上不出现。
 * 项目 AGENTS.md §5 那条"不变量"就是这么要求的：任何"生效了"的结论都要真跑证据。
 *
 * 本脚本用 Electron 开一个真窗口，指向**正在运行的那个插件实例**（默认 3110），
 * 走完配对 → 列表渲染，然后从 DOM 里**读真实文本**，并检查：
 *   ① 会话行显示的是**标题**而不是 sessionId
 *   ② 背景确实是**浅色**
 *   ③ **没有横向溢出**（用户报的"跳到屏幕框之外"）
 *   ④ 滚动层高度不超过视口（布局错位的典型症状）
 *
 * ★ 只读：只列会话、看页面，**不发任何提示词**。
 *
 * 用法：
 *   node scripts/ui-check-mobile.js              # 用默认 3110，按**真机逻辑尺寸** 375×834
 *   node scripts/ui-check-mobile.js --port 3182  # 指定别的实例（如临时环境）
 *   node scripts/ui-check-mobile.js --keep       # 保留窗口不关（肉眼看看）
 *   node scripts/ui-check-mobile.js --w 360 --h 800   # 换别的尺寸（如另一台手机）
 *   node scripts/ui-check-mobile.js --audit      # 额外打印一份"尺寸审计"（哪些元素偏大）
 *
 * ★ 默认尺寸来自**真机规格书**（不是随手写的）：
 *   `D:\DSH工作区002\3.dsh-mobile-remote\桌宠适配-真机规格书_Redmi-K70-Ultra_20260917.md`
 *     · 真实分辨率 **1220 × 2712 px**，密度 **520 dpi**，密度系数 **3.25**
 *     · ⇒ 逻辑尺寸 **375 × 834 dp**（该文档第 1 节速查表）
 *     · 系统 WebView = Chromium **131**，`sw375dp`，手势导航无导航栏，有挖孔
 *   **为什么必须按这个尺寸验**：以前默认用 420×860（凭感觉写的），比真机**宽 45px** ——
 *   窄屏上更早换行、内容更高，**"偏大/溢出"这类问题只有在 375 宽下才暴露**。
 *   教训与项目 AGENTS.md §5 那条"先证明尺子对，再报结论"是同一件事。
 *
 * 退出码：0 全过；1 有 FAIL；2 起不来。
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(val("--port", "3110"));
const CDP = Number(val("--cdp", "9351"));
const KEEP = argv.includes("--keep");
const AUDIT = argv.includes("--audit");
const OFFICIAL = val("--official", "http://127.0.0.1:3105");
// ★ 默认尺寸 = 真机逻辑尺寸（见文件头：规格书 375×834 dp）。之前默认 420×860 是凭感觉写的，
//   比真机宽 45px ⇒ 窄屏才暴露的"偏大/换行/溢出"问题被掩盖。
const WIN_W = Number(val("--w", "375"));
const WIN_H = Number(val("--h", "834"));

const failures = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures.push(`${name}: ${detail || ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${CDP}/json/list`);
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
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch { }
      if (m.result && m.result.exceptionDetails) {
        return reject(new Error("页面报错: " + JSON.stringify(m.result.exceptionDetails).slice(0, 300)));
      }
      resolve(m.result && m.result.result ? m.result.result.value : undefined);
    };
  });
}

(async () => {
  console.log("\n=== ui-check-mobile：真开一个页面看手机端渲染 ===");
  console.log(`  目标实例 : 127.0.0.1:${PORT}`);
  console.log(`  CDP 端口 : ${CDP}`);
  console.log(`  窗口尺寸 : ${WIN_W}×${WIN_H}  ← 真机逻辑尺寸（规格书：375×834 dp / 520dpi / ×3.25）\n`);

  // ── 取一个配对码 ──
  let code;
  try {
    const st = await (await fetch(`${OFFICIAL}/dsh-int-mobile-remote/state`)).json();
    code = st.data.code;
    console.log(`  拿到配对码 : ${code}`);
  } catch (e) {
    console.log(`✗ 读不到同源路由（${e.message}）⇒ 插件没在跑`);
    process.exit(2);
  }

  // ── 起一个真 Electron 窗口指向手机页面 ──
  const electronExe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
  if (!fs.existsSync(electronExe)) { console.log(`✗ 找不到 Electron: ${electronExe}`); process.exit(2); }

  const userData = path.join(ROOT, "runtime", "ui-check-mobile", String(Date.now()));
  fs.mkdirSync(userData, { recursive: true });

  // 一个极小的 Electron 壳：只开窗口加载目标 URL
  const shellJs = path.join(userData, "shell.js");
  fs.writeFileSync(shellJs, `
const { app, BrowserWindow } = require("electron");
app.commandLine.appendSwitch("remote-debugging-port", "${CDP}");
app.on("window-all-closed", () => app.quit());
app.whenReady().then(() => {
  const w = new BrowserWindow({
    width: ${WIN_W}, height: ${WIN_H}, show: ${KEEP ? "true" : "false"},
    useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  w.loadURL(process.argv[2]);
});
`, "utf8");
  fs.writeFileSync(path.join(userData, "package.json"), JSON.stringify({ name: "ui-check", main: "shell.js" }), "utf8");

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // ★ 不删的话 Electron 退化成纯 Node（AGENTS.md §6 那条）
  const targetUrl = `http://127.0.0.1:${PORT}/?c=${code}`;
  const child = spawn(electronExe, [userData, targetUrl], {
    cwd: ROOT, env, stdio: "ignore", windowsHide: !KEEP,
  });

  let ws = null;
  try {
    // 等页面
    let page = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try {
        const ts = await listTargets();
        page = ts.find((t) => t.type === "page" && t.url.includes(`:${PORT}`));
        if (page) break;
      } catch { }
      await sleep(400);
    }
    if (!page) throw new Error("等页面超时");
    ws = page.webSocketDebuggerUrl;
    await sleep(2500);   // 等配对与首次渲染

    // ── ① 会话行显示的是标题还是 sessionId ──
    const listRaw = await cdpEval(ws, `(() => {
      const rows = Array.from(document.querySelectorAll('.row'));
      return JSON.stringify({
        count: rows.length,
        sample: rows.slice(0, 8).map(r => {
          const t = r.querySelector('.row-title');
          const chips = Array.from(r.querySelectorAll('.chip')).map(c => c.textContent.trim());
          return { title: t ? t.textContent.trim() : null, chips };
        }),
      });
    })()`);
    const L = JSON.parse(listRaw);
    console.log(`\n── ① 会话列表（${L.count} 行）──`);
    for (const s of L.sample) console.log(`     「${s.title}」  ${s.chips.join(" | ")}`);

    check("会话列表渲染出了行", L.count > 0, `${L.count} 行`);
    // sessionId 形如 session-xxxxxxxx-…；标题不该长这样
    const looksLikeId = (t) => !!t && /^session-|^[0-9a-f]{8}-[0-9a-f]{4}/i.test(t);
    const titled = L.sample.filter((s) => s.title && !looksLikeId(s.title)).length;
    check("行标题是人看得懂的文字（不是 sessionId）",
      titled >= Math.min(3, L.sample.length),
      `${titled}/${L.sample.length} 行是标题`);

    // ── ② 浅色背景 ──
    const themeRaw = await cdpEval(ws, `(() => {
      const b = getComputedStyle(document.body).backgroundColor;
      const m = b.match(/\\d+/g) || [];
      const [r, g, bl] = m.map(Number);
      const lum = (0.299*r + 0.587*g + 0.114*bl);
      return JSON.stringify({ body: b, lum: Math.round(lum), pairBg: getComputedStyle(document.documentElement).backgroundColor });
    })()`);
    const T = JSON.parse(themeRaw);
    console.log(`\n── ② 主题 ──\n     body 背景 ${T.body}（亮度 ${T.lum}/255）`);
    check("背景是浅色（亮度 > 200）", T.lum > 200, `${T.body} 亮度 ${T.lum}`);

    // ── ③ 没有横向溢出 ──
    const overflowRaw = await cdpEval(ws, `(() => {
      const de = document.documentElement;
      const wide = [];
      for (const n of document.querySelectorAll('*')) {
        const r = n.getBoundingClientRect();
        if (r.width > 0 && r.right > window.innerWidth + 1) {
          wide.push((n.className || n.tagName) + ' right=' + Math.round(r.right));
        }
      }
      return JSON.stringify({
        scrollW: de.scrollWidth, innerW: window.innerWidth,
        bodyScrollW: document.body.scrollWidth,
        offenders: wide.slice(0, 6),
      });
    })()`);
    const O = JSON.parse(overflowRaw);
    console.log(`\n── ③ 横向溢出 ──\n     documentElement.scrollWidth=${O.scrollW}  innerWidth=${O.innerW}`);
    if (O.offenders.length) console.log("     越界元素: " + O.offenders.join(" | "));
    check("页面没有横向滚动（scrollWidth ≤ innerWidth+1）",
      O.scrollW <= O.innerW + 1, `scrollWidth=${O.scrollW} vs innerWidth=${O.innerW}`);

    // ── ③b 图标必须是 SVG，不能是 emoji ──
    //
    // 用户原话："右下角的那两个神秘小图标看着很奇怪，就不知道是干什么用的"。
    // 真因是 emoji 由**系统字体**渲染（颜色/粗细/字形随手机变，有的成黑白方框）。
    // 所以这里查的是"到底渲染成了 SVG 还是文字"——只看 HTML 里写了 svg 不算，
    // 要问 DOM 里**真的**有没有 SVG 节点，且里面没有 emoji 字符。
    const iconRaw = await cdpEval(ws, `(() => {
      const ids = ['imageBtn','historyBtn','modelBtn','cancelBtn','backBtn','refreshBtn','newSessionBtn','menuBtn'];
      const out = {};
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) { out[id] = null; continue; }
        const svg = el.querySelector('svg');
        const txt = (el.textContent || '').trim();
        // 常见 emoji 区段（够用了：本插件原来用的是 🖼 U+1F5BC / 🕘 U+1F558 等）
        const hasEmoji = /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{FE0F}]/u.test(txt);
        out[id] = { hasSvg: !!svg, svgPaths: svg ? svg.querySelectorAll('path,rect,circle,line,polyline').length : 0, text: txt, hasEmoji: hasEmoji };
      }
      return JSON.stringify(out);
    })()`);
    const IC = JSON.parse(iconRaw);
    console.log(`\n── ③b 图标（应为 SVG，不该是 emoji）──`);
    for (const [id, v] of Object.entries(IC)) {
      if (!v) { console.log(`     ${id}: (页面上没有这个按钮，跳过)`); continue; }
      console.log(`     ${id}: svg=${v.hasSvg} 图元=${v.svgPaths} 文本="${v.text}" emoji=${v.hasEmoji}`);
    }
    const iconsPresent = Object.values(IC).filter(Boolean);
    check("发图片 / 历史 两个按钮存在",
      !!IC.imageBtn && !!IC.historyBtn, `imageBtn=${!!IC.imageBtn} historyBtn=${!!IC.historyBtn}`);
    check("图标是内联 SVG（不是 emoji 文字）",
      iconsPresent.length > 0 && iconsPresent.every((v) => v.hasSvg),
      iconsPresent.filter((v) => !v.hasSvg).length + " 个不是 SVG");
    check("图标里没有任何 emoji 字符",
      iconsPresent.every((v) => !v.hasEmoji),
      iconsPresent.filter((v) => v.hasEmoji).map((v) => v.text).join("|") || "(无)");
    check("SVG 真的画了图元（不是空 svg 占位）",
      iconsPresent.every((v) => v.svgPaths > 0),
      iconsPresent.map((v) => v.svgPaths).join(","));

    // ── ③c 键盘：visualViewport 跟随后，body 必须跟着缩 ──
    //
    // 用户报："点击输入框弹出键盘之后，键盘会把那个输入框挡住，整个页面也会被挡住一半。"
    // 真因：Android 15 强制 edge-to-edge ⇒ adjustResize 失效 ⇒ 键盘是**盖**上来的。
    // 解法是 app.js 的 syncViewport() 把 visualViewport.height 写进 `--app-h`。
    // 桌面 Electron 里没有软键盘，所以**不能**等真键盘；
    // 这里直接：① 确认 `--app-h` 被设置成了当前可视高度；
    //          ② 手工把它改小（模拟键盘占了 300px），看 body 是否真的跟着变矮 ——
    //             这验证的是"CSS 确实用了这个变量"，也就是那条修复链的后半段。
    const kbRaw = await cdpEval(ws, `(() => {
      const root = document.documentElement;
      const vv = window.visualViewport;
      const before = {
        appH: root.style.getPropertyValue('--app-h'),
        bodyH: Math.round(document.body.getBoundingClientRect().height),
        vvH: vv ? Math.round(vv.height) : null,
      };
      // 模拟键盘：把 --app-h 压到 60%
      const small = Math.round((vv ? vv.height : window.innerHeight) * 0.6);
      root.style.setProperty('--app-h', small + 'px');
      const shrunk = Math.round(document.body.getBoundingClientRect().height);
      // 复位
      if (before.appH) root.style.setProperty('--app-h', before.appH);
      else root.style.removeProperty('--app-h');
      const restored = Math.round(document.body.getBoundingClientRect().height);
      return JSON.stringify({ before, small, shrunk, restored });
    })()`);
    const K = JSON.parse(kbRaw);
    console.log(`\n── ③c 键盘适配（visualViewport → --app-h）──`);
    console.log(`     JS 写入的 --app-h = "${K.before.appH}"（visualViewport 高 ${K.before.vvH}）`);
    console.log(`     把 --app-h 改成 ${K.small}px 后 body 高 ${K.before.bodyH} → ${K.shrunk}（复位后 ${K.restored}）`);
    check("app.js 真的把可视高度写进了 --app-h",
      !!K.before.appH && /^\d+px$/.test(K.before.appH.trim()), `"${K.before.appH}"`);
    check("--app-h 变小后 body 真的跟着变矮（键盘能顶起输入框）",
      K.shrunk < K.before.bodyH - 20, `bodyH ${K.before.bodyH} → ${K.shrunk}`);
    check("改回去后 body 恢复原高度",
      Math.abs(K.restored - K.before.bodyH) <= 2, `${K.restored} vs ${K.before.bodyH}`);

    // ── ③d 工具调用 / 思考过程：必须默认**折叠** ──
    //
    // 用户原话："电脑上还有完整的调用工具和思考过程，这些像电脑那样子做成折叠的样式会好一点。"
    //
    // ★ 判据不能是"代码里写了 details" —— 要问 DOM。
    //   而且**必须真打开一个会话**：列表页上根本没有消息，直接查会得到 0 个
    //   ⇒ 那种断言是空转（第一版就是这么写的，永远 PASS，等于没验）。
    //   所以这一段：点进第一个会话 → 等消息与工具卡渲染出来 → 再查。
    const opened = await cdpEval(ws, `(async () => {
      const row = document.querySelector('.row');
      if (!row) return JSON.stringify({ ok: false, why: '没有会话行' });
      row.click();
      // 等"详情视图出现且消息流里有东西"
      const t0 = Date.now();
      let msgs = 0, tools = 0, thinks = 0;
      while (Date.now() - t0 < 25000) {
        await new Promise(r => setTimeout(r, 400));
        const mv = document.getElementById('detailView');
        if (!mv || mv.classList.contains('hidden')) continue;
        msgs = document.querySelectorAll('#messages > *').length;
        tools = document.querySelectorAll('details.tool').length;
        thinks = document.querySelectorAll('details.think').length;
        // 有工具卡或思考块就够验折叠了；否则等到消息稳定
        if (tools + thinks > 0) break;
        if (msgs > 0 && Date.now() - t0 > 8000) break;
      }
      const toolEls = Array.from(document.querySelectorAll('details.tool'));
      const thinkEls = Array.from(document.querySelectorAll('details.think'));
      const notDetails = Array.from(document.querySelectorAll('.tool, .think'))
        .filter(n => n.tagName !== 'DETAILS').length;
      // 收起时的高度：验证"收起后确实只占一行"（这才是折叠的意义）
      const collapsedH = toolEls.length ? Math.round(toolEls[0].getBoundingClientRect().height) : null;
      let openH = null;
      if (toolEls.length) {
        toolEls[0].setAttribute('open', '');
        openH = Math.round(toolEls[0].getBoundingClientRect().height);
        toolEls[0].removeAttribute('open');
      }
      return JSON.stringify({
        ok: true, msgs, tools: toolEls.length, thinks: thinkEls.length,
        toolsOpen: toolEls.filter(d => d.hasAttribute('open')).length,
        thinksOpen: thinkEls.filter(d => d.hasAttribute('open')).length,
        notDetails, collapsedH, openH,
        hasToolCss: !!Array.from(document.styleSheets).some(ss => {
          try { return Array.from(ss.cssRules).some(r => r.selectorText && r.selectorText.includes('details.tool')); }
          catch (e) { return false; }
        }),
        hasThinkCss: !!Array.from(document.styleSheets).some(ss => {
          try { return Array.from(ss.cssRules).some(r => r.selectorText && r.selectorText.includes('.think')); }
          catch (e) { return false; }
        }),
      });
    })()`);
    const F = JSON.parse(opened);
    console.log(`\n── ③d 折叠（真打开一个会话后）──`);
    console.log(`     消息 ${F.msgs} 条  工具卡 ${F.tools} 个（默认展开 ${F.toolsOpen}）  思考块 ${F.thinks} 个（默认展开 ${F.thinksOpen}）`);
    if (F.collapsedH !== null) console.log(`     工具卡收起 ${F.collapsedH}px → 展开 ${F.openH}px`);
    console.log(`     仍是旧式 div 的: ${F.notDetails} 个   折叠样式已加载: ${F.hasToolCss}/${F.hasThinkCss}`);
    check("会话详情真的打开了（不是空转）", F.ok === true && F.msgs > 0,
      F.ok ? `${F.msgs} 条消息` : String(F.why));
    check("工具卡用 <details>（浏览器原生折叠，不是旧的 div）",
      F.notDetails === 0, `${F.notDetails} 个不是 details`);
    check("工具卡默认**不展开**", F.tools === 0 || F.toolsOpen === 0,
      `${F.toolsOpen}/${F.tools} 个展开了`);
    check("思考块默认**不展开**", F.thinks === 0 || F.thinksOpen === 0,
      `${F.thinksOpen}/${F.thinks} 个展开了`);
    check("工具卡折叠后确实更矮（展开会变高）",
      F.collapsedH === null || F.openH === null || F.openH > F.collapsedH,
      `${F.collapsedH}px → ${F.openH}px`);
    check("折叠样式已真的加载", F.hasToolCss === true && F.hasThinkCss === true,
      `tool=${F.hasToolCss} think=${F.hasThinkCss}`);

    // ── ③e 输入区实测（**必须趁在详情页时量**）──
    //
    // 详情页的输入框在列表页是 hidden（宽度量出来是 0）——
    // 第一版把审计放在"返回列表之后"，于是输入框宽度恒为 0、报了一个假 FAIL。
    // 正确做法：在哪个页面，就量哪个页面的东西。
    const composerRaw = await cdpEval(ws, `(() => {
      const px = (n) => Math.round(n);
      const q = (s) => document.querySelector(s);
      const rect = (s) => { const e = q(s); return e ? e.getBoundingClientRect() : null; };
      const cs = (s) => { const e = q(s); return e ? getComputedStyle(e) : null; };
      const bar = rect('#promptForm');
      const inp = rect('#promptInput');
      const btns = ['#imageBtn','#historyBtn','#sendBtn'].map(s => {
        const b = rect(s); return b ? { id: s, w: px(b.width), h: px(b.height) } : null;
      }).filter(Boolean);
      return JSON.stringify({
        winW: window.innerWidth, winH: window.innerHeight,
        barH: bar ? px(bar.height) : 0,
        inputW: inp ? px(inp.width) : 0,
        inputH: inp ? px(inp.height) : 0,
        inputFont: cs('#promptInput') ? cs('#promptInput').fontSize : null,
        btns,
        placeholder: q('#promptInput') ? q('#promptInput').getAttribute('placeholder') : null,
        sendText: q('#sendBtn') ? q('#sendBtn').textContent.trim() : null,
      });
    })()`);
    const CB = JSON.parse(composerRaw);
    console.log(`\n── ③e 输入区（详情页实测）──`);
    console.log(`     输入框 ${CB.inputW}×${CB.inputH}px（字号 ${CB.inputFont}）　输入条高 ${CB.barH}px`);
    console.log(`     按钮: ` + CB.btns.map(t => `${t.id.replace('#','')} ${t.w}×${t.h}`).join(", ")
      + `　发送键文字「${CB.sendText}」`);
    const smallComposer = CB.btns.filter(t => t.h < 40 || t.w < 40);
    check("输入框宽度没被按钮挤到不足 一半屏宽",
      CB.inputW >= CB.winW * 0.5, `${CB.inputW} vs 半屏 ${Math.round(CB.winW / 2)}`);
    check("输入区按钮都不小于 40×40", smallComposer.length === 0,
      smallComposer.map(t => `${t.id} ${t.w}×${t.h}`).join(", ") || `(${CB.btns.map(t=>t.w+"×"+t.h).join("/")})`);

    // 详情页的信息密度：一屏能看到多少条消息（含折叠卡）
    const detailRaw = await cdpEval(ws, `(() => {
      const px = (n) => Math.round(n);
      const box = document.querySelector('#messages');
      const kids = Array.from(box.children);
      const heights = kids.map(k => k.getBoundingClientRect().height).filter(h => h > 0);
      const avg = heights.length ? Math.round(heights.reduce((a,b)=>a+b,0)/heights.length) : 0;
      const vis = box.clientHeight;
      // 折叠卡占比：一屏里有多少像素是"收起的一行卡"（信息被藏起来的量）
      const collapsed = Array.from(document.querySelectorAll('details.tool:not([open]),details.think:not([open])'))
        .reduce((a, d) => a + d.getBoundingClientRect().height, 0);
      const bubbleCs = document.querySelector('.bubble.ai') ? getComputedStyle(document.querySelector('.bubble.ai')) : null;
      // ★ 分组情况（本轮加的关键指标）：组数、组内卡数、整组收起后占多高
      const groups = Array.from(document.querySelectorAll('details.toolgroup'));
      const groupInfo = groups.map(g => ({
        tools: g.querySelectorAll('details.tool').length,
        thinks: g.querySelectorAll('details.think').length,
        open: g.hasAttribute('open'),
        h: px(g.getBoundingClientRect().height),
        title: (g.querySelector('.toolgroup-title') || {}).textContent || '',
      }));
      // 组内所有卡片的**合计**高度（= 如果不分组会占多少）
      const looseH = Array.from(document.querySelectorAll('details.tool, details.think'))
        .reduce((a, d) => a + d.getBoundingClientRect().height, 0);
      const groupH = groups.reduce((a, g) => a + g.getBoundingClientRect().height, 0);
      return JSON.stringify({
        msgH: vis, avgItem: avg, count: kids.length,
        perScreen: avg ? Math.floor(vis / avg) : 0,
        collapsedPx: px(collapsed), collapsedPct: vis ? Math.round(collapsed / vis * 100) : 0,
        bubbleFont: bubbleCs && bubbleCs.fontSize, bubbleMaxW: bubbleCs && bubbleCs.maxWidth,
        bodyW: document.documentElement.clientWidth,
        groups: groupInfo, groupCount: groups.length,
        groupsOpen: groupInfo.filter(g => g.open).length,
        looseTotal: px(looseH), groupTotal: px(groupH),
        groupToolsTotal: groupInfo.reduce((a, g) => a + g.tools, 0),
        groupThinksTotal: groupInfo.reduce((a, g) => a + g.thinks, 0),
        notGrouped: Array.from(document.querySelectorAll('#messages > details.tool, #messages > details.think')).length,
      });
    })()`);
    const DT = JSON.parse(detailRaw);
    console.log(`\n── ③f 消息区（详情页实测）──`);
    console.log(`     可视高 ${DT.msgH}px，平均每条 ${DT.avgItem}px ⇒ 一屏约 **${DT.perScreen} 条**（共 ${DT.count} 条）`);
    console.log(`     折叠卡在正文里占 ${DT.collapsedPx}px（= 消息区可视高的 ${DT.collapsedPct}%）`);
    console.log(`     气泡字号 ${DT.bubbleFont}，最大宽 ${DT.bubbleMaxW}（正文可用宽 ${DT.bodyW}px）`);
    console.log(`\n── ③g 工具/思考分组（本轮按真机尺寸新加的优化）──`);
    console.log(`     组数 ${DT.groupCount}（默认展开 ${DT.groupsOpen}）　`
      + `组内: 工具 ${DT.groupToolsTotal} + 思考 ${DT.groupThinksTotal}`);
    for (const g of DT.groups.slice(0, 6)) {
      console.log(`       「${g.title}」 工具${g.tools} 思考${g.thinks} 高${g.h}px${g.open ? " (展开)" : ""}`);
    }
    if (DT.groups.length > 6) console.log(`       …还有 ${DT.groups.length - 6} 组`);
    console.log(`     分组前合计 ${DT.looseTotal}px → 分组后合计 ${DT.groupTotal}px`
      + `（省 ${DT.looseTotal ? Math.round((1 - DT.groupTotal / DT.looseTotal) * 100) : 0}%）`);
    check("工具/思考被合并成组（不是逐个平铺）",
      DT.groupCount > 0 && DT.notGrouped === 0,
      `组数 ${DT.groupCount}，裸卡 ${DT.notGrouped}`);
    check("组默认**全部收起**", DT.groupsOpen === 0, `${DT.groupsOpen}/${DT.groupCount} 展开了`);
    // ★ 下面两条**故意写成条件式**，因为脚本点的是列表第一行 —— 而"第一个会话"
    //   随时会变（新会话、别的会话在跑）。遇到一个只有一两个工具卡的短会话，
    //   "省 50%"自然不成立。第一版把它们写成硬阈值，连跑 3 次全过、第 4 次 FAIL ——
    //   典型的 flaky 尺子（flaky 的判据比没有判据更糟：会让人不再相信 FAIL）。
    //   真正稳的判据是上面那两条：**没有裸卡** + **默认全收起** ——
    //   分组一旦坏掉（卡片被直接塞进 #messages），notGrouped 立刻 > 0。
    const manyItems = (DT.groupToolsTotal + DT.groupThinksTotal) >= 4;
    if (manyItems) {
      check("分组后显著变矮（至少省 50%）",
        DT.groupTotal <= DT.looseTotal * 0.5,
        `${DT.looseTotal}px → ${DT.groupTotal}px（${DT.groupToolsTotal} 工具 + ${DT.groupThinksTotal} 思考）`);
    } else {
      console.log(`  SKIP  分组压缩比（本会话只有 ${DT.groupToolsTotal + DT.groupThinksTotal} 个卡/块，样本太小）`);
    }
    console.log(`  · 本次会话：${DT.groupToolsTotal + DT.groupThinksTotal} 个卡/块 → ${DT.groupCount} 组；`
      + `一屏约 ${DT.perScreen} 条消息（此项随会话变化，仅作参考）`);

    // 回到列表，后面的布局断言仍按列表页检查
    await cdpEval(ws, `(() => { const b = document.getElementById('backBtn'); if (b) b.click(); return 1; })()`);
    await sleep(900);

    // ── ④ 滚动层不超出视口（"错位/跳出屏幕"的典型症状）──
    const layoutRaw = await cdpEval(ws, `(() => {
      const list = document.getElementById('sessionList');
      const r = list ? list.getBoundingClientRect() : null;
      return JSON.stringify({
        innerH: window.innerHeight,
        bodyH: document.body.getBoundingClientRect().height,
        listBottom: r ? Math.round(r.bottom) : null,
        listTop: r ? Math.round(r.top) : null,
        listScrollH: list ? list.scrollHeight : null,
        listClientH: list ? list.clientHeight : null,
      });
    })()`);
    const Y = JSON.parse(layoutRaw);
    console.log(`\n── ④ 布局 ──`);
    console.log(`     视口高 ${Y.innerH}  body 高 ${Math.round(Y.bodyH)}  列表 ${Y.listTop}→${Y.listBottom}`);
    console.log(`     列表内容 ${Y.listScrollH} / 可视 ${Y.listClientH}（内容高于可视=正常，内部滚动）`);
    check("列表底部不超出视口", Y.listBottom !== null && Y.listBottom <= Y.innerH + 1,
      `listBottom=${Y.listBottom} innerHeight=${Y.innerH}`);
    check("body 高度不超过视口（没有把页面撑长）",
      Math.round(Y.bodyH) <= Y.innerH + 1, `bodyH=${Math.round(Y.bodyH)} innerH=${Y.innerH}`);

    // ── ⑤ 尺寸审计：在**真机尺寸**下量"到底哪里偏大" ──
    //
    // 用户反馈"手机上这个界面有点偏大"。笼统的"偏大"没法改，必须拆成数字：
    // 触控目标够不够大（<40px 不好点）、字够不够小、每行装得下多少字、
    // 固定高度条占了多少屏、正文可用宽剩多少。
    //
    // 参考线（Android 官方 Material 指南）：可点目标 ≥ **48dp**；
    // 在 375dp 宽屏上，正文 15–16px 是舒服区间，`16px` 在 375 宽下每行约 21 个汉字。
    const auditRaw = await cdpEval(ws, `(() => {
      const px = (n) => Math.round(n);
      const r = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect() : null; };

      // ① 可点目标尺寸（<40px 的点起来费劲）
      //    ★ 只量**可见**元素：详情页的按钮在列表页是 hidden、宽度为 0，
      //      把它们算进来会得到一堆假 FAIL（第一版就是这么错的）。
      const targets = [];
      for (const sel of ['#imageBtn','#historyBtn','#sendBtn','#backBtn','#modelBtn','#cancelBtn',
                         '#refreshBtn','#newSessionBtn','#menuBtn','#searchInput','#promptInput']) {
        const e = document.querySelector(sel);
        if (!e) continue;
        const b = e.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;    // 不可见 ⇒ 跳过
        if (e.offsetParent === null && getComputedStyle(e).position !== 'fixed') continue;
        targets.push({ id: sel, w: px(b.width), h: px(b.height) });
      }
      const small = targets.filter(t => t.h > 0 && (t.h < 40 || t.w < 40));

      // ② 固定高度条各占多少（顶栏 / 搜索栏 / 输入区 / 审批条 / 横幅）
      const bars = {};
      for (const [k, sel] of [['顶栏','.bar'],['搜索栏','.searchbar'],['输入区','#promptForm'],
                              ['附件条','#attachBar'],['审批条','#approvalBar'],['横幅','#hostBanner']]) {
        const b = r(sel);
        bars[k] = b && b.height > 0 ? px(b.height) : 0;
      }
      const barsTotal = Object.values(bars).reduce((a, b) => a + b, 0);

      // ③ 正文与字号
      const cs = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
      const rowTitle = cs('.row-title'), rowMeta = cs('.row-meta'), chip = cs('.chip'),
            prompt = cs('#promptInput'), barTitle = cs('.bar-title'), detailTitle = cs('#detailTitle');
      const msgCs = cs('.bubble.ai');

      // ④ 每行能装多少字
      const bodyW = document.documentElement.clientWidth;
      const pEl = document.querySelector('#promptInput');
      const promptW = (pEl && pEl.getBoundingClientRect().width) ? px(pEl.getBoundingClientRect().width) : 0;
      const fontPx = parseFloat(getComputedStyle(document.body).fontSize);

      // ⑤ 会话行有多高（列表信息密度）
      const rows = Array.from(document.querySelectorAll('.row'));
      const rowHeights = rows.slice(0, 20).map(x => px(x.getBoundingClientRect().height));
      const avgRow = rowHeights.length ? Math.round(rowHeights.reduce((a,b)=>a+b,0)/rowHeights.length) : 0;
      const listEl = document.querySelector('#sessionList');
      const listH = listEl ? px(listEl.clientHeight) : 0;

      return JSON.stringify({
        innerW: window.innerWidth, innerH: window.innerHeight, dpr: window.devicePixelRatio,
        bodyW, fontPx,
        targets, small,
        bars, barsTotal, barsPct: Math.round(barsTotal / window.innerHeight * 100),
        fonts: {
          rowTitle: rowTitle && rowTitle.fontSize, rowMeta: rowMeta && rowMeta.fontSize,
          chip: chip && chip.fontSize, prompt: prompt && prompt.fontSize,
          barTitle: barTitle && barTitle.fontSize, detailTitle: detailTitle && detailTitle.fontSize,
          bubble: msgCs && msgCs.fontSize,
        },
        rowH: avgRow, rowCount: rows.length, listH,
        rowsVisible: avgRow ? Math.floor(listH / avgRow) : 0,
        promptW,
      });
    })()`);
    const A = JSON.parse(auditRaw);
    console.log(`\n── ⑤ 尺寸审计（真机 ${A.innerW}×${A.innerH}，dpr ${A.dpr}）──`);
    console.log(`     字体基准 ${A.fontPx}px　正文可用宽 ${A.bodyW}px　输入框宽 ${A.promptW}px`);
    console.log(`     字号: 会话标题 ${A.fonts.rowTitle} / 元信息 ${A.fonts.rowMeta} / 胶囊 ${A.fonts.chip}`
      + ` / 顶栏标题 ${A.fonts.barTitle} / 详情标题 ${A.fonts.detailTitle} / 气泡 ${A.fonts.bubble}`);
    console.log(`     固定条合计 ${A.barsTotal}px = 屏高 ${A.barsPct}%　`
      + Object.entries(A.bars).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(" / "));
    console.log(`     会话行平均 ${A.rowH}px，列表可视 ${A.listH}px ⇒ **一屏能看到 ${A.rowsVisible} 行**（共 ${A.rowCount} 行）`);
    console.log(`     可点目标: ` + A.targets.map(t => `${t.id.replace('#','')} ${t.w}×${t.h}`).join(", "));
    if (A.small.length) console.log(`     ⚠ 偏小的（<40px）: ` + A.small.map(t => `${t.id} ${t.w}×${t.h}`).join(", "));

    // 不设"必须多大"的硬断言（那是设计取舍，不是对错），只把数字摆出来 + 三条下限
    check("可点目标都不小于 40×40（Android 建议 48dp，这里放宽到 40 作下限）",
      A.small.length === 0, A.small.map(t => `${t.id} ${t.w}×${t.h}`).join(", ") || "(全部达标)");
    check("一屏至少能看到 5 个会话行（信息密度下限）",
      A.rowsVisible >= 5, `${A.rowsVisible} 行（行高 ${A.rowH}px / 可视 ${A.listH}px）`);

    console.log("");
  } catch (e) {
    check("UI 检查流程未抛异常", false, e && e.message);
  } finally {
    if (!KEEP) {
      try { child.kill(); } catch { }
      try { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { }
      await sleep(800);
      try { fs.rmSync(userData, { recursive: true, force: true }); } catch { }
    } else {
      console.log(`  · 窗口保留着（--keep）：${userData}`);
    }
  }

  if (failures.length) {
    console.log(`结果：${failures.length} 项 FAIL`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log("");
    process.exit(1);
  }
  console.log("结果：全部 PASS\n");
  process.exit(0);
})().catch((e) => { console.error("失败：" + (e && e.stack ? e.stack : e)); process.exit(2); });
