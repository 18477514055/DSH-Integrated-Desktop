"use strict";

/**
 * first-run.js —— 「首次安装向导」有没有走过，只记这一件事。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这件事要单独记一个文件
 * ══════════════════════════════════════════════════════════════════
 * 0.2.6 起安装包**不再带插件**（用户原话：「我们发出去的包干干净净的，有本体客户端
 * 就足够了」）。插件的入口因此从"随包落位"变成了"首启时勾选、从我们的仓库拉"。
 *
 * 而"该不该弹那个向导"需要一个**跨启动的持久标记**：
 *   · 不能靠"有没有插件"判 —— 用户可能就是要一个插件都不装；
 *   · 不能靠 settings.json —— 那是**用户设置**，被删/被重置不该让向导复活；
 *   · 更不能每次启动都弹 —— 那是骚扰，不是向导。
 *
 * 所以：一份独立的状态文件 `<userData>/first-run.json`，`done:true` 之后永不再自动弹
 * （手动重开永远可以，见 settings 的「集成版插件」栏）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三种"收工"都记账，措辞不同（**这是给未来的自己看的**）
 * ══════════════════════════════════════════════════════════════════
 *   installed=[...]  勾了并装成功的那几个
 *   skipped=true     明确点了「先跳过，直接开始用」
 *   dismissed=true   什么都没点，直接把那个窗口关了
 * 后两种都不算"装过东西"，但都算"见过向导了"——下次不再自动弹。
 *
 * ══════════════════════════════════════════════════════════════════
 * 边界
 * ══════════════════════════════════════════════════════════════════
 *   · 只写 `<userData>/first-run.json` 一个文件；**不碰 DSH_HOME**（那是内核的地盘）。
 *   · 不 require Electron —— 传进来的是普通路径字符串，所以 `node -e` 就能直接测，
 *     不必起一个 Electron 进程（本项目的验收脚本靠的就是这条）。
 *   · 读失败（文件不存在 / 半截 JSON / 带 BOM）一律当成"没走过"，**不抛错**：
 *     状态文件坏了最多多弹一次向导，不该让客户端起不来。
 */

const fs = require("node:fs");
const path = require("node:path");

const FILE = "first-run.json";

/** 状态文件在哪（**传目录进来**，不依赖 Electron 的 app）。 */
function statePath(userDataDir) {
  return path.join(String(userDataDir || ""), FILE);
}

/**
 * 读状态。**永远返回对象或 null，不抛错。**
 *
 * ★ 剥 BOM 不是洁癖：Windows PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，
 *   而 JSON.parse 遇到 BOM 直接抛 "Unexpected token"。`main.js` 的 loadSettings()
 *   就为同一件事栽过一次（2026-09-19：settings.json 带 BOM ⇒ 端口配置读不进来）。
 */
function read(userDataDir) {
  if (!userDataDir) return null;
  try {
    let raw = fs.readFileSync(statePath(userDataDir), "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    return j;
  } catch {
    return null;
  }
}

/** 走过了没有。文件坏的/没的 ⇒ false（宁可多弹一次，也不该少弹）。 */
function isDone(userDataDir) {
  const s = read(userDataDir);
  return !!(s && s.done === true);
}

/** 合并写一份状态，**不动 `done`**（记录中间进度用）。 */
function save(userDataDir, patch = {}) {
  if (!userDataDir) return null;
  const next = { ...(read(userDataDir) || {}), ...patch };
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(statePath(userDataDir), JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    return null;   // 写不进去不影响功能：大不了下次再弹一次
  }
  return next;
}

/** 记成"收工了"，此后不再自动弹。 */
function mark(userDataDir, patch = {}) {
  return save(userDataDir, { ...patch, done: true, at: new Date().toISOString() });
}

module.exports = { FILE, statePath, read, isDone, save, mark };
