# dsh-mobile-remote —— 手机遥控

> 电脑右下角一个「📱」按钮 → 点开是二维码 → **手机扫一下**就能看会话、看流式输出、
> 发消息、发图片、切模型、中断任务、批准/拒绝审批。
>
> 两条路都能走：**手机浏览器**（零安装）或**装个 Android App**（更像正经应用）。

这是 **DSH Integrated 的一个客户端插件**（官方 Web 前端的浏览器半边插件 + 一个宿主半边）。

---

## 两条路，选一个

| | ① 浏览器（零安装） | ② Android App（WebView 壳） |
|---|---|---|
| 怎么开始 | 用**系统相机**扫电脑上的**第一个**二维码 | 先装 `android/` 编出的 APK，再扫**第二个**二维码 |
| 手机要装东西吗 | **不用** | 要装 APK |
| 体验 | 有图标（可"添加到主屏幕"），但地址栏在、非独立窗口 | 无地址栏、独立任务、桌面图标 |
| 功能 | **完全一样**（App 就是个全屏 WebView，加载的是同一个页面） | 同左 |

> 装了 App 就扫**第二个**码（`dshmr://` 深链，扫到直接进 App）；
> 没装 App 就扫**第一个**（普通 http，任何相机都能扫、开浏览器）。
> 两个码内容不同但功能一致 —— 电脑端弹窗里都给了。

---

## 手机端能做什么（对着你提的四条都改了）

**① 会话列表**（原来"太素、看不出哪个是哪个"）
- **标题**：读会话日志里的 `session/title`，显示人看得懂的名字（不再是一串 sessionId）
- **工作区胶囊**：📁 一眼看出属于哪个项目
- **相对时间**：刚刚 / N 分钟前 / 昨天 / 月-日
- **运行中**标记（绿边 + ●）、**空会话**置灰
- **搜索框**：按标题 / 工作区 / 路径过滤

**② 聊天区**（原来"看不到思考过程、工具只有一行、代码块没排版"）
- **思考过程**：可折叠（默认收起，标题显示字数），不再刷屏
- **工具调用**：独立成卡（黄色左边条 + 工具名 + 参数/结果）
- **代码块**：``` 围栏渲染成等宽代码块，带语言标签
- 流式输出逐字显示

**③ 发消息**（原来"没历史、换行/发送不分、不能发图"）
- **历史输入**：🕘 按钮，本机存最近 30 条，点一下填回输入框
- **回车=换行 / Ctrl(⌘)+回车=发送**：刻意区分，避免手滑发出去
- **发图片**：🖼 选图 → 缩略图预览 → 可删；base64 直传，宿主自己提升为持久附件

**④ 操控感**（原来"只能发消息"）
- **切模型 + 思考强度**：⚙ 按提供方分组（实测 3 个来源 / 41 个模型），有 reasoning 的再选一档强度
- **新建会话并选工作区**：＋
- **审批**：电脑上要批准某个工具调用时，**手机上会弹出来**，可直接「允许 / 拒绝」

---

## 它是什么 / 装在哪

| | |
|---|---|
| 类型 | 官方 Web 前端的**客户端插件**（`window.__ModuleLoader__.load({id, factory})` 形态）+ 宿主半边 |
| 注册的槽位 | `shell.overlay`（右下角悬浮按钮 + 大弹窗） |
| 宿主半边 | `lib/index.js`：起一个**局域网 HTTP 服务**（默认 `0.0.0.0:3110`），并在官方 `webServer` 上挂三个**同源路由** |
| 依赖 | **零 npm 依赖**。二维码用 vendor 进来的 `lib/qr.cjs`（MIT，见 `lib/qr-LICENSE.txt`）；token 用 `node:crypto` |
| 手机端 | `web/` 里的静态页面（由宿主半边自己发，无需构建、无需 CDN） |
| Android 壳 | `android/`（零第三方依赖的 WebView 工程，**见其 README 的验证状态**） |

**为什么二维码在电脑端生成**：手机端页面要显示二维码的话，要么依赖外网在线服务、
要么自己带一份编码器；而电脑端**本来就有 Node**，生成成 SVG 直接塞进界面最省事，
而且**离线可用**。

---

## 怎么用

1. 装好、**重启客户端**（见下）
2. 右下角出现「📱」→ 点开
3. 手机连**同一个 Wi-Fi**，用**系统相机**扫码
   - 没装 App → 扫**第一个**码（开浏览器）
   - 装了 App → 扫**第二个**码（直接进 App）
4. 自动配对，进入会话列表

弹窗里还有：**8 位配对码**（相机扫不了时手输）、局域网地址、已配对设备数、
「换一张码」、「断开全部手机」。

> **配对码 60 秒自动更换、用过即废。** 换码是自动的（弹窗开着时会自己刷新倒计时）。

---

## 怎么装 / 验 / 退

```powershell
# 1) 真跑验证（临时环境起真内核，不碰你在用的 DSH_HOME；会短暂弹一个窗口）
node scripts/plugin-check-mobile-remote.js
node scripts/plugin-check-mobile-remote.js --keep   # 保留临时目录（排查用）

