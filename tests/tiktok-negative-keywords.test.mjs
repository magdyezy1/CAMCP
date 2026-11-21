import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {assertRefused} from './helpers/assert-refused.mjs';

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
    // R2.5 M4 (package r25-m4-search): the ad groups of a manual Search Ads campaign hold search_result_enabled false ("Create Manual
    // Search Ads Campaigns", read 2026-11-20: ignored and false) and keywords with the review status TikTok adds.
    305: {
      adgroup_id: '305',
      campaign_id: '205',
      adgroup_name: 'Search Ads group one',
      search_result_enabled: false,
      operation_status: 'ENABLE',
      search_keywords: [{keyword: 'running shoes', match_type: 'PHRASE_WORD', audit_status: 'SYNTHETIC_STATE_A'}],
    },
    306: {
      adgroup_id: '306',
      campaign_id: '205',
      adgroup_name: 'Search Ads group two',
      search_result_enabled: false,
      operation_status: 'DISABLE',
    },
    // The ad group of an Upgraded Smart+ Search campaign, whose negative keywords are account level.
    307: {
      adgroup_id: '307',
      campaign_id: '207',
      adgroup_name: 'Smart+ Search group',
      search_result_enabled: false,
      operation_status: 'DISABLE',
      campaign_automation_type: 'UPGRADED_SMART_PLUS',
    },
    // An ad group whose campaign TikTok does not return.
    308: {
      adgroup_id: '308',
      campaign_id: '299',
      adgroup_name: 'Orphan',
      search_result_enabled: false,
      operation_status: 'DISABLE',
    },
    // R2.5 M4 (package r25-m4-search, the lead's review S3-1 and S3-2): ad groups of Search campaigns whose row does not read MANUAL.
    309: {
      adgroup_id: '309',
      campaign_id: '209',
      adgroup_name: 'Search, no automation type',
      search_result_enabled: false,
      operation_status: 'DISABLE',
    },
    311: {
      adgroup_id: '311',
      campaign_id: '211',
      adgroup_name: 'Legacy Smart+ Search group',
      search_result_enabled: false,
      operation_status: 'DISABLE',
    },
    313: {
      adgroup_id: '313',
      campaign_id: '213',
      adgroup_name: 'Search, a type no page lists',
      search_result_enabled: false,
      operation_status: 'DISABLE',
    },
    315: {
      adgroup_id: '315',
      campaign_id: '215',
      adgroup_name: 'Search, a type that is no enum',
      search_result_enabled: false,
      operation_status: 'DISABLE',
    },
  };
  const campaigns = {
    201: {campaign_id: '201', campaign_name: 'Search campaign'},
    203: {campaign_id: '203', campaign_name: 'Feed campaign'},
    205: {
      campaign_id: '205',
      campaign_name: 'Manual Search Ads campaign',
      is_search_campaign: true,
      campaign_automation_type: 'MANUAL',
      operation_status: 'DISABLE',
    },
    207: {
      campaign_id: '207',
      campaign_name: 'Smart+ Search campaign',
      is_search_campaign: true,
      campaign_automation_type: 'UPGRADED_SMART_PLUS',
      operation_status: 'DISABLE',
    },
    // A Search campaign row with no automation type, one of the legacy Smart+, one with a type no page lists and one whose "type" is free
    // text: none was read as MANUAL (the lead's review S3-1), and what TikTok returned never reaches a message (S3-2).
    209: {
      campaign_id: '209',
      campaign_name: 'Search, no automation type',
      is_search_campaign: true,
      operation_status: 'DISABLE',
    },
    211: {
      campaign_id: '211',
      campaign_name: 'Legacy Smart+ Search',
      is_search_campaign: true,
      campaign_automation_type: 'SMART_PLUS',
      operation_status: 'DISABLE',
    },
    213: {
      campaign_id: '213',
      campaign_name: 'Search, a type no page lists',
      is_search_campaign: true,
      campaign_automation_type: 'SYNTHETIC_NEW_TYPE',
      operation_status: 'DISABLE',
    },
    215: {
      campaign_id: '215',
      campaign_name: 'Search, a type that is no enum',
      is_search_campaign: true,
      campaign_automation_type: 'free text, not an enum <b>',
      operation_status: 'DISABLE',
    },
  };
  const lists = new Map([
    [
      'ADGROUP:301',
      Array.from({length: 60}, (_, i) => ({keyword_id: String(9000 + i), name: 'kw' + i, match_type: 'BROAD_WORD'})),
    ],
    ['CAMPAIGN:201', [{keyword_id: '8000', name: 'free', match_type: 'PRECISE_WORD'}]],
    ['ADGROUP:305', [{keyword_id: '8100', name: 'free', match_type: 'PRECISE_WORD'}]],
    ['CAMPAIGN:205', [{keyword_id: '8200', name: 'jobs', match_type: 'BROAD_WORD'}]],
  ]);
  let next = 10000,
    writes = 0,
    mode = '',
    n = 0;
  const requests = [],
    campaignLookups = [];
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
      campaignLookups.push([...f.campaign_ids]);
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
    campaigns,
    campaignLookups,
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

