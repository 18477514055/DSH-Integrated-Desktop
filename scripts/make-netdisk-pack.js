"use strict";

/**
 * make-netdisk-pack.js —— 生成**国内网盘分发包**（不依赖 GitHub 的那条路）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有它（用户原话）
 * ═══════════════════════════════════════════════════════════════════════════
 * 「能不能把你的整个资源打包成一个网盘分享的压缩包形式？我们最好做一个像这样的
 *   国内分发方法，**不能完全依赖 github**。」
 *
 * 产出是一个 zip，里面四样东西，拿到包的人**断网也能走完全程**：
 *
 *   DSH-集成桌面端-<版本>/
 *     00-先看我.md                     ← 给目标用户看的说明（怎么装、怎么离线装插件）
 *     安装包/
 *       DSH-Integrated-<版本>-x64.exe          （安装版，NSIS）
 *       DSH-Integrated-<版本>-portable-x64.exe （便携版，可选，--portable）
 *     插件包/
 *       plugin-index.json              ← 与仓库里那份**同格式**（dsh-plugin-index/v1）
 *       plugins/<名字>-<版本>.tgz      ← 每个插件的 npm 包
 *     校验/
 *       SHA256SUMS.txt                 ← 包内每个文件的 sha256（相对路径）
 *
 * 那个 `插件包/` 就是外壳「本地插件包」功能认的形状 —— 用户把它解压到
 * 下载夹 / 桌面 / 应用数据目录任一处的 plugin-pack 里，或者用设置页的
 * 「选择插件包目录…」指给它，就能**离线**把插件装进 DSH（见 src/plugin-pack.js）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 用法
 * ═══════════════════════════════════════════════════════════════════════════
 *   node scripts/make-netdisk-pack.js                 # 只带安装版（约 90 MB）
 *   node scripts/make-netdisk-pack.js --portable      # 再加便携版（约 180 MB）
 *   node scripts/make-netdisk-pack.js --out D:\       # 指定输出目录
 *   node scripts/make-netdisk-pack.js --no-zip        # 只铺目录，不打包（调试用）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三条刻意的决定
 * ═══════════════════════════════════════════════════════════════════════════
 *   ① **索引格式不另立一套**：与 DSH-Plugin-Hub 里那份完全同形，用同一个
 *      schema 常量。生产端加字段，这里与外壳都自动跟着走，不会分叉成两套。
 *   ② **插件 tgz 用 `npm pack` 现打**，不从上传器的归档目录里捞 ——
 *      归档目录里的可能正是用户改了一半的那一版；现打才能保证"包里的字节
 *      = 你眼前这份源码"。且 npm pack 会按插件自己的 files 白名单裁剪。
 *   ③ **sha256 在打包前对每个文件算一遍**并写进校验/SHA256SUMS.txt；
 *      打包后再**回读 zip 成员**核对（不信 tar 的自述）。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = PKG.version;

/** 与 src/plugin-pack.js / src/plugin-catalog.js **同一个** schema 常量（不许分叉）。 */
const SCHEMA = "dsh-plugin-index/v1";
/** 网盘包里装插件包的那一层目录名 —— 与 src/plugin-pack.js 的 PACK_DIRNAME 对应。 */
const PACK_DIRNAME = "plugin-pack";

const argv = process.argv.slice(2);
const WANT_PORTABLE = argv.includes("--portable");
const NO_ZIP = argv.includes("--no-zip");
const outArg = argv.indexOf("--out");
const OUT_DIR = outArg >= 0 && argv[outArg + 1] ? path.resolve(argv[outArg + 1]) : path.join(ROOT, "release");

const problems = [];
const say = (m) => console.log(m);

// ── 小工具 ────────────────────────────────────────────────────────────

function sha256File(abs) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
}

