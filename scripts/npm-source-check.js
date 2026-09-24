"use strict";

/**
 * npm-source-check.js —— 证明「npm 这条路能顶住 GitHub 挂掉」
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这个验收（不是"顺手补个测试"）
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-09-25 实测（代理关闭、直连）：
 *     registry.npmjs.org        → 200  ✅
 *     raw.githubusercontent.com → 000  ❌  ← 插件**清单**在这儿
 *     github.com                → 000  ❌  ← 插件**下载**在这儿
 * ⇒ 一个**没有梯子**的人打开「集成版插件」页，清单读不到、插件也下不来。
 *   这正是用户说的「npm 是最官方、最正规的途径，也是不用梯子也能轻松命令行下载的途径」。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★ 怎么制造「GitHub 挂了」—— 我第一版用网络招数，**失败了，记在这里**
 * ═══════════════════════════════════════════════════════════════════════════
 *   第一版用 `--host-resolver-rules=MAP raw.githubusercontent.com 127.0.0.1:1`，
 *   结果 GitHub **照样返回 200**。原因：本机走 Clash（TUN + fake-ip），
 *   **域名是在代理那边解析的**，Chromium 的解析规则根本轮不到 ——
 *   本项目 AGENTS.md §8 早就记过这条（"`--host-resolver-rules` 那招**也无效**"）。
 *   ⇒ 我差点拿一个"前置条件不成立"的跑当证据。**先证明尺子对**，这次又栽在同一个地方。
 *
 *   **改用的确定性办法**：`fetchIndex()` 本来就接受两个开关（它们不是为测试加的，
 *   是正常参数），用它们精确摆出三层：
 *     · `repo`  指向一个不存在的仓库 ⇒ GitHub 那条**必然 404**（走 fail 分支）
 *     · `npm:false` ⇒ 关掉 npm 源
 *   于是三种场景都能**确定性地**摆出来，不依赖网络怎么变。
 *
 * 用法：
 *   node scripts/run-electron.js scripts/npm-source-check.js
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const { app } = require("electron");

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

// ── 用**临时 userData**，免得污染用户真实的插件清单缓存 ────────────────
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-npm-src-"));
app.setPath("userData", TMP_HOME);

/** 一个**必然 404** 的仓库 —— 用来确定性地让 GitHub 那条失败。 */
const DEAD_REPO = "nonexistent-owner-xyz/nonexistent-repo-xyz";

