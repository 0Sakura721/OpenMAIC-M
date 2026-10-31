package ai.openmaic.mobile;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * The app's own switches, read by the Node runtime at startup.
 *
 * Stored as `<filesDir>/openmaic/mobile-settings.json`, because that directory
 * is where the server already looks for state and what the backup archive
 * captures — a switch survives a backup/restore cycle the same way a course
 * does. Node reads it once per launch (mobile/runtime/start.mjs), so a change
 * takes effect on next launch.
 *
 * One switch today:
 *
 *   - `allowLocalNetworks` — sets ALLOW_LOCAL_NETWORKS for the server process.
 *     The upstream SSRF guard refuses private/loopback targets by default,
 *     which is right for a cloud deployment and wrong for a phone: the point
 *     of running locally is to reach a model server on the same Wi-Fi
 *     (LM Studio, Ollama, llama.cpp). Default off, because the switch does
 *     relax a real (if small) guard.
 */
final class DeviceSettings {

    private static final String TAG = "OpenMAIC";

    static final String FILE_NAME = "mobile-settings.json";

    private DeviceSettings() {}

    static File file(Context context) {
        return new File(new File(context.getFilesDir(), "openmaic"), FILE_NAME);
    }

    /** Read one boolean switch; any problem reads as the default (false). */
    static boolean readAllowLocalNetworks(Context context) {
        try (FileInputStream input = new FileInputStream(file(context))) {
            byte[] bytes = new byte[input.available()];
            int read = input.read(bytes);
            JSONObject json = new JSONObject(new String(bytes, 0, Math.max(read, 0), StandardCharsets.UTF_8));
            return json.optBoolean("allowLocalNetworks", false);
        } catch (Exception notThere) {
            return false;
        }
    }

    /**
     * Write one boolean switch, preserving any other keys a future version adds.
     *
     * Runs on the caller's thread; the settings dialog calls this from a worker.
     */
    static void writeAllowLocalNetworks(Context context, boolean value) throws Exception {
        File target = file(context);
        JSONObject json = new JSONObject();
        // Preserve existing keys so an update that adds switches does not wipe
        // what the user already set.
        try (FileInputStream input = new FileInputStream(target)) {
            byte[] bytes = new byte[input.available()];
            int read = input.read(bytes);
            json = new JSONObject(new String(bytes, 0, Math.max(read, 0), StandardCharsets.UTF_8));
        } catch (Exception noFileYet) {
            // First write: start from an empty object.
        }
        json.put("allowLocalNetworks", value);
        Log.i(TAG, "mobile-settings: allowLocalNetworks=" + value);

        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
            throw new Exception("无法创建设置目录");
        }
        try (FileOutputStream output = new FileOutputStream(target)) {
            output.write(json.toString().getBytes(StandardCharsets.UTF_8));
        }
    }
}
