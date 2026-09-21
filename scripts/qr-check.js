"use strict";

/**
 * qr-check.js —— 证明"我们画的二维码，别的解码器能读出来"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不能只看"编码器没报错"
 * ══════════════════════════════════════════════════════════════════
 * `$DSH_HOME/AGENTS.md` 第二条硬规矩：验证必须**真让它工作**，
 * "函数存在 / 没抛异常 / 版本号对"一律不构成证据。
 * 二维码尤其如此：编出来的矩阵**画错了、静区不够、掩码错、EC 等级选错**，
 * 编码器都不会报错 —— 它只是安静地产出一个**扫不出来的**方块。
 *
 * 所以这里的判据是**端到端**的，而且是**交叉实现**的：
 *   用 A 库（qrcode-generator，MIT）编码 → 渲染成真实 RGBA 像素
 *   → 交给 B 库（jsQR，Apache-2.0，**完全独立的另一份实现**）解码
 *   → 解出来的字符串必须与原串**逐字节相等**。
 * 两个互不相干的实现同时错成一样，才可能骗过这一关。
 *
 * ★ 这里渲染像素的那段代码**与 lib/index.js 里给手机端画图用的是同一套算法**
 *   （getModuleCount/isDark + 4 模块静区 + 整数倍缩放），
 *   所以这个脚本验的就是**真正会上线的那条路径**，不是一个平行实现。
 *
 * 用法：node scripts/qr-check.js
 * 退出码：0 全过；1 有失败。
 */

const path = require("node:path");
const { createRequire } = require("node:module");

const ROOT = path.join(__dirname, "..");
// ★ 2026-09-21 插件包内分层（desktop/ = 电脑侧，phone/ = 手机侧）后，qr.cjs 归入 desktop/。
//   下面这条路径走的是 ② 里的**联接**（plugin\dsh-mobile-remote → ③\3.dsh-mobile-remote），
//   联接会兜住，所以 ② 这边不用关心本体在哪个工作区。
const QR_PATH = path.join(ROOT, "plugin", "dsh-mobile-remote", "desktop", "qr.cjs");
// 解码器是**另一份独立实现**（Apache-2.0），只用于验证，不随插件发布。
// 放在 scripts/vendor/ 而不是临时目录：验证脚本必须能重复跑，不能依赖一个会被删掉的目录。
const DECODER = path.join(ROOT, "scripts", "vendor", "jsqr.cjs");

const req = createRequire(__filename);
const qrcode = req(QR_PATH);
const jsQRMod = req(DECODER);
const jsQR = typeof jsQRMod === "function" ? jsQRMod : jsQRMod.default;

let failed = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failed++;
}

/**
 * 把 QR 矩阵渲染成 RGBA 像素 —— **与插件里给手机端画 PNG 用的是同一套算法**。
 * @param {string} text 要编码的内容
 * @param {number} scale 每个模块占几个像素
 * @param {number} quiet 静区（单位：模块）。QR 标准要求 ≥4，少了会扫不出来。
 * @param {string} ec 纠错等级 L/M/Q/H
 */
function render(text, scale, quiet, ec) {
  // ★ 必须显式切到 UTF-8：这个库的默认 stringToBytes 是 **Latin-1**
  //   （`charCodeAt(i) & 0xff`），任何非 ASCII 字符都会被悄悄截成低 8 位 ——
  //   编码器不报错，产出的却是个**内容错掉的**二维码。
  //   实测（本脚本第一轮）：中文那条解出来是空串。
  //   配对码本身是 ASCII，所以真实路径不会踩到；但"只在 ASCII 下正确"是个地雷，
  //   这里与 lib/index.js 用同一种写法，把它钉死。
  qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];
  // typeNumber 0 = 让库自己选最小够用的版本号
  const qr = qrcode(0, ec);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const side = (n + quiet * 2) * scale;
  const buf = Buffer.alloc(side * side * 4, 0xff); // 先全填白（含 alpha=255）
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      const y0 = (r + quiet) * scale;
      const x0 = (c + quiet) * scale;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const o = ((y0 + dy) * side + (x0 + dx)) * 4;
          buf[o] = 0; buf[o + 1] = 0; buf[o + 2] = 0; buf[o + 3] = 255;
        }
      }
    }
  }
  return { buf, side, n };
}

console.log("\n=== qr-check：交叉实现验证（A 库编码 → B 库解码）===\n");
console.log(`  编码器 : ${path.relative(ROOT, QR_PATH)}`);
console.log(`  解码器 : ${path.relative(ROOT, DECODER)}（独立实现，仅用于验证，不随包发布）\n`);

