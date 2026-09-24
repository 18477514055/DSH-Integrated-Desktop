"use strict";

/**
 * status-page.js —— 加载页（同时也承担"启动失败"页）的页面逻辑。
 *
 * 数据全部来自主进程：页面自己不知道内核、端口、档案这些事，
 * 只是把 `dsh:state` 快照与 `dsh:status` 事件画出来。
 *
 * ★ 用 `seq` 丢弃过期消息：页面订阅事件与拉快照之间有一个竞态窗口，
 *   没有序号的话，可能用一份**更旧**的快照覆盖掉刚收到的新事件
 *   （表现是进度条倒退 / 卡在"正在启动"）。
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const S = window.dshShell;

  const elTitle = $("title");
  const elStageText = $("stagetext");
  const elBar = $("bar");
  const elBarFill = $("barfill");
  const elBarMeta = $("barmeta");
  const elStages = $("stages");
  const elDetail = $("detail");
  const elVerdict = $("verdict");
  const sheet = $("sheet");
  const backdrop = $("sheet-backdrop");
  const actions = $("actions");
  const outPre = $("out");
  const outClear = $("btn-clear");
  const verdict2 = $("verdict2");

  const output = ShellUI.createOutput(outPre, outClear);
  output.init(outClear);

  let seenSeq = -1;
  /** 抽屉是否已经被**自动**拉开过 —— 只自动拉一次，之后用户关了就是关了。 */
  let autoOpened = false;

  function render(st) {
    if (!st) return;
    if (typeof st.seq === "number") {
      if (st.seq < seenSeq) return;   // 过期，丢掉
      seenSeq = st.seq;
    }

    // 鲸鱼几何只在第一份带 whale 的快照里给一次
    if (st.whale) ShellUI.setWhale(document.querySelector(".whale"), st.whale, 0.92);

    if (typeof st.title === "string") elTitle.textContent = st.title;
    if (typeof st.stage === "string") elStageText.textContent = st.stage;

    if (typeof st.percent === "number") {
      const p = Math.max(0, Math.min(100, st.percent));
      elBarFill.style.width = p + "%";
      elBar.classList.toggle("idle", st.settled === true);
      elBarMeta.textContent = st.percentLabel || `${p}%`;
    } else {
      elBar.classList.remove("idle");
    }

    if (Array.isArray(st.stages)) {
      elStages.innerHTML = st.stages
        .map((s) => `<li class="${ShellUI.esc(s.state || "pending")}"><span class="dot"></span>${ShellUI.esc(s.label)}</li>`)
        .join("");
    }

    const detailText = typeof st.detail === "string" ? st.detail : "";
    if (detailText) { elDetail.hidden = false; elDetail.textContent = detailText; }
    else { elDetail.hidden = true; elDetail.textContent = ""; }

    if (st.failed) {
      if (!elVerdict.classList.contains("show")) {
        elVerdict.className = "verdict show bad";
        elVerdict.textContent = "启动没成功。可以先点下面的「诊断与修复」。";
      }
    }

    // ★ 2026-09-25：**本机一个内核都没有**时，把抽屉**自动拉开**。
    //   理由：那是全新用户第一次打开客户端的唯一界面，而他要做的事
    //   （点「下载并安装内核」）就藏在这个抽屉里 —— 让他自己去发现
    //   「诊断与修复」这四个字，等于把最容易卡住的一步交给运气。
    //   只在主进程明确标了 `openDiag` 时才做（别的失败不打扰用户）。
    if (st.openDiag === true && !autoOpened) {
      autoOpened = true;
      openSheet();
    }
  }

  // ── 抽屉 ──────────────────────────────────────────────────────────
  function openSheet() { sheet.classList.add("open"); backdrop.classList.add("open"); }
  function closeSheet() { sheet.classList.remove("open"); backdrop.classList.remove("open"); }

  // ★ 主进程会直接调它推状态（`main.js` 的 pushStatus）。
  //   没有这个入口时，"页面还没 boot 完就推过来的状态"会丢，
  //   表现是加载页头一两秒空着。
  window.__dshRender = (st) => { try { render(st); } catch (e) { console.error(e); } };

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheet.classList.contains("open")) closeSheet();
  });
  backdrop.addEventListener("click", closeSheet);
  $("btn-close").addEventListener("click", closeSheet);
  $("btn-diag").addEventListener("click", openSheet);
  $("btn-settings").addEventListener("click", () => {
    if (S && S.openSettings) S.openSettings().catch(() => { });
  });

  // ── 启动 ──────────────────────────────────────────────────────────
  async function boot() {
    if (!S) {
      elTitle.textContent = "外壳通道未就绪";
      elStageText.textContent = "preload 没跑起来，诊断功能不可用。";
      return;
    }

    // 先订阅、再拉快照；配合 seq 保证不会用旧快照覆盖新事件
    S.onStatus((st) => { try { render(st); } catch (e) { console.error(e); } });
    S.onOutput((m) => {
      if (!m) return;
      output.append(m.stream || "out", m.text || "");
    });

    try {
      render(await S.getSnapshot());
    } catch (e) {
      elStageText.textContent = "读初始状态失败：" + ((e && e.message) || e);
    }

    await ShellUI.mountActions(actions, {
      output,
      verdictEl: verdict2,
      onBusy: (id) => {
        if (id) openSheet();
      },
    });
  }

  boot();
})();
