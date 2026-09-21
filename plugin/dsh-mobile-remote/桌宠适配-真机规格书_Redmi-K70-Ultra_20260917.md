# 桌宠移动端适配 · 真机规格书

**采集对象**：Redmi K70 Ultra（`2407FRK8EC` / codename `rothko`）
**采集时间**：2026-09-17 16:21（CST，设备本地时间）/ 2026-09-17T08:21:10Z
**采集方式**：手机内 Termux 的只读 shell 查询（`getprop` / `cmd <service>` / `/proc` / `/sys`），uid 10398，**无 root、无 adb、无 dumpsys 权限**
**配套文件**：`桌宠适配-真机规格_20260917.json`（同一份数据的机器可读版，sha256 见文末）
**用途**：把本机（这台手机）作为桌宠移动端的第一台目标真机，供电脑侧做设计换算、资源切图、性能预算与兼容性决策

---

## 0. 采集口径与隐私声明（先说清楚这份东西里没有什么）

本文档**只包含硬件与系统能力参数**，即"这台机器的屏幕、算力、编解码、系统行为"。

**明确排除、未采集**：

| 类别 | 说明 |
|---|---|
| 身份标识 | IMEI / MEID / IMSI、SIM 卡信息（`persist.radio.*`、`gsm.*` 全部未采集） |
| 网络标识 | Wi-Fi MAC、蓝牙 MAC（`ro.ril.oem.wifimac` 等已跳过） |
| 设备序列号 | `ro.serialno` / `ro.boot.serialno` |
| 账号类 | Android ID、广告 ID、Google/小米账号、任何登录态 |
| 应用清单 | 仅按包名单独查询了 WebView 与 Chrome 的版本号，**没有导出已安装应用列表**（`cmd package list packages` 虽然能列出 448 条，仅用于过滤，未落盘） |
| 个人内容 | 通讯录 / 短信 / 通话 / 位置 / 相册 / 剪贴板 / 通知 / 任何会话记录 |
| 显示标识 | 屏幕 `uniqueId` 也已剔除（虽非个人身份，但属设备唯一值） |

> 结论：这份文档可以安全地放进下载目录、经微信/QQ/U 盘传到电脑，不含可用于追踪你个人身份的字段。

---

## 1. 关键数字速查表（电脑侧可直接照着用）

| 项目 | 值 | 来源 |
|---|---|---|
| 屏幕（真实/应用）分辨率 | **1220 × 2712 px**（竖屏） | `cmd display get-displays` |
| 密度 | **520 dpi**，密度系数 **3.25** | `cmd display get-displays` / `ro.sf.lcd_density` |
| 逻辑尺寸 | **375 × 834 dp**（sw375dp） | `cmd activity get-config` |
| 宽高比 | **2.223 : 1**（约 20:9.2，"long" 屏） | 计算 |
| 物理对角线 | **6.673 英寸 / 169.5 mm**（445.614 dpi 实测） | 计算 |
| 刷新率档位 | **60 / 90 / 120 / 144 Hz**；开机档 60Hz；**MIUI 限到 120** | `cmd display` / `persist.sys.smartpower.limit.max.refresh.rate` |
| 刘海/挖孔 | **有**（`ro.miui.notch=1`）；非圆角屏（`notround`） | getprop / get-config |
| 导航方式 | **手势导航，无导航栏**（`navhidden` / `nonav`） | `cmd activity get-config` |
| 色域/HDR | 广色域 + HDR；支持 **Dolby Vision / HDR10 / HLG / HDR10+** | `cmd display get-displays` |
| SoC | **MediaTek MT6989**（Dimensity 9300 系列） | `ro.soc.model` |
| CPU | **8 核全大核**：4×Cortex-A720 @≤2.0GHz + 3×Cortex-X4 @≤2.85GHz + 1×Cortex-X4 @≤3.4GHz | `/proc/cpuinfo` + `cpufreq` |
| ABI | **仅 arm64-v8a（不支持 32 位）** | `ro.product.cpu.abilist` |
| GPU API | **OpenGL ES 3.2**（`196610`）、Vulkan（Mali 驱动） | `ro.opengles.version` / `ro.hardware.vulkan` |
| 内存 | **15.56 GB 可用总量（16GB SKU）** + **16GB zram** | `/proc/meminfo` |
| 存储 | **481 GB 总 / 49 GB 可用**（90% 已用，无 SD 卡槽） | `df -h /data` |
| 系统 | **Android 15 / API 35**，HyperOS **OS2.0.203.0.VNNCNXM**，安全补丁 2025-05-01 | getprop |
| 内核 | **6.1.78-android14-11**（aarch64，SMP PREEMPT） | `uname -a` |
| 系统 WebView | **com.google.android.webview 131.0.6778.260**（Chromium 131） | `aapt2 dump badging` |
| 硬解视频 | **AV1 / HEVC / AVC / VP9**（含 lowlatency 实例） | `/vendor/etc/media_codecs*.xml` |
| 单张纹理上限 | **200 MB** | `ro.hwui.max_texture_allocation_size` |
| 应用堆上限 | 默认 256 MB / 开 largeHeap 512 MB | `dalvik.vm.heapgrowthlimit` / `heapsize` |
| 空转计时 | 最后一次触控后 **1100 ms** 进入 idle | `debug.sf.set_idle_timer_ms` |

---

## 2. 设备与系统

### 2.1 设备身份（非隐私部分）

| 项 | 值 |
|---|---|
| 厂商 / 品牌 | Xiaomi / Redmi |
| 型号 / 市场名 | `2407FRK8EC` / **Redmi K70 Ultra** |
| 代号（device / product / board） | `rothko` |
| 形态 | 直板手机，**非折叠屏**（`cmd device_state print-state` = `0`，仅一种 supported state） |
| 首次出厂 API | 34（Android 14） |
| 构建指纹 | `Redmi/rothko/rothko:15/AP3A.240617.008/OS2.0.203.0.VNNCNXM:user/release-keys` |
| 构建类型 / 标签 | `user` / `release-keys` |
| 特性 | `nosdcard`（无外置 SD 卡槽） |
| 启动校验 | verified boot = **green**，bootloader **locked**，dm-verity managed |
| 加密 | 全盘 **文件级加密（FBE）**，文件名 AES-256-CTS |

