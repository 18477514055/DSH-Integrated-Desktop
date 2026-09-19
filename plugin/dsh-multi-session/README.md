# dsh-multi-session —— 多会话同时开工

> 一个大弹窗里放 N 个输入框（默认 1 个，点「新增会话」加），每行一条提示词；
> 右下角**一键发送** ⇒ 一次创建 N 个会话并把 N 条提示词分别发出去，它们并行跑。

这是 **DSH Integrated 的一个客户端插件**（浏览器半边插件），不是外壳的一部分。
触发按钮在**主输入框右侧、发送键旁边**。

---

## 它是什么 / 装在哪

| | |
|---|---|
| 类型 | 官方 Web 前端的**客户端插件**（`window.__ModuleLoader__.load({id, factory})` 形态） |
| 注册的槽位 | `conversation.input.right`（触发按钮）、`shell.overlay`（大弹窗） |
| 宿主半边 | `lib/index.js` 是空的 `apply()` —— **纯浏览器能力**，与官方 `@deepseek-ai/dsh-client-ui-session` 同形 |
| 宿主侧行为 | 无（不注册路由、不改配置、不碰凭据） |
| 依赖 | **零 npm 依赖**。只用平台共享模块表里的 `react` 与 `@deepseek-ai/dsh-client-ui-primitives` |

---

## 为什么做成"插件"而不是"注入脚本"（架构判断，附依据）

本仓库原有的扩展手法是往官方页面里注入 JS（`src/inject/model-search.js`）。
那对"改一个已存在的 DOM"够用，但这次要**创建会话**、**发消息**、**拿模型目录** ——
这些必须拿到官方的一等公民服务。官方给插件作者的正规入口就是客户端插件机制，
本机已有四个活例可作参照：`dsh-plugin-install`、`dsh-crosshub`、`dsh-qoder-connect`、
`dsh-connect-workbuddy`。

**为什么不复用官方那个输入框（这一条是本次最重要的结论）**：
官方输入框**在架构上不可复用**，四条独立证据，每条都足以致命：

1. 它是 `kind:'single'`、`scope:'session-maybe'` 的**单例槽位**，整个页面只有一个。
2. 它的会话来自 **React context 的"当前绑定"**，渲染路径上没有任何覆盖点
   （`RenderOpts` 无 scope 字段；`SessionProvider` 不接受会话参数）。
3. 插件**不能渲染**那个槽位（`SlotOwnershipError`；`ctx.slots.renderSlot` 只允许 `root`），
   也不能替换 scope 适配器（重复 `installScope` 直接抛错）。
4. 输入框组件与它的编辑器（`InputBar` / `ComposerContentEditable`）**既不导出也不可 require**
   —— 官方 `/client` 导出面只有 14 个值，没有一个是输入框；
   连 `lexical` 本身都不在平台共享模块表里（那张表只有 9 个词）。

⇒ 只能"部分重实现"：**文本面自己写，而语义（草稿/提交/命令/引用/模型）尽量借官方的**。

---

## 每行输入框有什么（这是用户选的"全功能档"）

| 能力 | 实现方式 | 官方依据 | 验证情况 |
|---|---|---|---|
| 多行文本 | 自己的 `<textarea>`（自动增高） | 官方编辑器拿不到，见上 | ✅ 真跑 |
| **模型选择**（每行各自选） | `ctx.remote.session.modelCatalog()` | **不需要 sessionId**（`types/catalog.d.ts:4` 明写 "without requiring a Session"） | ✅ 真跑：列出 5 项（含 reasoning 档位） |
| **`/` 命令菜单** | `ctx.remote.commands.list(sessionId)` | 位置参数、**必填 sessionId** | ✅ 真跑：6 条真实命令 |
| **`@` 文件引用** | `ctx.remote.fileReferences.list(sessionId, query)` | 同上；提及语法照抄官方 `formatFileMention` | ✅ 真跑：8 条真实路径 |
| **附件**（回形针 / 拖入？见下） | `ctx.conversation.createDrafts` + `sendSession` | 官方完整提交管线（乐观回显 / 图片 base64 / 文件凭据 / 结算） | ✅ 真跑：字节落到 `attachments/v1/files/…` |
| **工作区**（每行各自选） | 标准 prop `useWorkspaces` + `create({workspaceId})` | 官方字段名是 `workspaceId`/`title`，**不是** `id`/`name` | ✅ 真跑：下拉有内容 |

**发送走的是官方完整路径**：建会话 → （选了模型才）`selectModel` → `createDrafts` →
**等后台上传完成** → `sendSession(face, text, ids, "queue")`。
拿不到 `sendSession` 时会退回更底层的 `prompt([{type:'text',text}], 'queue')`，
**并且在结果里写明走了哪条路**（`路径：sendSession` / `路径：prompt()`），不假装成功。

