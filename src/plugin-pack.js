"use strict";

/**
 * plugin-pack.js —— 「本地插件包」这一来源（**第三来源，离线可用**）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有它（用户原话）
 * ═══════════════════════════════════════════════════════════════════════════
 * 「不能完全依赖 github」「在连接不上仓库的情况下，也要检查一下本地，
 *   这样的话，别人可以从网盘中把我的插件下载下来，然后在集成版插件中把它安装上去。」
 *
 * 现状（0.2.7 之前）的真实缺口：
 *   · 断网时**清单**有缓存兜底（plugin-catalog.js 的 readCache），列表还看得见；
 *   · 但**装不了** —— 安装那步只认 entry.downloadUrl，必然要走 GitHub。
 *   · 而且「检查插件更新」按钮用 force:true，会把缓存兜底也一并关掉 ⇒
 *     点一下反而把好好的列表变成「拿不到插件清单」。（那个 UX bug 一并修，见 main.js）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 形状：一个文件夹，里面两样东西
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   <包目录>/
 *     plugin-index.json      ← 与仓库里那份**同格式**（dsh-plugin-index/v1）
 *     plugins/
 *       dsh-int-mobile-remote-0.4.0.tgz
 *       ...
 *
 * 网盘包里由 `scripts/make-netdisk-pack.js` 生成。**索引格式不另立一套** ——
 * 复用 plugin-catalog.js 的 normalizeIndex，所以生产端加字段这里自动跟着走。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 安全边界（与网络来源**同一套**，一处都不放松）
 * ═══════════════════════════════════════════════════════════════════════════
 *   · 渲染进程**永远递不进路径**：包目录只有两种来路 —— ① 主进程自己扫候选位置，
 *     ② 用户在原生目录选择框里点出来的（IPC 存进 settings）。渲染进程只能递**包名**。
 *   · .tgz 照旧过 `plugin-install.js` 的 `validatePluginDir` + sha256 + `installFromArchive`
 *     —— 本地文件**不跳过任何一道校验**。
 *   · sha256：索引里给了就逐字节核对；没给则**在扫描时**算一遍并记下来，
 *     安装前再算一次比对（防止"扫完之后文件被换掉"这个 TOCTOU 窗口）。
 *   · 只读：本模块不写任何东西（连缓存都不写）。落到 <DSH_HOME>\plugins 那一步
 *     仍然只由 plugin-install.js 做，且它自己带 A 环境拒写闸。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/** 与 plugin-catalog.js 的 INDEX_FILE 同名同格式 —— 刻意不另立格式。 */
const INDEX_FILE = "plugin-index.json";
/** 网盘包里放 tgz 的子目录。 */
const PLUGINS_SUBDIR = "plugins";
/**
 * 装插件包的那一层可能叫什么。
 *
 * ★ 2026-09-22 实测抓到的真 bug（只有"生产端 × 消费端交叉验证"才发现）：
 *   生产端（make-netdisk-pack.js）把索引放在 `<包>\插件包\plugin-index.json`，
 *   而这里原来只试 `plugin-index.json` 与 `plugin-pack/plugin-index.json`（都是 ASCII）
 *   ⇒ **三种摆法一个都认不到**，测试里 found 全是 false。
 *   修法不是改生产端去迁就消费端，而是**两边都认**：用户手里的包可能来自任一版本。
 */
const PACK_SUBDIR_NAMES = ["plugin-pack", "插件包"];
/** 网盘包解压后那一层的名字（`make-netdisk-pack.js` 产出时用同一个常量）。 */
const PACK_DIRNAME = "DSH-集成桌面端-插件包";

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function readJson(p) {
  try {
    let raw = fs.readFileSync(p, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);   // 剥 BOM（PowerShell 写过的 JSON 会带）
    return JSON.parse(raw);
  } catch { return null; }
}

/** 流式算 sha256（与 plugin-install.js 同一实现，不引依赖）。 */
function sha256File(abs) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/**
 * 候选位置。**顺序即优先级**（先找到先用）。
 *
 * 为什么放这么多：用户的解压位置不可预测 —— 有人解到下载夹、有人解到桌面、
 * 有人直接把里面的 plugin-pack 拖出来。与其让他找对位置，不如多找几个地方。
 * 找不到也无所谓：设置页里有「选择插件包目录…」这个明确的按钮兜底。
 *
 * @param {{userData?:string, downloads?:string, desktop?:string, explicit?:string}} p
 */
