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

  // 版本比较不过 ⇒ 就算连上也判失败（尺子错了，结论不可信）
  const code = (!r.ok || bad) ? 1 : 0;
  out(code ? "结果：✗ 链路或尺子有问题" : "结果：✓ 链路通、尺子对");
  app.exit(code);
});
