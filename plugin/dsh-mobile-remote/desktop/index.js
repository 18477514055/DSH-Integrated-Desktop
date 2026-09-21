/**
 * dsh-mobile-remote —— 宿主半边（Host half）。
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
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import qrcode from './qr.cjs';

/** 插件名（Cordis bundle tree 中的 id）。 */
export const name = 'dsh-mobile-remote';

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
const ROUTE_PREFIX = '/dsh-mobile-remote';

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
  /** 由 installApprovalBridge 填上：手机回答审批时回调 */
  resolveApproval: null,
  /** 诊断（供 plugin-check 读取，也供"看不见"时定位） */
  diagnostics: { errors: [], listens: [], pairs: 0, prompts: 0, cancels: 0, approvals: 0, rpc: {} },
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
  };
}

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
      const token = makeToken();
      const deviceId = randomBytes(8).toString('hex');
      const deviceName = String(body?.deviceName || '').slice(0, 60) || '手机';
      state.devices.set(token, { deviceId, name: deviceName, pairedAt: Date.now(), lastSeen: Date.now() });
      state.diagnostics.pairs++;
      return sendJson(res, 200, { token, deviceId, ok: true });
    }

    // ── 以下全部需要 token ──
    const token = bearerOf(req) || url.searchParams.get('token') || '';
    const device = token ? state.devices.get(token) : null;
    if (!device) return sendJson(res, 401, { error: 'unauthorized', message: '未配对或 token 已失效，请重新扫码' });
    device.lastSeen = Date.now();

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
      ctx.logger?.warn?.(`[dsh-mobile-remote] 局域网服务启动失败：${e?.message || e}`);
      resolve({ server: null, port: null });
    });
    server.listen(Config.port, '0.0.0.0', () => {
      const addrs = lanAddresses();
      state.diagnostics.listens.push({ port: Config.port, at: Date.now() });
      ctx.logger?.info?.(
        `[dsh-mobile-remote] 局域网服务已监听 http://0.0.0.0:${Config.port}` +
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
  }, 'dsh-mobile-remote: approval bridge');
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
  }, 'dsh-mobile-remote: lan server');

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
        sendJson(response, 200, { ok: true, data: publicState(ctx) });
      },
    }));

    ctx.effect(() => () => { for (const d of disposers) { try { d?.(); } catch { } } }, 'dsh-mobile-remote: routes');
  });
}
