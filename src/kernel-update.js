"use strict";

/**
 * kernel-update.js —— 「检查内核更新」：查**官方渠道**（npm registry）→ 下载官方包
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一版（0.2.9）的核心主张：内核更新不与外壳冲突
 * ══════════════════════════════════════════════════════════════════
 * 本模块让这件事**可被用户自己验证**，而不是一句宣传。三条机制，
 * 每一条都能用工具查（见 scripts/kernel-update-check.js 的真跑断言）：
 *
 *   ① **外壳包里根本没有内核。** 打包产物只有 `src/**` + `assets/**`
 *      （`vendor/dsh` 不存在、asar 里没有 `plugin/`、`resources\plugins` 不存在）。
 *      ⇒ 升级内核**不可能**覆盖到外壳的代码，反过来也一样。
 *   ② **内核是外部独立安装的**，外壳只 `spawn` 它的 `lib/bin.js` 并读 stdout
 *      （见 kernel.js 的铁律 1）。外壳不 import 内核任何内部模块。
 *   ③ **插件与内核的模块镜像层是分开的**：内核启动时的 `healProfilesModuleFallback()`
 *      重写的是 `$DSH_HOME/profiles/node_modules`（共享镜像层），
 *      而我们的插件落在 `$DSH_HOME/profiles/<profile>/node_modules`（且是指向仓库的
 *      junction）⇒ 内核换代**碰不到**它们。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么**只检查 + 下载**，不替用户安装
 * ══════════════════════════════════════════════════════════════════
 * 「装内核」= 往**外壳此刻正在运行的那个目录**（全局 npm）里换代码。
 * 2026-09-19 那次真实事故就是这么来的（升级 → 回滚也失败 → 客户端完全起不来，
 * 最后靠另一个 AI 才修好）。所以这里的边界是硬的：
 *
 *   · **检查**：只发一次 GET，什么都不写。
 *   · **下载**：把官方 `.tgz` 拉到 `<userData>\kernel-update\`，
 *     并**用 npm 自己给的 `sha512` integrity 逐字节校验**；不通过就删掉。
 *   · **安装**：**不代劳** —— 把命令给你，由你在自己的终端里执行，看得见每一步。
 *     顺带提醒：`npm i -g` 会冲掉 `dsh` 的守卫 shim，装完要重跑 `dsh-guard-install.ps1`。
 *
 * 这也是全局规矩里那条判据：*这条命令跑下去之后，如果用户就看不见我了，那我不该跑它。*
 */

