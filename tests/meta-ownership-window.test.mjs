import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * R2.5 package r25-fr-window (the owner's friction report of 2026-11-25, C1 and B3): AMCP acts on a Meta campaign, ad set or ad only while
 * the account has listed or created it for this login, and that lasted five minutes. On the owner's runs it stopped a 26-ad go-live three
 * times and refused its first write, forced a list read of all eight accounts before a plan of 24 end dates, and made the read-back of a
 * correct budget and date change read "unverified". Q22 of the Round 2.5 plan (owner, 2026-11-15): a campaign, an ad set and an ad never
 * change ad account, so what an account listed or AMCP created of them vouches for six hours; everything else stays at five minutes. A
 * verification may renew, for 60 seconds, the observation of what its own review wrote (the lead's decision of 2026-11-27); a write never
 * may. The world is synthetic: eight accounts with 3 ad sets each (24) and 26 ads, as in the owner's two plans. Time passes on the clock
 * (Date.now, as the other plan tests make it pass), so the rows, the reviews and the run budget all see it.
 */
const gateway = 'meta_native_action',
  tenantId = 'meta-ownership-window',
  actor = {tenantId, userId: 'operator', role: 'operator'},
  owner = {...actor, userId: 'owner', role: 'admin'},
  minute = 60_000,
  hour = 60 * minute,
  accounts = Array.from({length: 8}, (_, i) => String(101 + i)),
  edges = {campaigns: 'campaign', adsets: 'adset', ads: 'ad', adcreatives: 'creative', customaudiences: 'audience'},
  adId = (account, j) => '5' + account + '0' + j,
  adSetId = (account, k) => '4' + account + '0' + k,
  campaignId = account => '3' + account + '01',
  date = day => '2026-12-' + String(day).padStart(2, '0') + 'T23:59:00+0300',
  // The two logins a test may use, by the name it gives them; the gateway's schema wants their ids to be UUIDs.
  ids = {login: '11111111-1111-4111-8111-111111111111', second: '22222222-2222-4222-8222-222222222222'};
// One clock for the file: every test starts at the real time, and a test moves it on.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

function world(t, {logins = ['login']} = {}) {
  skew = 0;
  const store = new Store(':memory:', Buffer.alloc(32, 88).toString('base64'));
  t.after(() => store.close());
  const connections = Object.fromEntries(
    logins.map(name => [
      name,
      {
        id: ids[name],
        tenantId,
        gateway,
        accounts,
        writeAccounts: accounts,
        enabled: true,
        label: 'Synthetic Meta ' + name,
        scopes: ['ads_management'],
      },
    ]),
  );
  for (const c of Object.values(connections)) store.putConnection(owner, c, {accessToken: 'synthetic'});
  const objects = new Map(),
    requests = [],
    put = (id, o) => objects.set(id, {id, ...o});
  accounts.forEach((account, n) => {
    put(campaignId(account), {kind: 'campaign', account_id: account, name: 'Campaign ' + account, status: 'PAUSED'});
    for (let k = 1; k <= 3; k++)
      put(adSetId(account, k), {
        kind: 'adset',
        account_id: account,
        campaign_id: campaignId(account),
        name: 'Ad set ' + account + '.' + k,
        status: 'ACTIVE',
        daily_budget: '5000',
        end_time: '2026-11-30T23:59:00+0300',
      });
    // 26 ads: four in each of the first two accounts, three in each of the others.
    for (let j = 1; j <= (n < 2 ? 4 : 3); j++)
      put(adId(account, j), {
        kind: 'ad',
        account_id: account,
        campaign_id: campaignId(account),
        adset_id: adSetId(account, ((j - 1) % 3) + 1),
        name: 'Ad ' + account + '.' + j,
        status: 'PAUSED',
      });
  });
  put('610101', {kind: 'creative', account_id: '101', name: 'Spring carousel', status: 'ACTIVE'});
  put('710101', {kind: 'audience', account_id: '101', name: 'Site visitors', subtype: 'CUSTOM'});
  // An audience another account shares with 101: 101's list shows it, and it is not 101's.
  put('710999', {
    kind: 'audience',
    account_id: '999',
    name: 'Shared audience',
    subtype: 'CUSTOM',
    shared_with: ['101'],
  });
  const gone = () =>
    Response.json({error: {message: 'Unsupported get request.', code: 100, error_subcode: 33}}, {status: 400});
  let writes = 0,
    next = 900000,
    onWrite = () => {};
  const fetcher = async (raw, init = {}) => {
    const url = new URL(String(raw)),
      method = init.method ?? 'GET',
      path = url.pathname,
      fields = url.searchParams.get('fields')?.split(','),
      project = o => {
        const out = {id: o.id};
        for (const k of fields ?? ['name']) if (k !== 'id' && k !== 'kind' && o[k] !== undefined) out[k] = o[k];
        return out;
      },
      form = () => Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
    requests.push(method + ' ' + path);
    let m;
    if (method === 'GET' && (m = /^\/v26\.0\/act_(\d+)$/.exec(path)))
      return Response.json({
        id: 'act_' + m[1],
        account_id: m[1],
        account_status: 1,
        currency: 'USD',
        timezone_name: 'UTC',
        name: 'Account ' + m[1],
      });
    if (
      method === 'GET' &&
      (m = /^\/v26\.0\/act_(\d+)\/(campaigns|adsets|ads|adcreatives|customaudiences)$/.exec(path))
    )
      return Response.json({
        data: [...objects.values()]
          .filter(o => o.kind === edges[m[2]] && (o.account_id === m[1] || o.shared_with?.includes(m[1])))
          .map(project),
      });
    if (method === 'GET' && (m = /^\/v26\.0\/(\d+)$/.exec(path))) {
      const o = objects.get(m[1]);
      return o ? Response.json(project(o)) : gone();
    }
    if (method === 'POST' && (m = /^\/v26\.0\/(\d+)$/.exec(path))) {
      const o = objects.get(m[1]);
      if (!o) return gone();
      Object.assign(o, form());
      writes++;
      onWrite(writes);
      return Response.json({success: true});
    }
    if (method === 'POST' && (m = /^\/v26\.0\/act_(\d+)\/(adsets|ads)$/.exec(path))) {
      const id = String(next++);
      put(id, {...form(), kind: edges[m[2]], account_id: m[1]});
      writes++;
      onWrite(writes);
      return Response.json({id});
    }
    throw new Error('Unexpected synthetic Meta request ' + method + ' ' + path);
  };
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(fetcher, async () => {}, 30000, 8 * 1024 * 1024, 100000),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = (tool, input) => service.call(tool, input, actor),
    login = logins[0];
  const f = {
    store,
    objects,
    requests,
    connections,
    call,
    pass: ms => {
      skew += ms;
    },
    onWrite: fn => {
      onWrite = fn;
    },
    writes: () => writes,
    /** The account lists an agent reads, as the refusal's own next_call names them: one read for each account. */
    list: async (kind, who = login, only = accounts) => {
      for (const account of only)
        ok(
          await call(gateway, {
            action: 'meta_' + kind + '_list',
            account_id: account,
            connection_id: ids[who],
            query: {fields: 'id'},
          }),
        );
    },
    /** A native read of an account's edge, as an agent sends it (the creatives and audiences have no typed list). */
    edge: async (action, account, fields) =>
      ok(
        await call(gateway, {
          action,
          account_id: account,
          connection_id: ids[login],
          params: {ad_account_id: 'act_' + account, fields},
        }),
      ),
    listReads: edge => requests.filter(r => new RegExp('^GET /v26\\.0/act_\\d+/' + edge + '$').test(r)).length,
    prepare: (action, account, path_params, payload, who = login) =>
      call('amcp_write', {
        action: 'prepare',
        gateway,
        connection_id: ids[who],
        arguments: {action, account_id: account, ...(path_params ? {path_params} : {}), payload},
      }),
    execute: (review, extra = {}) =>
      call('amcp_write', {
        action: 'execute',
        review_id: review.data.review_id,
        idempotency_key: review.data.idempotency_key,
        confirmed: true,
        ...extra,
      }),
    verify: review => call('amcp_campaign', {action: 'verify', review_id: review.data.review_id}),
    /** A plan created and approved as the owner's agent does: the summary first, then approve with what it names. */
    plan: async (steps, name) => {
      const created = ok(await call('amcp_campaign', {action: 'create', name, brief: 'Synthetic.', steps}));
      const preview = (await call('amcp_campaign', {action: 'approve', id: created.data.id})).data;
      ok(
        await call('amcp_campaign', {
          ...preview.next_call.arguments,
          ...preview.next_call.add_after_user_approval,
        }),
      );
      return created.data.id;
    },
    /** Runs the plan as an agent does: run again after each stop for time, `between` ms later. */
    finish: async (id, between = 0) => {
      let last;
      for (let i = 0; i < 8; i++) {
        last = (await call('amcp_campaign', {action: 'run', id})).data;
        if (last?.run?.stopped !== 'time') break;
        f.pass(between);
      }
      return last;
    },
    owned: (id, account = '101', who = login) => store.ownsResource(connections[who], account, id),
    /** How many rows are live now, whoever they are for. */
    live: () => store.db.prepare('SELECT count(*) AS n FROM resource_ownership WHERE expires_at>?').get(Date.now()).n,
    expiry: id => store.db.prepare('SELECT expires_at FROM resource_ownership WHERE resource=?').get(id)?.expires_at,
  };
  return f;
}
function ok(r) {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
}
const step = (id, account, action, path_params, payload) => ({
  id,
  kind: 'write',
  gateway,
  connection_id: ids.login,
  account_id: account,
  description: id,
  arguments: {action, path_params, payload},
  depends_on: [],
});
const objectsOf = (f, kind) => [...f.objects.values()].filter(o => o.kind === kind);
const goLive = f =>
  objectsOf(f, 'ad').map(o => step('go_' + o.id, o.account_id, 'meta_ad_id_update', {ad_id: o.id}, {status: 'ACTIVE'}));
const endDates = (f, end) =>
  objectsOf(f, 'adset').map(o =>
    step('end_' + o.id, o.account_id, 'meta_ad_set_id_update', {ad_set_id: o.id}, {end_time: end}),
  );
const stopped = ran => JSON.stringify(ran?.run ?? ran).slice(0, 700);

// The owner's first shape: the 26-ad go-live, over eight accounts, the lists read before the plan was approved, the run stopping for time
// every ten steps.
test('control: the 26-ad go-live runs to its end when no time passes', async t => {
  const f = world(t);
  assert.equal(goLive(f).length, 26);
  await f.list('ad');
  const ran = await f.finish(await f.plan(goLive(f), 'Go live'));
  assert.equal(ran.run.stopped, 'complete', stopped(ran));
  assert.equal(f.writes(), 26);
  assert.equal(f.listReads('ads'), 8);
});

test('the 26-ad go-live runs to its end although every list is older than five minutes, and its runs cross the window twice more', async t => {
  const f = world(t);
  await f.list('ad');
  // The agent listed the accounts, the user read the approval for a while, and the first run starts after the five minutes.
  f.pass(6 * minute);
  f.onWrite(n => {
    // Ten steps a run: the run stops for time, and the agent comes back six minutes later.
    if (n % 10 === 0) f.pass(26_000);
  });
  const ran = await f.finish(await f.plan(goLive(f), 'Go live'), 6 * minute);
  assert.equal(ran.run.stopped, 'complete', stopped(ran));
  assert.equal(f.writes(), 26);
  assert.ok(
    objectsOf(f, 'ad').every(o => o.status === 'ACTIVE'),
    'every ad is on',
  );
  assert.equal(f.listReads('ads'), 8, 'no list read but the agent’s own eight');
});

// The owner's second shape: 24 end dates on 24 ad sets, in three runs of 12, 11 and 1 steps.
test('24 ad set end dates run to their end in three runs, six minutes apart, and read back exactly', async t => {
  const f = world(t),
    end = date(6);
  await f.list('adset');
  f.pass(6 * minute);
  f.onWrite(n => {
    if (n === 12 || n === 23) f.pass(26_000);
  });
  const ran = await f.finish(await f.plan(endDates(f, end), 'End dates'), 6 * minute);
  assert.equal(ran.run.stopped, 'complete', stopped(ran));
  assert.equal(f.writes(), 24);
  assert.equal(objectsOf(f, 'adset').length, 24);
  assert.ok(objectsOf(f, 'adset').every(o => o.end_time === end));
  assert.equal(f.listReads('adsets'), 8);
});

// The owner's third shape: a correct budget and date change, verified later.
test('a budget and date change of an ad set verifies six minutes after it was written', async t => {
  const f = world(t);
  await f.list('adset', 'login', ['101']);
  const review = ok(
    await f.prepare(
      'meta_ad_set_id_update',
      '101',
      {ad_set_id: adSetId('101', 1)},
      {daily_budget: '6000', end_time: date(6)},
    ),
  );
  ok(await f.execute(review, {spend_change_confirmed: true}));
  f.pass(6 * minute);
  const verified = ok(await f.verify(review));
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data.checks));
});

