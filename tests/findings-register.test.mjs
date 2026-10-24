// DOC-03: the findings register is data (docs/review/findings.json) with two generated views. Before, it was a
// hand-written page: its later findings were prose paragraphs, nothing listed what was still open, and a finding's
// status lived only in its sentence. tools/findings-register.mjs validates the register and writes the open view
// (docs/review/FINDINGS.md) and the closed view (docs/review/FINDINGS-CLOSED.md); `npm run docs:index:check` fails when
// either differs from the register.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  closedView,
  closedViewText,
  findingsProblems,
  isOpen,
  openView,
  openViewText,
  registerFile,
  registerProblems,
  summaryOf,
} from '../tools/findings-register.mjs';
import {frontMatter} from '../tools/docs-front-matter.mjs';
import {currentPages} from '../tools/docs-lint.mjs';
import {removeTestDirectory} from '../dist/tests/temp.js';

const register = JSON.parse(fs.readFileSync(registerFile, 'utf8')),
  openText = fs.readFileSync(openView, 'utf8'),
  closedText = fs.readFileSync(closedView, 'utf8');
const flat = text => String(text).replace(/\s*\n\s*/g, ' ');

/** A small register: one closed table finding, one open table finding, one open paragraph finding with a note. */
function sample() {
  return {
    schema_version: 1,
    meaning: 'A synthetic register.',
    intro: ['The review of a synthetic branch.'],
    states: {open: ['partial', 'planned'], closed: ['fixed', 'implemented']},
    groups: [
      {id: 'areas', title: 'Review by area', intro: ['Found by area.']},
      {
        id: 'later',
        title: 'Later deliveries',
        intro: [],
        notes: [{after: 'F-3', text: '**A note:** recorded after F-3.'}],
      },
    ],
    findings: [
      {
        id: 'F-1',
        severity: 'high',
        area: 'Money',
        group: 'areas',
        found_against: 'abc1234',
        finding: 'A cap is not counted',
        evidence: '`src/a.ts:1`',
        recommendation: 'Count it',
        effort: 'S',
        status: 'fixed',
        resolution: 'fixed (counted)',
      },
      {
        id: 'F-2',
        severity: 'medium',
        area: 'Money',
        group: 'areas',
        found_against: 'abc1234',
        finding: 'A total is not counted',
        evidence: '`src/b.ts:2`',
        failure_scenario: 'A total passes the cap',
        recommendation: 'Count totals',
        effort: 'M',
        status: 'implemented',
        resolution: 'implemented: totals; acceptance open',
        remaining: 'live acceptance (owner-run)',
      },
      {
        id: 'F-3',
        severity: 'low',
        area: 'Delivery batches',
        group: 'later',
        text: '**F-3 (low, S, partial):** The page reflows at 320 pixels. A guard now\nmeasures it.',
        status: 'partial',
      },
    ],
    controls_verified: 'Session cookies; CSRF.',
  };
}
const temporary = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-findings-'));
  t.after(() => removeTestDirectory(directory, 'amcp-findings-'));
  return directory;
};

test('the repository register validates and both views are generated from it, never edited by hand', () => {
  assert.deepEqual(registerProblems(register), []);
  assert.deepEqual(findingsProblems('.'), [], 'the views are the register as it is now (npm run docs:index)');
  for (const text of [openText, closedText])
    assert.equal(frontMatter(text).data.generated, 'tools/findings-register.mjs');
  // Generated pages are no maintained pages: the freeze and the size report read the register's views as data.
  const pages = currentPages('.');
  assert.ok(!pages.includes(openView) && !pages.includes(closedView));
  // The register kept every finding of the hand-written page (266, F-01 to F-245 with its prefixed IDs).
  assert.equal(register.findings.length, 266);
  assert.equal(new Set(register.findings.map(f => f.id)).size, 266);
});

test('every finding is in exactly one view, and the open view holds each open finding in full', () => {
  const open = register.findings.filter(f => isOpen(register, f)),
    closed = register.findings.filter(f => !isOpen(register, f));
  assert.ok(open.length > 0 && closed.length > 0);
  const counts = /^\| Open \|.* \| (\d+) \|$/m.exec(openText),
    closedCounts = /^\| Closed \|.* \| (\d+) \|$/m.exec(openText);
  assert.equal(Number(counts[1]), open.length);
  assert.equal(Number(closedCounts[1]), closed.length);
  for (const f of open) {
    assert.ok(openText.includes('\n### ' + f.id + ' (' + f.severity + ')\n'), f.id + ' has its section');
    assert.ok(!closedText.includes('| ' + f.id + ' |') && !(f.text && closedText.includes(f.text)), f.id);
    // Regression: the first open view listed an open finding's summary and status only, so the evidence,
    // failure scenario, recommendation and effort it was recorded with were in neither view.
    if (f.text) assert.ok(openText.includes(f.text), f.id + ' keeps its paragraph');
    for (const key of ['finding', 'evidence', 'failure_scenario', 'recommendation', 'effort', 'resolution'])
      if (f[key] !== undefined) assert.ok(openText.includes(flat(f[key])), f.id + ' keeps its ' + key);
    if (f.remaining) assert.ok(openText.includes('- What remains: ' + f.remaining), f.id + ' says what remains');
  }
  for (const f of closed) {
    assert.ok(!openText.includes('\n### ' + f.id + ' ('), f.id + ' is not in the open view');
    if (f.text) assert.ok(closedText.includes(f.text), f.id + ' keeps its paragraph');
    else
      assert.ok(closedText.includes('| ' + f.id + ' | ' + f.severity + ' | ' + flat(f.finding).replace(/\|/g, '\\|')));
  }
  // Each note is printed once, after the paragraph finding it follows.
  for (const group of register.groups)
    for (const note of group.notes ?? [])
      assert.equal((openText + closedText).split(note.text).length - 1, 1, note.after + ' note');
});