# 2) 预演 / 落盘 / 查状态 / 回滚（★ 注意要带 --plugin）
node scripts/install-plugin.js --plugin dsh-mobile-remote --status    # 只读：装没装、联接指向哪
node scripts/install-plugin.js --plugin dsh-mobile-remote --apply     # 落盘（先自动备份 profile 的 package.json）
node scripts/install-plugin.js --plugin dsh-mobile-remote --revert    # 回滚

# 3) 二维码单独体检（编码 → 用**另一个独立解码器**读回来）
node scripts/qr-check.js
```

`--plugin` 是 2026-09-20 泛化出来的；**不带它时行为与以前完全一样**（默认 `dsh-multi-session`）。

装完改的是 **profile**（B 环境 `profiles/web`）三处，缺一处都是"文件都在、界面什么都没有"：

1. `package.json` → `dependencies` 里加 `"dsh-mobile-remote": "link:<本仓库路径>"`
2. `package.json` → `dsh.profile.bundles` 末尾追加 `"dsh-mobile-remote"`
3. `node_modules` 里建**目录联接**指向本仓库

**脚本不会重启内核。** 装完要由人按一次重启（托盘 → 退出 → 重新打开）。
这一条是刻意的：AI 不该按下那个会关掉用户程序、让用户再也看不见它的按钮。

---

## 验证状态（**别把两件事混为一谈**）

| 部分 | 状态 | 证据 |
|---|---|---|
| 电脑端插件 | ✅ **已真跑验证** | `plugin-check-mobile-remote.js`：**33 项全过、4 连跑全过**；含真 HTTP 端到端 + **磁盘交叉核对** |
| 二维码（含 App 深链） | ✅ **已交叉验证** | `qr-check.js`：**19 项全过**，用**另一个独立实现**（jsQR）解码读回 |
| Android 壳工程 | ⚠️ **未验证** | 写它的机器上**没有 Android SDK / JDK / Gradle**（实测全部"没有"），**一次都没编过** |

⇒ 电脑端是硬的；**Android 壳是"应该能编、逻辑极简、但没实测过"**。
细节与打包步骤见 `android/README.md`。

---

## 诚实的边界（**先看这段再决定要不要开着**）

- **没有 TLS，局域网内是明文。** 配对码与 token 在同一 Wi-Fi 下可被嗅探。
  **在家用 Wi-Fi 下可以接受；不要在公共 Wi-Fi / 公司网络里开着。**
- **服务监听 `0.0.0.0`** ⇒ 同一局域网内谁都能连到那个端口。安全性完全靠
  **一次性配对码（60 秒、用过即废）+ 随机 token（256 bit）**。
- **配对成功后，那台手机拥有与电脑端同等的操作能力**：能发提示词、能中断任务、
  **能批准工具调用**。本插件**不做**按设备的能力裁剪，也没有"只读模式"。
- **审批桥接的三条规则**（都关系到"会不会把电脑端卡住"，代码里有详细注释）：
  1. **没有手机在线时立刻让位**给官方其它 answerer —— 否则电脑上的审批框会不再弹出；
  2. **有手机在线但没人回答 ⇒ 90 秒后让位**，**不是自动同意**（自动同意 = 安全倒退）；
  3. 手机点「拒绝」会真的返回 `rejected`；**刻意不提供"永远同意"**（那需要持久化策略，
     风险面完全不同）。
- **token 只存在内存里**，重启内核即全部失效、需要重新扫码。这是刻意的取舍：
  手机能远程操作电脑上的 Agent，凭据落盘比"重启要重扫"危险得多。
- 手机端**不能**：选 Agent 预设、改权限预设、拖拽/粘贴附件（只支持点选图片）。
- **没有推送通知**：手机锁屏后不会提醒你有新输出，要自己切回页面看。
- 手机端页面是 `http://`（非安全源）⇒ 浏览器里"添加到主屏幕"只能得到**书签快捷方式**，
  不是独立窗口；**要真正的独立 App 体验就得装那个壳**。

---

## 上一版（qwen 做的那个）为什么"装不上去"

> 结论：**不是"装不上去"，是从没被接进装载链，而且代码本身跑不起来。**
> 五处硬伤，每一处单独都足以致命。留在这里是为了以后别再犯。

| # | 硬伤 | 证据 |
|---|---|---|
| 1 | **宿主半边连语法都不合法** | `node --check lib/index.js` → `SyntaxError: Unexpected token 'export'`，崩在 `export interface Config {` —— TypeScript 类型语法写进了 `.js` |
| 2 | **浏览器半边有顶层 `export`** | 客户端 bundle 是以**经典脚本**加载的（`dsh-client-modules/lib/client.js`：`createElement("script")` + `.src`，没有 `type=module`）⇒ 顶层 `export` 是语法错误，脚本**静默加载失败**、插件根本不出现 |
| 3 | **依赖根本不存在** | `import jwt from 'jsonwebtoken'`，而全盘扫 `profiles` 下 **jsonwebtoken / qrcode 一个都没有** ⇒ 必然 `ERR_MODULE_NOT_FOUND` |
| 4 | **`inject` 声明了不存在的包名** | 要求 `@deepseek-ai/dsh-client-command`，实际只有 `dsh-client-ui-commands`；且缺 `external` |
| 5 | **客户端半边压根没注册槽位** | 返回 `{inject: (ctx) => {…}}` —— 契约要求 `inject` 是**字符串数组**、`apply` 才是函数；全文 `ctx.slots.inject/register` **0 处**，只往 `document.body` 挂了个 div |

