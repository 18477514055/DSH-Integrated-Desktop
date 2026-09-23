"use strict";

/**
 * kernel.js —— 内核的发现、启动、复用、停止
 *
 * ══════════════════════════════════════════════════════════════════
 * 设计铁律（来自 2026-09-19 两次真实事故的教训）
 * ══════════════════════════════════════════════════════════════════
 *
 * 1. **外壳不拥有内核。**
 *    本文件只做三件事：找内核、起进程、读它的 stdout。
 *    绝不把内核代码放进本仓库，绝不改内核的文件。
 *    （社区版把内核嵌进安装目录，导致"升级内核 = 拆自己地基"。）
 *
 * 2. **绝不与别的内核抢同一个 DSH_HOME。**
 *    内核启动时会调 healProfilesModuleFallback()，把
 *    $DSH_HOME/profiles/node_modules 重写成**当前内核**的世代。
 *    两个不同世代的内核共用同一个 DSH_HOME ⇒ 后启动的会废掉先启动的。
 *    （实测：2026-09-19 一次误指把 ~/.dsh 的 241 个 JUNCTION 全改指了。）
 *
 * 3. **一个端口只允许一个内核。**
 *    启动前先探测；已有 dsh 在跑就复用，绝不起第二个。
 *
 * 4. **会话格式单向升级，不可逆。**
 *    0.1.5 有 v0→v1→v2→v3 迁移链，但 0.1.2 读不了 v3。
 *    所以默认使用**独立 DSH_HOME**，避免把用户的旧会话升成新版后
 *    导致旧内核再也读不了（退路会被毁掉）。
 */

const { spawn, spawnSync, execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** 内核发现顺序（越靠前优先级越高）。 */
function findKernelCandidates(opts = {}) {
  const list = [];

  // ① 调用方显式指定（配置 / 环境变量）
  if (opts.explicitPath) {
    list.push({ path: opts.explicitPath, source: "显式指定" });
  }
  if (process.env.DSH_KERNEL_PATH) {
    list.push({ path: process.env.DSH_KERNEL_PATH, source: "环境变量 DSH_KERNEL_PATH" });
  }

  // ② 应用自带（打包时随包分发；未打包时是 <项目>/vendor/dsh）
  const bundled = opts.bundledPath || path.join(__dirname, "..", "vendor", "dsh");
  if (fs.existsSync(bundled)) {
    list.push({ path: bundled, source: "应用自带" });
  }

  // ③ 全局 npm 安装（%APPDATA%\npm\node_modules\@deepseek-ai\dsh）
  const globalNpm = path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "npm", "node_modules", "@deepseek-ai", "dsh",
  );
  if (fs.existsSync(globalNpm)) {
    list.push({ path: globalNpm, source: "全局 npm" });
  }

  return list;
}

/** 把候选目录解析成可用的内核描述；无效返回 null。 */
function resolveKernel(pkgDir) {
  if (!pkgDir) return null;
  const bin = path.join(pkgDir, "lib", "bin.js");
  if (!fs.existsSync(bin)) return null;

  let version = "未知";
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    if (manifest.version) version = manifest.version;
  } catch {
    /* 版本读不到不算致命，bin 存在就能跑 */
  }
  return { dir: pkgDir, bin, version };
}

/** 按优先级找第一个可用内核。 */
function discoverKernel(opts = {}) {
  for (const c of findKernelCandidates(opts)) {
    const k = resolveKernel(c.path);
    if (k) return { ...k, source: c.source };
  }
  return null;
}

/**
 * 解析 DSH_HOME。
 *
 * ⚠️ 刻意**不读 process.env.DSH_HOME** —— 这是 2026-09-19 事故的直接原因：
 * 本应用自己就是 DSH 起的（或从带该变量的 shell 启动），环境里天然带着
 * DSH_HOME=~/.dsh，会被误判成"用户显式指定"，于是新版内核指向了旧环境。
 *
 * 优先顺序：显式传入 > 应用私有目录（默认）。
 * 想用系统默认 ~/.dsh 必须显式传 useSystemDefault=true。
 */
