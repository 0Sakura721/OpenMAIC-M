package ai.openmaic.mobile;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Asks the project's GitHub releases whether a newer build exists.
 *
 * Deliberately reads only the public Releases API: no account, no token, no
 * analytics. The request carries the User-Agent GitHub requires and nothing
 * else identifying.
 *
 * Two things decide whether a build counts as an update:
 *
 *   - the channel — {@link DeviceSettings#CHANNEL_RELEASE} ignores
 *     pre-releases, {@link DeviceSettings#CHANNEL_PREVIEW} considers both.
 *     Every build published so far is a pre-release, so the default channel
 *     finds nothing until a finished version exists.
 *   - the version — the tag's `m` number is compared against the installed
 *     `versionName`, which CI sets from the tag. A plain `versionCode` compare
 *     would not work: the code is not known to the release page.
 *
 * Runs on a worker thread; the caller owns threading and UI.
 */
final class UpdateChecker {

    private static final String TAG = "OpenMAIC";

    private static final String RELEASES_URL =
            "https://api.github.com/repos/0Sakura721/OpenMAIC-M/releases?per_page=30";

    /** What the check found. */
    static final class Result {
        /** True when a build newer than the installed one is published. */
        final boolean available;
        /** The newer tag, or the installed version when nothing is newer. */
        final String version;
        final String notes;
        final String apkUrl;
        /** Set when the check could not be made at all. */
        final String error;

        private Result(boolean available, String version, String notes, String apkUrl, String error) {
            this.available = available;
            this.version = version;
            this.notes = notes;
            this.apkUrl = apkUrl;
            this.error = error;
        }

        static Result none(String installed) {
            return new Result(false, installed, null, null, null);
        }

        static Result failure(String message) {
            return new Result(false, null, null, null, message);
        }
    }

    private UpdateChecker() {}

    /** The installed `versionName`, which is the release tag CI built from. */
    static String installedVersion(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return info.versionName == null ? "0" : info.versionName;
        } catch (Exception unknown) {
            return "0";
        }
    }

    /**
     * Perform the check. Blocking; call from a worker thread.
     *
     * @param channel {@link DeviceSettings#CHANNEL_RELEASE} or
     *                {@link DeviceSettings#CHANNEL_PREVIEW}
     */
    static Result check(Context context, String channel) {
        String installed = installedVersion(context);
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(RELEASES_URL).openConnection();
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(15_000);
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            // GitHub rejects requests without a User-Agent.
            connection.setRequestProperty("User-Agent", "OpenMAIC-M/" + installed);

            int status = connection.getResponseCode();
            if (status != 200) {
                return Result.failure("服务器返回 " + status);
            }
            String body = readAll(connection.getInputStream());
            return pick(installed, channel, new JSONArray(body));
        } catch (Exception error) {
            Log.w(TAG, "update check failed", error);
            return Result.failure(error.getMessage() == null ? error.toString() : error.getMessage());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /**
     * Walk the release list and keep the newest tag that this channel accepts
     * and that is newer than what is installed.
     *
     * The list is ordered newest-first by GitHub, but every entry is compared
     * rather than trusting position: a draft or a malformed tag must not be
     * mistaken for the newest.
     */
    private static Result pick(String installed, String channel, JSONArray releases) throws Exception {
        boolean allowPrerelease = DeviceSettings.CHANNEL_PREVIEW.equals(channel);
        int installedRank = versionRank(installed);

        String bestTag = null;
        int bestRank = installedRank;
        String bestNotes = null;
        String bestApk = null;

        for (int i = 0; i < releases.length(); i += 1) {
            JSONObject release = releases.getJSONObject(i);
            if (release.optBoolean("draft", false)) continue;
            boolean prerelease = release.optBoolean("prerelease", false);
            if (prerelease && !allowPrerelease) continue;

            String tag = release.optString("tag_name", "");
            int rank = versionRank(tag);
            if (rank <= 0 || rank <= bestRank) continue;

            String apk = apkUrl(release, installed);
            if (apk == null) continue; // A release with no installable asset is not an update.

            bestTag = tag;
            bestRank = rank;
            bestNotes = release.optString("body", "");
            bestApk = apk;
        }

        if (bestTag == null) return Result.none(installed);
        return new Result(true, bestTag, bestNotes, bestApk, null);
    }

    /**
     * A comparable rank for a tag like `v1.0.0-m11`: `major * 1_000_000 + m`.
     *
     * Comparing the milestone alone would call `v2.0.0-m3` older than
     * `v1.0.0-m11`, which would hide a whole new major line. Folding the major
     * in keeps the comparison monotonic across versions while still ordering
     * milestones within one.
     *
     * A tag without a milestone (`v1.0.0`) ranks as `major * 1_000_000`, i.e.
     * below `v1.0.0-m1`. That is intentional: while this port is in milestone
     * builds, a bare tag is not a newer thing to install. When a real 1.0.0
     * ships this should become the top of its major line.
     */
    private static int versionRank(String tag) {
        if (tag == null || tag.isEmpty()) return 0;
        String body = tag.startsWith("v") ? tag.substring(1) : tag;

        int major = 0;
        int firstDot = body.indexOf('.');
        String majorPart = firstDot < 0 ? body : body.substring(0, firstDot);
        try {
            major = Integer.parseInt(majorPart);
        } catch (NumberFormatException notNumeric) {
            return 0;
        }
        if (major < 0) return 0;

        int milestone = 0;
        int marker = body.lastIndexOf("-m");
        if (marker >= 0) {
            StringBuilder digits = new StringBuilder();
            for (int i = marker + 2; i < body.length(); i += 1) {
                char c = body.charAt(i);
                if (c < '0' || c > '9') break;
                digits.append(c);
            }
            if (digits.length() > 0) {
                try {
                    milestone = Integer.parseInt(digits.toString());
                } catch (NumberFormatException tooBig) {
                    milestone = 0;
                }
            }
        }
        return major * 1_000_000 + Math.min(milestone, 999_999);
    }

    /** The first `.apk` asset, preferring one built for this device's ABI. */
    private static String apkUrl(JSONObject release, String installed) {
        JSONArray assets = release.optJSONArray("assets");
        if (assets == null) return null;
        String fallback = null;
        String abi = Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "";
        for (int i = 0; i < assets.length(); i += 1) {
            JSONObject asset = assets.optJSONObject(i);
            if (asset == null) continue;
            String name = asset.optString("name", "");
            if (!name.endsWith(".apk")) continue;
            String url = asset.optString("browser_download_url", "");
            if (url.isEmpty()) continue;
            if (!abi.isEmpty() && name.contains(abi)) return url;
            if (fallback == null) fallback = url;
        }
        return fallback;
    }

    private static String readAll(InputStream input) throws Exception {
        try (InputStream stream = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = stream.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
