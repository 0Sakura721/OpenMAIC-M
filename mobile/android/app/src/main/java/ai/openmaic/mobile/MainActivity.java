package ai.openmaic.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
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

    /** Sent by the ongoing notification's "数据备份" action. */
    static final String ACTION_DATA_MENU = "ai.openmaic.mobile.DATA_MENU";

    /** Where the in-process server listens. Loopback only: nothing is exposed. */
    static final int SERVER_PORT = 7010;

    private static final String START_URL = "http://127.0.0.1:" + SERVER_PORT + "/";

    /** How long the first boot may take before the app stops waiting. */
    private static final long BOOT_TIMEOUT_MS = 180_000;

    private WebView webView;
    /** The draggable settings handle that floats above the page. */
    private View settingsHandle;
    private View splash;
    private TextView splashStatus;
    private ProgressBar splashProgress;

    private ValueCallback<Uri[]> fileChooserCallback;
    private static final int FILE_CHOOSER_REQUEST = 4001;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 4002;
    private static final int REQUEST_BACKUP = 4003;
    private static final int REQUEST_RESTORE = 4004;

    private final AtomicBoolean bootStarted = new AtomicBoolean(false);

    /** Set once the port answered; onResume uses it to detect a killed process. */
    private volatile boolean serverWasReady = false;

    /** The latest phase text from the server, shown with an elapsed counter. */
    private volatile String splashPhase = "正在准备…";
    /** When this boot attempt started; -1 before the timer arms it. */
    private volatile long splashStartedAt = -1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildLayout());
        configureWebView();
        requestNotificationPermission();
        // The Node runtime reports each phase on stdout; the JNI log pipe calls
        // back here, and this activity renders the line. Registered before the
        // runtime starts so no early phase is missed.
        NodeRuntime.setStatusListener(this);

        if (savedInstanceState == null && bootStarted.compareAndSet(false, true)) {
            startServerAndLoad();
        }
        // A cold start from the notification's action.
        if (ACTION_DATA_MENU.equals(getIntent() == null ? null : getIntent().getAction())) {
            showDataMenu();
        }
    }

    /**
     * Called from the Node runtime's thread for every {@code OPENMAIC_STATUS}
     * line the server prints (see mobile/runtime/start.mjs).
     *
     * Two rules, both forced by the threading:
     *
     *   - the text must hop to the UI thread before touching the views;
     *   - a phase that has already been superseded is skipped, so a slow line
     *     arriving after success cannot drag the splash back over a working
     *     page.
     */
    public void onNodeStatus(String text) {
        if (text == null || text.isEmpty()) return;
        runOnUiThread(() -> {
            if (serverWasReady) return;
            setStatus(text);
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // `singleTask`: the notification action re-enters the running activity
        // here rather than creating a second one.
        if (intent != null && ACTION_DATA_MENU.equals(intent.getAction())) {
            showDataMenu();
        }
    }

    /**
     * Android 13+ needs the user's consent for the foreground service's ongoing
     * notification. Declining does not stop the service from running — the
     * notification is simply not shown — so this is requested quietly and the
     * refusal is not treated as an error.
     */
    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
    }

    // ---------------------------------------------------------------- views

    private View buildLayout() {
        FrameLayout root = new FrameLayout(this);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.WHITE);
        // Android 15 (targetSdk 35+) draws edge-to-edge by default: the window
        // extends under the status bar, and the WebView paints behind it. The
        // page is a desktop-oriented web app that knows nothing about notches,
        // so its headers and dialogs render underneath the clock and the camera
        // cutout. Padding the WebView container by the real inset is the fix
        // that needs no upstream change: everything the page draws starts below
        // the system bars, on every page, including dialogs.
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        applyDisplayCutoutPadding(root);

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
        // A discoverable second route to the data menu, on the screen shown
        // while the runtime unpacks. The notification action is the one that
        // stays available afterwards.
        title.setOnLongClickListener(view -> {
            showDataMenu();
            return true;
        });
        splashGroup.addView(title);

        splashProgress = new ProgressBar(this);
        LinearLayout.LayoutParams progressParams =
                new LinearLayout.LayoutParams(dp(48), dp(48));
        progressParams.topMargin = dp(24);
        splashProgress.setIndeterminate(true);
        splashGroup.addView(splashProgress, progressParams);

        splashStatus = new TextView(this);
        splashPhase = "首次启动：正在解压运行时…";
        splashStatus.setText(splashPhase);
        splashStatus.setTextSize(14);
        splashStatus.setTextColor(Color.rgb(107, 114, 128));
        splashStatus.setGravity(android.view.Gravity.CENTER);
        LinearLayout.LayoutParams statusParams =
                new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT);
        statusParams.topMargin = dp(20);
        splashGroup.addView(splashStatus, statusParams);

        // A labelled button on the splash, where a first-time user is already
        // looking. The long-press and notification routes still exist; this is
        // the one that does not have to be discovered.
        android.widget.Button splashSettings = new android.widget.Button(this);
        splashSettings.setText("应用设置");
        splashSettings.setAllCaps(false);
        splashSettings.setOnClickListener(v -> showSettingsDialog());
        LinearLayout.LayoutParams settingsParams =
                new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT);
        settingsParams.topMargin = dp(32);
        splashGroup.addView(splashSettings, settingsParams);

        splash = splashGroup;
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // A small draggable handle that stays reachable once the page loads.
        //
        // The page owns every touch after that, so an in-shell control has to
        // float above it. It is deliberately small, dimmed most of the time,
        // and draggable: the user can park it wherever it is least in the way,
        // and the position is remembered. Without it the only route in was the
        // notification action (absent until the user grants notifications) or
        // a long press on the splash title (gone once the page loads) — which
        // is exactly how it got to be unfindable.
        settingsHandle = buildSettingsHandle();
        // Hidden while the splash is up: the splash has its own labelled
        // "应用设置" button, and a floating circle over the logo would be noise.
        settingsHandle.setVisibility(View.GONE);
        FrameLayout.LayoutParams handleParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        handleParams.gravity = android.view.Gravity.TOP | android.view.Gravity.END;
        handleParams.topMargin = dp(8);
        handleParams.rightMargin = dp(8);
        root.addView(settingsHandle, handleParams);
        restoreHandlePosition(handleParams);

        // A thin strip along the bottom edge that opens the data menu on a long
        // press: the fallback for anyone who drags the handle off screen.
        View menuStrip = new View(this);
        menuStrip.setBackgroundColor(Color.TRANSPARENT);
        menuStrip.setOnLongClickListener(view -> {
            showDataMenu();
            return true;
        });
        FrameLayout.LayoutParams stripParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(24));
        stripParams.gravity = android.view.Gravity.BOTTOM;
        root.addView(menuStrip, stripParams);

        return root;
    }

    /**
     * Pad a full-screen container by the system bar insets.
     *
     * Applied to the root layout so both the WebView and the splash clear the
     * status bar (and, for devices that route bars through cutout insets, the
     * display cutout). The listener re-applies on rotation and on foldables,
     * where the inset height changes.
     *
     * Edge-to-edge is only enforced from Android 15 / targetSdk 35; on older
     * releases the status bar was already opaque and the window did not extend
     * under it, so the insets read as zero and this is a no-op there.
     */
    private void applyDisplayCutoutPadding(FrameLayout container) {
        // WindowInsets.Type and the ime() mask are API 30+. Below that the
        // platform still draws an opaque status bar and resizes for the
        // keyboard (adjustResize), so there is nothing to compensate for.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;

        final int basePaddingLeft = container.getPaddingLeft();
        final int basePaddingTop = container.getPaddingTop();
        final int basePaddingRight = container.getPaddingRight();
        final int basePaddingBottom = container.getPaddingBottom();

        android.view.View.OnApplyWindowInsetsListener listener = (view, insets) -> {
            android.graphics.Insets bars =
                    insets.getInsets(android.view.WindowInsets.Type.systemBars()
                            | android.view.WindowInsets.Type.displayCutout()
                            // adjustResize is ignored under edge-to-edge; the
                            // keyboard arrives here instead. Padding the bottom
                            // by it keeps the page's own input fields above the
                            // keyboard.
                            | android.view.WindowInsets.Type.ime());
            container.setPadding(
                    basePaddingLeft + bars.left,
                    basePaddingTop + bars.top,
                    basePaddingRight + bars.right,
                    basePaddingBottom + bars.bottom);
            // Consumed: the WebView content is the only thing here, and letting
            // the inset propagate would double-apply it inside the page.
            return insets.inset(bars.left, bars.top, bars.right, bars.bottom);
        };
        container.setOnApplyWindowInsetsListener(listener);

        // Request the insets once now; the listener keeps them fresh afterwards.
        container.requestApplyInsets();
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
                    // The page now owns the screen; the floating handle is the
                    // way back to the shell's settings from here on.
                    if (settingsHandle != null) settingsHandle.setVisibility(View.VISIBLE);
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
        // Raise the foreground service first, so the runtime is never running
        // inside a process Android is free to freeze.
        ServerKeepAliveService.start(this);
        startElapsedTimer();
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
     * Show how long startup has taken, next to the phase text.
     *
     * The phase lines arrive every few seconds at best, and one of them ("打开
     * 本地数据库") can legitimately sit for half a minute on a cold start. A
     * counter is what tells an impatient user the app is alive and roughly how
     * long is left, without anyone having to interpret the phases.
     */
    private void startElapsedTimer() {
        splashStartedAt = System.currentTimeMillis();
        final android.os.Handler handler = new android.os.Handler(getMainLooper());
        final Runnable tick = new Runnable() {
            @Override
            public void run() {
                if (serverWasReady || splash == null || splash.getVisibility() != View.VISIBLE) {
                    return; // Done: stop ticking, leave the last text alone.
                }
                renderSplashStatus();
                handler.postDelayed(this, 1000);
            }
        };
        handler.postDelayed(tick, 1000);
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
        // The progress text comes from the server itself (OPENMAIC_STATUS lines
        // via onNodeStatus); this loop only watches for the port and hands over.
        while (System.currentTimeMillis() < deadline) {
            if (portAcceptsConnections()) {
                serverWasReady = true;
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
            splashPhase = text == null ? "" : text;
            renderSplashStatus();
        });
    }

    /**
     * Phase text plus elapsed seconds.
     *
     * The phase line comes from the server and changes a few times per boot; the
     * seconds come from a timer and change every second. Showing both together
     * answers both questions an impatient user has — what is it doing, and is it
     * stuck.
     */
    private void renderSplashStatus() {
        if (splashStatus == null) return;
        if (splashStartedAt < 0) {
            splashStatus.setText(splashPhase);
            return;
        }
        long seconds = (System.currentTimeMillis() - splashStartedAt) / 1000;
        splashStatus.setText(splashPhase + "（已等待 " + seconds + " 秒）");
    }

    private void showFailure(Throwable error) {
        runOnUiThread(() -> {
            // Freezes both the phase callback and the elapsed timer: whatever
            // failed has to stay on screen until the user acts on it.
            serverWasReady = true;
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

    /**
     * The backup/restore entry.
     *
     * Reached from the ongoing notification's action — the one surface that
     * stays available while the app runs, since the WebView owns every touch
     * once the page loads. The splash title is a second, discoverable route for
     * the first launch.
     */
    private void showDataMenu() {
        new android.app.AlertDialog.Builder(this)
                .setTitle("数据")
                .setItems(new String[] {"导出数据…", "恢复数据…", "应用设置…"}, (dialog, which) -> {
                    if (which == 0) startBackup();
                    else if (which == 1) startRestore();
                    else showSettingsDialog();
                })
                .show();
    }

    /**
     * The app's own switches.
     *
     * Deliberately minimal: everything the web UI configures (providers, model
     * settings) already has a screen; this is only for switches that belong to
     * the shell around it.
     */
    /**
     * The always-available settings handle: a small dimmed circle that opens the
     * settings dialog on tap and can be dragged anywhere.
     *
     * Half-transparent at rest so it does not compete with the page, opaque
     * while touched. Dragging uses raw deltas and writes the final position into
     * the layout params, so the page underneath never sees the gesture.
     */
    private View buildSettingsHandle() {
        TextView handle = new TextView(this);
        handle.setText("⚙");
        handle.setTextSize(18);
        handle.setTextColor(Color.rgb(55, 65, 81));
        handle.setGravity(android.view.Gravity.CENTER);
        android.graphics.drawable.GradientDrawable background =
                new android.graphics.drawable.GradientDrawable();
        background.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        background.setColor(Color.argb(230, 255, 255, 255));
        background.setStroke(dp(1), Color.argb(60, 0, 0, 0));
        handle.setBackground(background);
        handle.setAlpha(0.55f);
        handle.setContentDescription("应用设置");
        int size = dp(44);
        handle.setWidth(size);
        handle.setHeight(size);

        handle.setOnClickListener(v -> showSettingsDialog());

        handle.setOnTouchListener(new View.OnTouchListener() {
            private float downRawX, downRawY;
            private int downLeft, downTop;
            private boolean dragging;

            @Override
            public boolean onTouch(View view, android.view.MotionEvent event) {
                FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) view.getLayoutParams();
                switch (event.getActionMasked()) {
                    case android.view.MotionEvent.ACTION_DOWN:
                        downRawX = event.getRawX();
                        downRawY = event.getRawY();
                        // Measure where the handle actually is rather than
                        // trusting the margins: while gravity-anchored the
                        // margins are zero and the view sits at the top-end.
                        int[] location = new int[2];
                        view.getLocationInWindow(location);
                        downLeft = location[0];
                        downTop = location[1];
                        dragging = false;
                        view.setAlpha(1f);
                        return false; // Let a simple tap reach the click listener.
                    case android.view.MotionEvent.ACTION_MOVE: {
                        float dx = event.getRawX() - downRawX;
                        float dy = event.getRawY() - downRawY;
                        if (!dragging && Math.hypot(dx, dy) < dp(8)) return false;
                        dragging = true;
                        params.gravity = android.view.Gravity.TOP | android.view.Gravity.START;
                        params.leftMargin = Math.max(0, Math.round(downLeft + dx));
                        params.topMargin = Math.max(0, Math.round(downTop + dy));
                        view.setLayoutParams(params);
                        return true;
                    }
                    case android.view.MotionEvent.ACTION_UP:
                    case android.view.MotionEvent.ACTION_CANCEL:
                        view.setAlpha(0.55f);
                        if (dragging) {
                            rememberHandlePosition(params.leftMargin, params.topMargin);
                            return true;
                        }
                        return false;
                    default:
                        return false;
                }
            }
        });
        return handle;
    }

    /** Restore where the user last parked the handle, if they moved it. */
    private void restoreHandlePosition(FrameLayout.LayoutParams params) {
        android.content.SharedPreferences prefs = getSharedPreferences("openmaic", MODE_PRIVATE);
        int left = prefs.getInt("handleLeft", -1);
        int top = prefs.getInt("handleTop", -1);
        if (left < 0 || top < 0) return;
        params.gravity = android.view.Gravity.TOP | android.view.Gravity.START;
        params.leftMargin = left;
        params.topMargin = top;
    }

    private void rememberHandlePosition(int left, int top) {
        getSharedPreferences("openmaic", MODE_PRIVATE)
                .edit()
                .putInt("handleLeft", left)
                .putInt("handleTop", top)
                .apply();
    }

    private void showSettingsDialog() {
        android.widget.LinearLayout panel = new android.widget.LinearLayout(this);
        panel.setOrientation(android.widget.LinearLayout.VERTICAL);
        int pad = dp(20);
        panel.setPadding(pad, pad / 2, pad, 0);

        android.widget.CheckBox allowLocal = new android.widget.CheckBox(this);
        allowLocal.setText("允许访问局域网模型服务");
        allowLocal.setChecked(DeviceSettings.readAllowLocalNetworks(this));
        panel.addView(allowLocal);

        android.widget.TextView hint = new android.widget.TextView(this);
        hint.setText("勾选后，模型服务商可以填写局域网地址（如 LM Studio、Ollama 的 http://192.168.x.x:端口）。\n\n修改在下次启动应用后生效。\n\n仅在你信任所在网络时开启。");
        hint.setTextSize(13);
        hint.setTextColor(Color.rgb(107, 114, 128));
        hint.setPadding(0, dp(8), 0, dp(12));
        panel.addView(hint);

        new android.app.AlertDialog.Builder(this)
                .setTitle("应用设置")
                .setView(panel)
                .setNegativeButton("取消", null)
                .setPositiveButton("保存", (dialog, which) -> {
                    boolean checked = allowLocal.isChecked();
                    if (checked == DeviceSettings.readAllowLocalNetworks(this)) return;
                    runDataTask("正在保存…", () -> {
                        DeviceSettings.writeAllowLocalNetworks(this, checked);
                        return "设置已保存，下次启动生效";
                    });
                })
                .show();
    }

    private void startBackup() {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/zip")
                .putExtra(Intent.EXTRA_TITLE, DataBackup.suggestedFileName());
        try {
            startActivityForResult(intent, REQUEST_BACKUP);
        } catch (Exception error) {
            Log.w(TAG, "no document provider for backup", error);
            toast("没有可用的文件选择器");
        }
    }

    private void startRestore() {
        new android.app.AlertDialog.Builder(this)
                .setTitle("恢复数据")
                .setMessage("这会用备份文件替换当前的课程与设置。\n当前数据会在替换前保留一份，成功后才删除。")
                .setNegativeButton("取消", null)
                .setPositiveButton("选择文件", (dialog, which) -> {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                            .addCategory(Intent.CATEGORY_OPENABLE)
                            .setType("application/zip");
                    try {
                        startActivityForResult(intent, REQUEST_RESTORE);
                    } catch (Exception error) {
                        Log.w(TAG, "no document provider for restore", error);
                        toast("没有可用的文件选择器");
                    }
                })
                .show();
    }

    /** Run a backup operation off the UI thread and report the outcome. */
    private void runDataTask(String working, java.util.concurrent.Callable<String> task) {
        toast(working);
        new Thread(() -> {
            try {
                String summary = task.call();
                runOnUiThread(() -> toast("完成：" + summary));
            } catch (Exception error) {
                Log.e(TAG, "data task failed", error);
                runOnUiThread(() -> toast("失败：" + error.getMessage()));
            }
        }, "openmaic-data").start();
    }

    private void toast(String message) {
        runOnUiThread(() -> android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show());
    }

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
        if (requestCode == REQUEST_BACKUP) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                Uri target = data.getData();
                runDataTask("正在导出…", () -> DataBackup.exportTo(this, target));
            }
            return;
        }
        if (requestCode == REQUEST_RESTORE) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                Uri source = data.getData();
                runDataTask("正在恢复…", () -> {
                    String summary = DataBackup.importFrom(this, source);
                    // The running server holds the old database open; the new
                    // files only take effect on a fresh launch.
                    return summary + "\n请重启 OpenMAIC 使恢复的数据生效。";
                });
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // The runtime lives in this process, so a process kill takes the server
        // with it and the WebView is left holding a page whose backend is gone.
        // Rather than let the user click into dead buttons, re-check the port
        // and say so. A restart is not attempted: node::Start can only run once
        // per process, so reviving it would need a fresh process.
        if (serverWasReady && webView != null) {
            new Thread(() -> {
                if (portAcceptsConnections()) return;
                runOnUiThread(this::showServerGone);
            }, "openmaic-health").start();
        }
    }

    private void showServerGone() {
        if (splash == null) return;
        splash.setVisibility(View.VISIBLE);
        if (splashProgress != null) splashProgress.setVisibility(View.GONE);
        if (splashStatus != null) {
            splashStatus.setText("本地服务已停止（应用被系统回收）。\n请重新启动 OpenMAIC。");
        }
    }

    @Override
    protected void onDestroy() {
        // The native side holds a global reference to this activity; dropping it
        // here is what lets a destroyed activity be collected, and stops
        // callbacks into an object whose views are gone.
        NodeRuntime.setStatusListener(null);
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        // Only stop the service when the activity is finishing: a rotation or a
        // configuration change also destroys it, and tearing the service down
        // then would leave the runtime unprotected for the recreated activity.
        if (isFinishing()) {
            ServerKeepAliveService.stop(this);
        }
        super.onDestroy();
    }
}
