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
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★ 2026-09-25 修：只查 `/latest` 会**漏掉整个 0.1.7 系列**
 * ══════════════════════════════════════════════════════════════════
 * 用户报：「我现在只检测到了一个 0.1.5 的一个小版本，但是现在不是已经跑到 0.1.7 了吗？」
 *
 * 直连 `registry.npmjs.org` 实测（不经外壳、不经代理工具）：
 *
 *     dist-tags = { latest: "0.1.5-rc.3", next: "0.1.7-rc.2", alpha: "0.1.7-alpha.2" }
 *     最新发布的一个 = 0.1.7-rc.2（2026-09-24T14:18Z）
 *     0.1.5-rc.3    = 2026-09-22T05:55Z
 *
 * ⇒ 检查本身**没撒谎**（`/latest` 确实就是 0.1.5-rc.3），错的是**只问了那一个标签**：
 *   上游把 `latest` 停在 0.1.5 之后，继续把 0.1.7 系列发在 `next` / `alpha` 上。
 *   于是界面把「正式渠道推荐的那个」说成了「官方最新」，而真正的更新看不见。
 *
 * ⇒ 现在改成**读整份元数据、把全部 dist-tags 都列出来**，并且：
 *   · **默认渠道仍然是 `latest`** —— 不替用户把预览渠道当默认（那等于劝人踩
 *     「内核换代把注入 UI 弄哑」的坑，见 project AGENTS §5：没真跑证据不下兼容性结论）；
 *   · 每个渠道**各自**算 `hasUpdate`，界面上分别标出来；
 *   · 说明白一件事：`npm i -g @deepseek-ai/dsh` 装的是 `latest`，**不是**最新那个版本 ——
 *     所以要装别的渠道，只能靠**本地已下载的那个 .tgz**（版本钉死在文件名上）。
 *
 * 请求的是 npm 的**精简元数据**（`application/vnd.npm.install-v1+json`，实测 ~145 KB，
 * 含全部 dist-tags 与每个版本的 `dist`），并带缓存破坏参数 —— 元数据带
 * `cache-control: max-age=300`，而用户点这个按钮就是想**现在**知道真相。
 */

