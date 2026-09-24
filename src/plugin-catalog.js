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
  // ★ 2026-09-25 新增：npm registry。
  //
  //   为什么必须加（**这不是优化，是修一条断掉的路** —— 2026-09-25 实测）：
  //     关掉梯子直连时，`raw.githubusercontent.com` 与 `github.com` **都是 000（不通）**，
  //     而 `registry.npmjs.org` **200**。也就是说：**插件清单与插件下载全在墙掉的主机上**，
  //     一个没有梯子的人打开「集成版插件」页，**清单读不到、插件也下不来**。
  //   ⇒ 用户原话「npm 是最官方、最正规的途径，也是不用梯子也能轻松命令行下载的途径」
  //     说的正是这件事；本文件从 0.2.13 起把 npm 当**并列来源**（不是替换 GitHub）。
  //
  //   ⚠️ 边界仍然写死：**只认 registry.npmjs.org 这一个官方主机**。
  //     不默认加 `registry.npmmirror.com`（淘宝镜像）—— 它虽然实测更快（0.2s），
  //     但那是**第三方镜像**，加进来等于把"装什么代码进用户的家"交给第三方。
  //     真要加，应当是一次**显式的信任决定**，而不是顺手写进白名单。
  "registry.npmjs.org",
];

/** npm registry。**这是下载源**（与只给人看的 NPM_PAGE_BASE 不同）。 */
const NPM_REGISTRY = "https://registry.npmjs.org";

/**
 * 我们自己的包名种子清单（**兜底用**）。
 *
 * ★ 为什么需要它：npm 的搜索接口**根本不做名称匹配**（2026-09-25 实测：
 *   查 `dsh-int-mobile-remote` 这么精确的名字，返回的还是 103517 条无关结果，
 *   我们的包在返回的 250 条里一条都不在）。所以「自动发现我们有哪些包」**这条路走不通**，
 *   清单只能来自：① GitHub 索引（能连上时）② 缓存 ③ **这份写死的种子**。
 *
 * ⇒ 这份种子保证：**全新机器 + 没梯子 + 没缓存**，插件页上至少能看到我们自己的插件。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★ `aliasOf`：**同一个插件的旧包名**（2026-09-25 加，真跑验收逼出来的）
 * ═══════════════════════════════════════════════════════════════════════════
 *   本机的 GitHub 索引里**还挂着改名前的旧名**（`dsh-multi-session`、
 *   `dsh-plugin-uploader`），而 npm 上只有改名后的新名（`dsh-int-*`）。
 *   如果只按"包名在不在 hub 里"判断该不该查 npm，就会**把同一个插件查成两张卡**：
 *     旧名那张来自 hub、新名那张来自 npm ⇒ 界面上出现**两个一模一样的插件**，
 *     而"已装"标签是 `mergeInstalled` 按**组名**匹配的 ⇒
 *     装完刷新时标签落在另一张卡上，用户看到的是**"装完了还是没装"**。
 *   （实测：`ui-check plugins` 的「★ 卡片状态跟着变成「已装」」从 PASS 变 FAIL，
 *     用 `git stash` 回改动前跑同一条，证明是**我引入的**回归。）
 *   ⇒ 判据从"包名在不在 hub 里"改成"**这个插件的任一名字**在不在 hub 里"。
 */
const SEED_PACKAGES = [
  "dsh-int-multi-session",
  "dsh-int-mobile-remote",
  "dsh-int-archive-manager",
  "dsh-int-plugin-uploader",
  "dsh-int-im-file-inbox",
];

/** 新名 → 它在 GitHub 索引里可能还挂着的**旧名**（改名前的形态，见上面那段注释）。 */
const SEED_ALIASES = {
  "dsh-int-multi-session": ["dsh-multi-session"],
  "dsh-int-plugin-uploader": ["dsh-plugin-uploader"],
  "dsh-int-archive-manager": ["dsh-archive-manager"],
  "dsh-int-mobile-remote": ["dsh-mobile-remote"],
};

// ── npm 上的说明页（用户 2026-09-24 提的第 ③ 件事）────────────────────

/** npm 官网。**这是给人看的页面**，不是下载源 —— 下载仍然只走 ALLOWED_HOSTS。 */
const NPM_PAGE_BASE = "https://www.npmjs.com/package/";

