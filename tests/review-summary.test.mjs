import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {exactAmount, reviewSummary} from '../dist/src/review-summary.js';
import {googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {campaignStep, createPlan, fixture as snapFixture} from '../dist/tests/snapchat-plan-fixture.js';

/**
 * WRT-05 Stage E: reviews were exact but hard to scan (up to 160 JSON-pointer rows, no headline) and their 5-minute
 * expiry was a static time. Each review now carries a server-authored summary (operation, entity, account, money in
 * account currency with exact decimals, status changes) above the authoritative table; the website counts down to
 * expires_at, disables Execute at zero and prepares again for a new review.
 */
test('exact decimal conversion never rounds', () => {
  assert.equal(exactAmount('100000000', 1000000), '100.00');
  assert.equal(exactAmount(179260000, 1000000), '179.26');
  assert.equal(exactAmount('1', 1000000), '0.000001');
  assert.equal(exactAmount('123456789012345678901', 1000000), '123456789012345.678901');
  assert.equal(exactAmount('12.5', 1), '12.50');
  assert.equal(exactAmount('-3', 1000000), '-0.000003');
  assert.equal(exactAmount('1e6', 1000000), undefined);
  assert.equal(exactAmount('AUTO_BID', 1000000), undefined);
});

test('a Google budget update is summarized with the exact amount in account currency', async () => {
  const f = googleBudgetFixture();
  try {
    const r = await f.update(100000001);
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 600));
    const s = r.data.summary;
    assert.equal(s.operation, 'update');
    assert.equal(s.entity, 'campaign budget');
    assert.equal(s.count, 1);
    // This review reads the budget, not the customer, so the currency is not named rather than guessed.
    assert.equal(s.account.currency, undefined);
    assert.deepEqual(s.money, [
      {field: '/operations/0/update/amountMicros', native: '100000001', native_unit: 'micros', amount: '100.000001'},
    ]);
    assert.match(
      s.text,
      /^Update 1 campaign budget in account 123; amountMicros 100\.000001 in account currency \(100000001 micros\)\.$/,
    );
    // The exact request stays the authority.
    assert.equal(r.data.request.body.operations[0].update.amountMicros, '100000001');
  } finally {
    f.close();
  }
});

test('Snapchat ad squad and ad creates are summarized with exact decimals and their status', () => {
  const state = [{adaccounts: [{adaccount: {id: 'acct1', name: 'Synthetic Company', currency: 'USD'}}]}];
  const squad = reviewSummary(
    {
      gateway: 'snapchat_native_action',
      accountId: 'acct1',
      action: 'snapchat_campaigns_campaign_id_adsquads_create',
      method: 'POST',
      path: '/v1/campaigns/camp1/adsquads',
      body: {adsquads: [{name: 'S', status: 'PAUSED', daily_budget_micro: 179260000, bid_strategy: 'AUTO_BID'}]},
    },
    state,
  );
  assert.equal(squad.operation, 'create');
  assert.equal(squad.entity, 'ad squad');
  assert.equal(squad.account.name, 'Synthetic Company');
  assert.deepEqual(squad.money, [
    {
      field: '/adsquads/0/daily_budget_micro',
      native: 179260000,
      native_unit: 'micros',
      amount: '179.26',
      currency: 'USD',
    },
  ]);
  assert.deepEqual(squad.status, [{field: '/adsquads/0/status', to: 'PAUSED'}]);
  assert.match(squad.text, /Create 1 ad squad in account Synthetic Company \(acct1\); daily_budget_micro 179\.26 USD/);
  const ad = reviewSummary(
    {
      gateway: 'snapchat_native_action',
      accountId: 'acct1',
      action: 'snapchat_adsquads_ad_squad_id_ads_create',
      method: 'POST',
      path: '/v1/adsquads/sq1/ads',
      body: {ads: [{name: 'Ad', status: 'PAUSED', creative_id: 'cr1', type: 'REMOTE_WEBPAGE'}]},
    },
    state,
  );
  assert.deepEqual([ad.operation, ad.entity, ad.count, ad.money], ['create', 'ad', 1, undefined]);
  assert.equal(ad.text, 'Create 1 ad in account Synthetic Company (acct1); status PAUSED.');
});

