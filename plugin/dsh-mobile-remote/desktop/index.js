/**
 * dsh-int-mobile-remote —— 宿主半边（Host half）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 它做什么
 * ═══════════════════════════════════════════════════════════════════════════
 * 同时开两个面：
 *
 *  ① **局域网面**（默认 0.0.0.0:3110）—— 给手机用。提供：
 *       · 手机端页面（本包 web/ 目录里的静态文件）
 *       · 配对：一次性 code → 长期 token
 *       · SSE 事件流（`/api/events`）
 *       · RPC（`/api/rpc`）：列会话 / 看流式输出 / 发消息 / 中断
 *
 *  ② **同源面**（挂在官方 `webServer` 上，走 127.0.0.1:3105）—— 给电脑端插件界面用。
 *       浏览器半边要拿"当前二维码"，走同源路由就**没有跨域、也没有 CSP 问题**；
 *       二维码在**这一侧（Node）**用 vendor 的 MIT 库生成成 SVG，浏览器半边只负责显示。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三条刻意的设计决定（都有原因，不是随手写的）
 * ═══════════════════════════════════════════════════════════════════════════
 * 1. **不用 WebSocket，用 SSE + POST。**
 *    浏览器 `new WebSocket()` **无法设置请求头** ⇒ 想在握手时带
 *    `Authorization: Bearer …` 是做不到的（上一版就是这么死的：服务端要求握手带
 *    Bearer，手机永远连不上，被 close(4000) 踢掉）。
 *    EventSource 同样不能设头，但它**可以带查询参数**，所以 token 走 query；
 *    而 POST 用 fetch，**能**设 Authorization 头。
 *    ⇒ 两条路各用自己拿得到的鉴权方式，且**零依赖**（不用 ws 包）。
 *
 * 2. **零 npm 依赖。**
 *    本机实测 `profiles` 下**没有** jsonwebtoken、也没有 qrcode（上一版直接
 *    `import jwt from 'jsonwebtoken'` ⇒ 必然 ERR_MODULE_NOT_FOUND）。
 *    所以：token 用 `node:crypto` 生成**不透明随机串**存内存；二维码用 vendor 的
 *    `./qr.cjs`（MIT，见同目录 qr-LICENSE.txt）。
 *
 * 3. **token 只存内存、不落盘。**
 *    重启内核即全部失效、需要重新扫码。这是刻意的取舍：手机能远程操作电脑上的
 *    Agent，凭据落在磁盘上比"重启要重扫"危险得多。`SECRET` 同理，进程内随机。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 安全边界（诚实说明，别把它说成"安全的"）
 * ═══════════════════════════════════════════════════════════════════════════
 * · 服务监听 0.0.0.0 ⇒ **同一局域网内谁都能连到这个端口**。安全性完全靠：
 *   一次性码（60 秒、用过即废）+ 随机 token。
 * · **没有 TLS**：局域网内的流量是明文。配对码与 token 在局域网上可被嗅探。
 *   在家用 Wi-Fi 下可以接受；**不要在公共网络上开着它**。
 * · 配对成功后，该设备**拥有与电脑端同等的操作能力**（能发提示词、能中断）。
 *   本插件不做按设备的能力裁剪。
 */

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, statSync,
  createReadStream, createWriteStream, unlinkSync,
} from 'node:fs';
import { networkInterfaces } from 'node:os';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import qrcode from './qr.cjs';

/** 插件名（Cordis bundle tree 中的 id）。
 *  ★ 必须与 package.json 的 name 一致 —— loader 拿它当模块标识符 import。
 *  2026-09-22 由 dsh-int-mobile-remote 改名而来：那个名字在 npm 上已被占用。 */
export const name = 'dsh-int-mobile-remote';

/**
 * 运行参数。
 *
 * ⚠️ 刻意**不导出** `Config`：Cordis 会把导出的 `Config` 当作 **schemastery 校验模式**
 * 来解释（本机 dsh-api-* 那些官方包都是 `static Config: z<Config>` 的形状）。
 * 这里给一个普通对象会被当成非法模式，轻则配置读不到、重则插件加载失败。
 * 本插件没有需要用户配置的项，所以用模块内常量 + `apply(ctx, config)` 的可选覆盖即可。
 */
const Config = {
  /**
   * 局域网监听端口。
   * 默认 3110；可用环境变量 `DSH_MOBILE_REMOTE_PORT` 覆盖 ——
   * 这是给 `scripts/plugin-check-mobile-remote.js` 用的：验证脚本要在临时环境里
   * 起一个**不与真实环境抢端口**的实例（否则"验证"会去连用户正在跑的那个）。
   */
  port: Number(process.env.DSH_MOBILE_REMOTE_PORT) || 3110,
  /** 一次性配对码的有效期（毫秒）。 */
  codeTtlMs: 60_000,
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* 手机侧页面目录。2026-09-21 起本插件按"电脑侧 / 手机侧"分了层：
 *   desktop\  = 电脑侧（本文件 + client.js + qr.cjs）—— 进上传包、进 git
 *   phone\    = 手机侧（网页）—— 电脑侧运行时从这里**现读**文件发给手机
 * 为什么要分层：手机页不是打包时嵌进客户端的，而是宿主半边用 HTTP 现读现发，
 * 所以它必须随宿主一起被装到用户机器上 ⇒ 归在包内、由 `files` 白名单一起分发。
 * 改名时这里要跟着改（两处引用：serveStatic 与 MIME 映射的取值都在本文件）。 */
const PHONE_DIR = path.join(HERE, '..', 'phone');
/** 局域网服务的路由前缀。跟着包名一起改（2026-09-22）。
 *  ★ 手机页面**不碰**这个前缀（phone/app.js 走的是 /api/rpc、/api/events、
 *    /api/pair/submit），所以改它**不需要重新编译 APK**。 */
const ROUTE_PREFIX = '/dsh-int-mobile-remote';

/* ── 设备台账持久化（2026-09-22，用户需求："连接过之后能不能不要再断掉"）──────
 *
 * 现状与主诉：token 只存内存 ⇒ **重启内核（客户端重启/更新）就全部失效**，
 * 手机端 localStorage 里的 token 对不上号 ⇒ 401 ⇒ 每次都要重新扫码。用户嫌烦。
 *
 * 修法：把 devices 台账写到**插件自己的数据文件**里（`state.devices.json`，
 * 放在 DSH 插件数据目录），内核重启后 loadDevices() 读回来 ⇒ 手机端旧 token
 * 继续有效，**免重扫**。
 *
 * ── 与第 3 条设计决定的冲突与调和（诚实记录）────────────────────────
 * 文件头第 3 条原本写"token 只存内存、不落盘"是刻意的安全取舍。现在要落盘，
 * 风险面确实变宽了：拿到这个文件 = 拿到电脑上 Agent 的操作权。
 * 缓解：
 *   ① 文件权限跟随用户 profile（NTFS 下默认仅本用户可读，与 DSH 其它状态同档）；
 *   ② 内容只有"不透明 token → 设备名"，不含任何其他凭据；
 *   ③ revoke（"断开全部手机"）会**立刻清空并写盘** ⇒ 怀疑泄露时一键作废；
 *   ④ 存放位置在用户数据目录，**不进 git、不进上传包**。
 * 换来的收益（重启/更新后免重扫）对日常使用是决定性的。 */
const DEVICES_FILE = path.join(
  process.env.DSH_MOBILE_REMOTE_DATA || path.join(HERE, '..', '.devices'),
  'devices.json',
);

function saveDevices() {
  try {
    mkdirSync(path.dirname(DEVICES_FILE), { recursive: true });
    const obj = {};
    for (const [t, d] of state.devices) obj[t] = d;
    writeFileSync(DEVICES_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch { /* 写不进去就退回内存态（重启后要重扫），不炸插件 */ }
}

function loadDevices() {
  try {
    if (!existsSync(DEVICES_FILE)) return;
    const obj = JSON.parse(readFileSync(DEVICES_FILE, 'utf8'));
    // ★ 按设备名瘦身（2026-09-22 用户报告"电脑上不停计算很多设备，明明只扫了一台"）：
    //   旧版宿主在跑时，每次配对都会新增一条（去重逻辑是这轮才写的，没生效）⇒
    //   台账文件里已经积累了一堆同名的历史条目。加载时同名只保留**最近活跃**的那条，
    //   其余丢弃并回写 —— 界面上的"已配对 N 台"从此等于真实设备数。
    const byName = new Map();
    for (const [t, d] of Object.entries(obj || {})) {
      if (!t || !d || !d.deviceId) continue;
      const prev = byName.get(d.name);
      if (!prev || (d.lastSeen || 0) > (prev.entry.lastSeen || 0)) {
        if (prev) state.devices.delete(prev.token);
        byName.set(d.name, { token: t, entry: d });
        state.devices.set(t, d);
      }
    }
    if (byName.size !== Object.keys(obj || {}).length) saveDevices();   // 瘦过身就回写
  } catch { /* 坏文件当不存在 */ }
}

/* ══════════════════════════════════════════════════════════════════
 * 文件互传（2026-09-22 用户需求）
 * ══════════════════════════════════════════════════════════════════
 * 用户原话：「允许连接之后的手机和电脑DSH互传文件。这方便了一些跨端项目中，
 *   我可以随时下载电脑那边的文件。」
 *
 * ── 两个方向，两条完全不同的通路（为什么不能都用 RPC）──────────────
 * RPC（`/api/rpc`）是 **JSON 请求 / JSON 响应**：正文进内存、再 base64 编码。
 * 对"传文件"来说这是错的形状 ——
 *   · base64 让体积膨胀 4/3，一个 30 MB 的文件变成 40 MB 字符串；
 *   · 两端都要**整个装进内存**（手机端尤其致命，WebView 很容易被系统杀掉）；
 *   · 没有任何进度信息，用户只看到"卡住"。
 * 所以：
 *   · **电脑 → 手机**：RPC 只负责**发一张一次性票据**（`file.download`），
 *     真正的字节走 `GET /api/file/dl?t=<票据>` —— 那是一个**普通 URL**，
 *     于是手机端可以交给系统下载管理器 / 浏览器，**带原生进度、断点、通知栏**，
 *     而且完全不需要 WebView 参与。
 *   · **手机 → 电脑**：`POST /api/file/ul?...`，请求体就是**裸字节**，
 *     宿主 `pipeline()` 边收边落盘，**不在内存里堆积**。
 *
 * ── 为什么下载要"票据"而不是直接在 URL 里带路径 ──────────────────
 * 若 `GET /api/file/dl?path=C:\...` 直接收路径，那这个端点就成了
 * **"凭 token 读任意文件"** 的通用接口 —— 路径会进日志、进浏览器历史，
 * 且无法施加"必须先在手机上选过这个文件"这道闸。票据把能力收窄成：
 *   · 一次性（用过即焚）；
 *   · 短命（2 分钟）；
 *   · **绑定设备**（A 手机的票据 B 手机用不了）；
 *   · 由 `file.download` 在**校验过路径确实存在、且是普通文件**之后才签发。
 *
 * ── 落盘方向的安全边界（诚实说明）──────────────────────────────
 * 上传**只能写进"该会话工作区根目录"之内**（含子目录），
 * 且子目录参数会被规范化并校验前缀，`..` 逃逸一律拒绝。
 * 工作区之外**不写** —— 与"列目录"同一条边界（内核自己也只把 list 限制在工作区内）。
 * 文件名会清洗（去掉路径分隔符与控制字符），重名**不覆盖**，自动加 `-1`/`-2`。
 * ⚠️ 但要说清：上传的是**任意内容**，写进工作区就等于"给 Agent 送去了一个文件"。
 * 这是用户明确要的能力（跨端项目里互传），不是漏洞；但它的确让手机端
 * 获得了"能往电脑磁盘写字节"的能力，所以 token 的保密等级要按"等于电脑操作权"看。
 */

/** 一次性下载票据：ticket -> { path, name, bytes, deviceId, expiresAt } */
const DOWNLOAD_TTL_MS = 2 * 60_000;
/** 单次上传上限。1 GiB —— 比内核自己的 32 MiB 读上限宽松得多，
 *  因为这条路**不经过内核的文件服务**（是纯 HTTP 字节流），
 *  限制的理由只是"别让一个误操作把磁盘写满"，不是内存。 */
const UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;

/** 把文件名清洗成"能安全落在磁盘上"的样子（去掉分隔符/控制字符/保留名）。 */
function safeFileName(raw) {
  let n = String(raw || '').replace(/\\/g, '/').split('/').pop() || '';
  // eslint-disable-next-line no-control-regex
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  if (!n) n = 'file';
  if (n.length > 180) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 180 - ext.length) + ext;
  }
  // Windows 保留设备名
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(path.parse(n).name)) n = '_' + n;
  return n;
}