function human(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

/** 递归列文件（相对路径 + 绝对路径）。**不跟随联接** —— 联接由调用方显式处理。 */
function walk(dir, base = dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    let isDirP = false;
    try { isDirP = fs.statSync(p).isDirectory(); } catch { continue; }   // statSync 跟随联接
    if (isDirP) walk(p, base, out);
    else out.push({ rel: path.relative(base, p).replace(/\\/g, "/"), abs: p });
  }
  return out;
}

/** 复制目录树（跟随联接 ⇒ 解引用成真实文件）。 */
function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    const st = (() => { try { return fs.statSync(s); } catch { return null; } })();
    if (!st) continue;
    if (st.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * **自己读 zip 的中央目录**，返回成员名（文件与目录都算）。
 *
 * 为什么不 shell 出去让 `tar -tf` 列：Windows 自带的 bsdtar 在中文 Windows 上
 * 把成员名按 **GBK** 写进 stdout（实测逐字节确认），拿 utf8 解码会**全部认不出**
 * ⇒ 判据会被一个编码问题带偏（2026-09-22 实测：zip 明明 13 个成员齐全，
 * 却报"缺 6 个文件"）。自己读中央目录就没有这一层。
 *
 * 名字解码规则（zip 规范）：general purpose bit 11 置位 ⇒ 名字是 UTF-8；
 * 否则是老式 CP437/本地代码页，中文环境下退化为 GBK。
 */
function readZipMembers(zipPath) {
  const buf = fs.readFileSync(zipPath);
  // ① 从尾部找 End Of Central Directory（0x06054b50），最多回退 64KB 注释
  let eocd = -1;
  const from = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= from; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const out = [];
  for (let n = 0; n < count; n += 1) {
    if (off + 46 > buf.length) break;
    if (buf.readUInt32LE(off) !== 0x02014b50) break;      // 中央目录条目签名
    const flags = buf.readUInt16LE(off + 8);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const raw = buf.subarray(off + 46, off + 46 + nameLen);
    let name;
    if (flags & 0x800) {
      name = raw.toString("utf8");                        // bit 11 ⇒ UTF-8
    } else {
      // 没有 UTF-8 标志：先按 UTF-8 试；出现替换字符说明不是 UTF-8，退 UTF-16LE → GBK
      const asUtf8 = raw.toString("utf8");
      if (asUtf8.includes("\uFFFD")) {
        name = new TextDecoder("gbk").decode(raw);
      } else {
        name = asUtf8;
      }
    }
    out.push(name);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** npm pack 一个插件目录 → 返回打出来的 tgz 绝对路径。 */
function packPlugin(dir) {
  const nodeDir = path.dirname(process.execPath);
  const cli = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
  if (!fs.existsSync(cli)) { problems.push(`找不到 npm-cli.js：${cli}`); return null; }
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-pack-"));
  const r = spawnSync(process.execPath, [cli, "pack", "--pack-destination", dest, "--json", dir],
    { encoding: "utf8", timeout: 180000 });
  if (r.status !== 0) {
    problems.push(`npm pack 失败（${path.basename(dir)}）：${(r.stderr || "").slice(0, 300)}`);
    return null;
  }
  const files = fs.readdirSync(dest).filter((f) => f.endsWith(".tgz"));
  if (files.length !== 1) { problems.push(`npm pack 产出不是恰好一个 tgz：${files.join(",")}`); return null; }
  return path.join(dest, files[0]);
}

// ── ① 先确认安装包在不在 ─────────────────────────────────────────────

say(`网盘分发包 —— DSH 集成桌面端 ${VERSION}\n`);

const artifacts = [`DSH-Integrated-${VERSION}-x64.exe`];
if (WANT_PORTABLE) artifacts.push(`DSH-Integrated-${VERSION}-portable-x64.exe`);

say("① 检查安装包");
for (const n of artifacts) {
  const p = path.join(ROOT, "release", n);
  if (!fs.existsSync(p)) {
    problems.push(`release/ 里缺 ${n} —— 先跑 npm run dist${WANT_PORTABLE ? ":portable" : ""}`);
    say(`   ✗ 缺 ${n}`);
  } else {
    say(`   ✓ ${n}  ${human(fs.statSync(p).size)}`);
  }
}
if (problems.length) {
  say("\n先解决上面的问题再打包。");
  process.exit(1);
}

// ── ② 铺目录 ─────────────────────────────────────────────────────────

const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-netdisk-"));
const packRoot = path.join(stageRoot, `DSH-集成桌面端-${VERSION}`);
const dirInstaller = path.join(packRoot, "安装包");
const dirPluginPack = path.join(packRoot, "插件包");
const dirPlugins = path.join(dirPluginPack, "plugins");
const dirSum = path.join(packRoot, "校验");
for (const d of [dirInstaller, dirPlugins, dirSum]) fs.mkdirSync(d, { recursive: true });
say(`\n② 铺目录 → ${packRoot}`);

for (const n of artifacts) {
  fs.copyFileSync(path.join(ROOT, "release", n), path.join(dirInstaller, n));
}
say(`   安装包：${artifacts.length} 个`);

// ── ③ 打插件包 ───────────────────────────────────────────────────────
//
// 直接读仓库 plugin/ 目录（`plugins.js` 的 listBundledPlugins 已经处理好
// 目录联接与 `_` 前缀排除），再对每个用 npm pack 现打。

say("\n③ 打插件包（npm pack）");
const P = require("../src/plugins.js");
const found = P.listBundledPlugins(path.join(ROOT, "plugin"));
if (!found.length) problems.push("plugin/ 目录里一个插件都没发现");
say(`   发现 ${found.length} 个：${found.map((p) => p.name + "@" + p.version).join("、")}`);

const entries = [];
for (const pl of found) {
  const tgz = packPlugin(pl.dir);
  if (!tgz) continue;
  const base = path.basename(tgz);
  const dest = path.join(dirPlugins, base);
  fs.copyFileSync(tgz, dest);
  const bytes = fs.statSync(dest).size;
  const sha = sha256File(dest);
  entries.push({
    name: pl.name,
    version: pl.version,
    file: base,
    sha256: sha,
    bytes,
    description: String((pl.pkg && pl.pkg.description) || "").slice(0, 300),
    publishedAt: new Date().toISOString(),
    platform: "web",
    repo: "本地插件包（网盘分发）",
  });
  say(`   ✓ ${pl.name}@${pl.version}  ${base}  ${human(bytes)}  sha256 ${sha.slice(0, 12)}…`);
}

if (!entries.length) problems.push("一个插件包都没打出来");

// 索引：**与仓库那份同格式**
const index = {
  schema: SCHEMA,
  updatedAt: new Date().toISOString(),
  repo: "本地插件包（网盘分发）",
  generatedBy: `make-netdisk-pack.js @ DSH Integrated ${VERSION}`,
  entries,
};
fs.writeFileSync(path.join(dirPluginPack, "plugin-index.json"),
  JSON.stringify(index, null, 2) + "\n", "utf8");
say(`   索引：plugin-index.json（${entries.length} 条，schema=${SCHEMA}）`);

// ── ④ 说明文件（给目标用户看） ───────────────────────────────────────

const readme = `# DSH 集成桌面端 ${VERSION} —— 网盘分发包

> 这一包是给**连不上 GitHub**（或懒得折腾）的人准备的：解压即用，
> 插件也能**离线**装，全程不需要访问任何境外站点。

## 里面有什么

\`\`\`
安装包/     DSH-Integrated-${VERSION}-x64.exe${WANT_PORTABLE ? `
            DSH-Integrated-${VERSION}-portable-x64.exe（免安装版）` : ""}
插件包/     plugin-index.json + plugins/*.tgz（我们那套插件的离线安装包）
校验/       SHA256SUMS.txt（包内每个文件的 sha256，自己核一遍更放心）
\`\`\`

## 怎么装客户端

1. 双击 \`安装包/DSH-Integrated-${VERSION}-x64.exe\`，按提示装完（可以改安装目录）。
${WANT_PORTABLE ? "   · 不想装就用便携版：直接运行 `DSH-Integrated-" + VERSION + "-portable-x64.exe`，不写注册表。\n" : ""}2. 第一次启动可能会问你装哪些插件 —— 见下一节。

> ⚠️ **装了新版本必须重装一次**（不是"重启客户端"）。外壳的代码是打进安装目录的，
> 重启不会换代码。装的时候会覆盖，原有的插件与档案都不受影响。

## 怎么装插件（**离线也能装**）

**方式一：让它自己认（推荐）**

把这一包里的 \`插件包\` 整个文件夹**复制到下面任一个位置**，然后打开客户端：

- 你的**下载**文件夹里，命名成 \`plugin-pack\`
- 你的**桌面**上，命名成 \`plugin-pack\`
- 或者哪里都行 —— 打开客户端 → 设置 → **集成版插件** → 「选择插件包目录…」指给它

然后进「设置 → 集成版插件」，往下看**本地插件包**那一栏，点「从插件包装」即可。
第一次启动时的向导也会自动把插件包里的条目列出来，勾上就能装。

**方式二：手动**

插件就是普通的 npm 包，也可以直接：

\`\`\`
dsh plugin --profile web add "路径\\插件包\\plugins\\dsh-int-multi-session-0.1.1.tgz"
\`\`\`

## 装完要重启一次

插件写进档案后，内核要重读一次档案才会加载 —— **重启一次客户端**即可
（设置页装完会给你一个「重启内核」按钮）。

## 校验（可选，但建议）

在 \`校验\` 目录里：

\`\`\`powershell
# 逐条核对这个包里每个文件的 sha256
Get-Content SHA256SUMS.txt | ForEach-Object {
  $h,$f = $_ -split '\\s+',2
  $got = (Get-FileHash -Algorithm SHA256 -Path (Join-Path .. $f)).Hash.ToLower()
  if ($got -eq $h) { "OK   $f" } else { "BAD  $f" }
}
\`\`\`

## 这一包是从哪来的

由仓库里的 \`scripts/make-netdisk-pack.js\` 生成，源码地址：
https://github.com/18477514055/DSH-Integrated-Desktop

生成时间：${new Date().toISOString()}

## 我们一共有哪几条下载渠道（想更新时看这里）

| # | 渠道 | 适合谁 | 说明 |
|---|---|---|---|
| ① | **GitHub Releases**（主渠道） | 能上 GitHub | https://github.com/18477514055/DSH-Integrated-Desktop/releases |
| ② | **国内网盘包**（就是这一包） | 上不了 GitHub | 含安装包 **+ 插件包**，全程不需要境外站点 |
| ③ | **插件走 npm** | 想单独装/更新插件 | \`dsh plugin --profile web add dsh-int-xxx\` |
| ④ | **客户端里的插件页** | 已经装了客户端 | 外壳设置 → 集成版插件；**插件无需重装客户端** |

★ **装了客户端之后，以后升级不用再回来下载**：客户端里
**外壳设置 → 更新 → 检查更新** 就能升（它会同时看线上与本机）。

★ **这一包里的是"某个时点的快照"**：插件版本按打包当时算，
所以网盘包里的插件可能**比 npm 上的新**（npm 上的是发过一次就定住的）。
想要最新插件就走 ①/③。

> 完整说明（含校验方法、常见问题、给分享对象的注意事项）在仓库里：
> **\`docs/下载与安装渠道.md\`**
`;
fs.writeFileSync(path.join(packRoot, "00-先看我.md"), readme, "utf8");
say("\n④ 说明文件：00-先看我.md");

// ── ⑤ 校验和 ─────────────────────────────────────────────────────────

say("\n⑤ 算 sha256");
const allFiles = walk(packRoot);
const sumLines = allFiles.map((f) => `${sha256File(f.abs)}  ${f.rel}`);
fs.writeFileSync(path.join(dirSum, "SHA256SUMS.txt"), sumLines.join("\n") + "\n", "utf8");
say(`   ${sumLines.length} 个文件已登记（SHA256SUMS.txt 本身不在其中）`);

// ── ⑥ 打包 zip（bsdtar；Windows 自带） ───────────────────────────────

let zipPath = null;
if (!NO_ZIP) {
  say("\n⑥ 打 zip");
  const tar = path.join(process.env.SystemRoot || "C:\\Windows", "system32", "tar.exe");
  if (!fs.existsSync(tar)) {
    problems.push(`找不到 ${tar}`);
  } else {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    zipPath = path.join(OUT_DIR, `DSH-集成桌面端-${VERSION}-网盘包.zip`);
    try { fs.rmSync(zipPath, { force: true }); } catch { /* 没有就算了 */ }
    const r = spawnSync(tar, ["-a", "-c", "-f", zipPath, "-C", stageRoot, path.basename(packRoot)],
      { encoding: "utf8", timeout: 900000 });
    if (r.status !== 0) {
      problems.push(`tar 打包失败：${(r.stderr || "").slice(0, 300)}`);
    } else {
      const bytes = fs.statSync(zipPath).size;
      say(`   → ${zipPath}  ${human(bytes)}`);

      // ★ 回读：不信 tar 的自述。查魔数 + 列出成员名并核对。
      //
      // ⚠️ 2026-09-22 实测踩到的坑（**量具自己撒谎**）：Windows 自带的 bsdtar
      //   在**中文 Windows** 上把成员名按 **GBK(936)** 写进 stdout（实测逐字节
      //   `44 53 48 2d bc af b3 c9 d7 c0 c3 e6 b6 cb 2d ...` = "DSH-集成桌面端-"），
      //   同时它把**参数**按 UTF-8 输出（所以 ASCII 的 `-tf` 没事）。
      //   于是拿 utf8 解码去比对中文成员名 ⇒ **全部认不出**，
      //   报一堆"zip 里缺 xxx"，而 zip 其实完全正常（13 个成员一个不少）。
      //   ⇒ 判据不能用子进程的输出编码，必须**自己从 zip 的中央目录读**：
      //     zip 的 general purpose bit 11 置位时名字是 UTF-8，否则按 GBK 兜。
      const members = readZipMembers(zipPath);
      say(`   回读（直接读 zip 中央目录，不经过子进程编码）：${members.length} 个成员`);
      for (const m of members.slice(0, 4)) say(`     · ${m}`);

      const base = path.basename(packRoot);
      const norm = (s) => s.replace(/\\/g, "/").replace(/\/+$/, "");
      const have = new Set(members.map(norm));
      const must = [
        `${base}/00-先看我.md`,
        `${base}/插件包/plugin-index.json`,
        `${base}/校验/SHA256SUMS.txt`,
      ];
      for (const m of must) {
        if (!have.has(m)) problems.push(`zip 里缺 ${m}`);
      }
      for (const en of entries) {
        const m = `${base}/插件包/plugins/${en.file}`;
        if (!have.has(m)) problems.push(`zip 里缺插件包 ${en.file}`);
      }
      for (const n of artifacts) {
        const m = `${base}/安装包/${n}`;
        if (!have.has(m)) problems.push(`zip 里缺安装包 ${n}`);
      }
      if (members.length === 0) problems.push("zip 中央目录读不出任何成员");
    }
  }
} else {
  say("\n⑥ 跳过打包（--no-zip）");
}

// ── ⑦ 汇总 ───────────────────────────────────────────────────────────

say("\n⑦ 汇总");
say(`   安装包 ${artifacts.length} 个 / 插件包 ${entries.length} 个 / 目录 ${path.basename(packRoot)}`);
if (zipPath) say(`   zip：${zipPath}`);
else say(`   铺好的目录：${packRoot}`);

if (problems.length) {
  say("\n❌ 有问题：");
  for (const p of problems) say("   · " + p);
  process.exit(2);
}
say("\n✅ 完成。");
say("提醒：网盘上传要**你自己点** —— 我没有网盘凭据。");
if (zipPath) say(`要传的文件就是：${zipPath}`);
