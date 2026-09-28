import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * TikTok saved audiences (API for Business v1.3, checked 2026-09-26): reusable targeting that changes no ad group.
 * The details read returns ID lists in its own order, expands a price range into steps of 50, and fills unset
 * fields with defaults.
 */
const TIKTOK = '16161616-1616-4161-8161-161616161616',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-saved-audiences', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 73).toString('base64');
const audience = (extra = {}) => ({
  saved_audience_name: 'Bidders KSA 25-44',
  location_ids: ['6252001', '2077456'],
  gender: 'GENDER_UNLIMITED',
  age_groups: ['AGE_25_34', 'AGE_35_44'],
  languages: ['ar', 'en'],
  audience_ids: ['500'],
  excluded_audience_ids: ['501'],
  interest_category_ids: ['14', '16'],
  actions: [
    {
      action_scene: 'VIDEO_RELATED',
      action_period: 7,
      action_category_ids: ['2'],
      video_user_actions: ['WATCHED_TO_END', 'LIKED'],
    },
    {action_scene: 'CREATOR_RELATED', action_period: 0, action_category_ids: ['3'], video_user_actions: ['FOLLOWING']},
  ],
  operating_systems: ['ANDROID'],
  min_android_version: '10.0',
  network_types: ['WIFI', '4G'],
  device_price_ranges: [0, 1000],
  ...extra,
});
const seeds = {
  500: {audience_id: '500', name: 'Buyers', type: 'Customer File', is_creator: true, is_valid: true, cover_num: 5000},
  501: {audience_id: '501', name: 'Converted', type: 'Engagement', is_creator: true, is_valid: true, cover_num: 900},
  502: {
    audience_id: '502',
    name: 'Shared list',
    type: 'Customer File',
    is_creator: false,
    is_valid: true,
    cover_num: 4000,
  },
  503: {audience_id: '503', name: 'Preparing', type: 'Customer File', is_creator: true, is_valid: false, cover_num: 0},
};
function fixture({readDrift} = {}) {
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
  const saved = new Map(),
    requests = [],
    writes = [];
  let n = 0,
    mode = '';
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET',
      q = k => url.searchParams.get(k);
    requests.push(method + ' ' + path);
    if (method === 'GET' && path === '/v1.3/advertiser/info/')
      return ok({
        list: [
          {
            advertiser_id: account,
            name: 'Synthetic advertiser',
            currency: 'SAR',
            timezone: 'Asia/Riyadh',
            status: 'STATUS_ENABLE',
          },
        ],
      });
    if (method === 'GET' && path === '/v1.3/dmp/custom_audience/get/') {
      const ids = JSON.parse(q('custom_audience_ids'));
      return ok({
        list: ids.filter(id => seeds[id]).map(id => ({audience_details: {...seeds[id]}, audience_history: []})),
      });
    }
    if (method === 'POST' && path === '/v1.3/dmp/saved_audience/create/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      const {advertiser_id, ...stored} = b;
      // TikTok returns lists in its own order, the price range in steps of 50, and defaults for unset fields.
      const read = {
        ...stored,
        saved_audience_id: '9900001',
        location_ids: [...b.location_ids].reverse(),
        age_groups: [...(b.age_groups ?? [])].reverse(),
        min_ios_version: 'NONE',
        device_model_ids: [],
        actions: [...(b.actions ?? [])]
          .reverse()
          .map(a => ({...a, video_user_actions: [...a.video_user_actions].reverse()})),
        ...(b.device_price_ranges
          ? {
              device_price_ranges: Array.from(
                {length: (b.device_price_ranges[1] - b.device_price_ranges[0]) / 50 + 1},
                (_, i) => b.device_price_ranges[0] + i * 50,
              ),
            }
          : {}),
      };
      saved.set('9900001', read);
      if (mode === 'lost') throw new Error('Synthetic accepted response lost');
      return mode === 'error'
        ? Response.json({code: 40002, message: 'Invalid location', request_id: 'r' + ++n, data: {}})
        : ok({saved_audience_id: '9900001'});
    }
    if (method === 'GET' && path === '/v1.3/dmp/saved_audience/list/') {
      const ids = JSON.parse(q('saved_audience_ids'));
      const list = ids
        .filter(id => saved.has(id))
        .map(id => (readDrift ? readDrift(structuredClone(saved.get(id))) : structuredClone(saved.get(id))));
      return ok({saved_audiences: list, page_info: {page: 1, page_size: 10, total_number: list.length, total_page: 1}});
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
  const args = (payload, action = 'tiktok_dmp_saved_audience_create') => ({action, account_id: account, payload});
  const prepare = payload =>
    call('amcp_write', {action: 'prepare', gateway, connection_id: TIKTOK, arguments: args(payload)});
  const execute = id => call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  return {
    store,
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

test('saved audience creation is a reviewed TikTok family; deletion is reviewed by the deletions family', async () => {
  const f = fixture();
  try {
    const inspected = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      connection_id: TIKTOK,
      arguments: f.args(audience()),
    });
    assert.equal(inspected.data.review_contract_supported, true, JSON.stringify(inspected));
    const deletion = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      connection_id: TIKTOK,
      arguments: f.args({saved_audience_ids: ['9900001']}, 'tiktok_dmp_saved_audience_delete'),
    });
    assert.equal(deletion.data?.review_contract_supported, true, JSON.stringify(deletion));
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('only documented targeting is accepted, before any request', async () => {
  const f = fixture();
  try {
    const cases = {
      'no name': audience({saved_audience_name: ' '}),
      'emoji name': audience({saved_audience_name: 'KSA 🎯'}),
      '513-character name': audience({saved_audience_name: 'x'.repeat(513)}),
      'no locations': audience({location_ids: []}),
      'duplicate locations': audience({location_ids: ['6252001', '6252001']}),
      'location name': audience({location_ids: ['Riyadh']}),
      'unknown gender': audience({gender: 'ALL'}),
      'unknown age': audience({age_groups: ['AGE_65_100']}),
      'duplicate age': audience({age_groups: ['AGE_18_24', 'AGE_18_24']}),
      'unknown network': audience({network_types: ['6G']}),
      'two systems': audience({operating_systems: ['ANDROID', 'IOS']}),
      'bad version': audience({min_android_version: 'ten'}),
      'price step': audience({device_price_ranges: [0, 1025]}),
      'reversed price': audience({device_price_ranges: [500, 100]}),
      'three prices': audience({device_price_ranges: [0, 100, 200]}),
      'models with prices': audience({device_model_ids: ['7']}),
      'included and excluded': audience({excluded_audience_ids: ['500']}),
      'unknown scene': audience({
        actions: [
          {action_scene: 'MUSIC_RELATED', action_period: 0, action_category_ids: ['2'], video_user_actions: ['LIKED']},
        ],
      }),
      'wrong scene action': audience({
        actions: [
          {
            action_scene: 'VIDEO_RELATED',
            action_period: 7,
            action_category_ids: ['2'],
            video_user_actions: ['FOLLOWING'],
          },
        ],
      }),
      'creator period': audience({
        actions: [
          {
            action_scene: 'CREATOR_RELATED',
            action_period: 7,
            action_category_ids: ['3'],
            video_user_actions: ['FOLLOWING'],
          },
        ],
      }),
      'video period': audience({
        actions: [
          {action_scene: 'VIDEO_RELATED', action_period: 30, action_category_ids: ['2'], video_user_actions: ['LIKED']},
        ],
      }),
      'no categories': audience({
        actions: [
          {action_scene: 'VIDEO_RELATED', action_period: 7, action_category_ids: [], video_user_actions: ['LIKED']},
        ],
      }),
      'extra action key': audience({
        actions: [
          {
            action_scene: 'VIDEO_RELATED',
            action_period: 7,
            action_category_ids: ['2'],
            video_user_actions: ['LIKED'],
            weight: 1,
          },
        ],
      }),
      'example-only field': audience({interest_keyword_language: ['en']}),
      'too many audiences': audience({
        audience_ids: Array.from({length: 60}, (_, i) => String(600 + i)),
        excluded_audience_ids: Array.from({length: 41}, (_, i) => String(700 + i)),
      }),
    };
    for (const [name, payload] of Object.entries(cases)) {
      const r = await f.prepare(payload);
      assert.equal(
        r.error?.code,
        'INVALID_TIKTOK_SAVED_AUDIENCE',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test("a saved audience with owned audiences is created once and verifies despite TikTok's read-back formatting", async () => {
  const f = fixture();
  try {
    const p = await f.prepare(audience());
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(
      p.data.state_reads.map(r => r.path),
      ['/v1.3/advertiser/info/', '/v1.3/dmp/custom_audience/get/'],
    );
    const impact = p.data.creative_impact;
    assert.equal(impact.scope, 'saved_audiences');
    assert.equal(impact.may_affect_serving, false);
    assert.deepEqual(
      [
        impact.saved_audience.locations,
        impact.saved_audience.included_audiences,
        impact.saved_audience.excluded_audiences,
      ],
      [2, 1, 1],
    );
    const done = await f.execute(p.data.review_id);
    assert.equal(done.success, true, 'a name mentioning bidders is not a spending change: ' + JSON.stringify(done));
    assert.equal(f.writes.length, 1);
    const {advertiser_id, ...sent} = f.writes[0];
    assert.equal(advertiser_id, account);
    assert.deepEqual(sent, audience());
    const verified = await f.verify(p.data.review_id);
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified));
    assert.equal(verified.data.checks[0].resource_id, '9900001');
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('without referenced audiences only the advertiser is read', async () => {
  const f = fixture();
  try {
    const {audience_ids, excluded_audience_ids, ...plain} = audience();
    const p = await f.prepare(plain);
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(
      p.data.state_reads.map(r => r.path),
      ['/v1.3/advertiser/info/'],
    );
  } finally {
    f.store.close();
  }
});

test('shared, unavailable and missing audiences are refused before any write', async () => {
  const f = fixture();
  try {
    for (const [payload, code, pattern] of [
      [audience({audience_ids: ['502']}), 'INVALID_TIKTOK_SAVED_AUDIENCE', /shared/],
      [audience({excluded_audience_ids: ['503']}), 'INVALID_TIKTOK_SAVED_AUDIENCE', /not available/],
      [audience({audience_ids: ['599']}), 'STATE_TARGET_MISMATCH', /./],
    ]) {
      const r = await f.prepare(payload);
      assert.equal(r.error?.code, code, JSON.stringify(r).slice(0, 300));
      assert.match(r.error.message, pattern);
    }
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('a saved audience that reads back differently stays inconclusive', async () => {
  for (const [name, drift, field] of [
    ['locations', d => ({...d, location_ids: ['6252001']}), '/location_ids'],
    ['prices', d => ({...d, device_price_ranges: [0, 50, 100]}), '/device_price_ranges'],
    ['actions', d => ({...d, actions: d.actions.slice(1)}), '/actions'],
  ]) {
    const f = fixture({readDrift: drift});
    try {
      const p = await f.prepare(audience());
      await f.execute(p.data.review_id);
      const verified = await f.verify(p.data.review_id);
      assert.equal(verified.data.status, 'inconclusive', name + ' ' + JSON.stringify(verified));
      assert.deepEqual(verified.data.checks[0].changed_fields, [field], name);
    } finally {
      f.store.close();
    }
  }
});

test('rejected or lost creations are never resubmitted, and claims survive restart and concurrency', async () => {
  for (const [mode, first, again] of [
    ['error', 'PLATFORM_ERROR', 'WRITE_OUTCOME_UNCERTAIN'],
    ['lost', 'WRITE_OUTCOME_UNCERTAIN', 'WRITE_OUTCOME_UNCERTAIN'],
  ]) {
    const f = fixture();
    try {
      const p = await f.prepare(audience());
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
    const p = await g.prepare(audience());
    const results = await Promise.all([g.execute(p.data.review_id), g.execute(p.data.review_id)]);
    assert.ok(results.some(r => r.success));
    assert.equal(g.writes.length, 1);
    g.restart();
    assert.equal((await g.execute(p.data.review_id)).data.replayed, true);
  } finally {
    g.store.close();
  }
});
