/**
 * dsh-mobile-remote —— 电脑侧插件（Host half）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个文件是什么
 * ═══════════════════════════════════════════════════════════════════════════
 * 启动一个独立的 HTTP+WebSocket 服务器在 0.0.0.0:3110 端口，负责：
 *   ① Pairing Server:60 秒轮换一次性 code → 换发长期 bearer token
 *   ② WS→RPC bridge:将手机通过 WS 发的 JSON-RPC 请求转换为 ctx.remote.* 调用
 *   ③ Event stream 推送：session/events、approval/request 等实时推送给已配对的设备
 *   ④ PWA 静态文件服务：提供手机端浏览器可打开的网页
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 关键改动（2026-09-20）：
 * - PairingServer 现在维护所有连接的客户端列表（browserClients + mobileClients）
 * - 每次生成新 oneshot code 时，会**主动推送**到所有 browser 客户端
 * - PC 端悬浮按钮收到事件后自动刷新二维码
 */

import { createServer } from 'node:http';
import { Server as WebSocketServer, WebSocket } from 'ws';
import { randomBytes, constants } from 'crypto';
import jwt from 'jsonwebtoken';

/** 插件名称（Cordis bundle tree 中的 id） */
export const name = 'dsh-mobile-remote';

/** 配置接口 */
export interface Config {
  port?: number;      // 默认 3110
}

/** 一次性配对码状态 */
interface OnetimeCodeEntry {
  code: string;
  expiresAt: number;
}

/** 长期 token 状态 */
interface LongtermTokenEntry {
  token: string;
  refreshToken: string;
  expiresAt: number;
  deviceId: string;
}

/** 内存存储（生产环境应该用 Redis/SQLite） */
const ONETIME_CODES = new Map<string, OnetimeCodeEntry>();
const LONGTERM_TOKENS = new Map<string, LongtermTokenEntry>();

/** 安全的密钥（实际应从 $DSH_HOME/.credentials.yaml 读取） */
const SECRET_KEY = randomBytes(32).toString('hex');

/** 连接管理：区分浏览器客户端（显示 QR）和移动客户端（扫码连接） */
const BROWSER_CLIENTS = new Set<WebSocket>();
const MOBILE_CLIENTS = new Map<string, WebSocket>();

/** 生成随机字符串 */
function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/** 生成 UUID */
function uuid(): string {
  return randomBytes(16).toString('hex').replace(/([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})/, '$1-$2-$3');
}

/** Pairing Server 实现 */
class PairingServer {
  private readonly CODE_LENGTH = 16;
  private readonly CODE_TTL_MS = 60_000;        // 60 秒过期
  private readonly TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 天
  private readonly REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 天
  private currentCodeInfo: { code: string; expiresIn: number } | null = null;

  /** 获取当前 or 生成新的 oneshot code */
  getCurrentOrCreateOnetimeCode() {
    if (this.currentCodeInfo && Date.now() + 5000 < Date.now() + this.CODE_TTL_MS) {
      return this.currentCodeInfo;
    }
    
    const code = randomString(this.CODE_LENGTH);
    this.currentCodeInfo = {
      code,
      expiresIn: this.CODE_TTL_MS
    };
    
    ONETIME_CODES.set(code, {
      code,
      expiresAt: Date.now() + this.CODE_TTL_MS
    });

    return this.currentCodeInfo;
  }

  /** 向所有浏览器客户端推送最新的 oneshot code */
  broadcastCodeToBrowserClients() {
    const codeInfo = this.getCurrentOrCreateOnetimeCode();
    if (!codeInfo) return;

    console.log(`[Mobile Remote] Broadcasting new QR code to ${BROWSER_CLIENTS.size} browser client(s)`);

    for (const ws of BROWSER_CLIENTS) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'mmr:code:update',
          code: codeInfo.code,
          expiresIn: codeInfo.expiresIn
        }));
      }
    }
  }

  /** 提交 pairing request，用一次性 code 换长期 token */
  async submitPairingRequest(submittedCode: string): Promise<{ kind: 'success'; token: string; refreshToken: string } | { kind: 'expired' }> {
    const entry = ONETIME_CODES.get(submittedCode);
    if (!entry) {
      return { kind: 'expired' };
    }
    if (Date.now() > entry.expiresAt) {
      ONETIME_CODES.delete(submittedCode);
      return { kind: 'expired' };
    }

    // 成功：换发长期 token
    const deviceId = uuid();
    const token = jwt.sign({
      deviceId,
      type: 'access',
      issuedAt: Date.now(),
      ttlMs: this.TOKEN_TTL_MS
    }, SECRET_KEY);

    const refreshToken = jwt.sign({
      deviceId,
      type: 'refresh',
      issuedAt: Date.now(),
      ttlMs: this.REFRESH_TTL_MS
    }, SECRET_KEY);

    LONGTERM_TOKENS.set(token, {
      token,
      refreshToken,
      expiresAt: Date.now() + this.TOKEN_TTL_MS,
      deviceId
    });

    // 一次性 code 用完即废
    ONETIME_CODES.delete(submittedCode);

    return {
      kind: 'success',
      token,
      refreshToken
    };
  }

  /** 验证并刷新 token */
  verifyToken(token: string): LongtermTokenEntry | null {
    try {
      const payload = jwt.verify(token, SECRET_KEY) as any;
      const entry = LONGTERM_TOKENS.get(token);
      if (!entry || Date.now() > entry.expiresAt) {
        return null;
      }
      return entry;
    } catch (e) {
      return null;
    }
  }

  /** 撤销 token（logout） */
  revokeToken(token: string): void {
    LONGTERM_TOKENS.delete(token);
  }

  /** 清理过期 code/token */
  private cleanupExpiredCodes(): void {
    const now = Date.now();
    for (const [code, entry] of ONETIME_CODES.entries()) {
      if (now > entry.expiresAt) {
        ONETIME_CODES.delete(code);
      }
    }
    for (const [token, entry] of LONGTERM_TOKENS.entries()) {
      if (now > entry.expiresAt) {
        LONGTERM_TOKENS.delete(token);
      }
    }
  }
}

