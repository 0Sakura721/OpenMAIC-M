package ai.openmaic.mobile;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * The app's own switches.
 *
 * Stored as `<filesDir>/openmaic/mobile-settings.json`, because that directory
 * is where the server already looks for state and what the backup archive
 * captures — a switch survives a backup/restore cycle the same way a course
 * does. Node reads the file once per launch (mobile/runtime/start.mjs).
 *
 * Keys today:
 *
 *   - `allowLocalNetworks` — sets ALLOW_LOCAL_NETWORKS for the server process.
 *     The upstream SSRF guard refuses private/loopback targets by default,
 *     which is right for a cloud deployment and wrong for a phone: the point
 *     of running locally is to reach a model server on the same Wi-Fi
 *     (LM Studio, Ollama, llama.cpp). Default off, because the switch does
 *     relax a real (if small) guard.
 *   - `autoCheckUpdates` — check for a new build on launch. Default off: an
 *     unprompted network request every start is not something to opt people
 *     into silently, and the check is available by hand anyway.
 *   - `updateChannel` — `release` or `preview`. Controls which builds count as
 *     an update. Every build published so far is a pre-release, so `release`
 *     is the conservative default: it stays quiet until a finished version
 *     exists.
 *
 * The whole file is rewritten on every save so unknown keys from a newer build
 * survive a downgrade instead of being dropped.
 */
final class DeviceSettings {

    private static final String TAG = "OpenMAIC";

    static final String FILE_NAME = "mobile-settings.json";

    static final String KEY_ALLOW_LOCAL_NETWORKS = "allowLocalNetworks";
    static final String KEY_AUTO_CHECK_UPDATES = "autoCheckUpdates";
    static final String KEY_UPDATE_CHANNEL = "updateChannel";

    /** Which builds the user is willing to be offered. */
    static final String CHANNEL_RELEASE = "release";
    static final String CHANNEL_PREVIEW = "preview";

    private DeviceSettings() {}

    static File file(Context context) {
        return new File(new File(context.getFilesDir(), "openmaic"), FILE_NAME);
    }

    /** The stored object, or an empty one when the file is absent or unreadable. */
    private static JSONObject read(Context context) {
        try (FileInputStream input = new FileInputStream(file(context))) {
            byte[] bytes = new byte[input.available()];
            int read = input.read(bytes);
            return new JSONObject(new String(bytes, 0, Math.max(read, 0), StandardCharsets.UTF_8));
        } catch (Exception notThere) {
            return new JSONObject();
        }
    }

    static boolean readAllowLocalNetworks(Context context) {
        return read(context).optBoolean(KEY_ALLOW_LOCAL_NETWORKS, false);
    }

    static boolean readAutoCheckUpdates(Context context) {
        return read(context).optBoolean(KEY_AUTO_CHECK_UPDATES, false);
    }

    /** {@link #CHANNEL_RELEASE} unless the user chose otherwise. */
    static String readUpdateChannel(Context context) {
        String channel = read(context).optString(KEY_UPDATE_CHANNEL, CHANNEL_RELEASE);
        return CHANNEL_PREVIEW.equals(channel) ? CHANNEL_PREVIEW : CHANNEL_RELEASE;
    }

    /** Write several switches at once, merging into whatever is already stored. */
    static synchronized void write(Context context, JSONObject changes) throws Exception {
        File target = file(context);
        JSONObject json = read(context);
        java.util.Iterator<String> keys = changes.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            json.put(key, changes.get(key));
        }

        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
            throw new Exception("无法创建设置目录");
        }
        // Written under a temporary name and then renamed: a process killed
        // mid-write would otherwise leave a truncated JSON file, and every
        // switch would silently read as its default.
        File temporary = new File(target.getPath() + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(json.toString().getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
        if (!temporary.renameTo(target)) {
            throw new Exception("无法保存设置");
        }
        Log.i(TAG, "mobile-settings: " + json);
    }

    static void writeAllowLocalNetworks(Context context, boolean value) throws Exception {
        JSONObject changes = new JSONObject();
        changes.put(KEY_ALLOW_LOCAL_NETWORKS, value);
        write(context, changes);
    }
}
