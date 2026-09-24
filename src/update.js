"use strict";

/**
 * update.js —— 「检查更新」：查 GitHub Releases → 下载安装包 → 启动安装
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不用 electron-updater
 * ══════════════════════════════════════════════════════════════════
 *   本项目外壳一直是**零运行时依赖**（只有 electron 自己是 devDependency）。
 *   引一个 electron-updater 进来，就多一个每次启动都要跑、还要跟内核升级解耦的东西。
 *   而我们要的能力其实很窄：**看 GitHub 上有没有比当前更新的 Release，有就下载那个 exe 跑一下**。
 *   用 Electron 自带的 `net`（走 Chromium 网络栈 ⇒ **自动走系统代理**，
 *   本机就是 Clash 127.0.0.1:7897）+ `shell.openPath` 就够了。
 *
 * ══════════════════════════════════════════════════════════════════
 * 边界（说清楚，别让人误以为它比实际更安全）
 * ══════════════════════════════════════════════════════════════════
 *   · **不校验签名**：只保证「从我们自己的 GitHub 仓库、经 HTTPS 下载」。
 *     安装包本身是 electron-builder 用 signtool 签的（有签名），但本模块**不验证它**。
 *   · **不静默安装**：必须用户点「下载并安装」才动；下载完是**用户可见地**启动安装器，
 *     然后外壳自己退出，安装器装完会重新拉起（electron-builder 的 runAfterFinish）。
 *     ⇒ 不存在"偷偷替换自己的可执行文件"。
 *   · **不自动轮询**：只在设置页点「检查更新」时查一次（外加托盘里那一条）。
 */

const { app, net, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const REPO = "18477514055/DSH-Integrated-Desktop";
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const UA = "dsh-integrated-desktop-updater";

/**
 * 版本号比较。返回 1 / 0 / -1。
 *
 * 只看**数字段**（`0.2.10` 要大于 `0.2.9` —— 按字符串比会得出反的结论）。
 * 带预发布后缀的（`-rc.1`）**排在同版本正式版之前**（`0.2.4-rc.1 < 0.2.4`）。
 */
function cmpVersion(a, b) {
  const parse = (v) => {
    const s = String(v || "").trim().replace(/^v/i, "");
    const dash = s.indexOf("-");
    const core = (dash >= 0 ? s.slice(0, dash) : s);
    const pre = dash >= 0 ? s.slice(dash + 1) : "";
    const nums = core.split(".").map((x) => parseInt(x, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre };
  };
  const A = parse(a), B = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] > B.nums[i] ? 1 : -1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;    // 正式版 > 预发布
  if (!B.pre) return -1;
  return A.pre > B.pre ? 1 : -1;
}

/** 从 Release 的 assets 里挑「安装版」那个 exe（不要 portable）。 */
function pickInstaller(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const exes = list.filter((a) => /\.exe$/i.test(a.name || ""));
  const install = exes.find((a) => /-x64\.exe$/i.test(a.name) && !/portable/i.test(a.name));
  return install || exes.find((a) => !/portable/i.test(a.name)) || null;
}

/** 从安装包文件名里读版本：`DSH-Integrated-0.2.5-x64.exe` → `0.2.5`。portable 不算。 */
function versionFromInstallerName(name) {
  const n = String(name || "");
  if (/portable/i.test(n)) return "";
  const m = /^DSH-Integrated-(.+?)-x64\.exe$/i.exec(n);
  return m ? m[1] : "";
}

/**
 * 在给定的几个目录里找**本机已有的、比当前更新的**安装包。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有这一步（用户原话）
 * ═══════════════════════════════════════════════════════════════════════════
 * 「检查更新，同时检查仓库的情况和本地的情况，说不定他们是本地安装包呢。」
 *
 * 真实场景就是本机：自己 `npm run dist` 打出了 0.2.5，但因为工作区不干净
 * （另一个会话还在改）**一直没发到 GitHub** ⇒ 线上还停在 0.2.2。
 * 只查线上，它就永远报「已是最新」，而更新的安装包其实就躺在 `release\` 里。
 *
 * **只读**：只列目录、只 stat，不写、不执行。
 * 目录由调用方给（主进程从设置里的工作目录 + 下载临时目录算出来），本模块自己不猜路径。
 */
function findLocalInstaller(dirs, current) {
  let best = null;
  for (const dir of Array.isArray(dirs) ? dirs : []) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }   // 目录不存在就算没有
    for (const n of names) {
      const ver = versionFromInstallerName(n);
      if (!ver) continue;
      if (cmpVersion(ver, current) <= 0) continue;             // 不比当前新就不提
      const abs = path.join(dir, n);
      let size = 0;
      try { size = fs.statSync(abs).size; } catch { continue; }
      // 太小的多半是半个下载 / 占位文件 —— 别把一个残包当成"可以升级"
      if (size < 1024 * 1024) continue;
      if (!best || cmpVersion(ver, best.version) > 0) best = { version: ver, path: abs, size, dir };
    }
  }
  return best;
}