test('the open view lists a summary, then the record as written; the closed view groups findings as found', () => {
  const r = sample(),
    open = openViewText(r),
    closed = closedViewText(r);
  assert.deepEqual(registerProblems(r), []);
  assert.match(open, /\| Open \| 0 \| 0 \| 1 \| 1 \| 0 \| 2 \|/);
  assert.match(open, /\| Closed \| 0 \| 1 \| 0 \| 0 \| 0 \| 1 \|/);
  assert.ok(
    open.includes('| [F-2](#f-2-medium) | medium | Review by area: Money | A total is not counted | implemented |'),
  );
  // A paragraph finding's summary is its first sentence, without its bold label.
  assert.equal(summaryOf(r.findings[2]), 'The page reflows at 320 pixels.');
  assert.ok(
    open.includes(
      '| [F-3](#f-3-low) | low | Later deliveries: Delivery batches | The page reflows at 320 pixels. | partial |',
    ),
  );
  for (const line of [
    '### F-2 (medium)',
    '- Found in: Review by area: Money, against `abc1234`',
    '- Finding: A total is not counted',
    '- Evidence: `src/b.ts:2`',
    '- Failure scenario: A total passes the cap',
    '- Recommendation: Count totals',
    '- Effort: M',
    '- Status: implemented: totals; acceptance open',
    '- What remains: live acceptance (owner-run)',
    '### F-3 (low)',
    '**A note:** recorded after F-3.',
  ])
    assert.ok(open.split('\n').includes(line), line);
  assert.ok(open.includes(r.findings[2].text));
  assert.ok(!open.includes('F-1 '), 'a closed finding is not in the open view');
  // The closed view: the group, its introduction, the area's table with the revision it was found against.
  assert.ok(closed.includes('## Review by area\n\nFound by area.\n\n### Money\n\nFound against `abc1234`.'));
  assert.ok(closed.includes('| F-1 | high | A cap is not counted | `src/a.ts:1` | Count it | S | fixed (counted) |'));
  assert.ok(!closed.includes('F-2') && !closed.includes('F-3') && !closed.includes('Later deliveries'));
});

test('a register its views cannot show is refused, with what is wrong', () => {
  const broken = (change, pattern) => {
    const r = sample();
    change(r);
    assert.ok(
      registerProblems(r).some(p => pattern.test(p)),
      pattern + ' in ' + JSON.stringify(registerProblems(r)),
    );
  };
  broken(r => (r.schema_version = 2), /schema_version must be 1/);
  broken(r => (r.findings[1].id = 'F-1'), /F-1: is listed twice/);
  broken(r => (r.findings[0].id = 'X-1'), /an ID is F- and a number/);
  broken(r => (r.findings[0].severity = 'severe'), /severity is one of/);
  broken(r => (r.findings[0].group = 'nowhere'), /names no group/);
  broken(r => delete r.findings[0].area, /names the area/);
  broken(r => (r.findings[0].status = 'done'), /"done" is in neither state/);
  broken(r => delete r.findings[0].finding, /has its text or its finding/);
  broken(r => (r.findings[1].remaining = ' '), /remaining names what remains/);
  broken(r => r.states.closed.push('partial'), /states lists the open and the closed statuses/);
  broken(r => (r.groups[1].notes[0].after = 'F-1'), /no paragraph finding of this group/);
  broken(r => (r.groups[1].notes[0].after = 'F-9'), /which is no finding/);
  broken(r => (r.controls_verified = ''), /controls_verified/);
  broken(r => (r.intro = 'one paragraph'), /intro is a list of paragraphs/);
  broken(r => delete r.groups[0].title, /each group has its id, title and intro/);
  broken(r => (r.findings[0] = null), /a finding is an object/);
});

test('a changed register makes the views stale until they are written; closing a finding moves it', t => {
  const root = temporary(t),
    file = path.join(root, registerFile);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const r = sample();
  fs.writeFileSync(file, JSON.stringify(r));
  assert.deepEqual(findingsProblems(root), [
    openView + ' is out of date with ' + registerFile + '. Run npm run docs:index.',
    closedView + ' is out of date with ' + registerFile + '. Run npm run docs:index.',
  ]);
  assert.deepEqual(findingsProblems(root, {write: true}), []);
  assert.deepEqual(findingsProblems(root), []);
  // F-3 is fixed: the register changes, the views are stale, and once written F-3 is in the closed view only.
  r.findings[2].status = 'fixed';
  fs.writeFileSync(file, JSON.stringify(r));
  assert.equal(findingsProblems(root).length, 2);
  findingsProblems(root, {write: true});
  const open = fs.readFileSync(path.join(root, openView), 'utf8'),
    closed = fs.readFileSync(path.join(root, closedView), 'utf8');
  assert.ok(!open.includes('F-3') && closed.includes(r.findings[2].text) && closed.includes('**A note:**'));
  // An invalid register writes nothing and says why.
  fs.writeFileSync(file, '{"schema_version":1');
  assert.match(findingsProblems(root, {write: true})[0], /^docs\/review\/findings\.json: /);
  assert.equal(fs.readFileSync(path.join(root, openView), 'utf8'), open);
});
