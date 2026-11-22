// R2.5 field3, package r25-field3-recipes, the lead's addition to AMCP-08: the Performance Max recipe sets final URL expansion. The owner's session
// tried `url_expansion_opt_out`, a Campaign field Google removed in v22; v25 keeps the setting in `asset_automation_settings`, as the entry of the
// type FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION. Synthetic customer 123; nothing reaches Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {pmaxCustomer} from './fixtures/google-pmax-data.mjs';

const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
const business = {...examples.google_pmax_business, connection_id: 'g'};
const pmax = patch => campaignRecipe('google_performance_max', {...business, ...patch});
const campaignOf = plan =>
  plan.steps[0].arguments.payload.mutate_operations.find(o => o.campaign_operation).campaign_operation.create;
const setting = status => [
  {asset_automation_type: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', asset_automation_status: status},
];

test('the names the recipe sends are the ones of the pinned v25 Discovery document, and url_expansion_opt_out is not one of them', () => {
  const vendor = JSON.parse(readFileSync('.mirror/VENDOR/google-ads-v25.json', 'utf8')).document.schemas;
  const campaign = vendor.GoogleAdsGoogleadsV25Resources__Campaign.properties,
    automation = vendor.GoogleAdsGoogleadsV25Resources_Campaign_AssetAutomationSetting.properties;
  assert.equal(campaign.assetAutomationSettings.type, 'array');
  assert.ok(campaign.assetAutomationSettings.items.$ref.endsWith('Campaign_AssetAutomationSetting'));
  assert.ok(automation.assetAutomationType.enum.includes('FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION'));
  assert.deepEqual(
    automation.assetAutomationStatus.enum.filter(v => !['UNSPECIFIED', 'UNKNOWN'].includes(v)),
    ['OPTED_IN', 'OPTED_OUT'],
  );
  assert.equal(campaign.urlExpansionOptOut, undefined, 'removed in v22: the replacement is the setting above');
  const definition = campaignRecipes.find(r => r.id === 'google_performance_max');
  assert.ok(definition.optional.includes('final_url_expansion'));
  assert.deepEqual(definition.inputs.final_url_expansion.values, ['OPTED_IN', 'OPTED_OUT']);
  assert.equal(definition.inputs.final_url_expansion.case_insensitive, true);
});

test('final_url_expansion sets the campaign’s final URL expansion entry, with the value in its listed form', () => {
  assert.deepEqual(
    campaignOf(pmax({final_url_expansion: 'OPTED_OUT'})).asset_automation_settings,
    setting('OPTED_OUT'),
  );
  assert.deepEqual(campaignOf(pmax({final_url_expansion: 'OPTED_IN'})).asset_automation_settings, setting('OPTED_IN'));
  assert.deepEqual(
    campaignOf(pmax({final_url_expansion: 'opted_out'})).asset_automation_settings,
    setting('OPTED_OUT'),
  );
  // The plan says what was chosen, beside the build.
  assert.equal(pmax({final_url_expansion: 'opted_out'}).recipe.final_url_expansion, 'OPTED_OUT');
});

test('a value outside the set is invalid and lists the two values; a boolean and the removed field are not accepted', () => {
  for (const value of [
    'INVALID',
    'OPT_OUT',
    'OPTED OUT',
    ' OPTED_OUT',
    'OPTED_OUT ',
    'ENABLED',
    7,
    true,
    false,
    null,
    [],
    {},
  ])
    assert.throws(
      () => pmax({final_url_expansion: value}),
      e =>
        assertRefused(e, 'RECIPE_INPUT_INVALID') &&
        e.details.field === 'final_url_expansion' &&
        JSON.stringify(e.details.allowed) === JSON.stringify(['OPTED_IN', 'OPTED_OUT']),
      String(value),
    );
});

test('left out or blank, the create is unchanged: no setting, and the keys a brief without it has always sent', () => {
  for (const patch of [{}, {final_url_expansion: ''}, {final_url_expansion: undefined}]) {
    const plan = pmax(patch);
    assert.equal(campaignOf(plan).asset_automation_settings, undefined);
    assert.equal(plan.recipe.final_url_expansion, undefined);
    assert.deepEqual(Object.keys(campaignOf(plan)), [
      'resource_name',
      'name',
      'status',
      'advertising_channel_type',
      'campaign_budget',
      'maximize_conversions',
      'brand_guidelines_enabled',
      'contains_eu_political_advertising',
    ]);
  }
});

test('the plan with final_url_expansion passes the build’s review, runs under the spend confirmation, and the campaign is created paused with the setting', async t => {
  const x = pmaxCustomer();
  t.after(() => x.store.close());
  const created = await x.call('amcp_campaign', {
    action: 'create_from_recipe',
    recipe: 'google_performance_max',
    business: {...business, final_url_expansion: 'opted_out', positive_geo_target_type: 'PRESENCE'},
  });
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 1500));
  const id = created.data.id,
    preview = await x.call('amcp_campaign', {action: 'approve', id});
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 1500));
  const approved = await x.call('amcp_campaign', {
    action: 'approve',
    id,
    confirmed: true,
    plan_hash: preview.data.plan_hash,
    summary_hash: preview.data.summary_hash,
  });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 1500));
  // Approved without spend_change_confirmed, the run stops for it and nothing is sent.
  let result = await x.call('amcp_campaign', {action: 'run', id});
  assert.equal(result.data.run?.stopped, 'needs_spend_change_confirmed', JSON.stringify(result).slice(0, 800));
  assert.equal(x.mutates.length, 0);
  const again = await x.call(result.data.next_call.tool, {
    ...result.data.next_call.arguments,
    confirmed: true,
    spend_change_confirmed: true,
  });
  assert.equal(again.success, true, JSON.stringify(again).slice(0, 1500));
  result = await x.call('amcp_campaign', {action: 'run', id});
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 1500));
  const full = (await x.call('amcp_campaign', {action: 'get', id, detail: 'full'})).data;
  assert.equal(
    full.state,
    'complete',
    JSON.stringify(full.steps.map(s => ({id: s.id, status: s.status, error: s.error}))),
  );
  assert.equal(x.mutates.length, 1, 'one request created everything');
  const campaign = [...x.created.values()].find(r => r.advertising_channel_type === 'PERFORMANCE_MAX');
  assert.equal(campaign.status, 'PAUSED');
  assert.deepEqual(campaign.asset_automation_settings, setting('OPTED_OUT'));
  // This fake answers a read of the campaign with exactly what was created. What Google's read of `campaign.asset_automation_settings` lists beside
  // the entry sent is UNVERIFIED (a live check on the owner's test account shows it, and that the field is selectable in a query): the build
  // compares the entries it sent by their type, so another entry is no mismatch (tests/google-pmax-automation-readback.test.mjs, fix round S2-1).
});
