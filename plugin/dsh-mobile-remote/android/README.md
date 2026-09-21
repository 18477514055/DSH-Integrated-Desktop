# 手机遥控 · Android 壳工程

> 这是一个**极简 WebView 壳**：把电脑端插件自己发出来的手机端页面装进一个原生 App，
> 于是你有桌面图标、无地址栏、独立任务——而功能仍然全部由电脑端提供。

---

## ⚠️ 先看这一段：验证状态（别把它当成"已测过的成品"）

| 项 | 状态 |
|---|---|
| 本工程能否编出 APK | ✅ **已真编出 APK**（2026-09-20 首编、2026-09-21 重编含键盘修复；见下面「构建环境」一节；`aapt2` 逐项核实过清单与资源） |
| Java 代码逻辑 | 已逐行人工检查，且**编译通过**；但**仍未真机运行过**（没有 Android 设备连过这台机器） |
| **键盘让位**（`installKeyboardInsetHandler`） | ⚠️ **未真机验证**。它针对的是"Android 15 起 targetSdk≥35 忽略 `adjustResize`"这个平台行为；网页侧那一半（`visualViewport`）已用真渲染验证过，**原生侧这一半没有**。真机上若仍被挡，第一个就该查这里 |
| 电脑端插件 | **已真跑验证**：`node scripts/plugin-check-mobile-remote.js` 33 项全过、4 连跑全过 |
| 二维码（含 App 深链） | **已交叉验证**：`node scripts/qr-check.js` 19 项全过（用**另一个独立解码器**读回） |
| 手机端界面渲染 | **已真跑验证**：`node scripts/ui-check-mobile.js` 17 项全过、3 连跑全过（真开窗口读 DOM） |

⇒ **结论**：电脑端与网页端是硬的；这个壳**已能编出 APK**，但**装到真机上的表现还没验过**。
复杂度刻意压到最低（一个 Activity、零第三方依赖），就是为了让这个风险尽量小。
**装上后第一件事：真机跑一遍**（配对 → 列表 → 发消息 → 点输入框看键盘 → 展开一个工具卡）。

---

## 构建环境（2026-09-20 实测可用，已编出 APK）

| 组件 | 版本 / 位置 |
|---|---|
| Gradle | **9.7.1**（AGP 9.4.1 **要求 9.7.x**；9.4.1 会报 `NoClassDefFoundError: ProjectTypeBinding`） |
| AGP | **9.4.1** |
| JDK | Android Studio 自带 JBR（`C:\Program Files\Android\Android Studio\jbr`，OpenJDK 25） |
| SDK | `C:\Users\24239\AppData\Local\Android\Sdk`（platform **android-37.0** / build-tools **36.0.0**） |
| 构建路径 | `D:\dsh-android-build`（**junction → 真实工程**，源码只有一份） |

**重新编译**（两条命令，2026-09-21 实测 34 秒编过）：
```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
cd D:\dsh-android-build
.\gradlew.bat assembleDebug --offline     # ★ 用默认 ~/.gradle 缓存；第一次编要去掉 --offline
```
产物：`app\build\outputs\apk\debug\app-debug.apk`

> ⚠️ **编完记得把产物复制到`android/app-debug.apk`** —— 那才是**随包分发**、
> 被 git 跟踪的那一份（构建输出目录 `app/build/...` 是被排除的生成物，
> 而且它 232 字符深的路径不该进包）。2026-09-21 重编后已复制并核对：
> 905964 字节、sha256 `D9DC0F6F...B565`，dex 里确认含 `installKeyboardInsetHandler`。

### 三个实测踩到的坑（都已写进对应文件注释）

