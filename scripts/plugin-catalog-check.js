"use strict";

/**
 * plugin-catalog-check.js —— `src/plugin-catalog.js` 的真跑验收
 *
 * 这个模块是外壳与生产端之间**唯一**的接口点，所以两类事必须钉死：
 *   ① **容错**：生产端换格式、某条数据坏掉时，清单不能整个打没，也不能瞎猜；
 *   ② **安全**：它决定"从哪下、下哪个"，而那个包最终会**装进用户的家、跑在用户的内核里**
 *      ⇒ 来源必须是**写死的边界**，不能让索引说去哪就去哪。
 *
 * 纯函数部分在**普通 node** 里跑（不需要 Electron）；
 * 最后一段拿**线上真实索引**跑一遍（连不上明确 SKIP，不算通过）。
 *
 * 用法：node scripts/plugin-catalog-check.js [--keep]
 */

const C = require("../src/plugin-catalog.js");

let OK = 0;
const FAILS = [];
const SKIPS = [];
function chk(cond, label, extra) {
  if (cond) { OK++; console.log(`  OK   ${label}`); }
  else {
    FAILS.push(label + (extra ? `  <-- ${extra}` : ""));
    console.log(`  FAIL ${label}${extra ? "  <-- " + extra : ""}`);
  }
}
function skip(label, why) { SKIPS.push(label); console.log(`  SKIP ${label}  （${why}）`); }
function section(t) { console.log(`\n=== ${t} ===`); }

// ═════════════════════════════════════════════════════════════════════════
section("① 模块能在普通 node 里被 require（纯函数与 Electron 解耦）");
// ═════════════════════════════════════════════════════════════════════════
chk(typeof C.normalizeIndex === "function", "normalizeIndex 可用");
{
  const { cmpVersion } = require("../src/update.js");
  chk(cmpVersion("0.2.10", "0.2.9") === 1, "version 尺子：0.2.10 > 0.2.9（按字符串比会得出反的）");
  chk(cmpVersion("0.2.4-rc.1", "0.2.4") === -1, "version 尺子：预发布 < 正式版");
  chk(cmpVersion("1.0.0", "1.0.0") === 0, "version 尺子：相等返回 0");
}

// ═════════════════════════════════════════════════════════════════════════
section("② 下载来源边界 —— 索引说去哪不算，得在允许名单里");
// ═════════════════════════════════════════════════════════════════════════
{
  chk(C.isAllowedDownloadUrl("https://github.com/o/r/releases/download/t/a.tgz") === true, "github.com 放行");
  chk(C.isAllowedDownloadUrl("https://raw.githubusercontent.com/o/r/main/x.json") === true, "raw.githubusercontent.com 放行");
  chk(C.isAllowedDownloadUrl("https://objects.githubusercontent.com/x") === true, "objects.githubusercontent.com 放行");
  chk(C.isAllowedDownloadUrl("http://github.com/o/r/a.tgz") === false, "★ http（非 https）拒绝");
  chk(C.isAllowedDownloadUrl("https://evil.example.com/a.tgz") === false, "★ 别的主机拒绝");
  chk(C.isAllowedDownloadUrl("https://github.com.evil.com/a.tgz") === false, "★ 后缀伪装（github.com.evil.com）拒绝");
  chk(C.isAllowedDownloadUrl("file:///C:/Windows/system32/calc.exe") === false, "★ file: 协议拒绝");
  chk(C.isAllowedDownloadUrl("javascript:alert(1)") === false, "★ javascript: 拒绝");
  chk(C.isAllowedDownloadUrl("") === false, "空串拒绝");
  chk(C.isAllowedDownloadUrl("不是网址") === false, "不是网址拒绝");
  chk(C.repoOf("https://github.com/18477514055/DSH-Plugin-Hub/releases/download/t/a.tgz") === "18477514055/DSH-Plugin-Hub",
    "能从下载地址反查出 owner/repo");
}

