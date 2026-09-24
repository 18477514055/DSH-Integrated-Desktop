"use strict";

/**
 * kernel-update-check —— 「检查内核更新」的**真跑**验收
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须是 Electron 主进程跑
 * ══════════════════════════════════════════════════════════════════
 *   `src/kernel-update.js` 用 Electron 的 `net`（走 Chromium 网络栈 ⇒ 自动走系统代理，
 *   本机就是 Clash 7897）。`node` 直接 require 它拿不到 `net`。
 *   所以这个脚本用 `electron` 跑（跟 `scripts/update-check.js` 同一套路）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它验什么（三层，缺一层都不算数）
 * ══════════════════════════════════════════════════════════════════
 *   ① **版本比较这把尺子**（纯函数，不联网）—— 尤其是预发布那几条：
 *      `0.1.5-rc.10 > 0.1.5-rc.9`（**按字符串比会得出反的结论**）。
 *      项目铁律：「先证明尺子对，再报结论」。
 *   ② **真连一次官方渠道**（npm registry）—— 只读，不写。
 *      并核对返回的东西**确实是我们要的**（version + 可校验的 dist）。
 *   ③ **校验函数真的会拒绝坏数据** —— 造一个字节被改过的文件，
 *      `verifyDigest` 必须说"不通过"。不然"下载完校验"就只是一句话。
 *
 * ⚠️ **不下载**（那要几 MB 且会写磁盘）：下载路径由 ③ 用现造的小文件覆盖。
 *    想验真下载：在设置页点「下载官方内核包」，它会把包放到
 *    `<userData>\kernel-update\` 并**按官方 sha512 校验**。
 *
 * 用法： npx electron scripts/kernel-update-check.js
 * 退出码：0 全过；1 有 FAIL。
 */

const { app } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const KU = require(path.join(ROOT, "src", "kernel-update.js"));
const K = require(path.join(ROOT, "src", "kernel.js"));

const failures = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures.push(`${name}: ${detail || ""}`);
}

/**
 * ★ 本脚本自己也会撒谎，所以要显式读 package.json 的版本再判一次。
 *   （用 `electron 脚本.js` 跑时，`app.getVersion()` 拿到的是 **Electron 的**版本，
 *     本机实测是 37.10.3 —— `update-check.js` 第一版就因此印出过误导人的结论。）
 */
function shellVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version; }
  catch { return ""; }
}

