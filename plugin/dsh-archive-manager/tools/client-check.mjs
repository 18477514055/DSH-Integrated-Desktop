/**
 * 浏览器半边（client.js）的真跑验证。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个（而不是"文件语法对就算过"）
 * ═══════════════════════════════════════════════════════════════════════════
 * `client.js` 是**唯一**决定"用户能不能在侧边栏看到这个分组"的文件。
 * 它如果注册错槽位、或加载时抛错，表现是**界面上一个挂载点都没有、且不报错**
 * （全局规矩第二条：静态可解析 ≠ 动态可加载）。
 *
 * 所以这里做三件真事：
 *   ① 真的执行 `window.__ModuleLoader__.load(...)` 的 factory，拿到 { name, inject, apply }
 *   ② 真的调 `apply(fakeCtx)`，看它往哪两个槽位注册了什么 id/key
 *   ③ 真的调用注册的组件函数，检查它渲染出了搜索框 / 日期筛选 / 删除按钮
 *
 * ⚠ 这是**结构级**验证。真正的像素级验证要装进客户端看（README 的验收步骤）。
 *   但"挂错了槽位"这类致命错误，在这里就能被抓出来 —— 那正是最容易犯的错。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, "..");
const CLIENT = path.join(PLUGIN_DIR, "lib", "client.js");

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name + (detail ? " — " + detail : "")); console.log("  FAIL  " + name + (detail ? " — " + detail : "")); }
}

// ── 最小 DOM / 模块加载器桩 ────────────────────────────────────────────
// 只需要撑到"能执行 factory、能调 apply、能拿到注册项"就够了。
const listeners = [];
globalThis.window = {
  __ModuleLoader__: { load: (spec) => { globalThis.__loadedSpec = spec; } },
};
globalThis.document = {
  head: { appendChild() {} },
  body: {},
  createElement: () => ({ dataset: {}, style: {}, remove() {}, setAttribute() {} }),
  querySelector: () => null,
};
globalThis.fetch = async () => ({ ok: true, text: async () => "{}" });

// 极简 React 桩：记录被创建的元素；**并递归展开函数组件**。
//
// ★ 为什么要递归展开（我第一版漏了，导致 7 条断言假 FAIL）：
//   `h(ArchivePanel)` 只创建一个 `type = ArchivePanel` 的元素 —— 真正的 React
//   在渲染时才会去调用那个函数。我的桩如果只记不展开，就永远看不到内部的
//   搜索框 / 日期框，于是"渲染出了什么"完全验不出来（而且会**假 FAIL**，
//   因为元素其实都在，只是没被展开）。
//   所以这里手动递归调用所有 function/组件类型的 type。
const created = [];
const HOOK_STATE = { depth: 0 };

function expand(node, depth) {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const c of node) expand(c, depth); return; }
  created.push(node);
  let t = node.type;
  // 递归展开函数组件（有上限，防死循环）
  let guard = 0;
  while (typeof t === "function" && guard++ < 20 && depth < 60) {
    let out = null;
    try { out = t(node.props || {}); } catch (e) { return; }
    if (out === null || out === undefined || typeof out !== "object") return;
    if (Array.isArray(out)) { for (const c of out) expand(c, depth + 1); return; }
    created.push(out);
    node = out;
    t = out.type;
  }
  if (node.children) for (const c of node.children) expand(c, depth + 1);
  if (node.props && node.props.children !== undefined) expand(node.props.children, depth + 1);
}

globalThis.__require = (id) => {
  if (id === "react") {
    return {
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState: (v) => [typeof v === "function" ? v() : v, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      Fragment: "Fragment",
      createPortal: (node) => node,
    };
  }
  if (id === "react-dom") return { createPortal: (node) => node };
  if (id === "@deepseek-ai/dsh-client-ui-primitives") return {};
  throw new Error("未桩接的模块: " + id);
};

console.log("=== 1. 加载 client.js ===");
let loadErr = null;
try {
  const src = fs.readFileSync(CLIENT, "utf8");
  // 用 new Function 在受控作用域里跑，把 require 换成桩
  const fn = new Function("window", "document", "fetch", "React", "ReactDOM", "P", src + "\n");
  // 直接走更稳的路：把源码里的 __ModuleLoader__.load 调用替换成导出
  const patched = src.replace(
    /window\.__ModuleLoader__\.load\(/,
    "globalThis.__captured = ("
  );
  const runner = new Function(patched);
  runner();
} catch (e) {
  loadErr = e;
}
ok("client.js 执行不抛错", loadErr === null, loadErr ? String(loadErr.message) : "");
const spec = globalThis.__captured;
ok("调用了模块加载器", !!spec, "没捕获到");
ok("id = dsh-int-archive-manager", spec && spec.id === "dsh-int-archive-manager", spec && String(spec.id));
ok("factory 是函数", spec && typeof spec.factory === "function");

console.log("");
console.log("=== 2. 执行 factory ===");
let mod = null, fErr = null;
try { mod = spec.factory(globalThis.__require); } catch (e) { fErr = e; }
ok("factory 不抛错", fErr === null, fErr ? String(fErr.message).slice(0, 200) : "");
ok("导出 name", mod && mod.name === "dsh-int-archive-manager", mod && String(mod.name));
ok("inject 只含 slots", mod && Array.isArray(mod.inject) && mod.inject.length === 1 && mod.inject[0] === "slots",
  mod ? JSON.stringify(mod.inject) : "");
ok("导出 apply", mod && typeof mod.apply === "function");

console.log("");
console.log("=== 3. 真的 apply：看它往哪些槽位注册 ===");
const injections = [];
const registrations = [];
const effects = [];
const fakeCtx = {
  effect(fn, label) { effects.push({ fn, label }); return () => {}; },
  slots: {
    inject(slotName, cb) {
      injections.push(slotName);
      try { cb(); } catch (e) { /* 记在 registrations 里 */ }
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
};
let aErr = null;
try { mod.apply(fakeCtx); } catch (e) { aErr = e; }
ok("apply 不抛错", aErr === null, aErr ? String(aErr.message).slice(0, 250) : "");

