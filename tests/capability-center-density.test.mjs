// WEB-08: Capabilities density. Before it, /capabilities fetched the whole graph twice on load (the filter choices and
// page 1, about 296 KB each), listed every workflow card flat (56 cards, 47 with no matching account) and dropped the
// search from the address. These tests render the real capability graph of a synthetic workspace (no provider
// request) and guard one graph request on load, the "Available to me" default with a collapsed "Not available yet"
// group, objective and platform grouping, and filters that persist in the address.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const tenantId = 'capability-density',
  admin = {tenantId, userId: 'owner', role: 'admin'},
  catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  operations = readFileSync('web/operations-center.js', 'utf8'),
  pager = operations.slice(
    operations.indexOf('function workPageLoader('),
    operations.indexOf('// Only these authored AMCP instructions'),
  ),
  esc = value =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');

/** A workspace with one Google Ads and one Meta account selected; every provider request is refused. */
function workspace() {
  const store = new Store(':memory:', Buffer.alloc(32, 41).toString('base64')),
    egress = [];
  const transport = new NativeTransport(
    async input => {
      egress.push(String(input));
      throw Error('No provider request is expected');
    },
    async () => {},
  );
  const service = new MirrorService(new Registry(), store, transport, undefined, {allowWrites: true});
  for (const [id, gateway, account] of [
    ['google-login', 'google_ads_native_action', '100'],
    ['meta-login', 'meta_native_action', '200'],
  ])
    store.putConnection(
      admin,
      {id, tenantId, gateway, accounts: [account], writeAccounts: [account], enabled: true, label: id, scopes: []},
      {accessToken: 'synthetic-' + id},
    );
  const call = async input => {
    const r = await service.call('amcp_workspace', input, admin);
    if (!r.success) throw Object.assign(Error(r.error.message), {code: r.error.code});
    return r.data;
  };
  return {store, egress, call};
}

const selected = (html, name) => {
  const options = new RegExp(`<select name="${name}">([\\s\\S]*?)</select>`).exec(html)?.[1] ?? '';
  return /<option value="([^"]*)" selected>/.exec(options)?.[1] ?? '';
};

/** capability-center.js on a synthetic /capabilities page whose workspace calls reach the real service in-process. */
async function capabilityPage(ws, {search = '', locale = 'en'} = {}) {
  const requests = [],
    addresses = [],
    bindings = new Map(),
    root = () => ({
      innerHTML: '',
      status: {textContent: ''},
      isConnected: true,
      setAttribute() {},
      querySelector(selector) {
        return selector === '[data-page-status]' ? this.status : null;
      },
      querySelectorAll() {
        return [];
      },
    }),
    nodes = {'#capability-results': root(), '#contract-results': root()},
    location = {pathname: '/capabilities', search, href: 'https://amcp.example/capabilities' + search};
  let form;
  const context = createContext({
    Intl,
    Date,
    JSON,
    URL,
    URLSearchParams,
    document: {addEventListener() {}, querySelectorAll: () => []},
    location,
    history: {
      replaceState(state, title, url) {
        const next = new URL(String(url));
        addresses.push(next.search);
        location.search = next.search;
        location.href = next.href;
      },
    },
    navigationGeneration: 1,
    identityGeneration: 1,
    content: {innerHTML: '<div class="page-heading"><h1>Capabilities</h1></div>'},
    esc,
    pretty: String,
    date: () => 'Synthetic date',
    badge: (value, label) => `<span data-state="${esc(value)}">${esc(label ?? value)}</span>`,
    recordDetails: () => '',
    errorMessage: e => e.message,
    Option: function (text, value, defaultSelected, isSelected) {
      return {text, value, selected: isSelected};
    },
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    workspaceCall: async (tool, input) => {
      assert.equal(tool, 'workspace');
      requests.push(structuredClone(input));
      return ws.call(input);
    },
    $: selector => {
      if (selector === '#capability-filter' || selector === '#contract-filter') {
        if (selector === '#contract-filter') return {elements: {search: {value: ''}, gateway: {value: ''}}};
        if (form) return form;
        const html = context.content.innerHTML,
          pick = name => ({
            value: selected(html, name),
            add(option) {
              if (option.selected) this.value = option.value;
            },
          });
        form = {
          elements: {
            workflow_id: pick('workflow_id'),
            target: pick('target'),
            search: {
              value: /<input name="search" type="search" maxlength="200" value="([^"]*)">/.exec(html)?.[1] ?? '',
            },
          },
        };
        return form;
      }
      return nodes[selector];
    },
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  context.catalog = catalog;
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(pager);
  run(readFileSync('web/capability-center.js', 'utf8'));
  await run('renderCapabilityCenter()');
  return {
    context,
    run,
    requests,
    addresses,
    graphRequests: () => requests.filter(r => r.action === 'capabilities'),
    results: () => nodes['#capability-results'].innerHTML,
    status: () => nodes['#capability-results'].status.textContent,
    form: () => form,
    submit: () => bindings.get('#capability-filter')(),
  };
}
const linked = (html, id) => html.indexOf(`href="/capabilities?workflow_id=${encodeURIComponent(id)}"`);