// The security review of 2026-11-27 (F1): a verification used to write the row it renewed, and every prepare, execute and plan step saw it, so a verification every
// 50 seconds kept an ID writable seven hours on. It writes nothing now: what it renews is its own call's, for its own reads.
test('a verification reads back what its own review wrote after the window, and leaves nothing a prepare can find, however often it runs', async t => {
  const f = world(t);
  await f.list('adset', 'login', ['101']);
  const edit = async k =>
    ok(await f.prepare('meta_ad_set_id_update', '101', {ad_set_id: adSetId('101', k)}, {end_time: date(10 + k)}));
  const a = await edit(1),
    b = await edit(2);
  ok(await f.execute(a, {spend_change_confirmed: true}));
  ok(await f.execute(b, {spend_change_confirmed: true}));
  const sent = f.writes();
  // Seven hours later every observation has lapsed, the six-hour ones too.
  f.pass(7 * hour);
  assert.equal(f.live(), 0);
  // A verification every 50 seconds: each one reads back, and none leaves a row.
  for (let i = 0; i < 4; i++) {
    const verified = ok(await f.verify(a));
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data.checks));
    assert.equal(f.live(), 0, 'nothing was written for a write to find (round ' + i + ')');
    assert.equal(f.owned(adSetId('101', 1)), false);
    f.pass(50_000);
  }
  // Neither its target nor the other review's is writable.
  for (const k of [1, 2])
    assertRefused(
      await f.prepare('meta_ad_set_id_update', '101', {ad_set_id: adSetId('101', k)}, {end_time: date(20)}),
      'RESOURCE_SCOPE_REQUIRED',
      {writes: () => f.writes() - sent},
    );
});