ok("注册到 sidebar.panellist（侧边栏分组行）", injections.includes("sidebar.panellist"), JSON.stringify(injections));
ok("注册到 main（主面板）", injections.includes("main"), JSON.stringify(injections));

const panelReg = registrations.find((r) => r.options && r.options.id === "dsh-int-archive-manager");
ok("panellist 的 id = dsh-int-archive-manager", !!panelReg, JSON.stringify(registrations.map((r) => r.options)));
ok("panellist 带 label 已归档", panelReg && panelReg.options.label === "已归档", panelReg && String(panelReg.options.label));
ok("panellist 带 order", panelReg && typeof panelReg.options.order === "number");
ok("panellist name 字段 = 槽位名", panelReg && panelReg.options.name === "sidebar.panellist", panelReg && String(panelReg.options.name));

const mainReg = registrations.find((r) => r.options && r.options.key === "dsh-int-archive-manager");
ok("main 的 key = dsh-int-archive-manager", !!mainReg, JSON.stringify(registrations.map((r) => r.options)));
ok("main name 字段 = 槽位名", mainReg && mainReg.options.name === "main", mainReg && String(mainReg.options.name));

// ★ 这是最关键的一条：两个 id 必须一致，否则点侧边栏那行会抛
//   "main panel ... is not registered"
ok("panellist.id 与 main.key 一致（否则点击报错）",
  panelReg && mainReg && panelReg.options.id === mainReg.options.key,
  panelReg && mainReg ? panelReg.options.id + " vs " + mainReg.options.key : "");

console.log("");
console.log("=== 4. 渲染主面板：检查关键控件 ===");
created.length = 0;
let rErr = null;
let rootNode = null;
try { rootNode = mainReg.component({}); } catch (e) { rErr = e; }
ok("主面板渲染不抛错", rErr === null, rErr ? String(rErr.message).slice(0, 250) : "");
expand(rootNode, 0);
ok("展开出元素（>5 个）", created.length > 5, "实际 " + created.length);

const all = JSON.stringify(created);
ok("渲染出搜索框", /"data-dsham":"search"/.test(all));
ok("渲染出日期筛选（type=date）", /"type":"date"/.test(all));
ok("渲染出转储夹设置输入框", /"data-dsham":"trashdir"/.test(all));
ok("渲染出归档列表 tab", /"data-dsham":"tab-archived"/.test(all));
ok("渲染出转储文件夹 tab", /"data-dsham":"tab-trash"/.test(all));
ok("渲染出刷新按钮", /"data-dsham":"refresh"/.test(all));
ok("面板根节点有标记", /"data-dsham":"dsh-int-archive-manager-body"/.test(all));

console.log("");
console.log("=== 5. 渲染侧边栏图标 ===");
created.length = 0;
let iErr = null;
let iconNode = null;
try { iconNode = panelReg.component({ size: 16, active: false }); } catch (e) { iErr = e; }
ok("图标渲染不抛错", iErr === null, iErr ? String(iErr.message).slice(0, 200) : "");
expand(iconNode, 0);
const iconJson = JSON.stringify(created);
ok("图标有标记", iconJson.includes("dsh-int-archive-manager-icon"), iconJson.slice(0, 160));
ok("图标内含 svg", iconJson.includes("svg"), iconJson.slice(0, 160));

console.log("");
console.log("=== 6. 调试钩子 ===");
ok("挂了 window.__dshArchiveManager", !!globalThis.__dshArchiveManager);
ok("钩子带 diagnostics", !!(globalThis.__dshArchiveManager && globalThis.__dshArchiveManager.diagnostics));
ok("钩子带 apiList", typeof (globalThis.__dshArchiveManager || {}).apiList === "function");

console.log("");
console.log("================================================================");
console.log("断言 " + (pass + fail) + " 条：PASS " + pass + " / FAIL " + fail);
if (fail) { console.log(""); console.log("失败清单："); for (const f of failures) console.log("  · " + f); }
console.log("================================================================");
process.exit(fail ? 1 : 0);
