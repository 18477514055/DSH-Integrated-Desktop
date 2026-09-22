package com.dsh.mobileremote;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 手机遥控 —— Android 壳。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 这个 App 到底做什么（别把它想复杂了）
 * ═══════════════════════════════════════════════════════════════════
 * 它就是**一个全屏 WebView**，加载电脑上那个插件自己发出来的手机端页面。
 * 真正的功能（会话列表、流式输出、发消息、审批…）全在网页里，
 * 由电脑端的插件提供；这个壳只负责：
 *   · 全屏、无地址栏（比浏览器"添加到主屏幕"更像正经 App）
 *   · 记住上次连的地址（下次打开直接进）
 *   · 支持网页里"选图片"（转交给系统文件选择器）
 *   · 返回键 = 网页后退，退到底再退出 App
 *
 * ★ 为什么不做"内嵌二维码扫描"：那要么引第三方库（ZXing/MLKit），
 *   要么自己写解码器，两者都会破坏本工程"零第三方依赖"的前提。
 *   替代方案（更省事、也更可靠）：**用系统相机扫码**。
 *   电脑端二维码里编的是 `dshmr://` 开头的地址，系统扫到后会
 *   **直接唤起本 App**（见 AndroidManifest 里的 intent-filter）。
 *
 * ★ 诚实声明：本文件**没有被真机验证过**（写它的机器上没有 Android SDK，
 *   见同目录 README 的"验证状态"一节）。逻辑刻意写得极简，
 *   就是为了让"没验证过"这件事的风险尽量小。
 */
public class MainActivity extends Activity {

    /** 上次连接地址的存档键（SharedPreferences） */
    private static final String PREFS = "dsh_mobile_remote";
    private static final String KEY_URL = "last_url";

    private WebView webView;
    private FrameLayout root;
    private View setupView;
    private ValueCallback<Uri[]> fileCallback;
    private static final int REQ_FILE = 1001;
    private static final int REQ_SCAN = 1002;

