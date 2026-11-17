// Where the brain lives. The installer lets the person choose the folder (install.sh --brain PATH) and saves it as
// BRAIN_DIR in ~/.brain/config; the LaunchAgent also passes it to the app as BRAIN_DIR. Order: the environment, then
// ~/.brain/config, then ~/Brain. Shared by the server, the code map routes and the mapper.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, isAbsolute, sep } from 'path';

export function brainDir(env = process.env, home = homedir()) {
  let p = env.BRAIN_DIR;
  if (!p) {
    try {
      const m = readFileSync(join(home, '.brain', 'config'), 'utf8').match(/^BRAIN_DIR="?([^"\n]*)"?[ \t]*$/m);
      if (m) p = m[1];
    } catch {}
  }
  p = (p || '').trim().replace(/^~(?=$|\/)/, home);
  return p && isAbsolute(p) ? resolve(p) : join(home, 'Brain');
}

export const BRAIN = brainDir();
// The brain folder as shown in messages: ~/Brain, ~/Notes/brain, or the full path outside the home folder.
const HOME = homedir();
export const BRAIN_LABEL = BRAIN === HOME || BRAIN.startsWith(HOME + sep) ? '~' + BRAIN.slice(HOME.length) : BRAIN;
