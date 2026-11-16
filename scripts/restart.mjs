#!/usr/bin/env node
// Build, restart and verify the Brain app that runs from THIS copy, in one step: `npm run restart`.
// Finds the LaunchAgent whose server.js is this folder's (the developer agent com.steph.brain-app, or an installed
// com.brain.app), restarts it, waits for it, then runs the live build check. Exits non-zero, loudly, on any mismatch,
// so a task cannot report the app as updated while it still serves an old build.
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = join(process.env.HOME, 'Library', 'LaunchAgents');
const fail = (m) => { console.error(`\n✗ RESTART FAILED: ${m}\n`); process.exit(1); };
const run = (cmd, args) => execFileSync(cmd, args, { cwd: APP, stdio: 'inherit' });

console.log('==> Building');
run('npm', ['run', 'build']); // includes the dist check

const serverJs = join(APP, 'server.js');
const agents = [];
for (const f of readdirSync(AGENTS).filter((x) => x.endsWith('.plist'))) {
  let text = '';
  try { text = execFileSync('plutil', ['-convert', 'xml1', '-o', '-', join(AGENTS, f)]).toString(); } catch { continue; }
  if (text.includes(`<string>${serverJs}</string>`)) agents.push(f.replace(/\.plist$/, ''));
}
if (!agents.length) {
  const others = readdirSync(AGENTS).filter((x) => /brain/.test(x) && x.endsWith('.plist'));
  fail(`no LaunchAgent runs ${serverJs}. Brain agents present: ${others.join(', ') || 'none'}. The running app is a different copy; rebuild that one.`);
}

const uid = execFileSync('id', ['-u']).toString().trim();
for (const label of agents) {
  console.log(`==> Restarting ${label}`);
  run('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]);
}

console.log('==> Waiting for the app');
let up = false;
for (let i = 0; i < 30 && !up; i++) {
  try { await fetch('http://localhost:' + (process.env.BRAIN_PORT || 5180) + '/api/version'); up = true; }
  catch { await new Promise((r) => setTimeout(r, 1000)); }
}
if (!up) fail('the app did not answer within 30 s. See ~/.brain/brain-app.log.');

console.log('==> Checking the running app');
run(process.execPath, [join(APP, 'scripts', 'check-build.mjs'), '--live']);
console.log('\nRestarted and verified. Open pages reload themselves on their next focus or map open.');