/** 重名不覆盖：`a.txt` -> `a-1.txt` -> `a-2.txt` …（最多试 999 次）。 */
function uniquePathIn(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; i < 1000 && existsSync(candidate); i++) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
  }
  return candidate;
}

/**
 * 取"该会话的工作区根目录"（上传的落点，也是相对路径的基准）。
 * 与 `file.read` 同款取值顺序（`agent.session.header.cwd` → `sandboxPolicy.workspaceRoot`）。
 */
function workspaceRootOf(ctx, sessionId) {
  const agent = agentOf(ctx, sessionId);
  let root = agent?.session?.header?.cwd;
  if (!root) {
    try { root = ctx.get('sandboxPolicy')?.workspaceRoot; } catch { /* 取不到就算了 */ }
  }
  return root ? path.resolve(String(root)) : '';
}

/* ══════════════════════════════════════════════════════════════════
 * 跨工作区（2026-09-22 用户需求）
 * ══════════════════════════════════════════════════════════════════
 * 用户原话：「我们的整个工作其实已经迁移到第2个工作区了，有没有办法让手机可以
 *   下载三个工作区的文件？以及向三个工作区发送文件。」
 *
 * ── 为什么这件事**能**做，而且是官方设计允许的（不是我们绕过限制）────────
 * 关键在 `WorkspaceFileScope` 这个参数：它是 `{ sessionId, workspaceRoot }`，
 * 而 `workspaceRoot` 是**调用方给的**（`dsh-api-workspace-files/lib/index.js:555`）。
 * 所有方法的"工作区边界"都是拿**这个字段**去 confine 的：
 *   · `inspect`   ：`const root = await this.ctx.fs.resolve(workspaceRoot)`
 *   · `confine`   ：`if (!this.ctx.fs.contains(root, target)) throw outside-workspace`
 *   · `list` 用 confine、`readAll`/`stat`/`read` 用 locateFile → 同一把尺子
 * ⇒ 换一个 `workspaceRoot`，就换了一个工作区；**边界仍然由内核强制执行**，
 *   我们并没有拿到"任意读盘"的能力（下面第 2 条把可选项钉死）。
 *
 * ── 我们**额外**加的那道闸（比内核更严，这是刻意的）──────────────────
 * 手机端可以传一个 `root`，但**必须命中"已注册工作区"**才受理 ——
 * 依据是官方工作区注册表（`ctx.workspaceController` 的 baseline，
 * 与 `workspace.list` 同一个来源，已被手机端"新建会话"用了很久）。
 * 也就是说：手机能在**三个工作区**之间自由浏览/互传，
 * 但**不能**指定 `C:\Windows`、`%USERPROFILE%\.dsh`（A 环境）之类的任意目录。
 * ⚠️ 这条闸是**本插件自己**加的，不是内核的：内核那边给什么 root 就 confine 到哪，
 *   所以这道校验绝不能删（删了就等于"凭 token 读整台机器"）。
 */

/** 已注册工作区的绝对路径（规范化后的）。取不到就返回空表 ⇒ 调用方只允许本会话工作区。 */
async function registeredWorkspaceRoots(ctx) {
  let wctrl;
  try { wctrl = ctx.get('workspaceController'); } catch { wctrl = null; }
  if (!wctrl || typeof wctrl.follow !== 'function') return [];
  const out = [];
  const ac = new AbortController();
  try {
    // follow 的第一帧是完整 baseline，拿到就能停（与 workspace.list 同一手法）
    for await (const frame of wctrl.follow(ac.signal)) {
      if (frame && frame.type === 'baseline') {
        for (const w of (frame.value?.items || [])) {
          if (w && w.path) out.push(path.resolve(String(w.path)));
        }
        break;
      }
    }
  } catch { /* 读不到就当没有 */ }
  try { ac.abort(); } catch { }
  return out;
}

