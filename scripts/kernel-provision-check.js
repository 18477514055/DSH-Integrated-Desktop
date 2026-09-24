"use strict";

/**
 * kernel-provision-check.js —— 证明「新用户不必敲命令行」这件事**真的成立**
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这个验收
 * ═══════════════════════════════════════════════════════════════════════════
 * 用户 2026-09-25 分发后反馈：「我们这个纯粹的外壳下载之后还得麻烦用户自己去跑
 *   命令行下载前面这两个东西才能用，这里就不比社区版简便了。」
 *
 * 这个脚本要证明的**不是**"代码写对了"，而是**用户拿到 exe 之后真的能直接用**：
 *   ① 随包的 npm 在（打包没漏）
 *   ② 用 Electron 自带的 Node 能跑它（**用户不需要装 Node.js**）
 *   ③ 全新机器（没有内核）⇒ 能真装出一个**能跑的内核**
 *   ④ 装完之后，`kernel.js` 的发现链**真的认得它**（不是"文件在那儿"）
 *   ⑤ 已经有内核时 ⇒ **一个字节都不下**（用户明确要求的那条）
 *   ⑥ 落点在 `<userData>\kernel\` 里，**绝不碰全局 npm 目录 / 安装目录**
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★ 判据是"能不能跑"，不是"文件在不在"
 * ═══════════════════════════════════════════════════════════════════════════
 * 本项目铁律：**"文件存在 / 配置里有 / 版本号对"一律不算证据**。
 * 所以第 ③ 步装完之后，会**真的用 Electron 起一次那个内核**（`--version`），
 * 拿到版本号才算过。第 ④ 步是让 `discoverKernel()` 自己去找（而不是我们拼路径）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 用法（**要联网，会真下 214 MB**）
 * ═══════════════════════════════════════════════════════════════════════════
 *   node scripts/run-electron.js scripts/kernel-provision-check.js
 *   node scripts/run-electron.js scripts/kernel-provision-check.js --keep   # 留住临时家
 *
 * ⚠️ 它**只写临时目录**，绝不碰用户的 `<userData>\kernel`（那是真东西）。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { app } = require("electron");

const KEEP = process.argv.includes("--keep");

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

const REPO = path.join(__dirname, "..");
/** 一个**全新的、空的** userData —— 模拟"新用户刚装完 exe"。 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-kpcheck-"));
app.setPath("userData", TMP);

app.whenReady().then(async () => {
  const KP = require("../src/kernel-provision.js");
  const K = require("../src/kernel.js");

  console.log("kernel-provision-check（真跑，会真下 214 MB）");
  console.log(`临时 userData: ${TMP}`);

  // ═════════════════════════════════════════════════════════════════════
  section("① 随包的 npm 在不在（打包漏了它，整个方案就不成立）");
  // ═════════════════════════════════════════════════════════════════════
  const npmDir = KP.bundledNpmDir({});
  console.log(`  bundledNpmDir = ${npmDir || "(没找到)"}`);
  chk(!!npmDir, "★ 找得到随包的 npm 目录");
  if (!npmDir) {
    console.log("  ⇒ 后面全部无法进行（先跑 node scripts/fetch-npm.js）");
    return finish();
  }
  const npmCli = path.join(npmDir, "bin", "npm-cli.js");
  chk(fs.existsSync(npmCli), "★ bin/npm-cli.js 存在", npmCli);
  chk(fs.existsSync(path.join(npmDir, "node_modules")), "★ node_modules 存在（依赖解出来了）");

  // ═════════════════════════════════════════════════════════════════════
  section("② 用 Electron 自带的 Node 能跑它吗（**用户不需要装 Node.js** 的根据）");
  // ═════════════════════════════════════════════════════════════════════
  const electron = process.execPath;
  console.log(`  electron = ${electron}`);
  {
    const r = spawnSync(electron, [npmCli, "--version"],
      { encoding: "utf8", timeout: 60000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    const out = String(r.stdout || "").trim();
    chk(r.status === 0 && /^\d+\.\d+/.test(out),
      "★★ 真跑：electron.exe + npm-cli.js --version 拿到版本号", `status=${r.status} out=${out}`);
    if (out) console.log(`     npm 版本 = ${out}`);
  }
  // ★ 反面证据：证明这台机器上**没有**把 node 放进 PATH 也能成
  //   （否则"能跑"可能只是借了系统 node 的光，而不是 Electron 的功劳）
  {
    const r = spawnSync("where.exe", ["node"], { encoding: "utf8", timeout: 15000 });
    const hasSystemNode = r.status === 0 && String(r.stdout || "").trim();
    console.log(`  （参考）这台机器上 where node = ${hasSystemNode ? String(r.stdout).split(/\r?\n/)[0].trim() : "没有"}`);
    console.log(`     但上面那次跑用的是 process.execPath = electron.exe，**不是** node`);
  }

  // ═════════════════════════════════════════════════════════════════════
  section("③ 只读体检：全新机器应该报「没找到内核」");
  // ═════════════════════════════════════════════════════════════════════
  const st0 = KP.status({ userDataDir: TMP, kernel: null });
  console.log(`  found=${st0.found} bundledNpm=${st0.bundledNpm} installed=${st0.installed.length} root=${st0.root}`);
  chk(st0.found === false, "★ 全新机器：报「没找到内核」（界面据此默认勾上）");
  chk(st0.bundledNpm === true, "★ 随包 npm 可用（界面才敢给「开始安装」按钮）");
  chk(st0.installed.length === 0, "★ 外壳还没装过任何版本");
  chk(String(st0.root).startsWith(TMP), "★ 落点在本次临时 userData 里（不碰真家）", st0.root);

  // ═════════════════════════════════════════════════════════════════════
  section("④ 真装（214 MB / 约 1.5 分钟）");
  // ═════════════════════════════════════════════════════════════════════
  const lines = [];
  const t0 = Date.now();
  const r = await KP.provision({
    userDataDir: TMP,
    onLine: (s) => { lines.push(s); },
    onProgress: () => {},
    timeoutMs: 20 * 60 * 1000,
  });
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`  用时 ${secs} 秒   ok=${r.ok} ${r.ok ? `version=${r.version}` : `reason=${r.reason}`}`);
  if (!r.ok) {
    console.log("  最后 8 行输出：");
    for (const l of lines.slice(-8)) console.log(`     ${l}`);
  }
  chk(r.ok === true, "★★ 真装成功", r.reason || "");
  if (!r.ok) return finish();

  // ═════════════════════════════════════════════════════════════════════
  section("⑤ 装出来的东西**真能跑**（不是「文件在那儿」）");
  // ═════════════════════════════════════════════════════════════════════
  const bin = r.bin;
  chk(!!bin && fs.existsSync(bin), "★ lib/bin.js 存在", bin || "(没有)");
  {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", DSH_HOME: path.join(TMP, "probe-home") };
    const q = spawnSync(electron, ["--expose-internals", bin, "--version"],
      { encoding: "utf8", timeout: 120000, env });
    const out = String(q.stdout || "").trim();
    chk(q.status === 0 && /^\d+\.\d+/.test(out),
      "★★ 真跑：用 Electron 起这个内核，拿到版本号", `status=${q.status} out=${out} err=${String(q.stderr || "").slice(0, 120)}`);
    if (out) console.log(`     内核自报版本 = ${out}`);
  }
  {
    // ★★ 2026-09-25：这一条第一版**量错了目录**，记在这里。
    //   我量的是 `r.dir`（= `<root>/node_modules/@deepseek-ai/dsh`），
    //   得到"0.0 MB / 10 个文件"就报 FAIL。但那**正是内核包本身** ——
    //   它只有 10 个文件 / 0.05 MB（只是个 CLI 入口），
    //   真正的实现全在它的**兄弟目录**里（`<root>/node_modules/` 下 500+ 个包）。
    //   ⇒ 该量的是 `r.root`（= npm 的 `--prefix` 目录）。
    //   判据本身（"依赖树真的拉下来了"）没错，是**尺子指错了地方**。
    chk(!!r.root, "★ 返回了 root（npm 的 --prefix 目录）—— 统计体积要用它，不是用 dir", r.root || "(没有)");
    const files = [];
    (function walk(d) {
      let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        const p = path.join(d, e.name);
        let isDir = false; try { isDir = fs.statSync(p).isDirectory(); } catch { continue; }
        if (isDir) walk(p); else files.push(p);
      }
    })(r.root || r.dir);
    const bytes = files.reduce((s, f) => { try { return s + fs.statSync(f).size; } catch { return s; } }, 0);
    console.log(`     root 体积 ${(bytes / 1024 / 1024).toFixed(1)} MB / ${files.length} 个文件`);
    chk(files.length > 1000, "★ 依赖树真的拉下来了（内核本体只有 10 个文件，几百个包才算对）",
      `${files.length} 个文件`);
    chk(bytes > 150 * 1024 * 1024, "★ 体积对得上（实测约 214 MB）",
      `${(bytes / 1024 / 1024).toFixed(1)} MB`);
  }

  // ═════════════════════════════════════════════════════════════════════
  section("⑥ 发现链**认得它**（这才是「装了生效」）");
  // ═════════════════════════════════════════════════════════════════════
  const found = K.discoverKernel({ userDataDir: TMP });
  console.log(`  discoverKernel → ${found ? `${found.version}（${found.source}）` : "(没找到)"}`);
  chk(!!found, "★★ 发现链真的找到了外壳装的那个内核");
  if (found) {
    chk(/外壳安装/.test(found.source), "★ 来源标成「外壳安装」（界面能看出是它）", found.source);
    chk(path.resolve(found.dir).toLowerCase().startsWith(path.resolve(TMP).toLowerCase()),
      "★ 找到的就是本次临时家里那份（没串到真家去）", found.dir);
  }

  // ═════════════════════════════════════════════════════════════════════
  section("⑦ 幂等：再装一次 ⇒ **一个字节都不下**（用户明确要求的那条）");
  // ═════════════════════════════════════════════════════════════════════
  {
    const t1 = Date.now();
    const r2 = await KP.provision({ userDataDir: TMP, onLine: () => {}, timeoutMs: 60000 });
    const ms = Date.now() - t1;
    console.log(`  第二次用时 ${ms} ms   ok=${r2.ok} reused=${r2.reused}`);
    chk(r2.ok === true, "第二次也返回成功");
    chk(r2.reused === true, "★★ 明确标了 reused=true（走的「已有就跳过」那条）");
    chk(ms < 5000, "★★ 快到能证明它没下载（< 5 秒）", `${ms} ms`);
  }

  // ═════════════════════════════════════════════════════════════════════
  section("⑧ 已有内核时，体检应报「找到了」并让界面**不勾**");
  // ═════════════════════════════════════════════════════════════════════
  {
    const st1 = KP.status({ userDataDir: TMP, kernel: K.discoverKernel({ userDataDir: TMP }) });
    console.log(`  found=${st1.found} version=${st1.version} source=${st1.source} installed=${st1.installed.length}`);
    chk(st1.found === true, "★ 报「找到了」（界面据此：不勾 + 禁用按钮）");
    chk(st1.installed.length >= 1, "★ 列得出外壳装过的那一版（界面给「删除」后悔药）");
  }

  // ═════════════════════════════════════════════════════════════════════
  section("⑨ 边界：绝不碰别人的东西");
  // ═════════════════════════════════════════════════════════════════════
  {
    // ① 落点必须在 <userData>\kernel\ 里
    chk(path.resolve(r.dir).toLowerCase().startsWith(path.resolve(path.join(TMP, "kernel")).toLowerCase()),
      "★ 内核落在 <userData>\\kernel\\ 里（不碰安装目录、不碰全局 npm）", r.dir);

    // ② 删除的越界闸门：递一个外面的路径必须被拒
    const bad = KP.remove(TMP, "..\\..\\..\\Windows");
    chk(bad.ok === false, "★★ 删除接口拒绝越界路径（只许删 <userData>\\kernel\\ 底下的）", bad.reason || "");

    // ③ 真删一个，确认删得掉（后悔药可用）
    const v = (r.version || "").trim();
    if (v) {
      const del = KP.remove(TMP, v);
      chk(del.ok === true, "★ 删除接口能删掉自己装的那一版", del.reason || "");
      const after = K.discoverKernel({ userDataDir: TMP });
      chk(!after || !/外壳安装/.test(after.source),
        "★ 删完之后发现链不再报「外壳安装」（真删掉了）",
        after ? after.source : "(没找到)");
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  section("⑩ 「下载并安装内核」这个动作（新用户唯一看得见的那条路）");
  // ═════════════════════════════════════════════════════════════════════
  //
  // ★ 为什么要单独验它：全新机器上 `ensureServer()` 会抛「找不到 dsh 内核」，
  //   用户停在**加载页的失败态** —— 那时他还没进过设置页，
  //   所以「运行环境」那一栏再完善也救不了他。这条动作必须挂在加载页的抽屉里。
  //
  // ★ 这里**不重跑 214 MB**（上面 ④ 已经真装过一次了）。验的是**编排逻辑**：
  //   用一份假 ctx 把四种结局都走一遍 —— 成功 / 装了但发现链认不到 / 安装失败 / 装了但重启失败。
  //   「真能装」由 ④⑤⑥ 负责，「编排对不对」由这里负责，两件事分开量。
  {
    const DIAG = require("../src/diagnostics.js");

    // ① 显隐：没有内核才出现，有内核时**必须消失**（否则诱导用户白下 214 MB）
    const noK = DIAG.list({ profile: "web", hasKernel: false }).map((a) => a.id);
    const hasK = DIAG.list({ profile: "web", hasKernel: true }).map((a) => a.id);
    const unk = DIAG.list({ profile: "web" }).map((a) => a.id);
    chk(noK.includes("install-kernel"), "★ 本机没有内核 ⇒ 清单里有「下载并安装内核」", noK.join(", "));
    chk(!hasK.includes("install-kernel"), "★★ 已经有内核 ⇒ 这一条**不出现**（不诱导白下 214 MB）", hasK.join(", "));
    chk(!unk.includes("install-kernel"), "★ 状态未知时也不出现（宁可少一个按钮）", unk.join(", "));

    const meta = DIAG.list({ profile: "web", hasKernel: false }).find((a) => a.id === "install-kernel");
    chk(!!(meta && meta.confirm && meta.danger), "★ 它带确认文案（下 214 MB 是件大事，要先问一句）");
    chk(!!(meta && /214\s*MB/.test(meta.desc)), "★ 说明里写清了体积（约 214 MB）", (meta && meta.desc) || "");

    // ①.1 ★ 两个"有没有内核"是**两件事**，这里钉住它们互不干扰：
    //   有内核但没跑起来（端口被占/插件把它搞崩）时，
    //   「下载并安装内核」必须**消失**（别再下 214 MB），而「浏览器启动」也**该消失**
    //   （没有地址可开）。混用这两个概念会各错一次，都真实发生过。
    {
      const stalled = DIAG.list({ profile: "web", hasKernel: true, hasServer: false }).map((a) => a.id);
      chk(!stalled.includes("install-kernel"),
        "★★ 内核装着但没跑起来 ⇒ **不劝用户再下一份**（install-kernel 不出现）", stalled.join(", "));
      chk(!stalled.includes("browser-open"),
        "★★ 内核没跑 ⇒ 「浏览器启动」也不出现（没有地址可开）", stalled.join(", "));
    }

    // ② 编排：四种结局
    const mkCtx = (prov, restartFails) => {
      const out = [];
      return {
        out,
        ctx: {
          emit: (s, t) => out.push(`${s}:${t}`),
          state: () => ({ profile: "web", serverUrl: restartFails ? null : "http://127.0.0.1:1/?token=x" }),
          provisionKernel: async () => prov,
          restartKernel: async () => { if (restartFails) throw new Error("端口被占"); },
        },
      };
    };

    {
      const { ctx, out } = mkCtx({ ok: true, version: "9.9.9", discovered: { version: "9.9.9", source: "外壳安装（9.9.9）" } }, false);
      const r = await DIAG.run("install-kernel", ctx);
      chk(r.ok === true && r.code === 0, "★ 成功路径：装好 + 发现链认到 + 重启 ⇒ ok", JSON.stringify(r));
      chk(out.some((l) => /重启内核/.test(l)), "★ 输出里说了「现在重启内核让它生效」");
    }
    {
      // ★ 最要紧的一条：**装了但发现链认不到** 不能报成功
      //   （那正是"文件在那儿"≠"装了生效"那条铁律）
      const { ctx } = mkCtx({ ok: true, version: "9.9.9", discovered: null }, false);
      const r = await DIAG.run("install-kernel", ctx);
      chk(r.ok === false && r.code === 2, "★★ 装了但发现链认不到 ⇒ **不报成功**（code 2）", JSON.stringify(r));
    }
    {
      const { ctx } = mkCtx({ ok: false, reason: "npm 退出码 1" }, false);
      const r = await DIAG.run("install-kernel", ctx);
      chk(r.ok === false && r.code === 1 && /npm 退出码 1/.test(r.message),
        "★ 安装失败 ⇒ 如实报原因", JSON.stringify(r));
    }
    {
      // ★ 装成功、只是没起来 ⇒ 必须**分开报**，别让用户以为 214 MB 白下了
      const { ctx } = mkCtx({ ok: true, version: "9.9.9", discovered: { version: "9.9.9", source: "外壳安装（9.9.9）" } }, true);
      const r = await DIAG.run("install-kernel", ctx);
      chk(r.ok === false && r.code === 3 && /已装好/.test(r.message),
        "★★ 装好了但重启失败 ⇒ 明说「已装好」（别让用户以为白下了）", JSON.stringify(r));
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  section("⑪ 接线：main.js 真的把它注进去了吗（**静态可解析 ≠ 动态可用**）");
  // ═════════════════════════════════════════════════════════════════════
  //
  // ★ 铁律：动作在 diagnostics.js 里写好了，但 ctx 里没注入 `provisionKernel`
  //   的话，点下去就是 `ctx.provisionKernel is not a function` ——
  //   而那只有在**全新机器上**才会暴露（开发机永远有内核、这个按钮根本不出现）。
  //   ⇒ 用源码断言把它钉住。这一条不是"文件存在"，是"接线存在"。
  {
    const mainSrc = fs.readFileSync(path.join(REPO, "src", "main.js"), "utf8");
    chk(/provisionKernel:\s*async/.test(mainSrc),
      "★★ main.js 的 buildDiagCtx 里注入了 provisionKernel");
    chk(/KP\.provision\(/.test(mainSrc), "★ 注入的是 kernel-provision.js（不是另写一套）");
    chk(/err\.code\s*=\s*"DSH_KERNEL_MISSING"/.test(mainSrc),
      "★ 缺内核时打了 code 标记（加载页据此自动拉开抽屉）");
    chk(/openDiag:\s*!!noKernel/.test(mainSrc), "★ 那个标记真的推给了加载页");
    const spSrc = fs.readFileSync(path.join(REPO, "src", "status-page.js"), "utf8");
    chk(/st\.openDiag === true/.test(spSrc), "★ 加载页真的读了它并自动拉开抽屉");
  }

  return finish();

  function finish() {
    console.log(`\n${"=".repeat(64)}`);
    console.log(`kernel-provision-check：${OK} OK / ${FAILS.length} FAIL / ${SKIPS.length} SKIP`);
    if (FAILS.length) { console.log("失败项："); for (const f of FAILS) console.log(`  · ${f}`); }
    if (SKIPS.length) { console.log("跳过项（**不算通过**）："); for (const s of SKIPS) console.log(`  · ${s}`); }
    if (KEEP) {
      console.log(`（--keep：临时家保留在 ${TMP}）`);
    } else {
      try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 忽略 */ }
    }
    app.exit(FAILS.length ? 1 : 0);
  }
}).catch((e) => {
  console.error("脚本自己崩了：" + ((e && e.stack) || e));
  app.exit(2);
});