test('an execute made right after a verification is refused: the verification left nothing that renews a write', async t => {
  const f = world(t);
  await f.list('adset', 'login', ['101']);
  const edit = end => f.prepare('meta_ad_set_id_update', '101', {ad_set_id: adSetId('101', 1)}, {end_time: date(end)});
  const first = ok(await edit(11));
  ok(await f.execute(first, {spend_change_confirmed: true}));
  // A second change, reviewed while the ad set was owned and not sent.
  const second = ok(await edit(12)),
    sent = f.writes();
  // Every observation lapses (the rows move, not the clock, so the review is still within its five minutes), and the first write is verified.
  f.store.db.prepare('UPDATE resource_ownership SET expires_at=?').run(Date.now() - 1);
  const verified = ok(await f.verify(first));
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data.checks));
  const before = f.requests.length;
  assertRefused(await f.execute(second, {spend_change_confirmed: true}), 'RESOURCE_SCOPE_REQUIRED', {
    writes: () => f.writes() - sent,
  });
  assert.equal(f.requests.length, before, 'nothing was sent after the refusal');
});

test('a plan step gets no help from the verification of an earlier step', async t => {
  const f = world(t),
    x = adSetId('101', 1);
  await f.list('adset', 'login', ['101']);
  const created = ok(
    await f.call('amcp_campaign', {
      action: 'create',
      name: 'Two dates',
      brief: 'Synthetic.',
      steps: [
        step('first', '101', 'meta_ad_set_id_update', {ad_set_id: x}, {end_time: date(11)}),
        {
          ...step('second', '101', 'meta_ad_set_id_update', {ad_set_id: x}, {end_time: date(12)}),
          depends_on: ['first'],
        },
      ],
    }),
  );
  const id = created.data.id,
    prepared = ok(await f.call('amcp_campaign', {action: 'prepare_next', id}));
  ok(
    await f.call('amcp_campaign', {
      ...prepared.data.next_call.arguments,
      ...prepared.data.next_call.add_after_user_approval,
    }),
  );
  const first = f.store.document(tenantId, 'campaign_run', id).steps[0];
  assert.equal(first.status, 'verified', JSON.stringify(first.error));
  // Seven hours on, the first step's review is verified again, and the plan goes on to its second step.
  f.pass(7 * hour);
  const verified = ok(await f.call('amcp_campaign', {action: 'verify', review_id: first.review_id}));
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data.checks));
  const second = await f.call('amcp_campaign', {action: 'prepare_next', id});
  assert.match(JSON.stringify(second), /RESOURCE_SCOPE_REQUIRED/, 'the second step needs the account’s list again');
  assert.equal(f.writes(), 1);
});

