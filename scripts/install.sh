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

# Uninstall the assistant tools only:  bash install.sh --remove-assistant-tools
if [ "${1:-}" = "--remove-assistant-tools" ]; then
  if command -v claude >/dev/null 2>&1; then claude mcp remove --scope user brainmap && echo "brainmap tools removed from Claude Code."
  else echo "Claude Code is not installed; nothing to remove."; fi
  exit 0
fi

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
# The code mapper's parser (@babel/parser 8) needs Node ^22.18.0 || >=24.11.0. A Node on the Mac that does not meet
# that is left alone and a private copy in ~/.brain/node is used instead, on first install and on update.
NODE_NEED="22.18 or newer in the 22 line, or 24.11 or newer"
node_fits() {
  local v; v="$("$1" -p 'process.versions.node' 2>/dev/null)" || return 1
  local major="${v%%.*}" rest="${v#*.}"; local minor="${rest%%.*}"
  [ "$major" -eq 22 ] && [ "$minor" -ge 18 ] && return 0
  [ "$major" -eq 24 ] && [ "$minor" -ge 11 ] && return 0
  [ "$major" -ge 25 ] && return 0
  return 1
}
NODE_DIR="$STATE_DIR/node"
NODE=""
SYS_NODE="$(command -v node || true)"
if [ -n "$SYS_NODE" ] && node_fits "$SYS_NODE"; then
  NODE="$SYS_NODE"
  echo "Using Node $("$NODE" -v) already on this Mac ($NODE): it meets the minimum ($NODE_NEED)."
elif [ -n "$SYS_NODE" ]; then
  echo "Node $("$SYS_NODE" -v 2>/dev/null || echo '(unreadable)') on this Mac ($SYS_NODE) is too old for the code map, which needs $NODE_NEED."
  echo "It is not changed; the Brain uses its own copy in $NODE_DIR instead."
fi
if [ -z "$NODE" ] && [ -x "$NODE_DIR/bin/node" ]; then
  if node_fits "$NODE_DIR/bin/node"; then
    NODE="$NODE_DIR/bin/node"; echo "Using the Brain's own Node $("$NODE" -v) from a previous install ($NODE)."
  else
    echo "The Brain's own Node $("$NODE_DIR/bin/node" -v) from a previous install is too old ($NODE_NEED is needed); replacing it."
    rm -rf "$NODE_DIR"
  fi
fi
if [ -z "$NODE" ]; then
  # Private copy of Node inside ~/.brain: no Homebrew, no password, nothing installed system-wide.
  case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) fail "unsupported processor $(uname -m)." ;; esac
  [ -n "$SYS_NODE" ] || echo "No Node on this Mac."
  echo "Downloading the Brain's own copy of Node (about 50 MB)..."
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
  node_fits "$NODE" || fail "the downloaded Node $("$NODE" -v) does not meet the minimum ($NODE_NEED)."
  echo "Using the Brain's own Node $("$NODE" -v) ($NODE)."
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
/usr/bin/sed -e "s|__NODE__|$NODE|" -e "s|__APP_DIR__|$APP_DIR|" "$APP_DIR/scripts/brainmap.sh" > "$STATE_DIR/brainmap.sh"
chmod +x "$STATE_DIR/brainmap.sh"
# The brainmap and brainpack commands go in ~/.local/bin, which is always writable (no Homebrew, no password).
# If a new login shell would not find them there, ~/.local/bin is added to the PATH in the shell's profile.
BIN_DIR="$HOME/.local/bin"
if mkdir -p "$BIN_DIR" 2>/dev/null && ln -sf "$STATE_DIR/brainpack.sh" "$BIN_DIR/brainpack" && ln -sf "$STATE_DIR/brainmap.sh" "$BIN_DIR/brainmap"; then
  echo "brainmap and brainpack commands installed in $BIN_DIR."
else
  echo "Could not install the brainmap and brainpack commands in $BIN_DIR. They still work by full path: $STATE_DIR/brainmap.sh"
