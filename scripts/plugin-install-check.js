"use strict";

/**
 * plugin-install-check.js —— `src/plugin-install.js` 的真跑验收
 *
 * 规矩（照抄本项目 §5 验证纪律）：
 *   · **全部在一个临时 DSH 家上跑**，绝不碰用户真实的 B 家。
 *   · 每条结论都去**磁盘上找证据**，不看模块自己的结果文案。
 *   · 特别要盯的三件事：
 *       ① profile\package.json **无 BOM**（带 BOM = 整台 DSH 起不来）
 *       ② 通过 node_modules 的**联接真的能读到**插件文件（不是"文件在那儿"）
 *       ③ 删落点时**不能把联接的目标本体删掉**（插件本体可能在别的盘/工作区）
 *   · 交叉断言：同一个插件，`provision()` 与 `installFromDir()` 装出来的
 *     profile\package.json 必须**逐字节相同** —— 对不上就是两套实现分叉了。
 *
 * 用法：node scripts/plugin-install-check.js [--keep]
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const I = require("../src/plugin-install.js");
const P = require("../src/plugins.js");

const KEEP = process.argv.includes("--keep");

let OK = 0;
const FAILS = [];
function chk(cond, label, extra) {
  if (cond) { OK++; console.log(`  OK   ${label}`); }
  else {
    FAILS.push(label + (extra ? `  <-- ${extra}` : ""));
    console.log(`  FAIL ${label}${extra ? "  <-- " + extra : ""}`);
  }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-pi-check-"));
const log = () => {};

// ─────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────

function buildPlugin(dir, name, version, mutate) {
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
  const pkg = {
    name, version, private: true,
    description: "fixture for plugin-install-check",
    main: "lib/index.js",
    exports: {
      ".": "./lib/index.js",
      "./client": "./lib/client.js",
      "./cordis.patch.yml": "./cordis.patch.yml",
      "./package.json": "./package.json",
    },
    dsh: {
      bundle: { patch: "./cordis.patch.yml" },
      client: { platform: "web", inject: ["@deepseek-ai/dsh-client-ui-slots"] },
    },
  };
  if (typeof mutate === "function") mutate(pkg, dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
  if (!pkg.__noPatch) {
    fs.writeFileSync(path.join(dir, "cordis.patch.yml"), "# fixture patch\n- insert:\n    - id: fixture\n", "utf8");
  }
  fs.writeFileSync(path.join(dir, "lib", "index.js"), "module.exports = {};\n", "utf8");
  fs.writeFileSync(path.join(dir, "lib", "client.js"), "window.__fixture__ = true;\n", "utf8");
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`, "utf8");
  fs.writeFileSync(path.join(dir, "nested", "deep.txt"), "deep-content-12345\n", "utf8");
  return dir;
}

/** 造一个"已经跑过内核"的家：profile 存在，且里面有别人的东西 */
function makeHome(home) {
  const profileDir = path.join(home, "profiles", "web");
  const nm = path.join(profileDir, "node_modules");
  fs.mkdirSync(nm, { recursive: true });

  // ★ 刻意**不**按"家名"分目录。
  //   第一版写的是 path.join(home, "..", "foreign", path.basename(home), …) ⇒ 两个家
  //   连这条"别人的插件"路径都不同（foreign\homeB vs foreign\homeProvision），
  //   交叉断言就得靠字符串修补才比得平 —— 那是把尺子做歪。夹具不该依赖家名。
  const foreign = path.join(root, "foreign", "shared", "someone-else-plugin");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "package.json"),
    JSON.stringify({ name: "someone-else-plugin", version: "9.9.9" }, null, 2) + "\n", "utf8");
  fs.mkdirSync(path.join(nm, "someone-else-plugin"), { recursive: true });
  fs.writeFileSync(path.join(nm, "someone-else-plugin", "package.json"),
    JSON.stringify({ name: "someone-else-plugin", version: "9.9.9" }, null, 2) + "\n", "utf8");
  fs.mkdirSync(path.join(nm, "@deepseek-ai", "dsh-base"), { recursive: true });

  const pkg = {
    name: "dsh-profile-web",
    private: true,
    dependencies: {
      "@deepseek-ai/dsh-base": "0.1.5-rc.2",
      "someone-else-plugin": "link:" + foreign,
      "dev-linked": "link:" + path.join(home, "..", "elsewhere", "dev-linked"),
    },
    dsh: {
      profile: {
        bundles: ["@deepseek-ai/dsh-base", "dsh-web-app", "someone-else-plugin"],
        patchReload: "live",
      },
    },
  };
  fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
  return { profileDir, nm, foreign, pkg };
}

