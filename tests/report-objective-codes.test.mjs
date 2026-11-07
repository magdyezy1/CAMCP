// The objective block of a v4 row gains a stable `reason_code` (and the platform and objective a code names), so the report
// page words an unknown objective from the code and no longer parses the server's English sentence. A snapshot recorded
// before the code has the sentence alone and is shown as it was. All data are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resolveObjective} from '../dist/src/report-objectives.js';
import {row} from './helpers/report-packets.mjs';
import {reportEngine} from './helpers/report-engine.mjs';
import {reportPage} from './helpers/report-page.mjs';

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
const table = {
  name: 'TikTok',
  values: {TRAFFIC: 'traffic', APP_RETARGETING: null},
  missingReason: 'TikTok returned no objective for this campaign.',
};

test('every reason the resolver gives has a code, and the codes that name a platform carry what they name', () => {
  const code = input => {
    const {reason, reason_code, reason_values} = resolveObjective({platform: 'tiktok', table, ...input});
    return reason === null ? [null] : [reason_code, reason_values];
  };
  assert.deepEqual(code({native: 'TRAFFIC'}), [null], 'no reason, no code');
  assert.deepEqual(code({native: 'TRAFFIC', campaignId: '1', overrides: {1: 'sales'}}), [
    'campaign_override',
    undefined,
  ]);
  assert.deepEqual(code({native: 'TRAFFIC', legacy: 'sales'}), ['source_choice', undefined]);
  assert.deepEqual(code({native: 'NEW_LEADS_THING'}), ['inferred_from_native', undefined]);
  assert.deepEqual(code({native: 'APP_RETARGETING'}), [
    'no_matching_objective',
    {platform: 'TikTok', native: 'APP_RETARGETING'},
  ]);
  assert.deepEqual(code({native: 'FUTURE_THING'}), [
    'objective_not_grouped',
    {platform: 'TikTok', native: 'FUTURE_THING'},
  ]);
  assert.deepEqual(code({native: null}), ['platform_returned_none', undefined]);
  assert.deepEqual(code({native: null, unread: 'refused'}), ['read_refused', undefined]);
  assert.deepEqual(code({native: null, unread: 'limited'}), ['read_limited', undefined]);
  assert.deepEqual(code({native: null, unread: 'refused', fallback: 'sales'}), ['fallback_read_refused', undefined]);
  assert.deepEqual(code({native: null, unread: 'limited', fallback: 'sales'}), ['fallback_read_limited', undefined]);
  assert.deepEqual(
    [resolveObjective({platform: 'other', native: 'TRAFFIC'})].map(r => [r.reason_code, r.reason_values]),
    [['source_has_no_objective', undefined]],
  );
  assert.deepEqual(
    [
      resolveObjective({
        platform: 'test',
        table: {...table, mapped: () => ({group: 'app_installs', reason: 'Mapped.'})},
      }),
    ].map(r => r.reason_code),
    ['mapped_by_provider'],
  );
});

test('a v4 snapshot returns the code and its values in the row’s objective block, and keeps them out of the flat row', async t => {
  const e = reportEngine(t, {
      rowsFor: () => [
        row('campaign', 'c1', {}, {objective: 'FUTURE_THING'}),
        row('campaign', 'c2', {}, {objective: undefined}),
        row('campaign', 'c3', {}, {objective: 'OUTCOME_LEADS'}),
      ],
    }),
    {report, stored} = await e.go(['campaign']),
    objectives = report.rows.map(r => r.objective);
  assert.deepEqual(objectives[0], {
    native: 'FUTURE_THING',
    group: 'unknown',
    source: 'unknown',
    reason: 'Meta returned the objective FUTURE_THING, which AMCP does not group yet; choose one in the report.',
    reason_code: 'objective_not_grouped',
    reason_values: {platform: 'Meta', native: 'FUTURE_THING'},
  });
  assert.equal(objectives[1].reason_code, 'platform_returned_none');
  assert.equal(objectives[1].reason, 'Meta returned no objective for this campaign.');
  assert.equal(objectives[2].reason, null);
  assert.equal(objectives[2].reason_code, undefined, 'no reason, no code');
  assert.equal(report.rows[0].objective_reason_code, undefined, 'the flat fields stay out of the projection');
  assert.equal(stored.rows[0].objective_reason_code, 'objective_not_grouped');
});

for (const locale of ['en', 'ar']) {
  test(
    locale +
      ': the page words an unknown objective from its code, and reads an older snapshot’s sentence as it always did',
    () => {
      const view = reportPage(locale, {platforms: [], metrics: {}}),
        source = (objective, flat = {}) =>
          view.call('reportObjectiveSource(row)', {
            row: {objective: 'X', objective_group: 'unknown', ...flat, ...(objective ? {objective} : {})},
          }),
        said = (key, values) =>
          Object.entries(values).reduce((text, [name, value]) => text.replace('{' + name + '}', value), view.text(key));
      const unmatched = '{platform}’s {native} has no matching AMCP objective; choose one in the report.',
        ungrouped =
          '{platform} returned the objective {native}, which AMCP does not group yet; choose one in the report.';
      // The code and its values decide: the sentence beside them is not looked at.
      const block = (code, values, reason = 'a sentence no pattern matches') => ({
        native: 'X',
        group: 'unknown',
        source: 'unknown',
        reason,
        reason_code: code,
        reason_values: values,
      });
      assert.equal(
        source(block('no_matching_objective', {platform: 'TikTok', native: 'APP_RETARGETING'})),
        said(unmatched, {platform: 'TikTok', native: 'APP_RETARGETING'}),
      );
      assert.equal(
        source(block('objective_not_grouped', {platform: 'Meta', native: 'FUTURE_THING'})),
        said(ungrouped, {platform: 'Meta', native: 'FUTURE_THING'}),
      );
      // A sentence with names in it that look like the pattern is still the code's, not the pattern's.
      assert.equal(
        source(
          block(
            'no_matching_objective',
            {platform: 'A', native: 'B'},
            'C’s D has no matching AMCP objective; choose one in the report.',
          ),
        ),
        said(unmatched, {platform: 'A', native: 'B'}),
      );
      // Any other code is a fixed sentence the catalog knows.
      assert.equal(
        source(block('platform_returned_none', undefined, 'Meta returned no objective for this campaign.')),
        view.text('Meta returned no objective for this campaign.'),
      );
      // A v4 snapshot recorded before the code, and a snapshot recorded before v4, are read from their sentence as before.
      const old = {
        native: 'X',
        group: 'unknown',
        source: 'unknown',
        reason: 'TikTok’s APP_RETARGETING has no matching AMCP objective; choose one in the report.',
      };
      assert.equal(source(old), said(unmatched, {platform: 'TikTok', native: 'APP_RETARGETING'}));
      assert.equal(
        source(null, {
          objective_source: 'unknown',
          objective_reason:
            'Meta returned the objective FUTURE_THING, which AMCP does not group yet; choose one in the report.',
        }),
        said(ungrouped, {platform: 'Meta', native: 'FUTURE_THING'}),
      );
      if (locale === 'ar') assert.match(source(old), /[؀-ۿ]/);
      assert.ok(catalog[unmatched] && catalog[ungrouped], 'both messages have Arabic');
    },
  );
}
