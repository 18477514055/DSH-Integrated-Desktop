"use strict";

/**
 * make-icon —— 生成应用图标：**白色底 + 黑色鲸鱼**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是"白底黑鲸鱼"
 * ══════════════════════════════════════════════════════════════════
 * 原来用的是社区版留下的占位图（官方 favicon 的**白色前景 + 透明底**）。
 * 透明底的白色图形在**浅色任务栏 / 浅色资源管理器**上几乎看不见。
 * 白底 + 黑鲸鱼在浅色和深色两种底上**都看得清**，所以整个换掉。
 *
 * ══════════════════════════════════════════════════════════════════
 * 形状来源：官方 favicon 的鲸鱼路径（不是自己画的）
 * ══════════════════════════════════════════════════════════════════
 * `src/whale-path.json` 是官方 `dsh-web-frontend/dist/favicon.svg` 里那条
 * `<path d="…">` 按 `M` 拆成的 4 段（body / belly / eye / spout），
 * 由社区工程的 `scripts/gen-whale-path.js` 生成，2026-09-20 原样搬进来。
 *
 * ★ 官方 favicon 本身在**浅色模式下是不可见的**：它的 `<svg>` 带 `fill="none"`，
 *   只有 `prefers-color-scheme: dark` 那条媒体查询才把 path 填成白色。
 *   所以这里**不直接复用官方 svg**，而是用自己的画布明确指定两种颜色。
 *
 * ★ 填充规则：body 是逆时针外轮廓，belly/eye/spout 是三处顺时针镂空。
 *   这里不依赖 nonzero 环绕数，而是**先画黑色身体、再用白色把三个孔盖回去** ——
 *   换渲染器也不会画错。
 *
 * ══════════════════════════════════════════════════════════════════
 * 产物（全部写进 assets/，全部可重复生成）
 * ══════════════════════════════════════════════════════════════════
 *   icon.png        512  窗口图标 / 备用
 *   icon-256.png    256  electron-builder 转换用 / 备用
 *   icon.ico        多尺寸真 ICO（16/24/32/48/64/128/256，内嵌 PNG）
 *                       ⇒ Windows 上 exe 的**文件图标**与**桌面 / 开始菜单快捷方式图标**
 *                         都取自它（快捷方式指向 exe，图标即 exe 内嵌图标）
 *   tray.png         32  托盘（通知区域）
 *   tray@2x.png      64  高分屏托盘（Electron 按 @2x 后缀自动选用）
 *
 * 用法：
 *   npm run icon          （= electron scripts/make-icon.js）
 *   npm run dist          （前置会自动跑 ensure-icon）
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ 两个踩过的坑（别改回去）
 * ══════════════════════════════════════════════════════════════════
 * 1. **`ELECTRON_RUN_AS_NODE=1` 会让这个脚本必崩。**
 *    被设上时 Electron 退化成纯 Node，`require("electron")` 返回的是
 *    **npm 包里那个指路字符串**而不是 API ⇒ 解构出的 `app` 是 undefined
 *    ⇒ 报 `Cannot read properties of undefined (reading 'whenReady')`。
 *    DSH 给工具子进程就设了这个变量（本机实测 `=1`），所以在 DSH 会话里
 *    跑必须先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`。下面有显式检查。
 *
 * 2. **别"每个尺寸开一个离屏窗口"。**
 *    实测：连续开关 8 个离屏窗口时，16×16 能成、24×24 直接
 *    `ERR_FAILED (-2) loading 'data:text/html…'` —— 是窗口创建/销毁的竞态，
 *    不是尺寸限制。改成**每个缩放档只渲染一张 512 母图、再降采样**就稳了
 *    （加载次数 8 → 2）。
 */

const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

// ── 坑 1 的显式检查：早失败、说人话 ─────────────────────────────
if (!process.versions.electron) {
  console.error("[make-icon] 这个脚本必须由 Electron 运行，当前是纯 Node。");
  console.error("[make-icon] 正确用法: npm run icon   （或 electron scripts/make-icon.js）");
  process.exit(1);
}
{
  const probe = require("electron");
  // ★ 注意：`whenReady` 在 **`app`** 上，不在 electron 模块上。
  //   （这里踩过一次：写成 `typeof probe.whenReady` 会让守卫永远为真、
  //     把一次本来能跑通的渲染误判成环境问题。）
  if (!probe || !probe.app || typeof probe.app.whenReady !== "function") {
    console.error("[make-icon] require('electron') 没有返回 Electron API。");
    console.error("[make-icon] 几乎总是因为环境变量 ELECTRON_RUN_AS_NODE 被设上了。");
    console.error("[make-icon] PowerShell 里先执行:  Remove-Item Env:\\ELECTRON_RUN_AS_NODE");
    process.exit(1);
  }
}

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "assets");
const WHALE_FILE = path.join(ROOT, "src", "whale-path.json");

