# Brain: setup for a new user

The Brain is a folder of plain notes on your Mac (`~/Brain`) that any AI assistant can work from, plus a small app at http://localhost:5180 to read it, copy context packs and approve changes. Nothing leaves your Mac unless you paste it into a chat yourself.

## What you need
- A Mac.
- Node.js 20 or newer (`brew install node`) and git (`xcode-select --install`).
- An assistant plan. This guide assumes ChatGPT.

## Install (about 10 minutes)
1. Put the `brain-app` folder at `~/Projects/brain-app`.
2. In Terminal:
   ```sh
   cd ~/Projects/brain-app
   bash scripts/install.sh "YourFirstName"
   ```
3. Open http://localhost:5180 in Safari, then File > Add to Dock.

The installer creates an empty brain, starts the app at every login, and saves a local copy of the brain every 15 minutes. It never overwrites an existing `~/Brain`.

## First session: fill your brain
1. In the app, click **Copy setup interview** (top bar; it shows only while you have no projects).
2. Paste it into a new ChatGPT chat. It asks you about 15 short questions: who you are, how you want it to work with you, your projects.
3. At the end it gives you one code block. Copy it, open **Inbox > Paste proposals** in the app, paste, and approve what is right. Discard anything you did not say.

Add more later the same way: any chat ends with a close session.

## Daily use with ChatGPT
1. **Start a chat.** In the app, click **Copy general pack** (no project yet) or open a project and click **Copy full pack**. Paste it as the first message.
2. **Work normally.**
3. **End the chat.** Click **Copy close-session prompt**, paste it into ChatGPT, copy its answer.
4. **Save.** In the app, open **Inbox > Paste proposals**, paste, then approve or discard each change. Nothing is written until you approve.

Use **Copy project only** when the chat already has your pack and you only need a project's latest files.

## Rules
- Only facts you stated or confirmed go in. The assistant proposes, you approve.
- Never store passwords, card or account numbers, ID numbers or balances.
- Your brain is yours: it is not shared with anyone and has no online backup unless you add a private GitHub repository yourself.

## Optional, to check on install day
- **Codex** (included with ChatGPT plans) can let the app turn pasted free text or exported chats into suggestions (Distill). The app offers Codex only if `codex` is installed, signed in, and passes a one-time test when the app starts.
- **Direct reading**: Codex can connect to tools such as Basic Memory, which would let it read the brain without a pack. Not set up or tested yet.

## If something breaks
- App log: `~/.brain/brain-app.log`
- Restart the app: `launchctl kickstart -k gui/$(id -u)/com.brain.app`
- Backup log: `~/.brain/autocommit.log`
