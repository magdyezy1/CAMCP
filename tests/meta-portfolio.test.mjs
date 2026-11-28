import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {metaPortfolioFields} from '../dist/src/meta-portfolio.js';
import evidence from './fixtures/meta-portfolio-sdk-v26.json' with {type: 'json'};

const gateway = 'meta_native_action';
const actor = {tenantId: 'meta-portfolio', userId: 'reader', role: 'admin'};
const campaign = id => ({
  id,
  name: 'Campaign ' + id,
  account_id: '100',
  status: 'ACTIVE',
  effective_status: 'PAUSED',
  daily_budget: '123456789012345678',
  objective: 'OUTCOME_SALES',
});
const adset = id => ({
  id,
  name: 'Ad set ' + id,
  account_id: '100',
  campaign_id: '10',
  status: 'ACTIVE',
  effective_status: 'CAMPAIGN_PAUSED',
  lifetime_budget: '5000',
  bid_amount: 50,
});
const ad = id => ({
  id,
  name: 'Ad ' + id,
  account_id: '100',
  campaign_id: '10',
  adset_id: '201',
  status: 'ACTIVE',
  effective_status: 'CAMPAIGN_PAUSED',
});
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 46).toString('base64'));
  const connection = {
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    tenantId: actor.tenantId,
    gateway,
    accounts: ['100', '200'],
    enabled: true,
    label: 'Synthetic',
    scopes: ['ads_read'],
  };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  const requests = [];
  let change = body => body;
  const transport = new NativeTransport(
    async (raw, init) => {
      const url = new URL(String(raw));
      assert.equal(init.method, 'GET');
      assert.equal(url.origin, 'https://graph.facebook.com');
      requests.push(url);
      const route = url.pathname.replace(/^\/v\d+\.0/, '');
      let body;
      if (route === '/act_100') body = {id: 'act_100', account_id: '100', currency: 'USD', timezone_name: 'UTC'};
      else if (route === '/act_100/campaigns')
        body = url.searchParams.has('after')
          ? {data: [campaign('30')]}
          : {
              data: [campaign('10'), campaign('20')],
              paging: {
                cursors: {after: 'opaque-next'},
                next: 'https://untrusted.example/never-follow?access_token=not-a-real-token',
              },
            };
      else if (route === '/10') body = campaign('10');
      else if (route === '/10/adsets') body = {data: [adset('201'), adset('202')]};
      else if (route === '/201') body = adset('201');
      else if (route === '/201/ads') body = {data: [ad('301')]};
      else throw Error('Unexpected fixture route ' + route);
      return Response.json(change(body, route, url));
    },
    async () => {},
  );
  const service = new MirrorService(new Registry(), store, transport);
  const call = args =>
    service.call(
      'amcp_workspace',
      {action: 'portfolio', gateway, account_id: '100', connection_id: connection.id, limit: 2, ...args},
      actor,
    );
  return {
    store,
    connection,
    requests,
    call,
    setChange: fn => {
      change = fn;
    },
    close: () => store.close(),
  };
}
const ok = response => {
  assert.equal(response.success, true, JSON.stringify(response));
  return response.data;
};

test('Meta inventory fields and parent edges align with hashed official SDK v26 evidence', () => {
  for (const [name, fields] of Object.entries(metaPortfolioFields))
    for (const field of fields) assert.ok(evidence.models[name].fields.includes(field), name + '.' + field);
  for (const [name, edge] of [
    ['adaccount', '/campaigns'],
    ['campaign', '/adsets'],
    ['adset', '/ads'],
  ]) {
    assert.ok(evidence.models[name].calls.some(c => c.method === 'GET' && c.edge === edge));
    assert.match(evidence.sources[name].sha256, /^[a-f0-9]{64}$/);
  }
});

