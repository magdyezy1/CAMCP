// DOC-03 (owner decision P12): the delivery records moved to docs/records/ and superseded reviews to docs/archive/,
// with every link preserved. Nothing checked the repository's Markdown links before: a moved or renamed document, or a
// renamed heading, broke its inbound links silently. tools/docs-links.mjs fails on a broken relative link or section,
// on a link that still names a moved document's old address, and on a missing or stale redirect stub; `npm run
// docs:index:check` (tools/docs-index.mjs) runs it, so qualification and the image build do too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  headingSlug,
  linkProblems,
  markdownAnchors,
  markdownLinks,
  readMoves,
  rewriteLinks,
  stubText,
} from '../tools/docs-links.mjs';
import {removeTestDirectory} from '../dist/tests/temp.js';

const temporary = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-docs-links-'));
  t.after(() => removeTestDirectory(directory, 'amcp-docs-links-'));
  return directory;
};
const write = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
  fs.writeFileSync(path.join(root, file), text);
};

test('every relative link in the repository resolves, names no moved address, and every moved document has its stub', () => {
  assert.deepEqual(linkProblems('.'), []);
  const run = spawnSync(process.execPath, ['tools/docs-links.mjs', '--check'], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
  // The move P12 approved: no delivery or incident record is a document in docs/review/ any more; each old address is
  // a stub naming its record in docs/records/, and the superseded reviews are in docs/archive/.
  const {date, moves} = readMoves('.');
  assert.equal(date, '2026-10-22');
  const records = fs.readdirSync('docs/review').filter(file => /^(?:DELIVERY|INCIDENT)-/.test(file));
  assert.ok(records.length >= 139);
  for (const file of records) assert.match(moves.get('docs/review/' + file) ?? '', /^docs\/records\//, file);
  assert.ok([...moves.values()].filter(file => file.startsWith('docs/archive/')).length >= 11);
  for (const [from, to] of moves) {
    assert.ok(fs.existsSync(to), to);
    assert.equal(fs.readFileSync(from, 'utf8'), stubText('.', from, to, date), from);
  }
});

test('a broken file, a wrong case, a missing section and a link that leaves the repository are each refused', t => {
  const root = temporary(t);
  write(root, 'docs/guide.md', '# Guide\n\n## Connect your accounts\n\n<a id="explicit-anchor"></a>\n');
  write(
    root,
    'docs/README.md',
    [
      '# Index',
      '',
      '[ok](guide.md) [section](guide.md#connect-your-accounts) [explicit](guide.md#explicit-anchor)',
      '[line](guide.md#L3) [here](#index) [web](https://example.test/x) [mail](mailto:a@example.test)',
      '[missing](missing.md)',
      '[case](Guide.md)',
      '[gone](guide.md#no-such-section)',
      '[outside](../../elsewhere.md)',
      '`[in code](absent.md)`',
      '```',
      '[in a block](absent.md)',
      '```',
      '[angle](<guide.md>) [titled](guide.md "Title") ![image](missing.png)',
      '[ref]: also-missing.md',
      '<a href="html-missing.md">html</a>',
    ].join('\n'),
  );
  assert.deepEqual(linkProblems(root), [
    'docs/README.md:5: missing.md does not exist',
    'docs/README.md:6: Guide.md does not exist',
    'docs/README.md:7: guide.md#no-such-section names no heading or anchor in docs/guide.md',
    'docs/README.md:8: ../../elsewhere.md leaves the repository or is not a valid address',
    'docs/README.md:13: missing.png does not exist',
    'docs/README.md:14: also-missing.md does not exist',
    'docs/README.md:15: html-missing.md does not exist',
  ]);
});

test('a link to a moved address is refused until rewritten; the rewrite re-bases the moved document and writes its stub', t => {
  const root = temporary(t);
  write(root, 'docs/OPERATIONS.md', '# Operations\n\n## Restore drill\n');
  write(root, 'docs/review/FINDINGS.md', '# Findings\n');
  // The record as it was before the move, then moved by hand: its links are written for docs/review/.
  const record =
    '# Delivery — 1 October 2026\n\nSee [operations](../OPERATIONS.md#restore-drill), [findings](FINDINGS.md), ' +
    '[the other record](DELIVERY-B.md) and [the source](../../src/x.ts).\n';
  write(root, 'docs/records/DELIVERY-A.md', record);
  write(root, 'docs/records/DELIVERY-B.md', '# Other record\n');
  write(root, 'src/x.ts', '// source\n');
  write(
    root,
    'docs/README.md',
    '# Index\n\n[record](review/DELIVERY-A.md#delivery--1-october-2026) [other](review/DELIVERY-B.md)\n',
  );
  write(root, 'README.md', '# AMCP\n\n[record](docs/review/DELIVERY-A.md)\n');
  write(
    root,
    'docs/moved.json',
    JSON.stringify({
      date: '2026-10-22',
      moved: {
        'docs/review/DELIVERY-A.md': 'docs/records/DELIVERY-A.md',
        'docs/review/DELIVERY-B.md': 'docs/records/DELIVERY-B.md',
      },
    }),
  );
  const before = linkProblems(root);
  assert.ok(
    before.includes(
      'docs/review/DELIVERY-A.md: the redirect stub to docs/records/DELIVERY-A.md is missing or stale (node tools/docs-links.mjs --write)',
    ),
  );
  assert.ok(
    before.includes(
      'README.md:3: docs/review/DELIVERY-A.md names the old address of docs/records/DELIVERY-A.md (node tools/docs-links.mjs --write)',
    ),
  );
  assert.ok(before.some(p => p.startsWith('docs/records/DELIVERY-A.md:3: FINDINGS.md does not exist')));
  const changed = rewriteLinks(root);
  assert.deepEqual(changed.sort(), [
    'README.md',
    'docs/README.md',
    'docs/records/DELIVERY-A.md',
    'docs/review/DELIVERY-A.md',
    'docs/review/DELIVERY-B.md',
  ]);
  assert.deepEqual(linkProblems(root), []);
  assert.equal(
    fs.readFileSync(path.join(root, 'docs/records/DELIVERY-A.md'), 'utf8'),
    // Links that resolve from the new folder stay; the one written for docs/review/ is re-based; sections are kept.
    record.replace('[findings](FINDINGS.md)', '[findings](../review/FINDINGS.md)'),
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'docs/README.md'), 'utf8'),
    '# Index\n\n[record](records/DELIVERY-A.md#delivery--1-october-2026) [other](records/DELIVERY-B.md)\n',
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'README.md'), 'utf8'),
    '# AMCP\n\n[record](docs/records/DELIVERY-A.md)\n',
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'docs/review/DELIVERY-A.md'), 'utf8'),
    '# Moved: Delivery — 1 October 2026\n\nThis document moved on 2026-10-22 (DOC-03, owner decision P12). Its text and ' +
      'history are kept at\n[docs/records/DELIVERY-A.md](../records/DELIVERY-A.md); this page only keeps links to the ' +
      'old address working.\n',
  );
  // Idempotent: a second run changes nothing.
  assert.deepEqual(rewriteLinks(root), []);
  // A stub edited by hand, or a moved document's new title, makes the stub stale until it is written again.
  write(root, 'docs/review/DELIVERY-B.md', '# Other record, edited\n');
  assert.deepEqual(linkProblems(root), [
    'docs/review/DELIVERY-B.md: the redirect stub to docs/records/DELIVERY-B.md is missing or stale (node tools/docs-links.mjs --write)',
  ]);
  // The new address must exist.
  fs.rmSync(path.join(root, 'docs/records/DELIVERY-B.md'));
  assert.ok(
    linkProblems(root).includes(
      'docs/moved.json: docs/records/DELIVERY-B.md (moved from docs/review/DELIVERY-B.md) does not exist',
    ),
  );
});

test('headings get GitHub’s anchors, repeats numbered, in any script; links are found only outside code', () => {
  assert.equal(headingSlug('Connect your accounts'), 'connect-your-accounts');
  assert.equal(headingSlug('The `amcp_write` tool: what it does (B05)'), 'the-amcp_write-tool-what-it-does-b05');
  assert.equal(headingSlug('Delivery — 1 October 2026'), 'delivery--1-october-2026');
  assert.equal(headingSlug('[Linked](x.md) heading'), 'linked-heading');
  assert.equal(headingSlug('ربط الحسابات'), 'ربط-الحسابات');
  assert.deepEqual(
    [...markdownAnchors('# Title\n\n## Steps\n\n## Steps\n\n```\n## not a heading\n```\n<span id="Kept"></span>\n')],
    ['title', 'steps', 'steps-1', 'kept'],
  );
  assert.deepEqual(
    markdownLinks('[a](a.md) `[b](b.md)` ``[c](`c.md`)``\n~~~\n[d](d.md)\n~~~\n[e](<e.md>) [f](f.md "F")').map(
      l => l.target,
    ),
    ['a.md', 'e.md', 'f.md'],
  );
});
