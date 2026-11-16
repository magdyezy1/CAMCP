// Package r25-m2-refusal, item 3 (MT3, L3-03, Round 2.5 M2 acceptance 5): what the rate governor keeps is shown. The answer of a call
// that sent provider requests carries `meta.rate_limit: {state, until?, usage_pct?}` for the logins and accounts it touched (the
// one that is most constrained when it touched several), and `amcp_workspace check` carries it for the account it checks. Meta
// shows ok or cooling from its usage headers and unknown before it has said any; Google, whose APIs send none, shows "not
// exposed"; TikTok shows unknown until a header AMCP can read has been seen. The view names no provider: it is the shape the
// package names, small enough for every answer of a journey (tests/journeys/baseline.json budgets response bytes), and a check
// is for one connection whose provider is known. The values are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const meta = 'meta_native_action';
const owner = {tenantId: 'exposure', userId: 'owner', role: 'admin'};
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
const usage = (callCount = 63) => ({
  'x-business-use-case-usage': JSON.stringify({
    123: [
      {
        type: 'ads_management',
        call_count: callCount,
        total_cputime: 20,
        total_time: 20,
        estimated_time_to_regain_access: 0,
      },
    ],
  }),
});
const blocked = {
  'x-business-use-case-usage': JSON.stringify({
    123: [
      {type: 'ads_management', call_count: 100, total_cputime: 30, total_time: 30, estimated_time_to_regain_access: 12},
    ],
  }),
};

/** A Meta ad account (123) and a Google Ads and a TikTok login, behind the real service and transport. */
function fixture({headers = () => ({})} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 79).toString('base64')),
    requests = [];
  for (const [id, gateway, accounts] of [
    ['m', meta, ['123']],
    ['g', 'google_ads_native_action', ['1234567890']],
    ['t', 'tiktok_native_action', ['9000000000000000003']],
  ])
    store.putConnection(
      owner,
      {
        id,
        tenantId: owner.tenantId,
        gateway,
        accounts,
        writeAccounts: accounts,
        enabled: true,
        label: id,
        scopes: ['ads_management'],
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
  const transport = new NativeTransport(
    async (raw, init = {}) => {
      const method = init.method ?? 'GET',
        path = new URL(String(raw)).pathname;
      requests.push(method + ' ' + path);
      if (method === 'GET' && path === '/v26.0/act_123')
        return json(
          {
            id: 'act_123',
            account_id: '123',
            name: 'Synthetic',
            currency: 'USD',
            timezone_name: 'UTC',
            account_status: 1,
            tos_accepted: {custom_audience_tos: 1},
          },
          200,
          headers(requests.length),
        );
      throw Error('Unexpected synthetic request: ' + method + ' ' + path);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    1000000,
    1,
    1000,
  );
  transport.coordination = store;
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  return {
    store,
    transport,
    requests,
    call: (tool, input) => service.call(tool, input, owner),
    prepare: () =>
      service.call(
        'amcp_write',
        {
          action: 'prepare',
          gateway: meta,
          arguments: {
            action: 'meta_campaign_create',
            account_id: '123',
            payload: {
              name: 'Draft',
              status: 'PAUSED',
              objective: 'OUTCOME_TRAFFIC',
              special_ad_categories: [],
              is_adset_budget_sharing_enabled: false,
            },
          },
        },
        owner,
      ),
    check: (input = {}) =>
      service.call('amcp_workspace', {action: 'check', connection_id: 'm', account_id: '123', ...input}, owner),
  };
}
const mode = async (value, run) => {
  const before = process.env.AMCP_PROVIDER_PACING_MODE;
  if (value === undefined) delete process.env.AMCP_PROVIDER_PACING_MODE;
  else process.env.AMCP_PROVIDER_PACING_MODE = value;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.AMCP_PROVIDER_PACING_MODE;
    else process.env.AMCP_PROVIDER_PACING_MODE = before;
  }
};

test('a call that sent Meta requests shows what Meta said in meta.rate_limit; with nothing to say the answer is as it was', async () => {
  const f = fixture({headers: () => usage(63)});
  try {
    const prepared = await f.prepare();
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 600));
    assert.deepEqual(prepared.meta.rate_limit, {state: 'ok', usage_pct: 63});
    // The bytes are small and carry no payload and no identifier of an account or a login.
    assert.ok(JSON.stringify(prepared.meta.rate_limit).length < 50);
  } finally {
    f.store.close();
  }
  // Before Meta has said anything, and for a provider that says nothing, an answer carries no rate_limit: a constant "unknown" on
  // every answer would be bytes of no information (tests/journeys/baseline.json budgets them). amcp_workspace check says it.
  const quiet = fixture();
  try {
    const prepared = await quiet.prepare();
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 600));
    assert.equal(Object.hasOwn(prepared.meta, 'rate_limit'), false);
    assert.deepEqual((await quiet.check()).data.rate_limit, {state: 'unknown'});
  } finally {
    quiet.store.close();
  }
});