/**
 * 一条清单条目该链到哪个 npm 页面 —— 算不出就返回空串（**绝不瞎拼**）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有这个函数，而不是在界面里拼字符串
 * ═══════════════════════════════════════════════════════════════════════════
 * 用户原话：「在我们的集成版插件页面那里加一条 npm 官网的地址，如果别人想看说明的话，
 * 可以跳转到 npm 那里去查看。」
 *
 * ★★ 安全前提（2026-09-24 实测）：**索引里的名字不一定在 npm 上存在**。
 *   实测 GitHub hub 索引当时还挂着两个**旧名**：
 *     `dsh-plugin-uploader` → npm 上 **404**（改名前的名字，从没发过或已消失）
 *     `dsh-multi-session`   → npm 上 **404**
 *   而新名 `dsh-int-plugin-uploader` / `dsh-int-multi-session` → 200，维护者都是 `zjh18477514055`。
 *   ⇒ 如果照着索引名字硬拼 `https://www.npmjs.com/package/<name>`，用户点开就是 **404 页面**，
 *     看起来像"我们的包没了"。所以**只在能证明这个包确实在 npm 上时才给链接**。
 *
 * 判据（按可靠性排序，**任一条成立即可**）：
 *   ① 索引条目**自己声明了** npm 页地址（`npmUrl` / `homepage`）—— 生产端最清楚；
 *   ② 下载地址就是 **registry.npmjs.org** 的 tarball ⇒ 包名必然存在；
 *   ③ 包名带 `dsh-int-` 前缀 —— 这是我们自己的命名约定（2026-09-23 第二次改名后的
 *      **唯一**形态），而旧名一律不带 ⇒ 天然把索引里那些陈旧条目挡在外面。
 *
 * ⚠️ 这里**只做静态判断**，不联网。界面点开时若真 404，那是索引陈旧，
 *    不该让"渲染清单"这一步去承担联网校验的代价（清单是离线可用的）。
 *
 * @param {{name?:string, raw?:object}} entry 清单条目（normalizeEntry 的产物）
 * @returns {string} npm 页面地址；算不出就是空串
 */
function npmPageOf(entry) {
  if (!entry || typeof entry !== "object") return "";
  const raw = (entry.raw && typeof entry.raw === "object") ? entry.raw : {};

  // ① 索引自己声明的（最可靠 —— 生产端可以指向任何它想指的地方）
  const declared = str(raw.npmUrl) || str(raw.npm) || str(raw.homepage);
  if (declared) {
    // 仍然只放行 npm 官网，避免索引把用户带去别处
    try {
      const u = new URL(declared);
      if (u.protocol === "https:" && (u.hostname === "www.npmjs.com" || u.hostname === "npmjs.com")) {
        return declared;
      }
    } catch { /* 不是合法 URL ⇒ 继续走下面的判据 */ }
  }

  const name = str(entry.name);
  if (!name) return "";
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) return "";

  // ② 下载地址就是 npm registry 的 tarball
  const dl = str(entry.downloadUrl);
  if (dl) {
    try {
      const u = new URL(dl);
      if (u.protocol === "https:" && u.hostname === "registry.npmjs.org") {
        return NPM_PAGE_BASE + name;
      }
    } catch { /* 忽略 */ }
  }

  // ③ 我们自己的命名约定（旧名一律不带这个前缀 ⇒ 挡住索引里的陈旧条目）
  if (name.startsWith("dsh-int-")) return NPM_PAGE_BASE + name;

  return "";
}

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

// ── npm 源（2026-09-25 新增）──────────────────────────────────────────

/**
 * 某个包"最新一版"的元数据地址。
 *
 * ★ 刻意用 `/<包名>/latest` 而**不是** `/<包名>`：
 *   后者会返回**全部版本**的完整元数据（含每个版本的完整 package.json），
 *   一个包几十上百版时能到几 MB；而我们只需要"最新那版叫什么、从哪下、哈希多少"。
 *   实测 `/<包名>/latest` 只有几 KB，且字段齐全（`dist.tarball` / `dist.integrity`）。
 */
function npmLatestUrl(name) {
  return `${NPM_REGISTRY}/${String(name).replace("/", "%2F")}/latest`;
}

