"use strict";

/**
 * plugin-catalog.js —— 「集成版插件清单」的**数据来源**
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个文件是外壳与生产端之间的**唯一接口点**（刻意隔出来的一道缝）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   生产端（另一个项目）                     消费端（本外壳）
 *   D:\DSH工作区002\1.DSH插件上传器\   ──▶   plugin-catalog.js  ← 只有它认识索引格式
 *        └─ 推到 18477514055/DSH-Plugin-Hub         │  产出：一份"要装哪个 .tgz、sha256 是多少"
 *             （plugin-index.json + Release 附件）    ▼
 *                                              plugin-install.js  ← 只认「目录 / .tgz / sha256」
 *
 * **索引格式变了，只改这一个文件。** 别把索引字段漏到 UI 或安装层去。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 容错原则（**遇到读不懂的东西一律不猜**）
 * ═══════════════════════════════════════════════════════════════════════════
 *   · 索引版本（schema）不认识 ⇒ **不报错、照读，但把版本号回报给界面**，
 *     让用户知道"这份清单可能比外壳新"。
 *   · 单条缺必填字段（name / version / downloadUrl）⇒ **跳过那一条**并记账，
 *     不让一条坏数据把整个清单打没。
 *   · 缺 `sha256` ⇒ 保留条目但**标记为"未校验"**（装的时候会退化成只查传输完整）。
 *   · 未知字段（将来生产端加 tier / hidden 之类）⇒ **原样留在 `raw` 里**，
 *     认识的就用，不认识的不报错。这样生产端加字段不需要外壳先升级。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 与 update.js 的分工
 * ═══════════════════════════════════════════════════════════════════════════
 *   版本比较**不另写一份** —— 复用 `update.js` 的 `cmpVersion`
 *   （它已经验过 `0.2.10 > 0.2.9` 与 `0.2.4-rc.1 < 0.2.4` 这两个容易写错的点）。
 *   同一把尺子量两个地方，才不会出现"外壳说该更新、插件清单说不用"。
 */

const fs = require("node:fs");
const path = require("node:path");

const { cmpVersion } = require("./update.js");

// ── 索引的位置与版本 ───────────────────────────────────────────────────

/** 生产端仓库。插件也可以住在**别的仓库**里（索引里每条的 downloadUrl 是绝对地址）。 */
const HUB_REPO = "18477514055/DSH-Plugin-Hub";
const HUB_BRANCH = "main";
const INDEX_FILE = "plugin-index.json";
const KNOWN_SCHEMA = "dsh-plugin-index/v1";

const UA = "dsh-integrated-desktop-plugin-store";

/**
 * 允许的下载来源主机。
 *
 * ★ 这不是洁癖：这几步最终会把**别人的代码装进用户的家**，让它跑在用户的内核里。
 *   所以"从哪里下"必须是个**写死的边界**，而不是"索引说哪就哪"。
 *   索引本身也来自 GitHub ⇒ 索引被改坏也顶多让下载失败，不能让它指向任意主机。
 */
const ALLOWED_HOSTS = [
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "codeload.github.com",
];

/**
 * 开发工具类插件：**仍然列出来，但默认不勾选**，并打上「开发者工具」标签。
 *
 * ★★ 2026-09-23：**这张名单现在是空的**（原来是 `dsh-plugin-uploader`）。
 *   用户原话：「我认为它应该是一个普通插件，而不是只局限在开发者工具之上。」
 *   ⇒ 上传器（插件上传器）**不再是开发者工具**：它对任何想发布自己插件的人都有用，
 *     它的"只属于作者本人"的那部分（远端仓库地址、代理）已经改成**用户自己填**
 *     （见 `1.DSH插件上传器\plugin\dsh-plugin-uploader\lib\core.mjs` 的 `EXAMPLE_REPO`
 *      与 `DEFAULT_SETTINGS`：repo / proxy 都刻意没有默认值）。
 *
 * ★ 为什么"清空名单"还不够、**数据侧也要改**（两边都做了）：
 *   下面 `isDevOnly()` 的判据顺序是"**先读索引字段**，读不到才退回落名单"。
 *   生产端现在会往索引条目里写 `tier: "plugin"`（普通插件）——
 *   于是**外壳不改代码**就能把它当普通插件（这正是下面那段注释写的设计意图：
 *   "生产端一旦补上字段，外壳不用改就能生效"）。
 *   但**老索引里没有 `tier`** ⇒ 会退回落名单 ⇒ 还是被判成开发者工具。
 *   所以这张名单也必须清掉这一条，否则"改了生产端"与"外壳里的名单"会互相打架。
 *
 * ★ 这个机制本身**留着**：将来真有"只给开发者用"的插件，靠它或靠索引的
 *   `tier: "dev"` 标记即可，不必再改代码。
 */
