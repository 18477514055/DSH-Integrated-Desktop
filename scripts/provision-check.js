"use strict";

/**
 * provision-check.js —— 真跑验证 `src/plugins.js` 的内置插件逻辑
 *
 * 为什么必须是"真跑"（项目 AGENTS.md §5）："文件存在 / 配置里有 / 版本号对"
 * 一律不算证据。本脚本在**临时 DSH_HOME** 上真的建 profile、真的调 provision、
 * 然后**去磁盘上找**插件字节与联接指向，最后连跑两次验幂等。
 *
 * 覆盖的场景：
 *   ① 全新机器（profile 还不存在）→ 应报 pending="profile-missing"，不抛错、不乱写
 *   ② profile 就位后 → 三处契约全部落位（dependencies / bundles / 联接）
 *   ③ **幂等**：紧接着再跑一次 → changed 必须为空
 *   ④ **不越界**：别人的依赖、别人的 bundles 条目、别人的 node_modules 真实目录，一个都不许动
 *   ⑤ **自愈**：插件副本被改坏 → 下一轮自动修复；联接被删 → 下一轮自动重建
 *   ⑥ `_retired` 这类下划线目录不许被当成可分发的插件
 *   ⑦ 打包形态：srcRoot 换成模拟的 <resources>/plugins，行为一致
 *
 * 用法：node scripts/provision-check.js
 * 退出码：0=全过  1=有断言失败
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const P = require("../src/plugins");

const REPO = path.join(__dirname, "..");
const SRC_REPO = path.join(REPO, "plugin");

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, extra = "") {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; failures.push(label); console.log(`  ✗ ${label}${extra ? "  —— " + extra : ""}`); }
}

function cleanup(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

/** 两个路径是不是同一个（Windows 大小写不敏感）。 */
function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** 造一个"内核刚跑过第一次"的 profile 骨架。 */
function makeHome(root, { withProfile = true } = {}) {
  const home = path.join(root, "dsh-home");
  fs.mkdirSync(home, { recursive: true });
  if (!withProfile) return home;

  const prof = path.join(home, "profiles", "web");
  fs.mkdirSync(path.join(prof, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(prof, "package.json"), JSON.stringify({
    name: "dsh-profile-web",
    private: true,
    dependencies: {
      // ★ 别人的东西：全程一个字都不许改
      "someone-elses-plugin": "^9.9.9",
    },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "someone-elses-plugin"], patchReload: "live" } },
  }, null, 2) + "\n", "utf8");

  // ★ 别人的真实目录：名字不是我们分发的 ⇒ 绝不能被替换
  const foreign = path.join(prof, "node_modules", "someone-elses-plugin");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "index.js"), "// not ours\n", "utf8");

  return home;
}

function profilePkg(home) {
  return JSON.parse(fs.readFileSync(path.join(home, "profiles", "web", "package.json"), "utf8"));
}

