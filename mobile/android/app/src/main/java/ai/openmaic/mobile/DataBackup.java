package ai.openmaic.mobile;

import android.content.ContentResolver;
import android.content.Context;
import android.net.Uri;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/**
 * Export and restore everything the user would be upset to lose.
 *
 * The app stores its state in two directories under `filesDir`: the unpacked
 * runtime payload and, more importantly, `openmaic/` — the PGlite database that
 * holds every course, plus the model settings sealed with the instance key.
 * `allowBackup` is false (the runtime and database are far too large for
 * Android's auto-backup quota, and a partial restore would be worse than none),
 * so without this there is no way to move to a new phone or recover from a
 * reinstall.
 *
 * The archive is a plain zip, not encrypted: the user is the only one who can
 * read the destination they chose, and an app-level password would be one more
 * secret to lose. What it deliberately does *not* contain:
 *
 *   - the unpacked payload (it is rebuilt from the APK on next launch);
 *   - the runtime's own temp/cache files.
 *
 * A restore writes into `openmaic/` only, and refuses an archive that contains
 * paths outside it.
 */
final class DataBackup {

    private static final String TAG = "OpenMAIC";

    /** Directory holding everything worth keeping, relative to filesDir. */
    private static final String DATA_DIR = "openmaic";

    private DataBackup() {}

    /** A file name the user can recognise, with a sortable timestamp. */
    static String suggestedFileName() {
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmm", Locale.US).format(new Date());
        return "OpenMAIC-backup-" + stamp + ".zip";
    }

    /**
     * Write a zip of the data directory to `destination`.
     *
     * Returns a short summary for the UI: entry count and total bytes written.
     */
    static String exportTo(Context context, Uri destination) throws IOException {
        File dataDir = new File(context.getFilesDir(), DATA_DIR);
        if (!dataDir.isDirectory()) {
            throw new IOException("还没有可导出的数据（尚未产生课程）");
        }

        ContentResolver resolver = context.getContentResolver();
        int entries = 0;
        long bytes = 0;
        try (OutputStream raw = resolver.openOutputStream(destination, "wt");
             ZipOutputStream zip = new ZipOutputStream(new BufferedOutputStream(raw))) {
            if (raw == null) throw new IOException("无法写入所选位置");

            byte[] buffer = new byte[1 << 16];
            for (File file : walk(dataDir)) {
                String entryName = DATA_DIR + "/" + relativize(dataDir, file);
                ZipEntry entry = new ZipEntry(entryName);
                entry.setTime(file.lastModified());
                zip.putNextEntry(entry);
                try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
                    int read;
                    while ((read = input.read(buffer)) > 0) {
                        zip.write(buffer, 0, read);
                        bytes += read;
                    }
                }
                zip.closeEntry();
                entries++;
            }

            // A manifest the restore path can sanity-check, and the user can
            // read with any unzip tool to see what the file is.
            zip.putNextEntry(new ZipEntry("MANIFEST.txt"));
            String manifest = "OpenMAIC-M backup\n"
                    + "created=" + new SimpleDateFormat("yyyy-MM-dd HH:mm:ss Z", Locale.US).format(new Date()) + "\n"
                    + "entries=" + entries + "\n"
                    + "bytes=" + bytes + "\n";
            zip.write(manifest.getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
        }

        Log.i(TAG, "exported " + entries + " files, " + bytes + " bytes");
        return entries + " 个文件，" + (bytes / 1048576) + " MB";
    }

    /**
     * Replace the data directory with the contents of `source`.
     *
     * The existing directory is moved aside first and only deleted once the new
     * one is fully written, so an archive that turns out to be truncated leaves
     * the user where they started instead of with neither copy.
     */
    static String importFrom(Context context, Uri source) throws IOException {
        File dataDir = new File(context.getFilesDir(), DATA_DIR);
        File staging = new File(context.getFilesDir(), DATA_DIR + ".restore");
        File previous = new File(context.getFilesDir(), DATA_DIR + ".previous");

        deleteRecursively(staging);
        deleteRecursively(previous);
        if (!staging.mkdirs()) throw new IOException("无法创建恢复目录");

        ContentResolver resolver = context.getContentResolver();
        int entries = 0;
        long bytes = 0;
        byte[] buffer = new byte[1 << 16];

        String stagingRoot = staging.getCanonicalPath() + File.separator;
        try (InputStream raw = resolver.openInputStream(source);
             ZipInputStream zip = new ZipInputStream(new BufferedInputStream(raw))) {
            if (raw == null) throw new IOException("无法读取所选文件");

            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                String name = entry.getName();
                if (entry.isDirectory()) continue;
                // The archive is the user's to choose, so nothing about it is
                // trusted: an entry may not escape the restore directory.
                if (name.contains("..") || name.startsWith("/")) {
                    throw new IOException("压缩包包含非法路径：" + name);
                }
                String relative = name.startsWith(DATA_DIR + "/")
                        ? name.substring(DATA_DIR.length() + 1)
                        : name;
                if (relative.equals("MANIFEST.txt")) continue;

                File target = new File(staging, relative);
                String canonical = target.getCanonicalPath();
                if (!canonical.startsWith(stagingRoot)) {
                    throw new IOException("压缩包包含非法路径：" + name);
                }
                File parent = target.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
                    throw new IOException("无法创建 " + parent);
                }
                try (OutputStream out = new BufferedOutputStream(new FileOutputStream(target))) {
                    int read;
                    while ((read = zip.read(buffer)) > 0) {
                        out.write(buffer, 0, read);
                        bytes += read;
                    }
                }
                entries++;
                zip.closeEntry();
            }
        } catch (IOException error) {
            deleteRecursively(staging);
            throw error;
        }

        if (entries == 0) {
            deleteRecursively(staging);
            throw new IOException("压缩包里没有数据");
        }

        // Swap: keep the old copy until the new one is in place.
        if (dataDir.exists() && !dataDir.renameTo(previous)) {
            deleteRecursively(staging);
            throw new IOException("无法暂存现有数据");
        }
        if (!staging.renameTo(dataDir)) {
            // Put the old copy back; failing that, the data is still in
            // `previous` and the message says so.
            previous.renameTo(dataDir);
            deleteRecursively(staging);
            throw new IOException("无法应用恢复的数据");
        }
        deleteRecursively(previous);

        Log.i(TAG, "restored " + entries + " files, " + bytes + " bytes");
        return entries + " 个文件，" + (bytes / 1048576) + " MB";
    }

    /** Every regular file under `root`, depth-first. */
    private static java.util.List<File> walk(File root) {
        java.util.List<File> files = new java.util.ArrayList<>();
        collect(root, files);
        return files;
    }

    private static void collect(File directory, java.util.List<File> out) {
        File[] children = directory.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (child.isDirectory()) collect(child, out);
            else if (child.isFile()) out.add(child);
        }
    }

    /** `file`'s path relative to `root`, with forward slashes for the zip. */
    private static String relativize(File root, File file) {
        String rootPath = root.getAbsolutePath();
        String filePath = file.getAbsolutePath();
        String relative = filePath.startsWith(rootPath) ? filePath.substring(rootPath.length()) : filePath;
        if (relative.startsWith(File.separator)) relative = relative.substring(1);
        return relative.replace(File.separatorChar, '/');
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
