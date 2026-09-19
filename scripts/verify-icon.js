"use strict";

/**
 * verify-icon —— **逐像素**验证生成的图标真的是"白底 + 黑色鲸鱼"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它（以及它替代了什么）
 * ══════════════════════════════════════════════════════════════════
 * 图标是纯视觉产物，最容易犯的错是"脚本说成功、图其实不对"
 * （白底没生效 / 全透明 / 鲸鱼画反 / 只画出一个黑方块）。
 * 而"看一眼"不是可重复的验证手段。
 *
 * ⇒ 这里自己解码 PNG（只用 Node 自带的 `zlib`，**零依赖**），
 *   然后对这些**可断言的性质**逐条检查：
 *
 *   1. 画布四角与四边中点是**不透明纯白** `#ffffff`（⇒ "白色底部"成立，
 *      且不是原来那种透明底）。
 *   2. 存在足量**纯黑**像素（⇒ 鲸鱼画出来了，不是空白图）。
 *   3. 纯黑像素的**包围盒居中**且占画布约 `scale²×鲸鱼占比`（⇒ 没有被裁切/偏心）。
 *   4. 包围盒**内部**有足量白色（⇒ 肚皮/眼睛/水花的镂空在，不是一坨黑方块）。
 *   5. 文件尺寸与文件名承诺的一致（16/24/32/…/512）。
 *   6. `icon.ico` 里每张内嵌 PNG 的 **IHDR 真实尺寸**与目录项声明的尺寸一致。
 *
 * ★ 第 6 条是独立复核：`make-icon.js` 自己也校验一遍 ICO，但"脚本自报"
 *   不算证据，所以这里用**另一份代码**再解析一次，并且校验的是
 *   PNG 字节流里的真实宽高，而不是脚本写进目录项的那个数。
 *
 * 用法：node scripts/verify-icon.js
 * 退出码：0 全部通过；1 有不通过项（明细打到 stderr）。
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");

// ── 最小 PNG 解码器（8 位，非隔行，颜色类型 2/6）────────────────────
function decodePng(buf) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error("不是 PNG（签名不符）");

  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data.readUInt8(8),
        colorType: data.readUInt8(9),
        compression: data.readUInt8(10),
        filter: data.readUInt8(11),
        interlace: data.readUInt8(12),
      };
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    off += 8 + len + 4; // 长度 + 类型 + 数据 + CRC
  }
  if (!ihdr) throw new Error("没有 IHDR");
  if (ihdr.bitDepth !== 8) throw new Error(`只支持 8 位，实际 ${ihdr.bitDepth}`);
  if (ihdr.interlace !== 0) throw new Error("不支持隔行 PNG");
  if (ihdr.colorType !== 6 && ihdr.colorType !== 2) {
    throw new Error(`只支持颜色类型 6(RGBA)/2(RGB)，实际 ${ihdr.colorType}`);
  }

  const bpp = ihdr.colorType === 6 ? 4 : 3;
  const stride = ihdr.width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const expect = (stride + 1) * ihdr.height;
  if (raw.length < expect) throw new Error(`IDAT 解压后 ${raw.length} 字节，期望 ${expect}`);

  const out = Buffer.alloc(stride * ihdr.height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.height; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.from(line);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = cur[x];
      if (ft === 1) v = (v + a) & 0xff;
      else if (ft === 2) v = (v + b) & 0xff;
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (ft === 4) {
        // Paeth
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        v = (v + pr) & 0xff;
      } else if (ft !== 0) {
        throw new Error(`第 ${y} 行未知过滤器 ${ft}`);
      }
      cur[x] = v;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }

  return {
    width: ihdr.width,
    height: ihdr.height,
    hasAlpha: ihdr.colorType === 6,
    px(x, y) {
      const o = y * stride + x * bpp;
      return [out[o], out[o + 1], out[o + 2], bpp === 4 ? out[o + 3] : 255];
    },
  };
}

function readPng(file) {
  if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}`);
  return decodePng(fs.readFileSync(file));
}

// ── 断言器 ────────────────────────────────────────────────────────
const failures = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures.push(`${name}: ${detail || ""}`);
}

const isWhite = (p) => p[0] >= 250 && p[1] >= 250 && p[2] >= 250 && p[3] === 255;
const isBlack = (p) => p[0] <= 12 && p[1] <= 12 && p[2] <= 12 && p[3] === 255;

/**
 * 对一个 PNG 做内容检查。
 * @param {string} file
 * @param {number} expectSize
 * @param {number} scale - 生成时用的缩放（用来推算合理的黑色占比区间）
 */
