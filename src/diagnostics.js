"use strict";

/**
 * diagnostics.js —— 「诊断与修复」的动作清单与执行器（**主进程侧**）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这份文件是外壳的安全核心，改之前先读完
 * ══════════════════════════════════════════════════════════════════
 * 页面（加载页 / 设置页）**只能提交一个动作 id**，永远拿不到命令字符串。
 * id → 具体做什么，全部写死在本文件的 `ACTIONS` 里。
 * 所以即便页面被注入了脚本，它能做的也只是"按我们本来就提供的按钮"。
 * （`preload.js` 也只暴露 id 级接口；`main.js` 的 `assertShellSender`
 *   还会再判一次调用来源。）
 *
 * ══════════════════════════════════════════════════════════════════
 * 两条纪律（照 `$DSH_HOME/AGENTS.md` 的事故教训）
 * ══════════════════════════════════════════════════════════════════
 * 1. **会打断用户的操作必须让用户自己按。**
 *    所以这里只"提供按钮"，绝不在启动/自检流程里自己调它们。
 *    凡会中断当前回答的（重启内核 / 纯净启动 / 切保底客户端）都带
 *    `confirm`，页面必须先弹确认。
 *
 * 2. **凡有回退路径的，回退必须一起做且被验证过。**
 *    `clean-start` 失败时会**自动退回原档案**（见 `run()`），
 *    不让用户卡在一个起不来的档案里。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

// ── 常量 ──────────────────────────────────────────────────────────
/** 保底（社区版）的安装目录；`fallback-client` 用 */
const COMMUNITY_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "Programs", "DeepSeek Harness");
/** 体检脚本在保底家里（只读脚本，两边内容由 dsh-sync-homes.ps1 保证一致） */
const HEALTH_SCRIPT = path.join(os.homedir(), ".dsh", "safety", "dsh-home-check.ps1");
/** 纯净档案的声明：只挂两个官方 bundle，第三方插件一个都不加载 */
const CLEAN_PROFILE_DIRNAME = "clean";

let current = null;   // 正在跑的子进程（用于 cancel）

// ── 动作清单 ──────────────────────────────────────────────────────
/**
 * 元数据。`run` 在下面按 id 分派（不放在这里，避免把函数暴露给渲染进程）。
 * danger=true 表示"会中断用户当前正在做的事"，页面必须显示确认。
 */
const ACTIONS = [
  {
    id: "restart-kernel",
    label: "重启内核",
    desc: "杀掉当前内核并重新拉起。改过插件/配置后想让它们生效时用这条。会中断正在生成的回答。",
    danger: true,
    confirm: "重启内核会中断正在生成的回答。确定继续？",
  },
  {
    id: "clean-start",
    label: "纯净启动",
    desc: "用 clean 档案启动：只加载官方基础插件，第三方插件一个都不加载。用来判断「问题是不是第三方插件造成的」。",
    danger: true,
    confirm: "纯净启动会中断当前回答，并暂时换用 clean 档案（第三方插件全部不加载）。确定继续？",
  },
  {
    id: "exit-clean",
    label: "退出纯净模式",
    desc: "当前跑在 clean 档案上，这条会切回 web 档案（加载全部第三方插件）。",
    danger: true,
    confirm: "切回 web 档案会重启内核并中断当前回答。确定继续？",
  },
  {
    id: "browser-open",
    label: "浏览器启动",
    desc: "用系统默认浏览器打开当前内核地址。外壳界面出问题时可以用它接着干活。",
    danger: false,
  },
  {
    id: "health-check",
    label: "环境体检",
    desc: "跑只读体检脚本 dsh-home-check.ps1，检查两个 DSH 家的世代、模块镜像、守卫脚本有没有被冲掉。什么都不改。",
    danger: false,
  },
  {
    id: "open-dsh-home",
    label: "打开 DSH_HOME 目录",
    desc: "用资源管理器打开当前内核的数据目录（会话/配置/插件都在这里）。",
    danger: false,
  },
  {
    id: "open-logs",
    label: "打开日志目录",
    desc: "用资源管理器打开外壳与内核的日志目录。",
    danger: false,
  },
  {
    id: "copy-diag",
    label: "复制诊断信息",
    desc: "把版本/端口/DSH_HOME/档案 + 最近日志尾部打包成一份文本：复制到剪贴板，同时存成文件并打开所在目录。",
    danger: false,
  },
  {
    id: "fallback-client",
    label: "切到保底客户端",
    desc: "启动社区版 DeepSeek Harness（保底通道）。集成客户端出大事时用这条。",
    danger: true,
    confirm: "这会另外启动社区版客户端（它读写的是保底环境 ~/.dsh）。建议先把集成客户端退出，避免两个内核同时写同一个家。确定继续？",
  },
];