function resolveDshHome(opts = {}) {
  if (opts.dshHome) return path.resolve(opts.dshHome);

  if (opts.useSystemDefault) {
    return path.join(os.homedir(), ".dsh");
  }

  // 默认：应用私有目录，与 ~/.dsh 完全隔离
  const base = opts.userDataDir || path.join(__dirname, "..", "runtime");
  return path.join(base, "dsh-home");
}

/**
 * 探测某个 URL 上是不是 dsh 在服务。
 *
 * 返回值： "dsh"（活着）/ "dsh-auth"（活着，只是要 token）/ "other"（有响应但不是 dsh）
 *          / "none"（连不上）。
 *
 * ★ 2026-09-19 实测修正（真启动验证，非推断）：dsh web 对**带 token 的地址**返回
 *   **303 → "/" + Set-Cookie**，body 为空。旧版本只认 200/401/403，于是把
 *   "带 token 的地址"一律判成 "other" ⇒ 探活假阴性 ⇒ 触发无谓的内核重启循环。
 *   证据（scripts/probe-diag.js 原始输出）：
 *     GET /?token=…  → 303, location "/", set-cookie 有, body 长度 0
 *     GET /          → 401, body "dsh web authentication required; reopen the URL printed by dsh web."
 *   ⇒ 现在把 3xx 也算活着（token 已被接受、正跳去带 Cookie 的正式页）；
 *     并对 401/403 额外核对 body 特征串，避免把"别的程序占着端口也返 401"误认成 dsh。
 */
async function probeDsh(url, timeoutMs = 4000) {
  const http = require("node:http");
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; if (body.length > 4096) body = body.slice(0, 4096); });
      res.on("end", () => {
        const code = res.statusCode;

        // 200 + 含特征串 ⇒ 是 dsh 前端
        if (code === 200 && /DeepSeek Harness|__DSH_BOOT__/.test(body)) return done("dsh");

        // 3xx ⇒ dsh 把带 token 的地址 303 到 "/" 并下发 Cookie ⇒ 服务确实活着
        if (code >= 300 && code < 400) return done("dsh");

        // 401/403 ⇒ 要 token。核对确实是 dsh 在要（而不是别的程序）
        if (code === 401 || code === 403) {
          if (/dsh web|DeepSeek Harness/i.test(body)) return done("dsh-auth");
          // body 没特征串时不敢断言，给个更保守的判定
          return done("dsh-auth-unconfirmed");
        }
        done("other");
      });
    });
    req.on("error", () => done("none"));
    req.setTimeout(timeoutMs, () => { req.destroy(); done("none"); });
  });
}

/** 探活判定是否表示"内核活着"。 */
function isProbeAlive(v) {
  return v === "dsh" || v === "dsh-auth" || v === "dsh-auth-unconfirmed";
}

/**
 * 把带 token 的地址转成**适合反复探活**的地址。
 *
 * ★ 必须是裸 origin：带 token 的地址是一次性的（303 + Set-Cookie），
 *   反复拿它探活必然拿到 303/失效响应（见 probeDsh 注释里的实测证据）。
 */
function healthTargetUrl(serverUrl) {
  try {
    return new URL(serverUrl).origin + "/";
  } catch {
    return serverUrl;
  }
}

/** 端口是否已被占用。 */
function isPortBusy(port) {
  const r = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
  if (!r.stdout) return false;
  return new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, "i").test(r.stdout);
}

/** 端口此刻由哪个 pid LISTENING。取不到返回 null。 */
function portOwner(port) {
  const r = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
  if (!r.stdout) return null;
  const m = String(r.stdout).match(new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "i"));
  return m ? Number(m[1]) : null;
}