/**
 * 把 npm 的 "latest" 元数据变成外壳内部认的**一条** entry。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 与 GitHub 索引条目的**一个关键差异**：哈希类型不同
 * ═══════════════════════════════════════════════════════════════════════════
 *   · GitHub 索引给的是 **sha256**（我们自己的生产端算的）⇒ 进 `entry.sha256`
 *   · npm 给的是 **`dist.integrity` = `sha512-<base64>`**（还有 `dist.shasum` = sha1）
 *   ⇒ 两者**不能互相转换**，所以 entry 上并存两个字段：
 *        `sha256`（有就校验，走原有咽喉）
 *        `integrity`（sha512，npm 源专有 —— 校验在 installFromArchive 里，见那边的注释）
 *   **两个都没有 ⇒ 仍然能装，但会留"未校验"警告**（宁可降级也不假装安全）。
 */
function normalizeNpmLatest(name, meta) {
  if (!meta || typeof meta !== "object") return { entry: null, errors: ["npm 返回的不是对象"] };
  const version = str(meta.version);
  const dist = (meta.dist && typeof meta.dist === "object") ? meta.dist : {};
  const downloadUrl = str(dist.tarball);
  const integrity = str(dist.integrity);

  const errors = [];
  if (!version) errors.push("npm 没给 version");
  if (!downloadUrl) errors.push("npm 没给 dist.tarball");
  else if (!isAllowedDownloadUrl(downloadUrl)) {
    errors.push(`dist.tarball 不在允许的来源里：${downloadUrl}`);
  }
  if (errors.length) return { entry: null, errors };

  return {
    entry: {
      name: str(meta.name) || name,
      version,
      downloadUrl,
      sha256: "",                       // npm 不给 sha256（见上面注释）
      integrity,                        // sha512-…（npm 源专有）
      bytes: 0,                         // npm 不给"压缩包字节数"（unpackedSize 是解压后的）
      file: `${name}-${version}.tgz`,
      description: str(meta.description),
      releaseUrl: "",
      publishedAt: "",
      platform: "web",
      compatible: true,
      keywords: [],
      repo: "npm",                      // 界面显示"来自哪个仓库"用
      npmUrl: NPM_PAGE_BASE + name,
      source: "npm",                    // ★ 标明来源，界面/验收要能分清
      raw: { npmLatest: true },
    },
    errors: [],
  };
}

/**
 * 并发查一批包在 npm 上的最新版。
 *
 * 纪律：**一个包查不到不能拖垮整批**（没发过的、被下架的、网络抖的都要能跳过）。
 *
 * @param {string[]} names
 * @param {{timeoutMs?:number, concurrency?:number}} opts
 * @returns {Promise<{entries:Array, errors:Array<string>}>}
 */