function candidateDirs(p = {}) {
  const out = [];
  const push = (d) => { if (d && !out.includes(d)) out.push(d); };

  // ① 用户明确点过的那一个（最高优先级 —— 他比我们清楚）
  push(p.explicit);
  // ② 应用自己的数据目录（放这儿不受清理下载夹影响）
  if (p.userData) push(path.join(p.userData, "plugin-pack"));
  // ③ 下载夹的常见形态
  if (p.downloads) {
    push(path.join(p.downloads, "plugin-pack"));
    push(path.join(p.downloads, PACK_DIRNAME, "plugin-pack"));
    push(path.join(p.downloads, PACK_DIRNAME));
  }
  // ④ 桌面
  if (p.desktop) {
    push(path.join(p.desktop, PACK_DIRNAME, "plugin-pack"));
    push(path.join(p.desktop, PACK_DIRNAME));
  }
  return out;
}

/**
 * 在一个目录里找插件包。**尽量宽**：用户怎么解压、怎么命名都应该能认出来。
 *
 * 覆盖这些摆放（实测过的真包结构见 make-netdisk-pack.js 的产出）：
 *   · dir/plugin-index.json                      直接指到 pack 根
 *   · dir/plugin-pack/plugin-index.json          （网盘包的内部目录名）
 *   · dir/插件包/plugin-index.json                （中文目录名，实测就是这个）
 *   · dir/DSH-集成桌面端-<版本>/插件包/…          指到解压出来的最外层
 *
 * @returns {{found:boolean, dir:?string, indexFile:?string, pluginsDir:?string, tried:string[]}}
 */
function inspectDir(dir) {
  const tried = [];
  if (!dir) return { found: false, dir: null, indexFile: null, pluginsDir: null, tried };
  /** 每个中层目录名都要试"它自己"与"它的下一层"，两种解压深度都认。 */
  const shapes = [dir];
  for (const mid of PACK_SUBDIR_NAMES) shapes.push(path.join(dir, mid));
  // 再往下探一层：<dir>/<版本目录>/插件包/…（用户直接指到解压出来的那一层）
  shapes.push(path.join(dir, PACK_DIRNAME, "plugin-pack"));
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!isDir(path.join(dir, e.name))) continue;          // 跟随联接判目录
      for (const mid of PACK_SUBDIR_NAMES) shapes.push(path.join(dir, e.name, mid));
    }
  } catch { /* 目录读不了就只试上面那些 */ }

  for (const s of shapes) {
    tried.push(s);
    const idx = path.join(s, INDEX_FILE);
    if (!isFile(idx)) continue;
    // tgz 目录：优先 plugins/，其次与索引同级（有人会把 tgz 直接摊在根上）
    const sub = path.join(s, PLUGINS_SUBDIR);
    return {
      found: true,
      dir: s,
      indexFile: idx,
      pluginsDir: isDir(sub) ? sub : s,
      tried,
    };
  }
  return { found: false, dir: null, indexFile: null, pluginsDir: null, tried };
}

/** 依次试候选目录，返回第一个能用的。 */
function findPack(dirs) {
  const tried = [];
  for (const d of Array.isArray(dirs) ? dirs : []) {
    const r = inspectDir(d);
    tried.push(...r.tried);
    if (r.found) return { ...r, tried };
  }
  return { found: false, dir: null, indexFile: null, pluginsDir: null, tried };
}

/**
 * 把一份本地索引读成外壳认的形状。
 *
 * ★ 与网络来源的差别只有一处：**下载地址换成"本地文件"**。
 *   所以这里不复用 `normalizeEntry`（它硬要求 https + 允许主机），
 *   而是自己归一化后，仍交给 `normalizeIndex` 之外的**同一套** groupByName /
 *   mergeInstalled 去处理 —— 界面那一侧完全不知道这条来自本地还是网络。
 *
 * @param {{dir:string, indexFile:string, pluginsDir:string}} pack
 * @param {string} rawIndex  已解析的索引对象
 * @returns {{ok:boolean, entries:Array, skipped:string[], warnings:string[], missing:string[]}}
 */
