// JNI entry point for the embedded Node.js runtime.
//
// nodejs-mobile ships `libnode.so`, which exports the same `node::Start` the
// `node` binary calls. Starting the runtime is therefore one call on a
// background thread; everything else — opening the database, booting the
// Next.js server — is JavaScript, in `mobile/runtime/start.mjs`.
//
// Stdout and stderr are redirected into logcat. On Android the app process has
// no controlling terminal, so without this every `console.log` in the server
// (and every startup failure) is silently discarded, which makes a phone-side
// problem impossible to diagnose.
#include <jni.h>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "node.h"

#define LOG_TAG "OpenMAICNode"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

/**
 * The reader end of the stdout pipe, drained by a dedicated thread.
 *
 * Node writes in whatever chunk size it likes and a line can arrive split
 * across reads, so lines are assembled in `pending` and flushed on newline.
 */
struct LogPipe {
  int readFd = -1;
  std::string pending;
};

void* drainLogPipe(void* arg) {
  LogPipe* pipe = static_cast<LogPipe*>(arg);
  char buffer[4096];
  for (;;) {
    ssize_t count = read(pipe->readFd, buffer, sizeof(buffer));
    if (count <= 0) break;
    pipe->pending.append(buffer, static_cast<size_t>(count));
    size_t newline;
    while ((newline = pipe->pending.find('\n')) != std::string::npos) {
      std::string line = pipe->pending.substr(0, newline);
      pipe->pending.erase(0, newline + 1);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      __android_log_write(ANDROID_LOG_INFO, LOG_TAG, line.c_str());
    }
  }
  if (!pipe->pending.empty()) {
    __android_log_write(ANDROID_LOG_INFO, LOG_TAG, pipe->pending.c_str());
  }
  return nullptr;
}

/** Point fd 1 and 2 at a pipe whose other end feeds logcat. */
void redirectStdioToLogcat() {
  int fds[2];
  if (pipe(fds) != 0) {
    LOGE("could not create the log pipe");
    return;
  }
  LogPipe* logPipe = new LogPipe();
  logPipe->readFd = fds[0];
  pthread_t thread;
  if (pthread_create(&thread, nullptr, drainLogPipe, logPipe) != 0) {
    LOGE("could not start the log reader");
    close(fds[0]);
    close(fds[1]);
    return;
  }
  pthread_detach(thread);
  dup2(fds[1], STDOUT_FILENO);
  dup2(fds[1], STDERR_FILENO);
  close(fds[1]);
  // Line-buffered, so a log line reaches logcat when it is written rather than
  // when 4 KB accumulates.
  setvbuf(stdout, nullptr, _IOLBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
}

struct NodeArgs {
  int argc;
  char** argv;
};

void* startNodeThread(void* arg) {
  NodeArgs* args = static_cast<NodeArgs*>(arg);
  LOGI("starting Node.js runtime (%d args)", args->argc);
  // Never returns: `node::Start` runs the event loop until the process exits.
  int code = node::Start(args->argc, args->argv);
  LOGI("Node.js runtime exited with code %d", code);
  return nullptr;
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_ai_openmaic_mobile_NodeRuntime_startNode(
    JNIEnv* env, jclass /* clazz */, jobjectArray javaArgs, jstring javaWorkingDir) {
  redirectStdioToLogcat();

  const jsize count = env->GetArrayLength(javaArgs);
  // argv is one longer than the Java array: argv[0] is the program name, which
  // Node expects to be "node".
  NodeArgs* args = new NodeArgs();
  args->argc = count + 1;
  args->argv = static_cast<char**>(calloc(static_cast<size_t>(args->argc) + 1, sizeof(char*)));
  args->argv[0] = strdup("node");
  for (jsize index = 0; index < count; index++) {
    auto element = static_cast<jstring>(env->GetObjectArrayElement(javaArgs, index));
    const char* utf = env->GetStringUTFChars(element, nullptr);
    args->argv[index + 1] = strdup(utf);
    env->ReleaseStringUTFChars(element, utf);
    env->DeleteLocalRef(element);
  }

  if (javaWorkingDir != nullptr) {
    const char* dir = env->GetStringUTFChars(javaWorkingDir, nullptr);
    if (chdir(dir) != 0) LOGE("could not chdir to %s", dir);
    env->ReleaseStringUTFChars(javaWorkingDir, dir);
  }

  // Detached on purpose: the runtime owns the process from here, and the Java
  // caller must not block on it.
  pthread_t thread;
  if (pthread_create(&thread, nullptr, startNodeThread, args) != 0) {
    LOGE("could not start the Node.js thread");
    return -1;
  }
  return 0;
}
