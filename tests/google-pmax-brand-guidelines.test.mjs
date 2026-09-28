import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Performance Max brand guidelines, Google Ads API v23 (pinned Discovery document: CampaignService.EnablePMaxBrandGuidelines
 * and the campaign and campaign asset models; "Asset requirements" of the Performance Max guide; checked 2026-09-27).
 */
const gateway = 'google_ads_native_action',
  registry = new Registry(),
  C = 'customers/123/';
const actor = {tenantId: 'pmax-brand', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const actions = {rpc: 'google_ads_v23_campaign_enable_p_max_brand_guidelines', legacy: 'ENABLE_PMAX_BRAND_GUIDELINES'};
const campaign = id => C + 'campaigns/' + id,
  asset = id => C + 'assets/' + id;
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 89).toString('base64')),
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
  const campaigns = {
    1001: {
      name: 'PMax shoes',
      status: 'ENABLED',
      advertisingChannelType: 'PERFORMANCE_MAX',
      brandGuidelinesEnabled: false,
    },
    1002: {
      name: 'PMax paused',
      status: 'PAUSED',
      advertisingChannelType: 'PERFORMANCE_MAX',
      brandGuidelinesEnabled: false,
    },
    1003: {name: 'Search', status: 'ENABLED', advertisingChannelType: 'SEARCH', brandGuidelinesEnabled: false},
    1004: {
      name: 'Migrated',
      status: 'ENABLED',
      advertisingChannelType: 'PERFORMANCE_MAX',
      brandGuidelinesEnabled: true,
    },
    1005: {
      name: 'Travel goals',
      status: 'PAUSED',
      advertisingChannelType: 'PERFORMANCE_MAX',
      brandGuidelinesEnabled: false,
      travelCampaignSettings: {travelAccountId: '77'},
    },
    1006: {
      name: 'Removed',
      status: 'REMOVED',
      advertisingChannelType: 'PERFORMANCE_MAX',
      brandGuidelinesEnabled: false,
    },
  };
  const assets = {
    2001: {type: 'TEXT', textAsset: {text: 'Example Shoes'}},
    2002: {type: 'IMAGE', imageAsset: {fullSize: {widthPixels: '1200', heightPixels: '1200'}}},
    2003: {type: 'IMAGE', imageAsset: {fullSize: {widthPixels: '1200', heightPixels: '300'}}},
    2004: {type: 'IMAGE', imageAsset: {fullSize: {widthPixels: '1200', heightPixels: '628'}}},
    2005: {type: 'TEXT', textAsset: {text: 'A business name that is too long'}},
    2006: {type: 'IMAGE', imageAsset: {fullSize: {widthPixels: '100', heightPixels: '100'}}},
    2007: {type: 'IMAGE', imageAsset: {fullSize: {widthPixels: '600', heightPixels: '600'}}},
  };
  const links = [];
  const inList = (query, field) =>
    [...(new RegExp(field + ' IN \\(([^)]*)\\)').exec(query)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]);
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      path = u.pathname,
      body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({path, body});
    if (path === '/v25/customers/123/googleAds:search') {
      const q = body.query;
      if (/FROM customer /.test(q + ' '))
        return Response.json({results: [{customer: {resourceName: C.slice(0, -1), id: '123', manager: false}}]});
      if (/FROM campaign_asset /.test(q + ' ')) {
        const cs = inList(q, 'campaign_asset.campaign');
        return Response.json({
          results: links.filter(l => cs.includes(l.campaign) && l.status === 'ENABLED').map(l => ({campaignAsset: l})),
        });
      }
      if (/FROM campaign /.test(q + ' ')) {
        const names = inList(q, 'campaign.resource_name');
        return Response.json({
          results: names
            .filter(n => campaigns[n.split('/').at(-1)])
            .map(n => {
              const c = campaigns[n.split('/').at(-1)];
              return {campaign: {resourceName: n, ...c}};
            }),
        });
      }
      if (/FROM asset /.test(q + ' ')) {
        const names = inList(q, 'asset.resource_name');
        return Response.json({
          results: names
            .filter(n => assets[n.split('/').at(-1)])
            .map(n => ({asset: {resourceName: n, ...assets[n.split('/').at(-1)]}})),
        });
      }
      throw new Error('Unexpected query ' + q);
    }
    if (path === '/v25/customers/123/campaigns:enablePMaxBrandGuidelines') {
      writes++;
      return Response.json({
        results: body.operations.map((op, i) => {
          if (mode === 'partial' && i === 1)
            return {campaign: op.campaign, enablementError: {code: 3, message: 'Brand guidelines migration failed.'}};
          if (mode !== 'ignore') {
            const c = campaigns[op.campaign.split('/').at(-1)];
            c.brandGuidelinesEnabled = true;
            if (op.mainColor)
              c.brandGuidelines = {
                mainColor: op.mainColor.toUpperCase(),
                accentColor: op.accentColor,
                predefinedFontFamily: op.fontFamily,
              };
            const add = (a, role) =>
              links.push({
                resourceName: op.campaign + '~' + a.split('/').at(-1) + '~' + role,
                campaign: op.campaign,
                asset: a,
                fieldType: role,
                status: 'ENABLED',
              });
            if (op.autoPopulateBrandAssets) {
              add(asset(2001), 'BUSINESS_NAME');
              add(asset(2007), 'LOGO');
            } else {
              add(op.brandAssets.businessNameAsset, 'BUSINESS_NAME');
              for (const a of op.brandAssets.logoAsset) add(a, 'LOGO');
              for (const a of op.brandAssets.landscapeLogoAsset ?? []) add(a, 'LANDSCAPE_LOGO');
            }
          }
          return {campaign: op.campaign};
        }),
      });
    }
    throw new Error('Unexpected ' + path);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (operations, action = actions.rpc) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: '123', payload: {operations}}},
      actor,
    );
  const execute = (p, extra = {spend_change_confirmed: true}) =>
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
  return {store, calls, campaigns, links, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};
