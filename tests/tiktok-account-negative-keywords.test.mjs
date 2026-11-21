import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {familyOf, reviewedFamilies} from '../dist/src/reviewed-families.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * R2.5 M4, package r25-m4-search2, item 4 (S3-4, the lead's review of 27528f0e): the account-level negative keywords of TikTok's Search Ads,
 * `object_type: ADVERTISER`, which TikTok's pages document on all five routes (impl/r25-m4-search2-DOCS.md, section 2, P8 to P12). The routes and
 * the family are the campaign and ad group negative keywords' (tests/tiktok-negative-keywords.test.mjs): one family claims each body, and the
 * account level is another module of it (src/tiktok-account-negative-keywords.ts). TikTok's Search pages say that "account-level negative keywords
 * will be applied" to a Smart+ Search campaign. A synthetic advertiser answers; nothing reaches TikTok.
 */
const TIKTOK = '32323232-3232-4323-8323-323232323232',
  gateway = 'tiktok_native_action',
  account = '7001',
  other = '7002';
const actor = {tenantId: 'tiktok-account-negative-keywords', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 92).toString('base64');

/** A synthetic advertiser with an account-level list of 60 keywords (two pages of 50), and a campaign and an ad group with lists of their own. */
function fixture() {
  const store = new Store(':memory:', key);
  store.putConnection(
    owner,
    {
      id: TIKTOK,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const lists = new Map([
    [
      'ADVERTISER:' + account,
      [
        {keyword_id: '5000', name: 'free', match_type: 'BROAD_WORD'},
        {keyword_id: '5001', name: 'cheap', match_type: 'PHRASE_WORD'},
        ...Array.from({length: 58}, (_, i) => ({
          keyword_id: String(5100 + i),
          name: 'kw' + i,
          match_type: 'BROAD_WORD',
        })),
      ],
    ],
    ['ADGROUP:301', [{keyword_id: '9000', name: 'adgroup term', match_type: 'BROAD_WORD'}]],
  ]);
  let next = 20000,
    writes = 0,
    mode = '',
    n = 0;
  const requests = [],
    bodies = [];
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const u = new URL(String(raw)),
      path = u.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET',
      q = k => u.searchParams.get(k);
    requests.push(method + ' ' + path + (q('page') ? ' p' + q('page') + ' ' + q('object_type') : ''));
    if (path === '/v1.3/advertiser/info/')
      return ok({
        list: [
          {
            advertiser_id: account,
            name: 'Synthetic advertiser',
            status: 'STATUS_ENABLE',
            currency: 'USD',
            timezone: 'Etc/GMT',
            country: 'US',
            balance: 12,
          },
        ],
      });
    if (path === '/v1.3/search_ad/negative_keyword/get/') {
      const list = lists.get(q('object_type') + ':' + q('object_id')) ?? [],
        page = Number(q('page')),
        size = Number(q('page_size'));
      const total = mode === 'huge' ? 201 : Math.max(1, Math.ceil(list.length / size));
      return ok({
        keywords: structuredClone(list.slice((page - 1) * size, page * size)),
        page_info: {page, page_size: size, total_number: list.length, total_page: total},
      });
    }
    const b = JSON.parse(init.body);
    writes++;
    bodies.push({path, body: b});
    if (mode === 'refuse')
      return Response.json({code: 40002, message: 'Synthetic refusal', request_id: 'r' + ++n, data: {}});
    const k = b.object_type + ':' + (b.object_id ?? b.object_ids?.[0]);
    if (path === '/v1.3/search_ad/negative_keyword/add/') {
      const current = lists.get(k) ?? [];
      for (const w of b.keywords)
        if (!current.some(c => c.name.toLowerCase() === w.name.toLowerCase()))
          current.push({keyword_id: String(next++), name: w.name, match_type: w.match_type ?? 'BROAD_WORD'});
      lists.set(k, current);
      return ok({});
    }
    if (path === '/v1.3/search_ad/negative_keyword/update/') {
      const old = lists.get(k).find(w => w.keyword_id === b.old_keyword_id),
        renamed = old.name !== b.keyword.name,
        id = renamed ? String(next++) : old.keyword_id;
      Object.assign(old, {keyword_id: id, name: b.keyword.name, match_type: b.keyword.match_type ?? 'BROAD_WORD'});
      return ok({new_keyword_id: id});
    }
    if (path === '/v1.3/search_ad/negative_keyword/delete/') {
      // R2.5 field3, package r25-field3-livefix, item 1. TikTok's page "Delete negative keywords" (read 2026-11-21): `keyword_info_to_delete` pairs an
      // ID with its match type "to ensure more accurate deletion of negative keyword and match type pairs", and the answer's `deleted_keyword_ids`
      // lists "the IDs of successfully deleted negative keywords". Without the pairs this fake matches every ID as BROAD_WORD (UNVERIFIED default:
      // the live check LV-31 sent the ID of a PRECISE_WORD keyword alone and was answered code 0 with an empty list). Modes: `ignores` deletes
      // nothing and answers an empty list (the live answer), `partial` deletes the first pair only.
      const pairs = b.keyword_info_to_delete ?? b.keyword_ids.map(id => ({keyword_id: id, match_type: 'BROAD_WORD'})),
        current = lists.get(k) ?? [],
        matched = current.filter(w => pairs.some(p => p.keyword_id === w.keyword_id && p.match_type === w.match_type)),
        gone = mode === 'ignores' ? [] : mode === 'partial' ? matched.slice(0, 1) : matched;
      lists.set(
        k,
        current.filter(w => !gone.includes(w)),
      );
      return ok({deleted_keyword_ids: gone.map(w => w.keyword_id)});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const prepare = (action, payload, account_id = account) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, connection_id: TIKTOK, arguments: {action, account_id, payload}},
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
  return {
    store,
    lists,
    requests,
    bodies,
    add: payload => prepare('tiktok_search_ad_negative_keyword_add', payload),
    update: payload => prepare('tiktok_search_ad_negative_keyword_update', payload),
    remove: payload => prepare('tiktok_search_ad_negative_keyword_delete', payload),
    execute,
    verify: p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor),
    writes: () => writes,
    mode: m => {
      mode = m;
    },
    list: () => lists.get('ADVERTISER:' + account),
  };
}
const level = {object_type: 'ADVERTISER'};
const addBody = (extra = {}) => ({
  ...level,
  object_ids: [account],
  keywords: [{name: 'jobs', match_type: 'PHRASE_WORD'}, {name: 'diy'}],
  ...extra,
});

test('adding account-level exclusions reads the advertiser and every page of the account list, needs no spending confirmation, writes once as reviewed and verifies', async () => {
  const f = fixture();
  try {
    const p = await f.add(addBody());
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 900));
    assert.ok(
      f.requests.includes('GET /v1.3/advertiser/info/'),
      'the advertiser row proves the scope: ' + f.requests.join(' | '),
    );
    assert.deepEqual(
      f.requests.filter(r => r.includes('negative_keyword/get')),
      [
        'GET /v1.3/search_ad/negative_keyword/get/ p1 ADVERTISER',
        'GET /v1.3/search_ad/negative_keyword/get/ p2 ADVERTISER',
      ],
      'the complete list is read: both pages',
    );
    const impact = p.data.creative_impact;
    assert.equal(impact.scope, 'search_negative_keywords');
    assert.equal(impact.object_type, 'ADVERTISER');
    assert.deepEqual(impact.objects, [{id: account, name: 'Synthetic advertiser', operation_status: 'STATUS_ENABLE'}]);
    assert.equal(impact.may_affect_serving, false, 'exclusions only narrow delivery');
    assert.deepEqual(impact.changes.add, [
      {name: 'jobs', match_type: 'PHRASE_WORD'},
      {name: 'diy', match_type: 'BROAD_WORD'},
    ]);
    assert.deepEqual(impact.keywords_before, [{object_id: account, count: 60}]);
    // What the level means: every Search Ads campaign of the advertiser, not one campaign or ad group.
    assert.match(impact.applies_to, /every Search Ads campaign of this advertiser/);
    assert.match(impact.applies_to, /Smart\+ Search/);
    assert.equal(p.data.execute_requirements.spend_change_confirmed, false);
    const done = await f.execute(p);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 900));
    assert.equal(f.writes(), 1);
    assert.deepEqual(f.bodies[0].body, {advertiser_id: account, ...addBody()}, 'sent as it was reviewed');
    assert.equal(f.list().length, 62);
    const verified = await f.verify(p);
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 900));
    assert.equal((await f.execute(p)).data?.replayed, true);
    assert.equal(f.writes(), 1, 'a replay sends nothing');
  } finally {
    f.store.close();
  }
});

