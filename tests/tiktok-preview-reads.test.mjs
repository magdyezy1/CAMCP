import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * TikTok ad, Upgraded Smart+ and creative previews and Smart Text recommendations (API for Business v1.3, checked
 * 2026-09-27): POST requests that return a preview link or suggested texts and change nothing, so a reader can run them
 * on a read-only deployment.
 */
const TIKTOK = '35353535-3535-4353-8353-353535353535',
  gateway = 'tiktok_native_action',
  account = '123',
  registry = new Registry();
const actions = {
  ads: 'tiktok_creative_ads_preview_create',
  adsAlias: 'tiktok_ad_preview',
  smart: 'tiktok_smart_plus_ad_preview',
  smartAlias: 'tiktok_smart_ad_preview',
  text: 'tiktok_creative_smart_text_get',
  textAlias: 'tiktok_smart_text',
};
const actor = {tenantId: 'tiktok-previews', userId: 'reader', role: 'reader'},
  owner = {...actor, role: 'admin'};
const creation = {
  preview_type: 'ADS_CREATION',
  objective_type: 'TRAFFIC',
  identity_id: '7000000000000000001',
  identity_type: 'CUSTOMIZED_USER',
  ad_format: 'SINGLE_VIDEO',
  video_id: 'v10033g50000abcdef',
  ad_text: 'Spring sale on running shoes',
  call_to_action: 'SHOP_NOW',
  landing_page_url: 'https://example.com/sale',
  placement: 'PLACEMENT_TIKTOK',
};
const smartCreation = {
  preview_type: 'ADS_CREATION',
  creative_list: [
    {
      creative_info: {
        ad_format: 'SINGLE_VIDEO',
        video_info: {video_id: 'v10033g50000abcdef'},
        identity_type: 'CUSTOMIZED_USER',
        identity_id: '7000000000000000001',
      },
    },
  ],
  ad_text_list: [{ad_text: 'Spring sale'}],
};
const link = 'https://ads.tiktok.com/ad_preview_tool?ad_preview_id=5681cba0fcd211eab33c351a98f0001';
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 95).toString('base64')),
    connection = {
      id: TIKTOK,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    };
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  const calls = [];
  const transport = new NativeTransport(async (raw, init = {}) => {
    const u = new URL(String(raw)),
      path = u.pathname.replace(/^\/open_api/, '');
    calls.push({
      path,
      method: init.method,
      query: Object.fromEntries(u.searchParams),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + calls.length, data});
    if (path === '/v1.3/creative/ads_preview/create/')
      return ok({
        tips: [{messages: ['The resolution should be 1280*720 at least.'], placement: 'PLACEMENT_TIKTOK'}],
        preview_link: link,
        iframe: '<iframe src="' + link + '"></iframe>',
      });
    if (path === '/v1.3/smart_plus/ad/preview/')
      return ok({preview_link: link, iframe: '<iframe src="' + link + '"></iframe>'});
    if (path === '/v1.3/creative/smart_text/generate/')
      return ok({
        industry_id: '29140301',
        generate_id: '3414796565638865',
        language: 'EN',
        texts: ['Run further in the new spring range', 'Free shipping on running shoes'],
      });
    throw new Error('Unexpected TikTok request ' + path);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: false,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const call = (action, payload, extra = {}) =>
    service.call(
      gateway,
      {action, account_id: account, connection_id: connection.id, payload, dry_run: false, ...extra},
      actor,
    );
  return {store, calls, call};
}

test("ad previews run as reads for a reader on a read-only deployment and return TikTok's link unchanged", async () => {
  const f = fixture();
  try {
    const out = await f.call(actions.ads, creation);
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 600));
    assert.equal(f.calls.length, 1);
    assert.deepEqual([f.calls[0].method, f.calls[0].path], ['POST', '/v1.3/creative/ads_preview/create/']);
    assert.deepEqual(f.calls[0].body, {advertiser_id: account, ...creation});
    assert.match(JSON.stringify(out), /ad_preview_tool/);
    const existing = await f.call(actions.adsAlias, {preview_type: 'AD', ad_id: '401'});
    assert.equal(existing.success, true, JSON.stringify(existing).slice(0, 600));
    assert.deepEqual(f.calls[1].body, {advertiser_id: account, preview_type: 'AD', ad_id: '401'});
    const dry = await f.call(actions.ads, creation, {dry_run: true});
    assert.equal(dry.success, true, JSON.stringify(dry).slice(0, 400));
    assert.equal(dry.data.request.readOnly, true);
    assert.match(dry.data.request.warnings.join(' '), /30 days; anyone who has the link/);
    const image = await f.call(
      actions.ads,
      {
        preview_type: 'SINGLE_IMAGE',
        image_id: 'ad-site-i18n-sg/202011165d0d',
        display_name: 'Brand',
        ad_text: 'Spring sale',
        placements: ['PLACEMENT_PANGLE'],
      },
      {dry_run: true},
    );
    assert.equal(image.success, true, JSON.stringify(image).slice(0, 400));
    assert.match(image.data.request.warnings.join(' '), /24 hours/);
    assert.equal(f.calls.length, 2);
  } finally {
    f.store.close();
  }
});

