// DOC-02: one status label collapsed source completeness, provider eligibility, blocked live acceptance and optional
// expansion, so no package could ever close. The status data reports three separate axes, cites test files that
// exist, names finite remainders, and generates a byte-identical table checked by docs:index:check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {
  manualStates,
  nativeStates,
  packageStatusTable,
  renderPackageStatus,
  statusFile,
  tableFile,
  validatePackageStatus,
} from '../tools/package-status.mjs';

const data = () => JSON.parse(fs.readFileSync(statusFile, 'utf8'));
const problems = mutate => {
  const copy = data();
  mutate(copy);
  return validatePackageStatus(copy, process.cwd());
};

test('the committed status validates, cites existing test files and generates the committed table byte for byte', () => {
  const {problems: found, table} = packageStatusTable(process.cwd());
  assert.deepEqual(found, []);
  assert.equal(fs.readFileSync(tableFile, 'utf8'), table);
  assert.equal(renderPackageStatus(data()), renderPackageStatus(data()));
  const status = data();
  assert.deepEqual(
    status.packages.map(p => p.id),
    Array.from({length: 28}, (_, i) => 'B' + String(i + 1).padStart(2, '0')),
  );
  for (const p of status.packages) {
    for (const file of p.source.tests) assert.ok(fs.existsSync(file), p.id + ' ' + file);
    // A package that is not source-met always names what is missing and where the remainder goes.
    if (!p.source.met) assert.ok(p.source.gap && p.remainders.length, p.id);
  }
  // The axes are counted separately; no single "done" figure is published.
  assert.match(table, /\| Source acceptance \(of 28\) \| met \d+ · not met \d+ \|/);
  assert.match(table, new RegExp('\\| Native/live acceptance \\| ' + nativeStates.map(s => s + ' \\d+').join(' · ')));
  assert.match(
    table,
    new RegExp('\\| Manual/deployed acceptance \\| ' + manualStates.map(s => s + ' \\d+').join(' · ')),
  );
  assert.doesNotMatch(table, /\b\d+ (?:done|complete|implemented) \/ \d+/i);
});

test('the validator refuses unsupported claims and open-ended remainders', () => {
  const first = p => p.packages[0],
    unmet = p => p.packages.find(x => !x.source.met);
  const cases = [
    ['source met without tests', p => (first(p).source.tests = []), /cites at least one test file/],
    ['a test file that does not exist', p => first(p).source.tests.push('tests/missing.test.mjs'), /does not exist/],
    ['source met without a commit', p => delete first(p).source.commit, /commit/],
    ['an unknown native state', p => (first(p).native.state = 'live'), /native\.state/],
    ['read-verified without evidence', p => (first(p).native.state = 'read_verified'), /native read_verified cites/],
    ['manual accepted without evidence', p => (first(p).manual.state = 'accepted'), /manual accepted cites/],
    ['not met without a gap', p => delete unmet(p).source.gap, /names the gap/],
    ['not met without remainders', p => (unmet(p).remainders = []), /names its finite remainders/],
    ['a remainder without a canonical reference', p => (first(p).remainders[0].ref = 'later'), /not a register item/],
    ['an unknown disposition', p => (first(p).remainders[0].disposition = 'someday'), /disposition/],
    ['a missing package', p => p.packages.pop(), /B01 to B28/],
    [
      'an unlisted finite package',
      p => (first(p).remainders[0] = {text: 'x', disposition: 'finite_package', ref: 'B40'}),
      /not a listed finite package/,
    ],
    [
      'an orphaned finite package',
      p => (p.finite_packages[0].id = 'B39'),
      /no package remainder points|not a listed finite/,
    ],
  ];
  for (const [label, mutate, pattern] of cases) {
    const found = problems(mutate);
    assert.ok(
      found.some(problem => pattern.test(problem)),
      label + ': ' + found.join('; '),
    );
  }
});

/** The first cell of each body row of the first table after `heading` in a Markdown file. */
const firstCells = (file, heading) => {
  const lines = fs.readFileSync(file, 'utf8').split('\n'),
    start = lines.findIndex(l => l.startsWith(heading)),
    cells = [];
  assert.ok(start >= 0, file + ' ' + heading);
  let i = start + 1;
  while (i < lines.length && !lines[i].startsWith('|')) i++;
  for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) cells.push(lines[i].split('|')[1].trim());
  return cells;
};
const tableRows = (file, heading) => {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let i = lines.findIndex(l => l.startsWith(heading));
  assert.ok(i >= 0, file + ' ' + heading);
  while (!lines[i].startsWith('|')) i++;
  const rows = [];
  for (i += 2; i < lines.length && lines[i].startsWith('|'); i++)
    rows.push(
      lines[i]
        .split('|')
        .slice(1, -1)
        .map(c => c.trim()),
    );
  return rows;
};