test('renaming an account-level exclusion changes what the Search campaigns of the account can show on, so it needs the spend flag, and verifies with the new keyword ID the answer carries', async () => {
  const f = fixture();
  try {
    const p = await f.update({
      ...level,
      object_id: account,
      old_keyword_id: '5000',
      keyword: {name: 'free stuff', match_type: 'PHRASE_WORD'},
    });
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 900));
    assert.equal(p.data.creative_impact.may_affect_serving, true, 'a renamed exclusion can widen delivery');
    assert.deepEqual(p.data.creative_impact.changes.update, {
      keyword_id: '5000',
      name: 'free stuff',
      match_type: 'PHRASE_WORD',
    });
    assert.equal(p.data.execute_requirements.spend_change_confirmed, true);
    const before = f.writes();
    assertRefused(await f.execute(p), 'SPEND_CONFIRMATION_REQUIRED', {writes: () => f.writes() - before});
    const done = await f.execute(p, {spend_change_confirmed: true});
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 900));
    assert.ok(f.list().some(w => w.name === 'free stuff' && w.match_type === 'PHRASE_WORD'));
    assert.equal((await f.verify(p)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('removing account-level exclusions names each one, needs the spend flag, and is a deletion under the owner’s policy', async () => {
  const f = fixture();
  try {
    const p = await f.remove({...level, object_id: account, keyword_ids: ['5000', '5001']});
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 900));
    assert.deepEqual(p.data.creative_impact.changes.remove, [
      {keyword_id: '5000', name: 'free', match_type: 'BROAD_WORD'},
      {keyword_id: '5001', name: 'cheap', match_type: 'PHRASE_WORD'},
    ]);
    assert.equal(p.data.creative_impact.may_affect_serving, true);
    assert.equal(p.data.execute_requirements.spend_change_confirmed, true);
    const done = await f.execute(p, {spend_change_confirmed: true});
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 900));
    assert.equal(f.list().length, 58);
    assert.equal((await f.verify(p)).data.status, 'verified');
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    saveSpendPolicy(g.store, owner, {scope: 'workspace', confirmed: true, policy: {allow_deletion: false}});
    const refused = await g.remove({...level, object_id: account, keyword_ids: ['5000']});
    assertRefused(refused, 'POLICY_DELETION_FORBIDDEN', {writes: g.writes});
    // Adding is no deletion and is not refused by it.
    assert.equal((await g.add(addBody())).success, true);
  } finally {
    g.store.close();
  }
});

