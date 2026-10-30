package ai.openmaic.mobile;

import android.util.Log;

/**
 * Starts the embedded Node.js runtime on a background thread.
 *
 * {@link #start} blocks only until the thread is created; {@code node::Start}
 * never returns, because it runs the server's event loop. The Java side
 * therefore never joins it — the process lives as long as Android keeps the
 * app alive, and the runtime dies with the process.
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
     * @param args       argv for the runtime; argv[0] ("node") is prepended in C.
     * @param workingDir the unpacked Node project directory.
     * @return 0 when the thread started, -1 when it did not.
     */
    static native int startNode(String[] args, String workingDir);
}