/** Windows 路径比较不分大小写；这里统一用小写做键。 */
function samePath(a, b) {
  const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * 决定这次操作"作用在哪个工作区根"，并**校验它确实是一个已注册工作区**。
 *
 * @returns `{ ok: true, root, isOther }` 或 `{ ok: false, reason }`
 *   `isOther` = 用户选的不是当前会话自己的工作区（前端据此提示）。
 */
async function resolveTargetRoot(ctx, sessionId, requestedRoot) {
  const own = workspaceRootOf(ctx, sessionId);
  if (!requestedRoot) {
    return own ? { ok: true, root: own, isOther: false } : { ok: false, reason: '拿不到该会话的工作区根目录' };
  }
  const want = path.resolve(String(requestedRoot));
  // ① 是当前会话自己的工作区 ⇒ 直接放行（哪怕注册表里读不到，它是会话的既定根）
  if (own && samePath(want, own)) return { ok: true, root: want, isOther: false };
  // ② 否则必须是**已注册工作区**
  const roots = await registeredWorkspaceRoots(ctx);
  const hit = roots.find((r) => samePath(r, want));
  if (!hit) {
    return {
      ok: false,
      reason: '只能访问已注册的工作区（' + want + ' 不在工作区列表里）',
    };
  }
  return { ok: true, root: hit, isOther: true };
}

/**
 * 把"相对工作区的子目录"解析成绝对路径，并**校验没有逃出工作区**。
 * 返回 `{ ok: true, dir }` 或 `{ ok: false, reason }`。
 */
function resolveSubdir(root, rawSub) {
  if (!root) return { ok: false, reason: '拿不到该会话的工作区根目录' };
  const sub = String(rawSub || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const dir = path.resolve(root, sub);
  // ★ 前缀校验必须带分隔符：否则 `D:\work-evil` 会被判成在 `D:\work` 之内
  const normRoot = root.endsWith(path.sep) ? root : root + path.sep;
  if (dir !== root && !dir.startsWith(normRoot)) {
    return { ok: false, reason: '只能传到工作区之内（拒绝越出：' + sub + '）' };
  }
  return { ok: true, dir };
}

/** 生成 Content-Disposition（含非 ASCII 文件名的 RFC 5987 形态）。 */
function contentDisposition(name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/* ══════════════════════════════════════════════════════════════════
 * 小工具
 * ══════════════════════════════════════════════════════════════════ */

/** 生成人类可读的一次性码（去掉容易看错的 0/O/1/I）。 */
function makeCode(len = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

/** 生成不透明 token（256 bit）。 */
function makeToken() {
  return randomBytes(32).toString('base64url');
}

/** 定长比较，避免用 `===` 比 token 带来的时序差异。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 找一个**局域网可达**的 IPv4 地址，按"手机最可能连得上"排序。
 *
 * ══════════════════════════════════════════════════════════════════
 * 用户报的问题与真因（2026-09-21 实测复现）
 * ══════════════════════════════════════════════════════════════════
 * 「有时候电脑连手机热点反而无法扫描连接上，然后两个连同一个 WiFi 反而还能连接上。」
 *
 * **真因不是"热点不通"，而是二维码里编了错的地址。** 两个独立原因：
 *
 * ① **同属私网段的地址是平局，谁先枚举到就选谁。**
 *    旧判据只有一条：是不是私网（192.168./10./172.16-31.）。
 *    可热点一开，Windows 的 **Wi-Fi Direct 虚拟网卡**（`本地连接* 1`）就会拿到
 *    `192.168.137.1` —— 它**也是私网**，于是和 WLAN 的真实地址打成平局，
 *    `Array.prototype.sort` 对 0 不保序 ⇒ 结果取决于 `networkInterfaces()` 的枚举顺序。
 *    实测复现（同一组地址、只换枚举顺序）：
 *      A: WLAN 在前 → 选中 192.168.43.5 (WLAN)        ✅ 对
 *      B: 本地连接* 1 在前 → 选中 192.168.137.1        ❌ 手机连不上（那是电脑自己的热点网关）
 *    ⇒ 表现就是"有时能用、有时不能"，且**跟手机怎么连没关系**。
 *
 * ② **Clash / Meta 之类的 TUN 虚拟网卡会带一个非私网地址（本机是 198.18.0.1）。**
 *    它不属于私网段，所以排最后 —— 但**没有真正排除**，一旦机器上只有它就中招。
 *    而且它**抢默认路由**（本机 `0.0.0.0/0` 的 metric=0 指向 Meta 隧道），
 *    这正是"电脑连手机热点时反而连不上"的另一半原因：
 *    流量被 TUN 接管，局域网内也不通。
 *
 * ══════════════════════════════════════════════════════════════════
 * 现在的判据（按优先级逐条打分，分数越高越优先）
 * ══════════════════════════════════════════════════════════════════
 *   · **接口名是虚拟网卡** ⇒ 直接排除（Wi-Fi Direct / TUN / VPN / WAN Miniport…）
 *   · 私网段 ⇒ +100；`192.168.137.*`（Windows 热点的固定网关，**绝不该给手机**）⇒ -1000
 *   · 接口是 Up 且连着 ⇒ +50
 *   · 接口名看起来像真网卡（WLAN / Wi-Fi / 以太网 / Ethernet…）⇒ +20
 *   · 名字是 `本地连接*`（Windows 对虚拟适配器的默认命名）⇒ -200
 *
 * ★ 为什么用 `os.networkInterfaces()` 的**接口名**当判据：
 *   它是零依赖能拿到的唯一信号。Node 不给适配器描述，也不给 metric；
 *   要拿那些必须起子进程查 WMI，而本插件的前提是"零 npm 依赖、启动即用"。
 *   接口名足以区分"真网卡 vs 虚拟网卡"，实测本机 16 个适配器全部区分正确。
 */
function lanAddresses() {
  const out = [];
  const ifaces = networkInterfaces();

  // 虚拟/隧道网卡的接口名特征（不区分大小写）
  const VIRTUAL = [
    /^本地连接\s*\*/,            // Windows 给虚拟适配器的默认名（Wi-Fi Direct / WAN Miniport…）
    /wi-?fi\s*direct/i,
    /tunnel/i, /teredo/i, /6to4/i, /isatap/i,
    /\btun\b/i, /\btap\b/i, /wintun/i, /wireguard/i, /openvpn/i, /anyconnect/i,
    /hyper-?v/i, /vmware/i, /virtualbox/i, /vethernet/i, /docker/i, /loopback/i,
    /bluetooth/i, /\bpseudo\b/i, /miniport/i,
  ];
  const isVirtualName = (n) => VIRTUAL.some((re) => re.test(n));

  // 看起来像"真网卡"的名字（加分项）
  const REAL_NAME = [/wi-?fi/i, /wlan/i, /wireless/i, /ethernet/i, /以太网/, /无线/, /^eth\d/i, /^en\d/i, /^wlan\d/i];

  const priv = (ip) =>
    ip.startsWith('192.168.') || ip.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

  /** Windows 移动热点（ICS）固定用 192.168.137.0/24 —— 那是**电脑自己**的网关地址，
   *  手机连上后要访问的是电脑在**另一个**网络里的地址，所以绝不能把它编进二维码。 */
  const isWindowsHotspotGw = (ip) => ip.startsWith('192.168.137.');

  /**
   * RFC 2544 基准测试网段 `198.18.0.0/15` —— **实测** Clash / mihomo 之类代理工具的
   * TUN 虚拟网卡就用它（本机 Meta Tunnel = `198.18.0.1`）。
   * 这个网段是保留做基准测试的，**永远不会**是真实局域网地址，
   * 手机绝无可能连上 ⇒ 直接排除。
   *
   * ★ 为什么不能只靠"接口名"排除：本机那个适配器的接口名就叫 **`Meta`**
   *   —— 不含 tun/vpn/pseudo 任何关键词（实测：只靠名字判据会把它漏过去，
   *   探针第 ④ 条因此 FAIL）。所以这里**按地址段**兜一层，跟名字判据互补。
   */
  const isBenchmarkRange = (ip) => {
    const m = /^198\.(\d+)\./.exec(ip);
    if (!m) return false;
    const second = Number(m[1]);          // 198.18.x.x 或 198.19.x.x
    return second === 18 || second === 19;
  };

  for (const [ifName, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.internal) continue;
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      const ip = String(a.address);
      if (ip.startsWith('169.254.')) continue;        // APIPA：DHCP 失败，手机连不上
      if (isVirtualName(ifName)) continue;            // ★ 虚拟网卡：直接排除
      if (isBenchmarkRange(ip)) continue;             // ★ Clash 等 TUN 的 198.18/15

      let score = 0;
      if (priv(ip)) score += 100;
      if (isWindowsHotspotGw(ip)) score -= 1000;      // ★ 热点网关：几乎必然不是它
      if (REAL_NAME.some((re) => re.test(ifName))) score += 20;
      if (!priv(ip)) score -= 50;                     // 非私网段
      out.push({ ifName, address: ip, score });
    }
  }

  // ★ 分数相同时用**接口名**再做一次稳定比较 —— 不能让枚举顺序决定结果
  //   （旧版就是栽在这里：平局 = 听天由命，同一台机器两次启动可能给出不同地址）
  out.sort((x, y) => (y.score - x.score) || x.ifName.localeCompare(y.ifName));
  return out;
}

/** 把 QR 编成 SVG 字符串。★ 必须显式切 UTF-8，见下面注释。 */
function qrSvg(text) {
  // ★ 这个库的**默认** stringToBytes 是 Latin-1（`charCodeAt(i) & 0xff`），
  //   非 ASCII 会被静默截断、产出一个内容错掉的二维码且**不报错**。
  //   实测证据：scripts/qr-check.js 第一轮，中文那条解出来是空串。
  //   配对 URL 本身是 ASCII，但把这个地雷钉死成本极低。
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  const qr = qrcode(0, 'M'); // 0 = 自动选最小够用的版本号
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 20, alt: '手机遥控配对二维码' });
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req, limitBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > limitBytes) throw new Error('请求体过大');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/* ══════════════════════════════════════════════════════════════════
 * 状态（全部进程内）
 * ══════════════════════════════════════════════════════════════════ */

const state = {
  /** 当前一次性码：{ code, expiresAt } */
  code: null,
  /** 已配对设备：token -> { deviceId, name, pairedAt, lastSeen } */
  devices: new Map(),
  /** 每个设备的 SSE 连接：deviceId -> Set<res> */
  streams: new Map(),
  /** 每个设备正在跟随的会话：deviceId -> Map<sessionId, { abort }> */
  watchers: new Map(),
  /** 正在等手机回答的审批：id -> { resolve, timer, sessionId } */
  pendingApprovals: new Map(),
  /** 一次性下载票据：ticket -> { path, name, bytes, deviceId, expiresAt } */
  tickets: new Map(),
  /** 由 installApprovalBridge 填上：手机回答审批时回调 */
  resolveApproval: null,
  /** 诊断（供 plugin-check 读取，也供"看不见"时定位） */
  diagnostics: { errors: [], listens: [], pairs: 0, prompts: 0, cancels: 0, approvals: 0, rpc: {}, transfers: [] },
};

function currentCode() {
  const now = Date.now();
  if (state.code && now < state.code.expiresAt) return state.code;
  state.code = { code: makeCode(8), expiresAt: now + Config.codeTtlMs };
  return state.code;
}

function publicState(ctx) {
  const addrs = lanAddresses();
  const ip = addrs.length ? addrs[0].address : null;
  const c = currentCode();
  const url = ip ? `http://${ip}:${Config.port}/pair?c=${c.code}` : null;

  // 装了 Android 壳 App 的人扫这个：自定义 scheme，扫到直接唤起 App。
  // `u` 是编码后的真实 http 地址 —— App 里再解出来加载。
  // 为什么要两个码：http 那个**任何手机相机都能用**（没装 App 也能开浏览器），
  // 而这个只有装了 App 才有效。两个都给，用户不用做选择。
  const appUrl = url ? `dshmr://pair?u=${encodeURIComponent(url)}` : null;

  const svgOf = (text) => {
    if (!text) return null;
    try { return qrSvg(text); } catch (e) { state.diagnostics.errors.push('qr: ' + (e?.message || e)); return null; }
  };

  return {
    port: Config.port,
    addresses: addrs,
    ip,
    url,
    appUrl,
    code: c.code,
    expiresIn: Math.max(0, c.expiresAt - Date.now()),
    ttlMs: Config.codeTtlMs,
    qrSvg: svgOf(url),
    qrSvgApp: svgOf(appUrl),
    /** 备选地址：首选连不上时可以换一个（界面上做成可点）。
     *  为什么要给：本机同时有 WLAN 与 TUN 虚拟网卡时，"哪个地址手机真能连上"
     *  只有试过才知道 —— 与其让用户干瞪眼，不如把备选直接摆出来。
     *  见 lanAddresses() 的注释（旧版就因为平局时听天由命而"有时能连有时不能"）。 */
    alternates: addrs.slice(1).map((a) => ({
      ip: a.address, ifName: a.ifName, url: `http://${a.address}:${Config.port}/pair?c=${c.code}`,
    })),
    paired: state.devices.size,
    devices: [...state.devices.values()].map((d) => ({ name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen })),
    errors: state.diagnostics.errors.slice(-5),
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 会话能力：把 ctx 上的官方服务包成手机能用的几个动作
 * ══════════════════════════════════════════════════════════════════ */

function sessionCtrl(ctx) {
  try { return ctx.get('sessionController') || null; } catch { return null; }
}

/**
 * 由 sessionId 取到**活的 Agent**（不是冷快照）。
 *
 * 为什么需要它：权限预设、命令目录这两个官方服务都是**按 agent 作用域**的
 * （`commands.list(agent)`、`permissionPresets.set(session, name)`），
 * 而手机端只有 sessionId。官方 agent 服务（`ctx.agents`）的 `get(id)` 正好
 * 接受 sessionId 并返回活 Agent（`dsh-api-session-controller/lib/index.js:1060`
 * 就是这么用的：`this.ctx.agents.get(session.id)`）。
 * 拿不到就返回 null，调用方**如实报"不可用"**，不编造。
 */
function agentOf(ctx, sessionId) {
  if (!sessionId) return null;
  try {
    const agents = ctx.get('agents');
    if (!agents || typeof agents.get !== 'function') return null;
    return agents.get(sessionId) || null;
  } catch { return null; }
}

/** 把一次 follow 的帧推给某个设备的 SSE。 */
async function pumpFollow(ctx, deviceId, sessionId, signal) {
  const ctrl = sessionCtrl(ctx);
  if (!ctrl) throw new Error('sessionController 不可用');
  const iterable = ctrl.follow(
    { address: { kind: 'session', sessionId }, maxMessages: 40, assistantStream: true },
    signal,
  );
  for await (const frame of iterable) {
    if (signal.aborted) break;
    pushEvent(deviceId, 'session', { sessionId, frame });
  }
}

function pushEvent(deviceId, event, data) {
  const set = state.streams.get(deviceId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch { /* 连接断了，close 事件会清理 */ }
  }
}

/** RPC 方法表。手机只能调到这里列出的动作。 */
function rpcMethods(ctx) {
  return {
    async 'session.list'() {
      const ctrl = sessionCtrl(ctx);
      if (!ctrl) throw new Error('sessionController 不可用');
      const ac = new AbortController();
      const value = await ctrl.list({}, ac.signal);
      return value;
    },

    /** 工作区列表（手机端"新建会话"要选一个）。 */
    async 'workspace.list'() {
      let wctrl;
      try { wctrl = ctx.get('workspaceController'); } catch { wctrl = null; }
      if (!wctrl) return { items: [] };
      const ac = new AbortController();
      const items = [];
      // follow 的第一帧是完整 baseline，拿到就能停 —— 不需要长订阅
      for await (const frame of wctrl.follow(ac.signal)) {
        if (frame && frame.type === 'baseline') {
          for (const w of (frame.value?.items || [])) {
            items.push({
              workspaceId: w.workspaceId,
              title: w.title,
              path: w.path,
              sessionIds: w.sessionIds || [],
            });
          }
          break;
        }
      }
      ac.abort();
      return { items };
    },

    /** 模型目录（手机端"切模型"要用）。 */
    async 'modelCatalog'() {
      const ctrl = sessionCtrl(ctx);
      if (!ctrl) throw new Error('sessionController 不可用');
      return await ctrl.modelCatalog();
    },

    /** 切换某个会话的模型 / 思考强度。 */
    async 'session.selectModel'(deviceId, params) {
      const ctrl = sessionCtrl(ctx);
      if (!ctrl) throw new Error('sessionController 不可用');
      const { sessionId, provider, model, reasoningEffort } = params || {};
      if (!sessionId || !provider || !model) throw new Error('缺少 sessionId / provider / model');
      const req = { sessionId, provider, model };
      if (reasoningEffort) req.reasoningEffort = reasoningEffort;
      return await ctrl.selectModel(req);
    },

    /** 重命名会话（手机上改标题）。 */
    async 'session.rename'(deviceId, params) {
      const ctrl = sessionCtrl(ctx);
      if (!ctrl) throw new Error('sessionController 不可用');
      const { sessionId, title } = params || {};
      if (!sessionId || !title) throw new Error('缺少 sessionId / title');
      return await ctrl.rename({ sessionId, title });
    },

    /**
     * 批量读会话**标题**（会话列表要显示"人看得懂的名字"，而不是一串 sessionId）。
     *
     * 标题是日志里 `session/title` 事件折叠出来的，用 `page` 从尾部翻一页、
     * 从后往前找最后一条即可 —— 比给每个会话开 `follow` 长订阅便宜得多，
     * 而会话列表一次要读几十个。单个读不到不拖垮整批。
     */
    async 'session.titles'(deviceId, params) {
      const ctrl = sessionCtrl(ctx);
      if (!ctrl) throw new Error('sessionController 不可用');
      const ids = Array.isArray(params?.sessionIds) ? params.sessionIds.slice(0, 60) : [];
      const titles = {};
      for (const sessionId of ids) {
        try {
          const ac = new AbortController();
          const page = await ctrl.page({
            address: { kind: 'session', sessionId },
            throughSeq: Number.MAX_SAFE_INTEGER,
            maxMessages: 60,
          }, ac.signal);
          const records = (page && page.records) || [];
          for (let i = records.length - 1; i >= 0; i--) {
            const ev = records[i] && records[i].event;
            if (ev && ev.type === 'session/title' && ev.data && ev.data.title) {
              titles[sessionId] = ev.data.title;
              break;
            }
          }
        } catch { /* 单个失败不影响其它 */ }
      }
      return { titles };
    },

    /**
     * 新建会话。
     *
     * 加它不只是为了手机端好用（手机上确实需要"开一个新会话"），
     * 也是为了让 `scripts/plugin-check-mobile-remote.js` 能**真的走完**发消息/中断：
     * 那需要先有一个会话，而"往用户正在用的会话里发测试提示词"是绝不能做的事。
     */
    async 'session.create'(deviceId, params) {
      const ctrl = sessionCtrl(ctx);
      if (!ctrl) throw new Error('sessionController 不可用');
      const req = {};
      if (params?.workspaceId) req.workspaceId = params.workspaceId;
      if (params?.cwd) req.cwd = params.cwd;
      if (params?.agentPreset) req.agentPreset = params.agentPreset;
      return await ctrl.create(req);
    },

    async 'session.watch'(deviceId, params) {
      const sessionId = params?.sessionId;
      if (!sessionId) throw new Error('缺少 sessionId');
      // 一个设备同一时刻只跟随一个会话：先停掉上一个，避免事件流互相串
      const per = state.watchers.get(deviceId) || new Map();
      for (const [, w] of per) { try { w.abort.abort(); } catch { } }
      per.clear();
      const abort = new AbortController();
      per.set(sessionId, { abort });
      state.watchers.set(deviceId, per);
      // 不 await：这是一个持续到取消/断连为止的流
      pumpFollow(ctx, deviceId, sessionId, abort.signal).catch((e) => {
        pushEvent(deviceId, 'error', { sessionId, message: e?.message || String(e) });
      });
      return { watching: sessionId };
    },

    async 'session.unwatch'(deviceId) {
      const per = state.watchers.get(deviceId);
      if (per) { for (const [, w] of per) { try { w.abort.abort(); } catch { } } per.clear(); }
      return { ok: true };
    },

    /**
     * 发提示词。支持**文字 + 图片**。
     *
     * 图片走 `PromptContentPart` 的 `image` 分支（`{type:'image', mediaType, data, name}`）——
     * 官方类型里明写 "the Host promotes image bytes to durable references"，
     * 也就是**宿主自己会把 base64 提升成持久附件**，手机端不需要先拿上传凭据。
     * 这比 `file` 分支（要 `receiptId`、必须先 upload）省一整步，手机端也更简单。
     */
    async 'session.prompt'(deviceId, params) {
      const ctrl = sessionCtrl(ctx);
      if (!ctrl) throw new Error('sessionController 不可用');
      const sessionId = params?.sessionId;
      const text = params?.text;
      if (!sessionId) throw new Error('缺少 sessionId');

      const content = [];
      if (typeof text === 'string' && text.trim()) content.push({ type: 'text', text });

      // 图片：[{ mediaType, data(base64，不带 data: 前缀), name }]
      const images = Array.isArray(params?.images) ? params.images.slice(0, 6) : [];
      for (const img of images) {
        const mediaType = String(img?.mediaType || '');
        const data = String(img?.data || '');
        if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(mediaType)) throw new Error(`不支持的图片类型：${mediaType}`);
        if (!data) throw new Error('图片数据为空');
        const part = { type: 'image', mediaType, data };
        if (img?.name) part.name = String(img.name).slice(0, 120);
        content.push(part);
      }

      if (!content.length) throw new Error('提示词为空');

      const ac = new AbortController();
      const value = await ctrl.prompt({
        requestId: 'mmr-' + randomBytes(12).toString('hex'),
        sessionId,
        mode: 'queue',
        content,
      }, ac.signal);
      state.diagnostics.prompts++;
      return value;
    },

    /** 手机回答一个审批请求。 */
    async 'approval.answer'(deviceId, params) {
      const id = params?.id;
      if (!id) throw new Error('缺少审批 id');
      const ok = typeof state.resolveApproval === 'function'
        ? state.resolveApproval(id, params?.approve === true)
        : false;
      if (!ok) throw new Error('这条审批已经失效（可能已被电脑端处理或已超时）');
      state.diagnostics.approvals++;
      return { answered: params?.approve === true ? 'allowed-once' : 'rejected' };
    },

    async 'session.cancel'(deviceId, params) {
      const ctrl = sessionCtrl(ctx);
      if (!ctrl) throw new Error('sessionController 不可用');
      const sessionId = params?.sessionId;
      if (!sessionId) throw new Error('缺少 sessionId');
      const value = await ctrl.cancel({ sessionId });
      state.diagnostics.cancels++;
      return value;
    },

    /* ══════════════════════════════════════════════════════════════
     * 权限预设（2026-09-22 用户需求："＋ 里要包含权限选择"）
     * ══════════════════════════════════════════════════════════════
     * 用官方 `dsh-permission-presets` 服务，**不自己造一套**：
     *   · 读：`permissionPresets` 的 session 投影（`permissions`）已经算好
     *         options/currentValue（`dsh-permission-presets/lib/index.js:138-151, 230-236`）；
     *   · 写：`permissionPresets.set(session, name)`（同文件 274-278 行）——
     *         它会 append `permission/preset` 事件，并按需调 sandbox / approval 的
     *         **规范 setter**，与电脑端 `/permission` 命令走**同一条路**
     *         （命令处理器见同文件 156-180 行）。
     * 为什么要走官方 setter 而不是自己写事件：沙箱模式与审批策略各有自己的
     * 折叠与执行侧，绕过去会出现"界面显示改了、实际没生效"。
     *
     * ★ 安全边界（必须说清）：这里改的是**该会话**的权限，等于允许手机端把
     *   某个会话提到 danger-full-access。手机本来就已具备"发提示词 / 批审批"的
     *   同等能力（见文件头"安全边界"），所以这没有扩大攻击面；但要在界面上
     *   把 danger 那一档标红，别让人误点。
     */
    async 'permission.list'(deviceId, params) {
      const sessionId = params?.sessionId;
      if (!sessionId) throw new Error('缺少 sessionId');
      const svc = ctx.get('permissionPresets');
      if (!svc) throw new Error('这个客户端没有启用权限预设（permissionPresets 服务缺失）');
      const agent = agentOf(ctx, sessionId);
      if (!agent) throw new Error('会话不在运行（拿不到活 Agent）');
      // 用投影快照取"界面该显示什么"：options 已按声明顺序排好，currentValue 是推导值
      const snap = ctx.get('sessionProjections')?.snapshot?.(agent.session, ['permissions']);
      const view = snap?.values?.permissions;
      if (view) return { options: view.options, current: view.currentValue };
      // 投影拿不到就退回自己拼（至少名字与当前值要对）
      return {
        options: svc.names.map((n) => ({ value: n, name: svc.presets?.[n]?.name || n })),
        current: svc.current(agent.session),
      };
    },

    async 'permission.set'(deviceId, params) {
      const sessionId = params?.sessionId;
      const preset = String(params?.preset || '').trim();
      if (!sessionId || !preset) throw new Error('缺少 sessionId / preset');
      const svc = ctx.get('permissionPresets');
      if (!svc) throw new Error('这个客户端没有启用权限预设');
      const agent = agentOf(ctx, sessionId);
      if (!agent) throw new Error('会话不在运行（拿不到活 Agent）');
      if (!svc.names.includes(preset)) throw new Error(`没有这个权限档：${preset}`);
      svc.set(agent.session, preset);
      return { preset, current: svc.current(agent.session) };
    },

    /* ══════════════════════════════════════════════════════════════
     * 上下文容量（用户需求："加一个上下文容量显示"）
     * ══════════════════════════════════════════════════════════════
     * 数据来自官方 `dsh-token-meter` 注册的 `contextPressure` 投影
     * （`dsh-token-meter/lib/index.js:470-515`）：
     *   · contextWindow   —— 当前路由的窗口大小（来自 request/context 事件）
     *   · pressureTokens  —— 提供方报告的最新提示词规模
     *   · projectedTokens —— 下一个请求的提示词预计占多少
     * 官方前端显示的就是 `usedTokens / contextWindow`（`dsh-client-ui-conversation/
     * lib/client.js:15330-15334` 的算法：percent = round(used / window * 100)）。
     * 这里照抄同一算法，手机端显示的数字与电脑端**同源**，不是另算一套。 */
    async 'context.usage'(deviceId, params) {
      const sessionId = params?.sessionId;
      if (!sessionId) throw new Error('缺少 sessionId');
      const agent = agentOf(ctx, sessionId);
      if (!agent) throw new Error('会话不在运行（拿不到活 Agent）');
      const svc = ctx.get('sessionProjections');
      if (!svc || typeof svc.snapshot !== 'function') throw new Error('这个客户端没有上下文投影');
      const snap = svc.snapshot(agent.session, ['contextPressure', 'tokenUsage']);
      const p = (snap && snap.values && snap.values.contextPressure) || {};
      const u = (snap && snap.values && snap.values.tokenUsage) || {};
      const used = typeof p.pressureTokens === 'number' ? p.pressureTokens : null;
      const win = typeof p.contextWindow === 'number' ? p.contextWindow : null;
      return {
        usedTokens: used,
        contextWindow: win,
        projectedTokens: typeof p.projectedTokens === 'number' ? p.projectedTokens : null,
        percent: (used != null && win) ? Math.min(100, Math.round((used / win) * 100)) : null,
        // 累计计费口径（可选显示）：本轮会话的输入/输出总量
        totals: u.totals || null,
      };
    },

    /* ══════════════════════════════════════════════════════════════
     * 指令目录（用户需求："指令选择"）
     * ══════════════════════════════════════════════════════════════
     * 官方 `commands` 服务就是"人可用的斜杠命令"注册表
     * （`dsh-commands/lib/index.js:196-201` 类注释、`list(agent)` 在 278-280 行）。
     * 注意它是**按 agent 作用域**的：per-agent 变体会遮蔽全局同名命令，
     * 所以必须传活的 agent，不能拿 sessionId 糊弄。
     * 手机端只做"列出 + 填进输入框"，执行交给内核的正常发送路径
     * （手机把 `/name args` 当普通文本发出去，内核自己会解析成命令 ——
     * 这是官方行为，不需要手机端另开执行通道）。 */
    async 'command.list'(deviceId, params) {
      const sessionId = params?.sessionId;
      if (!sessionId) throw new Error('缺少 sessionId');
      const svc = ctx.get('commands');
      if (!svc || typeof svc.list !== 'function') throw new Error('这个客户端没有命令注册表');
      const agent = agentOf(ctx, sessionId);
      if (!agent) throw new Error('会话不在运行（拿不到活 Agent）');
      const list = svc.list(agent) || [];
      return {
        items: list.map((c) => ({
          name: String(c.name || ''),
          description: String(c.description || ''),
          takesInput: !!c.input,
          hint: c.input?.hint ? String(c.input.hint) : '',
          acceptsAttachments: c.input?.attachments === true,
        })).filter((c) => c.name),
      };
    },

    /* ══════════════════════════════════════════════════════════════
     * 电脑文件浏览（用户需求："文件选择，不知道能不能在手机上选电脑的文件夹"）
     * ══════════════════════════════════════════════════════════════
     * **能选**，而且走官方服务，不自己扫盘：
     * `ctx.get('sessionFileReferences').list(agent, query, signal)`
     *   （服务名见 `dsh-api-session-controller/lib/index.js:1710`；
     *     provider 是 `dsh-file-reference-local`，工作区根取自
     *     `agent.session.header.cwd`（同包 384-391 行））
     *
     * ★ query 的语义（这是本功能能"逐层浏览"的关键，来自实现 77-88 行）：
     *   · `""` 或 **以 `/` 结尾** ⇒ 只列**那一层**目录的条目（非递归，`listDirectory`）
     *   · 不含 `/` 的普通串   ⇒ 全工作区模糊搜索（会递归、有条数上限）
     *   所以手机端"进文件夹"= 把该目录名 + `/` 当 query 再问一次。
     *
     * ★ 返回的是**相对工作区根**的路径（`scanWorkspace` 里的 `relative`，148-181 行），
     *   正合 `@` 提及语法 —— 提及本来就是相对工作区根的（见官方 FILE_REFERENCE_PROMPT）。
     *
     * ★ 安全边界：只能看到**该工作区之内**的东西（provider/内核自己限定 root），
     *   手机拿不到工作区外的路径；且这是**只读列举**，不读文件内容。
     *   手机要"选文件"最终是往输入框里插一段 `@路径`，内容由内核按正常流程处理。
     *
     * ★★ 2026-09-22 扩展：支持**跨工作区**浏览（用户："让手机可以下载三个工作区的文件"）。
     *   传 `root` 指定目标工作区；不传就是当前会话自己的那个（老行为不变）。
     *   ★ 两条路走的是**两个不同的服务**，原因必须说清：
     *     · 本会话工作区 ⇒ `sessionFileReferences.list(agent, query)`。它按 agent 缓存索引、
     *       支持模糊搜索、且**排除** `.git`/`node_modules`/`dist` 等（见
     *       `dsh-file-reference-local/lib/index.js:30-46`），手机上看一眼更干净。
     *     · **别的工作区** ⇒ `workspaceFiles.list(scope, path)`。因为上面那个服务把索引
     *       **钉死在 `agent.session.header.cwd`**（同文件 387 行：`new WorkspaceFileSearch(
     *       agent.session.header.cwd ?? process.cwd(), …)`），没有换根的口子；
     *       而 `workspaceFiles` 的边界就是参数里的 `workspaceRoot` ⇒ 换根即换工作区。
     *   两条路的返回都被归一成同一种 `{path,name,kind,mention}`，手机端不必分情况。 */
    async 'file.list'(deviceId, params) {
      const sessionId = params?.sessionId;
      if (!sessionId) throw new Error('缺少 sessionId');
      const agent = agentOf(ctx, sessionId);
      if (!agent) throw new Error('会话不在运行（拿不到活 Agent）');

      // 目标工作区（不传 = 本会话自己的）
      const tr = await resolveTargetRoot(ctx, sessionId, params?.root);
      if (!tr.ok) throw new Error(tr.reason);

      // 规整成"列某一层目录"的相对路径（见上面 ★ query 语义）
      const raw = String(params?.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
      const rel = raw.replace(/\/+$/, '');          // 不带尾斜杠的相对路径（可为空串=根）

      // 上一级：去掉最后一段。已经在根 ⇒ 空串（前端据此禁用"上一级"）
      let parent = '';
      if (rel) {
        const parts = rel.split('/');
        parts.pop();
        parent = parts.join('/');
      }

      const ac = new AbortController();
      let items = [];
      let truncated = false;

      if (!tr.isOther) {
        // ── 本会话工作区：走官方文件引用服务（带排除表 + 模糊搜索）──
        const svc = ctx.get('sessionFileReferences');
        if (!svc || typeof svc.list !== 'function') throw new Error('这个客户端没有文件引用服务');
        const query = rel ? rel + '/' : '';
        try {
          items = await svc.list(agent, query, ac.signal);
        } catch (e) {
          throw new Error('列目录失败：' + (e?.message || e));
        }
      } else {
        // ── 别的工作区：走 workspaceFiles.list（边界 = 我们传的 workspaceRoot）──
        const wf = ctx.get('workspaceFiles');
        if (!wf || typeof wf.list !== 'function') throw new Error('这个客户端不支持跨工作区浏览');
        const scope = { sessionId, workspaceRoot: tr.root };
        let r;
        try {
          /* ★ 空串要换成 "."（2026-09-22 实测踩到）。
           *   内核的 `inspect` 第一行就是 `if (path.length === 0) throw
           *   "path is required"`（`dsh-api-workspace-files/lib/index.js:554`）——
           *   也就是说这条路**不接受空串表示"根目录"**（而上面那条
           *   `sessionFileReferences` 恰恰是用空串表示根的，两者语义不同）。
           *   传 "." 时：`lstat(".", {cwd: workspaceRoot})` 解析成工作区根本身，
           *   `confine` 里 `contains(root, root)` 成立 ⇒ 正是"列根目录"。
           *   症状极具误导性：整个跨工作区浏览静默返回 0 项、且看起来像"空目录"。 */
          r = await wf.list(scope, rel || '.', ac.signal);
        } catch (e) {
          const m = String(e?.message || e);
          if (/not-directory/i.test(m)) throw new Error('这不是一个目录');
          if (/not-found/i.test(m)) throw new Error('目录不存在：' + (rel || tr.root));
          throw new Error('列目录失败：' + m);
        }
        truncated = !!r?.truncated;
        // 内核返回的是 {name,type,size}；归一成与上面那条路相同的形状
        items = (r?.entries || []).map((en) => {
          const name = String(en?.name || '');
          const isDir = en?.type === 'directory';
          return {
            path: rel ? rel + '/' + name : name,
            kind: isDir ? 'directory' : 'file',
            // 下面 mentionOf 只认 path/kind，这里补齐成它要的形状
            size: typeof en?.size === 'number' ? en.size : undefined,
          };
        }).filter((c) => c.path);
      }

      return {
        path: rel,
        parent,
        root: tr.root,
        isOther: tr.isOther,
        truncated,
        // 手机端要显示"我在哪个工作区"，所以把名字也带上
        rootName: path.basename(tr.root) || tr.root,
        items: (items || []).map((c) => {
          const relPath = String(c.path || '');
          return {
            path: relPath,
            name: relPath.split('/').pop() || relPath,
            kind: c.kind === 'directory' ? 'directory' : 'file',
            size: typeof c.size === 'number' ? c.size : undefined,
            /* 官方提及语法（本文件内实现的同规则副本，见 mentionOf 的注释）。
             * ★ 跨工作区时**必须给绝对路径**：`@` 提及的语义是"相对**本会话**工作区根"
             *   （官方 FILE_REFERENCE_PROMPT 原话："relative to the workspace root"），
             *   而别的工作区的相对路径在**当前会话里根本解析不到** ⇒
             *   照搬相对路径会让模型去找一个不存在的文件。
             *   绝对路径这条路是官方支持的：`read` / `readAll` / `stat` 都**允许工作区外路径**
             *   （`dsh-api-workspace-files/lib/types/index.d.ts:6-11`），
             *   所以模型用 read 工具按绝对路径读得到。 */
            mention: tr.isOther
              ? mentionOf({ path: path.join(tr.root, relPath), kind: c.kind })
              : mentionOf(c),
          };
        }).filter((c) => c.path),
      };
    },

    /* ══════════════════════════════════════════════════════════════
     * 文件互传 · 电脑 → 手机（见文件上方"文件互传"整节的设计说明）
     * ══════════════════════════════════════════════════════════════
     * 这里**不返回文件内容**，只签发一张一次性票据。手机拿到 `url` 之后
     * 交给系统下载器 / 浏览器（原生进度、通知栏、断点），WebView 不参与。
     *
     * 为什么用 `stat` 先探一次：`workspaceFiles.readAll` 有 32 MiB 硬上限
     * （`dsh-api-workspace-files/lib/index.js:445-457`，超了抛 too-large），
     * 而下载这条路**不走内核**（纯 HTTP 流），所以能传更大的文件。
     * 先 stat 是为了：① 早点告诉用户"这文件多大"，② 拒绝目录/符号链接。 */
    async 'file.download'(deviceId, params) {
      const sessionId = params?.sessionId;
      const filePath = String(params?.path || '').trim();
      if (!sessionId || !filePath) throw new Error('缺少 sessionId / path');
      const svc = ctx.get('workspaceFiles');
      if (!svc || typeof svc.stat !== 'function') throw new Error('这个客户端不支持读文件');
      const agent = agentOf(ctx, sessionId);
      if (!agent) throw new Error('会话不在运行（拿不到活 Agent）');

      const tr = await resolveTargetRoot(ctx, sessionId, params?.root);
      if (!tr.ok) throw new Error(tr.reason);
      const scope = { sessionId, workspaceRoot: tr.root };
      const ac = new AbortController();

      // 1) 走内核定位文件（拿到**解析后的绝对路径**与真实大小）
      //    ★ 内核的 `stat` 对目录会先抛 `workspace-file/not-regular-file`
      //      （英文原文 `"assets" is a directory`）—— 实测确认（plugin-check
      //      第一版就撞在这上面：我的中文断言没匹配上英文消息）。
      //      这里把它翻成用户看得懂的话，且**不吞掉其它错误**。
      let st;
      try {
        st = await svc.stat(scope, filePath, ac.signal);
      } catch (e) {
        const msg = String(e?.message || e);
        if (/is a directory|not-regular-file/i.test(msg)) {
          throw new Error('这是一个目录，不能直接下载（请先进入它，或打包成一个文件）');
        }
        throw new Error('定位不到这个文件：' + msg);
      }
      const abs = String(st?.absolutePath || '');
      if (!abs) throw new Error('定位不到这个文件：' + filePath);

      // 2) 再用 node:fs 复核一次"它真的是个普通文件"（内核的 stat 对符号链接也会报 file）
      let real;
      try { real = statSync(abs); } catch (e) { throw new Error('读不到这个文件：' + (e?.message || e)); }
      if (real.isDirectory()) throw new Error('这是一个目录，不能直接下载（请先进入它，或打包）');
      if (!real.isFile()) throw new Error('这不是普通文件（可能是符号链接或设备文件）');

      // 3) 清掉**已过期**的旧票据（顺手做，不必定时器）。
      //    ★ 只清过期的，**不要**清同一设备的所有票据 —— 用户可能连着点两个文件下载，
      //      后者一签票就把前者的票删掉，前一个下载会当场 404（实测会踩）。
      const now = Date.now();
      for (const [t, tk] of state.tickets) {
        if (now > tk.expiresAt) state.tickets.delete(t);
      }

      const name = safeFileName(params?.name || abs);
      const ticket = makeToken();
      state.tickets.set(ticket, {
        path: abs, name, bytes: real.size, deviceId, expiresAt: now + DOWNLOAD_TTL_MS,
      });
      state.diagnostics.transfers.push({ dir: 'down', name, bytes: real.size, at: now });

      return {
        url: `/api/file/dl?t=${encodeURIComponent(ticket)}`,
        name,
        bytes: real.size,
        expiresIn: DOWNLOAD_TTL_MS,
        absolutePath: abs,
      };
    },

    /* ══════════════════════════════════════════════════════════════
     * 文件互传 · 手机 → 电脑（落点信息）
     * ══════════════════════════════════════════════════════════════
     * 真正写字节的是 `POST /api/file/ul`（裸字节流，见 startLanServer）。
     * 这个 RPC 只回答一件事：**"往哪儿传、能传多大、重名会怎样"**，
     * 让手机端在选文件**之前**就能把落点显示出来 —— 用户看得到才敢传。 */
    async 'file.uploadTarget'(deviceId, params) {
      const sessionId = params?.sessionId;
      if (!sessionId) throw new Error('缺少 sessionId');
      // 2026-09-22：支持跨工作区上传（用户："向三个工作区发送文件"）
      const tr = await resolveTargetRoot(ctx, sessionId, params?.root);
      if (!tr.ok) throw new Error(tr.reason);
      const workspaceRoot = tr.root;
      const sub = String(params?.dir || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
      const r = resolveSubdir(workspaceRoot, sub);
      if (!r.ok) throw new Error(r.reason);
      let exists = false;
      try { exists = statSync(r.dir).isDirectory(); } catch { exists = false; }
      return {
        workspaceRoot,
        rootName: path.basename(workspaceRoot) || workspaceRoot,
        isOther: tr.isOther,
        dir: sub,
        absolutePath: r.dir,
        exists,                       // 不存在也允许（上传时自动 mkdir -p）
        maxBytes: UPLOAD_MAX_BYTES,
        // 重名不覆盖 —— 这条要明说，否则用户会以为"传上去就顶掉了"
        onConflict: 'rename',
      };
    },

    /* ══════════════════════════════════════════════════════════════
     * 添加 API 通道（见文件末尾 llm-pi-ai 那一节的完整注释）
     * ══════════════════════════════════════════════════════════════ */

    /** 现有通道一览（手机端"添加 API"页面要显示"已经有了哪些"，避免重复添加）。 */
    async 'llm.providers'() {
      const out = { protocols: PI_AI_PROTOCOLS, providers: [] };
      try {
        const settings = ctx.get('settings');
        const sec = settings?.get?.('llm-pi-ai');
        const providers = (sec && sec.providers) || {};
        for (const [id, p] of Object.entries(providers)) {
          out.providers.push({
            id,
            displayName: p?.displayName || id,
            baseURL: p?.baseURL || '',
            api: p?.api || '',
            keyRef: p?.apiKeyEnv || '',
            models: Array.isArray(p?.models) ? p.models.map((m) => m?.id).filter(Boolean) : [],
          });
        }
      } catch { /* 读不到就给空表，不炸 */ }
      return out;
    },

    /**
     * 第一步：**探测端点上有哪些模型**（官方 `llm/discoverModels`）。
     * 与官方设置页的"获取可用模型"完全同一条路（`dsh-client-ui-settings-models/
     * lib/client.js:599, 2614-2616`），请求体形状取自 typert schema
     * （`dsh-llm/lib/typert.host.js:5-16`：provider/baseURL/api/apiKey 全可选）。
     * 这一步**不写任何东西** —— 让用户先看清要加哪些模型，再确认落盘。
     */
    async 'llm.discover'(deviceId, params) {
      const baseURL = String(params?.baseURL || '').trim();
      const api = String(params?.api || '').trim();
      const apiKey = String(params?.apiKey || '');
      if (!baseURL) throw new Error('缺少 baseURL');
      if (!PI_AI_PROTOCOLS.includes(api)) throw new Error('协议必须是：' + PI_AI_PROTOCOLS.join(' / '));
      const llm = ctx.get('llm');
      if (!llm || typeof llm.discoverModels !== 'function') throw new Error('这个客户端不支持模型发现');
      const req = { baseURL, api };
      if (apiKey) req.apiKey = apiKey;
      if (params?.provider) req.provider = String(params.provider);
      const ac = new AbortController();
      const found = await llm.discoverModels(LLM_NS, req, ac.signal);
      return {
        models: (found || []).map((m) => ({
          id: String(m.id || ''),
          name: m.name ? String(m.name) : '',
          contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
          maxTokens: typeof m.maxTokens === 'number' ? m.maxTokens : null,
        })).filter((m) => m.id),
      };
    },

    /**
     * 第二步：**落盘**（配置 + 凭据）。这是唯一会改电脑配置的动作。
     *
     * 顺序有意为之：**先写 settings、后写凭据**。
     * 反过来的话，若 settings 写失败，凭据里就留了一个没有通道引用的孤儿 key；
     * 而先写 settings 时，即使凭据写失败，表现只是"通道在、但缺 key"——
     * 手机端会把这句话明确报出来（下面 catch 里），用户补一次 key 即可。
     */
    async 'llm.add'(deviceId, params) {
      const providerId = String(params?.providerId || '').trim();
      const baseURL = String(params?.baseURL || '').trim();
      const api = String(params?.api || '').trim();
      const displayName = String(params?.displayName || '').trim();
      const apiKey = String(params?.apiKey || '');
      const models = Array.isArray(params?.models) ? params.models : [];

      if (!validRouteId(providerId)) {
        throw new Error('通道 ID 只能用小写字母/数字/连字符，且以字母开头（例：acme-gateway）');
      }
      if (!baseURL || !/^https?:\/\//i.test(baseURL)) throw new Error('baseURL 必须是 http(s):// 开头的完整地址');
      if (!PI_AI_PROTOCOLS.includes(api)) throw new Error('协议必须是：' + PI_AI_PROTOCOLS.join(' / '));
      if (!models.length) throw new Error('至少要有一个模型（先用"探测模型"拉一次）');

      const settings = ctx.get('settings');
      if (!settings || typeof settings.mutate !== 'function') throw new Error('这个客户端不支持写入设置');

      // 组装 profile —— 字段名与官方 schema 一致（`dsh-llm-pi-ai/lib/index.js:983-1015`）
      const keyRef = apiKey ? keyRefOf(providerId) : '';
      const profile = { api, baseURL, models: [] };
      if (displayName) profile.displayName = displayName;
      if (keyRef) profile.apiKeyEnv = keyRef;
      for (const m of models.slice(0, 200)) {
        const id = String(m?.id || '').trim();
        if (!id) continue;
        const entry = { id };
        if (m?.name) entry.name = String(m.name);
        if (Number.isInteger(m?.contextWindow) && m.contextWindow > 0) entry.contextWindow = m.contextWindow;
        if (Number.isInteger(m?.maxTokens) && m.maxTokens > 0) entry.maxTokens = m.maxTokens;
        profile.models.push(entry);
      }
      if (!profile.models.length) throw new Error('模型列表为空');

      // ① 写配置：**mutate（按路径）**，不是 update —— 见本节顶部注释
      await settings.mutate(LLM_NS, [{
        op: 'set',
        path: ['providers', providerId],
        value: profile,
      }]);

      // ② 写凭据（有 key 才写）。失败不掩盖配置已写入的事实 —— 明确报出来。
      let keyStored = false;
      if (keyRef) {
        try {
          const creds = ctx.get('credentials');
          if (!creds || typeof creds.set !== 'function') throw new Error('没有凭据服务');
          await creds.set(keyRef, apiKey);
          keyStored = true;
        } catch (e) {
          throw new Error('通道已写入，但 API key 保存失败（' + (e?.message || e)
            + '）。请在电脑上补一次，或换个 key 名重试。');
        }
      }

      return {
        providerId,
        displayName: displayName || providerId,
        models: profile.models.length,
        keyRef: keyRef || null,
        keyStored,
        // 提示手机端：通道**立刻可用**（无需重启内核），但要用它得在会话里选模型
        note: '通道已生效，无需重启。在会话里「切换模型」即可看到它。',
      };
    },

    /* ══════════════════════════════════════════════════════════════
     * 当前模型与推理强度（2026-09-22 用户需求："手机上可以看到当前对话
     * 使用的模型和推理强度"）
     * ══════════════════════════════════════════════════════════════
     * 数据来自官方 `modelSelection` 投影（`dsh-api-session-controller/
     * lib/index.js:2075-2084`），它有两个字段，**两个都要给手机**：
     *   · `lastUsed` —— 最近一次请求**真正用的**（来自 request/header 事件）
     *   · `next`     —— 已经切了、但还没发出请求的那个（来自 model/selection）
     * 只显示一个会误导：刚切完模型时 lastUsed 还是旧的，用户会以为没切成功；
     * 只显示 next 又会在没切换时是空的。手机端按"next 优先、否则 lastUsed"显示，
     * 并在两者不同时明确标出"已切换，下一条生效"。
     */
    async 'session.model'(deviceId, params) {
      const sessionId = params?.sessionId;
      if (!sessionId) throw new Error('缺少 sessionId');
      const agent = agentOf(ctx, sessionId);
      if (!agent) throw new Error('会话不在运行（拿不到活 Agent）');
      const svc = ctx.get('sessionProjections');
      if (!svc || typeof svc.snapshot !== 'function') throw new Error('这个客户端没有模型投影');
      const snap = svc.snapshot(agent.session, ['modelSelection']);
      const v = (snap && snap.values && snap.values.modelSelection) || {};
      return {
        lastUsed: v.lastUsed || null,
        next: v.next || null,
        // 手机端直接显示这个（next 优先），省得两端各判一次
        effective: v.next || v.lastUsed || null,
        pending: !!(v.next && v.lastUsed
          && (v.next.provider !== v.lastUsed.provider
            || v.next.model !== v.lastUsed.model
            || (v.next.reasoningEffort || '') !== (v.lastUsed.reasoningEffort || ''))),
      };
    },

    /* ══════════════════════════════════════════════════════════════
     * 读电脑文件的**字节**（把电脑上的图片发进对话）
     * ══════════════════════════════════════════════════════════════
     * 用官方 `workspaceFiles.readAll(sessionId, path)` —— 它返回 base64
     * （`dsh-api-workspace-files/lib/index.js:443-464`，关键行 461
     *  `Buffer.from(data).toString("base64")`）。
     *
     * ★ 权限边界（照抄官方声明，不夸大）：
     *   `read` / `readAll` / `readBytes` / `stat` **允许工作区外路径**
     *   （`dsh-api-workspace-files/lib/types/index.d.ts:6-11`）；
     *   只有 `list` 被 confine 在工作区内。所以"读字节"这一侧比"列目录"宽 ——
     *   手机端要传绝对路径才能读工作区外的文件，而列目录列不出来。
     *   这是内核的既定设计，本插件不额外放宽也不假装更严。
     * ★ 上限：maxBytes 2 MiB / maxFileBytes 32 MiB（同包 357-362 行）——
     *   图片够用；超了内核自己会拒绝，错误原样透传给手机。
     *
     * ★ 第一个参数不是 session，而是 **WorkspaceFileScope = {sessionId, workspaceRoot}**
     *   （官方 lookup 的构造见 `dsh-api-workspace-files/lib/index.js:378-387`：
     *    `workspaceRoot: header.cwd ?? sandboxPolicy.workspaceRoot`）。
     *   ★ 这条是**实测踩出来的**：第一版传了 session 对象，结果 readAll 返回空字符串、
     *   **且不报错**（因为 `locateFile` 从 scope 上取不到 root，静默读到 0 字节）。
     *   `plugin-check` 的"读文件字节"断言把它抓了出来 —— 这正是"必须真跑"的价值。
     */
    async 'file.read'(deviceId, params) {
      const sessionId = params?.sessionId;
      const filePath = String(params?.path || '').trim();
      if (!sessionId || !filePath) throw new Error('缺少 sessionId / path');
      const svc = ctx.get('workspaceFiles');
      if (!svc || typeof svc.readAll !== 'function') throw new Error('这个客户端不支持读文件');
      const agent = agentOf(ctx, sessionId);
      if (!agent) throw new Error('会话不在运行（拿不到活 Agent）');

      // 组装官方要的 WorkspaceFileScope（边界 = 我们选定的工作区根）
      //   2026-09-22：`root` 参数可指定别的工作区（仅限已注册的，见 resolveTargetRoot）
      const tr = await resolveTargetRoot(ctx, sessionId, params?.root);
      if (!tr.ok) throw new Error(tr.reason);
      const scope = { sessionId, workspaceRoot: tr.root };

      const ac = new AbortController();
      const r = await svc.readAll(scope, filePath, ac.signal);
      const data = String(r?.data || '');
      if (!data) throw new Error('读到的内容为空（路径不对，或该文件不在可读范围）');
      return {
        path: filePath,
        absolutePath: r?.absolutePath || '',
        // base64（不带 data: 前缀）—— 手机端拼成 data URL 预览，或当图片发出去
        data,
        bytes: typeof r?.bytes === 'number' ? r.bytes : Buffer.from(data, 'base64').length,
      };
    },
  };
}

/**
 * 把候选格式化成官方 `@` 提及文本。
 *
 * ★ 这是 `dsh-file-reference/lib/index.js:39-45` 的**同规则副本**（不是猜的）：
 *   · 目录：路径末尾补 `/`（官方 `formatFileMention` 第 40 行）
 *   · 含空白 ⇒ 用引号形态；目录保持引号**不闭合**（`@"a b/`），文件才闭合（`@"a b"`）
 *     （同函数 42-44 行）
 *   · 含控制字符或引号 ⇒ 官方返回 undefined（无法安全表示）；这里降级为不引用并跳过
 *   为什么抄一份而不 import：本插件对内核模块**不做 import**（零依赖前提，
 *   且内核包名/路径不属于稳定契约）；抄的是 6 行纯函数，规则有出处可核对。
 */
function mentionOf(candidate) {
  const kind = candidate?.kind === 'directory' ? 'directory' : 'file';
  const p = String(candidate?.path || '');
  if (!p) return '';
  const withSlash = kind === 'directory' ? p + '/' : p;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(withSlash)) return '';
  if (!/\s/u.test(withSlash)) return '@' + withSlash;
  return kind === 'directory' ? '@"' + withSlash : '@"' + withSlash + '"';
}

/* ══════════════════════════════════════════════════════════════════
 * 添加 API 通道（用户需求："允许在手机上输入 API 来添加 API 进电脑中"）
 * ══════════════════════════════════════════════════════════════════
 * 走**官方写入通道**，不手改 settings.yaml / .credentials.yaml：
 *   · 配置：`ctx.get('settings').mutate('llm-pi-ai', ops)`
 *     —— 官方设置页新增 provider 用的就是它（`dsh-client-ui-settings-models/
 *        lib/client.js:1188-1211` → `operations.writeSettings` → `remote.settings.mutate`）。
 *     为什么必须用 `mutate` 而不是 `update`：`update` 是**整体合并**，
 *     而 `mutate` 是**按路径改写**，它"不可能删掉自己没见过的字段"
 *     （`dsh-settings/lib/index.js:420-441` 的原文注释）。手机端只知道自己要加的那条
 *     通道，用 update 会有覆盖用户其它配置的风险 —— 这是**安全关键**，不是风格问题。
 *   · 凭据：`ctx.get('credentials').set(ref, key)` → 写 `.credentials.yaml` 的 `refs:`
 *     段（`dsh-credentials-local/lib/index.js:513, 604-630`）。
 *     ref 必须是 POSIX 标识符（`^[A-Za-z_][A-Za-z0-9_]*$`，同包 13 行），
 *     官方 UI 的派生规则是 `${ID大写}_API_KEY`（UI 里 920-922 行）—— 照抄同一规则。
 *
 * ★ 为什么**不用**重启内核：pi-ai 注册了 settings 的 onChange，
 *   写入会走 `registration.replace(routes)` **原地重注册**路由
 *   （`dsh-llm-pi-ai/lib/index.js:2645-2685`）；凭据更是每次请求现 resolve
 *   （同包 2594-2601）。pi-ai 源码注释自己写着"changed key, endpoint, model, or knob
 *   reaches the next request without a restart"（2480-2484 行）。
 *
 * ★ 安全边界（诚实说明）：
 *   · 手机能写凭据 = 手机能把**自己的** key 塞进电脑。这是用户明确要的功能，
 *     但它比"发消息/批审批"更高一层（改的是配置面）⇒ 界面上要明示。
 *   · 这里**只允许写 pi-ai 家族的通道**（NS 固定 `llm-pi-ai`），
 *     不去碰 boot 级 provider 定义，也不碰其它 namespace。
 *   · key 明文只在内存与最终文件里；本模块**不打印、不回显**（只回 key 长度）。
 */
const LLM_NS = 'llm-pi-ai';

/** route id → 凭据 ref。规则抄自官方设置页（`deriveKeyRef`，同规则副本）。 */
function keyRefOf(providerId) {
  return String(providerId).toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY';
}

/** route id 合法性：官方要求小写连字符标识（`dsh-credentials/lib/index.js:15` 的 KEY_SEGMENT_PATTERN）。 */
function validRouteId(id) {
  return /^[a-z][a-z0-9-]*$/.test(String(id || ''));
}

/** 协议白名单：pi-ai 只认这三种（`dsh-llm-pi-ai/lib/index.js:754-758` 的 PROTOCOLS）。 */
const PI_AI_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'];


/* ══════════════════════════════════════════════════════════════════
 * 局域网 HTTP 服务
 * ══════════════════════════════════════════════════════════════════ */

function startLanServer(ctx) {
  const methods = rpcMethods(ctx);

  const server = createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://lan.invalid'); } catch { res.writeHead(400); res.end('bad url'); return; }
    const p = url.pathname;

    // 手机端页面本身不做鉴权（里面没有数据，只有一个"输码"界面）
    if (req.method === 'GET' && (p === '/' || p === '/pair' || p === '/index.html')) {
      return serveStatic(res, 'index.html');
    }
    if (req.method === 'GET' && (p === '/app.js' || p === '/styles.css' || p === '/manifest.webmanifest')) {
      return serveStatic(res, p.slice(1));
    }

    // 配对：用一次性码换 token（唯一不需要 token 的接口）
    if (req.method === 'POST' && p === '/api/pair/submit') {
      let body;
      try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'invalid_json' }); }
      const submitted = String(body?.code || '').trim().toUpperCase();
      const c = state.code;
      if (!c || Date.now() > c.expiresAt || !submitted || !safeEqual(submitted, c.code)) {
        return sendJson(res, 400, { error: 'expired_code', message: '配对码不对或已过期，请在电脑上重新扫码' });
      }
      // 用过即废（一次性）
      state.code = null;
      const deviceName = String(body?.deviceName || '').slice(0, 60) || '手机';

      /* ── 同名设备去重（2026-09-22 用户报告"明明只是同一个手机APP的多次登录，
       *    它就显示好几台"）────────────────────────────────────────────
       * 真因：每次配对都 makeToken() 造一个新 token、devices 里加一个新条目；
       * 而 devices 的 key 是 token ⇒ 同一台手机每登录一次就"多一台设备"。
       * （旧 token 只在手机 localStorage 被清或 revoke 时才消失。）
       * 修法：先按**设备名**找旧条目 —— 找到就复用旧 token（并刷新 lastSeen），
       * 手机端拿到同一个 token，localStorage 里的旧值继续有效，不产生新条目。
       * 局限要诚实说：判定键是"设备名"（浏览器 UA 前 60 字 / App 固定 UA），
       * 同一台手机换浏览器会算两台 —— 但"同一 App 多次登录"这个主诉场景覆盖了。 */
      let token = null;
      for (const [t, d] of state.devices) {
        if (d.name === deviceName) { token = t; d.lastSeen = Date.now(); break; }
      }
      if (!token) {
        token = makeToken();
        state.devices.set(token, { deviceId: randomBytes(8).toString('hex'), name: deviceName, pairedAt: Date.now(), lastSeen: Date.now() });
      } else {
        // 复用旧条目 ⇒ 也要给它一个新的 deviceId 吗？不必：deviceId 只是流分组用，
        // 复用旧的让 SSE 流 / watchers 的清理路径保持原样。
      }
      state.diagnostics.pairs++;
      saveDevices();
      return sendJson(res, 200, { token, deviceId: state.devices.get(token).deviceId, ok: true });
    }

    // ── 以下全部需要 token ──
    const token = bearerOf(req) || url.searchParams.get('token') || '';
    const device = token ? state.devices.get(token) : null;
    if (!device) return sendJson(res, 401, { error: 'unauthorized', message: '未配对或 token 已失效，请重新扫码' });
    device.lastSeen = Date.now();

    /* ── 下载：电脑 → 手机（见文件上方"文件互传"整节）─────────────────
     * ★ 这里是**裸字节流**，不是 JSON。三个必须做对的地方：
     *   ① `content-length` 必须给真实大小 —— 手机端（系统下载器）靠它算进度；
     *   ② 支持 `Range`（206）—— 下载管理器的"继续"、以及浏览器对大文件的分段；
     *   ③ 票据**一次性**：拿到就删（在打开文件流成功之后才删，
     *      这样"文件打不开"时用户还能重试一次，而不是票据白烧）。
     * ★ 为什么 token 允许走查询参数：这个 URL 是要交给系统下载器的，
     *   我们**无法**给它加 Authorization 头。上面 `url.searchParams.get('token')`
     *   那一条就是为它准备的（SSE 也一样）。
     * ⚠️ 代价要讲清：URL 会进下载器记录 / 浏览器历史 ⇒ 用完即焚的票据
     *   只保护"文件路径"，token 本身仍可能留在手机端的下载历史里。 */
    if (req.method === 'GET' && p === '/api/file/dl') {
      const tk = state.tickets.get(url.searchParams.get('t') || '');
      if (!tk) return sendJson(res, 404, { error: 'bad_ticket', message: '下载链接已失效，请在手机上重新点一次' });
      if (tk.deviceId !== device.deviceId) return sendJson(res, 403, { error: 'wrong_device', message: '这张下载链接是另一台设备签发的' });
      if (Date.now() > tk.expiresAt) { state.tickets.delete(url.searchParams.get('t')); return sendJson(res, 410, { error: 'expired', message: '下载链接已过期，请重新点一次' }); }

      let size = tk.bytes;
      try { size = statSync(tk.path).size; } catch (e) {
        return sendJson(res, 404, { error: 'gone', message: '文件已不在原处：' + (e?.message || e) });
      }

      // Range 支持（单段）
      let start = 0, end = size - 1, status = 200;
      const range = String(req.headers.range || '');
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        if (m[1] === '' && m[2] !== '') {          // `bytes=-500` ⇒ 最后 500 字节
          start = Math.max(0, size - Number(m[2]));
        } else {
          start = Number(m[1] || 0);
          if (m[2] !== '') end = Math.min(size - 1, Number(m[2]));
        }
        if (!Number.isFinite(start) || start >= size || start > end) {
          res.writeHead(416, { 'content-range': `bytes */${size}` });
          return res.end();
        }
        status = 206;
      }
      const length = end - start + 1;

      const headers = {
        'content-type': 'application/octet-stream',
        'content-length': String(length),
        'content-disposition': contentDisposition(tk.name),
        'cache-control': 'no-store',
        'accept-ranges': 'bytes',
      };
      if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;

      let stream;
      try { stream = createReadStream(tk.path, { start, end }); } catch (e) {
        return sendJson(res, 500, { error: 'open_failed', message: e?.message || String(e) });
      }
      // 文件流打开失败（权限/被占用）也要能给出 JSON 而不是半截二进制
      stream.on('error', (e) => {
        state.diagnostics.errors.push('dl: ' + (e?.message || e));
        if (!res.headersSent) sendJson(res, 500, { error: 'read_failed', message: e?.message || String(e) });
        else try { res.destroy(); } catch { }
      });
      res.writeHead(status, headers);
      // 完整下载（非断点续传）成功即焚票；断点续传保留到过期，否则"继续"会 404
      if (status === 200) state.tickets.delete(url.searchParams.get('t'));
      pipeline(stream, res).catch(() => { try { res.destroy(); } catch { } });
      return;
    }

    /* ── 上传：手机 → 电脑（裸字节流）────────────────────────────────
     * 参数全在查询串里（`path` 只是**子目录**，`name` 是文件名），
     * 请求体就是文件字节本身。宿主 `pipeline(req → 文件)` 边收边写，
     * **不在内存里堆积** ⇒ 几百 MB 也不吃内存。
     * ★ 失败清理：写了一半出错就把残file删掉 —— 半个文件比没有文件更坏
     *   （用户会以为传成功了，然后去读一个被截断的 JSON/源码）。 */
    if (req.method === 'POST' && p === '/api/file/ul') {
      const sessionId = url.searchParams.get('sessionId') || '';
      const sub = url.searchParams.get('path') || '';
      const rawName = url.searchParams.get('name') || 'file';

      /* ★ 跨工作区上传（2026-09-22）：`root` 走**与 RPC 完全相同的那道校验**
       *   （`resolveTargetRoot` —— 只认"本会话工作区"或"已注册工作区"）。
       *   这条**必须**在这里也做一次，不能只靠前面的 `file.uploadTarget`：
       *   那个 RPC 只是"给手机看落点"，而**真正写字节的是这个端点** ——
       *   手机完全可以跳过 RPC 直接 POST 一个 root 过来。
       *   （实测精神：能被绕过的校验等于没有校验。） */
      const tr = await resolveTargetRoot(ctx, sessionId, url.searchParams.get('root') || '');
      if (!tr.ok) return sendJson(res, 403, { error: 'bad_workspace', message: tr.reason });
      const root = tr.root;
      const r = resolveSubdir(root, sub);
      if (!r.ok) return sendJson(res, 403, { error: 'outside_workspace', message: r.reason });

      const declared = Number(req.headers['content-length'] || 0);
      if (declared && declared > UPLOAD_MAX_BYTES) {
        return sendJson(res, 413, { error: 'too_large', message: `超过单次上限 ${Math.round(UPLOAD_MAX_BYTES / 1048576)} MB` });
      }

      let dir = r.dir;
      try { mkdirSync(dir, { recursive: true }); } catch (e) {
        return sendJson(res, 500, { error: 'mkdir_failed', message: e?.message || String(e) });
      }
      const name = safeFileName(rawName);
      const target = uniquePathIn(dir, name);

      let written = 0;
      const ws = createWriteStream(target);
      const cleanup = () => { try { unlinkSync(target); } catch { } };

      try {
        req.on('data', (c) => {
          written += c.length;
          if (written > UPLOAD_MAX_BYTES) { try { req.destroy(); } catch { } }
        });
        await pipeline(req, ws);
      } catch (e) {
        cleanup();
        state.diagnostics.errors.push('ul: ' + (e?.message || e));
        return sendJson(res, 500, { error: 'write_failed', message: e?.message || String(e) });
      }
      if (written > UPLOAD_MAX_BYTES) {
        cleanup();
        return sendJson(res, 413, { error: 'too_large', message: '超过单次上限' });
      }

      state.diagnostics.transfers.push({ dir: 'up', name: path.basename(target), bytes: written, at: Date.now() });
      // 相对工作区的路径 —— 手机端可以直接把它当 `@` 提及用
      const rel = path.relative(root, target).split(path.sep).join('/');
      /* ★ 提及文本：本工作区用**相对路径**（官方 `@` 的语义就是相对工作区根）；
       *   传进**别的工作区**时必须给**绝对路径** —— 否则 `@rel` 会被模型拿去
       *   在当前会话的工作区里找，那是个不存在的文件（见 file.list 里同一条注释）。 */
      const mentionPath = tr.isOther ? target : rel;
      return sendJson(res, 200, {
        ok: true,
        name: path.basename(target),
        renamed: path.basename(target) !== name,
        bytes: written,
        absolutePath: target,
        relativePath: rel,
        isOther: tr.isOther,
        workspaceRoot: root,
        mention: '@' + (/\s/.test(mentionPath) ? '"' + mentionPath + '"' : mentionPath),
      });
    }

    // SSE 事件流
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ deviceId: device.deviceId })}\n\n`);
      let set = state.streams.get(device.deviceId);
      if (!set) { set = new Set(); state.streams.set(device.deviceId, set); }
      set.add(res);
      const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { } }, 20_000);
      req.on('close', () => {
        clearInterval(ka);
        set.delete(res);
        if (!set.size) state.streams.delete(device.deviceId);
        // 设备断开 ⇒ 停掉它的跟随流（否则内核里会留着没人看的订阅）
        const per = state.watchers.get(device.deviceId);
        if (per) { for (const [, w] of per) { try { w.abort.abort(); } catch { } } per.clear(); }
      });
      return;
    }

    // RPC
    if (req.method === 'POST' && p === '/api/rpc') {
      let body;
      try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'invalid_json' }); }
      const method = String(body?.method || '');
      state.diagnostics.rpc[method] = (state.diagnostics.rpc[method] || 0) + 1;
      const fn = methods[method];
      if (!fn) return sendJson(res, 400, { error: 'unknown_method', message: `未知方法：${method}` });
      try {
        const result = await fn(device.deviceId, body?.params || {});
        return sendJson(res, 200, { ok: true, result });
      } catch (e) {
        state.diagnostics.errors.push(`${method}: ${e?.message || e}`);
        return sendJson(res, 500, { ok: false, error: 'rpc_failed', message: e?.message || String(e) });
      }
    }

    if (req.method === 'GET' && p === '/api/me') {
      return sendJson(res, 200, { ok: true, device: { name: device.name, deviceId: device.deviceId } });
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  return new Promise((resolve) => {
    server.on('error', (e) => {
      state.diagnostics.errors.push('listen: ' + (e?.message || e));
      // 端口被占不该让整个插件（乃至 profile）挂掉 —— 记下来，让界面能看见
      ctx.logger?.warn?.(`[dsh-int-mobile-remote] 局域网服务启动失败：${e?.message || e}`);
      resolve({ server: null, port: null });
    });
    server.listen(Config.port, '0.0.0.0', () => {
      const addrs = lanAddresses();
      state.diagnostics.listens.push({ port: Config.port, at: Date.now() });
      ctx.logger?.info?.(
        `[dsh-int-mobile-remote] 局域网服务已监听 http://0.0.0.0:${Config.port}` +
        (addrs.length ? `（手机请访问 http://${addrs[0].address}:${Config.port}）` : '（未找到局域网地址）'),
      );
      resolve({ server, port: Config.port });
    });
  });
}

