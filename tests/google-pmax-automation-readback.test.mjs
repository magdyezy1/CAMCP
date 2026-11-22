// R2.5 field3 fix round, package r25-field3-recipes, lead review S2-1: the read-back of a Performance Max build that sets final URL expansion.
// The campaign's `asset_automation_settings` is a list of one entry per automation type ("the opt-in/out status of each AssetAutomationType" in
// the pinned v25 Discovery), and opting in to final URL expansion also enables text asset automation, so Google's read can list entries the build
// never sent. The build compared the list whole and answered VERIFICATION_MISMATCH for a campaign Google had created exactly as sent. It now
// compares the entries it sent by their type, one status each. Synthetic customer 123; nothing reaches Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {campaignRecipe} from '../dist/src/campaign-recipes.js';
import {googleAtomicVerification} from '../dist/src/google-atomic-builds.js';
import {pmaxCustomer} from './fixtures/google-pmax-data.mjs';

const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
const business = {...examples.google_pmax_business, connection_id: 'g', final_url_expansion: 'OPTED_OUT'};
const FINAL = 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION';
const entry = (type, status) => ({assetAutomationType: type, assetAutomationStatus: status});

/** create_from_recipe, approve (preview, then with its hashes) and run, as an agent does; one re-approval for the spend flag at most. */
async function runBuild(x) {
  const call = input => x.call('amcp_campaign', input);
  const created = await call({action: 'create_from_recipe', recipe: 'google_performance_max', business});
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 1500));
  const id = created.data.id,
    preview = await call({action: 'approve', id});
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 1500));
  const approved = await call({
    action: 'approve',
    id,
    confirmed: true,
    plan_hash: preview.data.plan_hash,
    summary_hash: preview.data.summary_hash,
  });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 1500));
  let result = await call({action: 'run', id});
  for (let n = 0; n < 2 && result.success && result.data.run?.stopped === 'needs_spend_change_confirmed'; n++) {
    const again = await call({...result.data.next_call.arguments, confirmed: true, spend_change_confirmed: true});
    assert.equal(again.success, true, JSON.stringify(again).slice(0, 1500));
    result = await call({action: 'run', id});
  }
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
  return (await call({action: 'get', id, detail: 'full'})).data;
}
const checks = run => run.steps.flatMap(s => s.verification?.checks ?? []);
const campaignCheck = run => checks(run).find(c => /\/campaigns\//.test(String(c.resource_id)));
const outcome = run =>
  JSON.stringify([
    run.state,
    ...run.steps.map(s => ({
      id: s.id,
      status: s.status,
      error: s.error,
      notVerified: checks({steps: [s]})
        .filter(c => c.status !== 'verified')
        .map(c => [c.resource_id, c.status, c.code, c.changed_fields]),
    })),
  ]).slice(0, 1500);
const world = async (t, campaignReadsAutomation) => {
  const x = pmaxCustomer({campaignReadsAutomation});
  t.after(() => x.store.close());
  return x;
};

test('the verification of the campaign still selects asset_automation_settings, and compares the entries sent by their type, one status each', () => {
  const plan = campaignRecipe('google_performance_max', business),
    payload = plan.steps[0].arguments.payload,
    kinds = {
      campaign_budget_operation: ['campaignBudgetResult', 'campaignBudgets'],
      campaign_operation: ['campaignResult', 'campaigns'],
      asset_group_operation: ['assetGroupResult', 'assetGroups'],
      asset_operation: ['assetResult', 'assets'],
      asset_group_asset_operation: ['assetGroupAssetResult', 'assetGroupAssets'],
      campaign_criterion_operation: ['campaignCriterionResult', 'campaignCriteria'],
    },
    responses = payload.mutate_operations.map((op, i) => {
      const [result, kind] = kinds[Object.keys(op)[0]];
      return {[result]: {resourceName: 'customers/123/' + kind + '/' + (1000 + i)}};
    }),
    reads = googleAtomicVerification(
      {
        gateway: 'google_ads_native_action',
        accountId: '123',
        path: '/v25/customers/123/googleAds:mutate',
        method: 'POST',
        body: payload,
      },
      {data: {mutateOperationResponses: responses}},
      [],
      () => ({}),
      r => r,
    ),
    campaign = reads.find(r => /FROM campaign WHERE/.test(JSON.stringify(r.read)));
  assert.ok(campaign, 'the campaign has its read');
  assert.ok(/campaign\.asset_automation_settings/.test(JSON.stringify(campaign.read)), 'the field is still selected');
  assert.equal(campaign.expected.asset_automation_settings, undefined, 'the list is not compared whole');
  assert.deepEqual(campaign.expected.amcp_asset_automation, {[FINAL]: 'OPTED_OUT'});
  assert.equal(campaign.expected.status, 'PAUSED', 'every other field is compared as before');
  // Another resource of the build, and a campaign sent without the setting, carry no such marker.
  assert.ok(
    reads.filter(r => r !== campaign).every(r => r.expected.amcp_asset_automation === undefined),
    'only the campaign',
  );
});

test('Google lists other automation types beside the entry sent, in another order: the build verifies, and the check shows what Google lists', async t => {
  const x = await world(t, sent => [
    entry('TEXT_ASSET_AUTOMATION', 'OPTED_IN'),
    ...sent,
    entry('GENERATE_IMAGE_ENHANCEMENT', 'OPTED_IN'),
  ]);
  const run = await runBuild(x);
  assert.equal(run.state, 'complete', outcome(run));
  assert.deepEqual(
    run.steps.map(s => [s.id, s.status]),
    [['build', 'verified']],
  );
  const check = campaignCheck(run);
  assert.equal(check.status, 'verified', JSON.stringify(check));
  assert.deepEqual(check.changed_fields, []);
  assert.deepEqual(check.provider_asset_automation, {
    [FINAL]: 'OPTED_OUT',
    GENERATE_IMAGE_ENHANCEMENT: 'OPTED_IN',
    TEXT_ASSET_AUTOMATION: 'OPTED_IN',
  });
  assert.equal(x.mutates.length, 1, 'one request created everything');
});

for (const [name, reads] of [
  ['the entry sent with another status', sent => sent.map(e => ({...e, assetAutomationStatus: 'OPTED_IN'}))],
  ['the entry sent missing, beside other types', () => [entry('TEXT_ASSET_AUTOMATION', 'OPTED_IN')]],
  ['the list empty', () => []],
  ['the type sent listed twice with two statuses', sent => [...sent, entry(FINAL, 'OPTED_IN')]],
  ['the type sent listed twice with the same status', sent => [...sent, ...sent]],
])
  test('still not verified: ' + name, async t => {
    const x = await world(t, reads);
    const run = await runBuild(x);
    assert.notEqual(run.state, 'complete', outcome(run));
    const check = campaignCheck(run);
    assert.notEqual(check.status, 'verified', JSON.stringify(check));
    assert.ok(check.changed_fields.length > 0, JSON.stringify(check));
    assert.ok(
      run.steps.every(s => s.status !== 'verified'),
      outcome(run),
    );
  });
