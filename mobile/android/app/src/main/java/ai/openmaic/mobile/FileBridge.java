package ai.openmaic.mobile;

import android.app.Activity;
import android.content.ContentResolver;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;

import java.io.OutputStream;

/**
 * Hands a file the page produced to Android's file picker.
 *
 * The page saves files with `file-saver`, which builds a Blob URL and clicks an
 * anchor. A WebView has no download manager of its own, and it does not route
 * `blob:` through `DownloadListener` either, so that click did nothing at all —
 * exporting a course, a PPTX or a standalone HTML page all appeared to work and
 * silently produced nothing.
 *
 * The page cannot hand a Blob across the bridge, so the flow is two steps: the
 * script reads the Blob as base64 and calls {@link #save}, this class remembers
 * the bytes, asks the user where to put them, and {@link #put} writes them once
 * the picker answers.
 *
 * Base64 rather than bytes through a byte[] bridge: `addJavascriptInterface`
 * only marshals strings and primitives reliably, and a JPEG-sized payload is
 * fine while a 200 MB course export is not — so {@link #save} refuses anything
 * over the cap rather than throwing an OOM in the middle of a download.
 */
final class FileBridge {

    private static final String TAG = "OpenMAIC";

    /** Where the pending write goes. Set by {@link #save}, consumed by {@link #put}. */
    private static byte[] pending;
    private static String pendingName = "download";
    private static String pendingMime = "application/octet-stream";
    /** The last failure, for the page to report instead of guessing. */
    private static String lastError;

    /**
     * Above this the base64 round trip stops being reasonable. A course zip of
     * that size is possible; it is refused with a message the page shows, which
     * is better than a WebView crash nobody can attribute.
     */
    private static final int MAX_BASE64_CHARS = 96 * 1024 * 1024;

    private final MainActivity activity;

    FileBridge(MainActivity activity) {
        this.activity = activity;
    }

    /**
     * Called from the page with the file's contents, base64-encoded.
     *
     * Must not throw: an exception crossing the bridge surfaces in the page as an
     * opaque error. Everything is answered through {@link #lastError} instead.
     */
    @JavascriptInterface
    public boolean save(String base64, String name, String mime) {
        try {
            if (base64 == null || base64.isEmpty()) {
                lastError = "文件是空的";
                return false;
            }
            if (base64.length() > MAX_BASE64_CHARS) {
                lastError = "文件太大（约 " + (base64.length() / 1024 / 1024) + " MB），无法直接保存";
                return false;
            }
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            String safeName = (name == null || name.trim().isEmpty()) ? "download" : name.trim();
            // A name is only ever a suggestion to the picker, but stripping the
            // separators keeps a stray "../" from reading as a path.
            safeName = safeName.replace('/', '_').replace('\\', '_');

            pending = bytes;
            pendingName = safeName;
            pendingMime = (mime == null || mime.trim().isEmpty())
                    ? "application/octet-stream"
                    : mime.trim();
            lastError = null;
            activity.runOnUiThread(activity::startSavePicker);
            return true;
        } catch (Throwable error) {
            Log.e(TAG, "file bridge: save failed", error);
            lastError = error.getMessage() == null ? error.toString() : error.getMessage();
            return false;
        }
    }

    /** The last failure, for the page to report instead of guessing. */
    @JavascriptInterface
    public String lastError() {
        return lastError == null ? "" : lastError;
    }

    /** The name to offer the picker, before the user changes it. */
    static String suggestedName() {
        return pendingName;
    }

    /** The MIME type to hand the picker, so it filters sensibly. */
    static String mimeType() {
        return pendingMime;
    }

    /**
     * Write the bytes the page handed over to a destination the user chose.
     *
     * Runs on a worker: a course zip is tens of megabytes and writing it on the
     * UI thread would freeze the window for the duration.
     */
    static void put(Activity activity, Uri destination) throws Exception {
        byte[] bytes = pending;
        if (bytes == null) throw new Exception("没有待保存的文件");
        ContentResolver resolver = activity.getContentResolver();
        try (OutputStream output = resolver.openOutputStream(destination, "wt")) {
            if (output == null) throw new Exception("无法写入所选位置");
            output.write(bytes);
            output.flush();
        } finally {
            // Released whether or not the write landed: a retry re-sends the
            // bytes rather than resurrecting a half-consumed buffer.
            pending = null;
        }
    }

    /** True when {@link #put} has something to write. */
    static boolean hasPending() {
        return pending != null;
    }

    static void clearPending() {
        pending = null;
    }
}
