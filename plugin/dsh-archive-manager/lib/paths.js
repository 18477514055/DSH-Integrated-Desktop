/**
 * 归档会话的物理位置解析 —— host 半边专用（node 侧，不在浏览器里跑）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么这个文件单独存在
 * ═══════════════════════════════════════════════════════════════════════════
 * 官方**没有**任何"删除会话"的 API（逐条核实过，见 README §"官方没有删除能力"）。
 * 所以本插件必须自己知道会话文件在哪。这些路径规则是从真实磁盘反向核出来的，
 * 不是猜的 —— 每一条下面都写了它是怎么被验证的。
 *
 * 另一个目的：把"解析"与"执行"分开。删除是不可逆的，解析必须能被单独测试
 * （`tools/dry-run.mjs` 只跑解析、绝不碰磁盘写），这是安全设计的一部分。
 */

import fs from "node:fs";
import path from "node:path";

/**
 * 会话日志的**候选文件名**，按优先顺序。
 *
 * ★ 为什么是"候选"而不是一个常量（**这是踩出来的，不是设计出来的**）：
 *   我第一版只写了 `session.v3.jsonl.zstd`，因为本机内核是 0.1.5-rc.2（v3 世代）。
 *   结果 dry-run 跑出来 27 条归档里**只有 2 条有体积、25 条显示 `-`**。
 *   真实统计（`sessions\` 下 147 个会话目录，2026-09-21 实测）：
 *       `session.jsonl.zstd`     → 109 个   ← 旧格式（v0 世代，历史会话）
 *       `session.v3.jsonl.zstd`  →  38 个   ← 新格式（v3 世代）
 *   ⇒ **会话格式是逐会话决定的，不是全库统一的**。旧会话不会因为内核升级就变成 v3。
 *   硬编码任一个名字都会漏掉另一批 —— 漏掉的那批在 UI 上就是"体积未知"，
 *   更糟的是删除计划里会**只删目录不删日志**（日志还在，等于没腾空间）。
 *
 * 所以：两个名字都认，谁存在算谁；两个都在（理论上的迁移中间态）就都删。
 */
export const LOG_BASENAMES = ["session.v3.jsonl.zstd", "session.jsonl.zstd"];

/** 会话目录里属于"日志"的文件名判定（含未来的 v4/v5…）。 */
export function isLogFileName(name) {
  return /^session(?:\.v\d+)?\.jsonl\.zstd$/.test(name);
}

/**
 * 工作区目录名的编码规则（**实测反推**，不是文档）。
 *
 * 实测样本（`$DSH_HOME\sessions\` 下）：
 *   `D:\deepseek-workspace`              → `--D-deepseek-workspace--`
 *   `C:\Users\24239\Desktop\...Workspace` → `--C-Users-24239-Desktop-DeepSeek-Workspace--`
 *
 * 规则：`--` + 路径分隔符替换为 `-` + `--`。
 * ⚠ 盘符后的冒号 `:` 被**去掉**了（`D:` → `D`）—— 这是 Windows 文件名不允许 `:` 的自然结果。
 * ⚠ 路径里的**中文原样保留**（实测 `--C-Users-24239-Desktop-DeepSeek-Workspace--` 就是这样，
 *   含中文的工作区同理）。所以这个映射**不是**纯 ASCII 变换，不能假设只处理 ASCII。
 */
export function sessionsDirNameFor(cwd) {
  if (typeof cwd !== "string" || !cwd) return null;
  const s = cwd.replace(/[\\/]+$/, "");
  const flat = s.replace(/:/g, "").replace(/[\\/]+/g, "-");
  return "--" + flat + "--";
}

/** `$DSH_HOME\sessions\` 下的全部会话目录（含所在工作区目录名）。 */
export function listAllSessionDirs(home) {
  const root = path.join(home, "sessions");
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const wsEntry of entries) {
    if (!wsEntry.isDirectory()) continue;
    const wsRoot = path.join(root, wsEntry.name);
    let inner;
    try {
      inner = fs.readdirSync(wsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of inner) {
      if (!d.isDirectory()) continue;
      out.push({
        workspaceDirName: wsEntry.name,
        id: d.name,
        dir: path.join(wsRoot, d.name),
      });
    }
  }
  return out;
}

/**
 * 读一条会话的投影缓存（标题 / 时间 / token 等）。
 *
 * 投影缓存的真实形状（实测 `storages\session_projcache\sessions\<id>.json`）：
 *   { version: 7, record: { identity: {formatVersion, createdAt, cwd, ...},
 *                           rows: { title: {ver,seq,val}, sessionListMetadata: {...}, ... } } }
 * 注意 `rows` 是**对象**（key → {ver,seq,val}），不是数组。
 * 时间取 `sessionListMetadata.lastPromptAt`，没有就退到 `identity.createdAt`。
 */
export function readProjection(home, sessionId) {
  const p = path.join(home, "storages", "session_projcache", "sessions", sessionId + ".json");
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const rows = j.record && j.record.rows;
    const ident = j.record && j.record.identity;
    let title = null;
    if (rows && rows.title && typeof rows.title.val === "string") title = rows.title.val;
    let at = null;
    if (rows && rows.sessionListMetadata && rows.sessionListMetadata.val) {
      const v = rows.sessionListMetadata.val.lastPromptAt;
      if (typeof v === "number") at = v;
    }
    if (at === null && ident && typeof ident.createdAt === "number") at = ident.createdAt;
    return { ok: true, title, at, cwd: (ident && ident.cwd) || null };
  } catch {
    return { ok: false, title: null, at: null, cwd: null };
  }
}

/**
 * 会话目录里的全部日志文件（绝对路径）。
 *
 * 为什么返回**数组**：见 `LOG_BASENAMES` 的注释 —— 一个目录里可能同时有
 * v0 与 v3 两份（迁移中间态），只认一份就会删不干净。
 */
export function logFilesIn(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!isLogFileName(e.name)) continue;
    const p = path.join(dir, e.name);
    try {
      const st = fs.statSync(p);
      if (st.isFile()) out.push({ path: p, bytes: st.size, name: e.name });
    } catch { /* 读不到就跳过 */ }
  }
  return out;
}

/** 会话日志文件的合计大小（没有日志则 0，不是 null —— 0 就是"确实没有"）。 */
export function logSize(dir) {
  const files = logFilesIn(dir);
  return files.reduce((n, f) => n + f.bytes, 0);
}

/**
 * 读工作区注册表（归档集合与每条工作区登记的 sessionIds）。
 *
 * 真实形状（实测 `$DSH_HOME\storages\workspace.json`）：
 *   { unit: {name:'workspace', version:2},
 *     global: { initialized, workspaceIds: [...], archivedSessionIds: [...] },
 *     tables: { workspaces: { <wsId>: { path, title, sessionIds: [...], createdAt, updatedAt } } } }
 */
export function readWorkspaceRegistry(home) {
  const p = path.join(home, "storages", "workspace.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return {
    file: p,
    data: j,
    archived: Array.isArray(j.global && j.global.archivedSessionIds) ? j.global.archivedSessionIds.slice() : [],
    workspaces: (j.tables && j.tables.workspaces) || {},
  };
}

/** 原子写回 JSON（先写临时文件再 rename，避免半截文件）。 */
export function writeJsonAtomic(file, value) {
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
