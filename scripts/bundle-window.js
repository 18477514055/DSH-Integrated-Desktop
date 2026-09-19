/**
 * bundle-window.js —— 在**压缩过的 bundle**里只看限定窗口，绝不整行倒进上下文。
 *
 * 为什么需要它（2026-09-21 一天里需要了四次）：官方前端 / 插件的 `lib/client.js`
 * 是 esbuild 产物，很多是**单行几十万字符**。直接 `grep`/`cat` 会把整行灌进上下文
 * （一次就能烧掉几万 token，而且没有可读性）。本脚本只打印每个命中点**前后各 N 字符**。
 *
 * 用法：
 *   node scripts/bundle-window.js <文件> <正则> [--before 200] [--after 600] [--hits 5]
 *   node scripts/bundle-window.js <文件> "hot-" --after 400 --hits 3
 *   node scripts/bundle-window.js <文件> "insert" --before 500 --after 500 --hits 13 --all
 *
 * 选项：
 *   --before N   命中点前打印多少字符（默认 200）
 *   --after  N   命中点后打印多少字符（默认 600）
 *   --hits   N   最多打印几个命中（默认 5）
 *   --all        打印全部命中（等价于把 --hits 设得很大）
 *   --count      只打印命中数，不打印窗口
 *
 * 退出码：0=有命中  2=文件读不到  3=正则非法  4=零命中
 */
const fs = require("node:fs");

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const opt = (name, def) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? Number(argv[i + 1]) : def;
};
const has = (name) => argv.includes("--" + name);

const file = positional[0];
const pattern = positional[1];
if (!file || !pattern) {
  console.error("用法: node bundle-window.js <文件> <正则> [--before N] [--after N] [--hits N] [--all] [--count]");
  process.exit(2);
}
if (!fs.existsSync(file)) { console.error("文件不存在:", file); process.exit(2); }

let re;
try { re = new RegExp(pattern, "g"); } catch (e) { console.error("正则非法:", e.message); process.exit(3); }

const src = fs.readFileSync(file, "utf8");
const before = opt("before", 200);
const after = opt("after", 600);
const limit = has("all") ? Infinity : opt("hits", 5);

const hits = [...src.matchAll(re)];
console.log(`文件: ${file}`);
console.log(`大小: ${src.length} 字符 | 正则: /${pattern}/g | 命中: ${hits.length}`);
if (has("count")) process.exit(hits.length ? 0 : 4);
if (!hits.length) process.exit(4);

let shown = 0;
for (const m of hits) {
  if (shown >= limit) { console.log(`\n…（还有 ${hits.length - shown} 处未打印；需要就看 --hits/--all）`); break; }
  const s = Math.max(0, m.index - before);
  const e = Math.min(src.length, m.index + m[0].length + after);
  console.log(`\n──── #${shown + 1} @${m.index} ────`);
  console.log(src.slice(s, e));
  shown++;
}
