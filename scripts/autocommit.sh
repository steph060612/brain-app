#!/bin/bash
# Saves the brain with git, every 15 minutes (~/Library/LaunchAgents/com.brain.autocommit.plist runs it).
# Every run records what really happened: one line in ~/.brain/autocommit.log ("committed <commit>", "no changes",
# "skipped: ..." or "error: ..." with git's own message) and the latest outcome in ~/.brain/autocommit-status,
# which the Brain app reads to show a failing save on screen. Runs under macOS's /bin/bash 3.2.

[ -f "$HOME/.brain/config" ] && . "$HOME/.brain/config"
BRAIN_DIR="${BRAIN_DIR:-$HOME/Brain}"
STATE_DIR="$HOME/.brain"
LOG="$STATE_DIR/autocommit.log"
STATUS="$STATE_DIR/autocommit-status"
GIT="/usr/bin/git"
TIMESTAMP=$(/bin/date "+%Y-%m-%d %H:%M")
NOW=$(/bin/date -u "+%Y-%m-%dT%H:%M:%SZ")
mkdir -p "$STATE_DIR"

# record OUTCOME [MESSAGE]: one log line, and the status file the app reads:
#   line 1 outcome (committed, no-changes, skipped, error), line 2 time, line 3 when the current failures began
#   (errors only), then the message.
record() {
    local outcome="$1" msg="${2:-}" since="" word
    if [ "$outcome" = error ]; then
        [ "$(/usr/bin/sed -n 1p "$STATUS" 2>/dev/null)" = error ] && since=$(/usr/bin/sed -n 3p "$STATUS" 2>/dev/null)
        [ -n "$since" ] || since="$NOW"
    fi
    word="$outcome"; [ "$outcome" = no-changes ] && word="no changes"
    if [ -n "$msg" ]; then
        echo "$TIMESTAMP $word: $(printf '%s' "$msg" | /usr/bin/tr '\n' ' ' | /usr/bin/sed 's/  */ /g')" >> "$LOG"
    else
        echo "$TIMESTAMP $word" >> "$LOG"
    fi
    printf '%s\n%s\n%s\n%s\n' "$outcome" "$NOW" "$since" "$msg" > "$STATUS.tmp" && /bin/mv -f "$STATUS.tmp" "$STATUS"
}
failed() { record error "$1"; exit 1; }

lower() { printf '%s' "$1" | /usr/bin/tr '[:upper:]' '[:lower:]'; }
# The folder macOS keeps from background jobs that holds $1, if any (Desktop, Documents, Downloads, iCloud Drive,
# cloud storage). Compared without case: the Mac's disk ignores it. Same list as install.sh.
protected_place() {
    local p h d label
    p="$(lower "$1")/"
    h="$(lower "$HOME")"
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
    return 1
}
MOVE_HELP="Move the brain to a folder in your home folder outside Desktop, Documents, Downloads and iCloud Drive (for example ~/Brain), set BRAIN_DIR in ~/.brain/config to the new place, then run the Brain install line again."

# Without Apple's developer tools, /usr/bin/git only opens an install dialog: skip until they exist.
/usr/bin/xcode-select -p >/dev/null 2>&1 || { record skipped "developer tools not installed"; exit 0; }

if PLACE=$(protected_place "$BRAIN_DIR"); then
    failed "Your brain is in $PLACE ($BRAIN_DIR). macOS does not let background jobs open that folder, so it cannot be saved automatically. $MOVE_HELP"
fi
[ -d "$BRAIN_DIR" ] || failed "The brain folder $BRAIN_DIR does not exist. If you moved it, set BRAIN_DIR in ~/.brain/config to where it is now."
if ! OUT=$(/bin/ls "$BRAIN_DIR" 2>&1 >/dev/null); then
    case "$OUT" in
        *"Operation not permitted"*) failed "macOS does not let background jobs open $BRAIN_DIR (Operation not permitted), so it cannot be saved automatically. $MOVE_HELP" ;;
        *) failed "Cannot read $BRAIN_DIR: $OUT" ;;
    esac
fi
cd "$BRAIN_DIR" 2>/dev/null || failed "Cannot open $BRAIN_DIR."

# Use the Mac's git identity when one is set; otherwise a local placeholder.
IDENT=()
"$GIT" config user.email >/dev/null 2>&1 || IDENT=(-c user.name="${BRAIN_NAME:-brain}" -c user.email="brain@localhost")

# A brain created before git was available (or adopted without history) gets its repository on the first run.
if [ ! -e .git ]; then
    OUT=$( { "$GIT" init -q -b main && "$GIT" add -A && "$GIT" "${IDENT[@]}" commit -q -m "Start brain"; } 2>&1 ) \
        || failed "Could not start the brain's git history: $OUT"
    record committed "started local history ($("$GIT" rev-parse --short HEAD 2>/dev/null))"
    exit 0
fi

CHANGES=$("$GIT" status --porcelain 2>&1) || failed "git status failed: $CHANGES"
if [ -z "$CHANGES" ]; then
    record no-changes
else
    OUT=$("$GIT" add -A 2>&1) || failed "git add failed: $OUT"
    OUT=$("$GIT" "${IDENT[@]}" commit -q -m "Auto-commit $TIMESTAMP" 2>&1) || failed "git commit failed: $OUT"
    record committed "$("$GIT" rev-parse --short HEAD 2>/dev/null)"
fi

"$GIT" remote get-url origin >/dev/null 2>&1 || exit 0

LOCAL=$("$GIT" rev-parse HEAD)
REMOTE=$("$GIT" rev-parse origin/main 2>/dev/null)
if [ "$LOCAL" != "$REMOTE" ]; then
    if PUSH_OUT=$("$GIT" push origin main 2>&1); then
        echo "$TIMESTAMP pushed" >> "$LOG"
    else
        failed "Saved on this Mac, but the push to origin failed: $PUSH_OUT"
    fi
fi
