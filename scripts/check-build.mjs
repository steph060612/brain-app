#!/usr/bin/env node
// Fails loudly when the Brain app's parts disagree on the map schema.
//   node scripts/check-build.mjs            dist/ matches src/map-schema.js (run after every build)
//   node scripts/check-build.mjs --live     also the running server: it serves this copy, this build, and this schema,
//                                           and the bundle its index.html loads carries the same build id
//   --quiet                                 no output on success (used by the installer)
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SCHEMA_VERSION } from '../src/map-schema.js';
import { buildProblem, readBuildInfo } from '../src/build-check.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const live = process.argv.includes('--live'), quiet = process.argv.includes('--quiet');
const fail = (m) => { console.error(`\n✗ BUILD CHECK FAILED: ${m}\n`); process.exit(1); };
const ok = (m) => { if (!quiet) console.log(`✓ ${m}`); };

const problem = buildProblem(APP);
if (problem) fail(problem);
const info = readBuildInfo(APP);
ok(`dist build ${info.id} reads map schema ${info.schemaVersion}, same as src/map-schema.js`);

if (live) {
  // The port this copy listens on: BRAIN_PORT from ~/.brain/config (installed copies), else 5180.
  let port = Number(process.env.BRAIN_PORT) || 5180;
  try { const m = readFileSync(join(process.env.HOME, '.brain', 'config'), 'utf8').match(/BRAIN_PORT="?(\d+)/); if (m && !process.env.BRAIN_PORT && APP.startsWith(join(process.env.HOME, '.brain'))) port = Number(m[1]); } catch {}
  const base = `http://localhost:${port}`;
  let v;
  try { v = await (await fetch(`${base}/api/version`, { cache: 'no-store' })).json(); }
  catch (e) { fail(`no Brain app answers at ${base}/api/version (${e.message}). Is it running, and is it a build with /api/version?`); }
  if (v.stale) fail(`the running app reports a stale build: ${v.stale}`);
  if (v.appDir !== APP) fail(`the app at ${base} runs from ${v.appDir}, not from this copy (${APP}). Rebuild and restart that copy, or point its LaunchAgent here.`);
  if (v.schemaVersion !== SCHEMA_VERSION) fail(`the running server reads schema ${v.schemaVersion}, this code says ${SCHEMA_VERSION}: it was not restarted after the change.`);
  if (v.buildId !== info.id) fail(`the running server serves build ${v.buildId}, dist/ holds ${info.id}: it was not restarted after the build.`);
  const html = await (await fetch(base, { cache: 'no-store' })).text();
  const js = [...html.matchAll(/src="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  if (!js.length) fail(`${base}/ does not load a bundle from /assets/.`);
  for (const p of js) {
    const file = join(APP, 'dist', p);
    if (!existsSync(file)) fail(`index.html loads ${p}, which is not in dist/.`);
    if (!readFileSync(file, 'utf8').includes(info.id)) fail(`${p} does not carry build id ${info.id}.`);
  }
  ok(`${base} serves this copy, build ${v.buildId}, map schema ${v.schemaVersion}; its bundle carries the same build id`);
}
