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
force-directed diagram of that map. Linked folders are only read; git is called with `--no-optional-locks`.
Only JavaScript projects are supported.

The mapper also runs on its own: `node src/mapper.js <project folder> <output name>`.
