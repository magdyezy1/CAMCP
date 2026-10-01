import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

async function fixture(request) {
  const bindings = new Map(),
    events = new Map(),
    nodes = new Map(),
    calls = [];
  const node = key => {
    if (!nodes.has(key))
      nodes.set(key, {
        innerHTML: '',
        isConnected: true,
        attributes: {},
        focus() {
          this.focused = true;
        },
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
      });
    return nodes.get(key);
  };
  node('#portfolio-account').elements = {target: {value: '0', addEventListener: (event, fn) => events.set(event, fn)}};
  const context = createContext({
    navigationGeneration: 1,
    identityGeneration: 1,
    content: node('content'),
    $: node,
    platforms: ['meta', 'google'].map(id => ({
      id,
      gateway: id === 'meta' ? 'meta_native_action' : 'google_ads_native_action',
      connections: [{id: id + '-login', enabled: true, accounts: ['100']}],
    })),
    accountLabel: p => p.id,
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    esc: String,
    pretty: String,
    date: String,
    blank: String,
    recordDetails: JSON.stringify,
    workspaceCall: async (_tool, args) => {
      calls.push(args);
      return request(args);
    },
  });
  new Script(readFileSync('web/account-workflows.js', 'utf8')).runInContext(context);
  await new Script('renderPortfolio()').runInContext(context);
  return {
    context,
    nodes,
    node,
    bindings,
    events,
    calls,
    submit: () => bindings.get('#portfolio-account')(node('#portfolio-account')),
  };
}
const page = args => ({
  account_id: args.account_id,
  rows: [
    {
      id: args.requirements.entity === 'campaign' ? '10' : '201',
      name: 'Synthetic',
      status: 'ACTIVE',
      effective_status: 'CAMPAIGN_PAUSED',
      native_money: {daily_budget: '9007199254740993'},
      currency: 'USD',
      timezone: 'UTC',
      native: {id: '10'},
    },
  ],
  has_more: true,
  next_cursor: 'cursor',
  captured_at: 1,
  meaning: 'Native inventory',
});

test('portfolio navigation keeps native Meta hierarchy, money, effective state and cursor in the chosen account', async () => {
  const f = await fixture(async args => page(args));
  await f.submit();
  assert.match(f.node('#portfolio-view').innerHTML, /9007199254740993/);
  assert.match(f.node('#portfolio-view').innerHTML, /Effective: CAMPAIGN_PAUSED/);
  assert.doesNotMatch(f.node('#portfolio-view').innerHTML, /undefined budget micros/);
  assert.equal(f.node('#portfolio-heading').focused, true);
  await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1).requirements)), {entity: 'adset', campaign_id: '10'});
  await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1).requirements)), {
    entity: 'ad',
    campaign_id: '10',
    adset_id: '201',
  });
  await f.bindings.get('#portfolio-next')();
  assert.equal(f.calls.at(-1).cursor, 'cursor');
  await f.bindings.get('#portfolio-refresh')();
  assert.equal(f.calls.at(-1).cursor, undefined);
  assert.ok(f.calls.every(c => c.connection_id === 'meta-login' && c.account_id === '100'));
});

test('portfolio results and errors cannot repaint a newer selection, route, identity or detached view', async () => {
  for (const change of ['selection', 'navigationGeneration', 'identityGeneration', 'detach']) {
    for (const reject of [false, true]) {
      let finish;
      const f = await fixture(
        args =>
          new Promise((resolve, fail) => {
            finish = () => (reject ? fail(Error('Old failure')) : resolve(page(args)));
          }),
      );
      const pending = f.submit();
      if (change === 'selection') f.events.get('change')();
      else if (change === 'detach') f.node('#portfolio-view').isConnected = false;
      else f.context[change]++;
      f.node('#portfolio-view').innerHTML = 'Current page';
      finish();
      await pending;
      assert.equal(f.node('#portfolio-view').innerHTML, 'Current page');
      assert.equal(f.bindings.has('#portfolio-next'), false);
    }
  }
});

test('Google portfolio keeps ad_group and ad_group_id while a newer read supersedes an older read', async () => {
  let old;
  const f = await fixture(args =>
    f.calls.length === 1
      ? new Promise(resolve => {
          old = () => resolve(page(args));
        })
      : Promise.resolve(page(args)),
  );
  const stale = f.submit();
  f.node('#portfolio-account').elements.target.value = '1';
  f.events.get('change')();
  await f.submit();
  old();
  await stale;
  assert.match(f.node('#portfolio-view').innerHTML, /Google Ads/);
  await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
  assert.equal(f.calls.at(-1).requirements.entity, 'ad_group');
  await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
  assert.equal(f.calls.at(-1).requirements.ad_group_id, '201');
  assert.equal(f.calls.at(-1).requirements.adset_id, undefined);
});