const DEV_ONLY_FALLBACK = new Set();

// ── 小工具（纯函数，可在普通 node 里单测）─────────────────────────────

function str(v) {
  return typeof v === "string" ? v.trim() : (typeof v === "number" ? String(v) : "");
}

function isHttpUrl(u, { httpsOnly = false } = {}) {
  try {
    const parsed = new URL(String(u));
    if (httpsOnly && parsed.protocol !== "https:") return false;
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return parsed;
  } catch { return false; }
}

/** 下载地址必须 https + 落在允许的主机里。 */
function isAllowedDownloadUrl(u) {
  const parsed = isHttpUrl(u, { httpsOnly: true });
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

/** 从下载地址里抠出 owner/repo，用于界面上显示"来自哪个仓库"。 */
function repoOf(url) {
  try {
    const p = new URL(String(url));
    const parts = p.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  } catch { /* 忽略 */ }
  return "";
}

function indexUrl(repo = HUB_REPO, branch = HUB_BRANCH) {
  return `https://raw.githubusercontent.com/${repo}/${branch}/${INDEX_FILE}`;
}

// ── 归一化（纯函数）────────────────────────────────────────────────────

/**
 * 把索引里的**一条**变成外壳内部认的形状。
 *
 * @returns {{entry:?object, errors:string[], warnings:string[]}}
 */
function normalizeEntry(raw) {
  const errors = [];
  const warnings = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { entry: null, errors: ["这一条不是对象"], warnings };
  }

  const name = str(raw.name);
  const version = str(raw.version);
  const downloadUrl = str(raw.downloadUrl) || str(raw.browserDownloadUrl);

  if (!name) errors.push("缺 name");
  else if (!/^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    errors.push(`name 不像合法包名：${name}`);
  }
  if (!version) errors.push("缺 version");
  if (!downloadUrl) errors.push("缺 downloadUrl");
  else if (!isAllowedDownloadUrl(downloadUrl)) {
    errors.push(`downloadUrl 不在允许的来源里（只允许 https + GitHub 主机）：${downloadUrl}`);
  }

  // 必填不齐 ⇒ 整条跳过（不让一条坏数据把清单打没）
  if (errors.length) return { entry: null, errors, warnings };

  const sha256 = str(raw.sha256).toLowerCase();
  if (!sha256) warnings.push("这条没给 sha256 ⇒ 装上时不校验内容，只查传输完整");
  else if (!/^[0-9a-f]{64}$/.test(sha256)) {
    warnings.push(`sha256 格式不对（${sha256.slice(0, 12)}…）⇒ 当作没有`);
  }

  const bytesRaw = raw.bytes;
  const bytes = Number.isFinite(Number(bytesRaw)) && Number(bytesRaw) > 0 ? Number(bytesRaw) : 0;
  if (!bytes) warnings.push("这条没给 bytes ⇒ 不做大小核对");

  const platform = str(raw.platform);
  // 本外壳跑的是 web profile；索引说别的平台就标成不适用（**不静默藏起来**）
  const compatible = !platform || platform === "web";

  const keywords = Array.isArray(raw.keywords) ? raw.keywords.map(str).filter(Boolean) : [];

  return {
    entry: {
      name,
      version,
      downloadUrl,
      // sha256 格式不对时当成没有 —— 宁可走"未校验"的降级路径，也不拿一个坏哈希去比对
      sha256: /^[0-9a-f]{64}$/.test(sha256) ? sha256 : "",
      bytes,
      file: str(raw.file),
      description: str(raw.description),
      releaseUrl: str(raw.releaseUrl),
      publishedAt: str(raw.publishedAt),
      platform,
      compatible,
      keywords,
      repo: repoOf(downloadUrl) || HUB_REPO,
      raw,                                  // 未知字段原样留着，将来加字段不用改外壳
    },
    errors,
    warnings,
  };
}

