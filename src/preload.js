"use strict";

/**
 * preload.js —— 外壳自有页面（加载页 / 设置页）与主进程之间的**唯一**通道。
 *
 * ══════════════════════════════════════════════════════════════════
 * 安全设计（这份文件是外壳的信任边界，改之前先读完）
 * ══════════════════════════════════════════════════════════════════
 * 1. **渲染进程永远拿不到命令字符串。**
 *    它只能提交一个**动作 id**；id → 具体做什么，写死在主进程的
 *    `diagnostics.js` 白名单里。就算这个页面被注入了脚本，
 *    它能做的也只是"点一下我们本来就提供的那几个按钮"。
 *
 * 2. **主进程还会再判一次来源**（`main.js` 的 `assertShellSender`）：
 *    只有"当前正在显示外壳自有页面"时才受理。官方 UI 页面（http://…）
 *    即使拿到了 window.dshShell，调用也会被拒。
 *
 * 3. 只暴露必须的几件事，**不暴露 ipcRenderer 本身**，
 *    也没有 `require` / `process` / 任意 `invoke(channel, ...)` 的通道。
 */

const { contextBridge, ipcRenderer } = require("electron");

/** 订阅一个主进程事件，返回退订函数。 */
function subscribe(channel, cb) {
  if (typeof cb !== "function") return () => { };
  const handler = (_event, payload) => {
    try { cb(payload); } catch (e) { /* 页面自己的异常不该炸掉通道 */ }
  };
  ipcRenderer.on(channel, handler);
  return () => { try { ipcRenderer.removeListener(channel, handler); } catch (e) { } };
}

contextBridge.exposeInMainWorld("dshShell", {
  // ── 诊断与修复 ────────────────────────────────────────────────
  /** 列出可用动作（只有元数据，没有命令）。 */
  listActions: () => ipcRenderer.invoke("dsh:diag:list"),
  /** 执行一个动作 id。返回 { ok, code, message }。输出通过 onOutput 流式推送。 */
  runAction: (id) => ipcRenderer.invoke("dsh:diag:run", String(id)),
  /** 请求中止正在跑的动作。 */
  cancelAction: () => ipcRenderer.invoke("dsh:diag:cancel"),
  /** 动作的输出分片：{ id, stream: "out"|"err"|"sys", text } */
  onOutput: (cb) => subscribe("dsh:diag:out", cb),
  /** 动作开始/结束：{ id, phase: "start"|"end", ok?, code? } */
  onActionState: (cb) => subscribe("dsh:diag:state", cb),

  // ── 启动状态（加载页用） ──────────────────────────────────────
  /** 当前状态快照。带 seq，页面据此丢弃过期事件。 */
  getSnapshot: () => ipcRenderer.invoke("dsh:state"),
  /** 状态变化：{ seq, phase, title, detail, percent, stages, failed } */
  onStatus: (cb) => subscribe("dsh:status", cb),

  // ── 设置 ──────────────────────────────────────────────────────
  /** 写入一项设置。返回更新后的完整设置对象。 */
  setSetting: (key, value) => ipcRenderer.invoke("dsh:setting:set", String(key), value),
  /** 打开设置窗口（加载页底部入口用）。 */
  openSettings: () => ipcRenderer.invoke("dsh:settings:open"),
  /** 关掉当前窗口（设置窗口的"关闭"按钮用；主窗口忽略此调用）。 */
  closeSelf: () => ipcRenderer.invoke("dsh:window:close"),
  /** 用系统资源管理器打开一个**白名单内**的位置：'dsh-home' | 'logs' | 'app' */
  openLocation: (which) => ipcRenderer.invoke("dsh:open-location", String(which)),
  /** 弹系统目录选择框。返回 { ok, path?, message? }。 */
  pickDirectory: (startAt) => ipcRenderer.invoke("dsh:pick-directory", startAt ? String(startAt) : null),

  // ── 只读环境信息（关于页/诊断信息用） ────────────────────────
  getEnv: () => ipcRenderer.invoke("dsh:env"),
});
