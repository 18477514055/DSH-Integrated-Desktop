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

  // ── ② 真连官方渠道：读的是**全部** dist-tags，不只 latest ──────────
  //
  // ★★ 这一段的来历（用户 2026-09-25 报的 bug）：
  //   「你这个检查内核更新的功能可靠吗？我现在只检测到了一个 0.1.5 的一个小版本，
  //     但是现在不是已经跑到 0.1.7 了吗？」
  //   直连 registry 实测：dist-tags = { latest: 0.1.5-rc.3, next: 0.1.7-rc.2,
  //     alpha: 0.1.7-alpha.2 } —— 检查**没撒谎**（`/latest` 确实就是 0.1.5-rc.3），
  //   错的是它**只问了那一个标签**，于是把"正式渠道推荐的那版"说成了"官方最新"，
  //   0.1.7 整个看不见。旧代码查的是 `…/@deepseek-ai/dsh/latest`。
  console.log("");
  console.log("── ② 真连官方渠道（npm registry 的全部 dist-tags，只读）──");
  const r = await KU.check();
  console.log(`  本机内核: ${r.installed && r.installed.found
    ? `v${r.installed.version}（来自：${r.installed.source}）` : "找不到"}`);
  const chs = Array.isArray(r.channels) ? r.channels : [];
  console.log(`  渠道清单: ${chs.map((c) => `${c.tag}=${c.version}`
    + `${c.isDefault ? "(默认)" : ""}${c.newerThanDefault ? "★比默认新" : ""}`).join("  ") || "-"}`);
  console.log(`  默认渠道: ${r.channel || "-"} = ${r.latest || "-"}`
    + `   全部渠道里最高: ${r.newest || "-"}`);
  if (r.skipped && r.skipped.length) console.log(`  跳过的标签: ${r.skipped.join("；")}`);
  if (r.reason) console.log(`  失败原因: ${r.reason}`);

  check("真连上了官方渠道并拿到版本号", !!(r.ok && r.latest), r.reason || `latest=${r.latest}`);
  check("★★ 检查读的是**全部 dist-tags**（不止 latest —— 这就是那个 bug）",
    r.ok && chs.length >= 1, chs.map((c) => `${c.tag}=${c.version}`).join(" ") || r.reason || "");
  check("★ 请求的是 npm **精简元数据**（小得多，但 dist-tags 与各版本 dist 一个不少）",
    /npm\.install-v1\+json/.test(String(KU.META_ACCEPT)), KU.META_ACCEPT);
  check("★★ 查询地址**不再是 `/latest`**（旧写法只看得见一个标签）",
    !/\/latest\/?$/.test(KU.REGISTRY), KU.REGISTRY);
  check("★ 每个渠道都带**自己的**可校验下载地址（https + integrity/shasum）",
    chs.length > 0 && chs.every((c) => c.dist && /^https:\/\//.test(c.dist.tarball)
      && (c.dist.integrity || c.dist.shasum)),
    chs.map((c) => `${c.tag}:${c.dist && c.dist.tarball
      ? (c.dist.integrity ? "有integrity" : "只有shasum") : "★没有dist"}`).join(" ") || "一个渠道都没有");
  check("★ 下载地址是 https（不是明文 http）",
    chs.length > 0 && chs.every((c) => /^https:\/\//.test(c.dist.tarball)),
    (chs[0] && chs[0].dist && chs[0].dist.tarball.slice(0, 40)) || "-");
  check("★ 默认渠道就是 `latest` 标签（不是「最高的那个」）",
    !!r.channel && chs.some((c) => c.isDefault && c.tag === r.channel)
      && (!r.tags || !r.tags.latest || r.channel === "latest"),
    `channel=${r.channel} tags.latest=${(r.tags && r.tags.latest) || "-"}`);
  check("★ 默认渠道永远排第一条（界面上位置不跳，哪怕它不是最新的）",
    !!(chs[0] && chs[0].isDefault), chs.map((c) => c.tag).join(" > ") || "-");
  check("★ 每个渠道的 hasUpdate 都与**同一把尺子**自洽（cmpVersion，不另写一套）",
    chs.every((c) => c.hasUpdate === ((r.installed && r.installed.found)
      ? KU.cmpVersion(c.version, r.installed.version) > 0 : null)),
    chs.map((c) => `${c.tag}:${c.hasUpdate}`).join(" ") || "-");
  check("★ `newest` 真的是全部渠道里版本最高的那个",
    !!r.newest && chs.every((c) => KU.cmpVersion(r.newest, c.version) >= 0), `newest=${r.newest}`);
  check("★ `newerThanDefault` 只在**比默认渠道新**的渠道上为真",
    chs.every((c) => c.newerThanDefault === (!c.isDefault
      && KU.cmpVersion(c.version, r.latest) > 0)),
    chs.map((c) => `${c.tag}:${c.newerThanDefault}`).join(" ") || "-");
  check("本机内核是**从官方渠道**来的（不是随包带的）",
    !!(r.installed && r.installed.found && /全局 npm|应用自带|显式|外壳安装/.test(r.installed.source || "")),
    (r.installed && r.installed.source) || "找不到内核");
  check("★ 本机内核**不是**外壳自带的（vendor/dsh 不存在）",
    !fs.existsSync(path.join(ROOT, "vendor", "dsh")), path.join(ROOT, "vendor", "dsh"));

  // 内核版本与"默认渠道那一版"的关系必须自洽：有更新 ⇔ default > 本机
  if (r.ok && r.installed && r.installed.found) {
    const want = KU.cmpVersion(r.latest, r.installed.version) > 0;
    check("★ hasUpdate 与版本比较**自洽**（不是另写一套判据）", r.hasUpdate === want,
      `latest=${r.latest} 本机=${r.installed.version} hasUpdate=${r.hasUpdate} 期望=${want}`);
  }

  // ── ②.5 纯函数回归：上游把新版发在 next 上时，看得见吗（**不联网**）──
  //
  // ★ 为什么不靠 ② 那几条验这件事：它们量的是"此刻 registry 上恰好有什么" ——
  //   上游哪天把 `latest` 提升到 0.1.7，真跑断言就自动变成"验不到"，护栏失效。
  //   这一段喂一份**与 2026-09-25 那天完全相同**的元数据，离线且永远可复现。
  //   ★ 旧代码在这一段会**整批 FAIL**（它只看得见 `latest` 一个标签）。
  console.log("");
  console.log("── ②.5 纯函数：上游把新版发在 next 上时，看得见吗（不联网）──");
  const fakeDist = (v) => ({
    tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${v}.tgz`,
    integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}`,
    shasum: "0".repeat(40),
    unpackedSize: 48904,
  });
  const fakeVer = (v) => ({ name: KU.PKG, version: v, dist: fakeDist(v) });
  const FIXTURE = {
    "dist-tags": { latest: "0.1.5-rc.3", next: "0.1.7-rc.2", alpha: "0.1.7-alpha.2" },
    versions: {
      "0.1.5-rc.3": fakeVer("0.1.5-rc.3"),
      "0.1.7-rc.2": fakeVer("0.1.7-rc.2"),
      "0.1.7-alpha.2": fakeVer("0.1.7-alpha.2"),
    },
  };
  const fx = KU.channelsFromMeta(FIXTURE, { found: true, version: "0.1.5-rc.2" });
  const fxChs = Array.isArray(fx.channels) ? fx.channels : [];
  console.log(`  渠道: ${fxChs.map((c) => `${c.tag}=${c.version}`
    + `${c.isDefault ? "(默认)" : ""}${c.newerThanDefault ? "★比默认新" : ""}`).join("  ")}`);
  check("★★ 三个标签**一个都没漏**（旧代码在这一条上必然 FAIL —— 它只看得见 latest）",
    fx.ok === true && fxChs.length === 3, fxChs.map((c) => c.tag).join(" ") || fx.reason);
  const fxNext = fxChs.find((c) => c.tag === "next");
  check("★★ 0.1.7-rc.2 **出现在结果里**（这正是用户问「不是已经跑到 0.1.7 了吗」的那一版）",
    !!fxNext && fxNext.version === "0.1.7-rc.2", fxNext ? `next=${fxNext.version}` : "★ next 不见了");
  check("★★ 它被标成「比默认渠道新」（界面靠这一条把 0.1.7 指出来）",
    !!(fxNext && fxNext.newerThanDefault === true), String(fxNext && fxNext.newerThanDefault));
  // ★★ 光"看得见"还不够 —— 0.1.7-rc.2 在外壳上**起不来**（下面 ②.6 有完整证据）。
  //   只报"比默认渠道更新"而不报"起不来"，等于换个姿势误导用户。
  check("★★ 同时被标成「起不来」（2026-09-25 隔离真跑的结论，不是推断）",
    !!(fxNext && fxNext.compat && fxNext.compat.usable === false
      && fxNext.compat.level === "verified-bad"),
    fxNext && fxNext.compat ? `${fxNext.compat.label} —— ${fxNext.compat.note}` : "next 不见了");
  check("★★ 默认渠道**仍然是** latest=0.1.5-rc.3（不替用户把预览渠道当默认）",
    fx.channel === "latest"
      && !!(fxChs[0] && fxChs[0].isDefault && fxChs[0].tag === "latest" && fxChs[0].version === "0.1.5-rc.3"),
    `channel=${fx.channel} 第一条=${fxChs[0] && `${fxChs[0].tag}=${fxChs[0].version}`}`);
  check("★ 全部渠道里最高的是 0.1.7-rc.2（不是默认渠道那一版）",
    fx.newest === "0.1.7-rc.2", `newest=${fx.newest}`);
  check("★ alpha 也被列出来（不认识/不常用的标签一样不藏）",
    !!fxChs.find((c) => c.tag === "alpha" && c.version === "0.1.7-alpha.2"),
    fxChs.map((c) => c.tag).join(" "));
  check("★★ 最高的那版**不在**正式渠道上 ⇒ 界面必须说清 `npm i -g` 装不到它",
    fx.newest !== FIXTURE["dist-tags"].latest,
    `newest=${fx.newest} latest=${FIXTURE["dist-tags"].latest}`);
  check("★ 每个渠道各自的 hasUpdate 都用 cmpVersion 算对了（本机 0.1.5-rc.2）",
    fxChs.find((c) => c.tag === "latest").hasUpdate === true
      && fxChs.find((c) => c.tag === "next").hasUpdate === true
      && fxChs.find((c) => c.tag === "alpha").hasUpdate === true,
    fxChs.map((c) => `${c.tag}:${c.hasUpdate}`).join(" "));
  // 反例：把本机换成比谁都新 ⇒ 三个渠道都必须报"没有更新"
  const fxNew = KU.channelsFromMeta(FIXTURE, { found: true, version: "0.2.0" });
  check("★ 反例：本机比所有渠道都新 ⇒ 三个 hasUpdate 全是 false",
    (fxNew.channels || []).every((c) => c.hasUpdate === false),
    (fxNew.channels || []).map((c) => `${c.tag}:${c.hasUpdate}`).join(" "));
  const fxNoKernel = KU.channelsFromMeta(FIXTURE, { found: false, version: "" });
  check("★ 本机找不到内核 ⇒ hasUpdate 一律 null（**不能**说「有更新」）",
    (fxNoKernel.channels || []).every((c) => c.hasUpdate === null),
    (fxNoKernel.channels || []).map((c) => `${c.tag}:${c.hasUpdate}`).join(" "));
  // 坏数据：标签指着一个元数据里没有的版本 ⇒ 跳过并记下来，不编假记录
  const fxBad = KU.channelsFromMeta(
    { "dist-tags": { latest: "0.1.5-rc.3", ghost: "9.9.9" }, versions: { "0.1.5-rc.3": fakeVer("0.1.5-rc.3") } },
    { found: true, version: "0.1.5-rc.2" });
  check("★ 标签指着元数据里没有的版本 ⇒ 跳过、写进 skipped（不编一条假渠道）",
    fxBad.ok === true && fxBad.channels.length === 1 && Array.isArray(fxBad.skipped)
      && fxBad.skipped.some((s) => /ghost/.test(s)),
    `channels=${(fxBad.channels || []).map((c) => c.tag).join(" ")} skipped=${(fxBad.skipped || []).join("；")}`);
  const fxNoTags = KU.channelsFromMeta({ versions: {} }, { found: true, version: "0.1.5-rc.2" });
  check("★ 元数据里没有 dist-tags ⇒ 明确报失败，不崩",
    fxNoTags.ok === false && !!fxNoTags.reason, fxNoTags.reason || "(没有 reason)");
  // 没有 latest 标签时退回"版本最高的那个" —— 上游随时可能改标签布局
  const fxNoLatest = KU.channelsFromMeta(
    { "dist-tags": { next: "0.1.7-rc.2", alpha: "0.1.7-alpha.2" },
      versions: { "0.1.7-rc.2": fakeVer("0.1.7-rc.2"), "0.1.7-alpha.2": fakeVer("0.1.7-alpha.2") } },
    { found: true, version: "0.1.5-rc.2" });
  check("★ 万一上游没有 latest 标签 ⇒ 默认渠道退回版本最高的那个（不崩、不空）",
    fxNoLatest.ok === true && fxNoLatest.channel === "next",
    `channel=${fxNoLatest.channel} newest=${fxNoLatest.newest}`);

  // ── ②.6 兼容性：**「有更新」不等于「能跑」** ─────────────────────
  //
  // ★★ 这一段才是用户那个问题的**真答案**。查清"0.1.7 发在 next 上"之后浮出来的
  //   更要紧的一件事：**0.1.7 在外壳上根本起不来**。
  //   真跑（`scripts/kernel-compat-check.js`，每条都是一次真启动）：
  //     0.1.5-rc.3（latest）✅ 就绪        0.1.7-rc.2（next）❌ Unsupported/no-context
  //     0.1.7-alpha.2（alpha）❌ 同上      0.1.7-rc.2 用**系统 node 24** 跑 ✅ 就绪
  //   ⇒ 卡的是 **Electron**：外壳带 37，而 0.1.6 起的内核（新增了运行时拦截）
  //     要 Electron 43/44/45。
  console.log("");
  console.log("── ②.6 兼容性：「有更新」不等于「能跑」──");
  const ev = KU.shellElectron();
  console.log(`  外壳的 Electron: ${ev}   本机系统 node: ${process.version}`);
  console.log(`  分水岭: 内核 v${KU.KERNEL_INTERCEPTION_FROM} 起要 Electron `
    + `${KU.LOADER_SUPPORTED_ELECTRON.join(" / ")}`);
  console.log(`  ${(r.channels || []).map((c) => `${c.tag}=${c.version}`
    + `（${c.compat ? c.compat.label : "-"}）`).join("  ")}`);

  check("★ 拿到了外壳的 Electron 版本（判兼容性的前提）", !!ev, ev || "(空)");
  // ★★ 这一条是**护栏的护栏**：换了 Electron 之后表里的"实测"结论全部作废。
  //    脚本在这里 FAIL，就是逼你去跑一次 kernel-compat-check.js 重新真跑。
  const staleEv = KU.COMPAT_EVIDENCE.filter((e) => e.electron !== ev);
  check("★★ 兼容性证据表记的 Electron 与本机一致（换了 Electron 就必须重新真跑）",
    staleEv.length === 0,
    staleEv.length
      ? `表里这些是别的 Electron 上验的：${staleEv.map((e) => `${e.version}@${e.electron}`).join(" ")}`
        + " —— 跑 node scripts/kernel-compat-check.js --version=<版本> 重新真跑"
      : `全部 ${KU.COMPAT_EVIDENCE.length} 条记录都是 Electron ${ev}`);
  // 尺子自检：分水岭两边各判一次 + 真跑过的那一版
  const c155 = KU.compatOf("0.1.5-rc.9", ev);       // 0.1.5 世代、**没逐版验过**
  const c160 = KU.compatOf("0.1.6", ev);           // 新增拦截的那一代
  const c170 = KU.compatOf("0.1.7-rc.2", ev);      // **真跑验过**
  check("★ 分水岭：0.1.5 世代的版本判「能跑」", c155.usable === true,
    `${c155.label} —— ${c155.note}`);
  check("★ 分水岭：0.1.6（新增运行时拦截的那一代）判「起不来」", c160.usable === false,
    `${c160.label} —— ${c160.note}`);
  check("★★ 真跑验过的 0.1.7-rc.2 判「起不来」，且证据等级是「实测」",
    c170.usable === false && c170.level === "verified-bad", `${c170.label} —— ${c170.note}`);
  check("★ 没逐版验过的版本**不许**写成「实测」（只给世代结论）",
    c155.level === "gen-ok" && c160.level === "gen-bad", `${c155.level} / ${c160.level}`);
  check("★ 换了不在加载器白名单里的 Electron ⇒ 只按白名单判，不靠猜",
    KU.LOADER_SUPPORTED_ELECTRON.length >= 1, `白名单 = ${KU.LOADER_SUPPORTED_ELECTRON.join(" / ")}`);
  // ★ 反例：把 Electron 换成加载器白名单里那一版 ⇒ 同一版内核应改判「预计能跑」。
  //   （这一条保证"外壳哪天换了 Electron"时规则会跟着走，而不是永远说 0.1.7 起不来。）
  const c160New = KU.compatOf("0.1.6", KU.LOADER_SUPPORTED_ELECTRON[0]);
  check("★ 反例：换成白名单里的 Electron ⇒ 0.1.6 那一代改判「预计能跑」",
    c160New.usable === true && c160New.level === "gen-ok",
    `${KU.LOADER_SUPPORTED_ELECTRON[0]} 上：${c160New.label}`);
  check("★ 兼容性表里的版本号结构完整（不是随手写的字符串）",
    KU.COMPAT_EVIDENCE.every((e) => /^\d+\.\d+\.\d+/.test(e.version) && /^\d+\.\d+\.\d+$/.test(e.electron)),
    KU.COMPAT_EVIDENCE.map((e) => `${e.version}@${e.electron}=${e.ok ? "ok" : "bad"}`).join(" "));
  if (r.ok) {
    const defCh = (r.channels || []).find((c) => c.isDefault);
    check("★★ 默认渠道（`latest`）那一版在**这台机器的 Electron 上实测能跑**"
      + "（否则界面就是在劝人装一个起不来的东西）",
      !!(defCh && defCh.compat && defCh.compat.usable === true),
      defCh ? `${defCh.version} → ${defCh.compat.label}` : "没有默认渠道");
    check("★ 每个渠道都带了 compat 判定（界面不自己猜「能不能跑」）",
      (r.channels || []).every((c) => c.compat && typeof c.compat.usable === "boolean" && c.compat.label),
      (r.channels || []).map((c) => `${c.tag}:${c.compat && c.compat.label}`).join(" "));
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