/**
 * 算出「本机可能放着安装包」的目录清单。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么要有这个函数（2026-09-24 用户报的真 bug）
 * ═══════════════════════════════════════════════════════════════════════════
 * 用户原话：「为什么我点检查更新的时候找不到你打包的 0.2.10 呢？」
 *
 * 真因：目录清单**只**由 `app.getPath("temp")` + `settings.workspace\release` 组成，
 * 而 `settings.workspace` 是**内核的工作目录**（cwd），默认是空串
 * （用户现场实测 `settings.json` 里 `workspace=''`）。
 * 于是 `npm run dist` 打出来的 0.2.10 躺在 `D:\deepseek-workspace\5.DSH集成桌面端\release\`，
 * **一个候选目录都没扫到它** ⇒ 明明本机有新包，界面却报「已是最新」。
 * 讽刺的是上面 `findLocalInstaller` 的注释写的正是为了这个场景，而它拿不到目录。
 *
 * ⇒ 所以清单改成**从"包实际会落在哪"推导**，而不是从"用户配了什么"推导：
 *   ① 下载临时目录（更新流程自己下的）；
 *   ② 设置里的工作目录 + `release`（保留旧行为）；
 *   ③ ★ **外壳自己的项目目录 + `release`** —— 开发机 `npm run dist` 的产物就在这儿，
 *      这正是用户现场那个 0.2.10 的所在；
 *   ④ ★ **每个已注册工作区**：根本身 + **一层子目录** + `release`
 *      （本机实况：工作区根是 `D:\deepseek-workspace`，项目在它的子目录 `5.DSH集成桌面端` 下）。
 *
 * 只**列目录、只 stat**，不写、不执行。目录不存在也无所谓（`findLocalInstaller` 会跳过），
 * 但会原样列出来 ⇒ 界面上能看见"到底扫了哪些地方"，**"没找到"才是可解释的**。
 *
 * @param {{tempDir?:string, workspace?:string, appPath?:string, workspaceRoots?:string[]}} opts
 * @returns {string[]} 去重后的绝对路径清单（不保证存在）
 */
function candidateInstallerDirs(opts = {}) {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    if (typeof p !== "string" || !p.trim()) return;
    const abs = path.resolve(p);
    const key = abs.replace(/[\\/]+$/, "").toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(abs);
  };

  push(opts.tempDir);
  if (opts.workspace) push(path.join(opts.workspace, "release"));
  if (opts.appPath) push(path.join(opts.appPath, "release"));

  const roots = Array.isArray(opts.workspaceRoots) ? opts.workspaceRoots : [];
  for (const root of roots) {
    if (typeof root !== "string" || !root.trim()) continue;
    push(path.join(root, "release"));
    let subs = [];
    try { subs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of subs) {
      // ★ 联接（Junction）对 Dirent.isDirectory() 返回 **false** ⇒ 必须跟随一次 statSync。
      //   （项目 AGENTS.md §7 记过这个坑：联接形态的插件曾被整批静默跳过。）
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try { isDir = fs.statSync(path.join(root, e.name)).isDirectory(); } catch { isDir = false; }
      }
      if (isDir) push(path.join(root, e.name, "release"));
    }
  }
  return out;
}

/**
 * 查最新 Release。**只读**，不写任何东西。
 *
 * @param {{localDirs?:string[]}} [opts] 顺带扫这几个本地目录里有没有更新的安装包
 * @returns {Promise<{ok:boolean, reason?:string, current:string, latest?:string,
 *                    hasUpdate?:boolean, asset?:object, notes?:string, page?:string,
 *                    localNewer:?{version:string,path:string,size:number,dir:string},
 *                    scannedDirs?:{dir:string,exists:boolean}[]}>}
 */