/**
 * 把**整份**索引变成 `{ schema, updatedAt, entries, skipped, warnings }`。
 * 一条读不懂只丢那一条，其余照用。
 */
function normalizeIndex(raw) {
  const out = {
    schema: "", knownSchema: false, updatedAt: "", repo: "",
    entries: [], skipped: [], warnings: [],
  };
  if (!raw || typeof raw !== "object") {
    out.skipped.push("整份索引不是对象");
    return out;
  }

  out.schema = str(raw.schema);
  out.knownSchema = !out.schema || out.schema === KNOWN_SCHEMA;
  out.updatedAt = str(raw.updatedAt);
  out.repo = str(raw.repo) || HUB_REPO;

  if (!out.knownSchema) {
    out.warnings.push(
      `索引版本是 ${out.schema}，外壳认识的是 ${KNOWN_SCHEMA} ⇒ 照读，但可能有字段读不到`
    );
  }

  const list = Array.isArray(raw.entries) ? raw.entries : null;
  if (!list) {
    out.skipped.push("entries 不是数组");
    return out;
  }

  list.forEach((r, i) => {
    const { entry, errors, warnings } = normalizeEntry(r);
    if (entry) {
      out.entries.push(entry);
      for (const w of warnings) out.warnings.push(`${entry.name}@${entry.version}：${w}`);
    } else {
      const nm = r && typeof r === "object" ? (str(r.name) || `#${i + 1}`) : `#${i + 1}`;
      out.skipped.push(`${nm}：${errors.join("；")}`);
    }
  });

  return out;
}

/** 这个插件是不是开发工具（默认不勾）。优先读索引字段，读不到才退回落名单。 */
function isDevOnly(entry) {
  const rawTier = str(entry.raw && entry.raw.tier).toLowerCase();
  if (rawTier) return rawTier === "dev" || rawTier === "developer";
  if (entry.raw && entry.raw.hidden === true) return true;
  if (entry.keywords.some((k) => /^(dev|developer|tooling)$/i.test(k))) return true;
  return DEV_ONLY_FALLBACK.has(entry.name);
}

/**
 * 按包名归组，每组里版本从高到低排（**用 update.js 的 cmpVersion，不另写一把尺子**）。
 * @returns {Array<{name, latest, versions, newestAt, devOnly, compatible}>}
 */
function groupByName(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!map.has(e.name)) map.set(e.name, []);
    map.get(e.name).push(e);
  }
  const groups = [];
  for (const [name, list] of map) {
    const sorted = list.slice().sort((a, b) => cmpVersion(b.version, a.version));
    groups.push({
      name,
      latest: sorted[0],
      versions: sorted,
      newestAt: sorted.map((e) => e.publishedAt).filter(Boolean).sort().pop() || "",
      devOnly: sorted.some(isDevOnly),
      compatible: sorted[0].compatible,
    });
  }
  // 名字排序：先按"是不是开发工具"（普通插件在前），再按名字
  groups.sort((a, b) => (a.devOnly === b.devOnly ? a.name.localeCompare(b.name) : (a.devOnly ? 1 : -1)));
  return groups;
}

/**
 * 把这个清单与"本机已装的"对一遍，给出每条该显示什么状态。
 *
 * @param {Array} groups            groupByName 的结果
 * @param {Array} installed         plugin-install.js 的 listInstalled().plugins
 * @returns {Array} 每项多出 { state, localSource, local, remoteVersion,
 *                            canInstall, canReplace, canUpdate, canUninstall }
 *
 * ★★ 状态机的关键一条（2026-09-21 用户点出来的）：
 *   **"本机已装"不等于"从我们仓库装的"**。本机可能有 dev 联接、本地 tgz、从 npm 装的包。
 *   第一版只看 `local.dirExists`，于是会给一个**已经装着的**插件显示「安装」按钮 ——
 *   点下去会把它在档案里的指向改掉，用户**悄悄失去"改源码即时生效"**。
 *   （真机实测：B 家装着 11 个插件，第一版一个都没认出来、报「已装 0」。）
 *   现在：本地装的 → state=`local`，按钮是**「改用仓库版」**且界面会先问一句，
 *   而不是一个看起来无害的「安装」。
 */
