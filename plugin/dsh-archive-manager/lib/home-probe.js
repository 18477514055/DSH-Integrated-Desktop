/**
 * 「这个目录像不像一个 DSH 家」—— 单独成模块，为了能被测试直接调用。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这个校验（**2026-09-21 真跑抓到的坑**）
 * ═══════════════════════════════════════════════════════════════════════════
 * 官方 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()` **默认返回 `~/.dsh`** ——
 * 也就是 **A 家**（源码 `dsh-home-paths/lib/types/index.d.ts:7`：`DSH_HOME_DIR_NAME = ".dsh"`）。
 *
 * 而全局规矩第一条是硬约束：**不许往 A 写。** A 是出事后唯一的维修通道；
 * 一旦 0.1.5 内核碰了 A，A 的 198 个 JUNCTION 会整体改指，**社区版 0.1.2 当场报废**
 * （2026-09-19 真实事故：241 个 JUNCTION 被跨世代改写）。
 *
 * 本插件的"删除归档"会**写** `storages\workspace.json`。如果拿到 A，
 * 就等于拿保底环境开刀 —— 而这还不会报错，只是悄悄写错了地方。
 *
 * ⇒ 所以：**任何一个候选目录，都必须通过这里的校验才被认作家。**
 *   宁可报"找不到家、用不了"，也不认错家。
 *
 * 判据：`storages\workspace.json` 存在即算。
 *
 * ★ 2026-09-21 又改了一次（**真跑 plugin-check 抓到的**）：
 *   第一版要求"同时有 `sessions\` 和 `storages\workspace.json`"。
 *   结果在临时家里跑时，那个家**只有 workspace.json、还没有 sessions 目录**
 *   （全新 profile，一个会话都没有）⇒ 校验不过 ⇒ 跳到下一个候选
 *   ⇒ **解析到了真实的 B 家**（`home` 打印出来是真实路径）。
 *   这正是"认错家"的又一个入口：判据太严会把合法的新家判死。
 *
 *   ⇒ `workspace.json` 是家的**注册表**，它在一个目录里就意味着"这是一个 DSH 家"。
 *     `sessions/` 只是内容多少的问题，不该拿来否定身份。
 *   同时保留"必须有 storages 这一层"的结构约束，足以挡掉临时目录与拼错的路径。
 */

import fs from "node:fs";
import path from "node:path";

/**
 * @param dir - 候选目录
 * @returns true 当它具备 `storages\workspace.json`（家的注册表）
 */
export function looksLikeHome(dir) {
  if (typeof dir !== "string" || !dir) return false;
  try {
    return fs.existsSync(path.join(dir, "storages", "workspace.json"));
  } catch {
    return false;
  }
}

/** 给测试用的同名出口（语义更清楚）。 */
export function resolveHomeProbe(dir) {
  return looksLikeHome(dir);
}
