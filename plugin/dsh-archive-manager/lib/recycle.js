/**
 * 「永久删除」的真实动作：把会话文件**搬到用户指定的转储文件夹**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★ 这个设计是用户定的，不是我定的（2026-09-21）
 * ═══════════════════════════════════════════════════════════════════════════
 * 用户原话：「我们的归档指定一个文件夹，该文件夹专门用来放这些东西，
 *           然后后面我自己去文件夹来迁移这些东西进回收站。」
 *
 * 演化过程（三次改动，每次都是被实测推着走的）：
 *   ① 系统回收站（Shell COM `InvokeVerb('delete')`）
 *      → **实测弹确认框，删一条弹一次**，用户当场反馈"一直在给我跳弹窗"。放弃。
 *   ② 插件自己管一个隐藏回收目录（`safety\archive-trash\`）
 *      → 不弹窗了，但**位置写死、用户不好找**。用户提议改成可指定。
 *   ③ **现在这版：位置由用户在界面里指定，随时可改**。
 *
 * 为什么这版最好：
 *   · **用户完全掌控** —— 想放哪放哪，想改就改，文件是他的，路径他看得见。
 *   · **不弹任何系统框** —— 纯文件移动，不经过 Shell。
 *   · **不依赖 COM / 不依赖 Windows 版本** —— 换机器、换系统都照样能跑。
 *   · **最后一步交给用户** —— 他自己去那个文件夹全选删除，删不删、什么时候删，
 *     完全是他自己的决定。插件只负责"挑出来、搬过去、摆整齐"。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 诚实的边界
 * ═══════════════════════════════════════════════════════════════════════════
 * · **空间不会立刻释放**：搬过去之后字节仍在盘上，只是换了位置。
 *   真正腾空间要用户去那个文件夹删掉。这是这个设计**故意的**代价 ——
 *   换来的是"删之前还有一次反悔的机会"。
 * · **跨盘会失败**：如果转储目录与 DSH 家不在同一个盘，rename 会抛 EXDEV。
 *   这里**不静默降级成"复制再删原件"**（那对大文件又慢又危险），
 *   而是如实报错、一个字节都不动。宁可"没删成"，也不假装删了。
 * · 用户自己在文件夹里删掉之后，插件的"还原"就失效了 —— 这是**预期行为**，
 *   不是 bug。UI 里会检测到并说明。
 */

import fs from "node:fs";
import path from "node:path";

/**
 * 默认转储目录（用户可在界面里改）。
 *
 * ★ 2026-09-21 随项目搬到第三工作区时改的：原来指向 `D:\deepseek-workspace\7.归档管理器\`，
 *   现在项目在 `D:\DSH工作区002\2.归档管理器\`，默认路径必须跟着走 ——
 *   否则用户第一次打开会看到"默认转储夹"指着一个**已经不存在的目录**。
 *   配置一旦写入就以配置为准，所以只有"从未改过"的用户会受影响，
 *   但那正是**第一次用**的人，印象最差的那种情况。
 */
export const DEFAULT_TRASH_DIR = "D:\\DSH工作区002\\2.归档管理器\\已删除归档";

/** 配置文件的名字（放在转储目录的**同级**，这样换目录时配置不跟着走丢）。 */
const CONFIG_NAME = "archive-manager.config.json";

/**
 * 配置文件放哪。
 *
 * ★ 为什么**不**放在转储目录里面：用户可能会整个删掉那个目录
 *   （这正是这个设计允许甚至鼓励的操作）。配置跟着一起没了 ⇒
 *   下次打开插件又回到默认路径，用户会以为"我明明改过怎么又回去了"。
 *   所以放在**插件自己的目录下**（工作区里的那个），与转储目录解耦。
 */
export function configPath(pluginDir) {
  return path.join(pluginDir, CONFIG_NAME);
}

/**
 * 解析"配置文件放哪"。
 *
 * ★ 为什么允许环境变量覆盖（**这是被 e2e 测试污染逼出来的**）：
 *   配置路径原本写死为插件目录。但 `index.js` 用 `import.meta.url` 算插件目录 ——
 *   测试从临时家导入这个模块时，算出来的仍指向**真实插件目录**，
 *   于是 e2e 把 `trashDir = <临时目录>` 写进了**真实插件目录里的配置文件**
 *   （实测残留 `C:\Users\...\Temp\dsh-am-sink-xxx`）。
 *   ⇒ 测试污染了交付物。这是真 bug，不是小瑕疵。
 *
 *   所以加一个环境变量出口：`DSH_ARCHIVE_CONFIG_DIR`。
 *   生产环境**不设**它 ⇒ 走插件目录（默认行为完全不变）；
 *   测试设它 ⇒ 配置落在临时目录，与真实插件彻底隔离。
 */