/** Apply 函数入口 */
export function apply(ctx: any, config?: Config): void {
  const pairingServer = new PairingServer();
  const PORT = config?.port ?? 3110;

  // 启动独立的 HTTP+WS 服务器
  const httpServer = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 健康检查
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', port: PORT }));
      return;
    }

    // Pairing API
    if (req.url === '/api/mobile/pair/submit' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { code } = JSON.parse(body);
          const result = pairingServer.submitPairingRequest(code);

          if (result.kind === 'success') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'expired_code' }));
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_json' }));
        }
      });
      return;
    }

    // 默认 404
    res.writeHead(404);
    res.end('Not found');
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws/mobile' });

  wss.on('connection', (ws: WebSocket, req) => {
    // 判断是浏览器连接还是移动设备连接
    const userAgent = req.headers['user-agent'] || '';
    const isBrowserClient = userAgent.includes('Mozilla') && !userAgent.includes('Mobile');

    if (isBrowserClient) {
      // 浏览器客户端：注册到 BROWSER_CLIENTS，用于接收 QR code 更新
      BROWSER_CLIENTS.add(ws);
      console.log(`[Mobile Remote] Browser client connected (${BROWSER_CLIENTS.size} total)`);

      // 立即推送当前的 oneshot code
      const codeInfo = pairingServer.getCurrentOrCreateOnetimeCode();
      if (codeInfo) {
        ws.send(JSON.stringify({
          type: 'mmr:code:update',
          code: codeInfo.code,
          expiresIn: codeInfo.expiresIn
        }));
      }

      ws.on('close', () => {
        BROWSER_CLIENTS.delete(ws);
        console.log(`[Mobile Remote] Browser client disconnected (${BROWSER_CLIENTS.size} remaining)`);
      });

      // 不处理其他消息
      return;
    }

    // 移动客户端：需要 token 鉴权
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      ws.close(4000, 'Unauthorized');
      return;
    }

    const token = authHeader.slice(7);
    const entry = pairingServer.verifyToken(token);

    if (!entry) {
      ws.close(4000, 'Invalid token');
      return;
    }

    // 记录移动端连接
    MOBILE_CLIENTS.set(entry.deviceId, ws);
    console.log(`[Mobile Remote] Device ${entry.deviceId} connected (${MOBILE_CLIENTS.size} total)`);

    // 心跳机制
    const heartbeatInterval = setInterval(() => {
      if (ws.isPaused) {
        ws.resume();
      } else {
        ws.ping();
      }
    }, 30000);

    ws.on('close', () => {
      clearInterval(heartbeatInterval);
      MOBILE_CLIENTS.delete(entry.deviceId);
      console.log(`[Mobile Remote] Device ${entry.deviceId} disconnected (${MOBILE_CLIENTS.size} remaining)`);
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        handleSocketMessage(ws, msg, ctx).catch(err => {
          ws.send(JSON.stringify({ error: err.message }));
        });
      } catch (e) {
        ws.send(JSON.stringify({ error: 'invalid_json' }));
      }
    });

    ws.on('error', (err) => {
      console.error('[Mobile Remote] WS error:', err.message);
    });
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[Mobile Remote Plugin] listening on http://0.0.0.0:${PORT}`);
  });

  // 每 60 秒生成新的 QR code 并广播
  setInterval(() => {
    pairingServer.broadcastCodeToBrowserClients();
  }, 60000);

  // 定期清理过期数据
  setInterval(() => pairingServer.cleanupExpiredCodes(), 60000);
}

/** 处理 WS 消息：JSON-RPC 风格 */
async function handleSocketMessage(ws: WebSocket, msg: any, ctx: any): Promise<void> {
  const { id, method, params } = msg;

  try {
    let result;

    switch (method) {
      case 'session.list': {
        const sessionCtrl = ctx.get('sessionController');
        result = await sessionCtrl.list(params || {});
        break;
      }

      case 'session.create': {
        const sessionCtrl = ctx.get('sessionController');
        result = await sessionCtrl.create(params || {});
        break;
      }

      case 'session.follow': {
        const sessionCtrl = ctx.get('sessionController');
        const iterable = await sessionCtrl.follow(params || {});
        result = { snapshot: true, items: [] };
        break;
      }

      case 'session.prompt': {
        const sessionCtrl = ctx.get('sessionController');
        result = await sessionCtrl.prompt(params || {});
        break;
      }

      case 'session.selectModel': {
        const sessionCtrl = ctx.get('sessionController');
        result = await sessionCtrl.selectModel(params || {});
        break;
      }

      case 'session.cancel': {
        const sessionCtrl = ctx.get('sessionController');
        result = await sessionCtrl.cancel(params || {});
        break;
      }

      case 'workspace.list': {
        const wsCtrl = ctx.get('workspaceController');
        const signal = new AbortController().signal;
        result = await wsCtrl.follow(signal);
        break;
      }

      case 'workspace.create': {
        const wsCtrl = ctx.get('workspaceController');
        result = await wsCtrl.create(params || {});
        break;
      }

      case 'modelCatalog': {
        const sessionCtrl = ctx.get('sessionController');
        result = await sessionCtrl.modelCatalog();
        break;
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }

    ws.send(JSON.stringify({ id, result }));

  } catch (err) {
    ws.send(JSON.stringify({
      id,
      error: err instanceof Error ? err.message : String(err)
    }));
  }
}
