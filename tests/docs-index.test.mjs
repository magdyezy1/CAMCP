// DOC-03: docs/README.md, the map of the documentation, is generated from each page's front matter. Before,
// tools/docs-index.mjs placed the top-level guides by a hand list of file names and refused a document it did not
// list, so every new page needed an edit of the tool, and the index's claim to be generated "from the documents
// themselves" was not true. These checks read the committed index against every page's front matter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {documentationPages, pageMeta} from '../tools/docs-front-matter.mjs';
import {readMoves} from '../tools/docs-links.mjs';

const index = fs.readFileSync('docs/README.md', 'utf8'),
  {moves} = readMoves('.');
/** The index's sections by their "## " heading, each with its text. */
const sections = (() => {
  const out = new Map();
  let current = null;
  for (const line of index.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) out.set((current = heading[1]), '');
    else if (current) out.set(current, out.get(current) + line + '\n');
  }
  return out;
})();
/** The section a page's status and tier place it in, as the index says it does. */
function sectionOf(file, meta) {
  if (meta.tier === 'owner') return 'Owner guide';
  if (meta.status === 'proposal') return 'Plans and proposals';
  if (meta.status === 'archived') return 'Archive';
  if (meta.status === 'record') return file.startsWith('docs/implementation/') ? 'Implementation records' : 'Records';
  if (meta.tier === 'engineering') return 'Engineering reference';
  return meta.status === 'current' ? 'Operate AMCP' : 'Operator reference';
}

test('the index tool names no document: the pages place themselves by their front matter', () => {
  const source = fs.readFileSync('tools/docs-index.mjs', 'utf8');
  // The only Markdown files the tool names are the index it writes and the owner guide's README, whose links give the
  // guide's reading order. A hand list of guides would name each of them.
  const named = [...new Set([...source.matchAll(/['"`]([\w./-]+\.md)\b/g)].map(m => m[1]))].sort();
  assert.deepEqual(named, ['/README.md', 'README.md', 'docs/README.md']);
  assert.match(index, /^---\nstatus: current\ntier: operator\ngenerated: tools\/docs-index\.mjs\n---\n/);
  assert.deepEqual(
    [...sections.keys()],
    [
      'Owner guide',
      'Operate AMCP',
      'Operator reference',
      'Engineering reference',
      'Plans and proposals',
      'Implementation records',
      'Records',
      'Archive',
    ],
  );
});

/** The index's entries: its list items and table rows (its introductions also link a few pages in their prose). */
const entries = text =>
  text
    .split('\n')
    .filter(line => line.startsWith('- [') || line.startsWith('| '))
    .join('\n');

test('every documentation page is listed once, in the section its status and tier give it; stubs are not', () => {
  let listed = 0;
  const all = entries(index);
  for (const file of documentationPages('.')) {
    if (!file.startsWith('docs/') || file === 'docs/README.md') continue;
    const link = '](' + path.posix.relative('docs', file) + ')',
      count = all.split(link).length - 1;
    if (moves.has(file)) {
      assert.equal(count, 0, file + ' is a redirect stub, never listed');
      continue;
    }
    const meta = pageMeta('.', file),
      expected = sectionOf(file, meta);
    assert.equal(count, 1, file + ' is listed once');
    assert.ok(
      entries(sections.get(expected)).includes(link),
      file + ' (' + meta.status + ', ' + meta.tier + ') is in ' + expected,
    );
    listed++;
  }
  assert.ok(listed > 400, String(listed));
});

test('the owner guide is listed in its reading order, each English page beside its Arabic translation', () => {
  const owner = sections.get('Owner guide'),
    readme = fs.readFileSync('docs/owner/README.md', 'utf8'),
    order = [
      'README.md',
      ...[...readme.matchAll(/\]\(([\w-]+\.md)(?:#[^)]*)?\)/g)]
        .map(m => m[1])
        .filter((f, i, all) => all.indexOf(f) === i),
    ].filter(f => fs.existsSync('docs/owner/' + f));
  const rows = owner.split('\n').filter(line => line.startsWith('| ['));
  assert.equal(rows.length, order.length);
  rows.forEach((row, i) => {
    assert.ok(row.includes('](owner/' + order[i] + ')'), row);
    assert.ok(row.includes('](owner/ar/' + order[i] + ')'), row + ' has its translation');
  });
});