/** 打成 npm pack 那种布局：包里套一层 package/ */
function packTgz(pluginDir, outTgz) {
  const stage = fs.mkdtempSync(path.join(root, "stage-"));
  fs.cpSync(pluginDir, path.join(stage, "package"), { recursive: true, dereference: true });
  const r = spawnSync(I.tarBin(), ["-czf", outTgz, "-C", stage, "package"], {
    encoding: "utf8", windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`打包失败：${r.stderr}`);
  fs.rmSync(stage, { recursive: true, force: true });
  return outTgz;
}

function readProfilePkg(home) {
  return fs.readFileSync(path.join(home, "profiles", "web", "package.json"), "utf8");
}
function firstBytes(abs, n = 3) {
  const fd = fs.openSync(abs, "r");
  const b = Buffer.alloc(n);
  fs.readSync(fd, b, 0, n, 0);
  fs.closeSync(fd);
  return [...b];
}
function junctionTarget(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────
section("① sha256 —— 先证明尺子对（拿 PowerShell 的 Get-FileHash 独立复算）");
// ─────────────────────────────────────────────────────────────────────────
{
  const f = path.join(root, "hello.bin");
  fs.writeFileSync(f, "hello", "utf8");
  const mine = I.sha256File(f);
  // 独立实现：PowerShell 的 Get-FileHash
  const ps = spawnSync("powershell", ["-NoProfile", "-Command",
    `(Get-FileHash -Algorithm SHA256 -LiteralPath '${f.replace(/'/g, "''")}').Hash`], { encoding: "utf8" });
  const theirs = (ps.stdout || "").trim().toLowerCase();
  chk(theirs.length === 64, "对照尺子拿到了 64 位十六进制", theirs.slice(0, 20));
  chk(mine === theirs, "自定义 sha256 == PowerShell Get-FileHash", `mine=${mine.slice(0, 16)} theirs=${theirs.slice(0, 16)}`);
  chk(mine === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    'sha256("hello") == 已知真值（第二个独立对照）', mine);
  fs.writeFileSync(f, "hello2", "utf8");
  chk(I.sha256File(f) !== mine, "内容变了 sha256 就变");
}

// ─────────────────────────────────────────────────────────────────────────
section("② validatePluginDir —— 装之前那道闸");
// ─────────────────────────────────────────────────────────────────────────
const goodDir = buildPlugin(path.join(root, "src", "dsh-demo-plugin"), "dsh-demo-plugin", "1.2.3");
{
  const v = I.validatePluginDir(goodDir);
  chk(v.ok === true, "合法插件通过", v.errors.join("; "));
  chk(v.name === "dsh-demo-plugin", "读出 name");
  chk(v.version === "1.2.3", "读出 version");
  chk(!!v.patchFile && fs.existsSync(v.patchFile), "定位到 cordis.patch.yml 真实文件");
  chk(!!v.clientEntry && fs.existsSync(v.clientEntry), "定位到 exports[\"./client\"] 真实文件");

  chk(I.validatePluginDir(path.join(root, "src", "nonexistent")).ok === false, "目录不存在 → 拒");
  const noPkg = path.join(root, "src", "no-pkg");
  fs.mkdirSync(noPkg, { recursive: true });
  chk(I.validatePluginDir(noPkg).ok === false, "没有 package.json → 拒");

  const badJson = path.join(root, "src", "bad-json");
  fs.mkdirSync(badJson, { recursive: true });
  fs.writeFileSync(path.join(badJson, "package.json"), "{ 这不是 JSON ", "utf8");
  chk(I.validatePluginDir(badJson).ok === false, "package.json 坏 JSON → 拒");

  const notPlugin = path.join(root, "src", "not-a-plugin");
  fs.mkdirSync(notPlugin, { recursive: true });
  fs.writeFileSync(path.join(notPlugin, "package.json"),
    JSON.stringify({ name: "not-a-plugin", version: "1.0.0" }, null, 2), "utf8");
  const vn = I.validatePluginDir(notPlugin);
  chk(vn.ok === false, "没有 dsh.bundle / dsh.client → 拒（否则连累整棵 profile tree）");
  chk(vn.errors.some((e) => /dsh\.bundle/.test(e)), "拒绝理由里点名了 dsh.bundle");

  const missingPatch = buildPlugin(path.join(root, "src", "missing-patch"), "missing-patch", "1.0.0",
    (pkg) => { pkg.__noPatch = true; });
  const vm = I.validatePluginDir(missingPatch);
  chk(vm.ok === false, "dsh.bundle.patch 指向的文件不存在 → 拒");
  chk(vm.errors.some((e) => /patch/.test(e)), "拒绝理由里点名了 patch");

  const badClient = buildPlugin(path.join(root, "src", "bad-client"), "bad-client", "1.0.0",
    (pkg) => { pkg.exports["./client"] = "./lib/nope.js"; });
  chk(I.validatePluginDir(badClient).ok === false, "exports[\"./client\"] 指向不存在的文件 → 拒");

  const badName = buildPlugin(path.join(root, "src", "bad-name"), "bad name!", "1.0.0");
  chk(I.validatePluginDir(badName).ok === false, "包名非法 → 拒");

  const nodePlat = buildPlugin(path.join(root, "src", "node-plat"), "node-plat", "1.0.0",
    (pkg) => { pkg.dsh.client.platform = "node"; });
  const vp = I.validatePluginDir(nodePlat);
  chk(vp.ok === true && vp.warnings.length > 0, "platform=node 只警告不拒绝（信息，不是阻断）");
}

// ─────────────────────────────────────────────────────────────────────────
section("③ 解包 —— 数组参数、不经 shell（路径含空格是必踩项）");
// ─────────────────────────────────────────────────────────────────────────
let tgz = null;
{
  tgz = packTgz(goodDir, path.join(root, "dsh-demo-plugin-1.2.3.tgz"));
  chk(fs.existsSync(tgz), "打出了 npm pack 布局的 tgz");

  const unpack = path.join(root, "unpack-1");
  const r = I.extractTgz(tgz, unpack, log);
  chk(path.basename(r) === "package", "自动钻过 package/ 这一层，找到插件根", r);
  chk(fs.readFileSync(path.join(r, "lib", "client.js"), "utf8").includes("__fixture__"),
    "解出来的 lib/client.js 内容与源一致");
  chk(fs.existsSync(path.join(r, "nested", "deep.txt")), "嵌套子目录也解出来了");

  // ★ 空格路径：真实场景里 %APPDATA%\DSH Integrated\… 必然含空格
  const spaceDir = path.join(root, "带 空格 的 目录");
  const spaceOut = path.join(root, "另 一个 目录");
  fs.mkdirSync(spaceDir, { recursive: true });
  const spacedTgz = path.join(spaceDir, "有 空格 的 包.tgz");
  fs.copyFileSync(tgz, spacedTgz);
  let spaceOk = false, spaceErr = "";
  try { I.extractTgz(spacedTgz, spaceOut, log); spaceOk = true; } catch (e) { spaceErr = e.message; }
  chk(spaceOk, "★ 压缩包与目标目录都含空格时照样解得出", spaceErr);

  let threw = false;
  try { I.extractTgz(path.join(root, "no-such.tgz"), path.join(root, "unpack-x")); } catch { threw = true; }
  chk(threw, "压缩包不存在 → 抛错（不是静默返回）");

  const notTar = path.join(root, "not-a-tar.tgz");
  fs.writeFileSync(notTar, "这不是压缩包", "utf8");
  let threw2 = false;
  try { I.extractTgz(notTar, path.join(root, "unpack-y")); } catch { threw2 = true; }
  chk(threw2, "不是压缩包 → 抛错（不会留下半个插件）");

  const emptyDir = path.join(root, "empty-dir");
  fs.mkdirSync(emptyDir, { recursive: true });
  chk(I.detectPluginRoot(emptyDir) === null, "空目录 → detectPluginRoot 返回 null（不瞎猜）");
}

// ─────────────────────────────────────────────────────────────────────────
section("④ installFromDir —— 三处契约，逐条去磁盘上找");
// ─────────────────────────────────────────────────────────────────────────
const homeB = path.join(root, "homeB");
const fx = makeHome(homeB);
const beforePkg = readProfilePkg(homeB);
{
  const r = I.installFromDir({ dshHome: homeB, dir: goodDir, log });
  chk(r.ok === true, "安装成功", r.errors.join("; "));
  chk(r.name === "dsh-demo-plugin" && r.version === "1.2.3", "回报的 name/version 正确");

  const dest = path.join(homeB, "plugins", "dsh-demo-plugin");
  chk(fs.existsSync(dest), "落点存在：<dshHome>\\plugins\\<名字>");
  let st = null; try { st = fs.lstatSync(dest); } catch {}
  chk(!!st && !st.isSymbolicLink(), "★ 落点是**真实目录**，不是指向开发机的联接");
  chk(fs.existsSync(path.join(dest, "lib", "client.js")), "文件递归拷全（lib/client.js）");
  chk(fs.existsSync(path.join(dest, "nested", "deep.txt")), "文件递归拷全（嵌套子目录）");

  const pkg = JSON.parse(readProfilePkg(homeB).replace(/^\uFEFF/, ""));
  chk(pkg.dependencies["dsh-demo-plugin"] === "link:" + dest, "① dependencies 写成 link:落点");
  chk(pkg.dsh.profile.bundles.includes("dsh-demo-plugin"), "② bundles 里有它");

  const link = path.join(fx.nm, "dsh-demo-plugin");
  chk(junctionTarget(link) !== null, "③ node_modules 里有联接");
  chk(path.resolve(junctionTarget(link)).toLowerCase() === path.resolve(dest).toLowerCase(),
    "③ 联接指向落点");
  // ★ 不变量：通过联接**真的读得到**文件内容（"文件在那儿"不算证据）
  let throughLink = "";
  try { throughLink = fs.readFileSync(path.join(link, "lib", "client.js"), "utf8"); } catch {}
  chk(throughLink.includes("__fixture__"), "★ 通过 node_modules 的联接真能读到 lib/client.js");

  // ★ BOM
  const bb = firstBytes(path.join(homeB, "profiles", "web", "package.json"));
  chk(!(bb[0] === 0xef && bb[1] === 0xbb && bb[2] === 0xbf),
    "★ profile package.json **无 BOM**（带 BOM = 整台 DSH 起不来）", bb.join(","));

  // 备份
  const bdir = path.join(homeB, "safety", "plugin-install-backup");
  const backups = fs.existsSync(bdir) ? fs.readdirSync(bdir) : [];
  chk(backups.length === 1, "改前备份了一份 profile");
  if (backups.length) {
    const saved = fs.readFileSync(path.join(bdir, backups[0], "package.json"), "utf8");
    chk(saved === beforePkg, "备份内容 == 改之前那份（能退回去）");
    chk(fs.existsSync(path.join(bdir, backups[0], "meta.json")), "备份里留了 meta.json（动作/插件/时间）");
  }

  // 不越界
  const after = JSON.parse(readProfilePkg(homeB).replace(/^\uFEFF/, ""));
  chk(after.dependencies["someone-else-plugin"] === "link:" + fx.foreign, "别人的依赖一字未动");
  chk(after.dependencies["dev-linked"].includes("dev-linked"), "开发机那条 link 一字未动");
  chk(after.dsh.profile.bundles.filter((b) => b === "someone-else-plugin").length === 1,
    "别人的 bundles 条目还在，且没被重复添加");
  chk(after.dsh.profile.bundles[0] === "@deepseek-ai/dsh-base" &&
      after.dsh.profile.bundles[1] === "dsh-web-app", "原有 bundles 的**顺序**没被打乱");
  let st2 = null; try { st2 = fs.lstatSync(path.join(fx.nm, "someone-else-plugin")); } catch {}
  chk(!!st2 && !st2.isSymbolicLink(), "别人的 node_modules 条目仍是原来的真实目录");

  // 幂等
  const r2 = I.installFromDir({ dshHome: homeB, dir: goodDir, log });
  chk(r2.ok === true, "第二次安装也成功");
  chk(r2.changed.length === 0, "★ 幂等：第二次 changed=[]", JSON.stringify(r2.changed));
  chk(!!r2.skipped, "★ 幂等：走的是「内容一致，跳过落位」这条");
  const bdir2 = fs.readdirSync(path.join(homeB, "safety", "plugin-install-backup"));
  chk(bdir2.length === 1, "幂等：没有再多备份一份（没白写盘）");
}

// ─────────────────────────────────────────────────────────────────────────
section("⑤ 落点已是联接时替换 —— ★ 绝不能删掉联接的目标本体");
// ─────────────────────────────────────────────────────────────────────────
const homeC = path.join(root, "homeC");
makeHome(homeC);
{
  const realBody = path.join(root, "elsewhere-real-body");
  fs.mkdirSync(realBody, { recursive: true });
  fs.writeFileSync(path.join(realBody, "MARKER-DO-NOT-DELETE.txt"), "本体在这里\n", "utf8");
  fs.mkdirSync(path.join(homeC, "plugins"), { recursive: true });
  const dest = path.join(homeC, "plugins", "dsh-demo-plugin");
  const mk = spawnSync("cmd", ["/c", "mklink", "/J", dest, realBody], { encoding: "utf8", windowsHide: true });
  chk(mk.status === 0 && junctionTarget(dest) !== null, "（夹具）落点先做成指向别处的联接");

  const r = I.installFromDir({ dshHome: homeC, dir: goodDir, log });
  chk(r.ok === true, "落点是联接时也能装", r.errors.join("; "));
  chk(fs.existsSync(path.join(realBody, "MARKER-DO-NOT-DELETE.txt")),
    "★ 联接的目标**本体没被删掉**（recursive 删联接 = 删本体，这条专防它）");
  let st = null; try { st = fs.lstatSync(dest); } catch {}
  chk(!!st && !st.isSymbolicLink(), "替换后落点是真实目录");

  const u = I.uninstall({ dshHome: homeC, name: "dsh-demo-plugin", log });
  chk(u.ok === true, "卸得掉");
  chk(fs.existsSync(path.join(realBody, "MARKER-DO-NOT-DELETE.txt")),
    "★ 卸载同样没碰对联接的目标本体");
}

// ─────────────────────────────────────────────────────────────────────────
section("⑥ 交叉断言 —— provision() 与 installFromDir() 必须装出**逐字节相同**的 profile");
// ─────────────────────────────────────────────────────────────────────────
{
  const homeP = path.join(root, "homeProvision");
  makeHome(homeP);
  const srcRoot = path.join(root, "src-root");
  fs.mkdirSync(srcRoot, { recursive: true });
  fs.cpSync(goodDir, path.join(srcRoot, "dsh-demo-plugin"), { recursive: true, dereference: true });

  const pr = P.provision({ dshHome: homeP, profile: "web", srcRoot, dev: false, appVersion: "check", log });
  chk(pr.ok === true, "provision() 装成功", (pr.errors || []).join("; "));

  const a = readProfilePkg(homeP);
  const b = readProfilePkg(homeB);
  // ★ 两个家路径不同，而 profile 里存的是**绝对路径** ⇒ 直接比字符串必然不同。
  //   第一版就是这里假 FAIL 的（结构其实一模一样）。比之前先把各自的"家"归一化成 <HOME>。
  const normHome = (s, home) => s.split(home.replace(/\\/g, "\\\\")).join("<HOME>");
  const an = normHome(a, homeP);
  const bn = normHome(b, homeB);
  chk(an === bn, "★ 两条实现写出的 profile\\package.json **逐字节相同**（没分叉）",
    an === bn ? "" : `归一化后仍不同：\n--- provision ---\n${an}\n--- installFromDir ---\n${bn}`);

  const da = path.join(homeP, "plugins", "dsh-demo-plugin");
  const db = path.join(homeB, "plugins", "dsh-demo-plugin");
  chk(P.fingerprint(da) === P.fingerprint(db), "两边的插件落点内容指纹一致");

  const pr2 = P.provision({ dshHome: homeP, profile: "web", srcRoot, dev: false, appVersion: "check", log });
  chk(pr2.changed.length === 0, "provision() 自己也仍然幂等（没被我改坏）");
}

// ─────────────────────────────────────────────────────────────────────────
section("⑦ installFromArchive + sha256 把关");
// ─────────────────────────────────────────────────────────────────────────
const homeD = path.join(root, "homeD");
makeHome(homeD);
{
  const good = I.sha256File(tgz);
  const r = I.installFromArchive({ dshHome: homeD, tgz, expectedSha256: good, log });
  chk(r.ok === true, "sha256 对得上 → 装成功", r.errors.join("; "));
  chk(fs.existsSync(path.join(homeD, "plugins", "dsh-demo-plugin", "lib", "client.js")), "从 tgz 装出来的文件齐全");

  const homeE = path.join(root, "homeE");
  makeHome(homeE);
  const bad = "0".repeat(64);
  const r2 = I.installFromArchive({ dshHome: homeE, tgz, expectedSha256: bad, log });
  chk(r2.ok === false, "sha256 不符 → 拒装");
  chk(/sha256/.test(r2.errors.join(" ")), "拒绝理由点名 sha256");
  chk(!fs.existsSync(path.join(homeE, "plugins", "dsh-demo-plugin")), "★ 拒装时**一个字节都没落盘**");
  const pkgE = JSON.parse(readProfilePkg(homeE).replace(/^\uFEFF/, ""));
  chk(!pkgE.dependencies["dsh-demo-plugin"], "★ 拒装时 profile 也没被动过");

  const homeF = path.join(root, "homeF");
  makeHome(homeF);
  const r3 = I.installFromArchive({ dshHome: homeF, tgz, log });
  chk(r3.ok === true, "不给 sha256 也能装（但降级）");
  chk(r3.warnings.some((w) => /sha256/.test(w)), "★ 不给 sha256 时必须留下警告（第一版把它吞了）");

  const leftovers = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("dsh-plugin-unpack-"));
  chk(leftovers.length === 0, "解包临时目录被清干净", leftovers.join(","));
}

// ─────────────────────────────────────────────────────────────────────────
section("⑧ listInstalled / uninstall");
// ─────────────────────────────────────────────────────────────────────────
{
  const l = I.listInstalled({ dshHome: homeB });
  chk(l.ok === true, "列得出");
  chk(l.plugins.length === 1, "只列我们管的 1 个（开发机那条 link 不算我们的）", JSON.stringify(l.plugins.map((p) => p.name)));
  if (l.plugins.length) {
    const p = l.plugins[0];
    chk(p.name === "dsh-demo-plugin" && p.version === "1.2.3", "名字与版本正确");
    chk(p.enabled === true && p.junctionOk === true && p.dirExists === true, "开着、联接好、落点在");
  }

  const u = I.uninstall({ dshHome: homeB, name: "dsh-demo-plugin", log });
  chk(u.ok === true, "卸载成功", u.errors.join("; "));
  const pkg = JSON.parse(readProfilePkg(homeB).replace(/^\uFEFF/, ""));
  chk(!pkg.dependencies["dsh-demo-plugin"], "① dependencies 里撤掉了");
  chk(!pkg.dsh.profile.bundles.includes("dsh-demo-plugin"), "② bundles 里撤掉了");
  chk(junctionTarget(path.join(fx.nm, "dsh-demo-plugin")) === null, "③ 联接撤掉了");
  chk(!fs.existsSync(path.join(homeB, "plugins", "dsh-demo-plugin")), "落点文件也删了");
  chk(pkg.dependencies["someone-else-plugin"] === "link:" + fx.foreign, "★ 卸载没碰别人的依赖");
  chk(pkg.dsh.profile.bundles.includes("someone-else-plugin"), "★ 卸载没碰别人的 bundles");
  const bb = firstBytes(path.join(homeB, "profiles", "web", "package.json"));
  chk(!(bb[0] === 0xef && bb[1] === 0xbb && bb[2] === 0xbf), "卸载后写的 profile 仍无 BOM");

  const homeG = path.join(root, "homeG");
  makeHome(homeG);
  I.installFromDir({ dshHome: homeG, dir: goodDir, log });
  const u2 = I.uninstall({ dshHome: homeG, name: "dsh-demo-plugin", keepFiles: true, log });
  chk(u2.ok === true, "keepFiles 卸载成功");
  chk(fs.existsSync(path.join(homeG, "plugins", "dsh-demo-plugin")), "keepFiles:true 时落点保留（只脱钩不删文件）");
}

// ─────────────────────────────────────────────────────────────────────────
section("⑨ assertNotCommunityHome —— A 环境一个字节都不许写");
// ─────────────────────────────────────────────────────────────────────────
{
  const savedUP = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const aHome = path.join(root, ".dsh");
  let t1 = false; try { I.assertNotCommunityHome(aHome); } catch { t1 = true; }
  chk(t1, "A 家原样 → 拒");
  let t2 = false; try { I.assertNotCommunityHome(aHome + "\\"); } catch { t2 = true; }
  chk(t2, "A 家带尾斜杠 → 拒（规范化比较）");
  let t3 = false; try { I.assertNotCommunityHome(aHome.toUpperCase()); } catch { t3 = true; }
  chk(t3, "A 家大小写变体 → 拒");
  let t4 = true; try { I.assertNotCommunityHome(path.join(root, "DSH Integrated", "dsh-home")); } catch { t4 = false; }
  chk(t4, "B 风格路径 → 放行");

  const r = I.installFromDir({ dshHome: aHome, dir: goodDir, log });
  chk(r.ok === false && /A 环境/.test(r.errors.join(" ")), "installFromDir 撞上 A 家 → 拒");
  chk(!fs.existsSync(path.join(aHome, "plugins")), "★ 拒的那一刻，A 家下什么都没被创建");
  process.env.USERPROFILE = savedUP;
}

// ─────────────────────────────────────────────────────────────────────────
section("⑩ listInstalled 认不认得出「本地装的」—— 真机上栽过的那一条");
// ─────────────────────────────────────────────────────────────────────────
// 为什么会栽：第一版只认"落点在 <dshHome>\plugins 下"的那一种。
// 拿真实 B 家一跑 ⇒ `已装 0`，而那台机器实际装着 11 个插件（dev 联接 / 本地 tgz / npm）。
// 后果不是少显示几个，是**给已经装着的插件显示「安装」按钮**，一点就覆盖掉用户的 dev link。
{
  const H = path.join(root, "homeSources");
  makeHome(H);
  const nm = path.join(H, "profiles", "web", "node_modules");
  const profileDir = path.join(H, "profiles", "web");
  const nm2 = path.join(profileDir, "node_modules");
  fs.mkdirSync(nm2, { recursive: true });

  // ① 本地目录联接（dev）—— 本体在"仓库"里，不在我们的 store 下
  const devSrc = buildPlugin(path.join(root, "elsewhere-repo", "dsh-dev-linked"), "dsh-dev-linked", "3.1.4");
  fs.symlinkSync(devSrc, path.join(nm2, "dsh-dev-linked"), "junction");

  // ② 本地 tgz（file:，相对 profile 目录）—— 与 dsh-crosshub 同一种写法
  const tgzDir = path.join(profileDir, "plugin-src");
  fs.mkdirSync(tgzDir, { recursive: true });
  const localTgz = packTgz(buildPlugin(path.join(root, "src-local-pkg"), "dsh-local-pkg", "0.4.2"),
    path.join(tgzDir, "dsh-local-pkg-0.4.2.tgz"));
  chk(fs.existsSync(localTgz), "（夹具）造出本地 tgz");
  // pnpm 解包后的目录（我们只关心"读得出它是什么"）
  const unpacked = path.join(nm2, "dsh-local-pkg");
  fs.mkdirSync(unpacked, { recursive: true });
  fs.cpSync(buildPlugin(path.join(root, "src-local-unpacked"), "dsh-local-pkg", "0.4.2"),
    unpacked, { recursive: true, dereference: true });

  // ③ 从 npm 装的
  const regDir = path.join(nm2, "dsh-from-npm");
  fs.mkdirSync(regDir, { recursive: true });
  fs.cpSync(buildPlugin(path.join(root, "src-npm"), "dsh-from-npm", "1.0.7"),
    regDir, { recursive: true, dereference: true });

  // ④ 一个**不是插件**的普通依赖（不该被列出来）
  const plainDir = path.join(nm2, "just-a-lib");
  fs.mkdirSync(plainDir, { recursive: true });
  fs.writeFileSync(path.join(plainDir, "package.json"),
    JSON.stringify({ name: "just-a-lib", version: "1.0.0" }, null, 2) + "\n", "utf8");

  // ⑤ 官方框架包（没有 dsh 字段 ⇒ 也不该被列出来）
  const baseDir = path.join(nm2, "@deepseek-ai", "dsh-base");
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-base", version: "0.1.5" }, null, 2) + "\n", "utf8");

  // 写进 profile
  const pj = JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8"));
  pj.dependencies = {
    ...pj.dependencies,
    "@deepseek-ai/dsh-base": "0.1.5-rc.2",
    "just-a-lib": "^1.0.0",
    "dsh-dev-linked": "link:" + devSrc,
    "dsh-local-pkg": "file:./plugin-src/dsh-local-pkg-0.4.2.tgz",
    "dsh-from-npm": "^1.0.7",
  };
  pj.dsh.profile.bundles.push("dsh-dev-linked", "dsh-local-pkg", "dsh-from-npm");
  fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify(pj, null, 2) + "\n", "utf8");

  const l = I.listInstalled({ dshHome: H, profile: "web" });
  const by = (n) => l.plugins.find((p) => p.name === n);
  chk(l.ok === true, "列得出");
  chk(by("dsh-dev-linked") && by("dsh-dev-linked").source === "local-link",
    "① link: 到仓库外 ⇒ source=local-link", by("dsh-dev-linked") ? by("dsh-dev-linked").source : "没列出来");
  chk(by("dsh-dev-linked") && by("dsh-dev-linked").version === "3.1.4",
    "① 读出了它自己的版本", by("dsh-dev-linked") ? by("dsh-dev-linked").version : "");
  chk(by("dsh-local-pkg") && by("dsh-local-pkg").source === "local-file",
    "② file: 的本地 tgz ⇒ source=local-file", by("dsh-local-pkg") ? by("dsh-local-pkg").source : "没列出来");
  chk(by("dsh-from-npm") && by("dsh-from-npm").source === "registry",
    "③ 版本号 spec ⇒ source=registry", by("dsh-from-npm") ? by("dsh-from-npm").source : "没列出来");
  chk(by("dsh-from-npm") && by("dsh-from-npm").version === "1.0.7", "③ 从 node_modules 读出真版本");
  chk(!by("just-a-lib"), "★ 没有 dsh 字段的普通依赖**不列**");
  chk(!by("@deepseek-ai/dsh-base"), "★ 官方框架包**不列**");
  chk(l.plugins.every((p) => p.source !== "hub" || p.ours === true), "hub 来源才标 ours");
  chk(l.plugins.filter((p) => p.source !== "hub").every((p) => p.ours === false),
    "★ 本地来源的一律 ours=false（`ours` 只表示「是不是我们从仓库装的那一份」）");

  // 一个**我们的**落点在，且读不回来时，必须仍能被列出来（好让界面报「落点丢了」）
  const pj2 = JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8"));
  pj2.dependencies["dsh-gone"] = "link:" + path.join(H, "plugins", "dsh-gone");
  pj2.dsh.profile.bundles.push("dsh-gone");
  fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify(pj2, null, 2) + "\n", "utf8");
  const l2 = I.listInstalled({ dshHome: H, profile: "web" });
  const gone = l2.plugins.find((p) => p.name === "dsh-gone");
  chk(!!gone && gone.source === "hub" && gone.dirExists === false,
    "★ 落点被删掉的自家插件仍然列得出来，且 dirExists=false（界面才能报「落点丢了」）",
    gone ? JSON.stringify({ source: gone.source, dirExists: gone.dirExists }) : "没列出来");

  // resolveDep 的边角
  chk(I.resolveDep(profileDir, nm2, "x", "git+https://example.com/x.git") === null,
    "认不出来的 spec ⇒ null（不猜）");
  chk(I.resolveDep(profileDir, nm2, "x", "") === null, "空 spec ⇒ null（不炸）");
  chk(I.resolveDep(profileDir, nm2, "x", "file:./rel/dir").kind === "file"
    && path.isAbsolute(I.resolveDep(profileDir, nm2, "x", "file:./rel/dir").target),
    "★ file: 的相对路径按 **profile 目录** 解析成绝对路径（pnpm 的规矩）");
}

