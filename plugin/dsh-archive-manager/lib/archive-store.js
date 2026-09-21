/**
 * 归档会话的读取与删除 —— host 半边的业务核心（node 侧）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个模块的边界（很重要，别越界）
 * ═══════════════════════════════════════════════════════════════════════════
 *   ✅ 做：读归档名单、读标题与时间、把"删哪些文件"算清楚、真的执行回收站删除。
 *   ❌ 不做：**绝不**在内核持有会话时删它的日志。**绝不**动未归档会话。
 *   ❌ 不做：不碰 `settings.yaml` / `cordis.patch.yml` / `sessions\` 的其它条目
 *      （全局红线：工作区与 DSH 家默认只读，只动本次任务点名的东西）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * "永久删除"到底删哪几样（用户拍板：删日志+投影+归档登记）
 * ═══════════════════════════════════════════════════════════════════════════
 *   ① `$DSH_HOME\sessions\<工作区目录>\<会话id>\session.v3.jsonl.zstd`  ← 真正的体积大头
 *   ② `$DSH_HOME\storages\session_projcache\sessions\<会话id>.json`     ← 标题/时间的缓存
 *   ③ `$DSH_HOME\storages\workspace.json` 的两处登记：
 *        · `global.archivedSessionIds` 里去掉这条 id
 *        · `tables.workspaces[*].sessionIds` 里去掉这条 id
 *
 * ★ 为什么③必须在同一次操作里做完（**这是完整性，不是洁癖**）：
 *   只删①②不动③ ⇒ 归档名单里留着一条指向不存在文件的 id ⇒ 界面上是一条**幽灵条目**，
 *   点它打不开、删它又删不掉（文件已经没了，回收站再删一次只会报"已不存在"）。
 *   **删到一半的系统比没删的系统更难收拾。** 所以下面 `remove()` 把三处当成一个整体：
 *   任何一处失败就停下来，并把已经做了什么如实回给调用方（不假装成功）。
 */

import fs from "node:fs";
import path from "node:path";
import { logFilesIn, logSize, listAllSessionDirs, readProjection, readWorkspaceRegistry } from "./paths.js";
import { moveToTrash } from "./recycle.js";

/**
 * 列出全部已归档会话。
 *
 * 数据来源有两处，都要读：
 *   · `workspace.json` 的 `global.archivedSessionIds` —— **权威名单**（谁算归档由它说了算）
 *   · 磁盘上的日志与投影 —— 标题、时间、体积（名单里有但磁盘上没有的，如实标 missing）
 *
 * ⚠ 为什么不反向（扫磁盘找哪些没在列表里）：没在 `archivedSessionIds` 里的会话是**活的**，
 *   它们只是"当前没显示"，不是归档。把活的当归档删掉是灾难。
 */
export function listArchived(home) {
  const reg = readWorkspaceRegistry(home);
  const dirs = listAllSessionDirs(home);
  const byId = new Map(dirs.map((d) => [d.id, d]));

  // 会话 id → 它所属工作区的标题（从 workspace.json 的 sessionIds 反查）
  const wsTitleOf = new Map();
  for (const wsId of Object.keys(reg.workspaces)) {
    const ws = reg.workspaces[wsId];
    const title = ws && ws.title ? ws.title : null;
    for (const sid of (ws && ws.sessionIds) || []) {
      if (!wsTitleOf.has(sid)) wsTitleOf.set(sid, title);
    }
  }

  const items = [];
  for (const id of reg.archived) {
    const d = byId.get(id);
    const proj = readProjection(home, id);
    const files = d ? logFilesIn(d.dir) : [];
    const bytes = files.reduce((n, f) => n + f.bytes, 0);

    // 时间：投影里读不到就用日志文件的 mtime 兜底。
    // ★ 为什么需要兜底：实测 27 条归档里有 1 条**没有投影缓存**（665 字节的空会话），
    //   它在列表里会是 `?` —— 而"按天筛选"要能用，**没有时间就筛不了**。
    //   日志文件的 mtime 是磁盘事实：最后一次被写的时刻，正好近似"最后活跃时间"。
    let at = proj.at;
    let atSource = proj.at !== null ? "projection" : null;
    if (at === null && files.length) {
      let best = 0;
      for (const f of files) {
        try {
          const m = fs.statSync(f.path).mtimeMs;
          if (m > best) best = m;
        } catch { /* 读不到就算了 */ }
      }
      if (best > 0) { at = best; atSource = "mtime"; }
    }

    items.push({
      id,
      title: proj.title || null,
      at,
      atSource,
      cwd: proj.cwd || null,
      workspaceTitle: wsTitleOf.get(id) || null,
      logBytes: bytes,
      logFiles: files.map((f) => f.name),
      logMissing: files.length === 0,
      projMissing: !proj.ok,
    });
  }
  // 时间倒序：最近归档的在最上面（用户来找"刚归档的那个"是主要场景）。
  items.sort((a, b) => (b.at || 0) - (a.at || 0));
  return items;
}

