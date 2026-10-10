// WEB-08: owner Settings density. Before it, the access table came first and the emergency stop sat about 3,845 px
// down a 768 px page; worker health listed 100 near-identical rows such as "Idle | 5,868.337 | Yes" with no verdict;
// the owner's own access row offered "Limit to test access" and "Remove access", which the server always refuses; and
// the palette had no way to the pause control. These tests guard the Safety-first sections, the anchors, the
// unchanged confirmations, the worker-health verdict, the self row and the owner-only palette entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {operationsWorkerHealth} from '../dist/src/operations-worker-health.js';

const owner = readFileSync('web/owner-operations.js', 'utf8'),
  approvals = readFileSync('web/account-approvals.js', 'utf8'),
  catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  fixed = Date.UTC(2026, 9, 6, 8),
  esc = value =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');

/** The worker observation of one process that last reported 5,868.337 seconds (about 98 minutes) ago. */
function quietWorker() {
  const store = new Store(':memory:');
  try {
    store.putDocument('__service_limits__', 'worker_heartbeat', 'SYNTHETIC-PROCESS', {
      at: fixed - 5868337,
      state: 'idle',
    });
    return operationsWorkerHealth(store, fixed);
  } finally {
    store.close();
  }
}
function health(worker = quietWorker()) {
  return {
    backup: {status: 'unverified'},
    operations: {worker},
    connections: [],
    jobs: [],
    email: [],
    storage: {database_bytes: 0, report_rows: 0},
    limits: {},
    api_versions: {},
    policies: [],
  };
}

/** owner-operations.js (and optionally account-approvals.js) on a synthetic Settings page in the given language. */
function settingsPage({locale = 'en', hash = '', accounts = null} = {}) {
  const areas = [],
    calls = [],
    bindings = new Map(),
    confirmations = [],
    slot = {
      hidden: true,
      children: [],
      append(area) {
        this.children.push(area);
      },
    },
    link = {hidden: true};
  let confirmReply = false;
  const context = createContext({
    Intl,
    Date,
    JSON,
    document: {
      addEventListener() {},
      createElement() {
        return {
          listeners: {},
          addEventListener(type, fn) {
            this.listeners[type] = fn;
          },
          querySelector() {
            return null;
          },
        };
      },
    },
    renderSettings() {},
    date: value => (value === undefined ? 'unknown' : new Date(value).toISOString()),
    esc,
    session: {authenticated: true, administrator: true, workspaceRole: 'owner'},
    location: {pathname: '/settings', hash},
    navigationGeneration: 1,
    content: {
      querySelector(selector) {
        const html = areas[0]?.innerHTML ?? '';
        if (selector === '#settings-access') return html.includes('id="settings-access"') ? slot : null;
        if (selector === '[data-settings-access]') return html.includes('data-settings-access') ? link : null;
        return null;
      },
      append(area) {
        areas.push(area);
      },
    },
    platforms: [],
    pretty: String,
    toast() {},
    authBind(selector, fn) {
      bindings.set(selector, fn);
    },
    confirmAction: async request => {
      confirmations.push(request);
      return confirmReply;
    },
    FormData: class {
      constructor(form) {
        this.values = form.values;
      }
      get(key) {
        return this.values[key] ?? null;
      }
      has(key) {
        return key in this.values;
      }
    },
    $() {
      return {addEventListener() {}, scrollIntoView() {}, textContent: ''};
    },
    api: async (path, init) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({path, body});
      if (path === '/api/account/options') return {emailEnabled: false, providers: []};
      if (path === '/api/owner/accounts')
        if (accounts) return {accounts, pending: 0, emailEnabled: false, setup: {}, providers: []};
        else throw Object.assign(Error('Only the AMCP owner can manage account access.'), {status: 403});
      if (body?.action === 'health') return {success: true, data: health()};
      return {success: true, data: {}};
    },
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  context.catalog = catalog;
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  const app = readFileSync('web/app.js', 'utf8');
  run(app.slice(app.indexOf('const identityKey ='), app.indexOf('function resetPrivateState()')));
  run(owner);
  if (accounts) run(approvals);
  return {
    context,
    areas,
    calls,
    bindings,
    confirmations,
    slot,
    link,
    run,
    confirm: value => {
      confirmReply = value;
    },
    render: () => run('renderSettings()'),
  };
}
const position = (html, id) => {
  const at = html.indexOf(`id="${id}"`);
  assert.ok(at >= 0, id + ' is rendered');
  return at;
};

test('owner Settings lead with Safety: the emergency stop and spending caps come before access, health and retention', async () => {
  for (const locale of ['en', 'ar']) {
    const page = settingsPage({locale});
    await page.render();
    assert.equal(page.areas.length, 1);
    const html = page.areas[0].innerHTML,
      order = [
        'settings-safety',
        'owner-write-pause',
        'owner-spend-policy',
        'owner-cap-overrides',
        'settings-access',
        'settings-health',
        'owner-worker-health',
        'settings-retention',
        'owner-retention',
        'owner-export-policy-panel',
        'settings-account',
      ].map(id => position(html, id));
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
      'sections follow Safety, Access, Health, Retention, Account',
    );
    // One click from the top: the sub-navigation precedes every section and its first link is Safety.
    const nav = /<nav class="settings-subnav" aria-label="([^"]+)"><ul>([\s\S]*?)<\/ul><\/nav>/.exec(html);
    assert.ok(nav, 'the Settings sub-navigation is rendered');
    assert.ok(html.indexOf('<nav class="settings-subnav"') < position(html, 'settings-safety'));
    const links = [...nav[2].matchAll(/href="#([^"]+)">([^<]+)</g)].map(m => [m[1], m[2]]);
    assert.deepEqual(
      links.map(([id]) => id),
      ['settings-safety', 'settings-access', 'settings-health', 'settings-retention', 'settings-account'],
    );
    // Every anchor names a section that exists on the page.
    for (const [id] of links) position(html, id);
    const label = text => (locale === 'ar' ? catalog[text] : text);
    assert.deepEqual(
      links.map(([, text]) => text),
      ['Safety', 'Access', 'Health', 'Retention', 'Account'].map(label),
    );
    assert.equal(nav[1], label('Settings sections'));
    // Access stays hidden until the instance owner's access list fills it.
    assert.match(html, /<li data-settings-access hidden><a href="#settings-access">/);
    assert.match(html, /<section id="settings-access" class="settings-group" hidden><\/section>/);
  }
});