function bearerOf(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

async function serveStatic(res, name) {
  // 防目录穿越：只允许 phone/ 下的直接文件名
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    res.writeHead(400); res.end('bad path'); return;
  }
  try {
    const buf = await readFile(path.join(PHONE_DIR, name));
    res.writeHead(200, {
      'content-type': MIME[path.extname(name)] || 'application/octet-stream',
      'content-length': buf.byteLength,
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 审批桥接
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 把 `approval/request` 的 waterfall 接到手机上。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条必须写清的规则（都关系到"会不会把电脑端卡住"）
 * ══════════════════════════════════════════════════════════════════
 * 1. **没有手机在线时，立刻 `next()` 让位。**
 *    waterfall 是"返回一个 outcome 就算你认领了这个请求"。若我们既不认领也不
 *    让位，官方其它 answerer（桌面端 UI）就永远轮不到 ⇒ **电脑上的审批框不再弹出**。
 *    这是最危险的一种坏法：手机没开，桌面端反而被弄瘸了。所以判据是
 *    "有没有已配对的手机 + 它是不是开着事件流"，没有就一个 `next()` 走人。
 *
 * 2. **有手机在线但没人回答 ⇒ 超时后 `next()`，不是自动同意。**
 *    自动同意等于把"手机连着"变成"永久放行一切工具调用"，那是安全倒退。
 *    超时让位给桌面端，用户仍能在电脑上看到并决定。
 *
 * 3. **手机明确点了"拒绝" ⇒ 返回 `'rejected'`（这是唯一会认领的分支）。**
 *    拒绝是**安全方向**的动作，认领它不会把用户卡住。
 *    注意不提供"永远同意"——那需要持久化策略，风险面完全不同，本版刻意不做。
 */
function installApprovalBridge(ctx) {
  const TIMEOUT_MS = 90_000;

  const answer = (id, outcome) => {
    const p = state.pendingApprovals.get(id);
    if (!p) return false;
    state.pendingApprovals.delete(id);
    try { clearTimeout(p.timer); } catch { }
    p.resolve(outcome);
    return true;
  };

  /** 手机点了同意/拒绝 → 落回等待中的那个 Promise。 */
  state.resolveApproval = (id, approve) => answer(id, approve ? 'allowed-once' : 'rejected');

  ctx.effect(() => {
    const dispose = ctx.on('approval/request', async (req, next) => {
      // 规则 1：没有手机在看 ⇒ 立刻让位（绝不挡桌面端）
      if (!state.devices.size || !state.streams.size) return next();

      const id = 'ap-' + randomBytes(8).toString('hex');
      const sessionId = req?.agent?.session?.id || req?.agent?.sessionId || null;

      // 推给所有已配对的手机
      for (const deviceId of state.streams.keys()) {
        pushEvent(deviceId, 'approval', {
          id,
          sessionId,
          toolName: req?.toolName || '(未知工具)',
          reason: req?.reason || '',
          callId: req?.callId || null,
        });
      }

      const outcome = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          // 规则 2：超时让位给桌面端，**不自动同意**
          if (state.pendingApprovals.delete(id)) {
            for (const deviceId of state.streams.keys()) {
              pushEvent(deviceId, 'approval-expired', { id });
            }
            resolve('__next__');
          }
        }, TIMEOUT_MS);
        state.pendingApprovals.set(id, { resolve, timer, sessionId });
        // 用户在电脑上先回答了 ⇒ 请求被 abort，我们也要让位
        req?.signal?.addEventListener?.('abort', () => {
          if (state.pendingApprovals.delete(id)) {
            clearTimeout(timer);
            resolve('__next__');
          }
        }, { once: true });
      });

      if (outcome === '__next__') return next();
      return outcome;
    });
    return () => { try { dispose?.(); } catch { } };
  }, 'dsh-int-mobile-remote: approval bridge');
}

