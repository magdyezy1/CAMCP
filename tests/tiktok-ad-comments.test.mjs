import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * PRV-06 B: hiding and unhiding comments on an advertiser's ads (POST /v1.3/comment/status/update/, operation HIDDEN or
 * PUBLIC). tiktok_comment_status_update was a blocked write, so brand-safety cleanup had to happen in Ads Manager. The
 * review finds each comment in TikTok's comment list for a caller-supplied comment_scope (one ad, ad group or campaign,
 * at most 31 days), refuses unknown comments and comments that already have the status, keeps no comment text or author,
 * needs no spending confirmation, and verifies each comment's status. A synthetic TikTok API answers; nothing leaves
 * the process.
 */
const TIKTOK = '42424242-4242-4424-8424-424242424242',
  gateway = 'tiktok_native_action',
  account = '123',
  registry = new Registry(),
  actor = {tenantId: 'tiktok-ad-comments', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const today = new Date().toISOString().slice(0, 10),
  daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10),
  scope = {search_field: 'AD_ID', search_value: '9001', start_time: daysAgo(6), end_time: today};
function fixture({mode = '', pageSize} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 63).toString('base64'));
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
  // Third-party content: text and authors must never reach the review.
  const comment = (comment_id, ad_id, status) => ({
    comment_id,
    ad_id,
    adgroup_id: '800',
    campaign_id: '700',
    advertiser_id: account,
    status,
    comment_type: 'COMMENT',
    text: 'Visit spam-site dot example for free coins',
    username: 'private.person',
    user_id: '55501',
    likes: 3,
    create_time: daysAgo(1) + ' 10:00:00',
  });
  const comments = [
    comment('5001', '9001', 'PUBLIC'),
    comment('5002', '9001', 'PUBLIC'),
    comment('5003', '9001', 'HIDDEN'),
    ...Array.from({length: 120}, (_, i) => comment(String(6000 + i), '9001', 'PUBLIC')),
    comment('5009', '9002', 'PUBLIC'),
  ];
  const requests = [],
    sent = [];
  let n = 0;
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const u = new URL(String(raw)),
      path = u.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET',
      q = k => u.searchParams.get(k);
    requests.push(method + ' ' + path + (q('page') ? ' p' + q('page') : ''));
    if (method === 'GET' && path === '/v1.3/comment/list/') {
      assert.equal(q('advertiser_id'), account);
      for (const k of ['search_field', 'search_value', 'start_time', 'end_time']) assert.ok(q(k), k);
      const page = Number(q('page')),
        size = pageSize ?? Number(q('page_size')),
        rows = comments.filter(c => mode === 'leaky' || c[q('search_field').toLowerCase()] === q('search_value')),
        total = Math.max(1, Math.ceil(rows.length / size));
      return ok({
        comments: rows.slice((page - 1) * size, page * size).map(c => structuredClone(c)),
        page_info: {page, page_size: size, total_number: rows.length, total_page: mode === 'endless' ? 99 : total},
      });
    }
    if (method === 'POST' && path === '/v1.3/comment/status/update/') {
      const b = JSON.parse(init.body);
      sent.push(b);
      if (mode === 'error')
        return Response.json({code: 40002, message: 'Synthetic refusal', request_id: 'r' + ++n, data: {}});
      const changed = mode === 'partial' ? b.comment_ids.slice(0, 1) : b.comment_ids;
      if (mode !== 'ignore') for (const c of comments) if (changed.includes(c.comment_id)) c.status = b.operation;
      return ok(mode === 'partial' ? {failed_comment_ids: b.comment_ids.slice(1)} : {});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (payload, extra = {comment_scope: scope}, action = 'tiktok_comment_status_update') =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: account, payload, ...extra}},
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
    comments,
    requests,
    sent,
    prepare,
    execute,
    verify,
    writes: () => sent.length,
    close: () => store.close(),
  };
}
const reviewed = p => {
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 1500));
  return p.data;
};

