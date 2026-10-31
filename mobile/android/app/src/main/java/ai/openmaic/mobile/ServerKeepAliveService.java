package ai.openmaic.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

/**
 * Keeps the in-process server alive while the app is not in front.
 *
 * Why this exists: the OpenMAIC server is a Node runtime on a thread inside
 * this app's process, and Android treats a backgrounded process as free real
 * estate. Without a foreground service the runtime is frozen within seconds of
 * the user switching away — generation stops, the SSE streams stall, and
 * returning to the app finds a page that can no longer reach its backend. With
 * one, the process is a foreground process and keeps running; a partial wake
 * lock keeps the CPU awake for the (often minutes-long) course generation the
 * user started before putting the phone down.
 *
 * The service owns only the notification and the wake lock. It deliberately
 * does not start, stop or restart the runtime: that lifecycle belongs to
 * {@link MainActivity} and {@link NodePayload}, and a service that also
 * controlled it would have to duplicate the "already started" arbitration.
 */
public class ServerKeepAliveService extends Service {

    private static final String TAG = "OpenMAIC";

    static final String CHANNEL_ID = "openmaic_server";
    private static final int NOTIFICATION_ID = 0x0A11;

    static final String ACTION_START = "ai.openmaic.mobile.SERVER_START";
    static final String ACTION_STOP = "ai.openmaic.mobile.SERVER_STOP";

    private PowerManager.WakeLock wakeLock;

    /** Start (or refresh) the foreground service. Safe to call repeatedly. */
    static void start(Context context) {
        Intent intent = new Intent(context, ServerKeepAliveService.class).setAction(ACTION_START);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception error) {
            // A background start can be refused (Android 12+ restricts it). The
            // app is then in the foreground anyway, so the next foreground
            // activity start will succeed — log rather than crash the boot.
            Log.w(TAG, "could not start the keep-alive service", error);
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, ServerKeepAliveService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        startInForeground();
        acquireWakeLock();
        // START_STICKY: if the process is killed under memory pressure, the
        // system restarts the service. The runtime itself cannot be revived
        // from here (node::Start runs once per process), so the activity
        // detects a dead port on resume and reports it rather than pretending
        // the server is up.
        return START_STICKY;
    }

    private void startInForeground() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "OpenMAIC 服务",
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("保持本地服务运行，以便课程生成在后台继续");
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }

        Intent open = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this,
                0,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // The ongoing notification is the one surface always reachable while the
        // app runs, so it carries the entry to backup/restore: the WebView owns
        // every touch once the page loads, and the splash is gone by then.
        Intent backup = new Intent(this, MainActivity.class)
                .setAction(MainActivity.ACTION_DATA_MENU)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent backupIntent = PendingIntent.getActivity(
                this,
                1,
                backup,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification notification = new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("OpenMAIC 正在运行")
                .setContentText("本地服务已启动，课程生成可继续")
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentIntent(contentIntent)
                .addAction(new Notification.Action.Builder(
                        android.graphics.drawable.Icon.createWithResource(
                                this, android.R.drawable.ic_menu_save),
                        "数据备份",
                        backupIntent).build())
                .setOngoing(true)
                .setShowWhen(false)
                .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // `dataSync` is the honest type: the work is local I/O and model
            // calls, not media playback or location.
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    /**
     * Hold the CPU awake while the app is in the background.
     *
     * Deliberately a *partial* wake lock with a timeout: it keeps the CPU
     * running so a generation pass is not suspended mid-write, without forcing
     * the screen on. The timeout is the backstop for a bug that forgets to
     * release it — ten minutes is longer than any single generation step, and
     * the lock is released explicitly on service destruction.
     */
    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power == null) return;
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "openmaic:server");
        wakeLock.setReferenceCounted(false);
        try {
            wakeLock.acquire(10 * 60 * 1000L);
        } catch (Exception error) {
            Log.w(TAG, "could not acquire the wake lock", error);
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (Exception error) {
                Log.w(TAG, "could not release the wake lock", error);
            }
        }
        wakeLock = null;
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