/* ══════════════════════════════════════════════════════════════════
 * apply
 * ══════════════════════════════════════════════════════════════════ */

/**
 * @param {any} ctx Cordis 上下文
 * @param {Partial<typeof Config>} [config]
 */
export function apply(ctx, config) {
  if (config) {
    if (typeof config.port === 'number' && config.port > 0) Config.port = config.port;
    if (typeof config.codeTtlMs === 'number' && config.codeTtlMs > 0) Config.codeTtlMs = config.codeTtlMs;
  }

  // ⓪ 恢复已配对设备（重启免重扫，见 DEVICES_FILE 处的注释）
  loadDevices();

  // ① 局域网服务（手机用）
  let lanHandle = null;
  ctx.effect(() => {
    let closed = false;
    startLanServer(ctx).then((h) => {
      if (closed) { try { h.server?.close(); } catch { } return; }
      lanHandle = h;
    });
    return () => {
      closed = true;
      try { lanHandle?.server?.close(); } catch { }
      for (const set of state.streams.values()) for (const res of set) { try { res.end(); } catch { } }
      for (const per of state.watchers.values()) for (const [, w] of per) { try { w.abort.abort(); } catch { } }
      state.streams.clear();
      state.watchers.clear();
    };
  }, 'dsh-int-mobile-remote: lan server');

  // ② 审批桥接：把"要不要允许这个工具调用"推到手机，手机点同意/拒绝
  installApprovalBridge(ctx);

  // ③ 同源路由（电脑端插件界面用）—— 挂在官方 webServer 上，走 127.0.0.1:3105
  ctx.inject(['webServer'], (hostCtx) => {
    const disposers = [];

    disposers.push(hostCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/state`,
      handler: async (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
        sendJson(response, 200, { ok: true, data: publicState(ctx) });
      },
    }));

    disposers.push(hostCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/rotate`,
      handler: async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
        state.code = null;             // 下次 currentCode() 会生成新的
        sendJson(response, 200, { ok: true, data: publicState(ctx) });
      },
    }));

    // 已配对设备全部注销（手机上要重新扫码）
    disposers.push(hostCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/revoke`,
      handler: async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
        for (const set of state.streams.values()) for (const res of set) { try { res.end(); } catch { } }
        for (const per of state.watchers.values()) for (const [, w] of per) { try { w.abort.abort(); } catch { } }
        state.devices.clear(); state.streams.clear(); state.watchers.clear();
        saveDevices();               // ★ revoke = 明确作废：台账同步清盘（安全阀，见 DEVICES_FILE 注释）
        sendJson(response, 200, { ok: true, data: publicState(ctx) });
      },
    }));

    ctx.effect(() => () => { for (const d of disposers) { try { d?.(); } catch { } } }, 'dsh-int-mobile-remote: routes');
  });
}