function analyzeImage(file, expectSize, scale) {
  const label = path.basename(file);
  console.log(`\n[${label}]`);
  const img = readPng(file);

  check(`${label} 尺寸`, img.width === expectSize && img.height === expectSize,
    `${img.width}x${img.height}，期望 ${expectSize}x${expectSize}`);

  // 1. 边缘与四角：不透明纯白
  const probes = [
    [0, 0], [img.width - 1, 0], [0, img.height - 1], [img.width - 1, img.height - 1],
    [(img.width >> 1), 0], [(img.width >> 1), img.height - 1],
    [0, (img.height >> 1)], [img.width - 1, (img.height >> 1)],
  ];
  const badEdges = probes.filter(([x, y]) => !isWhite(img.px(x, y)));
  check(`${label} 四角+四边中点为不透明纯白`, badEdges.length === 0,
    badEdges.length ? `${badEdges.length}/8 个点不是白色，例如 ${JSON.stringify(img.px(...badEdges[0]))}` : "8/8");

  // 2. 统计黑/白，求黑像素包围盒
  let black = 0, opaque = 0, transparent = 0;
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = img.px(x, y);
      if (p[3] === 255) opaque++; else transparent++;
      if (isBlack(p)) {
        black++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  const total = img.width * img.height;
  const blackRatio = black / total;

  check(`${label} 完全不透明（无透明像素）`, transparent === 0, `透明 ${transparent} / ${total}`);
  check(`${label} 存在黑色鲸鱼像素`, black > 0, `黑 ${black} 像素（${(blackRatio * 100).toFixed(1)}%）`);

  // 3. 占比落在合理区间。鲸鱼轮廓约占外接框 35%，再乘 scale²
  const lo = Math.max(0.05, scale * scale * 0.22);
  const hi = Math.min(0.75, scale * scale * 0.52);
  check(`${label} 黑色占比合理`, blackRatio >= lo && blackRatio <= hi,
    `${(blackRatio * 100).toFixed(1)}%，期望 ${(lo * 100).toFixed(1)}%~${(hi * 100).toFixed(1)}%`);

  // 4. 包围盒居中
  if (maxX >= 0) {
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const dx = Math.abs(cx - (img.width - 1) / 2) / img.width;
    const dy = Math.abs(cy - (img.height - 1) / 2) / img.height;
    check(`${label} 鲸鱼居中`, dx <= 0.06 && dy <= 0.06,
      `偏移 dx=${(dx * 100).toFixed(2)}% dy=${(dy * 100).toFixed(2)}%`);
    // 大小：★ 鲸鱼**天然是横宽的**（外接框约 1.34:1），所以不可能同时满足
    //   w=h=scale —— 只有**长边**能命中 scale，短边必然更小。
    //   （这里踩过一次：一开始断言 w≈h≈scale，四条全红，图其实是对的。）
    const wRatio = (maxX - minX + 1) / img.width, hRatio = (maxY - minY + 1) / img.height;
    const longSide = Math.max(wRatio, hRatio);
    const aspect = wRatio / hRatio;
    check(`${label} 长边接近设定缩放 ${scale}`,
      Math.abs(longSide - scale) <= 0.08,
      `实测 ${wRatio.toFixed(3)}x${hRatio.toFixed(3)}，长边 ${longSide.toFixed(3)}`);
    check(`${label} 鲸鱼宽高比正常（横宽，约 1.34:1）`,
      aspect >= 1.20 && aspect <= 1.50,
      `实测 ${aspect.toFixed(3)}（被压扁/拉长会掉出这个区间）`);

    // 5. 镂空：包围盒内部必须有白色（肚皮/眼睛/水花）
    let innerWhite = 0, innerTotal = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        innerTotal++;
        if (isWhite(img.px(x, y))) innerWhite++;
      }
    }
    const innerWhiteRatio = innerWhite / innerTotal;
    check(`${label} 鲸鱼内部有镂空（肚皮/眼睛/水花）`,
      innerWhiteRatio >= 0.15,
      `包围盒内白色占 ${(innerWhiteRatio * 100).toFixed(1)}%（一坨实心黑会接近 0%）`);
  }
}

/** ICO 独立复核：目录项声明的尺寸 vs 内嵌 PNG 的 IHDR 真实尺寸。 */
function analyzeIco(file) {
  console.log(`\n[${path.basename(file)}]`);
  const buf = fs.readFileSync(file);
  const count = buf.readUInt16LE(4);
  check("icon.ico 是 ICO(type=1)", buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1);
  const sizes = [];
  let allOk = true;
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const dw = buf.readUInt8(o) || 256;
    const dh = buf.readUInt8(o + 1) || 256;
    const len = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    const img = decodePng(buf.subarray(off, off + len));
    const ok = img.width === dw && img.height === dh;
    if (!ok) allOk = false;
    sizes.push(`${dw}${ok ? "" : `(IHDR ${img.width})`}`);
  }
  check("icon.ico 每张内嵌 PNG 的 IHDR 与目录项一致", allOk, sizes.join(", "));
  const has256 = sizes.some((s) => s.startsWith("256"));
  check("icon.ico 含 256x256（Windows 大图标/打包要求）", has256, sizes.join(", "));
}

// ── 主流程 ────────────────────────────────────────────────────────
console.log(`verify-icon —— ${ASSETS}`);
try {
  analyzeImage(path.join(ASSETS, "icon.png"), 512, 0.84);
  analyzeImage(path.join(ASSETS, "icon-256.png"), 256, 0.84);
  analyzeImage(path.join(ASSETS, "tray.png"), 32, 0.94);
  analyzeImage(path.join(ASSETS, "tray@2x.png"), 64, 0.94);
  analyzeIco(path.join(ASSETS, "icon.ico"));
} catch (e) {
  console.error(`\n[verify-icon] 无法完成检查: ${(e && e.stack) || e}`);
  process.exit(1);
}

if (failures.length) {
  console.error(`\n[verify-icon] ${failures.length} 项不通过:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("\n[verify-icon] 全部通过：白底不透明 + 黑色鲸鱼 + 居中 + 有镂空");
process.exit(0);
