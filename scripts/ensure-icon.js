"use strict";

/**
 * ensure-icon —— 打包前检查图标是否齐全，缺了就自动生成。
 *
 * 图标不进版本库（体积大且可重复生成），所以新克隆的仓库直接打包会缺图标；
 * electron-builder 遇到 `build.win.icon` 指向不存在的文件只会**警告**，
 * 结果是打出一个没有图标的安装包 —— 这种"静默降级"必须堵掉，所以这里直接失败。
 *
 * 用法：npm run dist 的前置脚本（见 package.json）。
 * 退出码：0 齐全或已补齐；1 生成失败。
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const NEEDED = ["icon.png", "icon-256.png", "icon.ico", "tray.png", "tray@2x.png"];

const missing = NEEDED.filter((n) => !fs.existsSync(path.join(ROOT, "assets", n)));
if (missing.length === 0) {
  console.log("[ensure-icon] 5 个图标齐全，跳过生成。");
  process.exit(0);
}

console.log(`[ensure-icon] 缺 ${missing.length} 个（${missing.join(", ")}），开始生成…`);

// ★ 必须清掉 ELECTRON_RUN_AS_NODE：被设上时 Electron 退化成纯 Node，
//   make-icon.js 会以明确的报错退出（它自己有检查，这里再保险一次）。
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electronBin = path.join(ROOT, "node_modules", ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron");
const r = spawnSync(electronBin, [path.join("scripts", "make-icon.js")], {
  cwd: ROOT,
  stdio: "inherit",
  windowsHide: true,
  env,
  shell: process.platform === "win32", // .cmd 需要 shell 才能执行
});

if (r.error) {
  console.error(`[ensure-icon] 无法启动 Electron: ${r.error.message}`);
  process.exit(1);
}
if (r.status !== 0) {
  console.error(`[ensure-icon] make-icon.js 退出码 ${r.status}`);
  process.exit(1);
}

const stillMissing = NEEDED.filter((n) => !fs.existsSync(path.join(ROOT, "assets", n)));
if (stillMissing.length) {
  console.error(`[ensure-icon] 生成后仍缺: ${stillMissing.join(", ")}`);
  process.exit(1);
}

// 生成完顺手做逐像素验证，避免"生成了一个错的图标却一路打进安装包"
const v = spawnSync(process.execPath, [path.join("scripts", "verify-icon.js")], {
  cwd: ROOT,
  stdio: "inherit",
  windowsHide: true,
});
if (v.status !== 0) {
  console.error("[ensure-icon] 图标验证未通过，见上面的明细。");
  process.exit(1);
}

console.log("[ensure-icon] 图标已生成并验证通过。");
process.exit(0);
