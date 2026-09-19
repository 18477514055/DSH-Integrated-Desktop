# DSH 集成桌面端

把官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 内核装进原生 Electron 外壳。

> ⚠️ **社区项目，非官方出品。** DeepSeek Harness 本体、`@deepseek-ai/*` 软件包与官方前端
> 版权归 [deepseek-ai](https://github.com/deepseek-ai) 及其贡献者所有（MIT）。

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
| `Ctrl+Shift+I` | 开发者工具 |
| `Ctrl+R` / `F5` | 重载页面 |
| `Ctrl+Shift+O` | 在系统浏览器打开 |

关闭窗口默认驻留托盘；托盘右键可退出或看关于信息。

---

## 目录结构

```
├── src/
│   ├── main.js             Electron 主进程（窗口 / 托盘 / 生命周期 / IPC / 注入）
│   ├── kernel.js           内核发现、启动、探活、自愈
│   ├── preload.js          外壳页面 ↔ 主进程的唯一通道（只暴露动作 id）
│   ├── diagnostics.js      「诊断与修复」动作白名单与执行器（主进程侧）
│   ├── status-page.html/js 启动加载页（白底黑鲸鱼 + 里程碑进度 + 诊断抽屉）
│   ├── settings.html/js    外壳自己的设置页（常规 / 诊断与修复 / 关于）
│   ├── shell-ui.css/js     两个外壳页面共享的样式与页面逻辑
│   ├── whale-path.json     官方鲸鱼几何（4 段子路径）
│   └── inject/
│       └── model-search.js 注入官方 UI 的模型搜索框 + 提供方胶囊
├── scripts/
│   ├── check-kernel.js     内核可用性检查
│   ├── make-icon.js        生成白底黑鲸鱼图标（多尺寸 PNG + 真 ICO）
│   ├── verify-icon.js      逐像素验证图标（自带 PNG 解码，零依赖）
│   ├── ensure-icon.js      打包前补齐并验证图标
│   └── ui-check.js         CDP 真跑真看验证界面（loading / inject / reuse / probe）
├── assets/                 图标（由 scripts/make-icon.js 生成）
├── runtime/                运行时数据（独立 DSH_HOME，不提交）
├── migration/              从社区版迁移数据的工具（不提交）
└── docs/                   设计文档与事故记录
```

界面定制那一轮的完整记录（改了什么 / 为什么 / **怎么验证的** / 怎么退回去）见
`docs/界面定制-2026-09-20.md`。

---

## 界面自检

```powershell
npm run verify:icon                 # 逐像素验证图标（白底/不透明/黑鲸鱼/居中/镂空/ICO 尺寸）
node scripts/ui-check.js loading    # 加载页 + 抽屉 + 动作清单（临时环境，不碰你的 DSH_HOME）
node scripts/ui-check.js inject     # 模型搜索框注入（临时环境 + 空端口）
node scripts/ui-check.js reuse      # 复用已有内核的两条路径
```

四个模式都**不碰**你正在用的环境：`loading`/`inject` 用临时 userData + 空闲端口 3177，
`reuse` 自己起一个"外来内核"来造复用场景（跑完会收尾杀掉）。

---

## 分发：`github/` 是"可以直接上传"的暂存区

```powershell
npm run dist              # 1) 先打包（会顺带生成并逐像素验证图标）
git add -A && git commit  # 2) 提交 —— 工作区不干净时第 3 步会拒绝
npm run release:bundle    # 3) 生成 github/ 并逐文件审计
npm run release:check     #    任何时候都可以只审计现有 github/，不重新生成
```

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
