import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Edits of Upgraded Smart+ Spark Ads (API for Business v1.3, checked 2026-09-26). The update is incremental except
 * creative_list, which TikTok replaces in full, so posts left out of it are removed from the ad.
 */
const TIKTOK = '24242424-2424-4242-8242-242424242424',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-smart-plus-ad-updates', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 81).toString('base64');
const post = (item, format = 'SINGLE_VIDEO', extra = {}) => ({
  creative_info: {ad_format: format, tiktok_item_id: item, identity_type: 'TT_USER', identity_id: 'tt-1', ...extra},
});
const config = (extra = {}) => ({
  call_to_action_id: '700',
  creative_auto_add_toggle: false,
  creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY'],
  utm_params: [{key: 'utm_source', value: 'tiktok'}],
  ...extra,
});
const stored = list =>
  list.map((c, i) => ({
    ad_material_id: 'm' + i,
    material_operation_status: 'ENABLE',
    creative_info: {...c.creative_info, aigc_disclosure_type: 'NOT_DECLARED'},
  }));
function fixture({readBack} = {}) {
  const store = new Store(':memory:', key),
    connection = {
      id: TIKTOK,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    };
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  const ads = {
    5100: {
      smart_plus_ad_id: '5100',
      adgroup_id: '300',
      ad_name: 'Paused spark',
      operation_status: 'DISABLE',
      creative_list: stored([post('9001'), post('9002', 'CAROUSEL_ADS')]),
      landing_page_url_list: [{landing_page_url: 'https://shop.example.test/sale?utm_source=tiktok'}],
      ad_configuration: config(),
    },
    5101: {
      smart_plus_ad_id: '5101',
      adgroup_id: '300',
      ad_name: 'Live spark',
      operation_status: 'ENABLE',
      creative_list: stored([post('9001'), post('9003')]),
      landing_page_url_list: [{landing_page_url: 'https://shop.example.test/'}],
      ad_configuration: config({
        creative_auto_add_toggle: true,
        creative_auto_enhancement_strategy_list: ['TRANSLATE_AND_DUB'],
        utm_params: [],
      }),
    },
    5102: {
      smart_plus_ad_id: '5102',
      adgroup_id: '300',
      ad_name: 'Uploaded video',
      operation_status: 'DISABLE',
      creative_list: [
        {
          ad_material_id: 'm0',
          creative_info: {
            ad_format: 'SINGLE_VIDEO',
            video_info: {video_id: 'v1'},
            image_info: [{web_uri: 'img-1'}],
            identity_type: 'TT_USER',
            identity_id: 'tt-1',
          },
        },
      ],
      landing_page_url_list: [{landing_page_url: 'https://shop.example.test/'}],
      ad_configuration: config({utm_params: []}),
    },
    5103: {
      smart_plus_ad_id: '5103',
      adgroup_id: '300',
      ad_name: 'Terminated',
      operation_status: 'FROZEN',
      creative_list: stored([post('9001')]),
      landing_page_url_list: [{landing_page_url: 'https://shop.example.test/'}],
      ad_configuration: config({utm_params: []}),
    },
  };
  const identities = {
    'TT_USER:tt-1': {available_status: 'AVAILABLE', can_pull_video: true, is_gpppa: false},
    'TT_USER:tt-private': {available_status: 'IS_PRIVATE_ACCOUNT', can_pull_video: true, is_gpppa: false},
  };
  const posts = {
    'tt-1': {9001: 'VIDEO', 9002: 'CAROUSEL', 9003: 'VIDEO', 9004: 'VIDEO'},
    'tt-private': {9201: 'VIDEO'},
  };
  const portfolios = {
    700: {portfolio_content: [{asset_ids: ['201781'], asset_content: 'learn_more'}]},
    701: {
      creative_portfolio_id: '701',
      creative_portfolio_type: 'CARD',
      portfolio_content: [{card_type: 'IMAGE', image_id: 'img-1'}],
    },
  };
  const requests = [],
    writes = [];
  let n = 0,
    signed = 0,
    mode = '';
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const u = new URL(String(raw)),
      path = u.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET',
      q = k => u.searchParams.get(k);
    requests.push(method + ' ' + path);
    if (method === 'GET' && path === '/v1.3/smart_plus/ad/get/') {
      const ids = JSON.parse(q('filtering')).smart_plus_ad_ids,
        rows = ids
          .filter(id => ads[id])
          .map(id => (readBack ? readBack(structuredClone(ads[id])) : structuredClone(ads[id])));
      return ok({list: rows, page_info: {page: 1, page_size: 100, total_number: rows.length, total_page: 1}});
    }
    if (method === 'GET' && path === '/v1.3/identity/info/') {
      const i = identities[q('identity_type') + ':' + q('identity_id')];
      return i
        ? ok({
            identity_info: {
              identity_id: q('identity_id'),
              identity_type: q('identity_type'),
              profile_image_url: 'https://p16.example.test/a.jpeg?x-signature=' + ++signed,
              ...i,
            },
          })
        : Response.json({code: 40002, message: 'Identity does not exist', request_id: 'r' + ++n, data: {}});
    }
    if (method === 'GET' && path === '/v1.3/identity/video/info/') {
      const own = posts[q('identity_id')] ?? {};
      return ok({
        video_details: JSON.parse(q('item_ids'))
          .filter(id => own[id])
          .map(id => ({
            item_id: id,
            item_type: own[id],
            status: 'ITEM_STATUS_HESITATE_RECOMMEND',
            video_info: {url: 'https://v16.example.test/' + id + '.mp4?x-expires=' + ++signed},
          })),
      });
    }
    if (method === 'GET' && path === '/v1.3/creative/portfolio/get/') {
      const p = portfolios[q('creative_portfolio_id')];
      return p
        ? ok(structuredClone(p))
        : Response.json({code: 40002, message: 'Creative portfolio does not exist', request_id: 'r' + ++n, data: {}});
    }
    if (method === 'POST' && path === '/v1.3/smart_plus/ad/update/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      const a = ads[b.smart_plus_ad_id];
      // Incremental, except creative_list, which replaces the ad's creatives; TikTok returns lists in its own order.
      if (b.ad_name !== undefined) a.ad_name = b.ad_name;
      if (b.creative_list) a.creative_list = stored(b.creative_list).reverse();
      if (b.landing_page_url_list) a.landing_page_url_list = b.landing_page_url_list;
      if (b.ad_configuration)
        a.ad_configuration = {
          ...b.ad_configuration,
          creative_auto_enhancement_strategy_list: [
            ...b.ad_configuration.creative_auto_enhancement_strategy_list,
          ].reverse(),
        };
      if (mode === 'lost') throw new Error('Synthetic accepted response lost');
      return mode === 'error'
        ? Response.json({code: 40002, message: 'Post is not available for Spark Ads', request_id: 'r' + ++n, data: {}})
        : ok(structuredClone(a));
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const start = () =>
    new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    });
  let service = start();
  const call = (tool, input) => service.call(tool, input, actor);
  const args = (payload, action = 'tiktok_smart_plus_ad_update') => ({action, account_id: account, payload});
  const prepare = (payload, extra = {}, action) =>
    call('amcp_write', {action: 'prepare', gateway, connection_id: TIKTOK, arguments: args(payload, action), ...extra});
  const execute = (id, extra = {}) =>
    call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true, ...extra});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  return {
    store,
    ads,
    identities,
    requests,
    writes,
    call,
    args,
    prepare,
    execute,
    verify,
    mode: v => {
      mode = v;
    },
    restart: () => {
      service = start();
    },
  };
}

