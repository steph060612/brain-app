#!/bin/bash
# Build a release package of the Brain app from the current commit, and point get.sh at it. Publishes nothing.
#
#   scripts/release.sh v0.2.0 --notes-file notes.md --dry-run   print what would be built and published, change nothing
#   scripts/release.sh v0.2.0 --notes-file notes.md             print the same, ask, then build
#                                                               release/brain-app-v0.2.0.tar.gz
#                                            and update VERSION and SHA256 in get.sh
#   --notes-file F     the release notes (Markdown). Required to build: without it a dry run shows the plan but no
#                      publish command. Keep it outside the repository, or commit it: untracked files stop a release.
#   --yes              do not ask (still prints everything first)
#   --allow-untracked  proceed although untracked files exist (they are never packaged: the package is made
#                      from `git archive` of the commit, plus the built dist/)
#
# Refuses to run with uncommitted changes, or when the commit is not the one on origin/main (get.sh is read from
# main on GitHub, so the release must match a commit others can see). The package is built in a clean export of the
# commit with `npm ci` and `npm run build`, checked with scripts/check-build.mjs, then started on a spare port with an
# empty home folder and checked live (it must serve its own build and map schema) before it is packed.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
fail() { echo "✗ RELEASE REFUSED: $1" >&2; exit 1; }
say()  { echo "==> $1"; }

VERSION="" DRY=no YES=no ALLOW_UNTRACKED=no NOTES=""
while [ $# -gt 0 ]; do
  a="$1"; shift
  case "$a" in
    --notes-file) NOTES="${1:-}"; [ -n "$NOTES" ] || fail "--notes-file needs a file."; shift ;;
    --notes-file=*) NOTES="${a#--notes-file=}" ;;
    --dry-run) DRY=yes ;;
    --yes) YES=yes ;;
    --allow-untracked) ALLOW_UNTRACKED=yes ;;
    v[0-9]*) VERSION="$a" ;;
    *) fail "unknown argument $a. Usage: scripts/release.sh vX.Y.Z --notes-file FILE [--dry-run] [--yes] [--allow-untracked]" ;;
  esac
done
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]+)?$ ]] || fail "give a version like v0.2.0."
# Release notes: required to build and to print the publish command.
if [ -n "$NOTES" ]; then
  [ -f "$NOTES" ] || fail "notes file $NOTES does not exist."
  [ -n "$(tr -d '[:space:]' < "$NOTES")" ] || fail "notes file $NOTES is empty."
  NOTES="$(cd "$(dirname "$NOTES")" && pwd)/$(basename "$NOTES")"
fi

# ── Checks that change nothing ─────────────────────────────────────────────────────────────────────────────────
TRACKED="$(git status --porcelain --untracked-files=no)"
[ -z "$TRACKED" ] || fail "uncommitted changes to tracked files:
$TRACKED
Commit or stash them first: a release is built from a commit, not from the working tree."
UNTRACKED="$(git ls-files --others --exclude-standard)"
if [ -n "$UNTRACKED" ] && [ "$ALLOW_UNTRACKED" = no ]; then
  fail "untracked files (they would not be in the release):
$UNTRACKED
Commit them, delete them, or pass --allow-untracked to leave them out."
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = main ] || fail "on branch $BRANCH; releases are made from main."
git fetch -q origin main || fail "could not reach origin to compare with origin/main."
HEAD_SHA="$(git rev-parse HEAD)"
[ "$HEAD_SHA" = "$(git rev-parse origin/main)" ] || fail "HEAD ($(git rev-parse --short HEAD)) is not origin/main ($(git rev-parse --short origin/main)). Push or pull first."

