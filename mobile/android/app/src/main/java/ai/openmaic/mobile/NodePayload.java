package ai.openmaic.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.system.Os;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Unpacks the Node project out of the APK and starts the runtime.
 *
 * The payload is hundreds of megabytes of JavaScript, WebAssembly and static
 * assets, shipped as a single zip asset. It cannot be run from inside the APK:
 * an APK is itself a zip that the platform only reads through its index, so
 * every `read()` of a module would decompress the whole entry again. So on
 * first launch — and after every app update — it is inflated into the app's
 * private storage, where the files are ordinary and the runtime mmaps them.
 *
 * The unpack is versioned by the APK's `lastUpdateTime`: an update replaces the
 * payload wholesale rather than merging into it, because a half-updated tree
 * would run a mix of two builds, and that failure looks like a random crash.
 */
final class NodePayload {

    private static final String TAG = "OpenMAICNode";

    /** Where the payload is unpacked, under filesDir. */
    static final String PAYLOAD_DIR = "payload";

    /** The asset the build writes the archive to. */
    private static final String ASSET_NAME = "payload.zip";

    private static final String PREFS = "openmaic";
    private static final String PREF_UNPACKED_AT = "payloadUnpackedAt";

    private NodePayload() {}

    /** Unpack the payload if this APK's build has not been unpacked yet. */
    static File ensureUnpacked(Context context) throws IOException {
        File target = new File(context.getFilesDir(), PAYLOAD_DIR);
        long installedAt = lastUpdateTime(context);

        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean current =
                target.isDirectory()
                        && prefs.getLong(PREF_UNPACKED_AT, -1) == installedAt
                        && new File(target, "mobile/start.mjs").isFile();

        if (!current) {
            Log.i(TAG, "unpacking payload into " + target + " (build " + installedAt + ")");
            long started = System.currentTimeMillis();
            deleteRecursively(target);
            if (!target.mkdirs() && !target.isDirectory()) {
                throw new IOException("could not create " + target);
            }
            int files = inflate(context, target);
            prefs.edit().putLong(PREF_UNPACKED_AT, installedAt).apply();
            Log.i(TAG, "unpacked " + files + " files in "
                    + (System.currentTimeMillis() - started) + " ms");
        }
        return target;
    }

    /**
     * Inflate `assets/payload.zip` into `target`.
     *
     * Entry names are resolved against `target` and rejected if they escape it:
     * a `..` in an archive is a path-traversal bug, and the payload is produced
     * by this repository's own build, so refusing the entry costs nothing and
     * removes the class of bug entirely.
     */
    private static int inflate(Context context, File target) throws IOException {
        String canonicalTarget = target.getCanonicalPath() + File.separator;
        int files = 0;
        try (InputStream raw = context.getAssets().open(ASSET_NAME);
             ZipInputStream zip = new ZipInputStream(new BufferedInputStream(raw, 1 << 16))) {
            ZipEntry entry;
            byte[] buffer = new byte[1 << 16];
            while ((entry = zip.getNextEntry()) != null) {
                File destination = new File(target, entry.getName());
                String canonical = destination.getCanonicalPath();
                if (!canonical.startsWith(canonicalTarget)) {
                    throw new IOException("payload entry escapes the app directory: " + entry.getName());
                }
                if (entry.isDirectory()) {
                    if (!destination.mkdirs() && !destination.isDirectory()) {
                        throw new IOException("could not create " + destination);
                    }
                    continue;
                }
                File parent = destination.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
                    throw new IOException("could not create " + parent);
                }
                try (OutputStream out = new FileOutputStream(destination)) {
                    int read;
                    while ((read = zip.read(buffer)) > 0) {
                        out.write(buffer, 0, read);
                    }
                }
                files++;
                zip.closeEntry();
            }
        }
        if (files == 0) {
            throw new IOException("the payload archive is empty or missing");
        }
        return files;
    }

    /**
     * Start the runtime against an unpacked payload.
     *
     * The environment is set before the thread starts because nodejs-mobile
     * reads it during bootstrap: `TMPDIR` points at the app's cache (the
     * default `/tmp` does not exist on Android), and `HOME` at filesDir so a
     * module that resolves `~` stays inside app-private storage.
     */
    static void start(Context context, File payloadDir) {
        try {
            Os.setenv("TMPDIR", context.getCacheDir().getAbsolutePath(), true);
            Os.setenv("HOME", context.getFilesDir().getAbsolutePath(), true);
            Os.setenv("NODE_ENV", "production", true);
            Os.setenv("COOKIE_SECURE", "0", true);
            Os.setenv("PORT", String.valueOf(MainActivity.SERVER_PORT), true);
            Os.setenv("OPENMAIC_DATA_DIR", context.getFilesDir().getAbsolutePath(), true);
        } catch (Exception error) {
            Log.e(TAG, "could not set the runtime environment", error);
        }

        String[] args = {"mobile/start.mjs"};
        int started = NodeRuntime.startNode(args, payloadDir.getAbsolutePath());
        if (started != 0) {
            throw new IllegalStateException("Node.js runtime failed to start");
        }
    }

    private static long lastUpdateTime(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return info.lastUpdateTime;
        } catch (Exception error) {
            Log.w(TAG, "could not read the package update time", error);
            return 0;
        }
    }

    private static void deleteRecursively(File file) {
        if (!file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursively(child);
        }
        if (!file.delete()) Log.w(TAG, "could not delete " + file);
    }
}