// ─────────────────────────────────────────────────────────────────────────
section("⑪ 全新 profile **没有** node_modules —— 内核 0.1.7 换布局之后的新用户路");
// ─────────────────────────────────────────────────────────────────────────
// 背景（实测，不是推测）：
//   · 内核 0.1.5 那代启动时会往 `<DSH_HOME>\profiles\web\node_modules` 里装
//     `@deepseek-ai/dsh-base` 那一套 ⇒ 这个目录**总是存在**。
//   · 0.1.7 起模块解析改由 `<DSH_HOME>\profiles\node_modules` 那一层「拦截层」
//     承担，**全新 profile 里根本没有 node_modules**（要等 pnpm 真跑过一次才出现）。
//   · 旧代码一看到它不在就 `errors.push("profile 的 node_modules 不存在")` 然后返回
//     ⇒ **新用户一个插件都装不上**，而开发机（家里早就有它）永远复现不出来。
// 真机日志证据 + 「再起一次内核、问内核自己加载了没有」的端到端在
// `scripts/fresh-install-check.js`；这一段守的是**两个入口的行为**与**回归护栏**。
{
  /** 造一个"内核刚建好、还没装过任何东西"的 profile：只有 package.json，没有 node_modules */
  const freshHome = (name) => {
    const H = path.join(root, name);
    const pd = path.join(H, "profiles", "web");
    fs.mkdirSync(pd, { recursive: true });
    fs.writeFileSync(path.join(pd, "package.json"), JSON.stringify({
      name: "dsh-profile-web", private: true,
      dependencies: { "@deepseek-ai/dsh-base": "0.1.7-rc.2" },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], patchReload: "live" } },
    }, null, 2) + "\n", "utf8");
    return { H, pd, nm: path.join(pd, "node_modules") };
  };

  // ① installFromDir（首启向导 / 设置页走的就是它）
  const A = freshHome("homeFreshA");
  chk(!fs.existsSync(A.nm), "（夹具）这个 profile 确实**没有** node_modules");
  const a1 = I.installFromDir({ dshHome: A.H, profile: "web", dir: buildPlugin(path.join(root, "freshA"), "dsh-fresh-a", "2.0.0") });
  chk(a1.ok === true, "★ installFromDir 在没有 node_modules 的全新 profile 上**成功**",
    JSON.stringify({ ok: a1.ok, errors: a1.errors }));
  chk(fs.existsSync(A.nm) && fs.statSync(A.nm).isDirectory(),
    "★ node_modules 被**自己建出来**了（不是干等内核）");
  chk(!!junctionTarget(path.join(A.nm, "dsh-fresh-a")), "★ 联接也真建出来了");
  chk(!/node_modules 不存在/.test(JSON.stringify(a1.errors)),
    "★ 回归护栏：旧那句「profile 的 node_modules 不存在」没有再出现");

  // ② provision（随包分发那条路，同一种形状的家上也必须能过，且**不再有 pending**）
  const B = freshHome("homeFreshB");
  const srcRoot = path.join(root, "freshSrc");
  buildPlugin(path.join(srcRoot, "dsh-fresh-b"), "dsh-fresh-b", "2.0.0");
  const b1 = P.provision({ dshHome: B.H, profile: "web", srcRoot, appVersion: "test" });
  chk(b1.ok === true && !b1.pending,
    "★ provision 在同样形状的全新 profile 上也不再 pending（旧值 `node_modules-missing`）",
    JSON.stringify({ ok: b1.ok, pending: b1.pending, errors: b1.errors }));
  chk(!!junctionTarget(path.join(B.nm, "dsh-fresh-b")), "★ provision 也真把联接建出来了");

  // ③ 反面：如果那个位置上是**文件**（不是目录），必须拒绝动手，不许覆盖
  const C = freshHome("homeFreshC");
  fs.writeFileSync(C.nm, "not a directory\n", "utf8");
  const c1 = I.installFromDir({ dshHome: C.H, profile: "web", dir: buildPlugin(path.join(root, "freshC"), "dsh-fresh-c", "2.0.0") });
  chk(c1.ok === false && c1.errors.some((e) => /不是目录/.test(e)),
    "★ node_modules 位置上是文件时**拒绝动手**（不覆盖别人的东西）", JSON.stringify(c1.errors));
  chk(fs.readFileSync(C.nm, "utf8") === "not a directory\n", "★ 那个文件一个字节没被改");
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`plugin-install-check：${OK} OK / ${FAILS.length} FAIL`);
if (FAILS.length) {
  console.log("失败项：");
  for (const f of FAILS) console.log(`  · ${f}`);
}
console.log(`临时家：${root}`);
if (!KEEP && !FAILS.length) fs.rmSync(root, { recursive: true, force: true });
else console.log("（保留临时目录以便排查：--keep 或存在失败）");
process.exit(FAILS.length ? 1 : 0);