async function fetchNpmLatest(names, opts = {}) {
  const { net } = require("electron");
  const timeoutMs = Number(opts.timeoutMs) || 8000;
  const list = [...new Set((names || []).map((n) => str(n)).filter(Boolean))];
  const entries = [];
  const errors = [];

  // 小并发池：包不多（个位数），但别一次全放出去
  const limit = Math.max(1, Math.min(Number(opts.concurrency) || 4, list.length || 1));
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      const name = list[i];
      try {
        const res = await net.fetch(npmLatestUrl(name), {
          headers: { "User-Agent": UA, Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 404) { errors.push(`${name}：npm 上没有这个包（404）`); continue; }
        if (!res.ok) { errors.push(`${name}：npm 返回 HTTP ${res.status}`); continue; }
        const meta = await res.json();
        const { entry, errors: es } = normalizeNpmLatest(name, meta);
        if (entry) entries.push(entry); else errors.push(`${name}：${es.join("；")}`);
      } catch (e) {
        errors.push(`${name}：${(e && e.message) || e}`);
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return { entries, errors };
}

/**
 * 合并「GitHub 索引条目」与「npm 条目」。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★ 规则（**同名同版本时 GitHub 优先**）与一个必须避开的坑
 * ═══════════════════════════════════════════════════════════════════════════
 *   GitHub 那份带我们自己的 **sha256**（校验强度更高）；
 *   npm 那份的价值在于**版本更新**（GitHub 索引是半自动维护的，两边各有新旧）。
 *   ⇒ 两份都留、按 `(name, version)` 去重，让 `groupByName` 去排版本。
 *
 *   ⚠️⚠️ **但去重键必须是 `(name, version)`，而且合并后同一个包名只应剩一组。**
 *     我第一版只做了"条目级去重"，看着对，**真跑验收立刻抓到**：
 *     同一个包在两边**版本号不同**时（实测 `dsh-int-plugin-uploader`：
 *     npm 0.1.6 / GitHub 索引 0.1.4）⇒ 去重键不同 ⇒ **两条都留下** ⇒
 *     `groupByName` 按名字分组后**生成了两组同名卡片**，
 *     界面上那个插件出现**两次**，而且"已装"标签只落在其中一组上
 *     （`mergeInstalled` 是按**组名**匹配的）⇒ 用户看到"装完了还是没装"。
 *
 *   ⇒ 所以本函数只负责"条目级去重 + GitHub 优先"，
 *     **"同名只留一组"这件事由 groupByName 天然保证**（它按 name 归组）——
 *     两组同名卡片的原因是**我调用了两次 groupByName 后拼接**，
 *     见 fetchIndex 里那段"合并后必须重新分组"的注释。
 */
function mergeSources(hubEntries, npmEntries) {
  const seen = new Set();
  const out = [];
  for (const e of [...(hubEntries || []), ...(npmEntries || [])]) {
    const key = `${e.name}@${e.version}`;
    if (seen.has(key)) continue;      // 先来的赢 ⇒ GitHub 在前，自然优先
    seen.add(key);
    out.push(e);
  }
  return out;
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

  // ★★ 2026-09-25：sha512 SRI（npm 源的哈希形态）。
  //
  //   为什么两个哈希字段并存：**它们不能互相转换**。
  //     · GitHub 索引（我们自己生产端算的）给 **sha256**
  //     · npm 官方给 `dist.integrity` = **sha512-<base64>**
  //   校验在 plugin-install.js 的 installFromArchive 里，两条都认。
  //
  //   ⚠️ 这条曾经**被我自己弄丢过**（真跑验收抓到的）：
  //     我给 npm 源写了个 `normalizeNpmLatest`，它正确地放上了 integrity，
  //     但 `fetchIndex` 最后又调了一次 `normalizeIndex` 做合并后的归一化 ——
  //     而那个函数走的是**本函数**，本函数当时不认 `integrity` ⇒ **字段被静默丢掉**，
  //     结果"npm 装插件"会退化成"没有哈希可校验"。
  //     教训：**加字段时要把"所有会经过的归一化点"都数一遍**。
  const integrity = str(raw.integrity);
  if (integrity && !/^sha512-[A-Za-z0-9+/=]+$/.test(integrity)) {
    warnings.push(`integrity 格式不认识（${integrity.slice(0, 16)}…）⇒ 当作没有`);
  }
  const integrityOk = /^sha512-[A-Za-z0-9+/=]+$/.test(integrity) ? integrity : "";

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
      // ★ npm 源的哈希（sha512 SRI）。**必须在这里也带上** —— 见上面那段"曾被弄丢"的注释
      integrity: integrityOk,
      bytes,
      file: str(raw.file),
      description: str(raw.description),
      releaseUrl: str(raw.releaseUrl),
      publishedAt: str(raw.publishedAt),
      platform,
      compatible,
      keywords,
      // ★ npm 源的条目：repo 直接标 "npm"。
      //   ⚠️ 不能只靠 `repoOf(downloadUrl) || …` —— 对 npm 的 tarball 地址
      //     `https://registry.npmjs.org/<name>/-/<name>-<ver>.tgz`，
      //     `repoOf` 会**误解析成 `"<name>/-"`**（它是按 GitHub 的 /owner/repo/ 形状写的）。
      //     真跑验收抓到过：界面上会显示"来自 dsh-int-multi-session/-"，看着像坏了。
      repo: (str(raw.source) === "npm") ? "npm" : (repoOf(downloadUrl) || HUB_REPO),
      // ★ npm 说明页（用户 2026-09-24 第 ③ 件事）；算不出就是空串，界面据此决定
      //   显不显示那个链接 —— **绝不瞎拼一个会 404 的地址**（见 npmPageOf 的注释）
      npmUrl: npmPageOf({ name, downloadUrl, raw }),
      // ★ 来源标记（2026-09-25）：界面与验收要能分清"这条是从哪来的"
      //   ⚠️ 与 integrity 同一个坑：`normalizeEntry` 是**所有条目都要过**的那道归一化，
      //     所以来源标记必须在这里保留，否则合并后一律变成默认值（真跑验收抓到的）。
      source: (str(raw.source) === "npm" ? "npm" : "hub"),
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
  // ★ 关掉 npm 源的口子（验收与单测要用；默认开）
  const useNpm = opts.npm !== false;
  const seed = Array.isArray(opts.seedPackages) ? opts.seedPackages : SEED_PACKAGES;

  /**
   * ★★ 2026-09-25 改：**失败不再等于"没清单"**。
   *
   *   以前 GitHub 拿不到就直接 fail（退回缓存 / 报错）。现在多了一层：
   *   **GitHub 挂了也要去问 npm** —— 因为 npm 才是"没梯子时唯一通的那条"。
   *   三层兜底，从强到弱：
   *     ① GitHub 索引（有我们的 sha256，最可信）
   *     ② npm registry（没梯子也能通；只有 sha512 integrity）
   *     ③ 本地缓存（断网时显示上一份，标 stale）
   *   只有**三层全空**才真的算失败。
   */
  /**
   * ★★ 2026-09-25 定稿的设计：**GitHub 能用时它说了算，npm 只补缺口 + 兜底。**
   *
   * ── 为什么不是"永远两边都查、合并"（我第一版就是这么写的，**真跑验收当场抓到回归**）──
   *   第一版每次取清单都并发查 npm 的 5–6 个包，结果是：
   *     ① **多打 6 个 HTTP 请求** ⇒ 插件页每次刷新都变慢；
   *     ② 更要命的：npm 上是**新包名**（`dsh-int-multi-session`），
   *        而 GitHub 索引里还挂着**旧包名**（`dsh-multi-session`）⇒
   *        合并后**同一个插件出现两张卡**（新旧名各一张）；
   *     ③ 而"已装"标签是 `mergeInstalled` 按**组名**匹配的 ⇒
   *        装完刷新时标签落在另一张卡上，界面表现成**"装完了还是没装"**。
   *        （`ui-check plugins` 的「★ 卡片状态跟着变成「已装」」实测从 PASS 变 FAIL，
   *          用 `git stash` 回改动前跑同一条证明是**我引入的**。）
   *
   * ── 所以现在的规则 ──
   *   · **GitHub 索引取到了** ⇒ 以它为准（行为与加 npm 之前**一字不差**），
   *     只额外查 **种子里那些 hub 里没有的包**（生产端发了新插件、索引还没更新时，
   *     用户也能第一时间看到）——通常 0～1 个请求。
   *   · **GitHub 取不到**（没梯子 / 被墙 / 404）⇒ **npm 全量顶上**，这就是这条路的全部意义。
   *
   * ⇒ 取舍说清楚：**hub 索引里某个包版本偏旧时，现在不会自动用 npm 的新版覆盖。**
   *   这是刻意的 —— 版本权威归生产端（hub），npm 只解决"够不够得着"。
   *   要改这个取舍，得先把"新旧包名同现"这件事在数据侧解决（给索引里的旧名打退役标记）。
   */
  const fromNpm = async (names) => {
    if (!useNpm) return { entries: [], errors: [] };
    const list = [...new Set((names || []).map((n) => str(n)).filter(Boolean))];
    if (!list.length) return { entries: [], errors: [] };
    return await fetchNpmLatest(list, { timeoutMs: Math.min(timeoutMs, 8000) });
  };

  /** 缓存里出现过的包名（上次 GitHub 索引的样子）—— hub 挂掉时靠它保证覆盖全。 */
  const namesFromCache = () => {
    const out = [];
    const cached = readCache();
    if (cached && cached.index && Array.isArray(cached.index.entries)) {
      for (const e of cached.index.entries) {
        const n = str(e && e.name);
        if (n) out.push(n);
      }
    }
    return out;
  };

  const finish = ({ hubEntries, hubRaw, npmEntries, npmErrors, stale, error, source }) => {
    const merged = mergeSources(hubEntries, npmEntries);
    const idx = normalizeIndex({ schema: KNOWN_SCHEMA, entries: merged });
    // 把 npm 那侧的问题也如实报出来（但**不**因此判失败）
    for (const e of npmErrors || []) idx.warnings.push(`npm 源：${e}`);
    return {
      ok: true, index: idx, groups: groupByName(idx.entries),
      fetchedAt: new Date().toISOString(), stale: !!stale, error: error || "", source,
      counts: { hub: (hubEntries || []).length, npm: (npmEntries || []).length },
    };
  };

  const fail = async (error) => {
    // ★ GitHub 不通 ⇒ **npm 全量顶上**（种子 ∪ 缓存里见过的名字）。
    //   这是"没梯子"用户的**正常路径**，不是降级 —— 所以下面 source 标 "npm"、stale=false。
    const npm = await fromNpm([...new Set([...seed, ...namesFromCache()])]);
    if (npm.entries.length) {
      return finish({
        hubEntries: [], npmEntries: npm.entries, npmErrors: npm.errors,
        stale: false, error, source: "npm",
      });
    }
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
        counts: { hub: idx.entries.length, npm: 0 },
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
    return await fail(`取插件清单失败（连不上）：${(e && e.message) || e}`);
  }
  if (res.status === 404) return await fail(`插件清单不存在（HTTP 404）：${url}`);
  if (!res.ok) return await fail(`插件清单拉取失败（HTTP ${res.status}）`);

  let raw;
  try {
    raw = await res.json();
  } catch (e) {
    return await fail(`插件清单不是合法 JSON：${(e && e.message) || e}`);
  }

  const index = normalizeIndex(raw);
  // ★★ GitHub 取到了 ⇒ **以它为准**（行为与加 npm 之前一字不差）。
  //
  //   只额外问 npm 一件事：**种子里有哪些包是 hub 索引里没有的** ——
  //   生产端发了新插件但索引还没更新时，用户也能第一时间看到（通常 0～1 个请求）。
  //   ⚠️ 刻意**不**做"同名合并"：npm 上是新包名、索引里可能还挂着旧包名，
  //     合并会让同一个插件出现两张卡（详见 mergeSources 上方那段长注释）。
  const hubNames = new Set(index.entries.map((e) => e.name));
  // ★ 判据是「这个插件的**任一名字**在不在 hub 里」—— 不是"新名在不在"。
  //   否则索引里挂着旧名时，会把同一个插件再从 npm 查一遍 ⇒ 两张卡（见 SEED_ALIASES 注释）。
  const missing = seed.filter((n) => {
    if (hubNames.has(n)) return false;
    const aliases = SEED_ALIASES[n] || [];
    return !aliases.some((a) => hubNames.has(a));
  });
  const npm = await fromNpm(missing);
  const fetchedAt = new Date().toISOString();
  writeCache(raw, url);
  const merged = mergeSources(index.entries, npm.entries);
  const outIdx = normalizeIndex({ schema: index.schema || KNOWN_SCHEMA, entries: merged });
  outIdx.schema = index.schema;
  outIdx.knownSchema = index.knownSchema;
  outIdx.updatedAt = index.updatedAt;
  outIdx.repo = index.repo;
  for (const w of index.warnings) outIdx.warnings.push(w);
  for (const w of index.skipped) outIdx.skipped.push(w);
  for (const e of npm.errors) outIdx.warnings.push(`npm 源：${e}`);
  return {
    ok: true, index: outIdx, groups: groupByName(outIdx.entries),
    fetchedAt, stale: false, error: "", source: "network",
    counts: { hub: index.entries.length, npm: npm.entries.length },
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
  NPM_PAGE_BASE, NPM_REGISTRY, SEED_PACKAGES, SEED_ALIASES,
  // 纯函数（可在普通 node 里单测）
  indexUrl, repoOf, isAllowedDownloadUrl, normalizeEntry, normalizeIndex,
  groupByName, mergeInstalled, isDevOnly, npmPageOf,
  npmLatestUrl, normalizeNpmLatest, mergeSources,
  // 需要 Electron 的
  fetchIndex, fetchNpmLatest, downloadArchive, cleanupArchive,
  readCache, writeCache, cacheFile,
};
