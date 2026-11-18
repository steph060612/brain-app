#!/usr/bin/env node
// Strict mode for brainmap: a Claude Code PreToolUse hook (Grep, Glob, Read) installed per project by the
// Brain app. It blocks only the first search of source code in a session, telling the assistant to use the
// code map tools first, and allows everything after that. It never blocks twice in a session, never blocks
// reads of instruction or configuration files, does nothing in a folder without a map, and any error means
// "allow" so the assistant can never get stuck. Session state lives in ~/.brain, never in the project.
import { readFileSync, mkdirSync, openSync, closeSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';
import { projectFor, mapFile } from './codemap-status.js';

export const STATE_DIR = process.env.BRAINMAP_HOOK_STATE || join(homedir(), '.brain', 'strict-sessions');
export const MESSAGE = 'This project has a code map. Before searching the code, use the brainmap tools '
  + '(mcp__brainmap__overview first, then file, impact, callers, collection, screen or find); if they are not available, '
  + 'run `brainmap overview` in a shell. This reminder appears once per session: after it, searches run normally.';

const SOURCE = /\.(js|jsx|mjs|cjs|ts|tsx|py)$/i;
// Instruction and configuration files are never blocked: CLAUDE.md, AGENTS.md, README, *.md, *.json, .env*,
// lock files, dot-rc files and *.config.* / *rc.js files.
const PROTECTED = /(^|\/)(CLAUDE|AGENTS|README)(\.[^/]*)?$|\.(md|mdx|json|jsonc|ya?ml|toml|lock|env|txt)$|(^|\/)\.env[^/]*$|(^|\/)\.[^/]*rc(\.[^/]*)?$|\.config\.[cm]?[jt]s$|(^|\/)(babel|metro|jest|vite|webpack|eslint|prettier|tailwind|postcss|next)\.config[^/]*$/i;

const isProtected = p => PROTECTED.test(String(p || ''));

// Is this tool call a search of source code? Reads of non-source or protected files, and searches limited
// to non-source files, are not.
export function isCodeSearch(tool, input = {}) {
  if (tool === 'Read') { const p = input.file_path || ''; return SOURCE.test(p) && !isProtected(p); }
  if (tool === 'Glob') {
    const p = String(input.pattern || '');
    return !(isProtected(p) || /\.(md|json|ya?ml|txt|png|jpe?g|svg|css)\}?$/i.test(p));
  }
  if (tool === 'Grep') {
    if (input.path && isProtected(input.path)) return false;
    const g = String(input.glob || ''), t = String(input.type || '');
    if (g && (isProtected(g) || /\.(md|json|ya?ml|txt)\}?$/i.test(g))) return false;
    if (t && !/^(js|jsx|ts|tsx|javascript|typescript|py|python)$/i.test(t)) return false;
    return true;
  }
  return false;
}

// Does the folder belong to a linked project (any of its linked folders) that has a map?
async function hasMap(cwd) {
  const p = await projectFor(cwd);
  return !!p && existsSync(mapFile(p.slug));
}

// Claims "this session was reminded" atomically; true only for the first caller in a session.
function firstInSession(sessionId) {
  mkdirSync(STATE_DIR, { recursive: true });
  const f = join(STATE_DIR, `${basename(String(sessionId)).replace(/[^A-Za-z0-9._-]/g, '_')}.reminded`);
  try { closeSync(openSync(f, 'wx')); return true; } catch { return false; }
}

// Old session markers (over a week) are removed now and then.
function tidy() {
  try {
    const week = Date.now() - 7 * 864e5;
    for (const f of readdirSync(STATE_DIR)) { const p = join(STATE_DIR, f); if (statSync(p).mtimeMs < week) unlinkSync(p); }
  } catch { }
}

export async function decide(event) {
  if (!event?.session_id || !isCodeSearch(event.tool_name, event.tool_input)) return null;
  if (!(await hasMap(event.cwd || process.cwd()))) return null;
  if (!firstInSession(event.session_id)) return null;
  if (Math.random() < 0.05) tidy();
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: MESSAGE } };
}

async function main() {
  try {
    const out = await decide(JSON.parse(readFileSync(0, 'utf8') || '{}'));
    if (out) process.stdout.write(JSON.stringify(out));
  } catch { /* any problem: allow */ }
  process.exit(0);
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
