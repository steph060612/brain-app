#!/bin/bash
# Usage:
#   brainpack.sh <project>                 full pack: rules, profile, preferences, project files (new chat about a project)
#   brainpack.sh --project-only <project>  project files only (chat that already has the rules)
#   brainpack.sh --general                 rules, profile, preferences only (new chat, no project yet)
#   brainpack.sh                           list projects

# Settings: ~/.brain/config sets BRAIN_NAME (the owner's first name) and optionally BRAIN_DIR.
[ -f "$HOME/.brain/config" ] && . "$HOME/.brain/config"
BRAIN_NAME="${BRAIN_NAME:-the owner}"
BRAIN_DIR="${BRAIN_DIR:-$HOME/Brain}"
PACKS_DIR="$HOME/.brain/packs"
DATE="/bin/date"
TODAY=$("$DATE" "+%Y-%m-%d")

strip_permalink() {
    /usr/bin/grep -v '^permalink:' "$1"
}

print_file() {
    local filepath="$1"
    local relpath="$2"
    echo "=== FILE: $relpath ==="
    strip_permalink "$filepath"
    echo ""
}

list_projects() {
    echo "Available projects:"
    for d in "$BRAIN_DIR/projects"/*/; do
        echo "  $(/usr/bin/basename "$d")"
    done
    echo "Available archive:"
    for d in "$BRAIN_DIR/archive"/*/; do
        echo "  $(/usr/bin/basename "$d")"
    done
}

MODE="full"
case "$1" in
    --project-only) MODE="project-only"; shift ;;
    --general)      MODE="general"; shift ;;
    --setup)        MODE="setup"; shift ;;
esac
shopt -s nullglob

# Setup interview: first session for an empty brain. The assistant interviews the owner and outputs
# the first files in the UPDATE PROTOCOL format, which go through Paste proposals like any close session.
if [ "$MODE" = "setup" ]; then
    S="SETUP INTERVIEW for ${BRAIN_NAME}'s new knowledge base (exported $TODAY). The brain is almost empty: only the rules, a profile with the name, and empty preferences, shown below. Your job in this chat is to fill it by interviewing $BRAIN_NAME."$'\n\n'
    for f in README.md profile.md preferences.md; do
        S+="=== FILE: $f ==="$'\n'"$(/usr/bin/grep -v '^permalink:' "$BRAIN_DIR/$f")"$'\n\n'
    done
    S+="=== HOW TO RUN THE INTERVIEW ==="$'\n'
    S+="1. Ask one short question at a time and wait for the answer. Keep it to about 15 questions in total; skip what does not apply."$'\n'
    S+="2. Cover, in this order: who they are (studies or work, where they live, languages); how they want assistants to work with them (tone, length, format, what annoys them); their active projects, for each one what it is, current status, the single next step, decisions already made with the reason, and stable background; then only the people and topics that matter for those projects."$'\n'
    S+="3. You may already know things about $BRAIN_NAME from earlier chats. Use them only as questions to confirm, for example 'I have that you study X, is that still true?'. Never write anything $BRAIN_NAME did not state or confirm in this chat."$'\n'
    S+="4. Never ask for or record passwords, card or account numbers, ID numbers, balances or health details."$'\n'
    S+="5. When the interview is done, or when $BRAIN_NAME says 'close session', output the files in the UPDATE PROTOCOL format from README.md, all blocks inside one single code block and nothing else in it. profile.md and preferences.md already exist: use the append action for them. For everything else use the create action, with frontmatter (title, updated: $TODAY). Each project gets projects/[short-hyphenated-name]/state.md, decisions.md and context.md. People go in people/[name].md, other subjects in topics/[subject].md. Short bullet points, dated where they can go stale."$'\n'
    S+="6. Tell $BRAIN_NAME at the end: copy the code block, open the Brain app, Inbox, Paste proposals, then approve."$'\n\n'
    S+="Start now with your first question."$'\n'
    /bin/mkdir -p "$PACKS_DIR"
    PACK_FILE="$PACKS_DIR/setup-interview-${TODAY}.md"
    printf '%s' "$S" > "$PACK_FILE"
    printf '%s' "$S" | /usr/bin/pbcopy
    echo "Saved to: $PACK_FILE"
    echo "Size: ${#S} characters"
    exit 0
fi

PROJECT_NAME="$1"

if [ "$MODE" != "general" ]; then
    if [ -z "$PROJECT_NAME" ]; then
        list_projects
        [ "$MODE" = "full" ] && exit 0
        exit 1
    fi

    PROJECT_DIR=""
    if [ -d "$BRAIN_DIR/projects/$PROJECT_NAME" ]; then
        PROJECT_DIR="$BRAIN_DIR/projects/$PROJECT_NAME"
        PROJECT_REL="projects/$PROJECT_NAME"
    elif [ -d "$BRAIN_DIR/archive/$PROJECT_NAME" ]; then
        PROJECT_DIR="$BRAIN_DIR/archive/$PROJECT_NAME"
        PROJECT_REL="archive/$PROJECT_NAME"
    else
        echo "Project '$PROJECT_NAME' not found."
        echo ""
        list_projects
        exit 1
    fi
fi

PACK=""

