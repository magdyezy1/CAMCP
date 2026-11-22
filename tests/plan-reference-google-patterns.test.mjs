import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {at, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {providerHooks} from '../dist/src/provider-hooks.js';
import {campaignPreflight} from '../dist/src/campaign-preflight.js';
import {MirrorError} from '../dist/src/errors.js';

/**
 * Package r25-field3-refs, item 3 (AMCP-01, F1-4): the stand-in of a Google create has the parts of its resource name. The composite table of the
 * preflight knew three kinds (ad group ads, ad group criteria, campaign criteria) and the four asset links, so the result of an asset group signal,
 * a listing group filter, a bid modifier, a shared criterion, a campaign shared set, an asset set link or a label link got a name of one part, which
 * no check of a composite name accepts. The parts are now read from the resource name pattern of the pinned Google descriptors
 * (src/google-legacy-mapping.json, `resourcePattern`), so no collection is a hand-written row. Customer 123 and invented numbers only.
 */
const hook = providerHooks('google_ads_native_action').campaign.preflight.reference;
const mapping = JSON.parse(fs.readFileSync('src/google-legacy-mapping.json', 'utf8'));
/** The stand-in of the n-th result of a mutate of `collection`, whose create names `fieldType`. */
const standIn = (collection, n, fieldType) =>
  hook({
    path: '/payload/x',
    ref: 'p#/data/results/0/resourceName',
    ordinal: n,
    parent: {gateway: 'google_ads_native_action', account_id: '123', arguments: {action: 'a'}},
    compile: () => ({
      path: '/v25/customers/123/' + collection + ':mutate',
      body: {operations: [{create: fieldType === undefined ? {name: 'x'} : {fieldType}}]},
    }),
  });

test('the result of a create is named with the parts of its resource name, the number in each id part and the field type as sent', () => {
  // Each row is Google's own resource name for the collection (customers/{customer_id}/<collection>/<ids>), written out here, not read from the code.
  const expected = {
    campaigns: '5',
    campaignBudgets: '5',
    adGroups: '5',
    assets: '5',
    assetGroups: '5',
    conversionActions: '5',
    labels: '5',
    customerLabels: '5',
    adGroupAds: '5~5',
    adGroupCriteria: '5~5',
    campaignCriteria: '5~5',
    assetGroupSignals: '5~5',
    assetGroupListingGroupFilters: '5~5',
    adGroupBidModifiers: '5~5',
    campaignBidModifiers: '5~5',
    sharedCriteria: '5~5',
    campaignSharedSets: '5~5',
    campaignAssetSets: '5~5',
    adGroupAssetSets: '5~5',
    assetSetAssets: '5~5',
    campaignLabels: '5~5',
    adGroupLabels: '5~5',
    adGroupCustomizers: '5~5',
    campaignCustomizers: '5~5',
    adGroupAdLabels: '5~5~5',
    adGroupCriterionLabels: '5~5~5',
  };
  for (const [collection, id] of Object.entries(expected))
    assert.equal(standIn(collection, 5), 'customers/123/' + collection + '/' + id, collection);
  // The asset links name their field type, as the create sends it.
  assert.equal(standIn('assetGroupAssets', 5, 'HEADLINE'), 'customers/123/assetGroupAssets/5~5~HEADLINE');
  assert.equal(standIn('campaignAssets', 2, 'SITELINK'), 'customers/123/campaignAssets/2~2~SITELINK');
  assert.equal(standIn('adGroupAssets', 7, 'CALLOUT'), 'customers/123/adGroupAssets/7~7~CALLOUT');
  assert.equal(standIn('customerAssets', 5, 'CALL'), 'customers/123/customerAssets/5~CALL');
  // A collection the descriptors do not know is one number, as before.
  assert.equal(standIn('notACollection', 5), 'customers/123/notACollection/5');
});

test('every customer collection of the pinned descriptors is named by its own pattern, so no collection is a hand-written row', () => {
  const rows = Object.values(mapping.googleProto.descriptors)
    .map(d =>
      /^customers\/\{customer_id\}\/([A-Za-z]+)\/(\{[a-z_0-9]+\}(?:~\{[a-z_0-9]+\})*)$/.exec(d.resourcePattern ?? ''),
    )
    .filter(Boolean);
  assert.ok(rows.length > 100, 'the descriptors name over a hundred customer collections: ' + rows.length);
  for (const [, collection, ids] of rows) {
    const parts = ids.split('~').map(p => p.slice(1, -1)),
      symbolic = parts.includes('field_type');
    assert.equal(
      standIn(collection, 3, symbolic ? 'HEADLINE' : undefined),
      'customers/123/' + collection + '/' + parts.map(p => (p === 'field_type' ? 'HEADLINE' : '3')).join('~'),
      collection + ' ' + ids,
    );
  }
});

test('an association create without its exact field type is still refused INVALID_REFERENCE, whichever level it links', () => {
  for (const collection of ['campaignAssets', 'adGroupAssets', 'customerAssets', 'assetGroupAssets'])
    for (const type of [undefined, 'headline', 7])
      assert.throws(
        () => standIn(collection, 1, type),
        e => e instanceof MirrorError && e.code === 'INVALID_REFERENCE',
        collection + ' ' + String(type),
      );
});

test('a step that removes the signal an earlier step creates is checked: the signal’s name has its two parts', async () => {
  const f = googleReconcileFixture({tenant: 'plan-reference-google-patterns'});
  try {
    const step = (id, args, depends_on = []) => ({
      id,
      kind: 'write',
      gateway: 'google_ads_native_action',
      connection_id: 'g',
      account_id: '123',
      description: id,
      arguments: args,
      depends_on,
    });
    const out = await campaignPreflight(f.service, f.actor, [
      step('signal', {
        action: 'google_ads_v23_asset_group_signal_mutate_asset_group_signals',
        payload: {
          operations: [{create: {asset_group: at('assetGroups', '77'), search_theme: {text: 'synthetic theme'}}}],
        },
      }),
      step(
        'unsignal',
        {
          action: 'google_ads_v23_asset_group_signal_mutate_asset_group_signals',
          payload: {operations: [{remove: {$ref: 'signal#/data/results/0/resourceName'}}]},
        },
        ['signal'],
      ),
    ]);
    const check = out.checks.find(c => c.step === 'unsignal');
    assert.equal(check.status, 'contract_checked', JSON.stringify(check.error));
    assert.equal(check.references_deferred, 1);
  } finally {
    f.close();
  }
});
