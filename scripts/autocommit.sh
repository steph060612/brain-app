#!/bin/bash

[ -f "$HOME/.brain/config" ] && . "$HOME/.brain/config"
BRAIN_DIR="${BRAIN_DIR:-$HOME/Brain}"
LOG="$HOME/.brain/autocommit.log"
GIT="/usr/bin/git"
DATE="/bin/date"

TIMESTAMP=$("$DATE" "+%Y-%m-%d %H:%M")

cd "$BRAIN_DIR" || {
    echo "$TIMESTAMP error: could not cd into $BRAIN_DIR" >> "$LOG"
    exit 1
}

if ! "$GIT" diff --quiet || ! "$GIT" diff --cached --quiet || [ -n "$("$GIT" ls-files --others --exclude-standard)" ] || [ -n "$("$GIT" ls-files --deleted)" ]; then
    "$GIT" add -A
    "$GIT" commit -m "Auto-commit $TIMESTAMP" >> "$LOG" 2>&1
    echo "$TIMESTAMP committed" >> "$LOG"
else
    echo "$TIMESTAMP no changes" >> "$LOG"
fi

"$GIT" remote get-url origin >/dev/null 2>&1 || exit 0

LOCAL=$("$GIT" rev-parse HEAD)
REMOTE=$("$GIT" rev-parse origin/main 2>/dev/null)
if [ "$LOCAL" != "$REMOTE" ]; then
    PUSH_OUT=$("$GIT" push origin main 2>&1)
    if [ $? -eq 0 ]; then
        echo "$TIMESTAMP pushed" >> "$LOG"
    else
        echo "$TIMESTAMP push failed: $PUSH_OUT" >> "$LOG"
    fi
fi
