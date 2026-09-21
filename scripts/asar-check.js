"use strict";

/**
 * asar-check.js —— **打完包必须回读产物里的代码**（本项目踩过坑的硬规矩）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么非要有这个脚本
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-09-21 出 0.2.4 时，`npm run dist` 是在我修一个 bug **之前**启动的 ——
 * 产物里那份 `settings.js` 还是旧的（少了 `wireUpdate();` 那一行调用）。
 * 界面上"有按钮、点了没反应"，而**仓库源码看起来完全正常**。
 * 是从产物里把文件抠出来核对才发现的。
 *
 * ⇒ **仓库里改了 ≠ 产物里就是那个版本。** 这条规矩现在由脚本机械执行，不靠人记得。
 *
 * 用法：
 *   node scripts/asar-check.js                 # 默认查 release/win-unpacked/resources/app.asar
 *   node scripts/asar-check.js <app.asar 路径>
 * 退出码：0 全中 / 1 有缺失
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

/**
 * 每个文件必须命中的"功能标记"。
 *
 * ★ 加新功能时**顺手在这里加一行** —— 这些标记就是"这一版该有的东西真的在产物里"的清单。
 *   只加字符串，不加解释（解释写在这里就够了）。
 */
const CHECKS = [
  {
    file: "src/inject/page-switch.js",
    marks: ["shell-settings", "外壳设置", "__dshPageSwitch", "swallowFromRoot", "data-page-id"],
  },
  {
    file: "src/settings.html",
    marks: ['data-pane="update"', 'data-pane="plugins"', 'data-pane="diag"',
      'data-pane="welcome"', "up-current", "pl-list", "btn-pl-check", "up-row-local", "btn-up-local",
      "btn-pl-wizard", "fr-list", "btn-fr-install", "fr-done"],
  },
  {
    file: "src/settings.js",
    marks: ["wireUpdate()", "wirePlugins()", "loadPlugins(false)", "doInstallPlugin",
      "doUninstallPlugin", "ShellUI.esc", "doInstallLocal", "localNewer", "sourceLabel",
      "wireWizard()", "loadWizard", "doInstallSelected", "frInstallable", "firstRunDone"],
  },
  {
    file: "src/sites.js",
    marks: ["chat.deepseek.com", "platform.deepseek.com", "LOCAL_ID"],
  },
  {
    file: "src/main.js",
    marks: [
      "dsh:page:switch", "dsh:page:open-settings", "openSettingsWindow",
      "dsh:update:check",
      "dsh:plugins:list", "dsh:plugins:check", "dsh:plugins:install", "dsh:plugins:uninstall",
      "pluginState", "pluginsEmit",
      "localInstallerDirs", "localInstallerFound",
      "dsh:plugins:install-many", "installOneFromIndex",
      "dsh:first-run:state", "dsh:first-run:done", "firstRunDue", "maybeAutoOpenFirstRun",
    ],
  },
  {
    file: "src/update.js",
    marks: ["cmpVersion", "releases/latest", "pickInstaller", "findLocalInstaller", "versionFromInstallerName"],
  },
  {
    file: "src/preload.js",
    marks: ["switchPage", "openShellSettings", "checkUpdate", "installPlugin", "uninstallPlugin", "checkPlugins",
      "installPlugins", "firstRunState", "firstRunDone"],
  },
  {
    // ★ 0.2.6 起：安装包**不带插件**，插件的入口在首启向导 —— 这个文件必须真的在产物里，
    //   否则"标记读不出来"会让向导每次启动都弹（骚扰），或者再也弹不出来（新用户拿不到插件）。
    file: "src/first-run.js",
    marks: ["first-run.json", "isDone", "mark", "statePath"],
  },
  {
    // ★ 这两个是插件管理器的两块核心，**必须真的进产物**
    file: "src/plugin-catalog.js",
    marks: ["dsh-plugin-index/v1", "ALLOWED_HOSTS", "normalizeIndex", "mergeInstalled", "isDevOnly"],
  },
  {
    file: "src/plugin-install.js",
    marks: ["validatePluginDir", "installFromArchive", "assertNotCommunityHome", "connectIntoProfile", "detectPluginRoot"],
  },
  {
    file: "src/kernel.js",
    marks: ["dsh-home"],
  },
];

// ── 极简 asar 读取（不引依赖：外壳是零运行时依赖的，脚本也不该拖一个进来）──

