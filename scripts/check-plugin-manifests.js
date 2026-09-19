/**
 * check-plugin-manifests.js —— 读 B 的 web profile 里每个插件的 dsh 声明，
 * 用于判断"它应该有客户端部分吗"，从而判定引导载荷里缺席是否正常。
 *
 * 用 node 读（UTF-8），不用 PowerShell（会把 UTF-8 当 GBK，中文描述串会炸 JSON）。
 * 用法：node scripts/check-plugin-manifests.js <profile 目录>
 */
const fs = require("node:fs");
const path = require("node:path");

const dir = process.argv[2];
if (!dir) { console.error("用法: node check-plugin-manifests.js <profileDir>"); process.exit(1); }

const names = [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dsh-whale-widget",
  "dsh-plugin-install",
  "@dsh-pet/bridge",
  "dsh-crosshub",
  "dsh-connect-workbuddy",
];

for (const n of names) {
  const pj = path.join(dir, "node_modules", n, "package.json");
  if (!fs.existsSync(pj)) { console.log(`${n.padEnd(28)} 未安装`); continue; }
  let j;
  try { j = JSON.parse(fs.readFileSync(pj, "utf8")); }
  catch (e) { console.log(`${n.padEnd(28)} package.json 读不了: ${e.message}`); continue; }
  const dsh = j.dsh || {};
  const hasBundle = dsh.bundle && dsh.bundle.patch ? "有" : "无";
  const client = dsh.client
    ? `有 (platform=${dsh.client.platform || "未声明"})`
    : "无（纯 host 插件）";
  console.log(`${n.padEnd(28)} v${(j.version || "?").padEnd(10)} bundle=${hasBundle.padEnd(3)} client=${client}`);
}