test('the scope is exactly the selected advertiser: another ID, two IDs, a non-string and another advertiser_id are each refused before any request', async () => {
  const f = fixture();
  try {
    const refused = [
      ['another advertiser in object_ids', f.add(addBody({object_ids: [other]}))],
      ['the advertiser and another', f.add(addBody({object_ids: [account, other]}))],
      ['the advertiser twice', f.add(addBody({object_ids: [account, account]}))],
      ['no object_ids', f.add(addBody({object_ids: []}))],
      ['a number in object_ids', f.add(addBody({object_ids: [7001]}))],
      ['a campaign ID where the advertiser belongs', f.add(addBody({object_ids: ['201']}))],
      ['another advertiser_id in the body', f.add(addBody({advertiser_id: other}))],
      [
        'another object_id on an update',
        f.update({...level, object_id: other, old_keyword_id: '5000', keyword: {name: 'x', match_type: 'BROAD_WORD'}}),
      ],
      ['another object_id on a delete', f.remove({...level, object_id: other, keyword_ids: ['5000']})],
      ['a number as object_id', f.remove({...level, object_id: 7001, keyword_ids: ['5000']})],
    ];
    for (const [name, pending] of refused) {
      const r = await pending;
      assertRefused(r, 'ACCOUNT_SCOPE_MISMATCH', {writes: f.writes});
      assert.ok(r.error.message.length > 20, name);
    }
    assert.equal(f.requests.length, 0, 'every one is refused before any request: ' + f.requests.join(' | '));
  } finally {
    f.store.close();
  }
});