function junctions(home, names) {
  const nm = path.join(home, "profiles", "web", "node_modules");
  const out = {};
  for (const n of names) {
    let t = null;
    try { t = fs.realpathSync(path.join(nm, n)); } catch { /* 不存在 */ }
    out[n] = t;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
console.log("\n=== provision-check：内置插件逻辑真跑验证 ===");
console.log(`  插件来源: ${SRC_REPO}`);

const srcPlugins = P.listBundledPlugins(SRC_REPO);
const names = srcPlugins.map((p) => p.name);
console.log(`  发现插件: ${names.join(", ") || "(无)"}`);
ok(names.length >= 2, "来源目录里发现 ≥2 个插件", `实得 ${names.length}`);
ok(!names.includes("_retired"), "`_retired` 没被当成可分发的插件");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-provision-check-"));
let home = null;

try {
  // ── ① 全新机器：profile 还不存在 ──
  console.log("\n① 全新机器（profile 不存在）");
  home = makeHome(root, { withProfile: false });
  let r = P.provision({ dshHome: home, profile: "web", srcRoot: SRC_REPO, log: () => {} });
  ok(r.pending === "profile-missing", "报 pending=profile-missing（不抛错）", JSON.stringify(r.pending));
  ok(r.changed.length === 0, "没有做任何改动");
  ok(!fs.existsSync(path.join(home, "plugins")), "没有凭空创建 plugins 目录");

  // ── ② profile 就位 → 三处契约 ──
  console.log("\n② profile 就位后执行 provision");
  cleanup(home);
  home = makeHome(root, { withProfile: true });
  r = P.provision({ dshHome: home, profile: "web", srcRoot: SRC_REPO, appVersion: "0.2.2-test", log: () => {} });
  ok(r.ok, "provision 成功", JSON.stringify(r.errors));
  ok(r.changed.length === names.length, `changed 含全部插件（${names.length}）`, JSON.stringify(r.changed));

  for (const p of srcPlugins) {
    const dest = path.join(home, "plugins", p.name);
    ok(fs.existsSync(path.join(dest, "package.json")), `[${p.name}] 副本有 package.json`);
    // ★ 2026-09-21 插件包内分层（desktop/ 电脑侧 / phone/ 手机侧）后，客户端半边
    //   在 desktop/client.js。不再写死 lib/ —— 那会在下一次整理时又把这把尺子弄过时。
    //   判据改为"按 package.json 的 exports["./client"] 解析，解析出的文件必须存在"。
    const cRel = String((p.pkg && p.pkg.exports && p.pkg.exports["./client"]) || "").replace(/^\.\//, "");
    ok(!!cRel && fs.existsSync(path.join(dest, cRel)),
      `[${p.name}] 副本有客户端半边（exports["./client"] = ${cRel || "(未声明)"}）`);
    ok(P.fingerprint(dest) === P.fingerprint(p.dir), `[${p.name}] 副本与源**逐字节同指纹**`);
    ok(P.fingerprint(dest) !== null, `[${p.name}] 指纹可算（非 null）`);
  }

  const pkg = profilePkg(home);
  const bundles = pkg.dsh.profile.bundles;
  for (const p of srcPlugins) {
    const dest = path.join(home, "plugins", p.name);
    ok(pkg.dependencies[p.name] === "link:" + dest, `[${p.name}] ① dependencies=link:<用户目录>/plugins/...`, String(pkg.dependencies[p.name]));
    ok(bundles.includes(p.name), `[${p.name}] ② dsh.profile.bundles 含它`);
  }

  const jx = junctions(home, names);
  const clientAt = (n) => {
    // ★ 分层后按 exports["./client"] 解析，不写死 lib/
    const p = srcPlugins.find((x) => x.name === n);
    const rel = p ? String(p.pkg?.exports?.["./client"] || "").replace(/^\.\//, "") : "lib/client.js";
    try { return fs.existsSync(path.join(jx[n], rel)); } catch { return false; }
  };
  for (const n of names) {
    ok(!!jx[n], `[${n}] ③ node_modules 联接存在`);
    ok(clientAt(n), `[${n}] ③ 联接里**真能读到**客户端半边（desktop/client.js）`);
  }

  ok(fs.existsSync(path.join(home, "safety", "plugin-provision-backup")), "改 package.json 前留了备份目录");
  ok(fs.existsSync(path.join(home, "plugins", P.STATE_FILE)), "写了 .provisioned.json 状态留痕");

  // ── ④ 不越界 ──
  console.log("\n④ 不许碰别人的东西");
  ok(pkg.dependencies["someone-elses-plugin"] === "^9.9.9", "别人的 dependencies 条目原样保留");
  ok(bundles.includes("someone-elses-plugin"), "别人的 bundles 条目原样保留");
  ok(fs.existsSync(path.join(home, "profiles", "web", "node_modules", "someone-elses-plugin", "index.js")),
    "别人的**真实目录**没被替换/删除");

  // ── ③ 幂等 ──
  console.log("\n③ 幂等：紧接着再跑一次");
  const r2 = P.provision({ dshHome: home, profile: "web", srcRoot: SRC_REPO, appVersion: "0.2.2-test", log: () => {} });
  ok(r2.changed.length === 0, "第二次 changed 为空", JSON.stringify(r2.changed));
  ok(r2.ok, "第二次仍 ok", JSON.stringify(r2.errors));
  const pkgAfter = profilePkg(home);
  ok(JSON.stringify(pkgAfter.dependencies) === JSON.stringify(pkg.dependencies), "package.json 的 dependencies 没被再写一遍");

  // ── ⑤ 自愈 ──
  console.log("\n⑤ 自愈能力");
  const victim = names[0];
  const victimClient = path.join(home, "plugins", victim, "lib", "client.js");
  const before = fs.readFileSync(victimClient);
  fs.appendFileSync(victimClient, "\n// TAMPERED\n");
  const r3 = P.provision({ dshHome: home, profile: "web", srcRoot: SRC_REPO, log: () => {} });
  ok(r3.changed.includes(victim), "副本被改坏 → 下一轮检出并要求重装", JSON.stringify(r3.changed));
  ok(Buffer.compare(fs.readFileSync(victimClient), before) === 0, "副本内容被修复回源的样子");

  fs.rmSync(path.join(home, "profiles", "web", "node_modules", victim), { recursive: true, force: true });
  const r4 = P.provision({ dshHome: home, profile: "web", srcRoot: SRC_REPO, log: () => {} });
  ok(r4.changed.includes(victim), "联接被删 → 下一轮检出", JSON.stringify(r4.changed));
  ok(!!junctions(home, [victim])[victim], "联接被重建");

  // ── ⑥ 已指向别处的**合法** link：必须被尊重，不许接管 ──
  //
  // 场景：开发机用 install-plugin.js 把插件联到**仓库目录**（改源码即时生效）。
  // 打包版若每次都改写它，就是"装了打包版 → 开发用联接被冲掉"的拉锯。
  console.log("\n⑥ 开发机场景：profile 已联到别处（仓库目录）");
  const A = names[0];
  const home3 = makeHome(path.join(root, "devlink"), { withProfile: true });
  const elsewhere = path.join(root, "elsewhere", A);
  fs.mkdirSync(path.join(elsewhere, "lib"), { recursive: true });
  fs.writeFileSync(path.join(elsewhere, "package.json"),
    JSON.stringify({ name: A, version: "9.9.9", dsh: { client: { platform: "web" } } }, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(elsewhere, "lib", "client.js"), "// dev version — 不许被覆盖\n", "utf8");

  const p3 = path.join(home3, "profiles", "web");
  const j3 = JSON.parse(fs.readFileSync(path.join(p3, "package.json"), "utf8"));
  j3.dependencies[A] = "link:" + elsewhere;
  j3.dsh.profile.bundles.push(A);
  fs.writeFileSync(path.join(p3, "package.json"), JSON.stringify(j3, null, 2) + "\n", "utf8");
  fs.symlinkSync(elsewhere, path.join(p3, "node_modules", A), "junction");

  const r7 = P.provision({ dshHome: home3, profile: "web", srcRoot: SRC_REPO, log: () => {} });
  ok(r7.ok, "⑥ provision 成功", JSON.stringify(r7.errors));
  ok(!r7.changed.includes(A), `[${A}] 已有的外部 link 没被判定为"要改"`, JSON.stringify(r7.changed));
  ok(!fs.existsSync(path.join(home3, "plugins", A)), `[${A}] 没被复制进 plugins\\（不接管）`);
  ok(profilePkg(home3).dependencies[A] === "link:" + elsewhere, `[${A}] dependencies 指向别处被保留`);
  ok(fs.readFileSync(path.join(elsewhere, "lib", "client.js"), "utf8").includes("dev version"),
    `[${A}] 那份"开发版"内容一个字节都没被动`);
  ok(samePath(junctions(home3, [A])[A], elsewhere), `[${A}] 联接仍指向别处`);

  // ── ⑥b 指向**已失效**目录的 link：必须接管，把用户救回来 ──
  console.log("\n⑥b 指向已失效目录的 link → 必须接管修复");
  const home4 = makeHome(path.join(root, "deadlink"), { withProfile: true });
  const dead = path.join(root, "gone-away", A);
  const p4 = path.join(home4, "profiles", "web");
  const j4 = JSON.parse(fs.readFileSync(path.join(p4, "package.json"), "utf8"));
  j4.dependencies[A] = "link:" + dead;         // 目录根本不存在（项目挪走了）
  j4.dsh.profile.bundles.push(A);
  fs.writeFileSync(path.join(p4, "package.json"), JSON.stringify(j4, null, 2) + "\n", "utf8");

  const r8 = P.provision({ dshHome: home4, profile: "web", srcRoot: SRC_REPO, log: () => {} });
  ok(r8.ok, "⑥b provision 成功", JSON.stringify(r8.errors));
  ok(r8.changed.includes(A), `[${A}] 失效 link 被接管修复`, JSON.stringify(r8.changed));
  ok(profilePkg(home4).dependencies[A] === "link:" + path.join(home4, "plugins", A),
    `[${A}] 改指到用户数据目录`, String(profilePkg(home4).dependencies[A]));
  ok(!!junctions(home4, [A])[A], `[${A}] 联接被重建`);

  // ── ⑦ 打包形态 ──
  console.log("\n⑦ 打包形态（物化 → 模拟 electron-builder → 落位）");
  //
  // ★ 这一段以前是 `for (const p of srcPlugins) fs.cpSync(p.dir, …, {recursive:true})`，
  //   **它对本仓库当前的形态直接崩掉**（实测 2026-09-21，node 24：53 OK / 1 FAIL）：
  //   只要 plugin/ 下有插件是"本体在别的工作区、这里只留 Junction"，cpSync 就抛
  //   EPERM: operation not permitted, symlink。
  //   两个真因叠在一起，现在都验：
  //     ① `plugin/` 是**联接** ⇒ 必须先走 materializePlugins 解引用
  //        （这也是打包脚本 scripts/materialize-plugins.js 做的事）
  //     ② electron-builder 的 copyDir **不解引用联接**，会把联接原样复制成
  //        指向开发机的**死链** ⇒ 物化产物必须是真实目录，下面逐条查
  const matRoot = path.join(root, "materialized");
  const mat = P.materializePlugins(SRC_REPO, matRoot, P.DEFAULT_EXCLUDES);
  ok(mat.ok && !mat.errors.length, "物化成功", mat.errors.join(" | "));
  const linkNames = [];
  for (const name of mat.copied) {
    const st = fs.lstatSync(path.join(matRoot, name));
    if (st.isSymbolicLink()) linkNames.push(name);
  }
  ok(!linkNames.length, "物化产物里没有联接（否则打包会带死链）", linkNames.join(","));
  if (mat.links.length) {
    ok(mat.copied.length === names.length,
      `物化了 ${mat.links.length} 个联接形态的插件，数量与来源一致`, mat.copied.join(","));
  }

  const resRoot = path.join(root, "resources", "plugins");
  fs.mkdirSync(resRoot, { recursive: true });
  for (const name of mat.copied) {
    // 物化后都是真实目录 ⇒ cpSync 不再需要 dereference，正好模拟 electron-builder
    fs.cpSync(path.join(matRoot, name), path.join(resRoot, name), { recursive: true });
  }
  // 排除规则必须真的生效（构建产物里那 232 字符深的路径不许进来）
  ok(!fs.existsSync(path.join(resRoot, "dsh-mobile-remote", "android", "build")),
    "android/build（232 字符深路径）没进打包产物");

  const home2 = makeHome(path.join(root, "packaged"), { withProfile: true });
  const r5 = P.provision({ dshHome: home2, profile: "web", srcRoot: resRoot, appVersion: "0.2.2-test", log: () => {} });
  ok(r5.ok, "打包形态 provision 成功", JSON.stringify(r5.errors));
  ok(r5.plugins.length === names.length, "打包形态发现同样多的插件", JSON.stringify(r5.plugins));
  const pkg2 = profilePkg(home2);
  for (const p of srcPlugins) {
    ok(pkg2.dependencies[p.name] === "link:" + path.join(home2, "plugins", p.name),
      `[${p.name}] 打包形态 link 指向用户目录（**不是**安装目录）`, String(pkg2.dependencies[p.name]));
  }
  const r6 = P.provision({ dshHome: home2, profile: "web", srcRoot: resRoot, appVersion: "0.2.2-test", log: () => {} });
  ok(r6.changed.length === 0, "打包形态同样幂等", JSON.stringify(r6.changed));
} catch (e) {
  fail += 1;
  failures.push("脚本抛异常: " + ((e && e.stack) || e));
  console.log("\n✗ 抛异常：\n" + ((e && e.stack) || e));
} finally {
  cleanup(root);
}

console.log("\n" + "=".repeat(60));
console.log(`  结果：${pass} OK / ${fail} FAIL`);
if (fail) {
  console.log("  失败项：");
  for (const f of failures) console.log("    · " + f);
}
console.log("=".repeat(60) + "\n");
process.exit(fail ? 1 : 0);