/**
 * 列出动作（按当前状态裁剪）。
 * @param {{profile?: string, hasKernel?: boolean}} state
 */
function list(state = {}) {
  const inClean = state.profile === CLEAN_PROFILE_DIRNAME;
  return ACTIONS
    .filter((a) => {
      if (a.id === "clean-start") return !inClean;
      if (a.id === "exit-clean") return inClean;
      if (a.id === "browser-open") return state.hasKernel !== false;
      return true;
    })
    .map(({ id, label, desc, danger, confirm }) => ({ id, label, desc, danger: !!danger, confirm: confirm || null }));
}

function meta(id) {
  return ACTIONS.find((a) => a.id === id) || null;
}

// ── 小工具 ────────────────────────────────────────────────────────
function runStreaming(ctx, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, ...opts });
    } catch (e) {
      resolve({ ok: false, code: -1, message: `无法启动 ${cmd}: ${(e && e.message) || e}` });
      return;
    }
    current = child;
    child.stdout.on("data", (d) => ctx.emit("out", d.toString("utf8")));
    child.stderr.on("data", (d) => ctx.emit("err", d.toString("utf8")));
    child.on("error", (e) => {
      current = null;
      resolve({ ok: false, code: -1, message: `进程错误: ${(e && e.message) || e}` });
    });
    child.on("close", (code) => {
      current = null;
      resolve({ ok: code === 0, code, message: "" });
    });
  });
}

function findCommunityExe() {
  if (!fs.existsSync(COMMUNITY_DIR)) return { ok: false, why: `目录不存在: ${COMMUNITY_DIR}` };
  let names;
  try { names = fs.readdirSync(COMMUNITY_DIR); }
  catch (e) { return { ok: false, why: `读不到目录: ${(e && e.message) || e}` }; }
  const exes = names.filter((n) => /\.exe$/i.test(n));
  // 排除卸载器与辅助程序，优先名字里带 Harness / DeepSeek 的那个
  const preferred = exes.filter((n) => !/uninstall|crashpad|elevate|squirrel/i.test(n));
  const hit = preferred.find((n) => /harness|deepseek/i.test(n));
  const pick = hit || (preferred.length === 1 ? preferred[0] : null);
  if (!pick) {
    return { ok: false, why: `在 ${COMMUNITY_DIR} 里认不出主程序，候选: ${exes.join(", ") || "(没有 exe)"}` };
  }
  return { ok: true, path: path.join(COMMUNITY_DIR, pick) };
}

function tailFile(file, maxLines) {
  try {
    if (!fs.existsSync(file)) return `(文件不存在: ${file})`;
    let text = fs.readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const lines = text.split(/\r?\n/);
    const tail = lines.slice(Math.max(0, lines.length - maxLines));
    return tail.join("\n") + (lines.length > maxLines ? `\n…（共 ${lines.length} 行，只取最后 ${maxLines} 行）` : "");
  } catch (e) {
    return `(读日志失败: ${(e && e.message) || e})`;
  }
}

/** 写纯净档案的 3 个声明文件（只补缺失的，不覆盖已存在的）。 */
function ensureCleanProfile(dshHome, ctx) {
  const dir = path.join(dshHome, "profiles", CLEAN_PROFILE_DIRNAME);
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    "package.json": JSON.stringify({
      name: "dsh-profile-clean",
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
          patchReload: "startup",
        },
      },
    }, null, 2) + "\n",
    "cordis.yml": "# dsh profile root —— 空条目表。\n# 配置树由 patch 组合而成：package.json 的 dsh.profile.bundles，然后 cordis.patch.yml。\n# 要改请改 cordis.patch.yml，不要改本文件。\n[]\n",
    "cordis.patch.yml": "[]\n",
  };
  const created = [];
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, body, "utf8");
      created.push(name);
    }
  }
  ctx.emit("sys", created.length
    ? `纯净档案已补齐: ${created.join(", ")}  → ${dir}\n`
    : `纯净档案已存在，未改动: ${dir}\n`);
  ctx.emit("sys", "（node_modules 镜像由内核启动时自己建立，这里不碰。）\n");
  return dir;
}

