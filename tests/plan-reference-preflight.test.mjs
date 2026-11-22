import test from 'node:test';
import assert from 'node:assert/strict';
import {at, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {checkOf, step as providerStep, world} from './helpers/plan-reference-world.mjs';
import {campaignPreflight} from '../dist/src/campaign-preflight.js';

/**
 * Package r25-field3-refs, item 1 (the owner's second Google report of 2026-11-21, AMCP-01): a plan's preflight gave every reference to an
 * earlier step's create ONE stand-in per collection, so 25 different new assets read as one asset and a within-request duplicate check
 * refused the step (`INVALID_ASSET_LINK`: "Each association may occur only once in a reviewed batch", operation 1, first_operation 0). No single
 * approved plan could create assets and link them. Each reference to a different result now has a stand-in of its own, and two references to the
 * SAME result are one identity and are still refused as a duplicate. Everything here is synthetic (customer 123); nothing leaves the process.
 */
const group = at('assetGroups', '77'),
  campaign = at('campaigns', '10');
let tenants = 0;
const google = () => googleReconcileFixture({tenant: 'plan-reference-preflight-' + ++tenants});
const googleStep = (id, args, depends_on = []) => ({
  id,
  kind: 'write',
  gateway: 'google_ads_native_action',
  connection_id: 'g',
  account_id: '123',
  description: id,
  arguments: args,
  depends_on,
});
/** A step that creates `texts` as text assets, in one AssetService mutate. */
const textAssets = (id, texts) =>
  googleStep(id, {
    action: 'google_ads_v23_asset_mutate_assets',
    payload: {operations: texts.map(text => ({create: {text_asset: {text}}}))},
  });
const ref = (step, i) => ({$ref: step + '#/data/results/' + i + '/resourceName'});
/** One asset group link per reference, all with `type`. */
const groupLinks = (id, refs, type = 'HEADLINE', depends_on) =>
  googleStep(
    id,
    {
      action: 'google_ads_v23_asset_group_asset_mutate_asset_group_assets',
      payload: {operations: refs.map(asset => ({create: {asset_group: group, field_type: type, asset}}))},
    },
    depends_on ?? [...new Set(refs.map(r => r.$ref.split('#')[0]))],
  );
const texts = n => Array.from({length: n}, (_, i) => 'Synthetic headline ' + String.fromCharCode(65 + i));
const references = (step, n) => Array.from({length: n}, (_, i) => ref(step, i));

test('R1: three links to three results of one asset create are checked, each reference deferred', async () => {
  const f = google();
  try {
    const out = await campaignPreflight(f.service, f.actor, [
      textAssets('en_texts', texts(3)),
      groupLinks('en_text_links', references('en_texts', 3)),
    ]);
    const links = checkOf(out, 'en_text_links');
    assert.equal(links.status, 'contract_checked', JSON.stringify(links.error));
    assert.equal(links.references_deferred, 3);
    assert.equal(out.status, 'ready');
    assert.equal(f.writes.length, 0, 'a preflight sends no write');
  } finally {
    f.close();
  }
});

// F1-3 (item 2): what the preflight cannot judge for a reference it says so, and it says how the identity of references is judged: here by the result
// each one names, and again on the resolved IDs when the step is prepared (N3 of tests/plan-reference-lifecycle.test.mjs proves the second).
test('F1-3: the deferral of a step with references says its identity is judged again on the resolved IDs when the step is prepared', async () => {
  const f = google();
  try {
    const out = await campaignPreflight(f.service, f.actor, [
      textAssets('en_texts', texts(3)),
      groupLinks('en_text_links', references('en_texts', 3)),
    ]);
    const deferrals = out.deferred.filter(d => d.step === 'en_text_links');
    assert.equal(deferrals.length, 1, JSON.stringify(out.deferred));
    const [deferral] = deferrals;
    assert.deepEqual(
      deferral.fields,
      [0, 1, 2].map(i => '/payload/operations/' + i + '/create/asset'),
    );
    assert.equal(deferral.identity_rechecked_at_prepare, true);
    assert.match(
      deferral.reason,
      /Duplicates among references are judged here by predecessor result, and again on the resolved IDs when the step is prepared\./,
    );
    // The earlier sentence stays: exact parent ownership and the provider's validation are judged when the step is prepared.
    assert.match(
      deferral.reason,
      /^These fields depend on IDs from verified predecessors; exact parent ownership and provider validation occur when the step is prepared\./,
    );
    // A step with no reference has no such deferral, and says nothing of identity.
    assert.equal(
      out.deferred.some(d => d.step === 'en_texts'),
      false,
    );
    assert.equal(
      out.deferred.filter(d => d.step !== 'en_text_links').some(d => d.identity_rechecked_at_prepare !== undefined),
      false,
    );
  } finally {
    f.close();
  }
});

test('R1b: the owner’s shape, twenty-five texts linked in one step as HEADLINE and DESCRIPTION, is checked whole', async () => {
  const f = google();
  try {
    const out = await campaignPreflight(f.service, f.actor, [
      textAssets('en_texts', texts(25)),
      googleStep(
        'en_text_links',
        {
          action: 'google_ads_v23_asset_group_asset_mutate_asset_group_assets',
          payload: {
            operations: references('en_texts', 25).map((asset, i) => ({
              create: {asset_group: group, field_type: i < 15 ? 'HEADLINE' : 'DESCRIPTION', asset},
            })),
          },
        },
        ['en_texts'],
      ),
    ]);
    const links = checkOf(out, 'en_text_links');
    assert.equal(links.status, 'contract_checked', JSON.stringify(links.error));
    assert.equal(links.references_deferred, 25);
  } finally {
    f.close();
  }
});

test('R2: two images uploaded by two media steps are linked as two MARKETING_IMAGE links in one step', async () => {
  const f = google();
  try {
    const media = id => ({
      id,
      kind: 'media',
      connection_id: 'g',
      account_id: '123',
      description: id,
      arguments: {platform: 'google_ads', action: 'prepare_library'},
      depends_on: [],
    });
    const out = await campaignPreflight(f.service, f.actor, [
      media('image_a'),
      media('image_b'),
      groupLinks('image_links', [{$ref: 'image_a#/media_id'}, {$ref: 'image_b#/media_id'}], 'MARKETING_IMAGE', [
        'image_a',
        'image_b',
      ]),
    ]);
    const links = checkOf(out, 'image_links');
    assert.equal(links.status, 'contract_checked', JSON.stringify(links.error));
    assert.equal(links.references_deferred, 2);
  } finally {
    f.close();
  }
});

/** A valid Performance Max build whose two marketing images are the given assets (references or names). */
function pmaxBuild(images) {
  const text = (n, value) => ({
      asset_operation: {create: {resource_name: at('assets', '-' + n), text_asset: {text: value}}},
    }),
    link = (asset, field_type) => ({
      asset_group_asset_operation: {create: {asset_group: at('assetGroups', '-20'), asset, field_type}},
    }),
    words = [
      ['HEADLINE', 'Synthetic one'],
      ['HEADLINE', 'Synthetic two'],
      ['HEADLINE', 'Synthetic three'],
      ['LONG_HEADLINE', 'Synthetic long headline'],
      ['DESCRIPTION', 'Synthetic words.'],
      ['DESCRIPTION', 'More words.'],
      ['BUSINESS_NAME', 'Synthetic'],
    ];
  return [
    {
      campaign_budget_operation: {
        create: {
          resource_name: at('campaignBudgets', '-1'),
          name: 'Synthetic budget',
          amount_micros: '50000000',
          delivery_method: 'STANDARD',
          explicitly_shared: false,
        },
      },
    },
    {
      campaign_operation: {
        create: {
          resource_name: at('campaigns', '-2'),
          name: 'Synthetic PMax',
          status: 'PAUSED',
          advertising_channel_type: 'PERFORMANCE_MAX',
          campaign_budget: at('campaignBudgets', '-1'),
          maximize_conversions: {},
          brand_guidelines_enabled: false,
          contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        },
      },
    },
    ...words.map(([, value], i) => text(100 + i, value)),
    {
      asset_group_operation: {
        create: {
          resource_name: at('assetGroups', '-20'),
          name: 'Synthetic group',
          campaign: at('campaigns', '-2'),
          final_urls: ['https://example.test/'],
          status: 'ENABLED',
        },
      },
    },
    ...words.map(([type], i) => link(at('assets', '-' + (100 + i)), type)),
    ...images.map(asset => link(asset, 'MARKETING_IMAGE')),
    link(at('assets', '502'), 'SQUARE_MARKETING_IMAGE'),
    link(at('assets', '503'), 'LOGO'),
  ];
}

test('R3: two uploaded images feed one Performance Max build, each its own asset', async () => {
  const f = google();
  try {
    const media = id => ({
      id,
      kind: 'media',
      connection_id: 'g',
      account_id: '123',
      description: id,
      arguments: {platform: 'google_ads', action: 'prepare_library'},
      depends_on: [],
    });
    const out = await campaignPreflight(f.service, f.actor, [
      media('image_a'),
      media('image_b'),
      googleStep(
        'build',
        {
          action: 'google_ads_v23_google_ads_mutate',
          payload: {mutate_operations: pmaxBuild([{$ref: 'image_a#/media_id'}, {$ref: 'image_b#/media_id'}])},
        },
        ['image_a', 'image_b'],
      ),
    ]);
    const build = checkOf(out, 'build');
    assert.equal(build.status, 'contract_checked', JSON.stringify(build.error));
    assert.equal(build.references_deferred, 2);
  } finally {
    f.close();
  }
});

test('R4: six sitelinks created in one step are linked to a campaign in one step', async () => {
  const f = google();
  try {
    const out = await campaignPreflight(f.service, f.actor, [
      googleStep('sitelinks', {
        action: 'google_ads_v23_asset_mutate_assets',
        payload: {
          operations: Array.from({length: 6}, (_, i) => ({
            create: {
              sitelink_asset: {link_text: 'Synthetic link ' + (i + 1)},
              final_urls: ['https://example.test/page-' + (i + 1)],
            },
          })),
        },
      }),
      googleStep(
        'sitelink_links',
        {
          action: 'google_ads_v23_campaign_asset_mutate_campaign_assets',
          payload: {
            operations: references('sitelinks', 6).map(asset => ({create: {campaign, field_type: 'SITELINK', asset}})),
          },
        },
        ['sitelinks'],
      ),
    ]);
    const links = checkOf(out, 'sitelink_links');
    assert.equal(links.status, 'contract_checked', JSON.stringify(links.error));
    assert.equal(links.references_deferred, 6);
  } finally {
    f.close();
  }
});

// N1 (the gate stays): two references to the SAME result are one asset, and one asset may not be linked twice with one field type.
test('N1: two links that reference the same result are still refused as a duplicate at the preflight', async () => {
  const f = google();
  try {
    const out = await campaignPreflight(f.service, f.actor, [
      textAssets('en_texts', texts(3)),
      groupLinks('en_text_links', [ref('en_texts', 0), ref('en_texts', 0)]),
    ]);
    const links = checkOf(out, 'en_text_links');
    assert.equal(links.status, 'blocked');
    assert.equal(links.error.code, 'INVALID_ASSET_LINK');
    assert.equal(links.error.details.operation, 1);
    assert.equal(links.error.details.first_operation, 0);
    assert.equal(out.status, 'blocked');
  } finally {
    f.close();
  }
});

// The duplicate is the repeat of one RESULT, wherever it stands: the first operation is the one that named the result first, not operation 0 of
// the list (before the fix every reference was one identity, so the second link was always the duplicate of the first).
test('N1b: a result named twice is refused at the position of its repeat, naming the link it repeats', async () => {
  const f = google();
  try {
    const out = await campaignPreflight(f.service, f.actor, [
      textAssets('en_texts', texts(3)),
      groupLinks('en_text_links', [ref('en_texts', 0), ref('en_texts', 1), ref('en_texts', 0)]),
    ]);
    const links = checkOf(out, 'en_text_links');
    assert.equal(links.status, 'blocked');
    assert.equal(links.error.code, 'INVALID_ASSET_LINK');
    assert.equal(links.error.details.operation, 2, 'the third link repeats the first');
    assert.equal(links.error.details.first_operation, 0);
  } finally {
    f.close();
  }
});

// N2 (the gate stays): a reference to an update names the resource that update changes, so it IS that resource and the same literal name is a duplicate.
test('N2: a reference to an update predecessor and the same literal name are still one link, refused as a duplicate', async () => {
  const f = google(),
    linkName = at('assetGroupAssets', '77~5~HEADLINE'),
    pause = status => ({
      action: 'google_ads_v23_asset_group_asset_mutate_asset_group_assets',
      payload: {operations: [{update: {resource_name: linkName, status}, update_mask: 'status'}]},
    });
  try {
    const out = await campaignPreflight(f.service, f.actor, [
      googleStep('pause_link', pause('PAUSED')),
      googleStep(
        'again',
        {
          action: 'google_ads_v23_asset_group_asset_mutate_asset_group_assets',
          payload: {
            operations: [
              {update: {resource_name: ref('pause_link', 0), status: 'ENABLED'}, update_mask: 'status'},
              {update: {resource_name: linkName, status: 'ENABLED'}, update_mask: 'status'},
            ],
          },
        },
        ['pause_link'],
      ),
    ]);
    const again = checkOf(out, 'again');
    assert.equal(again.status, 'blocked');
    assert.equal(again.error.code, 'INVALID_ASSET_LINK');
    assert.equal(again.error.details.first_operation, 0);
  } finally {
    f.close();
  }
});

// R5: the same collapse in the other providers (Microsoft, TikTok, LinkedIn, Snapchat): each provider's own within-request duplicate check
// refused two references to two different predecessors, because every reference read the same stand-in.
test('R5: Microsoft, two new ad groups are named in one AdGroupIds list', async () => {
  const w = world(['microsoft_ads_native_action']),
    gateway = 'microsoft_ads_native_action';
  try {
    const out = await w.preflight([
      providerStep(gateway, 'add', {
        action: 'AddAdGroups',
        payload: {
          CampaignId: '10',
          AdGroups: [
            {Name: 'Synthetic A', Status: 'Paused'},
            {Name: 'Synthetic B', Status: 'Paused'},
          ],
        },
      }),
      providerStep(
        gateway,
        'delete',
        {
          action: 'DeleteAdGroups',
          payload: {
            CampaignId: '10',
            AdGroupIds: [{$ref: 'add#/data/AdGroupIds/0'}, {$ref: 'add#/data/AdGroupIds/1'}],
          },
        },
        ['add'],
      ),
    ]);
    const check = checkOf(out, 'delete');
    assert.equal(check.status, 'contract_checked', JSON.stringify(check.error));
    assert.equal(check.references_deferred, 2);
  } finally {
    w.close();
  }
});

const tiktokAdGroup = {
  action: 'tiktok_adgroup_create',
  payload: {
    advertiser_id: '123',
    campaign_id: '300',
    adgroup_name: 'Synthetic ad group',
    promotion_type: 'WEBSITE',
    placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
    location_ids: ['6252001'],
    budget_mode: 'BUDGET_MODE_DAY',
    budget: 50,
    schedule_type: 'SCHEDULE_FROM_NOW',
    schedule_start_time: '2027-01-01 00:00:00',
    optimization_goal: 'CLICK',
    billing_event: 'CPC',
    bid_type: 'BID_TYPE_NO_BID',
    operation_status: 'DISABLE',
  },
};
test('R5: TikTok, one budget update names two ad groups that two earlier steps create', async () => {
  const w = world(['tiktok_native_action']),
    gateway = 'tiktok_native_action';
  try {
    const out = await w.preflight([
      providerStep(gateway, 'ag1', tiktokAdGroup),
      providerStep(gateway, 'ag2', tiktokAdGroup),
      providerStep(
        gateway,
        'budget',
        {
          action: 'tiktok_adgroup_budget_update',
          payload: {
            budget: [
              {adgroup_id: {$ref: 'ag1#/data/data/adgroup_id'}, budget: 1200},
              {adgroup_id: {$ref: 'ag2#/data/data/adgroup_id'}, budget: 1300},
            ],
          },
        },
        ['ag1', 'ag2'],
      ),
    ]);
    const check = checkOf(out, 'budget');
    assert.equal(check.status, 'contract_checked', JSON.stringify(check.error));
    assert.equal(check.references_deferred, 2);
  } finally {
    w.close();
  }
});

test('R5: LinkedIn, two conversion pairs name two campaigns that two earlier steps create', async () => {
  const w = world(['linkedin_native_action']),
    gateway = 'linkedin_native_action';
  try {
    const campaignRef = id => ({$ref: id + '#/created_id', prefix: 'urn:li:sponsoredCampaign:'}),
      out = await w.preflight([
        providerStep(gateway, 'c1', {
          action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post',
          payload: {name: 'Synthetic'},
        }),
        providerStep(gateway, 'c2', {
          action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post',
          payload: {name: 'Synthetic'},
        }),
        providerStep(
          gateway,
          'unlink',
          {
            action: 'linkedin_rest_campaign_conversions_delete',
            restli_method: 'BATCH_DELETE',
            query: {
              ids: [
                {campaign: campaignRef('c1'), conversion: 'urn:lla:llaPartnerConversion:789'},
                {campaign: campaignRef('c2'), conversion: 'urn:lla:llaPartnerConversion:789'},
              ],
            },
          },
          ['c1', 'c2'],
        ),
      ]);
    const check = checkOf(out, 'unlink');
    assert.equal(check.status, 'contract_checked', JSON.stringify(check.error));
    assert.equal(check.references_deferred, 2);
  } finally {
    w.close();
  }
});

test('R5: Snapchat, one product set update names two sets that two earlier steps create', async () => {
  const w = world(['snapchat_native_action']),
    gateway = 'snapchat_native_action';
  try {
    const create = name => ({
        action: 'snapchat_catalogs_catalog_id_product_sets_create',
        params: {catalog_id: 'cat-1'},
        payload: {product_sets: [{name, filter: {AVAILABILITY: {EQ: 'IN_STOCK'}}}]},
      }),
      out = await w.preflight([
        providerStep(gateway, 'set_a', create('Synthetic set A')),
        providerStep(gateway, 'set_b', create('Synthetic set B')),
        providerStep(
          gateway,
          'rename',
          {
            action: 'snapchat_catalogs_catalog_id_product_sets_update',
            params: {catalog_id: 'cat-1'},
            payload: {
              product_sets: [
                {
                  id: {$ref: 'set_a#/data/product_sets/0/product_set/id'},
                  name: 'Synthetic one',
                  filter: {AVAILABILITY: {EQ: 'IN_STOCK'}},
                },
                {
                  id: {$ref: 'set_b#/data/product_sets/0/product_set/id'},
                  name: 'Synthetic two',
                  filter: {AVAILABILITY: {EQ: 'IN_STOCK'}},
                },
              ],
            },
          },
          ['set_a', 'set_b'],
        ),
      ]);
    const check = checkOf(out, 'rename');
    assert.equal(check.status, 'contract_checked', JSON.stringify(check.error));
    assert.equal(check.references_deferred, 2);
  } finally {
    w.close();
  }
});

// The gate stays in every provider: two references to the SAME result of one step are one identity.
test('N1: in each provider two references to the same result are still refused as a duplicate', async () => {
  const w = world(['microsoft_ads_native_action', 'tiktok_native_action', 'snapchat_native_action']);
  try {
    const ms = 'microsoft_ads_native_action',
      tt = 'tiktok_native_action',
      sc = 'snapchat_native_action';
    const out = await w.preflight([
      providerStep(ms, 'add', {
        action: 'AddAdGroups',
        payload: {CampaignId: '10', AdGroups: [{Name: 'Synthetic A', Status: 'Paused'}]},
      }),
      providerStep(
        ms,
        'delete',
        {
          action: 'DeleteAdGroups',
          payload: {CampaignId: '10', AdGroupIds: [{$ref: 'add#/data/AdGroupIds/0'}, {$ref: 'add#/data/AdGroupIds/0'}]},
        },
        ['add'],
      ),
      providerStep(tt, 'ag1', tiktokAdGroup),
      providerStep(
        tt,
        'budget',
        {
          action: 'tiktok_adgroup_budget_update',
          payload: {
            budget: [
              {adgroup_id: {$ref: 'ag1#/data/data/adgroup_id'}, budget: 1200},
              {adgroup_id: {$ref: 'ag1#/data/data/adgroup_id'}, budget: 1300},
            ],
          },
        },
        ['ag1'],
      ),
      providerStep(
        sc,
        'rename',
        {
          action: 'snapchat_catalogs_catalog_id_product_sets_update',
          params: {catalog_id: 'cat-1'},
          payload: {
            product_sets: [
              {
                id: {$ref: 'set_a#/data/product_sets/0/product_set/id'},
                name: 'Synthetic one',
                filter: {AVAILABILITY: {EQ: 'IN_STOCK'}},
              },
              {
                id: {$ref: 'set_a#/data/product_sets/0/product_set/id'},
                name: 'Synthetic two',
                filter: {AVAILABILITY: {EQ: 'IN_STOCK'}},
              },
            ],
          },
        },
        ['set_a'],
      ),
    ]);
    for (const [id, code] of [
      ['delete', 'INVALID_MICROSOFT_REQUEST'],
      ['budget', 'INVALID_TIKTOK_BUDGET'],
      ['rename', 'INVALID_SNAPCHAT_PRODUCT_SET'],
    ]) {
      const check = checkOf(out, id);
      assert.equal(check.status, 'blocked', id);
      assert.equal(check.error.code, code, id);
    }
  } finally {
    w.close();
  }
});