test('Smart+ ad edits are a reviewed TikTok family under both action names', async () => {
  const f = fixture();
  try {
    for (const action of ['tiktok_smart_plus_ad_update', 'tiktok_smart_ad_update']) {
      const r = await f.call('amcp_write', {
        action: 'inspect',
        gateway,
        connection_id: TIKTOK,
        arguments: f.args({smart_plus_ad_id: '5100', ad_name: 'Renamed'}, action),
      });
      assert.equal(r.data.review_contract_supported, true, action + ' ' + JSON.stringify(r));
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('only name, post, landing page and configuration edits are accepted, before any request', async () => {
  const f = fixture();
  try {
    const ad = extra => ({smart_plus_ad_id: '5100', ...extra});
    const cases = {
      'nothing to change': [ad(), 'ad_name'],
      'status': [ad({operation_status: 'ENABLE'}), 'operation_status'],
      'ad texts': [ad({ad_text_list: [{ad_text: 'Sale'}]}), 'ad_text_list'],
      'long name': [ad({ad_name: 'x'.repeat(513)}), 'ad_name'],
      'material ID': [
        ad({creative_list: [{ad_material_id: 'm0', creative_info: post('9001').creative_info}]}),
        'creative_list[0].ad_material_id',
      ],
      'upload': [
        ad({creative_list: [post('9001', 'SINGLE_VIDEO', {video_info: {video_id: 'v1'}})]}),
        'creative_list[0].creative_info.video_info',
      ],
      'custom identity': [
        ad({creative_list: [post('9001', 'SINGLE_VIDEO', {identity_type: 'CUSTOMIZED_USER'})]}),
        'creative_list[0].creative_info.identity_type',
      ],
      'implicit auto-add': [
        ad({ad_configuration: {call_to_action_id: '700', creative_auto_enhancement_strategy_list: []}}),
        'ad_configuration.creative_auto_add_toggle',
      ],
      'UTM not in the new URL': [
        ad({landing_page_url_list: [{landing_page_url: 'https://shop.example.test/new'}], ad_configuration: config()}),
        'ad_configuration.utm_params',
      ],
    };
    for (const [name, [payload, field]] of Object.entries(cases)) {
      const r = await f.prepare(payload);
      assert.equal(
        r.error?.code,
        'INVALID_TIKTOK_SMART_PLUS_AD',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
      assert.equal(r.error.details?.field, field, name);
    }
    assert.equal(
      (await f.prepare({advertiser_id: '999', smart_plus_ad_id: '5100', ad_name: 'x'})).error?.code,
      'ACCOUNT_SCOPE_MISMATCH',
    );
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('any Smart+ ad can be renamed; the review reads only the ad and verifies the name', async () => {
  const f = fixture();
  try {
    const p = await f.prepare({smart_plus_ad_id: '5102', ad_name: 'Uploaded video Q4'});
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(
      p.data.state_reads.map(r => r.path),
      ['/v1.3/smart_plus/ad/get/'],
    );
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    assert.deepEqual(p.data.creative_impact.changes.ad_name, {before: 'Uploaded video', after: 'Uploaded video Q4'});
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.deepEqual(f.writes, [{advertiser_id: account, smart_plus_ad_id: '5102', ad_name: 'Uploaded video Q4'}]);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('replacing the posts of a paused ad lists kept, added and removed posts and verifies', async () => {
  const f = fixture();
  try {
    const p = await f.prepare({smart_plus_ad_id: '5100', creative_list: [post('9001'), post('9003')]});
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(
      p.data.state_reads.map(r => r.path),
      ['/v1.3/smart_plus/ad/get/', '/v1.3/identity/info/', '/v1.3/identity/video/info/'],
    );
    assert.deepEqual(p.data.creative_impact.changes.creative_list, {
      kept: ['9001'],
      added: ['9003'],
      removed: ['9002'],
    });
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
  } finally {
    f.store.close();
  }
});

test('removing posts from an enabled ad needs creative_edit_confirmed at review and execution', async () => {
  const f = fixture();
  try {
    const edit = {smart_plus_ad_id: '5101', creative_list: [post('9001'), post('9004')]};
    const refused = await f.prepare(edit);
    assert.equal(refused.error?.code, 'CREATIVE_EDIT_CONFIRMATION_REQUIRED', JSON.stringify(refused));
    assert.deepEqual(refused.error.details.removed, ['9003']);
    const added = await f.prepare({
      smart_plus_ad_id: '5101',
      creative_list: [post('9001'), post('9003'), post('9004')],
    });
    assert.equal(added.success, true, 'adding posts removes nothing');
    const p = await f.prepare(edit, {creative_edit_confirmed: true});
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal(p.data.creative_impact.may_affect_serving, true);
    assert.equal((await f.execute(p.data.review_id)).error?.code, 'CREATIVE_EDIT_CONFIRMATION_REQUIRED');
    assert.equal(f.writes.length, 0);
    assert.equal((await f.execute(p.data.review_id, {creative_edit_confirmed: true})).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('edits the ad or its dependencies cannot carry are refused before any write', async () => {
  const f = fixture();
  try {
    const cases = [
      [
        'posts of an upload ad',
        {smart_plus_ad_id: '5102', creative_list: [post('9001')]},
        'INVALID_TIKTOK_SMART_PLUS_AD',
        /only its name can be edited/,
      ],
      ['terminated ad', {smart_plus_ad_id: '5103', ad_name: 'Revived'}, 'INVALID_TIKTOK_SMART_PLUS_AD', /FROZEN/],
      [
        'adding TRANSLATE_AND_DUB',
        {
          smart_plus_ad_id: '5100',
          ad_configuration: config({creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY', 'TRANSLATE_AND_DUB']}),
        },
        'INVALID_TIKTOK_SMART_PLUS_AD',
        /TRANSLATE_AND_DUB cannot be added or removed/,
      ],
      [
        'removing TRANSLATE_AND_DUB',
        {
          smart_plus_ad_id: '5101',
          ad_configuration: config({creative_auto_enhancement_strategy_list: [], utm_params: undefined}),
        },
        'INVALID_TIKTOK_SMART_PLUS_AD',
        /TRANSLATE_AND_DUB cannot be added or removed/,
      ],
      [
        'UTM parameters dropped',
        {smart_plus_ad_id: '5100', ad_configuration: config({utm_params: undefined})},
        'INVALID_TIKTOK_SMART_PLUS_AD',
        /Restate utm_params/,
      ],
      [
        'new URL without the UTM parameters',
        {smart_plus_ad_id: '5100', landing_page_url_list: [{landing_page_url: 'https://shop.example.test/new'}]},
        'INVALID_TIKTOK_SMART_PLUS_AD',
        /utm_params only record/,
      ],
      [
        'display card as CTA',
        {smart_plus_ad_id: '5100', ad_configuration: config({call_to_action_id: '701'})},
        'INVALID_TIKTOK_CTA_PORTFOLIO',
        /CARD portfolio/,
      ],
      [
        'private account post',
        {smart_plus_ad_id: '5100', creative_list: [post('9201', 'SINGLE_VIDEO', {identity_id: 'tt-private'})]},
        'INVALID_TIKTOK_SMART_PLUS_AD',
        /IS_PRIVATE_ACCOUNT/,
      ],
      ['missing ad', {smart_plus_ad_id: '5199', ad_name: 'Missing'}, 'STATE_TARGET_MISMATCH', /./],
    ];
    for (const [name, payload, code, message] of cases) {
      for (const k of Object.keys(payload.ad_configuration ?? {}))
        if (payload.ad_configuration[k] === undefined) delete payload.ad_configuration[k];
      const r = await f.prepare(payload);
      assert.equal(r.error?.code, code, name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300));
      assert.match(r.error.message, message, name);
    }
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('a drifted read-back is inconclusive; rejected or lost edits are never resubmitted; concurrent executions submit once', async () => {
  const d = fixture({readBack: a => (a.ad_name === 'Paused spark Q4' ? {...a, ad_name: 'Paused spark q4'} : a)});
  try {
    const p = await d.prepare({smart_plus_ad_id: '5100', ad_name: 'Paused spark Q4'});
    await d.execute(p.data.review_id);
    const v = await d.verify(p.data.review_id);
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
    assert.deepEqual(v.data.checks[0].changed_fields, ['/ad_name']);
  } finally {
    d.store.close();
  }
  for (const [mode, first, again] of [
    // r25-m2-refusal (Q16): TikTok’s refusal here is code 40002 with no data in an HTTP 200 answer, which its return-code table defines as a refusal of the request: the review is rejected and its key retired (WRITE_REJECTED), not uncertain. A lost response stays uncertain.
    ['error', 'PLATFORM_ERROR', 'WRITE_REJECTED'],
    ['lost', 'WRITE_OUTCOME_UNCERTAIN', 'WRITE_OUTCOME_UNCERTAIN'],
  ]) {
    const f = fixture();
    try {
      const p = await f.prepare({smart_plus_ad_id: '5100', creative_list: [post('9001')]});
      f.mode(mode);
      assert.equal((await f.execute(p.data.review_id)).error?.code, first, mode);
      f.mode('');
      f.restart();
      assert.equal((await f.execute(p.data.review_id)).error?.code, again, mode);
      assert.equal(f.writes.length, 1, mode);
    } finally {
      f.store.close();
    }
  }
  const g = fixture();
  try {
    const p = await g.prepare({smart_plus_ad_id: '5100', ad_name: 'Parallel'});
    const results = await Promise.all([g.execute(p.data.review_id), g.execute(p.data.review_id)]);
    assert.ok(results.some(r => r.success));
    assert.equal(g.writes.length, 1);
    g.restart();
    assert.equal((await g.execute(p.data.review_id)).data.replayed, true);
  } finally {
    g.store.close();
  }
});

// ---- r25-field-tiktok (#6): every violation of an edit in one answer, and product_info_enabled ---------------------------------
// As for the create contract (tests/tiktok-smart-plus-ads.test.mjs): an edit that breaks several rules is refused once, with the
// first violation as the message and every one in details.violations; an edit that breaks one is refused as it always was.
// ad_configuration.product_info_enabled (UNSET, NON_CATALOG or CATALOG, "Update an Upgraded Smart+ Ad" and "Get Upgraded Smart+
// Ads", checked 2026-11-19) is accepted only as UNSET. UNSET switches product information off, so an ad whose mode is on keeps it:
// restating UNSET over it is refused, as TRANSLATE_AND_DUB cannot be removed.
const fieldsOf = r => r.error.details.violations.map(v => v.field);

test('an edit that breaks several rules is refused once, with the first violation as the message and every one listed', async () => {
  const f = fixture();
  try {
    const r = await f.prepare({
      smart_plus_ad_id: 'x',
      operation_status: 'ENABLE',
      ad_text_list: [{ad_text: 'Sale'}],
      ad_name: '',
      creative_list: [post('abc')],
      ad_configuration: {call_to_action_id: 'x', product_info_enabled: 'CATALOG'},
    });
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.deepEqual(fieldsOf(r), [
      'operation_status',
      'ad_text_list',
      'smart_plus_ad_id',
      'ad_name',
      'creative_list[0].creative_info.tiktok_item_id',
      'ad_configuration.call_to_action_id',
      'ad_configuration.creative_auto_add_toggle',
      'ad_configuration.creative_auto_enhancement_strategy_list',
      'ad_configuration.product_info_enabled',
    ]);
    assert.equal(r.error.details.field, 'operation_status');
    const first =
      '"operation_status" is outside the qualified Smart+ Spark Ad edit contract; pause or enable the ad through the Smart+ status family.';
    assert.equal(r.error.details.violations[0].message, first);
    assert.equal(r.error.message, first.replace(/\.$/, '') + ', and 8 more (details.violations lists every one).');
    assert.equal(f.requests.length, 0, 'refused before any request');
    // Nothing to change is a rule of its own, and it is listed beside an unknown key.
    const none = await f.prepare({smart_plus_ad_id: '5100', operation_status: 'ENABLE'});
    assertRefused(none, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.deepEqual(fieldsOf(none), ['operation_status', 'ad_name']);
    // The landing page and the UTM match: a mismatch is listed once the page is valid, not before.
    const pages = await f.prepare({
      smart_plus_ad_id: '5100',
      landing_page_url_list: [{landing_page_url: 'ftp://example.test/'}],
      ad_configuration: config({utm_params: [{key: 'a', value: 'b'}], creative_auto_add_toggle: 'yes'}),
    });
    assert.deepEqual(fieldsOf(pages), ['landing_page_url_list', 'ad_configuration.creative_auto_add_toggle']);
    const utm = await f.prepare({
      smart_plus_ad_id: '5100',
      landing_page_url_list: [{landing_page_url: 'https://shop.example.test/new'}],
      ad_configuration: config({creative_auto_add_toggle: 'yes'}),
    });
    assert.deepEqual(fieldsOf(utm), ['ad_configuration.creative_auto_add_toggle', 'ad_configuration.utm_params']);
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('an edit that breaks one rule is refused as it always was: its own sentence and field, no count and no list', async () => {
  const f = fixture();
  try {
    const r = await f.prepare({smart_plus_ad_id: '5100', ad_name: 'x'.repeat(513)});
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(r.error.details.field, 'ad_name');
    assert.equal(r.error.details.violations, undefined);
    assert.equal(r.error.message_localization, undefined);
    assert.match(r.error.message, /^ad_name must be nonempty, at most 512 characters/);
  } finally {
    f.store.close();
  }
});

test('an edit may restate product_info_enabled UNSET when the ad has none or UNSET, and it verifies', async () => {
  for (const current of [undefined, 'UNSET']) {
    const f = fixture();
    try {
      // TikTok returns UNSET for an ad that never set it; an older read may not return the field at all.
      if (current) f.ads[5100].ad_configuration.product_info_enabled = current;
      const edit = {smart_plus_ad_id: '5100', ad_configuration: config({product_info_enabled: 'UNSET'})};
      const p = await f.prepare(edit);
      assert.equal(p.success, true, String(current) + ' ' + JSON.stringify(p.error ?? p.data).slice(0, 400));
      assert.equal((await f.execute(p.data.review_id)).success, true);
      assert.equal(f.writes[0].ad_configuration.product_info_enabled, 'UNSET');
      const v = await f.verify(p.data.review_id);
      assert.equal(v.data.status, 'verified', JSON.stringify(v));
    } finally {
      f.store.close();
    }
  }
});

test('an edit never switches product information off: UNSET over NON_CATALOG or CATALOG is refused at review and again at execution', async () => {
  for (const current of ['NON_CATALOG', 'CATALOG']) {
    const f = fixture();
    try {
      f.ads[5100].ad_configuration.product_info_enabled = current;
      const edit = {smart_plus_ad_id: '5100', ad_configuration: config({product_info_enabled: 'UNSET'})};
      const r = await f.prepare(edit);
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, 'ad_configuration.product_info_enabled');
      assert.match(r.error.message, new RegExp(current));
      assert.match(r.error.message, /switch/);
      // The same edit is accepted while the ad's mode is UNSET, and refused at execution once the ad turned out to have it on.
      f.ads[5100].ad_configuration.product_info_enabled = 'UNSET';
      const p = await f.prepare(edit);
      assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 400));
      f.ads[5100].ad_configuration.product_info_enabled = current;
      assertRefused(await f.execute(p.data.review_id), 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    } finally {
      f.store.close();
    }
  }
});

test('every other value of product_info_enabled is outside the edit contract and refused, before any request', async () => {
  const f = fixture();
  try {
    for (const value of ['ON', 'NON_CATALOG', 'CATALOG', 'unset', '', true, null, 0, ['UNSET']]) {
      const edit = {smart_plus_ad_id: '5100', ad_configuration: config({product_info_enabled: value})};
      const r = await f.prepare(JSON.parse(JSON.stringify(edit)));
      const name = 'product_info_enabled ' + JSON.stringify(value);
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, 'ad_configuration.product_info_enabled', name);
      assert.match(r.error.message, /Set product_info_enabled to UNSET or leave it out/, name);
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});
