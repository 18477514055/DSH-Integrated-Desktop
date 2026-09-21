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

/**
 * 查最新 Release。**只读**，不写任何东西。
 * @returns {Promise<{ok:boolean, reason?:string, current:string, latest?:string,
 *                    hasUpdate?:boolean, asset?:object, notes?:string, page?:string}>}
 */
async function check() {
  const current = app.getVersion();
  let res;
  try {
    res = await net.fetch(API_LATEST, {
      headers: { "User-Agent": UA, Accept: "application/vnd.github+json" },
    });
  } catch (e) {
    return { ok: false, reason: `连不上 GitHub：${(e && e.message) || e}`, current };
  }
  if (res.status === 404) {
    return { ok: false, reason: "仓库上还没有任何 Release", current, page: RELEASES_PAGE };
  }
  if (!res.ok) {
    return { ok: false, reason: `GitHub 返回 HTTP ${res.status}`, current, page: RELEASES_PAGE };
  }

  let rel;
  try { rel = await res.json(); } catch (e) {
    return { ok: false, reason: `返回内容不是 JSON：${(e && e.message) || e}`, current };
  }

  const latest = String(rel.tag_name || rel.name || "").replace(/^v/i, "");
  if (!latest) return { ok: false, reason: "Release 里没有版本号", current, page: RELEASES_PAGE };

  const asset = pickInstaller(rel.assets);
  const hasUpdate = cmpVersion(latest, current) > 0;
  return {
    ok: true,
    current,
    latest,
    hasUpdate,
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
    notes: typeof rel.body === "string" ? rel.body.slice(0, 4000) : "",
    page: rel.html_url || RELEASES_PAGE,
    publishedAt: rel.published_at || "",
  };
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

module.exports = { check, download, launchInstaller, openReleasesPage, cmpVersion, pickInstaller, RELEASES_PAGE, REPO };