test('a call that sent no provider request carries no rate_limit', async () => {
  const f = fixture({headers: () => usage()});
  try {
    for (const [tool, input] of [
      ['amcp_workspace', {action: 'dashboard'}],
      ['amcp_workspace', {action: 'capabilities'}],
      ['amcp_workspace', {action: 'history'}],
    ]) {
      const answer = await f.call(tool, input);
      assert.equal(answer.success, true, tool + ' ' + input.action + ' ' + JSON.stringify(answer).slice(0, 300));
      assert.equal(Object.hasOwn(answer.meta, 'rate_limit'), false, input.action);
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('a refusal carries it too: a request refused before it was sent shows the block that refused it', async () => {
  await mode('enforce', async () => {
    const f = fixture({headers: n => (n === 1 ? blocked : {})});
    try {
      assert.equal((await f.prepare()).success, true);
      const refused = await f.prepare();
      assertRefused(refused, 'PLATFORM_RATE_LIMIT');
      assert.equal(refused.meta.rate_limit.state, 'cooling');
      assert.ok(Date.parse(refused.meta.rate_limit.until) > Date.now() + 11 * 60000);
      assert.equal(f.requests.length, 1, 'the second prepare sent nothing');
    } finally {
      f.store.close();
    }
  });
});

test('a call that is run by another carries what the nested call touched: a plan step prepared through amcp_campaign', async () => {
  const f = fixture({headers: () => usage(41)});
  try {
    const created = await f.call('amcp_campaign', {
      action: 'create',
      name: 'Exposure',
      brief: 'Synthetic: one paused Meta campaign.',
      steps: [
        {
          id: 'campaign',
          kind: 'write',
          gateway: meta,
          connection_id: 'm',
          account_id: '123',
          arguments: {
            action: 'meta_campaign_create',
            payload: {
              name: 'Draft',
              status: 'PAUSED',
              objective: 'OUTCOME_TRAFFIC',
              special_ad_categories: [],
              is_adset_budget_sharing_enabled: false,
            },
          },
        },
      ],
    });
    assert.equal(created.success, true, JSON.stringify(created).slice(0, 600));
    assert.equal(Object.hasOwn(created.meta, 'rate_limit'), false, 'creating a plan sends no request');
    const next = await f.call('amcp_campaign', {action: 'prepare_next', id: created.data.id});
    assert.equal(next.success, true, JSON.stringify(next).slice(0, 600));
    assert.deepEqual(next.meta.rate_limit, {state: 'ok', usage_pct: 41});
  } finally {
    f.store.close();
  }
});

test('amcp_workspace check shows the limits of the account it checks, with or without a live read', async () => {
  const f = fixture({headers: () => usage(77)});
  try {
    // Without a live read nothing was sent, and nothing has been seen.
    const offline = await f.check();
    assert.equal(offline.success, true, JSON.stringify(offline).slice(0, 600));
    assert.deepEqual(offline.data.rate_limit, {state: 'unknown'});
    assert.equal(f.requests.length, 0);
    // The live read of the account carries Meta's headers, which the check then shows.
    const live = await f.check({live: true});
    assert.equal(live.success, true, JSON.stringify(live).slice(0, 600));
    assert.deepEqual(live.data.rate_limit, {state: 'ok', usage_pct: 77});
    assert.deepEqual(live.meta.rate_limit, {state: 'ok', usage_pct: 77});
    // The same for each account of a batch.
    const batch = await f.check({account_id: undefined, account_ids: ['123']});
    assert.equal(batch.success, true, JSON.stringify(batch).slice(0, 600));
    assert.deepEqual(batch.data.results[0].rate_limit, {state: 'ok', usage_pct: 77});
  } finally {
    f.store.close();
  }
});

test('check says not exposed for Google, whose APIs send no usage header, and unknown for TikTok until one is seen', async () => {
  const f = fixture();
  try {
    const google = await f.check({connection_id: 'g', account_id: '1234567890'});
    assert.equal(google.success, true, JSON.stringify(google).slice(0, 600));
    assert.deepEqual(google.data.rate_limit, {state: 'not_exposed'});
    const tiktok = await f.check({connection_id: 't', account_id: '9000000000000000003'});
    assert.equal(tiktok.success, true, JSON.stringify(tiktok).slice(0, 600));
    assert.deepEqual(tiktok.data.rate_limit, {state: 'unknown'});
  } finally {
    f.store.close();
  }
});

test('check shows a throttle that is known as cooling, with when it ends', async () => {
  await mode('enforce', async () => {
    const f = fixture({headers: () => blocked});
    try {
      const live = await f.check({live: true});
      assert.equal(live.success, true, JSON.stringify(live).slice(0, 600));
      assert.equal(live.data.rate_limit.state, 'cooling');
      assert.equal(live.data.rate_limit.usage_pct, 100);
      assert.ok(Date.parse(live.data.rate_limit.until) > Date.now() + 11 * 60000);
      const again = await f.check();
      assert.equal(again.data.rate_limit.state, 'cooling');
    } finally {
      f.store.close();
    }
  });
});

test('the summary of a call that touched several shows the most constrained one: a throttle, then the highest usage, then unknown, then not exposed', async () => {
  const {rateLimitSummary} = await import('../dist/src/provider-usage.js');
  const view = (state, extra = {}) => ({state, ...extra});
  assert.equal(rateLimitSummary([]), undefined);
  assert.deepEqual(rateLimitSummary([view('not_exposed'), view('unknown')]), view('unknown'));
  assert.deepEqual(rateLimitSummary([view('unknown'), view('ok', {usage_pct: 10})]), view('ok', {usage_pct: 10}));
  assert.deepEqual(
    rateLimitSummary([view('ok', {usage_pct: 10}), view('ok', {usage_pct: 90}), view('ok', {usage_pct: 40})]),
    view('ok', {usage_pct: 90}),
  );
  assert.deepEqual(
    rateLimitSummary([
      view('ok', {usage_pct: 90}),
      view('cooling', {until: '2026-11-16T10:00:00.000Z'}),
      view('cooling', {until: '2026-11-16T10:30:00.000Z'}),
    ]),
    view('cooling', {until: '2026-11-16T10:30:00.000Z'}),
  );
});
