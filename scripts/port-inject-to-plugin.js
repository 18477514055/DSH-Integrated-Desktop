/**
 * port-inject-to-plugin.js —— 把 `src/inject/*.js` 的**注入脚本**移植成**客户端插件**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有这个脚本（而不是手抄一遍）
 * ══════════════════════════════════════════════════════════════════
 * 移植的正确性关键是「**注入体逐字不变**」—— 那 400 多行 DOM 逻辑是 4 轮真跑验收
 * （`ui-check inject` / `ui-check files`）验过的，手抄一遍必然引入无声的差异。
 * 所以这里做**机械移植**：读原文 → 包进插件工厂 → 只在**显式列出的锚点**上做替换
 * （替换失败就**报错退出**，绝不静默产出一个坏文件）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 两处"包装层"适配（都不改注入体本身）
 * ══════════════════════════════════════════════════════════════════
 * ① **body 可能还不存在**：注入版是在 `executeJavaScript`（页面加载完）里跑的，`document.body` 一定有；
 *    插件版的 `apply()` 在客户端启动期就可能跑，那时 body 未必在 —— 而 `observe(document.body, …)`
 *    传 null 会**抛异常**（apply 直接失败）。⇒ 包装层统一：body 不在就等 `DOMContentLoaded`。
 * ② **能力来源不同**：注入版用 preload 暴露的 `window.dshShell.openWorkspaceFile`；
 *    插件版走官方的 `ctx.remote.session.openWorkspacePath`（宿主半边做同一件事：
 *    `dsh-native-command` 的 openNativePath / revealNativePath）。⇒ 包装层提供 `makeBridge(ctx)`，
 *    注入体里**只改一行** `var shell = window.dshShell;` → `var shell = bridge;`。
 *
 * 用法：node scripts/port-inject-to-plugin.js [--check]
 *   （--check = 只比对新旧是否一致，不写文件；退出码 2 = 有文件需要重新生成）
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CHECK = process.argv.includes("--check");

const PORTS = [
  {
    injectFile: path.join(ROOT, "src", "inject", "model-search.js"),
    outFile: path.join(ROOT, "plugin", "dsh-int-model-search", "lib", "client.js"),
    pkg: "dsh-int-model-search",
    cordisInject: [],                 // 纯 DOM：不依赖任何客户端服务
    needsRemote: false,
    hook: 'window.__dshModelSearchStats.src = "plugin";',
    why: [
      "给官方「选择模型」下拉加**搜索框 + 提供方筛选**（原来是外壳注入）。",
      "纯 DOM 装饰：不需要任何官方服务，所以 cordis inject 为空、dsh.client.inject 也不声明。",
    ],
    replacements: [],
  },
  {
    injectFile: path.join(ROOT, "src", "inject", "sidebar-open.js"),
    outFile: path.join(ROOT, "plugin", "dsh-int-sidebar-open", "lib", "client.js"),
    pkg: "dsh-int-sidebar-open",
    cordisInject: ["remote", "remote.session"],   // 要 ctx.remote.session.openWorkspacePath
    needsRemote: true,
    hook: 'if (window.__dshSidebarOpen) window.__dshSidebarOpen.src = "plugin";',
    why: [
      "侧栏文件树那一行悬停出图标：**用默认应用打开** / **在资源管理器中显示**（原来是外壳注入 + IPC）。",
      "动作改走官方 session.openWorkspacePath（宿主半边做系统打开；路径的会话工作区解析由宿主负责）。",
    ],
    replacements: [
      {
        from: [
          "  var shell = window.dshShell;",
          '  if (!shell || typeof shell.openWorkspaceFile !== "function") {',
          "    return; // 不是本机内核界面（两个外部站点没有这个通道），不出任何控件",
          "  }",
        ].join("\n"),
        to: [
          "  var shell = bridge;   // ★ 插件版：由 makeBridge(ctx) 提供同一个接口（见文件头「两处包装层适配」）",
          '  if (!shell || typeof shell.openWorkspaceFile !== "function") {',
          "    return; // 拿不到官方的 session.openWorkspacePath（内核太老 / 服务缺失）⇒ 不出任何控件",
          "  }",
        ].join("\n"),
      },
    ],
  },
];

/**
 * 桥：把官方的 session.openWorkspacePath 包装成注入体认得的那个接口
 * （注入体原来调 window.dshShell.openWorkspaceFile(path, action)）。
 *
 * 契约（逐条有出处）：
 *   · 请求形状 { path, action?: "reveal", application?: string }
 *     —— dsh-api-session-controller/lib/types/types.d.ts:361-368；
 *     官方自己的调用点 dsh-client-ui-open-in-app/lib/client.js:440-452 就是这么拼的
 *     （**open 不传 action**，缺省即默认应用）。
 *   · 返回是 RemoteResult，成功看 .ok（官方同处 ok = (await …).ok）。
 *   · 宿主负责「路径的会话工作区解析」（d.ts 原文：Path after best-effort Session
 *     workspace resolution）⇒ 注入版那三条外壳闸门（来源/路径/动作）在插件版里
 *     由**宿主**承担，我们这边只保证只发 open / reveal 两个动作。
 */
