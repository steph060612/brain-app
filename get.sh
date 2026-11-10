#!/bin/bash
# Brain: download and install (or update) in one line, from Terminal:
#   curl -fsSL https://raw.githubusercontent.com/steph060612/brain-app/main/get.sh | bash
# Downloads a fixed, tested release (not the latest code), checks it, then runs its installer.
set -euo pipefail

VERSION="v0.1.1"
SHA256="30c79311a0cb45680f450c4105b7c78dfc30155c9aa3bd949594c642a93c22ec"
URL="https://github.com/steph060612/brain-app/releases/download/$VERSION/brain-app-$VERSION.tar.gz"

[ "$(uname)" = "Darwin" ] || { echo "Stopped: the Brain runs on macOS only." >&2; exit 1; }
# Download with a progress bar; on a dropped connection, resume where it stopped (up to 5 times).
fetch() {
  local url="$1" out="$2" n=0
  while [ "$n" -lt 5 ]; do
    curl -fL --progress-bar --connect-timeout 20 --retry 3 --retry-delay 3 -C - "$url" -o "$out" && return 0
    n=$((n + 1)); echo "Connection dropped, resuming ($n of 5)..." >&2; sleep 3
  done
  return 1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading the Brain app $VERSION (about 5 MB)..."
fetch "$URL" "$TMP/app.tar.gz" || { echo "Stopped: download failed 5 times. Check the internet connection and run the same line again." >&2; exit 1; }
[ "$(shasum -a 256 "$TMP/app.tar.gz" | cut -d' ' -f1)" = "$SHA256" ] \
  || { echo "Stopped: the download does not match the published release. Nothing was installed." >&2; exit 1; }
tar -xzf "$TMP/app.tar.gz" -C "$TMP"

# Questions go to the keyboard, not to the downloaded script.
/bin/bash "$TMP/brain-app/install.sh" "$@" < /dev/tty
