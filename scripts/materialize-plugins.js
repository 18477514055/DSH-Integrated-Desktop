"use strict";

/**
 * materialize-plugins.js —— 打包前把 `plugin/` 里的**目录联接**展开成真实目录。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它解决什么问题（2026-09-21 实测，不是理论）
 * ══════════════════════════════════════════════════════════════════
 * 2026-09-21 起插件的**本体搬到了第三工作区**（`D:\DSH工作区002\`），
 * 仓库里的 `plugin/<名字>` 只是 **Junction**。而 electron-builder 拷 extraResources
 * 用的 `copyDir` **不解引用联接**（走 `lstat().isSymbolicLink()` 分支，把联接原样重建）：
 *
 *   实测（与 package.json **完全相同**的 filter 跑 builder-util 的 copyDir）：
 *     dest/dsh-mobile-remote 存在 = true
 *     它是符号链接（Junction）    = true
 *     → 指向 C:\Users\...\WORKSPACE3\1.手机遥控     ← 开发机专属绝对路径
 *
 * ⇒ 别人装完，`resources\plugins\<名字>` 是**死链**，落位逻辑找不到插件，界面上什么都没有。
 *
 * 本脚本在 electron-builder **之前**跑：把插件解引用拷到 `runtime/materialized-plugins/`
 * （`.gitignore` 已忽略整个 runtime 目录），再让 extraResources 的 from 指向它。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条设计取舍
 * ══════════════════════════════════════════════════════════════════
 * ① **只物化联接，真实目录原样用。** 判据是 `lstatSync().isSymbolicLink()`。
 *    如果 `plugin/` 下**一个联接都没有**（比如在别人机器上、或以后又搬回仓库），
 *    脚本会打印 `plugin/` 本身并让打包直接用仓库目录 —— **不多拷一份，
 *    也不会因为"目标目录存在但为空"而把插件弄丢**。
 * ② **`--check` 只读**：不写任何东西，只报告"如果现在打包，产物里会不会有死链"。
 *    退出码 0 = 干净；2 = 有联接（打包前必须先物化）。
 * ③ 物化目录**每次重建**（先删再拷）：避免上一次的残留文件混进这一包。
 *
 * 用法（由 package.json 的 pack / dist 自动调用，也可手动）：
 *   node scripts/materialize-plugins.js            # 物化，打印结果（stdout 末行是要用的目录）
 *   node scripts/materialize-plugins.js --check    # 只检查，不写
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const P = require("../src/plugins");

const REPO = path.join(__dirname, "..");
const SRC = path.join(REPO, "plugin");
const OUT = path.join(REPO, "runtime", "materialized-plugins");
const CHECK = process.argv.includes("--check");

function main() {
  // ── 先看清 plugin/ 下有什么 ──
  let entries = [];
  try { entries = fs.readdirSync(SRC, { withFileTypes: true }); }
  catch (e) { console.error(`[materialize] 读不到 ${SRC}：${e.message}`); process.exit(1); }

  const links = [];
  for (const e of entries) {
    if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
    const full = path.join(SRC, e.name);
    let st = null;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) links.push({ name: e.name, target: fs.readlinkSync(full) });
  }

  const plugins = P.listBundledPlugins(SRC);
  console.log(`[materialize] 来源目录：${SRC}`);
  console.log(`[materialize] 发现插件 ${plugins.length} 个：${plugins.map((p) => p.name).join(", ") || "(无)"}`);
  console.log(`[materialize] 其中目录联接 ${links.length} 个${links.length ? "：" : "（无需物化）"}`);
  for (const l of links) console.log(`               · ${l.name} → ${l.target}`);

  // ── --check：只报，不写 ──
  if (CHECK) {
    if (!links.length) {
      console.log("[materialize] --check：没有联接，打包产物不会出现死链 ✓");
      process.exit(0);
    }
    console.error("[materialize] --check：✗ 有联接 —— 直接打包会把它原样复制成"
      + "指向开发机的死链，别人装完就没有插件。");
    console.error("              先跑一次：node scripts/materialize-plugins.js");
    process.exit(2);
  }

  // ── 物化：**无条件**执行 ──
  //
  // 为什么不"没有联接就跳过、直接用仓库 plugin/"：`extraResources.from` 是
  // **静态配置**，一个构建配置不可能随"这台机器有没有联接"而变。
  // 所以统一规定：**打包读的永远是 OUT 目录**，由本脚本负责把它填对。
  // 没有联接时就是把真实目录原样拷一份（约 1 MB 的量级，代价可接受），
  // 换来的是"任何机器上打包行为一致、且不可能漏掉插件"。
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch { /* 忽略 */ }
  const r = P.materializePlugins(SRC, OUT, P.DEFAULT_EXCLUDES);
  if (!r.ok || r.errors.length) {
    console.error("[materialize] ✗ 物化失败：");
    for (const e of r.errors) console.error("    · " + e);
    process.exit(1);
  }
  if (!r.copied.length) {
    console.error("[materialize] ✗ 物化结果为 0 个插件 —— 拒绝让一个没有插件的包流出去");
    process.exit(1);
  }

  // ── 回验：产物必须是**真实目录**，且文件数与"本体减去排除项"一致 ──
  let bad = 0;
  for (const name of r.copied) {
    const d = path.join(OUT, name);
    const st = fs.lstatSync(d);
    if (st.isSymbolicLink()) {
      console.error(`[materialize] ✗ ${name} 物化后仍是联接 —— 打包产物会带死链`);
      bad++;
      continue;
    }
    const got = countFiles(d);
    const want = countFiles(path.join(SRC, name), P.DEFAULT_EXCLUDES);
    if (got !== want) {
      console.error(`[materialize] ✗ ${name} 文件数不一致：物化 ${got} vs 应得 ${want}`);
      bad++;
    } else {
      const how = r.links.includes(name) ? "由联接展开" : "真实目录拷贝";
      console.log(`[materialize] ✓ ${name} 已物化（${how}，${got} 个文件，已排除构建产物）`);
    }
  }
  if (bad) process.exit(1);

  console.log(`[materialize] 物化目录：${OUT}`);
  console.log(OUT);
}

/** 数文件；`excludes` 给定时跳过被排除的子树（与打包 filter 同一套规则）。 */
function countFiles(dir, excludes) {
  let n = 0;
  (function walk(cur, rel) {
    let es;
    try { es = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(cur, e.name);
      const r = rel ? rel + "/" + e.name : e.name;
      if (excludes && P.isExcluded(r, excludes)) continue;
      // 物化后不该再有联接；真遇到了也要跟随（用 statSync）
      let st = null;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) n++;
    }
  })(dir, "");
  return n;
}

main();