const { app, net, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const K = require("./kernel");

/** 官方渠道：npm registry 上这个包就是内核本体。 */
const PKG = "@deepseek-ai/dsh";
/** 整份元数据（**含全部 dist-tags**）。★ 不要退回 `…/latest` —— 那正是漏掉 0.1.7 的原因。 */
const REGISTRY = `https://registry.npmjs.org/${PKG}`;
/** npm 的"精简元数据"：体积小得多，但 `dist-tags` 与各版本 `dist` 一个不少。 */
const META_ACCEPT = "application/vnd.npm.install-v1+json, application/json";
/** 给人看的官方页面（不是下载地址，只是让用户能自己去看版本历史）。 */
const OFFICIAL_PAGE = `https://www.npmjs.com/package/${PKG}`;
const UA = "dsh-integrated-desktop-kernel-updater";

/**
 * 已知的 npm dist-tag 各自是什么意思（**只解释语义，不写死版本号**）。
 *
 * 版本号永远从 registry 现读；这里只是把 `next` 这种标签翻译成人话。
 * 没登记过的标签照原样显示 —— 上游随时可能加标签，别让界面因为不认识就把它藏起来
 * （那又会变成同一个 bug：**看得见的比实际存在的少**）。
 */
const CHANNELS = {
  latest: { label: "正式渠道", note: "npm i -g @deepseek-ai/dsh 默认装的就是它" },
  next: { label: "预览渠道", note: "官方把更新的版本先发在这里，还没提升成正式" },
  alpha: { label: "实验渠道", note: "更早的试验版，官方不保证完整" },
};

/** 把一个 dist-tag 翻译成界面能直接用的 {label, note}。 */
function channelInfo(tag) {
  const k = CHANNELS[tag];
  return { label: (k && k.label) || tag, note: (k && k.note) || "" };
}

// ── ★★ 兼容性：新版内核**能不能在外壳上跑**（2026-09-25 两轮真跑查明的）────────
//
// 这一节回答的问题比"哪个版本更新"更要紧，而且**答案跟渠道无关**：
// `0.1.5` 世代的预览版能跑，`0.1.7` 世代在外壳原来那版 Electron 上**连启动都过不去**。
//
// ── 第一轮：外壳当时带 Electron **37.10.3** ──────────────────────────
//
//   | 内核版本      | 渠道      | 结果 |
//   |---------------|-----------|------|
//   | 0.1.5-rc.2    | （在用）  | ✅ 就绪 |
//   | 0.1.5-rc.3    | `latest`  | ✅ 就绪 |
//   | 0.1.7-rc.2    | `next`    | ❌ `Unsupported/no-context` |
//   | 0.1.7-alpha.2 | `alpha`   | ❌ `Unsupported/no-context` |
//   | 0.1.7-rc.2    | 系统 node 24（对照） | ✅ ⇒ 卡的是 Electron，不是内核本身 |
//
// ── 第二轮：把外壳升到 Electron **44.0.0**（同一天）──────────────────
//
//   四个版本**全部 ✅ 就绪**（含 0.1.7-rc.2 / 0.1.7-alpha.2）⇒ 这一版外壳顺带解开了
//   0.1.6+ 内核。为此 `package.json` 把 electron 钉成**精确的 `44.0.0`**（不加 `^`）。
//
//   ⚠️⚠️ **为什么必须是精确版本**：那个校验比的是 **V8 运行时的精确指纹**，
//   不是版本区间。实测 **Electron 44.4.5 照样起不来**：
//     unsupported Electron runtime fingerprint: Node 24.21.0, V8 15.2.124.28-electron.0
//     (supported Electron versions: 43.0.0, 44.0.0, 45.0.0-alpha.6)
//   ⇒ 「升到最新」在这里**是错的**。同理 37.10.3 也不行。
//
//   机制（逐文件数出来的，不是猜的）：`0.1.6` 起 `dsh-app-boot` 新增
//   `installRuntimeInterception`（0.1.5-rc.3 里 **0 处**、0.1.7-rc.2 里 **3 处**），
//   它要 hook V8 内部去 `require` 内置模块，而依赖的
//   `node-addon-native-custom-loader@0.1.6` 只认上面那三个**精确**指纹
//   （两个内核带的是**同一个** 0.1.6 版加载器 ⇒ 差别在调用方）。
//   ★ 该加载器在 npm 上的最新版**就是 0.1.6**（2026-09-14 发布）⇒ 没有"换个新加载器就好了"这条路。

/** 内核世代的**分水岭**：这个版本起新增了运行时拦截。 */
const KERNEL_INTERCEPTION_FROM = "0.1.6";
/** 加载器那句错误原文里自报的"支持的 Electron 版本"（照抄，不改写；**是精确指纹，不是区间**）。 */
const LOADER_SUPPORTED_ELECTRON = ["43.0.0", "44.0.0", "45.0.0-alpha.6"];

/** 外壳这一版用的 Electron。★ 取 `process.versions.electron` —— 只有真在 Electron 里才准。 */
function shellElectron() {
  return String((process.versions && process.versions.electron) || "");
}

/**
 * **真跑验过**的兼容性记录（**当前这一版 Electron 上的**）。
 *
 * ★ 这是"证据"，不是"规则"：没验过的版本**不许**写成"实测"
 *   （本项目记过两次"拿代理证据当通过凭据"的教训）。
 * ★ 换了 Electron 之后这些记录**全部作废** —— `scripts/kernel-update-check.js`
 *   里有一条断言盯着这件事（记录与本机 Electron 不符就 FAIL，逼你重新真跑）。
 *   上一轮（Electron 37.10.3）的结果记在文件顶部那段注释里。
 */
const COMPAT_EVIDENCE = [
  { version: "0.1.5-rc.2", electron: "44.0.0", ok: true, note: "隔离真跑：拿到了本机地址" },
  { version: "0.1.5-rc.3", electron: "44.0.0", ok: true, note: "隔离真跑：拿到了本机地址" },
  { version: "0.1.7-rc.2", electron: "44.0.0", ok: true,
    note: "隔离真跑：拿到了本机地址（同一版内核在 Electron 37.10.3 上起不来）" },
  { version: "0.1.7-alpha.2", electron: "44.0.0", ok: true, note: "隔离真跑：拿到了本机地址" },
];

/**
 * **已知跑不了**的 Electron（也全是真跑结论，不是推断）。
 *
 * ★ 为什么单独列出来：那个校验比的是 **V8 精确指纹**，所以"更新的 Electron"**不一定**
 *   在支持列表里。没有这一张表的话，`compatOf` 只能对不在列表里的 Electron 说"不知道" ——
 *   而这两个我们是**真跑过、明确知道起不来**的，说"不知道"是浪费已知证据。
 */
const COMPAT_KNOWN_BAD_ELECTRON = [
  { electron: "37.10.3", note: "0.1.7-rc.2 与 0.1.7-alpha.2 实测都是 Unsupported/no-context" },
  { electron: "44.4.5",
    note: "实测同样 Unsupported/no-context（Node 24.21.0 / V8 15.2.124.28）—— "
      + "「升到最新」在这个校验面前是错的，必须精确匹配加载器那张表" },
];

/**
 * 判"外壳这一版的 Electron 能不能跑这一版内核"。
 *
 * 五档，**证据等级写在脸上**（不许把"同世代"或"预计"说成"实测"）：
 *   · `verified-ok` / `verified-bad` —— 这一版**真跑过**（当前 Electron 上）；
 *   · `known-bad-electron`          —— 这一版没跑过，但外壳这个 Electron **真跑过跑不了**；
 *   · `gen-ok`                      —— Electron 在加载器支持列表里 ⇒ 这一代内核**预计**能跑；
 *   · `unknown`                     —— 都不沾边，**说不出能不能跑**（`usable: null`）。
 *
 * @param {string} version 内核版本
 * @param {string} [electron] 外壳的 Electron 版本；不给就用 `shellElectron()`
 * @returns {{level:string, usable:boolean|null, label:string, note:string}}
 */
function compatOf(version, electron) {
  const ev = String(electron || shellElectron() || "").trim();
  const need = LOADER_SUPPORTED_ELECTRON.join(" / ");
  const exact = COMPAT_EVIDENCE.find((e) => e.version === version && e.electron === ev);
  if (exact) {
    return exact.ok
      ? { level: "verified-ok", usable: true, label: "实测能跑",
        note: `真跑验过（Electron ${ev}）：${exact.note}` }
      : { level: "verified-bad", usable: false, label: "实测起不来",
        note: `真跑验过（Electron ${ev}）：${exact.note}。它要 Electron ${need}。` };
  }
  if (cmpVersion(version, KERNEL_INTERCEPTION_FROM) >= 0) {
    const badEv = COMPAT_KNOWN_BAD_ELECTRON.find((e) => e.electron === ev);
    if (badEv) {
      return { level: "known-bad-electron", usable: false, label: "这个 Electron 上起不来",
        note: `${KERNEL_INTERCEPTION_FROM} 起内核新增了运行时拦截，要 Electron ${need}`
          + `（**精确指纹**，不是版本区间）。而外壳这个 Electron ${ev}：${badEv.note}。` };
    }
    if (LOADER_SUPPORTED_ELECTRON.includes(ev)) {
      return { level: "gen-ok", usable: true, label: "预计能跑",
        note: `外壳的 Electron ${ev} 在加载器支持列表（${need}）里 ⇒ 这一代内核应该能跑；`
          + "但**这一版本身没逐版真跑验过**。" };
    }
    return { level: "unknown", usable: null, label: "未验（Electron 不在支持列表）",
      note: `${KERNEL_INTERCEPTION_FROM} 起内核要 Electron ${need} 之一（**精确指纹**），`
        + `而外壳带的是 ${ev || "?"} —— 不在列表里，所以**说不出能不能跑**。`
        + `真要装，先用 kernel-compat-check.js --version=${version} 真跑一次。` };
  }
  return { level: "gen-ok", usable: true, label: "同世代能跑",
    note: `0.1.5 世代的 0.1.5-rc.3 真跑验过能跑（Electron ${ev || "?"}）；`
      + "**这一版本身没逐版验过**。" };
}

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
 * 用 `kernel.js` 的发现链（显式指定 → 应用自带 → **外壳安装的** → 全局 npm），
 * 所以报出来的就是外壳**真会去启动**的那一个 —— 不是另猜一个。
 *
 * ★ 2026-09-25：把 userDataDir 传下去，否则"外壳替用户装的那一份"会被漏掉，
 *   界面就会在明明装好的情况下报"没找到内核"。
 */
function installed() {
  const k = K.discoverKernel({ userDataDir: app.getPath("userData") });
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
 * 查官方渠道上内核的**全部发行渠道**（npm 的 dist-tags）。**只读**，不写任何东西。
 *
 * ★ 返回里的 `channels` 是**完整**的一份；`latest`/`hasUpdate`/`dist` 三个旧字段
 *   保留下来，含义收窄成「**默认渠道**（`latest` 标签）的那一个」——
 *   调用方的语义没变，但界面必须把 `channels` 也画出来，否则又会退回到
 *   "看得见 0.1.5、看不见 0.1.7" 那个 bug。
 *
 * @returns {Promise<{ok:boolean, reason?:string, installed:object, page:string,
 *   channel?:string, channels?:Array<{tag:string,label:string,note:string,version:string,
 *     dist:object, hasUpdate:boolean|null}>, latest?:string, hasUpdate?:boolean|null,
 *   dist?:object, newest?:string, tags?:object, modifiedAt?:string, checkedAt?:string}>}
 */
/**
 * 从一份 npm 元数据里算出**全部渠道**。**纯函数**：不联网、不读磁盘、不看时钟。
 *
 * ★ 为什么单独拆出来：用户 2026-09-25 报的那个 bug（"只看得见 0.1.5、看不见 0.1.7"）
 *   **不该靠"此刻 registry 上恰好有什么"去验** —— 上游哪天把 `latest` 提升到 0.1.7，
 *   真跑那条断言就自动变成"验不到"，等于没有护栏。
 *   拆成纯函数之后，验收脚本可以喂一份**与那天完全相同**的元数据
 *   （`latest=0.1.5-rc.3` / `next=0.1.7-rc.2`），离线、确定性地断言 0.1.7 会被列出来。
 *
 * 规则（每一条都能被断言）：
 *   · 每个 dist-tag 一条；标签指着元数据里没有的版本、或没给可校验下载地址的 ⇒
 *     **跳过并写进 `skipped`**（不编一条假记录，也不假装它不存在）；
 *   · 默认渠道 = `latest`；万一上游没给这个标签，退回**版本最高**的那个；
 *   · 默认渠道永远排第一条（界面上的位置不跳）；
 *   · `hasUpdate` / `newerThanDefault` 全部用**同一把尺子** `cmpVersion` 算。
 *
 * @param {object} meta npm 元数据（精简版或全量版都吃）
 * @param {{found?:boolean, version?:string}} cur 本机内核
 * @param {{electron?:string}} [opts] 外壳的 Electron 版本（判兼容性用；不给就用 `shellElectron()`）
 * @returns {{ok:boolean, reason?:string, channels?:Array, channel?:string,
 *            newest?:string, tags?:object, skipped?:string[]}}
 */
function channelsFromMeta(meta, cur, opts) {
  const electron = String((opts && opts.electron) || shellElectron() || "").trim();
  const tags = (meta && (meta["dist-tags"] || meta.distTags)) || null;
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) {
    return { ok: false, reason: "官方源的返回里没有 dist-tags" };
  }
  const versions = (meta && meta.versions) || {};
  const found = !!(cur && cur.found);
  const curVer = (cur && cur.version) || "";

  const channels = [];
  const skipped = [];
  for (const tag of Object.keys(tags)) {
    const version = String(tags[tag] || "").trim();
    if (!version) { skipped.push(`${tag}=空`); continue; }
    const vm = versions[version];
    if (!vm) { skipped.push(`${tag}→${version}（元数据里没有这个版本）`); continue; }
    const dist = readDist(vm);
    if (!dist) { skipped.push(`${tag}→${version}（没有可校验的下载地址）`); continue; }
    channels.push({
      ...channelInfo(tag),
      tag,
      version,
      dist,
      // 本机内核找不到时**不能**断言"有更新" —— 置 null 说清楚，别编
      hasUpdate: found ? cmpVersion(version, curVer) > 0 : null,
      // ★ 比"有没有更新"更要紧：这一版在外壳这一版的 Electron 上**跑不跑得起来**
      compat: compatOf(version, electron),
    });
  }
  if (!channels.length) {
    return {
      ok: false,
      reason: `官方源的 dist-tags 里没有一个可下载的版本`
        + `${skipped.length ? `（${skipped.join("；")}）` : ""}`,
      skipped, tags: { ...tags },
    };
  }

  const byVerDesc = (a, b) => cmpVersion(b.version, a.version);
  const def = channels.find((c) => c.tag === "latest") || channels.slice().sort(byVerDesc)[0];
  const newest = channels.slice().sort(byVerDesc)[0];
  // 排序：默认渠道永远第一条（界面上不跳），其余按版本从新到旧。
  channels.sort((a, b) => (a === def ? -1 : b === def ? 1 : byVerDesc(a, b)));
  // ★ 这两条由**主进程**算好给界面用 —— 版本比较的尺子只有一把（cmpVersion），
  //   渲染进程自己再写一套"谁更新"迟早会与这把尺子分叉。
  for (const c of channels) {
    c.isDefault = c === def;
    c.newerThanDefault = c !== def && cmpVersion(c.version, def.version) > 0;
  }
  return { ok: true, channels, channel: def.tag, newest: newest.version, tags: { ...tags }, skipped };
}

async function check() {
  const cur = installed();
  const withCur = (o) => ({ ...o, installed: cur, page: OFFICIAL_PAGE });

  let res;
  try {
    // ★ 缓存破坏参数 + cache:"no-store"：元数据带 `cache-control: max-age=300`，
    //   而用户点这个按钮就是想**现在**知道真相。
    //   （本项目在 GitHub 的 contents API 上已经吃过一次"读到缓存还当成真的"的亏。）
    res = await net.fetch(`${REGISTRY}?t=${Date.now()}`, {
      headers: { "User-Agent": UA, Accept: META_ACCEPT },
      cache: "no-store",
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

  const parsed = channelsFromMeta(meta, cur, { electron: shellElectron() });
  if (!parsed.ok) return withCur({ ok: false, reason: parsed.reason });

  const def = parsed.channels.find((c) => c.isDefault) || parsed.channels[0];
  return withCur({
    ok: true,
    channel: parsed.channel,
    channels: parsed.channels,
    // 这三个旧字段保留下来，含义收窄成「**默认渠道**（latest 标签）的那一个」
    latest: def.version,
    hasUpdate: def.hasUpdate,
    dist: def.dist,
    newest: parsed.newest,
    tags: parsed.tags,
    skipped: parsed.skipped,
    modifiedAt: String((meta && meta.modified) || ""),
    checkedAt: new Date().toISOString(),
    // ★ 界面要告诉用户"外壳带的是哪个 Electron" —— 兼容性就是卡在它上面
    shellElectron: shellElectron(),
    kernelInterceptionFrom: KERNEL_INTERCEPTION_FROM,
    loaderSupportedElectron: LOADER_SUPPORTED_ELECTRON.slice(),
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
  cmpVersion, verifyDigest, tarballName, installed, downloadDir, channelInfo,
  channelsFromMeta, compatOf, shellElectron,
  PKG, REGISTRY, OFFICIAL_PAGE, META_ACCEPT, CHANNELS,
  KERNEL_INTERCEPTION_FROM, LOADER_SUPPORTED_ELECTRON, COMPAT_EVIDENCE,
  COMPAT_KNOWN_BAD_ELECTRON,
};