/** 配色与留白：白底、黑色鲸鱼 */
const BG = "#ffffff";
const FG = "#000000";
/** 应用图标留白多一点（贴边会显得比其他图标大一圈） */
const APP_SCALE = 0.84;
/** 托盘要"填满"：16~32px 下留白会让鲸鱼糊成一团 */
const TRAY_SCALE = 0.94;
/** 母图尺寸：一次渲染，之后全部降采样 */
const MASTER = 512;

const APP_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const TRAY_SIZES = [32, 64];

function loadWhale() {
  if (!fs.existsSync(WHALE_FILE)) {
    console.error(`[make-icon] 找不到 ${WHALE_FILE}`);
    console.error("[make-icon] 它应由 scripts/gen-whale-path.js 从官方 favicon.svg 生成。");
    process.exit(1);
  }
  // ★ 用 readFileSync + JSON.parse，不用 require：require 带缓存，改了几何后会拿到旧值
  const shapes = JSON.parse(fs.readFileSync(WHALE_FILE, "utf8"));
  const missing = ["body", "belly", "eye", "spout"].filter(
    (k) => typeof shapes[k] !== "string" || shapes[k].length === 0);
  if (missing.length) {
    console.error(`[make-icon] whale-path.json 缺字段: ${missing.join(", ")}`);
    process.exit(1);
  }
  return shapes;
}

/**
 * 一个尺寸的 SVG 片段，绝对定位在 `left` 处。
 * viewBox 固定 `0 0 50 50`（官方 favicon 坐标系）；小尺寸靠降采样得到。
 */
function svgCell(left, size, scale, shapes) {
  const pad = (50 * (1 - scale)) / 2;
  return `<svg style="position:absolute;left:${left}px;top:0" width="${size}" height="${size}" viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="50" height="50" fill="${BG}"/>
  <g transform="translate(${pad} ${pad}) scale(${scale})">
    <path d="${shapes.body}" fill="${FG}"/>
    <path d="${shapes.belly}" fill="${BG}"/>
    <path d="${shapes.eye}" fill="${BG}"/>
    <path d="${shapes.spout}" fill="${BG}"/>
  </g>
</svg>`;
}

/** 一页画两张母图（左=应用，右=托盘），只加载一次。 */
function masterPage(shapes) {
  const W = MASTER * 2;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:${BG};width:${W}px;height:${MASTER}px;overflow:hidden}
