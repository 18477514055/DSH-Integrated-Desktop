/**
 * ui-inspect.js —— 从外部读"真实运行的界面"，不改应用一行代码。
 *
 * 原理：Electron 支持 --remote-debugging-port；用 CDP（Chrome DevTools Protocol）
 * 连上去执行一段 JS，把渲染后的真实 DOM 文本取回来。
 *
 * 为什么这么做：这是唯一能回答"用户的会话到底出现在界面上没有"的**真实验证**
 * —— 不是"文件存在"，也不是"接口返回 200"，而是用户真正会看到的东西。
 *
 * 用法：
 *   1) 先带调试端口启动应用：
 *      electron.exe . --remote-debugging-port=9222
 *   2) node scripts/ui-inspect.js 9222
 */
const CDP_PORT = Number(process.argv[2] || 9222);

const EXPR = `(() => {
  const boot = window.__DSH_BOOT__;
  const text = (document.body ? document.body.innerText : "") || "";
  return JSON.stringify({
    title: document.title,
    href: location.href,
    hasBoot: !!boot,
    entryCount: boot && boot.entries ? boot.entries.length : 0,
    entryIds: boot && boot.entries ? boot.entries.map(e => e.id) : [],
    textLen: text.length,
    textHead: text.slice(0, 2500)
  });
})()`;

async function getTargets() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return r.json();
}

function cdp(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("CDP 超时")); }, 20000);
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error("WebSocket 错误: " + (e.message || "unknown"))); };
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1, method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.result && msg.result.exceptionDetails) {
        return reject(new Error("页面里执行报错: " + JSON.stringify(msg.result.exceptionDetails).slice(0, 300)));
      }
      resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
    };
  });
}

(async () => {
  if (typeof WebSocket === "undefined") {
    console.error("这个 node 没有全局 WebSocket，无法走 CDP"); process.exit(1);
  }
  const targets = await getTargets();
  const pages = targets.filter((t) => t.type === "page");
  console.log(`CDP 目标数: ${targets.length}，其中 page: ${pages.length}`);
  for (const t of pages) console.log(`   - ${t.title || "(无标题)"}  ${t.url}`);
  if (!pages.length) { console.error("没有 page 目标"); process.exit(1); }

  const target = pages.find((t) => /^https?:\/\/127\.0\.0\.1/.test(t.url)) || pages[0];
  console.log(`选中的目标: ${target.url}`);
  console.log("");

  const raw = await cdp(target.webSocketDebuggerUrl, EXPR);
  const info = JSON.parse(raw);
  console.log("标题      :", info.title);
  console.log("地址      :", info.href);
  console.log("__DSH_BOOT__ :", info.hasBoot, "| 客户端插件条目:", info.entryCount);
  console.log("界面文本长度:", info.textLen);
  console.log("");
  console.log("── 客户端插件条目 id ──");
  for (const id of info.entryIds) console.log("   " + id);
  console.log("");
  console.log("── 界面真实文本（前 2500 字）──");
  console.log(info.textHead);
})().catch((e) => { console.error("失败:", e.message); process.exitCode = 1; });
