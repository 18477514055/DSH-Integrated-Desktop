package com.dsh.mobileremote;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
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
        hint.setText("\n在电脑上点开「📱 手机遥控」，用**系统相机**扫那个二维码即可自动打开本 App。\n\n"
                + "扫不了也可以在这里手输电脑上的地址（形如 192.168.1.5:3110）。");
        hint.setTextSize(14);
        hint.setPadding(0, pad / 2, 0, pad);
        box.addView(hint);

        final android.widget.EditText input = new android.widget.EditText(this);
        input.setHint("192.168.1.5:3110");
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
        webView.loadUrl(url);
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
        });

        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                // 网页里"🖼 发图片"走这里 → 交给系统文件选择器
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("image/*");
                    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(Intent.createChooser(i, "选择图片"), REQ_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
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
        if (webView != null) webView.onPause();
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