CURRENT="$(sed -n 's/^VERSION="\(.*\)"$/\1/p' get.sh)"
CURRENT_SHA="$(sed -n 's/^SHA256="\(.*\)"$/\1/p' get.sh)"
[ -n "$CURRENT" ] && [ -n "$CURRENT_SHA" ] || fail "get.sh has no VERSION=\"...\" and SHA256=\"...\" lines to update."
[ "$VERSION" != "$CURRENT" ] || fail "get.sh already points at $VERSION."
[ "$(printf '%s\n%s\n' "${CURRENT#v}" "${VERSION#v}" | sort -V | tail -1)" = "${VERSION#v}" ] || fail "$VERSION is older than the published $CURRENT."
OUT="$REPO/release/brain-app-$VERSION.tar.gz"
[ ! -e "$OUT" ] || fail "$OUT already exists. A version is built once; pick a new one."
git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null && fail "tag $VERSION already exists."
SCHEMA="$(sed -n 's/^export const SCHEMA_VERSION = \([0-9]*\);$/\1/p' src/map-schema.js)"
# Where the one-line installer will download this version from: get.sh's own URL line, with the new version.
URL_TEMPLATE="$(sed -n 's/^URL="\(.*\)"$/\1/p' get.sh)"
[[ "$URL_TEMPLATE" =~ ^https://github\.com/([^/]+/[^/]+)/releases/download/\$VERSION/brain-app-\$VERSION\.tar\.gz$ ]] \
  || fail "get.sh's URL line no longer has the expected form; check it by hand."
REPO_SLUG="${BASH_REMATCH[1]}"
ASSET_URL="${URL_TEMPLATE//\$VERSION/$VERSION}"

# ── What would happen ─────────────────────────────────────────────────────────────────────────────────────────
echo
echo "Release plan"
echo "  version        $VERSION (get.sh now points at $CURRENT)"
echo "  commit         $(git log -1 --format='%h %s' HEAD)"
echo "  map schema     $SCHEMA"
echo "  package        release/brain-app-$VERSION.tar.gz: the $(git ls-files | wc -l | tr -d ' ') tracked files of this commit plus the built dist/, under brain-app/"
echo "  build          clean export of the commit, npm ci, npm run build, scripts/check-build.mjs, then a live check of the"
echo "                 package started on a spare port with an empty home folder"
echo "  get.sh         VERSION=\"$CURRENT\" -> \"$VERSION\"; SHA256 -> the new package's checksum (shown after the build)"
if [ -n "$NOTES" ]; then
  echo "  notes          $NOTES ($(wc -l < "$NOTES" | tr -d ' ') lines; first: $(grep -m1 -v '^[[:space:]]*$' "$NOTES" | cut -c1-80))"
  echo "  publishes      nothing. After it finishes, you publish with:"
  echo "                   gh release create $VERSION release/brain-app-$VERSION.tar.gz --repo $REPO_SLUG --target $HEAD_SHA --title $VERSION --notes-file $NOTES"
  echo "                 which tags commit $(git rev-parse --short HEAD) (the one packaged) and serves $ASSET_URL"
  echo "                 and only then commit and push get.sh (pushing it first would break the one-line install)."
else
  echo "  notes          none given"
  echo "  publishes      nothing, and no publish command is shown without release notes. Add --notes-file FILE."
fi
if [ -n "$UNTRACKED" ]; then echo "  left out       untracked: $(echo "$UNTRACKED" | tr '\n' ' ')"; fi
echo
[ "$DRY" = yes ] && { echo "Dry run: nothing was built or changed."; exit 0; }
[ -n "$NOTES" ] || fail "release notes are required to build: add --notes-file FILE (Markdown, kept outside the repository or committed)."
if [ "$YES" = no ]; then
  read -r -p "Build $VERSION now? [y/N] " ok
  [ "$ok" = y ] || [ "$ok" = Y ] || { echo "Nothing done."; exit 1; }
fi

# ── Build ─────────────────────────────────────────────────────────────────────────────────────────────────────
STAGE="$(mktemp -d)"
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$STAGE"; }
trap cleanup EXIT
PKG="$STAGE/brain-app"
say "Exporting commit $(git rev-parse --short HEAD)"
mkdir -p "$PKG"
git archive --format=tar HEAD | tar -x -C "$PKG"
say "Installing packages (npm ci)"
( cd "$PKG" && npm ci --no-audit --no-fund --loglevel=error )
say "Building"
( cd "$PKG" && BRAIN_COMMIT="$(git -C "$REPO" rev-parse --short HEAD)" npm run build --silent ) || fail "the build or its check failed (see above)."
node "$PKG/scripts/check-build.mjs" || fail "the packaged build does not match its map schema."

say "Starting the package on a spare port to check it live"
PORT=5190
while [ "$PORT" -lt 5199 ] && /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT + 1)); done
mkdir -p "$STAGE/home/Brain"
( cd "$PKG" && HOME="$STAGE/home" BRAIN_PORT="$PORT" exec node server.js >"$STAGE/server.log" 2>&1 ) &
SERVER_PID=$!
for _ in $(seq 1 30); do curl -fsS "http://localhost:$PORT/api/version" >/dev/null 2>&1 && break; sleep 0.5; done
HOME="$STAGE/home" BRAIN_PORT="$PORT" node "$PKG/scripts/check-build.mjs" --live \
  || { cat "$STAGE/server.log" >&2; fail "the package does not pass the live check."; }
kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""

say "Packing"
rm -rf "$PKG/node_modules"
mkdir -p "$REPO/release"
( cd "$STAGE" && COPYFILE_DISABLE=1 tar -czf "$OUT" brain-app )
SUM="$(shasum -a 256 "$OUT" | cut -d' ' -f1)"
COUNT="$(tar -tzf "$OUT" | grep -vc '/$')"
BUILD_ID="$(node -p "require('$PKG/dist/build-info.json').id")"

say "Pointing get.sh at $VERSION"
/usr/bin/sed -i '' -e "s/^VERSION=\"$CURRENT\"$/VERSION=\"$VERSION\"/" -e "s/^SHA256=\"$CURRENT_SHA\"$/SHA256=\"$SUM\"/" get.sh
grep -q "^VERSION=\"$VERSION\"$" get.sh && grep -q "^SHA256=\"$SUM\"$" get.sh || fail "could not update get.sh."

echo
echo "Built, not published."
echo "  package   $OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '), $COUNT files)"
echo "  sha256    $SUM"
echo "  build     $BUILD_ID (map schema $SCHEMA, commit $(git rev-parse --short HEAD))"
echo "  get.sh    now VERSION=\"$VERSION\", SHA256 as above (uncommitted)"
echo
echo "To publish, in this order:"
echo "  1. gh release create $VERSION $OUT --repo $REPO_SLUG --target $HEAD_SHA --title $VERSION --notes-file $NOTES"
echo "  2. curl -fsSL $ASSET_URL | shasum -a 256    # must print $SUM"
echo "  3. git commit -m \"get.sh: $VERSION\" get.sh && git push"
echo "To abandon: git checkout get.sh && rm $OUT"
