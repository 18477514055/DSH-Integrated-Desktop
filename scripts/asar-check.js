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
const crypto = require("node:crypto");

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
    marks: ["shell-settings", "外壳设置", "__dshPageSwitch", "swallowFromRoot", "data-page-id",
      "data-dsh-note"],
  },
  {
    file: "src/settings.html",
    marks: ['data-pane="update"', 'data-pane="plugins"', 'data-pane="diag"',
      'data-pane="welcome"', "up-current", "pl-list", "btn-pl-check", "up-row-local", "btn-up-local",
      "btn-pl-wizard", "fr-list", "btn-fr-install", "fr-done",
      // ★ 2026-09-25：内核那一段从"一行官方最新"改成**渠道清单**（见下）
      "kn-channels", "kn-channel-hint", "kn-row-dl", "kn-warn"],
  },
  {
    file: "src/settings.js",
    marks: ["wireUpdate()", "wirePlugins()", "loadPlugins(false)", "doInstallPlugin",
      "doUninstallPlugin", "ShellUI.esc", "doInstallLocal", "localNewer", "sourceLabel",
      "wireWizard()", "loadWizard", "doInstallSelected", "frInstallable", "firstRunDone",
      // ★ 2026-09-25：渠道清单由这个函数现画（有几个渠道、各是几版全来自 registry）
      "renderKernelChannels", "data-kn-tag", "newerThanDefault", "isDefault"],
  },
  {
    file: "src/sites.js",
    marks: ["chat.deepseek.com", "platform.deepseek.com", "LOCAL_ID",
      "pagesUi", "statusOf", "did-fail-load", "FAIL_GRACE_MS", "loadInto", "errorCardHtml",
      "did-navigate"],
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
      // ★ 0.2.10：退出要能退干净 —— 认领复用的内核、退出时一起关（见 docs/退出退不干净-2026-09-23.md）
      "claimAdoptedKernel", "adoptedKernelPid", "shutdownKernels", "quitApp", "armQuitOnFileHook",
      // ★ 0.2.14：运行环境那三条 IPC + 缺内核时的标记（加载页据此自动拉开抽屉）
      "dsh:kernel:env", "dsh:kernel:provision", "dsh:kernel:remove",
      "DSH_KERNEL_MISSING", "openDiag",
      // ★ 2026-09-25：下载那一步从"只认一个地址"改成"只认本次检查发现的那张地址表"
      //   （上游把 0.1.7 发在 next 上，只记一个地址会让选预览渠道的下载被自己拒掉）。
      //   `渠道：` 是主进程那条日志的标记 —— ui-check 会拿它和页面 DOM 逐个对账。
      "lastKernelDists", "渠道：",
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
    // ★ 0.2.10：判"这个内核是不是本应用拉起来的"要用的三个原语
    marks: ["dsh-home", "ourKernelProcess", "portOwner", "waitPortFree"],
  },
  {
    // ★ 0.2.14：**外壳替用户装内核**那一整套（用户 2026-09-25 报的"还得自己跑命令行"）。
    //   这个文件必须真的进产物 —— 少了它，"新用户开箱即用"这条承诺整个不成立，
    //   而且症状是"点了按钮报 is not a function"（只有在全新机器上才暴露）。
    file: "src/kernel-provision.js",
    marks: ["npm-cli.js", "bundledNpmDir", "--ignore-scripts", "kernelDirFor", "provision",
      // ★ 2026-09-25：磁盘满了要说人话（npm 只会给一个退出码 1，原因埋在它自己的日志里）
      "spaceVerdict", "ENOSPC"],
  },
  {
    // ★ 2026-09-25：检查内核更新从"只查 /latest"改成读**全部 dist-tags**。
    //   成因是用户报的「只看得见 0.1.5、看不见 0.1.7」——上游把 0.1.7 发在 `next` 上。
    //   这几个标记在产物里缺一个，界面就会退回"只有一个版本号"的样子。
    file: "src/kernel-update.js",
    marks: ["channelsFromMeta", "dist-tags", "newerThanDefault", "isDefault",
      "npm.install-v1+json", "skipped"],
  },
  {
    file: "src/diagnostics.js",
    marks: ["install-kernel", "provisionKernel", "hasServer", "hasKernel"],
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
  // ★★ 数据区起点必须**按 4 字节对齐** —— 2026-09-22 实测抓到的（发布 0.2.7 前）：
  //   asar 的 JSON 头写完之后会 padding 到 4 的倍数，而 `readUInt32LE(12)` 给的是
  //   **未 padding 的字符串长度**。所以真实起点是 `align4(16 + headerSize)`，
  //   不是 `16 + headerSize`。
  //   活例：headerSize=6414 时 16+6414=6430 → 真实起点 6432，**差 2 字节**。
  //   ⚠️ 这个错位原来一直没被发现，因为本脚本只做**子串匹配** —— 整体平移 2 字节
  //   照样能 `includes()` 到所有标记（即"全中"其实是假的严格）。
  //   现在除了标记，还会对 `src/*.js` 做**逐字节 sha256**比对，错位就再也混不过去。
  const base = 16 + headerSize + ((4 - ((16 + headerSize) % 4)) % 4);
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

  // ══════════════════════════════════════════════════════════════════
  // ★★ 逐字节比对：产物里的 `src/**` 必须与磁盘上（= git HEAD）**完全相同**
  // ══════════════════════════════════════════════════════════════════
  //
  // 为什么非要有这一段（2026-09-22，发布 0.2.7 前实测）：
  //   上面那些"功能标记全中"只证明**某个片段在**，不证明**整个文件是同一份** ——
  //   而且原来 base 少算 2 字节（见上），整体平移照样能 `includes()` 到所有标记。
  //   要回答"这个安装包里的代码是不是我眼前这一份"，只有 sha256 说了算。
  //   ⇒ 这一段就是 `verify:asar` 的**结论性判据**。
  {
    const fd2 = fs.openSync(asar, "r");
    const walk = (node, rel) => {
      const out = [];
      for (const [name, child] of Object.entries(node.files || {})) {
        const r = rel ? rel + "/" + name : name;
        if (child && child.files) out.push(...walk(child, r));
        else if (child && child.size !== undefined) out.push({ rel: r, size: child.size, offset: child.offset });
      }
      return out;
    };
    const srcNode = nodeAt(["src"]);
    const entries = srcNode ? walk(srcNode, "src") : [];
    let same = 0;
    const diff = [];
    const gone = [];
    for (const e of entries) {
      const onDisk = path.join(ROOT, e.rel);
      if (!fs.existsSync(onDisk)) { gone.push(e.rel); continue; }
      const buf = Buffer.alloc(e.size);
      fs.readSync(fd2, buf, 0, e.size, base + parseInt(e.offset, 10));
      const a = crypto.createHash("sha256").update(buf).digest("hex");
      const b = crypto.createHash("sha256").update(fs.readFileSync(onDisk)).digest("hex");
      if (a === b) same += 1; else diff.push(e.rel);
    }
    fs.closeSync(fd2);

    // 反向：磁盘上有、产物里没有的（漏打包）
    const diskFiles = [];
    (function w(d, rel) {
      for (const en of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, en.name);
        const r = rel ? rel + "/" + en.name : en.name;
        if (en.isDirectory()) w(p, r); else diskFiles.push("src/" + r);
      }
    })(path.join(ROOT, "src"), "");
    const packed = new Set(entries.map((e) => e.rel));
    const missing = diskFiles.filter((f) => !packed.has(f));

    console.log("");
    console.log(`  src/** 逐字节比对: ${same}/${entries.length} 个文件与磁盘 sha256 相同`);
    if (diff.length) console.log(`  FAIL  与磁盘不一致：${diff.join(", ")}`);
    if (gone.length) console.log(`  FAIL  产物里有、磁盘上没有：${gone.join(", ")}`);
    if (missing.length) console.log(`  FAIL  磁盘上有、产物里没打进去：${missing.join(", ")}`);

    if (diff.length || gone.length || missing.length) {
      console.log("  ⇒ 产物里的代码**不是**你现在看到的这一份（或漏打了文件）");
      process.exitCode = 1;
      // 不 return：让下面结构性检查也照常打印，一次看全
      bad += diff.length + gone.length + missing.length;
    } else {
      console.log("  ⇒ 产物 = 源码树 = git HEAD（逐字节）");
    }
  }

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

  // ── 产物里的版本号必须等于 package.json 的版本 ────────────────────
  //   为什么单列一条：`publish-release.py` 是**按 tag 幂等**的，忘了改版本号就把上一版
  //   已发布的附件无声地换掉（AGENTS.md §8 记过这个坑）。这条断言让"产物属于哪一版"
  //   再也不能靠人记得。同时也回答装完客户端后「关于」里该显示什么。
  {
    const pj = nodeAt(["package.json"]);
    if (!pj || pj.size === undefined) {
      structBad += 1;
      console.log("  FAIL  产物里没有 package.json");
    } else {
      // ★ 上面那个 `fd` 早就 close 了（标记那一段用完就关）⇒ 这里必须自己开一个，
      //   否则 `fs.readSync(已关闭的 fd)` 直接 EBADF。
      const fd3 = fs.openSync(asar, "r");
      const buf = Buffer.alloc(pj.size);
      fs.readSync(fd3, buf, 0, pj.size, base + parseInt(pj.offset, 10));
      fs.closeSync(fd3);
      let packedVersion = "?";
      try { packedVersion = JSON.parse(buf.toString("utf8")).version || "?"; } catch { /* 读不出 */ }
      const diskVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
      console.log(`  产物里的版本号: ${packedVersion}（磁盘 package.json: ${diskVersion}）`);
      if (packedVersion !== diskVersion) {
        structBad += 1;
        console.log(`  FAIL  产物版本与 package.json 不一致 —— 这个包不是当前这一版的构建`);
      }
    }
  }

  // ── ★★ 0.2.14：随包的 npm 必须真的落在 `resources\npm\` ──────────────
  //
  // 为什么这条是**结论性判据**（比上面所有标记都硬）：
  //   「外壳替用户装内核」整条链的入口是 `kernel-provision.js` 的 `bundledNpmDir()`，
  //   打包版它读的是 `process.resourcesPath\npm`（= `resources\npm\`）。
  //   而**开发机上永远读得到** `<repo>\runtime\npm` ⇒ `kernel-provision-check`
  //   在开发机上跑一万遍都是绿的，**哪怕 electron-builder 根本没拷这个目录**。
  //   ⇒ 必须回读**产物**。少了它，用户拿到 exe 后点「下载并安装内核」会得到
  //     "随包的 npm 不在（打包时漏了 runtime/npm？）"，而我们在开发机上什么都看不见。
  //   （这正是本项目那条铁律：**仓库里改了 ≠ 产物里就是那个版本**。）
  {
    const resDir = path.dirname(asar);
    const npmDir = path.join(resDir, "npm");
    const npmCli = path.join(npmDir, "bin", "npm-cli.js");
    const npmNm = path.join(npmDir, "node_modules");

    let npmFiles = 0;
    let npmBytes = 0;
    if (fs.existsSync(npmDir)) {
      (function w(d) {
        let es = [];
        try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const en of es) {
          const p = path.join(d, en.name);
          let isDir = false;
          try { isDir = fs.statSync(p).isDirectory(); } catch { continue; }
          if (isDir) w(p);
          else { npmFiles += 1; try { npmBytes += fs.statSync(p).size; } catch { /* 忽略 */ } }
        }
      })(npmDir);
    }

    console.log("");
    console.log(`  resources/npm 存在: ${fs.existsSync(npmDir)}`
      + (fs.existsSync(npmDir) ? `（${npmFiles} 个文件 / ${(npmBytes / 1024 / 1024).toFixed(1)} MB）` : ""));
    console.log(`  resources/npm/bin/npm-cli.js 存在: ${fs.existsSync(npmCli)}`);

    if (!fs.existsSync(npmCli)) {
      structBad += 1;
      console.log("  FAIL  ★★ 随包的 npm 不在产物里 —— 「外壳替用户装内核」整条链会当场断掉。"
        + "\n        用户点「下载并安装内核」只会得到「随包的 npm 不在（打包时漏了 runtime/npm？）」。"
        + "\n        修法：先跑 `node scripts/fetch-npm.js` 把 runtime/npm 备好，再确认"
        + "\n        package.json 的 build.extraResources 里有 { from: \"runtime/npm\", to: \"npm\" }。");
    } else if (!fs.existsSync(npmNm)) {
      structBad += 1;
      console.log("  FAIL  ★★ npm-cli.js 在，但 node_modules 不在 —— 那是个跑不起来的 npm 壳子"
        + "（npm 的依赖没解出来，`npm install` 会 MODULE_NOT_FOUND）。");
    } else if (npmFiles < 500) {
      structBad += 1;
      console.log(`  FAIL  ★★ 随包的 npm 只有 ${npmFiles} 个文件 —— 明显不完整（实测应约 1900 个）。`);
    } else {
      // ★ 与开发机上那一份对一对：产物里的必须就是备好的那一份
      const srcDir = path.join(ROOT, "runtime", "npm");
      const srcCli = path.join(srcDir, "bin", "npm-cli.js");
      if (fs.existsSync(srcCli)) {
        const a = crypto.createHash("sha256").update(fs.readFileSync(npmCli)).digest("hex");
        const b = crypto.createHash("sha256").update(fs.readFileSync(srcCli)).digest("hex");
        if (a === b) {
          console.log("  OK    ★★ 随包 npm 完整，且 npm-cli.js 与 runtime/npm 逐字节相同");
        } else {
          structBad += 1;
          console.log("  FAIL  产物里的 npm-cli.js 与 runtime/npm 那一份**不是同一个文件**");
        }
      } else {
        console.log("  （参考）本机没有 runtime/npm，无法逐字节对照（--check 会报它缺失）");
      }
    }
  }

  console.log("");
  if (bad === 0 && structBad === 0) {
    console.log(`结论：${filesOk} 个文件、${totalMarks} 个功能标记全部命中；结构性检查全过（干净包 + 随包 npm 就位）`);
    process.exit(0);
  }
  if (bad) console.log(`结论：${bad} 个标记缺失 —— **产物里的代码不是你现在看到的这一份**`);
  if (structBad) console.log(`结论：${structBad} 项结构性检查没过 —— 这个包不是「干净包」`);
  process.exit(1);
}

main();