test('a status change names the current status, and an undocumented unit stays native', () => {
  const s = reviewSummary(
    {
      gateway: 'meta_native_action',
      accountId: '123',
      action: 'meta_campaign_id_update',
      method: 'POST',
      path: '/v26.0/111',
      body: {status: 'PAUSED', daily_budget: '5000'},
    },
    [{id: '111', name: 'Spring', status: 'ACTIVE'}],
  );
  assert.deepEqual(s.status, [{field: '/status', from: 'ACTIVE', to: 'PAUSED'}]);
  assert.deepEqual(s.money, [{field: '/daily_budget', native: '5000'}], 'Meta minor units are not converted');
  assert.match(s.text, /status ACTIVE → PAUSED/);
});

test('an expired plan step prepared again gets a new review and says nothing changed', async () => {
  const f = snapFixture();
  try {
    const id = (await createPlan(f, [campaignStep()])).data.id;
    const first = await f.call('amcp_campaign', {action: 'prepare_next', id});
    assert.equal(first.success, true, JSON.stringify(first).slice(0, 800));
    assert.equal(first.data.review.summary.operation, 'create');
    const run = f.store.document('snap-plan', 'campaign_run', id);
    run.steps[0].review.expires_at = new Date(Date.now() - 1000).toISOString();
    f.store.putDocument('snap-plan', 'campaign_run', id, run);
    const again = await f.call('amcp_campaign', {action: 'prepare_next', id});
    assert.equal(again.success, true, JSON.stringify(again).slice(0, 800));
    assert.notEqual(again.data.review.review_id, first.data.review.review_id);
    assert.equal(again.data.review.unchanged_since_review, first.data.review.review_id);
    assert.equal(f.writes.length, 0);
  } finally {
    f.close();
  }
});

test('the review countdown disables Execute at zero and offers Prepare again', () => {
  const nodes = new Map(),
    bindings = new Map(),
    intervals = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {checked: false, innerHTML: '', textContent: '', hidden: true, disabled: false});
    return nodes.get(id);
  };
  let now = Date.UTC(2026, 9, 9, 12);
  const context = createContext({
    document: {addEventListener() {}},
    $: id => node(id),
    Object,
    JSON,
    String,
    Number,
    Math,
    Date: Object.assign(function () {}, {now: () => now, parse: Date.parse, UTC: Date.UTC}),
    encodeURIComponent,
    esc: value => String(value ?? ''),
    badge: String,
    date: String,
    blank: String,
    recordDetails: () => '',
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    setInterval: fn => intervals.push(fn) && intervals.length,
    clearInterval: () => {},
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/campaign-workflows.js', 'utf8')).runInContext(context);
  context.review = {
    expires_at: new Date(now + 65000).toISOString(),
    request: {action: 'x'},
    summary: {
      operation: 'update',
      entity: 'campaign budget',
      count: 1,
      account: {id: '123'},
      money: [{field: '/amountMicros', native: '1', native_unit: 'micros', amount: '0.000001', currency: 'USD'}],
    },
  };
  const html = new Script('readableReview(review, "Execute")').runInContext(context);
  assert.match(html, /id="review-countdown"/);
  assert.match(html, /0\.000001 USD · 1 micros/);
  assert.match(html, /id="prepare-again"/);
  let prepared = 0;
  context.again = () => prepared++;
  new Script('bindReviewCountdown(review, again)').runInContext(context);
  assert.equal(node('#review-countdown').textContent, 'Expires in 1:05');
  assert.equal(node('#execute-reviewed').disabled, false);
  now += 65000;
  intervals[0]();
  assert.equal(node('#review-countdown').textContent, 'This review expired. Nothing was sent.');
  assert.equal(node('#execute-reviewed').disabled, true);
  assert.equal(node('#review-expired').hidden, false);
  bindings.get('#prepare-again')();
  assert.equal(prepared, 1);
});
