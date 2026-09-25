"use strict";

/**
 * kernel-provision.js —— 让**新用户不必自己敲命令行**装内核。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 它解决什么问题（用户 2026-09-25 分发后反馈的原话）
 * ═══════════════════════════════════════════════════════════════════════════
 * 「我们之前做的那个社区版，它是打包了 node.js、dsh 官方内核的，但是我们这个
 *   纯粹的外壳下载之后还得麻烦用户自己去跑命令行下载前面这两个东西才能用，
 *   这里就不比社区版简便了。……能不能让官方内核也和插件一样在安装界面勾选，
 *   如果用户自己有的话就不用勾，或者就算勾了，扫描到电脑里已经有了，也不会下载，
 *   如果没有的话就勾上给他加一句说明就可以了。」
 *
 * ── 那两个"东西"的真实情况（2026-09-25 逐条查过）─────────────────────────
 *   · **Node.js**  → ❌ **不需要**。外壳早就是用 Electron 自己当 Node 跑内核的
 *                    （`src/kernel.js`：`spawn(process.execPath, …, ELECTRON_RUN_AS_NODE:"1")`）。
 *                    用户以为要装，其实一直没要过。
 *   · **dsh 内核** → ✅ 真缺。`vendor/dsh` 不存在 ⇒ 只能退到"全局 npm"，新用户没有。
 *
 * ── 为什么不是"自动跑一条 npm 命令"（用户原本的想法）────────────────────
 *   `npm` 命令**需要 Node.js**，而对方机器上没有 ⇒ 死循环。
 *   ★ 但 npm 本体是**纯 JS**（11.8 MB、零平台二进制），可以随外壳一起带，
 *     再用 **Electron 自带的 Node** 去跑它。2026-09-25 真跑验证：
 *       electron.exe <npm>/bin/npm-cli.js view @deepseek-ai/dsh version → 0.1.5-rc.3 ✅
 *       真装一次内核 → 518 包 / 89 秒 / 214 MB，装完 `dsh --version` 能跑 ✅
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★ 四条铁律（每一条都对着一次真实事故）
 * ═══════════════════════════════════════════════════════════════════════════
 * ① **绝不装进安装目录。** 内核落在 `<userData>\kernel\<版本>\`。
 *    社区版把内核嵌进安装目录，于是"升级内核 = 拆自己地基" ——
 *    2026-09-19 那次事故（客户端完全起不来、连逃生通道都失效）就是这么来的。
 *    ⇒ 外壳的 `src/kernel.js` 铁律 1「外壳不拥有内核」**不破**：
 *      我们只是**替用户下载**，装到用户数据目录，与外壳生命周期完全解耦。
 *
 * ② **绝不碰 `npm i -g` 的全局目录。** 那会冲掉 `dsh` 的守卫 shim
 *    （`src/kernel-update.js` 里记着这个坑），也会污染用户已有的环境。
 *    ⇒ 用 `npm install --prefix <私有目录>`，**只写我们自己的目录**。
 *
 * ③ **已装就不下载**（用户明确要求的那条）。
 *    判据复用 `kernel.js` 的 `discoverKernel()` —— 它已经会找
 *    `DSH_KERNEL_PATH` / `vendor/dsh` / 全局 npm。找到就**一个字节都不下**。
 *
 * ④ **绝不自动下载**。下载 214 MB 是件大事，**必须用户点了勾、点了开始**。
 *    本模块只提供 `status()`（只读体检）与 `provision()`（真装），
 *    由界面（首启向导 / 设置页）显式调用。**没有任何"启动时偷偷装"的路径。**
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么用 npm 装而不是"自己下 tarball 再解"
 * ═══════════════════════════════════════════════════════════════════════════
 *   内核包本体只有 0.05 MB / 10 个文件 —— **它自己几乎什么都不含**，
 *   真正的实现全在 **72 个 dependencies**（装完 190+ 个包 / 214 MB）里。
 *   ⇒ 自己解一个 tarball 只会得到一个**跑不起来的空壳**。
 *     必须有依赖解析器，而 npm 就是那个解析器。
 *   （这也是为什么 `kernel-update.js` 的"下载 .tgz"只够用来**给用户自己装**，
 *     不足以让我们代装。）
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** 官方内核包名（`kernel-update.js` 里同一个）。 */
const PKG = "@deepseek-ai/dsh";
const REGISTRY = "https://registry.npmjs.org";
const UA = "dsh-integrated-desktop-kernel-provision";