test('Capabilities loads with one graph request and shows available workflows first, the rest collapsed', async () => {
  const ws = workspace();
  try {
    const page = await capabilityPage(ws),
      graph = await ws.call({action: 'capabilities', view: 'graph'}),
      html = page.results(),
      available = graph.workflows.filter(w => w.accounts.length),
      later = graph.workflows.filter(w => !w.accounts.length);
    assert.equal(page.graphRequests().length, 1, 'the filter choices and page 1 share one graph request');
    assert.deepEqual(page.graphRequests()[0], {action: 'capabilities', view: 'graph'});
    assert.ok(available.length > 0 && later.length > available.length, 'the fixture has both groups');
    assert.ok(html.includes(`Available to me (${available.length})`));
    const fold = html.indexOf('<details class="capability-unavailable"><summary>');
    assert.ok(fold > 0, 'unavailable workflows stay discoverable in a collapsed group');
    assert.doesNotMatch(html, /<details class="capability-unavailable" open/);
    assert.ok(html.includes(`Not available yet (${later.length})</summary>`));
    for (const w of available) assert.ok(linked(html, w.id) > 0 && linked(html, w.id) < fold, w.id + ' is available');
    for (const w of later) assert.ok(linked(html, w.id) > fold, w.id + ' is folded');
    // Grouped by objective with counts; each group names its platforms with their counts.
    const groups = [...html.slice(0, fold).matchAll(/<section class="capability-group"><h4>([^<]+)<\/h4>/g)].map(
      m => m[1],
    );
    const objectives = new Set(available.map(w => w.objective));
    assert.equal(groups.length, objectives.size);
    assert.equal(
      groups.reduce((sum, heading) => sum + Number(/\((\d+)\)$/.exec(heading)[1]), 0),
      available.length,
    );
    assert.match(html, /<p class="form-note"><bdi>[^<]+<\/bdi> \d+/);
    assert.deepEqual(ws.egress, [], 'no provider request');
  } finally {
    ws.store.close();
  }
});

test('the Arabic page names both groups in Arabic and keeps native identifiers literal', async () => {
  const ws = workspace();
  try {
    const page = await capabilityPage(ws, {locale: 'ar'}),
      html = page.results(),
      graph = await ws.call({action: 'capabilities', view: 'graph'}),
      available = graph.workflows.filter(w => w.accounts.length).length;
    assert.equal(page.graphRequests().length, 1);
    assert.ok(html.includes(catalog['Available to me ({count})'].replace('{count}', available)), 'available heading');
    assert.ok(
      html.includes(catalog['Not available yet ({count})'].replace('{count}', graph.workflows.length - available)),
      'folded heading',
    );
    assert.ok(
      html.includes(
        catalog[
          'These workflows have no selected account on their platform. Connect a login and select an account in Connections to use them.'
        ],
      ),
    );
    assert.match(html, /workflow_id=recipe%3Agoogle_search/);
  } finally {
    ws.store.close();
  }
});