test('pausing writes from the Safety section still asks for confirmation first; a declined one sends nothing', async () => {
  const page = settingsPage();
  await page.render();
  const pause = page.bindings.get('#owner-pause-writes');
  assert.equal(typeof pause, 'function');
  page.confirm(false);
  await pause({values: {reason: 'Synthetic incident'}});
  assert.equal(page.confirmations.at(-1).title, 'Pause every reviewed write of this workspace?');
  assert.equal(page.confirmations.at(-1).confirmLabel, 'Pause all writes');
  assert.equal(page.calls.filter(c => c.body?.action === 'pause_writes').length, 0, 'declined: no pause request');
  page.confirm(true);
  await pause({values: {reason: 'Synthetic incident'}});
  assert.deepEqual(page.calls.find(c => c.body?.action === 'pause_writes').body, {
    action: 'pause_writes',
    reason: 'Synthetic incident',
    confirmed: true,
  });
});

test('a fresh load of a link to the pause control opens Settings there once the page has rendered its data', async () => {
  const app = readFileSync('web/app.js', 'utf8'),
    start = app.indexOf('(async () => {\n  // All deferred feature scripts'),
    boot = app.slice(start, app.indexOf('})();', start) + 5);
  assert.ok(start > 0);
  for (const [hash, publicView, expected] of [
    ['#owner-write-pause', false, ['rendered', 'focus owner-write-pause']],
    ['#settings-retention', false, ['rendered', 'focus settings-retention']],
    ['#missing-section', false, ['rendered']],
    ['', false, ['rendered']],
    // The landing page scrolls to its own sections; the boot leaves public pages alone.
    ['#how-it-works', true, ['rendered']],
  ]) {
    const events = [],
      context = createContext({
        document: {readyState: 'complete', body: {classList: {contains: name => name === 'public-view' && publicView}}},
        location: {hash},
        session: undefined,
        initializeUILocale: async () => {},
        api: async () => ({authenticated: true}),
        refresh: async () => {
          // The whole Settings chain (owner controls, then the access list) renders before refresh resolves.
          await new Promise(resolve => setTimeout(resolve, 5));
          events.push('rendered');
        },
        fragmentTarget: value =>
          ['#owner-write-pause', '#settings-retention', '#how-it-works'].includes(value) ? {id: value.slice(1)} : null,
        focusFragmentTarget: target => events.push('focus ' + target.id),
      });
    await new Script(boot).runInContext(context);
    assert.deepEqual(events, expected, hash);
  }
});

test('opening the pause control from Settings reads health only and never pauses', async () => {
  const page = settingsPage({hash: '#owner-write-pause'});
  await page.render();
  assert.deepEqual(
    page.calls.map(c => c.body?.action ?? c.path),
    ['health', '/api/account/options'],
  );
  assert.equal(page.confirmations.length, 0);
});

