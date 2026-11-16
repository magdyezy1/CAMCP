// Package r25-m2-refusal, item 2 (Q16, owner 2026-11-15; L1-09; acceptance 6 of milestone M2): a TikTok create carries a
// provider-side deduplication key, frozen when the review is prepared. TikTok's `request_id` is documented as the key that makes a
// create idempotent at TikTok (the pinned catalog lists it for the standard campaign and ad group creates, and the Smart+ creates
// require it); the standard creates sent none, so a create that was sent twice would have been two creates.
//
// The review derives the value from its own ID when the request is prepared, in the form TikTok's Smart+ contract documents (a
// positive 64-bit integer as a string), and keeps it in the frozen request: the fingerprint covers it, and execute sends exactly
// that value, never a new one. The ad create takes no `request_id` (the pinned catalog does not list it for /ad/create/), and a
// value the caller supplied is frozen as it is. The answers below are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {advertiserWorld, answer} from './helpers/tiktok-advertiser-noise.mjs';
import {standardCreates} from './helpers/tiktok-standard-creates.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

const world = () => advertiserWorld({rotating: false});
/** A positive 64-bit integer written as a string, which is how TikTok's Smart+ contract documents `request_id`. */
const requestIdShape = value =>
  typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;

test('a standard campaign create carries a request_id frozen at prepare, and execute sends exactly that value', async () => {
  const f = standardCreates(world(), {tenant: 'request-id-campaign'});
  try {
    const review = (await f.prepare('campaign')).data;
    const frozen = review.request.body.request_id;
    assert.ok(requestIdShape(frozen), 'a positive 64-bit integer string, got ' + JSON.stringify(frozen));
    assert.equal((await f.execute(review)).success, true);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].body.request_id, frozen, 'execute sends the value the review froze');
    // Nothing else about the request changed: the caller's own fields are sent as they were.
    const {request_id: _frozen, ...sent} = f.sent[0].body;
    assert.deepEqual(sent, {
      advertiser_id: f.world.id,
      campaign_name: 'Synthetic campaign',
      objective_type: 'TRAFFIC',
      budget_mode: 'BUDGET_MODE_INFINITE',
      operation_status: 'DISABLE',
    });
  } finally {
    f.close();
  }
});

test('a standard ad group create carries one too', async () => {
  const f = standardCreates(world(), {tenant: 'request-id-adgroup'});
  try {
    const review = (await f.prepare('adgroup')).data;
    assert.ok(requestIdShape(review.request.body.request_id));
    assert.equal((await f.execute(review)).success, true);
    assert.equal(f.sent[0].body.request_id, review.request.body.request_id);
  } finally {
    f.close();
  }
});

test('each review has its own key: the same request prepared twice gets two request_ids, and a corrected request a third', async () => {
  const f = standardCreates(world(), {tenant: 'request-id-distinct'});
  try {
    const first = (await f.prepare('campaign')).data,
      again = (await f.prepare('campaign')).data,
      corrected = (await f.prepare('campaign', p => ({...p, campaign_name: 'Corrected'}))).data;
    const ids = [first, again, corrected].map(r => r.request.body.request_id);
    assert.equal(new Set(ids).size, 3, JSON.stringify(ids));
    for (const id of ids) assert.ok(requestIdShape(id));
  } finally {
    f.close();
  }
});

test('the value is derived from the review ID, so it is a function of the review and of nothing the caller sends', async () => {
  const {tiktokRequestIdFor} = await import('../dist/src/tiktok-request-id.js');
  const f = standardCreates(world(), {tenant: 'request-id-derived'});
  try {
    const review = (await f.prepare('campaign')).data;
    assert.equal(review.request.body.request_id, tiktokRequestIdFor(review.review_id));
    assert.equal(tiktokRequestIdFor(review.review_id), tiktokRequestIdFor(review.review_id));
    assert.notEqual(tiktokRequestIdFor(review.review_id), tiktokRequestIdFor('another-review-id'));
    // Always a positive 64-bit integer, whatever the ID.
    for (const id of ['', '0', 'a', review.review_id, 'x'.repeat(500)])
      assert.ok(requestIdShape(tiktokRequestIdFor(id)), id);
  } finally {
    f.close();
  }
});

test('a request_id the caller supplies is frozen as it is, never replaced', async () => {
  const f = standardCreates(world(), {tenant: 'request-id-supplied'});
  try {
    const review = (await f.prepare('campaign', p => ({...p, request_id: '700100200300'}))).data;
    assert.equal(review.request.body.request_id, '700100200300');
    assert.equal((await f.execute(review)).success, true);
    assert.equal(f.sent[0].body.request_id, '700100200300');
  } finally {
    f.close();
  }
});

