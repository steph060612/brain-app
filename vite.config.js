import { defineConfig } from 'vite';
import { writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { SCHEMA_VERSION } from './src/map-schema.js';

// Every build gets an id. It is baked into the bundle (__BRAIN_BUILD__) and written to dist/build-info.json, which the
// server reads at startup and reports at /api/version. An open page compares the two and reloads itself when the
// server runs a newer build, so a long-lived tab can never keep reading maps with an old schema.
// BRAIN_COMMIT: set by scripts/release.sh, which builds in an export of the commit that has no .git folder.
let commit = process.env.BRAIN_COMMIT || 'nogit';
if (!process.env.BRAIN_COMMIT) {
  try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
}
const BUILD = { id: `${SCHEMA_VERSION}-${commit}-${Date.now().toString(36)}`, schemaVersion: SCHEMA_VERSION, commit, builtAt: new Date().toISOString() };

export default defineConfig({
  define: { __BRAIN_BUILD__: JSON.stringify(BUILD) },
  plugins: [{
    name: 'brain-build-info',
    apply: 'build',
    closeBundle() {
      mkdirSync('dist', { recursive: true });
      writeFileSync('dist/build-info.json', JSON.stringify(BUILD, null, 2) + '\n');
    },
  }],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false },
    },
  },
});