// ═════════════════════════════════════════════════════════════════════════
section("③ normalizeEntry —— 一条的容错");
// ═════════════════════════════════════════════════════════════════════════
const GOOD = {
  name: "dsh-demo",
  version: "1.2.3",
  file: "dsh-demo-1.2.3.tgz",
  sha256: "a".repeat(64),
  bytes: 12345,
  description: "演示插件",
  downloadUrl: "https://github.com/o/r/releases/download/t/dsh-demo-1.2.3.tgz",
  releaseUrl: "https://github.com/o/r/releases/tag/t",
  publishedAt: "2026-09-21T05:05:56.515Z",
  keywords: ["demo"],
  platform: "web",
};
{
  const r = C.normalizeEntry(GOOD);
  chk(!!r.entry && r.errors.length === 0, "完整条目 → 通过", r.errors.join("；"));
  chk(r.entry.name === "dsh-demo" && r.entry.version === "1.2.3", "name/version 读对");
  chk(r.entry.sha256 === "a".repeat(64), "sha256 读对");
  chk(r.entry.bytes === 12345, "bytes 读成数字");
  chk(r.entry.compatible === true, "platform=web ⇒ 适用");
  chk(r.entry.repo === "o/r", "反查出 repo");
  chk(!!r.entry.raw, "原始对象留在 raw 里（将来加字段不用改外壳）");

  // 必填三件套
  for (const k of ["name", "version", "downloadUrl"]) {
    const bad = { ...GOOD }; delete bad[k];
    const rr = C.normalizeEntry(bad);
    chk(rr.entry === null && rr.errors.some((e) => e.includes(k)), `缺 ${k} → 整条跳过并记账`);
  }

  const badName = C.normalizeEntry({ ...GOOD, name: "有 空格 的 名字" });
  chk(badName.entry === null, "包名非法 → 跳过");

  const badUrl = C.normalizeEntry({ ...GOOD, downloadUrl: "https://evil.example.com/x.tgz" });
  chk(badUrl.entry === null && badUrl.errors.some((e) => /允许的来源/.test(e)),
    "★ 下载地址不在允许来源 → 跳过（不是「照下」）");

  // sha256 坏格式 ⇒ 降级成"没有"，不是拿坏哈希去比对
  const badHash = C.normalizeEntry({ ...GOOD, sha256: "xyz" });
  chk(!!badHash.entry && badHash.entry.sha256 === "", "sha256 格式不对 ⇒ 当作没有");
  chk(badHash.warnings.some((w) => /sha256/.test(w)), "且留下警告");

  const noHash = C.normalizeEntry({ ...GOOD, sha256: undefined });
  chk(!!noHash.entry && noHash.warnings.some((w) => /sha256/.test(w)), "缺 sha256 ⇒ 保留但标记未校验");

  const noBytes = C.normalizeEntry({ ...GOOD, bytes: undefined });
  chk(!!noBytes.entry && noBytes.entry.bytes === 0 && noBytes.warnings.some((w) => /bytes/.test(w)),
    "缺 bytes ⇒ 0 并警告（不猜大小）");

  const nodePlat = C.normalizeEntry({ ...GOOD, platform: "node" });
  chk(!!nodePlat.entry && nodePlat.entry.compatible === false, "platform=node ⇒ 标记为不适用（不静默藏起来）");

  const noDesc = C.normalizeEntry({ ...GOOD, description: undefined });
  chk(!!noDesc.entry && noDesc.entry.description === "", "缺 description ⇒ 空串（不编一段说明）");

  chk(C.normalizeEntry(null).entry === null, "null → 跳过");
  chk(C.normalizeEntry("字符串").entry === null, "字符串 → 跳过");
  chk(C.normalizeEntry([1, 2]).entry === null, "数组 → 跳过");
}

// ═════════════════════════════════════════════════════════════════════════
section("④ normalizeIndex —— 一条坏数据不许把整个清单打没");
// ═════════════════════════════════════════════════════════════════════════
{
  const idx = C.normalizeIndex({
    schema: "dsh-plugin-index/v1",
    repo: "o/r",
    updatedAt: "2026-09-21T00:00:00Z",
    entries: [GOOD, { name: "坏的" }, { ...GOOD, name: "dsh-demo2" }, null],
  });
  chk(idx.knownSchema === true, "认得的 schema ⇒ knownSchema=true");
  chk(idx.entries.length === 2, "4 条里 2 条好 ⇒ 只留 2 条", String(idx.entries.length));
  chk(idx.skipped.length === 2, "另 2 条进了 skipped 账", JSON.stringify(idx.skipped));
  chk(idx.repo === "o/r" && idx.updatedAt === "2026-09-21T00:00:00Z", "repo/updatedAt 读对");

  const un = C.normalizeIndex({ schema: "dsh-plugin-index/v9", entries: [GOOD] });
  chk(un.knownSchema === false, "不认识的 schema ⇒ 标记 false");
  chk(un.warnings.some((w) => /v9/.test(w)), "★ 但不报错、照读，只留一句警告");
  chk(un.entries.length === 1, "★ 版本不认得也把能读的读出来");

  const noArr = C.normalizeIndex({ schema: "x", entries: "不是数组" });
  chk(noArr.entries.length === 0 && noArr.skipped.length === 1, "entries 不是数组 ⇒ 空清单 + 记账");

  chk(C.normalizeIndex(null).skipped.length === 1, "整份不是对象 ⇒ 记账");
  const empty = C.normalizeIndex({});
  chk(empty.entries.length === 0 && empty.knownSchema === true, "没写 schema ⇒ 当作认得（向后兼容）");
}

