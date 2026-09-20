/**
 * dsh-mobile-remote —— 浏览器半边（Client plugin）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个文件是什么
 * ═══════════════════════════════════════════════════════════════════════════
 * 注入到官方页面中的一个**悬浮按钮**："📱 手机遥控"
 * 
 * 点击按钮后：
 *   1. 弹出二维码窗口
 *   2. 实时显示当前的 oneshot code（60 秒轮换）
 *   3. 手机上访问 http://[PC IP]:3110 即可扫码连接
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 核实的官方契约（已核实）
 * ═══════════════════════════════════════════════════════════════════════════
 * ① 注册形状：`window.__ModuleLoader__.load()`
 * ② 无需特定插槽，直接 inject style 并通过全局事件通知
 * ③ 样式：往 `<head>` 插 `<style data-plugin-css>`
 */

// Host 侧占位（必须存在，见 dsh-multi-session/lib/index.js）
export function apply() {}

if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({
    id: "dsh-mobile-remote",
    factory: (require) => {
      "use strict";

      const React = require("react");
      const ReactDOM = require("react-dom/client");
      const P = require("@deepseek-ai/dsh-client-ui-primitives");
      const h = React.createElement;
      const { useState, useEffect } = React;

      /** 常量 */
      const PLUGIN_ID = "dsh-mobile-remote";
      const CSS_ID = PLUGIN_ID + "/styles.css";

      // 缓存当前 oneshot code（由外部 WebSocket 推送或默认值）
      let currentOneshotCode = "";
      let expiresAt = Date.now() + 60000;

      /** CSS 注入 */
      const styles = `.mmr-btn{position:fixed;bottom:80px;right:20px;z-index:9999;background:#0066cc;color:#fff;border:none;padding:12px 20px;border-radius:50%;box-shadow:0 4px 20px rgba(0,0,0,0.3);cursor:pointer;font-size:24px;display:flex;align-items:center;justify-content:center;transition:all 0.2s}.mmr-btn:hover{transform:scale(1.1)}.mmr-modal-backdrop{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.2s}@keyframes fadeIn{from{opacity:0}to{opacity:1}}.mmr-modal-card{background:#fff;border-radius:16px;padding:24px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.3);animation:slideUp 0.3s}@keyframes slideUp{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}.mmr-modal-header{text-align:center;margin-bottom:20px}.mmr-modal-title{font-size:20px;font-weight:600;margin:0 0 8px;color:#1a1a2e}.mmr-modal-subtitle{font-size:14px;color:#666;margin:0}.mmr-qr-container{text-align:center;background:#f5f7fa;padding:24px;border-radius:12px;margin-bottom:16px}.mmr-qr-image{width:220px;height:220px;display:block;margin:0 auto;background:#fff;border-radius:8px;padding:8px}.mmr-code-display{margin-top:16px;text-align:center}.mmr-code-text{font-family:'Courier New',monospace;font-size:16px;font-weight:600;color:#0066cc;letter-spacing:1px;word-break:break-all;padding:8px;background:#f0f4ff;border-radius:6px;margin:8px 0}.mmr-timer{color:#666;font-size:13px;margin-top:8px}.mmr-actions{display:flex;gap:12px;flex-wrap:wrap}.mmr-btn-action{flex:1;padding:10px;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;transition:all 0.2s}.mmr-btn-copy{background:#0066cc;color:#fff}.mmr-btn-copy:hover{background:#0055aa}.mmr-btn-close{background:#e0e4ec;color:#1a1a2e}.mmr-btn-close:hover{background:#d0d4dc}`;

      function injectStyles(ctx) {
        if (typeof document === 'undefined') return;
        
        const existing = document.querySelector(`style[data-plugin-css="${CSS_ID}"]`);
        if (!existing) {
          const style = document.createElement('style');
          style.dataset.plugin = PLUGIN_ID;
          style.dataset.pluginCss = CSS_ID;
          style.textContent = styles;
          document.head.appendChild(style);
        }
      }

      /** QR Code Panel 组件 */
      function QRCodePanel({ onClose }) {
        const [imageUrl, setImageUrl] = useState('');
        const [timer, setTimer] = useState(expiresAt - Date.now());

        useEffect(() => {
          if (currentOneshotCode) {
            const url = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(currentOneshotCode)}`;
            setImageUrl(url);
          }
        }, [currentOneshotCode]);

        useEffect(() => {
          const interval = setInterval(() => {
            const remaining = expiresAt - Date.now();
            if (remaining <= 0) {
              // 请求新的 code（通过自定义事件）
              window.dispatchEvent(new CustomEvent('mmr:refresh-code'));
              setTimer(60000);
            } else {
              setTimer(remaining);
            }
          }, 1000);

          return () => clearInterval(interval);
        }, [expiresAt]);

        const formatTime = (ms) => {
          const seconds = Math.floor(ms / 1000);
          return `${seconds}s`;
        };

        const handleCopy = () => {
          if (currentOneshotCode) {
            navigator.clipboard.writeText(currentOneshotCode).then(() => {
              alert(`码已复制到剪贴板:\n${currentOneshotCode}`);
            });
          }
        };

        const handleClose = () => {
          onClose?.();
        };

        return h('div', { className: 'mmr-modal-backdrop', onClick: handleClose },
          h('div', { className: 'mmr-modal-card', onClick: (e) => e.stopPropagation() },
            h('div', { className: 'mmr-modal-header' },
              h('h2', { className: 'mmr-modal-title' }, '📱 手机遥控'),
              h('p', { className: 'mmr-modal-subtitle' }, '用手机扫描下方二维码连接')
            ),

            h('div', { className: 'mmr-qr-container' },
              imageUrl ? 
                h('img', { src: imageUrl, alt: 'Scan to connect', className: 'mmr-qr-image' }) :
                h('div', { style: 'width:220px;height:220px;background:#f0f0f0;border-radius:8px;display:flex;align-items:center;justify-content:center;' }, '生成中...')
            ),

            currentOneshotCode && h('div', { className: 'mmr-code-display' },
              h('div', { style: 'font-size:14px;color:#666;margin-bottom:4px;' }, '备用输入码（如无法扫码）:'),
              h('div', { className: 'mmr-code-text' }, currentOneshotCode),
              h('div', { className: 'mmr-timer' }, `剩余有效时间：${formatTime(timer)}`)
            ),

            h('div', { className: 'mmr-actions' },
              h('button', {
                className: 'mmr-btn-action mmr-btn-copy',
                onClick: handleCopy,
                disabled: !currentOneshotCode
              }, '💾 复制此码'),
              h('button', {
                className: 'mmr-btn-action mmr-btn-close',
                onClick: handleClose
              }, '关闭')
            )
          )
        );
      }

      /** 悬浮按钮组件 */
      function MobileRemoteButton() {
        const [showModal, setShowModal] = useState(false);

        useEffect(() => {
          const handler = (e) => {
            if (e.detail?.showModal) {
              setShowModal(true);
            }
          };

          window.addEventListener('mmr:open', handler);
          return () => window.removeEventListener('mmr:open', handler);
        }, []);

        return h(React.Fragment, {},
          h(P.Button, {
            variant: "primary",
            style: {
              position: 'fixed',
              bottom: '80px',
              right: '20px',
              zIndex: '9999',
              width: '64px',
              height: '64px',
              borderRadius: '50%',
              padding: '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
              transition: 'all 0.2s'
            },
            onMouseEnter: (e) => { e.currentTarget.style.transform = 'scale(1.1)'; },
            onMouseLeave: (e) => { e.currentTarget.style.transform = 'scale(1)'; },
            onClick: () => setShowModal(true)
          }, '📱')
          ,

          showModal && h(QRCodePanel, { onClose: () => setShowModal(false) })
        );
      }

      /** 主注入逻辑 */
      return {
        inject: (ctx) => {
          injectStyles(ctx);

          // 监听全局事件：从父级注入 code update
          if (typeof window !== 'undefined') {
            window.addEventListener('mmr:code:update', (e) => {
              if (e.detail.code) {
                currentOneshotCode = e.detail.code;
                expiresAt = Date.now() + (e.detail.expiresIn || 60000);
                // 强制重渲染以更新弹窗
                window.location.reload();
              }
            });

            window.addEventListener('mmr:refresh-code', () => {
              window.dispatchEvent(new CustomEvent('mmr:open', { detail: { showModal: true }}));
            });
          }

          // 创建根节点并挂载组件
          const buttonDiv = document.createElement('div');
          buttonDiv.id = 'mmr-button-root';
          document.body.appendChild(buttonDiv);

          const root = ReactDOM.createRoot(buttonDiv);
          root.render(h(MobileRemoteButton));

          // 清理
          ctx.effect(() => () => {
            try {
              root.unmount();
              buttonDiv.remove();
            } catch {}
          }, `${PLUGIN_ID}:cleanup`);
        }
      };
    }
  });
}