export function resolveConfigDir() {
  const override = process.env.DSH_ARCHIVE_CONFIG_DIR;
  if (override && typeof override === "string" && override.trim()) return override.trim();
  return PLUGIN_DIR_FALLBACK;
}

/** 由 index.js 在启动时设置（用 import.meta.url 算出来的真实插件目录）。 */
let PLUGIN_DIR_FALLBACK = ".";
export function setPluginDir(dir) { PLUGIN_DIR_FALLBACK = dir; }

/**
 * 决定配置文件落在哪个目录。
 *
 * ★ 优先级：`环境变量 > 显式参数 > 插件目录`
 *   环境变量排第一，是因为它**只在测试时设置**，而测试必须能把配置隔离到临时目录 ——
 *   （我第一版写成了 `pluginDir || resolveConfigDir()`，显式参数优先，
 *    结果 index.js 传进来的真实插件目录把环境变量盖掉了 ⇒ 污染依旧。
 *    e2e 第 11 组断言抓到的就是这个。）
 */
function pickConfigDir(pluginDir) {
  const override = process.env.DSH_ARCHIVE_CONFIG_DIR;
  if (override && typeof override === "string" && override.trim()) return override.trim();
  return pluginDir || resolveConfigDir();
}

/** 读配置；读不到就用默认值。 */
export function readConfig(pluginDir) {
  const dir = pickConfigDir(pluginDir);
  try {
    const j = JSON.parse(fs.readFileSync(configPath(dir), "utf8"));
    if (j && typeof j.trashDir === "string" && j.trashDir.trim()) {
      return { trashDir: j.trashDir.trim() };
    }
  } catch { /* 没有就用默认 */ }
  return { trashDir: DEFAULT_TRASH_DIR };
}

/** 写配置。 */
export function writeConfig(pluginDir, trashDir) {
  const dir = pickConfigDir(pluginDir);
  const p = configPath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ trashDir }, null, 2), "utf8");
  return { trashDir };
}

/** 造一个不重名的槽目录名：`<日期>-<会话尾号>`。 */
function slotName(sessionId) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  const tail = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "").slice(-12);
  return stamp + (tail ? "-" + tail : "");
}