fi
# BRAIN_LOGIN_SHELL overrides the shell checked (the installer test uses it to isolate a test home).
LOGIN_SHELL="${BRAIN_LOGIN_SHELL:-$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | awk '{print $2}')}"
[ -n "$LOGIN_SHELL" ] || LOGIN_SHELL="${SHELL:-/bin/zsh}"
# Not finding it is an answer, not an error (the installer runs with set -e and pipefail).
found_in_shell() { { "$LOGIN_SHELL" -lc 'command -v brainmap' 2>/dev/null </dev/null || true; } | tail -1; }
FOUND="$(found_in_shell)"
if [ -n "$FOUND" ]; then
  echo "A new Terminal window finds brainmap at $FOUND."
else
  case "$(basename "$LOGIN_SHELL")" in
    zsh) PROFILE="$HOME/.zprofile" ;;
    bash) PROFILE="$HOME/.bash_profile" ;;
    *) PROFILE="" ;;
  esac
  if [ -z "$PROFILE" ]; then
    echo "Your shell is $LOGIN_SHELL, which this installer does not set up. To run brainmap by name, add $BIN_DIR to your PATH yourself."
  elif { printf '\n# Added by the Brain installer: commands in ~/.local/bin (brainmap, brainpack)\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$PROFILE"; } 2>/dev/null; then
    echo "Added $BIN_DIR to your PATH in $PROFILE (two lines at the end, marked \"Added by the Brain installer\")."
    FOUND="$(found_in_shell)"
    if [ -n "$FOUND" ]; then echo "New Terminal windows now find brainmap at $FOUND (this window does not; open a new one)."
    else echo "A new Terminal window still does not find brainmap. Run it by full path: $STATE_DIR/brainmap.sh"; fi
  else
    echo "Could not write to $PROFILE. To run brainmap by name, add this line to it yourself: export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
fi
# Code map tools for Claude Code (user scope: every project, no project files touched). Re-added on update so
# the path stays current. Remove with: bash install.sh --remove-assistant-tools
if command -v claude >/dev/null 2>&1; then
  claude mcp remove --scope user brainmap >/dev/null 2>&1 || true
  claude mcp add --scope user brainmap -- "$NODE" "$APP_DIR/src/brainmap-mcp.js" >/dev/null && echo "brainmap tools added to Claude Code (user scope)."
else
  echo "Claude Code not found: the brainmap tools for assistants were not registered (the brainmap command still works)."
fi

step "Building the Brain app"
if "$NODE" "$APP_DIR/scripts/check-build.mjs" --quiet 2>/dev/null; then
  # The package contains a build that matches its own map schema: only the server's packages are needed.
  ( cd "$APP_DIR" && "$NPM" ci --omit=dev --no-audit --no-fund )
else
  # No build, or one that reads a different map schema than this package's mapper: build it here.
  ( cd "$APP_DIR" && "$NPM" ci --no-audit --no-fund && "$NPM" run build )
fi
"$NODE" "$APP_DIR/scripts/check-build.mjs" || fail "the app build does not match its map schema. Send $STATE_DIR/brain-app.log to whoever gave you the Brain."

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
BRAIN_PORT="$PORT" "$NODE" "$APP_DIR/scripts/check-build.mjs" --live --quiet \
  || fail "the running Brain app is not the build just installed. Send this file to whoever gave you the Brain: $STATE_DIR/brain-app.log"
if [ "$MODE" = update ]; then
  echo "Updated. The Brain app is running at $URL"
  exit 0
fi
open -a Safari "$URL" 2>/dev/null || true
echo "Done. The Brain app is open in Safari at $URL. Keep it in the Dock: File > Add to Dock."
echo "First step: click 'Copy setup interview' and paste it into a new chat with your assistant."
echo "Backups: your brain is saved on this Mac every 15 minutes. It is sent nowhere."