### 2.2 SoC

| 项 | 值 |
|---|---|
| 厂商 / 型号 | MediaTek / **MT6989** |
| 内部名 | `MT6989W/TCZA` |
| 平台名 | `mt6989` |
| 公称产品名（厂商规格，非本机读出） | Dimensity 9300 系列（本机 3.4GHz 主频与 9300+ 一致） |
| ABI | **仅 `arm64-v8a`**；`abilist32` 为空 ⇒ **系统完全不支持 32 位原生库** |
| 页大小 | 4096 字节 |

> ⚠️ **对桌宠的直接约束**：native 库（`jniLibs` / `.so`）**只能提供 `arm64-v8a`**，打 `armeabi-v7a` 毫无意义；同时这解释了为什么本机某些 Android 原生库需要 64 位专用构建。

### 2.3 系统

| 项 | 值 |
|---|---|
| Android 版本 / API | **15 / 35** |
| 安全补丁 | 2025-05-01 |
| 构建 ID | `AP3A.240617.008` |
| 系统增量版本 | `OS2.0.203.0.VNNCNXM`（HyperOS **OS2.0**，`ro.mi.os.version.code=2`） |
| 构建时间 | 2025-06-04 22:35:14 CST |
| 区域 | `cn`（中国区），运营商定制 `cn_chinatelecom` |
| 语言 | `zh-CN`，MCC/MNC `460-7` |
| 内核 | `6.1.78-android14-11-gb6577b760481-ab12075023`，编译于 2024-07-11 07:05:47 UTC，aarch64 SMP PREEMPT |

### 2.4 系统 WebView（H5 形态桌宠的基线内核）

| 项 | 值 |
|---|---|
| 实现包 | `com.google.android.webview` |
| 版本 | **131.0.6778.260**（versionCode 677826033） |
| targetSdk | 34 |
| APK 路径 / 体积 | `/product/app/WebViewGoogle64/WebViewGoogle64.apk`，75,769,473 字节 |
| 另有浏览器 | `com.android.chrome`（versionCode 744415833） |

> 若桌宠走 **WebView / H5** 方案：基线可以按 **Chromium 131** 来写，支持 ES2023+、WebGL2、WebGPU（Chromium 131 默认可用，但 WebGPU 在部分机型被 flags 关闭，需实测）、AVIF、WebP/WebP2 动图、CSS `@container`、`view-transition` 等。

---

## 3. 屏幕与显示（桌宠最重要的一节）

### 3.1 几何参数

| 项 | 值 |
|---|---|
| Display id / 类型 / 状态 | `0` / `INTERNAL` / `ON` |
| 真实分辨率 | **1220 × 2712 px** |
| 应用可用分辨率 | **1220 × 2712 px**（与真实一致，无降分辨率） |
| 安装方向 | `ROTATION_0`（竖屏为默认） |
| 当前旋转 | `0` |
| 密度 | **520 dpi**，密度系数 **3.25** |
| 字体缩放后的 scaledDensity | 3.25（与 density 相同 ⇒ 采集时刻**未做字体缩放**） |
| 物理像素密度 | xdpi = ydpi = **445.614** |
| 逻辑尺寸 | **w375dp × h834dp**，sw = **375dp** |
| 宽高比 | 2712 / 1220 = **2.22295** |
| 对角线（计算） | √(1220²+2712²) = 2973.8 px ⇒ **6.673 英寸 ≈ 169.5 mm** |
| 屏幕分类标记 | `normal` / **`long`** / `notround` / **`widecg`** / **`highdr`** |

**`cmd activity get-config` 原文（完整系统配置串）**：

```
config: mcc460-mnc7-zh-rCN-ldltr-sw375dp-w375dp-h834dp-normal-long-notround-widecg-highdr-port-notnight-520dpi-finger-keysexposed-nokeys-navhidden-nonav-2712x1220-v35
abi: arm64-v8a
```

逐段解读（这段就是 Android 资源限定的最终依据）：

| 段 | 含义 | 对桌宠的意义 |
|---|---|---|
| `sw375dp` / `w375dp` / `h834dp` | 最小宽/宽/高（dp） | **一切布局按 375×834dp 设计** |
| `long` | 长屏 | 竖屏可用高度很富裕，纵向空间不是瓶颈 |
| `notround` | 非圆形屏 | 不需要处理圆形表盘类适配 |
| `widecg` | 广色域 | 可上 Display-P3 / 广色域素材 |
| `highdr` | 高动态范围 | 可上 HDR 素材（本机 Dolby Vision/HDR10/HLG/HDR10+） |
| `port` | 当前竖屏 | — |
| `520dpi` | 密度 | 见下方切图建议 |
| `finger` | 触屏输入 | 触控设备 |
| `nokeys` | 无物理键盘 | 纯触控交互 |
| `navhidden` / `nonav` | **无导航栏** | 底部不需要为三键导航留位；手势条由系统 inset 决定 |
| `2712x1220` | 当前分辨率 | — |
| `v35` | API 35 | Android 15 行为 |

### 3.2 px ↔ dp 换算表（520dpi / ×3.25）

| dp | px | | px | dp |
|---|---|---|---|---|
| 1 | 3.25 | | 8 | 2.46 |
| 4 | 13 | | 16 | 4.92 |
| 8 | 26 | | 24 | 7.38 |
| 12 | 39 | | 32 | 9.85 |
| 16 | 52 | | 48 | 14.77 |
| 20 | 65 | | 64 | 19.69 |
| 24 | 78 | | 96 | 29.54 |
| 32 | 104 | | 128 | 39.38 |
| 36 | 117 | | 156 | 48.0 |
| 40 | 130 | | 180 | 55.38 |
| 48 | 156 | | 208 | 64.0 |
| 56 | 182 | | 260 | 80.0 |
| 64 | 208 | | 300 | 92.31 |
| 72 | 234 | | 312 | 96.0 |
| 80 | 260 | | 416 | 128.0 |
| 96 | 312 | | 520 | 160.0 |
| 128 | 416 | | 780 | 240.0 |
| 160 | 520 | | 1040 | 320.0 |