const { app, net, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const K = require("./kernel");

/** 官方渠道：npm registry 上这个包就是内核本体。 */
const PKG = "@deepseek-ai/dsh";
const REGISTRY = `https://registry.npmjs.org/${PKG}`;
const REGISTRY_LATEST = `${REGISTRY}/latest`;
/** 给人看的官方页面（不是下载地址，只是让用户能自己去看版本历史）。 */
const OFFICIAL_PAGE = `https://www.npmjs.com/package/${PKG}`;
const UA = "dsh-integrated-desktop-kernel-updater";

/**
 * 版本比较（比 `update.js` 的 `cmpVersion` 更严：预发布标识按 semver 逐段比）。
 *
 * 内核的版本号里有 `-rc.2` 这种预发布，而**字符串比较会在 `rc.9` vs `rc.10` 上出错**
 * （`"rc.10" < "rc.9"`）。这里按 semver 的规则逐段比：
 *   ① 主版本数字段逐段数值比较；
 *   ② 有预发布 < 无预发布（`0.1.5-rc.2 < 0.1.5`）；
 *   ③ 预发布标识逐段比：两边都是数字就按数值，否则按 ASCII；
 *      数字标识**永远小于**字母标识；前缀全等时**段数多的更大**（`rc.1.1 > rc.1`）。
 *
 * @param {string} a 版本号（可带前导 `v`）
 * @param {string} b 版本号
 * @returns {number} a>b 返回 1，a<b 返回 -1，相等 0
 */
function cmpVersion(a, b) {
  const parse = (v) => {
    const s = String(v || "").trim().replace(/^v/i, "");
    // 去掉 build metadata（`+…`），它不参与比较
    const noBuild = s.split("+")[0];
    const dash = noBuild.indexOf("-");
    const core = dash >= 0 ? noBuild.slice(0, dash) : noBuild;
    const pre = dash >= 0 ? noBuild.slice(dash + 1) : "";
    const nums = core.split(".").map((x) => {
      const n = parseInt(x, 10);
      return Number.isFinite(n) ? n : 0;
    });
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre ? pre.split(".") : [] };
  };
  const A = parse(a), B = parse(b);
  for (let i = 0; i < Math.max(A.nums.length, B.nums.length); i += 1) {
    const x = A.nums[i] || 0, y = B.nums[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  // 主版本相同：无预发布 > 有预发布
  if (A.pre.length === 0 && B.pre.length === 0) return 0;
  if (A.pre.length === 0) return 1;
  if (B.pre.length === 0) return -1;
  const n = Math.min(A.pre.length, B.pre.length);
  for (let i = 0; i < n; i += 1) {
    const x = A.pre[i], y = B.pre[i];
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) {
      const xi = parseInt(x, 10), yi = parseInt(y, 10);
      if (xi !== yi) return xi > yi ? 1 : -1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;             // 数字标识 < 字母标识
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  if (A.pre.length !== B.pre.length) return A.pre.length > B.pre.length ? 1 : -1;
  return 0;
}

/**
 * 本机内核现状。**只读**。
 *
 * 用 `kernel.js` 的发现链（显式指定 → 应用自带 → 全局 npm），
 * 所以报出来的就是外壳**真会去启动**的那一个 —— 不是另猜一个。
 */
function installed() {
  const k = K.discoverKernel({});
  if (!k) return { found: false, version: "", dir: "", source: "", bin: "" };
  return { found: true, version: k.version, dir: k.dir, source: k.source, bin: k.bin };
}

/** 下载落点目录：`<userData>\kernel-update\`（持久、用户找得到，不用临时目录）。 */
function downloadDir() {
  return path.join(app.getPath("userData"), "kernel-update");
}

/** 把一个 registry 的 dist 对象校验成我们能用的形状。 */
function readDist(meta) {
  const d = meta && meta.dist;
  if (!d || typeof d.tarball !== "string" || !/^https:\/\//.test(d.tarball)) return null;
  const out = { tarball: d.tarball, integrity: "", shasum: "", unpackedSize: 0 };
  if (typeof d.integrity === "string") out.integrity = d.integrity;
  if (typeof d.shasum === "string") out.shasum = d.shasum;
  if (typeof d.unpackedSize === "number") out.unpackedSize = d.unpackedSize;
  // integrity 与 shasum 至少要有一个，否则没法校验 —— 宁可不下载
  if (!out.integrity && !out.shasum) return null;
  return out;
}

/**
 * 查官方渠道上内核的最新版本。**只读**，不写任何东西。
 *
 * @returns {Promise<{ok:boolean, reason?:string, installed:object, latest?:string,
 *                    hasUpdate?:boolean, dist?:object, page?:string, publishedAt?:string}>}
 */
async function check() {
  const cur = installed();
  const withCur = (o) => ({ ...o, installed: cur, page: OFFICIAL_PAGE });

  let res;
  try {
    res = await net.fetch(REGISTRY_LATEST, {
      headers: { "User-Agent": UA, Accept: "application/vnd.npm.install-v1+json, application/json" },
    });
  } catch (e) {
    return withCur({ ok: false, reason: `连不上 npm 官方源：${(e && e.message) || e}` });
  }
  if (res.status === 404) {
    return withCur({ ok: false, reason: `官方源上查不到 ${PKG}` });
  }
  if (!res.ok) {
    return withCur({ ok: false, reason: `官方源返回 HTTP ${res.status}` });
  }

  let meta;
  try { meta = await res.json(); } catch (e) {
    return withCur({ ok: false, reason: `返回内容不是 JSON：${(e && e.message) || e}` });
  }

  const latest = String((meta && meta.version) || "").trim();
  if (!latest) return withCur({ ok: false, reason: "官方源的返回里没有 version 字段" });

  const dist = readDist(meta);
  if (!dist) return withCur({ ok: false, reason: "官方源的返回里没有可校验的下载地址（dist.tarball/integrity）" });

  // 本机内核找不到时不能断言"有更新" —— 说清楚，别编
  const hasUpdate = cur.found ? cmpVersion(latest, cur.version) > 0 : null;
  return withCur({
    ok: true,
    latest,
    hasUpdate,
    dist,
    publishedAt: (meta && meta.publishedAt) || "",
    homepage: (meta && meta.homepage) || "",
  });
}

/**
 * 校验一个下载下来的文件。
 *
 * ★ 优先用 npm 自己给的 **sha512 integrity**（比 shasum 强）；没有才退回 sha1 shasum。
 *   任何一条对不上就判失败 —— 绝不"下完就算成功"。
 *
 * @param {string} file 文件路径
 * @param {{integrity?:string, shasum?:string}} dist
 * @returns {{ok:boolean, reason?:string, algo?:string, actual?:string}}
 */
function verifyDigest(file, dist) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) {
    return { ok: false, reason: `读不到下载的文件：${(e && e.message) || e}` };
  }
  const want = String((dist && dist.integrity) || "");
  const m = /^sha(256|384|512)-([A-Za-z0-9+/=]+)$/.exec(want);
  if (m) {
    const algo = `sha${m[1]}`;
    const actual = crypto.createHash(algo).update(buf).digest("base64");
    if (actual !== m[2]) return { ok: false, algo, actual, reason: `${algo} 校验不通过（下载可能被改过或截断）` };
    return { ok: true, algo, actual: `${algo}-${actual}` };
  }
  const shasum = String((dist && dist.shasum) || "");
  if (/^[a-f0-9]{40}$/i.test(shasum)) {
    const actual = crypto.createHash("sha1").update(buf).digest("hex");
    if (actual.toLowerCase() !== shasum.toLowerCase()) {
      return { ok: false, algo: "sha1", actual, reason: "sha1 校验不通过（下载可能被改过或截断）" };
    }
    return { ok: true, algo: "sha1", actual };
  }
  return { ok: false, reason: "官方源没给可用的校验值，拒绝下载" };
}

/** 从 tarball URL 里取文件名（`…/dsh-0.1.5-rc.2.tgz` → `dsh-0.1.5-rc.2.tgz`）。 */
function tarballName(url, version) {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    if (/\.tgz$/i.test(base)) return base;
  } catch { /* 退回按版本拼 */ }
  return `dsh-${version || "latest"}.tgz`;
}

/**
 * 把官方内核包下载到 `<userData>\kernel-update\`，并**按官方校验值验一遍**。
 *
 * 已存在且校验通过 ⇒ 直接复用（省一次几 MB 的下载）。
 *
 * @param {{tarball:string, integrity?:string, shasum?:string}} dist
 * @param {string} version 版本号（只用于文件命名）
 * @param {(p:{got:number,total:number,percent:number})=>void} onProgress
 * @returns {Promise<{ok:boolean, path?:string, reason?:string, reused?:boolean,
 *                    bytes?:number, verified?:string}>}
 */
async function download(dist, version, onProgress = () => {}) {
  if (!dist || !dist.tarball) return { ok: false, reason: "没有可下载的地址" };
  const dir = downloadDir();
  const dest = path.join(dir, tarballName(dist.tarball, version));

  // 已经下过一份、且校验通过 ⇒ 复用
  try {
    if (fs.existsSync(dest)) {
      const v = verifyDigest(dest, dist);
      if (v.ok) {
        const size = fs.statSync(dest).size;
        onProgress({ got: size, total: size, percent: 100 });
        return { ok: true, path: dest, reused: true, bytes: size, verified: v.actual || v.algo };
      }
      fs.rmSync(dest, { force: true });      // 旧的坏了就删掉重下
    }
  } catch { /* 读不到就当没下过 */ }

  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 下面写文件时会报 */ }

  const got = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    let req;
    try {
      req = net.request({ method: "GET", url: dist.tarball, redirect: "follow" });
    } catch (e) {
      return done({ ok: false, reason: `发起下载失败：${(e && e.message) || e}` });
    }

    req.on("error", (e) => {
      try { fs.rmSync(dest, { force: true }); } catch { /* 忽略 */ }
      done({ ok: false, reason: `下载出错：${(e && e.message) || e}` });
    });

    req.on("response", (response) => {
      const code = response.statusCode;
      if (code !== 200) {
        try { fs.rmSync(dest, { force: true }); } catch { /* 忽略 */ }
        return done({ ok: false, reason: `下载被拒（HTTP ${code}）` });
      }
      const total = Number(response.headers["content-length"] || 0);
      let bytes = 0;
      const out = fs.createWriteStream(dest);
      out.on("error", (e) => {
        try { fs.rmSync(dest, { force: true }); } catch { /* 忽略 */ }
        done({ ok: false, reason: `写文件失败：${(e && e.message) || e}` });
      });
      response.on("data", (chunk) => {
        bytes += chunk.length;
        out.write(chunk);
        const percent = total ? Math.floor((bytes / total) * 100) : 0;
        try { onProgress({ got: bytes, total, percent }); } catch { /* 回调出错不影响下载 */ }
      });
      response.on("end", () => {
        out.end(() => done({ ok: true, bytes }));
      });
      response.on("error", (e) => {
        try { fs.rmSync(dest, { force: true }); } catch { /* 忽略 */ }
        done({ ok: false, reason: `读取响应出错：${(e && e.message) || e}` });
      });
    });

    req.end();
  });

  if (!got.ok) return got;

  // ★ 下载完**必须**校验：不通过就删掉，绝不留一个坏包在磁盘上误导用户
  const v = verifyDigest(dest, dist);
  if (!v.ok) {
    try { fs.rmSync(dest, { force: true }); } catch { /* 忽略 */ }
    return { ok: false, reason: v.reason || "校验失败" };
  }
  return { ok: true, path: dest, bytes: got.bytes, verified: v.actual || v.algo };
}