test('every earlier recommendation and every review decision D1-D27 has exactly one recorded disposition', () => {
  const decisions = 'docs/DECISIONS.md',
    dispositions = tableRows(decisions, '## Dispositions of earlier recommendations');
  const sources = [
    ['Review §5', firstCells('docs/review/REVIEW-2026-10-01.md', '## 5. ')],
    ['Review §6.13', firstCells('docs/review/REVIEW-2026-10-01.md', '### 6.13 ')],
    ['UX §3', firstCells('docs/review/product/UX-2026-10-01.md', '## 3. ')],
  ];
  for (const [source, items] of sources) {
    assert.ok(items.length >= 10, source);
    for (const item of items) {
      const rows = dispositions.filter(([s, recommendation]) => s === source && recommendation.startsWith(item));
      assert.equal(rows.length, 1, source + ': ' + item);
      assert.match(rows[0][2], /^(?:Accepted|Declined|Deferred|Implemented|Partly implemented|Replaced|Theme)/);
    }
  }
  // The commitments D25 names as dropped without a decision each have a row.
  for (const dropped of [
    /identifier-error matrix/,
    /^Owner-run acceptance kit/,
    /^Refusal analytics/,
    /^Success-measure baselines/,
    /^Per-account personal-data control/,
    /integrated cross-provider usage view/,
    /complete audit telemetry/,
    /"measured"/,
    /^Separate concise entry points/,
  ])
    assert.equal(dispositions.filter(([, r]) => dropped.test(r)).length, 1, String(dropped));
  // The identifier-error matrix is either declined or has a test file that exists.
  const matrix = dispositions.find(([, r]) => /identifier-error matrix/.test(r));
  const cited = /`(tests\/[\w.-]+\.test\.(?:mjs|ts))`/.exec(matrix[2]);
  assert.ok(/^Declined/.test(matrix[2]) || (cited && fs.existsSync(cited[1])), matrix[2]);
  const review = tableRows(decisions, '## 2026-10-09: engineering review decisions');
  assert.deepEqual(
    review.map(r => r[0]),
    Array.from({length: 27}, (_, i) => 'D' + (i + 1)),
  );
  for (const row of review) assert.match(row[2], /^Accepted/, row[0]);
});

// The owner approved the product-direction choices P1-P12 on 2026-10-11, but the record still listed P1, P11 and P12
// as not decided and the next P7 packs as pending while the code cited them as owner decisions. Every P row is now
// approved and none is left open anywhere in the record, beside the Zoho CRM scope (2026-10-13) and the instruction
// to push after wave 4 (2026-10-17); the release notes name the behaviour P2, P5 and P9 change.
test('every product-direction choice P1-P12 is recorded as approved on 2026-10-11 and none is left pending (regression: P1, P11 and P12 not decided, P7 pending)', () => {
  const decisions = 'docs/DECISIONS.md',
    text = fs.readFileSync(decisions, 'utf8'),
    rows = tableRows(decisions, '## 2026-10-11: product direction P1–P12'),
    open = /\bpending\b|\bnot decided\b|\bawaits?\b|until the owner (?:answers|decides|chooses)/i;
  assert.deepEqual(
    rows.map(r => r[0]),
    Array.from({length: 12}, (_, i) => 'P' + (i + 1)),
  );
  for (const row of rows) {
    assert.equal(row.length, 5, row[0]);
    assert.match(row[2], /^Approved: /, row[0]);
    assert.ok(row[3].length > 0 && row[4].length > 0, row[0] + ' names where the code stands and what it governs');
    assert.doesNotMatch(row.join(' '), open, row[0]);
  }
  // No recorded outcome elsewhere leaves a product-direction choice open: the Outcome cell of every decision table that
  // names a P choice. (Only outcomes: other prose may say what work still awaits, for example a P4 rehearsal path.)
  const lines = text.split('\n');
  let outcomes = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('|') || !lines[i + 1]?.startsWith('|---')) continue;
    const column = lines[i]
      .split('|')
      .slice(1, -1)
      .findIndex(c => /^Outcome\b/.test(c.trim()));
    if (column < 0) continue;
    for (let j = i + 2; j < lines.length && lines[j].startsWith('|'); j++) {
      const cell = lines[j].split('|').slice(1, -1)[column]?.trim() ?? '';
      if (!/\bP(?:[1-9]|1[0-2])\b/.test(cell)) continue;
      outcomes++;
      assert.doesNotMatch(cell, open, cell);
    }
  }
  assert.ok(outcomes > 0, 'outcome cells name P choices');
  // Zoho CRM feeds the ad platforms only, read-only on Zoho, through the reviewed write engine.
  const [zoho, ...more] = tableRows(decisions, '## 2026-10-13: Zoho CRM scope');
  assert.equal(more.length, 0);
  assert.match(zoho[1], /^Accepted: CRM to ads only\./);
  assert.match(zoho[1], /leads, contacts and deals read-only/);
  assert.match(zoho[1], /only through the existing reviewed write engine/);
  assert.match(zoho[1], /Nothing is written to Zoho\./);
  // The push follows wave 4.
  const push = tableRows(decisions, '## October 2026: delivery instructions').find(r => r[0] === '2026-10-17');
  assert.ok(push, 'the 2026-10-17 instruction has a row');
  assert.match(push[1], /wave 4 \(documentation\), then push to git/);
  assert.match(push[2], /^Accepted: the push to `Work-here` follows wave 4/);
  // The release notes call out each default wave 3b changes for existing workspaces.
  const start = text.indexOf('### Release notes for the push after wave 4'),
    notes = text.slice(start, text.indexOf('\n## ', start));
  assert.ok(start > 0);
  for (const [id, code] of [
    ['P2', /7 days instead of 72 hours/],
    ['P5', /CAP_OVERRIDE_OWNER_REQUIRED/],
    ['P5', /POLICY_CURRENCY_UNSET/],
    ['P9', /`unknown`/],
  ]) {
    assert.match(notes, new RegExp('\\(' + id + '\\)\\.\\*\\*'), id);
    assert.match(notes, code, id);
  }
});

test('docs:index:check validates the status data and the generated table without writing anything', () => {
  const before = fs.readFileSync(tableFile, 'utf8'),
    run = spawnSync(process.execPath, ['tools/docs-index.mjs', '--check'], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(tableFile, 'utf8'), before);
  // The standalone check compares the same bytes.
  const standalone = spawnSync(process.execPath, ['tools/package-status.mjs', '--check'], {encoding: 'utf8'});
  assert.equal(standalone.status, 0, standalone.stderr);
});