/** 文件名清洗：会话标题可能含 `\ / : * ? " < > |`，直接当目录名会失败。 */
function safeName(s, fallback) {
  const t = String(s || "").replace(/[\\/:*?"<>|\r\n\t]/g, "_").replace(/\s+/g, " ").trim();
  const cut = t.length > 60 ? t.slice(0, 60) : t;
  return cut || fallback;
}

/**
 * 把一条会话的全部文件搬进转储目录。
 *
 * @param home       DSH 家（源的父，仅用于记录）
 * @param trashDir   用户指定的转储目录
 * @param sessionId  会话 id
 * @param title      会话标题（用来给槽目录起个能看懂的名字）
 * @param files      要搬的绝对路径数组
 * @returns {{ok, slot?, dir?, moved?, error?, failed?}}
 *   `moved` 里记了每条的 `from` / `to`，**这是"还原"能成立的唯一依据**。
 */
export function moveToTrash(trashDir, sessionId, title, files, cwd) {
  const slot = slotName(sessionId) + "-" + safeName(title, "无标题");
  const destDir = path.join(trashDir, slot);
  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (e) {
    return { ok: false, error: "无法创建转储目录 " + destDir + "：" + ((e && e.message) || String(e)) };
  }

  const moved = [];
  const failed = [];
  for (const from of files) {
    const base = path.basename(from);
    let to = path.join(destDir, base);
    // 同槽里重名（例如 v0 + v3 之外的同名冲突）就加后缀，绝不覆盖已有文件。
    let n = 1;
    while (fs.existsSync(to)) {
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      to = path.join(destDir, stem + "(" + n + ")" + ext);
      n++;
    }
    try {
      fs.renameSync(from, to);
      moved.push({ from, to });
    } catch (e) {
      const msg = String((e && e.message) || e);
      const cross = (e && e.code === "EXDEV") || /cross-device/i.test(msg);
      failed.push({ from, error: cross ? "跨磁盘，无法移动（未删除）" : "移动失败：" + msg });
    }
  }

  // 记下原路径 —— 没有这个，"还原"就只能靠猜。
  try {
    fs.writeFileSync(
      path.join(destDir, "原路径.txt"),
      moved.map((m) => m.from).join("\r\n") + "\r\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(destDir, "_origin.json"),
      JSON.stringify(
        { sessionId, title: title || null, cwd: cwd || null, at: new Date().toISOString(), moved },
        null, 2
      ),
      "utf8"
    );
  } catch { /* 记录写不进去也不算失败 —— 文件已经安全搬过去了 */ }

  // ★ 这些记录文件必须写在 `moved` 之后、但在返回前 —— 上面已经是这个顺序了。
  //   注意：`files` 里的文件在 rename 之后就不在原位了，
  //   所以"槽里有几个文件"的断言要算上这两个记录文件。

  return { ok: failed.length === 0, slot, dir: destDir, moved, failed };
}

/** 列出转储目录里的槽（给"还原 / 打开文件夹"用）。 */
export function listTrash(trashDir) {
  let slots = [];
  try {
    slots = fs.readdirSync(trashDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return { ok: false, exists: false, slots: [] };
  }
  const out = [];
  for (const slot of slots) {
    const dir = path.join(trashDir, slot);
    let bytes = 0;
    let count = 0;
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, "_origin.json"), "utf8")); } catch { /* 没记录也能列 */ }
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isFile()) continue;
        count++;
        try { bytes += fs.statSync(path.join(dir, e.name)).size; } catch { /* 算了 */ }
      }
    } catch { /* 算了 */ }
    out.push({
      slot, dir, bytes, count,
      sessionId: (meta && meta.sessionId) || null,
      title: (meta && meta.title) || null,
      at: (meta && meta.at) || null,
      restorable: !!(meta && meta.moved && meta.moved.length),
    });
  }
  out.sort((a, b) => (a.slot < b.slot ? 1 : -1));
  return { ok: true, exists: true, dir: trashDir, slots: out, bytes: out.reduce((n, s) => n + s.bytes, 0) };
}

/**
 * 还原一个槽：把文件搬回它们**原来的路径**。
 *
 * ⚠ 如果用户已经自己在文件夹里把这些文件删了，这里会如实报
 *   "回收项缺失" —— 那是预期结果，不是 bug（他删了，就没有了）。
 */
export function restoreSlot(trashDir, slot) {
  const dir = path.join(trashDir, slot);
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, "_origin.json"), "utf8")); }
  catch { return { ok: false, error: "这个槽没有原路径记录，无法还原" }; }

  const results = [];
  for (const rec of meta.moved || []) {
    try {
      if (!fs.existsSync(rec.to)) {
        results.push({ from: rec.from, ok: false, error: "转储文件已不在（你可能已经手动删掉了）" });
        continue;
      }
      if (fs.existsSync(rec.from)) {
        results.push({ from: rec.from, ok: false, error: "原位置已经有文件了，为免覆盖未还原" });
        continue;
      }
      fs.mkdirSync(path.dirname(rec.from), { recursive: true });
      fs.renameSync(rec.to, rec.from);
      results.push({ from: rec.from, ok: true });
    } catch (e) {
      results.push({ from: rec.from, ok: false, error: String((e && e.message) || e) });
    }
  }
  const ok = results.length > 0 && results.every((r) => r.ok);

  // ★ 全还原成功后**先不删槽**，而是把 meta 一起交回调用方。
  //   （我第一版在这里就 rmSync 掉了，结果调用方下一步想读 `_origin.json`
  //     去"重新登记进归档名单"时文件已经没了 ⇒ 文件回来了但界面上找不到它，
  //     等于"还原了一半"。e2e 第 8 组断言抓到的正是这个。）
  //   由调用方（index.js 的 /restore）在登记完成之后再调 `dropSlot()` 收尾。
  return { ok, results, slot, meta };
}

/** 还原并登记完之后，把这个空槽删掉（收尾动作，与还原本身分开）。 */
export function dropSlot(trashDir, slot) {
  try { fs.rmSync(path.join(trashDir, slot), { recursive: true, force: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/** 删掉一个槽（**真正的抹除**，只在用户在界面上明确说"清空"时才调）。 */
export function purgeSlot(trashDir, slot) {
  const dir = path.join(trashDir, slot);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, slot };
  } catch (e) {
    return { ok: false, slot, error: String((e && e.message) || e) };
  }
}
