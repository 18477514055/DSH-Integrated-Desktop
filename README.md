# DSH 集成桌面端

把官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 内核装进原生 Electron 外壳。

> ⚠️ **社区项目，非官方出品。** DeepSeek Harness 本体、`@deepseek-ai/*` 软件包与官方前端
> 版权归 [deepseek-ai](https://github.com/deepseek-ai) 及其贡献者所有（MIT）。

---

## 下载：四条渠道，按你的情况挑一条

| # | 渠道 | 适合谁 | 怎么走 |
|---|---|---|---|
| ① | **[GitHub Releases](https://github.com/18477514055/DSH-Integrated-Desktop/releases)**（主渠道） | 能上 GitHub | 下载 `DSH-Integrated-<版本>-x64.exe` 直接装；附件里有 `SHA256SUMS.txt` 可校验 |
| ② | **国内网盘包** | 上不了 GitHub | 见 [`docs/下载与安装渠道.md`](docs/下载与安装渠道.md)（一条命令生成，含安装包 + 插件包） |
| ③ | **插件走 npm** | 想单独装插件 | `dsh plugin --profile web add dsh-int-xxx`（**外壳本身不在 npm 上**） |
| ④ | **客户端里的插件页** | 已经装了客户端 | 外壳设置 → 集成版插件 → 点着装；装完重启一次 |

### ★ 装之前：先确认你有内核

**客户端只装外壳、不带内核**（刻意的，这样内核能独立升级）。第一次用需要先有官方内核：

```bash
npm i -g @deepseek-ai/dsh
```

前提是本机有 Node.js。客户端找不到内核时会直接提示这句 —— **它不会替你装**。

### 已经装了旧版？

客户端里 **外壳设置 → 更新 → 检查更新** 就能升。它会**同时看线上与本机**
（本机自己打好的安装包也认），并列出扫过的目录。

> **完整的渠道说明、校验方法、插件装法、常见问题**：
> **[`docs/下载与安装渠道.md`](docs/下载与安装渠道.md)**

---

## 这个外壳的核心设计：**不拥有内核**

```
┌──────────────────────────────────────────────┐
│  外壳（本仓库）                                │
│   · 窗口 / 托盘 / 快捷键 / 单实例              │
│   · 找内核、起内核、探活、自愈                  │
│   ⛔ 不含任何内核代码                          │
└──────────────────┬───────────────────────────┘
                   │ 唯一接口 = 进程边界
                   ▼
┌──────────────────────────────────────────────┐
│  内核（外部，由 npm 独立管理）                 │
│   @deepseek-ai/dsh@<版本>                     │
│   ⛔ 外壳不改它、不嵌它、不替它升级            │
└──────────────────────────────────────────────┘
```

**为什么要这样**：内核可以独立升级，外壳不需要跟着改。
反过来（把内核嵌进安装目录）会让"升级内核 = 拆自己地基" ——
这是本项目立项的直接原因（详见 `docs/` 里的事故记录）。

---

## 从源码运行

```bash
npm install          # 会顺带检查机器上有没有可用的内核
npm start            # 启动
```

**前置条件**：机器上要有一个 dsh 内核。任选其一：

```bash
npm i -g @deepseek-ai/dsh          # 全局安装（推荐）
```

或把内核放到 `<项目>/vendor/dsh/`。

检查内核是否就绪：

```bash
node scripts/check-kernel.js
```

---

## 打包

```bash
npm run pack         # 只出未压缩目录（快，用于验证）
npm run dist         # 出 NSIS 安装包 + 便携版
```

产物在 `release/`。

> ⚠️ **国内网络**：Electron 二进制默认从 GitHub 下载，国内可能不通。
> 若 `npm install` 卡在 Electron 下载，用镜像：
> ```powershell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> npm install
> ```

---

## 数据目录（重要）

外壳**默认使用独立的数据目录**，与系统默认的 `~/.dsh` 隔离：

```
%APPDATA%\DSH Integrated\dsh-home\        ← 实际使用的就是这个（Windows 标准位置）
```

> ⚠️ **`<项目>\runtime\dsh-home\` 是一个死路径 —— 应用永远不会读它。**
> `src/main.js:123-128` 传的是 `app.getPath("userData")`；
> `src/kernel.js:100-110` 里 `runtime\dsh-home` 那条分支只在调用方**不传** `userDataDir` 时生效。
> 往 `runtime\` 里准备数据 = 白干（2026-09-20 真踩过，详见
> `docs/2026-09-20-环境迁移与验证记录.md` §2.1）。

**为什么隔离**：内核启动时会把 `$DSH_HOME/profiles/node_modules`
重写成与**当前内核**同世代的模块镜像。两个不同世代的内核共用同一个
`DSH_HOME`，后启动的会废掉先启动的。

另外，**会话格式是单向升级的**（0.1.5 有 v0→v1→v2→v3 迁移链，
但旧内核读不了 v3）。所以隔离能保住"旧内核 + 旧会话"这条退路。

想改用系统默认 `~/.dsh`：在 `settings.json` 里设 `"useSystemDshHome": true`，
但**请先确认没有旧世代内核在运行**。

---

## 配置文件

`settings.json`（位于 Electron 的 userData 目录）：

| 键 | 默认 | 说明 |
|---|---|---|
| `closeToTray` | `true` | 关窗口是否驻留托盘 |
| `port` | `3080` | 内核监听端口（本机现设为 `3105`，**避开社区端占用的 3080**） |
| `profile` | `"web"` | 用哪个 dsh profile |
| `workspace` | `null` | 内核工作目录（null = 用户主目录） |
| `useSystemDshHome` | `false` | 是否用系统默认 `~/.dsh` |

---

## 给这个环境装插件（**别用 `dsh plugin add` 传绝对路径**）

内核的 `dsh plugin` 在 Windows 下用 `shell: true` 起 pnpm
（`dsh/lib/plugin-Ddi42qoW.js:109-113`），而 Node 在这条路径上**不给参数加引号**
⇒ **任何含空格的绝对路径都会被 cmd 切开**。本机 userData 路径含空格
（`DSH Integrated`），所以这条路走不通（实测报 `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`）。

可行做法（社区端与 2026-09-20 的迁移都用这个）：

1. 把插件源放进 profile 目录内，例如 `profiles/web/plugin-src/`；
2. 直接改 `profiles/web/package.json`，用**无空格的相对规格**：
   `"dsh-crosshub": "file:./plugin-src/dsh-crosshub-0.2.1.tgz"`；
3. 在 **profile 目录里**直接跑 `pnpm.cmd install`（不是 `pnpm.ps1`，执行策略会挡）；
4. `dsh.profile.bundles` 里手工列上插件名 —— 内核只在 `dsh plugin` 成功时才自动重建这个列表，
   手写的列表会被原样尊重。

⚠️ 另有一个坑：`profiles/web/.dsh-plugin-install/hot-*.yml` 是插件安装器留下的**热补丁**，
里面可能 `insert` 一个已从 `package.json` 删掉的插件（本机真实案例：它会复活
`dsh-provider-qoder`，而那个插件与 0.1.5 内核不兼容）。搬 profile 时**不要带这个目录**。

---

## 诊断脚本

都在 `scripts/`，都可以直接 `node` 跑：

| 脚本 | 干什么 |
|---|---|
| `check-kernel.js` | 检查机器上有没有可用内核 |
| `probe-diag.js` | 真起内核，打印带/不带 token 的原始响应，模拟探活循环 |
| `boot-inspect.js` | 真起内核 → 跟 303 拿 Cookie → 读 `__DSH_BOOT__`，看插件是否真被加载 |
| `check-plugin-manifests.js` | 读各插件的 `dsh.bundle` / `dsh.client` 声明 |
| `ui-inspect.js` | 经 CDP 读**真实渲染界面**的文本（要先带 `--remote-debugging-port=9222` 启动应用） |

---

## 快捷键

| 键 | 作用 |
|---|---|
| **`Ctrl+1` / `Ctrl+2` / `Ctrl+3`** | **切页：本机 DSH / DeepSeek 网页版 / DeepSeek 开放平台**（见「三页切换」） |
| `Ctrl+,` | 打开设置 |
| `Ctrl+Shift+I` | 开发者工具 |
| `Ctrl+R` / `F5` | 重载当前页 |
| `Ctrl+Shift+O` | 在系统浏览器打开 |

关闭窗口默认驻留托盘；托盘右键可退出、切页或看关于信息。

> ★ 这些键对**每个页面各挂一次**（`before-input-event` 是 per-webContents 的）——
> 只挂在主窗口上的话，切到 DeepSeek 网站之后 `Ctrl+1` 就回不来了。

---

## 目录结构

```
├── src/
│   ├── main.js             Electron 主进程（窗口 / 托盘 / 生命周期 / IPC / 注入）
│   ├── kernel.js           内核发现、启动、探活、自愈
│   ├── sites.js            三页切换的视图层（WebContentsView 覆盖 + PAGES 单一出处）
│   ├── plugins.js          内置插件落位（随包分发 → 首次启动装进 profile）
│   ├── preload.js          外壳页面 ↔ 主进程的唯一通道（只暴露动作 id）
│   ├── diagnostics.js      「诊断与修复」动作白名单与执行器（主进程侧）
│   ├── status-page.html/js 启动加载页（白底黑鲸鱼 + 里程碑进度 + 诊断抽屉）
│   ├── settings.html/js    外壳自己的设置页（常规 / 诊断与修复 / 关于）
│   ├── shell-ui.css/js     两个外壳页面共享的样式与页面逻辑
│   ├── whale-path.json     官方鲸鱼几何（4 段子路径）
│   └── inject/
│       ├── model-search.js 注入官方 UI 的模型搜索框 + 提供方胶囊
│       └── page-switch.js  注入到页面里的「切换页面」把手（贴右侧边缘）
├── plugin/
│   └── dsh-multi-session/  客户端插件：多会话同时开工（大弹窗 + N 个输入框 + 一键发送）
│       ├── lib/client.js   浏览器半边（手写 bundle，无需构建）
│       ├── lib/index.js    宿主半边（空 apply —— 纯浏览器能力）
│       ├── cordis.patch.yml bundle 声明（**缺它内核直接拒绝加载**）
│       └── README.md       能力表 / 架构依据 / 装验退 / 踩过的坑
├── scripts/
│   ├── check-kernel.js     内核可用性检查
│   ├── make-icon.js        生成白底黑鲸鱼图标（多尺寸 PNG + 真 ICO）
│   ├── verify-icon.js      逐像素验证图标（自带 PNG 解码，零依赖）
│   ├── ensure-icon.js      打包前补齐并验证图标
│   ├── ui-check.js         CDP 真跑真看验证界面（loading / inject / reuse / probe）
│   ├── plugin-check.js     客户端插件的真跑验证（临时环境 + CDP + 磁盘交叉核对）
│   ├── install-plugin.js   把插件装进 profile（可预演 / 可回滚 / **绝不重启内核**）
│   ├── provision-check.js  ★ 内置插件落位逻辑的真跑验收（临时 DSH_HOME / 50 条断言）
│   ├── boot-peek.js        对正在跑的内核只读取一次引导载荷（看哪些插件真的被公告）
│   ├── platform-modules.js 从官方前端产物里抠出"平台共享模块表"及其导出清单
│   ├── slot-catalog.js     打印官方 61 个槽位的完整契约（注册选项/标准 props/最小示例）
│   ├── bundle-window.js    在压缩过的 bundle 里只看限定窗口（不把整行灌进上下文）
│   └── publish-release.py  ★ 发布 Release（GitHub API + curl 流式上传；**别用 gh release create**）
├── assets/                 图标（由 scripts/make-icon.js 生成）
├── runtime/                运行时数据（独立 DSH_HOME，不提交）
├── migration/              从社区版迁移数据的工具（不提交）
└── docs/                   设计文档与事故记录
```

界面定制那一轮的完整记录（改了什么 / 为什么 / **怎么验证的** / 怎么退回去）见
`docs/界面定制-2026-09-20.md`。
多会话插件那一轮的记录见 `docs/多会话插件-2026-09-21.md`（插件自己的能力表见
`plugin/dsh-multi-session/README.md`）。

---

## 多会话同时开工（客户端插件）

主输入框右侧、发送键旁边多了一个「**多会话**」按钮。点开是一个大弹窗：
默认 1 个输入框，点「新增会话」加行；每行是一条独立提示词（可各自选模型 / 工作区、
可挂附件、可用 `/` 命令与 `@` 文件引用）；**右下角一键发送** ⇒ 一次建 N 个会话并行跑。

它是**官方 Web 前端的客户端插件**，不是外壳的一部分。

> ### ★ 0.2.2 起它是「内置」的 —— 装完打开就有，**不需要任何人敲命令**
>
> 机制见 `AGENTS.md` §7：插件作为**真实目录**随包放在
> `<安装目录>\resources\plugins\`（不再塞进 `app.asar`），外壳启动时自动落位到
> `<DSH_HOME>\plugins\`，并把 profile 的**三处契约**一次写对（`dependencies` 里的
> `link:`、`dsh.profile.bundles`、`node_modules` 目录联接）。
> `link:` 指向**用户数据目录**，所以应用升级/卸载都不会留死链。
> 全新机器上 profile 是内核第一次跑才建的 ⇒ 会自动"装好 → 重启一次内核 → 出界面"，
> 用户只看到加载页多停一两秒。

下面这些命令是**开发机**上用的（打包版默认不接管，免得把开发用联接悄悄改写掉）：

```powershell
npm run provision:check     # ★ 内置落位逻辑的真跑验收（临时 DSH_HOME，40 条断言）
npm run plugin:check        # 真跑验证插件功能（临时环境，不碰你在用的 DSH_HOME）
npm run plugin:status       # 只读：现在装没装、联接指向哪
npm run plugin:install      # 开发用：把 profile 联接到**本仓库**（改源码即时生效）
npm run plugin:revert       # 回滚
```

**它们都不会重启内核** —— 装完要自己重启一次客户端（托盘 → 退出 → 重新打开）才生效。
这一条是刻意的：那条命令跑下去之后用户就看不见 AI 了，所以不该由 AI 来按。

**为什么要做成插件、以及"为什么不能直接复用官方那个输入框"**（四条各自足以致命的证据）
写在 `plugin/dsh-multi-session/README.md`，那里也记着实施过程中踩到的真坑
（插件包少了 `dsh.bundle` 声明内核直接拒绝启动、`onClick` 里未定义的 `ctx` 导致
"按钮在但点不动且不报错"、不等附件上传完就提交会被宿主拒绝……）。

---

## 三页切换：本机 DSH / DeepSeek 网页版 / DeepSeek 开放平台

窗口**右侧边缘**有一条细把手（默认 20px，悬停展开），点一下弹出三页清单，点哪页切哪页，
当前页打 ✓。另外两个入口是**托盘右键 → 页面**与 **Ctrl+1/2/3**。

| 页面 | 是什么 |
|---|---|
| 本机 DSH | 这个客户端本身（本机内核的官方界面） |
| DeepSeek 网页版 | <https://chat.deepseek.com/> |
| DeepSeek 开放平台 | <https://platform.deepseek.com/> |

**几个刻意的取舍**：

- **切走不停机**：网站是以**一层独立视图**盖在窗口上的，本机界面在下面继续活着 ——
  内核不断线、会话照跑（看一眼网页不会打断长回答）。
- **切回不重载**：站点页面只隐藏、**不销毁** ⇒ 不丢滚动位置、不丢登录态。
- **站点页里也有把手**：否则进去之后就没有出口（托盘是保险，但不该是唯一出路）。
- **登录态存在应用自己的数据目录里**，登录一次就记住。

**为什么必须进外壳**（而不是做成插件）：插件跑在官方前端的 React 树里，只有**网页**的能力；
而"把第三方站点装进同一个窗口"要 Electron 的**视图层**（`WebContentsView`）。
**`<iframe>` 也不行** —— 两个站点都带 `X-Frame-Options` / `frame-ancestors`，会被直接拒绝，
而且 iframe 里的登录态与主页面互相割裂。

**安全边界**：切页通道允许**官方 UI 与两个外部站点**调用（把手就注入在那里），
边界靠**取值写死** —— 只认 `dsh` / `chat` / `platform` 三个 id，别的一律拒。
即使第三方站点的脚本拿到这个通道，也只能在这三页之间切，不能执行命令、不能读写文件。

---

## 界面自检

```powershell
npm run verify:icon                 # 逐像素验证图标（白底/不透明/黑鲸鱼/居中/镂空/ICO 尺寸）
node scripts/ui-check.js loading    # 加载页 + 抽屉 + 动作清单（临时环境，不碰你的 DSH_HOME）
node scripts/ui-check.js inject     # 模型搜索框注入（临时环境 + 空端口）
node scripts/ui-check.js reuse      # 复用已有内核的两条路径
node scripts/ui-check.js pages      # ★ 三页切换：真点把手、真切页、真回读主进程状态（15 项断言）
npm run plugin:check                # 多会话插件：临时环境里真开弹窗、真发 2 条、真去磁盘找证据
npm run provision:check             # 内置插件落位：临时 DSH_HOME 里验三处契约 / 幂等 / 不越界 / 自愈
```

四个 `ui-check` 模式都**不碰**你正在用的环境：`loading`/`inject` 用临时 userData + 空闲端口 3177，
`reuse` 自己起一个"外来内核"来造复用场景（跑完会收尾杀掉）。

`plugin:check` 用的是**另一套**临时环境（`profiles/node_modules` 用目录联接只读借用，
插件也用联接指向本仓库），并且**刻意不看插件自己的结果文案** ——
它到临时 DSH_HOME 的磁盘上去找那两条提示词与附件字节，那才算证据。

---

## 分发：`github/` 是"可以直接上传"的暂存区

```powershell
npm run dist              # 1) 先打包（会顺带生成并逐像素验证图标）
git add -A && git commit  # 2) 提交 —— 工作区不干净时第 3 步会拒绝
npm run release:bundle    # 3) 生成 github/ 并逐文件审计
npm run release:check     #    任何时候都可以只审计现有 github/，不重新生成

# 4) 发布（顺序不能换：tag 打在**远端 HEAD** 上，必须先 push）
git push origin main
$env:GITHUB_TOKEN = (gh auth token).Trim()
npm run release:publish   # 建 Release + 传附件 + 回读
```

> ⚠️ **不要用 `gh release create`**（2026-09-20 实测）：本机 `gh` 是通的
> （`gh api rate_limit` 0.9 秒），但 `gh release create` 跑了 **20 分钟连 Release 都没建出来**，
> 进程活着、无输出、无报错。`publish-release.py` 改用 GitHub API + **`curl.exe` 流式上传**
> （第一版用 `urllib` 单次 POST 传 88 MB 会**卡死在代理上**：CPU 1 秒、内存 2 MB、连接不动），
> 并带"低速自动放弃"守卫与单文件重试。
> **发布后仍然必须把附件下载回来重算 sha256** —— 不看任何脚本自述。

`github/` 里只有这些：两个安装包、`RELEASE-NOTES.md`、`LICENSE`、
`SHA256SUMS.txt`、`source/<版本>-source.zip`。

**为什么这个目录在结构上一定干净**（不靠人每次眼检）：

1. `.gitignore` 是**白名单式**的 —— 默认忽略一切，只放行明确列出的路径。
   于是"能进 git 的"就等于"已经判过是安全的"。
2. 源码包用 **`git archive`** 产出 —— 它**只打包已跟踪文件**。
   被忽略的凭据 / 会话日志 / Cookies / 含 token 的内核日志**在构造上进不去**。
3. 生成后**逐个文件机械审计** —— 路径特征黑名单（17 条）+ 扩展名白名单 +
   内容密钥模式（8 类），任何一条不过脚本就**非 0 退出并打印明细**。

`github/` 本身**故意不进 git**（里面是 90 MB 级安装包，它本来就是要上传到 Release 的东西）。
上传命令见 `github/README-先看我.md`。

> 这一节的存在理由：本项目目录里曾经同时存在真实 API 凭据、几十个完整会话日志、
> 浏览器 Cookies 与含 token 的内核日志 —— 靠人每次判"哪些能公开"迟早会漏，
> 所以把它变成上面这三层**机械保证**。

---

## 许可

本项目以 **MIT** 发布。

- 本仓库的外壳代码：Copyright (c) 2026 陈黛华 / 18477514055
- 内嵌/调用的官方内核：Copyright (c) 2026 DeepSeek（MIT）

本外壳**不包含** chyra-moon 社区桌面端的代码，因此不涉及其署名义务。