test('Meta portfolio pages preserve exact money, native effective status and bound opaque continuation', async () => {
  const f = fixture();
  try {
    const first = ok(await f.call({requirements: {entity: 'campaign'}}));
    assert.deepEqual(
      first.rows.map(r => r.id),
      ['10', '20'],
    );
    assert.equal(first.rows[0].status, 'ACTIVE');
    assert.equal(first.rows[0].effective_status, 'PAUSED');
    assert.equal(first.rows[0].native_money.daily_budget, '123456789012345678');
    assert.equal(first.rows[0].currency, 'USD');
    assert.equal(first.has_more, true);
    assert.doesNotMatch(JSON.stringify(first), /untrusted.example|not-a-real-token/);
    const second = ok(await f.call({requirements: {entity: 'campaign'}, cursor: first.next_cursor}));
    assert.deepEqual(
      second.rows.map(r => r.id),
      ['30'],
    );
    assert.equal(second.has_more, false);
    assert.equal(f.requests.at(-1).searchParams.get('after'), 'opaque-next');
    const count = f.requests.length;
    for (const extra of [{account_id: '200'}, {limit: 1}, {requirements: {entity: 'adset', campaign_id: '10'}}]) {
      const r = await f.call({requirements: {entity: 'campaign'}, cursor: first.next_cursor, ...extra});
      assert.equal(r.error?.code, 'INVALID_CURSOR');
    }
    assert.equal(f.requests.length, count);
  } finally {
    f.close();
  }
});

test('Meta campaign to ad sets to ads rechecks native parents and retains exact hierarchy', async () => {
  const f = fixture();
  try {
    ok(await f.call({requirements: {entity: 'campaign'}}));
    const sets = ok(await f.call({requirements: {entity: 'adset', campaign_id: '10'}}));
    assert.deepEqual(
      sets.rows.map(r => r.id),
      ['201', '202'],
    );
    assert.equal(sets.rows[0].campaign_id, '10');
    assert.equal(sets.rows[0].native_money.bid_amount, '50');
    const ads = ok(await f.call({requirements: {entity: 'ad', campaign_id: '10', adset_id: '201'}}));
    assert.equal(ads.rows[0].adset_id, '201');
    assert.equal(ads.rows[0].campaign_id, '10');
    assert.match(ads.meaning, /not.*point.in.time/i);
    assert.ok(f.requests.some(u => u.pathname.endsWith('/10')));
    assert.ok(f.requests.some(u => u.pathname.endsWith('/201')));
    assert.equal(f.requests.filter(u => u.pathname.endsWith('/201/ads')).length, 1);
  } finally {
    f.close();
  }
});

// r25-fr-window (Q22, owner 2026-11-15): a campaign, an ad set and an ad the account shows keep six hours, whichever read showed them. A page of ad sets or ads must not
// leave the store's five minutes on rows an account list had given six hours (the last write wins), nor give its own rows less than a list does.
test('the campaigns an account lists and the ad sets and ads a page returns keep six hours', async () => {
  const f = fixture();
  try {
    ok(await f.call({requirements: {entity: 'campaign'}}));
    ok(await f.call({requirements: {entity: 'adset', campaign_id: '10'}}));
    ok(await f.call({requirements: {entity: 'ad', campaign_id: '10', adset_id: '201'}}));
    const sixHours = 6 * 3600000;
    for (const id of ['10', '201', '202', '301']) {
      const row = f.store.db.prepare('SELECT expires_at FROM resource_ownership WHERE resource=?').get(id),
        left = row.expires_at - Date.now();
      assert.ok(left > sixHours - 5000 && left <= sixHours, id + ' keeps ' + left + ' ms');
    }
  } finally {
    f.close();
  }
});

test('Meta portfolio refuses malformed IDs, amounts, scope, duplicate rows and ambiguous continuation', async () => {
  for (const mutate of [
    b => ({...b, data: [{...b.data[0], id: 9007199254740992}]}),
    b => ({...b, data: [{...b.data[0], account_id: '200'}]}),
    b => ({...b, data: [{...b.data[0], daily_budget: 9007199254740992}]}),
    b => ({...b, data: [b.data[0], b.data[0]]}),
    b => ({...b, data: [...b.data, campaign('30')]}),
    b => ({...b, paging: {next: 'x'}}),
    b => ({...b, paging: {cursors: {after: ''}, next: 'x'}}),
    b => ({...b, paging: []}),
    b => ({...b, data: {}}),
  ]) {
    const f = fixture();
    try {
      f.setChange((b, route) => (route.endsWith('/campaigns') ? mutate(b) : b));
      assert.equal((await f.call({requirements: {entity: 'campaign'}})).error?.code, 'PORTFOLIO_INVALID_RESPONSE');
    } finally {
      f.close();
    }
  }
});