test('replace is refused at the account level, whose page names it for a campaign or an ad group only; so are the other shapes TikTok’s pages do not give it', async () => {
  const f = fixture();
  try {
    const replace = await f.add(addBody({replace: true}));
    assertRefused(replace, 'INVALID_TIKTOK_NEGATIVE_KEYWORD', {writes: f.writes});
    assert.match(replace.error.message, /replace/);
    assert.match(replace.error.message, /delete/);
    for (const [name, p] of [
      ['replace as text', f.add(addBody({replace: 'false'}))],
      ['an unknown key', f.add(addBody({keyword_info_to_delete: []}))],
      ['no keywords', f.add(addBody({keywords: []}))],
      ['1,001 keywords', f.add(addBody({keywords: Array.from({length: 1001}, (_, i) => ({name: 'term' + i}))}))],
      ['a name over 80 characters', f.add(addBody({keywords: [{name: 'x'.repeat(81)}]}))],
      ['a forbidden character', f.add(addBody({keywords: [{name: '50% off'}]}))],
      ['a name twice', f.add(addBody({keywords: [{name: 'Deal'}, {name: 'deal', match_type: 'PHRASE_WORD'}]}))],
      ['an unknown match type', f.add(addBody({keywords: [{name: 'deal', match_type: 'EXACT'}]}))],
      ['a surrounding space', f.add(addBody({keywords: [{name: ' deal'}]}))],
      [
        'no match type in an update',
        f.update({...level, object_id: account, old_keyword_id: '5000', keyword: {name: 'deal'}}),
      ],
      [
        'no old keyword in an update',
        f.update({...level, object_id: account, keyword: {name: 'deal', match_type: 'BROAD_WORD'}}),
      ],
      ['no keyword IDs in a delete', f.remove({...level, object_id: account, keyword_ids: []})],
      [
        '1,001 keyword IDs in a delete',
        f.remove({...level, object_id: account, keyword_ids: Array.from({length: 1001}, (_, i) => String(1 + i))}),
      ],
      ['a keyword ID twice in a delete', f.remove({...level, object_id: account, keyword_ids: ['5000', '5000']})],
      ['an object type of another case', f.add(addBody({object_type: 'advertiser'}))],
      ['an unknown object type', f.add(addBody({object_type: 'ACCOUNT'}))],
    ]) {
      const r = await p;
      assertRefused(r, 'INVALID_TIKTOK_NEGATIVE_KEYWORD', {writes: f.writes});
      assert.ok(r.error.message.length > 10, name);
    }
    assert.equal(f.requests.length, 0, 'every one is refused before any request: ' + f.requests.join(' | '));
    // The unknown object type is told the three that exist.
    assert.match((await f.add(addBody({object_type: 'ACCOUNT'}))).error.message, /CAMPAIGN, ADGROUP or ADVERTISER/);
  } finally {
    f.store.close();
  }
});

test('the limits of TikTok’s pages hold at their edge: 1,000 keywords and 1,000 keyword IDs are accepted, and 80 characters', async () => {
  const f = fixture();
  try {
    const many = Array.from({length: 1000}, (_, i) => ({name: 'term' + i}));
    const added = await f.add(addBody({keywords: many}));
    assert.equal(added.success, true, JSON.stringify(added).slice(0, 700));
    assert.equal(added.data.creative_impact.changes.add.length, 1000);
    const wide = await f.add(addBody({keywords: [{name: 'x'.repeat(80)}]}));
    assert.equal(wide.success, true, JSON.stringify(wide).slice(0, 700));
    // 1,000 distinct IDs the list does not hold are refused as unknown, not as too many: the limit is the request's.
    const ids = Array.from({length: 1000}, (_, i) => String(70000 + i));
    const unknown = await f.remove({...level, object_id: account, keyword_ids: ids});
    assertRefused(unknown, 'STATE_NOT_FOUND', {writes: f.writes});
  } finally {
    f.store.close();
  }
});

test('an exclusion the account already holds, an unknown ID and an update that changes nothing are refused from the list that was read', async () => {
  const f = fixture();
  try {
    assertRefused(await f.add(addBody({keywords: [{name: 'FREE'}]})), 'CONFIGURATION_EXISTS', {writes: f.writes});
    assertRefused(await f.remove({...level, object_id: account, keyword_ids: ['4242']}), 'STATE_NOT_FOUND', {
      writes: f.writes,
    });
    assertRefused(
      await f.update({
        ...level,
        object_id: account,
        old_keyword_id: '4242',
        keyword: {name: 'x', match_type: 'BROAD_WORD'},
      }),
      'STATE_NOT_FOUND',
      {writes: f.writes},
    );
    assertRefused(
      await f.update({
        ...level,
        object_id: account,
        old_keyword_id: '5000',
        keyword: {name: 'free', match_type: 'BROAD_WORD'},
      }),
      'INVALID_TIKTOK_NEGATIVE_KEYWORD',
      {writes: f.writes},
    );
    assertRefused(
      await f.update({
        ...level,
        object_id: account,
        old_keyword_id: '5000',
        keyword: {name: 'cheap', match_type: 'BROAD_WORD'},
      }),
      'CONFIGURATION_EXISTS',
      {writes: f.writes},
    );
  } finally {
    f.store.close();
  }
});