// R2.5 M4 (package r25-m4-search, Q6): a manual Search Ads campaign takes negative keywords at its ad group and at itself ("Create Manual
// Search Ads Campaigns", read 2026-11-20: up to 10,000 for the ad group). TikTok ignores search_result_enabled on its ad groups and holds it
// false, so the review accepts an ad group whose campaign reads is_search_campaign true, besides the Automatic Search Placement rule that was.
// The campaign is read only for ad groups whose row does not say Automatic Search Placement, once for all of them.
const campaignReads = f => f.requests.filter(r => r === 'GET /v1.3/campaign/get/').length;

test('an add on the ad group of a manual Search Ads campaign reads its campaign once, then writes once and verifies', async () => {
  const f = fixture();
  try {
    const p = await f.add({
      object_type: 'ADGROUP',
      object_ids: ['305'],
      keywords: [{name: 'cheap tickets', match_type: 'PHRASE_WORD'}],
    });
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    assert.deepEqual(
      f.campaignLookups,
      [['205']],
      'one read, of the one campaign: the ad group does not say Automatic Search Placement',
    );
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    assert.deepEqual(p.data.creative_impact.keywords_before, [{object_id: '305', count: 1}]);
    const e = await f.execute(p);
    assert.equal(e.success, true, JSON.stringify(e).slice(0, 700));
    assert.equal(f.writes(), 1);
    assert.deepEqual(
      f.lists.get('ADGROUP:305').map(k => k.name),
      ['free', 'cheap tickets'],
    );
    const v = await f.verify(p);
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 700));
  } finally {
    f.store.close();
  }
});

