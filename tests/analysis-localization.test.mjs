import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {campaignRecommendation} from '../dist/src/report-metrics.js';
import * as localeChecks from '../tools/check-locales.mjs';

function fixture(locale = 'ar') {
  const context = createContext({document: {addEventListener() {}}, Intl});
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  context.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  if (locale === 'ar') run('uiLocale="ar";uiMessages=new Map(Object.entries(catalog))');
  run(readFileSync('web/report-quality.js', 'utf8'));
  return {context, run};
}
const nativeRow = () => ({
  source_kind: 'paid',
  complete: true,
  currency: 'SAR',
  timezone: 'Asia/Riyadh',
  captured_at: Date.now(),
  objective_group: 'sales',
  campaign_key: 'native-001',
  date_to: '2026-09-01',
  metrics: {spend: 100, conversions: 20, cpa: 5},
  attribution: 'native attribution',
  result_definition: 'native purchase',
});

test('missing-target recommendations retain the original reason and expose exact display parameters', () => {
  const row = nativeRow(),
    before = structuredClone(row),
    result = campaignRecommendation(row, {});
  assert.equal(result.decision, 'needs_target');
  assert.equal(result.reason, 'Set a CPA target in SAR for this objective or campaign.');
  assert.deepEqual(result.reason_localization, {key: 'target_required', kpi: 'CPA', currency: 'SAR'});
  assert.deepEqual(row, before);
  assert.equal(result.requires_review, true);
  assert.equal(result.automatic_execution, false);
});

test('only authored report explanations translate; native values that resemble other UI labels remain unchanged', () => {
  const f = fixture();
  assert.equal(f.run('typeof uiReportExplanation'), 'function');
  f.context.message = 'Illustrative sensitivity model, not a forecast or a statistical confidence interval.';
  assert.match(f.run('uiReportExplanation(message)'), /[\u0600-\u06ff]/);
  for (const value of [
    'Home',
    'Complete',
    'Original provider diagnostic <img>',
    'Native result 0012.34',
    'Set a CUSTOM target in ABC for this objective or campaign.',
  ]) {
    f.context.message = value;
    assert.equal(f.run('uiReportExplanation(message)'), value);
  }
  const english = fixture('en');
  english.context.message = f.context.message;
  assert.equal(english.run('uiReportExplanation(message)'), f.context.message);
});

test('Arabic target explanations use structured metadata and preserve unknown and legacy reasons', () => {
  const f = fixture();
  f.context.rec = campaignRecommendation(nativeRow(), {});
  const original = JSON.stringify(f.context.rec);
  assert.equal(f.run('typeof uiRecommendationReason'), 'function');
  const text = f.run('uiRecommendationReason(rec)');
  assert.match(text, /[\u0600-\u06ff]/);
  assert.match(text, /CPA/);
  assert.match(text, /SAR/);
  assert.equal(JSON.stringify(f.context.rec), original);
  for (const reason_localization of [
    undefined,
    {key: 'unsupported', kpi: 'CPA', currency: 'SAR'},
    {key: 'target_required', kpi: 3, currency: 'SAR'},
  ]) {
    f.context.rec = {decision: 'needs_target', reason: 'Original legacy reason Home', reason_localization};
    assert.equal(f.run('uiRecommendationReason(rec)'), 'Original legacy reason Home');
  }
});

test('report explanation extraction follows only authored explanation positions, leaving native protocol and context data alone', () => {
  assert.equal(typeof localeChecks.inspectReportExplanations, 'function');
  const source = `const result=(decision,reason)=>({decision,reason});
    result('scale','Known recommendation'); result('needs_target','Set a '+native+' target');
    result('wait', ready ? 'First explanation' : 'Second explanation');
    const row={reason:'Known reason',limitations:['Known limitation'],gateway:'native_action',message:'Provider diagnostic',context:{note:'Home'}};`;
  const found = localeChecks.inspectReportExplanations(source, 'src/report-metrics.ts');
  assert.deepEqual([...found].sort(), [
    'First explanation',
    'Known limitation',
    'Known reason',
    'Known recommendation',
    'Second explanation',
  ]);
  const r = localeChecks.inspectReportExplanations(
    "add('spend_anomaly',{currency:'USD'},'Known proposal');",
    'src/decision-reporting.ts',
  );
  assert.deepEqual([...r], ['Known proposal']);
});

test('collector warnings with a count or field name translate through fixed templates and keep the exact value', () => {
  // Regression (RPT-03/RPT-04 review): these warnings were built dynamically, so the exact-match lookup left them in
  // English for Arabic users.
  const ar = fixture(),
    en = fixture('en');
  const warnings = [
    [
      'Requested native metric metrics.misspelled_field was not returned as a number; formulas that use it stay unavailable. Check the field name for this provider.',
      'metrics.misspelled_field',
    ],
    [
      '4 X campaigns have no reported activity in this window (X active entities). They are not listed and are never counted as zero.',
      '4',
    ],
    [
      '1 X campaign has no reported activity in this window (X active entities). They are not listed and are never counted as zero.',
      '1',
    ],
    ['2 active X campaigns are missing from the campaign list; they are shown by ID.', '2'],
    ['1 active X campaign is missing from the campaign list; it is shown by ID.', '1'],
    [
      'TikTok ad group optimization events could not be read, so conversions use one generic result definition and campaigns optimizing for different events are not told apart.',
      'TikTok',
    ],
  ];
  for (const [warning, value] of warnings) {
    ar.context.warning = warning;
    const text = ar.run('uiSourceWarning(warning)');
    assert.match(text, /[؀-ۿ]/, warning);
    assert.ok(text.includes(value), text);
    en.context.warning = warning;
    assert.equal(en.run('uiSourceWarning(warning)'), warning, 'English keeps the collector sentence');
  }
  // Provider text that only resembles a template stays exactly as written.
  for (const value of ['Requested native metric <img> was not returned', 'Native warning 0012.34']) {
    ar.context.warning = value;
    assert.equal(ar.run('uiSourceWarning(warning)'), value);
  }
  ar.context.message =
    'The baseline window is not declared complete; comparisons with it (spend anomaly, creative fatigue) may reflect missing baseline data.';
  assert.match(ar.run('uiReportExplanation(message)'), /[؀-ۿ]/);
});
