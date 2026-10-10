// SEC-04 A: one formula guard for both CSV writers (the Overview export and the workflow report CSV).
// Payloads follow the OWASP "CSV Injection" prefix list (= + - @, tab, carriage return; accessed 2026-10-09), their
// full-width forms and a line feed. Before this change the Overview export did not neutralize control prefixes, and
// neither writer neutralized full-width triggers or a leading tab/CR/LF without an ASCII trigger after it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {neutralizeCsvCell, csvField} from '../dist/src/csv-safety.js';
import {exportCsv} from '../dist/src/google-sheets.js';
import {reportCsv} from '../dist/src/workflows.js';

const neutralized = [
  '=1+2',
  '=HYPERLINK("https://example.test","x")',
  '+cmd',
  '-2+3',
  '@SUM(A1)',
  ' =1+2',
  '\t=1+2',
  '\r=1+2',
  '\n=1+2',
  '\u0000=1+2',
  '\u001f+cmd',
  '\tplain',
  '\rplain',
  '\nplain',
  '＝1+2',
  '＋cmd',
  '－2+3',
  '＠SUM(A1)',
  ' ＝1+2',
  '-20% sale',
];
const literal = ['Summer sale', 'a=b', 'x-y', 'name@example.com', '', '1+1', 'سعر=10'];
const expected = value => '"' + (neutralized.includes(value) ? "'" + value : value).replaceAll('"', '""') + '"';

test('the shared guard neutralizes every OWASP prefix, full-width trigger and leading tab, CR or LF', () => {
  for (const value of neutralized) assert.equal(neutralizeCsvCell(value), "'" + value, JSON.stringify(value));
  for (const value of literal) assert.equal(neutralizeCsvCell(value), value, JSON.stringify(value));
  assert.equal(csvField(-5), '"-5"', 'numbers are not text and keep their sign');
  assert.equal(csvField(null), '""');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
});

// A self-check of the payload table, not of the writers: a narrowed guard (= only, or ASCII triggers only) must
// disagree with the shared guard on at least one row, so the table is wide enough to catch it. The writer-level
// assertions below are what keep both CSV writers on csvField.
test('table coverage self-check: the payload table separates narrowed guards (= only, and ASCII only)', () => {
  const mutants = {
    equalsOnly: v => (/^[\s\u0000-\u001f]*=/.test(v) ? "'" + v : v),
    asciiOnly: v => (/^[\s\u0000-\u001f]*[=+\-@]/.test(v) ? "'" + v : v),
  };
  for (const [name, mutant] of Object.entries(mutants))
    assert.ok(
      neutralized.some(v => mutant(v) !== neutralizeCsvCell(v)),
      name + ' must change at least one expected output',
    );
});

function overviewReport(names) {
  return {
    id: 'csv-guard',
    state: 'complete',
    config: {metrics: ['spend'], sources: []},
    sources: [],
    rows: names.map((name, i) => ({
      platform: 'meta',
      account_id: '1',
      campaign_id: String(i + 1),
      campaign_name: name,
      objective_group: 'sales',
      date_from: '2026-09-01',
      date_to: '2026-09-02',
      metrics: {spend: -5},
      recommendation: {decision: 'hold', reason: 'synthetic'},
      attribution: 'synthetic',
      result_definition: 'synthetic',
      complete: true,
      captured_at: Date.UTC(2026, 8, 3),
      quality: {},
    })),
  };
}

test('both writers escape every payload identically', () => {
  const values = [...neutralized, ...literal],
    overview = exportCsv(overviewReport(values)),
    workflow = reportCsv(values.map((name, i) => ({platform: 'meta', entity_id: String(i + 1), entity_name: name})));
  for (const value of values) {
    const field = expected(value);
    assert.ok(overview.includes(',' + field + ','), 'Overview export: ' + JSON.stringify(value));
    assert.ok(workflow.includes(',' + field + ','), 'workflow report: ' + JSON.stringify(value));
  }
  assert.ok(overview.includes(',"-5",'), 'a negative number is exported as a number');
});