case "$MODE" in
    full)
        PACK+="FULL PACK for a NEW chat. This is ${BRAIN_NAME}'s personal context, exported from their knowledge base on $TODAY. Follow the rules in README.md, the working preferences in preferences.md, and the WORKING RULES at the end. The project below is $PROJECT_NAME. If an earlier version of this context is already in this chat, this one replaces it."
        ;;
    project-only)
        PACK+="PROJECT-ONLY UPDATE for project $PROJECT_NAME, from ${BRAIN_NAME}'s knowledge base, exported $TODAY. It replaces any earlier version of these project files in this chat. It assumes this chat already contains ${BRAIN_NAME}'s README.md rules, profile.md and preferences.md from an earlier full or general pack. If you cannot see those earlier in this chat, say so in your first line and ask $BRAIN_NAME for the full pack before giving advice."
        ;;
    general)
        PACK+="GENERAL PACK for a NEW chat with no project yet. This is ${BRAIN_NAME}'s general context, exported from their knowledge base on $TODAY. Follow the rules in README.md, the working preferences in preferences.md, and the WORKING RULES at the end. If the chat turns out to be about one of the existing projects listed below, tell $BRAIN_NAME to paste that project's full pack instead."
        ;;
esac
PACK+=$'\n\n'

append_file() {
    local filepath="$1"
    local relpath="$2"
    if [ -f "$filepath" ]; then
        PACK+="=== FILE: $relpath ==="$'\n'
        PACK+="$(strip_permalink "$filepath")"$'\n\n'
    fi
}

if [ "$MODE" != "project-only" ]; then
    append_file "$BRAIN_DIR/README.md" "README.md"
    append_file "$BRAIN_DIR/profile.md" "profile.md"
    append_file "$BRAIN_DIR/topics/skills.md" "topics/skills.md"
    append_file "$BRAIN_DIR/preferences.md" "preferences.md"
fi

if [ "$MODE" != "general" ]; then
    for f in state.md decisions.md context.md; do
        append_file "$PROJECT_DIR/$f" "$PROJECT_REL/$f"
    done
else
    PACK+="=== EXISTING PROJECTS ==="$'\n'
    for d in "$BRAIN_DIR/projects"/*/; do
        PACK+="- $(/usr/bin/basename "$d")"$'\n'
    done
    PACK+=$'\n'
fi

PACK+="=== WORKING RULES ==="$'\n'
if [ "$MODE" != "general" ]; then
    ALL_PROJECTS=""
    for d in "$BRAIN_DIR/projects"/*/; do ALL_PROJECTS+="$(/usr/bin/basename "$d"), "; done
    ALL_PROJECTS="${ALL_PROJECTS%, }"
    PACK+="0. Right pack. This pack is for project $PROJECT_NAME. If ${BRAIN_NAME}'s request is about something else (projects in the brain: $ALL_PROJECTS), say so in your first line and ask them for the right project's pack before helping."$'\n'
    PACK+="1. Plan check first. Before helping with any plan or next step $BRAIN_NAME brings, compare it with state.md and decisions.md above, including any Open risks section. If it contradicts an earlier decision, ignores a known risk, or the reasoning is weak, say so in your first lines, before any help executing it. Do not wait to be asked."$'\n'
else
    PACK+="1. Plan check first. Before helping with any plan $BRAIN_NAME brings, check it against profile.md and preferences.md and challenge weak reasoning in your first lines, before any help executing it. Do not wait to be asked."$'\n'
fi
PACK+="2. No inflated claims. When you describe $BRAIN_NAME, their experience or their results (CVs, applications, cover letters, messages, bios), never claim more than these files state. No invented numbers, users, revenue, roles or outcomes; no upgrading 'built' to 'launched' or 'demo' to 'in use'. If a stronger claim would help, ask $BRAIN_NAME whether it is true instead of writing it."$'\n'
PACK+="3. Brain files only. The knowledge base is only the markdown files under projects/, archive/, people/ and topics/, plus profile.md and preferences.md. Never propose changes to anything else (spreadsheets, trackers, documents, other apps). If something outside the brain should change, tell $BRAIN_NAME in plain text, outside the code block."$'\n'
if [ "$MODE" != "general" ]; then
    PACK+="4. Close session. When $BRAIN_NAME says 'close session', output proposed changes using the UPDATE PROTOCOL format in README.md, with all blocks inside one single code block and nothing else in it, so the format stays intact when copied. Include only facts $BRAIN_NAME stated or confirmed in this chat. Do not assume your changes are saved; $BRAIN_NAME applies them themselves."$'\n'
else
    PACK+="4. Close session. When $BRAIN_NAME says 'close session', output proposed changes using the UPDATE PROTOCOL format in README.md, all blocks inside one single code block. If this became a new project, propose creating projects/[short-hyphenated-name]/state.md, decisions.md and context.md using the create action."$'\n'
fi
PACK+=$'\n'

/bin/mkdir -p "$PACKS_DIR"
case "$MODE" in
    full)         PACK_FILE="$PACKS_DIR/${PROJECT_NAME}-${TODAY}.md" ;;
    project-only) PACK_FILE="$PACKS_DIR/${PROJECT_NAME}-project-only-${TODAY}.md" ;;
    general)      PACK_FILE="$PACKS_DIR/general-pack-${TODAY}.md" ;;
esac
printf '%s' "$PACK" > "$PACK_FILE"

printf '%s' "$PACK" | /usr/bin/pbcopy

CHAR_COUNT=${#PACK}
echo "Saved to: $PACK_FILE"
echo "Size: $CHAR_COUNT characters"