// ── 位置 ──────────────────────────────────────────────────────────────

/** 外壳自己装的内核们住这儿：`<userData>\kernel\<版本>\`。 */
function kernelRoot(userDataDir) {
  return path.join(String(userDataDir || ""), "kernel");
}

/** 某一个版本的落点。 */
function kernelDirFor(userDataDir, version) {
  return path.join(kernelRoot(userDataDir), String(version));
}

/** 装完后，内核包的真实位置（`node_modules/@deepseek-ai/dsh`）。 */
function pkgDirIn(userDataDir, version) {
  return path.join(kernelDirFor(userDataDir, version), "node_modules", "@deepseek-ai", "dsh");
}

/** 随包的 npm 在哪。打包版在 `resources/npm/`；开发版在 `<repo>/runtime/npm/`。 */
function bundledNpmDir(opts = {}) {
  if (opts.npmDir) return opts.npmDir;
  const cands = [];
  // 打包版：electron-builder 把 runtime/npm 拷到 resources/npm
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, "npm"));
  // 开发版
  cands.push(path.join(__dirname, "..", "runtime", "npm"));
  for (const c of cands) {
    if (fs.existsSync(path.join(c, "bin", "npm-cli.js"))) return c;
  }
  return "";
}

// ── 只读体检 ──────────────────────────────────────────────────────────

/**
 * 现在这台机器上，内核是什么情况？
 *
 * **只读**：不联网、不写盘、不下载。界面据此决定"勾不勾、显示什么文案"。
 *
 * @param {{userDataDir:string, kernel?:object, npmDir?:string}} opts
 *        `kernel` 传 `kernel.js` 的 `discoverKernel()` 结果（避免这里再实现一遍发现链）
 * @returns {{found:boolean, source:string, version:string, dir:string,
 *            bundledNpm:boolean, npmDir:string, root:string, installed:Array}}
 */
function status(opts = {}) {
  const userDataDir = opts.userDataDir;
  const k = opts.kernel || null;
  const npmDir = bundledNpmDir(opts);

  // 外壳自己装过哪些版本（列目录，只读）
  const installed = [];
  const root = kernelRoot(userDataDir);
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const bin = path.join(root, e.name, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
      if (fs.existsSync(bin)) installed.push({ version: e.name, dir: path.join(root, e.name) });
    }
  } catch { /* 目录不存在 = 一个都没装过 */ }
  installed.sort((a, b) => (a.version < b.version ? 1 : -1));

  return {
    // 找到任何可用的内核（不论来路）—— 这就是用户说的"扫到电脑里已经有了"
    found: !!k,
    source: k ? k.source : "",
    version: k ? k.version : "",
    dir: k ? k.dir : "",
    // 随包的 npm 在不在（不在就没法代装）
    bundledNpm: !!npmDir,
    npmDir,
    // 外壳自己装的那些
    root,
    installed,
  };
}

// ── 真装 ──────────────────────────────────────────────────────────────

/**
 * 用**随包的 npm + Electron 自带的 Node** 把内核装进 `<userData>\kernel\<版本>\`。
 *
 * @param {{userDataDir:string, version?:string, onLine?:(s:string)=>void,
 *          onProgress?:(p:{phase:string,percent?:number})=>void,
 *          timeoutMs?:number, electronPath?:string, npmDir?:string}} opts
 * @returns {Promise<{ok:boolean, version?:string, dir?:string, bin?:string,
 *                    reason?:string, log?:string[]}>}
 */
