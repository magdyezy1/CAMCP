import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MirrorError, errorRemedy, errorResult, providerDataAction} from '../dist/src/errors.js';
import {reportSourceError} from '../dist/src/report-errors.js';
import {tiktokPageCountMessage} from '../dist/src/tiktok-report-pagination.js';

// r25-hotfix item 1, error 7 of the live checks of 2026-11-15: REPORT_INCOMPLETE told the caller to retry a refusal that is
// deterministic. TikTok's page-count rule refuses what one TikTok answer says, so the same request gets the same answer.
// Its remedy now says what AMCP saw, that a retry cannot help, and what to do. The facts are synthetic.
const facts = rule => ({page: 1, page_size: 7, total_number: 7, total_page: 1, list_length: 7, rule});
const refusal = rule => new MirrorError('REPORT_INCOMPLETE', tiktokPageCountMessage, {page_facts: facts(rule)}, 502);
// Checks on what a single answer says: no retry changes them.
const answerRules = [
  'page_info_missing',
  'page_not_echoed',
  'total_not_integer',
  'page_longer_than_size',
  'more_rows_than_declared',
];
// Rules that may follow TikTok's own data still moving (a total that changed between pages, rows short of the total):
// a retry can help, so they keep the shared retry advice.
const movingRules = ['total_changed', 'fewer_rows_than_declared', 'totals_mismatch'];
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const tiktok = {platform: 'tiktok', account_id: '1', connection_id: 'c'};

for (const rule of answerRules)
  test('REPORT_INCOMPLETE on ' + rule + ' says what AMCP saw, that a retry cannot help and what to do', () => {
    const remedy = errorRemedy(refusal(rule));
    assert.notEqual(remedy.action, providerDataAction);
    // What AMCP saw, with the rule that names it.
    assert.match(remedy.action, /page counts/);
    assert.match(remedy.action, /details\.page_facts\.rule/);
    // That retrying the same request returns the same answer, and never advice to retry it.
    assert.match(remedy.action, /Retrying the same request returns the same answer/);
    assert.doesNotMatch(remedy.action, /Retry the report/);
    // What to do.
    assert.match(remedy.action, /Report these details/);
    assert.match(remedy.action, /narrow the request/);
    assert.deepEqual([remedy.category, remedy.mutation_retry_safe], ['report', false]);
    // The MCP error says the same in its remedy and its next action.
    const sent = errorResult(refusal(rule), 'request-1', 1).error;
    assert.equal(sent.remedy.action, remedy.action);
    assert.equal(sent.next_action, remedy.action);
    assert.equal(sent.category, 'report');
  });

test('a report source that failed on such a refusal shows the same remedy, and no HTTP status', () => {
  for (const rule of answerRules) {
    const diagnostic = reportSourceError(refusal(rule), tiktok);
    assert.equal(diagnostic.category, 'provider_data', rule);
    assert.equal(diagnostic.next_action, errorRemedy(refusal(rule)).action, rule);
    assert.equal('http_status' in diagnostic, false, rule);
    assert.equal(diagnostic.page_facts.rule, rule);
  }
});

test('refusals a retry can help, and refusals that are not this check, keep the retry advice', () => {
  for (const rule of movingRules) {
    assert.equal(errorRemedy(refusal(rule)).action, providerDataAction, rule);
    assert.equal(reportSourceError(refusal(rule), tiktok).next_action, providerDataAction, rule);
  }
  // No page facts, a provider that sends none, facts that name no rule this check owns, and facts that are not facts.
  const generic = [
    new MirrorError('REPORT_INCOMPLETE', 'Synthetic.', {}, 502),
    new MirrorError('REPORT_INCOMPLETE', 'Synthetic.', {page_facts: {...facts('x'), rule: 'something_else'}}, 502),
    new MirrorError('REPORT_INCOMPLETE', 'Synthetic.', {page_facts: {...facts('x'), rule: undefined}}, 502),
    new MirrorError('REPORT_INCOMPLETE', 'Synthetic.', {page_facts: {...facts('x'), rule: ['page_not_echoed']}}, 502),
    new MirrorError('REPORT_INCOMPLETE', 'Synthetic.', {page_facts: 'page_not_echoed'}, 502),
    new MirrorError('REPORT_INCOMPLETE', 'Synthetic.', {page_facts: ['page_not_echoed']}, 502),
    new MirrorError('REPORT_DUPLICATE_ROWS', 'Synthetic.', {page_facts: facts('duplicate_tuple')}, 502),
    new MirrorError('REPORT_EMPTY_AMBIGUOUS', 'Synthetic.', {page_facts: facts('page_not_echoed')}, 502),
  ];
  for (const error of generic) {
    assert.equal(errorRemedy(error).action, providerDataAction, error.code + ' ' + JSON.stringify(error.details));
    assert.equal(reportSourceError(error, tiktok).next_action, providerDataAction, error.code);
  }
  // A changed response shape keeps its own provider-shape advice, with its caution about a submitted write.
  const shape = errorRemedy(
    new MirrorError('REPORT_SHAPE_CHANGED', 'Synthetic.', {page_facts: facts('page_not_echoed')}, 502),
  );
  assert.match(shape.action, /submitted write/);
});

test('every rule of the TikTok page-count check is classified, so a new rule must choose its remedy', () => {
  const source = readFileSync('src/tiktok-report-pagination.ts', 'utf8'),
    union = /export type TikTokPageRule =([^;]+);/.exec(source)?.[1] ?? '',
    rules = [...union.matchAll(/'([a-z_]+)'/g)].map(match => match[1]);
  // duplicate_tuple is its own code (REPORT_DUPLICATE_ROWS); the others are never a refusal.
  const classified = [...answerRules, ...movingRules, 'duplicate_tuple', 'total_page_basis_mismatch', 'empty_report'];
  assert.ok(rules.length >= 11, 'the rules were read from the source: ' + rules);
  assert.deepEqual([...rules].sort(), [...classified].sort());
});

test('the remedy has its Arabic string, and is not left as the English text', () => {
  const action = errorRemedy(refusal('page_not_echoed')).action;
  assert.match(catalog[action] ?? '', /[؀-ۿ]/, 'Arabic for: ' + action);
  assert.notEqual(catalog[action], action);
  // The refusal's own message already has one.
  assert.match(catalog[tiktokPageCountMessage], /[؀-ۿ]/);
});