test('worker health leads with a verdict in human terms and keeps the raw observations collapsed, in English and Arabic', () => {
  for (const locale of ['en', 'ar']) {
    const page = settingsPage({locale}),
      html = page.run(`ownerWorkerHealth(${JSON.stringify(quietWorker())})`),
      unit = (value, name) =>
        new Intl.NumberFormat(locale, {numberingSystem: 'latn', style: 'unit', unit: name, unitDisplay: 'long'}).format(
          value,
        ),
      text = (message, values) =>
        (locale === 'ar' ? catalog[message] : message).replace(/\{(\w+)\}/g, (_, key) => values[key]);
    const verdict = /<p class="worker-health-verdict"><strong>([^<]+)<\/strong> · ([^<]+)<\/p>/.exec(html);
    assert.ok(verdict, 'the verdict line is rendered');
    assert.equal(verdict[1], text('Only older process observations', {}));
    // About 98 minutes, not "5,868.337" seconds; the 90-second threshold is named.
    assert.equal(
      verdict[2],
      text('Newest report {age} ago; reports older than {threshold} are not recent.', {
        age: unit(98, 'minute'),
        threshold: unit(90, 'second'),
      }) +
        ' ' +
        text('Newest observations shown: {shown} ({working} working, {idle} idle).', {shown: 1, working: 0, idle: 1}),
    );
    // The careful scope wording stays.
    assert.match(html, locale === 'ar' ? /لا تؤكد/ : /do not confirm workspace jobs/);
    // The table is collapsed by default; each age is human, with the exact seconds in its title.
    assert.match(html, /<details class="worker-health-details"><summary>/);
    assert.doesNotMatch(html, /<details class="worker-health-details" open/);
    assert.ok(html.indexOf('<details class="worker-health-details">') < html.indexOf('<table'));
    assert.match(
      html,
      new RegExp(`<td title="${text('{seconds} seconds', {seconds: '5,868.337'})}">${unit(98, 'minute')}</td>`),
    );
    assert.ok(html.includes(text('Show observations ({count})', {count: 1})));
    assert.ok(html.includes(text('Observation age', {})));
  }
});

test('the human age keeps seconds under two minutes, minutes under two hours, then hours and days', () => {
  const page = settingsPage();
  const age = ms => page.run(`ownerAge(${ms})`);
  assert.equal(age(0), '0 seconds');
  assert.equal(age(90000), '90 seconds');
  assert.equal(age(119400), '119 seconds');
  assert.equal(age(120000), '2 minutes');
  assert.equal(age(5868337), '98 minutes');
  assert.equal(age(7200000), '2 hours');
  assert.equal(age(9000000), '2.5 hours');
  assert.equal(age(172800000), '2 days');
});

test("the owner's own access row shows You without actions; other rows keep their controls", async () => {
  const accounts = [
    {id: 'self-user', email: 'owner@example.test', name: 'Owner', state: 'approved', self: true, methods: ['email']},
    {id: 'member-user', email: 'member@example.test', name: 'Member', state: 'approved', self: false, methods: []},
    {id: 'waiting-user', email: 'new@example.test', name: 'New', state: 'pending', self: false, methods: []},
  ];
  for (const locale of ['en', 'ar']) {
    const page = settingsPage({locale, accounts});
    await page.render();
    // The access list is its own section after Safety, and its sub-navigation link appears.
    assert.equal(page.slot.children.length, 1);
    assert.equal(page.slot.hidden, false);
    assert.equal(page.link.hidden, false);
    const html = page.slot.children[0].innerHTML,
      rows = Object.fromEntries(
        [...html.matchAll(/<tr><td><strong>([^<]+)<\/strong>[\s\S]*?<\/tr>/g)].map(m => [m[1], m[0]]),
      ),
      label = text => (locale === 'ar' ? catalog[text] : text);
    assert.match(rows.Owner, new RegExp(`<span class="status online">${label('You')}</span>`));
    assert.doesNotMatch(rows.Owner, /<button|data-user=/, 'no dead-end action on the owner row');
    assert.match(rows.Member, /data-grant="true" data-test="true" data-user="member-user"/);
    assert.match(rows.Member, /data-grant="false" data-user="member-user"/);
    assert.doesNotMatch(rows.Member, new RegExp(`>${label('You')}<`));
    assert.match(rows.New, /data-grant="true" data-user="waiting-user"/);
  }
});

test('the palette offers owners a way to the pause control that only navigates; others never see it', () => {
  const identity = readFileSync('web/identity.js', 'utf8'),
    palette = identity.slice(identity.indexOf('const commandPages = ['), identity.indexOf('function openCommand()'));
  const results = (session, query) => {
    const list = {innerHTML: ''},
      context = createContext({
        document: {addEventListener() {}},
        esc,
        session,
        $: selector => (selector === '#command-query' ? {value: query} : list),
      });
    new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
    new Script(palette).runInContext(context);
    new Script('commandResults()').runInContext(context);
    return list.innerHTML;
  };
  for (const session of [
    {administrator: true, workspaceRole: 'owner'},
    {administrator: false, workspaceRole: 'owner'},
  ]) {
    const html = results(session, 'pause');
    assert.match(
      html,
      /<button data-command-go="\/settings#owner-write-pause"><span><strong>Pause all writes<\/strong>/,
    );
    assert.match(html, /pausing asks first/);
  }
  for (const role of ['admin', 'operator', 'viewer'])
    assert.doesNotMatch(results({administrator: false, workspaceRole: role}, 'pause'), /owner-write-pause/);
  // Searching by the page name still finds it, and the owner-only flag never leaks into the search text.
  assert.match(results({administrator: true}, 'settings'), /data-command-go="\/settings"/);
  assert.doesNotMatch(results({administrator: false, workspaceRole: 'viewer'}, 'true'), /owner-write-pause/);
});
