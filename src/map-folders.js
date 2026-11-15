// Several code folders in one map (format version: map-schema.js). Pure helpers with no Node or browser dependencies, used by
// brainmap, the tool server, the status check and the diagram. In a map of more than one folder, file ids and
// paths start with the folder's short name (app:src/x.js); `relPath` is the path inside the folder and
// `codeFolder` the folder every node and edge came from. A single-folder map has no prefixes.

export const DATA_ID = /^(sub)?collection:/;
export const folderNames = map => (map?.folders || []).map(f => f.name);
export const isMulti = map => (map?.folders?.length || 0) > 1;
// Is this file id written with its folder in front (app:src/x.js)?
export const prefixed = f => !!f && f.relPath !== undefined && f.relPath !== f.path;

// "ptdash:src/pages/X.jsx" → { folder: 'ptdash', rest: 'src/pages/X.jsx' }; no known folder in front → { folder: null, rest: q }.
export function scopeQuery(map, q) {
  const s = String(q ?? '');
  for (const name of folderNames(map)) if (s.toLowerCase().startsWith(`${name}:`)) return { folder: name, rest: s.slice(name.length + 1) };
  return { folder: null, rest: s };
}

// The part of a merged map that came from one folder: its files, the links made in it, and the collections it
// touches with that folder's own readers and writers. Links into another folder (a cloud function defined there)
// are left out. Shaped like a single-folder map (paths keep their prefix), so every command works on it.
export function forFolder(map, name) {
  if (!isMulti(map)) return map;
  const f = map.folders.find(x => x.name === name);
  if (!f) return null;
  const mine = x => x.codeFolder === name;
  const files = map.nodes.filter(n => n.kind === 'file' && mine(n));
  const fileIds = new Set(files.map(n => n.id));
  const edges = map.edges.filter(e => mine(e) && (fileIds.has(e.to) || DATA_ID.test(e.to)));
  const data = map.nodes.filter(n => n.kind !== 'file' && n.byFolder?.[name]).map(n => {
    const b = n.byFolder[name];
    const { shared, byFolder, ...rest } = n;
    return { ...rest, readers: b.readers, writers: b.writers, usedWithUnknownOperation: b.unknown, paths: b.paths || n.paths, ...(b.pattern ? { pattern: b.pattern } : {}), folders: [name] };
  });
  const groups = (map.groups?.list || []).filter(mine), ids = new Set(groups.map(g => g.id));
  return {
    ...map,
    generatedAt: f.generatedAt,
    project: { path: f.path, gitCommit: f.gitCommit, fileListSource: f.fileListSource },
    folders: [f],
    restrictedTo: name,
    counts: f.counts,
    rootGroups: (map.rootGroups || []).filter(mine),
    nodes: [...files, ...data],
    edges,
    unresolved: (map.unresolved || []).filter(mine),
    missingRelative: (map.missingRelative || []).filter(mine),
    parseFailures: (map.parseFailures || []).filter(mine),
    notes: (map.notes || []).filter(mine),
    skippedFiles: (map.skippedFiles || []).filter(mine),
    keptLargeFiles: (map.keptLargeFiles || []).filter(mine),
    navigation: { ...map.navigation, screens: (map.navigation?.screens || []).filter(mine), unmatched: (map.navigation?.unmatched || []).filter(mine) },
    functions: map.functions?.byFolder?.[name] || map.functions,
    data: { ...map.data, usesWithUnknownOperation: (map.data?.usesWithUnknownOperation || []).filter(mine) },
    groups: { ...map.groups, list: groups, isolated: (map.groups?.isolated || []).filter(id => fileIds.has(id)), links: (map.groups?.links || []).filter(l => ids.has(l.a) && ids.has(l.b)) },
  };
}

// Shared data: the collections and subcollections more than one folder touches, with each folder's reader and
// writer files (from the links), and the cloud function calls that go from one folder to another.
export function crossFolder(map) {
  const shared = map.nodes.filter(n => (n.kind === 'collection' || n.kind === 'subcollection') && n.shared);
  const inn = new Map();
  for (const e of map.edges) if ((e.kind === 'reads' || e.kind === 'writes') && DATA_ID.test(e.to)) (inn.get(e.to) || inn.set(e.to, []).get(e.to)).push(e);
  const data = shared.map(n => {
    const es = inn.get(n.id) || [];
    const byFolder = folderNames(map).filter(name => n.byFolder?.[name]).map(name => ({
      folder: name,
      readers: [...new Set(es.filter(e => e.codeFolder === name && e.kind === 'reads').map(e => e.from))].sort(),
      writers: [...new Set(es.filter(e => e.codeFolder === name && e.kind === 'writes').map(e => e.from))].sort(),
      unknown: n.byFolder[name].unknown || 0,
    }));
    return { id: n.id, kind: n.kind, name: n.kind === 'subcollection' ? n.pattern : n.name, total: n.readers + n.writers, byFolder };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const only = Object.fromEntries(folderNames(map).map(name => [name, map.nodes.filter(n => n.kind === 'collection' && n.folders?.length === 1 && n.folders[0] === name).map(n => n.name)]));
  const calls = map.edges.filter(e => e.crossFolder).map(e => ({ from: e.from, to: e.to, line: e.line, function: e.function, fromFolder: e.codeFolder, toFolder: e.toFolder }));
  return { data, calls, only };
}
