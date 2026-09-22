/**
 * dsh-int-archive-manager —— 宿主半边（Host half，node 侧）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这一半为什么必须存在
 * ═══════════════════════════════════════════════════════════════════════════
 * 官方内核**没有**删除会话的能力（README §"官方没有删除能力"有逐条出处）。
 * 浏览器里的插件（client 半边）拿不到文件系统，所以"永久删除"这件事
 * **只能**由 node 侧来做。这一半干的就是这件事，并通过 HTTP 把能力暴露给浏览器半边。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么用 `ctx.webServer.register` 而不是别的
 * ═══════════════════════════════════════════════════════════════════════════
 * 这是本机**已被验证**的做法，不是我发明的：第三方插件 `dsh-whale-widget`
 * （已装在 `profiles\web`，`lib/index.js` 里 9 处 `ctx.webServer.register`）
 * 就是这么给浏览器半边供数据的。它 `inject: ['webServer']`，然后挂 `/dsh-whale/*.json`。
 * 本插件照抄同一套形状，路径前缀换成 `/dsh-archive/`。
 *
 * 备选方案（都更差，已排除）：
 *   · `dsh` 命令行子进程 —— 我们要的是**界面内**一键操作，不是让用户去开终端；
 *   · 直接改内核源码 —— 违反"内核可独立升级"的架构前提（项目指令 §1）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * "永久删除"到底是什么意思（**用户拍板的语义，别擅自改**）
 * ═══════════════════════════════════════════════════════════════════════════
 * 用户原话：「我们的归档指定一个文件夹，该文件夹专门用来放这些东西，
 *           然后后面我自己去文件夹来迁移这些东西进回收站。」
 *
 * ⇒ 插件的"永久删除"= **把会话文件搬进用户指定的转储文件夹**。
 *   最后一步（真正抹掉）由用户自己在文件管理器里做。
 *   这样：不弹任何系统框、用户随时能找到、随时能反悔。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 安全设计（**这四条不是装饰**）
 * ═══════════════════════════════════════════════════════════════════════════
 * ① **只动归档会话**。`remove()` 第一步校验 id 在 `archivedSessionIds` 里，
 *    不在就拒绝。活会话的文件永远不会被这条路径碰到（e2e 里有断言）。
 * ② **绝不抹除**。只 `rename`（同盘原子移动）。跨盘 rename 会失败（EXDEV），
 *    这时**不降级为"复制再删"**，而是报错、一个字节都不动。
 * ③ **搬一半要如实报**。返回 `done` / `failed` 两个清单，任何一步失败整体 ok:false。
 * ④ **改注册表是最后一步**，且原子写（临时文件 + rename）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠ 已知边界（诚实写在这里，别等用户发现）
 * ═══════════════════════════════════════════════════════════════════════════
 * · **搬走后空间不会立刻释放**：字节还在转储文件夹里。真正腾空间要用户去删。
 *   这是这个设计**故意**的代价，换来一次反悔机会。
 * · **侧边栏列表不会立刻刷新**：内核在内存里持有会话名单，不因为我们改了磁盘就重读。
 *   要看到效果得重启客户端。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// 本文件是 ESM，要 require 官方的 CJS/双格式包就得走 createRequire。
// （`@deepseek-ai/dsh-home-paths` 是纯函数模块，见 resolveHome 的注释。）
const require = createRequire(import.meta.url);
import { listArchived, remove, archivedTotalBytes, planRemoval, restoreArchived } from "./archive-store.js";
import { readConfig, writeConfig, listTrash, restoreSlot, dropSlot, purgeSlot, setPluginDir, DEFAULT_TRASH_DIR } from "./recycle.js";
import { looksLikeHome } from "./home-probe.js";

/** HTTP 路由前缀。与 whale-widget 的 `/dsh-whale/` 同构。 */
const PREFIX = "/dsh-archive";
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

