# Developing the Brain app

Notes for working on the app itself. For using it, see [README.md](README.md).

## Layout

- `server.js`: the local API and static server (Express). Reads and writes `~/Brain`; app state lives in `~/.brain`.
- `src/`: the browser app (Vite, Three.js) and the code map: `mapper.js` (builds maps; `mapper-python.js` for Python, with the
  grammar in `grammars/`), `brainmap.js` (the command),
  `brainmap-mcp.js` (tool server), `codemap*.js` (panel, diagram, routes), `map-schema.js` (the map format version).
- `scripts/`: `install.sh` (installer and updater), `release.sh` (release packages), `restart.mjs` and
  `check-build.mjs` (build verification), and the scripts the installer copies into `~/.brain`.
- `templates/brain/`: the empty brain a new install starts from.

## Run a development copy

A development copy runs from its own folder, started at login by its own LaunchAgent: a plist in
`~/Library/LaunchAgents` whose `ProgramArguments` are a Node binary and this folder's `server.js`, with this folder as
`WorkingDirectory` and the log in `~/.brain/brain-app.log`. Name it `com.steph.brain-app` if you also run the installer
on the same Mac: the installer refuses to install over a Mac that has that developer agent.

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist   # start
launchctl bootout gui/$(id -u)/<label>                                   # stop
tail -f ~/.brain/brain-app.log                                           # log
```

`npm run dev` instead starts Vite on port 5174 (hot reload) and the API on port 3001.

## After code changes

```sh
npm run restart
```

This builds the frontend into `dist/`, restarts whichever LaunchAgent runs this folder's `server.js` (a developer
agent, or `com.brain.app` for an installed copy in `~/.brain/app`), then checks the running app: it must run from this
folder, serve the build just made, and read the same map schema as `src/map-schema.js`. Any mismatch fails with a ✗
message and a non-zero exit; "Restarted and verified" is the only success. `npm run check-build` runs the same check
without rebuilding.

How the parts stay in step:
- **Mapper and server:** the server spawns `src/mapper.js` from its own folder, and both import the version from
  `src/map-schema.js`. Bump it there when the map format changes; older maps are re-made automatically.
- **Server and browser bundle:** every build writes `dist/build-info.json` with a build id and its schema, and bakes
  the same id into the bundle. At startup the server refuses a build whose schema differs: it rebuilds when Vite is
  installed, otherwise it serves a "needs to be rebuilt" page instead of the app.
- **An open page and the server:** `/api/version` reports the server's build id. An open page compares it with its
  own at start, when the window comes back into view, and before opening a map, and reloads itself when they differ.
  `index.html` is served with `no-cache`.

## Releases

```sh
scripts/release.sh v0.2.0 --notes-file notes.md --dry-run   # print the plan, change nothing
scripts/release.sh v0.2.0 --notes-file notes.md             # build release/brain-app-v0.2.0.tar.gz, update get.sh
```

The package is built from a clean export of the pushed commit (`npm ci`, `npm run build`, the build check, then the
package started on a spare port with an empty home folder and checked live). The script publishes nothing: it prints
the `gh release create` command, with `--target` set to the commit and your notes file, and the order to follow
(publish, verify the checksum, then push `get.sh`). It refuses uncommitted changes, untracked files, a commit not on
`origin/main`, and a version that is not newer than the one `get.sh` points at.

To test the installer without touching your own setup, run it with `HOME` set to an empty folder and a minimal `PATH`.
`BRAIN_LOGIN_SHELL` makes the installer and the app ask a different login shell whether `brainmap` and `claude` are
on the PATH, so a test shell can stand in for a Mac without Homebrew or Claude Code. Put a stand-in `launchctl`
first on that `PATH` (and keep `claude` off it): the real one loads the test home's LaunchAgents into your own login
session. A stand-in that starts `server.js` with the plist's `BRAIN_PORT` and `BRAIN_DIR` lets the installer's live
check run; give the started server its own stdin, stdout and stderr, or the installer's output pipe stays open.

The brain folder comes from `src/brain-dir.js`: `BRAIN_DIR` in the environment (the LaunchAgent sets it), else
`BRAIN_DIR` in `~/.brain/config`, else `~/Brain`. `scripts/autocommit.sh` writes every run's outcome to
`~/.brain/autocommit.log` and the latest one to `~/.brain/autocommit-status` (outcome, time, start of the current
failures, git's message); `/api/gitlog` returns a failure as `backupProblem` and the page shows it as a red banner.

## Code maps

A project's panel can link one or more code folders (stored in `~/.brain/code-folders.json` as
`slug → [{ name, path }]`, never in `~/Brain`; the older `slug → "/path"` format is still read and is upgraded in
place on the next write) and **Map project**: the server runs `node src/mapper.js --folder <name>=<folder> … <slug>`
(spawned with an argument list, 60 second limit) and writes `~/.brain/maps/<slug>/map.json` (format version in
`src/map-schema.js`). The mapper also runs on its own: `node src/mapper.js <project folder> <output name>`, or
`node src/mapper.js --folder app=~/Projects/shop-app --folder web=~/Projects/shop-web <output name>` for several folders.

**Data layer.** Literal document IDs in Firestore paths (generated-looking values, UUIDs, email addresses, long
numbers) are replaced by `{id}` before anything is stored, so they never appear in the map, the diagram or brainmap;
short fixed document names such as `settings/general` are kept. Firestore use is read in every root (app, functions/,
scripts/): one node per top-level collection (counting everything under it) and one per subcollection path pattern,
such as `users/{uid}/orders`; each read or write records the named function it is in. Both styles are read: modular
(`doc(db, 'users', uid)`, `doc(db, \`users/${uid}/orders/${id}\`)`, also when destructured from
`require('firebase/firestore')`) and firebase-admin (`db.doc(\`orders/${orderId}\`)`,
`getFirestore().collection('users/' + uid + '/orders')`, `.doc()` / `.collection()` chained on a reference built
earlier, and `batch.set` / `t.get` / `t.update` on those references). A path may be a template, a concatenation, a
`const` holding one, or a `for … of` over a literal list of them (resolved paths are tagged inferred). A reference
returned by a helper in the same file (`ordersRef(uid)`) is recorded where the helper is called.