// 真实会用到的内容形状：配对 URL（含 16 位一次性码）
const CASES = [
  ["配对 URL（短）", "http://192.168.31.107:3110/pair?c=AbCdEf1234567890"],
  ["配对 URL（长 IP/主机名）", "http://192.168.100.200:3110/pair?c=Zz9Yy8Xx7Ww6Vv5U"],
  // ★ Android 壳 App 用的那个码：自定义 scheme + 百分号编码的 http 地址。
  //   它比普通 URL 长不少（内含 %3A%2F%2F 等），必须单独验一次可读性。
  ["App 深链（dshmr://，含百分号编码）",
    "dshmr://pair?u=" + encodeURIComponent("http://192.168.31.107:3110/pair?c=AbCdEf1234567890")],
  ["带 token 的完整地址", "http://10.0.0.7:3110/?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnop.qrstuvwxyz012345"],
  ["纯数字", "12345678901234567890"],
  ["中文（UTF-8 多字节）", "手机遥控：扫码连接电脑端 DSH"],
  ["混合长串（约 180 字节）", "http://192.168.31.107:3110/pair?c=AbCdEf1234567890&n=" + "x".repeat(100)],
];

for (const [label, text] of CASES) {
  let out;
  try {
    out = render(text, 4, 4, "M");
  } catch (e) {
    check(`${label} — 编码`, false, String(e));
    continue;
  }
  const decoded = jsQR(new Uint8ClampedArray(out.buf), out.side, out.side);
  const got = decoded && decoded.data;
  const ok = got === text;
  check(
    `${label} — 独立解码器读回一致`,
    ok,
    ok
      ? `版本 ${out.n}×${out.n}，${out.side}px`
      : `期望 ${JSON.stringify(text).slice(0, 60)}… 实际 ${JSON.stringify(got).slice(0, 60)}`,
  );
}

// 纠错等级：四档都必须能编能解（默认用 M，但别把别的等级留成地雷）
console.log("");
for (const ec of ["L", "M", "Q", "H"]) {
  const text = `http://192.168.31.107:3110/pair?c=EC${ec}1234567890`;
  try {
    const out = render(text, 4, 4, ec);
    const decoded = jsQR(new Uint8ClampedArray(out.buf), out.side, out.side);
    check(`纠错等级 ${ec} 可编可解`, decoded && decoded.data === text, `版本 ${out.n}×${out.n}`);
  } catch (e) {
    check(`纠错等级 ${ec} 可编可解`, false, String(e));
  }
}

// 缩放倍数：手机屏幕密度不同，别只在 4 倍下是对的
console.log("");
for (const scale of [2, 3, 4, 6, 8]) {
  const text = "http://192.168.31.107:3110/pair?c=Scale" + scale;
  const out = render(text, scale, 4, "M");
  const decoded = jsQR(new Uint8ClampedArray(out.buf), out.side, out.side);
  check(`缩放 ${scale}× 可解码`, decoded && decoded.data === text, `${out.side}px`);
}

// ── 对照实验：证明"这把尺子真的在量东西" ────────────────────────────
// 第一版这里用的是"静区=0 应该解不出来"，**实测该断言失败**：jsQR 对静区相当宽容，
// 去掉静区它照样解出来了 ⇒ 那条判据太弱，通不过反而说明它不能当证据（已换成下面两条）。
// 教训记在这里：**先证明尺子对，再报结论**。
console.log("");
{
  const target = "http://192.168.31.107:3110/pair?c=ControlAAA";
  const other = "http://192.168.31.107:3110/pair?c=ControlBBB";

  // 对照①：另一串内容的二维码，**不能**解出目标串
  const outOther = render(other, 4, 4, "M");
  const decOther = jsQR(new Uint8ClampedArray(outOther.buf), outOther.side, outOther.side);
  check(
    "对照①：另一串内容的二维码解出的是它自己、不是目标串",
    decOther && decOther.data === other && decOther.data !== target,
    decOther ? `读回 ${JSON.stringify(decOther.data).slice(0, 48)}` : "没解出来",
  );

  // 对照②：纯噪声不能解出目标串
  const side = 200;
  const noise = Buffer.alloc(side * side * 4, 0xff);
  for (let i = 0; i < side * side; i++) {
    const v = Math.random() < 0.5 ? 0 : 255;
    noise[i * 4] = v; noise[i * 4 + 1] = v; noise[i * 4 + 2] = v; noise[i * 4 + 3] = 255;
  }
  const decNoise = jsQR(new Uint8ClampedArray(noise), side, side);
  check(
    "对照②：纯噪声不会解出目标串（解码器不是在无脑返回）",
    !decNoise || decNoise.data !== target,
    decNoise ? `噪声里读出了 ${JSON.stringify(decNoise.data).slice(0, 40)}` : "如期没有结果",
  );

  // 记录（不作断言）：jsQR 对静区的容忍度，供以后排查"扫不出来"时参考
  const outNoQuiet = render(target, 4, 0, "M");
  const decNoQuiet = jsQR(new Uint8ClampedArray(outNoQuiet.buf), outNoQuiet.side, outNoQuiet.side);
  console.log(
    `  NOTE  静区=0 时 jsQR ${decNoQuiet && decNoQuiet.data === target ? "仍能解出（该解码器对静区宽容）" : "解不出"}` +
    "  —— 但本插件仍按标准用 4 模块静区（真机摄像头比 jsQR 苛刻得多）",
  );
}

console.log("");
if (failed) {
  console.log(`结果：${failed} 项 FAIL\n`);
  process.exit(1);
}
console.log("结果：全部 PASS —— 二维码可被独立实现读回\n");
process.exit(0);
