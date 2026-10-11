// The literal calls of AMCP's own tools that tests, the website and the guides make (MCP-07): each tool name followed by
// an object literal (`call('amcp_workspace', {action: 'check', ...})`, `{name: 'amcp_write', arguments: {...}}`,
// `{tool: 'amcp_campaign', arguments: {...}}`, or a guide's `amcp_media {action: "plan", source_id, ...}`), with the
// top-level argument names it passes. The per-action contract table (src/first-party-contracts.ts) must accept every one.
// A call built from a spread or a computed key is marked partial: only its literal names are known.
// Usage: node tools/first-party-fixtures.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const firstPartyToolNames = [
  'amcp_workspace',
  'amcp_campaign',
  'amcp_reporting',
  'amcp_reporting_overview',
  'amcp_ad_previews',
  'amcp_media',
  'amcp_write',
];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The index just past the literal, comment or template that starts at `i`, or `i` when none starts there. */
function skipToken(text, i) {
  const c = text[i];
  if (c === '/' && text[i + 1] === '/') {
    const end = text.indexOf('\n', i);
    return end < 0 ? text.length : end;
  }
  if (c === '/' && text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2);
    return end < 0 ? text.length : end + 2;
  }
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\\') j++;
      else if (text[j] === c) return j + 1;
      else if (text[j] === '\n') return j;
    }
    return text.length;
  }
  if (c === '`') {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\\') j++;
      else if (text[j] === '`') return j + 1;
      else if (text[j] === '$' && text[j + 1] === '{') j = matching(text, j + 1) - 1;
    }
    return text.length;
  }
  return i;
}
/** The index just past the bracket that closes the one at `open`. */
function matching(text, open) {
  const pairs = {'{': '}', '[': ']', '(': ')'},
    stack = [];
  for (let i = open; i < text.length;) {
    const next = skipToken(text, i);
    if (next !== i) {
      i = next;
      continue;
    }
    const c = text[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === '}' || c === ']' || c === ')') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i + 1;
    }
    i++;
  }
  return -1;
}
/** The top-level entries of an object literal's text, split at commas outside any bracket or literal. */
function entries(body) {
  const out = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < body.length;) {
    const next = skipToken(body, i);
    if (next !== i) {
      i = next;
      continue;
    }
    const c = body[i];
    if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  out.push(body.slice(start));
  return out.map(e => e.replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '').trim()).filter(Boolean);
}
/** One object literal: its literal keys, its literal action (when it has one) and whether a spread hides more. */
export function objectLiteral(text) {
  const keys = [],
    out = {keys, action: undefined, partial: false};
  for (const entry of entries(text.slice(1, -1))) {
    if (entry.startsWith('...')) {
      out.partial = true;
      continue;
    }
    const m = /^(?:(["'])([^"'\n]+)\1|([A-Za-z_$][\w$]*))\s*(:|$)/.exec(entry);
    if (!m) {
      out.partial = true;
      continue;
    }
    const key = m[2] ?? m[3];
    keys.push(key);
    if (key === 'action' && m[4] === ':') {
      const value = /^\s*(["'`])([A-Za-z_][\w]*)\1\s*(?:as\s+const\s*)?$/.exec(entry.slice(m[0].length));
      out.action = value ? value[2] : null;
    }
  }
  return out;
}
/** Every literal first-party call in one source text. */
export function extractCalls(text, file = '') {
  const calls = [],
    names = firstPartyToolNames.join('|'),
    pattern = new RegExp('(["\'`]?)\\b(' + names + ')\\b\\1', 'g');
  for (let m; (m = pattern.exec(text));) {
    const tool = m[2];
    let i = m.index + m[0].length;
    // `tool, {` (a call), `tool {` (a guide), or `tool', arguments: {` (a request object).
    const after =
      /^\s*(?:,\s*|)(?:arguments\s*:\s*)?\{/.exec(text.slice(i, i + 200)) ??
      (m[1] ? /^\s*,\s*arguments\s*:\s*\{/.exec(text.slice(i, i + 200)) : null);
    if (!after) continue;
    // A bare word must be followed directly by `{` (the guides' call notation), not by `, {`.
    if (!m[1] && !/^\s*\{/.test(text.slice(i, i + 20))) continue;
    if (m[1] && /^\s*\{/.test(text.slice(i, i + 20)) && !/[,(]\s*$/.test(text.slice(Math.max(0, m.index - 3), m.index)))
      continue;
    const open = i + after[0].length - 1,
      close = matching(text, open);
    if (close < 0) continue;
    const literal = objectLiteral(text.slice(open, close));
    if (!literal.keys.length) continue;
    calls.push({tool, file, line: text.slice(0, m.index).split('\n').length, ...literal});
  }
  return calls;
}
/** The calls in the repository's tests, website modules and guides. */
export function repositoryFixtures(base = root) {
  const files = [];
  const add = (dir, test) => {
    const full = path.join(base, dir);
    if (!fs.existsSync(full)) return;
    for (const name of fs.readdirSync(full))
      if (test(name) && fs.statSync(path.join(full, name)).isFile()) files.push(dir + '/' + name);
  };
  add('tests', n => /\.(?:ts|mjs)$/.test(n));
  add('web', n => /\.js$/.test(n));
  add('Skills/amcp-campaign-builder', n => /\.md$/.test(n));
  add('Skills/amcp-campaign-builder/references', n => /\.md$/.test(n));
  add('Skills/amcp-campaign-builder/examples', n => /\.json$/.test(n));
  return files.flatMap(file => extractCalls(fs.readFileSync(path.join(base, file), 'utf8'), file));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const calls = repositoryFixtures();
  if (process.argv.includes('--json')) console.log(JSON.stringify(calls, null, 1));
  else {
    const by = new Map();
    for (const c of calls) {
      const k = c.tool + ' ' + c.action;
      const e = by.get(k) ?? {n: 0, keys: new Set(), files: new Set()};
      e.n++;
      c.keys.forEach(x => e.keys.add(x));
      e.files.add(c.file);
      by.set(k, e);
    }
    for (const [k, e] of [...by].sort()) console.log(k, e.n, [...e.keys].sort().join(','));
  }
}
