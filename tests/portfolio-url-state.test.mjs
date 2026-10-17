// WEB-06 regressions: Portfolio forgot its account and drill-down (no URL state, so Back and reload lost the place),
// printed native micros with no account-currency equivalent ("9007199254740993 budget micros"), and its hand-offs
// opened generic Campaigns and Reports forms that dropped the account and campaign.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

async function fixture(request, {search = '', locale = 'en', writable = true} = {}) {
  const bindings = new Map(),
    nodes = new Map(),
    calls = [],
    pushed = [];
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
  const location = {pathname: '/portfolio', search, hash: ''};
  node('#portfolio-account').elements = {target: {value: '', addEventListener() {}}};
  const context = createContext({
    navigationGeneration: 1,
    identityGeneration: 1,
    URLSearchParams,
    location,
    document: {addEventListener() {}},
    content: node('content'),
    $: node,
    platforms: ['meta', 'google', 'linkedin', 'snapchat', 'tiktok', 'x'].map(id => ({
      id,
      gateway: ['google', 'x'].includes(id) ? id + '_ads_native_action' : id + '_native_action',
      connections: [{id: id + '-login', enabled: true, accounts: ['100'], writeAccounts: writable ? ['100'] : []}],
    })),
    accountLabel: p => p.id,
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    // The shell's address recorder (web/app.js): records a page state without re-rendering it.
    setViewLocation: (url, push) => {
      if (url === location.pathname + location.search) return;
      pushed.push({url, push});
      const [path, query = ''] = url.split('?');
      location.pathname = path;
      location.search = query ? '?' + query : '';
    },
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    pretty: value => JSON.stringify(value, null, 2),
    date: String,
    blank: String,
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    workspaceCall: async (_tool, args) => {
      calls.push(JSON.parse(JSON.stringify(args)));
      return request(args);
    },
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(
    `uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`,
  ).runInContext(context);
  const sharedSource = readFileSync('web/workspace.js', 'utf8');
  new Script(
    sharedSource.slice(
      sharedSource.indexOf('const recordDetails ='),
      sharedSource.indexOf('\nfunction workspaceFormFeedback('),
    ),
  ).runInContext(context);
  const errorSource = readFileSync('web/app.js', 'utf8');
  new Script(
    errorSource.slice(
      errorSource.indexOf('function requestError('),
      errorSource.indexOf("const content = $('#content')"),
    ),
  ).runInContext(context);
  // WEB-07: the Live portfolio page's own module, over the shared helper; it registers its page with the registry.
  for (const file of ['routes.js', 'account-workflows.js', 'portfolio.js'])
    new Script(readFileSync('web/' + file, 'utf8')).runInContext(context);
  await new Script('renderPortfolio()').runInContext(context);
  return {
    context,
    node,
    bindings,
    calls,
    pushed,
    location,
    view: () => node('#portfolio-view').innerHTML,
    choose: index => (node('#portfolio-account').elements.target.value = String(index)),
    submit: () => bindings.get('#portfolio-account')(node('#portfolio-account')),
  };
}
const row = (id, money) => ({
  id,
  name: 'Synthetic ' + id,
  status: 'ACTIVE',
  currency: 'USD',
  timezone: 'UTC',
  ...money,
});
const page = rows => args => ({account_id: args.account_id, rows, has_more: false, captured_at: 1, meaning: 'Native'});

test('drilling down records each level in the address; refresh and next page do not add history entries', async () => {
  const f = await fixture(page([row('10', {budget_micros: '5000000'})]));
  assert.deepEqual(f.calls, [], 'opening the page reads nothing');
  f.choose(1);
  await f.submit();
  assert.deepEqual(f.pushed.at(-1), {
    url: '/portfolio?connection_id=google-login&account_id=100&entity=campaign',
    push: true,
  });
  await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
  assert.deepEqual(f.pushed.at(-1), {
    url: '/portfolio?connection_id=google-login&account_id=100&entity=ad_group&campaign_id=10',
    push: true,
  });
  const count = f.pushed.length;
  await f.bindings.get('#portfolio-refresh')();
  assert.equal(f.pushed.length, count, 'a refresh of the same level keeps its entry');
});

test('a reloaded drill-down address restores the account and level, and reads only after Read inventory', async () => {
  const f = await fixture(page([row('201', {budget_micros: '1'})]), {
    search: '?connection_id=google-login&account_id=100&entity=ad_group&campaign_id=10',
  });
  assert.deepEqual(f.calls, [], 'restoring never reads the provider');
  assert.match(f.node('content').innerHTML, /<option value="1" selected>google<\/option>/);
  assert.match(f.view(), /id="portfolio-restored"/);
  assert.match(f.view(), /Read inventory to reopen Ad Group inventory for this account\. Campaign 10/);
  f.choose(1);
  await f.submit();
  assert.deepEqual(f.calls.at(-1).requirements, {entity: 'ad_group', campaign_id: '10'});
  assert.equal(f.calls.length, 1);
  // Back to the parent level is a new render of the parent address: the campaign level again.
  const parent = await fixture(page([]), {search: '?connection_id=google-login&account_id=100&entity=campaign'});
  parent.choose(1);
  await parent.submit();
  assert.deepEqual(parent.calls.at(-1).requirements, {entity: 'campaign'});
});

test('a restored address the person cannot use is named, not replaced; malformed levels are ignored', async () => {
  const f = await fixture(page([]), {search: '?connection_id=gone&account_id=100&entity=campaign'});
  assert.match(f.node('content').innerHTML, /<option value="" selected>Previously selected account — check access/);
  assert.doesNotMatch(f.view(), /portfolio-restored/);
  const g = await fixture(page([]), {
    search: '?connection_id=google-login&account_id=100&entity=everything&campaign_id=%3Cimg%3E',
  });
  assert.doesNotMatch(g.view(), /portfolio-restored/);
  g.choose(1);
  await g.submit();
  assert.deepEqual(g.calls.at(-1).requirements, {entity: 'campaign'}, 'an unknown level opens the top level');
  // A different account than the restored one opens at its top level.
  const h = await fixture(page([]), {search: '?connection_id=google-login&account_id=100&entity=ad&campaign_id=1'});
  h.choose(0);
  await h.submit();
  assert.deepEqual(h.calls.at(-1).requirements, {entity: 'campaign'});
});

test('Google, Snapchat and X micros show the exact account-currency decimal; Meta and TikTok stay unconverted', async () => {
  for (const locale of ['en', 'ar']) {
    const google = await fixture(page([row('10', {budget_micros: '9007199254740993'})]), {locale});
    google.choose(1);
    await google.submit();
    assert.match(google.view(), /9007199254740993/);
    assert.match(google.view(), /<bdi dir="ltr">9007199254\.740993 USD<\/bdi>/, locale);
    const snap = await fixture(page([row('s1', {native_money: {daily_budget_micro: '1500000', bid_micro: '20'}})]), {
      locale,
    });
    snap.choose(3);
    await snap.submit();
    assert.match(snap.view(), /<bdi dir="ltr">1\.5 USD<\/bdi>/);
    assert.match(snap.view(), /<bdi dir="ltr">0\.00002 USD<\/bdi>/);
    const x = await fixture(page([row('x1', {native_money: {total_budget_amount_local_micro: '-2000000'}})]), {
      locale,
    });
    x.choose(5);
    await x.submit();
    assert.match(x.view(), /<bdi dir="ltr">-2 USD<\/bdi>/);
    for (const index of [0, 4]) {
      const other = await fixture(page([row('m1', {native_money: {daily_budget: '9007199254740993'}})]), {locale});
      other.choose(index);
      await other.submit();
      assert.doesNotMatch(other.view(), /<bdi dir="ltr">/, 'Meta and TikTok units are not documented as micros');
    }
  }
  const malformed = await fixture(page([row('10', {budget_micros: '12.5'})]));
  malformed.choose(1);
  await malformed.submit();
  assert.doesNotMatch(malformed.view(), /<bdi dir="ltr">/, 'a value that is not an integer is not converted');
});

test('row hand-offs preselect the account and campaign; they need write access to clone and read nothing', async () => {
  const f = await fixture(page([row('10&x', {budget_micros: '1'})]));
  f.choose(1);
  await f.submit();
  assert.match(
    f.view(),
    /href="\/campaigns\?clone=1&connection_id=google-login&account_id=100&source_id=10%26x#campaign-clone">Clone into a draft/,
  );
  assert.match(
    f.view(),
    /href="\/reports\?connection_id=google-login&account_id=100&campaign_id=10%26x#report-capture">Capture evidence for this campaign/,
  );
  assert.equal(f.calls.length, 1, 'only the inventory read the person asked for');
  const readOnly = await fixture(page([row('10', {})]), {writable: false});
  readOnly.choose(1);
  await readOnly.submit();
  assert.doesNotMatch(readOnly.view(), /Clone into a draft/);
  assert.match(readOnly.view(), /Capture evidence for this campaign/);
  // Meta has no clone support and X has no evidence capture.
  const meta = await fixture(page([row('10', {})]));
  meta.choose(0);
  await meta.submit();
  assert.doesNotMatch(meta.view(), /Clone into a draft/);
  const x = await fixture(page([row('10', {})]));
  x.choose(5);
  await x.submit();
  assert.doesNotMatch(x.view(), /Capture evidence/);
});
