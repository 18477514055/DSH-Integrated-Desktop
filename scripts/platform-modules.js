/**
 * platform-modules.js —— 从官方前端产物里抠出**平台共享模块表**及其导出清单。
 *
 * 为什么需要它（2026-09-21）：客户端插件能 `require` 的东西是**固定的一小张表**
 * （`PLATFORM_MODULES`，见 `dsh-client-modules` 的 README：「外壳播种一张冻结模块表」）。
 * 那张表**只存在于**编好的前端产物里（`dsh-web-frontend/dist/assets/index-*.js`），
 * 而 `@deepseek-ai/dsh-client-ui-primitives` / `-dockkit` 这类包**磁盘上根本没有**
 * ⇒ 没有 `.d.ts` 可读，只能从产物里抠。
 *
 * 抠法：产物里那张表长这样（原文，偏移 508256 附近）：
 *     function by(){return{react:ec,"react/jsx-runtime":ic,...,"@deepseek-ai/dsh-client-ui-primitives":Zg,...}}
 * 而每个值是 `const Zg=Object.freeze(Object.defineProperty({__proto__:null,Button:w3,...},Symbol.toStringTag,...))`
 * ⇒ ① 先解析表得到 模块id → 变量名；② 再按变量名找定义，取 `{__proto__:null, ...}` 里的键。
 *
 * 用法：
 *   node scripts/platform-modules.js                 # 自动找唯一安装的 dsh-web-frontend
 *   node scripts/platform-modules.js <index-*.js>    # 指定产物
 *   node scripts/platform-modules.js --names         # 只打印模块 id，不打印导出（短）
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const NAMES_ONLY = process.argv.includes("--names");
const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));

function findBundle() {
  if (arg) return arg;
  const roots = [
    path.join(process.env.APPDATA || "", "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"),
  ];
  for (const r of roots) {
    const dist = path.join(r, "dsh-web-frontend", "dist", "assets");
    if (!fs.existsSync(dist)) continue;
    const hit = fs.readdirSync(dist).filter((f) => /^index-.*\.js$/.test(f));
    if (hit.length) return path.join(dist, hit[0]);
  }
  return null;
}

/** 从 `{` 起做花括号配平（跳过字符串），返回大括号内的原文。 */
function balanced(src, openIdx) {
  let depth = 0, i = openIdx, inStr = false, quote = "", esc = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = true; quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return src.slice(openIdx + 1, i); }
  }
  return null;
}

const bundle = findBundle();
if (!bundle || !fs.existsSync(bundle)) {
  console.error("找不到 dsh-web-frontend 的 index-*.js；请把路径作为参数传入。");
  process.exit(2);
}
const src = fs.readFileSync(bundle, "utf8");
console.log("产物 :", bundle);
console.log("长度 :", src.length, "字节\n");

// ① 平台模块表：形如 `return{react:ec,"react/jsx-runtime":ic,...}`
const tableRe = /return\{react:[A-Za-z0-9_$]+,"react\/jsx-runtime":[A-Za-z0-9_$]+[^}]*\}/g;
const tables = [...src.matchAll(tableRe)];
if (!tables.length) { console.error("没找到平台模块表（前端产物结构可能变了）"); process.exit(3); }
console.log(`找到 ${tables.length} 处候选模块表，取最后（最大）一处：\n`);

let best = tables[0][0];
for (const t of tables) if (t[0].length > best.length) best = t[0];

const pairs = [...best.matchAll(/"([^"]+)":([A-Za-z0-9_$]+)/g)].map((m) => ({ id: m[1], sym: m[2] }));
// 第一个键 `react:` 没有引号，单独补上
const head = /return\{([A-Za-z0-9_$]+):([A-Za-z0-9_$]+),/.exec(best);
if (head && !pairs.some((p) => p.id === head[1])) pairs.unshift({ id: head[1], sym: head[2] });

console.log("── 平台共享模块表（插件可 require 的全部 id）──");
for (const p of pairs) console.log(`   ${p.id.padEnd(46)} → ${p.sym}`);
console.log(`   共 ${pairs.length} 个\n`);
if (NAMES_ONLY) process.exit(0);

// ② 每个模块的导出清单
for (const p of pairs) {
  const defRe = new RegExp(`const ${p.sym}=Object\\.freeze\\(Object\\.defineProperty\\(\\{__proto__:null,`);
  const m = defRe.exec(src);
  if (!m) { console.log(`── ${p.id} ──\n   （未找到 const ${p.sym}=...{__proto__:null,...} 形状的定义；可能被内联或改名）\n`); continue; }
  const open = src.indexOf("{", m.index);
  const body = balanced(src, open);
  if (!body) { console.log(`── ${p.id} ──\n   （配平失败）\n`); continue; }
  const keys = [...body.matchAll(/(?:^|,)([A-Za-z_$][A-Za-z0-9_$]*):/g)].map((x) => x[1])
    .filter((k) => k !== "__proto__");
  console.log(`── ${p.id} ──  导出 ${keys.length} 项`);
  console.log("   " + keys.join(", ") + "\n");
}
