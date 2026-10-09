#!/bin/sh
# Build the worker once per Harogic SDK build and lay each out, with its
# libraries, under native/darwin-arm64/<sdk>/.
#
#   driver/worker/build.sh <dir holding unpacked Harogic-Mac-SDK-*-sdk<ver> folders>
#
# The SDK folders are the release zips from https://github.com/mbsound/Harogic-Mac-SDK
# (or `make dist` there). Each SDK build only opens analyzers whose firmware
# matches it, so the plugin ships every build and the driver tries them in turn.
set -eu
SRC_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SRC_DIR/../.." && pwd)
SDKS=${1:?usage: build.sh <dir with Harogic-Mac-SDK-*-sdk<ver> folders>}

found=0
for sdk in "$SDKS"/Harogic-Mac-SDK-*-sdk*; do
  [ -d "$sdk/lib" ] || continue
  ver=${sdk##*-sdk}
  out="$ROOT/native/darwin-arm64/sdk$ver"
  rm -rf "$out"
  mkdir -p "$out/lib"
  cp "$sdk"/lib/*.dylib "$sdk"/lib/htrausb.conf "$out/lib/"
  cp "$sdk/LICENSE" "$out/LICENSE-Harogic-Mac-SDK"
  clang -arch arm64 -O2 -Wall -Wextra -Wno-unused-parameter -Wno-comment -mmacosx-version-min=14.4 \
    -DSDK_LABEL="\"$ver\"" -I"$sdk/include" "$SRC_DIR/harogic_worker.c" \
    -L"$out/lib" -lhtraapi -Wl,-rpath,@executable_path/lib -o "$out/harogic-worker"
  codesign -f -s - "$out/harogic-worker" 2>/dev/null
  echo "built $out/harogic-worker"
  found=1
done
[ "$found" = 1 ] || { echo "no Harogic-Mac-SDK-*-sdk<ver> folders in $SDKS" >&2; exit 1; }