另外它还被 `profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles` **双双遗漏**
（两处都没有它）⇒ 内核按那个列表组合 profile，它永远不会被加载。端口 3110 也无监听。

**就算语法全修好，功能也还不通**（4 个语义缺口）：

1. PWA 发不出去：服务端只实现了 `/health`、配对、`/ws/mobile`，**没有静态文件处理**，默认 404
2. 一次性码永不变：`Date.now() + 5000 < Date.now() + this.CODE_TTL_MS` **恒为真**，与"60 秒轮换"完全相反
3. 手机永远连不上：服务端要求 WS 握手带 `Authorization: Bearer`，而浏览器 `new WebSocket()` **无法设置请求头**
4. 二维码用外网 `api.qrserver.com` 生成，且编的是**裸配对码不是 URL** ⇒ 断网即废、扫了也没法直接跳转

---

## 真跑时抓到的四个坑（都留了注释）

| 坑 | 表现 | 怎么抓到的 |
|---|---|---|
| `cordis.patch.yml` 的 `name` 写成显示名 `'Mobile Remote Plugin'` | **整个 profile 起不来**、界面退到状态页：`failed to import loader entry dsh-mobile-remote (Mobile Remote Plugin): Cannot find package 'Mobile Remote Plugin'` —— `name` 是 loader 用来 `import` 的**模块标识符**，不是给人看的 | 真跑第一次就抓到，日志原文在 `shell.log` |
| 客户端 `inject` 写成**包名** `['@deepseek-ai/dsh-client-ui-slots']` | 插件**永远停在 pending**、界面里什么都没有、**自己一行代码都没跑所以也不报错**：`web boot: 1 entry did not activate / pending (waiting for service: …)`。这里要的是 **cordis 服务名**（`'slots'`） | 写了个探针脚本接 CDP 抓 `Runtime.exceptionThrown` 与控制台 |
| 悬浮按钮**只把弹窗 portal 到 body**，按钮本身留在 `shell.overlay` 里 | 按钮被关在 `shell.overlay` 的 **z-index:20** 层叠上下文里 ⇒ 自己写 `z-index:9998` 也没用，官方那个 `z-index:1000` 的根遮罩盖在它上面。**用 `getBoundingClientRect()` 判是假 PASS**（矩形完全正常） | `document.elementFromPoint(按钮中心)` 命中的是 `_mask_w1urq_14`（别的元素）⇒ 与项目 AGENTS.md §5 那条完全吻合 |
| **测试夹具**里那个 1×1 PNG 是坏的 | 内核报 `Unsupported or malformed image data.`，我一度以为是插件的问题 | 用 sharp 逐步复现：`metadata()` **能过**、`raw().toBuffer()` **失败**（`vipspng: libpng read error`）⇒ 那个流传很广的 base64 的 IDAT 其实是坏的。换成 sharp 现生成的 PNG 即通过 |

> ★ 第二、三条合起来是一条教训：**"插件在界面里看不见"** 有三种互不相干的病因
> （bundle 没下发 / `apply` 抛错 / `inject` 等服务等不到），
> **"图片发不出去"** 也可能是夹具坏而不是代码坏 —— 都必须靠真跑 + 独立手段分开归因。

---

## 源码怎么读

```
lib/index.js     宿主半边：局域网服务（配对/SSE/RPC）+ 审批桥接 + 同源路由
lib/client.js    浏览器半边：右下角悬浮按钮 + 双二维码弹窗（手写单文件 bundle，无构建）
lib/qr.cjs       vendor 的二维码编码器（MIT，原样，未改一行）
web/             手机端页面（原生 JS，无框架、无 CDN）
android/         Android WebView 壳（零第三方依赖；见其 README 的验证状态）
```

`lib/index.js` 顶上写着三条刻意的设计决定（**为什么不用 WebSocket**、
**为什么零依赖**、**为什么 token 不落盘**），`lib/client.js` 顶上写着它踩过的坑。
读之前先读那两段注释，能省很多时间。

---

## 还没做 / 下一步

1. **真机验证 Android 壳**（编出来装上跑一遍）—— 这是当前最大的一块空白
2. 手机端推送通知（需要 App 层做，网页做不到）
3. 手机端拖拽 / 粘贴附件（现在只支持点选图片）
4. 可选的 HTTPS（自签证书）—— 目前明文只适合家用 Wi-Fi
5. 按设备裁剪能力（只读设备 / 全权设备）
6. 手机端选 Agent 预设 / 权限预设