test('a creative’s read-back, which keeps five minutes, is renewed the same way: the class does not matter to a verification', async t => {
  const f = world(t);
  await f.edge('meta_ad_account_id_adcreatives_get', '101', 'id,name,account_id');
  const review = ok(
    await f.prepare('meta_creative_id_update', '101', {creative_id: '610101'}, {name: 'Spring carousel v2'}),
  );
  ok(await f.execute(review));
  f.pass(7 * hour);
  const verified = ok(await f.verify(review));
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data.checks));
});

test('an ad set AMCP created is still the account’s six minutes later, so an ad can be created under it', async t => {
  const f = world(t);
  await f.list('campaign', 'login', ['101']);
  const created = ok(
    await f.prepare('meta_adset_create', '101', undefined, {
      name: 'Ad set',
      campaign_id: campaignId('101'),
      status: 'PAUSED',
      daily_budget: 2000,
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'LINK_CLICKS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting: {geo_locations: {countries: ['SA']}},
    }),
  );
  ok(await f.execute(created, {spend_change_confirmed: true}));
  const child = objectsOf(f, 'adset').find(o => o.name === 'Ad set');
  assert.ok(child, 'the ad set was created');
  f.pass(6 * minute);
  ok(
    await f.prepare('meta_ad_create', '101', undefined, {
      name: 'Ad',
      adset_id: child.id,
      creative: {creative_id: '555'},
      status: 'PAUSED',
    }),
  );
});