    /**
     * 键盘遮挡的兜底（配上网页里的 visualViewport 逻辑，两侧一起才治得住）。
     *
     * ═══════════════════════════════════════════════════════════════════
     * 为什么 Manifest 里写了 adjustResize 还不够（真因，2026-09-21 查证）
     * ═══════════════════════════════════════════════════════════════════
     * 用户报："手机上点击输入框弹出键盘之后，键盘会把那个输入框挡住，整个页面也会被挡住一半。"
     *
     * 本 App 的 targetSdk 是 **37**。而 **Android 15（API 35）起强制 edge-to-edge**：
     * `windowSoftInputMode="adjustResize"` 对 targetSdk ≥ 35 的应用**不再生效** ——
     * 系统不再因为键盘而缩小窗口，键盘是**盖**上来的。窗口高度不变 ⇒
     * 网页里 `100dvh` 量到的仍是"没有键盘"的高度 ⇒ 底部输入框正好落在键盘底下。
     *
     * 所以两侧都要做，缺一不可：
     *   · 网页侧：跟 visualViewport 写 `--app-h`（见 web/app.js 的 syncViewport）；
     *   · 原生侧：把**键盘让出的高度**做成 root 的底部 padding ——
     *     这一层在有些 ROM 上比网页侧更可靠（能拿到系统给的真实 inset，
     *     不必依赖 WebView 是否正确实现 visualViewport）。
     *
     * ⚠️ 本工程**零第三方依赖**（没有 androidx），所以不能用 WindowInsetsCompat，
     *    直接用 API 20+ 就有的 `View.OnApplyWindowInsetsListener`。
     *    `Type.ime()` 需要 API 30+；更低版本拿不到键盘高度就只避让导航栏（无害）。
     */
    @SuppressWarnings("deprecation")
    private void installKeyboardInsetHandler() {
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int bottom;
            int top = 0;
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                // ① 键盘（IME）高度：真正要躲开的那一块
                android.graphics.Insets ime = insets.getInsets(android.view.WindowInsets.Type.ime());
                // ② 系统手势条 / 导航栏：键盘没弹出时也要避让
                android.graphics.Insets sys = insets.getInsets(android.view.WindowInsets.Type.systemBars());
                bottom = Math.max(ime.bottom, sys.bottom);
                // ③ 状态栏（含前置摄像头/刘海挖孔区）：
                //    用户 2026-09-22 报告"上面是前置摄像头挡住的" —— targetSdk 37 强制
                //    edge-to-edge 后，页面顶端顶进了摄像头区域，标题/按钮会被挖孔压住。
                //    top 取 systemBars.top（状态栏高度，挖孔机型的状态栏本来就把挖孔包进去），
                //    与 displayCutout.top 兜底取大 —— 两种实现哪个大听哪个。
                int cutout = 0;
                if (android.os.Build.VERSION.SDK_INT >= 30) {
                    cutout = insets.getInsets(android.view.WindowInsets.Type.displayCutout()).top;
                }
                top = Math.max(sys.top, cutout);
            } else {
                bottom = insets.getSystemWindowInsetBottom();
                top = insets.getSystemWindowInsetTop();
            }
            // 把底部让出来 ⇒ WebView 的可用高度随之变小，输入框被顶到键盘之上；
            // 把顶部也让出来 ⇒ 页面整体从摄像头/刘海下方开始（用户："把整个页面稍拉短一点"）
            if (v.getPaddingBottom() != bottom || v.getPaddingTop() != top) {
                v.setPadding(v.getPaddingLeft(), top, v.getPaddingRight(), bottom);
            }
            return insets;
        });
        root.requestApplyInsets();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        root = new FrameLayout(this);
        setContentView(root);
        // ★ 键盘让位（Android 15 起 adjustResize 失效，见 installKeyboardInsetHandler 的注释）
        installKeyboardInsetHandler();

        // 若被 dshmr:// 唤起，直接用那个地址；否则用上次存的
        String target = urlFromIntent(getIntent());
        if (target == null) target = getPreferences(MODE_PRIVATE).getString(KEY_URL, null);

        if (target == null) {
            showSetup(null);
        } else {
            loadUrl(target);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String target = urlFromIntent(intent);
        if (target != null) {
            removeSetup();
            loadUrl(target);
        }
    }

    /**
     * 从 `dshmr://pair?u=<编码后的 http 地址>` 里取出真正的地址。
     *
     * 为什么套一层自定义 scheme：http 的局域网地址**无法**在没做域名验证的情况下
     * 路由到本 App（Android 的 App Links 要求 https + 域名校验）。
     * 自定义 scheme 不需要任何验证，扫到就能唤起。
     * 而真正的页面仍然是那个 http 地址 —— 只是被"装"进了这个 scheme 里。
     */
    private String urlFromIntent(Intent intent) {
        if (intent == null || intent.getData() == null) return null;
        Uri data = intent.getData();
        if (!"dshmr".equals(data.getScheme())) return null;
        String u = data.getQueryParameter("u");
        if (u != null && u.startsWith("http")) return u;
        // 兼容：也允许直接给 host/port/c
        String host = data.getQueryParameter("host");
        String port = data.getQueryParameter("port");
        String c = data.getQueryParameter("c");
        if (host != null && port != null) {
            String s = "http://" + host + ":" + port + "/";
            if (c != null) s += "?c=" + c;
            return s;
        }
        return null;
    }

    // ── 首次使用：手输地址 ───────────────────────────────────────────

    private void showSetup(String prefill) {
        if (setupView != null) return;

        final android.widget.LinearLayout box = new android.widget.LinearLayout(this);
        box.setOrientation(android.widget.LinearLayout.VERTICAL);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad, pad, pad);
        box.setGravity(android.view.Gravity.CENTER_VERTICAL);

        TextView title = new TextView(this);
        title.setText("手机遥控");
        title.setTextSize(24);
        box.addView(title);

        TextView hint = new TextView(this);
        hint.setText("\n连不上时最常见的原因是**电脑换了 IP**。\n"
                + "点下面的「扫码连接」，在电脑端弹窗里扫一下即可（全程不出本 App）。\n\n"
                + "扫不了也可以手输电脑上的新地址（形如 192.168.1.5:3110，\n"
                + "电脑端悬浮球弹窗里能看到当前地址）。\n");
        hint.setTextSize(14);
        hint.setPadding(0, pad / 2, 0, pad);
        box.addView(hint);

        final android.widget.EditText input = new android.widget.EditText(this);
        // ★ 预填上次的主机名（只改 IP 数字那部分就行），端口几乎不会变
        String last = getPreferences(MODE_PRIVATE).getString(KEY_URL, null);
        input.setHint("192.168.1.5:3110");
        if (last != null) {
            try {
                Uri u = Uri.parse(last);
                if (u.getHost() != null) {
                    input.setText(u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : ""));
                    input.setSelection(0, input.getText().length());
                }
            } catch (Exception ignored) { }
        }
        input.setSingleLine(true);
        box.addView(input, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        android.widget.Button go = new android.widget.Button(this);
        go.setText("连接");
        go.setOnClickListener(v -> {
            String raw = input.getText().toString().trim();
            if (raw.isEmpty()) {
                Toast.makeText(this, "请先填地址", Toast.LENGTH_SHORT).show();
                return;
            }
            // 容错：允许用户只填 ip:port，也允许填完整 URL 或带配对码的链接
            String url = raw;
            if (!url.startsWith("http")) url = "http://" + url;
            if (!url.contains("/")) url += "/";
            removeSetup();
            loadUrl(url);
        });
        android.widget.LinearLayout.LayoutParams lp = new android.widget.LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = pad / 2;
        box.addView(go, lp);

        // 内嵌扫码（2026-09-22）：不用切出去开系统相机，App 里直接扫
        android.widget.Button scan = new android.widget.Button(this);
        scan.setText("扫码连接（推荐）");
        scan.setOnClickListener(v -> {
            try {
                startActivityForResult(new Intent(MainActivity.this, ScanActivity.class), REQ_SCAN);
            } catch (Exception e) {
                Toast.makeText(this, "扫码不可用：" + e.getMessage(), Toast.LENGTH_SHORT).show();
            }
        });
        android.widget.LinearLayout.LayoutParams lp2 = new android.widget.LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp2.topMargin = pad / 4;
        box.addView(scan, lp2);

        setupView = box;
        root.addView(setupView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void removeSetup() {
        if (setupView != null) {
            root.removeView(setupView);
            setupView = null;
        }
    }

    // ── WebView ──────────────────────────────────────────────────────

    private void loadUrl(String url) {
        if (webView == null) {
            webView = new WebView(this);
            root.addView(webView, 0, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            configure(webView);
        }
        removeFailPanel();   // ★ 新导航开始 ⇒ 上一次失败的浮层必须先收掉（配对页 / 重试路径都经过这里）
        startWatchdog(url);  // ★ 连接挂起的兜底：死地址的 TCP 连接可能挂几十秒才报错，
                             //   用户等不了 —— 8 秒还没加载完就弹失败浮层（重试/重新配对）
        webView.loadUrl(url);
    }

    // ── 加载看门狗：不给"白屏干等"留任何机会 ──────────────────────
    //   死地址的失败报得极慢（内核 TCP 超时可达 30-120 秒），onReceivedError
    //   迟迟不来，用户看到的就是无限白屏。8 秒是页面正常加载的数倍余量。
    private Runnable watchdog;
    private String watchdogUrl;

    private void startWatchdog(String url) {
        cancelWatchdog();
        watchdogUrl = url;
        watchdog = new Runnable() {
            @Override public void run() {
                // 还停在原 URL 上才算超时（期间 onPageFinished 会 cancel）
                if (webView == null || failPanel != null) return;
                String cur = webView.getUrl();
                if (cur != null && cur.equals(watchdogUrl)) {
                    showFailPanel("连不上电脑（加载超时）",
                            "电脑可能换了 IP、关机了，或客户端没在运行。");
                }
            }
        };
        webView.postDelayed(watchdog, 8000);
    }

    private void cancelWatchdog() {
        if (watchdog != null && webView != null) { webView.removeCallbacks(watchdog); watchdog = null; }
    }

    private void configure(WebView wv) {
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);            // 页面全靠 JS
        s.setDomStorageEnabled(true);            // ★ 必须：token 存在 localStorage 里
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setMediaPlaybackRequiresUserGesture(false);

        // 明文 http：Manifest 里开了 usesCleartextTraffic，这里再兜一层
        // （某些 ROM 会忽略 Manifest 的开关）
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        CookieManager.getInstance().setAcceptCookie(true);

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // 站内跳转留在 WebView；外部链接交给系统浏览器
                Uri u = request.getUrl();
                String host = u.getHost();
                if (host != null && (host.equals(view.getUrl() == null ? null : Uri.parse(view.getUrl()).getHost()))) {
                    return false;
                }
                return false;   // 本插件页面没有外链，一律留在内部
            }

            @Override
            public void onReceivedError(WebView view, android.webkit.WebResourceRequest request,
                                        android.webkit.WebResourceError error) {
                // ★ 白屏真因（2026-09-22 用户实测）与正确修法：
                //   App 冷启动时加载"上次记住的地址"，但电脑换过 IP / 端口没起 ⇒
                //   WebView 停在**错误页**上。旧判据（onPageFinished 里看标题为空）
                //   是错的：很多 ROM 的错误页标题就是 URL 本身（非空）⇒ 永远不触发，
                //   表现就是"打开一直白屏，连扫码配对界面都看不到"。
                //   正确姿势：onReceivedError 是 WebView 的**正式**错误回调 ——
                //   主文档加载失败必然走到这里，跟 ROM 的错误页长得像不像无关。
                super.onReceivedError(view, request, error);
                // 只对主文档反应：CSS/JS 单个资源失败不该弹出错误浮层
                if (request == null || !request.isForMainFrame()) return;
                // WebResourceError.getCode() 需要 API 23+；低版本只给通用文案
                String detail;
                if (android.os.Build.VERSION.SDK_INT >= 23) {
                    detail = "连不上电脑（" + error.getErrorCode() + "）";
                } else {
                    detail = "连不上电脑";
                }
                final String d = detail;
                runOnUiThread(() -> showFailPanel(
                        d,
                        "电脑可能换了 IP、关机了，或客户端没在运行。"));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // 页面成功加载 ⇒ 收掉错误浮层（正常路径的唯一出口）
                super.onPageFinished(view, url);
                if (view.getProgress() >= 100) {
                    removeFailPanel();
                    cancelWatchdog();
                    // ★ 立刻记住地址（旧版只在 onDestroy 记 —— 而上滑杀后台
                    //   **不会**触发 onDestroy ⇒ 新地址从未落盘，冷启动永远加载
                    //   几天前的旧 IP，连接挂起 = 用户看到的"白屏"。这就是根因。）
                    remember(url);
                }
            }
        });

        // ★ JS 桥（2026-09-22 用户需求④）：
        //   网页里有「重启 App」按钮（见 phone/app.js 的 dshNative.forceRestart），
        //   装新版本插件后不用去系统设置砍后台 —— 点一下，整个 App 原地重启。
        wv.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public void forceRestart() {
                runOnUiThread(() -> {
                    // 记下地址再杀进程：冷启动后 still 能回到电脑端页面
                    if (webView != null) remember(webView.getUrl());
                    // 重启 = 结束自身 + 重新拉起。不碰任何系统设置，不用存储权限。
                    Intent i = getBaseContext().getPackageManager()
                            .getLaunchIntentForPackage(getBaseContext().getPackageName());
                    if (i != null) {
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                        finish();
                        startActivity(i);
                        // 结束当前进程，让新实例彻底冷启动（WebView、localStorage 原地重建）
                        Runtime.getRuntime().exit(0);
                    }
                });
            }

            /** 内嵌扫码（2026-09-22）：网页调 dshNative.startScan() 弹出扫码页，
             *  认出二维码后走 onActivityResult 回来 —— 全程不出 App。 */
            @android.webkit.JavascriptInterface
            public void startScan() {
                runOnUiThread(() -> {
                    try {
                        startActivityForResult(new Intent(MainActivity.this, ScanActivity.class), REQ_SCAN);
                    } catch (Exception ignored) { }
                });
            }

            /**
             * 文件下载（2026-09-22 用户需求：手机和电脑互传文件）。
             *
             * ══════════════════════════════════════════════════════════
             * 为什么必须由壳来做，网页自己做不了
             * ══════════════════════════════════════════════════════════
             * WebView 里的 `<a download>` / `location.href` 对一个
             * `Content-Disposition: attachment` 的响应**没有可靠的保存路径** ——
             * 多数 ROM 上它什么也不做（这正是"点了下载没反应"的经典症状）。
             * 而用 fetch 把字节拉进 JS 再存，会把整个文件装进 WebView 内存
             * （几百 MB 必被系统杀掉），且没有进度、不能续传。
             * ⇒ 交给**系统下载管理器**：通知栏进度、可暂停/继续、可断点续传、
             *   大文件不占本进程内存。这是 Android 上"下载一个文件"的标准做法。
             *
             * ★ 不需要任何存储权限：DownloadManager 写入公共 Downloads 目录
             *   走的是它自己的机制（API 29+ 是 scoped storage，更不需要权限）。
             *   所以本 App 的权限清单**没有变宽**（仍然只有 INTERNET /
             *   ACCESS_NETWORK_STATE / CAMERA）。
             *
             * ★ token 在 URL 里：DownloadManager 由系统进程发起请求，
             *   我们**无法**给它加 Authorization 头 ⇒ 网页侧把 token 拼进
             *   查询串（宿主端 `/api/file/dl` 接受 `?token=`）。
             *
             * ★ 明文 HTTP：清单里 `usesCleartextTraffic="true"` 是应用级设置，
             *   DownloadManager 在部分 ROM 上会**忽略**它而拒绝明文下载。
             *   所以这里 catch 住失败，退回"用系统浏览器打开该 URL" ——
             *   浏览器自己会下载，用户至少拿得到文件（只是进度在浏览器里）。
             */
            @android.webkit.JavascriptInterface
            public void download(final String url, final String fileName) {
                runOnUiThread(() -> {
                    String name = (fileName == null || fileName.trim().isEmpty())
                            ? "dsh-download" : fileName.trim();
                    try {
                        DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
                        r.setTitle(name);
                        r.setDescription("来自电脑 DSH");
                        r.setNotificationVisibility(
                                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                        r.setDestinationInExternalPublicDir(
                                Environment.DIRECTORY_DOWNLOADS, name);
                        // 允许在计费网络上下载（手机热点场景常见）；是否真用由系统决定
                        r.setAllowedOverMetered(true);
                        r.setAllowedOverRoaming(true);
                        DownloadManager dm = (DownloadManager)
                                getSystemService(Context.DOWNLOAD_SERVICE);
                        if (dm == null) throw new IllegalStateException("no DownloadManager");
                        dm.enqueue(r);
                        Toast.makeText(MainActivity.this,
                                "已开始下载：" + name, Toast.LENGTH_SHORT).show();
                    } catch (Exception e) {
                        // 兜底：交给系统浏览器（它自己的下载器同样有进度）
                        try {
                            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(i);
                        } catch (Exception e2) {
                            Toast.makeText(MainActivity.this,
                                    "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
                        }
                    }
                });
            }
        }, "dshNative");

        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                /* 网页里两个入口都走这里：
                 *   · 「发图片」    → <input accept="image/*">   ⇒ 只要图
                 *   · 「传到电脑」  → <input>（无 accept）        ⇒ 任意文件
                 * ★ 2026-09-22 改：旧版把类型**写死**成图片，于是"传到电脑"
                 *   只能选到图片 —— 而用户要传的恰恰是 zip / 源码 / 文档。
                 *   现在照 `getAcceptTypes()` 走：给了 accept 就尊重它，
                 *   没给（或给的是通配）就放开成任意类型。
                 * ⚠️ 注意别在块注释里写出「星号+斜杠」——那会提前闭合注释，
                 *    编译报"非法的表达式开始"（本轮实测踩过，就是上面那行
                 *    原本写的 image 通配符）。 */
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                String[] accepts = null;
                try { accepts = params.getAcceptTypes(); } catch (Exception ignored) { }
                boolean anyType = (accepts == null || accepts.length == 0);
                StringBuilder sb = new StringBuilder();
                if (!anyType) {
                    for (String a : accepts) {
                        if (a == null || a.trim().isEmpty()) { anyType = true; break; }
                        if (sb.length() > 0) sb.append(',');
                        sb.append(a.trim());
                    }
                }
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType(anyType ? "*/*" : sb.toString());
                    if (anyType) {
                        // 明确放开：部分 ROM 只认 EXTRA_MIME_TYPES，不认 setType("*/*")
                        i.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "*/*" });
                    }
                    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(
                            Intent.createChooser(i, anyType ? "选择文件" : "选择图片"), REQ_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
            }
        });
    }

    // ── 连接失败浮层（主文档加载失败的唯一出口）──────────────────
    //   ① 重试 —— 原地 reload（电脑只是暂时没响应时用）
    //   ② 重新配对 —— 回到配对页（那里有内嵌扫码 + 手输码），白屏的真正出口
    private FrameLayout failPanel;

    private void showFailPanel(String title, String hint) {
        if (failPanel != null) {
            // 已在显示：只刷新文案
            ((TextView) failPanel.getChildAt(0)).setText(title);
            ((TextView) failPanel.getChildAt(1)).setText(hint);
            return;
        }
        FrameLayout box = new FrameLayout(this);
        box.setBackgroundColor(0xF5F6F8);

        android.widget.LinearLayout col = new android.widget.LinearLayout(this);
        col.setOrientation(android.widget.LinearLayout.VERTICAL);
        col.setGravity(android.view.Gravity.CENTER);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        col.setPadding(pad, pad, pad, pad);

        TextView t1 = new TextView(this);
        t1.setText(title);
        t1.setTextSize(17);
        t1.setTextColor(0xFF1B1F27);
        col.addView(t1);

        TextView t2 = new TextView(this);
        t2.setText(hint);
        t2.setTextSize(13);
        t2.setTextColor(0xFF5B6472);
        t2.setPadding(0, pad / 3, 0, pad);
        col.addView(t2);

        android.widget.Button retry = new android.widget.Button(this);
        retry.setText("重试");
        retry.setOnClickListener(v -> {
            removeFailPanel();
            if (webView != null) webView.reload();
        });
        col.addView(retry, new android.widget.LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        android.widget.Button repair = new android.widget.Button(this);
        repair.setText("重新配对（扫码 / 手输码）");
        repair.setOnClickListener(v -> {
            removeFailPanel();
            if (webView != null) webView.stopLoading();
            showSetup(null);
        });
        android.widget.LinearLayout.LayoutParams rlp = new android.widget.LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rlp.topMargin = pad / 3;
        col.addView(repair, rlp);

        box.addView(col, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.Gravity.CENTER));
        root.addView(box, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        failPanel = box;
    }

    private void removeFailPanel() {
        if (failPanel != null) {
            root.removeView(failPanel);
            failPanel = null;
        }
        // 旧版单按钮也一并清掉（升级覆盖安装后不再走那个路径）
        removeRetry();
    }

    // 旧版遗留（仅 removeFailPanel 里兼容清理用）
    private android.widget.Button retryBtn;
    private void removeRetry() {
        if (retryBtn != null) {
            root.removeView(retryBtn);
            retryBtn = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_SCAN) {
            // 内嵌扫码回来：认出的文本要么是 http 地址（浏览器码）要么是 dshmr://（App 码）
            if (resultCode == RESULT_OK && data != null && data.hasExtra("text")) {
                String text = data.getStringExtra("text");
                String target = resolveScanned(text);
                if (target != null) {
                    removeSetup();
                    loadUrl(target);
                } else {
                    Toast.makeText(this, "认出来了，但不是本插件的配对码", Toast.LENGTH_LONG).show();
                }
            }
            return;
        }
        if (requestCode != REQ_FILE) { super.onActivityResult(requestCode, resultCode, data); return; }
        if (fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                result = new Uri[n];
                for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{ data.getData() };
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    /**
     * 把扫出来的文本解析成可加载的 http 地址。
     * 接受三种形态：① http(s)://… ② dshmr://pair?u=<编码的 http 地址> ③ dshmr://pair?host=&port=&c=
     * 都不是 ⇒ null（调用方给提示）。
     */
    private String resolveScanned(String text) {
        if (text == null) return null;
        String t = text.trim();
        if (t.startsWith("http")) return t;
        if (t.startsWith("dshmr://")) {
            Uri d = Uri.parse(t);
            String u = d.getQueryParameter("u");
            if (u != null && u.startsWith("http")) return u;
            String host = d.getQueryParameter("host");
            String port = d.getQueryParameter("port");
            String c = d.getQueryParameter("c");
            if (host != null && port != null) {
                String s = "http://" + host + ":" + port + "/";
                if (c != null) s += "?c=" + c;
                return s;
            }
        }
        return null;
    }

    /** 记住地址：只要页面加载成功就存下来，下次直接进。 */
    private void remember(String url) {
        if (url == null || !url.startsWith("http")) return;
        // 只存到主机端口那一层，别把一次性配对码存进去（它会过期）
        try {
            Uri u = Uri.parse(url);
            String base = u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
            getPreferences(MODE_PRIVATE).edit().putString(KEY_URL, base).apply();
        } catch (Exception ignored) { }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            webView.onPause();
            // ★ 退到后台也记地址（onDestroy 在"上滑杀后台"时根本不会触发，
            //   这里是正常使用路径上最后的落盘机会）
            remember(webView.getUrl());
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            remember(webView.getUrl());
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