// ═════════════════════════════════════════════════════════════════════════
section("⑤ groupByName —— 同名的多个版本，谁才是「最新」");
// ═════════════════════════════════════════════════════════════════════════
{
  const mk = (name, version, extra = {}) => C.normalizeEntry({
    ...GOOD, name, version, ...extra,
  }).entry;

  const g = C.groupByName([
    mk("dsh-a", "0.2.9"),
    mk("dsh-a", "0.2.10"),          // ★ 字符串比会挑错的那个
    mk("dsh-b", "1.0.0"),
  ]);
  const a = g.find((x) => x.name === "dsh-a");
  chk(a && a.latest.version === "0.2.10", "★ 最新版挑的是 0.2.10 而不是 0.2.9", a ? a.latest.version : "无");
  chk(a.versions.length === 2 && a.versions[0].version === "0.2.10", "版本列表从高到低排");

  // ★★ 2026-09-25 修正：这三条断言**曾经是错的**（长期 FAIL，被当成"旧账"）。
  //
  //   原断言假设 `DEV_ONLY_FALLBACK` 里有 `dsh-plugin-uploader`，
  //   但那份名单 **2026-09-23 被刻意清空了** —— 用户原话：
  //     「我认为它应该是一个普通插件，而不是只局限在开发者工具之上。」
  //   （`src/plugin-catalog.js` 里 `DEV_ONLY_FALLBACK` 上方那段注释就是这件事，
  //     而且 commit `814c5cb`「上传器不再是「开发者工具」」也是同一件事。）
  //   ⇒ **不是代码坏了，是断言没跟着改**。
  //     这类"长期 FAIL"最危险的地方在于：它会让真 FAIL 混在噪音里没人看。
  //   现在改成锁**新事实**，并且**用一个自造的 tier=dev 条目**去验"排序"这条规则本身
  //   （否则"开发工具排最后"这条断言会因为没有开发工具而变得空洞）。
  const dev = C.groupByName([
    mk("dsh-normal", "1.0.0"),
    C.normalizeEntry({ ...GOOD, name: "dsh-dev-tool", tier: "dev" }).entry,
  ]);
  chk(dev[dev.length - 1].name === "dsh-dev-tool", "★ 开发工具排到最后（普通插件在前）");
  chk(dev[dev.length - 1].devOnly === true, "并标了 devOnly");
  chk(dev[0].devOnly === false, "普通插件 devOnly=false");
  chk(C.DEV_ONLY_FALLBACK.size === 0,
    "★ 兜底名单现在是空的（2026-09-23 刻意清空：上传器是普通插件）",
    String(C.DEV_ONLY_FALLBACK.size));

  chk(C.groupByName([]).length === 0, "空输入 → 空输出");
}