test('a request the pinned catalog lists no request_id for is left as it is: an ad create, a status update and a Smart+ create', async () => {
  const f = standardCreates(world(), {tenant: 'request-id-none'});
  try {
    const ad = (await f.prepare('ad')).data;
    assert.equal(Object.hasOwn(ad.request.body, 'request_id'), false, 'an ad create takes no request_id');
    assert.equal((await f.execute(ad)).success, true);
    assert.equal(Object.hasOwn(f.sent[0].body, 'request_id'), false);
    // A Smart+ create requires the caller's own value, which is frozen with the request and sent exactly.
    const smart = await f.write({
      action: 'prepare',
      arguments: {
        action: 'tiktok_smart_plus_campaign_create',
        account_id: f.world.id,
        payload: {
          request_id: '700100200300',
          operation_status: 'DISABLE',
          objective_type: 'WEB_CONVERSIONS',
          sales_destination: 'WEBSITE',
          campaign_name: 'Smart+ synthetic',
          budget: 250,
        },
      },
    });
    assert.equal(smart.success, true, JSON.stringify(smart).slice(0, 800));
    assert.equal(smart.data.request.body.request_id, '700100200300');
    assert.equal((await f.execute(smart.data)).success, true);
    assert.equal(f.sent[1].body.request_id, '700100200300');
    // Without one a Smart+ create is still refused: AMCP supplies none where TikTok's contract asks the caller for it.
    const missing = await f.write({
      action: 'prepare',
      arguments: {
        action: 'tiktok_smart_plus_campaign_create',
        account_id: f.world.id,
        payload: {
          operation_status: 'DISABLE',
          objective_type: 'WEB_CONVERSIONS',
          sales_destination: 'WEBSITE',
          campaign_name: 'Smart+ synthetic',
          budget: 250,
        },
      },
    });
    assertRefused(missing, 'INVALID_TIKTOK_SMART_PLUS_CAMPAIGN');
  } finally {
    f.close();
  }
});

test('the frozen value is part of the review’s fingerprint: a review whose request_id was changed after prepare is refused and nothing is sent', async () => {
  const f = standardCreates(world(), {tenant: 'request-id-integrity'});
  try {
    const review = (await f.prepare('campaign')).data;
    const stored = f.store.document(f.tenant, 'write_review', review.review_id);
    const {id: _id, revision: _revision, ...data} = stored;
    data.plan.body.request_id = '4242';
    f.store.putDocument(f.tenant, 'write_review', review.review_id, data);
    assertRefused(await f.execute(review), 'REVIEW_CHANGED');
    assert.equal(f.sent.length, 0);
  } finally {
    f.close();
  }
});

test('the request_id is AMCP’s own value, shown in the request the review sends and nowhere as TikTok’s: not in the provider state, not in the approval text, and no spend field', async () => {
  const f = standardCreates(world(), {tenant: 'request-id-plain'});
  try {
    const prepared = await f.prepare('campaign');
    assert.equal(prepared.success, true);
    const value = prepared.data.request.body.request_id;
    assert.ok(requestIdShape(value), 'a frozen value to look for: ' + JSON.stringify(value));
    // The provider's state, the sentence a person approves and the evidence of the contract never carry it.
    for (const part of ['before_state', 'summary', 'contract_evidence'])
      assert.equal(JSON.stringify(prepared.data[part]).includes(value), false, part);
    // A name that holds no money: a paused create still needs no spend flag, as before the key was added.
    assert.equal(prepared.data.execute_requirements.spend_change_confirmed, false);
    assert.equal((await f.execute(prepared.data)).success, true);
  } finally {
    f.close();
  }
});

test('an expired review is prepared again from the caller’s own arguments, which never held the key: the new review gets its own', async () => {
  const f = standardCreates(world(), {tenant: 'request-id-expired'});
  try {
    const review = (await f.prepare('campaign')).data;
    const stored = f.store.document(f.tenant, 'write_review', review.review_id);
    const {id: _id, revision: _revision, ...data} = stored;
    f.store.putDocument(f.tenant, 'write_review', review.review_id, {...data, expires_at: Date.now() - 1000});
    const expired = await f.status(review);
    assert.equal(expired.data.state, 'expired');
    const again = expired.data.next_call.arguments;
    assert.equal(again.action, 'prepare');
    assert.equal(Object.hasOwn(again.arguments.payload, 'request_id'), false, 'the arguments to prepare again');
    const renewed = await f.write(again);
    assert.equal(renewed.success, true, JSON.stringify(renewed).slice(0, 800));
    assert.ok(requestIdShape(renewed.data.request.body.request_id));
    assert.notEqual(renewed.data.request.body.request_id, review.request.body.request_id);
  } finally {
    f.close();
  }
});