function mergeInstalled(groups, installed) {
  const byName = new Map((installed || []).map((p) => [p.name, p]));
  return groups.map((g) => {
    const local = byName.get(g.name) || null;
    const remoteVersion = g.latest ? g.latest.version : "";

    let state = "not-installed";
    if (local && local.source === "hub") {
      // 我们装的：能判"该不该更新"，也能判"落点还在不在"
      if (!local.dirExists) state = "broken";
      else if (local.enabled === false) state = "disabled";
      else state = cmpVersion(remoteVersion, local.version) > 0 ? "update" : "installed";
    } else if (local) {
      // 本地装的（dev 联接 / 本地 tgz / npm）—— 它**确实装着**，只是来路不同。
      state = "local";
    }

    return {
      ...g,
      state,
      localSource: local ? local.source : "",
      local: local ? {
        version: local.version,
        target: local.target,
        source: local.source,
        enabled: local.enabled,
        junctionOk: local.junctionOk,
        dirExists: local.dirExists,
      } : null,
      remoteVersion,
      canInstall: state === "not-installed" || state === "broken",
      // 本地装着的：**不**给普通安装按钮，只给"改用仓库版"（界面会先问一句）
      canReplace: state === "local" && !!remoteVersion,
      canUpdate: state === "update" || state === "disabled",
      canUninstall: !!local,
    };
  });
}

// ── 网络与缓存（这几个要用 Electron 的 net ⇒ 走系统代理）──────────────

/** 本地缓存文件：断网时清单还能显示上一份（并标明是旧的）。 */
function cacheFile() {
  const { app } = require("electron");
  return path.join(app.getPath("userData"), "plugin-index-cache.json");
}

function readCache() {
  try {
    const raw = fs.readFileSync(cacheFile(), "utf8").replace(/^\uFEFF/, "");
    const j = JSON.parse(raw);
    if (j && j.index && j.fetchedAt) return j;
  } catch { /* 没有缓存 / 读坏了都算没有 */ }
  return null;
}

function writeCache(index, url) {
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify({
      fetchedAt: new Date().toISOString(), url, index,
    }, null, 2) + "\n", "utf8");
  } catch { /* 缓存写不进去不影响功能 */ }
}

/**
 * 拉索引。**只读**，不改本机任何东西（除了那份缓存）。
 *
 * @param {{repo?:string, branch?:string, timeoutMs?:number, force?:boolean}} opts
 * @returns {Promise<{ok:boolean, index:?object, groups:Array, fetchedAt:string,
 *                    stale:boolean, error:string, source:string}>}
 */
async function fetchIndex(opts = {}) {
  const { net } = require("electron");
  const repo = opts.repo || HUB_REPO;
  const branch = opts.branch || HUB_BRANCH;
  const url = indexUrl(repo, branch);
  const timeoutMs = Number(opts.timeoutMs) || 20000;

  const fail = (error) => {
    const cached = readCache();
    // ★ 2026-09-22 修：「检查插件更新」（force=true）**也要**能退回缓存。
    //
    //   原来的 `cached && !opts.force` 有个很坑的后果：用户看着好好的清单，
    //   点一下「检查插件更新」——本来只是想看看有没有新版本 ——
    //   却因为断网而把列表整个变成「拿不到插件清单」，连"断网时还能看到上一份"
    //   这条兜底都被自己的按钮关掉了。**主动检查不该比不检查结果更差。**
    //
    //   force 现在只表示"**别用过期的内存快照、去网上再要一次**"，
    //   不再表示"不许 fallback"。退回缓存时如实标 stale=true，界面照旧会
    //   写明「这次没连上插件仓库，显示的是缓存（时间）」—— 用户不会被误导。
    if (cached) {
      const idx = normalizeIndex(cached.index);
      return {
        ok: true, index: idx, groups: groupByName(idx.entries),
        fetchedAt: cached.fetchedAt, stale: true, error, source: "cache",
      };
    }
    return { ok: false, index: null, groups: [], fetchedAt: "", stale: false, error, source: "none" };
  };

  let res;
  try {
    res = await net.fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return fail(`取插件清单失败（连不上）：${(e && e.message) || e}`);
  }
  if (res.status === 404) return fail(`插件清单不存在（HTTP 404）：${url}`);
  if (!res.ok) return fail(`插件清单拉取失败（HTTP ${res.status}）`);

  let raw;
  try {
    raw = await res.json();
  } catch (e) {
    return fail(`插件清单不是合法 JSON：${(e && e.message) || e}`);
  }

  const index = normalizeIndex(raw);
  const fetchedAt = new Date().toISOString();
  writeCache(raw, url);
  return {
    ok: true, index, groups: groupByName(index.entries),
    fetchedAt, stale: false, error: "", source: "network",
  };
}

