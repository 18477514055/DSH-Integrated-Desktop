# 2. 归档管理器 —— DSH 插件 `dsh-int-archive-manager`

> ★ **接手前先读 [`改名与交接-20260922.md`](./改名与交接-20260922.md)**：
> 这个插件 2026-09-22 由 `dsh-archive-manager` 改名为 `dsh-int-archive-manager`（0.1.0 → 0.2.0，
> 因为原名在 npm 上已被 jasonrale 占用）。那份文档写清了三处「必须同时改」、
> **目录名刻意不动**的原因、以及一个**与改名无关的既有 FAIL**（别栽在那里）。

> **位置**：第三工作区 `D:\DSH工作区002\2.归档管理器\`（2026-09-21 从第二工作区 `7.归档管理器` 搬来）。
> 包名仍是 `dsh-int-archive-manager`（内核靠它识别，与项目目录名无关）。

在侧边栏新增**第 4 个顶层分组**「已归档」，里面是已归档的对话：可搜索、可按天筛选、可"永久删除"腾空间。

> **状态：已自验，尚未安装。** 等你验收通过后我再装进 DSH。
> 目前它对你的 DSH 环境 **零改动**（只做过只读检查，见 §7 证据）。

---

## 一、它长什么样

```
侧边栏                                    中间主面板
─────────────                            ──────────────────────────────
🐟 DeepSeek                               已归档的对话   27 条 · 12.52 MB
➕ 新建会话                                [归档列表] [转储文件夹(3)] [刷新]
📁 DeepSeek-Workspace   ← 工作区 1
📁 deepseek-workspace   ← 工作区 2        转储文件夹 [D:\...\已删除归档] [保存]
📄 未分组                ← 未分组
📦 已归档                ← ★ 本次新增      [搜索标题/目录…] [2026-09-18] [全部][9月18日(15)]…
                                          ─────────────────────────────
                                          □ 做一次全面分析…     9月18日 12:14  7.2 MB  [永久删除]
                                          □ 检查硅基流动免费…   9月18日 05:30  1.5 MB  [永久删除]
                                          …
