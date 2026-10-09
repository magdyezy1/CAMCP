import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * DV360 Demand Gen ads, Display & Video 360 API v4 (pinned Discovery document and "Create a Demand Gen ad" of the Demand
 * Gen guide, checked 2026-09-27): create, patch with an update mask, and delete.
 */
const gateway = 'dv360_native_action',
  registry = new Registry();
const actor = {tenantId: 'dv360-dg-ads', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const A = 'DV360_ADVERTISERS_AD_GROUP_ADS_';
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 89).toString('base64')),
    calls = [];
  store.putConnection(
    owner,
    {
      id: 'dv360',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic DV360',
      scopes: ['https://www.googleapis.com/auth/display-video'],
    },
    {accessToken: 'synthetic'},
  );
  const lineItems = {
    555: {
      lineItemType: 'LINE_ITEM_TYPE_DEMAND_GEN',
      entityStatus: 'ENTITY_STATUS_ACTIVE',
      displayName: 'DG line',
      demandGenSettings: {geoLanguageTargetingEnabled: false},
      bidStrategy: {demandGenBid: {type: 'DEMAND_GEN_BIDDING_STRATEGY_TYPE_MAXIMIZE_CLICKS'}},
    },
    556: {
      lineItemType: 'LINE_ITEM_TYPE_DEMAND_GEN',
      entityStatus: 'ENTITY_STATUS_ARCHIVED',
      displayName: 'Old DG line',
      demandGenSettings: {geoLanguageTargetingEnabled: false},
    },
  };
  const group = (lineItemId, status) => ({
    lineItemId,
    displayName: 'Group ' + status,
    adGroupFormat: 'AD_GROUP_FORMAT_DEMAND_GEN',
    entityStatus: status,
    adGroupInventoryControl: {adGroupInventoryStrategy: 'AD_GROUP_INVENTORY_STRATEGY_ALL_GOOGLE_INVENTORY'},
  });
  const adGroups = {
    901: group('555', 'ENTITY_STATUS_PAUSED'),
    903: group('555', 'ENTITY_STATUS_ACTIVE'),
    904: group('556', 'ENTITY_STATUS_PAUSED'),
  };
  const assets = {
    810: {youtubeVideoId: 'SYNTHETIC01', entityStatus: 'ENTITY_STATUS_ACTIVE'},
    811: {youtubeVideoId: 'SYNTHETIC02', entityStatus: 'ENTITY_STATUS_ARCHIVED'},
  };
  const ads = new Map([
    [
      '7001',
      {adGroupId: '901', displayName: 'Video ad', entityStatus: 'ENTITY_STATUS_PAUSED', demandGenVideoAd: video()},
    ],
    [
      '7003',
      {
        adGroupId: '901',
        displayName: 'Legacy in-stream',
        entityStatus: 'ENTITY_STATUS_PAUSED',
        inStreamAd: {commonInStreamAttribute: {displayUrl: 'example.com'}},
      },
    ],
  ]);
  let writes = 0,
    next = 7100,
    mode = '',
    advertiserDefaults = {};
  // DV360 adds output-only fields: tracking URLs, image metadata, video details and the ad policy.
  const shown = (id, a) => {
    const out = {
      name: 'advertisers/123/adGroupAds/' + id,
      advertiserId: '123',
      adGroupAdId: id,
      ...structuredClone(a),
      adPolicy: {adPolicyApprovalStatus: 'APPROVED'},
    };
    for (const t of ['demandGenVideoAd', 'demandGenImageAd', 'demandGenCarouselAd', 'demandGenProductAd'])
      if (out[t]) {
        out[t].trackingUrl = 'https://tracking.example/' + id;
        if (out[t].logo) out[t].logo = {...out[t].logo, mimeType: 'image/png', fileSize: '2048'};
        // The availability note is output-only (Discovery revision 20260928); it must not count as a change.
        if (out[t].videos)
          out[t].videos = out[t].videos.map(v => ({
            ...v,
            id: assets[v.videoAssetId]?.youtubeVideoId,
            unavailableReason: 'VIDEO_UNAVAILABLE_REASON_UNSPECIFIED',
          }));
      }
    return out;
  };
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method,
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({path, method});
      if (method === 'GET') {
        if (path === '/v4/advertisers/123')
          return Response.json({
            name: 'advertisers/123',
            advertiserId: '123',
            displayName: 'Advertiser',
            entityStatus: 'ENTITY_STATUS_ACTIVE',
            generalConfig: {currencyCode: 'USD'},
            ...advertiserDefaults,
          });
        let m = /^\/v4\/advertisers\/123\/lineItems\/(\d+)$/.exec(path);
        if (m && lineItems[m[1]])
          return Response.json({
            name: 'advertisers/123/lineItems/' + m[1],
            advertiserId: '123',
            insertionOrderId: '20',
            lineItemId: m[1],
            ...lineItems[m[1]],
          });
        m = /^\/v4\/advertisers\/123\/adGroups\/(\d+)$/.exec(path);
        if (m && adGroups[m[1]])
          return Response.json({
            name: 'advertisers/123/adGroups/' + m[1],
            advertiserId: '123',
            adGroupId: m[1],
            ...adGroups[m[1]],
          });
        m = /^\/v4\/advertisers\/123\/adAssets\/(\d+)$/.exec(path);
        if (m && assets[m[1]])
          return Response.json({
            name: 'advertisers/123/adAssets/' + m[1],
            adAssetId: m[1],
            adAssetType: 'AD_ASSET_TYPE_YOUTUBE_VIDEO',
            youtubeVideoAsset: {youtubeVideoId: assets[m[1]].youtubeVideoId},
            entityStatus: assets[m[1]].entityStatus,
          });
        m = /^\/v4\/advertisers\/123\/adGroupAds\/(\d+)$/.exec(path);
        if (m && ads.has(m[1])) return Response.json(shown(m[1], ads.get(m[1])));
        return Response.json({error: {code: 404, message: 'Not found', status: 'NOT_FOUND'}}, {status: 404});
      }
      writes++;
      if (method === 'POST' && path === '/v4/advertisers/123/adGroupAds') {
        const id = String(next++);
        ads.set(id, structuredClone(body));
        return Response.json(shown(id, body));
      }
      const m = /^\/v4\/advertisers\/123\/adGroupAds\/(\d+)$/.exec(path);
      if (m && method === 'PATCH') {
        const a = ads.get(m[1]);
        if (mode !== 'ignore')
          for (const f of u.searchParams.get('updateMask').split(',')) a[f] = structuredClone(body[f]);
        return Response.json(shown(m[1], a));
      }
      if (m && method === 'DELETE') {
        if (mode !== 'ignore') ads.delete(m[1]);
        return Response.json({});
      }
      throw new Error('Unexpected write ' + method + ' ' + path);
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
  const create = ad =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action: A + 'CREATE', params: {advertiserId: '123'}, body: ad}},
      actor,
    );
  const patch = (id, updateMask, ad) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action: A + 'PATCH', params: {advertiserId: '123', adGroupAdId: id, updateMask}, body: ad},
      },
      actor,
    );
  const remove = id =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action: A + 'DELETE', params: {advertiserId: '123', adGroupAdId: id}}},
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
  return {
    store,
    calls,
    ads,
    create,
    patch,
    remove,
    execute,
    verify,
    writes: () => writes,
    mode: m => {
      mode = m;
    },
    advertiser: defaults => {
      advertiserDefaults = defaults;
    },
  };
}
function video(extra = {}) {
  return {
    finalUrl: 'https://example.com/shoes',
    callToAction: 'SHOP_NOW',
    headlines: ['Summer shoes'],
    longHeadlines: ['Light summer shoes for every day'],
    descriptions: ['Free returns'],
    businessName: 'Example Shoes',
    videos: [{videoAssetId: '810'}],
    logo: {assetId: '820'},
    ...extra,
  };
}
const image = () => ({
  finalUrl: 'https://example.com/sale',
  callToAction: 'Shop now',
  headlines: ['Big budget savings'],
  descriptions: ['Up to 30% off'],
  marketingImages: [{assetId: '821'}],
  logoImages: [{assetId: '820'}],
});
const carousel = () => ({
  finalUrl: 'https://example.com',
  headline: 'Our range',
  description: 'Pick a style',
  cards: [
    {finalUrl: 'https://example.com/a', headline: 'Runners', callToAction: 'Shop', marketingImage: {assetId: '822'}},
    {
      finalUrl: 'https://example.com/b',
      headline: 'Walkers',
      callToAction: 'Shop',
      squareMarketingImage: {assetId: '823'},
    },
  ],
});
const product = () => ({
  finalUrl: 'https://example.com/catalog',
  headline: 'Shop the catalog',
  description: 'All styles',
  callToAction: 'SHOP_NOW',
});
const ad = (type, body, extra = {}) => ({
  adGroupId: '901',
  displayName: 'Synthetic ' + type,
  entityStatus: 'ENTITY_STATUS_PAUSED',
  [type]: body,
  ...extra,
});
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('a paused video ad is created once and verifies against a read with output-only fields; activation needs confirmation', async () => {
  const f = fixture();
  try {
    const p = ok(await f.create(ad('demandGenVideoAd', video()))),
      impact = p.data.creative_impact;
    assert.equal(impact.scope, 'demand_gen_ad');
    assert.deepEqual(impact.video_assets, [
      {adAssetId: '810', youtubeVideoId: 'SYNTHETIC01', entityStatus: 'ENTITY_STATUS_ACTIVE'},
    ]);
    assert.match(impact.effect, /stays paused/);
    ok(await f.execute(p));
    assert.equal(f.writes(), 1);
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
    const on = ok(await f.patch('7100', 'entityStatus', {entityStatus: 'ENTITY_STATUS_ACTIVE'}));
    assert.match(on.data.creative_impact.effect, /once its ad group and line item are active/);
    assert.equal((await f.execute(on)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    ok(await f.execute(on, {spend_change_confirmed: true}));
    assert.equal(ok(await f.verify(on)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('image, carousel and product ads verify, a patch of the creative verifies, and a deletion verifies absence', async () => {
  const f = fixture();
  try {
    for (const [type, body] of [
      ['demandGenImageAd', image()],
      ['demandGenCarouselAd', carousel()],
      ['demandGenProductAd', product()],
    ]) {
      const p = ok(await f.create(ad(type, body, {adGroupId: '903'})));
      ok(await f.execute(p));
      assert.equal(ok(await f.verify(p)).data.status, 'verified', type);
    }
    const edit = ok(
      await f.patch('7001', 'displayName,demandGenVideoAd', {
        displayName: 'Video ad v2',
        demandGenVideoAd: video({headlines: ['Summer shoes', 'New colors']}),
      }),
    );
    assert.deepEqual(edit.data.creative_impact.after.creative.headlines, ['Summer shoes', 'New colors']);
    ok(await f.execute(edit));
    assert.equal(ok(await f.verify(edit)).data.status, 'verified');
    const d = ok(await f.remove('7001'));
    ok(await f.execute(d));
    assert.equal(ok(await f.verify(d)).data.status, 'verified');
    assert.equal(f.ads.has('7001'), false);
  } finally {
    f.store.close();
  }
});

test('malformed ad requests fail before any request', async () => {
  const {demandGenVideoAd, ...noType} = ad('demandGenVideoAd', video());
  for (const [label, kind, body, code] of [
    ['two ad types', 'create', ad('demandGenVideoAd', video(), {demandGenProductAd: product()})],
    ['no ad type', 'create', noType],
    ['video without videos', 'create', ad('demandGenVideoAd', video({videos: []}))],
    // The pinned model already lists the video calls to action.
    [
      'unknown video call to action',
      'create',
      ad('demandGenVideoAd', video({callToAction: 'CALL_NOW'})),
      'INVALID_VENDOR_BODY',
    ],
    [
      'product call to action of video ads',
      'create',
      ad('demandGenProductAd', {...product(), callToAction: 'WATCH_NOW'}),
    ],
    ['one carousel card', 'create', ad('demandGenCarouselAd', {...carousel(), cards: [carousel().cards[0]]})],
    [
      'long card call to action',
      'create',
      ad('demandGenCarouselAd', {
        ...carousel(),
        cards: carousel().cards.map(c => ({...c, callToAction: 'Shop the range'})),
      }),
    ],
    ['image ad without marketing images', 'create', ad('demandGenImageAd', {...image(), marketingImages: []})],
    ['ftp final URL', 'create', ad('demandGenProductAd', {...product(), finalUrl: 'ftp://example.com'})],
    ['final URL with a space', 'create', ad('demandGenProductAd', {...product(), finalUrl: 'https://example.com/a b'})],
    ['long display name', 'create', ad('demandGenProductAd', product(), {displayName: 'x'.repeat(256)})],
    ['draft status', 'create', ad('demandGenProductAd', product(), {entityStatus: 'ENTITY_STATUS_DRAFT'})],
    ['output-only ID', 'create', ad('demandGenProductAd', product(), {adGroupAdId: '5'})],
    ['immutable ad group', 'patch', ['7001', 'adGroupId', {adGroupId: '903'}]],
    [
      'two types in a patch',
      'patch',
      ['7001', 'demandGenVideoAd,demandGenProductAd', {demandGenVideoAd: video(), demandGenProductAd: product()}],
    ],
    [
      'field outside the mask',
      'patch',
      ['7001', 'displayName', {displayName: 'x', entityStatus: 'ENTITY_STATUS_PAUSED'}],
    ],
  ]) {
    const f = fixture();
    try {
      const r = kind === 'create' ? await f.create(body) : await f.patch(...body);
      assert.equal(r.error?.code, code ?? 'INVALID_DV360_AD', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
});

test('the review refuses archived line items, archived or unknown video assets, other ad kinds, type changes and unchanged patches', async () => {
  const f = fixture();
  try {
    assert.match(
      (await f.create(ad('demandGenProductAd', product(), {adGroupId: '904'}))).error?.message ?? '',
      /archived/,
    );
    assert.match(
      (await f.create(ad('demandGenVideoAd', video({videos: [{videoAssetId: '811'}]})))).error?.message ?? '',
      /archived/,
    );
    const image = await f.create(ad('demandGenVideoAd', video({videos: [{videoAssetId: '820'}]})));
    assert.equal(image.error?.code, 'STATE_TARGET_MISMATCH');
    assert.match(image.error.message, /not a YouTube video asset/);
    assert.match(
      (await f.patch('7003', 'displayName', {displayName: 'x'})).error?.message ?? '',
      /not a Demand Gen ad/,
    );
    assert.match(
      (await f.patch('7001', 'demandGenProductAd', {demandGenProductAd: product()})).error?.message ?? '',
      /type cannot change/,
    );
    assert.match(
      (await f.patch('7001', 'displayName', {displayName: 'Video ad'})).error?.message ?? '',
      /already matches/,
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('owner policies: an active ad is an activation and a deletion is a deletion; ad text about budgets is not a spending change', async () => {
  const f = fixture();
  try {
    const p = ok(await f.create(ad('demandGenImageAd', image())));
    ok(await f.execute(p));
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {allow_deletion: false, allow_activation: false},
    });
    assert.equal(
      (await f.create(ad('demandGenProductAd', product(), {entityStatus: 'ENTITY_STATUS_ACTIVE'}))).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
    assert.equal(
      (await f.patch('7001', 'entityStatus', {entityStatus: 'ENTITY_STATUS_ACTIVE'})).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
    ok(await f.create(ad('demandGenProductAd', product())));
    assert.equal((await f.remove('7001')).error?.code, 'POLICY_DELETION_FORBIDDEN');
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('an ad changed after review stops execution, and ignored changes are inconclusive', async () => {
  const f = fixture();
  try {
    const p = ok(await f.patch('7001', 'displayName', {displayName: 'Renamed'}));
    f.ads.get('7001').displayName = 'Changed elsewhere';
    assert.equal((await f.execute(p)).error?.code, 'STATE_CHANGED');
    assert.equal(f.writes(), 0);
    f.mode('ignore');
    const q = ok(await f.patch('7001', 'displayName', {displayName: 'Renamed'}));
    ok(await f.execute(q));
    const v = ok(await f.verify(q));
    assert.equal(v.data.status, 'inconclusive');
    assert.deepEqual(v.data.checks[0].changed_fields, ['/ad/display_name']);
    const d = ok(await f.remove('7001'));
    ok(await f.execute(d));
    assert.equal(ok(await f.verify(d)).data.status, 'inconclusive');
  } finally {
    f.store.close();
  }
});

// PRV-04: from 2026-10-12 DV360 refuses a YouTube video ad without a business name and a logo unless the advertiser sets
// defaults. The review previously accepted such an ad, which the provider would then refuse.
test('from 2026-10-12 a video ad without business name or logo is refused with a cited code unless the advertiser has defaults', async t => {
  const {setDeprecationClock} = await import('../dist/src/provider-deprecations.js');
  t.after(() => setDeprecationClock());
  const {businessName, logo, ...bare} = video();
  setDeprecationClock(() => Date.parse('2026-10-11T23:59:00Z'));
  let f = fixture();
  try {
    // The day before, the provider still applies its own rule; the review does not refuse early.
    ok(await f.create(ad('demandGenVideoAd', bare)));
  } finally {
    f.store.close();
  }
  setDeprecationClock(() => Date.parse('2026-10-12T00:00:00Z'));
  f = fixture();
  try {
    const refused = await f.create(ad('demandGenVideoAd', bare));
    assert.equal(refused.error?.code, 'PROVIDER_DEPRECATED');
    assert.deepEqual(refused.error.details.missing, ['businessName', 'logo']);
    assert.equal(refused.error.details.deprecation, 'dv360_youtube_ad_business_name_logo');
    assert.match(refused.error.details.source, /^https:\/\/developers\.google\.com\/display-video\//);
    const patched = await f.patch('7001', 'demandGenVideoAd', {demandGenVideoAd: {...bare, headlines: ['New']}});
    assert.equal(patched.error?.code, 'PROVIDER_DEPRECATED');
    // The surviving forms: both on the ad, or the advertiser's defaults; ads of other kinds are unaffected.
    ok(await f.create(ad('demandGenVideoAd', video())));
    ok(await f.create(ad('demandGenImageAd', image())));
    ok(await f.patch('7001', 'displayName', {displayName: 'Renamed'}));
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  f = fixture();
  try {
    f.advertiser({defaultBusinessName: 'Example Shoes', defaultLogoAssetId: '820'});
    ok(await f.create(ad('demandGenVideoAd', bare)));
    f.advertiser({defaultBusinessName: 'Example Shoes'});
    const half = await f.create(ad('demandGenVideoAd', bare));
    assert.deepEqual(half.error?.details?.missing, ['logo']);
  } finally {
    f.store.close();
  }
});

test('the ad model and methods match the pinned Discovery document', () => {
  const doc = JSON.parse(readFileSync('.mirror/VENDOR/dv360-v4.json', 'utf8')).document,
    S = doc.schemas,
    m = doc.resources.advertisers.resources.adGroupAds.methods;
  for (const t of ['demandGenVideoAd', 'demandGenImageAd', 'demandGenCarouselAd', 'demandGenProductAd'])
    assert.ok(S.AdGroupAd.properties[t] && !S.AdGroupAd.properties[t].readOnly, t);
  assert.equal(S.AdGroupAd.properties.adGroupAdId.readOnly, true);
  assert.equal(S.ImageAsset.properties.mimeType.readOnly, true);
  assert.equal(S.YoutubeVideoDetails.properties.id.readOnly, true);
  assert.match(S.DemandGenVideoAd.properties.callToAction.description, /WATCH_NOW/);
  assert.match(S.DemandGenProductAd.properties.callToAction.description, /SHOP_NOW/);
  assert.match(S.CarouselCard.properties.callToAction.description, /10 characters/);
  assert.deepEqual(
    [m.create.httpMethod, m.patch.httpMethod, m.delete.httpMethod, m.patch.parameters.updateMask.location],
    ['POST', 'PATCH', 'DELETE', 'query'],
  );
  for (const n of ['create', 'patch', 'delete'])
    assert.deepEqual(m[n].scopes, ['https://www.googleapis.com/auth/display-video']);
});
