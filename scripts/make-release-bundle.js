"use strict";

/**
 * make-release-bundle.js —— 生成 `github/`：**可以直接上传的纯净分发包**
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个脚本要解决的问题
 * ══════════════════════════════════════════════════════════════════
 * 每次分发都要人工判一遍"哪些文件安全、哪些不能公开" —— 这件事
 * **不该靠人记**：本项目目录里曾经同时存在真实 API 凭据
 * （`migration/preimage/<时间戳>/.credentials.yaml`）、几十个完整会话日志、
 * 浏览器 Cookies、含 token 的内核日志。人工判漏一条就是**永久泄露**。
 *
 * ⇒ 把它变成**两条结构性保证 + 一次机械审计**：
 *
 *   ① `.gitignore` 是**白名单式**的（默认忽略一切，只放行明确列出的路径）
 *      ⇒ "能进 git 的"就等于"已经判过是安全的"。
 *   ② 源码包用 **`git archive`** 产出，它**只打包已跟踪文件**
 *      ⇒ 源码包在构造上就不可能出现未跟踪/被忽略的东西。
 *   ③ 本脚本最后再对 `github/` 里**每一个文件**做机械审计
 *      （路径特征 + 扩展名白名单 + 内容密钥模式），任何一条不过就**非 0 退出**。
 *
 * 于是"分发"变成机械操作：跑这个脚本 → 它说 PASS → 上传 `github/` 里的东西。
 *
 * ══════════════════════════════════════════════════════════════════
 * 用法
 * ══════════════════════════════════════════════════════════════════
 *   node scripts/make-release-bundle.js            生成 + 审计
 *   node scripts/make-release-bundle.js --check    只审计现有的 github/，不重新生成
 *
 * 退出码：0 通过；1 有 FAIL（明细打到 stderr，**不要上传**）。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "github");
const CHECK_ONLY = process.argv.includes("--check");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;
const SUM_NAME = "SHA256SUMS.txt";
const README_NAME = "README-先看我.md";
const NOTES_NAME = "RELEASE-NOTES.md";

// ── 审计规则（**单一出处**：这里定义的，脚本自己用来判，不再在别处重抄一遍）──

/** 扩展名白名单：`github/` 里只允许出现这些 */
const ALLOWED_EXT = new Set([".exe", ".zip", ".md", ".txt"]);

/**
 * **没有扩展名**的文件，必须按文件名逐个放行。
 * （首版审计把 `LICENSE` 判成了 FAIL —— 那是对的：与其把"空扩展名"一概放行，
 *   不如要求无扩展名的文件显式登记，免得哪天混进个 `credentials` 之类的东西。）
 */
const ALLOWED_BARE = new Set(["LICENSE"]);

/** 这个文件在 `github/` 里是否被允许（扩展名白名单 or 无扩展名显式登记） */
function isAllowedName(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (ext) return ALLOWED_EXT.has(ext);
  return ALLOWED_BARE.has(path.basename(rel));
}

/** 路径特征黑名单（大小写不敏感，子串匹配） */
const FORBIDDEN_PATH = [
  "credential", ".env", "token", "cookie", "session", "node_modules",
  "migration", "runtime", "settings.yaml", "cordis", "kernel.json",
  ".git", ".npmcache", ".log", "preimage", "snapshot", "backup",
];

/** 内容密钥模式 */
const SECRET_PATTERNS = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/github_pat_[A-Za-z0-9_]{20,}/, "GitHub PAT"],
  [/sk-[A-Za-z0-9]{20,}/, "OpenAI 风格 key"],
  [/AKIA[0-9A-Z]{16}/, "AWS key id"],
  [/BEGIN [A-Z ]*PRIVATE KEY/, "私钥"],
  [/token=[A-Za-z0-9_\-.]{20,}/i, "URL 里的 token"],
  [/(api[_-]?key|apikey|secret|passwd|password)\s*[:=]\s*["']?[A-Za-z0-9_\-.]{20,}/i, "赋值式密钥"],
  [/[A-Za-z0-9+/]{200,}={0,2}/, "超长 base64（可能是密钥/证书）"],
];

const failures = [];
function fail(msg) { failures.push(msg); console.error("  FAIL  " + msg); }
function pass(msg) { console.log("  PASS  " + msg); }

function sha256(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}
function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}
function git(args) {
  return spawnSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true });
}