function provision(opts = {}) {
  const userDataDir = opts.userDataDir;
  const onLine = opts.onLine || (() => {});
  const onProgress = opts.onProgress || (() => {});
  const timeoutMs = Number(opts.timeoutMs) || 20 * 60 * 1000;   // 实测 89 秒，给足余量

  const npmDir = bundledNpmDir(opts);
  if (!npmDir) {
    return Promise.resolve({ ok: false, reason: "随包的 npm 不在（打包时漏了 runtime/npm？）" });
  }
  const npmCli = path.join(npmDir, "bin", "npm-cli.js");
  const electron = opts.electronPath || process.execPath;

    // ★ 版本：不指定就查 registry 的 latest（走 Chromium 网络栈之外的一条轻量路）
    //
    // ★★ 2026-09-25 说明为什么这里**故意仍然只查 `/latest`**（同一个项目里
    //   `src/kernel-update.js` 刚刚因为"只看 latest"被修过，别以为是漏了）：
    //   · 这一段的语义是「**新装一个能用的内核**」，装官方**正式渠道**发的那一版是对的；
    //   · 「**看得见有哪些版本**」以及"每个渠道各是几版"是另一件事，那在
    //     `kernel-update.js` 的渠道清单里（它读整份 dist-tags）。
    //   · 上游把 `latest` 停在 0.1.5、把 0.1.7 发在 `next` 上 —— 默认装 latest
    //     **正是"不把预览渠道塞给新用户"**。
    //   ⇒ 要装非默认渠道，走 `provision({version})` 显式指定（接口早就支持），
    //     或者用「检查内核更新」下载 .tgz 那条路。**别把这里改成"挑最高的那个"。**
  const wantVersion = String(opts.version || "").trim();

  return new Promise((resolve) => {
    const log = [];
    const say = (s) => { log.push(s); onLine(s); };

    const finish = (r) => resolve({ ...r, log });

    // ── ① 先问 registry：要装哪个版本（没指定时）──
    const askLatest = () => new Promise((res) => {
      const https = require("node:https");
      const req = https.get(`${REGISTRY}/${PKG.replace("/", "%2F")}/latest`,
        { headers: { "User-Agent": UA }, timeout: 20000 }, (r) => {
          if (r.statusCode !== 200) { r.resume(); return res({ ok: false, reason: `HTTP ${r.statusCode}` }); }
          let s = ""; r.setEncoding("utf8");
          r.on("data", (d) => { s += d; });
          r.on("end", () => {
            try {
              const j = JSON.parse(s);
              if (!j.version) return res({ ok: false, reason: "返回里没有 version" });
              res({ ok: true, version: j.version });
            } catch (e) { res({ ok: false, reason: `不是合法 JSON：${e.message}` }); }
          });
        });
      req.on("timeout", () => req.destroy(new Error("超时")));
      req.on("error", (e) => res({ ok: false, reason: (e && e.message) || String(e) }));
    });

    (async () => {
      let version = wantVersion;
      if (!version) {
        onProgress({ phase: "check" });
        say(`查官方最新版本…`);
        const q = await askLatest();
        if (!q.ok) {
          return finish({ ok: false, reason: `查不到官方最新版：${q.reason}` });
        }
        version = q.version;
      }
      say(`要装的版本：${PKG}@${version}`);

      const dest = kernelDirFor(userDataDir, version);
      const pkgDir = pkgDirIn(userDataDir, version);
      const bin = path.join(pkgDir, "lib", "bin.js");

      // ── ② 已经装过这个版本？直接复用（**一个字节都不下**）──
      if (fs.existsSync(bin)) {
        say(`✓ ${version} 已经装过了（${dest}）—— 不重复下载`);
        return finish({ ok: true, version, dir: pkgDir, root: dest, bin, reused: true });
      }

      fs.mkdirSync(dest, { recursive: true });
      say(`落点：${dest}`);
      say(`用的 npm：${npmCli}`);
      say(`用的 node：${electron}（Electron 自带的，不需要用户装 Node.js）`);

      // ── ③ 真装 ──
      //
      // ★ 参数逐条都有理由：
      //   `--prefix <私有目录>`  ⇒ **绝不碰全局 npm 目录**（铁律②）
      //   `--no-save`            ⇒ 不生成 package.json 依赖记录（我们不是个 node 项目）
      //   `--no-audit --no-fund` ⇒ 关掉两个联网的附加动作（快，且少两处失败点）
      //   `--loglevel=error`     ⇒ 只要错误，进度我们自己按行读
      //   `--ignore-scripts`     ⇒ **刻意不跑安装脚本**。
      //       官方内核的依赖里没有必须编译的原生模块（实测装完直接能跑），
      //       而跑脚本意味着"下载任意代码并执行" —— 对一个刚装好的空目录来说风险不值当。
      //       ⚠️ 若将来某版内核真需要编译，这一条要重新评估（那时会有明确报错，不会静默坏）。
      const args = [
        npmCli, "install",
        "--prefix", dest,
        "--no-save", "--no-audit", "--no-fund",
        "--loglevel=error",
        "--ignore-scripts",
        `${PKG}@${version}`,
      ];

      onProgress({ phase: "install" });
      say(`开始安装（实测约 1.5 分钟 / 214 MB）…`);

      const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
      // ★ 别让 npm 走用户 shell 里可能存在的代理配置（我们自己的网络栈更可预期）
      delete env.npm_config_proxy;
      delete env.npm_config_https_proxy;
      delete env.HTTP_PROXY;
      delete env.HTTPS_PROXY;

      const child = spawn(electron, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        say(`✗ 超时（${Math.round(timeoutMs / 1000)} 秒）—— 已终止`);
        try { child.kill(); } catch { /* 忽略 */ }
        finish({ ok: false, reason: `安装超时（${Math.round(timeoutMs / 1000)} 秒）` });
      }, timeoutMs);

      const feed = (buf) => {
        for (const line of String(buf).split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          say(t);
          // npm 的进度条形如 "⸨████░░░░⸩ ⸨ 45%⸩" —— 抠出百分比喂给界面
          const m = t.match(/(\d{1,3})%/);
          if (m) onProgress({ phase: "install", percent: Number(m[1]) });
        }
      };
      child.stdout.on("data", feed);
      child.stderr.on("data", feed);

      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish({ ok: false, reason: `起不来：${(e && e.message) || e}` });
      });

      child.on("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          say(`✗ npm 退出码 ${code}`);
          return finish({ ok: false, reason: `npm 退出码 ${code}` });
        }
        // ── ④ 收口：**去磁盘上找证据**，不信 npm 自己的输出（铁律：真跑才算）
        if (!fs.existsSync(bin)) {
          say(`✗ npm 说装完了，但 ${bin} 不存在`);
          return finish({ ok: false, reason: "装完了却找不到 lib/bin.js（安装不完整）" });
        }
        let v = "";
        try { v = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version || ""; }
        catch { /* 版本读不到不算致命 */ }
        say(`✓ 装好了：${pkgDir}${v ? `（版本 ${v}）` : ""}`);
        onProgress({ phase: "done", percent: 100 });
        // ★ 返回 root（= prefix 目录）而不只是 pkgDir：
        //   内核本体只有 10 个文件 / 0.05 MB，**真正的实现全在它的兄弟目录里**
        //   （`<root>/node_modules/` 下 500+ 个包 / 214 MB）。
        //   要统计体积、要在界面上给"打开目录"，都得用 root。
        //   （这个区别我自己的验收脚本第一版就量错了 —— 见 kernel-provision-check.js 的注释。）
        finish({ ok: true, version: v || version, dir: pkgDir, root: dest, bin });
      });
    })().catch((e) => finish({ ok: false, reason: `内部错误：${(e && e.stack) || e}` }));
  });
}

/** 删掉外壳装过的某个版本（设置页给个后悔药；**只删我们自己的目录**）。 */
function remove(userDataDir, version) {
  const dir = kernelDirFor(userDataDir, version);
  // ★ 安全闸：只允许删 <userData>\kernel\ 底下的东西，别的一律拒绝
  const root = path.resolve(kernelRoot(userDataDir));
  const target = path.resolve(dir);
  if (!target.startsWith(root + path.sep)) {
    return { ok: false, reason: `拒绝：${target} 不在 ${root} 里` };
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

module.exports = {
  PKG, REGISTRY,
  kernelRoot, kernelDirFor, pkgDirIn, bundledNpmDir,
  status, provision, remove,
};
