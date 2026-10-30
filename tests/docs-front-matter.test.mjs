// DOC-03: every documentation page says what it is (current, reference, record, proposal or archived) and who reads it
// (owner, operator or engineering) in a two-line front matter block. Before it, the index placed pages by a hand list
// and the documentation freeze told a current page from a record only by its folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  declaredMeta,
  documentationPages,
  documentationProblems,
  frontMatter,
  frontMatterBlock,
  frontMatterProblems,
  pageMeta,
  reviewedOutsideRecords,
  statuses,
  stripFrontMatter,
  tiers,
  withFrontMatter,
} from '../tools/docs-front-matter.mjs';
import {readMoves} from '../tools/docs-links.mjs';
import {removeTestDirectory} from '../dist/tests/temp.js';

test('a page’s front matter is read, written and removed the same way', () => {
  const page = '---\nstatus: reference\ntier: engineering\n---\n\n# Title\n\nText.\n';
  assert.deepEqual(frontMatter(page), {data: {status: 'reference', tier: 'engineering'}, body: '# Title\n\nText.\n'});
  assert.equal(stripFrontMatter(page), '# Title\n\nText.\n');
  assert.equal(frontMatterBlock({tier: 'owner', status: 'current'}), '---\nstatus: current\ntier: owner\n---\n\n');
  assert.equal(
    withFrontMatter({status: 'current', tier: 'owner'}, page),
    withFrontMatter({status: 'current', tier: 'owner'}, '# Title\n\nText.\n'),
  );
  // A page without a block is unchanged, and CRLF line ends read the same.
  assert.deepEqual(frontMatter('# Title\n'), {data: null, body: '# Title\n'});
  assert.deepEqual(frontMatter('---\r\nstatus: record\r\ntier: operator\r\n---\r\n\r\n# T\r\n').data, {
    status: 'record',
    tier: 'operator',
  });
  // A thematic break later in the page is not front matter.
  assert.equal(frontMatter('# T\n\n---\n\nstatus: x\n---\n').data, null);
});

test('a page without valid front matter is named, with what is wrong', () => {
  assert.deepEqual(statuses, ['current', 'reference', 'record', 'proposal', 'archived']);
  assert.deepEqual(tiers, ['owner', 'operator', 'engineering']);
  assert.deepEqual(frontMatterProblems('a.md', '---\nstatus: current\ntier: owner\n---\n\n# A\n'), []);
  assert.deepEqual(
    frontMatterProblems('a.md', '---\nstatus: current\ntier: operator\ngenerated: tools/docs-index.mjs\n---\n# A\n'),
    [],
  );
  assert.match(frontMatterProblems('a.md', '# A\n')[0], /a\.md: no front matter/);
  assert.match(frontMatterProblems('a.md', '---\nstatus: draft\ntier: owner\n---\n')[0], /status is one of/);
  assert.match(frontMatterProblems('a.md', '---\nstatus: current\n---\n')[0], /tier is one of/);
  assert.match(frontMatterProblems('a.md', '---\nstatus: current\ntier: owner\nowner: me\n---\n')[0], /unknown/);
  assert.match(frontMatterProblems('a.md', '---\nstatus current\n---\n')[0], /not `key: value`/);
  assert.match(
    frontMatterProblems('a.md', '---\nstatus: current\ntier: owner\ngenerated: by hand\n---\n')[0],
    /generated names the tool/,
  );
  // The repository README is GitHub's landing page: its meta data is declared, not written into it.
  assert.deepEqual(declaredMeta['README.md'], {status: 'current', tier: 'operator'});
});

test('every documentation page of the repository has valid front matter that agrees with its folder', () => {
  const {moves} = readMoves('.'),
    stubs = new Set([...moves.keys()].filter(file => file.startsWith('docs/')));
  assert.deepEqual(documentationProblems('.', stubs), []);
  const pages = documentationPages('.');
  assert.equal(pages[0], 'README.md');
  assert.ok(pages.length > 500);
  assert.deepEqual(pageMeta('.', 'README.md'), {status: 'current', tier: 'operator'});
  for (const file of [...stubs].filter(f => f.endsWith('.md')))
    assert.equal(pageMeta('.', file).status, 'archived', file);
});

