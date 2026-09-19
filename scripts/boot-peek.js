/**
 * boot-peek.js —— 对着**已经在跑的内核**只读取一次引导载荷，看前端拿到了什么。
 *
 * 为什么需要它：`boot-inspect.js` 会**另起一个内核**才能看到这些；
 * 而本机日常有一个内核在跑（用户的客户端），我们只想**看一眼**，不想再起一个。
 * 做法：读外壳留下的 `kernel.json`（里面是带 token 的地址）→ 跟 303 拿 Cookie → GET /。
 *
 * 全程只读：不写 home、不写 profile、不碰会话；只是把内核本来就会发给浏览器的
 * 那份 HTML 再要一次，然后从中抽三样东西：
 *   ① `__DSH_BOOT__` 这个 JSON 载荷的**键**（前端拿到了什么）
 *   ② 里面列出的**客户端插件 id**（= 哪些插件的 lib/client.js 会被加载）
 *   ③ 插件名在整份 HTML 里出现的位置（正面的"确实被列进去了"证据）
 *
 * 用法：
 *   node scripts/boot-peek.js                     # 自动找 %APPDATA%\DSH Integrated\kernel.json
 *   node scripts/boot-peek.js <kernel.json 路径>
 *   node scripts/boot-peek.js --raw               # 额外打印载荷前 1200 字（默认不打印）
 */
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const RAW = process.argv.includes("--raw");
const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const RECORD = arg || path.join(os.homedir(), "AppData", "Roaming", "DSH Integrated", "kernel.json");

function get(url, headers = {}) {
  return new Promise((resolve) => {
    const r = http.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on("error", (e) => resolve({ status: 0, headers: {}, body: "", error: e.code }));
    r.setTimeout(20000, () => { r.destroy(); resolve({ status: 0, headers: {}, body: "", error: "TIMEOUT" }); });
  });
}

/** 从一段 JS 里抠出 `__DSH_BOOT__ = {...}` 的 JSON 文本（按花括号配平，跳过字符串内的括号）。 */
function extractBootJson(html, at) {
  const eq = html.indexOf("=", at);
  if (eq < 0) return null;
  const start = html.indexOf("{", eq);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false, quote = "";
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  return null;
}

(async () => {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(RECORD, "utf8"));
  } catch (e) {
    console.error("读不到 kernel.json:", RECORD, "|", e.code || e.message);
    console.error("⇒ 说明现在没有本外壳留下的内核记录（客户端没在跑 / 用的不是本外壳）。");
    process.exit(2);
  }
  // ★ 凭据纪律：url 里带 token，回显前打码（本脚本的输出会被贴进对话/日志）
  const masked = JSON.stringify(rec, null, 2).replace(/(token=)[A-Za-z0-9._~-]+/g, "$1<已打码>");
  console.log("记录文件 :", RECORD);
  console.log("记录内容 :", masked.split("\n").slice(0, 12).join("\n"));

  const tokenUrl = rec.url || rec.serverUrl || rec.tokenUrl;
  if (!tokenUrl) { console.error("!! 记录里没有 url 字段，无法继续"); process.exit(2); }
  const origin = new URL(tokenUrl).origin;

  const r1 = await get(tokenUrl);
  const cookie = (r1.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
  console.log("\ntoken 请求:", r1.status, "| Cookie:", cookie ? "有" : "无");

  const r2 = await get(origin + "/", cookie ? { Cookie: cookie } : {});
  console.log("GET / :", r2.status, "| HTML 长度:", r2.body.length);

  const at = r2.body.indexOf("__DSH_BOOT__");
  if (at < 0) {
    console.log("\n!! 页面里没有 __DSH_BOOT__（可能拿到的是别的东西）");
    console.log(r2.body.slice(0, 400));
    process.exit(3);
  }

  const json = extractBootJson(r2.body, at);
  console.log("\n__DSH_BOOT__ 出现在偏移:", at, "| 载荷 JSON 长度:", json ? json.length : "(抠不出)");

  if (json) {
    let boot = null;
    try { boot = JSON.parse(json); } catch (e) { console.log("载荷不是合法 JSON:", e.message); }
    if (boot) {
      console.log("\n── 载荷顶层键 ──");
      for (const k of Object.keys(boot)) {
        const v = boot[k];
        const t = Array.isArray(v) ? `Array(${v.length})` : typeof v;
        console.log(`   ${k.padEnd(24)} ${t}`);
      }
      // 客户端插件清单：把任何"看起来像包名数组"的字段列出来
      console.log("\n── 载荷里的候选插件清单字段 ──");
      const isPkg = (s) => typeof s === "string" && /^(@[\w.-]+\/)?[\w.-]+$/.test(s) && /dsh|pet|crosshub|workbuddy|qoder|whale/i.test(s);
      let found = 0;
      for (const k of Object.keys(boot)) {
        const v = boot[k];
        const arr = Array.isArray(v) ? v : (v && Array.isArray(v.modules) ? v.modules : null);
        if (arr && arr.length && arr.filter(isPkg).length >= Math.max(1, arr.length * 0.5)) {
          found++;
          console.log(`   ${k} (${arr.length}) : ${arr.slice(0, 40).map((x) => (typeof x === "string" ? x : JSON.stringify(x).slice(0, 40))).join(", ")}`);
        }
      }
      if (!found) console.log("   (没找到明显的插件清单字段 —— 需要看原始载荷)");

      // ── entries：客户端模块清单（这才是"哪些 client.js 会被加载"的真值）──
      if (Array.isArray(boot.entries)) {
        const ids = boot.entries.map((e) => (typeof e === "string" ? e : (e && (e.id || e.name || e.specifier)) || JSON.stringify(e).slice(0, 60)));
        console.log(`\n── entries(${ids.length}) 全部 id ──`);
        ids.forEach((id, i) => console.log(`   ${String(i + 1).padStart(2)}. ${id}`));
        const s = boot.entries.find((e) => e && typeof e === "object");
        if (s) {
          console.log("\n── 第一条 entry 的键 / 形状（截断到 600 字）──");
          console.log(JSON.stringify(s, null, 2).slice(0, 600));
        }
      }
      if (Array.isArray(boot.batches)) {
        console.log(`\n── batches(${boot.batches.length}) 形状（截断到 600 字）──`);
        console.log(JSON.stringify(boot.batches, null, 2).slice(0, 600));
      }

      if (RAW) console.log("\n── 载荷前 1200 字 ──\n" + json.slice(0, 1200));
    }
  } else if (RAW) {
    console.log("\n── 原文前 1200 字 ──\n" + r2.body.slice(at, at + 1200));
  }
})().catch((e) => { console.error("失败:", e); process.exitCode = 1; });
