import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Removal of automatically created assets from an ad or a campaign, Google Ads API v23 (pinned Discovery document:
 * RemoveAutomaticallyCreatedAssets and RemoveCampaignAutomaticallyCreatedAsset; checked 2026-09-27).
 */
const gateway = 'google_ads_native_action',
  registry = new Registry(),
  C = 'customers/123/';
const actions = {
  ad: 'google_ads_v23_ad_group_ad_remove_automatically_created_assets',
  campaign: 'google_ads_v23_automatically_created_asset_removal_remove_campaign_automatically_created_asset',
};
const actor = {tenantId: 'google-auto-assets', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const asset = id => C + 'assets/' + id,
  ad = C + 'adGroupAds/10~20',
  campaign = id => C + 'campaigns/' + id;
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 95).toString('base64')),
    calls = [];
  let writes = 0;
  store.putConnection(
    owner,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Google Ads',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  // ad and campaign links: [owner, asset, field type, source, active]
  const links = [
    [ad, asset(1), 'HEADLINE', 'AUTOMATICALLY_CREATED', true],
    [ad, asset(2), 'DESCRIPTION', 'AUTOMATICALLY_CREATED', true],
    [ad, asset(3), 'HEADLINE', 'ADVERTISER', true],
    [campaign(7), asset(4), 'MARKETING_IMAGE', 'AUTOMATICALLY_CREATED', true],
    [campaign(7), asset(5), 'HEADLINE', 'ADVERTISER', true],
  ];
  const inList = (query, field) =>
    [...(new RegExp(field + ' IN \\(([^)]*)\\)').exec(query)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]);
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = decodeURIComponent(u.pathname),
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({path, body});
      if (path === '/v23/customers/123/googleAds:search') {
        const q = body.query + ' ';
        if (/FROM customer /.test(q))
          return Response.json({results: [{customer: {resourceName: 'customers/123', id: '123'}}]});
        if (/FROM ad_group_ad_asset_view /.test(q)) {
          const owners = inList(q, 'ad_group_ad_asset_view.ad_group_ad');
          return Response.json({
            results: links
              .filter(l => owners.includes(l[0]) && l[3] === 'AUTOMATICALLY_CREATED')
              .map(l => ({adGroupAdAssetView: {adGroupAd: l[0], asset: l[1], fieldType: l[2], enabled: l[4]}})),
          });
        }
        if (/FROM ad_group_ad /.test(q)) {
          const owners = inList(q, 'ad_group_ad.resource_name');
          return Response.json({
            results: owners.filter(o => o === ad).map(o => ({adGroupAd: {resourceName: o, status: 'ENABLED'}})),
          });
        }
        if (/FROM campaign_asset /.test(q)) {
          const owners = inList(q, 'campaign_asset.campaign');
          return Response.json({
            results: links
              .filter(l => owners.includes(l[0]) && l[3] === 'AUTOMATICALLY_CREATED')
              .map(l => ({
                campaignAsset: {campaign: l[0], asset: l[1], fieldType: l[2], status: l[4] ? 'ENABLED' : 'REMOVED'},
              })),
          });
        }
        if (/FROM campaign /.test(q)) {
          const owners = inList(q, 'campaign.resource_name');
          return Response.json({
            results: owners.filter(o => o === campaign(7)).map(o => ({campaign: {resourceName: o, status: 'ENABLED'}})),
          });
        }
        throw new Error('Unexpected query ' + q);
      }
      writes++;
      const remove = (o, a, t) => {
        if (mode !== 'ignore') for (const l of links) if (l[0] === o && l[1] === a && l[2] === t) l[4] = false;
      };
      if (path === C.replace(/^/, '/v23/') + 'adGroupAds/10~20:removeAutomaticallyCreatedAssets') {
        for (const x of body.assetsWithFieldType) remove(ad, x.asset, x.assetFieldType);
        return Response.json({});
      }
      if (path === '/v23/customers/123:removeCampaignAutomaticallyCreatedAsset') {
        for (const x of body.operations) remove(x.campaign, x.asset, x.fieldType);
        return Response.json(mode === 'partial' ? {partialFailureError: {code: 3, message: 'One removal failed'}} : {});
      }
      throw new Error('Unexpected ' + path);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const fromAd = list =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action: actions.ad,
          account_id: '123',
          path_params: {ad_group_ad: ad},
          payload: {assetsWithFieldType: list},
        },
      },
      actor,
    );
  const fromCampaign = (operations, extra = {partialFailure: false}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action: actions.campaign, account_id: '123', payload: {operations, ...extra}},
      },
      actor,
    );
  const execute = (p, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, links, fromAd, fromCampaign, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('automatically created assets are removed from an ad and from a campaign and verify gone; removals count as deletions', async () => {
  const f = fixture();
  try {
    const p = ok(
      await f.fromAd([
        {asset: asset(1), assetFieldType: 'HEADLINE'},
        {asset: asset(2), assetFieldType: 'DESCRIPTION'},
      ]),
    );
    assert.equal(p.data.creative_impact.removing.length, 2);
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    const c = ok(await f.fromCampaign([{campaign: campaign(7), asset: asset(4), fieldType: 'MARKETING_IMAGE'}]));
    ok(await f.execute(c));
    assert.equal(ok(await f.verify(c)).data.status, 'verified');
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    saveSpendPolicy(g.store, owner, {gateway, account_id: '123', confirmed: true, policy: {allow_deletion: false}});
    assert.equal(
      (await g.fromAd([{asset: asset(1), assetFieldType: 'HEADLINE'}])).error?.code,
      'POLICY_DELETION_FORBIDDEN',
    );
  } finally {
    g.store.close();
  }
});

test('malformed removals are refused before any request, and assets that are not automatically created or not linked are refused after reading', async () => {
  const cases = [
    ['empty list', f => f.fromAd([])],
    [
      'duplicate',
      f =>
        f.fromAd([
          {asset: asset(1), assetFieldType: 'HEADLINE'},
          {asset: asset(1), assetFieldType: 'HEADLINE'},
        ]),
    ],
    ['foreign asset', f => f.fromAd([{asset: 'customers/999/assets/1', assetFieldType: 'HEADLINE'}])],
    [
      'partial failure',
      f =>
        f.fromCampaign([{campaign: campaign(7), asset: asset(4), fieldType: 'MARKETING_IMAGE'}], {
          partialFailure: true,
        }),
    ],
    [
      'partial failure missing',
      f => f.fromCampaign([{campaign: campaign(7), asset: asset(4), fieldType: 'MARKETING_IMAGE'}], {}),
    ],
    ['unknown field type', f => f.fromCampaign([{campaign: campaign(7), asset: asset(4), fieldType: 'UNSPECIFIED'}])],
  ];
  for (const [label, run] of cases) {
    const f = fixture();
    try {
      const r = await run(f);
      assert.equal(r.success, false, label);
      assert.equal(f.calls.length, 0, label + ': ' + JSON.stringify(r).slice(0, 200));
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    assert.equal((await f.fromAd([{asset: asset(3), assetFieldType: 'HEADLINE'}])).error?.code, 'STATE_NOT_FOUND');
    assert.equal(
      (await f.fromCampaign([{campaign: campaign(7), asset: asset(5), fieldType: 'HEADLINE'}])).error?.code,
      'STATE_NOT_FOUND',
    );
    assert.equal(
      (await f.fromCampaign([{campaign: campaign(8), asset: asset(4), fieldType: 'MARKETING_IMAGE'}])).error?.code,
      'STATE_TARGET_MISMATCH',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a partial failure is a failure never resubmitted, an ignored removal is not verified, and the ledger lists both writes', async () => {
  const partial = fixture('partial');
  try {
    const p = ok(await partial.fromCampaign([{campaign: campaign(7), asset: asset(4), fieldType: 'MARKETING_IMAGE'}]));
    assert.equal((await partial.execute(p)).success, false);
    assert.equal((await partial.execute(p)).success, false);
    assert.equal(partial.writes(), 1);
  } finally {
    partial.store.close();
  }
  const ignored = fixture('ignore');
  try {
    const p = ok(await ignored.fromAd([{asset: asset(1), assetFieldType: 'HEADLINE'}]));
    ok(await ignored.execute(p));
    assert.notEqual(ok(await ignored.verify(p)).data.status, 'verified');
  } finally {
    ignored.store.close();
  }
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'google_auto_assets', action);
  }
});