test('the campaign is read only for the ad groups that do not say Automatic Search Placement, once for all of them', async () => {
  const f = fixture();
  try {
    // An ad group with Automatic Search Placement prepares without the campaign read, as it did.
    const plain = await f.add({object_type: 'ADGROUP', object_ids: ['301'], keywords: [{name: 'fresh'}]});
    assert.equal(plain.success, true, JSON.stringify(plain).slice(0, 500));
    assert.equal(campaignReads(f), 0);
    // Three ad groups, two of one Search Ads campaign and one with Automatic Search Placement: one read, of that campaign.
    const several = await f.add({
      object_type: 'ADGROUP',
      object_ids: ['301', '305', '306'],
      keywords: [{name: 'fresh'}],
    });
    assert.equal(several.success, true, JSON.stringify(several).slice(0, 500));
    assert.deepEqual(f.campaignLookups, [['205']]);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a campaign that reads is_search_campaign takes negative keywords without an ad group of Automatic Search Placement', async () => {
  const f = fixture();
  try {
    const p = await f.add({object_type: 'CAMPAIGN', object_ids: ['205'], keywords: [{name: 'free jobs'}]});
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    assert.equal(campaignReads(f), 1, 'the campaign read a campaign review always makes, and nothing more');
    assert.equal((await f.execute(p)).success, true);
    assert.deepEqual(
      f.lists.get('CAMPAIGN:205').map(k => k.name),
      ['jobs', 'free jobs'],
    );
    assert.equal((await f.verify(p)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('deleting and renaming keywords of a Search Ads ad group still need spending confirmation, and verify', async () => {
  const f = fixture();
  try {
    const d = await f.remove({object_type: 'ADGROUP', object_id: '305', keyword_ids: ['8100']});
    assert.equal(d.success, true, JSON.stringify(d).slice(0, 500));
    assert.equal(d.data.creative_impact.may_affect_serving, true);
    assertRefused(await f.execute(d), 'SPEND_CONFIRMATION_REQUIRED', {writes: f.writes});
    assert.equal((await f.execute(d, {spend_change_confirmed: true})).success, true);
    assert.equal((await f.verify(d)).data.status, 'verified');
    assert.deepEqual(f.lists.get('ADGROUP:305'), []);
  } finally {
    f.store.close();
  }
});

test('the ad groups and campaigns that are not manual Search Ads are still refused, with nothing written', async () => {
  const f = fixture();
  try {
    for (const [label, run, code, message] of [
      [
        'an ad group of a campaign that is no Search campaign',
        () => f.add({object_type: 'ADGROUP', object_ids: ['302'], keywords: [{name: 'x'}]}),
        'INVALID_TIKTOK_NEGATIVE_KEYWORD',
        /Automatic Search Placement/,
      ],
      [
        'a feed ad group',
        () => f.add({object_type: 'ADGROUP', object_ids: ['304'], keywords: [{name: 'x'}]}),
        'INVALID_TIKTOK_NEGATIVE_KEYWORD',
        /not in a manual Search Ads campaign/,
      ],
      [
        'one Search Ads ad group among others that are not',
        () => f.add({object_type: 'ADGROUP', object_ids: ['305', '304'], keywords: [{name: 'x'}]}),
        'INVALID_TIKTOK_NEGATIVE_KEYWORD',
        /not in a manual Search Ads campaign/,
      ],
      [
        'a campaign with no Search flag and no Search placement',
        () => f.add({object_type: 'CAMPAIGN', object_ids: ['203'], keywords: [{name: 'x'}]}),
        'INVALID_TIKTOK_NEGATIVE_KEYWORD',
        /no ad group with Automatic Search Placement/,
      ],
      [
        'an ad group of an Upgraded Smart+ Search campaign, whose negative keywords are account level',
        () => f.add({object_type: 'ADGROUP', object_ids: ['307'], keywords: [{name: 'x'}]}),
        'INVALID_TIKTOK_NEGATIVE_KEYWORD',
        /Smart\+ Search.*account level/,
      ],
      [
        'an Upgraded Smart+ Search campaign',
        () => f.add({object_type: 'CAMPAIGN', object_ids: ['207'], keywords: [{name: 'x'}]}),
        'INVALID_TIKTOK_NEGATIVE_KEYWORD',
        /Smart\+ Search.*account level/,
      ],
      [
        'an ad group whose campaign TikTok does not return',
        () => f.add({object_type: 'ADGROUP', object_ids: ['308'], keywords: [{name: 'x'}]}),
        'STATE_NOT_FOUND',
        /must exist/,
      ],
    ]) {
      const r = await run();
      assertRefused(r, code, {writes: f.writes, message});
      assert.ok(r.error.message, label);
    }
  } finally {
    f.store.close();
  }
});

// The refusals of the gate for a Search Ads object that is not read as a manual Search Ads campaign (R2.5 M4, package r25-m4-search, the
// lead's review S3-1): [what it is, object type, the IDs asked for, the ID refused, its campaign (an ad group's), the sentence, the
// automation type TikTok returned when it is a plain enum].
const adGroupSentence = /not in a manual Search Ads campaign/,
  campaignSentence = /not a manual Search Ads campaign/,
  smartSentence = /Smart\+ Search.*account level/;
const gateRefusals = [
  ['an ad group of a Search campaign with no automation type', 'ADGROUP', ['309'], '309', '209', adGroupSentence],
  ['a Search campaign with no automation type', 'CAMPAIGN', ['209'], '209', undefined, campaignSentence],
  ['an ad group of a legacy Smart+ Search campaign', 'ADGROUP', ['311'], '311', '211', smartSentence, 'SMART_PLUS'],
  ['a legacy Smart+ Search campaign', 'CAMPAIGN', ['211'], '211', undefined, smartSentence, 'SMART_PLUS'],
  [
    'an ad group of an Upgraded Smart+ Search campaign',
    'ADGROUP',
    ['307'],
    '307',
    '207',
    smartSentence,
    'UPGRADED_SMART_PLUS',
  ],
  ['an Upgraded Smart+ Search campaign', 'CAMPAIGN', ['207'], '207', undefined, smartSentence, 'UPGRADED_SMART_PLUS'],
  [
    'an ad group of a Search campaign with a type no page lists',
    'ADGROUP',
    ['313'],
    '313',
    '213',
    adGroupSentence,
    'SYNTHETIC_NEW_TYPE',
  ],
  [
    'a Search campaign with a type no page lists',
    'CAMPAIGN',
    ['213'],
    '213',
    undefined,
    campaignSentence,
    'SYNTHETIC_NEW_TYPE',
  ],
  ['an ad group of a Search campaign whose type is free text', 'ADGROUP', ['315'], '315', '215', adGroupSentence],
  ['a Search campaign whose type is free text', 'CAMPAIGN', ['215'], '215', undefined, campaignSentence],
  ['the one ad group that is not Search Ads among others', 'ADGROUP', ['305', '304'], '304', '203', adGroupSentence],
];

test('a Search campaign row that does not read MANUAL is refused, whatever else it says, with nothing written', async () => {
  const f = fixture();
  try {
    for (const [label, objectType, ids, , , message] of gateRefusals) {
      const r = await f.add({object_type: objectType, object_ids: ids, keywords: [{name: 'x'}]});
      assertRefused(r, 'INVALID_TIKTOK_NEGATIVE_KEYWORD', {writes: f.writes, message});
      assert.ok(r.error.message, label);
    }
    assert.equal(f.writes(), 0);
    // The row that does read MANUAL, with is_search_campaign, still passes (the tests above).
    const accepted = await f.add({object_type: 'ADGROUP', object_ids: ['305'], keywords: [{name: 'x'}]});
    assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 500));
  } finally {
    f.store.close();
  }
});

test('a refusal of the gate is one of four fixed sentences with Arabic, and nothing TikTok returned is in the message', async () => {
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    arabic = /[؀-ۿ]/u,
    sentences = new Set(),
    f = fixture();
  try {
    for (const [label, objectType, ids, failing, parent, message, type] of gateRefusals) {
      const r = await f.add({object_type: objectType, object_ids: ids, keywords: [{name: 'x'}]});
      assertRefused(r, 'INVALID_TIKTOK_NEGATIVE_KEYWORD', {writes: f.writes, message});
      // The ID of the object, its campaign and the type TikTok returned (only when it is a plain enum: letters and underscores) are in
      // the details; none of them, nor any other text of the row, is in the message (the lead's review S3-2).
      for (const text of [failing, parent, type, 'free text', '<b>'].filter(Boolean))
        assert.equal(r.error.message.includes(text), false, label + ': the message holds ' + text);
      assert.equal(r.error.details.object_type, objectType, label);
      assert.equal(r.error.details.object_id, failing, label);
      assert.equal(r.error.details.campaign_id, parent, label);
      assert.equal(r.error.details.campaign_automation_type, type, label);
      assert.match(catalog[r.error.message] ?? '', arabic, 'Arabic for: ' + r.error.message);
      sentences.add(r.error.message);
    }
    assert.equal(sentences.size, 4, [...sentences].join(' | '));
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('the bound of 10,000 negative keywords for an ad group holds on the Search Ads path', async () => {
  // The review's own check on a synthetic state: reading 10,000 keywords through the service is 200 requests, which is no unit test.
  const {tiktokNegativeKeywordReads, tiktokNegativeKeywordFollowUps, validateTiktokNegativeKeywordPrerequisites} =
    await import('../dist/src/tiktok-negative-keywords.js');
  const adgroups = {data: {list: [{adgroup_id: '305', campaign_id: '205', search_result_enabled: false}]}},
    campaigns = {data: {list: [{campaign_id: '205', is_search_campaign: true, campaign_automation_type: 'MANUAL'}]}},
    existing = n => ({
      data: {
        keywords: Array.from({length: n}, (_, i) => ({
          keyword_id: String(i + 1),
          name: 'kw' + i,
          match_type: 'BROAD_WORD',
        })),
      },
    });
  const check = (n, keywords) => {
    const plan = {
        gateway,
        method: 'POST',
        path: '/v1.3/search_ad/negative_keyword/add/',
        query: {},
        accountId: account,
        body: {advertiser_id: account, object_type: 'ADGROUP', object_ids: ['305'], keywords},
      },
      planned = tiktokNegativeKeywordReads(plan),
      [campaignRead] = tiktokNegativeKeywordFollowUps(plan, planned[0], adgroups);
    assert.equal(
      campaignRead.tiktokNegativeKeywordState.kind,
      'campaigns',
      'the campaign read follows the ad group read',
    );
    return validateTiktokNegativeKeywordPrerequisites(
      plan,
      [adgroups, existing(n), campaigns],
      [...planned, campaignRead],
    );
  };
  assert.throws(
    () => check(9999, [{name: 'one more'}, {name: 'and another'}]),
    e => assertRefused(e, 'INVALID_TIKTOK_NEGATIVE_KEYWORD', {message: /more than 10000 negative keywords/}),
  );
  assert.doesNotThrow(() => check(9999, [{name: 'the last one'}]));
  assert.doesNotThrow(() => check(0, [{name: 'first'}]));
});
test('the review status TikTok gives a keyword after the ad group is created is no change of the ad group; a real change still stops execution', async () => {
  const f = fixture();
  try {
    const p = await f.add({object_type: 'ADGROUP', object_ids: ['305'], keywords: [{name: 'fresh'}]});
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 500));
    // TikTok reviews the keyword after the build, between this prepare and its execute.
    f.adgroups['305'].search_keywords[0].audit_status = 'SYNTHETIC_STATE_B';
    const e = await f.execute(p);
    assert.equal(e.success, true, JSON.stringify(e).slice(0, 500));
    // A change of the ad group itself, or of its campaign, between prepare and execute is refused as before.
    for (const change of [
      () => (f.adgroups['305'].adgroup_name = 'Renamed by someone'),
      () => (f.campaigns[205].campaign_name = 'Renamed by someone'),
    ]) {
      const q = await f.add({object_type: 'ADGROUP', object_ids: ['305'], keywords: [{name: 'another ' + f.writes()}]});
      assert.equal(q.success, true, JSON.stringify(q).slice(0, 500));
      change();
      assertRefused(await f.execute(q), 'STATE_CHANGED', {writes: () => f.writes() - 1});
    }
  } finally {
    f.store.close();
  }
});