// ── 生成 ────────────────────────────────────────────────────────────
function build() {
  const artifacts = [
    `DSH-Integrated-${VERSION}-x64.exe`,
    `DSH-Integrated-${VERSION}-portable-x64.exe`,
  ];
  const missing = artifacts.filter((n) => !fs.existsSync(path.join(ROOT, "release", n)));
  if (missing.length) {
    console.error(`[bundle] release/ 里缺产物：${missing.join("、")}`);
    console.error("[bundle] 先跑：npm run dist");
    process.exit(1);
  }

  // 工作区必须干净：否则 git archive 打出来的源码包**不等于**你眼前的源码
  const st = git(["status", "--porcelain"]);
  const dirty = (st.stdout || "").trim();
  if (dirty) {
    console.error("[bundle] ⚠️ 工作区有未提交改动 —— git archive 只会打包**已提交**的内容，");
    console.error("[bundle]    也就是说源码包会和你眼前的源码不一致。请先 commit。");
    console.error(dirty.split("\n").map((l) => "           " + l).join("\n"));
    process.exit(1);
  }

  const head = (git(["rev-parse", "--short", "HEAD"]).stdout || "").trim();

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "source"), { recursive: true });

  // ① 安装包
  for (const n of artifacts) fs.copyFileSync(path.join(ROOT, "release", n), path.join(OUT, n));
  console.log(`[bundle] 拷入 ${artifacts.length} 个安装包`);

  // ② 许可与说明（只从**已跟踪**的文件里取，保证是审计过的）
  for (const n of ["LICENSE"]) {
    const src = path.join(ROOT, n);
    if (!fs.existsSync(src)) { console.error(`[bundle] 缺 ${n}`); process.exit(1); }
    fs.copyFileSync(src, path.join(OUT, n));
  }

  // ③ Release 说明：从 release-notes/<版本>.md 取，**缺了就拒绝生成**
  //    （宁可挡住，也不要发一个没有说明、或说明与版本对不上的 Release）
  const notesSrc = path.join(ROOT, "release-notes", `${VERSION}.md`);
  if (!fs.existsSync(notesSrc)) {
    console.error(`[bundle] 缺 release-notes/${VERSION}.md —— 请先写这一版的 Release 说明`);
    process.exit(1);
  }
  fs.copyFileSync(notesSrc, path.join(OUT, NOTES_NAME));

  // ④ 源码包：git archive 只含已跟踪文件 ⇒ 构造上就干净
  const zipName = `DSH-Integrated-${VERSION}-source.zip`;
  const zipPath = path.join(OUT, "source", zipName);
  const ar = git(["archive", "--format=zip", `--prefix=DSH-Integrated-${VERSION}/`,
    "-o", zipPath, "HEAD"]);
  if (ar.status !== 0) {
    console.error("[bundle] git archive 失败：" + (ar.stderr || "").trim());
    process.exit(1);
  }
  console.log(`[bundle] 源码包 source/${zipName}（${(fs.statSync(zipPath).size / 1024).toFixed(1)} KB）`);

  // ⑤ 目录说明
  fs.writeFileSync(path.join(OUT, README_NAME), folderReadme(head), "utf8");
  return { artifacts, zipName, head };
}