test('what an account listed lasts six hours for a campaign, an ad set and an ad: usable at 5 h 59 min, not at 6 h 1 min', async t => {
  for (const [kind, id, action, key, payload] of [
    ['ad', adId('101', 1), 'meta_ad_id_update', 'ad_id', {name: 'Ad renamed'}],
    ['adset', adSetId('101', 1), 'meta_ad_set_id_update', 'ad_set_id', {end_time: date(6)}],
    ['campaign', campaignId('101'), 'meta_campaign_id_update', 'campaign_id', {name: 'Campaign renamed'}],
  ]) {
    const inside = world(t);
    await inside.list(kind, 'login', ['101']);
    inside.pass(6 * hour - minute);
    ok(await inside.prepare(action, '101', {[key]: id}, payload));
    const outside = world(t);
    await outside.list(kind, 'login', ['101']);
    outside.pass(6 * hour + minute);
    assertRefused(await outside.prepare(action, '101', {[key]: id}, payload), 'RESOURCE_SCOPE_REQUIRED', {
      writes: () => outside.writes(),
    });
  }
});

// What the window still guards: each of these was refused before, and is now.
test('an id nobody listed or created is refused with the list that settles it, and nothing is sent', async t => {
  const f = world(t),
    refused = await f.prepare('meta_ad_id_update', '101', {ad_id: adId('101', 1)}, {name: 'Renamed'});
  assertRefused(refused, 'RESOURCE_SCOPE_REQUIRED', {writes: () => f.writes()});
  assert.equal(refused.error.details.next_call.arguments.action, 'meta_ad_list');
  assert.equal(f.requests.length, 0);
});

test('an ad another account listed is not this account’s, and another login’s list opens nothing for this one', async t => {
  const f = world(t, {logins: ['login', 'second']});
  await f.list('ad', 'login', ['102']);
  assertRefused(
    await f.prepare('meta_ad_id_update', '101', {ad_id: adId('102', 1)}, {name: 'Renamed'}),
    'RESOURCE_SCOPE_REQUIRED',
  );
  ok(await f.prepare('meta_ad_id_update', '102', {ad_id: adId('102', 1)}, {name: 'Renamed'}));
  await f.list('ad', 'second', ['101']);
  assertRefused(
    await f.prepare('meta_ad_id_update', '101', {ad_id: adId('101', 1)}, {name: 'Renamed'}, 'login'),
    'RESOURCE_SCOPE_REQUIRED',
  );
  ok(await f.prepare('meta_ad_id_update', '101', {ad_id: adId('101', 1)}, {name: 'Renamed'}, 'second'));
});

