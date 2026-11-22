#!/bin/bash
# Brain installer for a new Mac user. Run in Terminal:  bash ~/Downloads/brain-app/install.sh [NAME] [--brain PATH]
# Creates an empty brain at ~/Brain (or at --brain PATH; an existing folder there is used as it is, with its git
# history), settings in ~/.brain, and two background jobs that start at login: the Brain app
# (http://localhost:5180, or the next free address) and a local auto-commit every 15 minutes. Never overwrites a brain.
# Run again later to update: the brain folder saved in ~/.brain/config is found and left untouched.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$HOME/.brain"
CONFIG="$STATE_DIR/config"
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

# Arguments, in any order: an optional first name, --brain PATH (or --brain=PATH); or --remove-assistant-tools alone.
NAME_ARG=""; BRAIN_ARG=""; REMOVE_TOOLS=no
while [ $# -gt 0 ]; do
  case "$1" in
    --remove-assistant-tools) REMOVE_TOOLS=yes ;;
    --brain) [ $# -ge 2 ] && [ -n "$2" ] || fail "--brain needs a folder, for example --brain ~/Notes/brain."
             BRAIN_ARG="$2"; shift ;;
    --brain=*) BRAIN_ARG="${1#--brain=}"; [ -n "$BRAIN_ARG" ] || fail "--brain needs a folder, for example --brain ~/Notes/brain." ;;
    -*) fail "unknown option $1. The options are --brain PATH and --remove-assistant-tools." ;;
    *) [ -z "$NAME_ARG" ] || fail "give one first name only (got \"$NAME_ARG\" and \"$1\")."
       NAME_ARG="$1" ;;
  esac
  shift
done

# Uninstall the assistant tools only:  bash install.sh --remove-assistant-tools
if [ "$REMOVE_TOOLS" = yes ]; then
  if command -v claude >/dev/null 2>&1; then claude mcp remove --scope user brainmap && echo "brainmap tools removed from Claude Code."
  else echo "Claude Code is not installed; nothing to remove."; fi
  exit 0
fi

[ "$(uname)" = "Darwin" ] || fail "this installer is for macOS only."
[ -f "$AGENTS_DIR/com.steph.brain-app.plist" ] && fail "this Mac runs the developer version of the Brain app; do not install over it."

