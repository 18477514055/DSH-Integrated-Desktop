"use strict";

/**
 * check-kernel.js —— 检查机器上有没有可用的 dsh 内核
 *
 * 为什么需要它：本外壳**不内嵌内核**，只负责"找到并启动"。
 * 所以安装后第一件事应该是确认"找得到内核"，否则用户装完打开只会看到报错。
 *
 * 用法：
 *   node scripts/check-kernel.js          检查并打印结论（退出码 0/1）
 *
 * 退出码：0 = 找到可用内核；1 = 没找到
 */

const path = require("node:path");
const K = require(path.join(__dirname, "..", "src", "kernel.js"));

function main() {
  const candidates = K.findKernelCandidates({});

  console.log("");
  console.log("  ============================================");
  console.log("   DSH 内核检查");
  console.log("  ============================================");
  console.log("");

  if (candidates.length === 0) {
    console.log("  [X] 没有找到任何内核候选位置。");
    console.log("");
    console.log("  安装一个即可（任选）：");
    console.log("    npm i -g @deepseek-ai/dsh");
    console.log("  或把内核放到应用的 vendor/dsh 目录。");
    console.log("");
    process.exit(1);
  }

  let found = null;
  for (const c of candidates) {
    const k = K.resolveKernel(c.path);
    if (k) {
      console.log(`  [OK] ${c.source}`);
      console.log(`       路径: ${k.dir}`);
      console.log(`       版本: ${k.version}`);
      if (!found) found = { ...k, source: c.source };
    } else {
      console.log(`  [--] ${c.source} —— 无效（没有 lib/bin.js）`);
      console.log(`       ${c.path}`);
    }
  }

  console.log("");
  if (found) {
    console.log(`  将使用: ${found.version}（${found.source}）`);
    console.log("");
    process.exit(0);
  }

  console.log("  [X] 候选位置都无效。");
  console.log("");
  process.exit(1);
}

try {
  main();
} catch (e) {
  console.error(`[check-kernel] 失败: ${(e && e.message) || e}`);
  process.exit(1);
}