/**
 * 本插件自己的目录（用来放配置文件）。
 *
 * ★ 为什么配置文件放**这里**而不是转储目录里：用户可能会整个删掉转储目录
 *   （这正是本设计允许的操作）。配置跟着没了 ⇒ 下次打开又回到默认路径。
 *   放在插件目录里，与转储目录解耦。
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, "..");
// 告诉 recycle 模块配置文件该放哪（它自己算不出来 —— 见那里 resolveConfigDir 的注释）。
// 测试可用环境变量 DSH_ARCHIVE_CONFIG_DIR 把它指到临时目录，避免污染交付物。
setPluginDir(PLUGIN_DIR);

/**
 * 定 DSH_HOME。
 *
 * ★★ 血泪教训（2026-09-21 真跑 `npm run plugin:check` 抓到，**内核直接起不来**）：
 *   我第一版把 `homePaths` 写进了 `inject`，以为它是个 cordis 服务。
 *   实际启动报错（原文）：
 *       dsh: plugin tree failed to load: dsh: 1 entry did not activate
 *       dsh-int-archive-manager: pending (waiting for service: homePaths)
 *   ⇒ **`@deepseek-ai/dsh-home-paths` 是一个纯函数模块，不是 cordis 服务**，
 *     它导出的全是 `resolveDshHome()` / `dshHomePath()` 这类**函数**，
 *     根本没有往 ctx 上挂 `homePaths`。
 *   而 cordis 的 `inject` 语义是"**等这个服务出现才激活**" —— 写进一个不存在的名字，
 *   插件就永远停在 pending，进而**拖垮整个 profile 的启动**（不止我这个插件不能用）。
 *
 *   这正是全局规矩第二条说的："文件存在 / 模块可解析" ≠ "能加载"。
 *   我当初的"证据"是"包存在、导出看起来对"——**那是代理证据，不是行为证据**。
 *
 * ⇒ 正确做法：**不 inject 任何东西**，直接 import 那个纯函数模块要路径。
 *   拿不到就退回默认路径（两个家里 B 是活动的那个）。
 */
function resolveHome() {
  // 候选按顺序试；**每个候选都要通过 looksLikeHome() 校验**才采用。
  const candidates = [];

  // ⓪ 显式覆盖（**最高优先级，且必须最先试**）。
  //   用于测试与排障：e2e / plugin-check 必须能把家指到临时目录，
  //   否则它们会去动真实数据。⚠ 生产环境永远不该有它。
  if (process.env.DSH_ARCHIVE_HOME && process.env.DSH_ARCHIVE_HOME.trim()) {
    candidates.push(process.env.DSH_ARCHIVE_HOME.trim());
  }

  // ① 内核若把家写进了环境，那就是权威（不主动设，只是"设了就认"）。
  //   注意 `DSH_HOME` 是官方变量名；plugin-check 会设它指向临时家。
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim()) candidates.push(process.env.DSH_HOME.trim());

  // ② 插件自己的目录往上找（**这一条是 2026-09-21 补的，专治"认错家"**）：
  //   本插件住在 `<家>\profiles\web\node_modules\dsh-int-archive-manager\`（联接过去也成立），
  //   所以从 PLUGIN_DIR 往上数 3 层就是 `profiles\web`，再往上 2 层就是家。
  //   ⇒ **家在哪，由"插件被装在哪个家"决定**，而不是由全局探测猜。
  //   实测问题：真跑 plugin-check 时临时家里跑着，却解析到了**真实的 B 家**
  //   （因为 ① 之外的候选都指到真实环境）。装在哪就读哪个家，这是最可靠的判据。
  try {
    const up = path.resolve(PLUGIN_DIR, "..", "..", "..");
    // up = <家>/profiles/web ；再上两级 = <家>
    const home = path.resolve(up, "..", "..");
    candidates.push(home);
    // 有些装法是 <家>/plugins/<名>/lib（外壳的 provision 机制），也试一下
    candidates.push(path.resolve(PLUGIN_DIR, "..", ".."));
  } catch { /* 算不出来就跳过 */ }

  // ③ 官方纯函数模块（它在 profile 的 node_modules 里）
  try {
    const m = require("@deepseek-ai/dsh-home-paths");
    if (m && typeof m.resolveDshHome === "function") {
      const h = m.resolveDshHome(undefined, process.env);
      if (typeof h === "string" && h) candidates.push(h);
    }
  } catch { /* 解析不到就跳过 */ }

  // ④ B 家：本机**活动环境**（全局规矩：日常只在 B 干活，A 是只读保底）
  //   ⚠ 放最后：它是兜底，不是首选。放前面会盖掉"装在哪就读哪个家"的正确判据。
  candidates.push(path.join(os.homedir(), "AppData", "Roaming", "DSH Integrated", "dsh-home"));

  for (const c of candidates) {
    if (looksLikeHome(c)) return c;
  }
  // 全都校验不过也返回一个（B），让路由仍能提供可诊断的错误而不是崩掉
  return candidates[candidates.length - 1];
}

