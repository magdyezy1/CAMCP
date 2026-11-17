// Package r25-m2-refusal, item 2 as the lead's review of 2026-11-16 left it (S1-1; Q16, owner 2026-11-15; L1-09): AMCP sends no
// request_id of its own on a TikTok create.
//
// The first version of this item froze a key derived from each review when the review was prepared, so that TikTok would be a second
// backstop against a double create. TikTok's create pages say two things against it (the lead's reading of 2026-11-16, kept in the
// package REPORT for the live check LV-10): a different request_id is how a second object of the same name is created at all, so a key
// that is new for every review switches off TikTok's own same-name refusal across reviews; and a key de-duplicates a repeat only
// within 10 seconds, which AMCP never uses, because it never sends one review twice. Owner decision Q16 asks for the key after the
// dedupe check (LV-10), and that check has not run. So a standard create is sent as the caller wrote it: the request the review
// shows, the frozen plan and the body sent hold no request_id of AMCP's, nothing in the lifecycle can add one, and a key the caller
// supplies is frozen and sent exactly as it is. The answers below are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {registeredProviderHooks, providerHooks} from '../dist/src/provider-hooks.js';
import {advertiserWorld, answer} from './helpers/tiktok-advertiser-noise.mjs';
import {standardBodies, standardCreates} from './helpers/tiktok-standard-creates.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

const world = () => advertiserWorld({rotating: false});
const hasKey = (body, name) => Object.hasOwn(body, name);
/** Every value a key named `name` holds anywhere in `value`, whatever its depth. */
const valuesNamed = (value, name, found = []) => {
  if (Array.isArray(value)) for (const item of value) valuesNamed(item, name, found);
  else if (value && typeof value === 'object')
    for (const [key, inner] of Object.entries(value)) {
      if (key === name) found.push(inner);
      valuesNamed(inner, name, found);
    }
  return found;
};

test('a standard campaign create carries no request_id of AMCP’s: not in the request the review shows, not in the frozen plan, not in the body sent', async () => {
  const f = standardCreates(world(), {tenant: 'request-id-campaign'});
  try {
    const review = (await f.prepare('campaign')).data;
    assert.equal(hasKey(review.request.body, 'request_id'), false, 'the request the review shows');
    const stored = f.store.document(f.tenant, 'write_review', review.review_id);
    assert.equal(hasKey(stored.plan.body, 'request_id'), false, 'the plan the review froze');
    assert.deepEqual(review.request.body, standardBodies(f.world.id).campaign.payload);
    assert.equal((await f.execute(review)).success, true);
    assert.equal(f.sent.length, 1);
    // Exactly the caller's own fields, nothing added.
    assert.deepEqual(f.sent[0].body, standardBodies(f.world.id).campaign.payload);
    assert.equal(hasKey(f.sent[0].body, 'request_id'), false);
  } finally {
    f.close();
  }
});

test('a standard ad group create carries none either', async () => {
  const f = standardCreates(world(), {tenant: 'request-id-adgroup'});
  try {
    const review = (await f.prepare('adgroup')).data;
    assert.equal(hasKey(review.request.body, 'request_id'), false);
    assert.equal((await f.execute(review)).success, true);
    assert.deepEqual(f.sent[0].body, standardBodies(f.world.id).adgroup.payload);
    assert.equal(hasKey(f.sent[0].body, 'request_id'), false);
  } finally {
    f.close();
  }
});

test('nothing in the request differs from one review to the next: the same request prepared twice has one body, and a corrected one differs only in what the caller changed', async () => {
  const f = standardCreates(world(), {tenant: 'request-id-same'});
  try {
    const first = (await f.prepare('campaign')).data,
      again = (await f.prepare('campaign')).data,
      corrected = (await f.prepare('campaign', p => ({...p, campaign_name: 'Corrected'}))).data;
    assert.notEqual(first.review_id, again.review_id);
    assert.deepEqual(first.request.body, again.request.body);
    assert.deepEqual(corrected.request.body, {...first.request.body, campaign_name: 'Corrected'});
  } finally {
    f.close();
  }
});