test('a list longer than a review reads is refused as too large, a list changed between review and execution is STATE_CHANGED, and a refusal TikTok declares is recorded rejected', async () => {
  const f = fixture();
  try {
    f.mode('huge');
    assertRefused(await f.add(addBody()), 'STATE_TOO_LARGE', {writes: f.writes});
    f.mode('');
    const p = await f.add(addBody());
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    f.list().push({keyword_id: '7777', name: 'added elsewhere', match_type: 'BROAD_WORD'});
    const before = f.writes();
    assertRefused(await f.execute(p), 'STATE_CHANGED', {writes: () => f.writes() - before});
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    const p = await g.add(addBody());
    g.mode('refuse');
    const refused = await g.execute(p);
    // TikTok's own refusal (a parameter code in an HTTP 200 answer) applied nothing: the review is rejected, and the list is as it was.
    assertRefused(refused, 'PLATFORM_ERROR');
    assert.equal(refused.error.details?.submission, 'rejected', JSON.stringify(refused.error).slice(0, 500));
    assert.equal(g.list().length, 60, 'nothing was added');
  } finally {
    g.store.close();
  }
});

test('one family claims each body: the account level and the other two levels are the same family, and no other family claims any of the three', () => {
  const plan = (path, body) => ({
    gateway,
    action: 'tiktok_search_ad_negative_keyword',
    method: 'POST',
    path,
    query: {},
    body,
    headers: {},
    readOnly: false,
    destructive: false,
    requiresConfirmation: false,
    accountId: account,
    evidence: '',
    warnings: [],
  });
  for (const level of ['ADVERTISER', 'CAMPAIGN', 'ADGROUP', undefined])
    for (const route of ['add', 'update', 'delete']) {
      const p = plan('/v1.3/search_ad/negative_keyword/' + route + '/', {advertiser_id: account, object_type: level});
      const claiming = reviewedFamilies().filter(f => f.kind(p));
      assert.deepEqual(
        claiming.map(f => f.name),
        ['tiktok_negative_keywords'],
        route + ' ' + level,
      );
      assert.equal(familyOf(p).name, 'tiktok_negative_keywords');
    }
});

// R2.5 field3, package r25-field3-livefix, item 1 (the live check LV-31 of 2026-11-21, rebuilt with synthetic IDs): an account-level delete of a
// PRECISE_WORD keyword was answered code 0 with `deleted_keyword_ids: []`, the keyword stayed, and AMCP's receipt said `succeeded`. TikTok's page
// documents `keyword_info_to_delete` ([{keyword_id, match_type}]) for exactly this, and `deleted_keyword_ids` as the IDs it deleted.
const exact = {keyword_id: '5200', name: 'exact term', match_type: 'PRECISE_WORD'};
const phrase = {keyword_id: '5201', name: 'phrase term', match_type: 'PHRASE_WORD'};

test('removing exclusions of every match type sends each ID with the match type the review read, so TikTok deletes them, and the answer lists them all', async () => {
  const f = fixture();
  try {
    f.list().push({...exact}, {...phrase});
    const p = await f.remove({...level, object_id: account, keyword_ids: ['5200', '5201', '5000']});
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 900));
    // The review shows the request that will be sent, with the pairs built from its own read of the list.
    const pairs = [
      {keyword_id: '5200', match_type: 'PRECISE_WORD'},
      {keyword_id: '5201', match_type: 'PHRASE_WORD'},
      {keyword_id: '5000', match_type: 'BROAD_WORD'},
    ];
    assert.deepEqual(p.data.request.body.keyword_info_to_delete, pairs);
    const done = await f.execute(p, {spend_change_confirmed: true});
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 900));
    assert.equal(done.data.outcome, 'succeeded');
    assert.deepEqual(f.bodies[0].body.keyword_info_to_delete, pairs, 'sent as it was reviewed');
    assert.deepEqual(f.bodies[0].body.keyword_ids, ['5200', '5201', '5000']);
    assert.ok(
      !f.list().some(w => ['5200', '5201', '5000'].includes(w.keyword_id)),
      'TikTok deleted all three: none is left on the list',
    );
    assert.equal((await f.verify(p)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('an answer that lists none of the IDs is not a success: it says they are still on the list, names them, and queues no verification', async () => {
  const f = fixture();
  try {
    f.list().push({...exact});
    const p = await f.remove({...level, object_id: account, keyword_ids: ['5200']});
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 900));
    f.mode('ignores');
    const done = await f.execute(p, {spend_change_confirmed: true});
    // TikTok answered code 0 and deleted nothing (the live answer): the receipt must not say the change succeeded.
    assert.equal(done.success, false, JSON.stringify(done).slice(0, 900));
    assertRefused(done, 'WRITE_PARTIAL_OR_FAILED');
    assert.notEqual(done.data?.outcome, 'succeeded');
    assert.equal(done.data.outcome, 'partial_or_failed');
    assert.deepEqual(done.data.not_deleted_keyword_ids, ['5200']);
    assert.deepEqual(done.data.deleted_keyword_ids, []);
    assert.equal(done.data.verification, undefined, 'a failed outcome queues no verification');
    assert.ok(
      f.list().some(w => w.keyword_id === '5200'),
      'the keyword is still on the list',
    );
  } finally {
    f.store.close();
  }
});