</style></head><body>
${svgCell(0, MASTER, APP_SCALE, shapes)}
${svgCell(MASTER, MASTER, TRAY_SCALE, shapes)}
</body></html>`;
}

/**
 * 渲染两张母图，返回 `{ app, tray }`（PNG Buffer）。
 *
 * ★ 为什么是"一张页面两个格子"而不是"渲染两次"：
 *   实测每渲染一张就新建/销毁一个离屏窗口时，**第二张必然**
 *   `ERR_FAILED (-2) loading 'data:text/html…'` —— 离屏窗口创建/销毁有竞态。
 *   只加载一次页面就没有第二次机会踩到它。
 *
 * ★ 为什么用离屏窗口 + capturePage，而不是 nativeImage.createFromDataURL：
 *   nativeImage **解码不了 SVG**（Chromium 的 ImageSkia 没有 SVG 解码器），
 *   社区工程当年的 make-icon.js 里那段"方案 A"就是因此被跳过的。
 */
async function renderMasters(shapes) {
  const win = new BrowserWindow({
    width: MASTER * 2,
    height: MASTER,
    useContentSize: true,
    show: false,
    frame: false,
    resizable: false,
    backgroundColor: BG,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  try {
    const html = masterPage(shapes);
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    // 离屏渲染是异步的：loadURL 返回后可能还有一帧没画完
    await new Promise((r) => setTimeout(r, 500));

    const grab = async (x, tag) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const img = await win.webContents.capturePage({ x, y: 0, width: MASTER, height: MASTER });
        if (!img.isEmpty()) {
          const buf = img.toPNG();
          if (buf && buf.length > 100) return buf;
        }
        console.log(`[make-icon]   ${tag} 母图第 ${attempt} 次取到空图，重试…`);
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new Error(`${tag} 母图三次都是空图`);
    };

    return { app: await grab(0, "应用"), tray: await grab(MASTER, "托盘") };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * 组装 ICO 容器。
 *
 * 结构（全部小端）：
 *   6 字节头：reserved=0, type=1(icon), count
 *   每张 16 字节目录项：宽/高(0 表示 256)、调色板数、保留、planes、bpp、
 *                       数据长度、数据偏移
 *   随后是所有图像数据
 * ★ 图像数据直接用 PNG（Vista 起 Windows 全尺寸都支持 PNG-in-ICO）；
 *   自己写 BMP(DIB) 变体收益很小、写错的风险很大。
 */
function buildIco(entries) {
  const n = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(n, 4);

  const dir = Buffer.alloc(16 * n);
  let offset = 6 + 16 * n;
  const blobs = [];
  entries.forEach((e, i) => {
    const o = i * 16;
    const dim = e.size >= 256 ? 0 : e.size; // 256 在 ICO 里写 0
    dir.writeUInt8(dim, o + 0);
    dir.writeUInt8(dim, o + 1);
    dir.writeUInt8(0, o + 2);       // 调色板颜色数（真彩写 0）
    dir.writeUInt8(0, o + 3);       // 保留
    dir.writeUInt16LE(1, o + 4);    // color planes
    dir.writeUInt16LE(32, o + 6);   // bits per pixel
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
    blobs.push(e.png);
  });
  return Buffer.concat([header, dir, ...blobs]);
}

/** 自己读一遍 ICO 目录，证明写出来的容器是自洽的（不靠"应该没问题"）。 */
function verifyIco(buf, expectSizes) {
  if (buf.length < 6 + 16) throw new Error("ICO 太短");
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (reserved !== 0 || type !== 1) throw new Error(`ICO 头不对: reserved=${reserved} type=${type}`);
  if (count !== expectSizes.length) throw new Error(`ICO 张数不对: ${count} != ${expectSizes.length}`);
  const seen = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const w = buf.readUInt8(o) || 256;
    const len = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    if (off + len > buf.length) throw new Error(`ICO 第 ${i} 张越界: off=${off} len=${len} total=${buf.length}`);
    const sig = buf.subarray(off, off + 8);
    const isPng = sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47;
    if (!isPng) throw new Error(`ICO 第 ${i} 张不是 PNG`);
    seen.push(w);
  }
  const want = expectSizes.map((s) => (s >= 256 ? 256 : s)).join(",");
  const got = seen.join(",");
  if (want !== got) throw new Error(`ICO 尺寸表不对: ${got} != ${want}`);
  return got;
}

// ★ 必须在 app ready **之前**调用（远程桌面 / 无 GPU 环境下离屏渲染更稳）
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const shapes = loadWhale();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`[make-icon] 渲染母图 ${MASTER}x${MASTER}×2（应用缩放 ${APP_SCALE}，托盘缩放 ${TRAY_SCALE}）…`);
  const masters = await renderMasters(shapes);
  const appMaster = nativeImage.createFromBuffer(masters.app);
  const trayMaster = nativeImage.createFromBuffer(masters.tray);

  const at = (master, size) => master.resize({ width: size, height: size, quality: "best" }).toPNG();
  const rasters = new Map();
  for (const size of APP_SIZES) rasters.set(size, at(appMaster, size));
  const trayRasters = new Map();
  for (const size of TRAY_SIZES) trayRasters.set(size, at(trayMaster, size));

  const write = (name, buf) => {
    const p = path.join(OUT_DIR, name);
    fs.writeFileSync(p, buf);
    console.log(`[make-icon]   ${name.padEnd(14)} ${String(buf.length).padStart(7)} 字节`);
    return p;
  };

  write("icon.png", rasters.get(512));
  write("icon-256.png", rasters.get(256));
  write("tray.png", trayRasters.get(32));
  write("tray@2x.png", trayRasters.get(64));

  const ico = buildIco(ICO_SIZES.map((size) => ({ size, png: rasters.get(size) })));
  write("icon.ico", ico);
  const sizes = verifyIco(ico, ICO_SIZES);
  console.log(`[make-icon] icon.ico 自检通过，内嵌尺寸: ${sizes}`);

  console.log(`[make-icon] 完成，输出目录: ${OUT_DIR}`);
  app.exit(0);
}).catch((e) => {
  console.error("[make-icon] 失败:", (e && e.stack) || e);
  app.exit(1);
});

// 渲染阶段任何未捕获异常都要以非 0 退出，否则打包脚本会以为图标生成成功了
process.on("uncaughtException", (e) => {
  console.error("[make-icon] 未捕获异常:", (e && e.stack) || e);
  app.exit(1);
});
