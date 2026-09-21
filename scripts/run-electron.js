"use strict";

/**
 * run-electron.js —— 用 Electron 跑一个脚本，但**先删掉继承来的 `ELECTRON_RUN_AS_NODE`**
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这个壳（本项目记在案的坑，2026-09-20 实测）
 * ═══════════════════════════════════════════════════════════════════════════
 * DSH 内核进程就是带 `ELECTRON_RUN_AS_NODE=1` 启动的，而 **AI 的 shell 是它的子进程**
 * ⇒ 这个变量会一路继承下来。带着它去起 `electron.exe` 时，Electron 会**退化成纯 Node**：
 *
 *     require("electron")  →  返回的是**可执行文件路径字符串**，不是模块
 *     app                  →  undefined
 *     ⇒ 崩在 `app.whenReady()` / `app.setAppUserModelId()` 上
 *
 * **症状极具误导性**：报错看着像"脚本写错了"，其实是环境变量。
 * （2026-09-22 实测：`npm run update:check` 报
 *   `TypeError: Cannot read properties of undefined (reading 'whenReady')`，
 *   而同一个脚本上一轮还是好的 —— 差别只在这次是从内核的子进程里跑的。）
 *
 * `scripts/ui-check.js` 早就有这一行（它由 node 跑、内部 spawn 时 `delete env.ELECTRON_RUN_AS_NODE`）。
 * 这个文件把那套做法抽出来，让**任何**要 Electron 的脚本都能安全地跑。
 *
 * 用法（package.json 里就这么写）：
 *   node scripts/run-electron.js scripts/update-check.js [参数...]
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const target = process.argv[2];
if (!target) {
  console.error("用法: node scripts/run-electron.js <要跑的脚本> [参数...]");
  process.exit(2);
}

const exe = path.join(
  __dirname, "..", "node_modules", "electron", "dist",
  process.platform === "win32" ? "electron.exe" : "electron"
);
if (!fs.existsSync(exe)) {
  console.error(`找不到 Electron：${exe}`);
  console.error("（先 `npm install`）");
  process.exit(2);
}

const env = { ...process.env };
const hadRunAsNode = !!env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RUN_AS_NODE;
if (hadRunAsNode) {
  console.log("[run-electron] 已清掉继承来的 ELECTRON_RUN_AS_NODE（否则 Electron 会退化成纯 Node）");
}

// ★ 用 inherit：Windows 沙箱下 Node 的 piped stdio 会 EPERM（本项目实测过）
const child = spawn(exe, [path.resolve(target), ...process.argv.slice(3)], {
  env,
  stdio: "inherit",
  windowsHide: false,
});

child.on("error", (e) => {
  console.error(`[run-electron] 起不来：${(e && e.message) || e}`);
  process.exit(2);
});
child.on("exit", (code, signal) => {
  process.exit(code === null ? (signal ? 1 : 0) : code);
});
