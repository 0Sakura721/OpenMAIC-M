package ai.openmaic.mobile;

import android.util.Log;

/**
 * Starts the embedded Node.js runtime on a background thread, and receives the
 * progress it reports.
 *
 * {@link #startNode} returns as soon as the thread is created; {@code node::Start}
 * never returns, because it runs the server's event loop. The Java side
 * therefore never joins it — the process lives as long as Android keeps the app
 * alive, and the runtime dies with the process.
 *
 * Progress arrives through {@link #setStatusListener}: the Node side prints
 * lines prefixed with {@code OPENMAIC_STATUS}, the JNI log pipe recognises them
 * and calls back into the listener's {@code onNodeStatus(String)}. That is how
 * the splash screen shows what the server is doing during a first launch that
 * takes tens of seconds.
 */
final class NodeRuntime {

    private static final String TAG = "OpenMAICNode";

    static {
        // libnode.so must be loaded before the JNI library that links against
        // it, so that the dynamic linker finds node::Start already resolved.
        System.loadLibrary("node");
        System.loadLibrary("openmaic-node");
    }

    private NodeRuntime() {}

    /**
     * Register (or clear, with {@code null}) the receiver for status lines.
     *
     * The object must be an instance of {@code MainActivity}, because the native
     * side resolves {@code MainActivity.onNodeStatus(String)} once at load time
     * and calls it on whatever thread the runtime is on.
     */
    static native void setStatusListener(Object listener);

    /**
     * @param args       argv for the runtime; argv[0] ("node") is prepended in C.
     * @param workingDir the unpacked Node project directory.
     * @return 0 when the thread started, -1 when it did not.
     */
    static native int startNode(String[] args, String workingDir);
}