test('hide: two public comments are hidden after the comment list names them; no text or author is kept; each is verified', async t => {
  const f = fixture();
  t.after(f.close);
  const p = await f.prepare({comment_ids: ['5001', '5002'], operation: 'HIDDEN'}),
    data = reviewed(p),
    impact = data.creative_impact;
  assert.equal(impact.scope, 'ad_comments');
  assert.equal(impact.operation, 'hide');
  assert.equal(impact.status_after, 'HIDDEN');
  assert.equal(impact.ad_type, 'BIDDING', 'TikTok’s default ad type');
  assert.deepEqual(impact.comments, [
    {comment_id: '5001', ad_id: '9001', status_before: 'PUBLIC'},
    {comment_id: '5002', ad_id: '9001', status_before: 'PUBLIC'},
  ]);
  assert.deepEqual(impact.found_in, scope);
  assert.equal(impact.may_affect_serving, false);
  // The list holds 123 comments of the ad: both pages were read.
  assert.deepEqual(
    f.requests.filter(r => r.startsWith('GET')),
    ['GET /v1.3/comment/list/ p1', 'GET /v1.3/comment/list/ p2'],
  );
  for (const secret of ['spam-site', 'private.person', '55501'])
    assert.ok(!JSON.stringify(data).includes(secret), 'the review keeps no ' + secret);
  // No spending confirmation: hiding comments changes no delivery or spend.
  assert.notEqual(data.execute_requirements?.spend_change_confirmed, true);
  const done = await f.execute(p);
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 1500));
  assert.deepEqual(f.sent, [{advertiser_id: account, comment_ids: ['5001', '5002'], operation: 'HIDDEN'}]);
  assert.ok(!('comment_scope' in f.sent[0]) && !('tiktokCommentScope' in f.sent[0]), 'the scope is never sent');
  assert.deepEqual(done.data.comment_receipts ?? done.data.result?.comment_receipts, [
    {comment_id: '5001', receipt: 'accepted'},
    {comment_id: '5002', receipt: 'accepted'},
  ]);
  const v = await f.verify(p);
  assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 1500));
  assert.ok(!JSON.stringify(v).includes('spam-site'));
  assert.equal((await f.execute(p)).data.replayed, true);
  assert.equal(f.writes(), 1);
});

test('unhide: a hidden comment is made public again, also under an owner policy that forbids activation and deletion', async t => {
  const f = fixture();
  t.after(f.close);
  saveSpendPolicy(f.store, owner, {
    gateway,
    account_id: account,
    confirmed: true,
    policy: {allow_activation: false, allow_deletion: false},
  });
  const p = await f.prepare({comment_ids: ['5003'], operation: 'PUBLIC', ad_type: 'BIDDING'});
  assert.equal(reviewed(p).creative_impact.operation, 'unhide');
  assert.equal((await f.execute(p)).success, true);
  assert.equal(f.comments.find(c => c.comment_id === '5003').status, 'PUBLIC');
  assert.equal((await f.verify(p)).data.status, 'verified');
});

test('an unknown comment, or one outside comment_scope, is refused after reading; nothing is sent', async t => {
  const f = fixture();
  t.after(f.close);
  // 5009 is a comment of another ad: not in the scope's list.
  const refused = await f.prepare({comment_ids: ['5001', '7777', '5009'], operation: 'HIDDEN'});
  assertRefused(refused, 'STATE_NOT_FOUND', {writes: f.writes});
  assert.deepEqual(refused.error.details.comment_ids, ['5009', '7777']);
});

test('a comment that already has the status is refused, naming it (regression)', async t => {
  const f = fixture();
  t.after(f.close);
  const refused = await f.prepare({comment_ids: ['5001', '5003'], operation: 'HIDDEN'});
  assertRefused(refused, 'CONFIGURATION_EXISTS', {writes: f.writes});
  assert.deepEqual(refused.error.details, {comment_ids: ['5003'], status: 'HIDDEN'});
});

test('a partial reply is never success and never sent again; the receipts and the read-back name each comment', async t => {
  const f = fixture({mode: 'partial'});
  t.after(f.close);
  const p = await f.prepare({comment_ids: ['5001', '5002'], operation: 'HIDDEN'});
  reviewed(p);
  const first = await f.execute(p);
  assertRefused(first, 'WRITE_PARTIAL_OR_FAILED');
  assert.deepEqual(first.data.comment_receipts, [
    {comment_id: '5001', receipt: 'accepted'},
    {comment_id: '5002', receipt: 'failed'},
  ]);
  assertRefused(await f.execute(p), ['WRITE_PARTIAL_OR_FAILED', 'WRITE_OUTCOME_UNCERTAIN']);
  assert.equal(f.writes(), 1, 'never sent again');
  // Verification never turns a partial outcome into success.
  assertRefused(await f.verify(p), 'WRITE_PARTIAL_OR_FAILED');
  for (const mode of ['error', 'ignore']) {
    const g = fixture({mode});
    t.after(g.close);
    const q = await g.prepare({comment_ids: ['5001'], operation: 'HIDDEN'});
    reviewed(q);
    const out = await g.execute(q);
    if (mode === 'error') assertRefused(out, 'PLATFORM_ERROR');
    else {
      assert.equal(out.success, true);
      assert.notEqual((await g.verify(q)).data.status, 'verified', 'an ignored update is not verified');
    }
    assert.equal(g.writes(), 1);
  }
});

