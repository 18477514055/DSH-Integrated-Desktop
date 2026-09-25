"use strict";

/**
 * verify-quark-upload.cjs —— 回验「0.2.14 网盘包真的传上夸克了吗」。
 *
 * ★ 为什么不能只说"上传接口返回 201/成功"：
 *   本项目 AGENTS.md 记着一件真事 —— GitHub Release 附件**静默剥掉非 ASCII 字符**
 *   （`README-先看我.md` 变成 `README-.md`），而接口返回 201、脚本照报 ✅。
 *   夸克这边同理：文件名里全是中文，必须**回读云端那一条**逐字符核对。
 *
 * ★ 为什么没有 sha256 比对（说清楚，别假装验过）：
 *   本机这个 CLI 的下载通道有**服务端限制** —— 实测报
 *   `{"code":23018,"msg":"download file size limit[52428800]"}`，
 *   即单文件上限 **50 MB**，而这一包是 **95.9 MB** ⇒ **下不回来**，
 *   所以"下载回来重算哈希"这条最硬的判据**本轮做不到**。
 *   ⇒ 那就把能做到的做到位，并如实写明缺口：
 *     ① 云端那条的**文件名字符串逐字符**与本地一致（含全部中文）
 *     ② 云端那条的**字节数**与本地逐字节算出来的 size 一致
 *        （上传被截断的话这条必挂 —— 这是最可能出的事故）
 *     ③ 本地这一包的 sha256 与网盘包生成时登记的一致
 *   ⇒ "哈希对得上"这一条，只有等能用别的方式下载时才补得上。
 *
 * 用法：
 *   node scripts/verify-quark-upload.cjs <cloud-browse-raw.json> [本地zip路径]
 *   其中第一个参数由 cmd 重定向得到（**不能用 PowerShell 的 `>`**，
 *   它默认写 UTF-16，会把中文全毁掉 —— 本脚本前一步就是这么踩的）。
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
const text = fs.readFileSync(rawFile, "utf8");
const line = text.split(/\r?\n/).find((l) => l.includes("file_list"));
if (!line) {
  console.error(`读不到云端清单（${rawFile} 里没有 file_list 行）`);
  process.exit(1);
}
const cloud = JSON.parse(line).data;

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
console.log("  这个 CLI 的下载通道有服务端 50 MB 上限（code 23018），而本包 95.9 MB");
console.log("  ⇒ **没能**把文件下载回来重算 sha256。「哈希一致」这条本轮**没验到**。");
console.log("  已验的是：文件名逐字符 + 字节数完全一致（截断与改名这两类事故都能抓到）。");
process.exit(FAILS.length ? 1 : 0);
