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
                /* ★ 两种都算超时（2026-09-23，两处缺一不可）：
                 *   ① **cur 为空** —— 这是"死地址 TCP 挂起"的真实状态：
                 *      连接还没提交，WebView 压根没有当前地址（`getUrl()` 返回 null）。
                 *      只判 ② 的话，这种情况**永远不弹浮层** ⇒ 就是用户看到的白屏。
                 *      （上一版只判相等，等于把最常见的那种失败漏掉了。）
                 *   ② **cur 仍是目标地址** —— 提交了但没加载完（服务器半死不活）。
                 *   若已经跳到别的地址（重定向），说明有东西加载了，不算超时。 */
                if (cur == null || cur.isEmpty() || sameUrl(cur, watchdogUrl)) {
                    showFailPanel("连不上电脑（加载超时）",
                            "电脑可能换了 IP、关机了，或客户端没在运行。");
                }
            }
        };
        webView.postDelayed(watchdog, 8000);
    }

    /**
     * 比两个地址是不是"同一个"（★ 2026-09-23 修白屏的关键，见文件头"白屏第二因"）。
     *
     * ══════════════════════════════════════════════════════════════════
     * 为什么不能直接用 String.equals（这就是"必须扫码才能进"的真因）
     * ══════════════════════════════════════════════════════════════════
     * `remember()` 存进去的是**没有尾斜杠**的 `http://ip:port`（见 remember 的拼接），
     * 而 WebView 的 `getUrl()` 返回的是**规范化后**的 `http://ip:port/`。
     * 实测（真 Chromium 复现，本机 2026-09-23）：
     *     传入 "http://127.0.0.1:3110"  → location.href = "http://127.0.0.1:3110/"  equals? false
     *     传入 "http://127.0.0.1:3110/" → location.href = "http://127.0.0.1:3110/"  equals? true
     * ⇒ 旧写法 `cur.equals(watchdogUrl)` 在**冷启动加载记住的地址**时**恒为假**，
     *   看门狗静默失效 ⇒ 死地址（TCP 挂 30~120 秒）期间**既不加载也不报错 = 白屏**。
     *
     * ★ 为什么"扫码那条路"没事、只有冷启动白屏（这条对上了用户的描述）：
     *   扫码回来后拼的地址是 `"http://" + host + ":" + port + "/"` —— **带**尾斜杠，
     *   恰好与 WebView 的规范化结果相等 ⇒ 看门狗生效。
     *   而 `remember()` 存的那份**不带**斜杠 ⇒ 只有"冷启动走存档"这条路坏掉。
     *   用户原话「必须拿系统相机扫码才能进入软件，不然依旧是白屏」正是这个形状。
     *
     * 现在按"规范化后再比"：忽略尾斜杠差异，其余仍要求完全一致
     * （不放松成"前缀相同"—— 那会让跳转后的页面被误判成超时）。
     */
    private boolean sameUrl(String a, String b) {
        if (a == null || b == null) return false;
        if (a.equals(b)) return true;
        return stripTrailingSlash(a).equals(stripTrailingSlash(b));
    }

    private String stripTrailingSlash(String s) {
        if (s == null) return null;
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '/') end--;
        return s.substring(0, end);
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
             * token 交接（2026-09-23）—— 解决"换了 IP 就得重新配对"。
             *
             * 网页在配对成功 / 每次启动恢复 token 后调 `dshNative.saveToken(t)`；
             * 打开一个新 origin 时先调 `dshNative.getToken()` 取回。
             * 为什么必须由壳来存：localStorage 按 origin 隔离，
             * 而电脑换 IP 就换了 origin（见上面 token 那一节的说明）。
             */
            @android.webkit.JavascriptInterface
            public void saveToken(final String t) {
                if (t == null || t.length() < 16) return;
                getPreferences(MODE_PRIVATE).edit().putString(KEY_TOKEN, t).apply();
            }

            @android.webkit.JavascriptInterface
            public String getToken() {
                return storedToken();
            }

            /** 网页点「断开连接」时调用 —— 把壳里那份 token 也清掉。 */
            @android.webkit.JavascriptInterface
            public void clearToken() {
                getPreferences(MODE_PRIVATE).edit().remove(KEY_TOKEN).apply();
            }

            /** 自动找电脑（2026-09-23）：失败浮层上的按钮 / 网页也可以主动调。 */
            @android.webkit.JavascriptInterface
            public void findHost() {
                runOnUiThread(() -> autoDiscover());
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

    /** 本次 App 生命周期是否已经自动找过一次电脑（见 showFailPanel 的说明）。 */
    private boolean autoTried = false;

    /**
     * 这个失败是不是"连不上电脑"这一类（而不是"局域网里没找到"）。
     * 只有前者才值得自动扫一遍网段 —— 后者是扫完的结果，再扫一遍毫无意义
     * （会变成死循环：找不到 → 弹浮层 → 又自动扫 → 又找不到…）。
     */
    private boolean looksLikeConnectionFailure(String title) {
        if (title == null) return false;
        if (title.contains("没找到")) return false;      // 这是扫描的**结论**
        if (title.contains("正在")) return false;        // 这是进行中的状态文案
        return true;
    }

    private void showFailPanel(String title, String hint) {
        if (failPanel != null) {
            // 已在显示：只刷新文案
            ((TextView) failPanel.getChildAt(0)).setText(title);
            ((TextView) failPanel.getChildAt(1)).setText(hint);
            return;
        }
        /* ★ 连不上就**自动**找一次（2026-09-23）—— 用户的原话是
         *   「必须拿系统相机扫码才能进入软件，不然依旧是白屏」，
         *   也就是说他不想动手。所以这里不再只给按钮，而是**先自动找一遍**：
         *   找到了直接切过去（token 也跟着走，见 token 交接那一节）；
         *   找不到才把按钮留给用户。
         *   ★ 每次 App 生命周期只自动找一次（`autoTried`）—— 否则用户每点一次
         *   「重试」都会触发一轮 254 个地址的扫描，费电且没必要。
         *   ★ 扫描要 5~10 秒，所以**先把面板立起来**并写明"正在找"，
         *   绝不能让用户对着白屏等（那正是这次要消灭的东西）。 */
        boolean scanning = false;
        if (!autoTried && looksLikeConnectionFailure(title)) {
            autoTried = true;
            scanning = true;
            title = "正在局域网里找电脑…";
            hint = "大约 5~10 秒。请确认电脑上的 DSH 客户端正在运行。";
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

        /* ★ 自动找电脑（2026-09-23）：放在「重试」下面、「重新配对」上面。
         *   顺序是按"用户最可能想要什么"排的：
         *   重试（可能只是电脑还没起来）→ 自动找（换了 IP，最常见）→ 重扫（兜底）。
         *   把它放在重扫之前，正是为了让"换 IP"这个高频场景**不必再掏相机**。 */
        android.widget.Button find = new android.widget.Button(this);
        find.setText("自动找电脑（同一 Wi-Fi）");
        find.setOnClickListener(v -> {
            t1.setText("正在局域网里找电脑…");
            t2.setText("大约 5~10 秒。请确认电脑上的 DSH 客户端正在运行。");
            autoDiscover();
        });
        android.widget.LinearLayout.LayoutParams flp = new android.widget.LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        flp.topMargin = pad / 3;
        col.addView(find, flp);

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

        /* 面板已经立起来了（用户看到的是"正在找"而不是白屏），现在才真正开扫。
         * 顺序很重要：先立面板再开扫 ⇒ 扫描那 5~10 秒里屏幕上有字。 */
        if (scanning) autoDiscover();
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

    /* ══════════════════════════════════════════════════════════════════
     * 局域网自动找电脑（2026-09-23，用户需求）
     * ══════════════════════════════════════════════════════════════════
     * 用户原话：「连上同一个WIFI的时候，还是加载不出来，必须拿系统相机扫码才能进入软件，
     *   不然依旧是白屏。」
     *
     * 场景：手机和电脑都在同一个 Wi-Fi，但电脑的 IP 变了（DHCP 重新分配是常态）。
     * App 里存的还是旧 IP ⇒ 连不上 ⇒ 白屏 ⇒ 只能重扫二维码。
     * 这一节就是把这个"重扫"消掉：**失败时自动在局域网里找那台电脑**。
     *
     * ── 怎么找（不依赖任何第三方库、不加任何权限）──────────────────────
     * ① 取手机自己的 IPv4 地址（`NetworkInterface`，零权限）；
     * ② 按 /24 推出同网段的所有候选（192.168.1.x ⇒ .1 ~ .254）；
     * ③ 并发探测 `http://<ip>:<port>/`（连接 400ms / 读 600ms，都很短）；
     * ④ 判定"是它"的依据不是"能连上"，而是**页面里带着我们的标记**
     *    （`dsh手机遥控`）—— 否则同一网段里任何一个 80/3110 端口的服务器
     *    都会被误认成电脑。
     *
     * ── 为什么敢把 token 交给"找到的那台"（安全边界，诚实说）──────────
     * 见 `getToken()` 的注释：这个插件的 token 本来就在**明文 HTTP** 上传输
     * （本插件没有 TLS），同一 Wi-Fi 下能嗅探的人早就拿得到；
     * 而"找到"这一步要求对方返回**本插件页面的标记**。两者相加，
     * 把它存进 App 私有目录并不比现状更危险，但确实**不再按 origin 隔离**了。
     */

    /** 正在找（防止重复触发）。 */
    private volatile boolean discovering = false;

    /**
     * 从存档地址里取端口（取不到就用插件默认的 3110）。
     * 端口几乎不会变，所以自动找电脑时沿用它。
     */
    private int savedPort() {
        String last = getPreferences(MODE_PRIVATE).getString(KEY_URL, null);
        if (last != null) {
            try {
                int p = Uri.parse(last).getPort();
                if (p > 0) return p;
            } catch (Exception ignored) { }
        }
        return 3110;
    }

    /** 取本机所有非回环 IPv4（含前缀长度，用来推同网段）。 */
    private java.util.List<String[]> localIpv4() {
        java.util.List<String[]> out = new java.util.ArrayList<>();
        try {
            for (java.net.NetworkInterface nif : java.util.Collections.list(
                    java.net.NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (java.net.InterfaceAddress ia : nif.getInterfaceAddresses()) {
                    java.net.InetAddress a = ia.getAddress();
                    if (a instanceof java.net.Inet4Address) {
                        out.add(new String[]{ a.getHostAddress(), String.valueOf(ia.getNetworkPrefixLength()) });
                    }
                }
            }
        } catch (Exception ignored) { }
        return out;
    }

    /** 由 ip + 前缀长度算出该网段内的全部候选地址（最多 1024 个，防呆）。 */
    private java.util.List<String> candidatesFor(String ip, int prefix) {
        java.util.List<String> out = new java.util.ArrayList<>();
        try {
            byte[] raw = java.net.InetAddress.getByName(ip).getAddress();
            int ipInt = ((raw[0] & 0xFF) << 24) | ((raw[1] & 0xFF) << 16)
                    | ((raw[2] & 0xFF) << 8) | (raw[3] & 0xFF);
            // 只扫 /24 及更小的网段；比 /24 大的（如 /16）太广，扫完要好几分钟
            if (prefix < 24) prefix = 24;
            int mask = prefix == 0 ? 0 : (0xFFFFFFFF << (32 - prefix));
            int net = ipInt & mask;
            int count = 1 << (32 - prefix);
            if (count > 1024) count = 1024;
            for (int i = 1; i < count - 1; i++) {          // 跳过网络号与广播地址
                int cur = net + i;
                out.add(((cur >>> 24) & 0xFF) + "." + ((cur >>> 16) & 0xFF) + "."
                        + ((cur >>> 8) & 0xFF) + "." + (cur & 0xFF));
            }
        } catch (Exception ignored) { }
        return out;
    }

    /**
     * 探测一个地址上是不是**我们这台电脑**。
     * 判据是页面内容里的标记，不是"端口开着" —— 见本节开头第 ④ 条。
     */
    private boolean probeDsHost(String ip, int port) {
        java.net.HttpURLConnection c = null;
        try {
            java.net.URL u = new java.net.URL("http://" + ip + ":" + port + "/");
            c = (java.net.HttpURLConnection) u.openConnection();
            c.setConnectTimeout(400);
            c.setReadTimeout(700);
            c.setRequestMethod("GET");
            c.setInstanceFollowRedirects(false);
            if (c.getResponseCode() != 200) return false;
            java.io.InputStream in = c.getInputStream();
            byte[] buf = new byte[4096];
            int n = in.read(buf);
            if (n <= 0) return false;
            String head = new String(buf, 0, n, "UTF-8");
            // 页面标题或配对视图的 id —— 两者任一即可确认"这是本插件的手机页"
            return head.contains("dsh手机遥控") || head.contains("pairView");
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) { try { c.disconnect(); } catch (Exception ignored) { } }
        }
    }

    /**
     * 后台扫描局域网，找到电脑就切过去。
     * 全程不阻塞 UI；找到/找不到都回到 UI 线程改界面。
     */
    private void autoDiscover() {
        if (discovering) return;
        discovering = true;

        final int port = savedPort();
        final java.util.List<String> targets = new java.util.ArrayList<>();
        for (String[] pair : localIpv4()) {
            int prefix;
            try { prefix = Integer.parseInt(pair[1]); } catch (Exception e) { prefix = 24; }
            targets.addAll(candidatesFor(pair[0], prefix));
        }
        // 去重（手机同时有 Wi-Fi 与热点的网段时可能重复）
        java.util.LinkedHashSet<String> uniq = new java.util.LinkedHashSet<>(targets);
        final java.util.List<String> list = new java.util.ArrayList<>(uniq);

        new Thread(() -> {
            String found = null;
            try {
                // 32 并发：254 个地址约 8 轮 × 0.7s ≈ 6 秒扫完
                java.util.concurrent.ExecutorService pool =
                        java.util.concurrent.Executors.newFixedThreadPool(32);
                java.util.List<java.util.concurrent.Future<String>> futures = new java.util.ArrayList<>();
                for (String ip : list) {
                    futures.add(pool.submit(() -> probeDsHost(ip, port) ? ip : null));
                }
                pool.shutdown();
                for (java.util.concurrent.Future<String> f : futures) {
                    try {
                        String r = f.get();
                        if (r != null) { found = r; break; }
                    } catch (Exception ignored) { }
                }
                pool.shutdownNow();
            } catch (Exception ignored) { }

            final String hit = found;
            runOnUiThread(() -> {
                discovering = false;
                if (hit != null) {
                    String url = "http://" + hit + ":" + port + "/";
                    Toast.makeText(this, "找到电脑了：" + hit, Toast.LENGTH_SHORT).show();
                    loadUrl(url);
                } else {
                    // 找不到就把浮层文案改成"确实找不到"，并保留手动出口
                    showFailPanel("局域网里没找到电脑",
                            "确认电脑上的 DSH 客户端正在运行、且和手机在同一个 Wi-Fi。\n"
                          + "也可以直接扫码 / 手输地址。");
                }
            });
        }, "ds-lan-scan").start();
    }

    /* ── token 跨地址携带（2026-09-23）─────────────────────────────────
     * 为什么需要：token 存在网页的 `localStorage` 里，而 **localStorage 按 origin 隔离** ——
     * `http://192.168.1.5:3110` 与 `http://192.168.1.6:3110` 是**两个不同的 origin**。
     * 所以就算自动找到了电脑的新 IP，页面在新 origin 上也读不到旧 token，
     * 用户还是得重新配对一次。
     * 修法：让网页把 token 交给壳保存（App 私有 SharedPreferences，**不按 origin 隔离**），
     * 新地址加载时再由网页主动取回。
     *
     * ★ 安全边界（诚实说，别夸大）：这确实让 token **不再按 origin 隔离**。
     *   但要看清现状：本插件**没有 TLS**，token 本来就在局域网里明文传输，
     *   同一 Wi-Fi 下能嗅探的人早就拿得到；而"自动找到"那一步还要求对方
     *   返回本插件页面的标记。两者相加，这里并没有把风险从"低"变成"高"。
     *   仍然做的收敛：只存在 App 私有目录、卸载即消失、网页「断开」时一并清掉。 */

    private static final String KEY_TOKEN = "device_token";

    private String storedToken() {
        return getPreferences(MODE_PRIVATE).getString(KEY_TOKEN, "");
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
