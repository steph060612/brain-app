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
limit) and writes `~/.brain/maps/<slug>/map.json` (schemaVersion 2). **View map** replaces the brain with a
force-directed diagram of that map: a Folders view by default (one bubble per top-level folder, links weighted
by the file links between them, Show files expands a folder in place) and a Files view. Linked folders are only read (the one exception is the assistants block below); git is called with
`--no-optional-locks` and nothing is ever committed in them.
Only JavaScript projects are supported.

The mapper also runs on its own: `node src/mapper.js <project folder> <output name>`.

### brainmap (for coding assistants)

`brainmap` answers structure questions from the saved map, in compact plain text (60 lines unless `--all`):
`overview`, `files <folder>`, `file <path>`, `impact <path>`, `screen <name>`, `collection <name>`,
`function <name>`, `find <text>`, `unused`. Run it inside a linked folder, or pass `--project <name>`. Before
answering it runs the same "code changed since last map" check as the panel and re-maps when needed. It prints
paths, names and numbers only, never file contents. `install.sh` links it next to `brainpack`
(`~/.brain/brainmap.sh`, symlinked into `/opt/homebrew/bin` or `/usr/local/bin`).

**Enable for assistants** (panel, linked projects) shows a short block and, after confirmation, adds it between
`<!-- brainmap:start … -->` and `<!-- brainmap:end -->` markers to the project's AGENTS.md (or CLAUDE.md when there
is no AGENTS.md, unless CLAUDE.md only points to AGENTS.md). **Remove** deletes only that block (and the file, if
nothing else is left in it).