async function main() {
  console.log("=== 检查内核更新：验收（真跑）===");
  console.log(`  外壳版本（从 package.json 读）: ${shellVersion() || "?"}`);
  console.log(`  （注意：app.getVersion() = ${app.getVersion()} —— 这个数是 Electron 的，别用它）`);
  console.log("");

  // ── ① 尺子：版本比较 ─────────────────────────────────────────────
  console.log("── ① 版本比较（纯函数）──");
  const cases = [
    ["0.1.6", "0.1.5-rc.2", 1, "正式版 > 预发布"],
    ["0.1.5", "0.1.5-rc.2", 1, "同版本：正式版 > 预发布"],
    ["0.1.5-rc.2", "0.1.5-rc.1", 1, "预发布递增"],
    ["0.1.5-rc.10", "0.1.5-rc.9", 1, "★ rc.10 > rc.9（按字符串比会反）"],
    ["0.1.5-rc.2", "0.1.5-rc.10", -1, "★ 反向也成立"],
    ["0.2.0", "0.1.9", 1, "次版本进位"],
    ["0.1.10", "0.1.9", 1, "★ 0.1.10 > 0.1.9（字符串比会反）"],
    ["1.0.0", "0.99.99", 1, "主版本进位"],
    ["0.1.5-rc.2", "0.1.5-rc.2", 0, "完全相同"],
    ["v0.1.6", "0.1.6", 0, "前导 v 不影响"],
    ["0.1.5-rc.1.1", "0.1.5-rc.1", 1, "预发布段数多的更大"],
    ["0.1.5-rc.1", "0.1.5-alpha", 1, "★ 数字标识 < 字母标识（rc 比 alpha 大）"],
    ["0.1.5-beta", "0.1.5-alpha", 1, "字母标识按 ASCII 比"],
    ["0.1.5-rc.2+build9", "0.1.5-rc.2", 0, "build metadata 不参与比较"],
  ];
  let rulerOk = 0;
  for (const [a, b, want, why] of cases) {
    const got = KU.cmpVersion(a, b);
    const ok = got === want;
    if (ok) rulerOk++;
    else check(`cmpVersion(${a}, ${b})`, false, `期望 ${want} 实得 ${got} —— ${why}`);
  }
  check(`★ 版本比较这把尺子：${rulerOk}/${cases.length} 条全对`, rulerOk === cases.length,
    rulerOk === cases.length ? "含 rc.10>rc.9、0.1.10>0.1.9 两条容易写错的" : `${cases.length - rulerOk} 条错`);

  // ── ② 真连官方渠道 ───────────────────────────────────────────────
  console.log("");
  console.log("── ② 真连官方渠道（npm registry，只读）──");
  const r = await KU.check();
  console.log(`  本机内核: ${r.installed && r.installed.found
    ? `v${r.installed.version}（来自：${r.installed.source}）` : "找不到"}`);
  console.log(`  官方最新: ${r.latest || "-"}   有更新: ${r.hasUpdate}   ${r.reason || ""}`);
  check("真连上了官方渠道并拿到版本号", !!(r.ok && r.latest), r.reason || `latest=${r.latest}`);
  check("★ 返回里带**可校验的**下载地址（dist.tarball + integrity/shasum）",
    !!(r.dist && r.dist.tarball && (r.dist.integrity || r.dist.shasum)),
    r.dist ? `tarball=${r.dist.tarball.slice(0, 60)}… integrity=${(r.dist.integrity || "").slice(0, 28)}…` : "没有 dist");
  check("★ 下载地址是 https（不是明文 http）",
    !!(r.dist && /^https:\/\//.test(r.dist.tarball)), r.dist && r.dist.tarball.slice(0, 40));
  check("本机内核是**从官方渠道**来的（不是随包带的）",
    !!(r.installed && r.installed.found && /全局 npm|应用自带|显式/.test(r.installed.source || "")),
    (r.installed && r.installed.source) || "找不到内核");
  check("★ 本机内核**不是**外壳自带的（vendor/dsh 不存在）",
    !fs.existsSync(path.join(ROOT, "vendor", "dsh")), path.join(ROOT, "vendor", "dsh"));

  // 内核版本与"官方最新"的关系必须自洽：有更新 ⇔ latest > 本机
  if (r.ok && r.installed && r.installed.found) {
    const want = KU.cmpVersion(r.latest, r.installed.version) > 0;
    check("★ hasUpdate 与版本比较**自洽**（不是另写一套判据）", r.hasUpdate === want,
      `latest=${r.latest} 本机=${r.installed.version} hasUpdate=${r.hasUpdate} 期望=${want}`);
  }

  // ── ③ 校验函数真的会拒绝坏数据 ──────────────────────────────────
  console.log("");
  console.log("── ③ 「下载完校验」不是一句话（真造坏数据喂它）──");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-kncheck-"));
  try {
    const good = Buffer.from("this stands in for a real kernel tarball", "utf8");
    const goodFile = path.join(tmp, "good.tgz");
    fs.writeFileSync(goodFile, good);

    const integrity = "sha512-" + crypto.createHash("sha512").update(good).digest("base64");
    const shasum = crypto.createHash("sha1").update(good).digest("hex");

    const vGood = KU.verifyDigest(goodFile, { integrity });
    check("① 用官方 sha512 integrity 校验**好文件** ⇒ 通过",
      vGood.ok === true, JSON.stringify(vGood));

    const vGood1 = KU.verifyDigest(goodFile, { shasum });
    check("② 没有 integrity 时退回 sha1 shasum ⇒ 也通过",
      vGood1.ok === true, JSON.stringify(vGood1));

    const badFile = path.join(tmp, "bad.tgz");
    const bad = Buffer.from(good);
    bad[0] = bad[0] ^ 0xff;             // 改一个字节
    fs.writeFileSync(badFile, bad);
    const vBad = KU.verifyDigest(badFile, { integrity });
    check("★★ 改掉**一个字节** ⇒ 校验必须**拒绝**（否则校验形同虚设）",
      vBad.ok === false, JSON.stringify(vBad));

    const vBad1 = KU.verifyDigest(badFile, { shasum });
    check("★★ sha1 那条路也要拒绝同一个坏文件", vBad1.ok === false, JSON.stringify(vBad1));

    const vNone = KU.verifyDigest(goodFile, {});
    check("★ 官方源**没给**校验值 ⇒ 拒绝（宁可不下，也不下个没校验的）",
      vNone.ok === false, JSON.stringify(vNone));

    const vMissing = KU.verifyDigest(path.join(tmp, "nope.tgz"), { integrity });
    check("文件不存在 ⇒ 报错而不是崩", vMissing.ok === false, JSON.stringify(vMissing));

    // tarball 文件名解析
    check("tarball 文件名解析正确",
      KU.tarballName("https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.2.tgz", "x")
        === "dsh-0.1.5-rc.2.tgz",
      KU.tarballName("https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.2.tgz", "x"));

    // 那条"由你自己执行"的命令必须含守卫提醒（装完要重跑，否则 dsh shim 被冲掉）
    const hint = KU.installHint("C:\\some\\path\\dsh-0.1.5-rc.2.tgz");
    check("★ 给用户的安装命令里含「装完重跑守卫」那一步",
      /dsh-guard-install\.ps1/.test(hint), hint.split("\n").filter(Boolean).slice(1, 3).join(" / "));
    check("★ 安装命令是 npm install -g（官方渠道），不是别的野路子",
      /npm install -g/.test(hint), hint.split("\n")[0]);
    check("★ 安装命令里提醒了要重启客户端",
      /重启客户端/.test(hint), hint.split("\n").slice(-1)[0]);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  // ── ④ "不与外壳冲突"那三条，机械核一遍 ──────────────────────────
  console.log("");
  console.log("── ④ 本版主张：「内核更新不与外壳冲突」──");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const files = (pkg.build && pkg.build.files) || [];
  check("① 安装包只打外壳自己的 src/** 与 assets/**，**不含内核**",
    files.includes("src/**/*") && !files.some((f) => /vendor/i.test(f)),
    JSON.stringify(files));
  // 0.2.13 起 extraResources 又有了，但装的是**我们自带的 npm**（给"外壳代装内核"用），
  // 不是随包插件。所以这里断言的落点从"没有 extraResources"改成"没有任何随包插件"。
  const extraRes = (pkg.build && pkg.build.extraResources) || [];
  const resTo = extraRes.map((e) => String((e && e.to) || e || ""));
  const pluginRes = resTo.filter((t) => /plugin/i.test(t));
  check("① 也没有随包插件（0.2.6 起不再随包发插件）",
    !files.some((f) => /plugin/i.test(f)) && pluginRes.length === 0,
    "files=" + JSON.stringify(files) + " extraResources.to=" + JSON.stringify(resTo));
  check("①.1 extraResources 里只允许放 npm 运行时（0.2.13 起）",
    resTo.length === 0 || resTo.every((t) => t === "npm" || t === "npm/node_modules"),
    "extraResources.to=" + JSON.stringify(resTo));
  // ★★ 0.2.14：随包 npm 的**两条** extraResources 必须成对存在。
  //
  //   为什么单列这一条（2026-09-25 实测抓到的真 bug）：
  //     electron-builder 的 `app-builder-lib/out/util/filter.js:43-45` 里
  //     **硬编码**了一行 `if (relative === "node_modules") return false;`
  //     ⇒ 一条 `from: runtime/npm` 的 extraResources **永远拷不进 node_modules**：
  //       实测 1944 个文件只剩 418 个 / 3.2 MB，产物里那个 npm 是个跑不起来的空壳。
  //     ⇒ 修法是把里层拆成第二条（`from: runtime/npm/node_modules` → `to: npm/node_modules`），
  //       那样它的相对路径不再是 "node_modules"，就能过。
  //   ⇒ 这两条**必须同时存在**，少一条就等于发一个装不了内核的包。
  //     （判据的"真跑"版本在 scripts/packaged-npm-check.js —— 它会回读产物。）
  {
    const froms = extraRes.map((e) => String((e && e.from) || e || ""));
    const hasOuter = froms.includes("runtime/npm");
    const hasInner = froms.includes("runtime/npm/node_modules");
    check("①.2 ★★ 随包 npm 的两条 extraResources 成对存在（少一条 = 发个装不了内核的包）",
      !extraRes.length || (hasOuter && hasInner),
      "from=" + JSON.stringify(froms)
      + (extraRes.length && !hasInner
        ? "  ← 缺 runtime/npm/node_modules：electron-builder 会**静默丢掉** node_modules"
          + "（filter.js:43 硬编码 relative==='node_modules' 就拒绝），产物里的 npm 跑不起来" : ""));
  }
  const src = fs.readFileSync(path.join(ROOT, "src", "kernel.js"), "utf8");
  check("② 外壳把内核当**外部程序**（spawn 它的 bin.js），不引用内核内部模块",
    /spawn\(process\.execPath/.test(src) && !/require\(["']@deepseek-ai\/dsh/.test(src),
    "kernel.js 里是 spawn + 读 stdout");
  const dshHome = K.resolveDshHome({ userDataDir: path.join(os.homedir(), "AppData", "Roaming", "DSH Integrated") });
  check("③ 插件落点（profiles/<档案>/node_modules）与内核镜像层（profiles/node_modules）是**两层**",
    path.join(dshHome, "profiles", "node_modules") !== path.join(dshHome, "profiles", "web", "node_modules"),
    dshHome);

  console.log("");
  if (failures.length) {
    console.error(`[kernel-update-check] ${failures.length} 项 FAIL:`);
    for (const f of failures) console.error("  - " + f);
    app.exit(1);
    return;
  }
  console.log("[kernel-update-check] 全部通过");
  app.exit(0);
}

app.whenReady().then(main).catch((e) => {
  console.error("[kernel-update-check] 执行异常:", (e && e.stack) || e);
  app.exit(1);
});