// ── 执行 ──────────────────────────────────────────────────────────
/**
 * 执行一个动作。
 * @param {string} id
 * @param {object} ctx - 由 main.js 注入的上下文（见 main.js 的 buildDiagCtx）
 * @returns {Promise<{ok:boolean, code:number, message:string}>}
 */
async function run(id, ctx) {
  const m = meta(id);
  if (!m) return { ok: false, code: -1, message: `未知动作: ${id}` };

  switch (id) {
    // ── 重启内核 ────────────────────────────────────────────────
    case "restart-kernel": {
      ctx.emit("sys", `重启内核（档案 ${ctx.state().profile}）…\n`);
      try {
        await ctx.restartKernel({ profile: ctx.state().profile });
        ctx.emit("sys", `完成。内核: ${ctx.state().serverUrl || "?"}\n`);
        return { ok: true, code: 0, message: "内核已重启" };
      } catch (e) {
        return { ok: false, code: 1, message: `重启失败: ${(e && e.message) || e}` };
      }
    }

    // ── 纯净启动（失败自动回退）────────────────────────────────
    case "clean-start": {
      const dshHome = ctx.state().dshHome;
      const prev = ctx.state().profile;
      ensureCleanProfile(dshHome, ctx);
      ctx.emit("sys", `从档案「${prev}」切到「${CLEAN_PROFILE_DIRNAME}」并重启内核…\n`);
      try {
        await ctx.restartKernel({ profile: CLEAN_PROFILE_DIRNAME });
        ctx.emit("sys", "完成。当前为纯净模式（第三方插件未加载）。\n");
        return { ok: true, code: 0, message: "已进入纯净模式" };
      } catch (e) {
        // ★ 回退路径：不能让用户卡在一个起不来的档案里
        ctx.emit("err", `纯净启动失败: ${(e && e.message) || e}\n`);
        ctx.emit("sys", `自动回退到档案「${prev}」…\n`);
        try {
          await ctx.restartKernel({ profile: prev });
          ctx.emit("sys", "已回退，界面恢复正常。\n");
          return { ok: false, code: 2, message: `纯净启动失败，已自动回退到「${prev}」` };
        } catch (e2) {
          return { ok: false, code: 3, message: `纯净启动失败，回退也失败: ${(e2 && e2.message) || e2}` };
        }
      }
    }

    // ── 退出纯净模式 ───────────────────────────────────────────
    case "exit-clean": {
      ctx.emit("sys", "切回 web 档案（加载全部第三方插件）并重启内核…\n");
      try {
        await ctx.restartKernel({ profile: "web" });
        ctx.emit("sys", "完成。当前为 web 档案。\n");
        return { ok: true, code: 0, message: "已退出纯净模式" };
      } catch (e) {
        return { ok: false, code: 1, message: `切回失败: ${(e && e.message) || e}` };
      }
    }

    // ── 浏览器启动 ─────────────────────────────────────────────
    case "browser-open": {
      const url = ctx.state().serverUrl;
      if (!url) return { ok: false, code: 1, message: "内核还没就绪，没有可打开的地址" };
      ctx.emit("sys", `用系统浏览器打开: ${url}\n`);
      await ctx.openExternal(url);
      return { ok: true, code: 0, message: "已在系统浏览器中打开" };
    }

    // ── 环境体检 ───────────────────────────────────────────────
    case "health-check": {
      if (!fs.existsSync(HEALTH_SCRIPT)) {
        return { ok: false, code: 1, message: `找不到体检脚本: ${HEALTH_SCRIPT}` };
      }
      ctx.emit("sys", `体检脚本: ${HEALTH_SCRIPT}\n（只读，不会改动任何东西）\n\n`);
      const r = await runStreaming(ctx, "powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", HEALTH_SCRIPT,
      ]);
      const explain = { 0: "全绿", 2: "有警告", 3: "有严重问题" }[r.code];
      if (r.code === 0 || r.code === 2 || r.code === 3) {
        ctx.emit("sys", `\n体检结论: ${explain}（退出码 ${r.code}）\n`);
        return { ok: r.code === 0, code: r.code, message: `体检完成：${explain}` };
      }
      return { ok: false, code: r.code, message: `体检脚本异常退出（码 ${r.code}）` };
    }

    // ── 打开目录 ───────────────────────────────────────────────
    case "open-dsh-home": {
      const p = ctx.state().dshHome;
      const err = await ctx.openPath(p);
      return err ? { ok: false, code: 1, message: `打开失败: ${err}` }
                 : { ok: true, code: 0, message: `已打开 ${p}` };
    }
    case "open-logs": {
      const p = ctx.state().logDir;
      fs.mkdirSync(p, { recursive: true });
      const err = await ctx.openPath(p);
      return err ? { ok: false, code: 1, message: `打开失败: ${err}` }
                 : { ok: true, code: 0, message: `已打开 ${p}` };
    }

    // ── 复制诊断信息 ───────────────────────────────────────────
    case "copy-diag": {
      const s = ctx.state();
      const lines = [
        `# DSH 集成桌面端 · 诊断信息`,
        `生成时间 : ${new Date().toISOString()}`,
        ``,
        `## 外壳`,
        `外壳版本   : ${s.appVersion}`,
        `Electron   : ${s.electronVersion}`,
        `Chrome     : ${s.chromeVersion}`,
        `Node       : ${s.nodeVersion}`,
        `平台       : ${s.platform} ${s.arch}`,
        `userData   : ${s.userDataDir}`,
        ``,
        `## 内核`,
        `内核地址   : ${s.serverUrl || "(未启动)"}`,
        `内核版本   : ${s.kernelVersion || "(未知)"}`,
        `内核路径   : ${s.kernelDir || "(未知)"}`,
        `内核来源   : ${s.kernelSource || "(未知)"}`,
        `本次托管   : ${s.serverOwned ? "是（本应用拉起）" : "否（复用已有实例）"}`,
        `探活       : ${s.healthFails} 次连续失败`,
        ``,
        `## 环境`,
        `DSH_HOME   : ${s.dshHome}`,
        `档案       : ${s.profile}`,
        `端口       : ${s.port}`,
        `工作目录   : ${s.workspace}`,
        `日志目录   : ${s.logDir}`,
        `保底客户端 : ${s.communityExe || "(未找到)"}`,
        ``,
        `## 设置`,
        "```json",
        JSON.stringify(s.settings, null, 2),
        "```",
        ``,
        `## 外壳日志尾部（shell.log）`,
        "```",
        tailFile(path.join(s.userDataDir, "shell.log"), 80),
        "```",
        ``,
        `## 内核日志尾部`,
        "```",
        s.kernelLogFile ? tailFile(s.kernelLogFile, 80) : "(本次没有内核日志文件)",
        "```",
        ``,
        `## 崩溃日志尾部（crash.log，若有）`,
        "```",
        tailFile(path.join(s.userDataDir, "crash.log"), 40),
        "```",
        ``,
      ];
      const text = lines.join("\n");

      const outDir = path.join(s.userDataDir, "diagnostics");
      fs.mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outFile = path.join(outDir, `diag-${stamp}.txt`);
      fs.writeFileSync(outFile, text, "utf8");

      ctx.clipboardWrite(text);
      ctx.emit("sys", text);
      ctx.emit("sys", `\n—— 已复制到剪贴板，并存成文件：\n   ${outFile}\n`);
      await ctx.openPath(outDir);
      return { ok: true, code: 0, message: `诊断信息已复制，并存到 ${outFile}` };
    }

    // ── 切到保底客户端 ─────────────────────────────────────────
    case "fallback-client": {
      const found = findCommunityExe();
      if (!found.ok) {
        ctx.emit("err", `找不到社区版客户端：${found.why}\n`);
        return { ok: false, code: 1, message: `找不到社区版客户端：${found.why}` };
      }
      ctx.emit("sys", `启动: ${found.path}\n`);
      try {
        const child = spawn(found.path, [], { detached: true, stdio: "ignore", windowsHide: false });
        child.unref();
      } catch (e) {
        return { ok: false, code: 1, message: `启动失败: ${(e && e.message) || e}` };
      }
      return { ok: true, code: 0, message: "已启动保底客户端" };
    }

    default:
      return { ok: false, code: -1, message: `未实现的动作: ${id}` };
  }
}

/** 中止正在跑的动作（目前只有体检会跑长时间子进程）。 */
function cancel() {
  if (!current) return false;
  try { current.kill(); } catch (e) { /* 已经结束 */ }
  current = null;
  return true;
}

module.exports = { list, run, cancel, findCommunityExe, HEALTH_SCRIPT, COMMUNITY_DIR };
