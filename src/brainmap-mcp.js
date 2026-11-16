#!/usr/bin/env node
// brainmap as a local MCP tool server (stdio, JSON-RPC 2.0, one message per line), for coding assistants.
// Each tool runs the brainmap command in the assistant's working folder and returns exactly what brainmap
// prints: same per-section limits, same "all" option, same automatic refresh when the code changed.
// Read-only: it never writes inside a project. No network, no model calls, no dependencies.
//   claude mcp add --scope user brainmap -- node <brain-app>/src/brainmap-mcp.js
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { projectFor } from './codemap-status.js';

const BRAINMAP = join(dirname(fileURLToPath(import.meta.url)), 'brainmap.js');
const TIMEOUT_MS = 90_000; // a refresh can re-map (60 s limit) before answering
const VERSION = '1.0.0';

const all = { all: { type: 'boolean', description: 'Show every item instead of the first ones per section.' },
  folder: { type: 'string', description: 'Only this linked code folder (short name), when the project links several.' } };
const str = (name, description) => ({ [name]: { type: 'string', description } });
// Short descriptions: they are what the assistant reads in its context for every session.
const TOOLS = [
  { name: 'overview', description: 'Code map summary of this project: entry files, folders, most imported files, screens, collections, cloud functions. Call once at the start of a code task.', props: {}, args: () => [] },
  { name: 'file', description: 'One file: exports, imports, importers, navigation, collections read/written, functions called.', props: str('path', 'File path (or a unique file name).'), required: ['path'], args: a => [a.path] },
  { name: 'impact', description: 'Files that depend on a file through imports, up to 3 steps away.', props: str('path', 'File path (or a unique file name).'), required: ['path'], args: a => [a.path] },
  { name: 'callers', description: 'Files and lines that call an exported function (also via functions passed as values).', props: str('name', 'Function name, or file:name.'), required: ['name'], args: a => [a.name] },
  { name: 'collection', description: 'Firestore collection or subcollection: files that read/write it and the functions in between, with their callers.', props: { ...str('name', 'Collection, subcollection name, or path pattern like users/{uid}/orders.'), depth: { type: 'integer', enum: [1, 2], description: '2 also lists callers of the calling functions.' } }, required: ['name'], args: a => [a.name, ...(a.depth === 2 ? ['--depth', '2'] : [])] },
  { name: 'screen', description: 'Navigation screen or web route: its file, where it navigates to, where it is reached from.', props: str('name', 'Screen name, route path (/orders/:orderId or /orders/123) or page file.'), required: ['name'], args: a => [a.name] },
  { name: 'find', description: 'Search file paths, exported names, screens and collections in the map.', props: str('text', 'Text to look for.'), required: ['text'], args: a => [a.text] },
  { name: 'path', description: 'Shortest chain of links between two things (file, exported function, screen, collection or subcollection), hop by hop with file and line.', props: { ...str('a', 'Start: file, function (or file:function), screen or collection.'), ...str('b', 'End: same kinds.'), allShortest: { type: 'boolean', description: 'List up to 5 equally short paths.' } }, required: ['a', 'b'], args: a => [a.a, a.b, ...(a.allShortest ? ['--all-shortest'] : [])] },
  { name: 'query', description: 'Question in plain words: the files, functions, screens and collections that match, and the links around them, with file and line.', props: str('question', 'The question, e.g. "what saves a new order".'), required: ['question'], args: a => [a.question] },
  { name: 'notes', description: 'NOTE / WHY / HACK / FIXME / TODO / IMPORTANT / WARNING comments (and ADR/RFC citations) for a file or function, with lines.', props: str('target', 'File path, function name, or file:function; omit with all=true for every note.'), args: a => (a.target ? [a.target] : []) },
  { name: 'groups', description: 'Subsystems: groups of related files with a name, size, central files and the strongest links between groups.', props: {}, args: () => [] },
  { name: 'group', description: 'One group (number or label): its files by folder, collections, and which groups it depends on or is used by.', props: str('name', 'Group number or label (see groups).'), required: ['name'], args: a => [a.name] },
  { name: 'report', description: 'Project report: most-connected files, most-called functions, busiest data, bridge files, rare links between folders, suggested next queries.', props: {}, args: () => [] },
  { name: 'unused', description: 'Files not imported from the entry file, and screens with no incoming navigation found.', props: {}, args: () => [] },
];

// The linked project for a folder: any folder linked to it (a project can link several), deepest match.
const linkedProject = cwd => projectFor(cwd);

function runBrainmap(cwd, args) {
  return new Promise(res => {
    const child = spawn(process.execPath, [BRAINMAP, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', code => { clearTimeout(timer); res({ code, text: (out || err).trimEnd() }); });
    child.on('error', e => { clearTimeout(timer); res({ code: 1, text: `brainmap could not start: ${e.message}` }); });
  });
}

async function callTool(name, args = {}) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return { text: `Unknown tool ${name}.`, isError: true };
  for (const r of tool.required || []) if (typeof args[r] !== 'string' || !args[r].trim()) return { text: `Missing "${r}".`, isError: true };
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!(await linkedProject(cwd))) return { text: 'No code map: this folder is not linked to a Brain project; search the code directly.' };
  const r = await runBrainmap(cwd, [tool.name, ...tool.args(args), ...(args.all ? ['--all'] : []), ...(typeof args.folder === 'string' && args.folder.trim() ? ['--folder', args.folder.trim()] : [])]);
  return { text: r.text || '(no output)', isError: r.code !== 0 && !r.text };
}

// ─── JSON-RPC over stdio ─────────────────────────────────────────────────────
const send = msg => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = result => id !== undefined && send({ id, result });
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'brainmap', version: VERSION },
        instructions: 'Code map of the JavaScript or TypeScript project in this folder (if it is linked in the Brain app; a project can link several folders that share one map). Use these tools before searching files for structure questions.' });
    case 'ping': return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(t => ({ name: t.name, description: t.description,
        inputSchema: { type: 'object', properties: { ...t.props, ...all }, ...(t.required ? { required: t.required } : {}) },
        annotations: { readOnlyHint: true, openWorldHint: false } })) });
    case 'tools/call': {
      const r = await callTool(params?.name, params?.arguments);
      return reply({ content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) });
    }
    default:
      if (id !== undefined && !method?.startsWith('notifications/')) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  handle(msg).catch(e => msg.id !== undefined && send({ id: msg.id, error: { code: -32603, message: e.message } }));
});
