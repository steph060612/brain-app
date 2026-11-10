#!/bin/bash
# Brain installer for a new Mac user. Run in Terminal:  bash ~/Downloads/brain-app/install.sh
# Creates an empty brain at ~/Brain, settings in ~/.brain, and two background jobs that start at login:
# the Brain app (http://localhost:5180, or the next free address) and a local auto-commit every 15 minutes. Never overwrites ~/Brain.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRAIN_DIR="$HOME/Brain"
STATE_DIR="$HOME/.brain"
AGENTS_DIR="$HOME/Library/LaunchAgents"
TODAY="$(date +%Y-%m-%d)"

fail() { echo "Stopped: $1" >&2; exit 1; }
step() { echo; echo "==> $1"; }

# Download with a progress bar; on a dropped connection, resume where it stopped (up to 5 times).
fetch() {
  local url="$1" out="$2" n=0
  while [ "$n" -lt 5 ]; do
    curl -fL --progress-bar --connect-timeout 20 --retry 3 --retry-delay 3 -C - "$url" -o "$out" && return 0
    n=$((n + 1)); echo "Connection dropped, resuming ($n of 5)..." >&2; sleep 3
  done
  return 1
}

[ "$(uname)" = "Darwin" ] || fail "this installer is for macOS only."
[ -f "$AGENTS_DIR/com.steph.brain-app.plist" ] && fail "this Mac runs the developer version of the Brain app; do not install over it."

# Install on a fresh Mac; update when a previous install exists. An update never touches ~/Brain.
if [ -e "$BRAIN_DIR" ]; then
  [ -f "$STATE_DIR/config" ] && [ -f "$AGENTS_DIR/com.brain.app.plist" ] \
    || fail "$BRAIN_DIR already exists and was not made by this installer. Nothing was changed."
  MODE=update
  . "$STATE_DIR/config"
  NAME="${BRAIN_NAME:-}"
  PORT="${BRAIN_PORT:-5180}"
  echo "Updating the Brain app for $NAME. Your brain at $BRAIN_DIR is not touched."
else
  MODE=install
  NAME="${1:-}"
  if [ -z "$NAME" ]; then
    if [ -t 0 ]; then read -r -p "Your first name (used in your packs and rules): " NAME
    else read -r -p "Your first name (used in your packs and rules): " NAME < /dev/tty; fi
  fi
  [ -n "$NAME" ] || fail "a first name is required."
  case "$NAME" in *[\"\'\$\`\\]*) fail "the name cannot contain quotes, \$, backticks or backslashes." ;; esac
  # First free address from 5180, so a second user account on the same Mac gets its own.
  PORT=5180
  while [ "$PORT" -lt 5190 ] && /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT + 1)); done
fi

step "Checking tools"
NODE_DIR="$STATE_DIR/node"
NODE="$(command -v node || true)"
if [ -n "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
  echo "Using Node $("$NODE" -v) already on this Mac."
elif [ -x "$NODE_DIR/bin/node" ]; then
  NODE="$NODE_DIR/bin/node"; echo "Using Node from a previous install."
else
  # Private copy of Node inside ~/.brain: no Homebrew, no password, nothing installed system-wide.
  case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) fail "unsupported processor $(uname -m)." ;; esac
  echo "Downloading Node (about 50 MB)..."
  BASE="https://nodejs.org/dist/latest-v22.x"
  LINE="$(curl -fsSL --retry 5 --retry-delay 3 --connect-timeout 20 "$BASE/SHASUMS256.txt" | grep -E " node-v[0-9.]+-darwin-$ARCH\.tar\.gz$" | head -1)" || fail "could not reach nodejs.org."
  SUM="${LINE%% *}"; FILE="${LINE##* }"
  TMP="$(mktemp -d)"
  fetch "$BASE/$FILE" "$TMP/$FILE" || fail "the Node download failed 5 times. Check the internet connection and run the same line again."
  [ "$(shasum -a 256 "$TMP/$FILE" | cut -d' ' -f1)" = "$SUM" ] || fail "Node download is corrupted (checksum mismatch)."
  mkdir -p "$NODE_DIR"
  tar -xzf "$TMP/$FILE" -C "$NODE_DIR" --strip-components 1
  rm -rf "$TMP"
  NODE="$NODE_DIR/bin/node"
  echo "Node $("$NODE" -v) ready."
fi
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM="$(command -v npm || true)"
[ -n "$NPM" ] || fail "npm is missing."
export PATH="$(dirname "$NODE"):$PATH"

