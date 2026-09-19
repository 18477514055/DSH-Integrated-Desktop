/**
 * 探活诊断：真启动一个内核，然后对「带 token」与「不带 token」两种 URL 发原始请求，
 * 把 statusCode / location / body 头 200 字符原样打出来。
 *
 * 目的：搞清楚 probeDsh 为什么对带 token 的地址判成 "other"（探活假阴性）。
 * 用法：node scripts/probe-diag.js [port]
 *
 * ⚠️ 只读诊断：不改配置、不碰 ~/.dsh（DSH_HOME 强制为本项目 runtime/dsh-home）。
 */
const http = require("node:http");
const path = require("node:path");
const K = require(path.join(__dirname, "..", "src", "kernel.js"));

const PORT = Number(process.argv[2] || 3111);
const ROOT = path.join(__dirname, "..");
const DSH_HOME = path.join(ROOT, "runtime", "dsh-home");

function raw(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({
        url,
        status: res.statusCode,
        location: res.headers.location || null,
        setCookie: res.headers["set-cookie"] ? "(有)" : null,
        ctype: res.headers["content-type"] || null,
        bodyHead: body.slice(0, 200).replace(/\s+/g, " "),
        bodyLen: body.length,
        hasBoot: /__DSH_BOOT__/.test(body),
        hasName: /DeepSeek Harness/.test(body),
      }));
    });
    req.on("error", (e) => resolve({ url, error: e.code || e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ url, error: "TIMEOUT" }); });
  });
}

(async () => {
  const kernel = K.discoverKernel();
  console.log("内核:", kernel.dir, kernel.version);
  console.log("DSH_HOME:", DSH_HOME);
  console.log("端口:", PORT);
  console.log("");

  const spawned = K.spawnKernel({
    kernel,
    dshHome: DSH_HOME,
    port: PORT,
    profile: "web",
    logDir: path.join(ROOT, "runtime", "diag-logs"),
  });

  let url = null;
  try {
    url = await K.waitForUrl(spawned.logFile, spawned.child, 90000);
    if (!url) {
      console.log("!! 内核没打印地址，日志尾：");
      console.log(K.tailLog(spawned.logFile, 30));
      return;
    }
    console.log("内核地址(带 token):", url);
    console.log("");

    const origin = new URL(url).origin;
    const targets = [
      url,                              // 带 token 的完整地址（main.js 探活用的就是这个）
      origin + "/",                     // 裸根路径
      origin + "/?token=" + new URL(url).searchParams.get("token"),
      origin + "/index.html",
    ];

    for (const t of targets) {
      const r = await raw(t);
      console.log("── 请求:", t.replace(/token=[^&]+/, "token=***"));
      console.log("   ", JSON.stringify(r, null, 2).replace(/\n/g, "\n    "));
      // 顺带看看 probeDsh 怎么判
      const v = await K.probeDsh(t, 6000);
      console.log("    probeDsh 判定 =", v);
      console.log("");
    }

    // 再对 401/403 场景做个对照：去掉 token
    console.log("── probeDsh 对裸根路径:", await K.probeDsh(origin + "/", 6000));

    // ★ 模拟真实探活循环：连续 5 次探 healthTargetUrl，必须次次 alive
    const target = K.healthTargetUrl(url);
    console.log("");
    console.log("── 模拟探活循环（真实 startHealthWatch 用的地址）:", target);
    for (let i = 1; i <= 5; i++) {
      const v = await K.probeDsh(target, 6000);
      console.log(`   第 ${i} 次: 判定=${v} alive=${K.isProbeAlive(v)}`);
    }
  } finally {
    K.killTree(spawned.child);
    console.log("");
    console.log("内核已结束。");
  }
})().catch((e) => { console.error("诊断失败:", e); process.exitCode = 1; });