async function check(opts = {}) {
  const current = app.getVersion();
  // ★ 先看**本机**有没有更新的安装包 —— 线上没有不等于本机没有
  const localDirs = Array.isArray(opts.localDirs) ? opts.localDirs : [];
  const localNewer = findLocalInstaller(localDirs, current);
  // ★ 把"扫了哪些目录、哪些真的存在"一起报出去 —— 否则「没找到」不可解释
  //   （这正是本 bug 藏了这么久的原因：界面只报"已是最新"，没人知道它扫过哪里）
  const scannedDirs = localDirs.map((dir) => {
    let exists = false;
    try { exists = fs.statSync(dir).isDirectory(); } catch { exists = false; }
    return { dir, exists };
  });
  const withLocal = (o) => ({ ...o, current, localNewer, scannedDirs });

  let res;
  try {
    res = await net.fetch(API_LATEST, {
      headers: { "User-Agent": UA, Accept: "application/vnd.github+json" },
    });
  } catch (e) {
    return withLocal({ ok: false, reason: `连不上 GitHub：${(e && e.message) || e}` });
  }
  if (res.status === 404) {
    return withLocal({ ok: false, reason: "仓库上还没有任何 Release", page: RELEASES_PAGE });
  }
  if (!res.ok) {
    return withLocal({ ok: false, reason: `GitHub 返回 HTTP ${res.status}`, page: RELEASES_PAGE });
  }

  let rel;
  try { rel = await res.json(); } catch (e) {
    return withLocal({ ok: false, reason: `返回内容不是 JSON：${(e && e.message) || e}` });
  }

  const latest = String(rel.tag_name || rel.name || "").replace(/^v/i, "");
  if (!latest) return withLocal({ ok: false, reason: "Release 里没有版本号", page: RELEASES_PAGE });

  const asset = pickInstaller(rel.assets);
  const hasUpdate = cmpVersion(latest, current) > 0;
  return withLocal({
    ok: true,
    latest,
    hasUpdate,
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
    notes: typeof rel.body === "string" ? rel.body.slice(0, 4000) : "",
    page: rel.html_url || RELEASES_PAGE,
    publishedAt: rel.published_at || "",
  });
}

/** 下载目标路径：临时目录下、按版本命名（已存在且大小一致就直接复用）。 */
function targetPath(version, assetName) {
  const name = assetName || `DSH-Integrated-${version}-x64.exe`;
  return path.join(app.getPath("temp"), name);
}

/**
 * 下载安装包。带进度回调；失败会删掉半成品（免得下次误以为已下好）。
 *
 * @param {{url:string, name:string, size:number}} asset
 * @param {(p:{got:number,total:number,percent:number})=>void} onProgress
 * @returns {Promise<{ok:boolean, path?:string, reason?:string, reused?:boolean}>}
 */
async function download(asset, onProgress = () => {}) {
  if (!asset || !asset.url) return { ok: false, reason: "没有可下载的附件" };
  const dest = targetPath("", asset.name);

  // 已经下过一份、大小也对 ⇒ 直接复用（省一次 90MB）
  try {
    if (fs.existsSync(dest) && asset.size && fs.statSync(dest).size === asset.size) {
      onProgress({ got: asset.size, total: asset.size, percent: 100 });
      return { ok: true, path: dest, reused: true };
    }
  } catch { /* 读不到就当没下过 */ }

  try { fs.rmSync(dest, { force: true }); } catch { /* 忽略 */ }

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    let req;
    try {
      req = net.request({ method: "GET", url: asset.url, redirect: "follow" });
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
      const total = Number(response.headers["content-length"] || asset.size || 0);
      let got = 0;
      const out = fs.createWriteStream(dest);
      out.on("error", (e) => {
        try { fs.rmSync(dest, { force: true }); } catch { /* 忽略 */ }
        done({ ok: false, reason: `写文件失败：${(e && e.message) || e}` });
      });
      response.on("data", (chunk) => {
        got += chunk.length;
        out.write(chunk);
        const percent = total ? Math.floor((got / total) * 100) : 0;
        try { onProgress({ got, total, percent }); } catch { /* 回调自己出错不该影响下载 */ }
      });
      response.on("end", () => {
        out.end(() => {
          // 大小对不上 ⇒ 当作失败（网络截断是常态，别把半个 exe 当成品）
          if (asset.size && got !== asset.size) {
            try { fs.rmSync(dest, { force: true }); } catch { /* 忽略 */ }
            return done({ ok: false, reason: `下载不完整（${got}/${asset.size} 字节）` });
          }
          done({ ok: true, path: dest });
        });
      });
      response.on("error", (e) => {
        try { fs.rmSync(dest, { force: true }); } catch { /* 忽略 */ }
        done({ ok: false, reason: `读取响应出错：${(e && e.message) || e}` });
      });
    });

    req.end();
  });
}

/** 用系统默认方式启动安装包（用户可见）。返回 { ok, reason? }。 */
async function launchInstaller(file) {
  if (!file || !fs.existsSync(file)) return { ok: false, reason: "安装包不在磁盘上" };
  const err = await shell.openPath(file);
  if (err) return { ok: false, reason: err };
  return { ok: true };
}

function openReleasesPage() {
  return shell.openExternal(RELEASES_PAGE);
}

module.exports = {
  check, download, launchInstaller, openReleasesPage,
  cmpVersion, pickInstaller, versionFromInstallerName, findLocalInstaller,
  candidateInstallerDirs,
  RELEASES_PAGE, REPO,
};
