"use strict";

/**
 * mobile-remote-status.js —— 只读体检：**正在运行的那个插件实例**到底是哪个版本。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它（这不是"锦上添花"，是踩出来的）
 * ══════════════════════════════════════════════════════════════════
 * 宿主半边（`lib/index.js`）是**内核启动时加载进内存**的：
 * 改了磁盘上的源码，**已经在跑的那个实例不会变** —— 只有重启客户端才会重新加载。
 * 而手机端页面（`web/`）是**每次请求现读磁盘**的 ⇒ 于是会出现一种很迷惑的状态：
 *
 *     手机上是**新界面**，但新功能一个个都不工作
 *     （工作区胶囊不显示、标题不显示、切模型/审批报错）
 *
 * 2026-09-20 实测就是如此：内核 18:29 启动，`lib/index.js` 18:46 才改
 * ⇒ 跑的是旧宿主半边，新 RPC 全部 `unknown_method`，而手机页面已是新的。
 *
 * 本脚本就是用来**一眼看出这件事**的：它去问运行中的实例"你支持哪些方法"。
 *
 * 用法：node scripts/mobile-remote-status.js
 * 退出码：0=运行中的是新版；2=是旧版（需要重启客户端）；3=连不上
 */

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const OFFICIAL = "http://127.0.0.1:3105";
const LAN = "http://127.0.0.1:3110";

/** 这一版**新增**的 RPC —— 它们在旧版里不存在，正好当版本探针。 */
const NEW_METHODS = ["workspace.list", "modelCatalog", "session.titles", "session.selectModel", "approval.answer"];

(async () => {
  console.log("\n=== 手机遥控 · 运行状态体检 ===\n");

  // ── ① 插件在同源路由上活着吗 ──
  let st;
  try {
    const r = await fetch(`${OFFICIAL}/dsh-mobile-remote/state`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    st = (await r.json()).data;
  } catch (e) {
    console.log(`✗ 同源路由读不到（${e.message}）`);
    console.log("  ⇒ 插件没在跑，或者内核还没重启过。先重启客户端。\n");
    process.exit(3);
  }

  console.log(`  局域网地址 : ${st.ip}:${st.port}`);
  console.log(`  已配对设备 : ${st.paired} 台`);
  for (const d of st.devices || []) {
    console.log(`     · ${d.name.slice(0, 52)}`);
    console.log(`       配对于 ${new Date(d.pairedAt).toLocaleString("zh-CN")}   最后活动 ${new Date(d.lastSeen).toLocaleString("zh-CN")}`);
  }
  if (st.errors && st.errors.length) console.log(`  插件报错   : ${st.errors.join(" | ")}`);

  // ── ② 运行中的实例支持哪些方法（版本探针）──
  const pr = await (await fetch(`${LAN}/api/pair/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: st.code, deviceName: "status-check" }),
  })).json();
  if (!pr.token) {
    console.log(`\n✗ 自检配对失败：${JSON.stringify(pr)}`);
    process.exit(3);
  }

  const probe = async (method) => {
    const r = await fetch(`${LAN}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + pr.token },
      body: JSON.stringify({ method, params: method === "session.titles" ? { sessionIds: [] } : {} }),
    });
    const j = await r.json();
    return { ok: j.ok === true, err: j.error || "", status: r.status };
  };

  console.log("\n  方法支持情况（新版才有的那几个是关键）：");
  const base = await probe("session.list");
  console.log(`    ${"session.list".padEnd(20)} ${base.ok ? "✓" : "✗"}   （旧版也有，作对照）`);

  let newOk = 0;
  for (const m of NEW_METHODS) {
    const r = await probe(m);
    if (r.ok) newOk++;
    console.log(`    ${m.padEnd(20)} ${r.ok ? "✓" : "✗  " + r.err}`);
  }

  // ── ③ 磁盘 vs 运行中：是不是"改了但没重启" ──
  const plug = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "DSH Integrated", "dsh-home", "profiles", "web", "node_modules", "dsh-mobile-remote");
  let diskMtime = null;
  try { diskMtime = fs.statSync(path.join(plug, "lib", "index.js")).mtime; } catch { }

  console.log("");
  if (newOk === NEW_METHODS.length) {
    console.log("✓ 运行中的是**新版**宿主半边 —— 所有新功能都可用。");
    console.log("  （若手机界面仍不对，在手机上刷新页面即可；页面是每次现读磁盘的。）\n");
    process.exit(0);
  }

  console.log(`✗ 运行中的是**旧版**宿主半边：${NEW_METHODS.length - newOk}/${NEW_METHODS.length} 个新方法不存在。`);
  if (diskMtime) {
    console.log(`  磁盘上的 lib/index.js 修改于 ${diskMtime.toLocaleString("zh-CN")}`);
  }
  console.log("");
  console.log("  ⇒ 这是「改了源码但没重启客户端」的典型状态：");
  console.log("     手机端页面（web/）是每次现读磁盘的 ⇒ 界面上是**新的**；");
  console.log("     宿主半边（lib/index.js）是启动时加载进内存的 ⇒ 功能还是**旧的**。");
  console.log("     结果就是「新界面 + 一堆功能点了没反应」。");
  console.log("");
  console.log("  怎么修：**重启一次客户端**（托盘图标右键 → 退出 → 重新打开）。");
  console.log("  为什么脚本不替你重启：本会话的 AI 自己就跑在那个内核里，");
  console.log("  重启等于把它连同「你还能问问题」一起杀掉。\n");
  process.exit(2);
})().catch((e) => {
  console.error("体检失败：" + (e && e.message));
  process.exit(3);
});
