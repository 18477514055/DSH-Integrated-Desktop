/**
 * 端到端真跑验证（**不碰真实 DSH 家**，也不碰系统回收站）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么必须这么验（全局规矩第二条：验证必须是目标行为本身）
 * ═══════════════════════════════════════════════════════════════════════════
 * "文件存在 / 版本号对 / 配置里有"一律不算证据。这里每一条断言都是
 * **真的把插件跑起来、真的发 HTTP 请求、真的去磁盘上看字节在哪**。
 *
 * 这个插件会**搬动文件**，所以验收全部在**临时目录**里做：
 *   · 造假 DSH 家（归档会话 + 投影 + workspace.json）
 *   · 造假转储文件夹
 *   · 真的调 host `apply()` 挂路由，真的发 GET/POST
 *   · 真的核实：文件从 DSH 家消失了、**出现在转储文件夹里**、注册表改了
 *   · 真的还原一次，核实文件**回到原位**且**重新登记**
 *   · 最后清掉所有临时目录
 * 真实 DSH 家与系统回收站：**一个字节都不碰**。
 *
 * 用法：node tools/e2e-check.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ★ 必须用 fileURLToPath：`new URL(...).pathname` 对中文路径是百分号编码的，
//   再拼盘符会变成 `D:\D:\...`（本次实测报错）。本机路径含中文，必踩。
const HERE = fileURLToPath(new URL(".", import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, "..");
const LIB_INDEX = path.join(PLUGIN_DIR, "lib", "index.js");

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name + (detail ? " — " + detail : "")); console.log("  FAIL  " + name + (detail ? " — " + detail : "")); }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. 造临时环境
// ─────────────────────────────────────────────────────────────────────────
const sink = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-am-sink-"));
const home = path.join(sink, "dsh-home");
const trash = path.join(sink, "已删除归档");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(trash, { recursive: true });

// ★ 把配置目录指到临时目录 —— 否则 e2e 会把 trashDir 写进**真实插件目录**，
//   污染交付物（实测发生过：插件目录里留下指向已删临时目录的配置文件）。
process.env.DSH_ARCHIVE_CONFIG_DIR = path.join(sink, "cfg");

// ★★ 把 DSH 家锁到临时目录 —— **这条最重要**。
//   2026-09-21 回归实测：index.js 改成"自己探测家"之后，e2e 里的假会话
//   不在真实家的归档名单里，表面上只是几条断言 FAIL；但同一份代码在别的路径下
//   **可能真的去动真实数据**（删除会写 workspace.json）。
//   所以这里显式指定，并在下面加一条断言：解析出来的家**必须是临时目录**。
process.env.DSH_ARCHIVE_HOME = home;
console.log("临时 DSH 家 = " + home);
console.log("临时转储夹 = " + trash);

const WS_CWD = "D:\\fake-workspace";
function makeSession(id, wsDirName, title, atMs, bytes, logName) {
  const dir = path.join(home, "sessions", wsDirName, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, logName), Buffer.alloc(bytes, 7));
  const projDir = path.join(home, "storages", "session_projcache", "sessions");
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, id + ".json"), JSON.stringify({
    version: 7,
    record: {
      identity: { formatVersion: 3, createdAt: atMs - 1000, cwd: WS_CWD },
      rows: {
        title: { ver: 1, seq: 10, val: title },
        sessionListMetadata: { ver: 1, seq: 10, val: { blank: false, lastPromptAt: atMs } },
      },
    },
  }));
  return dir;
}

const A_ID = "session-aaaa-1111";
const B_ID = "session-bbbb-2222";
const C_ID = "session-cccc-3333"; // 活会话，**绝不能**被动
const wsDir = "--D-fake-workspace--";
makeSession(A_ID, wsDir, "归档会话甲", Date.UTC(2026, 8, 18, 10, 0, 0), 4096, "session.v3.jsonl.zstd");
makeSession(B_ID, wsDir, "归档会话乙", Date.UTC(2026, 8, 19, 10, 0, 0), 8192, "session.jsonl.zstd");
makeSession(C_ID, wsDir, "活会话丙", Date.UTC(2026, 8, 20, 10, 0, 0), 2048, "session.v3.jsonl.zstd");

const REG = path.join(home, "storages", "workspace.json");
fs.mkdirSync(path.dirname(REG), { recursive: true });
fs.writeFileSync(REG, JSON.stringify({
  unit: { name: "workspace", version: 2 },
  global: { initialized: true, workspaceIds: ["ws-1"], archivedSessionIds: [A_ID, B_ID] },
  tables: { workspaces: { "ws-1": { path: WS_CWD, title: "fake-workspace", sessionIds: [A_ID, B_ID, C_ID], createdAt: 1, updatedAt: 2 } } },
}, null, 2));

const A_LOG = path.join(home, "sessions", wsDir, A_ID, "session.v3.jsonl.zstd");
const A_PROJ = path.join(home, "storages", "session_projcache", "sessions", A_ID + ".json");
const C_LOG = path.join(home, "sessions", wsDir, C_ID, "session.v3.jsonl.zstd");

console.log("");
console.log("=== 1. 只读解析 ===");
const store = await import(pathToFileURL(path.join(PLUGIN_DIR, "lib", "archive-store.js")).href);
const listed = store.listArchived(home);
const byId = new Map(listed.map((x) => [x.id, x]));
ok("归档名单 2 条", listed.length === 2, "实际 " + listed.length);
ok("甲被列出", byId.has(A_ID));
ok("乙被列出（v0 日志名也认）", byId.has(B_ID));
ok("乙体积 = 8192", byId.get(B_ID).logBytes === 8192, String(byId.get(B_ID).logBytes));
ok("活会话丙不在名单", !byId.has(C_ID));
ok("合计 = 12288", store.archivedTotalBytes(home).bytes === 12288);

console.log("");
console.log("=== 2. 删除计划（只读）===");
const plan = store.planRemoval(home, A_ID);
ok("计划含日志", plan.targets.some((t) => t.kind === "log"));
ok("计划含投影", plan.targets.some((t) => t.kind === "proj"));
ok("计划跑完文件还在", fs.existsSync(A_LOG) && fs.existsSync(A_PROJ));
ok("活会话被拒", store.planRemoval(home, C_ID).ok === false);

console.log("");
console.log("=== 3. 挂 HTTP 服务 ===");
const mod = await import(pathToFileURL(LIB_INDEX).href);
const routes = new Map();
const fakeCtx = {
  get(n) { return n === "homePaths" ? { home } : undefined; },
  webServer: {
    register(r) { const k = r.kind + " " + r.path; if (routes.has(k)) throw new Error("dup " + k); routes.set(k, r.handler); return () => routes.delete(k); },
  },
};
const dispose = mod.apply(fakeCtx);
for (const p of ["/config.json", "/config", "/list.json", "/plan.json", "/remove", "/trash.json", "/restore", "/purge", "/health.json"]) {
  ok("挂了 " + p, routes.has("exact /dsh-archive" + p));
}

function call(key, init) {
  return new Promise((resolve, reject) => {
    const handler = routes.get(key);
    if (!handler) return reject(new Error("no route " + key));
    const chunks = (init && init.bodyChunks) || [];
    const req = {
      url: (init && init.url) || "/", method: (init && init.method) || "GET",
      on(ev, fn) { if (ev === "data") for (const c of chunks) fn(c); if (ev === "end") setTimeout(fn, 0); return req; },
      destroy() {},
    };
    const res = { statusCode: null, writeHead(c) { res.statusCode = c; return res; }, end(b) { resolve({ status: res.statusCode, body: String(b) }); } };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
const post = (p, obj) => call("exact /dsh-archive" + p, { method: "POST", bodyChunks: [Buffer.from(JSON.stringify(obj))] });
const get = (p) => call("exact /dsh-archive" + p);

const health = JSON.parse((await get("/health.json")).body);
ok("health 归档 2 条", health.archived === 2, JSON.stringify(health));
// ★★ 硬闸门：解析出来的家必须是**临时目录**，绝不能是真实 DSH 家。
//   这条一旦红了，说明 e2e 正在拿真实数据开刀 —— 立刻停手。
ok("插件解析出的家 = 临时目录（不是真实 DSH 家）",
  path.resolve(health.home).toLowerCase() === path.resolve(home).toLowerCase(),
  "解析出 " + health.home + "，期望 " + home);
// 与上一条同源，但用**绝对比对**兜底（上一条比的是 norm 小写，这条防"恰好同盘同结构"）。
// ⚠ 不能写"不含 AppData"—— 临时目录本身就在 `AppData\Local\Temp` 下，
//   我第一版就是这么写的，结果**假 FAIL**（实测红过一次）。
//   正确的判据是：它**不等于**那个真实的 B 家路径。
const REAL_B_HOME = path.join(process.env.APPDATA || "", "DSH Integrated", "dsh-home");
ok("解析出的家 ≠ 真实 B 家路径",
  path.resolve(health.home).toLowerCase() !== path.resolve(REAL_B_HOME).toLowerCase(),
  health.home + " 竟然等于真实家 " + REAL_B_HOME);

console.log("");
console.log("=== 4. 配置转储文件夹（可改）===");
const cfg0 = JSON.parse((await get("/config.json")).body);
ok("默认转储夹已报出", typeof cfg0.trashDir === "string" && cfg0.trashDir.length > 0, JSON.stringify(cfg0));
const setCfg = JSON.parse((await post("/config", { trashDir: trash })).body);
ok("改转储夹成功", setCfg.ok === true, JSON.stringify(setCfg));
ok("改后读回是新路径", JSON.parse((await get("/config.json")).body).trashDir === trash);
const badCfg = JSON.parse((await post("/config", { trashDir: "Z:\\不存在的盘\\xxx" })).body);
ok("不可写路径被拒", badCfg.ok === false, JSON.stringify(badCfg));

console.log("");
console.log("=== 5. 安全边界（先试不该成功的）===");
ok("缺 sessionId 被拒", JSON.parse((await post("/remove", {})).body).ok === false);
const liveTry = JSON.parse((await post("/remove", { sessionId: C_ID })).body);
ok("删活会话被拒", liveTry.ok === false, JSON.stringify(liveTry).slice(0, 120));
ok("活会话日志仍在磁盘", fs.existsSync(C_LOG));
const wrongTitle = JSON.parse((await post("/remove", { sessionId: A_ID, confirmTitle: "乱写的" })).body);
ok("标题确认不匹配被拒", wrongTitle.ok === false, JSON.stringify(wrongTitle));
ok("甲还没被搬走", fs.existsSync(A_LOG));

console.log("");
console.log("=== 6. 真的'删除'一条（搬到转储夹）===");
const r1 = JSON.parse((await post("/remove", { sessionId: A_ID, confirmTitle: "归档会话甲" })).body);
ok("remove 返回 ok", r1.ok === true, JSON.stringify(r1).slice(0, 300));
ok("甲的日志从 DSH 家消失", !fs.existsSync(A_LOG));
ok("甲的投影从 DSH 家消失", !fs.existsSync(A_PROJ));
ok("返回了转储槽路径", typeof r1.trashPath === "string" && r1.trashPath.length > 0, JSON.stringify(r1.trashPath));
ok("转储槽目录真的存在", fs.existsSync(r1.trashPath));
const trashEntries = fs.readdirSync(r1.trashPath);
ok("槽里有 2 个文件 + 2 个记录", trashEntries.length === 4, JSON.stringify(trashEntries));
ok("槽里有原路径.txt", trashEntries.includes("原路径.txt"));
ok("槽里有 _origin.json", trashEntries.includes("_origin.json"));
ok("槽名含日期与标题（人能认出）", /归档会话甲/.test(r1.slot || ""), String(r1.slot));

const reg1 = JSON.parse(fs.readFileSync(REG, "utf8"));
ok("甲已从归档名单移除", !reg1.global.archivedSessionIds.includes(A_ID));
ok("甲已从工作区移除", !reg1.tables.workspaces["ws-1"].sessionIds.includes(A_ID));
ok("乙仍在归档名单", reg1.global.archivedSessionIds.includes(B_ID));
ok("活会话丙仍登记着", reg1.tables.workspaces["ws-1"].sessionIds.includes(C_ID));
ok("活会话丙日志仍在", fs.existsSync(C_LOG));
ok("list 只剩 1 条", JSON.parse((await get("/list.json")).body).items.length === 1);

console.log("");
console.log("=== 7. 转储夹清单 ===");
const tr = JSON.parse((await get("/trash.json")).body);
ok("转储夹有 1 个槽", tr.slots && tr.slots.length === 1, JSON.stringify(tr).slice(0, 200));
ok("槽可还原", tr.slots[0].restorable === true);
ok("槽体积 > 0", tr.slots[0].bytes > 0, String(tr.slots[0].bytes));

console.log("");
console.log("=== 8. 还原（搬回原位 + 重新登记）===");
const rs = JSON.parse((await post("/restore", { slot: tr.slots[0].slot })).body);
ok("还原返回 ok", rs.ok === true, JSON.stringify(rs).slice(0, 300));
ok("甲的日志回到原位", fs.existsSync(A_LOG));
ok("甲的投影回到原位", fs.existsSync(A_PROJ));
const reg2 = JSON.parse(fs.readFileSync(REG, "utf8"));
ok("甲重新登记进归档名单", reg2.global.archivedSessionIds.includes(A_ID), JSON.stringify(reg2.global.archivedSessionIds));
ok("甲重新登记进工作区", reg2.tables.workspaces["ws-1"].sessionIds.includes(A_ID));
ok("转储槽已被清掉", !fs.existsSync(tr.slots[0].dir));
const list3 = JSON.parse((await get("/list.json")).body);
ok("list 恢复 2 条", list3.items.length === 2, "实际 " + list3.items.length);
ok("甲的标题还在", (list3.items.find((x) => x.id === A_ID) || {}).title === "归档会话甲");

console.log("");
console.log("=== 9. 真正抹除（purge，必须 confirm:true）===");
const r2 = JSON.parse((await post("/remove", { sessionId: B_ID })).body);
ok("乙已搬走", r2.ok === true, JSON.stringify(r2).slice(0, 200));
const tr2 = JSON.parse((await get("/trash.json")).body);
const slotB = tr2.slots[0].slot;
ok("purge 缺 confirm 被拒", JSON.parse((await post("/purge", { slot: slotB })).body).ok === false);
ok("槽还在（没被误抹）", fs.existsSync(path.join(trash, slotB)));
const pg = JSON.parse((await post("/purge", { slot: slotB, confirm: true })).body);
ok("purge 成功", pg.ok === true, JSON.stringify(pg));
ok("槽真的没了", !fs.existsSync(path.join(trash, slotB)));

console.log("");
console.log("=== 10. 卸载 ===");
let dOk = true;
try { dispose(); } catch { dOk = false; }
ok("disposer 不抛错", dOk);
ok("卸载后路由清空", routes.size === 0, "还剩 " + routes.size);

console.log("");
console.log("=== 11. 不污染交付物（这条守的是'测试别弄脏插件目录'）===");
const realCfg = path.join(PLUGIN_DIR, "archive-manager.config.json");
ok("真实插件目录里没有残留配置文件", !fs.existsSync(realCfg), "存在！说明测试污染了交付物：" + realCfg);

console.log("");
console.log("=== 12. 不认错家（守的是'别动 A 家这个只读保底环境'）===");
// 2026-09-21 真跑 `npm run plugin:check` 抓到的两个坑，各自留一条断言。
const idx = fs.readFileSync(LIB_INDEX, "utf8");
ok("不再 inject homePaths（它是纯函数模块，inject 会让整个 profile 起不来）",
  !/inject\s*=\s*\[[^\]]*homePaths/.test(idx), "还在 inject homePaths");
ok("DSH_HOME 候选里显式包含 B 家（活动环境）", /DSH Integrated/.test(idx), "没看到 B 家路径");

const probe = await import(pathToFileURL(path.join(PLUGIN_DIR, "lib", "home-probe.js")).href);
const fakeA = path.join(sink, "fake-A-home");
fs.mkdirSync(path.join(fakeA, "sessions"), { recursive: true }); // 只有 sessions，缺 workspace.json
ok("缺 workspace.json 的目录不被认作家", probe.looksLikeHome(fakeA) === false);
ok("临时空目录不被认作家", probe.looksLikeHome(path.join(sink, "nope")) === false);
ok("真正的 B 家被认出来", probe.looksLikeHome(
  path.join(process.env.APPDATA || "", "DSH Integrated", "dsh-home")) === true);
ok("looksLikeHome 对不存在的路径返回 false", probe.looksLikeHome("Z:\\不存在\\x") === false);
// ★ 2026-09-21 补：全新家（有 workspace.json 但还没 sessions/）**必须**被认出来。
//   第一版判据要求两者都有，结果临时新家被判死 ⇒ 插件落到真实 B 家（真跑抓到）。
const fresh = path.join(sink, "fresh-home", "storages");
fs.mkdirSync(fresh, { recursive: true });
fs.writeFileSync(path.join(fresh, "workspace.json"), "{}");
ok("全新家（只有 workspace.json，还没 sessions/）也要认", probe.looksLikeHome(path.join(sink, "fresh-home")) === true);

try { fs.rmSync(sink, { recursive: true, force: true }); } catch { /* 临时目录 */ }

console.log("");
console.log("================================================================");
console.log("断言 " + (pass + fail) + " 条：PASS " + pass + " / FAIL " + fail);
if (fail) { console.log(""); console.log("失败清单："); for (const f of failures) console.log("  · " + f); }
console.log("================================================================");
process.exit(fail ? 1 : 0);
