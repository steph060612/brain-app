// Basic Memory (an optional MCP server some people point at their brain) indexes the brain's notes. Its file
// watcher sees edits to files, but a whole folder moved in one rename (archiving or unarchiving a project) reaches
// it as a single folder event, which it does not index: its entries keep the old paths until its next full scan
// (when a Basic Memory server starts, or `basic-memory project index <name>`). That scan recognises the files as
// moved, by checksum, so nothing is duplicated. After a move the app runs that scan for the Basic Memory project
// whose folder is this brain, in the background. Nothing here runs when Basic Memory is not installed or not set up
// for this brain.
import { readFile, realpath } from 'fs/promises';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

const HOME = homedir();
// Where `uv tool install` and Homebrew put the command; the app runs under launchd with a minimal PATH.
const CLI_SPOTS = [join(HOME, '.local/bin/basic-memory'), '/opt/homebrew/bin/basic-memory', '/usr/local/bin/basic-memory'];

// Basic Memory's own settings folder: BASIC_MEMORY_CONFIG_DIR, else ~/.basic-memory, else $XDG_CONFIG_HOME/basic-memory.
function configFile() {
  if (process.env.BASIC_MEMORY_CONFIG_DIR) return join(process.env.BASIC_MEMORY_CONFIG_DIR, 'config.json');
  const home = join(HOME, '.basic-memory', 'config.json');
  if (existsSync(home) || !process.env.XDG_CONFIG_HOME) return home;
  return join(process.env.XDG_CONFIG_HOME, 'basic-memory', 'config.json');
}

const real = async p => { try { return await realpath(p); } catch { return p; } };

// The Basic Memory project whose folder is the brain: its name, or null (not installed, or not set up for it).
export async function basicMemoryProject(brainDir) {
  let cfg;
  try { cfg = JSON.parse(await readFile(configFile(), 'utf8')); } catch { return null; }
  const brain = await real(brainDir);
  for (const [name, p] of Object.entries(cfg?.projects || {})) {
    const path = typeof p === 'string' ? p : p?.path;
    if (path && (await real(path.replace(/^~(?=$|\/)/, HOME))) === brain) return name;
  }
  return null;
}

// After a project folder moved: { state, project, command }. state is 'none' (Basic Memory is not set up for this
// brain: nothing to do), 'reindexing' (its scan was started), or 'manual' (set up, but its command was not found:
// `command` is what to run).
export async function refreshAfterMove(brainDir, log = console) {
  const project = await basicMemoryProject(brainDir);
  if (!project) return { state: 'none' };
  const command = `basic-memory project index ${project}`;
  const cli = CLI_SPOTS.find(p => existsSync(p));
  if (!cli) return { state: 'manual', project, command };
  execFile(cli, ['project', 'index', project], { timeout: 10 * 60_000, env: process.env }, (err, stdout, stderr) => {
    if (err) log.error(`Basic Memory re-index of "${project}" failed: ${(stderr || err.message).trim().split('\n').pop()}`);
    else log.log(`Basic Memory re-indexed "${project}" after a project folder moved.`);
  });
  return { state: 'reindexing', project, command };
}