test('a status change between review and execute is STATE_CHANGED; a list without an end or outside the scope is refused', async t => {
  const f = fixture();
  t.after(f.close);
  const p = await f.prepare({comment_ids: ['5001'], operation: 'HIDDEN'});
  reviewed(p);
  f.comments.find(c => c.comment_id === '5001').status = 'HIDDEN';
  const changed = await f.execute(p);
  assertRefused(changed, 'STATE_CHANGED', {writes: f.writes});
  assert.ok(
    changed.error.details.changed_fields.some(path => /status/.test(path)),
    JSON.stringify(changed.error),
  );
  const endless = fixture({mode: 'endless', pageSize: 1});
  t.after(endless.close);
  assertRefused(await endless.prepare({comment_ids: ['5001'], operation: 'HIDDEN'}), 'INCOMPLETE_STATE', {
    writes: endless.writes,
  });
  const leaky = fixture({mode: 'leaky'});
  t.after(leaky.close);
  assertRefused(await leaky.prepare({comment_ids: ['5001'], operation: 'HIDDEN'}), 'INCOMPLETE_STATE', {
    writes: leaky.writes,
  });
});

test('malformed requests and scopes are refused before any request', async t => {
  const f = fixture();
  t.after(f.close);
  const ids = ['5001'];
  const cases = [
    ['no comment_scope', {comment_ids: ids, operation: 'HIDDEN'}, {}],
    [
      'a window over 31 days',
      {comment_ids: ids, operation: 'HIDDEN'},
      {comment_scope: {...scope, start_time: daysAgo(40)}},
    ],
    [
      'an end before the start',
      {comment_ids: ids, operation: 'HIDDEN'},
      {comment_scope: {...scope, end_time: daysAgo(9)}},
    ],
    ['a future end', {comment_ids: ids, operation: 'HIDDEN'}, {comment_scope: {...scope, end_time: '2099-01-01'}}],
    [
      'a date with a time',
      {comment_ids: ids, operation: 'HIDDEN'},
      {comment_scope: {...scope, end_time: today + ' 00:00:00'}},
    ],
    [
      'an undocumented search field',
      {comment_ids: ids, operation: 'HIDDEN'},
      {comment_scope: {...scope, search_field: 'TEXT'}},
    ],
    [
      'a search value that is not an ID',
      {comment_ids: ids, operation: 'HIDDEN'},
      {comment_scope: {...scope, search_value: 'spam'}},
    ],
    ['an extra scope key', {comment_ids: ids, operation: 'HIDDEN'}, {comment_scope: {...scope, comment_type: 'ALL'}}],
    ['no comments', {comment_ids: [], operation: 'HIDDEN'}],
    ['a comment twice', {comment_ids: ['5001', '5001'], operation: 'HIDDEN'}],
    [
      'more than 100 comments',
      {comment_ids: Array.from({length: 101}, (_, i) => String(6000 + i)), operation: 'HIDDEN'},
    ],
    ['a comment ID that is not digits', {comment_ids: ['abc'], operation: 'HIDDEN'}],
    ['an undocumented operation', {comment_ids: ids, operation: 'DELETE'}],
    ['an undocumented ad type', {comment_ids: ids, operation: 'HIDDEN', ad_type: 'SEARCH'}],
    ['an extra field', {comment_ids: ids, operation: 'HIDDEN', text: 'reply'}],
  ];
  for (const [label, payload, extra] of cases) {
    const refused = await f.prepare(payload, extra);
    assert.equal(refused.error?.code, 'INVALID_TIKTOK_COMMENT', label + ': ' + JSON.stringify(refused).slice(0, 400));
    assertRefused(refused, 'INVALID_TIKTOK_COMMENT', {writes: f.writes});
  }
  // comment_scope belongs to the comment status update only.
  assertRefused(
    await f.prepare({blocked_words: ['spam']}, {comment_scope: scope}, 'tiktok_blockedword_create'),
    'UNSUPPORTED_PARAMETER',
    {writes: f.writes},
  );
  assert.deepEqual(f.requests, [], 'nothing was read or sent');
});

test('the ledger reviews the comment status update and keeps replies and deletion blocked', () => {
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && /^tiktok_comment_/.test(r.action)),
    of = action => rows.find(r => r.action === action);
  assert.equal(of('tiktok_comment_status_update').status, 'reviewed_write_family');
  assert.equal(of('tiktok_comment_status_update').family, 'tiktok_ad_comments');
  assert.deepEqual(of('tiktok_comment_status_update').tests, ['tests/tiktok-ad-comments.test.mjs']);
  for (const action of ['tiktok_comment_post_create', 'tiktok_comment_delete']) {
    assert.equal(of(action).status, 'blocked_write', action);
    assert.match(of(action).reason, /hide|unhide|status/i, action);
  }
  assert.equal(of('tiktok_comment_list_get').status, 'native_read');
});