function normalizePack(pack, rawIndex) {
  const out = { ok: false, entries: [], skipped: [], warnings: [], missing: [] };
  if (!rawIndex || typeof rawIndex !== "object") {
    out.skipped.push("整份索引不是对象");
    return out;
  }
  const list = Array.isArray(rawIndex.entries) ? rawIndex.entries : null;
  if (!list) { out.skipped.push("entries 不是数组"); return out; }

  for (const raw of list) {
    if (!raw || typeof raw !== "object") { out.skipped.push("这一条不是对象"); continue; }
    const name = String(raw.name || "").trim();
    const version = String(raw.version || "").trim();
    if (!name || !version) { out.skipped.push(`${name || "（无名）"}：缺 name 或 version`); continue; }

    // 文件名：索引优先，否则按我们的命名约定推
    const file = String(raw.file || "").trim() || `${name}-${version}.tgz`;
    const abs = path.join(pack.pluginsDir, path.basename(file));   // ★ basename：不许用 ../ 跳出包目录
    if (!isFile(abs)) { out.missing.push(file); continue; }

    let sha = String(raw.sha256 || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) {
      // 索引没给（或给坏了）⇒ 现在算一遍记下来。安装前会再算一次比对。
      try { sha = sha256File(abs); } catch { sha = ""; out.warnings.push(`${name}@${version}：算不出 sha256`); }
    }
    let bytes = Number(raw.bytes) || 0;
    if (!bytes) { try { bytes = fs.statSync(abs).size; } catch { bytes = 0; } }

    out.entries.push({
      name,
      version,
      // 与网络条目同形，但下载地址是**本地文件**；UI 靠 local=true 区分措辞
      localFile: abs,
      local: true,
      file: path.basename(abs),
      bytes,
      sha256: sha,
      description: String(raw.description || ""),
      publishedAt: String(raw.publishedAt || ""),
      platform: String(raw.platform || ""),
      compatible: !raw.platform || raw.platform === "web",
      keywords: Array.isArray(raw.keywords) ? raw.keywords.map((k) => String(k)) : [],
      repo: String(raw.repo || "本地插件包"),
      raw,
    });
  }
  out.ok = true;
  return out;
}

/**
 * 读一个已经定位好的插件包。
 *
 * @returns {{ok:boolean, dir:string, entries:Array, skipped:string[], warnings:string[],
 *            missing:string[], updatedAt:string, error:string}}
 */
function readPack(pack) {
  const bad = (error) => ({
    ok: false, dir: (pack && pack.dir) || "", entries: [],
    skipped: [], warnings: [], missing: [], updatedAt: "", error,
  });
  if (!pack || !pack.found) return bad("没找到本地插件包");

  const raw = readJson(pack.indexFile);
  if (!raw) return bad(`插件包里的 ${INDEX_FILE} 读不出来（不是合法 JSON？）：${pack.indexFile}`);

  const n = normalizePack(pack, raw);
  return {
    ok: n.ok,
    dir: pack.dir,
    entries: n.entries,
    skipped: n.skipped,
    warnings: n.warnings,
    missing: n.missing,
    updatedAt: String(raw.updatedAt || ""),
    error: n.ok ? "" : "索引格式读不懂",
  };
}

/**
 * 一步到位：给候选目录 + 可选显式目录，返回"找到了什么"。
 * 主进程只调这一个。
 *
 * @param {{dirs?:string[], explicit?:string}} opts
 */
function scan(opts = {}) {
  const dirs = Array.isArray(opts.dirs) ? opts.dirs.slice() : [];
  if (opts.explicit && !dirs.includes(opts.explicit)) dirs.unshift(opts.explicit);
  const pack = findPack(dirs);
  if (!pack.found) {
    return {
      ok: false, found: false, dir: "", entries: [], skipped: [], warnings: [],
      missing: [], updatedAt: "", error: "", tried: pack.tried,
    };
  }
  const r = readPack(pack);
  return { ...r, found: true, tried: pack.tried };
}

/**
 * 安装前复算 sha256 —— 关掉"扫完之后文件被换掉"那个 TOCTOU 窗口。
 * @returns {{ok:boolean, error?:string, sha256?:string}}
 */
function verifyLocalFile(entry) {
  if (!entry || !entry.localFile) return { ok: false, error: "这条没有本地文件" };
  if (!isFile(entry.localFile)) return { ok: false, error: `本地文件不在了：${entry.localFile}` };
  let got;
  try { got = sha256File(entry.localFile); } catch (e) {
    return { ok: false, error: `读不了本地文件：${(e && e.message) || e}` };
  }
  if (entry.sha256 && got !== entry.sha256) {
    return { ok: false, error: `本地文件在扫描之后被改动过（sha256 不符）—— 拒绝安装\n期望 ${entry.sha256}\n实际 ${got}` };
  }
  return { ok: true, sha256: got };
}

module.exports = {
  INDEX_FILE, PLUGINS_SUBDIR, PACK_DIRNAME, PACK_SUBDIR_NAMES,
  candidateDirs, inspectDir, findPack, normalizePack, readPack, scan, verifyLocalFile,
  sha256File, readJson, isDir, isFile,
};
