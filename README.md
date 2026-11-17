# Brain

A portable memory for your AI assistants, on your Mac. Your notes live as plain Markdown files in a folder on your Mac (`~/Brain` unless you choose another); a small
local app shows them as a 3D brain, copies context packs into any chat, and lets you approve every change an assistant
proposes before it is written. Nothing leaves your Mac unless you paste it somewhere yourself.

macOS only. Works with ChatGPT, Claude, Gemini or any assistant you can paste text into.

## Install or update

In Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/steph060612/brain-app/main/get.sh | bash
```

The same line installs the first time and updates later. An update replaces the app only: your brain, your settings
(`~/.brain/config`), imports and packs are not touched. Step by step, including the first session:
[FRIEND-SETUP.md](FRIEND-SETUP.md).

The installer uses the Node already on your Mac if it is recent enough (22.18 or newer, or 24.11 or newer) and
otherwise downloads its own copy into `~/.brain/node`, leaving yours alone. It needs no Homebrew and no password, and
it says what it did at each step.

### Choosing where your brain lives

Your brain goes in `~/Brain` unless you add `--brain` and a folder:

```sh
curl -fsSL https://raw.githubusercontent.com/steph060612/brain-app/main/get.sh | bash -s -- --brain ~/Notes/brain
```

- A new folder gets an empty brain.
- A folder that already holds your notes is used as it is: nothing in it is changed, and its git history is kept.
- Not allowed: Desktop, Documents, Downloads, iCloud Drive and cloud storage folders (Dropbox, Google Drive,
  OneDrive). macOS does not let background jobs open files there, so the app and the automatic saves could not reach
  your brain. The installer stops and says so.
- If `~/Brain` already exists (or `~/brain`: the Mac usually treats them as the same folder), the installer stops and
  changes nothing. Run it again with `--brain` and the folder you want.

The folder is saved in `~/.brain/config`; updates find it there.

## Using it

Open **http://localhost:5180** (the installer prints the address; a second user account on the same Mac gets the next
free port). Keep it in the Dock from Safari with File > Add to Dock.

- **Copy setup interview** (shown while your brain is empty): paste into a new chat; the assistant interviews you and
  gives back one block to paste into **Inbox > Paste proposals**.
- **Copy full pack / Copy project only / Copy general pack**: your context for a new chat, with the rules the
  assistant should follow.
- **Copy close-session prompt**: at the end of a chat, ask the assistant for proposed changes; paste its answer into
  **Inbox > Paste proposals** and approve or discard each one. Nothing is written without your approval.
- **Import** and **Distill**: turn exported chats (Claude, ChatGPT, Gemini) into suggestions, using an assistant
  installed on your Mac (Claude Code, Codex or Gemini's command-line tool) when one is available.
- **List**: every brain item as a list instead of the 3D view. Click any item to read it or edit the Markdown.

Your brain is saved locally with git every 15 minutes when Apple's developer tools are installed. It is not backed up
anywhere else unless you add a private remote yourself. If a save fails, a red banner at the top of the app says why
and stays until a save works again.

## Code map (for JavaScript and TypeScript projects)

A project in your brain can be linked to one or more code folders. **Map project** reads the code (no AI, nothing
leaves your Mac) and builds a map of files, imports, function calls, screens and routes, Firestore collections and
cloud functions. **View map** shows it as a diagram; the panel lists entry files and findings such as files nothing
imports.

The `brainmap` command answers structure questions from that map, inside a linked folder:

```sh
brainmap overview                      # summary: entry files, folders, screens, collections
brainmap query "what saves a new order"
brainmap callers createOrder
brainmap collection users/{uid}/orders
brainmap screen /orders/:orderId
brainmap path screens/HomeScreen.js orders
brainmap help                          # every command
```

**Enable for assistants** adds a short marked block to the code folder's `AGENTS.md` (and `CLAUDE.md` when Claude
Code is installed) telling coding assistants to use `brainmap` before searching the code. You see the exact text
first; **Remove** takes it out again; nothing is committed. Two extras are Claude Code only and are offered only when
it is installed: **strict mode** (a hook that sends the first code search of a session to the map) and the **brainmap
tool server** (the same queries as Claude Code tools).

## Where things are

| | |
|---|---|
| Your notes | `~/Brain`, or the folder you chose (`BRAIN_DIR` in `~/.brain/config`) |
| Settings | `~/.brain/config` |
| The app | `~/.brain/app` (started at login by `~/Library/LaunchAgents/com.brain.app.plist`) |
| Packs, imports, code maps | `~/.brain/packs`, `~/.brain/imports`, `~/.brain/maps` |
| Commands | `brainmap`, `brainpack` in `~/.local/bin` |
| App log | `~/.brain/brain-app.log` |
| Backup log | `~/.brain/autocommit.log` |

## If something breaks

- Restart the app: `launchctl kickstart -k gui/$(id -u)/com.brain.app`
- Read the log: `tail -50 ~/.brain/brain-app.log`
- A red banner about saving: it quotes the error. Every save's result is in `~/.brain/autocommit.log`.
- A page that says the app needs to be rebuilt: run the install line again.

Working on the app itself: [DEVELOPING.md](DEVELOPING.md).
