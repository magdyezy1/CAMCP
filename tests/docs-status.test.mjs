// DOC-03: docs/STATUS.md answers where AMCP stands, generated from its sources, so no status is typed by hand: the
// three-axis package status (docs/review/package-status.json, DOC-02), the product facts written from the code
// (DOC-01), the provider access register (ACC-05) and the latest dated qualification record (QA-01). Before, there
// was no status page; the first "start here" document was a hand-written readiness page in release-engineering
// language. `npm run docs:index` writes the page and `npm run docs:index:check` fails when it is stale.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {latestQualification, statusPage, statusProblems, statusText} from '../tools/docs-status.mjs';
import {docFacts} from '../tools/doc-facts.mjs';
import {frontMatter} from '../tools/docs-front-matter.mjs';
import {currentPages} from '../tools/docs-lint.mjs';
import {removeTestDirectory} from '../dist/tests/temp.js';

let collected;
/** The facts of the committed tree, collected once (a child process builds the tool surface). */
const facts = () => {
  if (!collected) {
    const result = docFacts('.');
    assert.deepEqual(result.problems, []);
    collected = result.facts;
  }
  return collected;
};
const temporary = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-docs-status-'));
  t.after(() => removeTestDirectory(directory, 'amcp-docs-status-'));
  return directory;
};
const write = (root, file, data) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
  fs.writeFileSync(path.join(root, file), typeof data === 'string' ? data : JSON.stringify(data));
};
const record = (title, result) =>
  '---\nstatus: record\ntier: operator\n---\n\n# ' +
  title +
  '\n\nWhat ran.\n\n## Runs\n\n| Run | Result |\n| --- | --- |\n| Release gate | ' +
  result +
  ' |\n\n## Notes\n\nKept as written.\n';
/** A synthetic tree with the four sources the status page reads. */
function tree(t) {
  const root = temporary(t),
    pkg = (id, met, native, manual, remainders) => ({
      id,
      source: {met},
      native: {state: native},
      manual: {state: manual},
      remainders,
    });
  write(root, 'docs/review/package-status.json', {
    as_of: '2026-10-20',
    packages: [
      pkg('B01', true, 'none', 'not_recorded', []),
      pkg('B02', false, 'read_verified', 'pending_owner', [
        {disposition: 'register_item'},
        {disposition: 'owner_action'},
      ]),
    ],
  });
  write(root, 'docs/implementation/ACTION-CONTRACT-COVERAGE.json', {
    acceptance_layers: {
      catalog: 3000,
      pinned: 2900,
      locally_qualified: 2500,
      read_accepted: 4,
      write_accepted: 1,
      refused: 2,
      stale: 0,
    },
  });
  write(root, 'src/provider-access.json', {
    providers: {meta: {approvals: [{status: 'undeclared'}, {status: 'declared'}]}, x: {approvals: []}},
  });
  write(root, 'docs/records/QUALIFICATION-4a-2026-10-18.md', record('Wave 4a qualification', 'Passed earlier'));
  write(root, 'docs/records/QUALIFICATION-4b-2026-10-24.md', record('Wave 4b qualification', 'Passed'));
  write(root, 'docs/records/DEPLOYMENT-2026-10-30.md', record('A deployment, not a qualification', 'Deployed'));
  return root;
}

test('the committed status page is what its sources say now, and it is generated, not maintained', () => {
  assert.deepEqual(statusProblems('.', facts()), []);
  const page = fs.readFileSync(statusPage, 'utf8');
  assert.equal(frontMatter(page).data.generated, 'tools/docs-status.mjs');
  assert.ok(!currentPages('.').includes(statusPage), 'the freeze and the budget read no generated page');
  // The package axes are counted from the status data, each on its own.
  const data = JSON.parse(fs.readFileSync('docs/review/package-status.json', 'utf8')),
    met = data.packages.filter(p => p.source.met).length;
  assert.ok(
    page.includes(
      '| Source acceptance (of ' +
        data.packages.length +
        ') | met ' +
        met +
        ' · not met ' +
        (data.packages.length - met) +
        ' |',
    ),
  );
  assert.ok(page.includes('Status as of ' + data.as_of + ' '));
  const latest = latestQualification('.');
  assert.ok(page.includes('](' + path.posix.relative('docs', latest.file) + '), ' + latest.date + '.'));
});

test('the page follows its sources: each axis, provider access, the ledger and the newest qualification record', t => {
  const root = tree(t),
    text = statusText(root, facts());
  for (const line of [
    'Status as of 2026-10-20 (owner decision D25). Each axis is counted on its own; a documented blocker never completes one.',
    '| Source acceptance (of 2) | met 1 · not met 1 |',
    '| Native/live acceptance | none 1 · read verified 1 · write verified 0 |',
    '| Manual/deployed acceptance | not recorded 1 · pending owner 1 · accepted 0 · amended 0 |',
    '| Open remainders | 2: register item 1 · owner action 1 |',
    '| Provider approvals declared | 2 across 2 providers: declared 1 · undeclared 1 |',
    '| Ledger actions: catalog · pinned · locally qualified | 3,000 · 2,900 · 2,500 |',
    '| Ledger actions: read-accepted · write-accepted · refused · stale | 4 · 1 · 2 · 0 |',
    // The newest qualification record by the date in its name, with its runs as written; a deployment record is not one.
    '[Wave 4b qualification](records/QUALIFICATION-4b-2026-10-24.md), 2026-10-24.',
    '| Release gate | Passed |',
  ])
    assert.ok(text.split('\n').includes(line), line);
  assert.ok(!text.includes('Passed earlier') && !text.includes('Deployed') && !text.includes('Kept as written'));
  assert.match(text, /^---\nstatus: current\ntier: operator\ngenerated: tools\/docs-status\.mjs\n---\n\n# Status\n/);
});

test('a changed source makes the page stale until it is written; with no record the page says so', t => {
  const root = tree(t);
  assert.deepEqual(statusProblems(root, facts()), [
    statusPage + ' is out of date. Run npm run build, then npm run docs:index.',
  ]);
  assert.deepEqual(statusProblems(root, facts(), {write: true}), []);
  assert.deepEqual(statusProblems(root, facts()), []);
  // A package's manual acceptance is recorded: the page is stale until docs:index writes it again.
  const file = path.join(root, 'docs/review/package-status.json'),
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.packages[0].manual.state = 'accepted';
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal(statusProblems(root, facts()).length, 1);
  statusProblems(root, facts(), {write: true});
  assert.ok(
    fs
      .readFileSync(path.join(root, statusPage), 'utf8')
      .includes('| Manual/deployed acceptance | not recorded 0 · pending owner 1 · accepted 1 · amended 0 |'),
  );
  // A newer qualification record replaces the older one on the page.
  write(root, 'docs/records/QUALIFICATION-4c-2026-10-26.md', record('Wave 4c qualification', 'Passed again'));
  assert.equal(statusProblems(root, facts()).length, 1);
  assert.equal(latestQualification(root).file, 'docs/records/QUALIFICATION-4c-2026-10-26.md');
  // Without any qualification record the page says there is none; an unreadable source is a problem, not a page.
  for (const name of fs.readdirSync(path.join(root, 'docs/records'))) fs.rmSync(path.join(root, 'docs/records', name));
  assert.ok(statusText(root, facts()).includes('No qualification record in `docs/records/` yet.'));
  fs.writeFileSync(file, '{');
  assert.match(statusProblems(root, facts())[0], /^status page: /);
});
