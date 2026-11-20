// What the person's coding assistants will find on this Mac: is Claude Code installed, and does `brainmap` run by
// name? Asked of the person's login shell (the shell an assistant runs commands in, with the PATH their profile
// sets), because the server itself runs under launchd with a minimal PATH. Cached for a minute.
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir, userInfo } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HOME = homedir();
// Where Claude Code is installed when a login shell does not list it (native installer, npm global, Homebrew).
// BRAIN_CLAUDE_SPOTS (colon-separated) replaces the list; the Connect Claude Code test uses it to stand in for a Mac
// without Claude Code.
const CLAUDE_SPOTS = process.env.BRAIN_CLAUDE_SPOTS !== undefined ? process.env.BRAIN_CLAUDE_SPOTS.split(':').filter(Boolean)
  : [join(HOME, '.local/bin/claude'), join(HOME, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
// The brainmap command written by install.sh, else this copy's script run with this Node.
const BRAINMAP_SH = join(HOME, '.brain', 'brainmap.sh');
const BRAINMAP_JS = join(dirname(fileURLToPath(import.meta.url)), 'brainmap.js');

let cached = null, cachedAt = 0;

function loginShellLookup() {
  // BRAIN_LOGIN_SHELL: a different login shell to ask (used by the installer test, which isolates a test home).
  let shell = process.env.BRAIN_LOGIN_SHELL || '/bin/zsh';
  if (!process.env.BRAIN_LOGIN_SHELL) { try { shell = userInfo().shell || process.env.SHELL || shell; } catch {} }
  return new Promise(res => {
    execFile(shell, ['-lc', 'command -v claude || true; echo "<>"; command -v brainmap || true'],
      { timeout: 8000, env: { HOME, USER: process.env.USER || '', LANG: 'en_US.UTF-8' } },
      (err, stdout) => {
        if (err && !stdout) return res(null);
        const [c = '', b = ''] = String(stdout).split('<>');
        res({ claude: c.trim().split('\n').pop() || '', brainmap: b.trim().split('\n').pop() || '' });
      });
  });
}

export { CLAUDE_SPOTS };

// { claude: boolean, claudePath: the claude command to run ('' when not found), shell: the login shell asked,
//   brainmapOnPath: boolean, brainmapCommand: 'brainmap' or an absolute path }
export async function assistantEnv({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < 60_000) return cached;
  const found = await loginShellLookup();
  // The login shell's answer is what an assistant sees; the fixed spots are only a fallback when it cannot be asked.
  const spot = CLAUDE_SPOTS.find(p => existsSync(p)) || '';
  const claude = found ? !!found.claude : !!spot;
  // The command to run: the login shell's path; else a fixed spot (an alias or function is listed by name only, and
  // the native installer's ~/.local/bin is often not on the PATH). claude stays the login shell's answer.
  const claudePath = found?.claude?.startsWith('/') ? found.claude : spot;
  const brainmapOnPath = !!found?.brainmap;
  const full = existsSync(BRAINMAP_SH) ? BRAINMAP_SH : `"${process.execPath}" "${BRAINMAP_JS}"`;
  let shell = process.env.BRAIN_LOGIN_SHELL || '';
  if (!shell) { try { shell = userInfo().shell || process.env.SHELL || '/bin/zsh'; } catch { shell = '/bin/zsh'; } }
  cached = { claude, claudePath, shell, brainmapOnPath, brainmapCommand: brainmapOnPath ? 'brainmap' : full };
  cachedAt = Date.now();
  return cached;
}