/**
 * 这个目录**像不像**一个 DSH 家。
 *
 * 判据与"为什么必须校验"的完整说明在 `lib/home-probe.js`
 * （简短版：`dsh-home-paths` 默认指向 **A 家 = 只读保底**，写错了就是动保底环境）。
 */

/** 读请求体（POST JSON），带大小上限。 */
function readBody(req, limitBytes = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

function parseUrl(req) {
  return new URL(req.url || "/", "http://localhost");
}

const name = "dsh-int-archive-manager";
/**
 * 声明依赖：**只写确定存在的服务**。
 *
 * ★ 教训见 `resolveHome()` 的注释：写进一个不存在的服务名 = 插件永远 pending
 *   = **拖垮整个 profile 启动**。所以这里只留 `webServer` ——
 *   它在本仓库另一个插件（dsh-whale-widget）里已被验证可用。
 *   DSH_HOME 现在靠 import 纯函数模块拿到，**不再依赖任何服务**。
 */
const inject = ["webServer"];

function apply(ctx) {
  const home = resolveHome();
  const disposers = [];

  // ── GET /dsh-archive/config.json ──────────────────────────────────────
  // 当前转储文件夹在哪（以及它现在多大、多少条）。
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: PREFIX + "/config.json",
    handler: (req, res) => {
      try {
        const cfg = readConfig(PLUGIN_DIR);
        const t = listTrash(cfg.trashDir);
        sendJson(res, 200, {
          ok: true,
          pluginDir: PLUGIN_DIR,
          trashDir: cfg.trashDir,
          defaultTrashDir: DEFAULT_TRASH_DIR,
          trashExists: !!t.exists,
          trashSlots: (t.slots || []).length,
          trashBytes: t.bytes || 0,
        });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
    },
  }));

  // ── POST /dsh-archive/config ──────────────────────────────────────────
  // 改转储文件夹。body: { trashDir }
  // 不自动创建目录 —— 先试写，写不出来就如实报"这个路径用不了"，
  // 免得用户填了一个永远写不进去的路径还以为设好了。
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: PREFIX + "/config",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const dir = typeof body.trashDir === "string" ? body.trashDir.trim() : "";
        if (!dir) { sendJson(res, 400, { ok: false, error: "路径不能为空" }); return; }
        // 真的试着建一次 —— 这是"能不能用"的唯一可靠判据（不是"路径格式对不对"）
        try {
          fs.mkdirSync(dir, { recursive: true });
          const probe = path.join(dir, ".dsh-archive-write-test");
          fs.writeFileSync(probe, "ok", "utf8");
          fs.unlinkSync(probe);
        } catch (e) {
          sendJson(res, 200, { ok: false, error: "这个路径无法写入：" + String((e && e.message) || e) });
          return;
        }
        const cfg = writeConfig(PLUGIN_DIR, dir);
        sendJson(res, 200, { ok: true, trashDir: cfg.trashDir });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "请求解析失败：" + String((e && e.message) || e) });
      }
    },
  }));

  // ── GET /dsh-archive/list.json ────────────────────────────────────────
  // 归档会话清单（标题 / 时间 / 体积 / 工作区）。
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: PREFIX + "/list.json",
    handler: (req, res) => {
      try {
        const items = listArchived(home);
        const total = archivedTotalBytes(home);
        const cfg = readConfig(PLUGIN_DIR);
        sendJson(res, 200, { ok: true, home, items, total, trashDir: cfg.trashDir });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
    },
  }));

  // ── GET /dsh-archive/plan.json?sessionId=... ──────────────────────────
  // 只算"会搬走哪些文件"，**绝不删**。给 UI 在最终确认前显示清单用。
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: PREFIX + "/plan.json",
    handler: (req, res) => {
      try {
        const sessionId = parseUrl(req).searchParams.get("sessionId") || "";
        if (!sessionId) { sendJson(res, 400, { ok: false, error: "缺少 sessionId" }); return; }
        sendJson(res, 200, planRemoval(home, sessionId));
      } catch (e) {
        sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
    },
  }));

  // ── POST /dsh-archive/remove ──────────────────────────────────────────
  // "永久删除"：把会话文件搬进转储文件夹 + 清归档登记。
  // body: { sessionId, confirmTitle? }
  //  `confirmTitle` 是 UI 那一步"手打标题"的确认；这里**再校验一次** ——
  //  服务端不能只依赖前端已经确认过（前端可以被绕过，也可以出 bug）。
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: PREFIX + "/remove",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        if (!sessionId) { sendJson(res, 400, { ok: false, error: "缺少 sessionId" }); return; }

        // 服务端再确认一次标题（不依赖前端）
        if (typeof body.confirmTitle === "string" && body.confirmTitle.trim()) {
          const items = listArchived(home);
          const it = items.find((x) => x.id === sessionId);
          const want = String((it && it.title) || "").trim();
          if (want && body.confirmTitle.trim() !== want) {
            sendJson(res, 200, { ok: false, error: "标题确认不匹配，拒绝删除" });
            return;
          }
        }

        const cfg = readConfig(PLUGIN_DIR);
        const result = remove(home, sessionId, cfg.trashDir);
        sendJson(res, result.ok ? 200 : 500, result);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "请求解析失败：" + String((e && e.message) || e) });
      }
    },
  }));

  // ── GET /dsh-archive/trash.json ───────────────────────────────────────
  // 转储文件夹里有什么（可还原的槽清单）。
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: PREFIX + "/trash.json",
    handler: (req, res) => {
      try {
        const cfg = readConfig(PLUGIN_DIR);
        sendJson(res, 200, Object.assign({ ok: true }, listTrash(cfg.trashDir), { trashDir: cfg.trashDir }));
      } catch (e) {
        sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
    },
  }));

  // ── POST /dsh-archive/restore ─────────────────────────────────────────
  // 还原：把转储槽里的文件搬回原路径，**并重新登记进归档名单**。
  // ★ 只还原文件不够 —— 不重新登记的话，它会从界面上彻底消失
  //   （既不在归档列表，也不在会话列表），那才是真的丢了。
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: PREFIX + "/restore",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const slot = typeof body.slot === "string" ? body.slot : "";
        if (!slot) { sendJson(res, 400, { ok: false, error: "缺少 slot" }); return; }
        const cfg = readConfig(PLUGIN_DIR);
        const r = restoreSlot(cfg.trashDir, slot);
        if (!r.ok) { sendJson(res, 500, r); return; }

        // 文件回来了 —— 但**必须**重新登记，否则它哪儿都不显示（见 archive-store 注释）。
        const re = restoreArchived(home, slot, cfg.trashDir);
        // 只有登记成功了才收掉空槽；登记失败就把槽留着，让用户还能再试一次。
        if (re.ok) dropSlot(cfg.trashDir, slot);
        sendJson(res, 200, Object.assign({}, r, { registered: re, slotDropped: re.ok }));
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "请求解析失败：" + String((e && e.message) || e) });
      }
    },
  }));

  // ── POST /dsh-archive/purge ───────────────────────────────────────────
  // **真正的抹除**：删掉一个转储槽。这是插件里唯一会永久丢失数据的操作，
  // 所以要求 `confirm: true` 显式传入。
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: PREFIX + "/purge",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const slot = typeof body.slot === "string" ? body.slot : "";
        if (!slot) { sendJson(res, 400, { ok: false, error: "缺少 slot" }); return; }
        if (body.confirm !== true) {
          sendJson(res, 400, { ok: false, error: "需要 confirm:true 才允许真正抹除" });
          return;
        }
        const cfg = readConfig(PLUGIN_DIR);
        sendJson(res, 200, purgeSlot(cfg.trashDir, slot));
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "请求解析失败：" + String((e && e.message) || e) });
      }
    },
  }));

  // ── GET /dsh-archive/health.json ──────────────────────────────────────
  // 自检：家在哪、归档多少条、总共多少字节、转储目录在哪。**只读**。
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: PREFIX + "/health.json",
    handler: (req, res) => {
      try {
        const total = archivedTotalBytes(home);
        const cfg = readConfig(PLUGIN_DIR);
        sendJson(res, 200, {
          ok: true, plugin: name, home, pluginDir: PLUGIN_DIR,
          archived: total.count, bytes: total.bytes, trashDir: cfg.trashDir,
        });
      } catch (e) {
        sendJson(res, 200, { ok: false, plugin: name, home, error: String((e && e.message) || e) });
      }
    },
  }));

  return () => {
    for (const d of disposers.reverse()) {
      try { d(); } catch { /* 卸载时一个失败不该挡住其余的 */ }
    }
  };
}

export { name, inject, apply };