const explicit = (id, extra = {}) => ({
  campaign: campaign(id),
  autoPopulateBrandAssets: false,
  brandAssets: {businessNameAsset: asset(2001), logoAsset: [asset(2002)], landscapeLogoAsset: [asset(2003)]},
  mainColor: '#00aa55',
  accentColor: '#112233',
  fontFamily: 'Roboto',
  ...extra,
});

test('explicit brand assets are enabled once after confirmation and verify: the campaign links, colors and font', async () => {
  const f = fixture();
  try {
    const p = ok(await f.prepare([explicit(1001), explicit(1002)])),
      impact = p.data.creative_impact;
    assert.equal(impact.scope, 'pmax_brand_guidelines');
    assert.equal(impact.irreversible, true);
    assert.equal(impact.may_affect_serving, true);
    assert.match(impact.effect, /cannot be turned off again/);
    assert.equal((await f.execute(p, {})).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes(), 0);
    ok(await f.execute(p));
    assert.equal(f.writes(), 1);
    const w = f.calls.find(c => c.path.endsWith(':enablePMaxBrandGuidelines'));
    assert.equal(w.body.operations.length, 2);
    assert.equal(w.body.operations[0].brandAssets.businessNameAsset, asset(2001));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('automatically chosen brand assets verify by presence through the legacy action name', async () => {
  const f = fixture();
  try {
    const p = ok(await f.prepare([{campaign: campaign(1002), autoPopulateBrandAssets: true}], actions.legacy));
    assert.match(JSON.stringify(p.data.creative_impact.campaigns[0].brand_assets), /chosen by Google/);
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('malformed enable operations are refused before any request', async () => {
  const cases = [
    ['eleven campaigns', Array.from({length: 11}, (_, i) => explicit(1100 + i))],
    ['repeated campaign', [explicit(1001), explicit(1001)]],
    ['missing switch', [{campaign: campaign(1001)}]],
    ['assets with auto', [{...explicit(1001), autoPopulateBrandAssets: true}]],
    ['no assets without auto', [{campaign: campaign(1001), autoPopulateBrandAssets: false}]],
    [
      'six logos',
      [
        explicit(1001, {
          brandAssets: {
            businessNameAsset: asset(2001),
            logoAsset: [asset(2002), asset(3001), asset(3002)],
            landscapeLogoAsset: [asset(2003), asset(3003), asset(3004)],
          },
        }),
      ],
    ],
    [
      'no square logo',
      [
        explicit(1001, {
          brandAssets: {businessNameAsset: asset(2001), logoAsset: [], landscapeLogoAsset: [asset(2003)]},
        }),
      ],
    ],
    [
      'repeated asset',
      [explicit(1001, {brandAssets: {businessNameAsset: asset(2001), logoAsset: [asset(2002), asset(2002)]}})],
    ],
    ['main color alone', [explicit(1001, {accentColor: undefined})]],
    ['named color', [explicit(1001, {mainColor: 'green'})]],
    ['unknown font', [explicit(1001, {fontFamily: 'Arial'})]],
    ['URL as domain', [explicit(1001, {finalUriDomain: 'https://example.com/shoes'})]],
    ['another customer', [{...explicit(1001), campaign: 'customers/999/campaigns/1001'}]],
    // The pinned Discovery model refuses unknown operation fields itself.
    ['unqualified field', [{...explicit(1001), status: 'ENABLED'}], 'INVALID_VENDOR_BODY'],
  ];
  for (const [label, ops, code] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(ops.map(o => JSON.parse(JSON.stringify(o))));
      assert.equal(r.error?.code, code ?? 'INVALID_BRAND_GUIDELINES', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
});

test('the review refuses campaigns and assets that cannot take brand guidelines, without writes', async () => {
  const f = fixture();
  try {
    const code = async (ops, expected, pattern) => {
      const r = await f.prepare(ops);
      assert.equal(r.error?.code, expected, JSON.stringify(r).slice(0, 300));
      if (pattern) assert.match(r.error.message, pattern);
    };
    await code([explicit(1003)], 'INVALID_BRAND_GUIDELINES', /Performance Max/);
    await code([explicit(1004)], 'CONFIGURATION_EXISTS', /cannot be enabled twice or turned off/);
    await code([explicit(1005)], 'INVALID_BRAND_GUIDELINES', /travel goals/);
    await code([explicit(1006)], 'INVALID_BRAND_GUIDELINES', /removed/);
    await code([explicit(1099)], 'STATE_TARGET_MISMATCH');
    await code(
      [explicit(1001, {brandAssets: {businessNameAsset: asset(2005), logoAsset: [asset(2002)]}})],
      'INVALID_BRAND_GUIDELINES',
      /1–25 characters/,
    );
    await code(
      [explicit(1001, {brandAssets: {businessNameAsset: asset(2001), logoAsset: [asset(2004)]}})],
      'INVALID_BRAND_GUIDELINES',
      /square/,
    );
    await code(
      [explicit(1001, {brandAssets: {businessNameAsset: asset(2001), logoAsset: [asset(2006)]}})],
      'INVALID_BRAND_GUIDELINES',
      /128 x 128/,
    );
    await code(
      [
        explicit(1001, {
          brandAssets: {businessNameAsset: asset(2001), logoAsset: [asset(2002)], landscapeLogoAsset: [asset(2004)]},
        }),
      ],
      'INVALID_BRAND_GUIDELINES',
      /4:1/,
    );
    await code(
      [explicit(1001, {brandAssets: {businessNameAsset: asset(2001), logoAsset: [asset(2999)]}})],
      'STATE_TARGET_MISMATCH',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a result with an enablement error is a failure, and an ignored enablement is not verified', async () => {
  const partial = fixture('partial');
  try {
    const p = ok(await partial.prepare([explicit(1001), explicit(1002)]));
    const out = await partial.execute(p);
    assert.equal(out.success, false, JSON.stringify(out).slice(0, 300));
    assert.equal((await partial.execute(p)).success, false);
    assert.equal(partial.writes(), 1);
  } finally {
    partial.store.close();
  }
  const ignored = fixture('ignore');
  try {
    const p = ok(await ignored.prepare([explicit(1002)]));
    ok(await ignored.execute(p));
    assert.notEqual(ok(await ignored.verify(p)).data.status, 'verified');
  } finally {
    ignored.store.close();
  }
});

test('the method and models match the pinned Discovery document, and the ledger lists both actions in the family', () => {
  const doc = JSON.parse(readFileSync('.mirror/VENDOR/google-ads-v25.json', 'utf8')),
    d = doc.document ?? doc,
    S = d.schemas;
  assert.match(
    S.GoogleAdsGoogleadsV25Services__EnablePMaxBrandGuidelinesRequest.properties.operations.description,
    /maximum of 10/,
  );
  assert.match(
    S.GoogleAdsGoogleadsV25Resources__Campaign.properties.brandGuidelinesEnabled.description,
    /not possible to disable Brand Guidelines/,
  );
  assert.match(S.GoogleAdsGoogleadsV25Services__EnableOperation.properties.fontFamily.description, /Playfair Display/);
  assert.deepEqual(Object.keys(S.GoogleAdsGoogleadsV25Services__BrandCampaignAssets.properties).sort(), [
    'businessNameAsset',
    'landscapeLogoAsset',
    'logoAsset',
  ]);
  const rows = actionContracts(registry).filter(
    r => r.gateway === gateway && Object.values(actions).includes(r.action),
  );
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.status, 'reviewed_write_family', r.action);
    assert.equal(r.family, 'google_pmax_brand_guidelines', r.action);
  }
});
