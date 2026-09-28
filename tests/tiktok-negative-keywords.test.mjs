import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * Search Ads negative keywords of manual campaigns and ad groups (API for Business v1.3, checked 2026-09-26). Add and delete
 * return no keyword IDs, so every edited list is read completely, 50 keywords per page, before and after.
 */
const TIKTOK = '31313131-3131-4313-8313-313131313131',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-negative-keywords', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 90).toString('base64');
function fixture() {
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
  const adgroups = {
    301: {
      adgroup_id: '301',
      campaign_id: '201',
      adgroup_name: 'Search on',
      search_result_enabled: true,
      operation_status: 'ENABLE',
    },
    302: {
      adgroup_id: '302',
      campaign_id: '201',
      adgroup_name: 'Search off',
      search_result_enabled: false,
      operation_status: 'ENABLE',
    },
    304: {
      adgroup_id: '304',
      campaign_id: '203',
      adgroup_name: 'Feed only',
      search_result_enabled: false,
      operation_status: 'DISABLE',
    },
  };
  const campaigns = {
    201: {campaign_id: '201', campaign_name: 'Search campaign'},
    203: {campaign_id: '203', campaign_name: 'Feed campaign'},
  };
  const lists = new Map([
    [
      'ADGROUP:301',
      Array.from({length: 60}, (_, i) => ({keyword_id: String(9000 + i), name: 'kw' + i, match_type: 'BROAD_WORD'})),
    ],
    ['CAMPAIGN:201', [{keyword_id: '8000', name: 'free', match_type: 'PRECISE_WORD'}]],
  ]);
  let next = 10000,
    writes = 0,
    mode = '',
    n = 0;
  const requests = [];
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const u = new URL(String(raw)),
      path = u.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET',
      q = k => u.searchParams.get(k);
    requests.push(method + ' ' + path + (q('page') ? ' p' + q('page') : ''));
    if (path === '/v1.3/adgroup/get/') {
      const f = JSON.parse(q('filtering'));
      const list = Object.values(adgroups)
        .filter(g => (f.adgroup_ids ? f.adgroup_ids.includes(g.adgroup_id) : f.campaign_ids.includes(g.campaign_id)))
        .map(g => ({advertiser_id: account, ...g}));
      return ok({
        list,
        page_info: {
          page: 1,
          page_size: 100,
          total_number: list.length,
          total_page: mode === 'many_adgroups' && f.campaign_ids ? 2 : 1,
        },
      });
    }
    if (path === '/v1.3/campaign/get/') {
      const f = JSON.parse(q('filtering'));
      const list = Object.values(campaigns)
        .filter(c => f.campaign_ids.includes(c.campaign_id))
        .map(c => ({advertiser_id: account, ...c}));
      return ok({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
    }
    if (path === '/v1.3/search_ad/negative_keyword/get/') {
      const list = lists.get(q('object_type') + ':' + q('object_id')) ?? [],
        page = Number(q('page')),
        size = Number(q('page_size'));
      const total = mode === 'huge' ? 201 : mode === 'shifting' && page > 1 ? 3 : Math.ceil(list.length / size);
      return ok({
        keywords: structuredClone(list.slice((page - 1) * size, page * size)),
        page_info: {page, page_size: size, total_number: list.length, total_page: total},
      });
    }
    const b = JSON.parse(init.body);
    writes++;
    if (path === '/v1.3/search_ad/negative_keyword/add/') {
      for (const id of b.object_ids) {
        const k = b.object_type + ':' + id,
          current = b.replace ? [] : (lists.get(k) ?? []);
        for (const w of b.keywords)
          if (!current.some(c => c.name.toLowerCase() === w.name.toLowerCase()))
            current.push({keyword_id: String(next++), name: w.name, match_type: w.match_type ?? 'BROAD_WORD'});
        lists.set(k, current);
      }
      return ok({});
    }
    if (path === '/v1.3/search_ad/negative_keyword/update/') {
      const list = lists.get(b.object_type + ':' + b.object_id),
        old = list.find(k => k.keyword_id === b.old_keyword_id),
        renamed = old.name !== b.keyword.name,
        id = renamed ? String(next++) : old.keyword_id;
      Object.assign(old, {keyword_id: id, name: b.keyword.name, match_type: b.keyword.match_type ?? 'BROAD_WORD'});
      return ok(mode === 'no_id' ? {} : {new_keyword_id: id});
    }
    if (path === '/v1.3/search_ad/negative_keyword/delete/') {
      const k = b.object_type + ':' + b.object_id;
      lists.set(
        k,
        lists.get(k).filter(w => !b.keyword_ids.includes(w.keyword_id)),
      );
      return ok({});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const prepare = (action, payload) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, connection_id: TIKTOK, arguments: {action, account_id: account, payload}},
      actor,
    );
  const add = payload => prepare('tiktok_search_ad_negative_keyword_add', payload),
    update = payload => prepare('tiktok_search_ad_negative_keyword_update', payload),
    remove = payload => prepare('tiktok_search_ad_negative_keyword_delete', payload);
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
    lists,
    adgroups,
    requests,
    add,
    update,
    remove,
    execute,
    verify,
    writes: () => writes,
    mode: m => {
      mode = m;
    },
  };
}