公式：`px = dp × 3.25`，`dp = px ÷ 3.25`。

### 3.3 刷新率

**显示器报告的可用模式（`cmd display get-displays`）**：

| mode id | 分辨率 | 主频 | 该模式的候选刷新率 | HDR 类型 |
|---|---|---|---|---|
| 1 | 1220×2712 | **60.0 Hz** | 90 / 120 / 144 | 1,2,3,4 |
| 2 | 1220×2712 | **144.00002 Hz** | 60 / 90 / 120 | 1,2,3,4 |
| 3 | 1220×2712 | **120.00001 Hz** | 60 / 90 / 144 | 1,2,3,4 |
| 4 | 1220×2712 | **90.0 Hz** | 60 / 120 / 144 | 1,2,3,4 |

- 开机时的模式：`1220 2712 60.0`（`cmd display get-active-display-mode-at-start 0`）
- 采集时刻渲染帧率：`renderFrameRate 60.0`
- 用户未手动锁定任何模式：`User preferred display mode: null`
- **MIUI 的额外限制**：`persist.sys.smartpower.limit.max.refresh.rate = 120`
  ⇒ 物理屏支持 144Hz，但**系统省电策略把上限压在 120Hz**。桌宠的动画目标应当是 **60 / 90 / 120**，**不要把 144Hz 当作默认目标**。
- `ro.surface_flinger.game_default_frame_rate_override = 60`：未声明帧率的应用默认 60Hz。
- `ro.surface_flinger.enable_frame_rate_override = false`：系统级帧率覆盖关闭，帧率由应用/HWC 协商。
- `Match content frame rate type: 1`（非 ALWAYS 模式）。

**帧周期与 MTK 相位偏移配置（原始属性值，单位 ns）**

| 档位 | 帧周期 | `early.app.duration` | `early.sf.duration` | `late.app.duration` | `late.sf.duration` |
|---|---|---|---|---|---|
| 60 Hz（默认档） | 16.667 ms | 20,000,000 ns (20.0 ms) | 27,600,000 ns (27.6 ms) | 20.0 ms | 15.6 ms |
| 高刷档（90/120 Hz） | 11.111 / 8.333 ms | 11,600,000 ns (11.6 ms) | 10,300,000 ns (10.3 ms) | 11.6 ms | 10.3 ms |
| 144 Hz 档 | 6.944 ms | 10,500,000 ns (10.5 ms) | 8,900,000 ns (8.9 ms) | 10.5 ms | 8.9 ms |

> 属性名：`debug.sf.144_fps.*` / `debug.sf.high_fps.*` / `debug.sf.*`（默认=60）。
> **解读（推断，非官方文档）**：这是 MTK/SurfaceFlinger 的 frame-pacing 相位偏移表，其中 `app.duration` 可视为该档位下"应用每帧可用的绘制时间"参考 —— **60Hz 档给到 20ms、高刷档 11.6ms、144 档 10.5ms**。桌宠动画单帧 CPU+GPU 总耗时建议分别控制在 **≤10ms（60Hz）/ ≤6ms（120Hz）**，留出安全余量。

**其它时序属性**：

| 属性 | 值 | 含义 |
|---|---|---|
| `debug.sf.set_idle_timer_ms` | 1100 | 无新帧 1100ms 后 SurfaceFlinger 回到 idle（省电） |
| `ro.surface_flinger.set_touch_timer_ms` | 1100 | **触控后保持高刷 1100ms**，之后回落 |
| `debug.sf.hwc.min.duration` | 2,000,000 ns | HWC 最小合成时长 |
| `ro.surface_flinger.max_frame_buffer_acquired_buffers` | 4 | 最多 4 缓冲（≈四缓冲） |
| `debug.sf.use_phase_offsets_as_durations` | 1 | 上表按"时长"解释 |
| `debug.sf.disable_backpressure` | 1 | 关闭背压（高刷下更积极出帧） |

### 3.4 色彩、HDR、亮度

| 项 | 值 |
|---|---|
| 支持色模式（原始枚举） | `[0, 7, 9]` |
| 广色域 | 是（`widecg`，`ro.surface_flinger.has_wide_color_display=true`） |
| HDR | 是（`highdr`，`ro.surface_flinger.has_HDR_display=true`） |
| HDR 类型（枚举 `[1,2,3,4]`） | **Dolby Vision(1) / HDR10(2) / HLG(3) / HDR10+(4)** |
| API 报告最大亮度 | 500.0 nits（平均亮度同为 500） |
| 厂商侧面板峰值（PQ 属性） | `persist.vendor.sys.pq.mdp.vp.hdr10.panel.dtmo.panelnits.max = 1600` nits |
| 亮度范围 | `0.0 – 1.0`，默认 0.07496032，采集时 0.4499441 |
| 相关厂商能力 | `ro.vendor.pq.mtk_hdr10_plus_recording_support=1`、`hdr_vivid=1`、`ultra_hdr=1`、Dolby Vision（`debug.config.media.video.dolby_vision_suports=true`） |

> **对桌宠的意义**：可做 HDR 高光效果（宠物发光的技能特效不会被压成灰白），但**必须做 SDR 回退**；广色域素材（P3）可直接用。

### 3.5 刘海 / 安全区（★ 本机无法静态读取，必须运行时查）

已知事实：

- `ro.miui.notch = 1` ⇒ **确实有挖孔/刘海**，顶部存在不可绘制区域。
- 屏幕 **非圆角屏**（`notround`），但物理面板仍有小圆角，`notround` 只表示不按圆形处理。
- 采集时刻的导航配置是 `navhidden`/`nonav`（**手势导航，无三键导航栏**）。

**未采集到的（Termux 侧被权限挡住，`cmd window` 服务不可达）**：

- 状态栏精确高度（px / dp）
- 挖孔（displayCutout）精确 boundingRect 与 safeInset
- 手势条（gesture nav bar）高度
- 输入法（IME）高度

**必须在 App 内运行时查询**（Android 15 推荐做法）：

