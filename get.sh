#!/bin/bash
# Brain: download and install (or update) in one line, from Terminal:
#   curl -fsSL https://raw.githubusercontent.com/steph060612/brain-app/main/get.sh | bash
# Downloads a fixed, tested release (not the latest code), checks it, then runs its installer.
set -euo pipefail

VERSION="v0.1.0"
SHA256="7ee7f42fc3c05e0f6f6179e6144dd75d372582e45b285006458337ab512daca0"
URL="https://github.com/steph060612/brain-app/releases/download/$VERSION/brain-app-$VERSION.tar.gz"

[ "$(uname)" = "Darwin" ] || { echo "Stopped: the Brain runs on macOS only." >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading the Brain app $VERSION..."
curl -fsSL "$URL" -o "$TMP/app.tar.gz" || { echo "Stopped: download failed. Check the internet connection and try again." >&2; exit 1; }
[ "$(shasum -a 256 "$TMP/app.tar.gz" | cut -d' ' -f1)" = "$SHA256" ] \
  || { echo "Stopped: the download does not match the published release. Nothing was installed." >&2; exit 1; }
tar -xzf "$TMP/app.tar.gz" -C "$TMP"

# Questions go to the keyboard, not to the downloaded script.
/bin/bash "$TMP/brain-app/install.sh" "$@" < /dev/tty