test('in a plan, each attempt of a step is its own review with its own request_id; the plan step’s arguments never hold one', async () => {
  let refuse = true;
  const f = standardCreates(world(), {
    tenant: 'request-id-plan',
    post: () =>
      refuse
        ? Response.json({code: 40002, message: 'Your budget must be $50 or more.', request_id: 'synthetic', data: {}})
        : undefined,
  });
  try {
    const created = await f.plan({
      action: 'create',
      name: 'Request ID per attempt',
      brief: 'Synthetic: a paused TikTok campaign refused once, then corrected.',
      steps: [
        {
          id: 'campaign',
          kind: 'write',
          gateway: 'tiktok_native_action',
          connection_id: 'login',
          account_id: f.world.id,
          arguments: {
            action: 'tiktok_campaign_create',
            payload: {
              campaign_name: 'Synthetic campaign',
              objective_type: 'TRAFFIC',
              budget_mode: 'BUDGET_MODE_DAY',
              budget: 1,
              operation_status: 'DISABLE',
            },
          },
        },
      ],
    });
    assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
    const id = created.data.id,
      next = async () => {
        const prepared = await f.plan({action: 'prepare_next', id});
        assert.ok(prepared.data?.review?.review_id, JSON.stringify(prepared).slice(0, 800));
        return f.plan({
          action: 'execute_next',
          id,
          review_id: prepared.data.review.review_id,
          idempotency_key: prepared.data.review.review_id,
          confirmed: true,
          spend_change_confirmed: true,
        });
      };
    await next();
    const blocked = await f.plan({action: 'prepare_next', id});
    assert.equal(blocked.data.next_call.arguments.action, 'recover_step');
    await f.plan({...blocked.data.next_call.arguments, patch: [{path: '/payload/budget', value: 50}]});
    refuse = false;
    assert.equal((await next()).success, true);
    assert.equal(f.sent.length, 2);
    const [refused, corrected] = f.sent.map(s => s.body.request_id);
    assert.ok(requestIdShape(refused) && requestIdShape(corrected));
    assert.notEqual(refused, corrected, 'the corrected step is a new review under a new key');
    const step = f.store.document(f.tenant, 'campaign_run', id).steps[0];
    assert.equal(Object.hasOwn(step.arguments.payload, 'request_id'), false);
  } finally {
    f.close();
  }
});

/**
 * A synthetic advertiser that remembers what a campaign create made and lists it the way TikTok does: its rows carry the
 * fields the create set and never the request_id, which TikTok does not return.
 */
function campaignFixture() {
  const actor = {tenantId: 'request-id-verify', userId: 'operator', role: 'operator'},
    store = new Store(':memory:', Buffer.alloc(32, 59).toString('base64')),
    advertiser = '9000000000000000002',
    campaigns = new Map(),
    sent = [];
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'login',
      tenantId: actor.tenantId,
      gateway: 'tiktok_native_action',
      accounts: [advertiser],
      writeAccounts: [advertiser],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init = {}) => {
      const url = new URL(String(raw)),
        path = url.pathname.replace('/open_api', ''),
        method = init.method ?? 'GET';
      if (method === 'POST' && path === '/v1.3/campaign/create/') {
        const body = JSON.parse(init.body),
          {request_id: _requestId, ...row} = body;
        sent.push(body);
        campaigns.set('301', {...row, campaign_id: '301'});
        return Response.json(answer({campaign_id: '301'}));
      }
      if (path === '/v1.3/advertiser/info/')
        return Response.json(
          answer({list: [{advertiser_id: advertiser, name: 'Synthetic', currency: 'USD', timezone: 'UTC'}]}),
        );
      if (path === '/v1.3/campaign/get/') {
        const ids = JSON.parse(url.searchParams.get('filtering')).campaign_ids,
          list = ids.filter(id => campaigns.has(id)).map(id => campaigns.get(id));
        return Response.json(
          answer({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}}),
        );
      }
      throw new Error('Unexpected TikTok request ' + method + ' ' + path);
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  return {
    store,
    sent,
    advertiser,
    call: (tool, input) => service.call(tool, input, actor),
    close: () => store.close(),
  };
}

test('the read-back of a create that carried a request_id verifies: TikTok returns no request_id, and the review does not expect one', async () => {
  const f = campaignFixture();
  try {
    const prepared = await f.call('amcp_write', {
      action: 'prepare',
      gateway: 'tiktok_native_action',
      connection_id: 'login',
      arguments: {
        action: 'tiktok_campaign_create',
        account_id: f.advertiser,
        payload: {
          campaign_name: 'Synthetic verified',
          objective_type: 'TRAFFIC',
          budget_mode: 'BUDGET_MODE_INFINITE',
          operation_status: 'DISABLE',
        },
      },
    });
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 800));
    assert.ok(requestIdShape(prepared.data.request.body.request_id));
    const id = prepared.data.review_id,
      executed = await f.call('amcp_write', {
        action: 'execute',
        review_id: id,
        idempotency_key: id,
        confirmed: true,
        spend_change_confirmed: true,
      });
    assert.equal(executed.success, true, JSON.stringify(executed).slice(0, 800));
    assert.equal(f.sent[0].request_id, prepared.data.request.body.request_id);
    const verified = await f.call('amcp_campaign', {action: 'verify', review_id: id});
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified).slice(0, 1200));
  } finally {
    f.close();
  }
});