```

点「已归档」→ 中间大面板显示管理器。点某条「永久删除」→ 弹窗要求**手打标题确认** → 文件被搬到转储文件夹。

---

## 二、三个核心行为（都是你拍板的）

### 1. 「永久删除」到底做了什么

**不是抹除，是搬到你自己指定的文件夹。**

搬走三样东西（少一样就会留下幽灵条目）：

| # | 什么 | 在哪 |
|---|---|---|
| ① | 会话日志 `session.v3.jsonl.zstd` / `session.jsonl.zstd` | `$DSH_HOME\sessions\<工作区>\<会话id>\` |
| ② | 标题时间缓存 `<会话id>.json` | `$DSH_HOME\storages\session_projcache\sessions\` |
| ③ | 归档登记（两处） | `$DSH_HOME\storages\workspace.json` 的 `global.archivedSessionIds` 与各工作区的 `sessionIds` |

> **为什么③必须一起做**：只删文件不动登记 ⇒ 归档名单里留一条指向空气的 id，
> 界面上是**删不掉也打不开的幽灵条目**。删到一半的系统比没删的更难收拾。

### 2. 转储文件夹由你在界面里指定，随时可改

默认 `D:\DSH工作区002\2.归档管理器\已删除归档`，面板上能直接改。
设之前会**真写一次测试文件**验证可写 —— 填了写不进去的路径会当场报错，不会静默设坏。

### 3. 之后你自己决定什么时候真正删

搬过去之后字节**仍在盘上**（只是换了位置）。要真正腾空间：打开那个文件夹 → 全选 → 删除。
在那之前，随时可以在插件的「转储文件夹」页点**还原**搬回去。

- 每个会话一个子文件夹：`20260921-104533-归档会话甲\`，里面放日志文件 + `原路径.txt`
- 文件名带日期和标题，你在文件夹里**一眼能认出**是哪次对话

---

## 三、为什么必须写插件（官方给不了）

**官方内核没有"删除会话"的能力。** 逐条核实过：

| 查的地方 | 结论 |
|---|---|
| `dsh-session-persistence` 的 `SessionPersistence` | 只有 `create / open / flush / stat / list` —— **没有 delete** |
| 会话远程方法表（`typert.remote-client.d.ts:14-31`） | 15 个方法，**没有 delete/remove/purge** |
| `ctx.sessions`（`contract/sessions.d.ts:19-124`） | 有 `create/open/fork/search`，**没有 delete** |
| 官方自己的注释 | multi-session 插件文件头：「`sessions` 命名空间**没有 delete**」 |

官方只有**归档**（`archiveSession` / `archivedSessionIds`）—— 归档只是"藏起来不显示"，
**日志一个字节都没少**。所以要腾空间，只能自己动磁盘。

而浏览器里的插件读不到文件系统 ⇒ 必须由 **node 侧的宿主半边**来做，
再通过 HTTP 暴露给界面。这条路与已装插件 `dsh-whale-widget` 完全同构
（它用 `ctx.webServer.register` 挂了 9 个路由）。

---

## 四、界面是怎么挂上去的（关键架构判断）

我要的是"第 4 个顶层分组"。查过的槽位：

| 槽位 | 类型 | 能不能用 |
|---|---|---|
| `sidebar.workspaces` | **single** | ❌ **绝不能碰** —— 官方 WorkspaceBrowser 独占，注册就是**替换掉整个会话列表** |
| `sidebar.panellist` | list | ✅ **唯一**能新增顶层行的地方 |
| `main` | keyed | ✅ 点击后中间大面板显示什么 |

**两条注册必须成对**，且 `panellist.id` **`==`** `main.key`：
内核的 `layout.selectPanel(id)` 会校验这个 id 在 `main` 里真的注册过，
不一致就抛 `main panel "..." is not registered`（`dsh-client-ui-layout/lib/client.js:413`）。

这一点在 `tools/client-check.mjs` 里有专门一条断言守着。

---

## 五、安全设计

1. **只动归档会话** —— 第一步校验 id 在 `archivedSessionIds` 里，不在就拒绝。活会话永不触碰（e2e 有断言）。
2. **绝不抹除** —— 只 `rename`（同盘原子移动）。跨盘会失败（EXDEV），此时**不降级成"复制再删"**，而是报错、一字节不动。
3. **手打标题二次确认** —— 前端要打，**服务端再校验一次**（前端可以被绕过）。
4. **改注册表是最后一步**，且原子写（临时文件 + rename）。
5. **失败如实报** —— 返回 `done` / `failed` 两个清单，绝不说假的"删除成功"。

---

## 六、自验结果（真跑，不是"文件存在"）

```
node tools/e2e-check.mjs      → 63 条断言，PASS 63 / FAIL 0   （宿主半边：搬/还原/抹除/安全边界/不污染）
node tools/client-check.mjs   → 33 条断言，PASS 33 / FAIL 0   （浏览器半边：槽位/渲染）
node tools/install-dry.mjs    → 22 条断言，PASS 22 / FAIL 0   （内核 bundle 契约前置检查）
node tools/dry-run.mjs        → 只读列出你真实的 27 条归档（12.52 MB）
```

e2e 全部在**临时目录**里跑，真实 DSH 家一个字节没碰。

### 开发中抓到并修掉的真 bug（都是测试抓的，不是我事后想起的）

| bug | 症状 | 怎么抓到的 |
|---|---|---|
| 日志名只写 v3 | 27 条归档里 **25 条体积显示 `-`**，合计 0.33 MB 而非真实 12.52 MB | dry-run 数字明显不对 |
| `Split-Path -LiteralPath X -Leaf` | PowerShell 5.1 报 `AmbiguousParameterSet`，回收**静默失败** | e2e 第 5 组 |
| 还原只搬文件不登记 | 文件回来了但**界面上找不到**（不在任何列表） | e2e 第 8 组 |
| 还原时先删槽 | 下一步要读 `_origin.json` 去登记，**文件已没了** | e2e 第 8 组 |
| 配置写进插件目录 | e2e 把临时路径写进**真实交付物** | e2e 第 11 组（专门为它加的） |
| client 验证器不展开组件 | 7 条断言**假 FAIL**（元素其实都在） | client-check 自己暴露的 |
| **`inject` 写了 `homePaths`** | **内核直接起不来**（`waiting for service: homePaths`） | 真跑 `plugin:check:archive` |
| **家解析到真实环境** | 临时家里跑，`home` 却打印真实路径 | 真跑的"硬闸门"断言 |
| **验证环境搭错** | 13 条红 11 条，但**不是插件坏了** | 照抄 `plugin-check.js` 的 buildTempHome 才对 |

其中两条最值得记：
- **"尺子错了"会让结论差 38 倍**（0.33 MB vs 12.52 MB）。
- **"包存在、导出对"是代理证据**：`dsh-home-paths` 存在、导出看着也对，
  但它是纯函数模块、不是 cordis 服务 —— 只有真启动才暴露。

---

## 七、它到底有没有动过你的环境

**没有。** 全程只做了只读检查：

| 时间 | 动作 | 影响 |
|---|---|---|
| 全程 | 读 `$DSH_HOME` 的目录与 JSON | 只读 |
| 测试 | 在 `%TEMP%` 造假 DSH 家跑 e2e | 临时目录，已清 |
| **早期一次** | 试系统回收站方案 | **弹了确认框** → 当场废弃该方案（你反馈"一直跳弹窗"） |

复核（只读）：归档 **27 条**、会话目录 **145 个**、投影缓存 **139 个** —— 与开工前一致。

> ### 关于"跳弹窗"那件事（完整交代）
> 第一版走 Windows 系统回收站（Shell COM `InvokeVerb('delete')`），**删一条弹一次确认框**。
> 你当场反馈后我立刻停手：核实数据完好 → 清理临时目录 → **废弃该方案**。
> 现在改成搬到你自己指定的文件夹，全程**纯文件移动，不经过 Shell，绝不弹窗**。

---

## 八、已知边界（诚实说）

| 边界 | 说明 |
|---|---|
| **删完侧边栏不立刻刷新** | 内核在内存里持有会话名单，不因为我们改了磁盘就重读。要看到效果得**重启客户端**。 |
| **空间不会立刻释放** | 搬到转储夹后字节仍在盘上，要你自己去删。这是"可反悔"的代价。 |
| **搜索范围** | 目前搜标题 + 工作区名 + 目录。官方还有一个搜消息正文的 `session/search`，本次没接（归档会话的正文索引可用性未验证）。 |
| **没做"批量删除"** | 逐条删，每条都要确认。故意的 —— 批量 + 不可逆 = 最容易出事。 |

---

## 九、安装状态：**已装**（2026-09-21）

三处契约都已落盘（走脚本，没手敲）：

| 契约 | 值 |
|---|---|
| `dependencies` | `link:D:\deepseek-workspace\5.DSH集成桌面端\plugin\dsh-int-archive-manager` |
| `dsh.profile.bundles` | 含 `dsh-int-archive-manager`（共 12 项） |
| `node_modules` 联接 | → `D:\DSH工作区002\2.归档管理器` |

**源码真身在第 3 工作区**，`5.DSH集成桌面端\plugin\` 下是个 junction 指过去
（单一真源，改一处两边生效）。

```powershell
cd D:\deepseek-workspace\5.DSH集成桌面端
npm.cmd run plugin:status -- --plugin dsh-int-archive-manager   # 查状态
npm.cmd run plugin:check:archive                            # 真跑 14 条断言
npm.cmd run plugin:revert  -- --plugin dsh-int-archive-manager  # 不满意就撤
```

> ⚠️ **装完要你重启一次客户端才生效**（宿主启动快照客户端 bundle）。
> AI 不替你重启 —— 这个会话就跑在那个内核里，重启等于把自己杀掉。

### 真跑证据（plugin-check:archive，14/14）

```
PASS  ① 启动图里有 dsh-int-archive-manager（共 60 条）
PASS  ② 插件注入了自己的 <style>（说明 apply() 真的跑了）
PASS  ② 调试钩子存在 / 两个槽位都注册成功（没有静默失败）
PASS  ③ 侧边栏出现了「已归档」这一行      ← 真的在 DOM 里找到了
PASS  ③ 「已归档」这一行点得动
PASS  ③ 点完之后主面板真的渲染出来了
PASS  ③ 主面板里有搜索框 / 按天筛选 / 转储文件夹设置框
PASS  ③ HTTP 接口通了（health.json、list.json）
PASS  ③ 插件用的家是临时目录（不是真实环境）
```

### 这轮真跑抓到的 3 个真 bug（**只有真跑才抓得到**）

| bug | 症状 | 教训 |
|---|---|---|
| `inject` 写了 `homePaths` | **内核起不来**：`1 entry did not activate / waiting for service: homePaths` | `dsh-home-paths` 是**纯函数模块**，不是 cordis 服务。我当初的"证据"是"包存在、导出对"——**那是代理证据** |
| 家解析到真实 B 家 | 临时家里跑，`home` 却打印真实路径 | 判据要求"同时有 sessions/ 和 workspace.json"太严，**全新家没有 sessions/** ⇒ 被判死 ⇒ 落到真实环境 |
| 只传 `--user-data-dir` | 13 条断言红 11 条 | 那样是**全新 profile**，没有我的插件。**不是插件坏了，是我的验证环境搭错了** |

---

## 十、文件清单

```
D:\DSH工作区002\2.归档管理器\
├─ README.md                  ← 本文件
├─ package.json               双声明（dsh.bundle.patch + dsh.client）
├─ cordis.patch.yml           ★ 缺它内核直接拒绝加载
├─ lib\
│  ├─ index.js            宿主半边：挂 9 个 HTTP 路由
│  ├─ client.js           浏览器半边：侧边栏分组 + 主面板 UI
│  ├─ archive-store.js    归档清单解析 + 搬移 + 重新登记
│  ├─ paths.js            会话文件在哪（v0/v3 两种日志名）
│  └─ recycle.js          转储目录：搬入 / 列出 / 还原 / 抹除
└─ tools\
   ├─ dry-run.mjs         只读：列出真实归档 + 删除计划
   ├─ e2e-check.mjs       真跑 63 条断言（临时目录）
   ├─ client-check.mjs    真跑 33 条断言（槽位与渲染）
   └─ install-dry.mjs     真跑 23 条断言（内核契约前置检查）
```

> 注：搬来时**去掉了外面一层 `plugin\dsh-int-archive-manager\`**。原来那个层级是给
> `5.DSH集成桌面端\plugin\` 的自动发现机制用的（那边 `plugin/` 下每个目录=一个插件）；
> 本工作区是**薄层 + 指针**（见 `00-先看我` §六），没有那套机制，多一层只是让人多点一次。

---

## 十一、你现在可以做的事（不用等安装）

```powershell
# 看看它认出了哪些归档会话（只读，绝不改动任何东西）
node D:\DSH工作区002\2.归档管理器\tools\dry-run.mjs
```

它会列出你真实的 **27 条归档**（12.52 MB），带日期、体积、标题，以及"删这条会搬走哪些文件"。
**先看这个清单跟你心里那批是不是同一批** —— 对得上再让我装。