```kotlin
// 顶部状态栏 + 刘海 + 底部手势条，一次性拿到四边
val bars = ViewCompat.getRootWindowInsets(view)!!.getInsets(
    WindowInsetsCompat.Type.systemBars() or
    WindowInsetsCompat.Type.displayCutout() or
    WindowInsetsCompat.Type.ime()
)
// bars.top / bars.bottom / bars.left / bars.right  单位为 px
val dp = bars.top / resources.displayMetrics.density      // density = 3.25
```

```kotlin
// 精确拿挖孔矩形
val cutout = view.rootWindowInsets.displayCutout
cutout?.boundingRects?.forEach { rect -> /* px 矩形 */ }
cutout?.safeInsets                            // 四边安全内缩
```

```java
// 旧 API 兜底（仍可用，返回 px）
ViewCompat.getRootWindowInsets(view)
    .getInsets(WindowInsetsCompat.Type.systemBars()).top;
```

> 桌宠若要做**悬浮窗（overlay）**：注意刘海区、状态栏、手势条三处都要避让；本机是"长屏 + 挖孔 + 手势导航"的典型组合，**不要照抄平板/短屏的坐标**。

---

## 4. CPU

### 4.1 三集群（未做任何降频/隔离，8 核全部在线）

| 集群 | CPU | MIDR part | 核心（已核验） | 频率范围 | 实测当前频率 | cpu_capacity | 集群定位 |
|---|---|---|---|---|---|---|---|
| 能效 | 0–3 | `0xD81` | **Cortex-A720** | 300 MHz – **2.0 GHz** | 1000/900/800/1000 MHz | 450 | 后台/轻量逻辑 |
| 性能 | 4–6 | `0xD82` | **Cortex-X4** | 550 MHz – **2.85 GHz** | 均 1500 MHz | 871 | 主渲染/主逻辑 |
| 超大核 | 7 | `0xD82` | **Cortex-X4 (prime)** | 600 MHz – **3.4 GHz** | 600 MHz（空闲） | 1024 | 突发/卡顿救场 |

