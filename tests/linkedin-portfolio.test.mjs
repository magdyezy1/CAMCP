import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
const gateway = 'linkedin_native_action',
  account = 'urn:li:sponsoredAccount:100';
const group = id => ({
  id,
  account,
  name: 'Group ' + id,
  status: 'ACTIVE',
  totalBudget: {amount: '123456789012345678.90', currencyCode: 'USD'},
  createdBy: 'PRIVATE-PERSON',
});
const campaign = id => ({
  id,
  account,
  name: 'Campaign ' + id,
  campaignGroup: 'urn:li:sponsoredCampaignGroup:10',
  status: 'PAUSED',
  dailyBudget: {amount: '80.25', currencyCode: 'USD'},
  unitCost: {amount: '0.50', currencyCode: 'USD'},
  objectiveType: 'WEBSITE_VISIT',
});
const creative = id => ({
  id: 'urn:li:sponsoredCreative:' + id,
  account,
  campaign: 'urn:li:sponsoredCampaign:201',
  name: 'Creative ' + id,
  intendedStatus: 'ACTIVE',
  isServing: false,
  servingHoldReasons: ['CAMPAIGN_STOPPED'],
  content: {reference: 'PRIVATE-CONTENT'},
  createdBy: 'PRIVATE-PERSON',
});
function fixture(t) {
  const actor = {tenantId: 'linkedin-portfolio', userId: 'reader', role: 'reader'},
    store = new Store(':memory:', Buffer.alloc(32, 96).toString('base64'));
  t.after(() => store.close());
  const connection = {
    id: 'cccccccc-1111-4111-8111-111111111111',
    tenantId: actor.tenantId,
    gateway,
    accounts: ['100', '200'],
    scopes: ['r_ads'],
    enabled: true,
    label: 'Synthetic',
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  const requests = [];
  let change = body => body;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (raw, init) => {
        const url = new URL(String(raw));
        assert.equal(init.method, 'GET');
        assert.equal(url.origin, 'https://api.linkedin.com');
        requests.push({url, init});
        let body;
        const route = url.pathname.replace('/rest/adAccounts/100', '');
        if (route === '') body = {id: 100, currency: 'USD', name: 'Account'};
        else if (route === '/adCampaignGroups')
          body = url.searchParams.has('pageToken')
            ? {elements: [group('30')], metadata: {nextPageToken: null}}
            : {elements: [group('10'), group('20')], metadata: {nextPageToken: 'opaque-next'}};
        else if (route === '/adCampaignGroups/10') body = group('10');
        else if (route === '/adCampaigns') body = {elements: [campaign('201')], metadata: {}};
        else if (route === '/adCampaigns/201') body = campaign('201');
        else if (route === '/creatives') body = {elements: [creative('301')], metadata: {}};
        else throw Error('Unexpected fixture request ' + route);
        return Response.json(change(body, route, url));
      },
      async () => {},
    ),
  );
  const call = (input = {}, user = actor) =>
    service.call(
      'amcp_workspace',
      {action: 'portfolio', gateway, account_id: '100', connection_id: connection.id, limit: 2, ...input},
      user,
    );
  return {
    actor,
    store,
    connection,
    requests,
    call,
    setChange: f => {
      change = f;
    },
  };
}
function ok(r) {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
}
test('LinkedIn portfolio reads exact native groups and cursor pages with unconverted money and bounded fields', async t => {
  const f = fixture(t),
    first = ok(await f.call());
  assert.equal(first.entity, 'campaign_group');
  assert.deepEqual(
    first.rows.map(r => r.id),
    ['10', '20'],
  );
  assert.equal(first.rows[0].native_money.totalBudget.amount, '123456789012345678.90');
  assert.equal(first.rows[0].currency, 'USD');
  assert.equal(first.rows[0].timezone, null);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE-|createdBy|accessToken/);
  const list = f.requests.at(-1).url;
  assert.equal(list.searchParams.get('q'), 'search');
  assert.equal(list.searchParams.get('pageSize'), '2');
  assert.equal(list.searchParams.get('sortOrder'), 'ASCENDING');
  assert.match(list.searchParams.get('search'), /PENDING_DELETION/);
  assert.equal(list.searchParams.has('start'), false);
  assert.equal(list.searchParams.has('count'), false);
  assert.match(new Headers(f.requests[0].init.headers).get('LinkedIn-Version') ?? '', /^202609$/);
  const next = ok(await f.call({cursor: first.next_cursor}));
  assert.deepEqual(
    next.rows.map(r => r.id),
    ['30'],
  );
  assert.equal(next.has_more, false);
  assert.equal(f.requests.at(-1).url.searchParams.get('pageToken'), 'opaque-next');
});
test('LinkedIn group-campaign-creative navigation rechecks exact account and parent relationships', async t => {
  const f = fixture(t);
  ok(await f.call());
  const campaigns = ok(await f.call({requirements: {entity: 'campaign', campaign_group_id: '10'}}));
  assert.equal(campaigns.rows[0].campaign_group_id, '10');
  assert.equal(campaigns.rows[0].status, 'PAUSED');
  assert.match(f.requests.at(-1).url.searchParams.get('search'), /campaignGroup/);
  const ads = ok(await f.call({requirements: {entity: 'creative', campaign_group_id: '10', campaign_id: '201'}}));
  assert.equal(ads.rows[0].id, '301');
  assert.equal(ads.rows[0].resource_name, 'urn:li:sponsoredCreative:301');
  assert.equal(ads.rows[0].status, 'ACTIVE');
  assert.equal(ads.rows[0].is_serving, false);
  assert.deepEqual(ads.rows[0].serving_hold_reasons, ['CAMPAIGN_STOPPED']);
  assert.match(f.requests.at(-1).url.searchParams.get('campaigns'), /sponsoredCampaign/);
  assert.equal(f.requests.at(-1).url.searchParams.get('q'), 'criteria');
  assert.doesNotMatch(JSON.stringify(ads), /PRIVATE-|content/);
});
test('LinkedIn prerequisites and malformed entity/filter requests fail before any provider request', async t => {
  const f = fixture(t);
  for (const input of [
    {requirements: {entity: 'campaign', campaign_group_id: '10'}},
    {requirements: {entity: 'creative', campaign_group_id: '10', campaign_id: '201'}},
    {requirements: {entity: 'ad'}},
    {requirements: {entity: 'campaign_group', campaign_id: '201'}},
    {requirements: {entity: 'campaign', campaign_group_id: '10', extra: true}},
    {limit: 0},
    {limit: 101},
    {account_id: 'not-an-id'},
  ])
    assert.equal((await f.call(input)).success, false, JSON.stringify(input));
  assert.equal(f.requests.length, 0);
});
test('LinkedIn cursors reject tampering, changed account/actor/page size and reauthorization before requests', async t => {
  const f = fixture(t),
    page = ok(await f.call()),
    n = f.requests.length;
  for (const input of [
    {cursor: page.next_cursor + 'x'},
    {cursor: page.next_cursor, limit: 3},
    {cursor: page.next_cursor, account_id: '200'},
  ])
    assert.equal((await f.call(input)).success, false, JSON.stringify(input));
  assert.equal((await f.call({cursor: page.next_cursor}, {...f.actor, userId: 'other'})).success, false);
  assert.equal(f.requests.length, n);
  f.store.putConnection({...f.actor, role: 'admin'}, f.connection, {accessToken: 'replacement'});
  assert.equal((await f.call({cursor: page.next_cursor})).success, false);
  assert.equal(f.requests.length, n);
});
test('LinkedIn rejects foreign, repeated, unordered and inexact inventory without recording parent observations', async t => {
  for (const mutate of [
    rows => {
      rows[0].account = 'urn:li:sponsoredAccount:200';
    },
    rows => {
      rows[1].id = rows[0].id;
    },
    rows => rows.reverse(),
    rows => {
      rows[0].id = 9007199254740992;
    },
    rows => {
      rows[0].totalBudget.amount = 0.1;
    },
    rows => {
      rows[0].totalBudget.currencyCode = 'EUR';
    },
  ]) {
    const f = fixture(t);
    f.setChange((body, route) => {
      if (route === '/adCampaignGroups') mutate(body.elements);
      return body;
    });
    assert.equal((await f.call()).success, false);
    const n = f.requests.length;
    assert.equal((await f.call({requirements: {entity: 'campaign', campaign_group_id: '10'}})).success, false);
    assert.equal(f.requests.length, n);
  }
});
test('LinkedIn continuation metadata is bounded, loop-free and retains strict cross-page order', async t => {
  for (const update of [
    body => {
      body.metadata = [];
    },
    body => {
      body.metadata.nextPageToken = '';
    },
    body => {
      body.metadata.nextPageToken = 'x'.repeat(4097);
    },
    body => {
      body.elements.push(group('40'));
    },
    body => {
      body.paging = {start: 0, count: 2, total: 9};
    },
  ]) {
    const f = fixture(t);
    f.setChange((body, route) => {
      if (route === '/adCampaignGroups') update(body);
      return body;
    });
    assert.equal((await f.call()).success, false);
  }
  for (const mode of ['loop', 'repeat']) {
    const f = fixture(t),
      page = ok(await f.call());
    f.setChange((body, route) => {
      if (route === '/adCampaignGroups') {
        if (mode === 'loop') body.metadata.nextPageToken = 'opaque-next';
        else body.elements = [group('10')];
      }
      return body;
    });
    assert.equal((await f.call({cursor: page.next_cursor})).success, false);
  }
  const empty = fixture(t);
  empty.setChange((body, route) => (route === '/adCampaignGroups' ? {elements: [], metadata: {}} : body));
  const r = ok(await empty.call());
  assert.equal(r.rows.length, 0);
  assert.equal(r.has_more, false);
});
test('LinkedIn stops after current authority withdrawal and refuses changed parent ownership', async t => {
  const f = fixture(t);
  ok(await f.call());
  f.setChange((body, route) => {
    if (route === '/adCampaignGroups/10') body.account = 'urn:li:sponsoredAccount:200';
    return body;
  });
  assert.equal((await f.call({requirements: {entity: 'campaign', campaign_group_id: '10'}})).success, false);
  assert.equal(f.requests.at(-1).url.pathname.endsWith('/adCampaignGroups/10'), true);
  const g = fixture(t);
  g.setChange((body, route) => {
    if (route === '')
      g.store.putConnection({...g.actor, role: 'admin'}, {...g.connection, enabled: false}, {accessToken: 'synthetic'});
    return body;
  });
  assert.equal((await g.call()).success, false);
  assert.equal(g.requests.length, 1);
});
