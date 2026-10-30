# The Android shell

A thin native container around two things that are not Android code:

- the OpenMAIC server (`mobile/runtime/start.mjs`, run by nodejs-mobile)
- the page that server serves (loaded by a WebView)

There is no application logic here. If you are looking for how a course is
generated, or how the classroom renders, that is all upstream code in `lib/`,
`app/` and `packages/`.

## How it starts

```
MainActivity.onCreate
  └─ background thread
       ├─ NodePayload.ensureUnpacked   inflate assets/payload.zip → filesDir/payload
       ├─ NodePayload.start            set env, then NodeRuntime.startNode (JNI)
       │    └─ C thread: node::Start("mobile/start.mjs")
       │         └─ open PGlite, boot Next.js, listen on 127.0.0.1:7010
       └─ poll 127.0.0.1:7010 until it accepts, then webView.loadUrl
```

The handshake is a TCP poll rather than a callback because `node::Start` never
returns — it is the event loop. A port that accepts connections is the only
signal the Java side can observe without building a JNI callback path, and it
is also the honest one: the server is ready exactly when it is listening.

`node::Start` also prints `OPENMAIC_READY <url>` to stdout, which is redirected
into logcat. That line is what to grep for when debugging a device without a
remote debugger:

```bash
adb logcat -s OpenMAICNode OpenMAIC
```

## Building locally

CI does this; the commands are here for working on the shell itself.

```bash
# 1. the web app
pnpm install
pnpm build                          # writes .next/standalone

# 2. the payload the app ships
node mobile/scripts/assemble-payload.mjs \
  --out mobile/android/app/src/main/assets/payload.zip

# 3. the Node runtime (one download, ~78 MB)
node mobile/scripts/fetch-libnode.mjs

# 4. the APK
cd mobile/android
./gradlew assembleRelease           # needs ANDROID_HOME, NDK 27.2.12479018, CMake 3.22.1
```

`./gradlew assembleDebug` works the same way and signs with the debug key, which
is enough to install on your own device.

### Signing

`app/build.gradle` reads four environment variables and only applies a signing
config when they are present:

| Variable | Meaning |
|---|---|
| `OPENMAIC_KEYSTORE_PATH` | path to the `.jks` |
| `OPENMAIC_KEYSTORE_PASSWORD` | store password |
| `OPENMAIC_KEY_ALIAS` | key alias |
| `OPENMAIC_KEY_PASSWORD` | key password |

CI maps them from repository secrets. Without them a release build produces an
unsigned APK, which Android refuses to install — which is why the workflow fails
before Gradle runs when the secret is absent.

## What is unusual here

**The payload is a zip, not loose assets.** Tens of thousands of files as
individual APK assets makes AAPT spend a very long time compressing and
inflating each one, and makes first launch copy them one stream at a time. One
archive, inflated once, is much faster at both ends.

**`libnode.so` is loaded explicitly, before the JNI library.** `NodeRuntime`'s
static initializer does `System.loadLibrary("node")` first, because
`openmaic-node.so` has an undefined `node::Start` that the dynamic linker can
only resolve if libnode is already mapped.

**16 KB page alignment.** `CMakeLists.txt` links with
`-Wl,-z,max-page-size=16384` and the manifest keeps `extractNativeLibs` off
(`useLegacyPackaging = false`). Both are required for the app to install on
Android 15+ devices with 16 KB pages, which is most new arm64 hardware.

**One ABI by default.** `arm64-v8a`. Each `libnode.so` is about 85 MB; packaging
three makes a 250 MB APK that is slow to install and pointless on a phone that
can only run one of them. `-PabiFilters=all` builds the fat APK for emulator
work.

## Limits

- **No `child_process`.** nodejs-mobile does not provide process spawning. The
  Next.js `start-server` helper uses it (for `lsof`/`netstat`), which is why the
  server is booted through Next's programmatic API instead. Local ffmpeg media
  extraction and voice cloning are unavailable for the same reason.
- **`worker_threads` is present but untested on device.** The PPTX import and
  document-image parsing workers load their script from a filesystem path; that
  path resolution has not been exercised on a phone. A failure surfaces as an
  import error, not a crash.
- **`LISTEN/NOTIFY` does not work.** PGlite's `pg_notify` is accepted and goes
  nowhere, so the event bus falls back to polling. Streaming updates are slower,
  not broken.
- **WASM must work.** PGlite is PostgreSQL compiled to WebAssembly. The Node 24
  runtime from `digidem/nodejs-mobile` carries a V8 with the WASM engine
  enabled; a runtime built without it would fail at database open rather than
  later, which is why the CI check boots the payload and writes a course before
  the APK is assembled.