test('Upgraded Smart+ previews and Smart Text recommendations run as reads', async () => {
  const f = fixture();
  try {
    for (const [action, payload] of [
      [actions.smart, smartCreation],
      [actions.smartAlias, {preview_type: 'AD', smart_plus_ad_id: '1800000000000000001'}],
      [actions.text, {adgroup_id: '301', language: 'EN', keywords: ['running shoes'], limit: 5}],
      [actions.textAlias, {adgroup_id: '301', param_type: 'RECOMMENDED'}],
    ]) {
      const out = await f.call(action, payload);
      assert.equal(out.success, true, action + ': ' + JSON.stringify(out).slice(0, 600));
      const sent = f.calls.at(-1);
      assert.equal(sent.method, 'POST');
      assert.deepEqual(sent.body, {advertiser_id: account, ...payload});
    }
    assert.deepEqual(
      f.calls.map(c => c.path),
      [
        '/v1.3/smart_plus/ad/preview/',
        '/v1.3/smart_plus/ad/preview/',
        '/v1.3/creative/smart_text/generate/',
        '/v1.3/creative/smart_text/generate/',
      ],
    );
    const dry = await f.call(actions.text, {adgroup_id: '301', param_type: 'RECOMMENDED'}, {dry_run: true});
    assert.equal(dry.data.request.readOnly, true);
    assert.match(dry.data.request.warnings.join(' '), /suggested ad texts/);
    assert.equal(f.calls.length, 4);
  } finally {
    f.store.close();
  }
});

