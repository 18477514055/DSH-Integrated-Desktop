/**
 * 只读自检：把"归档名单 / 标题 / 时间 / 体积 / 删除计划"算出来并打印。
 *
 * ★ 这个脚本**绝不删任何文件、绝不写任何文件**。它是给用户验收用的第一道关卡：
 *   装插件之前先跑它，确认"它认出的归档会话"跟你心里的那批是同一批。
 *   如果这里列出来的就有问题，那插件删起来也一定有问题 —— **先证明尺子对**。
 *
 * 用法：
 *   node tools/dry-run.mjs                 # 用默认的 B 家
 *   node tools/dry-run.mjs <DSH_HOME路径>
 */

import path from "node:path";
import os from "node:os";
import { listArchived, planRemoval, archivedTotalBytes } from "../lib/archive-store.js";

const home = process.argv[2] || path.join(os.homedir(), "AppData", "Roaming", "DSH Integrated", "dsh-home");

console.log("DSH_HOME =", home);
console.log("");

const items = listArchived(home);
const total = archivedTotalBytes(home);
console.log("已归档会话 =", items.length, "条，日志合计 =", (total.bytes / 1024 / 1024).toFixed(2), "MB");
console.log("");

const fmtBytes = (n) => (n === null ? "-" : (n / 1024).toFixed(1) + " KB");
const fmtDay = (t) => (t ? new Date(t).toISOString().slice(0, 10) : "?");
const fmtTime = (t) => (t ? new Date(t).toISOString().slice(11, 19) : "?");

console.log("日期        时间      体积        标题");
console.log("--------------------------------------------------------------------------------");
for (const it of items) {
  console.log(
    fmtDay(it.at).padEnd(12) +
    fmtTime(it.at).padEnd(10) +
    fmtBytes(it.logBytes).padEnd(12) +
    (it.title || "(无标题)")
  );
}

console.log("");
console.log("=== 删除计划抽样（只看不删）===");
for (const it of items.slice(0, 3)) {
  const plan = planRemoval(home, it.id);
  console.log("");
  console.log("会话 " + it.id + "  「" + (it.title || "(无标题)") + "」");
  if (!plan.ok) { console.log("  " + plan.error); continue; }
  for (const t of plan.targets) console.log("  将回收 [" + t.kind + "] " + t.path);
  console.log("  将从注册表清理的工作区数 = " + plan.workspaceIdsToClean.length);
}

// 日期分布（验证"按天筛选"这个功能有没有数据可用）
const byDay = new Map();
for (const it of items) {
  const d = fmtDay(it.at);
  byDay.set(d, (byDay.get(d) || 0) + 1);
}
console.log("");
console.log("=== 按天分布（共 " + byDay.size + " 天）===");
for (const [d, n] of Array.from(byDay.entries()).sort()) console.log("  " + d + "  " + n + " 条");