**Calls.** Calls from one file to a function exported by another are `calls` edges (renamed, namespace and default
imports, `require`, re-exports through index files). An imported function handed to another file's function, as an
argument or inside an object literal (`backfill(uid, { getOrders })`), is followed one hop to where that function
calls it, and recorded as a call marked via value, with both lines. Calls the mapper cannot follow with certainty are
listed as unresolved, kind `call`. Calls to a function defined in the same file (exported or not) are recorded too,
marked same file, so chains through local helpers stay connected: `callers`, `collection` ("Through functions",
`--depth`), `impact file:function`, `path`, `query` and `report` follow them, and a same-file hop does not use up a
level of `--depth`.

**Languages.** JavaScript and TypeScript (.js .jsx .mjs .cjs .ts .tsx), parsed with Babel, and Python (.py; see
**Python** below). Imports resolve to the JS
and TS extensions and index files (`./x.js` may mean `x.ts`), and through the nearest tsconfig.json or jsconfig.json
(with its `extends` chain) for `paths` aliases and `baseUrl`. `.d.ts` files are used only to resolve imports.
Type-only imports and exports are `type-import` links: hidden in the diagram by default, left out of calls, and
followed by `brainmap impact --types`. Vendored code is never mapped: folders named vendor, vendors or third_party,
`.min.js`, `.bundle.js` and `.global.js` files, and files over 20,000 lines that no project file imports; the map
lists each skipped file with the reason.

**Python.** `.py` files are parsed by `src/mapper-python.js` with the tree-sitter Python grammar compiled to
WebAssembly (`src/grammars/tree-sitter-python.wasm`, tree-sitter-python 0.25.0, MIT; run by the `web-tree-sitter`
package). Nothing is compiled at install and no Python is run, so a Mac without Python maps the same as one with it,
and the result does not depend on an installed Python version. If the grammar cannot load, the Python files are
listed as skipped with that reason and the rest is mapped (a folder with only Python files gets a clear error).
Imports resolve from the folder root (and `src/` in a src layout), then from the importing file's own folder, as for a
script run directly (marked inferred); relative imports, aliases, `from x import *` and packages are followed, and the
`__init__.py` files Python runs first are inferred links. Anything else is a package. Calls follow the JavaScript
rules (imported and same-file functions, with the enclosing function) and add instantiations (`Order()`, function
`Order`) and method calls (function `Class.method`) only where the class is certain: `self.m()` and `cls.m()` (not
when a project subclass overrides `m`), `super().m()`, `Class.m()`, `Class().m()` and a variable assigned once from
`Class(...)`. A receiver known only from a type annotation, a variable assigned more than once, a method that may come
from a package base class, and an attribute set on the instance go to unresolved (kind `call`) with the reason. Each
file lists its classes with bases and methods; a class's file has an `inherits` link to each project base class's
file. Entry files: `if __name__ == "__main__"`, `__main__.py`, console scripts in pyproject.toml, setup.py or
setup.cfg, and a file that creates a Flask or FastAPI app. Flask and FastAPI routes (`@app.route`, `@app.get`,
`@bp.post`, `@router.put`, `add_url_rule`, with Blueprint, APIRouter, `register_blueprint` and `include_router`
prefixes) are routes named by their path, with their `handler` function and `methods`. Notes are the same tags in `#`
comments. There is no data layer for Python yet. `__pycache__`, virtual environments and tool caches are skipped.

