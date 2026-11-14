# brain-app

A local neural-brain visualization connected to the `~/Brain` knowledge base. Procedural Three.js brain with glowing points, surface labels for every Brain item, and a right-side panel for reading and editing Markdown files directly.

## Address

**http://localhost:5180**

The server starts automatically at login via a macOS LaunchAgent and restarts if it crashes.

## After code changes

Run these commands in order:

```sh
cd ~/Projects/brain-app
npm run build
launchctl kickstart -k gui/$(id -u)/com.steph.brain-app
```

`npm run build` compiles the frontend into `dist/`. The kickstart command replaces the running process with the updated one.

## Log

```
~/.brain/brain-app.log
```

Stdout and stderr from the server both go here. Tail it live:

```sh
tail -f ~/.brain/brain-app.log
```

## LaunchAgent

`~/Library/LaunchAgents/com.steph.brain-app.plist`

To stop the server:
```sh
launchctl bootout gui/$(id -u) com.steph.brain-app
```

To start it again:
```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.steph.brain-app.plist
```

## Dev mode

```sh
npm run dev
```

Starts Vite on port 5174 (with hot reload) and the API on port 3001 in parallel.

## Code maps

A project's panel can link a code folder (stored in `~/.brain/code-folders.json`, never in `~/Brain`) and
**Map project**: the server runs `node src/mapper.js <folder> <slug>` (spawned with an argument list, 60 second
limit) and writes `~/.brain/maps/<slug>/map.json` (schemaVersion 5). Firestore use is read in every folder (app,
functions/, scripts/): one node per top-level collection (counting everything under it) and one per subcollection
path pattern, such as `users/{uid}/workoutLogs`; each read or write records the named function it is in. Calls
from one file to a function exported by another are `calls` edges (renamed, namespace and default imports, `require`,
re-exports through index files). An imported function handed to another file's function, as an argument or inside an
object literal (`backfill(uid, { getWorkoutLogs })`), is followed one hop to where that function calls it, and recorded
as a call marked via value, with both lines. Calls the mapper cannot follow with certainty are listed as unresolved,
kind `call`. A map in an older format is re-made automatically by the panel and by
`brainmap`. **View map** replaces the brain with a
force-directed diagram of that map: a Folders view by default (one bubble per top-level folder, links weighted
by the file links between them, Show files expands a folder in place) and a Files view. Linked folders are only read (the one exception is the assistants block below); git is called with
`--no-optional-locks` and nothing is ever committed in them.
Only JavaScript projects are supported.

The mapper also runs on its own: `node src/mapper.js <project folder> <output name>`.

### brainmap (for coding assistants)

`brainmap` answers structure questions from the saved map, in compact plain text (each list shows its first
items with "(+N more, use --all)"):
`overview`, `files <folder>`, `file <path>`, `impact <path>`, `screen <name>`, `collection <name>`,
`function <name>`, `callers <name|file:name>`, `find <text>`, `unused`. `collection` also lists the functions that
read or write it and who calls them ("Through functions"; `--depth 2` adds the callers of those callers). Run it inside a linked folder, or pass `--project <name>`. Before
answering it runs the same "code changed since last map" check as the panel and re-maps when needed. It prints
paths, names and numbers only, never file contents. `install.sh` links it next to `brainpack`
(`~/.brain/brainmap.sh`, symlinked into `/opt/homebrew/bin` or `/usr/local/bin`).

**Enable for assistants** (panel, linked projects) adds a short marked block, between `<!-- brainmap:start … -->` and
`<!-- brainmap:end -->`, that tells coding assistants to run `brainmap overview` at the start of a code task and the
matching brainmap command (`callers`, `impact`, `screen`, `collection`, `file`) before searching the repository. It goes
into every one of CLAUDE.md and AGENTS.md that exists in the code folder, because Claude Code loads CLAUDE.md by itself
while other assistants read AGENTS.md; when neither exists, both are created. The preview shows, per file, whether it
exists and the exact text added. An existing block (older wording included) is updated in place, never duplicated, and
the panel says "needs an update" until every file has the current block. Each file's marker records
`created-file=yes|no`. **Remove** takes the block out of every file that has it and deletes a file only when its marker
says the app created it and nothing else is in it. Both actions are refused if either file changed after the preview.
Nothing is committed in the project.