/**
 * 给人看的那条安装命令（**由用户自己在终端里执行**）。
 *
 * ⚠️ 刻意不做成按钮：装内核 = 往外壳此刻正在运行的目录里换代码，
 *   而 2026-09-19 的事故正是"无人值守地升级内核"。命令交给用户，看得见每一步。
 */
function installHint(file) {
  const dir = downloadDir();
  const rel = file ? path.relative(dir, file) : "";
  const p = rel && !rel.startsWith("..") ? path.join(dir, rel) : (file || "<下载下来的 .tgz>");
  return [
    `npm install -g "${p}"`,
    "",
    "# 装完必须重跑一次守卫（npm i -g 会冲掉 dsh 的 shim）：",
    `powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\\.dsh\\safety\\dsh-guard-install.ps1"`,
    "",
    "# 然后重启客户端（内核是外壳启动时拉起的，换内核要重启才生效）",
  ].join("\n");
}

/** 打开官方 npm 页面（想自己看版本历史时用）。 */
function openOfficialPage() {
  return shell.openExternal(OFFICIAL_PAGE);
}

/** 在资源管理器里打开下载目录（用户要自己拿那个 .tgz 时用）。 */
async function openDownloadDir() {
  const dir = downloadDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 只读就算了 */ }
  const err = await shell.openPath(dir);
  return err ? { ok: false, reason: err } : { ok: true, path: dir };
}

module.exports = {
  check, download, installHint, openOfficialPage, openDownloadDir,
  cmpVersion, verifyDigest, tarballName, installed, downloadDir,
  PKG, REGISTRY, OFFICIAL_PAGE,
};