HAS_GIT=yes
if ! xcode-select -p >/dev/null 2>&1; then
  HAS_GIT=no
  echo "Apple's developer tools are not installed. A window will ask to install them: click Install."
  echo "Everything works without them; local backups start by themselves once they are installed."
  xcode-select --install >/dev/null 2>&1 || true
fi


# The app runs from ~/.brain/app, not from Downloads: background jobs may not read Downloads on macOS.
APP_DIR="$STATE_DIR/app"
mkdir -p "$STATE_DIR"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  rsync -a --delete --exclude node_modules --exclude .git --exclude .claude "$SRC_DIR/" "$APP_DIR/"
fi

if [ "$MODE" = install ]; then
step "Creating your brain at $BRAIN_DIR"
cp -R "$APP_DIR/templates/brain" "$BRAIN_DIR"
mv "$BRAIN_DIR/gitignore" "$BRAIN_DIR/.gitignore"
for f in "$BRAIN_DIR"/*.md; do
  /usr/bin/sed -i '' -e "s/{{NAME}}/$NAME/g" -e "s/{{TODAY}}/$TODAY/g" "$f"
done
if [ "$HAS_GIT" = yes ]; then
  ( cd "$BRAIN_DIR" && git init -q -b main && git add -A && git -c user.name="$NAME" -c user.email="brain@localhost" commit -q -m "Start brain" )
  echo "Empty brain created and saved as a first local commit."
else
  echo "Empty brain created. Local history starts once the developer tools are installed."
fi
fi

step "Settings and scripts in $STATE_DIR"
mkdir -p "$STATE_DIR/packs" "$STATE_DIR/imports"
[ "$MODE" = install ] && printf 'BRAIN_NAME="%s"\nBRAIN_DIR="%s"\nBRAIN_PORT="%s"\n' "$NAME" "$BRAIN_DIR" "$PORT" > "$STATE_DIR/config"
cp "$APP_DIR/scripts/brainpack.sh" "$APP_DIR/scripts/autocommit.sh" "$STATE_DIR/"
chmod +x "$STATE_DIR/brainpack.sh" "$STATE_DIR/autocommit.sh"
for bin in /opt/homebrew/bin /usr/local/bin; do
  if [ -d "$bin" ] && [ -w "$bin" ]; then ln -sf "$STATE_DIR/brainpack.sh" "$bin/brainpack"; echo "brainpack command linked in $bin."; break; fi
done

step "Building the Brain app"
if [ -f "$APP_DIR/dist/index.html" ]; then
  # Shared folder already contains the built app: only the server's packages are needed.
  ( cd "$APP_DIR" && "$NPM" ci --omit=dev --no-audit --no-fund )
else
  ( cd "$APP_DIR" && "$NPM" ci --no-audit --no-fund && "$NPM" run build )
fi

step "Background jobs"
mkdir -p "$AGENTS_DIR"
cat > "$AGENTS_DIR/com.brain.app.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.brain.app</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$APP_DIR/server.js</string></array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key><dict><key>BRAIN_PORT</key><string>$PORT</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$STATE_DIR/brain-app.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/brain-app.log</string>
</dict></plist>
PLIST
cat > "$AGENTS_DIR/com.brain.autocommit.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.brain.autocommit</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$STATE_DIR/autocommit.sh</string></array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$STATE_DIR/autocommit.launchd.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/autocommit.launchd.log</string>
</dict></plist>
PLIST
for label in com.brain.app com.brain.autocommit; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS_DIR/$label.plist"
done

step "Checking the app"
URL="http://localhost:$PORT"
UP=no
for i in $(seq 1 15); do
  if curl -fsS "$URL" >/dev/null 2>&1; then UP=yes; break; fi
  sleep 1
done
echo
if [ "$UP" = no ]; then
  fail "the Brain app did not start. Send this file to whoever gave you the Brain: $STATE_DIR/brain-app.log"
fi
if [ "$MODE" = update ]; then
  echo "Updated. The Brain app is running at $URL"
  exit 0
fi
open -a Safari "$URL" 2>/dev/null || true
echo "Done. The Brain app is open in Safari at $URL. Keep it in the Dock: File > Add to Dock."
echo "First step: click 'Copy setup interview' and paste it into a new chat with your assistant."
echo "Backups: your brain is saved on this Mac every 15 minutes. It is sent nowhere."