/** 等端口放开。杀完一个内核不能立刻起新的 —— 端口没释放就会撞 EADDRINUSE。 */
async function waitPortFree(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPortBusy(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return !isPortBusy(port);
}

/**
 * 读一个进程的 pid / 父 pid / 完整命令行（**异步**）。
 *
 * Windows 上没有便宜的 Node 原生办法（`wmic` 在新系统上已被移除，
 * `tasklist /V` 不给命令行），所以走一次 WMI 查询 —— 而 PowerShell 冷启动要
 * 几百毫秒，**绝不能同步做**：那会卡住主进程（UI 正在渲染的那一刻尤其明显）。
 * ⇒ 用 `execFile` 异步拿结果；调用方（认领）本来也不需要等它。
 *
 * @returns {Promise<{pid:number, ppid:number, cmd:string}|null>}
 */
function processInfo(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(null);
    const ps = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue; ` +
      `if ($null -eq $p) { 'null' } else { $p | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress }`;
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const out = String(stdout || "").trim();
        if (!out || out === "null") return resolve(null);
        try {
          const o = JSON.parse(out);
          resolve({ pid: o.ProcessId, ppid: o.ParentProcessId, cmd: String(o.CommandLine || "") });
        } catch { resolve(null); }
      });
  });
}

/**
 * **这个 pid 是不是"本外壳自己拉起来的内核"？**
 *
 * 为什么要这么麻烦（2026-09-23，用户报「无法彻底退出 dsh」的现场）：
 * 端口上有一个内核在跑，但外壳没有它的记录 ⇒ 走「裸 origin 复用」⇒
 * `serverOwned = false` ⇒ 退出时谁都不关它。**它到底是我们的还是别人的，
 * 决定我们有没有权力关它** ——
 *   · 我们自己 spawn 的内核（含内核自身脱离式重启留下的孤儿）：命令行是
 *     我们这个 exe + `--expose-internals` + `bin.js` + 同一个端口 ⇒ 可以关；
 *   · 用户在终端里自己 `dsh web` 起的（命令行是 node.exe）⇒ **一个字都不许动**。
 *
 * 三条判据缺一不可。取不到命令行时返回 ok=false（**认不出就不认领**，
 * 宁可少关一个，也绝不误关别人的内核）。
 *
 * @returns {{ok:boolean, why:string, info:object|null}} 用 await 取
 */
async function ourKernelProcess(pid, port) {
  const info = await processInfo(pid);
  if (!info) return { ok: false, why: "取不到它的命令行（WMI 查询没结果）", info: null };

  const m = info.cmd.match(/^\s*"([^"]+)"/) || info.cmd.match(/^\s*(\S+)/);
  const exe = m ? m[1] : "";
  if (!exe) return { ok: false, why: "命令行里读不出可执行文件", info };

  // ★⚠️ 判据**只用 ASCII 片段**，绝不拿完整路径去逐字节比 —— 实测踩过：
  //   WMI 的 CommandLine 经 PowerShell 往返之后，路径里的中文段会被改掉
  //   （本机控制台里 `5.DSH集成桌面端` 一直显示成乱码），
  //   ⇒ `exe.toLowerCase() === process.execPath.toLowerCase()` **永远为假**，
  //   于是"本应用自己的内核"一次都认领不到（第一版就是这么错的）。
  //   改成比**文件名**（`electron.exe` / `DSH Integrated.exe` / `node.exe` 都是 ASCII），
  //   足够把"我们的 exe"与"用户在终端里用 node 起的内核"分开。
  const want = path.basename(String(process.execPath)).toLowerCase();
  const got = path.basename(exe).toLowerCase();
  if (!want || !got || !exe.toLowerCase().endsWith(want)) {
    return { ok: false, why: `它的可执行文件不是本外壳（是 ${path.basename(exe) || "?"}）`, info };
  }
  if (!/--expose-internals/i.test(info.cmd)) {
    return { ok: false, why: "命令行里没有 --expose-internals（不是按内核方式起的）", info };
  }
  if (!/lib[\\/]bin\.js/i.test(info.cmd)) {
    return { ok: false, why: "命令行里没有 dsh 的 lib/bin.js（不是内核进程）", info };
  }
  if (!new RegExp(`--port\\s+${Number(port)}(\\s|$)`, "i").test(info.cmd)) {
    return { ok: false, why: `命令行里的端口不是 ${port}`, info };
  }
  return { ok: true, why: "可执行文件与命令行都指向本外壳拉起来的内核", info };
}

/**
 * 启动内核。
 *
 * 返回 { child, url, logFile }；url 是**带 token 的完整地址**。
 * 调用方负责在失败时 killTree。
 */
function spawnKernel({ kernel, dshHome, port, profile = "web", logDir, workspace, detached = false }) {
  fs.mkdirSync(dshHome, { recursive: true });

  // ★ detached：后台化启动 —— 不写日志文件、丢弃 stdio，并且**脱离父进程的 job 对象**
  //   （libuv 对 Windows 的 detached 会加 CREATE_BREAKAWAY_FROM_JOB + DETACHED_PROCESS
  //   + CREATE_NEW_PROCESS_GROUP）⇒ 父进程死了它也不会被一起带走。
  //   正常路径**不用它**（默认 false），只有验收脚本 `scripts/quit-check.js` 靠它
  //   造出「孤儿内核」这个现场。为什么要造：见那个脚本的顶部说明。
  let out = null, err = null, logFile = null;
  if (!detached) {
    fs.mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    logFile = path.join(logDir, `kernel-${stamp}.log`);
    out = fs.openSync(logFile, "a");
    err = fs.openSync(logFile.replace(/\.log$/, ".err.log"), "a");
  }

  // ★ 参数语法（实测）：`web` 是别名子命令，与 `--profile` **互斥**
  //   ✅ dsh web --host ...          ✅ dsh --profile clean --host ...
  //   ❌ dsh web --profile clean     （报 "web takes none of parent --profile"）
  const args = [];
  if (profile === "web") {
    args.push("web");
  } else {
    args.push("--profile", profile);
  }
  args.push("--host", "127.0.0.1", "--port", String(port), "--no-open");

  const child = spawn(process.execPath, ["--expose-internals", kernel.bin, ...args], {
    cwd: workspace || dshHome,
    env: {
      ...process.env,
      // ★ 显式指定 —— 绝不依赖环境里已有的值（见 resolveDshHome 的注释）
      DSH_HOME: dshHome,
      // 用 Electron 自带的 node 跑内核，不需要用户另装 node
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: detached ? "ignore" : ["ignore", out, err],
    windowsHide: true,
    detached,
  });

  return { child, logFile, out, err };
}

/** 结束内核进程树（Windows 下必须 /T，否则 npx 链会留孤儿）。 */
function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore",
      });
    } catch { /* 已退出 */ }
  }
  try { child.kill(); } catch { /* 已退出 */ }
}

/** 从日志里等出 "dsh web: http://..." 那行，返回带 token 的地址。 */
async function waitForUrl(logFile, child, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) return null;   // 已退出，不可能再出地址
    try {
      const raw = fs.readFileSync(logFile, "utf8");
      const m = raw.match(/dsh web: (https?:\/\/\S+)/);
      if (m) return m[1];
    } catch { /* 文件还没建 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** 读日志尾部，用于失败时给用户看原因。 */
function tailLog(logFile, lines = 30) {
  const candidates = [logFile.replace(/\.log$/, ".err.log"), logFile];
  for (const f of candidates) {
    try {
      const txt = fs.readFileSync(f, "utf8").trim();
      if (txt) return txt.split(/\r?\n/).slice(-lines).join("\n");
    } catch { /* 试下一个 */ }
  }
  return "";
}

module.exports = {
  findKernelCandidates,
  resolveKernel,
  discoverKernel,
  resolveDshHome,
  probeDsh,
  isProbeAlive,
  healthTargetUrl,
  isPortBusy,
  portOwner,
  waitPortFree,
  processInfo,
  ourKernelProcess,
  spawnKernel,
  killTree,
  waitForUrl,
  tailLog,
};
