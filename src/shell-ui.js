"use strict";

/**
 * shell-ui.js —— 加载页与设置页共享的页面逻辑。
 *
 * 刻意用**普通脚本 + 全局对象**而不是 ES module：
 * 这两个页面是 `file://` 加载的，Chromium 对 `file://` 下的
 * `<script type="module">` 会按 CORS 拒掉（跨源模块请求），
 * 普通脚本没有这个限制。
 *
 * 这里只有"画界面 + 调 window.dshShell"两件事；
 * 真正做什么全部在主进程的 `diagnostics.js` 里。
 */

const ShellUI = (() => {

  const esc = (s) => String(s == null ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ── 鲸鱼 ────────────────────────────────────────────────────────
  /**
   * 把官方鲸鱼几何画进一个 <svg class="whale">。
   * @param {SVGElement} svg - 含 .w-bg/.w-g/.w-body/.w-belly/.w-eye/.w-spout 的骨架
   * @param {{body,belly,eye,spout}} paths
   * @param {number} scale - 鲸鱼在画布里的占比（0~1）
   */
  function setWhale(svg, paths, scale) {
    if (!svg || !paths) return;
    const pad = (50 * (1 - (scale || 0.9))) / 2;
    svg.querySelector(".w-g").setAttribute("transform", `translate(${pad} ${pad}) scale(${scale || 0.9})`);
    const put = (sel, d) => {
      const el = svg.querySelector(sel);
      if (el && typeof d === "string" && d) el.setAttribute("d", d);
    };
    put(".w-body", paths.body);
    put(".w-belly", paths.belly);
    put(".w-eye", paths.eye);
    put(".w-spout", paths.spout);
  }

  // ── 模态确认（不用 window.confirm：样式不可控，且在主进程里会被吞）──
  function confirmModal(message) {
    return new Promise((resolve) => {
      const wrap = document.createElement("div");
      wrap.className = "modal-backdrop";
      wrap.innerHTML =
        `<div class="modal" role="dialog" aria-modal="true">
           <div class="modal-title">请确认</div>
           <div class="modal-body">${esc(message)}</div>
           <div class="modal-foot">
             <button class="btn" data-act="no">取消</button>
             <button class="btn btn-danger" data-act="yes">确定执行</button>
           </div>
         </div>`;
      const done = (v) => { wrap.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
      const onKey = (e) => { if (e.key === "Escape") done(false); };
      wrap.addEventListener("click", (e) => {
        const act = e.target && e.target.getAttribute && e.target.getAttribute("data-act");
        if (act === "yes") done(true);
        else if (act === "no" || e.target === wrap) done(false);
      });
      document.addEventListener("keydown", onKey);
      document.body.appendChild(wrap);
      const yes = wrap.querySelector('[data-act="yes"]');
      if (yes) yes.focus();
    });
  }

  // ── 输出面板 ────────────────────────────────────────────────────
  function createOutput(preEl, clearBtn) {
    let atBottom = true;
    if (preEl) {
      preEl.addEventListener("scroll", () => {
        atBottom = preEl.scrollTop + preEl.clientHeight >= preEl.scrollHeight - 24;
      });
    }
    return {
      clear() { if (preEl) preEl.textContent = ""; },
      /** @param {"out"|"err"|"sys"|"ok"} stream */
      append(stream, text) {
        if (!preEl || !text) return;
        const span = document.createElement("span");
        if (stream === "err") span.className = "l-err";
        else if (stream === "sys") span.className = "l-sys";
        else if (stream === "ok") span.className = "l-ok";
        span.textContent = text;
        preEl.appendChild(span);
        if (atBottom) preEl.scrollTop = preEl.scrollHeight;
      },
      init(clear) { if (clearBtn) clearBtn.addEventListener("click", () => this.clear()); },
    };
  }

  // ── 动作列表 ────────────────────────────────────────────────────
  /**
   * 渲染「诊断与修复」按钮列表，并处理确认 / 运行 / 输出。
   *
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {ReturnType<createOutput>} opts.output
   * @param {HTMLElement} [opts.verdictEl]
   * @param {(runningId:string|null)=>void} [opts.onBusy]
   */
  async function mountActions(container, opts) {
    const output = opts.output;
    const verdictEl = opts.verdictEl || null;
    let running = null;
    let buttons = [];

    function setBusy(id) {
      running = id;
      buttons.forEach((b) => {
        b.disabled = !!id;
        const tag = b.querySelector(".tag-run");
        if (id === b.dataset.id) {
          if (!tag) b.querySelector(".action-top").insertAdjacentHTML("beforeend", `<span class="tag tag-run">运行中</span>`);
        } else if (tag) tag.remove();
      });
      if (opts.onBusy) opts.onBusy(id);
    }

    function showVerdict(cls, text) {
      if (!verdictEl) return;
      verdictEl.className = "verdict show " + cls;
      verdictEl.textContent = text;
    }

    async function exec(meta) {
      if (running) return;
      setBusy(meta.id);
      if (verdictEl) verdictEl.className = "verdict";
      output.append("sys", `\n=== ${meta.label} ===\n`);
      try {
        const r = await window.dshShell.runAction(meta.id);
        const ok = r && r.ok;
        output.append(ok ? "ok" : "err", `\n[${ok ? "成功" : "未成功"}] ${(r && r.message) || ""}\n`);
        if (ok) showVerdict("ok", `${meta.label}：${(r && r.message) || "完成"}`);
        else if (r && r.code === 2) showVerdict("warn", `${meta.label}：${(r && r.message) || "有警告"}`);
        else showVerdict("bad", `${meta.label}：${(r && r.message) || "失败"}`);
      } catch (e) {
        output.append("err", `\n[异常] ${(e && e.message) || e}\n`);
        showVerdict("bad", `${meta.label}：调用出错 ${(e && e.message) || e}`);
      } finally {
        setBusy(null);
      }
    }

    let list = [];
    try {
      list = await window.dshShell.listActions();
    } catch (e) {
      container.innerHTML = `<div class="action-desc">读不到动作清单：${esc((e && e.message) || e)}</div>`;
      return;
    }

    container.innerHTML = "";
    buttons = list.map((meta) => {
      const b = document.createElement("button");
      b.className = "action";
      b.dataset.id = meta.id;
      b.innerHTML =
        `<div class="action-top">
           <span class="action-label">${esc(meta.label)}</span>
           ${meta.danger ? '<span class="tag">会中断</span>' : ""}
         </div>
         <div class="action-desc">${esc(meta.desc)}</div>`;
      b.addEventListener("click", async () => {
        if (running) return;
        // ★ 危险动作先确认。确认文案来自主进程（diagnostics.js），页面不自造。
        if (meta.danger && meta.confirm) {
          const ok = await confirmModal(meta.confirm);
          if (!ok) return;
        }
        await exec(meta);
      });
      container.appendChild(b);
      return b;
    });
  }

  return { esc, setWhale, confirmModal, createOutput, mountActions };
})();