app.whenReady().then(async () => {
  const C = require("../src/plugin-catalog.js");
  const PI = require("../src/plugin-install.js");

  console.log("npm-source-check（真跑，走 Chromium 网络栈）");
  console.log(`临时 userData: ${TMP_HOME}`);

  // ═════════════════════════════════════════════════════════════════════
  section("① 先证明「尺子」：那个死仓库真的取不到索引");
  // ═════════════════════════════════════════════════════════════════════
  let deadRepoFails = false;
  let deadWhy = "";
  try {
    const r = await require("electron").net.fetch(C.indexUrl(DEAD_REPO, "main"), {
      headers: { "User-Agent": "dsh-check" },
      signal: AbortSignal.timeout(15000),
    });
    deadWhy = `HTTP ${r.status}`;
    deadRepoFails = !r.ok;      // 404 也算"取不到"
  } catch (e) {
    deadRepoFails = true;
    deadWhy = (e && e.message) || String(e);
  }
  chk(deadRepoFails, "★ 前置条件成立：死仓库取不到索引（否则后面的结论无意义）", deadWhy);

  // ═════════════════════════════════════════════════════════════════════
  section("② 场景 A：GitHub 失败 + npm 通 ⇒ 清单仍然可用（**这是没梯子用户的正常路径**）");
  // ═════════════════════════════════════════════════════════════════════
  const A = await C.fetchIndex({ repo: DEAD_REPO, branch: "main", force: true });
  console.log(`  ok=${A.ok} source=${A.source} stale=${A.stale} 条目=${A.index ? A.index.entries.length : 0} counts=${JSON.stringify(A.counts || {})}`);

  chk(A.ok === true, "★ 仍然 ok=true", `ok=${A.ok}`);
  chk(A.source === "npm", "★ 来源如实标成 npm（用户能看出这次没走 GitHub）", A.source);
  chk(A.stale === false, "★ 这不是「过期缓存」—— 是刚从 npm 取的新数据", `stale=${A.stale}`);
  chk(!!A.error, "GitHub 的失败原因**没有吞掉**（error 里有话）", A.error ? "有" : "空");
  chk(A.index && A.index.entries.length >= 3, "★ 清单里有 ≥3 条（种子包都查到了）",
    A.index ? String(A.index.entries.length) : "无 index");
  chk(A.counts && A.counts.hub === 0, "★ counts.hub=0（如实报告：GitHub 那条没贡献）",
    JSON.stringify(A.counts || {}));

  // ═════════════════════════════════════════════════════════════════════
  section("③ 场景 A 的每一条都必须「真的能用」");
  // ═════════════════════════════════════════════════════════════════════
  const E = A.index ? A.index.entries : [];
  chk(E.length > 0, "有条目可验");
  chk(E.every((e) => e.source === "npm"), "★ 每条都标了 source=npm");
  chk(E.every((e) => C.isAllowedDownloadUrl(e.downloadUrl)),
    "★ 每条的下载地址都过白名单（不会去下任意主机）");
  chk(E.every((e) => /^sha512-[A-Za-z0-9+/=]+$/.test(e.integrity)),
    "★ 每条都带 sha512 integrity（**没它就只能降级成不校验**）");
  chk(E.every((e) => e.sha256 === ""), "★ 每条 sha256 都是空串（npm 不给 sha256，**不许瞎填**）");
  chk(E.every((e) => e.npmUrl.startsWith("https://www.npmjs.com/package/")),
    "★ 每条都有 npm 说明页地址（界面能画那个按钮）");
  chk(E.every((e) => /^\d+\.\d+\.\d+/.test(e.version)), "每条的 version 形状正常");
  chk(E.every((e) => e.repo === "npm"), "每条的 repo 标成 npm（界面显示来源用）");

  const { cmpVersion } = require("../src/update.js");
  const G = A.groups || [];
  chk(G.length >= 3, "★ 分组出来了（界面画的是分组，不是裸条目）", String(G.length));
  chk(G.every((g) => g.versions.length >= 1 && g.latest === g.versions[0]),
    "★ 每组的最新版就是第一条（排序自洽，复用 update.js 的 cmpVersion）");

  // ═════════════════════════════════════════════════════════════════════
  section("④ 场景 B：两条路都通 ⇒ **GitHub 说了算，npm 只补缺口**");
  // ═════════════════════════════════════════════════════════════════════
  const B = await C.fetchIndex({ force: true });
  console.log(`  ok=${B.ok} source=${B.source} 条目=${B.index ? B.index.entries.length : 0} counts=${JSON.stringify(B.counts || {})}`);
  if (!B.ok || (B.counts && B.counts.hub === 0)) {
    skip("场景 B（两条路都通）", "这次 GitHub 没取到（网络原因），无法验 —— **不算通过**");
  } else {
    chk(B.ok === true, "两条路都通 ⇒ ok=true");
    chk(B.source === "network", "来源标成 network", B.source);
    // ★★ 2026-09-25 定稿的设计：**hub 能取到时以它为准**，npm 只查"hub 里没有的种子包"。
    //
    //   为什么不做"永远两边都查再合并"（第一版就是那样，真跑验收当场抓到回归）：
    //     npm 上是**新包名**、hub 索引里还挂着**旧包名** ⇒ 合并后同一个插件出现**两张卡**
    //     ⇒ `mergeInstalled` 按组名匹配，"已装"标签落到另一张上
    //     ⇒ 界面表现成"装完了还是没装"。
    //   所以现在：**hub 通 ⇒ npm 贡献 0 条是正常的**（种子包 hub 里都有）。
    chk(B.counts.npm === 0,
      "★ hub 通时 npm 贡献 0 条（**这是刻意的**：避免新旧包名同现造成重复卡片）",
      JSON.stringify(B.counts));
    chk(B.index.entries.every((e) => e.source === "hub"),
      "★ 合并结果里全是 hub 来源（hub 通时它说了算）");
    chk(B.index.entries.length === B.counts.hub,
      "★ 条目数 == hub 单独的数量（npm 那条没往里塞东西）",
      `${B.index.entries.length} vs ${B.counts.hub}`);
    // 去重：同 (name,version) 只应出现一次
    const keys = B.index.entries.map((e) => `${e.name}@${e.version}`);
    chk(new Set(keys).size === keys.length, "★ (name,version) 无重复",
      `${keys.length} 条 / ${new Set(keys).size} 个唯一键`);
    // ★ 更要紧的一条：**同名只应有一组**（两组同名卡片就是那个回归的形态）
    const gnames = (B.groups || []).map((g) => g.name);
    chk(new Set(gnames).size === gnames.length, "★★ 分组名无重复（同名两张卡就是那个回归的形态）",
      `${gnames.length} 组 / ${new Set(gnames).size} 个唯一名`);
  }

  // ═════════════════════════════════════════════════════════════════════
  section("⑤ 场景 C：GitHub 失败 + npm 关掉 + **无缓存** ⇒ 必须如实失败");
  // ═════════════════════════════════════════════════════════════════════
  //   先把缓存删掉，才能测到"三层全空"
  try { fs.rmSync(C.cacheFile(), { force: true }); } catch { /* 没有就算了 */ }
  const C1 = await C.fetchIndex({ repo: DEAD_REPO, branch: "main", npm: false, force: true });
  console.log(`  ok=${C1.ok} source=${C1.source} error=${String(C1.error).slice(0, 60)}`);
  chk(C1.ok === false, "★ 三层全空 ⇒ 如实返回 ok=false（**不假装成功**）", `ok=${C1.ok} source=${C1.source}`);
  chk(C1.index === null, "没有清单就是 null（不是空数组冒充）");

  // ═════════════════════════════════════════════════════════════════════
  section("⑥ 场景 D：第三层兜底 —— 有缓存时，两条路都挂也要能退回上一份并标 stale");
  // ═════════════════════════════════════════════════════════════════════
  const D0 = await C.fetchIndex({ force: true });     // 先正常取一次，写缓存
  if (!D0.ok) {
    skip("场景 D（缓存兜底）", "连正常取一次都失败，写不出缓存");
  } else {
    const D = await C.fetchIndex({ repo: DEAD_REPO, branch: "main", npm: false, force: true });
    console.log(`  ok=${D.ok} source=${D.source} stale=${D.stale} 条目=${D.index ? D.index.entries.length : 0}`);
    chk(D.ok === true, "★ 两条路都挂但**有缓存** ⇒ 仍然 ok=true（断网还能看到上一份）", `ok=${D.ok}`);
    chk(D.source === "cache", "★ 来源如实标成 cache", D.source);
    chk(D.stale === true, "★ stale=true（界面会写明「这是缓存」——不误导用户）", `stale=${D.stale}`);
    chk(D.index && D.index.entries.length > 0, "缓存里的条目真的读出来了");
  }

  // ═════════════════════════════════════════════════════════════════════
  section("⑦ 端到端：真下一个包，并按 sha512 **校验通过**");
  // ═════════════════════════════════════════════════════════════════════
  const pick = E.find((e) => e.name === "dsh-int-multi-session") || E[0];
  if (!pick) {
    chk(false, "清单里一条都没有，没法做端到端");
  } else {
    console.log(`  选中的包：${pick.name}@${pick.version}`);
    const dl = await C.downloadArchive(pick, () => {});
    chk(dl.ok, "★ 真下载成功（走 Chromium 网络栈）", dl.ok ? `${dl.bytes} B` : dl.error);
    if (dl.ok) {
      // 先证明"坏哈希会被拒" —— 否则"校验通过"不能说明校验器在工作
      const bad = PI.installFromArchive({
        dshHome: path.join(TMP_HOME, "fake-home"),
        tgz: dl.path, expectedIntegrity: "sha512-" + "A".repeat(86) + "==", name: pick.name,
        log: () => {},
      });
      chk(bad.ok === false && (bad.errors || []).some((s) => /integrity 不符/.test(s)),
        "★ 先证明尺子对：**改一个字符的 integrity 必须被拒**",
        (bad.errors || []).join("；"));

      const good = PI.installFromArchive({
        dshHome: path.join(TMP_HOME, "fake-home"),
        tgz: dl.path, expectedIntegrity: pick.integrity, name: pick.name,
        log: () => {},
      });
      const hashErr = (good.errors || []).some((s) => /integrity 不符|sha256 不符/.test(s));
      chk(!hashErr, "★ 真 integrity ⇒ **哈希这一关通过**（没被拒）",
        hashErr ? (good.errors || []).join("；") : "通过");
      C.cleanupArchive(dl.path);
    }
  }

  // ── 收尾 ──
  console.log(`\n${"=".repeat(64)}`);
  console.log(`npm-source-check：${OK} OK / ${FAILS.length} FAIL / ${SKIPS.length} SKIP`);
  if (FAILS.length) { console.log("失败项："); for (const f of FAILS) console.log(`  · ${f}`); }
  if (SKIPS.length) { console.log("跳过项（**不算通过**）："); for (const s of SKIPS) console.log(`  · ${s}`); }

  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  app.exit(FAILS.length ? 1 : 0);
}).catch((e) => {
  console.error("脚本自己崩了：" + ((e && e.stack) || e));
  app.exit(2);
});