**Navigation.** React Navigation screens and web routes. React Router routes are read from `<Route path element>`
trees (nested, index and layout routes; the page is the deepest component in the element, including
`lazy(() => import(...))` pages) and from route objects passed to `createBrowserRouter`, `createHashRouter`,
`createMemoryRouter` or `useRoutes`. In a folder whose package.json depends on `next`, `app/**/page.*` and `pages/**`
(not `_app`, `_document`, `api/`) become routes (`[id]` → `:id`, `(group)` folders left out). Each route is a screen
named by its path pattern, such as `/orders/:orderId`, tied to its page file; a route whose element is
`<Navigate to>` is a redirect. Web navigation edges come from `navigate('/x')`, `<Link to>`, `<NavLink to>`,
`<Navigate to>`, Next.js `<Link href>`, `router.push` / `replace`, `history.push`, `redirect()` and
`window.location` assignments with a path. Paths are matched to routes segment by segment: a template path that fills
a parameter (`/orders/${id}` → `/orders/:orderId`), a path read from a constant or a list, and a path that lands on a
redirect route are tagged inferred. Targets the map cannot know, or no route matches, are unresolved (kind
`navigate`) with a reason. Back navigation and links to other sites are ignored.

**Entry files.** Each root (app, functions/, scripts/) of each code folder can have several entry files, looked for
in every folder of the root that has a package.json: the package's `main` and `module`, files its scripts run, scripts
its HTML pages load (including inline `<script type="module">` blocks), `src/main.*` and `src/index.*`, Expo and
React Native `App.*` and `index.*`, Next.js pages and layouts, and the functions entry. scripts/ only gets an entry
its package.json names. "Not imported" is a file no entry of its own root reaches; "standalone scripts" are the files
of a root with no entry file at all.

**Diagram.** **View map** replaces the brain with a force-directed diagram: a Folders view by default (one bubble per
top-level folder, Show files expands a folder in place) and a Files view. Calls are drawn per file pair; same-file
calls are listed in the file's card. Linked folders are only read (except for the assistants block below); git is
called with `--no-optional-locks` and nothing is ever committed in them.

### Several code folders in one project