const BRIDGE = [
  "    function makeBridge(ctx) {",
  "      var session = ctx && ctx.remote && ctx.remote.session;",
  "      if (!session || typeof session.openWorkspacePath !== \"function\") return null;",
  "      return {",
  "        openWorkspaceFile: function (p, action) {",
  "          if (!p) return Promise.resolve({ ok: false, reason: \"空路径\" });",
  "          var req = action === \"reveal\" ? { path: p, action: \"reveal\" } : { path: p };",
  "          return Promise.resolve()",
  "            .then(function () { return session.openWorkspacePath(req); })",
  "            .then(function (r) {",
  "              if (r && r.ok) return { ok: true, path: p, action: action };",
  "              var why = (r && (r.error || r.message)) || \"宿主拒绝了这个路径\";",
  "              return { ok: false, reason: String(why) };",
  "            })",
  "            .catch(function (e) { return { ok: false, reason: (e && e.message) || String(e) }; });",
  "        },",
  "      };",
  "    }",
  "",
].join("\n");

/** 包装层：body 守卫 + 桥 + 插件身份 */
function wrapper(p, body) {
  const indented = body.split("\n").map((l) => (l ? "    " + l : l)).join("\n");
  const bridgeFn = p.needsRemote ? "\n" + BRIDGE : "";
  const applyInner = p.needsRemote
    ? [
      "        bridge = makeBridge(ctx);",
      // ★ 别在这里调注入体里的 note()：那是**注入体内部**的函数，不在工厂作用域里
      //   （第一版这么写，`remote.session` 还没就绪时抛 ReferenceError ⇒
      //    apply 整个失败、界面上什么都没有、而且不报错 —— 2026-09-29 真跑抓到）。
      "        if (!bridge) { try { console.warn(\"[" + p.pkg + "] 拿不到 ctx.remote.session.openWorkspacePath —— 不出控件\"); } catch (e) { } return; }",
      "        runBody();",
      "        // 身份标记：验收脚本据此区分\"插件在跑\"还是\"外壳注入在跑\"",
      "        try { " + p.hook + " } catch (e) { /* 忽略 */ }",
    ].join("\n")
    : [
      "        runBody();",
      "        // 身份标记：验收脚本据此区分\"插件在跑\"还是\"外壳注入在跑\"",
      "        try { " + p.hook + " } catch (e) { /* 忽略 */ }",
    ].join("\n");

  const L = [];
  L.push("/**");
  L.push(" * " + p.pkg + " —— 浏览器半边（客户端插件）。**由 scripts/port-inject-to-plugin.js 机械生成。**");
  L.push(" *");
  L.push(" * ══════════════════════════════════════════════════════════════════");
  L.push(" * 这个文件是什么 / 为什么要生成而不是手写");
  L.push(" * ══════════════════════════════════════════════════════════════════");
  for (const w of p.why) L.push(" * " + w);
  L.push(" *");
  L.push(" * 注入体来自 src/inject/" + path.basename(p.injectFile) + "，**逐字不变**（除下面列的锚点）。");
  L.push(" * 那段 DOM 逻辑过了 4 轮真跑验收 ⇒ 手抄会引入无声差异，所以在这里**机械移植**：");
  L.push(" * 改了注入脚本就重跑生成器（node scripts/port-inject-to-plugin.js）。");
  L.push(" *");
  L.push(" * 包装层做了两件事（**都不改注入体**）：");
  L.push(" *   ① body 守卫：插件版的 apply 可能在 document.body 出现之前跑，而注入体里");
  L.push(" *      observe(document.body, …) 传 null 会抛 ⇒ body 不在就等 DOMContentLoaded。");
  L.push(" *   ② " + (p.needsRemote
    ? "桥：把官方 session.openWorkspacePath 包装成注入体认得的 openWorkspaceFile(path, action)。"
    : "（本插件不需要任何官方服务，没有桥。）"));
  L.push(" *");
  L.push(" * ⚠️ 别直接编辑本文件 —— 改注入脚本或改生成器，然后重跑生成器。");
  L.push(" *    一致性由 node scripts/port-inject-to-plugin.js --check 盯着（退出码 2 = 需要重新生成）。");
  L.push(" */");
  L.push("");
  L.push("window.__ModuleLoader__.load({");
  L.push("  id: " + JSON.stringify(p.pkg) + ",");
  L.push("  factory: (require) => {");
  L.push('    "use strict";');
  L.push("");
  L.push("    const name = " + JSON.stringify(p.pkg) + ";");
  L.push("    /** cordis 服务依赖：" + (p.cordisInject.length ? p.cordisInject.join(" / ") : "无（纯 DOM）") + " */");
  L.push("    const inject = " + JSON.stringify(p.cordisInject) + ";");
  if (p.needsRemote) L.push("    var bridge = null;   // 由 apply() 赋值，注入体通过闭包读它");
  L.push("");
  L.push("    function apply(ctx) {");
  L.push('      if (typeof document === "undefined") return;');
  L.push("      if (document.body) { run();");
  L.push('      } else { document.addEventListener("DOMContentLoaded", run, { once: true }); }');
  L.push("      return () => { /* 不主动拆：注入体自带幂等守卫（FLAG/NS），页面活多久它活多久 */ };");
  L.push("");
  L.push("      function run() {");
  L.push(applyInner);
  L.push("      }");
  L.push("    }");
  L.push(bridgeFn + "    /** 注入体（原样）：来自 src/inject/" + path.basename(p.injectFile) + " */");
  L.push("    function runBody() {");
  L.push(indented);
  L.push("    }");
  L.push("");
  L.push("    return { name, inject, apply };");
  L.push("  },");
  L.push("});");
  L.push("");
  return L.join("\n");
}