---

## 为什么"建会话"推迟到点发送那一刻

`sessions` 命名空间**没有 delete**（可用方法只有
`attachment/cancel/canOpenWorkspacePath/control/create/follow/fork/list/modelCatalog/`
`openWorkspacePath/page/prompt/rename/search/selectModel/updateQueue`）。
如果为了"让每行挂上官方状态"而提前建会话，用户一取消就会在侧栏留下一堆**删不掉的空会话**。
所以：行状态自己拿着（文本、`File[]`、模型、工作区），**发送时才建**。代价是 `/` 与 `@`
只能借用"打开弹窗那一刻的当前会话"作作用域 —— 默认情况下新会话与它同工作区，所以候选是对的。

---

## 怎么装 / 验 / 退

```powershell
# 1) 真跑验证（临时环境，不碰你在用的 DSH_HOME；会短暂弹一个窗口）
npm run plugin:check

# 2) 预演 / 落盘 / 查状态 / 回滚
npm run plugin:status      # 只读：现在装没装、联接指向哪
npm run plugin:install     # 落盘（先自动备份 profile 的 package.json）
npm run plugin:revert      # 回滚：从备份恢复 + 删联接
```

`plugin:install` 改的是 **profile**（默认 B 环境的 `profiles/web`）三处，缺一处都是
"文件都在、界面什么都没有"：

1. `package.json` → `dependencies` 里加 `"dsh-multi-session": "link:<本仓库路径>"`
2. `package.json` → `dsh.profile.bundles` 末尾追加 `"dsh-multi-session"`
3. `node_modules` 里建**目录联接**指向本仓库（零网络、零解析、零构建；
   改仓库里的源码即生效，回滚就是删联接）

**它不会重启内核。** 装完要由人按一次重启（托盘 → 退出 → 重新打开）。
这一条是刻意的：AI 不该按下那个会关掉用户程序、让用户再也看不见它的按钮。

---

## 诚实的边界（别把这些说成"和官方 1:1"）

- **文本面是 `<textarea>`，不是官方那套 Lexical 富文本**。没有引用 chip 的原子节点、
  没有装饰器与 span 映射；`@` 引用插入的是**字面提及文本**（与官方提交时的序列化形式一致，
  因为官方的引用 codec 就是恒等函数）。
- **`/` 与 `@` 菜单是本插件自己弹的**，不是官方 `MenuView`（那个组件没有导出，
  且它的 `pick` 会把事件派发进官方 Lexical 编辑器 —— 插件拿不到）。
- **行内 Enter 是换行，不是发送**（`Ctrl/Cmd+Enter` = 一键发送）。
  这是刻意的：本弹窗的语义是"写完 N 行一起发"，行内 Enter 直接发会导致"某一行偷偷先跑了"。
- **没有权限预设 / Agent 预设 / Plan 模式**（不在本次范围内）。
- **`/` 与 `@` 的作用域是"打开弹窗那一刻的当前会话"**（原因见上）。
  若你打开弹窗后切走会话，候选仍来自原来那个。
- 附件目前只支持**回形针选取**（拖入与粘贴还没接）。

---

## 源码怎么读

`lib/client.js` 是**手写的单文件 bundle**（没有构建步骤，仓库里不带 esbuild）。
文件开头就是完整的设计说明与逐条出处，正文按这个顺序：

```
常量 → 小工具 → 状态 store → 样式 → 模型目录 → 命令/引用 → 等待上传 → 发送
     → 触发菜单 → 触发按钮组件 → 行组件 → 弹窗组件 → 插件本体（apply）
```

几条**踩过的真坑**（都在源码注释里留了原文）：

| 坑 | 表现 | 出处 |
|---|---|---|
| 插件包只写 `dsh.client` 不写 `dsh.bundle` | 内核直接拒绝启动：`declares no dsh.bundle in its package.json` | 第一次真跑抓到 |
| `onClick` 里用了未定义的 `ctx` | **按钮在、点了没反应、控制台不报错** | 靠"点击计数 + onClick 内 catch"抓出 |
| 继承槽位 owner 的 `disabled` | 当前会话忙碌时按钮变灰点不动（恰恰是最想用它的时候） | 同上 |
| 不等附件后台上传就 `sendSession` | `conversation.sendSession: one or more files have not finished uploading` | 官方是禁用发送键，本插件必须等 |
| 槽位注册失败被静默吞掉 | bundle 加载了、界面一个挂载点都没有且不报错 | `dsh-crosshub` 源码里的事故注释；本插件用 `diagnostics` 记录下来 |
