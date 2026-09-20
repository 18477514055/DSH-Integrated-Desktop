# 手机遥控 · Android 壳工程

> 这是一个**极简 WebView 壳**：把电脑端插件自己发出来的手机端页面装进一个原生 App，
> 于是你有桌面图标、无地址栏、独立任务——而功能仍然全部由电脑端提供。

---

## ⚠️ 先看这一段：验证状态（别把它当成"已测过的成品"）

| 项 | 状态 |
|---|---|
| 本工程能否编出 APK | **未验证**——写它的这台机器上**没有 Android SDK / JDK / Gradle / adb**（实测全部"没有"），所以**我没有编过一次** |
| Java 代码逻辑 | 已逐行人工检查，但**没有真机运行过** |
| 电脑端插件 | **已真跑验证**：`node scripts/plugin-check-mobile-remote.js` 33 项全过、4 连跑全过 |
| 二维码（含 App 深链） | **已交叉验证**：`node scripts/qr-check.js` 19 项全过（用**另一个独立解码器**读回） |

⇒ **结论**：电脑端是硬的；**这个壳是"应该能编、逻辑简单、但没实测过"**。
它的复杂度刻意压到最低（一个 Activity、零第三方依赖），就是为了让这个风险尽量小。
你那边（或手机上的 DSH）编出来后，**第一件事就是真机装一次**。

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
网页里"🖼 发图片"走系统文件选择器（`ACTION_GET_CONTENT`），**不需要读存储权限**。

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
- 没做深色/浅色跟随（固定深色，与网页一致）
- 没做平板/横屏专门布局

---

## 文件结构

```
android/
├── settings.gradle                    仓库与模块声明
├── build.gradle                       根（只有 AGP 版本，无第三方依赖）
└── app/
    ├── build.gradle                   模块（compileSdk 34 / minSdk 24 / JDK 17）
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml        权限 + dshmr:// 深链 + 明文流量开关
        ├── java/com/dsh/mobileremote/
        │   └── MainActivity.java      全部逻辑（一个 Activity，约 300 行，注释详尽）
        └── res/
            ├── values/strings.xml     应用名「手机遥控」
            ├── values/themes.xml      深色主题（平台自带）
            └── mipmap-*/              图标（5 档密度，用 sharp 从 SVG 生成）
```
