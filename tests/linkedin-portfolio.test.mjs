import test from 'node:test';
import assert from 'node:assert/strict';
import {
  linkedinPortfolioFixture as fixture,
  linkedinPortfolioGateway as gateway,
  linkedinPortfolioGroup as group,
} from './fixtures/linkedin-portfolio-data.mjs';
function ok(r) {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
}

test('LinkedIn portfolio retains dynamic group daily money and identifies shared controls for current child campaigns', async t => {
  const f = fixture(t);
  f.setChange((body, route) => {
    const dynamic = row => ({
      ...row,
      dailyBudget: {amount: '90.000001', currencyCode: 'USD'},
      budgetOptimization: {
        budgetOptimizationStrategy: 'DYNAMIC',
        bidStrategy: 'MAX_DELIVERY',
        unrelatedPrivate: 'PRIVATE-POLICY',
      },
    });
    if (route === '/adCampaignGroups') body.elements = body.elements.map(dynamic);
    if (route === '/adCampaignGroups/10') return dynamic(body);
    return body;
  });
  const groups = ok(await f.call());
  assert.deepEqual(groups.rows[0].native_money.dailyBudget, {amount: '90.000001', currencyCode: 'USD'});
  assert.equal(groups.rows[0].budget_context.mode, 'group_dynamic');
  const children = ok(await f.call({requirements: {entity: 'campaign', campaign_group_id: '10'}}));
  assert.equal(children.rows[0].budget_context.mode, 'group_dynamic');
  assert.equal(children.rows[0].budget_context.group_id, '10');
  assert.deepEqual(children.rows[0].budget_context.group_daily_budget, {amount: '90.000001', currencyCode: 'USD'});
  assert.equal(children.rows[0].native_money.dailyBudget.amount, '80.25');
  assert.doesNotMatch(JSON.stringify({groups, children}), /PRIVATE-POLICY|PRIVATE-PERSON/);
  assert.ok(f.requests.every(r => r.init.method === 'GET'));
});

test('LinkedIn inventory distinguishes observed campaign daily budgets from lifetime, ambiguous and future group modes', async t => {
  for (const mode of ['daily', 'total', 'mixed', 'pacing', 'future-group', 'ambiguous-group']) {
    const f = fixture(t);
    ok(await f.call());
    f.setChange((body, route) => {
      if (route === '/adCampaignGroups/10') {
        if (mode === 'future-group') body.budgetOptimization = {budgetOptimizationStrategy: 'FUTURE'};
        if (mode === 'ambiguous-group') body.dailyBudget = {amount: '40', currencyCode: 'USD'};
      }
      if (route === '/adCampaigns')
        for (const row of body.elements) {
          if (mode === 'total') {
            delete row.dailyBudget;
            row.totalBudget = {amount: '2000', currencyCode: 'USD'};
          }
          if (mode === 'mixed') row.totalBudget = {amount: '2000', currencyCode: 'USD'};
          if (mode === 'pacing') row.pacingStrategy = 'LIFETIME';
        }
      return body;
    });
    const out = ok(await f.call({requirements: {entity: 'campaign', campaign_group_id: '10'}}));
    assert.equal(
      out.rows[0].budget_context.mode,
      mode === 'daily'
        ? 'campaign_daily'
        : mode === 'total'
          ? 'campaign_total'
          : mode === 'mixed'
            ? 'campaign_daily_and_total'
            : 'unknown',
      mode,
    );
    assert.ok(f.requests.every(r => r.init.method === 'GET'));
  }
});

test('malformed or foreign group daily money is refused instead of silently omitted', async t => {
  for (const money of [
    {amount: '80', currencyCode: 'EUR'},
    {amount: 0.1, currencyCode: 'USD'},
  ]) {
    const f = fixture(t);
    f.setChange((body, route) => {
      if (route === '/adCampaignGroups') body.elements[0].dailyBudget = money;
      return body;
    });
    assert.equal((await f.call()).success, false);
    assert.equal(f.store.ownsResource(f.connection, '100', 'portfolio/linkedin/campaign_group/10'), false);
  }
});
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