| 坑 | 症状 | 真因 |
|---|---|---|
| AGP 与 Gradle 版本错配 | `NoClassDefFoundError: org/gradle/features/binding/ProjectTypeBinding` | AGP 9.4.1 需要 **Gradle 9.7.x**。逐个 jar 搜那个类：`gradle-project-features-api-9.7.1.jar` 里有、9.4.1 的 191 个 jar 全没有 |
| 工程路径含中文 | `Your project path contains non-ASCII characters` | 真实路径含 `5.DSH集成桌面端`。**不改目录名**（AGENTS.md §0：两个已装插件用绝对路径 link: 钉在它上面）⇒ 用官方开关 `android.overridePathCheck=true`（见 `gradle.properties`） |
| Groovy 读到 BOM | `Unexpected character: '\ufeff'` | PowerShell 5.1 的 `Set-Content -Encoding UTF8` **会写 BOM**。用 Node 按 UTF-8 无 BOM 写（AGENTS.md §1 那条） |
| ★ `--offline` 编不动 | `Plugin [id: 'com.android.application', version: '9.4.1'] was not found` | 2026-09-21 重编时踩到：**第一次**跑必须让 Gradle 解析 AGP 插件（它不在本地缓存里）。`--offline` 只适合**已经成功编过一次**之后 |
| ★ Gradle 报 TLS 握手失败（**信息极度误导**） | `Could not GET 'https://dl.google.com/...' > The server may not support the client's requested TLS protocol versions: (TLSv1.2, TLSv1.3) > Remote host terminated the handshake` | 2026-09-21 在**干净缓存**下重编时踩到。**这不是 TLS 问题**：实测 PowerShell / curl / 以及用 JBR 写的 Java 探针去下那个 **17 MB 的 jar**，开代理与不开代理**都是 200、字节数一致**。是 Gradle 侧偶发/并发相关。**实际解法：删掉 `.gradle-home` 那类空缓存，改用默认 `~/.gradle`（09-20 成功编译留下的完整缓存）+ `--offline`，34 秒编过**。`gradle.properties` 里那几行代理设置**没有被真正验证过**（那次构建全程离线），保留只是无害兜底 —— 注释里已写明 |

> **2026-09-21 重编记录**：`GRADLE_USER_HOME` 指向
> `5.DSH集成桌面端\android\.gradle-home`（避免污染全局），Gradle 发行版在
> `5.DSH集成桌面端\.gradle-dist\`。加了 `--offline` 会失败（见上表最后一条），去掉即可。

---

## 怎么编（三种方式，任选）

### 方式 A：Android Studio（最省事）
1. Android Studio → **Open** → 选本目录（`android/`，**不是**插件根目录）
2. 等 Gradle sync 完 → **Build → Build Bundle(s)/APK(s) → Build APK(s)**
3. 产物：`android/app/build/outputs/apk/debug/app-debug.apk`

### 方式 B：命令行（有 JDK 17 + Android SDK）
```bash
cd android
# 指向你的 SDK（没设过才需要）
echo "sdk.dir=/path/to/Android/Sdk" > local.properties
./gradlew assembleDebug          # Linux/macOS
gradlew.bat assembleDebug        # Windows
```

### 方式 C：交给手机上的 DSH 编（你说的那条路）
把 **`android/` 整个目录**传过去即可。它需要的只有：
- JDK 17
- Android SDK（`compileSdk 34`、`build-tools`）
- 网络（第一次要下 Gradle 与 AGP 8.1.4）

**工程里没有 `local.properties`、没有 `.gradle/`、没有 `build/`**——都是生成物，别传。

---

## 编之前该知道的三件事（都写在代码注释里了）

1. **零第三方依赖。** 根 `build.gradle` 里没有 `dependencies` 块。
   `MainActivity` 继承的是平台自带的 `android.app.Activity`，主题用
   `Theme.DeviceDefault.NoActionBar` —— 所以**不会卡在"下某个库失败"**上。
   代价：UI 是系统默认样式（但这个壳只有一个"首次填地址"页面，够用）。

2. **`usesCleartextTraffic="true"` 是必需的，不是疏忽。**
   手机端页面走 `http://192.168.x.x:3110`（明文）。Android 9+ 默认禁明文，
   不开这个开关 App 会连不上、且报错含糊。
   代价要讲清楚：**局域网内流量不加密**（本插件本来就没有 TLS）。