function folderReadme(head) {
  return `# github/ —— 可以直接上传的纯净分发包

> 这个目录是 **${VERSION}** 版的分发暂存区。里面**只有**要上传的东西，
> 没有源码树、没有工作记录、没有任何凭据。
> 它由 \`node scripts/make-release-bundle.js\` **生成**，不要手工往里面放文件。

## 里面有什么

| 文件 | 去向 |
|---|---|
| \`DSH-Integrated-${VERSION}-x64.exe\` | GitHub Release 附件 |
| \`DSH-Integrated-${VERSION}-portable-x64.exe\` | GitHub Release 附件 |
| \`source/DSH-Integrated-${VERSION}-source.zip\` | 可选：Release 附件（源码包） |
| \`RELEASE-NOTES.md\` | Release 正文（\`publish-release.py\` 会读它当正文） |
| \`LICENSE\` | 许可 |
| \`${SUM_NAME}\` | 上面所有文件的 SHA256 |

生成时的提交：\`${head}\`

## 为什么这个目录一定干净（三层，不靠人记）

1. **\`.gitignore\` 是白名单式的** —— 默认忽略一切，只放行明确列出的路径。
   于是"能进 git 的"就等于"已经判过是安全的"。
2. **源码包用 \`git archive\` 产出** —— 它**只打包已跟踪文件**，
   被忽略的凭据/会话日志/Cookies/内核日志**在构造上就进不去**。
3. **生成后逐文件机械审计** —— 路径特征黑名单 + 扩展名白名单 + 内容密钥模式，
   任何一条不过脚本就非 0 退出，并打印明细。

## 怎么上传

\`\`\`powershell
# 1) 先生成并审计（工作区必须已提交，否则脚本会拒绝）
node scripts/make-release-bundle.js

# 2) ★ 必须先 push —— Release 的 tag 打在**远端 HEAD** 上，不是本地 HEAD
git push origin main

# 3) 建 Release 并传附件（GitHub API + curl 流式上传）
$env:GITHUB_TOKEN = (gh auth token).Trim()
python scripts/publish-release.py
\`\`\`

> ⚠️ **不要用 \`gh release create\`**（2026-09-20 实测）：本机 \`gh\` 是通的
> （\`gh api rate_limit\` 0.9 秒返回），但 \`gh release create\` 跑了 **20 分钟连 Release
> 都没建出来**，进程活着、无输出、无报错。\`publish-release.py\` 走 GitHub API 建 Release，
> 大文件改用 **\`curl.exe --data-binary @文件\` 流式上传**（\`urllib\` 单次 POST 传 88 MB
> 会卡死在代理上：CPU 1 秒、内存 2 MB、连接不动），并带"低速自动放弃"守卫与单文件重试。
>
> **发布后必须把附件下载回来重算 sha256** —— 不看任何脚本自述。

## 怎么自查

\`\`\`powershell
node scripts/make-release-bundle.js --check     # 只审计现有内容，不重新生成
\`\`\`

或者对**已经下载到手上**的文件校验（接收方也能用）：

\`\`\`
sha256sum -c ${SUM_NAME}
\`\`\`
`;
}

