// DOC-03: the documentation freeze. Every delivery batch pasted its summary into several current guides (a heading per
// batch, commit hashes, the same paragraphs on many pages), so current pages turned into delivery logs that
// contradicted each other. Nothing stopped a new batch heading, commit citation, typed package count ("13/14/1") or
// copied paragraph on a current page. tools/docs-lint.mjs records the pages that already hold them and lets each
// count only fall; `npm run docs:index:check` runs it, beside the link check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  baselineFile,
  budgetProblems,
  citationProblems,
  commitRecordPages,
  currentPages,
  decisionRows,
  decisionSubjects,
  lintProblems,
  measure,
  packageCounts,
  readBaseline,
  summary,
  writeBaseline,
} from '../tools/docs-lint.mjs';
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
      assert.deepEqual(count, {batch_headings: 0, commit_refs: 0, duplicate_lines: 0, package_counts: 0}, file);
  // Records, the archive, implementation records, stubs and generated references are not current pages.
  const pages = currentPages('.');
  assert.ok(
    pages.includes('README.md') && pages.includes('docs/owner/README.md') && pages.includes('docs/OPERATIONS.md'),
  );
  for (const file of pages) assert.doesNotMatch(file, /^docs\/(?:records|archive|implementation)\//);
  for (const file of ['docs/README.md', 'docs/CONTRACTS.md', 'docs/review/PACKAGE-STATUS.md', 'docs/review/SUMMARY.md'])
    assert.ok(!pages.includes(file), file);
  // The review's targets: the duplicate-line share is under 5% (6.8% before the batch history below moved, 1.8% before
  // the consolidation of 2026-10-24), and the owner and operator tiers' current pages keep within about 25,000 words
  // (46,536 before the operations runbook and the workflow guide were split into task pages). The reference pages
  // keep within the total the baseline records.
  const s = summary('.');
  assert.equal(s.targets.words, 25000);
  assert.ok(s.duplicate_share < s.targets.duplicate_share, String(s.duplicate_share));
  assert.ok(s.budget_words > 0 && s.budget_words <= s.targets.words, String(s.budget_words));
  assert.equal(s.unclassified_words, 0, 'every maintained page says its tier');
  assert.equal(s.reference_words, s.engineering_words + s.operator_reference_words);
  assert.deepEqual(budgetProblems('.'), []);
  assert.ok(s.reference_words <= readBaseline('.').totals.reference_words);
});