test('nothing in the code path can add one: no provider declares the review hook that sets a deduplication key, and the review shows no key named request_id', async () => {
  // The hook of the first version (WriteReviewHooks.dedupeBody) stays a seam, with nothing behind it: a provider that declared it
  // would send a key AMCP made, which Q16 holds back until LV-10 says how TikTok treats one. A declaration fails here, and in the
  // exact hook lists of tests/provider-review-hooks.test.mjs, until that decision is made.
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.writes && Object.hasOwn(h.writes, 'dedupeBody')).map(h => h.gateway),
    [],
  );
  assert.equal(providerHooks('tiktok_native_action').writes.dedupeBody, undefined);
  const f = standardCreates(world(), {tenant: 'request-id-nowhere'});
  try {
    for (const kind of ['campaign', 'adgroup', 'ad']) {
      const prepared = await f.prepare(kind);
      assert.equal(prepared.success, true, kind + ' ' + JSON.stringify(prepared).slice(0, 400));
      assert.deepEqual(valuesNamed(prepared.data, 'request_id'), [], kind);
    }
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

test('an ad create takes no request_id and a Smart+ create takes the caller’s own, sent exactly; without one a Smart+ create is still refused', async () => {
  const f = standardCreates(world(), {tenant: 'request-id-none'});
  try {
    const ad = (await f.prepare('ad')).data;
    assert.equal(hasKey(ad.request.body, 'request_id'), false, 'an ad create takes no request_id');
    assert.equal((await f.execute(ad)).success, true);
    assert.equal(hasKey(f.sent[0].body, 'request_id'), false);
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

test('a request_id added to the frozen request after prepare is refused and nothing is sent: execute cannot add or change one either', async () => {
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

test('an expired review is prepared again from the caller’s own arguments, and the new review carries no key either', async () => {
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
    assert.equal(hasKey(again.arguments.payload, 'request_id'), false, 'the arguments to prepare again');
    const renewed = await f.write(again);
    assert.equal(renewed.success, true, JSON.stringify(renewed).slice(0, 800));
    assert.equal(hasKey(renewed.data.request.body, 'request_id'), false);
  } finally {
    f.close();
  }
});

test('in a plan, no attempt of a step sends a request_id: the refused attempt and the corrected one go as the step wrote them', async () => {
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
      name: 'No request_id per attempt',
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
    for (const [index, sent] of f.sent.entries())
      assert.equal(hasKey(sent.body, 'request_id'), false, 'attempt ' + (index + 1));
    assert.deepEqual(
      f.sent.map(s => s.body.budget),
      [1, 50],
    );
    const step = f.store.document(f.tenant, 'campaign_run', id).steps[0];
    assert.equal(hasKey(step.arguments.payload, 'request_id'), false);
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

test('the read-back of a create that carried the caller’s request_id verifies: TikTok returns no request_id, and the review does not expect one', async () => {
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
          request_id: '700100200300',
          campaign_name: 'Synthetic verified',
          objective_type: 'TRAFFIC',
          budget_mode: 'BUDGET_MODE_INFINITE',
          operation_status: 'DISABLE',
        },
      },
    });
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 800));
    assert.equal(prepared.data.request.body.request_id, '700100200300');
    const id = prepared.data.review_id,
      executed = await f.call('amcp_write', {
        action: 'execute',
        review_id: id,
        idempotency_key: id,
        confirmed: true,
        spend_change_confirmed: true,
      });
    assert.equal(executed.success, true, JSON.stringify(executed).slice(0, 800));
    assert.equal(f.sent[0].request_id, '700100200300');
    const verified = await f.call('amcp_campaign', {action: 'verify', review_id: id});
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified).slice(0, 1200));
  } finally {
    f.close();
  }
});
