/**
 * slot-catalog.js —— 打印官方前端**槽位目录**里指定槽位的完整契约。
 *
 * 为什么需要它（2026-09-21）：客户端插件要往官方界面里加东西，唯一的入口是
 * `ctx.slots.inject("<槽位名>", ...)`。而"槽位名 / 能传哪些注册选项 / 组件能拿到哪些 props /
 * 别人是否已经占了 / 最小示例"这份契约，**只存在于** `dsh-cordis-client-runner/lib/client.js`
 * 里的 `CLIENT_SLOT_API` 数组（它同时是 `cordis_inspect what:"client"` 喂给模型的那份数据）。
 * 那个文件 26 万字符、制表符缩进，直接打开没法看 ⇒ 本脚本只抠你要的那几条。
 *
 * 用法：
 *   node scripts/slot-catalog.js                 # 列出全部槽位（key / kind / scope）
 *   node scripts/slot-catalog.js shell.overlay   # 打印指定槽位的完整契约
 *   node scripts/slot-catalog.js --grep overlay  # 按子串筛
 *   node scripts/slot-catalog.js --raw shell.overlay   # 连 example 原文一起打（默认就打）
 */
const fs = require("node:fs");
const path = require("node:path");

function findBundle() {
  const base = path.join(process.env.APPDATA || "", "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai");
  const f = path.join(base, "dsh-cordis-client-runner", "lib", "client.js");
  return fs.existsSync(f) ? f : null;
}

/** 从 `[` 起做方括号配平（跳过字符串），返回数组内的原文。 */
function balanced(src, openIdx, open = "[", close = "]") {
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
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return src.slice(openIdx + 1, i); }
  }
  return null;
}

/** 把数组原文按**顶层** `{...}` 切成若干条 entry。 */
function splitEntries(body) {
  const out = [];
  let depth = 0, start = -1, inStr = false, quote = "", esc = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = true; quote = c; continue; }
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") { depth--; if (depth === 0 && start >= 0) { out.push(body.slice(start, i + 1)); start = -1; } }
  }
  return out;
}

/** 取 entry 里某个顶层字段的值原文（字符串则去引号并反转义）。 */
function field(entry, name) {
  // 字段出现在**顶层**：前面是 `{` 或 `,\n\t\t\t` 这种缩进
  const re = new RegExp(`(?:^|[,{\\s])${name}:\\s*`, "m");
  const m = re.exec(entry);
  if (!m) return undefined;
  let i = m.index + m[0].length;
  if (entry[i] === '"' || entry[i] === "'" || entry[i] === "`") {
    const q = entry[i];
    let out = "", esc = false;
    for (i++; i < entry.length; i++) {
      const c = entry[i];
      if (esc) { out += c === "n" ? "\n" : c === "t" ? "\t" : c; esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === q) return out;
      out += c;
    }
    return out;
  }
  if (entry[i] === "[") return balanced(entry, i);
  return entry.slice(i).split("\n")[0].replace(/,$/, "").trim();
}

const argv = process.argv.slice(2);
const grepAt = argv.indexOf("--grep");
const grep = grepAt >= 0 ? argv[grepAt + 1] : null;
const wanted = argv.filter((a) => !a.startsWith("--") && a !== grep);

const bundle = findBundle();
if (!bundle) { console.error("找不到 dsh-cordis-client-runner/lib/client.js"); process.exit(2); }
const src = fs.readFileSync(bundle, "utf8");
const at = src.indexOf("const CLIENT_SLOT_API = [");
if (at < 0) { console.error("没找到 CLIENT_SLOT_API 数组（前端产物结构可能变了）"); process.exit(3); }
const body = balanced(src, src.indexOf("[", at));
if (!body) { console.error("CLIENT_SLOT_API 配平失败"); process.exit(3); }

const entries = splitEntries(body);
console.log(`槽位目录: ${entries.length} 条  (来自 ${bundle})\n`);

const rows = entries.map((e) => ({
  key: field(e, "key"), kind: field(e, "kind"), scope: field(e, "scope"),
  risk: field(e, "replaceRisk"), by: field(e, "declaredBy"),
  occ: field(e, "occupants"), raw: e,
}));

if (wanted.length === 0 && !grep) {
  for (const r of rows) console.log(`  ${String(r.key).padEnd(42)} ${String(r.kind).padEnd(8)} ${r.scope}`);
  console.log(`\n想看某条的完整契约：node scripts/slot-catalog.js <槽位名>`);
  process.exit(0);
}

const list = rows.filter((r) => (grep ? String(r.key).includes(grep) : wanted.includes(r.key)));
if (!list.length) { console.error("没有匹配的槽位:", wanted.join(", ") || grep); process.exit(4); }

for (const r of list) {
  console.log("═".repeat(78));
  console.log(`槽位      : ${r.key}`);
  console.log(`cardinality: ${r.kind}   scope: ${r.scope}   replaceRisk: ${r.risk}`);
  console.log(`谁让它存在 : ${r.by}`);
  console.log(`现有占用   : ${r.occ}`);
  const summary = field(r.raw, "summary");
  if (summary) console.log(`\n摘要      : ${summary}`);
  const opts = field(r.raw, "registerOptions");
  if (opts) {
    console.log(`\n── 注册选项 registerOptions ──`);
    for (const o of splitEntries(opts)) console.log(`   ${field(o, "name")} (${field(o, "requirement")}, ${field(o, "type")}) — ${field(o, "doc")}`);
  }
  const props = field(r.raw, "ownerProps");
  if (props) {
    console.log(`\n── 拥有者传给组件的 props ──`);
    for (const p of splitEntries(props)) {
      const re = /interface\s+(\w+)/; const m = re.exec(p);
      console.log(`   ${m ? m[1] : "(未知)"}`);
      for (const line of p.split("\n")) {
        if (/^\s*(\/\*\*|\*|\w+:)/.test(line) && !/^\s*\*\//.test(line)) console.log(`      ${line.trim()}`);
      }
    }
  }
  const std = field(r.raw, "standardProps");
  if (std) console.log(`\n── 框架给的标准 props ──\n   ${std.replace(/\n\s*/g, " ").replace(/,$/, "")}`);
  const inj = field(r.raw, "slotInject");
  if (inj && inj !== "undefined") console.log(`\n── 槽位级 inject 面 ──\n   ${inj}`);
  const doc = field(r.raw, "doc");
  if (doc && doc !== summary) console.log(`\n── 契约全文 ──\n${doc}`);
  const ex = field(r.raw, "example");
  if (ex) console.log(`\n── 最小示例（官方给的）──\n${ex}`);
  console.log("");
}
