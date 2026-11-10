#!/bin/bash
# Brain installer for a new Mac user. Run from the brain-app folder:  bash scripts/install.sh "FirstName"
# Creates an empty brain at ~/Brain, settings in ~/.brain, and two background jobs that start at login:
# the Brain app (http://localhost:5180) and a local auto-commit every 15 minutes. Never overwrites ~/Brain.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRAIN_DIR="$HOME/Brain"
STATE_DIR="$HOME/.brain"
AGENTS_DIR="$HOME/Library/LaunchAgents"
TODAY="$(date +%Y-%m-%d)"

fail() { echo "Stopped: $1" >&2; exit 1; }
step() { echo; echo "==> $1"; }

[ "$(uname)" = "Darwin" ] || fail "this installer is for macOS only."
NAME="${1:-}"
if [ -z "$NAME" ]; then read -r -p "Your first name (used in your packs and rules): " NAME; fi
[ -n "$NAME" ] || fail "a first name is required."
case "$NAME" in *[\"\'\$\`\\]*) fail "the name cannot contain quotes, \$, backticks or backslashes." ;; esac

step "Checking tools"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || fail "Node.js is missing. Install it (for example: brew install node), then run this again."
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20 or newer is needed (found $("$NODE" -v))."
command -v npm >/dev/null || fail "npm is missing."
command -v git >/dev/null || fail "git is missing. Run: xcode-select --install"
git --version >/dev/null 2>&1 || fail "git does not run yet. Run: sudo xcodebuild -license accept"
echo "Node $("$NODE" -v), git ok."

[ -e "$BRAIN_DIR" ] && fail "$BRAIN_DIR already exists. This installer never overwrites a brain."

step "Creating your brain at $BRAIN_DIR"
cp -R "$APP_DIR/templates/brain" "$BRAIN_DIR"
mv "$BRAIN_DIR/gitignore" "$BRAIN_DIR/.gitignore"
for f in "$BRAIN_DIR"/*.md; do
  /usr/bin/sed -i '' -e "s/{{NAME}}/$NAME/g" -e "s/{{TODAY}}/$TODAY/g" "$f"
done
( cd "$BRAIN_DIR" && git init -q -b main && git add -A && git -c user.name="$NAME" -c user.email="brain@localhost" commit -q -m "Start brain" )
echo "Empty brain created and saved as a first local commit."

step "Settings and scripts in $STATE_DIR"
mkdir -p "$STATE_DIR/packs" "$STATE_DIR/imports"
printf 'BRAIN_NAME="%s"\nBRAIN_DIR="%s"\n' "$NAME" "$BRAIN_DIR" > "$STATE_DIR/config"
cp "$APP_DIR/scripts/brainpack.sh" "$APP_DIR/scripts/autocommit.sh" "$STATE_DIR/"
chmod +x "$STATE_DIR/brainpack.sh" "$STATE_DIR/autocommit.sh"
for bin in /opt/homebrew/bin /usr/local/bin; do
  if [ -d "$bin" ] && [ -w "$bin" ]; then ln -sf "$STATE_DIR/brainpack.sh" "$bin/brainpack"; echo "brainpack command linked in $bin."; break; fi
done

step "Building the Brain app"
( cd "$APP_DIR" && npm ci --no-audit --no-fund && npm run build )

step "Background jobs"
mkdir -p "$AGENTS_DIR"
cat > "$AGENTS_DIR/com.brain.app.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.brain.app</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$APP_DIR/server.js</string></array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
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
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://localhost:5180 >/dev/null 2>&1; then echo "Brain app is running at http://localhost:5180"; break; fi
  sleep 1
  [ "$i" = 10 ] && echo "The app did not answer yet. Check $STATE_DIR/brain-app.log"
done

echo
echo "Done. Next: open http://localhost:5180 in Safari, then File > Add to Dock."
echo "Backups: your brain is saved locally every 15 minutes. It is pushed nowhere unless you add a private GitHub remote yourself."