test('filters persist in the address, and a shared link reloads the same view with one request', async () => {
  const ws = workspace();
  try {
    const page = await capabilityPage(ws);
    assert.equal(page.addresses.at(-1), '', 'no filter, no query');
    // Search and an account: the address keeps all three, and the account view is asked of the server, which
    // resolves account-scoped prerequisites only when one account is in view.
    page.form().elements.search.value = 'traffic';
    const targets = [
      ...new Map(
        (await ws.call({action: 'capabilities', view: 'graph'})).workflows.flatMap(w =>
          w.accounts.map(a => [a.connection_id + '\0' + a.account_id, a]),
        ),
      ).values(),
    ];
    page.form().elements.target.value = String(targets.findIndex(a => a.connection_id === 'meta-login'));
    await page.submit();
    const address = new URLSearchParams(page.addresses.at(-1));
    assert.equal(address.get('search'), 'traffic');
    assert.equal(address.get('connection_id'), 'meta-login');
    assert.equal(address.get('account_id'), '200');
    assert.deepEqual(page.graphRequests().at(-1), {
      action: 'capabilities',
      view: 'graph',
      connection_id: 'meta-login',
      account_id: '200',
    });
    assert.match(page.results(), /Meta website traffic|meta_website_traffic/);
    assert.doesNotMatch(page.results(), /recipe%3Agoogle_search/);

    // A shared link with a search and a workflow restores both and still loads with one graph request.
    const shared = await capabilityPage(ws, {search: '?workflow_id=recipe%3Ameta_website_traffic&search=traffic'});
    assert.equal(shared.graphRequests().length, 1);
    assert.equal(shared.form().elements.search.value, 'traffic');
    assert.equal(shared.form().elements.workflow_id.value, 'recipe:meta_website_traffic');
    assert.equal(shared.addresses.at(-1), '?workflow_id=recipe%3Ameta_website_traffic&search=traffic');
    assert.equal(linked(shared.results(), 'recipe:meta_website_traffic') > 0, true);
    assert.doesNotMatch(shared.results(), /capability-unavailable|Available to me/, 'an exact workflow shows as it is');
  } finally {
    ws.store.close();
  }
});

test('page 1 from the shared graph equals the server answer; account and unknown-workflow links still ask it', async () => {
  const ws = workspace();
  try {
    const page = await capabilityPage(ws),
      graph = await ws.call({action: 'capabilities', view: 'graph'});
    for (const workflow_id of ['recipe:meta_website_traffic', 'report:google', 'media:meta']) {
      page.context.input = {graph, filters: {workflow_id}};
      const local = page.run('capabilityLocalSelection(input.graph, input.filters)'),
        server = await ws.call({action: 'capabilities', view: 'graph', workflow_id});
      assert.deepEqual(local.workflows, server.workflows, workflow_id);
    }
    page.context.input = {graph, filters: {connection_id: 'meta-login', account_id: '200'}};
    assert.equal(page.run('capabilityLocalSelection(input.graph, input.filters)'), null);
    page.context.input = {graph, filters: {workflow_id: 'recipe:not-listed'}};
    assert.equal(page.run('capabilityLocalSelection(input.graph, input.filters)'), null);

    const account = await capabilityPage(ws, {search: '?connection_id=meta-login&account_id=200'});
    assert.equal(account.graphRequests().length, 2);
    assert.deepEqual(account.graphRequests()[1], {
      action: 'capabilities',
      view: 'graph',
      connection_id: 'meta-login',
      account_id: '200',
    });
    const unknown = await capabilityPage(ws, {search: '?workflow_id=recipe%3Anot-listed'});
    assert.equal(unknown.graphRequests().length, 2);
    assert.match(unknown.status(), /Choose an exact workflow_id returned by capabilities\./);
    assert.deepEqual(ws.egress, []);
  } finally {
    ws.store.close();
  }
});
