// CMP-07: google_serving_diagnostics. A synthetic Google customer answers the fixed GAQL projections; nothing reaches
// Google. Every primary status and reason of the pinned v25 schema passes through as its native symbol and renders with
// an explanation in English and Arabic; a symbol a later version adds lands in the unknown bucket as itself; policy
// evidence is never returned; incomplete, foreign or malformed pages are refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {googleServingEnums, servingLevels} from '../dist/src/google-serving-diagnostics.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

const account = '123',
  campaign = '9007199254740993',
  group = '444',
  ad = '555',
  assetGroup = '666',
  asset = '777';
const owner = {tenantId: 'google-serving', userId: 'reader', role: 'admin'};
const pinned = (() => {
  const raw = JSON.parse(readFileSync('.mirror/VENDOR/google-ads-v25.json', 'utf8'));
  return (typeof raw.document === 'string' ? JSON.parse(raw.document) : raw.document).schemas;
})();
const resource = name => pinned['GoogleAdsGoogleadsV25Resources__' + name].properties;
const enumOf = p => p.enum ?? p.items?.enum;

function rowsFor(query, reasons) {
  const customer = {id: account, resourceName: 'customers/' + account},
    c = {id: campaign, resourceName: `customers/${account}/campaigns/${campaign}`};
  if (query.includes(' FROM campaign '))
    return [
      {
        customer,
        campaign: {
          ...c,
          name: 'Exact campaign',
          status: 'ENABLED',
          servingStatus: 'SERVING',
          primaryStatus: 'LIMITED',
          primaryStatusReasons: reasons.campaign,
          biddingStrategySystemStatus: 'LEARNING_NEW',
          advertisingChannelType: 'PERFORMANCE_MAX',
        },
      },
    ];
  if (query.includes(' FROM ad_group_ad '))
    return [
      {
        customer,
        campaign: c,
        adGroup: {id: group, resourceName: `customers/${account}/adGroups/${group}`},
        adGroupAd: {
          resourceName: `customers/${account}/adGroupAds/${group}~${ad}`,
          status: 'ENABLED',
          ad: {id: ad, name: 'Exact ad'},
          primaryStatus: 'NOT_ELIGIBLE',
          primaryStatusReasons: reasons.ad,
          policySummary: {
            approvalStatus: 'DISAPPROVED',
            reviewStatus: 'REVIEWED',
            policyTopicEntries: [
              {
                topic: 'TRADEMARKS_IN_AD_TEXT',
                type: 'PROHIBITED',
                evidences: [{textList: {texts: ['CANARY-EVIDENCE']}}],
              },
              {topic: 'FUTURE_TOPIC', type: 'FUTURE_TYPE_V26'},
            ],
          },
          adStrength: 'POOR',
          actionItems: ['Try adding a few more unique headlines.'],
        },
      },
    ];
  if (query.includes(' FROM ad_group '))
    return [
      {
        customer,
        campaign: c,
        adGroup: {
          id: group,
          resourceName: `customers/${account}/adGroups/${group}`,
          name: 'Exact group',
          status: 'ENABLED',
          primaryStatus: 'LIMITED',
          primaryStatusReasons: reasons.ad_group,
        },
      },
    ];
  if (query.includes(' FROM asset_group_asset '))
    return [
      {
        customer,
        campaign: c,
        assetGroup: {id: assetGroup, resourceName: `customers/${account}/assetGroups/${assetGroup}`},
        assetGroupAsset: {
          resourceName: `customers/${account}/assetGroupAssets/${assetGroup}~${asset}~HEADLINE`,
          asset: `customers/${account}/assets/${asset}`,
          fieldType: 'HEADLINE',
          status: 'ENABLED',
          primaryStatus: 'NOT_ELIGIBLE',
          primaryStatusReasons: reasons.asset_group_asset,
          policySummary: {approvalStatus: 'APPROVED_LIMITED', reviewStatus: 'REVIEWED', policyTopicEntries: []},
        },
      },
    ];
  if (query.includes(' FROM asset_group '))
    return [
      {
        customer,
        campaign: c,
        assetGroup: {
          id: assetGroup,
          resourceName: `customers/${account}/assetGroups/${assetGroup}`,
          name: 'Exact asset group',
          status: 'ENABLED',
          primaryStatus: 'LIMITED',
          primaryStatusReasons: reasons.asset_group,
          adStrength: 'AVERAGE',
        },
      },
    ];
  return [];
}
function fixture(t, {reasons, edit = (_q, d) => d} = {}) {
  const actor = {...owner, role: 'reader'},
    store = new Store(':memory:', Buffer.alloc(32, 103).toString('base64'));
  t.after(() => store.close());
  const connection = {
    id: 'eeeeeeee-2222-4222-8222-222222222222',
    tenantId: actor.tenantId,
    gateway: 'google_ads_native_action',
    enabled: true,
    label: 'Synthetic Google',
    accounts: [account],
    scopes: ['https://www.googleapis.com/auth/adwords'],
  };
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  const requests = [];
  const all = Object.fromEntries(servingLevels.map(l => [l, googleServingEnums[l].primary_status_reasons]));
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (url, init) => {
        const query = JSON.parse(init.body).query;
        requests.push({url: String(url), method: init.method, query});
        return Response.json(edit(query, {results: rowsFor(query, reasons ?? all)}));
      },
      async () => {},
    ),
  );
  return {
    requests,
    call: (extra = {}) =>
      service.call(
        'amcp_reporting',
        {action: 'serving_diagnostics', account_id: account, connection_id: connection.id, ...extra},
        actor,
      ),
  };
}