test('a creative and an audience keep five minutes, and an audience another account shares is never the account’s', async t => {
  const f = world(t);
  await f.edge('meta_ad_account_id_adcreatives_get', '101', 'id,name,account_id');
  await f.edge('meta_ad_account_id_customaudiences_get', '101', 'id,name,account_id,subtype');
  ok(await f.prepare('meta_creative_id_update', '101', {creative_id: '610101'}, {name: 'Renamed'}));
  ok(await f.prepare('meta_custom_audience_id_update', '101', {custom_audience_id: '710101'}, {name: 'Renamed'}));
  assertRefused(
    await f.prepare('meta_custom_audience_id_update', '101', {custom_audience_id: '710999'}, {name: 'Renamed'}),
    'RESOURCE_SCOPE_REQUIRED',
  );
  assert.ok(f.expiry('610101') - Date.now() <= 5 * minute, 'a creative keeps the five minutes');
  f.pass(5 * minute + 1000);
  assertRefused(
    await f.prepare('meta_creative_id_update', '101', {creative_id: '610101'}, {name: 'Renamed again'}),
    'RESOURCE_SCOPE_REQUIRED',
  );
  assertRefused(
    await f.prepare('meta_custom_audience_id_update', '101', {custom_audience_id: '710101'}, {name: 'Renamed again'}),
    'RESOURCE_SCOPE_REQUIRED',
  );
});

test('re-provisioning, any edit of the login and a replaced credential clear every row, and a verification cannot revive them', async t => {
  const f = world(t),
    listed = async () => {
      await f.list('ad', 'login', ['101']);
      assert.equal(f.owned(adId('101', 1)), true);
    };
  await listed();
  f.store.putConnection(owner, f.connections.login, {accessToken: 'synthetic'});
  assert.equal(f.owned(adId('101', 1)), false, 'putConnection');
  assertRefused(
    await f.prepare('meta_ad_id_update', '101', {ad_id: adId('101', 1)}, {name: 'Renamed'}),
    'RESOURCE_SCOPE_REQUIRED',
  );
  await listed();
  f.store.updateConnection(owner, {...f.connections.login, label: 'Renamed login'});
  assert.equal(f.owned(adId('101', 1)), false, 'updateConnection');
  await listed();
  f.store.putConnection(owner, f.connections.login, {accessToken: 'another login'});
  assert.equal(f.owned(adId('101', 1)), false, 'a replaced credential');
  // A write made before the login was re-issued is not verified by a login that has seen nothing since.
  await listed();
  const review = ok(await f.prepare('meta_ad_id_update', '101', {ad_id: adId('101', 1)}, {name: 'Renamed'}));
  ok(await f.execute(review));
  f.store.putConnection(owner, f.connections.login, {accessToken: 'another login'});
  f.pass(7 * hour);
  const verified = ok(await f.verify(review));
  assert.equal(verified.data.status, 'unverified');
  assert.equal(verified.data.checks[0].code, 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(f.owned(adId('101', 1)), false);
});

test('an execute whose observation lapsed is refused: nothing is read again and nothing is written', async t => {
  const f = world(t);
  await f.list('ad', 'login', ['101']);
  const review = ok(await f.prepare('meta_ad_id_update', '101', {ad_id: adId('101', 1)}, {name: 'Renamed'}));
  f.pass(7 * hour);
  const before = f.requests.length;
  assertRefused(await f.execute(review), 'RESOURCE_SCOPE_REQUIRED', {writes: () => f.writes()});
  assert.equal(f.requests.length, before, 'no list read, no retry');
});

// The security review of 2026-11-27 (F4): a replaced credential is another login and clears every row; AMCP's own refresh of the same login's token, and the same credentials
// sealed again, clear nothing (a refresh every hour must not end a six-hour window).
test('replaced credentials clear every row; a token refresh and the same credentials keep them', async t => {
  const f = world(t),
    c = f.connections.login,
    id = adId('101', 1);
  await f.list('ad', 'login', ['101']);
  assert.equal(f.owned(id), true);
  f.store.replaceCredentials(tenantId, c.id, {accessToken: 'synthetic'});
  assert.equal(f.owned(id), true, 'the same credentials are the same login');
  f.store.completeCredentialRefresh(c, {accessToken: 'synthetic'}, {accessToken: 'refreshed'});
  assert.equal(f.owned(id), true, 'a token refresh keeps the login');
  f.store.replaceCredentials(tenantId, c.id, {accessToken: 'another login'});
  assert.equal(f.owned(id), false, 'other credentials are another login');
  assert.equal(f.live(), 0);
  assertRefused(
    await f.prepare('meta_ad_id_update', '101', {ad_id: id}, {name: 'Renamed'}),
    'RESOURCE_SCOPE_REQUIRED',
    {writes: () => f.writes()},
  );
});
test('no observation lasts longer than six hours, whatever a caller asks', async t => {
  const f = world(t);
  f.store.rememberResource(f.connections.login, '101', 'long', 48 * hour);
  const left = f.expiry('long') - Date.now();
  assert.ok(left > 6 * hour - 5000 && left <= 6 * hour, String(left));
});
