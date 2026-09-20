/**
 * dsh-mobile-remote —— 浏览器半边（客户端插件）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 它做什么
 * ═══════════════════════════════════════════════════════════════════════════
 * 在官方界面右下角挂一个悬浮按钮「📱」。点开后是一个大弹窗，里面是**手机遥控的
 * 配对二维码**：用手机系统相机扫一下，直接打开手机端页面、自动完成配对。
 * 弹窗里还有：配对码（手输备用）、局域网地址、已配对设备数、"换一张码"、"全部断开"。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 与上一版的关键差别（每一条都是实测踩出来的）
 * ═══════════════════════════════════════════════════════════════════════════
 * ① **本文件必须是"经典脚本"，不能有顶层 `export`。**
 *    客户端 bundle 由 `dsh-client-modules` 用 `document.createElement("script")`
 *    + `el.src` 加载（`dsh-client-modules/lib/client.js:146-159`，**没有 type=module**）
 *    ⇒ 顶层 `export` 是语法错误，脚本静默加载失败、插件在界面上**根本不出现**。
 *    上一版就是 `export function apply() {}` 死在这里。
 *    （对照：dsh-multi-session 与 dsh-crosshub 的 client.js 顶层 export 计数都是 0。）
 *
 * ② **`inject` 是字符串数组，`apply` 才是函数。**
 *    上一版返回 `{ inject: (ctx) => {...} }` —— 契约要求 `inject` 是**依赖声明数组**，
 *    写成函数等于没声明依赖、也没注册任何东西。
 *
 * ③ **必须真的注册槽位。** 上一版只往 `document.body` 挂了个 div，
 *    全文 `ctx.slots.inject/register` 出现 0 次 ⇒ 界面上没有挂载点。
 *
 * ④ **弹窗 portal 到 `document.body`。** `shell.overlay` 那层是 z-index:20，
 *    任何 z-index > 20 的官方 UI 都会盖在弹窗上面（项目 AGENTS.md §3 有实测活例）。
 *
 * ⑤ **二维码由宿主半边生成成 SVG 文本**，这里只负责显示。
 *    上一版用外网 `api.qrserver.com` ⇒ 断网即废，而且编的是裸配对码、不是可扫的 URL。
 */