// ═════════════════════════════════════════════════════════════════════════
section("⑥ isDevOnly —— 优先读索引字段，读不到才退回落名单");
// ═════════════════════════════════════════════════════════════════════════
{
  const mk = (name, extra = {}) => C.normalizeEntry({ ...GOOD, name, ...extra }).entry;
  // ★ 2026-09-25 修正：原来断言「dsh-plugin-uploader 在兜底名单里 ⇒ 是开发工具」，
  //   但那份名单 2026-09-23 已刻意清空（上传器改判为普通插件）。
  //   现在锁的是**机制**：名单空 ⇒ 不在名单里的一律不是；而 tier/keywords/hidden 仍能判。
  chk(C.isDevOnly(mk("dsh-plugin-uploader")) === false,
    "★ 上传器**不再**被当开发者工具（2026-09-23 起它是普通插件）");
  chk(C.isDevOnly(mk("dsh-whatever")) === false, "不在名单里 ⇒ 不是");
  chk(C.isDevOnly(mk("dsh-whatever", { tier: "dev" })) === true, "★ 索引 tier=dev ⇒ 开发工具（生产端补字段后自动生效）");
  chk(C.isDevOnly(mk("dsh-plugin-uploader", { tier: "normal" })) === false, "★ 索引说 normal 就听索引的");
  chk(C.isDevOnly(mk("dsh-x", { hidden: true })) === true, "索引 hidden=true ⇒ 开发工具");
  chk(C.isDevOnly(mk("dsh-x", { keywords: ["dev"] })) === true, "keywords 里有 dev ⇒ 开发工具");
}

// ═════════════════════════════════════════════════════════════════════════
section("⑦ mergeInstalled —— 清单 × 本机已装（含「本地装的」那一路）");
// ═════════════════════════════════════════════════════════════════════════
{
  const mk = (name, version) => C.normalizeEntry({ ...GOOD, name, version }).entry;
  const groups = C.groupByName([mk("dsh-a", "1.1.0"), mk("dsh-b", "2.0.0"), mk("dsh-c", "3.0.0"), mk("dsh-d", "4.0.0")]);

  const rows = C.mergeInstalled(groups, [
    { name: "dsh-b", version: "2.0.0", source: "hub", target: "x", enabled: true, junctionOk: true, dirExists: true },
    { name: "dsh-c", version: "2.9.0", source: "hub", target: "y", enabled: true, junctionOk: true, dirExists: true },
    { name: "dsh-d", version: "4.0.0", source: "hub", target: "z", enabled: true, junctionOk: true, dirExists: false },
  ]);
  const at = (n) => rows.find((r) => r.name === n);
  chk(at("dsh-a").state === "not-installed", "没装 ⇒ not-installed");
  chk(at("dsh-a").canInstall === true, "没装 ⇒ 可以装");
  chk(at("dsh-b").state === "installed", "同版本 ⇒ installed");
  chk(at("dsh-b").canUpdate === false, "同版本 ⇒ 不给「更新」按钮");
  chk(at("dsh-c").state === "update", "★ 本地 2.9.0 / 线上 3.0.0 ⇒ update");
  chk(at("dsh-c").canUpdate === true && at("dsh-c").local.version === "2.9.0", "update 时带着本地版本");
  chk(at("dsh-d").state === "broken", "★ 落点没了 ⇒ broken（能重装救回来）");
  chk(at("dsh-d").canInstall === true, "broken 可以重装");

  const disabled = C.mergeInstalled(C.groupByName([mk("dsh-e", "1.0.0")]),
    [{ name: "dsh-e", version: "1.0.0", source: "hub", enabled: false, dirExists: true, junctionOk: true }]);
  chk(disabled[0].state === "disabled", "装了但没在 bundles 里 ⇒ disabled");

  // ── ★ 「本地装的」那一路（真机上栽过：B 家装着 11 个，界面报「已装 0」）──
  const loc = C.mergeInstalled(
    C.groupByName([mk("dsh-f", "1.0.0"), mk("dsh-g", "2.0.0"), mk("dsh-h", "1.0.0")]),
    [
      { name: "dsh-f", version: "0.5.0", source: "local-link", target: "D:\\repo\\dsh-f", enabled: true, junctionOk: true, dirExists: true },
      { name: "dsh-g", version: "2.0.0", source: "registry", target: "nm", enabled: true, junctionOk: true, dirExists: true },
      { name: "dsh-h", version: "1.0.0", source: "local-file", target: "C:\\x.tgz", enabled: true, junctionOk: true, dirExists: true },
    ]);
  const lt = (n) => loc.find((r) => r.name === n);
  chk(lt("dsh-f").state === "local", "★ dev 联接装着的 ⇒ state=local（不是 not-installed）");
  chk(lt("dsh-f").canInstall === false, "★★ 本地装着的**不给**普通「安装」按钮（那会覆盖用户的 dev link）");
  chk(lt("dsh-f").canReplace === true, "给的是「改用仓库版」");
  chk(lt("dsh-f").local.version === "0.5.0", "报的是**本地那一份**的版本，不是线上版本");
  chk(lt("dsh-f").localSource === "local-link" && lt("dsh-h").localSource === "local-file"
    && lt("dsh-g").localSource === "registry", "来路分别标成 local-link / local-file / registry",
    JSON.stringify([lt("dsh-f").localSource, lt("dsh-h").localSource, lt("dsh-g").localSource]));
  chk(lt("dsh-g").state === "local", "npm 装的也算「已装」（local）");
  chk(lt("dsh-h").canReplace === true && lt("dsh-h").canInstall === false, "本地文件装的同理");

  chk(C.mergeInstalled(groups, []).every((r) => r.state === "not-installed"), "一个都没装 ⇒ 全是 not-installed");
  chk(C.mergeInstalled([], []).length === 0, "空清单 → 空结果");
}