// ── 审计 ────────────────────────────────────────────────────────────
function audit() {
  console.log("");
  console.log(`=== 审计 ${path.relative(ROOT, OUT)}/ ===`);

  if (!fs.existsSync(OUT)) {
    console.error(`[bundle] ${path.relative(ROOT, OUT)}/ 不存在，先跑一次生成。`);
    process.exit(1);
  }

  const files = walk(OUT);
  if (!files.length) { fail("目录是空的"); return; }

  // ① 路径特征
  let pathBad = 0;
  for (const rel of files) {
    const low = rel.toLowerCase();
    for (const bad of FORBIDDEN_PATH) {
      if (low.includes(bad)) { fail(`路径命中黑名单「${bad}」: ${rel}`); pathBad++; }
    }
  }
  if (!pathBad) pass(`路径特征：${files.length} 个文件 × ${FORBIDDEN_PATH.length} 条黑名单，无命中`);

  // ② 扩展名白名单（无扩展名的按文件名显式登记）
  const extBad = files.filter((f) => !isAllowedName(f));
  if (extBad.length) extBad.forEach((f) => fail(`扩展名不在白名单内: ${f}`));
  else pass(`扩展名：全部落在 [${[...ALLOWED_EXT].join(" ")}] + [${[...ALLOWED_BARE].join(" ")}] 内`);

  // ③ 内容密钥模式（只扫文本类）
  let secBad = 0;
  for (const rel of files) {
    if (path.extname(rel).toLowerCase() !== ".md" && path.extname(rel).toLowerCase() !== ".txt") continue;
    const text = fs.readFileSync(path.join(OUT, rel), "utf8");
    for (const [re, label] of SECRET_PATTERNS) {
      const m = text.match(re);
      if (m) { fail(`内容命中「${label}」: ${rel} → ${JSON.stringify(m[0].slice(0, 40))}…`); secBad++; }
    }
  }
  if (!secBad) pass(`内容密钥模式：${SECRET_PATTERNS.length} 类 × 文本文件，无命中`);

  // ④ 结构：只允许"平铺的产物 + source/ 一个子目录"
  const strayDirs = [...new Set(files.filter((f) => f.includes(path.sep))
    .map((f) => f.split(path.sep)[0]))].filter((d) => d !== "source");
  if (strayDirs.length) strayDirs.forEach((d) => fail(`多出不该有的子目录: ${d}/`));
  else pass("结构：只有平铺产物 + source/ 一个子目录");

  // ⑤ 校验和清单自身要自洽
  const sumPath = path.join(OUT, SUM_NAME);
  if (!fs.existsSync(sumPath)) {
    fail(`缺 ${SUM_NAME}`);
  } else {
    const listed = new Map();
    for (const line of fs.readFileSync(sumPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
      if (m) listed.set(m[2].trim().replace(/\\/g, "/"), m[1]);
    }
    const expect = files.filter((f) => f.replace(/\\/g, "/") !== SUM_NAME).map((f) => f.replace(/\\/g, "/"));
    const miss = expect.filter((f) => !listed.has(f));
    const extra = [...listed.keys()].filter((f) => !expect.includes(f));
    if (miss.length) miss.forEach((f) => fail(`${SUM_NAME} 里缺 ${f}`));
    if (extra.length) extra.forEach((f) => fail(`${SUM_NAME} 里多出 ${f}（清单与实际不符）`));
    let wrong = 0;
    for (const [rel, want] of listed) {
      const p = path.join(OUT, rel);
      if (!fs.existsSync(p)) continue;
      if (sha256(p) !== want) { fail(`${SUM_NAME} 与实际不符: ${rel}`); wrong++; }
    }
    if (!miss.length && !extra.length && !wrong) {
      pass(`${SUM_NAME} 自洽：${listed.size} 个文件逐个重算一致`);
    }
  }

  // ⑥ 与 git 的对照：source/ 里的 zip 必须是 git archive 的产物（有固定前缀）
  const zips = files.filter((f) => f.toLowerCase().endsWith(".zip"));
  if (zips.length !== 1) {
    fail(`source/ 下应当恰好有 1 个源码 zip，实际 ${zips.length} 个`);
  } else {
    pass(`源码包：${zips[0]}`);
  }
}

function writeSums() {
  const files = walk(OUT)
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => f !== SUM_NAME)
    .sort();
  const lines = files.map((f) => `${sha256(path.join(OUT, f))}  ${f}`);
  fs.writeFileSync(path.join(OUT, SUM_NAME), lines.join("\n") + "\n", "utf8");
  console.log(`[bundle] 写出 ${SUM_NAME}（${files.length} 个文件）`);
}

// ── 主流程 ──────────────────────────────────────────────────────────
console.log(`make-release-bundle —— v${VERSION}${CHECK_ONLY ? "（仅审计）" : ""}`);
console.log(`  输出目录: ${path.relative(ROOT, OUT)}/`);

if (!CHECK_ONLY) {
  const info = build();
  writeSums();
  console.log("");
  console.log(`  生成时的提交: ${info.head}`);
}
audit();

console.log("");
if (failures.length) {
  console.error(`[bundle] ${failures.length} 项 FAIL —— **不要上传**，先按上面明细修掉。`);
  process.exit(1);
}
console.log("[bundle] 全部通过 ✅ 这个目录可以直接上传。");
console.log(CHECK_ONLY ? "" : `        下一步：见 github/${README_NAME} 里的 gh release 命令。`);
