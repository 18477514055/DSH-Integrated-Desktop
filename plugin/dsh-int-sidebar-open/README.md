# dsh-int-sidebar-open —— 侧栏文件「真打开」

> **它做两件事**（右侧栏文件树那一行，鼠标移上去时行尾浮出小图标）：
> **用默认应用打开** / **在文件资源管理器中显示**；右键任意一行还有菜单（含**复制路径**）。
> **单击照旧是在侧栏里读它** —— 内核自带的行为，一个字没改。
>
> **原来是外壳的注入脚本 + 自建 IPC**（`src/inject/sidebar-open.js` + `preload.js` 的
> `dsh:file:open-workspace`），2026-09-29 移植成独立客户端插件：动作改走**官方的**
> `ctx.remote.session.openWorkspacePath` ⇒ 跟着内核走，换成官方桌面端也照样能用。

## 装法

```powershell
# 集成版自己的家（profile=web）
node scripts/install-plugin.js --plugin dsh-int-sidebar-open --apply

# 官方桌面端的家（profile=desktop）—— 复刻集成版用这条
node scripts/install-plugin.js --plugin dsh-int-sidebar-open --apply --home "$env:USERPROFILE\.dsh" --profile desktop
```

装完**重启一次客户端**。

## 动作走哪条链（为什么不再需要外壳）

```
我们的图标 ──▶ ctx.remote.session.openWorkspacePath({ path, action? })
                    │  （Remote，官方 api-session-controller）
                    ▼
              宿主：SessionOpenWorkspacePathRequest
                    · action 缺省 = 用默认应用打开；action:"reveal" = 在文件管理器里选中
                    · 路径由宿主做**会话工作区解析**（d.ts 原文：after best-effort
                      Session workspace resolution）
                    ▼
              dsh-native-command: openNativePath / revealNativePath
```

- 请求形状与官方自己的调用点逐字一致（`dsh-client-ui-open-in-app/lib/client.js:440-452`）。
- ⇒ **路径归属的判定在宿主那边**，不是"页面说是什么就是什么"。注入版当年必须自己写
  `guardWorkspaceFilePath`，插件版不需要 —— 这是移植后**更强**的一点，不是更弱。

## 已知边界（诚实写清楚）

| 边界 | 说明 |
|---|---|
| 依赖内核有 `session.openWorkspacePath` | 拿不到就**不出任何控件**（安静退出，官方界面照常用）—— 见生成物里 `makeBridge` 的空值分支 |
| ★★ **宿主不校验路径是否存在**（2026-09-29 真跑实测） | 拿一个**不存在**的路径去问，宿主照样回 `ok:true` —— 它的契约只是"把路径交给本机打开器"（`SessionOpenWorkspacePathValue = { opened: true }`）。⇒ **"文件不存在 / 打不开"这一类失败，插件版收不到**（注入版当年能报，是因为外壳自己调 `shell.openPath` 拿到了错误串）。**表现差异**：注入版的红色 toast 会提示"打不开"，插件版不会。真要恢复这个提示，得在客户端半边自己 `stat` 一次（**没做**，因为客户端半边拿不到 fs）。 |
| 路径的**归属**由宿主判定 | 我们只发送**内核自己渲染出来的**那些行携带的 `data-files-path`（`<li data-files-entry data-files-path>`）⇒ 路径来源是内核，不是页面随手编的。⚠️ 但"宿主是否拒绝**工作区之外**的绝对路径"**未经实测**（不敢拿真实路径去试，那会真的启动程序）—— 记为**未知 / 需复核**。 |
| 图标挂在**独立浮层**上，不塞进 React 的 DOM | 树是 React 画的，append 进去的图标会在它重渲染那一行时被抹掉 |
| `position:fixed` + `getBoundingClientRect()` 跟行跑 | 侧栏有好几层 `overflow`，用 absolute 放进祖先会被**裁掉**（DOM 里有、屏幕上没有） |
| 事件拦在**根节点 + 冒泡**阶段 | 在自身元素上用捕获阶段 `stopPropagation` 会让**自己的**点击处理器完全不执行（2026-09-20 实测） |
| 样式一律走 CSSOM、不碰 `innerHTML` | 官方页面可能下发严格 `style-src`；有些页面开了 Trusted Types |
| "看得见"用 `elementFromPoint` 判，不用 `getBoundingClientRect` | 矩形是**未裁切**的几何：行被滚出可视区或被盖住时矩形照样正常（假 PASS） |

## 与外壳注入的关系（★ 两边只能活一个）

外壳 `src/main.js` 注入前会查 profile 里**有没有装本插件**：装了就**跳过注入**，并写一行 `shell.log`。
⇒ 插件缺失时（干净装机、没勾选插件）功能仍在，只是由注入版提供。

两者共用同一段 DOM 逻辑与同一个调试钩子 `window.__dshSidebarOpen`，靠 `.src`
（`"inject"` / `"plugin"`）区分身份，**验收脚本据此断言"现在跑的是哪一个"**。

## 调试钩子

```js
window.__dshSidebarOpen.state()   // { installed, stripVisible, menuVisible, hoverPath, calls, last, errors, src }
window.__dshSidebarOpen.src       // "inject" | "plugin"
```

`calls` / `last` 记的是我们**发起过的**请求与结果（`last.ok`）。
⚠️ 它是**插件自己的报告**，只能当线索 —— 判定"真打开了"要用独立证据
（真出现一个资源管理器窗口 / 真实进程），见 `docs\侧栏文件真打开-2026-09-23.md` 的复盘。

## 生成物警告

`lib/client.js` 是 **`scripts/port-inject-to-plugin.mjs` 机械生成**的（注入体逐字不变，
只把 `var shell = window.dshShell;` 换成桥）。**别直接编辑它** —— 改注入脚本或生成器后重跑：

```powershell
node scripts/port-inject-to-plugin.mjs           # 重新生成
node scripts/port-inject-to-plugin.mjs --check   # 只校对（退出码 2 = 需要重新生成）
```