// ═════════════════════════════════════════════════════════════════════════
section("⑦b npmPageOf —— npm 说明页链接（**算不出就不给，绝不瞎拼 404**）");
// ═════════════════════════════════════════════════════════════════════════
// 用户 2026-09-24 原话：「在我们的集成版插件页面那里加一条 npm 官网的地址，
// 如果别人想看说明的话，可以跳转到 npm 那里去查看。」
//
// ★★ 这一段的核心是**那条实测出来的坑**：GitHub hub 索引里当时还挂着两个**旧名**
//    （dsh-plugin-uploader / dsh-multi-session），而那两个在 npm 上是 **404**
//    （实测 curl registry.npmjs.org 返回 404），新名 dsh-int-* 才是 200。
//    ⇒ 如果照索引名字硬拼，用户点开就是 404 页面，看起来像"我们的包没了"。
{
  const P = C.NPM_PAGE_BASE;
  chk(P === "https://www.npmjs.com/package/", "npm 页面基址是写死的常量");

  // ① 我们的新名（dsh-int-*）⇒ 给链接
  chk(C.npmPageOf({ name: "dsh-int-mobile-remote" }) === P + "dsh-int-mobile-remote",
    "★ dsh-int-* 给 npm 链接（我们自己的命名约定）");
  chk(C.npmPageOf({ name: "dsh-int-plugin-uploader" }) === P + "dsh-int-plugin-uploader",
    "★ dsh-int-plugin-uploader 给链接");

  // ② ★★ 索引里的旧名 ⇒ **不给**（它们在 npm 上不存在，给了就是 404）
  chk(C.npmPageOf({ name: "dsh-plugin-uploader" }) === "",
    "★★ 旧名 dsh-plugin-uploader **不给**链接（npm 上实测 404）");
  chk(C.npmPageOf({ name: "dsh-multi-session" }) === "",
    "★★ 旧名 dsh-multi-session **不给**链接（npm 上实测 404）");
  chk(C.npmPageOf({ name: "dsh-demo" }) === "",
    "别的命名（不是我们的约定）也不给 —— 免得指向别人的同名包");

  // ③ 索引自己声明时优先（生产端最清楚）
  chk(C.npmPageOf({ name: "dsh-demo", raw: { npmUrl: "https://www.npmjs.com/package/whatever" } })
    === "https://www.npmjs.com/package/whatever", "★ 索引自己声明 npmUrl ⇒ 用它（生产端说了算）");
  chk(C.npmPageOf({ name: "dsh-demo", raw: { homepage: "https://www.npmjs.com/package/x" } })
    === "https://www.npmjs.com/package/x", "homepage 也认");
  // ★ 索引是外部数据 ⇒ 它不能把用户带去别的主机
  chk(C.npmPageOf({ name: "dsh-demo", raw: { npmUrl: "https://evil.example.com/x" } }) === "",
    "★★ 索引声明的地址**不是 npm 官网** ⇒ 拒绝（索引被改坏也带不走用户）");
  chk(C.npmPageOf({ name: "dsh-demo", raw: { npmUrl: "javascript:alert(1)" } }) === "",
    "★★ javascript: 一律拒绝");
  chk(C.npmPageOf({ name: "dsh-demo", raw: { npmUrl: "http://www.npmjs.com/package/x" } }) === "",
    "★★ 非 https 拒绝");

  // ④ 下载地址已经是 npm registry ⇒ 包名必然存在，给链接
  chk(C.npmPageOf({
    name: "whatever-name",
    downloadUrl: "https://registry.npmjs.org/whatever-name/-/whatever-name-1.0.0.tgz",
  }) === P + "whatever-name", "★ 下载地址就是 npm registry 的 tarball ⇒ 给链接（包必然存在）");

  // ⑤ 乱七八糟的输入不许炸，也不许拼出东西
  chk(C.npmPageOf(null) === "", "null ⇒ 空串");
  chk(C.npmPageOf({}) === "", "空对象 ⇒ 空串");
  chk(C.npmPageOf({ name: "../../etc/passwd" }) === "", "★ 路径穿越形态的包名 ⇒ 空串");
  chk(C.npmPageOf({ name: "x?y=z#frag" }) === "", "★ 带查询串/锚点的包名 ⇒ 空串");
  chk(C.npmPageOf({ name: "  " }) === "", "纯空白 ⇒ 空串");

  // ⑥ normalizeEntry 要把 npmUrl 带出来（界面读的就是它）
  const ne = C.normalizeEntry({
    name: "dsh-int-demo", version: "1.0.0",
    downloadUrl: "https://github.com/o/r/releases/download/t/a.tgz",
    sha256: "a".repeat(64), bytes: 100,
  });
  chk(!!ne.entry && ne.entry.npmUrl === P + "dsh-int-demo", "★ normalizeEntry 产出的条目带 npmUrl",
    ne.entry ? String(ne.entry.npmUrl) : "entry 是 null");
  const neOld = C.normalizeEntry({
    name: "dsh-demo", version: "1.0.0",
    downloadUrl: "https://github.com/o/r/releases/download/t/a.tgz",
    sha256: "a".repeat(64), bytes: 100,
  });
  chk(!!neOld.entry && neOld.entry.npmUrl === "", "非我们的命名 ⇒ npmUrl 是空串（界面据此不画按钮）");
}