/**
 * 算出"删这条会话要动哪些路径"。
 *
 * 单独拎出来是为了**可测**：`tools/dry-run.mjs` 只调这个函数，
 * 于是"删哪些东西"这件事能被完整验证，而**不真的删任何文件**。
 */
export function planRemoval(home, sessionId) {
  const reg = readWorkspaceRegistry(home);
  const archived = reg.archived;
  if (!archived.includes(sessionId)) {
    return { ok: false, error: "该会话不在归档名单里，拒绝删除" };
  }

  const dirs = listAllSessionDirs(home);
  const d = dirs.find((x) => x.id === sessionId) || null;

  const targets = [];
  if (d) {
    // 日志文件可能有多个（v0 + v3 并存），逐个回收 —— 见 paths.js 的 LOG_BASENAMES 注释。
    for (const f of logFilesIn(d.dir)) targets.push({ kind: "log", path: f.path, bytes: f.bytes });
    // 会话目录本身：删完日志后如果是空的，连目录一起收走，不留空壳。
    targets.push({ kind: "dir", path: d.dir });
  }
  const projPath = path.join(home, "storages", "session_projcache", "sessions", sessionId + ".json");
  if (fs.existsSync(projPath)) targets.push({ kind: "proj", path: projPath });

  return {
    ok: true,
    sessionId,
    targets,
    registryFile: reg.file,
    inArchivedList: true,
    workspaceIdsToClean: Object.keys(reg.workspaces).filter(
      (wsId) => ((reg.workspaces[wsId] && reg.workspaces[wsId].sessionIds) || []).includes(sessionId)
    ),
  };
}

/**
 * 真的"删除"一条归档会话 = 搬进转储文件夹 + 清登记。
 *
 * 顺序是**刻意**的：
 *   先搬文件（可逆：能从转储文件夹还原） → 再改注册表（原子写）。
 * 因为搬走的文件还能搬回来，而注册表改错了没有第二次机会。
 * 反过来（先清登记再搬文件）一旦中途失败，就变成"没人知道这个文件存在"的孤儿。
 *
 * ★ 会话目录**不整体搬走**，只搬里面的日志文件：
 *   目录本身留着（空的）不影响任何事，而搬目录会让它从 DSH 的会话扫描里
 *   以一种更难预测的方式消失。空目录留着反而更安全、更可逆。
 *
 * @param home      DSH 家
 * @param sessionId 会话 id
 * @param trashDir  用户指定的转储目录（由调用方从配置里读出后传进来）
 * @returns 逐项结果的清单。**任何一项失败都会整体返回 ok:false**，
 *          并列出 `done` 与 `failed`，让 UI 能如实说"删了一半"而不是假的"删除成功"。
 */
