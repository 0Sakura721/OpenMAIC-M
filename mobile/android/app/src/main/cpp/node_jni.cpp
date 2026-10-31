// JNI entry point for the embedded Node.js runtime.
//
// nodejs-mobile ships `libnode.so`, which exports the same `node::Start` the
// `node` binary calls. Starting the runtime is therefore one call on a
// background thread; everything else — opening the database, booting the
// Next.js server — is JavaScript, in `mobile/runtime/start.mjs`.
//
// Two things come back out of that thread:
//
//   1. Every stdout/stderr line is forwarded to logcat, so a phone-side failure
//      is diagnosable without a debugger. The app process has no controlling
//      terminal; without this the server's output is discarded.
//
//   2. Lines the app should *show the user* are also handed to Java through a
//      callback. The first launch unpacks ~20k files and then boots a Next.js
//      server, which takes tens of seconds on a phone — long enough that a
//      static "starting…" reads as a hang. The Node side emits `OPENMAIC_STATUS`
//      markers for each phase and the activity renders them.
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

/** The prefix the Node side puts on lines meant for the splash screen. */
constexpr const char* kStatusPrefix = "OPENMAIC_STATUS ";

/**
 * Java side of the status channel.
 *
 * `gJavaVm` is needed because the Node runtime runs on a thread this library
 * created; attaching it to the JVM is the only way to call back into Java from
 * there. The class and method are cached once, since `FindClass` on an
 * arbitrary thread uses the system class loader and would not see app classes.
 */
struct StatusSink {
  JavaVM* vm = nullptr;
  jobject callback = nullptr;   // global ref to the listener
  jmethodID method = nullptr;   // void onStatus(String)
};

StatusSink gStatus;

/** Cached at load time from JNI_OnLoad, which runs on a Java thread. */
JavaVM* gCachedVm = nullptr;
jclass gActivityClass = nullptr;

/**
 * Hand one status line to Java.
 *
 * Attaches the calling thread if needed and detaches it again, so a long-lived
 * Node thread does not leak a JNI attachment. Any failure is swallowed: a UI
 * update must never take down the server.
 */
void publishStatus(const std::string& message) {
  if (gStatus.vm == nullptr || gStatus.callback == nullptr || gStatus.method == nullptr) {
    return;
  }

  JNIEnv* env = nullptr;
  bool detach = false;
  const jint state = gStatus.vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6);
  if (state == JNI_EDETACHED) {
    if (gStatus.vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return;
    detach = true;
  } else if (state != JNI_OK) {
    return;
  }

  jstring text = env->NewStringUTF(message.c_str());
  if (text != nullptr) {
    env->CallVoidMethod(gStatus.callback, gStatus.method, text);
    env->DeleteLocalRef(text);
    // A pending exception from the Java side would abort the next JNI call.
    if (env->ExceptionCheck()) env->ExceptionClear();
  }

  if (detach) gStatus.vm->DetachCurrentThread();
}

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

      // Status markers go to the UI *and* to logcat: the log is what a bug
      // report has, and it should show the same sequence the user saw.
      if (line.rfind(kStatusPrefix, 0) == 0) {
        publishStatus(line.substr(strlen(kStatusPrefix)));
      }
      __android_log_write(ANDROID_LOG_INFO, LOG_TAG, line.c_str());
    }
  }
  if (!pipe->pending.empty()) {
    __android_log_write(ANDROID_LOG_INFO, LOG_TAG, pipe->pending.c_str());
  }
  return nullptr;
}

/** Point fd 1 and 2 at a pipe whose other end feeds logcat and the UI. */
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

/**
 * Cache the JVM and the activity class while a Java thread is on the stack.
 *
 * `FindClass` resolves through the caller's class loader. Called later from the
 * Node thread it would look in the system loader and fail, so the class is
 * resolved here once and kept as a global reference.
 */
extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /* reserved */) {
  gCachedVm = vm;
  JNIEnv* env = nullptr;
  if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) == JNI_OK && env != nullptr) {
    jclass local = env->FindClass("ai/openmaic/mobile/MainActivity");
    if (local != nullptr) {
      gActivityClass = static_cast<jclass>(env->NewGlobalRef(local));
      env->DeleteLocalRef(local);
    }
  }
  return JNI_VERSION_1_6;
}

extern "C" JNIEXPORT void JNICALL
Java_ai_openmaic_mobile_NodeRuntime_setStatusListener(
    JNIEnv* env, jclass /* clazz */, jobject listener) {
  if (gStatus.callback != nullptr) {
    env->DeleteGlobalRef(gStatus.callback);
    gStatus.callback = nullptr;
    gStatus.method = nullptr;
  }
  gStatus.vm = gCachedVm;
  if (listener == nullptr || gActivityClass == nullptr || gStatus.vm == nullptr) return;

  gStatus.callback = env->NewGlobalRef(listener);
  gStatus.method = env->GetMethodID(gActivityClass, "onNodeStatus", "(Ljava/lang/String;)V");
  if (gStatus.method == nullptr) {
    LOGE("MainActivity.onNodeStatus(String) not found");
    env->DeleteGlobalRef(gStatus.callback);
    gStatus.callback = nullptr;
  }
}

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
