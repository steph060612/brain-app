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
limit) and writes `~/.brain/maps/<slug>/map.json` (schemaVersion 10). Literal document IDs in Firestore paths (generated-looking
values, UUIDs, email addresses, long numbers) are replaced by `{id}` before anything is stored, so they never appear in
the map, the diagram or brainmap; short fixed document names such as `stats/exercisePRs` are kept. Firestore use is read in every folder (app,
functions/, scripts/): one node per top-level collection (counting everything under it) and one per subcollection
path pattern, such as `users/{uid}/workoutLogs`; each read or write records the named function it is in. Calls
from one file to a function exported by another are `calls` edges (renamed, namespace and default imports, `require`,
re-exports through index files). An imported function handed to another file's function, as an argument or inside an
object literal (`backfill(uid, { getWorkoutLogs })`), is followed one hop to where that function calls it, and recorded
as a call marked via value, with both lines. Calls the mapper cannot follow with certainty are listed as unresolved,
kind `call`. Calls to a function defined in the same file (exported or not) are recorded too, marked same file, so
chains through local helpers stay connected: `callers`, `collection` ("Through functions", `--depth`), `impact
file:function`, `path`, `query` and `report` follow them, and a same-file hop does not use up a level of `--depth`.
The diagram draws calls per file pair only and lists same-file calls in the file's card. A map in an older format is re-made automatically by the panel and by
`brainmap`. **View map** replaces the brain with a
force-directed diagram of that map: a Folders view by default (one bubble per top-level folder, links weighted
by the file links between them, Show files expands a folder in place) and a Files view. Linked folders are only read (the one exception is the assistants block below); git is called with
`--no-optional-locks` and nothing is ever committed in them.
JavaScript and TypeScript are supported (.js .jsx .mjs .cjs .ts .tsx), parsed with Babel (typescript plugin for
TS). Imports resolve to the JS and TS extensions and index files (`./x.js` may mean `x.ts`), and through the nearest
tsconfig.json or jsconfig.json (with its `extends` chain) for `paths` aliases and `baseUrl`. `.d.ts` files are used only
to resolve imports. Type-only imports and exports (`import type`, `export type`, and imports of interfaces or type
aliases) are `type-import` links: hidden in the diagram by default (the "Type imports" layer), left out of calls, and
followed by `brainmap impact --types`. Vendored code is never mapped: folders named vendor, vendors or third_party,
`.min.js`, `.bundle.js` and `.global.js` files, and files over 20,000 lines that no project file imports; the map
lists each skipped file with the reason.

The mapper also runs on its own: `node src/mapper.js <project folder> <output name>`.

### brainmap (for coding assistants)

`brainmap` answers structure questions from the saved map, in compact plain text (each list shows its first
items with "(+N more, use --all)"): `overview`, `files <folder>`, `file <path>`, `impact <path>`, `screen <name>`,
`collection <name>`, `function <name>`, `callers <name|file:name>`, `find <text>`, `unused`, `path <A> <B>`, `report`, `query "<question>"`, `groups`, `group <label|number>` and `notes <file|function|--all>`.
Groups are detected separately for each root (app, functions/, scripts/), so scripts and cloud functions never join
app groups; links across roots still show in a group's "depends on" and "used by".
Every link is tagged extracted (written out in the code) or inferred (derived by the mapper: a function passed as a
value, a screen name inferred from a variable or condition, data reached through a helper-built reference or a
resolved value, subcollection placeholders merged by position); output marks inferred links, `path` ends with its
confidence, `report` counts both, and the diagram draws inferred links lighter.
`notes` lists comments that start with NOTE, WHY, HACK, FIXME, TODO, IMPORTANT or WARNING (in capitals, or followed
by a colon, dash or parenthesis) and comments citing an ADR or RFC, attached to their function (or the file), with
line and the first 200 characters; `file` and `callers` show how many there are, and `query` matches their words at
a lower weight than names.
`groups` lists subsystems: groups of related files found by community detection on the file graph (Louvain with a
Leiden-style refinement that keeps every group connected; fixed seed, so the same code gives the same groups). Links
are weighted per kind (imports 1, calls +1 and a little per call site, navigation 1.5, shared collections 2/(k−1),
same-file calls a small self-weight, links into files used almost everywhere scaled down); files linked to nothing go
to an "isolated" bucket. Each group is named from its most distinctive words (file, screen, function and collection
names, camelCase split, common words dropped) and lists its 3 most central files. The diagram's Files view can
color by group ("Color by: Folder | Group").
`query` answers a question in plain words without AI: it drops common words, splits camelCase, snake_case and paths
on both sides with simple plural matching, scores files, exported functions, screens and collections by the words
in their names, keeps up to 5 clear matches and prints the links around them (grouped by kind, links between two
matches first, paths of up to 3 hops between matches) and three follow-up commands; with no clear match it suggests
`brainmap find`.
`path` finds the shortest chain of links (imports, calls including via value, navigation, cloud functions, reads,
writes) between two files, functions, screens or collections, hop by hop with file and line; it says when only the
reverse direction exists, tries navigation alone first between two screens, and `--all-shortest` lists up to 5.
`report` lists the most-connected files, most-called functions, busiest data, bridge files (articulation points of
the import graph), rare links between folders and five ready-to-run follow-up commands; the diagram shows the same
report in its findings. `collection` also lists the
functions that read or write it and who calls them ("Through functions"; `--depth 2` adds the callers of those
callers). Run it inside a linked folder, or pass `--project <name>`. Before answering it runs the same "code changed
since last map" check as the panel and re-maps when needed. It prints paths, names and numbers only, never file
contents. `install.sh` links it next to `brainpack` (`~/.brain/brainmap.sh`, symlinked into `/opt/homebrew/bin` or
`/usr/local/bin`).

**Tools for Claude Code (MCP).** `src/brainmap-mcp.js` is a local stdio tool server with the same queries as tools
(`overview`, `file`, `impact`, `callers`, `collection`, `screen`, `find`, `unused`, `path`, `report`, `query`, `groups`, `group`, `notes`, each with an `all` option). Each tool
runs `brainmap` in the assistant's working folder, so the text, limits and automatic refresh are the same; in a folder
that is not linked it answers in one line. Read-only. `install.sh` registers it at user scope (every project, no
project files touched):

```sh
claude mcp add --scope user brainmap -- "$(command -v node)" ~/Projects/brain-app/src/brainmap-mcp.js   # install
claude mcp remove --scope user brainmap                                                              # uninstall
bash install.sh --remove-assistant-tools                                                             # same, via the installer
```

In a fresh session it adds about 100 tokens to `/context` (57 for the server instructions plus the tool names); the
full tool definitions (about 900 tokens) are loaded only when the assistant looks them up.

**Strict mode** (panel, per project, opt in: "Strict: send the first code search to the map") adds a Claude Code
PreToolUse hook (`src/brainmap-hook.js`) to the project's `.claude/settings.local.json`. In each session it blocks the
first Grep, Glob or Read of source code once, with a message to use the map tools, then allows everything. It never
blocks CLAUDE.md, AGENTS.md, other Markdown, JSON or configuration files, does nothing in a folder without a map, and
lets everything through on any error. Session markers live in `~/.brain/strict-sessions`. It is refused when git
would track the file; the change is previewed, refused if the file changed after the preview, and Remove restores
the file byte for byte (original kept in `~/.brain/strict-backups`) unless it was edited since, in which case only
the hook is taken out.

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

