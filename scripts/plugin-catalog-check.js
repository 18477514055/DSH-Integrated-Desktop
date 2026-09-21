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

  const dev = C.groupByName([mk("dsh-normal", "1.0.0"), mk("dsh-plugin-uploader", "0.1.2")]);
  chk(dev[dev.length - 1].name === "dsh-plugin-uploader", "★ 开发工具排到最后（普通插件在前）");
  chk(dev[dev.length - 1].devOnly === true, "并标了 devOnly");
  chk(dev[0].devOnly === false, "普通插件 devOnly=false");

  chk(C.groupByName([]).length === 0, "空输入 → 空输出");
}

// ═════════════════════════════════════════════════════════════════════════
section("⑥ isDevOnly —— 优先读索引字段，读不到才退回落名单");
// ═════════════════════════════════════════════════════════════════════════
{
  const mk = (name, extra = {}) => C.normalizeEntry({ ...GOOD, name, ...extra }).entry;
  chk(C.isDevOnly(mk("dsh-plugin-uploader")) === true, "落名单里的名字 ⇒ 开发工具");
  chk(C.isDevOnly(mk("dsh-whatever")) === false, "不在名单里 ⇒ 不是");
  chk(C.isDevOnly(mk("dsh-whatever", { tier: "dev" })) === true, "★ 索引 tier=dev ⇒ 开发工具（生产端补字段后自动生效）");
  chk(C.isDevOnly(mk("dsh-plugin-uploader", { tier: "normal" })) === false, "★ 索引说 normal 就听索引的（覆盖落名单）");
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
    chk(names.includes("dsh-multi-session") && names.includes("dsh-archive-manager"),
      "★ 我们刚发的两个插件出现在清单里", JSON.stringify(names));
    const ms = g.find((x) => x.name === "dsh-multi-session");
    chk(ms && ms.latest.version === "0.1.1", "dsh-multi-session 最新版 = 0.1.1", ms ? ms.latest.version : "无");
    chk(ms && ms.latest.downloadUrl.startsWith("https://github.com/"), "下载地址是 GitHub");
    const up = g.find((x) => x.name === "dsh-plugin-uploader");
    chk(up && up.devOnly === true, "★ 上传器被认成开发工具（默认不勾）");
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

  // ── 收尾 ──
  console.log(`\n${"=".repeat(64)}`);
  console.log(`plugin-catalog-check：${OK} OK / ${FAILS.length} FAIL / ${SKIPS.length} SKIP`);
  if (FAILS.length) { console.log("失败项："); for (const f of FAILS) console.log(`  · ${f}`); }
  if (SKIPS.length) { console.log("跳过项（**不算通过**）："); for (const s of SKIPS) console.log(`  · ${s}`); }
  process.exit(FAILS.length ? 1 : 0);
})();
