package ai.openmaic.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.io.File;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The app's only screen: a WebView pointed at the OpenMAIC server running in
 * this same process.
 *
 * There is no local HTML here. The WebView loads `http://127.0.0.1:PORT`, the
 * Next.js server {@link NodePayload} starts, exactly as a browser on a desktop
 * would load it — which is what makes the app behave like the web app instead
 * of a reimplementation of it.
 */
public class MainActivity extends Activity {

    private static final String TAG = "OpenMAIC";

    /** Where the in-process server listens. Loopback only: nothing is exposed. */
    static final int SERVER_PORT = 7010;

    private static final String START_URL = "http://127.0.0.1:" + SERVER_PORT + "/";

    /** How long the first boot may take before the app stops waiting. */
    private static final long BOOT_TIMEOUT_MS = 180_000;

    private WebView webView;
    private View splash;
    private TextView splashStatus;
    private ProgressBar splashProgress;

    private ValueCallback<Uri[]> fileChooserCallback;
    private static final int FILE_CHOOSER_REQUEST = 4001;

    private final AtomicBoolean bootStarted = new AtomicBoolean(false);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildLayout());
        configureWebView();

        if (savedInstanceState == null && bootStarted.compareAndSet(false, true)) {
            startServerAndLoad();
        }
    }

    // ---------------------------------------------------------------- views

    private View buildLayout() {
        FrameLayout root = new FrameLayout(this);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.WHITE);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout splashGroup = new LinearLayout(this);
        splashGroup.setOrientation(LinearLayout.VERTICAL);
        splashGroup.setGravity(android.view.Gravity.CENTER);
        splashGroup.setBackgroundColor(Color.WHITE);
        splashGroup.setPadding(dp(32), dp(32), dp(32), dp(32));

        TextView title = new TextView(this);
        title.setText("OpenMAIC");
        title.setTextSize(28);
        title.setTextColor(Color.rgb(17, 24, 39));
        title.setGravity(android.view.Gravity.CENTER);
        splashGroup.addView(title);

        splashProgress = new ProgressBar(this);
        LinearLayout.LayoutParams progressParams =
                new LinearLayout.LayoutParams(dp(48), dp(48));
        progressParams.topMargin = dp(24);
        splashProgress.setIndeterminate(true);
        splashGroup.addView(splashProgress, progressParams);

        splashStatus = new TextView(this);
        splashStatus.setText("首次启动：正在解压运行时…");
        splashStatus.setTextSize(14);
        splashStatus.setTextColor(Color.rgb(107, 114, 128));
        splashStatus.setGravity(android.view.Gravity.CENTER);
        LinearLayout.LayoutParams statusParams =
                new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT);
        statusParams.topMargin = dp(20);
        splashGroup.addView(splashStatus, statusParams);

        splash = splashGroup;
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        return root;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // The app is a single origin on loopback, and the server sets cookies
        // for its anonymous owner; without this every launch is a new owner.
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        // Font/webfont and XHR traffic is same-origin over http://127.0.0.1;
        // mixed-content blocking would otherwise drop requests the page makes
        // to absolute http URLs, and the CSP already permits only 'self'.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri.getHost();
                // Anything off loopback is a real external link: hand it to the
                // system browser rather than navigating the app away.
                if (host != null && !host.equals("127.0.0.1") && !host.equals("localhost")) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception error) {
                        Log.w(TAG, "no handler for " + uri, error);
                    }
                    return true;
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (splash != null && splash.getVisibility() == View.VISIBLE) {
                    splash.setVisibility(View.GONE);
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                // Page errors are otherwise invisible on a device without a
                // remote debugger attached.
                Log.i(TAG, "[web] " + message.message() + " @" + message.lineNumber());
                return true;
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // The classroom's media tools ask for the microphone and
                // camera; WebView requires an explicit grant.
                request.grant(request.getResources());
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileChooserCallback != null) {
                    fileChooserCallback.onReceiveValue(null);
                }
                fileChooserCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception error) {
                    Log.w(TAG, "could not open the file chooser", error);
                    fileChooserCallback = null;
                    return false;
                }
            }
        });
    }

    // ------------------------------------------------------------- lifecycle

    private void startServerAndLoad() {
        new Thread(() -> {
            try {
                File payload = NodePayload.ensureUnpacked(this);
                Log.i(TAG, "payload at " + payload);
                NodePayload.start(this, payload);
                waitForServerThenLoad();
            } catch (Exception error) {
                Log.e(TAG, "startup failed", error);
                showFailure(error);
            }
        }, "openmaic-boot").start();
    }

    /**
     * Poll the server until it answers.
     *
     * The runtime is ready when the port accepts connections, and there is no
     * callback from Node to Java here (the JNI call never returns), so polling
     * is the whole handshake. It also tolerates the runtime being slow to warm
     * up — the first request compiles the route graph, which on a phone is
     * seconds, not milliseconds.
     */
    private void waitForServerThenLoad() throws InterruptedException {
        long deadline = System.currentTimeMillis() + BOOT_TIMEOUT_MS;
        setStatus("正在启动服务…");
        while (System.currentTimeMillis() < deadline) {
            if (portAcceptsConnections()) {
                runOnUiThread(() -> webView.loadUrl(START_URL));
                return;
            }
            Thread.sleep(400);
        }
        showFailure(new IllegalStateException("服务在 " + (BOOT_TIMEOUT_MS / 1000) + " 秒内没有启动"));
    }

    private boolean portAcceptsConnections() {
        try (java.net.Socket socket = new java.net.Socket()) {
            socket.connect(new java.net.InetSocketAddress("127.0.0.1", SERVER_PORT), 500);
            return true;
        } catch (Exception notYet) {
            return false;
        }
    }

    private void setStatus(String text) {
        runOnUiThread(() -> {
            if (splashStatus != null) splashStatus.setText(text);
        });
    }

    private void showFailure(Throwable error) {
        runOnUiThread(() -> {
            if (splash == null) return;
            splash.setVisibility(View.VISIBLE);
            if (splashProgress != null) splashProgress.setVisibility(View.GONE);
            if (splashStatus != null) {
                splashStatus.setText("启动失败：\n" + error
                        + "\n\n请查看 logcat（OpenMAICNode / OpenMAIC）中的详细日志。");
            }
        });
    }

    // ------------------------------------------------------------ back/exit

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST && fileChooserCallback != null) {
            fileChooserCallback.onReceiveValue(
                    WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileChooserCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