window.__ModuleLoader__.load({
  id: 'dsh-mobile-remote',
  factory: (require) => {
    'use strict';

    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const PLUGIN_ID = 'dsh-mobile-remote';
    const CSS_ID = PLUGIN_ID + '/styles.css';
    const TRIGGER_SLOT = 'shell.overlay';
    const TRIGGER_ID = 'mobile-remote-trigger';
    const ROUTE = '/dsh-mobile-remote';

    /** 诊断：槽位挂没挂上必须看得见，不许静默吞（dsh-crosshub 源码里的事故）。 */
    const diagnostics = { slots: {}, errors: [], at: new Date().toISOString() };

    function recordSlot(id, ok, message) {
      diagnostics.slots[id] = ok ? { ok: true } : { ok: false, message: String(message || '') };
      if (!ok) diagnostics.errors.push(id + ': ' + String(message || ''));
    }

    function safeRegister(ctx, options, component) {
      try {
        const d = ctx.slots.register(options, component);
        recordSlot(options.id, true);
        return typeof d === 'function' ? d : () => {};
      } catch (e) {
        recordSlot(options.id, false, (e && e.message) ? e.message : String(e));
        return () => {};
      }
    }

    const CSS = `
.mmr-fab{position:fixed;right:18px;bottom:18px;z-index:9998;width:52px;height:52px;border-radius:50%;
  border:1px solid var(--dsw-alias-border-l2,#3a3f4b);background:var(--dsw-alias-bg-layer-1,#1c1d21);
  color:var(--dsw-alias-label-primary,#e8e8ea);font-size:22px;line-height:1;cursor:pointer;
  box-shadow:0 6px 22px rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center}
.mmr-fab:hover{transform:scale(1.06)}
.mmr-mask{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
  padding:20px;box-sizing:border-box;background:rgba(0,0,0,.5)}
.mmr-panel{width:min(420px,94vw);max-height:92vh;overflow:auto;box-sizing:border-box;
  background:var(--dsw-alias-bg-layer-1,#1c1d21);color:var(--dsw-alias-label-primary,#e8e8ea);
  border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:14px;
  box-shadow:0 18px 60px rgba(0,0,0,.5)}
.mmr-head{display:flex;align-items:center;gap:8px;padding:13px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#3a3f4b)}
.mmr-head h3{margin:0;font-size:15px;font-weight:600}
.mmr-x{margin-left:auto;background:transparent;border:0;color:inherit;font-size:18px;cursor:pointer;padding:4px 8px;border-radius:7px}
.mmr-x:hover{background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.08))}
.mmr-body{padding:16px;display:flex;flex-direction:column;gap:13px;align-items:center}
.mmr-qr{width:236px;height:236px;background:#fff;border-radius:10px;padding:8px;box-sizing:border-box;
  display:flex;align-items:center;justify-content:center}
.mmr-qr.small{width:168px;height:168px}
.mmr-qr svg{width:100%;height:100%;display:block}
.mmr-qr-label{font-size:12.5px;opacity:.8;text-align:center;margin-bottom:-4px}
.mmr-code{font:600 22px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:4px;
  padding:9px 14px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));
  border:1px solid var(--dsw-alias-border-l2,#3a3f4b)}
.mmr-line{font-size:12.5px;opacity:.72;text-align:center;word-break:break-all;line-height:1.6}
.mmr-timer{font-size:12.5px;opacity:.72}
.mmr-actions{display:flex;gap:8px;width:100%;flex-wrap:wrap}
.mmr-btn{flex:1;min-width:104px;padding:9px 12px;border-radius:9px;cursor:pointer;font-size:13.5px;
  border:1px solid var(--dsw-alias-border-l2,#3a3f4b);background:transparent;color:inherit}
.mmr-btn:hover{background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.08))}
.mmr-btn.primary{background:var(--dsw-alias-state-success-primary,#3b82f6);border-color:transparent;color:#fff}
.mmr-btn.danger{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.mmr-err{font-size:12.5px;color:var(--dsw-alias-state-error-primary,#ff6b6b);text-align:center;white-space:pre-wrap}
.mmr-ok{font-size:12.5px;color:var(--dsw-alias-state-success-primary,#4ade80);text-align:center}
`;

    function installCss(ctx) {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')) return;
      const el = document.createElement('style');
      el.setAttribute('data-plugin', PLUGIN_ID);
      el.setAttribute('data-plugin-css', CSS_ID);
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    /** 从同源路由取状态。同源 ⇒ 无跨域、无 CSP 问题。 */
    async function fetchState() {
      const r = await fetch(ROUTE + '/state', { headers: { accept: 'application/json' } });
      const j = await r.json();
      if (!j || j.ok === false) throw new Error((j && j.message) || '读取失败');
      return j.data;
    }

    function Panel({ onClose }) {
      const [state, setState] = useState(null);
      const [err, setErr] = useState(null);
      const [note, setNote] = useState(null);
      const [tick, setTick] = useState(0);

      const reload = useCallback(() => {
        setErr(null);
        fetchState().then(setState).catch((e) => setErr(e.message));
      }, []);

      useEffect(() => { reload(); }, [reload]);

      // 倒计时：只为了让"还剩多久过期"动起来
      useEffect(() => {
        const t = setInterval(() => setTick((n) => n + 1), 1000);
        return () => clearInterval(t);
      }, []);

      // 码过期就自动换一张（否则用户盯着一张死码扫）
      const left = state ? Math.max(0, state.expiresIn - tick * 1000) : 0;
      useEffect(() => {
        if (state && left <= 0) { reload(); }
      }, [left, state, reload]);

      async function rotate() {
        setNote(null);
        try {
          const r = await fetch(ROUTE + '/rotate', { method: 'POST' });
          const j = await r.json();
          setState(j.data);
          setNote('已换新码');
        } catch (e) { setErr(e.message); }
      }

      async function revoke() {
        setNote(null);
        try {
          const r = await fetch(ROUTE + '/revoke', { method: 'POST' });
          const j = await r.json();
          setState(j.data);
          setNote('已断开全部手机');
        } catch (e) { setErr(e.message); }
      }

      return h('div', { className: 'mmr-mask', onClick: onClose },
        h('div', { className: 'mmr-panel', onClick: (e) => e.stopPropagation() },
          h('div', { className: 'mmr-head' },
            h('h3', null, '📱 手机遥控'),
            h('button', { className: 'mmr-x', onClick: onClose, title: '关闭' }, '✕'),
          ),
          h('div', { className: 'mmr-body' },
            err ? h('div', { className: 'mmr-err' }, '读取失败：' + err) : null,

            // ── ① 通用二维码：任何手机相机都能扫，开浏览器（没装 App 也能用）──
            h('div', { className: 'mmr-qr-label' }, '① 用相机扫（打开浏览器，无需装 App）'),
            state && state.qrSvg
              ? h('div', { className: 'mmr-qr', dangerouslySetInnerHTML: { __html: state.qrSvg } })
              : h('div', { className: 'mmr-qr' }, h('span', { style: { color: '#888', fontSize: '12px' } },
                  state ? '未找到局域网地址' : '生成中…')),

            // ── ② App 专用二维码：装了「手机遥控」App 就扫这个，直接进 App ──
            state && state.qrSvgApp
              ? h('div', { className: 'mmr-qr-label' }, '② 装了「手机遥控」App 的扫这个（直接进 App）')
              : null,
            state && state.qrSvgApp
              ? h('div', { className: 'mmr-qr small', dangerouslySetInnerHTML: { __html: state.qrSvgApp } })
              : null,

            state && state.code ? h('div', { className: 'mmr-code' }, state.code) : null,

            h('div', { className: 'mmr-line' },
              state
                ? (state.ip
                    ? '手机连同一个 Wi-Fi，扫码或访问 ' + state.ip + ':' + state.port
                    : '未找到局域网地址：确认电脑已连上 Wi-Fi / 网线')
                : ''),

            state ? h('div', { className: 'mmr-timer' },
              left > 0 ? '配对码 ' + Math.ceil(left / 1000) + ' 秒后自动更换' : '正在更换…') : null,

            state && state.paired
              ? h('div', { className: 'mmr-ok' }, '已配对 ' + state.paired + ' 台设备')
              : null,

            note ? h('div', { className: 'mmr-ok' }, note) : null,

            h('div', { className: 'mmr-actions' },
              h('button', { className: 'mmr-btn', onClick: rotate }, '换一张码'),
              state && state.paired
                ? h('button', { className: 'mmr-btn danger', onClick: revoke }, '断开全部手机')
                : null,
            ),

            h('div', { className: 'mmr-line' },
              '扫码后手机可查看会话、看流式输出、发消息、中断当前任务。'),
            h('div', { className: 'mmr-line' },
              '⚠ 同一局域网内可用；流量未加密，请勿在公共 Wi-Fi 下使用。'),
          ),
        ),
      );
    }

    function Trigger() {
      const [open, setOpen] = useState(false);

      /**
       * ★ 连**按钮本身**也要 portal 到 `document.body`，不只是弹窗。
       *
       * 实测（2026-09-20，临时环境）：按钮放在 `shell.overlay` 槽位里时，
       * 它的祖先链是 `_root_w1urq_2 { z-index:1000; position:fixed }` 下的
       * `shell.overlay { z-index:20 }` ⇒ 按钮自己写 `z-index:9998` **没用**：
       * 它被关在 z-index:20 那个层叠上下文里，而官方那个 z-index:1000 的根遮罩
       * （`_mask_w1urq_14`，`aria-hidden="true"` 的空 div）盖在它上面。
       * 判据用的是 `document.elementFromPoint(按钮中心)` —— 命中的是**别的元素**，
       * 也就是项目 AGENTS.md §5 里那条："看得见"不能用 `getBoundingClientRect()` 判，
       * 它返回的是**未裁切**的几何，被盖住时矩形照样正常 ⇒ 假 PASS。
       * 挂到 body 之后直接在根层叠上下文里比大小（9998 > 1000），才真的在最上层。
       */
      const portal = (node) => (typeof document === 'undefined' ? node : ReactDOM.createPortal(node, document.body));

      return h(React.Fragment, null,
        portal(h('button', {
          className: 'mmr-fab',
          title: '手机遥控',
          onClick: () => setOpen(true),
        }, '📱')),
        open ? portal(h(Panel, { onClose: () => setOpen(false) })) : null,
      );
    }

    /**
     * ★ `inject` 里写的是 **cordis 服务名**，不是 npm 包名。
     *
     * 这是本次实测踩到的坑（2026-09-20，临时环境真跑）：
     *   写成 `['@deepseek-ai/dsh-client-ui-slots']` ⇒ 插件**永远停在 pending**：
     *     Error: web boot: 1 entry did not activate
     *       dsh-mobile-remote: pending (waiting for service: @deepseek-ai/dsh-client-ui-slots)
     *   ⇒ 界面里什么都没有，而插件自己的代码**一行都没跑**（所以也不会报错）。
     *   包名只属于 `dsh.client.inject`（那份是给 `dsh-client-modules` 组合 bundle 用的）；
     *   这里的 `inject` 是 cordis 的依赖声明，`slots` 才是服务名
     *   （对照 dsh-multi-session 的 client.js：`const inject = ["slots", "sessions", …]`，
     *    且它源码里就写着"写进一个不存在的服务名 = 插件永远不 apply、且没有报错"）。
     */
    const inject = ['slots'];

    function apply(ctx) {
      installCss(ctx);
      ctx.slots.inject(TRIGGER_SLOT, () => safeRegister(ctx,
        { name: TRIGGER_SLOT, id: TRIGGER_ID, order: 60, label: '手机遥控' },
        () => h(Trigger, { ctx }),
      ));

      try {
        globalThis.__dshMobileRemote = {
          plugin: PLUGIN_ID,
          diagnostics,
          open: () => { /* 供自动化验证：点不到按钮时也能开 */ },
        };
      } catch (e) { /* 没有 window 就算了 */ }
    }

    return { name: PLUGIN_ID, inject, apply };
  },
});