# ─── Where the brain lives ───────────────────────────────────────────────────
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
tilde() { case "$1" in "$HOME") echo "~" ;; "$HOME"/*) echo "~${1#"$HOME"}" ;; *) echo "$1" ;; esac; }
expand() { case "$1" in "~") echo "$HOME" ;; "~/"*) echo "$HOME/${1#"~/"}" ;; *) echo "$1" ;; esac; }
# $1 with symlinks resolved in the deepest part that exists; the part that does not exist yet is appended as written.
physical() {
  local p="${1%/}" rest=""
  [ -n "$p" ] || p=/
  while [ ! -d "$p" ] && [ "$p" != / ]; do rest="/$(basename "$p")$rest"; p="$(dirname "$p")"; done
  printf '%s%s' "$(cd -P "$p" 2>/dev/null && pwd -P || printf '%s' "$p")" "$rest"
}
# The name a path has on disk. The Mac's disk usually ignores case, so ~/Brain finds a folder named ~/brain.
on_disk() {
  local parent base hit
  parent="$(dirname "$1")"; base="$(basename "$1")"
  hit="$(find "$parent" -maxdepth 1 -mindepth 1 -name "$base" -print 2>/dev/null | head -1)"
  [ -n "$hit" ] || hit="$(find "$parent" -maxdepth 1 -mindepth 1 -iname "$base" -print 2>/dev/null | head -1)"
  printf '%s' "${hit:-$1}"
}
# The folder macOS keeps from background jobs that holds $1, if any. LaunchAgents (the app and the automatic saves)
# get "Operation not permitted" in Desktop, Documents, Downloads, iCloud Drive and cloud storage folders.
# Same list as autocommit.sh.
protected_place() {
  local p h d label
  for p in "$1" "$(physical "$1")"; do
    p="$(lower "$p")/"
    for h in "$HOME" "$(physical "$HOME")"; do
      h="$(lower "$h")"
      for d in Desktop Documents Downloads "Library/Mobile Documents" "Library/CloudStorage"; do
        case "$p" in
          "$h/$(lower "$d")"/*)
            case "$d" in
              "Library/Mobile Documents") label="iCloud Drive" ;;
              "Library/CloudStorage") label="a cloud storage folder (~/Library/CloudStorage)" ;;
              *) label="~/$d" ;;
            esac
            echo "$label"; return 0 ;;
        esac
      done
    done
  done
  return 1
}
# Stop unless $1 is a place the background jobs can reach and the settings file can hold.
check_brain_place() {
  local p="$1" place home_p
  case "$p" in /*) ;; *) fail "--brain needs a full path, for example --brain ~/Notes/brain." ;; esac
  case "$p" in *[\"\$\`\\\<\>\&]*) fail "the brain folder's path cannot contain quotes, \$, backticks, backslashes, <, > or &." ;; esac
  case "$p" in *$'\n'*) fail "the brain folder's path cannot contain a line break." ;; esac
  home_p="$(lower "$(physical "$HOME")")"
  case "$(lower "$(physical "$p")")/" in
    "$home_p/.brain/"*) fail "the brain cannot be inside ~/.brain, where the app keeps its own files." ;;
    "$home_p/"?*) ;;
    *) fail "the brain must be a folder inside your home folder ($HOME), not $(tilde "$p")." ;;
  esac
  if place="$(protected_place "$p")"; then
    fail "$(tilde "$p") is in $place. macOS does not let background jobs open files there (\"Operation not permitted\"), so the Brain app and the automatic saves could not reach your brain. Choose a folder in your home folder outside Desktop, Documents, Downloads and iCloud Drive, for example --brain ~/Brain or --brain ~/Notes/brain. If your brain is there now, move it first (for example: mv ~/Documents/brain ~/Brain) and pass the new place. Nothing was changed."
  fi
}
# Stop unless the existing folder $1 can be adopted as a brain as it is.
check_adoptable() {
  local p="$1" shown marker top
  shown="$(tilde "$p")"
  [ -d "$p" ] || fail "$shown exists but is not a folder. Nothing was changed."
  for marker in package.json pyproject.toml setup.py requirements.txt Pipfile Cargo.toml go.mod Gemfile pom.xml build.gradle Makefile; do
    [ -e "$p/$marker" ] && fail "$shown looks like a code project (it has $marker), not a brain. Nothing was changed. Choose the folder that holds your brain's notes, or a new folder."
  done
  [ -n "$(find "$p" -maxdepth 3 -name '*.md' -not -path '*/.git/*' -print 2>/dev/null | head -1)" ] \
    || fail "$shown has no Markdown (.md) notes, so it does not look like a brain. Nothing was changed. Choose the folder that holds your notes, or a new folder."
  if [ ! -e "$p/.git" ] && xcode-select -p >/dev/null 2>&1 && top="$(git -C "$p" rev-parse --show-toplevel 2>/dev/null)"; then
    fail "$shown is inside the git repository $(tilde "$top"). The brain needs its own history: choose a folder that is not inside another repository. Nothing was changed."
  fi
}

# Install on a fresh Mac; update when a previous install exists. The brain folder is the one saved in ~/.brain/config
# (always ~/Brain before --brain existed). An update never touches it.
ADOPT=no
if [ -f "$CONFIG" ] && [ -f "$AGENTS_DIR/com.brain.app.plist" ]; then
  MODE=update
  BRAIN_NAME=""; BRAIN_DIR=""; BRAIN_PORT=""
  . "$CONFIG"
  NAME="${BRAIN_NAME:-}"
  PORT="${BRAIN_PORT:-5180}"
  BRAIN_DIR="${BRAIN_DIR:-$HOME/Brain}"
  if [ -n "$BRAIN_ARG" ] && [ "$(lower "$(physical "$(expand "$BRAIN_ARG")")")" != "$(lower "$(physical "$BRAIN_DIR")")" ]; then
    fail "this Mac already has a brain at $(tilde "$BRAIN_DIR") (saved in $CONFIG), and the installer does not move it. To move it: move the folder, set BRAIN_DIR in $CONFIG to the new place, then run the install line again without --brain. Nothing was changed."
  fi
  [ -d "$BRAIN_DIR" ] || fail "your brain should be at $BRAIN_DIR (saved in $CONFIG), but that folder is not there. Nothing was changed. Put the folder back, or set BRAIN_DIR in $CONFIG to where it is now, then run the install line again."
  echo "Updating the Brain app for $NAME. Your brain at $(tilde "$BRAIN_DIR") is not touched."
  if PLACE="$(protected_place "$BRAIN_DIR")"; then
    echo "WARNING: your brain is in $PLACE. macOS does not let background jobs open files there, so it is not being saved automatically and the app may not be able to read it. Move it to a folder outside Desktop, Documents, Downloads and iCloud Drive (for example ~/Brain), set BRAIN_DIR in $CONFIG to the new place, and run the install line again." >&2
  fi
else
  MODE=install
  if [ -n "$BRAIN_ARG" ]; then BRAIN_DIR="$(expand "$BRAIN_ARG")"; else BRAIN_DIR="$HOME/Brain"; fi
  check_brain_place "$BRAIN_DIR"
  BRAIN_DIR="$(physical "$BRAIN_DIR")"
  if [ -e "$BRAIN_DIR" ] || [ -L "$BRAIN_DIR" ]; then
    FOUND="$(on_disk "$BRAIN_DIR")"
    if [ -z "$BRAIN_ARG" ]; then
      if [ "$FOUND" != "$BRAIN_DIR" ]; then
        fail "a folder named $(tilde "$FOUND") already exists. This Mac's disk does not tell upper from lower case, so ~/Brain would be that same folder. Nothing was changed. To start a new brain, run the install line again with a new folder, for example --brain ~/MyBrain. If $(tilde "$FOUND") already is your brain, pass --brain $(tilde "$FOUND") to use it as it is."
      fi
      fail "~/Brain already exists and was not made by this installer. Nothing was changed. If it is your brain, run the install line again with --brain ~/Brain to use it as it is (its history is kept). To start a new brain, pass --brain with a new folder."
    fi
    BRAIN_DIR="$FOUND"
    check_adoptable "$BRAIN_DIR"
    ADOPT=yes
  fi
  NAME="$NAME_ARG"
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

if [ "$MODE" = install ] && [ "$ADOPT" = yes ]; then
step "Using your brain at $(tilde "$BRAIN_DIR")"
echo "Nothing in it is changed, added or removed."
if [ -e "$BRAIN_DIR/.git" ]; then
  echo "Its git history is kept; automatic saves add to it."
else
  echo "It has no git history yet; the first automatic save starts one."
fi
elif [ "$MODE" = install ]; then
step "Creating your brain at $(tilde "$BRAIN_DIR")"
mkdir -p "$(dirname "$BRAIN_DIR")"
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
[ "$MODE" = install ] && printf 'BRAIN_NAME="%s"\nBRAIN_DIR="%s"\nBRAIN_PORT="%s"\n' "$NAME" "$BRAIN_DIR" "$PORT" > "$CONFIG"
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
# Installers before 15 November linked the commands in /opt/homebrew/bin or /usr/local/bin, which every account on
# the Mac shares, so another account's assistants would run this account's copy. Such a link is removed, only when
# it is a symlink to this account's own script; anything else there is left alone.
for old in /opt/homebrew/bin /usr/local/bin; do
  for cmd in brainmap brainpack; do
    [ -L "$old/$cmd" ] && [ "$(readlink "$old/$cmd")" = "$STATE_DIR/$cmd.sh" ] && rm -f "$old/$cmd" 2>/dev/null \
      && echo "Removed the old shared command link $old/$cmd (the command is now in $BIN_DIR)."
  done
done
# BRAIN_LOGIN_SHELL overrides the shell checked (the installer test uses it to isolate a test home).
LOGIN_SHELL="${BRAIN_LOGIN_SHELL:-$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | awk '{print $2}')}"
[ -n "$LOGIN_SHELL" ] || LOGIN_SHELL="${SHELL:-/bin/zsh}"
# Not finding it is an answer, not an error (the installer runs with set -e and pipefail).
in_shell() { { "$LOGIN_SHELL" -lc "command -v $1" 2>/dev/null </dev/null || true; } | tail -1; }
found_in_shell() { in_shell brainmap; }
# Said only when a new Terminal window would run some other brainmap (one earlier on the PATH than ~/.local/bin).
other_brainmap() {
  [ -n "$FOUND" ] && ! [ "$FOUND" -ef "$STATE_DIR/brainmap.sh" ] || return 0
  echo "Note: a different brainmap comes earlier on your PATH, so new Terminal windows and assistants will run $FOUND, not the Brain's $BIN_DIR/brainmap. Remove or rename that one to use the Brain's."
}
FOUND="$(found_in_shell)"
if [ -n "$FOUND" ]; then
  other_brainmap
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
    if [ -n "$FOUND" ]; then other_brainmap
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
  <key>EnvironmentVariables</key><dict><key>BRAIN_PORT</key><string>$PORT</string><key>BRAIN_DIR</key><string>$BRAIN_DIR</string></dict>
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
# The next steps follow what the app will show: its Connect Claude Code button appears when the login shell finds
# claude (src/assistant-env.js asks the same shell).
if [ "$ADOPT" != yes ]; then
  if [ -n "$(in_shell claude)" ]; then
    echo "Next: in the Brain app, click Connect Claude Code, then Set up your brain."
  else
    echo "First step: in the Brain app, click Set up your brain."
  fi
fi
echo "Backups: your brain ($(tilde "$BRAIN_DIR")) is saved on this Mac every 15 minutes. It is sent nowhere."
echo "If a save fails, the Brain app shows a red message at the top saying why."