- `online` = `0-7`，`isolated` 为空，无热插拔限制。
- **不是经典 big.LITTLE**：**没有任何小核**，4×A720 + 4×X4 全大核设计。
- MIDR 核验来源：[ARM Cortex-A720 = 0xD81](https://lists.u-boot-project.org/pipermail/u-boot/2025-September/598734.html)、[ARM Cortex-X4 = 0xD82](https://gcc.gnu.org/pipermail/gcc-patches/2025-January/673170.html)。
- 各集群完整可用频率表：
  - A720 (cpu0)：`2000,1900,1800,1700,1600,1500,1400,1300,1200,1100,1000,900,800,700,600,500,400,300` MHz
  - X4 (cpu4)：`2850,2800,2700,2600,2500,2400,2300,2200,2100,2000,1900,…,600,550` MHz
  - X4 prime (cpu7)：`3400,3300,3250,3200,3100,3000,…,600` MHz（步进 100MHz，3250 为额外档）

### 4.2 CPU 特性（`/proc/cpuinfo` Features）

```
fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm
jscvt fcma lrcpc dcpop sha3 sm3 sm4 asimddp sha512 sve asimdfhm dit uscat ilrcpc
flagm ssbs sb paca pacg dcpodp sve2 sveaes svepmull svebitperm svesha3 svesm4
flagm2 frint svei8mm svebf16 i8mm bf16 dgh bti ecv afp wfxt
```

要点：

- **SVE / SVE2 可用**（含 `svebf16`、`svei8mm`、`svemath` 相关位）⇒ 若桌宠以后做端侧小模型推理（姿态、表情、语音唤醒），**这台机器有 BF16/I8MM 向量加速**。
- 硬件 AES / SHA1 / SHA256 / SHA512 / PMULL、CRC32、点积（`asimddp` / `i8mm`）。
- `bti`（分支目标识别）、`paca/pacg`（指针认证）⇒ 安全特性齐全。

### 4.3 空闲状态（cpu0，`cpuidle`）

| state | 名称 | 退出延迟 |
|---|---|---|
| 0 | `WFI` | 1 µs |
| 1 | `cpuoff-l` | 349 µs |
| 2 | `clusteroff-l` | 434 µs |
| 3 | `mcusysoff-l` | 2192 µs |
| 4 | `system-vcore` | 4440 µs |
| 5 | `s2idle` | 20000 µs |

> **对桌宠的意义**：单核 WFI 唤醒只要 1µs，短动画掉到 idle 之后再拉起来**几乎无延迟成本**；但 `s2idle` 级（20ms 延迟）在长时间静止后会让"忽然动一下"有一帧级迟滞。长时间无操作的桌宠宜用**低频心跳**（例如 5–10 Hz 的环境动画）避免深度睡眠，而不是完全停帧再突然复活。

### 4.4 轻量算力基线

| 项 | 值 |
|---|---|
| 测试 | Node.js 单线程 `Math.sqrt` 累加循环 1 秒 |
| 结果 | **约 8.89 × 10⁷ 次迭代/秒** |
| 运行时 | Node v24.18.0 / V8 13.6.233.17 |

> 这只是"数量级参考"，不是标准跑分。它的用途是：**电脑侧做算法预算时，心里有个本机单线程 JS 的大致盘子**（例如粒子系统每帧能跑多少次浮点运算）。真正的性能结论必须在桌宠 App 内用 `Perfetto` / `gfxinfo` / `benchmark` 测。

---

## 5. GPU 与图形 API

| 项 | 值 | 来源 |
|---|---|---|
| OpenGL ES 版本 | **3.2**（原始值 `196610` = `0x00030002`） | `ro.opengles.version` |
| Vulkan | **有**（`ro.hardware.vulkan = mali`） | getprop |
| EGL 驱动名 | `ro.hardware.egl = meow`（ARM Mali 系命名） | getprop |
| HWUI 渲染后端 | `skiagl`（`debug.renderengine.backend`） | getprop |
| 单次纹理/位图最大分配 | **209,715,200 字节 = 200 MB** | `ro.hwui.max_texture_allocation_size` |
| 最多同时持有的帧缓冲 | 4 | `ro.surface_flinger.max_frame_buffer_acquired_buffers` |
| GPU profiler 支持 | `true` | `graphics.gpu.profiler.support` |
| 厂商 GPU 服务 | `ro.vendor.mtk.gpu.service = 1`、`game_memc = 1` | getprop |
| EGL 配置（节选） | 支持 NV12/NV16/NV21/P010/P210/YUV420/YUYV/YVU420 等 `recordable` 格式 | `ro.vendor.arm.egl.configs.*` |

**GPU 型号为厂商规格推断**：MT6989 平台对应 **ARM Immortalis-G720**（本机只读出"mali"驱动族与 GLES 3.2，**没有**读出型号字符串）。

**未采集到的**：GPU 型号字符串、GPU 可用频率表、Vulkan 具体版本号
（`/sys/kernel/ged/hal/*`、`/proc/gpufreqv2/*`、`/sys/class/devfreq` 全部 `Permission denied`；`cmd gpu` 返回 `Failed transaction`）

**对桌宠的落点**：

- 有 **WebGL2**（GLES 3.2 对应 ES 3.0/3.1 能力），WebView 内可跑 3D 桌宠；真实的 Vulkan 直连要走原生。
- **单张纹理 200MB 上限**对桌宠远远够用，真正的瓶颈是**应用堆 256MB**（见第 6 节）。
- `game_memc` 是 MTK 的游戏内存压缩特性，**不要依赖它**做资源压缩。

---

## 6. 内存与存储

### 6.1 内存

| 项 | 值 |
|---|---|
| `MemTotal` | **15,555,780 kB**（15.56 GB 十进制 / 14.83 GiB）⇒ **16GB SKU** |
| 采集时 `MemAvailable` | 7,709,316 kB ≈ **7.35 GiB** |
| 采集时 `MemFree` | 797,784 kB |
| 采集时 `Cached` | 5,870,768 kB |
| `SwapTotal` | **16,777,212 kB = 16 GB（zram 压缩交换，非物理内存）** |
| 采集时 `SwapFree` | 14,000,636 kB（已用约 2.6 GB） |
| 每应用 memcg | `ro.config.per_app_memcg = false` |

**Dalvik/ART 堆限制（单个 App 最硬的天花板）**：

| 项 | 值 |
|---|---|
| `dalvik.vm.heapsize` | **512m**（等价于 `largeHeap` 可用上限） |
| `dalvik.vm.heapgrowthlimit` | **256m**（**未声明 largeHeap 时的默认上限**） |
| `dalvik.vm.heapstartsize` | 8m |
| `dalvik.vm.heapmaxfree` / `heapminfree` | 32m / 2m |
| `heaptargetutilization` | 0.5 |
| USAP（进程池） | `dalvik.vm.usap_pool_enabled = false` |

> **桌宠内存预算建议（派生）**：
> - 默认堆上限 **256MB** ⇒ **不要开 largeHeap 硬顶**，桌宠常驻内存建议控制在 **120–200MB**；
> - 纯动画资源的常驻解码缓冲（bitmap/texture）建议 **≤ 64MB**；
> - 16GB zram 的存在意味着系统**更晚**才触发低内存回收，但也意味着**一旦触发就是批量杀后台**——不要指望"系统会先提醒"。
> - 16GB RAM 机型上你几乎不会遇到 OOM，但这台机器**不能代表低端机**；建议电脑侧另设一台 6–8GB 的目标机做下限验证。

### 6.2 存储

| 项 | 值 |
|---|---|
| 数据分区 | `/dev/block/dm-58` 挂 `/data/user/0`，**481 GB 总 / 432 GB 已用 / 49 GB 可用（90%）** |
| 模拟存储 | `/dev/fuse` 挂 `/storage/emulated`，同上数值 |
| 外置 SD | **无**（`nosdcard`，`external_sdcard = false`） |
| 下载目录 | `/storage/emulated/0/Download` —— **可写**（已实测写入成功） |
| 加密 | 文件级加密（FBE） |

> ⚠️ **可用空间只剩 49GB（90% 满）**：桌宠的资源包（尤其是 4K 天空盒 / 长序列帧）在真机联调时会很快吃满。电脑侧打包资源时请**显式给出体积预算**，并优先用 AVIF/WebP 而不是 PNG 序列。

---

## 7. 媒体编解码

来源：`/vendor/etc/media_codecs*.xml`（逐文件解析 codec 名）。

### 7.1 硬件编解码（MTK 专用实例）

| 类型 | 硬件解码 | 硬件编码 |
|---|---|---|
| **AV1** | `c2.mtk.av1.decoder`、`c2.mtk.av1.decoder.lowlatency`、`OMX.MTK.VIDEO.DECODER.AV1`（含 `.secure`） | — |
| **HEVC / H.265** | `c2.mtk.hevc.decoder`、`.lowlatency`、`OMX.MTK.VIDEO.DECODER.HEVC`（含 `.secure`） | `c2.mtk.hevc.encoder`、`OMX.MTK.VIDEO.ENCODER.HEVC` |
| **AVC / H.264** | `c2.mtk.avc.decoder`、`.lowlatency`、`OMX.MTK.VIDEO.DECODER.AVC`（含 `.secure`） | `c2.mtk.avc.encoder`、`OMX.MTK.VIDEO.ENCODER.AVC` |
| **VP9** | `c2.mtk.vp9.decoder`、`.lowlatency`、`OMX.MTK.VIDEO.DECODER.VP9`（含 `.secure`） | — |

> `lowlatency` 实例是重点：**做"即时反应"的桌宠动画解码时优先选用**，延迟更低。

### 7.2 软件编解码（C2 软实例，兜底）

视频：`c2.android.av1.decoder`、`c2.android.av1-dav1d.decoder`（dav1d 软解 AV1）、`c2.android.avc.decoder/encoder`、`c2.android.hevc.decoder/encoder`、`c2.android.vp8.decoder/encoder`、`c2.android.vp9.decoder/encoder`、`c2.android.mpeg4.decoder/encoder`（+ 全部 `OMX.google.*` 等价项）

音频：`c2.android.aac.decoder/encoder`、`c2.android.flac.decoder/encoder`、`c2.android.opus.decoder/encoder`、`c2.android.mp3.decoder`、`c2.android.vorbis.decoder`、`OMX.google.*`

### 7.3 Dolby 音频

`OMX.dolby.ac3.decoder`、`OMX.dolby.ac4.decoder`、`OMX.dolby.eac3.decoder`、`OMX.dolby.eac3-joc.decoder`（JOC = 杜比全景声）、`c2.dolby.ac4.decoder`、`c2.dolby.eac3.decoder`；相关服务 `dolbycodec2` 与 `vendor-dolby-media-c2-hal-1-0` 均在运行。

### 7.4 HDR 视频能力

`dolby_vision_suports = true`、`ro.vendor.hdr10plus.enable = 1`、`hdr_vivid` / `ultra_hdr` = 1、`mtk_hdr10_panel_dtmo = 1`、HDR10+ 录制支持 = 1。

### 7.5 桌宠资源格式建议（派生建议）

| 资源类型 | 推荐 | 理由 |
|---|---|---|
| 静帧 / 图标 | **AVIF（首选）或 WebP** | 本机硬解 AV1 + WebView 131 支持 AVIF；体积比 PNG 小 60–80% |
| 短循环动画（呼吸、眨眼、待机） | **WebP 动图 / AVIF 序列 / Lottie(JSON)** | 本机 HEVC 硬解虽强，但**带 alpha 的视频支持不稳**，别用 HEVC-alpha |
| 长动画 / 复杂特效 | **HEVC 或 AV1 视频（无 alpha）**，低延迟实例 | 硬解省电，8.33ms 帧预算内可解码多条 |
| 声效 | AAC / Opus（体积）、FLAC（无损） | 全支持；Dolby 只在系统层，不要做依赖 |
| 大背景 | 按 1220×2712 px 出图（或 0.5×/0.25× 多级 mipmap） | 单张纹理上限 200MB，但常驻越小越好 |

---

## 8. 音频参数

| 项 | 值 |
|---|---|
| 媒体音量级数 / 默认 | **30 级** / 默认 20 |
| 通话音量级数 / 默认 | 11 级 / 默认 4 |
| 蓝牙空间音频 | `ro.miui.audio.support.BleSpatializer = true` |
| 运行中的音频服务 | `audioserver`、`media.swcodec`、`dolbycodec2`、`vendor-dolby-media-c2-hal-1-0` |
| 屏幕录制/回采 | `ro.vendor.audio.screenrecorder.bothrecord = 1`、`ro.vendor.audio.playbackcapture.screen = true` |

---

## 9. 图形时序与系统调度（HyperOS 专属行为）

这类参数在普通 AOSP 机器上不存在，**是 MIUI/HyperOS 对动画调度的私有干预**，对"桌宠要跟手、要稳帧"非常关键：

| 属性 / 服务 | 值 | 含义 |
|---|---|---|
| `persist.sys.miui_animator_sched.big_prime_cores` | **`4-7`** | MIUI 把**动画线程**调度到 4 个 X4 大核 |
| `persist.sys.miui_animator_sched.bigcores` | **`4-6`** | 次级动画调度核 |
| `persist.sys.enable_miui_booster` | 1 | MIUI Booster 开启 |
| `persist.sys.hardcoder.name` / `miuibooster.name` | `miui_booster` | 硬编码加速器（在 `/system` 刷入） |
| `init.svc.touch_boost` | running | 触控加速服务常驻 |
| `vendor.boostfwk.frame.decision` | 2 | MTK boost 框架的帧决策策略 |
| `vendor.boostfwk.sbb.touch.duration` | 1000 | 触控加速持续 1000ms |
| `vendor.boostfwk.frameprefetcher` | 0 | 帧预取关闭 |
| `persist.sys.miui_scout_enable` | true | MIUI 资源调度/监控 |
| `persist.sys.smartpower.limit.max.refresh.rate` | **120** | 省电策略限帧 120 |

> **结论（派生）**：在这台机器上，**桌宠的动画线程天然跑在 X4 大核上**，但**刷新率会被 MIUI 压到 120**、**无触控 1.1 秒后进入 idle**、并且**触控后有 1 秒的 boost 窗口**。
> 因此最优策略是：**"触控/交互瞬间拉高帧率（≤120Hz），静止 1.1 秒后主动降帧或降活动量"** —— 既跟手，又不会在 idle 时被判为耗电应用而被限制。

---

## 10. 触控、振动、传感器

| 项 | 结论 |
|---|---|
| 触控设备 | `cmd activity get-config` 中标记为 `finger`（触摸屏），**无鼠标/触控板** |
| 触控采样率、触控 IC、最大触点数 | **无法采集**（`/proc/bus/input/devices` 与 `/sys/class/input` 均 Permission denied） |
| 输入注入 | `cmd input tap/swipe/keyevent` **命令存在**，但 uid 10398 无 `INJECT_EVENTS`，理论上不可用；**不要把它设计成调试依赖** |
| 振动器 | **1 个**，id = `0`（`cmd vibrator_manager list` → `0`） |
| 振感接口 | `cmd vibrator_manager`（`list` / `synced` / `combined` / `sequential` / `xml`）——可直接下 **VibrationEffect.Composition 组合振动** |
| 传感器（加速度/陀螺/指南针/光感/接近/霍尔…） | **无法在 Termux 侧枚举**（sensorservice 的 shell 命令无输出，Termux:API app 未安装，`termux-sensor` 拿不到权限） |

**传感器必须在 App 内运行时枚举**：

```kotlin
val sm = getSystemService(SensorManager::class.java)
sm.getSensorList(Sensor.TYPE_ALL).forEach {
    Log.i("pet", "${it.name} type=${it.type} vendor=${it.vendor} maxRange=${it.maximumRange} res=${it.resolution}")
}
```

> 若桌宠要做 **摇一摇 / 倾斜 / 翻转 / 遮挡（接近光感）** 交互，**一定要运行时探测后再启用**，不要在电脑侧写死"K70 Ultra 一定有陀螺仪"。
> （该机型厂商规格上具备陀螺仪/加速度计/电子罗盘/环境光/接近/霍尔等，但**本次未能从设备读到**，故不作为已验证事实。）

---

## 11. 后台存活与系统限制（桌宠"常驻"的关键风险区）

这是 HyperOS 2.0（MIUI）在**任何 Android 15 行为之外**额外加的限制。桌宠（尤其悬浮窗形态）能不能活，全看这几条：

| 限制 | 表现 | 应对 |
|---|---|---|
| **一键清理会强停应用** | 被强停的应用会**拦截所有跨应用 intent**，只有用户手动启动一次才解锁 | 在最近任务界面**给桌宠加锁**；引导用户开启"自启动" |
| **自启动权限** | 默认需要用户手动授予 | 首次启动用引导页提示（`AutoStartPermissionHelper` 之类），或直接给图文步骤 |
| **省电策略** | 默认"智能省电"会限制后台 | 引导设为 **无限制**，并申请忽略电池优化（`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`） |
| **悬浮窗权限** | `SYSTEM_ALERT_WINDOW` 默认关闭 | 运行时用 `Settings.canDrawOverlays()` 检测并跳转授权 |
| **后台弹出界面 / 通知 / 读取通知** | 默认全部关闭 | 按需申请，**不要一次性全要**（用户反感） |
| **前台服务类型限制（Android 14+/15）** | 必须有合规的 `foregroundServiceType`，否则启动即崩 | 桌宠常驻服务建议用 `specialUse`（并在 manifest 里写明 `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`）或 `mediaPlayback`（若有音频） |
| **`init.svc.touch_boost`、`miuibooster` 常驻** | 系统会在触控后 boost 1000ms | 把"重活动"放在用户交互后 1 秒内做，性价比最高 |

> 相关属性：`ro.miui.notch=1`、`persist.sys.miui_scout_enable=true`、`persist.sys.enable_miui_booster=1`。
> **本机已启用**：`ro.miui.has_gmscore=1`（带 GMS）、`ro.miui.enable_cloud_verify=true`（云验证，装第三方 APK 时会有安全扫描）。

---

## 12. 这台机器上"能查/不能查"的边界（给电脑端工具链的说明）

本节的意义：**电脑侧不要设计依赖下列"查不到"的数据**。

### ✅ Termux 侧（uid 10398）可读

- `getprop`（本次 **2331 条**，已全量扫描并按需过滤）
- `cmd <service>`：`display`（完整 DisplayInfo）、`activity get-config`、`package`（448 个包名 + versionCode）、`device_state`、`vibrator_manager`、`input`、`statusbar`（部分）、`game`、`power`（部分）、`webviewupdate`（仅 set 类）
- `/proc/cpuinfo`、`/proc/meminfo`、`/proc/self/*`、`/sys/devices/system/cpu/*`（频率、capacity、cpuidle、online/isolated）
- `df`、以及 **`/storage/emulated/0` 全目录读写**
- `aapt2`（本次用它解析出 WebView 131.0.6778.260）

### ❌ 被权限挡住 / 不存在

| 目标 | 现象 |
|---|---|
| `dumpsys`（任意服务） | `Permission Denial: … missing android.permission.DUMP` |
| `settings get/put`（含 `--user 0`） | `SecurityException: … INTERACT_ACROSS_USERS` |
| `wm size` / `wm density` | Termux 内**没有 `wm` 命令** |
| `cmd window` | `Can't find service: window` |
| `cmd overlay` | `Can't find service: overlay` |
| `cmd uimode night`（读） | 缺 `MODIFY_DAY_NIGHT_MODE` |
| `cmd deviceidle whitelist` | 缺 `DUMP` |
| `/proc/bus/input/devices`、`/sys/class/input` | `Permission denied` |
| `/sys/class/power_supply/*`（电池） | `Permission denied` |
| `/sys/class/thermal/*`（温度） | 空 / `Permission denied` |
| `/sys/class/devfreq`、`/sys/kernel/ged/*`、`/proc/gpufreqv2/*` | `Permission denied` |
| 截图 / 读取图片 | 系统不允许；**AI 侧也读不了任何图片路径**（连自建探针 PNG 都 `EACCES`） |
| root / sudo / adb | 全部没有 |

> ⚠️ 另外注意：本手册所在工作区的既有记录里曾写"`pm list packages` 受包可见性过滤，只能看到 com.termux"。**本次实测该结论已不成立**：`cmd package list packages` 能列出 **448** 个包（`pm list packages` 亦同）。电脑侧如按旧结论设计，会低估本机可查询范围。

---

## 13. 给桌宠适配的落地建议（★ 以下为派生建议，不是实测事实）

> 上面 1–12 节全部是可核验的原始事实；本节是基于事实的工程建议，**冲突时以事实为准**。

### 13.1 切图与资源

- 密度 **520dpi** 落在 `xxhdpi(480, ×3.0)` 与 `xxxhdpi(640, ×4.0)` 之间，Android 会选最近的 **xxhdpi** 桶，然后**放大 8.33%** 渲染到 ×3.25。
- 要像素级精确，三选一：
  1. **矢量优先**（VectorDrawable / SVG / Lottie）——最省事；
  2. 位图放 `drawable-nodpi`，**严格按 ×3.25 出图**；
  3. 位图放 `drawable-xxxhdpi`（×4.0），让系统**缩小**（缩小比放大的画质好）。
- 桌宠本体尺寸参考（竖屏短边 1220px）：

| 占短边比例 | px | dp |
|---|---|---|
| 10% | 122 | 37.5 |
| 15% | 183 | 56.3 |
| 20% | 244 | 75.1 |
| 25% | 305 | 93.8 |

> 建议**待机态**占短边 12–18%（146–220px），**互动/放大态** 25%（305px）左右；再大就会遮挡主界面内容。

### 13.2 帧率策略

- 目标帧率取 **60Hz 为默认**，交互时提到 **90/120Hz**；
- **不要以 144Hz 为目标**（MIUI 已限制到 120）；
- 单帧预算：60Hz ⇒ CPU+GPU 合计 **≤ 10ms**；120Hz ⇒ **≤ 6ms**；
- 无操作 **1.1 秒**后主动降活动量（与系统的 idle timer 对齐），5–10Hz 的微动效即可。

### 13.3 内存与包体

- 应用堆默认上限 **256MB**，常驻建议 **120–200MB**，解码缓冲 ≤ 64MB；
- 不要用 `largeHeap` 掩盖泄漏；
- 包体与资源：优先 **AVIF/WebP**，长动画走 **HEVC/AV1 视频**；
- 本机可用空间仅 **49GB**，联调资源包请控制在几百 MB 级别。

### 13.4 兼容性下限

- **只发 `arm64-v8a`**（本机不支持 32 位原生库）；
- **最低 API 建议 34+ 更省心**（本机 first_api_level=34），若要下沉到 31–33，务必单独验证：
  - Android 14+ 前台服务类型强校验；
  - Android 13+ 通知权限；
  - Android 12+ 悬浮窗与精确闹钟行为。

### 13.5 必测项清单（在这台真机上）

1. 刘海避让：挖孔不遮挡宠物头顶；
2. 手势导航条不与宠物脚部交互区重叠；
3. 60 / 90 / 120Hz 三档实测帧率与耗电；
4. 静止 1.1 秒后的降帧是否引起"忽然卡一下";
5. 悬浮窗 + 一键清理 + 加锁 三种场景下的存活；
6. 后台省电"无限制"下的 24 小时驻留耗电曲线；
7. AVIF / WebP 动图 / HEVC 视频 三种资源在 WebView 131 与原生两条链路上的表现；
8. 宽色域（P3）素材在 `widecg` 屏幕上的实际观感 + SDR 回退。

---

## 14. 复现命令清单（电脑侧想核对哪条就跑哪条）

手机侧（Termux 内，全部只读）：

```bash
# 系统与设备
getprop
uname -a
cat /proc/cpuinfo; cat /proc/meminfo

# 显示（信息量最大的一条）
cmd display get-displays
cmd activity get-config
cmd display get-active-display-mode-at-start 0
cmd display get-user-preferred-display-mode
cmd display get-match-content-frame-rate-pref

# CPU 集群
for i in 0 1 2 3 4 5 6 7; do
  echo "cpu$i max=$(cat /sys/devices/system/cpu/cpu$i/cpufreq/cpuinfo_max_freq 2>/dev/null) \
cap=$(cat /sys/devices/system/cpu/cpu$i/cpu_capacity 2>/dev/null)"
done
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_frequencies
for d in /sys/devices/system/cpu/cpu0/cpuidle/state*; do echo "$(basename $d) $(cat $d/name) $(cat $d/latency)"; done

# 存储
df -h /data /storage/emulated/0

# 版本 / WebView
cmd package path com.google.android.webview      # 再对返回的 apk 跑：
aapt2 dump badging /product/app/WebViewGoogle64/WebViewGoogle64.apk | head -3

# 振动 / 形态
cmd vibrator_manager list
cmd device_state print-state

# 编解码
ls /vendor/etc/media_codecs*.xml
grep -oE 'name="[^"]*"' /vendor/etc/media_codecs_c2.xml | sort -u | head -60
```

---

## 15. 未采集 / 未知项（明确列出，避免电脑侧误以为"已知"）

1. 状态栏、挖孔、手势条、输入法的**精确 inset 数值**
2. 屏幕**圆角半径**、屏幕**面板厂商与型号字符串**
3. 系统当前**字体缩放**、**动画时长缩放**（settings 读不到）
4. **触控 IC 型号、触控采样率、最大同时触点数**
5. **传感器清单**（加速度计/陀螺仪/电子罗盘/环境光/接近/霍尔等是否存在，未验证）
6. **电池**额定容量、健康度、实时电流/电压/温度、充电功率（power_supply 被拒）
7. **温度墙与降频曲线**（thermal_zone 被拒）
8. **GPU 型号字符串、GPU 频率表、Vulkan 版本号**
9. **CPU/GPU 持续性能**（长时间负载下的稳态帧率，须在 App 内 profiling）
10. 现网信号、Wi-Fi 型号、蓝牙版本等**连接性细节**
11. 屏幕**峰值亮度实测**（只有厂商属性 1600nits 与 API 报告的 500nits 两个口径）

---

## 16. 给电脑端 DSH 的接入说明

- 本机（手机）**没有**把这份文档放进跨端通道（`~/.dsh-handoff/`），是**刻意**的：按你的要求，跨端协作还不完整，所以**文件本体走人工搬运**（下载目录 → 微信/QQ/U 盘 → 电脑）。
- 两个文件位置（手机侧）：

| 文件 | 路径 | 用途 |
|---|---|---|
| 规格书（本文，人读） | `/storage/emulated/0/Download/桌宠适配-真机规格书_Redmi-K70-Ultra_20260917.md` | 设计换算、切图、预算、必测清单 |
| 规格数据（机器读） | `/storage/emulated/0/Download/桌宠适配-真机规格_20260917.json` | 让电脑上的 DSH 直接 `JSON.parse` 后喂给设计/构建脚本 |

- JSON 的 `schema` 字段为 `dsh.device-profile/1`，节点划分：`meta / device / os / display / cpu / gpu / memory / storage / media / audio / timing / haptics / platform_behavior_for_background_app / probe_capability / unknowns / reproduce_commands`。
- 电脑侧建议动作：把 JSON 丢给 DSH，让它**生成 rem/px 换算表、资源切图清单、以及一份目标设备配置类**（例如 Unity/Godot 的 profile 或 Android 的 `DeviceProfile`）。

### 校验值

| 文件 | 大小 | sha256 |
|---|---|---|
| `桌宠适配-真机规格_20260917.json` | 17,756 字节 | `e552f0e3121d49af9f9417bcb0458c7dc938a4bcf8842dd05c96626f0eeef79b` |
| `桌宠适配-真机规格书_Redmi-K70-Ultra_20260917.md` | 见文件属性 | 传完后在电脑侧用 `sha256sum` 对比（手机侧可用 `sha256sum` 生成） |

> 传输后核对建议：在电脑上跑 `sha256sum <文件名>`，与手机侧 `cd /storage/emulated/0/Download && sha256sum 桌宠适配-真机规格*` 的输出逐字节对比。

---

*本文档由手机内 DSH 会话于 2026-09-17 采集生成；所有原始数据均来自设备自身只读查询，未包含任何个人隐私字段。*