test('the pinned enum lists match the v25 Discovery document, so a version change fails here first', () => {
  const names = {
    campaign: 'Campaign',
    ad_group: 'AdGroup',
    ad: 'AdGroupAd',
    asset_group: 'AssetGroup',
    asset_group_asset: 'AssetGroupAsset',
  };
  for (const level of servingLevels) {
    const p = resource(names[level]);
    assert.deepEqual(googleServingEnums[level].primary_status, enumOf(p.primaryStatus), level);
    assert.deepEqual(googleServingEnums[level].primary_status_reasons, enumOf(p.primaryStatusReasons), level);
  }
  assert.deepEqual(googleServingEnums.ad_strength, enumOf(resource('AdGroupAd').adStrength));
  const summary = pinned.GoogleAdsGoogleadsV25Resources__AdGroupAdPolicySummary.properties;
  assert.deepEqual(googleServingEnums.approval_status, enumOf(summary.approvalStatus));
  assert.deepEqual(googleServingEnums.review_status, enumOf(summary.reviewStatus));
  assert.deepEqual(
    googleServingEnums.policy_topic_type,
    enumOf(pinned.GoogleAdsGoogleadsV25Common__PolicyTopicEntry.properties.type),
  );
});

test('every level is one bounded read; native symbols pass through, unknown ones are bucketed and evidence is withheld', async t => {
  const f = fixture(t, {
    reasons: {
      campaign: ['BUDGET_CONSTRAINED', 'BIDDING_STRATEGY_LEARNING', 'A_REASON_FROM_V26'],
      ad_group: ['HAS_ADS_DISAPPROVED'],
      ad: ['AD_GROUP_AD_DISAPPROVED'],
      asset_group: ['ASSET_GROUP_LIMITED'],
      asset_group_asset: ['ASSET_DISAPPROVED'],
    },
  });
  const out = await f.call({campaign_id: campaign});
  assert.equal(out.success, true, JSON.stringify(out.error));
  const d = out.data;
  assert.equal(f.requests.length, 5, 'one read per level');
  assert.ok(
    f.requests.every(
      r =>
        r.method === 'POST' &&
        /\/customers\/123\/googleAds:search$/.test(r.url) &&
        r.query.includes(`campaign.id = ${campaign}`) &&
        /LIMIT 51$/.test(r.query),
    ),
  );
  assert.deepEqual(
    d.rows.map(r => r.level),
    servingLevels,
  );
  const byLevel = Object.fromEntries(d.rows.map(r => [r.level, r]));
  assert.equal(byLevel.campaign.id, campaign, 'int64 IDs stay exact');
  assert.deepEqual(byLevel.campaign.primary_status_reasons, [
    'BUDGET_CONSTRAINED',
    'BIDDING_STRATEGY_LEARNING',
    'A_REASON_FROM_V26',
  ]);
  assert.deepEqual(byLevel.campaign.unknown_symbols, ['A_REASON_FROM_V26']);
  assert.equal(byLevel.ad.policy.approval_status, 'DISAPPROVED');
  assert.deepEqual(byLevel.ad.policy.topics, [
    {topic: 'TRADEMARKS_IN_AD_TEXT', type: 'PROHIBITED'},
    {topic: 'FUTURE_TOPIC', type: 'FUTURE_TYPE_V26'},
  ]);
  assert.deepEqual(byLevel.ad.unknown_symbols, ['FUTURE_TYPE_V26']);
  assert.equal(byLevel.ad.ad_strength, 'POOR');
  assert.deepEqual(byLevel.ad.action_items, ['Try adding a few more unique headlines.']);
  assert.equal(byLevel.asset_group.ad_strength, 'AVERAGE');
  assert.equal(byLevel.asset_group_asset.field_type, 'HEADLINE');
  assert.equal(byLevel.asset_group_asset.asset_id, asset);
  assert.doesNotMatch(JSON.stringify(d), /CANARY-EVIDENCE/, 'policy evidence is never returned');
  assert.equal(d.summary.campaign.primary_status.LIMITED, 1);
  assert.equal(d.summary.campaign.reasons.A_REASON_FROM_V26, 1);
  assert.deepEqual(d.summary.campaign.unknown_symbols, ['A_REASON_FROM_V26']);
  assert.equal(d.has_more, false);
  // A level narrowed to one choice reads once.
  const only = await f.call({options: {levels: ['campaign'], limit: 1}});
  assert.equal(only.success, true);
  assert.equal(f.requests.length, 6);
  assert.match(
    f.requests.at(-1).query,
    /FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.id LIMIT 2$/,
  );
});