// ── 跑 ────────────────────────────────────────────────────────────────
let needRegen = 0;
for (const p of PORTS) {
  const src = fs.readFileSync(p.injectFile, "utf8");
  let body = src;

  if (!/src\s*[:=]\s*"inject"/.test(src)) {
    console.error("❌ " + p.pkg + ": 源文件里没有身份标记（应含 src: \"inject\"）—— 先给注入脚本加上，再重跑");
    process.exit(2);
  }
  for (const r of p.replacements) {
    if (!body.includes(r.from)) {
      console.error("❌ " + p.pkg + ": 锚点没匹配上（源文件改过？）—— 期望找到：\n" + r.from.split("\n").map((l) => "      " + l).join("\n"));
      process.exit(2);
    }
    if (body.split(r.from).length > 2) {
      console.error("❌ " + p.pkg + ": 锚点出现多次，太危险 —— 换成更长的锚点");
      process.exit(2);
    }
    body = body.replace(r.from, r.to);
  }

  const out = wrapper(p, body);
  const old = fs.existsSync(p.outFile) ? fs.readFileSync(p.outFile, "utf8") : null;
  const same = old === out;
  if (!same) needRegen++;
  console.log((same ? "= 一致" : (old === null ? "+ 新建" : "~ 更新")) + "  " + path.relative(ROOT, p.outFile)
    + "  (" + out.split("\n").length + " 行, " + Buffer.byteLength(out) + " B)");
  if (!CHECK && !same) {
    fs.mkdirSync(path.dirname(p.outFile), { recursive: true });
    fs.writeFileSync(p.outFile, out, "utf8");
  }
}
if (CHECK && needRegen) {
  console.error("\n❌ 有 " + needRegen + " 个生成文件与注入脚本不一致 —— 跑一次 node scripts/port-inject-to-plugin.js");
  process.exit(2);
}
console.log(CHECK ? "\n✅ 生成物与注入脚本一致" : "\n✅ 生成完毕");
