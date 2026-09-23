"use strict";

/**
 * quit-orphan.js —— 验收脚手架：**造一个「孤儿内核」**（只给 `scripts/quit-check.js` 用）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要这么一个东西
 * ══════════════════════════════════════════════════════════════════════════
 * 用户 2026-09-23 报「无法彻底退出 dsh，从托盘退出也不行」。现场是：
 *   · 3105 端口上有一个内核在服务（就是本会话跑在里面的那个，pid 9724）
 *   · 它的**父进程早就不存在了**（一个已经退出的外壳实例）
 *   · 它的**启动日志文件根本不存在**（`<userData>\logs\` 里没有对应的那一对）
 *   · 外壳认不出它是自己人 ⇒ `serverOwned = false` ⇒ 退出时**永远不敢关它**
 *
 * 想复现这个现场，第一反应是「杀掉外壳、留下内核」。**但那条路走不通**：
 * 本机 2026-09-23 实测，`taskkill /F` 掉外壳之后，它 spawn 出来的内核**也一起没了**
 * —— 因为 Electron/Chromium 的父进程一死，子进程通常会被 job 对象带走。
 * 所以孤儿内核只能**主动造**：用一个一次性父进程（本脚本）以 `detached: true`
 * 启动内核（脱离 job 对象 ⇒ 父进程死了它也活），拿到就绪信号后自己退出。
 *
 * ⚠️ 于是本脚本造出来的现场与用户现场的**来源不同**（用户那个更像内核自身的
 *    "脱离式重启"：无日志、父进程已死、argv 与我们 `spawnKernel` 的一字不差），
 *    但**状态完全一致**：端口上有一个内核，它的父进程已死，外壳认不出它。
 *    被验收的东西就是这个状态下「退出能不能退干净」。
 *
 * 参数（都由 quit-check 传进来）：
 *   --home=<临时 DSH_HOME>  --port=<端口>  --workspace=<目录>  --out=<结果 json 路径>
 */

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const K = require("../src/kernel.js");

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

function write(out, payload) {
  try { fs.writeFileSync(out, JSON.stringify(payload, null, 2), "utf8"); }
  catch { /* 交不出去也没别的办法 */ }
}

const home = arg("home");
const port = Number(arg("port"));
const workspace = arg("workspace");
const out = arg("out");

app.whenReady().then(async () => {
  if (!home || !port || !out) {
    write(out, { ok: false, why: "参数不全（--home/--port/--out 都要）" });
    app.exit(2);
    return;
  }

  const kernel = K.discoverKernel({});
  if (!kernel) {
    write(out, { ok: false, why: "找不到 dsh 内核" });
    app.exit(2);
    return;
  }

  // ★ process.execPath 此刻就是开发态的 electron.exe（由 run-electron.js 起）
  //   ⇒ 内核的命令行与我们外壳 `spawnKernel` 造出来的**完全一致**，
  //     外壳的「这是不是我拉起来的内核」判据才有东西可认。
  const sp = K.spawnKernel({
    kernel, dshHome: home, port, profile: "web", workspace, detached: true,
  });

  // 等它真的在服务（不带 token 的裸 origin 探活即可），最多 180 秒
  const deadline = Date.now() + 180000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await K.probeDsh(`http://127.0.0.1:${port}`);
      if (K.isProbeAlive(r)) { ready = true; break; }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }

  write(out, {
    ok: ready,
    pid: sp.child.pid,
    selfPid: process.pid,
    port,
    home,
    workspace,
    kernelVersion: kernel.version,
    kernelSource: kernel.source,
    kernelBin: kernel.bin,
    at: new Date().toISOString(),
    why: ready ? "" : "内核 180 秒内没起来",
  });

  // ★★ 关键：**绝不杀内核**，直接走人 ⇒ 内核成为孤儿。
  app.exit(ready ? 0 : 1);
}).catch((e) => {
  write(out, { ok: false, why: `起内核抛异常: ${(e && e.message) || e}` });
  app.exit(2);
});