import test from 'node:test';
import assert from 'node:assert/strict';
import {at} from './helpers/google-reconcile-fixture.mjs';
import {approvalSummary} from '../dist/src/plan-approval.js';

/**
 * R2.5 package r25-approval-effects, fix round (the lead's review of 3ad1f091, S2-2): the budget loop of the approval summary aggregated the
 * largest listed steps first even where aggregating made a one-field step larger, so a plan of 30 one-field status steps went from 4.7 KB to
 * 12 KB with every step truncated, and the website disabled "Save plan approval" until each list was opened. A step is aggregated only where
 * that makes it smaller. Synthetic, local, no compile.
 */
const step = (id, gateway, args) => ({
  id,
  kind: 'write',
  gateway,
  connection_id: 'c',
  account_id: '123',
  description: id,
  arguments: args,
  depends_on: [],
});
const planOf = steps => ({id: 'plan1', plan_hash: 'ph', steps});
const google = (id, action, operations) =>
  step(id, 'google_ads_native_action', {action: 'google_ads_v23_' + action, payload: {operations}});
const nth = n => Array.from({length: n}, (_, i) => i + 1);
test('S2-2: a plan of many one-field status steps stays listed: aggregating a step only when that makes it smaller', () => {
  const tiktok = n =>
      nth(n).map(i =>
        step('s' + i, 'tiktok_native_action', {
          action: 'tiktok_campaign_status_update',
          payload: {advertiser_id: '123', campaign_ids: [String(i)], operation_status: 'DISABLE'},
        }),
      ),
    googleStatus = n =>
      nth(n).map(i =>
        google('g' + i, 'ad_group_mutate_ad_groups', [
          {update: {resource_name: at('adGroups', String(i)), status: 'PAUSED'}, update_mask: 'status'},
        ]),
      );
  const sized = steps =>
    approvalSummary(
      planOf(steps),
      new Map(steps.map(s => [s.id, {spend: false, destructive: false, irreversible: false, checked: true}])),
    );
  const bytes = s => Buffer.byteLength(JSON.stringify(s));
  // `before` is each fixture's summary in bytes at 3ad1f091 (where every step was aggregated), measured on a scratch build of that commit
  // (git archive of 3ad1f091, tsc, this same fixture and the same effects map). No ceiling is asserted: the review's spec is that no step
  // is truncated and that the summary is smaller than it was.
  for (const [name, steps, before] of [
    ['30 TikTok status steps', tiktok(30), 11978],
    ['40 TikTok status steps', tiktok(40), 15828],
    ['30 Google status steps', googleStatus(30), 12698],
  ]) {
    const summary = sized(steps);
    assert.equal(summary.truncated, undefined, name + ' has no truncated step');
    assert.ok(
      summary.steps.every(s => s.truncated === undefined && s.all_fields === undefined && s.status?.length === 1),
      name + ': every step lists its status field and needs no list to open',
    );
    assert.ok(bytes(summary) < before, name + ' is ' + bytes(summary) + ' bytes, was ' + before);
  }
  // A step with many fields is still aggregated, where that makes it smaller (the budget loop's purpose is unchanged).
  const wide = step('wide', 'meta_native_action', {
    action: 'meta_campaign_update',
    campaign_id: '1',
    payload: Object.fromEntries(nth(60).map(i => ['daily_budget_' + i, String(i * 100)])),
  });
  assert.equal(sized([wide]).steps[0].truncated, true);
});