3. **扫码用"系统相机"，App 内不做扫码。**
   内嵌扫码要么引 ZXing/MLKit（破坏零依赖），要么自己写解码器。
   替代方案更省事也更可靠：电脑端弹窗给了**两个二维码**——
   - ① 普通 http 地址：任何手机相机都能扫，**开浏览器**（没装 App 也能用）
   - ② `dshmr://` 深链：装了本 App 就扫这个，**直接进 App**
   （为什么不用 http 直接唤起 App：Android 的 App Links 要求 https + 域名校验，
   局域网 IP + http **做不到**——这是平台限制，不是配置问题。）

---

## 它有哪些权限（只有两个）

| 权限 | 为什么 |
|---|---|
| `INTERNET` | 要连电脑的局域网服务 |
| `ACCESS_NETWORK_STATE` | 判断"是不是连在 Wi-Fi 上"，好在移动数据下给明确提示 |

**刻意不要**的：存储、相机、位置、通讯录、后台服务。
网页里"发图片"走系统文件选择器（`ACTION_GET_CONTENT`），**不需要读存储权限**。

---

## 键盘遮挡（2026-09-21 修，**必读**）

用户报："点击输入框弹出键盘之后，键盘会把那个输入框挡住，整个页面也会被挡住一半。"

**真因是平台行为，不是配置写错**：本 App `targetSdk = 37`，而
**Android 15（API 35）起强制 edge-to-edge** ⇒ `windowSoftInputMode="adjustResize"`
（`AndroidManifest.xml` 里确实写了）**被系统忽略**，键盘是**盖**上来的、
窗口高度不变 ⇒ 网页里 `100dvh` 量到的仍是"没键盘"的高度 ⇒ 输入框正好落在键盘底下。

**三层一起修**（缺一层都治不住）：网页侧 `visualViewport` → CSS 变量（`web/app.js`）、
原生侧 `OnApplyWindowInsetsListener` 做底部 padding（`MainActivity.installKeyboardInsetHandler()`）、
主题里再显式写一遍（`res/values/themes.xml`）。理由与取舍写在各自文件的注释里。

⚠️ **真机上还没验过**（见开头「验证状态」表）。

---

## 装完之后怎么用

1. 手机上装好 APK
2. 电脑上点「📱」→ 用**系统相机**扫**第二个**二维码（`dshmr://` 那个）
3. 系统会问用哪个应用打开 → 选「手机遥控」→ 直接进 App，自动配对

扫第一个码也能用（走浏览器），两者功能完全一样。

---

## 已知限制 / 没做的事

- **没有内嵌扫码**（理由见上）
- **没有推送通知**：锁屏不会提醒你有新输出
- **没有"退出登录"入口在 App 层**：在网页里点「⋯ → 断开并重新配对」
- **记住的地址只到 `ip:port`**：一次性配对码不存（它会过期，存了反而误导）
- 没做深色/浅色跟随（固定浅色，与网页一致）
- 没做平板/横屏专门布局
- **没做"换地址"的 App 层入口**：电脑端弹窗里的备选地址现在还只是列出来，
  换地址得靠重新扫另一个码
- **键盘修复未在真机确认**（见「键盘遮挡」一节）

---

## 文件结构

```
android/
├── settings.gradle                    仓库与模块声明
├── build.gradle                       根（只有 AGP 版本，无第三方依赖）
└── app/
    ├── build.gradle                   模块（compileSdk 37 / minSdk 24 / JDK 17）
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml        权限 + dshmr:// 深链 + 明文流量开关
        ├── java/com/dsh/mobileremote/
        │   └── MainActivity.java      全部逻辑（一个 Activity，约 360 行，注释详尽；
        │                              含 installKeyboardInsetHandler 键盘让位）
        └── res/
            ├── values/strings.xml     应用名「dsh手机遥控」
            ├── values/themes.xml      浅色主题（平台自带）+ 键盘/导航栏设置
            └── mipmap-*/              图标（5 档密度，用 sharp 从 SVG 生成）
```