/**
 * 把一份已归档的版本下载到临时目录。
 * 顺手做两件事：**大小核对** + **sha256 核对由 plugin-install.js 做**（那里是咽喉）。
 *
 * @returns {Promise<{ok:boolean, path?:string, error?:string, bytes?:number}>}
 */
async function downloadArchive(entry, onProgress = () => {}) {
  const { app, net } = require("electron");
  if (!entry || !entry.downloadUrl) return { ok: false, error: "这条没有下载地址" };
  if (!isAllowedDownloadUrl(entry.downloadUrl)) {
    return { ok: false, error: `下载地址不在允许的来源里：${entry.downloadUrl}` };
  }

  const safeName = String(entry.file || `${entry.name}-${entry.version}.tgz`).replace(/[^\w.+-]/g, "_");
  const dir = path.join(app.getPath("temp"), "dsh-plugin-downloads");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, safeName);

  let res;
  try {
    res = await net.fetch(entry.downloadUrl, {
      headers: { "User-Agent": UA },
      redirect: "follow",
      signal: AbortSignal.timeout(180000),
    });
  } catch (e) {
    return { ok: false, error: `下载失败：${(e && e.message) || e}` };
  }
  if (!res.ok) return { ok: false, error: `下载被拒（HTTP ${res.status}）` };

  let buf;
  try {
    const total = Number(res.headers.get("content-length") || entry.bytes || 0);
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (reader) {
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        got += value.length;
        try { onProgress({ got, total, percent: total ? Math.floor((got / total) * 100) : 0 }); } catch { /* 回调自己出错不影响下载 */ }
      }
      buf = Buffer.concat(chunks);
    } else {
      buf = Buffer.from(await res.arrayBuffer());
      try { onProgress({ got: buf.length, total: buf.length, percent: 100 }); } catch { /* 忽略 */ }
    }
  } catch (e) {
    return { ok: false, error: `读取下载内容失败：${(e && e.message) || e}` };
  }

  // 大小核对：截断是常态，别把半个包交给安装层
  if (entry.bytes && buf.length !== entry.bytes) {
    return { ok: false, error: `下载不完整（${buf.length}/${entry.bytes} 字节）—— 已丢弃，请重试` };
  }

  try {
    fs.writeFileSync(dest, buf);
  } catch (e) {
    return { ok: false, error: `写文件失败：${(e && e.message) || e}` };
  }
  return { ok: true, path: dest, bytes: buf.length };
}

/** 删掉刚才下载的临时包（装完就没用了 —— 插件本体已经拷进 <DSH_HOME>\plugins）。 */
function cleanupArchive(file) {
  try { if (file) fs.rmSync(file, { force: true }); } catch { /* 忽略 */ }
}

module.exports = {
  // 常量
  HUB_REPO, HUB_BRANCH, INDEX_FILE, KNOWN_SCHEMA, ALLOWED_HOSTS, DEV_ONLY_FALLBACK,
  // 纯函数（可在普通 node 里单测）
  indexUrl, repoOf, isAllowedDownloadUrl, normalizeEntry, normalizeIndex,
  groupByName, mergeInstalled, isDevOnly,
  // 需要 Electron 的
  fetchIndex, downloadArchive, cleanupArchive,
  readCache, writeCache, cacheFile,
};