test('malformed previews and Smart Text requests, and another advertiser, are refused before any request', async () => {
  const drop = (o, k) => {
    const c = {...o};
    delete c[k];
    return c;
  };
  const cases = [
    ['unknown preview type', actions.ads, {preview_type: 'STORY'}],
    ['a field of another preview type', actions.ads, {preview_type: 'AD', ad_id: '401', video_id: 'v1'}],
    ['an existing ad without ad_id', actions.ads, {preview_type: 'AD'}],
    ['a non-numeric ad_id', actions.ads, {preview_type: 'AD', ad_id: 'abc'}],
    ['a creation without identity', actions.ads, drop(creation, 'identity_id')],
    ['an unknown objective', actions.ads, {...creation, objective_type: 'SALES'}],
    ['a Business Center identity without its Business Center', actions.ads, {...creation, identity_type: 'BC_AUTH_TT'}],
    ['a single video without a video', actions.ads, drop(creation, 'video_id')],
    ['a store without its Business Center', actions.ads, {...creation, store_id: '9001'}],
    [
      'a video preview without placements',
      actions.ads,
      {preview_type: 'SINGLE_VIDEO', video_id: 'v1', display_name: 'Brand', ad_text: 'Hi'},
    ],
    ['a Smart+ preview without creatives', actions.smart, {preview_type: 'ADS_CREATION', creative_list: []}],
    [
      'a Smart+ preview with six ad texts',
      actions.smart,
      {...smartCreation, ad_text_list: Array.from({length: 6}, (_, i) => ({ad_text: 'Text ' + i}))},
    ],
    [
      'a Smart+ CTA list with a CTA portfolio',
      actions.smart,
      {
        ...smartCreation,
        call_to_action_list: [{call_to_action: 'SHOP_NOW'}],
        ad_configuration: {call_to_action_id: '77'},
      },
    ],
    ['a Smart+ ad preview without its ad', actions.smart, {preview_type: 'AD'}],
    ['Smart Text without a language', actions.text, {adgroup_id: '301', keywords: ['shoes']}],
    ['Smart Text without keywords', actions.text, {adgroup_id: '301', language: 'EN'}],
    ['Smart Text with 21 texts', actions.text, {adgroup_id: '301', param_type: 'RECOMMENDED', limit: 21}],
    ['Smart Text in German', actions.text, {adgroup_id: '301', param_type: 'RECOMMENDED', language: 'DE'}],
    ['Smart Text with an extra field', actions.text, {adgroup_id: '301', param_type: 'RECOMMENDED', ad_text: 'x'}],
    ['a query parameter', actions.text, {adgroup_id: '301', param_type: 'RECOMMENDED'}, {query: {page: 1}}],
  ];
  for (const [label, action, payload, extra] of cases) {
    const f = fixture();
    try {
      const out = await f.call(action, JSON.parse(JSON.stringify(payload)), extra);
      assert.equal(out.error?.code, 'INVALID_TIKTOK_PREVIEW_READ', label + ': ' + JSON.stringify(out).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const other = await f.call(actions.ads, {preview_type: 'AD', ad_id: '401'}, {account_id: '999'});
    assert.equal(other.error?.code, 'CONNECTION_REQUIRED', JSON.stringify(other).slice(0, 300));
    const mixed = await f.call(actions.ads, {advertiser_id: '999', preview_type: 'AD', ad_id: '401'});
    assert.equal(mixed.error?.code, 'ACCOUNT_SCOPE_MISMATCH', JSON.stringify(mixed).slice(0, 300));
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});

test('enhanced catalog preflight checks the chosen preview variant, not every variant the catalog lists', () => {
  const compiler = new Compiler(registry),
    enhanced = {mode: 'enhanced', flags: {catalogPreflight: true}};
  for (const [action, payload] of [
    [actions.ads, {preview_type: 'AD', ad_id: '401'}],
    [actions.ads, creation],
    [actions.smart, {preview_type: 'AD', smart_plus_ad_id: '1800000000000000001'}],
  ]) {
    const p = compiler.compile(gateway, {action, account_id: account, payload}, enhanced);
    assert.equal(p.readOnly, true, action);
    assert.equal(p.requiresConfirmation, false);
  }
  assert.throws(
    () =>
      compiler.compile(
        gateway,
        {action: actions.text, account_id: account, payload: {language: 'EN', keywords: ['shoes']}},
        enhanced,
      ),
    e => e.code === 'MISSING_PARAMETER',
  );
  assert.throws(
    () =>
      compiler.compile(
        gateway,
        {action: actions.text, account_id: account, payload: {language: 'EN', keywords: ['shoes']}},
        {mode: 'strict', flags: {}},
      ),
    e => e.code === 'INVALID_TIKTOK_PREVIEW_READ',
  );
});

test('the six preview and Smart Text actions are native reads in the action ledger; Smart Text feedback stays blocked', () => {
  const rows = actionContracts(registry).filter(r => r.gateway === gateway);
  for (const action of Object.values(actions)) {
    const row = rows.find(r => r.action === action);
    assert.equal(row?.status, 'native_read', action);
  }
  assert.equal(rows.find(r => r.action === 'tiktok_creative_smart_text_feedback')?.status, 'blocked_write');
});