export function remove(home, sessionId, trashDir) {
  const plan = planRemoval(home, sessionId);
  if (!plan.ok) return { ok: false, error: plan.error, done: [], failed: [] };
  if (!trashDir) return { ok: false, error: "未指定转储文件夹，拒绝删除", done: [], failed: [] };

  // 标题：给转储槽起个能看懂的名字（用户之后要在文件夹里认出它）
  let title = null;
  const proj = readProjection(home, sessionId);
  if (proj.ok && proj.title) title = proj.title;
  // cwd 也要记下来：还原时要靠它判断该把会话登记回哪个工作区
  const cwd = proj.ok ? proj.cwd : null;

  // 只搬**文件**（日志 + 投影）。目录不搬，见上面注释。
  const files = plan.targets.filter((t) => t.kind !== "dir").map((t) => t.path);

  const moved = moveToTrash(trashDir, sessionId, title, files, cwd);

  const done = moved.moved ? moved.moved.map((m) => ({ kind: "moved", path: m.from, to: m.to })) : [];
  const failed = (moved.failed || []).map((f) => ({ kind: "move", path: f.from, error: f.error }));

  // 文件层面全成了才动注册表 —— 否则宁可留着幽灵条目（至少还能再试一次）。
  if (failed.length === 0) {
    try {
      const reg = readWorkspaceRegistry(home);
      const data = reg.data;
      data.global.archivedSessionIds = (data.global.archivedSessionIds || []).filter((x) => x !== sessionId);
      for (const wsId of plan.workspaceIdsToClean) {
        const ws = data.tables.workspaces[wsId];
        if (ws && Array.isArray(ws.sessionIds)) {
          ws.sessionIds = ws.sessionIds.filter((x) => x !== sessionId);
        }
      }
      const tmp = reg.file + ".tmp-" + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, reg.file);
      done.push({ kind: "registry", path: reg.file, method: "rewritten" });
    } catch (e) {
      failed.push({ kind: "registry", path: plan.registryFile, error: "写回注册表失败：" + ((e && e.message) || String(e)) });
    }
  }

  return {
    ok: failed.length === 0,
    sessionId,
    slot: moved.slot || null,
    trashDir,
    trashPath: moved.dir || null,
    canRestore: failed.length === 0,
    done,
    failed,
    error: failed.length ? "部分步骤失败（详见 failed）" : null,
  };
}

/** 汇总：已归档会话占用多少字节（给 UI 显示"能腾多少"）。 */
export function archivedTotalBytes(home) {
  const items = listArchived(home);
  const bytes = items.reduce((n, x) => n + (x.logBytes || 0), 0);
  return { count: items.length, bytes };
}

/**
 * 还原之后**重新登记**进归档名单。
 *
 * ★ 为什么这个函数必须存在（**这是我一开始漏掉的，很关键**）：
 *   `remove()` 做了两件事：搬走文件 + 从 `archivedSessionIds` 里摘掉 id。
 *   那么"还原"如果只把文件搬回去，就只做了一半 —— id 还不在归档名单里。
 *   结果会是：文件在磁盘上，但**界面上哪儿都找不到它**
 *   （不在归档列表，也不在会话列表）。那比没还原还糟：数据回来了却看不见。
 *
 *   这条正好呼应 `remove()` 注释里那句"删到一半的系统比没删的系统更难收拾" ——
 *   还原到一半同样是坏的。所以搬回文件与重新登记必须成对发生。
 *
 * @param slot 转储槽名（里面 `_origin.json` 记着 sessionId）
 * @returns {{ok, sessionId?, error?}}
 */
export function restoreArchived(home, slot, trashDir) {
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(trashDir, slot, "_origin.json"), "utf8"));
  } catch {
    return { ok: false, error: "读不到这个槽的原信息，无法重新登记" };
  }
  const sessionId = meta && meta.sessionId;
  if (!sessionId) return { ok: false, error: "槽信息里没有会话 id" };

  // 先确认文件真的回来了（否则登记了一条指向空气的 id = 幽灵条目）
  const dirs = listAllSessionDirs(home);
  const d = dirs.find((x) => x.id === sessionId);
  if (!d || logFilesIn(d.dir).length === 0) {
    return { ok: false, sessionId, error: "磁盘上没找到回来的日志文件，未登记（避免产生幽灵条目）" };
  }

  try {
    const reg = readWorkspaceRegistry(home);
    const data = reg.data;
    if (!Array.isArray(data.global.archivedSessionIds)) data.global.archivedSessionIds = [];
    if (!data.global.archivedSessionIds.includes(sessionId)) {
      data.global.archivedSessionIds.push(sessionId);
    }
    // 工作区登记也补回去（remove 时从这些表里摘掉了）
    for (const wsId of Object.keys(data.tables.workspaces || {})) {
      const ws = data.tables.workspaces[wsId];
      if (!ws) continue;
      const cwd = (meta && meta.cwd) || null;
      // 只补回"路径对得上"的工作区 —— 不能把会话塞进一个它不属于的工作区
      if (cwd && ws.path && String(ws.path).toLowerCase() === String(cwd).toLowerCase()) {
        if (!Array.isArray(ws.sessionIds)) ws.sessionIds = [];
        if (!ws.sessionIds.includes(sessionId)) ws.sessionIds.push(sessionId);
      }
    }
    const tmp = reg.file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, reg.file);
    return { ok: true, sessionId };
  } catch (e) {
    return { ok: false, sessionId, error: "写回注册表失败：" + String((e && e.message) || e) };
  }
}