// A page's folder says what it may be: a dated record never passes for a current page, the archive is archived, and
// the owner tier is the owner guide. A redirect stub is archived, and a generated page names a generator that exists.
test('a page whose front matter its folder contradicts, a stub that is not archived or a missing generator is refused', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-front-matter-'));
  t.after(() => removeTestDirectory(root, 'amcp-front-matter-'));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    fs.writeFileSync(path.join(root, file), text);
  };
  const page = (status, tier, extra = '') => '---\nstatus: ' + status + '\ntier: ' + tier + extra + '\n---\n\n# Page\n';
  write('README.md', '# Repo\n');
  write('tools/make.mjs', '// a generator\n');
  write('docs/GUIDE.md', page('current', 'operator'));
  write('docs/GENERATED.md', page('reference', 'engineering', '\ngenerated: tools/make.mjs'));
  write('docs/records/RECORD-2026-10-01.md', page('record', 'operator'));
  write('docs/archive/OLD.md', page('archived', 'engineering'));
  write('docs/owner/README.md', page('current', 'owner'));
  write('docs/review/MOVED.md', page('archived', 'engineering'));
  // A reviewed proposal of the review folder stays where links expect it.
  write('docs/review/ROADMAP.md', page('proposal', 'engineering'));
  assert.deepEqual(documentationProblems(root, new Set(['docs/review/MOVED.md'])), []);
  write('docs/records/NOW.md', page('current', 'operator'));
  write('docs/archive/LIVE.md', page('reference', 'engineering'));
  write('docs/owner/ops.md', page('current', 'operator'));
  write('docs/OWNER.md', page('current', 'owner'));
  write('docs/review/MOVED.md', page('reference', 'engineering'));
  write('docs/LOST.md', page('reference', 'engineering', '\ngenerated: tools/gone.mjs'));
  write('docs/BARE.md', '# No front matter\n');
  // The review of wave 4c: a hand-written page left the freeze, the budget and the reference total by saying it was a
  // record, a proposal or archived. Outside the record folders only a stub or a reviewed page may say so, as reviewed.
  const outside = status =>
    ': outside docs/records/, docs/implementation/, docs/archive/ a page is current or reference, not ' +
    status +
    ' (move it there, or review it into reviewedOutsideRecords in tools/docs-front-matter.mjs)';
  write('docs/PLAN.md', page('proposal', 'operator'));
  write('docs/review/DATED.md', page('record', 'engineering'));
  write('docs/review/ROADMAP.md', page('archived', 'engineering'));
  assert.deepEqual(documentationProblems(root, new Set(['docs/review/MOVED.md'])), [
    'docs/BARE.md: no front matter (---, status: …, tier: …, ---) at the top of the page',
    'docs/LOST.md: its generator tools/gone.mjs does not exist',
    'docs/OWNER.md: the owner tier is the owner guide, in docs/owner/',
    'docs/PLAN.md' + outside('proposal'),
    'docs/archive/LIVE.md: a page in docs/archive/ is archived, not reference',
    'docs/owner/ops.md: a page in docs/owner/ is for the owner tier',
    'docs/records/NOW.md: a page in docs/records/ is record, not current',
    'docs/review/DATED.md' + outside('record'),
    'docs/review/MOVED.md: a redirect stub is archived',
    'docs/review/ROADMAP.md' + outside('archived'),
  ]);
});

test('the pages reviewed to be records or proposals outside the record folders say what they were reviewed as', () => {
  for (const [file, status] of Object.entries(reviewedOutsideRecords)) {
    assert.ok(fs.existsSync(file), file);
    assert.equal(pageMeta('.', file).status, status, file);
    assert.doesNotMatch(file, /^docs\/(?:records|implementation|archive)\//, file + ' needs no entry');
  }
});