test('an answer that lists only some of the IDs names the rest as not deleted', async () => {
  const f = fixture();
  try {
    f.list().push({...exact}, {...phrase});
    const p = await f.remove({...level, object_id: account, keyword_ids: ['5200', '5201']});
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 900));
    f.mode('partial');
    const done = await f.execute(p, {spend_change_confirmed: true});
    assertRefused(done, 'WRITE_PARTIAL_OR_FAILED');
    assert.equal(done.data.outcome, 'partial_or_failed');
    assert.deepEqual(done.data.deleted_keyword_ids, ['5200']);
    assert.deepEqual(done.data.not_deleted_keyword_ids, ['5201']);
  } finally {
    f.store.close();
  }
});

test('a caller may give keyword_info_to_delete: it must name the same IDs and the match types the list holds, or the request is refused before anything is sent', async () => {
  const f = fixture();
  try {
    f.list().push({...exact}, {...phrase});
    const given = [
      {keyword_id: '5200', match_type: 'PRECISE_WORD'},
      {keyword_id: '5201', match_type: 'PHRASE_WORD'},
    ];
    const p = await f.remove({
      ...level,
      object_id: account,
      keyword_ids: ['5200', '5201'],
      keyword_info_to_delete: given,
    });
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 900));
    assert.deepEqual(p.data.request.body.keyword_info_to_delete, given);
    // The refusals: a match type the list does not hold, other IDs than keyword_ids, a repeated ID, a malformed entry, a stray key.
    for (const [name, info] of [
      ['a match type the list does not hold', [{...given[0], match_type: 'BROAD_WORD'}, given[1]]],
      ['an ID missing from the pairs', [given[0]]],
      ['an ID that is not in keyword_ids', [given[0], {keyword_id: '5000', match_type: 'BROAD_WORD'}]],
      ['an ID twice', [given[0], given[0]]],
      ['an unknown match type', [{...given[0], match_type: 'EXACT'}, given[1]]],
      ['a stray key in an entry', [{...given[0], name: 'exact term'}, given[1]]],
      ['no list', []],
      ['a list that is no list', 'PRECISE_WORD'],
    ]) {
      const refused = await f.remove({
        ...level,
        object_id: account,
        keyword_ids: ['5200', '5201'],
        keyword_info_to_delete: info,
      });
      assertRefused(refused, 'INVALID_TIKTOK_NEGATIVE_KEYWORD', {writes: f.writes});
      assert.ok(refused.error.message.length > 10, name);
    }
    assert.equal(f.writes(), 0, 'every one is refused before any write');
    assert.equal((await f.execute(p, {spend_change_confirmed: true})).success, true);
    assert.deepEqual(f.bodies[0].body.keyword_info_to_delete, given);
  } finally {
    f.store.close();
  }
});

test('a refusal TikTok declares for a delete stays a refusal, recorded rejected, and the list is as it was', async () => {
  const f = fixture();
  try {
    f.list().push({...exact});
    const p = await f.remove({...level, object_id: account, keyword_ids: ['5200']});
    f.mode('refuse');
    const refused = await f.execute(p, {spend_change_confirmed: true});
    assertRefused(refused, 'PLATFORM_ERROR');
    assert.equal(refused.error.details?.submission, 'rejected', JSON.stringify(refused.error).slice(0, 500));
    assert.ok(f.list().some(w => w.keyword_id === '5200'));
  } finally {
    f.store.close();
  }
});
