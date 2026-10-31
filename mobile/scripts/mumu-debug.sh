#!/usr/bin/env bash
# Install an OpenMAIC-M APK on the MuMu emulator and capture its startup log.
#
# Why MuMu at all: CI proves the payload boots and the APK is signed, but it
# cannot see what a device actually does. Two defects so far were invisible
# until a device ran the app — a malformed package scope on the ESM loader
# thread, and the server being frozen when backgrounded. This script is the
# loop that finds them.
#
# MuMu is x86_64, so it needs an APK with the x86_64 ABI. Build one with
#   gh workflow run APK -f abi=all
# and pass that artifact here. An arm64-only APK installs but its Node runtime
# is translated by Houdini, which is not the path a real phone takes.
#
# Usage:
#   bash mobile/scripts/mumu-debug.sh <path-to.apk>
#   bash mobile/scripts/mumu-debug.sh <path-to.apk> --keep-data

set -euo pipefail

APK="${1:-}"
KEEP_DATA=0
for arg in "$@"; do
  [ "$arg" = "--keep-data" ] && KEEP_DATA=1
done

if [ -z "$APK" ] || [ ! -f "$APK" ]; then
  echo "usage: $0 <path-to.apk> [--keep-data]" >&2
  exit 2
fi
APK="$(cd "$(dirname "$APK")" && pwd)/$(basename "$APK")"

PKG=ai.openmaic.mobile
ACTIVITY="$PKG/.MainActivity"

# MuMu ships its own adb; prefer it so the version matches the emulator.
ADB=""
for candidate in \
  "/d/Program Files/Netease/MuMu/nx_main/adb.exe" \
  "/c/Program Files/Netease/MuMu/nx_main/adb.exe" \
  "$(command -v adb 2>/dev/null || true)"
do
  [ -x "$candidate" ] && { ADB="$candidate"; break; }
done
[ -n "$ADB" ] || { echo "no adb found (looked in MuMu's install and PATH)" >&2; exit 1; }

# MuMu listens on several ports depending on version; whichever accepts wins.
DEVICE=""
for port in 16384 7555 5555 16416; do
  if "$ADB" connect "127.0.0.1:$port" >/dev/null 2>&1; then
    if "$ADB" -s "127.0.0.1:$port" shell true >/dev/null 2>&1; then
      DEVICE="127.0.0.1:$port"; break
    fi
  fi
done
if [ -z "$DEVICE" ]; then
  echo "no MuMu emulator found. Start it from the MuMu window first." >&2
  exit 1
fi
echo "[mumu] device $DEVICE"

ABI="$("$ADB" -s "$DEVICE" shell getprop ro.product.cpu.abilist 2>/dev/null | tr -d '\r')"
echo "[mumu] abilist: $ABI"
case "$ABI" in
  *arm64-v8a*) echo "[mumu] hint: an x86_64 APK avoids the ARM translation layer" ;;
esac

if [ "$KEEP_DATA" = "0" ]; then
  echo "[mumu] uninstalling old copy (payload will be re-unpacked)"
  "$ADB" -s "$DEVICE" shell pm uninstall "$PKG" >/dev/null 2>&1 || true
fi

echo "[mumu] installing $(basename "$APK")"
"$ADB" -s "$DEVICE" install -r "$APK" | tail -1

"$ADB" -s "$DEVICE" logcat -c
echo "[mumu] launching"
"$ADB" -s "$DEVICE" shell am start -n "$ACTIVITY" >/dev/null

# The first launch unpacks ~20k files and opens the database; both take tens of
# seconds on an emulator with 4 GB of RAM.
echo "[mumu] waiting for startup (up to 4 min)"
deadline=$(( $(date +%s) + 240 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if "$ADB" -s "$DEVICE" logcat -d -s OpenMAICNode 2>/dev/null | grep -q "listening on"; then
    break
  fi
  if "$ADB" -s "$DEVICE" logcat -d -s OpenMAICNode 2>/dev/null | grep -q "OPENMAIC_FAILED"; then
    break
  fi
  sleep 5
done

echo
echo "================ startup log ================"
"$ADB" -s "$DEVICE" logcat -d -s OpenMAICNode OpenMAIC 2>/dev/null | tail -40
echo "============================================="
echo

if "$ADB" -s "$DEVICE" logcat -d -s OpenMAICNode 2>/dev/null | grep -q "OPENMAIC_FAILED"; then
  echo "[mumu] RESULT: server FAILED to start" >&2
  exit 1
fi

PORT="7010"
if "$ADB" -s "$DEVICE" logcat -d -s OpenMAICNode 2>/dev/null | grep -q "listening on"; then
  echo "[mumu] RESULT: server is up"
  echo "[mumu] forwarding 127.0.0.1:$PORT so you can open it from this machine"
  "$ADB" -s "$DEVICE" forward "tcp:$PORT" "tcp:$PORT" >/dev/null
  echo "[mumu] -> http://127.0.0.1:$PORT  (Ctrl-C does not close the forward)"
  echo "[mumu] to verify persistence without the UI:"
  echo "         curl -s http://127.0.0.1:$PORT/api/health"
else
  echo "[mumu] RESULT: still starting; watch it with:" >&2
  echo "         \"$ADB\" -s $DEVICE logcat -s OpenMAICNode OpenMAIC" >&2
  exit 1
fi