// DOC-03 implementation path, step 4: the batch sections of the write coverage and implementation pages are delivery
// history. They held 106 batch headings and 335 long lines repeated on other current pages, about half of all the
// repetition across current pages; they now live in docs/records/, kept as written, and each page links its history.
// The implementation page itself is the dated matrix of 1 October 2026, "no longer updated" by its own words, with the
// batch notes of 113 to 158 under it: since the consolidation of 2026-10-24 its front matter says it is a record, so the
// freeze and the size report no longer read it as a maintained page (before, they did).
test('the coverage and implementation pages keep no batch history; their records hold it, linked both ways', () => {
  const {counts} = measure('.'),
    pages = currentPages('.');
  for (const [page, record, first, last, maintained] of [
    ['docs/review/COVERAGE.md', 'docs/records/COVERAGE-BATCH-HISTORY.md', '## Done in batch 49', '## Batch 181 ', true],
    [
      'docs/review/IMPLEMENTATION-2026-10-01.md',
      'docs/records/IMPLEMENTATION-2026-10-01-BATCH-HISTORY.md',
      '## Batch 160 ',
      '## Batch 192 ',
      false,
    ],
  ]) {
    const text = fs.readFileSync(page, 'utf8'),
      history = fs.readFileSync(record, 'utf8');
    assert.doesNotMatch(text, /^## .*\bbatch(?:es)?\s+\d+/im, page);
    assert.ok(text.includes('](../records/' + path.posix.basename(record) + ')'), page + ' links its history');
    assert.ok(history.includes('](../review/' + path.posix.basename(page) + ')'), record + ' links its page');
    assert.ok(history.includes('\n' + first) && history.includes('\n' + last), record);
    assert.ok(!pages.includes(record), record + ' is a record, not a current page');
    assert.equal(pages.includes(page), maintained, page);
    if (maintained) {
      assert.equal(counts[page].batch_headings, 0, page);
      assert.equal(counts[page].duplicate_lines, 0, page);
    } else assert.match(text, /^---\nstatus: record\n/, page + ' says it is a record');
  }
});

test('a new batch heading, commit reference, package count or repeated long line on a current page is refused; records may hold them', t => {
  const root = temporary(t);
  write(root, 'README.md', '# Repo\n');
  write(
    root,
    'docs/moved.json',
    JSON.stringify({date: '2026-10-22', moved: {'docs/review/OLD.md': 'docs/records/OLD.md'}}),
  );
  write(root, 'docs/GUIDE.md', '# Guide\n\n' + long + '\n');
  write(
    root,
    'docs/OTHER.md',
    '# Other\n\n## Batch 12 — a delivery\n\nFixed at `60ec2cc`; the matrix stays 13/14/1.\n\n' + long + '\n',
  );
  write(root, 'docs/records/DELIVERY-2026-10-01-X.md', '# Record\n\n## Batch 12\n\n13/14/1\n\n' + long + '\n');
  write(root, 'docs/archive/OLD-REVIEW.md', '# Old\n\n' + long + '\n');
  write(root, 'docs/review/OLD.md', '# Moved: Old\n\n' + long + '\n');
  write(root, 'docs/GENERATED.md', '# Generated page\n\nGenerated by a tool.\n\n## Batch 3\n\n' + long + '\n');
  // In code, a heading or a long line is not prose.
  write(root, 'docs/CODE.md', '# Code\n\n```\n## Batch 9\n' + long + '\n```\n');
  assert.deepEqual(currentPages(root), ['README.md', 'docs/CODE.md', 'docs/GUIDE.md', 'docs/OTHER.md']);
  assert.deepEqual(measure(root).counts, {
    'README.md': {batch_headings: 0, commit_refs: 0, duplicate_lines: 0, package_counts: 0},
    'docs/CODE.md': {batch_headings: 0, commit_refs: 0, duplicate_lines: 0, package_counts: 0},
    'docs/GUIDE.md': {batch_headings: 0, commit_refs: 0, duplicate_lines: 1, package_counts: 0},
    'docs/OTHER.md': {batch_headings: 1, commit_refs: 1, duplicate_lines: 1, package_counts: 1},
  });
  const problems = lintProblems(root, {pages: {}});
  assert.equal(problems.length, 5);
  assert.match(
    problems.find(p => p.startsWith('docs/GUIDE.md')),
    /repeated on another current page.*is also in docs\/OTHER\.md/,
  );
  assert.ok(problems.some(p => p.startsWith('docs/OTHER.md: 1 headings naming a batch')));
  assert.ok(problems.some(p => p.startsWith('docs/OTHER.md: 1 commit references')));
  assert.ok(
    problems.some(p => p.startsWith('docs/OTHER.md: 1 literal package counts (link docs/review/PACKAGE-STATUS')),
  );
  // The first record of a tree takes the counts as they are; after that they may only fall.
  assert.deepEqual(writeBaseline(root), [
    'docs/GUIDE.md duplicate_lines 0 → 1',
    'docs/OTHER.md batch_headings 0 → 1',
    'docs/OTHER.md commit_refs 0 → 1',
    'docs/OTHER.md duplicate_lines 0 → 1',
    'docs/OTHER.md package_counts 0 → 1',
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
  write(root, 'docs/GUIDE.md', '# Guide\n\nThe packages stand at 13 implemented /\n14 partial / one open.\n');
  assert.deepEqual(
    lintProblems(root).filter(p => p.startsWith('docs/GUIDE.md')),
    [
      'docs/GUIDE.md: 1 literal package counts (link docs/review/PACKAGE-STATUS.md, generated from the package status, instead), above 0',
    ],
  );
});

/** A page with front matter and about `words` words of prose in short lines (no line is a long line). */
const sized = (status, tier, words, mark = 'w') => {
  const body = Array.from({length: words - 2}, (_, i) => mark + i),
    lines = [];
  for (let i = 0; i < body.length; i += 8) lines.push(body.slice(i, i + 8).join(' '));
  return '---\nstatus: ' + status + '\ntier: ' + tier + '\n---\n\n# Page\n\n' + lines.join('\n') + '\n';
};

// DOC-03, the consolidation of 2026-10-24: the size targets are enforced, not only measured. The owner and operator
// tiers' current pages keep within the review's about 25,000 words, the duplicate-line share stays under 5%, and the
// reference pages (the engineering tier, and the owner and operator references) keep within the total the baseline
// records, which may only fall unless an increase is recorded with its reason. Before, the lint reported the word
// count and refused nothing, so a current page could grow without limit or leave the budget for a reference page.
test('the budget, the duplicate-line share and the recorded reference total are enforced; an increase needs its reason', t => {
  const root = temporary(t);
  write(root, 'README.md', '# Repo\n\nA short landing page.\n');
  write(root, 'docs/GUIDE.md', sized('current', 'operator', 24000, 'g'));
  write(root, 'docs/owner/README.md', sized('current', 'owner', 500, 'o'));
  write(root, 'docs/ENGINEERING.md', sized('reference', 'engineering', 1000, 'e'));
  write(root, 'docs/WORKFLOW.md', sized('reference', 'operator', 600, 'f'));
  write(root, 'docs/records/RECORD-2026-10-01.md', sized('record', 'operator', 9000, 'r'));
  let s = summary(root);
  assert.deepEqual(
    [s.budget_words, s.reference_words, s.engineering_words, s.operator_reference_words],
    [24506, 1600, 1000, 600],
    'records are outside both totals',
  );
  // No baseline yet: the budget and the duplicate share are checked, there is no recorded total to compare.
  assert.deepEqual(budgetProblems(root), []);
  writeBaseline(root);
  assert.equal(readBaseline(root).totals.reference_words, 1600);
  // A current page that grows past the budget is refused.
  write(root, 'docs/GUIDE.md', sized('current', 'operator', 24600, 'g'));
  assert.deepEqual(budgetProblems(root), [
    'the owner and operator current pages hold 25106 words, above their budget of 25000: move detail to a reference page or a record, or shorten them',
  ]);
  // Calling it a reference page moves its words to the reference total, which is above what the baseline records.
  write(root, 'docs/GUIDE.md', sized('reference', 'operator', 24600, 'g'));
  s = summary(root);
  assert.deepEqual([s.budget_words, s.reference_words], [506, 26200]);
  assert.deepEqual(budgetProblems(root), [
    'the reference pages (engineering, and the owner and operator references) hold 26200 words, above the 1600 recorded in tools/docs-lint-baseline.json: shorten them, or record why with node tools/docs-lint.mjs --write --allow-increase=<reason>',
  ]);
  assert.throws(() => writeBaseline(root), /reference_words 1600 → 26200[\s\S]*--allow-increase/);
  writeBaseline(root, 'the guide is detail operators consult on demand');
  assert.deepEqual(readBaseline(root).increases, [
    {reason: 'the guide is detail operators consult on demand', raised: ['reference_words 1600 → 26200']},
  ]);
  assert.deepEqual(budgetProblems(root), []);
  // Shortening lowers the record on the next write, which needs no reason; growing again is refused.
  write(root, 'docs/GUIDE.md', sized('reference', 'operator', 20000, 'g'));
  writeBaseline(root);
  assert.equal(readBaseline(root).totals.reference_words, 21600);
  write(root, 'docs/ENGINEERING.md', sized('reference', 'engineering', 1100, 'e'));
  assert.equal(budgetProblems(root).length, 1);
  write(root, 'docs/ENGINEERING.md', sized('reference', 'engineering', 1000, 'e'));
  assert.deepEqual(budgetProblems(root), []);
  // The duplicate-line share: one long line of two maintained pages out of three long lines is not under 5%.
  write(root, 'docs/ENGINEERING.md', sized('reference', 'engineering', 1000, 'e') + '\n' + long + '\n');
  write(root, 'docs/WORKFLOW.md', sized('reference', 'operator', 600, 'f') + '\n' + long + '\n');
  write(
    root,
    'docs/owner/README.md',
    sized('current', 'owner', 500, 'o') + '\nThis owner line is long enough to count, at seventy characters or more.\n',
  );
  s = summary(root);
  assert.deepEqual([s.long_lines, s.duplicate_lines], [3, 2]);
  assert.ok(
    budgetProblems(root).includes(
      'the duplicate-line share is 66.7%, not under 5%: keep each fact in one place and link to it',
    ),
  );
});

// The integration of DOC-01 with DOC-03: the decision record's rows name the commits a decision governs (the
// 2026-10-18 push, the two Railway fixes and the deployed revision), so counting them as delivery history refused the
// decision record itself. Its commit references are not counted; every other rule still applies to it, and every
// other current page still names a revision only through a dated record.
test('the decision record may cite the commits its decisions govern; its other rules and other pages are unchanged', t => {
  assert.deepEqual(commitRecordPages, ['docs/DECISIONS.md']);
  const root = temporary(t);
  write(root, 'README.md', '# Repo\n\nDeployed at `cb338f68` ([record](docs/records/DEPLOYMENT-2026-10-18.md)).\n');
  write(
    root,
    'docs/DECISIONS.md',
    '# Decisions\n\n| 2026-10-18 | Pushed at `5db67a71`; fixed in `998d711a` and `cb338f68` |\n\n' +
      '## Batch 7 — a delivery\n\nThe matrix stays 13/14/1.\n',
  );
  write(root, 'docs/records/DEPLOYMENT-2026-10-18.md', '# Deployment\n\nPushed at `5db67a71`.\n');
  assert.deepEqual(measure(root).counts['docs/DECISIONS.md'], {
    batch_headings: 1,
    commit_refs: 0,
    duplicate_lines: 0,
    package_counts: 1,
  });
  assert.deepEqual(lintProblems(root, {pages: {}}), [
    'README.md: 1 commit references (a current page says what is true now; cite a record instead), above 0',
    'docs/DECISIONS.md: 1 headings naming a batch (move the delivery history to docs/records/), above 0',
    'docs/DECISIONS.md: 1 literal package counts (link docs/review/PACKAGE-STATUS.md, generated from the package status, instead), above 0',
  ]);
  // The repository's decision record does cite commits, so the exemption is exercised and not dead.
  assert.match(fs.readFileSync('docs/DECISIONS.md', 'utf8'), /`(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,12}`/);
  assert.equal(measure('.').counts['docs/DECISIONS.md'].commit_refs, 0);
});

test('a package count is three numbers that add up to the 28 packages, or the counts in words', () => {
  for (const text of [
    '13/14/1',
    'the matrix stays 13/15/0.',
    '(13 / 14 / 1)',
    '13 implemented / 14 partial / one open',
    '13 implemented/14 partial/1 open',
    '13 implemented\n/ 14 partial / one open',
  ])
    assert.equal(packageCounts(text), 1, text);
  // Other numbers with slashes are not package counts: another sum, a longer chain, a date, an ID or a version.
  for (const text of ['20/0/0', '1/2/3', '13/14/1/2', '2026/10/23', 'B13/14/1', 'v13/14/1', '13/14/1-2', '0.13/14/1'])
    assert.equal(packageCounts(text), 0, text);
  assert.equal(packageCounts('13/14/1 then 13/15/0 and 13 implemented / 15 partial / zero open'), 3);
});

// P2C-04 (differential review, wave 5 round 2 part 2c): the V2 plan numbers its decisions D1 to D26, and the V2 records cited them as
// `(D20)`, `(D26)` and `(C11)`, where docs/DECISIONS.md defines D20 as "Conditional-program observations" and D26 as "Test tooling" (the
// 2026-10-08 engineering review numbers its questions D1 to D27), and docs/acceptance/ASSISTIVE-TECHNOLOGY.md defines C11 as the NVDA
// keyboard criterion. A reader who followed "no staging (D20)" found another decision, so the statements that no live check has run
// and that staging is blocked could not be traced to the owner's words. A citation that means the plan's is written `V2 plan D20`; an
// unqualified `(Dnn)` must name the subject of its row in docs/DECISIONS.md; an unqualified `(Cnn)` is a criterion of the
// assistive-technology page, and only that page may write one.
const ledger = [
  '# Decisions',
  '',
  '| ID | Decision | Outcome |',
  '|---|---|---|',
  '| D3 | Product audience, registration and legal identity | Accepted (a): the operator legal identity and the legal pages. |',
  '| D20 | Conditional-program observations | Accepted: retain them as timestamped "not a grant" records. |',
  '| D26 | Test tooling | Accepted: an architecture ratchet that blocks only regressions. |',
].join('\n');

test('an unqualified decision citation whose row has another subject is refused; "V2 plan Dnn" and a citation that names its row’s subject are not (P2C-04)', t => {
  const root = temporary(t);
  write(root, 'docs/DECISIONS.md', ledger + '\n');
  write(
    root,
    'docs/records/V2-QUALIFICATION.md',
    [
      '# Record',
      '',
      'Live checks are blocked: no staging (D20).',
      'Live checks are blocked: no staging (V2 plan D20).',
      'The V2 server keeps a per-client contract profile (D26), which the review calls test tooling.',
      'Spend 0 marked `provider_omitted` for a row with no delivery (D3).',
      '```',
      'a fenced example is not prose: (D20)',
      '```',
      '',
    ].join('\n'),
  );
  write(
    root,
    'docs/OPERATIONS.md',
    [
      '# Operations',
      '',
      'The owner approved the legal pages (D3).',
      'Retain the timestamped observation of a conditional program, never a grant (D20).',
      'The architecture ratchet blocks only regressions (D26).',
      'The review of the plan answers an unknown question (D99).',
      '',
    ].join('\n'),
  );
  const problems = citationProblems(root);
  assert.equal(problems.length, 4, problems.join('\n'));
  // The file and the line, the row the citation lands on, and what to write if the plan's decision is meant.
  assert.ok(
    problems.some(p =>
      /^docs\/records\/V2-QUALIFICATION\.md:3: \(D20\) is "Conditional-program observations" in docs\/DECISIONS\.md/.test(
        p,
      ),
    ),
    problems.join('\n'),
  );
  assert.ok(
    problems.every(p => p.startsWith('docs/')),
    problems.join('\n'),
  );
  assert.ok(problems.find(p => p.includes('(D20)')).includes('write "V2 plan D20"'), problems.join('\n'));
  // A sentence that cites a row by words of another subject is refused even where the word `test tooling` follows the citation.
  assert.ok(
    problems.some(p => p.includes(':5: (D26) is "Test tooling"')),
    problems.join('\n'),
  );
  // The same sentence about spend 0 cites D3, whose row is about the audience and the legal identity.
  assert.ok(
    problems.some(p => p.includes(':6: (D3) is "Product audience, registration and legal identity"')),
    problems.join('\n'),
  );
  // An id that is no row of the decision record.
  assert.ok(
    problems.some(p => /^docs\/OPERATIONS\.md:6: \(D99\) is not a decision of docs\/DECISIONS\.md/.test(p)),
    problems.join('\n'),
  );
  // lintProblems reports them with the rest of the freeze.
  assert.ok(lintProblems(root, {pages: {}}).some(p => p.includes('(D20) is "Conditional-program observations"')));
});

test('an unqualified criterion citation is refused on every page but the assistive-technology one, and a tree without the decision record is not judged (P2C-04)', t => {
  const root = temporary(t);
  write(root, 'docs/DECISIONS.md', ledger + '\n');
  write(root, 'docs/records/V2-QUALIFICATION.md', '# Record\n\nLive deployment is the owner’s deferral (C11).\n');
  write(
    root,
    'docs/acceptance/ASSISTIVE-TECHNOLOGY.md',
    '# Assistive technology\n\nThe journey completes without a mouse (C11); the validation message is announced (C7).\n',
  );
  const problems = citationProblems(root);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(
    problems[0],
    /^docs\/records\/V2-QUALIFICATION\.md:3: \(C11\) is a criterion of docs\/acceptance\/ASSISTIVE-TECHNOLOGY\.md, which this page is not/,
  );
  // Without docs/DECISIONS.md there is no row to compare with, as in a partial tree.
  fs.rmSync(path.join(root, 'docs/DECISIONS.md'));
  assert.deepEqual(citationProblems(root), []);
});

test('each subject names its own row in docs/DECISIONS.md, so the table cannot drift from the record, and the repository cites by it (P2C-04)', () => {
  const rows = decisionRows('.');
  assert.deepEqual(
    [...rows.keys()],
    Array.from({length: 27}, (_, i) => 'D' + (i + 1)),
    'the rows D1 to D27 of the decision record',
  );
  assert.deepEqual(Object.keys(decisionSubjects).sort(), [...rows.keys()].sort());
  for (const [id, row] of rows) assert.match(row.text, decisionSubjects[id], id + ': ' + row.title);
  // Every citation of the repository: qualified as the plan's, or about the subject of its row.
  assert.deepEqual(citationProblems('.'), []);
});

test('each id of a parenthesised list is judged by itself, and a date after an id is not an id (P2C-04)', t => {
  const root = temporary(t);
  write(root, 'docs/DECISIONS.md', ledger + '\n');
  write(
    root,
    'docs/records/V2-QUALIFICATION.md',
    [
      '# Record',
      '',
      'The owner approved the legal pages and live checks are blocked (D3, D20).',
      'Live deployment is deferred (D20, 2026-11-03: "leave the live deployment for now").',
      'The owner approved the legal pages (D3; V2 plan D20).',
      '',
    ].join('\n'),
  );
  // D3 names its subject on line 3 and passes there; D20 does not, so only D20 is refused, on lines 3 and 4. Line 5 qualifies its second id.
  assert.deepEqual(
    citationProblems(root).map(problem => problem.split(' is ')[0]),
    ['docs/records/V2-QUALIFICATION.md:3: (D20)', 'docs/records/V2-QUALIFICATION.md:4: (D20)'],
  );
});