test('adding exclusions to an ad group reads every keyword page, needs no spending confirmation, writes once and verifies', async () => {
  const f = fixture();
  try {
    const p = await f.add({
      object_type: 'ADGROUP',
      object_ids: ['301'],
      keywords: [{name: 'cheap tickets', match_type: 'PHRASE_WORD'}, {name: 'free'}],
    });
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    assert.deepEqual(
      f.requests.filter(r => r.includes('negative_keyword/get')),
      ['GET /v1.3/search_ad/negative_keyword/get/ p1', 'GET /v1.3/search_ad/negative_keyword/get/ p2'],
    );
    const impact = p.data.creative_impact;
    assert.equal(impact.scope, 'search_negative_keywords');
    assert.equal(impact.may_affect_serving, false);
    assert.deepEqual(impact.keywords_before, [{object_id: '301', count: 60}]);
    const e = await f.execute(p);
    assert.equal(e.success, true, JSON.stringify(e).slice(0, 700));
    assert.equal(f.writes(), 1);
    assert.equal(f.lists.get('ADGROUP:301').length, 62);
    const v = await f.verify(p);
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 700));
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('a campaign needs an ad group with Automatic Search Placement; its keywords are added and verified', async () => {
  const f = fixture();
  try {
    const p = await f.add({
      object_type: 'CAMPAIGN',
      object_ids: ['201'],
      keywords: [{name: 'jobs', match_type: 'BROAD_WORD'}],
    });
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    assert.equal((await f.execute(p)).success, true);
    assert.equal((await f.verify(p)).data.status, 'verified');
    const off = await f.add({object_type: 'CAMPAIGN', object_ids: ['203'], keywords: [{name: 'jobs'}]});
    assert.equal(off.error?.code, 'INVALID_TIKTOK_NEGATIVE_KEYWORD');
    assert.match(off.error.message, /no ad group with Automatic Search Placement/);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('deleting, renaming and replacing keywords need spending confirmation, and each result verifies', async () => {
  const f = fixture();
  try {
    const d = await f.remove({object_type: 'CAMPAIGN', object_id: '201', keyword_ids: ['8000']});
    assert.equal(d.success, true, JSON.stringify(d).slice(0, 500));
    assert.equal((await f.execute(d)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal((await f.execute(d, {spend_change_confirmed: true})).success, true);
    assert.equal((await f.verify(d)).data.status, 'verified');
    const u = await f.update({
      object_type: 'ADGROUP',
      object_id: '301',
      old_keyword_id: '9000',
      keyword: {name: 'kw zero', match_type: 'PRECISE_WORD'},
    });
    assert.equal(u.success, true, JSON.stringify(u).slice(0, 500));
    assert.equal(u.data.creative_impact.may_affect_serving, true);
    assert.equal((await f.execute(u, {spend_change_confirmed: true})).success, true);
    assert.equal((await f.verify(u)).data.status, 'verified');
    const r = await f.add({
      object_type: 'ADGROUP',
      object_ids: ['301'],
      replace: true,
      keywords: [{name: 'only this', match_type: 'PRECISE_WORD'}],
    });
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 500));
    assert.equal((await f.execute(r)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal((await f.execute(r, {spend_change_confirmed: true})).success, true);
    assert.equal((await f.verify(r)).data.status, 'verified');
    assert.deepEqual(
      f.lists.get('ADGROUP:301').map(k => k.name),
      ['only this'],
    );
    assert.equal(f.writes(), 3);
  } finally {
    f.store.close();
  }
});

test('ad groups without search, existing and absent keywords, clashing and empty updates, and unknown ad groups are refused before any write', async () => {
  const f = fixture();
  try {
    for (const [label, run, code, message] of [
      [
        'search off',
        () => f.add({object_type: 'ADGROUP', object_ids: ['302'], keywords: [{name: 'x'}]}),
        'INVALID_TIKTOK_NEGATIVE_KEYWORD',
        /Automatic Search Placement/,
      ],
      [
        'existing name',
        () =>
          f.add({object_type: 'ADGROUP', object_ids: ['301'], keywords: [{name: 'KW5', match_type: 'PRECISE_WORD'}]}),
        'CONFIGURATION_EXISTS',
        /already has the negative keyword "KW5"/,
      ],
      [
        'absent keyword',
        () => f.remove({object_type: 'ADGROUP', object_id: '301', keyword_ids: ['1']}),
        'STATE_NOT_FOUND',
        /no negative keyword 1/,
      ],
      [
        'clashing rename',
        () =>
          f.update({
            object_type: 'ADGROUP',
            object_id: '301',
            old_keyword_id: '9000',
            keyword: {name: 'kw1', match_type: 'BROAD_WORD'},
          }),
        'CONFIGURATION_EXISTS',
        /another negative keyword named "kw1"/,
      ],
      [
        'empty update',
        () =>
          f.update({
            object_type: 'ADGROUP',
            object_id: '301',
            old_keyword_id: '9000',
            keyword: {name: 'kw0', match_type: 'BROAD_WORD'},
          }),
        'INVALID_TIKTOK_NEGATIVE_KEYWORD',
        /neither the name nor the match type/,
      ],
      [
        'unknown ad group',
        () => f.add({object_type: 'ADGROUP', object_ids: ['399'], keywords: [{name: 'x'}]}),
        'STATE_NOT_FOUND',
        /must exist/,
      ],
    ]) {
      const r = await run();
      assert.equal(r.error?.code, code, label + ': ' + JSON.stringify(r).slice(0, 400));
      assert.match(r.error.message, message, label);
    }
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('malformed keywords, objects and fields fail locally without network requests', async () => {
  for (const [label, action, payload] of [
    ['forbidden character', 'add', {object_type: 'ADGROUP', object_ids: ['301'], keywords: [{name: '50% off'}]}],
    ['81 characters', 'add', {object_type: 'ADGROUP', object_ids: ['301'], keywords: [{name: 'x'.repeat(81)}]}],
    [
      'same name twice',
      'add',
      {
        object_type: 'ADGROUP',
        object_ids: ['301'],
        keywords: [{name: 'Deal'}, {name: 'deal', match_type: 'PRECISE_WORD'}],
      },
    ],
    [
      'unknown match type',
      'add',
      {object_type: 'ADGROUP', object_ids: ['301'], keywords: [{name: 'deal', match_type: 'EXACT'}]},
    ],
    [
      'update without match type',
      'update',
      {object_type: 'ADGROUP', object_id: '301', old_keyword_id: '9000', keyword: {name: 'deal'}},
    ],
    [
      'eleven objects',
      'add',
      {
        object_type: 'ADGROUP',
        object_ids: Array.from({length: 11}, (_, i) => String(400 + i)),
        keywords: [{name: 'deal'}],
      },
    ],
    ['numeric object id', 'add', {object_type: 'ADGROUP', object_ids: [301], keywords: [{name: 'deal'}]}],
    [
      'unknown field',
      'delete',
      {object_type: 'ADGROUP', object_id: '301', keyword_ids: ['9000'], match_type: 'BROAD_WORD'},
    ],
    ['unknown object type', 'delete', {object_type: 'AD', object_id: '301', keyword_ids: ['9000']}],
    ['empty deletion', 'delete', {object_type: 'ADGROUP', object_id: '301', keyword_ids: []}],
  ]) {
    const f = fixture();
    try {
      const r = await (action === 'add' ? f.add(payload) : action === 'update' ? f.update(payload) : f.remove(payload));
      assert.equal(r.error?.code, 'INVALID_TIKTOK_NEGATIVE_KEYWORD', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.requests.length, 0, label);
    } finally {
      f.store.close();
    }
  }
});

test('owner policies: deletions and replacements are removals, and widening edits count as serving; plain additions pass', async () => {
  const f = fixture();
  try {
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: account,
      confirmed: true,
      policy: {allow_deletion: false, allow_activation: true},
    });
    assert.equal(
      (await f.remove({object_type: 'ADGROUP', object_id: '301', keyword_ids: ['9000']})).error?.code,
      'POLICY_DELETION_FORBIDDEN',
    );
    assert.equal(
      (await f.add({object_type: 'ADGROUP', object_ids: ['301'], replace: true, keywords: [{name: 'x'}]})).error?.code,
      'POLICY_DELETION_FORBIDDEN',
    );
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: account,
      confirmed: true,
      policy: {allow_deletion: true, allow_activation: false},
    });
    assert.equal(
      (
        await f.update({
          object_type: 'ADGROUP',
          object_id: '301',
          old_keyword_id: '9000',
          keyword: {name: 'kw zero', match_type: 'BROAD_WORD'},
        })
      ).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
    assert.equal(
      (await f.add({object_type: 'ADGROUP', object_ids: ['301'], keywords: [{name: 'fresh'}]})).success,
      true,
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('shifting page counts, oversized lists and campaigns with too many ad groups never pass as complete state; later changes stop execution', async () => {
  for (const [mode, code] of [
    ['shifting', 'STATE_CHANGED'],
    ['huge', 'STATE_TOO_LARGE'],
  ]) {
    const f = fixture();
    try {
      f.mode(mode);
      const r = await f.add({object_type: 'ADGROUP', object_ids: ['301'], keywords: [{name: 'x'}]});
      assert.equal(r.error?.code, code, mode + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.writes(), 0);
      if (mode === 'huge')
        assert.equal(
          f.requests.filter(x => x.includes('negative_keyword/get')).length,
          1,
          'refused after the first page',
        );
    } finally {
      f.store.close();
    }
  }
  {
    const f = fixture();
    try {
      f.mode('many_adgroups');
      const r = await f.add({object_type: 'CAMPAIGN', object_ids: ['201'], keywords: [{name: 'x'}]});
      assert.equal(r.error?.code, 'INCOMPLETE_STATE', JSON.stringify(r).slice(0, 300));
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const p = await f.add({object_type: 'ADGROUP', object_ids: ['301'], keywords: [{name: 'late'}]});
    assert.equal(p.success, true);
    f.lists.get('ADGROUP:301').push({keyword_id: '7777', name: 'added elsewhere', match_type: 'BROAD_WORD'});
    assert.equal((await f.execute(p)).error?.code, 'STATE_CHANGED');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('an update receipt without the new keyword ID is kept as a failure and is never resubmitted or verified as success', async () => {
  const f = fixture();
  try {
    const u = await f.update({
      object_type: 'ADGROUP',
      object_id: '301',
      old_keyword_id: '9000',
      keyword: {name: 'kw zero', match_type: 'PRECISE_WORD'},
    });
    assert.equal(u.success, true);
    f.mode('no_id');
    assert.equal((await f.execute(u, {spend_change_confirmed: true})).success, false);
    assert.equal((await f.execute(u, {spend_change_confirmed: true})).data.replayed, true);
    assert.equal(f.writes(), 1);
    assert.equal((await f.verify(u)).error?.code, 'WRITE_PARTIAL_OR_FAILED');
  } finally {
    f.store.close();
  }
});
