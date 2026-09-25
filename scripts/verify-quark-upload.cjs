"use strict";

/**
 * verify-quark-upload.cjs —— 回验「网盘包真的传上夸克了吗」（0.2.14 起用，0.2.15 起通吃两种 browse 输出）。
 *
 * ★ 为什么不能只说"上传接口返回 201/成功"：
 *   本项目 AGENTS.md 记着一件真事 —— GitHub Release 附件**静默剥掉非 ASCII 字符**
 *   （`README-先看我.md` 变成 `README-.md`），而接口返回 201、脚本照报 ✅。
 *   夸克这边同理：文件名里全是中文，必须**回读云端那一条**逐字符核对。
 *
 * ★ 为什么没有 sha256 比对（说清楚，别假装验过）：
 *   本机这个 CLI 的下载通道有**服务端限制** —— 实测报
 *   `{"code":23018,"msg":"download file size limit[52428800]"}`，
 *   即单文件上限 **50 MB**，而网盘包向来在 90 MB 以上 ⇒ **下不回来**，
 *   所以"下载回来重算哈希"这条最硬的判据**做不到**（`download` 也没有分段/range 选项，查过）。
 *   ⇒ 那就把能做到的做到位，并如实写明缺口：
 *     ① 云端那条的**文件名字符串逐字符**与本地一致（含全部中文）
 *     ② 云端那条的**字节数**与本地逐字节算出来的 size 一致
 *        （上传被截断的话这条必挂 —— 这是最可能出的事故）
 *     ③ 本地这一包的 sha256 打印出来，供下载后自己核
 *   ⇒ "哈希对得上"这一条，只有等能用别的方式下载时才补得上。
 *
 * 用法：
 *   node scripts/verify-quark-upload.cjs <cloud-browse-raw.json> [本地zip路径]
 *   第一个参数是 `quark-drive.cjs browse …` 的**原始输出**（带不带 --verbose 都行）。
 *   ⚠️ 落盘时**不能用 PowerShell 的 `>`**（默认写 UTF-16，会把中文全毁掉）——
 *      用 `cmd /c "… > 文件"` 或 Node 的 `fs.writeFileSync(…, 'utf8')`。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const rawFile = process.argv[2];
const localZip = process.argv[3]
  || path.join(__dirname, "..", "release", "DSH-集成桌面端-0.2.14-网盘包.zip");

if (!rawFile) {
  console.error("用法: node scripts/verify-quark-upload.cjs <cloud-browse-raw.json> [本地zip]");
  process.exit(2);
}

let OK = 0;
const FAILS = [];
function chk(cond, label, extra) {
  if (cond) { OK++; console.log(`  OK   ${label}`); }
  else { FAILS.push(label + (extra ? `  <-- ${extra}` : "")); console.log(`  FAIL ${label}${extra ? "  <-- " + extra : ""}`); }
}

console.log("verify-quark-upload —— 云端那条真的就是本地这一包吗");

// ── 读云端回读结果（原始字节按 UTF-8 解；读不到就明确报错）──
//
// ★ 2026-09-25 加：**夸克 CLI 的两种 browse 输出都要吃得下** ——
//   · `browse --parent-fid <fid> --verbose` ⇒ 一行里带 `… body={"data":{"file_list":[…]}}`
//     （**带前缀，不能直接 JSON.parse** —— 第一版就是这么假失败的）；
//   · `browse --parent-fid <fid>`（不带 --verbose）⇒ 每个文件一行独立 JSON，
//     `data.filename` / `data.size`，没有 `file_list` 包装。
//   两种都是 CLI 的**原始输出**，脚本负责归一化，不要求调用方先加工。
const text = fs.readFileSync(rawFile, "utf8");
const lines = text.split(/\r?\n/).filter(Boolean);

function jsonOf(s) {
  try { return JSON.parse(s); } catch { return null; }
}

let cloud = null;
for (const l of lines) {
  const i = l.indexOf("body=");
  if (i >= 0) {
    const j = jsonOf(l.slice(i + "body=".length).trim());
    const d = j && j.data;
    if (d && Array.isArray(d.file_list)) { cloud = d; break; }
  }
}
if (!cloud) {
  for (const l of lines) {
    const j = jsonOf(l.trim());
    if (j && j.data && Array.isArray(j.data.file_list)) { cloud = j.data; break; }
  }
}
if (!cloud) {
  // 不带 --verbose 的形状：逐行一个文件
  const rows = lines.map((l) => jsonOf(l.trim()))
    .filter((j) => j && j.data && typeof j.data.filename === "string")
    .map((j) => ({ filename: j.data.filename, size: j.data.size }));
  if (rows.length) cloud = { total: rows.length, file_list: rows };
}
if (!cloud) {
  console.error(`读不到云端清单（${rawFile} 里既没有 file_list，也没有逐文件行）`);
  process.exit(1);
}

console.log(`\n云端目录共 ${cloud.total} 项：`);
for (const f of cloud.file_list) console.log(`  · ${f.filename}  ${f.size} B`);

const localName = path.basename(localZip);
const localSize = fs.statSync(localZip).size;
const hit = cloud.file_list.find((f) => f.filename === localName);

console.log("");
const base = localName.replace(/\.zip$/, "");
chk(!!hit, `★ 云端有「${localName}」这一条`, hit ? "" : `云端只有：${cloud.file_list.map((f) => f.filename).join("、")}`);

if (hit) {
  // ① 文件名逐字符
  chk(hit.filename === localName, "★★ 文件名**逐字符**相同（中文没被剥掉 / 没被改名）",
    `云端 ${JSON.stringify(hit.filename)} / 本地 ${JSON.stringify(localName)}`);
  const cps = [...hit.filename].map((c) => c.codePointAt(0));
  const hasCJK = cps.some((c) => c >= 0x4e00 && c <= 0x9fff);
  chk(hasCJK, "★ 云端文件名里**真的还有汉字**（不是被换成 ASCII 或问号）",
    `码点 ${cps.map((c) => c.toString(16)).join(" ")}`);

  // ② 字节数（上传被截断的话这条必挂）
  chk(hit.size === localSize, "★★ 云端字节数与本地**完全一致**（排除上传截断）",
    `云端 ${hit.size} / 本地 ${localSize}`);

  // ③ 前缀对不对（防止传成上一个版本）
  chk(hit.filename.includes(base), "★ 云端那个就是本次这一版（不是旧版本混进来了）", base);
}

// ── ④ 本地这一包的 sha256（如实登记；云端哈希本轮拿不到）──
{
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(localZip, "r");
  const buf = Buffer.allocUnsafe(1 << 20);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  console.log(`\n  本地 sha256 = ${h.digest("hex")}`);
  console.log(`  本地 size   = ${localSize}`);
}

console.log(`\n${"=".repeat(64)}`);
console.log(`verify-quark-upload：${OK} OK / ${FAILS.length} FAIL`);
if (FAILS.length) { console.log("失败项："); for (const f of FAILS) console.log("  · " + f); }
console.log("\n★ 缺口（不许当成通过）：");
console.log(`  这个 CLI 的下载通道有服务端 **50 MB 上限**（实测 code 23018），`
  + `而本包 ${(localSize / 1048576).toFixed(1)} MB`);
console.log("  ⇒ **没能**把文件下载回来重算 sha256。「哈希一致」这条本轮**没验到**。");
console.log("  已验的是：文件名逐字符 + 字节数完全一致（截断与改名这两类事故都能抓到）。");
process.exit(FAILS.length ? 1 : 0);