function readTree(fd, headerSize) {
  const hb = Buffer.alloc(headerSize);
  fs.readSync(fd, hb, 0, headerSize, 16);
  return JSON.parse(hb.toString("utf8").replace(/\0+$/g, ""));
}

function main() {
  const asar = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(ROOT, "release", "win-unpacked", "resources", "app.asar");

  if (!fs.existsSync(asar)) {
    console.error(`找不到产物：${asar}`);
    console.error("（先跑 `npm run dist` 或 `npm run pack`）");
    process.exit(1);
  }

  console.log(`回读产物: ${asar}`);
  console.log(`          ${fs.statSync(asar).size} 字节，${new Date(fs.statSync(asar).mtimeMs).toLocaleString()}`);
  console.log("");

  const fd = fs.openSync(asar, "r");
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(12);
  const base = 16 + headerSize;
  const tree = readTree(fd, headerSize);

  const nodeAt = (parts) => {
    let cur = tree;
    for (const p of parts) {
      if (!cur || !cur.files || !cur.files[p]) return null;
      cur = cur.files[p];
    }
    return cur;
  };

  let bad = 0;
  let totalMarks = 0;
  let filesOk = 0;

  for (const c of CHECKS) {
    const n = nodeAt(c.file.split("/"));
    totalMarks += c.marks.length;
    if (!n || n.size === undefined) {
      console.log(`  缺失  ${c.file}`);
      bad += c.marks.length;
      continue;
    }
    const buf = Buffer.alloc(n.size);
    fs.readSync(fd, buf, 0, n.size, base + parseInt(n.offset, 10));
    const txt = buf.toString("utf8");
    const miss = c.marks.filter((m) => !txt.includes(m));
    if (miss.length) {
      bad += miss.length;
      console.log(`  FAIL  ${c.file.padEnd(26)} 缺：${miss.join(" | ")}`);
    } else {
      filesOk += 1;
      console.log(`  OK    ${c.file.padEnd(26)} ${String(n.size).padStart(7)} B  ${c.marks.length}/${c.marks.length}`);
    }
  }
  fs.closeSync(fd);

  // ── 结构性检查：**包干干净净**（0.2.6 的核心承诺，从"打印一句"升级成"断言"）──
  //
  // 用户原话：「我们发出去的包干干净净的，有本体客户端就足够了。」
  // ⇒ 安装产物里**不许**带插件：插件改由首启向导从插件仓库拉（见 src/first-run.js）。
  //   这两条断言的作用是：谁把 `extraResources` 或 `build.files` 里的 plugin 加回来，
  //   `npm run verify:asar` 立刻 FAIL —— 不再靠人记得。
  let structBad = 0;

  const hasPluginDir = !!(tree.files && tree.files.plugin);
  console.log(`\n  asar 内 plugin/ 目录存在: ${hasPluginDir}（必须 false —— 插件不进 asar）`);
  if (hasPluginDir) { structBad += 1; console.log("  FAIL  asar 里带了 plugin/ 目录"); }

  const unpacked = path.join(path.dirname(asar), "plugins");
  const hasPlugins = fs.existsSync(unpacked);
  let pluginNames = [];
  if (hasPlugins) {
    try { pluginNames = fs.readdirSync(unpacked); } catch { /* 忽略 */ }
  }
  console.log(`  resources/plugins 存在: ${hasPlugins}${hasPlugins ? "  → " + pluginNames.join(", ") : "（干净包：不带内置插件）"}`);
  if (hasPlugins) {
    structBad += 1;
    console.log(`  FAIL  产物里带了 ${pluginNames.length} 个内置插件 —— 0.2.6 起必须不带。`
      + `\n        插件现在由「首次安装向导」从插件仓库拉（src/first-run.js + src/plugin-catalog.js）。`
      + `\n        若是故意要恢复随包分发，请同时改这里与 AGENTS.md §7，别只改 package.json。`);
  }

  console.log("");
  if (bad === 0 && structBad === 0) {
    console.log(`结论：${filesOk} 个文件、${totalMarks} 个功能标记全部命中；结构性检查全过（干净包）`);
    process.exit(0);
  }
  if (bad) console.log(`结论：${bad} 个标记缺失 —— **产物里的代码不是你现在看到的这一份**`);
  if (structBad) console.log(`结论：${structBad} 项结构性检查没过 —— 这个包不是「干净包」`);
  process.exit(1);
}

main();
