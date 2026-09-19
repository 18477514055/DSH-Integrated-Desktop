/**
 * boot-inspect.js —— 真启动内核，然后读前端页面，找"插件是否真的被加载"的正面证据。
 *
 * 为什么需要它：stderr 为空只是**反证**（2026-09-19 事故的教训：
 * "静态可解析 ≠ 动态可加载"，必须让目标行为真的发生）。
 * 本脚本做的是：真起内核 → 真拿 token → 真跟 303 拿 Cookie → 真读页面，
 * 看 5 个第三方插件的名字是否出现在引导载荷/资源清单里。
 *
 * 用法：node scripts/boot-inspect.js <DSH_HOME 绝对路径> <端口>
 */
const http = require("node:http");
const path = require("node:path");
const K = require(path.join(__dirname, "..", "src", "kernel.js"));

const DSH_HOME = process.argv[2];
const PORT = Number(process.argv[3] || 3113);
if (!DSH_HOME) { console.error("用法: node boot-inspect.js <DSH_HOME> [port]"); process.exit(1); }

const PLUGINS = [
  "dsh-whale-widget",
  "dsh-plugin-install",
  "@dsh-pet/bridge",
  "dsh-pet",
  "dsh-crosshub",
  "dsh-connect-workbuddy",
];
const BUILTIN = ["dsh-base", "dsh-web-app"];

function req(url, headers = {}) {
  return new Promise((resolve) => {
    const r = http.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on("error", (e) => resolve({ status: 0, headers: {}, body: "", error: e.code }));
    r.setTimeout(15000, () => { r.destroy(); resolve({ status: 0, headers: {}, body: "", error: "TIMEOUT" }); });
  });
}

(async () => {
  const kernel = K.discoverKernel();
  console.log("内核:", kernel.version, "| DSH_HOME:", DSH_HOME, "| 端口:", PORT);

  const spawned = K.spawnKernel({ kernel, dshHome: DSH_HOME, port: PORT, profile: "web",
    logDir: path.join(__dirname, "..", "runtime", "diag-logs") });

  try {
    const tokenUrl = await K.waitForUrl(spawned.logFile, spawned.child, 90000);
    if (!tokenUrl) { console.log("!! 内核没起来"); console.log(K.tailLog(spawned.logFile, 25)); return; }

    const origin = new URL(tokenUrl).origin;

    // 跟着 token URL 的 303 拿 Cookie
    const r1 = await req(tokenUrl);
    const setCookie = r1.headers["set-cookie"] || [];
    const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    console.log("token 请求 ->", r1.status, "| 拿到 Cookie:", cookie ? "是" : "否");

    const r2 = await req(origin + "/", cookie ? { Cookie: cookie } : {});
    console.log("带 Cookie 请求 / ->", r2.status, "| body 长度:", r2.body.length, "| 含 __DSH_BOOT__:", /__DSH_BOOT__/.test(r2.body));
    console.log("");

    // ① 引导载荷
    const i = r2.body.indexOf("__DSH_BOOT__");
    if (i >= 0) {
      const seg = r2.body.slice(i, i + 3000);
      console.log("── __DSH_BOOT__ 附近的原文（前 900 字）──");
      console.log(seg.slice(0, 900));
      console.log("");
    } else {
      console.log("!! 页面里没有 __DSH_BOOT__，可能拿到的是别的响应");
      console.log("── body 前 400 字 ──");
      console.log(r2.body.slice(0, 400));
      console.log("");
    }

    // ② 插件名的出现情况（这才是"是否被加载"的正面证据）
    console.log("── 各插件名在页面里的出现次数 ──");
    for (const p of [...PLUGINS, ...BUILTIN]) {
      const re = new RegExp(p.replace(/[/@.]/g, (m) => "\\" + m), "g");
      const n = (r2.body.match(re) || []).length;
      console.log(`   ${n > 0 ? "✅" : "❌"} ${p.padEnd(26)} ${n} 次`);
    }

    // ③ 内核 stderr 全文（唯一暴露 qoder 类故障的地方）
    const fs = require("node:fs");
    const errFile = spawned.logFile.replace(/\.log$/, ".err.log");
    let err = "";
    try { err = fs.readFileSync(errFile, "utf8"); } catch { /* 还没建 */ }
    console.log("");
    console.log("── 内核 stderr 全文 ──");
    console.log(err.trim() ? err : "(空)");
  } finally {
    K.killTree(spawned.child);
  }
})().catch((e) => { console.error("失败:", e); process.exitCode = 1; });
