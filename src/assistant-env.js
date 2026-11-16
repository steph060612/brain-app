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
const CLAUDE_SPOTS = [join(HOME, '.local/bin/claude'), join(HOME, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
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

// { claude: boolean, brainmapOnPath: boolean, brainmapCommand: 'brainmap' or an absolute path }
export async function assistantEnv({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < 60_000) return cached;
  const found = await loginShellLookup();
  // The login shell's answer is what an assistant sees; the fixed spots are only a fallback when it cannot be asked.
  const claude = found ? !!found.claude : CLAUDE_SPOTS.some(p => existsSync(p));
  const brainmapOnPath = !!found?.brainmap;
  const full = existsSync(BRAINMAP_SH) ? BRAINMAP_SH : `"${process.execPath}" "${BRAINMAP_JS}"`;
  cached = { claude, brainmapOnPath, brainmapCommand: brainmapOnPath ? 'brainmap' : full };
  cachedAt = Date.now();
  return cached;
}
