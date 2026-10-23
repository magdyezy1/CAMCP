// DOC-03: the documentation freeze. Every delivery batch pasted its summary into several current guides (a heading per
// batch, commit hashes, the same paragraphs on many pages), so current pages turned into delivery logs that
// contradicted each other. Nothing stopped a new batch heading, commit citation or copied paragraph on a current page.
// tools/docs-lint.mjs records the pages that already hold them and lets each count only fall; `npm run
// docs:index:check` runs it, beside the link check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {baselineFile, currentPages, lintProblems, measure, summary, writeBaseline} from '../tools/docs-lint.mjs';
import {removeTestDirectory} from '../dist/tests/temp.js';

const temporary = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-docs-lint-'));
  t.after(() => removeTestDirectory(directory, 'amcp-docs-lint-'));
  return directory;
};
const write = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
  fs.writeFileSync(path.join(root, file), text);
};
const long = 'This sentence is long enough to count as a long line, at seventy characters or more, on purpose.';

test('the repository keeps the documentation freeze, and the owner guide starts and stays clean', () => {
  assert.deepEqual(lintProblems('.'), []);
  const {counts} = measure('.');
  for (const [file, count] of Object.entries(counts))
    if (file.startsWith('docs/owner/'))
      assert.deepEqual(count, {batch_headings: 0, commit_refs: 0, duplicate_lines: 0}, file);
  // Records, the archive, implementation records, stubs and generated references are not current pages.
  const pages = currentPages('.');
  assert.ok(
    pages.includes('README.md') && pages.includes('docs/owner/README.md') && pages.includes('docs/OPERATIONS.md'),
  );
  for (const file of pages) assert.doesNotMatch(file, /^docs\/(?:records|archive|implementation)\//);
  for (const file of ['docs/README.md', 'docs/CONTRACTS.md', 'docs/review/PACKAGE-STATUS.md', 'docs/review/SUMMARY.md'])
    assert.ok(!pages.includes(file), file);
  // The review's targets: the duplicate-line share is under 5% (it was 6.8% before the batch history below moved);
  // the word count still waits on consolidating the long guides, so it is measured, not asserted.
  const s = summary('.');
  assert.equal(s.targets.words, 25000);
  assert.ok(s.duplicate_share > 0 && s.duplicate_share < s.targets.duplicate_share, String(s.duplicate_share));
});

// DOC-03 implementation path, step 4: the batch sections of the write coverage and implementation pages are delivery
// history. They held 106 batch headings and 335 long lines repeated on other current pages, about half of all the
// repetition across current pages; they now live in docs/records/, kept as written, and each page links its history.
test('the coverage and implementation pages keep no batch history; their records hold it, linked both ways', () => {
  const {counts} = measure('.'),
    pages = currentPages('.');
  for (const [page, record, first, last] of [
    ['docs/review/COVERAGE.md', 'docs/records/COVERAGE-BATCH-HISTORY.md', '## Done in batch 49', '## Batch 181 '],
    [
      'docs/review/IMPLEMENTATION-2026-10-01.md',
      'docs/records/IMPLEMENTATION-2026-10-01-BATCH-HISTORY.md',
      '## Batch 160 ',
      '## Batch 192 ',
    ],
  ]) {
    const text = fs.readFileSync(page, 'utf8'),
      history = fs.readFileSync(record, 'utf8');
    assert.equal(counts[page].batch_headings, 0, page);
    assert.equal(counts[page].duplicate_lines, 0, page);
    assert.doesNotMatch(text, /^## .*\bbatch(?:es)?\s+\d+/im, page);
    assert.ok(text.includes('](../records/' + path.posix.basename(record) + ')'), page + ' links its history');
    assert.ok(history.includes('](../review/' + path.posix.basename(page) + ')'), record + ' links its page');
    assert.ok(history.includes('\n' + first) && history.includes('\n' + last), record);
    assert.ok(pages.includes(page) && !pages.includes(record), record + ' is a record, not a current page');
  }
});

test('a new batch heading, commit reference or repeated long line on a current page is refused; records may hold them', t => {
  const root = temporary(t);
  write(root, 'README.md', '# Repo\n');
  write(
    root,
    'docs/moved.json',
    JSON.stringify({date: '2026-10-22', moved: {'docs/review/OLD.md': 'docs/records/OLD.md'}}),
  );
  write(root, 'docs/GUIDE.md', '# Guide\n\n' + long + '\n');
  write(root, 'docs/OTHER.md', '# Other\n\n## Batch 12 — a delivery\n\nFixed at `60ec2cc`.\n\n' + long + '\n');
  write(root, 'docs/records/DELIVERY-2026-10-01-X.md', '# Record\n\n## Batch 12\n\n' + long + '\n');
  write(root, 'docs/archive/OLD-REVIEW.md', '# Old\n\n' + long + '\n');
  write(root, 'docs/review/OLD.md', '# Moved: Old\n\n' + long + '\n');
  write(root, 'docs/GENERATED.md', '# Generated page\n\nGenerated by a tool.\n\n## Batch 3\n\n' + long + '\n');
  // In code, a heading or a long line is not prose.
  write(root, 'docs/CODE.md', '# Code\n\n```\n## Batch 9\n' + long + '\n```\n');
  assert.deepEqual(currentPages(root), ['README.md', 'docs/CODE.md', 'docs/GUIDE.md', 'docs/OTHER.md']);
  assert.deepEqual(measure(root).counts, {
    'README.md': {batch_headings: 0, commit_refs: 0, duplicate_lines: 0},
    'docs/CODE.md': {batch_headings: 0, commit_refs: 0, duplicate_lines: 0},
    'docs/GUIDE.md': {batch_headings: 0, commit_refs: 0, duplicate_lines: 1},
    'docs/OTHER.md': {batch_headings: 1, commit_refs: 1, duplicate_lines: 1},
  });
  const problems = lintProblems(root, {pages: {}});
  assert.equal(problems.length, 4);
  assert.match(
    problems.find(p => p.startsWith('docs/GUIDE.md')),
    /repeated on another current page.*is also in docs\/OTHER\.md/,
  );
  assert.ok(problems.some(p => p.startsWith('docs/OTHER.md: 1 headings naming a batch')));
  assert.ok(problems.some(p => p.startsWith('docs/OTHER.md: 1 commit references')));
  // The first record of a tree takes the counts as they are; after that they may only fall.
  assert.deepEqual(writeBaseline(root), [
    'docs/GUIDE.md duplicate_lines 0 → 1',
    'docs/OTHER.md batch_headings 0 → 1',
    'docs/OTHER.md commit_refs 0 → 1',
    'docs/OTHER.md duplicate_lines 0 → 1',
  ]);
  assert.deepEqual(lintProblems(root), []);
  write(root, 'docs/GUIDE.md', '# Guide\n\n## Batch 13 — another delivery\n\n' + long + '\n');
  assert.deepEqual(lintProblems(root), [
    'docs/GUIDE.md: 1 headings naming a batch (move the delivery history to docs/records/), above 0',
  ]);
  assert.throws(() => writeBaseline(root), /docs\/GUIDE\.md batch_headings 0 → 1[\s\S]*--allow-increase/);
  // An increase is recorded only with its reason.
  writeBaseline(root, 'a heading the owner asked to keep');
  const baseline = JSON.parse(fs.readFileSync(path.join(root, baselineFile), 'utf8'));
  assert.deepEqual(baseline.increases, [
    {reason: 'a heading the owner asked to keep', raised: ['docs/GUIDE.md batch_headings 0 → 1']},
  ]);
  // Removing the history lowers the record on the next write; the page then may not regain it.
  write(root, 'docs/OTHER.md', '# Other\n');
  write(root, 'docs/GUIDE.md', '# Guide\n');
  writeBaseline(root);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, baselineFile), 'utf8')).pages, {});
  write(root, 'docs/OTHER.md', '# Other\n\nSee `be3a630`.\n');
  assert.equal(lintProblems(root).length, 1);
});
