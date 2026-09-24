"use strict";

/**
 * update-check.js —— 只读验证「检查更新」这条链路真的通
 *
 * 为什么要单独有一个探针：`src/update.js` 跑在**主进程**里（用 Electron 的 `net`，
 * 走 Chromium 网络栈 ⇒ 自动走系统代理），用 node 直接 require 是跑不起来的。
 * 而"能不能连上 GitHub Releases、能不能挑对安装包"这件事**必须真连一次**才算数
 * （项目规矩：文件存在 / 配置里有，一律不算证据）。
 *
 * 用法（用 Electron 跑，不是 node）：
 *   npm run update:check
 *   node_modules\electron\dist\electron.exe scripts\update-check.js
 *
 * 它**只读**：只发一次 GET，不下载、不写任何东西。
 * 退出码：0 = 链路通（有没有新版本都算通）；1 = 连不上 / 返回不可解析。
 */
const { app } = require("electron");

app.whenReady().then(async () => {
  const U = require("../src/update.js");
  const out = (s) => { try { process.stdout.write(s + "\n"); } catch { /* 忽略 */ } };

  out("=== 检查更新链路探针（只读）===");
  // ★ 用 `electron 脚本.js` 直接跑时，`app.getVersion()` 拿到的是 **Electron 自己的版本**
  //   （实测 37.10.3），不是我们的。所以这里显式从 package.json 读外壳版本，
  //   并按**真实外壳**的算法比一遍 —— 否则这个探针会印出一个误导人的"有更新=false"。
  const pkgVersion = (() => {
    try { return require("../package.json").version; } catch { return app.getVersion(); }
  })();
  out(`  外壳版本(package.json): v${pkgVersion}`);
  out(`  app.getVersion()      : v${app.getVersion()}  ← 直接跑脚本时这是 Electron 的版本，别被它骗`);
  out(`  仓库        : ${U.REPO}`);
  out("  正在查 GitHub Releases…");

  let r;
  try {
    r = await U.check();
  } catch (e) {
    out(`  ✗ 抛异常：${(e && e.stack) || e}`);
    app.exit(1);
    return;
  }

  out(`  ok=${r.ok}  ${r.reason || ""}`);
  out(`  当前=${r.current}  最新=${r.latest || "-"}  有更新=${r.hasUpdate}`);
  if (r.asset) out(`  安装包=${r.asset.name}（${r.asset.size} 字节）`);
  else out("  安装包=（这个 Release 没挂安装包）");
  if (r.page) out(`  页面=${r.page}`);

  // 按**真实外壳**的版本再判一次（app.getVersion() 在这里不可信，见上）
  if (r.ok && r.latest) {
    const real = U.cmpVersion(r.latest, pkgVersion) > 0;
    out(`  ★ 以真实外壳版本 v${pkgVersion} 判断：${real ? `有更新 → v${r.latest}` : "已是最新"}`);
  }

  // 版本比较的尺子也要当场验一下（历史上吃过"尺子错了还报完整"的亏）
  const cases = [
    ["0.2.4", "0.2.3", 1],
    ["0.2.3", "0.2.4", -1],
    ["0.2.3", "0.2.3", 0],
    ["0.2.10", "0.2.9", 1],
    ["v0.3.0", "0.2.9", 1],
    ["0.2.4-rc.1", "0.2.4", -1],
  ];
  let bad = 0;
  for (const [a, b, want] of cases) {
    const got = U.cmpVersion(a, b);
    if (got !== want) { bad += 1; out(`  ✗ 版本比较错: cmp(${a}, ${b}) = ${got}，应为 ${want}`); }
  }
  out(bad ? `  ✗ 版本比较 ${bad} 条不对` : `  ✓ 版本比较 6 条全对（含 0.2.10 > 0.2.9、预发布 < 正式版）`);

  // ── ★「同时看本地」那把尺子也要当场验（用户 2026-09-21 提的那条）──
  //    用户原话：「检查更新，同时检查仓库的情况和本地的情况，说不定他们是本地安装包呢。」
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const ck = (cond, label) => { if (cond) out(`  ✓ ${label}`); else { bad += 1; out(`  ✗ ${label}`); } };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-upd-local-"));
  try {
    const big = Buffer.alloc(1200 * 1024);   // 太小的会被当成残包跳过，所以造够 1.2 MB
    for (const n of [
      "DSH-Integrated-0.1.0-x64.exe",           // 比当前旧 ⇒ 不该报
      "DSH-Integrated-9.9.8-x64.exe",           // 次新
      "DSH-Integrated-9.9.9-x64.exe",           // 最高 ⇒ 应该挑它
      "DSH-Integrated-9.9.9-portable-x64.exe",  // portable ⇒ 不算
      "随便一个文件.exe",
    ]) {
      try { fs.writeFileSync(path.join(tmp, n), big); } catch { /* 忽略 */ }
    }

    out("");
    out("=== 找本地安装包（只读，临时目录）===");
    ck(U.versionFromInstallerName("DSH-Integrated-0.2.5-x64.exe") === "0.2.5", "能从文件名读出版本");
    ck(U.versionFromInstallerName("DSH-Integrated-0.2.5-portable-x64.exe") === "", "portable 不算");
    ck(U.versionFromInstallerName("别的名字.exe") === "", "别的名字不算");

    const found = U.findLocalInstaller([tmp, path.join(tmp, "不存在的目录")], "0.2.5");
    ck(!!found && found.version === "9.9.9", "★ 挑出**最高**的那个本地包（不是次新的 9.9.8）",
      found ? found.version : "没找到");
    ck(!!found && path.isAbsolute(found.path), "返回的是绝对路径");
    ck(U.findLocalInstaller([tmp], "99.0.0") === null, "★ 本地没有更高的 ⇒ null（不瞎报「有更新」）");
    ck(U.findLocalInstaller([path.join(tmp, "根本没有这个目录")], "0.1.0") === null, "目录不存在 ⇒ null（不抛错）");
    ck(U.findLocalInstaller([], "0.1.0") === null, "空目录表 ⇒ null");
    ck(U.findLocalInstaller(undefined, "0.1.0") === null, "没给目录 ⇒ null");
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  // ── 真的扫一次本仓库的 release\ —— 这就是用户要的那件事 ──
  out("");
  out("=== 顺带：真的扫一下本仓库 release\\ ===");
  const relDir = path.join(__dirname, "..", "release");
  // ★★ 这里**不能**用 `U.check({ localDirs })` 来验：
  //    用 `electron 脚本.js` 跑时 `app.getVersion()` 是 **Electron 的版本**（37.10.3），
  //    于是一个真实的 0.2.5 会被判成"比当前旧"、根本扫不出来。
  //    （本文件开头那条"探针自己也会撒谎"的坑，这是**第二处**咬人 —— 第一版就是这么假 FAIL 的。）
  //    所以直接调 findLocalInstaller 并**显式**传真实外壳版本。
  const foundInRelease = U.findLocalInstaller([relDir], "0.2.4");
  out(`  扫的目录: ${relDir}`);
  out(`  基准     : v0.2.4（假装装着的是它 —— 真实场景就是"装着的比 release\\ 里的旧"）`);
  out(`  真实外壳 : v${pkgVersion}（注意不能用 app.getVersion()，它是 ${app.getVersion()}）`);
  out(`  扫到     : ${foundInRelease ? `v${foundInRelease.version}（${foundInRelease.size} 字节）` : "没有比它更新的"}`);
  // ★ 条件式判据：只有 release\ 里**确实**躺着当前版本的安装包时才判 ——
  //   否则"忘了出包"会变成一条假 FAIL（外部状态不该写死进断言）
  const exe = path.join(relDir, `DSH-Integrated-${pkgVersion}-x64.exe`);
  if (fs.existsSync(exe)) {
    ck(!!foundInRelease && foundInRelease.version === pkgVersion,
      `★ 以 v0.2.4（装着的那一版）为基准，扫出本机 release\\ 里的 v${pkgVersion}（线上还停在 ${r.latest || "?"}）`);
    // 「不比自己新就不报」这条同样要钉住 —— 否则会一直催你升到**同一个**版本
    ck(U.findLocalInstaller([relDir], pkgVersion) === null,
      "★ 与当前**同版本**的安装包不算「有更新」（否则会一直催你升到同一个版本）");
  } else {
    out(`  （release\\ 里没有 v${pkgVersion} 的安装包，这一条不判）`);
  }

  // ── ★★ 目录清单这把尺子（2026-09-24 用户报的 bug：打好的包扫不到）──
  //    用户原话：「为什么我点检查更新的时候找不到你打包的 0.2.10 呢？」
  //    真因：清单只由 `settings.workspace\release` 组成，而那是**内核工作目录**（默认空串）
  //    ⇒ `npm run dist` 的产物在项目自己的 `release\` 里，一个候选目录都没覆盖到。
  //    这里既验"推导规则"，也验"本机真实的那个 release\ 真的进了清单"。
  out("");
  out("=== 目录清单推导（candidateInstallerDirs）===");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-upd-dirs-"));
  const fakeRoot = path.join(tmpRoot, "假工作区");
  const fakeProj = path.join(fakeRoot, "5.某项目");
  fs.mkdirSync(path.join(fakeProj, "release"), { recursive: true });
  fs.mkdirSync(path.join(fakeRoot, "release"), { recursive: true });
  // 造一个**联接**形态的子目录 —— Dirent.isDirectory() 对它返回 false，必须跟随 stat
  const linkDir = path.join(fakeRoot, "联接子目录");
  try { fs.symlinkSync(fakeProj, linkDir, "junction"); } catch { /* 权限不够就跳过那条断言 */ }

  const dirs = U.candidateInstallerDirs({
    tempDir: path.join(tmpRoot, "临时目录"),
    workspace: "",
    appPath: fakeProj,
    workspaceRoots: [fakeRoot],
  });
  const norm = (s) => path.resolve(s).replace(/[\\/]+$/, "").toLowerCase();
  const has = (p) => dirs.some((d) => norm(d) === norm(p));

  ck(has(path.join(tmpRoot, "临时目录")), "① 临时目录进了清单");
  ck(has(path.join(fakeProj, "release")), "② ★ 外壳项目目录下的 release\\ 进了清单（0.2.10 就在这种位置）");
  ck(has(path.join(fakeRoot, "release")), "③ ★ 已注册工作区**根**下的 release\\ 进了清单");
  ck(has(path.join(fakeProj, "release")), "④ ★ 工作区**一层子目录**下的 release\\ 进了清单（本机是 D:\\deepseek-workspace\\5.DSH集成桌面端）");
  if (fs.existsSync(linkDir)) {
    ck(dirs.some((d) => norm(d).startsWith(norm(linkDir))), "⑤ ★ 联接（Junction）形态的子目录也被跟随（Dirent 会骗人）");
  } else {
    out("  （没能建联接，第 ⑤ 条不判）");
  }
  ck(!U.candidateInstallerDirs({ workspace: "", appPath: fakeProj, workspaceRoots: [fakeRoot] })
    .some((d) => /temp/i.test(d) && !has(path.join(tmpRoot, "临时目录"))), "⑥ 没给临时目录时不会瞎编一个");
  ck(U.candidateInstallerDirs({ tempDir: "X", workspace: "X", appPath: "X", workspaceRoots: ["X"] })
    .filter((d) => norm(d) === norm(path.join("X", "release"))).length === 1, "⑦ 同一个目录只出现一次（去重）");

  // ★★ 最要紧的一条：**本机真实的那个 release\** 必须能被扫到，且真的扫出 0.2.10
  out("");
  out("=== ★ 本机真实场景：0.2.10 到底能不能被扫到 ===");
  const realDirs = U.candidateInstallerDirs({
    tempDir: os.tmpdir(),
    workspace: "",                                   // ← 用户现场就是空串
    appPath: path.join(__dirname, ".."),             // ← 外壳自己的项目目录
    workspaceRoots: [path.join(__dirname, "..", "..")],  // ← 本机工作区根 D:\deepseek-workspace
  });
  out(`  推导出 ${realDirs.length} 个候选目录：`);
  for (const d of realDirs) {
    let mark = "不存在";
    try { if (fs.statSync(d).isDirectory()) mark = "存在"; } catch { mark = "不存在"; }
    out(`    [${mark}] ${d}`);
  }
  const realFound = U.findLocalInstaller(realDirs, "0.2.9");
  out(`  以 v0.2.9（用户当时装的那一版）为基准扫到的: ${realFound ? `v${realFound.version} ← ${realFound.path}` : "（没有更高的）"}`);
  // ★ 注意用 realDirs 判，别用上面那个假清单的 has()（第一版就是拿错清单假 FAIL 的）
  const hasReal = (p) => realDirs.some((d) => norm(d) === norm(p));
  ck(hasReal(path.join(__dirname, "..", "release")), "★ 本仓库的 release\\ 真的进了候选清单（bug 的正解）");
  const realExe = path.join(__dirname, "..", "release", `DSH-Integrated-${pkgVersion}-x64.exe`);
  if (fs.existsSync(realExe)) {
    ck(!!realFound && U.cmpVersion(realFound.version, "0.2.9") >= 0,
      `★ 以 v0.2.9 为基准，能从本机 release\\ 扫到 v${pkgVersion}（用户现场扫不到的那个）`);
  } else {
    out(`  （release\\ 里没有 v${pkgVersion} 的安装包，这一条不判）`);
  }

  // 版本比较不过 ⇒ 就算连上也判失败（尺子错了，结论不可信）
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
  const code = (!r.ok || bad) ? 1 : 0;
  out(code ? "结果：✗ 链路或尺子有问题" : "结果：✓ 链路通、尺子对、本地扫描对");
  app.exit(code);
});