test('incomplete, foreign or malformed pages and unqualified options are refused', async t => {
  for (const [edit, code] of [
    [(_q, d) => ({...d, nextPageToken: 'more'}), 'SERVING_DIAGNOSTICS_INCOMPLETE'],
    [
      (_q, d) => ({results: d.results.map(r => ({...r, customer: {id: '999'}}))}),
      'SERVING_DIAGNOSTICS_INVALID_RESPONSE',
    ],
    [
      (q, d) =>
        q.includes(' FROM campaign ')
          ? {results: d.results.map(r => ({...r, campaign: {...r.campaign, primaryStatus: 'eligible <b>'}}))}
          : d,
      'SERVING_DIAGNOSTICS_INVALID_RESPONSE',
    ],
    [
      (q, d) =>
        q.includes(' FROM ad_group ')
          ? {
              results: d.results.map(r => ({
                ...r,
                adGroup: {...r.adGroup, resourceName: 'customers/999/adGroups/' + group},
              })),
            }
          : d,
      'STATE_TARGET_MISMATCH',
    ],
  ]) {
    const f = fixture(t, {edit});
    assertRefused(await f.call(), code);
  }
  const f = fixture(t);
  for (const [extra, code] of [
    [{options: {levels: ['keyword']}}, 'INVALID_ARGUMENT'],
    [{options: {levels: ['campaign', 'campaign']}}, 'INVALID_ARGUMENT'],
    [{options: {limit: 101}}, 'INVALID_ARGUMENT'],
    [{options: {other: true}}, 'INVALID_ARGUMENT'],
    [{campaign_id: 'abc'}, 'INVALID_ARGUMENT'],
    [{gateway: 'meta_native_action'}, 'DIAGNOSTICS_UNSUPPORTED_GATEWAY'],
  ])
    assertRefused(await f.call(extra), code);
  assert.equal(f.requests.length, 0, 'option refusals happen before any read');
});

for (const locale of ['en', 'ar']) {
  test(
    'serving diagnostics ' + locale + ' render every pinned status and reason with its explanation and native symbol',
    () => {
      const ui = accountWorkflowFixture(locale),
        catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
        labels = ui.run('servingLabels');
      const symbols = new Set([
        ...servingLevels.flatMap(l => [
          ...googleServingEnums[l].primary_status,
          ...googleServingEnums[l].primary_status_reasons,
        ]),
        ...googleServingEnums.approval_status,
        ...googleServingEnums.review_status,
        ...googleServingEnums.policy_topic_type,
        ...googleServingEnums.ad_strength,
      ]);
      for (const s of symbols) {
        assert.ok(Object.hasOwn(labels, s), 'an explanation for ' + s);
        assert.ok(catalog[labels[s]], 'Arabic for ' + labels[s]);
      }
      // One row per level carrying every reason of that level.
      ui.context.serving = {
        has_more: true,
        rows: servingLevels.map(level => ({
          level,
          id: '1',
          name: 'Native <img onerror=bad>',
          primary_status: googleServingEnums[level].primary_status.at(-1),
          primary_status_reasons: [...googleServingEnums[level].primary_status_reasons, 'A_REASON_FROM_V26'],
          unknown_symbols: ['A_REASON_FROM_V26'],
          ...(level === 'ad'
            ? {
                ad_strength: 'POOR',
                policy: {
                  approval_status: 'DISAPPROVED',
                  review_status: 'REVIEWED',
                  topics: [{topic: 'T', type: 'LIMITED'}],
                },
                action_items: ['Native <script> suggestion'],
              }
            : {}),
        })),
      };
      const html = ui.run('servingDiagnosticsView(serving)');
      for (const level of servingLevels)
        for (const s of googleServingEnums[level].primary_status_reasons) {
          assert.ok(html.includes(`<code dir="ltr">${s}</code>`), s + ' is shown literally');
          const label = locale === 'ar' ? catalog[labels[s]] : labels[s];
          assert.ok(html.includes(label), s + ' has its ' + locale + ' explanation');
        }
      assert.match(html, /A_REASON_FROM_V26/);
      assert.match(html, locale === 'ar' ? /غير مسمّى في هذا الإصدار من AMCP/ : /Not named by this version of AMCP/);
      assert.match(html, locale === 'ar' ? /تشخيص العرض في Google/ : /Google serving diagnostics/);
      assert.match(html, /Native &lt;img onerror=bad&gt;/);
      assert.match(html, /Native &lt;script&gt; suggestion/);
      assert.doesNotMatch(html, /<img|<script/);
    },
  );
}
