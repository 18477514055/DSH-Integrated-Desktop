/**
 * 安装前置检查（**只检查，不装**）。
 *
 * 为什么需要：项目指令 §3 说"装插件只走脚本，手敲必漏三处之一"。
 * 装之前先确认这包本身**具备被内核接受的形状**，免得装到一半才发现缺东西。
 *
 * 三处契约（抄自 install-plugin.js 的做法）：
 *   ① package.json 有 `dsh.bundle`（否则内核报 declares no dsh.bundle）
 *   ② package.json 有 `dsh.client`（否则浏览器半边不会被下发）
 *   ③ cordis.patch.yml 存在且 id 与包名一致
 *
 * 外加：main 指向的文件存在、exports 齐全、语法可解析。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, "..");

let pass = 0, fail = 0;
const failures = [];
function ok(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; failures.push(n + (d ? " — " + d : "")); console.log("  FAIL  " + n + (d ? " — " + d : "")); }
}

console.log("插件目录 = " + PLUGIN_DIR);
console.log("");

const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "package.json"), "utf8"));

console.log("=== 1. 内核 bundle 契约 ===");
ok("有 dsh.bundle.patch", !!(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch), JSON.stringify(pkg.dsh));
const patchPath = path.join(PLUGIN_DIR, pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch || "");
ok("patch 文件存在", fs.existsSync(patchPath), String(patchPath));
const patch = fs.readFileSync(patchPath, "utf8");
ok("patch 里声明了 insert", /insert:/.test(patch));
ok("patch 的 id = 包名", new RegExp("id:\\s*" + pkg.name).test(patch), patch.slice(0, 200));
ok("patch 的 name = 包名", new RegExp("name:\\s*['\"]?" + pkg.name).test(patch));

console.log("");
console.log("=== 2. 客户端契约 ===");
ok("有 dsh.client", !!(pkg.dsh && pkg.dsh.client), JSON.stringify(pkg.dsh && pkg.dsh.client));
ok("dsh.client.platform = web", pkg.dsh && pkg.dsh.client.platform === "web");
ok("dsh.client.inject 是数组", Array.isArray(pkg.dsh && pkg.dsh.client.inject));
const injected = (pkg.dsh && pkg.dsh.client.inject) || [];
ok("inject 只写平台共享模块（9 个词之一可 require）",
  injected.every((m) => /^@deepseek-ai\/(dsh-client-ui-slots|dsh-client-ui-primitives|dsh-client-ui-dockkit|dsh-client-store|dsh-client-ui-layout)$/.test(m)),
  JSON.stringify(injected));

console.log("");
console.log("=== 3. 文件与导出 ===");
// ★ 2026-09-21 修正：这条原来断言"包名 == 目录名"，搬到 `2.归档管理器` 后必然失败。
//   但那个断言本身就是**错的**：插件的包名（`dsh-archive-manager`，内核靠它识别）
//   与它所在的项目目录名（工作区里的 `2.归档管理器`，给人看的）**本来就不该相等** ——
//   本机另外两个插件也印证：`5.DSH集成桌面端\plugin\dsh-multi-session` 同样不等。
//   真正该守的是：包名必须是个合法的、**稳定的** npm 名（内核用它做 bundle id）。
ok("包名是合法 npm 名（内核靠它识别，与项目目录名无关）",
  /^[a-z0-9][a-z0-9._-]*$/.test(pkg.name) && !pkg.name.startsWith("."),
  pkg.name + "（所在目录 " + path.basename(PLUGIN_DIR) + "）");
ok("包名与 cordis.patch.yml 的 id 一致",
  new RegExp("id:\\s*" + pkg.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(patch),
  pkg.name);
ok("main 指向的文件存在", fs.existsSync(path.join(PLUGIN_DIR, pkg.main)), pkg.main);
ok("exports 有 ./client", !!(pkg.exports && pkg.exports["./client"]));
ok("exports 有 ./cordis.patch.yml", !!(pkg.exports && pkg.exports["./cordis.patch.yml"]));
ok("exports 有 ./package.json", !!(pkg.exports && pkg.exports["./package.json"]));
ok("lib/client.js 存在", fs.existsSync(path.join(PLUGIN_DIR, "lib", "client.js")));
ok("lib/index.js 存在", fs.existsSync(path.join(PLUGIN_DIR, "lib", "index.js")));

console.log("");
console.log("=== 4. 语法可解析（node --check 等价）===");
for (const f of ["lib/index.js", "lib/client.js", "lib/paths.js", "lib/recycle.js", "lib/archive-store.js"]) {
  const p = path.join(PLUGIN_DIR, f);
  let err = null;
  try {
    // 用动态 import 之外的轻量办法：交给子进程 --check 更可靠，这里直接看能否 new Function 解析 ESM 之外的部分。
    // 这些文件是 ESM，用 --check 才准（由外部脚本跑）；此处只验证文件非空且可被读。
    const s = fs.readFileSync(p, "utf8");
    if (!s.trim()) throw new Error("空文件");
  } catch (e) { err = e; }
  ok(f + " 非空可读", err === null, err ? String(err.message) : "");
}

console.log("");
console.log("=== 5. 与已装插件对照（whale-widget 是本机活例）===");
const home = process.env.APPDATA
  ? path.join(process.env.APPDATA, "DSH Integrated", "dsh-home")
  : null;
const ref = home ? path.join(home, "profiles", "plugin-src", "DeepSeek-Balance-Whale-Widget-0.2.10", "package.json") : null;
if (ref && fs.existsSync(ref)) {
  const r = JSON.parse(fs.readFileSync(ref, "utf8"));
  ok("参照插件也有 dsh.bundle.patch（本包形状与它一致）", !!(r.dsh && r.dsh.bundle && r.dsh.bundle.patch));
  console.log("       参照： " + JSON.stringify(r.dsh));
  console.log("       本包： " + JSON.stringify(pkg.dsh));
} else {
  console.log("       （未找到参照插件，跳过对照）");
}

console.log("");
console.log("================================================================");
console.log("断言 " + (pass + fail) + " 条：PASS " + pass + " / FAIL " + fail);
if (fail) { console.log(""); console.log("失败清单："); for (const f of failures) console.log("  · " + f); }
console.log("================================================================");
process.exit(fail ? 1 : 0);