A project can link several folders, for example an app and a website that share one Firestore database
(`app` = `~/Projects/shop-app`, `web` = `~/Projects/shop-web`). Each linked folder has a short name (letters, digits,
dash, underscore; default the folder's own name; `collection` and `subcollection` are not allowed). The panel's link
section is a list: **+ Add folder** (path and optional short name), **Remove** per folder, and each folder's own
"Map is current" / "Code changed since last map (N files)" / "Not in the map yet" status.

All linked folders go into one `map.json`. Each folder is mapped on its own, so imports, calls, navigation and routes
stay inside one folder; then the maps are merged. With more than one folder every file id and path starts with the
folder's short name (`web:src/lib/orders.js`), `relPath` is the path inside the folder, and every node and edge has
`codeFolder`; the map lists the folders in `folders` (path, commit, counts each). The data layer is the join: a
collection or subcollection with the same path pattern is one node, with reads and writes from every folder,
`byFolder` counts, and `shared: true` when more than one folder touches it (a shared subcollection shows the first
linked folder's placeholder names; links from a folder that names them differently are tagged inferred,
"placeholders merged by position"). A cloud function called in one folder and defined in another
(`httpsCallable(…, 'createOrder')` in web, `exports.createOrder` in the app's functions/) is a `calls-function` edge
with `crossFolder: true`, tagged inferred. Groups are detected per folder (and per root inside it), never across
folders. A project with one folder gets a map without prefixes.

`brainmap` and the tool server find the project from any linked folder, so an assistant working in shop-web gets the
same merged map. Every command takes `--folder <name>` (the tools a `folder` argument) to limit the output to one
folder. Without it, readers, writers and callers are grouped by folder with the folder's name before the path,
`collection` says which folders touch it, and `path` can cross folders through shared data or a cross-folder cloud
function, and marks that hop. `report`, `groups`, `query` and `unused` are computed per folder; `report` ends with an
"Across folders" section. The automatic refresh re-maps the project when any linked folder changed (or a folder was
added or removed). **Enable for assistants** and **strict mode** apply to every linked folder, each previewed and
removed on its own. In the diagram's Files view, "Color by: Code folder" groups by linked folder.

### brainmap

`brainmap` answers structure questions from the saved map, in compact plain text (each list shows its first items
with "(+N more, use --all)"): `overview`, `files <folder>`, `file <path>`, `impact <path>`, `screen <name>`,
`collection <name>`, `function <name>`, `callers <name|file:name>`, `find <text>`, `unused`, `path <A> <B>`,
`report`, `query "<question>"`, `groups`, `group <label|number>` and `notes <file|function|--all>`. Run it inside a
linked folder, or pass `--project <name>`. Before answering it runs the same "code changed since last map" check as
the panel and re-maps when needed. It prints paths, names and numbers only, never file contents. The installer writes
it as `~/.brain/brainmap.sh` (with the Node and app paths filled in) and links it into `~/.local/bin`, adding that
folder to the PATH in the login shell's profile when a new shell would not find it.

- Every link is tagged extracted (written out in the code) or inferred (a function passed as a value, a screen name
  inferred from a variable, data reached through a helper-built reference or a resolved value, subcollection
  placeholders merged by position); output marks inferred links and the diagram draws them lighter.
- `groups`: subsystems found by community detection on the file graph (Louvain with a Leiden-style refinement; fixed
  seed, so the same code gives the same groups), per root, each named from its most distinctive words with its 3 most
  central files.
- `query`: plain words, no AI. It drops common words, splits camelCase, snake_case and paths, scores files, functions,
  screens and collections by the words in their names, and prints the links around up to 5 clear matches.
- `path`: the shortest chain of links between two files, functions, screens or collections, hop by hop with file and
  line (`--all-shortest` lists up to 5). `screen` and `path` also take a route path (`/orders/:orderId`) or a concrete
  path (`/orders/123`, matched to its route).
- `notes`: comments that start with NOTE, WHY, HACK, FIXME, TODO, IMPORTANT or WARNING, and comments citing an ADR or
  RFC, attached to their function.
- `report`: most-connected files, most-called functions, busiest data, bridge files, rare links between folders and
  five ready-to-run follow-up commands.

### Tool server for Claude Code

`src/brainmap-mcp.js` is a local stdio tool server with the same queries as tools, each with an `all` option. Each
tool runs `brainmap` in the assistant's working folder, so the text, limits and automatic refresh are the same; in a
folder that is not linked it answers in one line. Read-only. The installer registers it at user scope when Claude
Code is installed:

```sh
claude mcp add --scope user brainmap -- "$(command -v node)" <brain-app folder>/src/brainmap-mcp.js   # install
claude mcp remove --scope user brainmap                                                                # uninstall
bash install.sh --remove-assistant-tools                                                               # same, via the installer
```

Context cost, measured in Claude Code in November 2026: a fresh session gains about 100 tokens (57 for the server
instructions plus the tool names); the full tool definitions (about 900 tokens) load only when the assistant looks
them up.

### Strict mode (Claude Code only)

Panel, per project, opt in. Adds a Claude Code PreToolUse hook (`src/brainmap-hook.js`) to each linked folder's
`.claude/settings.local.json`. In each session it blocks the first Grep, Glob or Read of source code once, with a
message to use the map tools, then allows everything. It never blocks CLAUDE.md, AGENTS.md, other Markdown, JSON or
configuration files, does nothing in a folder without a map, and lets everything through on any error. Session
markers live in `~/.brain/strict-sessions`. It is refused when git would track the file; the change is previewed,
refused if the file changed after the preview, and Remove restores the file byte for byte (original kept in
`~/.brain/strict-backups`) unless it was edited since. The panel hides it when Claude Code is not installed (it keeps
showing Remove if it is already on).

### Enable for assistants

Adds a short marked block, between `<!-- brainmap:start … -->` and `<!-- brainmap:end -->`, telling coding assistants
to use the map before searching the repository. What it writes depends on what is installed, as seen by the person's
login shell (`src/assistant-env.js`):

- **Claude Code installed:** the block names the `mcp__brainmap__*` tools and the `brainmap` command, and goes into
  every one of CLAUDE.md and AGENTS.md that exists; when neither exists, both are created.
- **Claude Code not installed** (Codex and others): only AGENTS.md is written, CLAUDE.md is never created, and the
  block leads with `brainmap overview` and the matching commands, using the full path to brainmap when it is not on
  the PATH.

The preview shows, per file, the exact text. An existing block (older wording included) is updated in place, never
duplicated. Each file's marker records `created-file=yes|no`; **Remove** takes the block out of every file that has
it and deletes a file only when the app created it and nothing else is in it. Both actions are refused if a file
changed after the preview. Nothing is committed in the project.