test('Meta portfolio refuses a changed parent before reading children and never records an invalid child page', async () => {
  const f = fixture();
  try {
    ok(await f.call({requirements: {entity: 'campaign'}}));
    f.setChange((b, r) => (r === '/10' ? {...b, account_id: '200'} : b));
    assert.equal(
      (await f.call({requirements: {entity: 'adset', campaign_id: '10'}})).error?.code,
      'STATE_TARGET_MISMATCH',
    );
    assert.equal(
      f.requests.some(u => u.pathname.endsWith('/10/adsets')),
      false,
    );
    f.setChange((b, r) =>
      r === '/10/adsets' ? {...b, data: [adset('201'), {...adset('202'), campaign_id: '20'}]} : b,
    );
    assert.equal(
      (await f.call({requirements: {entity: 'adset', campaign_id: '10'}})).error?.code,
      'STATE_TARGET_MISMATCH',
    );
    assert.equal(f.store.ownsResource(f.connection, '100', '201'), false);
  } finally {
    f.close();
  }
});

test('Meta continuation rejects repeated cursors, overlapping rows and an expired chain', async () => {
  const f = fixture();
  try {
    const first = ok(await f.call({requirements: {entity: 'campaign'}}));
    f.setChange((b, r) =>
      r.endsWith('/campaigns') ? {...b, paging: {cursors: {after: 'opaque-next'}, next: 'x'}} : b,
    );
    assert.equal(
      (await f.call({requirements: {entity: 'campaign'}, cursor: first.next_cursor})).error?.code,
      'PORTFOLIO_INVALID_RESPONSE',
    );
    f.setChange((b, r) => (r.endsWith('/campaigns') ? {data: [campaign('10')]} : b));
    assert.equal(
      (await f.call({requirements: {entity: 'campaign'}, cursor: first.next_cursor})).error?.code,
      'PORTFOLIO_INVALID_RESPONSE',
    );
    const cursor = JSON.parse(Buffer.from(first.next_cursor, 'base64url').toString());
    cursor.expires_at = Date.now() - 1;
    const count = f.requests.length;
    assert.equal(
      (
        await f.call({
          requirements: {entity: 'campaign'},
          cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url'),
        })
      ).error?.code,
      'INVALID_CURSOR',
    );
    assert.equal(f.requests.length, count);
    const originalNow = Date.now;
    try {
      const future = originalNow() + 300001;
      Date.now = () => future;
      assert.equal(
        (await f.call({requirements: {entity: 'campaign'}, cursor: first.next_cursor})).error?.code,
        'INVALID_CURSOR',
      );
    } finally {
      Date.now = originalNow;
    }
    assert.equal(f.requests.length, count);
  } finally {
    f.close();
  }
});

test('Meta parent prerequisites and page size fail before requests; unknown amounts stay null and extra fields are withheld', async () => {
  const f = fixture();
  try {
    for (const args of [
      {limit: 101},
      {requirements: {entity: 'adset', campaign_id: '10'}},
      {requirements: {entity: 'campaign', campaign_id: '10'}},
      {requirements: {entity: 'ad_group'}},
    ])
      assert.equal((await f.call(args)).success, false);
    assert.equal(f.requests.length, 0);
    f.setChange((b, r) =>
      r.endsWith('/campaigns')
        ? {data: [{...campaign('10'), daily_budget: null, private_unrequested_field: 'withhold'}]}
        : b,
    );
    const result = ok(await f.call({requirements: {entity: 'campaign'}}));
    assert.equal(result.rows[0].native_money.daily_budget, null);
    assert.doesNotMatch(JSON.stringify(result), /private_unrequested_field|withhold/);
  } finally {
    f.close();
  }
});

test('explicit foreign account IDs in native collection rows never create an ownership observation', async () => {
  for (const account_id of ['200', null, 100]) {
    const f = fixture();
    try {
      f.setChange((b, r) => (r.endsWith('/campaigns') ? {data: [{...campaign('10'), account_id}]} : b));
      assert.equal((await f.call({requirements: {entity: 'campaign'}})).success, false);
      assert.equal(f.store.ownsResource(f.connection, '100', '10'), false);
    } finally {
      f.close();
    }
  }
});

test('Meta portfolio stops when selected account access or login authorization changes during a read', async () => {
  for (const revoke of ['account', 'credentials']) {
    const f = fixture();
    try {
      f.setChange((b, r) => {
        if (r === '/act_100')
          f.store.putConnection(
            actor,
            {...f.connection, accounts: revoke === 'account' ? ['200'] : ['100']},
            {accessToken: revoke === 'credentials' ? 'changed' : 'synthetic'},
          );
        return b;
      });
      assert.equal((await f.call({requirements: {entity: 'campaign'}})).success, false);
      assert.equal(
        f.requests.some(u => u.pathname.endsWith('/campaigns')),
        false,
      );
    } finally {
      f.close();
    }
  }
});