// ═════════════════════════════════════════════════════════════════════════
section("⑧ 拿线上真实索引跑一遍（连不上就 SKIP，不当成通过）");
// ═════════════════════════════════════════════════════════════════════════
(async () => {
  const { cmpVersion } = require("../src/update.js");   // ★ ⑧ 段里要用它做自洽判据
  const url = C.indexUrl();
  chk(url === "https://raw.githubusercontent.com/18477514055/DSH-Plugin-Hub/main/plugin-index.json",
    "索引地址拼对了", url);
  chk(C.indexUrl("o/r", "dev").includes("/o/r/dev/"), "换仓库/分支也能拼");

  // ★ 实测：这一段有时会取不到数（网络抖动，同一台机器前两次还好的）。
  //   重试一次再认输；**仍然失败就标 SKIP，绝不算通过**。
  let raw = null;
  let lastErr = "";
  for (let attempt = 1; attempt <= 2 && !raw; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "dsh-catalog-check" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      raw = await res.json();
    } catch (e) {
      lastErr = (e && e.message) || String(e);
      if (attempt === 1) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!raw) skip("线上索引实测", `连不上（已重试一次）：${lastErr}`);

  if (raw) {
    const idx = C.normalizeIndex(raw);
    console.log(`  （线上 schema=${idx.schema} updatedAt=${idx.updatedAt} 条目=${idx.entries.length} 跳过=${idx.skipped.length}）`);
    chk(idx.knownSchema === true, "线上 schema 是外壳认识的那版", idx.schema);
    chk(idx.entries.length >= 4, "读到 ≥4 条", String(idx.entries.length));
    chk(idx.skipped.length === 0, "★ 线上每一条都能被读懂（没有读不懂的）", JSON.stringify(idx.skipped));
    chk(idx.entries.every((e) => e.sha256.length === 64), "★ 每条都有合法 sha256");
    chk(idx.entries.every((e) => e.compatible), "每条 platform 都适用本外壳");

    const g = C.groupByName(idx.entries);
    const names = g.map((x) => x.name);
    chk(names.includes("dsh-multi-session") && names.includes("dsh-int-archive-manager"),
      "★ 我们刚发的两个插件出现在清单里", JSON.stringify(names));
    const ms = g.find((x) => x.name === "dsh-multi-session");
    chk(ms && ms.latest.version === "0.1.1", "dsh-multi-session 最新版 = 0.1.1", ms ? ms.latest.version : "无");
    chk(ms && ms.latest.downloadUrl.startsWith("https://github.com/"), "下载地址是 GitHub");
    const up = g.find((x) => x.name === "dsh-plugin-uploader");
    // ★ 2026-09-25 修正：这条原断言「上传器必须被认成开发工具」**已经过期** ——
    //   2026-09-23 起上传器就是**普通插件**（兜底名单清空 + commit 814c5cb）。
    //   现在反过来锁：**它必须是普通插件**，否则界面上它会缩进"开发者工具"里、默认不勾。
    chk(up && up.devOnly === false, "★ 上传器是**普通插件**（2026-09-23 起，默认就该勾）");
    // ★★ 别把外面世界的版本号写死在断言里 —— 生产端随时会发新版本。
    //    第一版这里写死 "0.1.2"，结果写这份脚本的**当天**它就变成了 0.1.4（假 FAIL）。
    //    改成**自洽判据**：groupByName 挑出的「最新」，必须等于索引里这个包的最高版本
    //    （用同一把 cmpVersion 自己算一遍，而不是引用一个会过期的事实）。
    if (up) {
      const maxV = up.versions.map((v) => v.version)
        .reduce((m, v) => (cmpVersion(v, m) > 0 ? v : m), "0.0.0");
      chk(up.latest.version === maxV,
        "上传器挑出的最新版 == 索引里它的最高版本（自洽，不写死）",
        `${up.latest.version} vs ${maxV}`);
    } else {
      chk(false, "索引里找不到 dsh-plugin-uploader（生产端把它下架了？）");
    }
    // 清单随生产端变化 ⇒ 只锁"能自洽"的部分，不锁条数与名字集合
    chk(g.every((x) => x.versions.length >= 1 && x.latest === x.versions[0]),
      "★ 每组的最新版都确实是该组的第一条（排序自洽）");
  }

  // ═════════════════════════════════════════════════════════════════════════
section("⑨ npm 源（2026-09-25 加：没梯子时唯一通的那条）");
// ═════════════════════════════════════════════════════════════════════════
{
  // ── ⑨a 白名单：npm registry 必须在，且**不能顺手把第三方镜像也放进来** ──
  chk(C.ALLOWED_HOSTS.includes("registry.npmjs.org"),
    "★ 白名单里有 registry.npmjs.org（没它 = 没梯子的用户装不了插件）");
  chk(!C.ALLOWED_HOSTS.some((h) => /npmmirror|taobao|cnpm/i.test(h)),
    "★ 白名单里**没有**第三方镜像（淘宝镜像更快，但那是别人的信任决定，不许顺手加）",
    C.ALLOWED_HOSTS.join(","));
  chk(C.NPM_REGISTRY === "https://registry.npmjs.org", "npm registry 常量是官方地址且 https");

  // ── ⑨b 地址拼装：用 /latest 而不是整包元数据 ──
  chk(C.npmLatestUrl("dsh-int-multi-session") === "https://registry.npmjs.org/dsh-int-multi-session/latest",
    "npmLatestUrl 拼对了", C.npmLatestUrl("dsh-int-multi-session"));
  chk(C.npmLatestUrl("@scope/pkg").includes("%2F"),
    "★ 带 scope 的包名要转义 /（否则拼出的是另一个地址）", C.npmLatestUrl("@scope/pkg"));

  // ── ⑨c normalizeNpmLatest：把 npm 元数据变成内部条目 ──
  const fakeNpm = {
    name: "dsh-int-demo", version: "1.2.3",
    description: "演示用",
    dist: {
      tarball: "https://registry.npmjs.org/dsh-int-demo/-/dsh-int-demo-1.2.3.tgz",
      integrity: "sha512-" + "A".repeat(86) + "==",
    },
  };
  const nn = C.normalizeNpmLatest("dsh-int-demo", fakeNpm);
  chk(!!nn.entry, "★ 合法 npm 元数据能变成条目");
  if (nn.entry) {
    chk(nn.entry.version === "1.2.3" && nn.entry.name === "dsh-int-demo", "name/version 带对了");
    chk(nn.entry.integrity.startsWith("sha512-"), "★ integrity（sha512）带过来了");
    chk(nn.entry.sha256 === "", "★ sha256 刻意留空（npm 不给 sha256，不许瞎填）");
    chk(nn.entry.source === "npm", "★ 标了 source=npm（验收要能分清来源）");
    chk(nn.entry.npmUrl === C.NPM_PAGE_BASE + "dsh-int-demo", "npmUrl 给了（界面能画那个按钮）");
    chk(C.isAllowedDownloadUrl(nn.entry.downloadUrl), "★ npm 的 tarball 地址能过白名单");
  }
  // 坏数据：不许猜
  const nnBad = C.normalizeNpmLatest("x", { version: "1.0.0", dist: { tarball: "https://evil.example.com/a.tgz" } });
  chk(nnBad.entry === null, "★ 非白名单主机的 tarball ⇒ 整条拒绝（不猜、不放行）");
  const nnNoVer = C.normalizeNpmLatest("x", { dist: { tarball: "https://registry.npmjs.org/x/-/x-1.tgz" } });
  chk(nnNoVer.entry === null, "缺 version ⇒ 拒绝");

  // ── ⑨d mergeSources：同名同版本时 GitHub 优先（它带 sha256，校验更强）──
  const hubE = { name: "a", version: "1.0.0", sha256: "b".repeat(64), source: "hub" };
  const npmE = { name: "a", version: "1.0.0", sha256: "", integrity: "sha512-x", source: "npm" };
  const merged = C.mergeSources([hubE], [npmE]);
  chk(merged.length === 1, "★ 同名同版本只留一条（去重）", String(merged.length));
  chk(merged[0].sha256 === "b".repeat(64), "★ 去重时 GitHub 那条赢（它带 sha256）");
  const merged2 = C.mergeSources([hubE], [{ ...npmE, version: "2.0.0" }]);
  chk(merged2.length === 2, "不同版本两条都留（让 groupByName 去排）", String(merged2.length));

  // ── ⑨e 种子清单：全新机器 + 没梯子 + 没缓存时，靠它兜底 ──
  chk(Array.isArray(C.SEED_PACKAGES) && C.SEED_PACKAGES.length >= 3,
    "★ 有包名种子清单（npm 搜索接口不做名称匹配，只能靠写死的种子）",
    String(C.SEED_PACKAGES.length));
  chk(C.SEED_PACKAGES.every((n) => n.startsWith("dsh-int-")),
    "★ 种子里全是我们自己的 dsh-int-* 命名");

  // ── ⑨f 真连一次 npm（连不上 SKIP，不当通过）──
  //   判据是"**真拿到** tarball 地址与 integrity"，不是"函数没抛错"。
  const https = require("node:https");
  const getJson = (u, ms = 12000) => new Promise((resolve, reject) => {
    const req = https.get(u, { headers: { "User-Agent": "dsh-catalog-check", Accept: "application/json" }, timeout: ms }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      let s = ""; res.setEncoding("utf8");
      res.on("data", (d) => { s += d; });
      res.on("end", () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    });
    req.on("timeout", () => req.destroy(new Error("超时")));
    req.on("error", reject);
  });

  try {
    const meta = await getJson(C.npmLatestUrl("dsh-int-multi-session"));
    chk(!!meta.version, "★ 真连 npm：拿到了 version", String(meta.version));
    chk(!!(meta.dist && meta.dist.tarball), "★ 真连 npm：拿到了 dist.tarball");
    chk(!!(meta.dist && /^sha512-/.test(String(meta.dist.integrity))),
      "★ 真连 npm：拿到了 sha512 integrity（没它就只能降级成不校验）",
      meta.dist ? String(meta.dist.integrity).slice(0, 20) : "无 dist");
    const real = C.normalizeNpmLatest("dsh-int-multi-session", meta);
    chk(!!real.entry && C.isAllowedDownloadUrl(real.entry.downloadUrl),
      "★ 真数据过一遍 normalizeNpmLatest + 白名单，能通");
  } catch (e) {
    skip("真连一次 npm registry", (e && e.message) || String(e));
  }
}

// ── 收尾 ──
  console.log(`\n${"=".repeat(64)}`);
  console.log(`plugin-catalog-check：${OK} OK / ${FAILS.length} FAIL / ${SKIPS.length} SKIP`);
  if (FAILS.length) { console.log("失败项："); for (const f of FAILS) console.log(`  · ${f}`); }
  if (SKIPS.length) { console.log("跳过项（**不算通过**）："); for (const s of SKIPS) console.log(`  · ${s}`); }
  process.exit(FAILS.length ? 1 : 0);
})();
