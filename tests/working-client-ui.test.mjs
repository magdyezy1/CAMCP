// SEC-08 phase 1 on the website: the working client in the top bar narrows pickers and lists, lives in ?client= and in
// this tab's identity-keyed memory, is forgotten on sign-out and workspace switch, asks before a push or plan spans
// clients, and pickers preselect an account only when exactly one remains. Before, pickers offered every client's
// accounts and the Drive import and ad previews silently chose the first one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

/** A value from the page's realm, compared as plain data. */
const plain = value => JSON.parse(JSON.stringify(value));
const clients = [
  {
    profile_id: 'profile-a',
    name: 'Client A',
    accounts: [
      {gateway: 'meta_native_action', connection_id: 'meta', account_id: '100'},
      {gateway: 'google_ads_native_action', connection_id: 'google', account_id: '1234567890'},
    ],
  },
  {
    profile_id: 'profile-b',
    name: 'Client B',
    accounts: [{gateway: 'meta_native_action', connection_id: 'meta', account_id: '200'}],
  },
];
const accounts = [
  {gateway: 'meta_native_action', connection_id: 'meta', account_id: 'act_100', label: 'A Meta'},
  {gateway: 'meta_native_action', connection_id: 'meta', account_id: '200', label: 'B Meta'},
  {gateway: 'google_ads_native_action', connection_id: 'google', account_id: '123-456-7890', label: 'A Google'},
];

function shell({search = '', session = {authenticated: true, id: 'person-1', workspaceId: 'w1'}} = {}) {
  const storage = new Map(),
    confirmations = [],
    requests = [];
  const sessionStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
    key: index => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  };
  const location = {href: 'https://amcp.test/media' + search, search, pathname: '/media', hash: ''};
  const history = {
    state: null,
    replaceState(_state, _title, url) {
      const next = new URL(url, 'https://amcp.test');
      location.href = next.href;
      location.search = next.search;
      location.pathname = next.pathname;
    },
  };
  const context = createContext({
    session,
    location,
    history,
    sessionStorage,
    URL,
    URLSearchParams,
    JSON,
    Array,
    identityGeneration: 1,
    workingClients: null,
    accessSetChoices: [],
    supersededRequest: () => Object.assign(Error(''), {code: 'REQUEST_SUPERSEDED'}),
    api: async url => {
      requests.push(url);
      return {clients};
    },
    uiText: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, k) => values[k]),
    esc: String,
    routeEntry: () => ({public: false}),
    document: {addEventListener() {}, querySelector: () => null, getElementById: () => null},
    confirmAction: async request => {
      confirmations.push(request);
      return true;
    },
    resetPrivateState() {},
    recipeDraftsForget() {},
  });
  const source = readFileSync('web/app.js', 'utf8');
  new Script(
    source.slice(source.indexOf('const workingClientStore'), source.indexOf("document.addEventListener('change'")),
  ).runInContext(context);
  new Script(
    source.slice(source.indexOf('function resetTabState('), source.indexOf('function requestError(')),
  ).runInContext(context);
  const run = code => new Script(code).runInContext(context);
  return {context, run, storage, location, confirmations, requests};
}

test('the working client narrows pickers and preselects only a sole remaining account', async () => {
  const f = shell({search: '?client=profile-a'});
  await f.run('loadWorkingClients()');
  f.context.accounts = accounts;
  // Meta act_ and Google dashes compare as the server compares them.
  const narrowed = f.run('clientAccountOptions(accounts)');
  assert.deepEqual(plain(narrowed.options.map(a => a.label)), ['A Meta', 'A Google']);
  assert.equal(narrowed.preselect, null, 'two accounts remain: an explicit placeholder, no silent choice');
  assert.deepEqual(plain(f.run('workingClientQuery()')), {profile_id: 'profile-a'});
  f.run("history.replaceState(null, '', '/media?client=profile-b')");
  const sole = f.run('clientAccountOptions(accounts)');
  assert.equal(sole.preselect?.label, 'B Meta', 'exactly one account remains: it is preselected');
  // No working client: every account, and a preselection only when the workspace has one account.
  f.run("history.replaceState(null, '', '/media')");
  f.run('workingClientRemember(null)');
  const all = f.run('clientAccountOptions(accounts)');
  assert.equal(all.options.length, 3);
  assert.equal(all.preselect, null);
  assert.deepEqual(plain(f.run('workingClientQuery()')), {});
});

test('the working client lives in ?client= and in this tab per identity, and a stale one is dropped', async () => {
  const f = shell();
  await f.run('loadWorkingClients()');
  await f.run('loadWorkingClients()');
  assert.equal(f.requests.length, 1, 'the list loads once per identity');
  f.run("workingClientRemember('profile-b')");
  // Another page of the same tab: the address gains ?client= from this tab's memory.
  assert.equal(f.run('syncWorkingClientLocation()'), true);
  assert.equal(f.location.search, '?client=profile-b');
  assert.equal(f.run('syncWorkingClientLocation()'), false);
  // A client this person no longer has (removed, or outside a new access set) is dropped from both.
  f.run("history.replaceState(null, '', '/media?client=removed')");
  f.run('syncWorkingClientLocation()');
  assert.equal(f.location.search, '');
  assert.equal(f.run('workingClient()'), null);
  // The memory is keyed by person and workspace: another workspace starts without a client.
  f.run("workingClientRemember('profile-a')");
  f.context.session.workspaceId = 'w2';
  assert.equal(f.run('workingClient()'), null);
});

test('sign-out and workspace switch forget the working client', async () => {
  const f = shell({search: '?client=profile-a'});
  await f.run('loadWorkingClients()');
  f.run('syncWorkingClientLocation()');
  assert.equal(f.storage.size, 1);
  // resetTabState runs on DELETE /api/session and on /api/workspaces/switch (see api()).
  f.run('resetTabState()');
  assert.equal(f.storage.size, 0);
  assert.equal(f.run('workingClients'), null);
  assert.match(
    readFileSync('web/app.js', 'utf8'),
    /url === '\/api\/session' && method === 'DELETE'\) resetTabState\(\)/,
  );
  assert.match(readFileSync('web/app.js', 'utf8'), /url === '\/api\/workspaces\/switch'\) resetTabState\(\)/);
});

test('a push or plan that spans clients asks first; one client does not', async () => {
  const f = shell();
  await f.run('loadWorkingClients()');
  assert.equal(
    await f.run(
      "confirmCrossClient([{gateway: 'meta_native_action', connection_id: 'meta', account_id: '100'}, {gateway: 'google_ads_native_action', account_id: '1234567890'}])",
    ),
    true,
  );
  assert.equal(f.confirmations.length, 0);
  await f.run(
    "confirmCrossClient([{gateway: 'meta_native_action', connection_id: 'meta', account_id: 'act_100'}, {gateway: 'meta_native_action', connection_id: 'meta', account_id: '200'}])",
  );
  assert.equal(f.confirmations.length, 1);
  assert.deepEqual(plain(f.confirmations[0].items), ['Client A', 'Client B']);
});

test('an account the address names stays listed, so a link to another client’s account still opens it', async () => {
  const f = shell({search: '?client=profile-b&connection_id=meta&account_id=100'});
  await f.run('loadWorkingClients()');
  f.context.accounts = accounts;
  const linked = f.run('clientAccountOptions(accounts)');
  assert.deepEqual(plain(linked.options.map(a => a.label)), ['A Meta', 'B Meta']);
  assert.equal(linked.hidden, 1, 'A Google is still hidden by the working client');
  // A client with no account among these: an empty picker that says the filter hid them.
  f.run("history.replaceState(null, '', '/media?client=profile-c')");
  f.context.workingClients = [
    ...f.context.workingClients,
    {
      profile_id: 'profile-c',
      name: 'Client C',
      accounts: [{gateway: 'tiktok_native_action', connection_id: 'tiktok', account_id: '900'}],
    },
  ];
  const none = f.run('clientAccountOptions(accounts)');
  assert.equal(none.options.length, 0);
  assert.equal(none.hidden, 3);
  assert.match(f.run('workingClientEmptyNotice()'), /Choose All clients in the top bar/);
});

/**
 * The media page (web/workspace.js) with the working-client functions of the shell, as the browser loads them. Its
 * account list has the three accounts of `accounts` above; `respond` answers workspace calls.
 */
function mediaPage(search) {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [],
    pushed = [];
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        id,
        innerHTML: '',
        isConnected: true,
        data: {},
        addEventListener() {},
        insertAdjacentHTML() {},
        setAttribute() {},
        focus() {},
      });
    return nodes.get(id);
  };
  node('#media-source').data = {drive_url: 'https://drive.google.com/file/d/synthetic/view'};
  const location = {href: 'https://amcp.test/media' + search, search, pathname: '/media', hash: ''};
  const context = createContext({
    document: {addEventListener() {}, querySelector: () => null, getElementById: () => null},
    content: node('#content'),
    $: node,
    session: {authenticated: true, id: 'person-1', workspaceId: 'w1'},
    sessionStorage: {getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0},
    history: {state: null, replaceState() {}},
    identityGeneration: 1,
    workingClients: [
      ...clients,
      {
        profile_id: 'profile-c',
        name: 'Client C',
        accounts: [{gateway: 'tiktok_native_action', connection_id: 'tiktok', account_id: '900'}],
      },
    ],
    accessSetChoices: [],
    routeEntry: () => ({public: false}),
    platforms: [
      {
        id: 'meta',
        gateway: 'meta_native_action',
        name: 'Meta',
        connections: [{id: 'meta', enabled: true, accounts: ['act_100', '200']}],
      },
      {
        id: 'google',
        gateway: 'google_ads_native_action',
        name: 'Google Ads',
        connections: [{id: 'google', enabled: true, accounts: ['123-456-7890']}],
      },
    ],
    accountLabel: (_p, _c, a) => 'Account ' + a,
    accountText: (_p, _c, a) => a,
    creativePushPanel: targets => {
      pushed.push(targets);
      return '';
    },
    pushDrives: () => [],
    adPreviewsPanel: () => '',
    bindCreativePush() {},
    bindAdPreviews() {},
    bindCreativeLibrary: async () => {},
    workspaceCall: async (tool, args) => {
      calls.push({tool, args: JSON.parse(JSON.stringify(args))});
      return args.action === 'list' ? {presets: {}, sources: [], recovery_reviews: []} : {review_id: 'review'};
    },
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    reviewView: () => '',
    bindReviewCountdown() {},
    readReviewConsents: () => ({confirmed: true}),
    FormData: function (form) {
      return Object.entries(form.data ?? {});
    },
    Object,
    JSON,
    Number,
    String,
    Math,
    URL,
    URLSearchParams,
    encodeURIComponent,
    location,
    esc: value => String(value ?? ''),
    date: String,
    badge: String,
    blank: String,
    recordDetails: () => '',
    controls: () => '',
    toast() {},
    navigate() {},
    clearTimeout() {},
    setTimeout() {},
    pollTimer: undefined,
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  const app = readFileSync('web/app.js', 'utf8'),
    page = readFileSync('web/workspace.js', 'utf8');
  new Script(
    app.slice(app.indexOf('const workingClientStore'), app.indexOf("document.addEventListener('change'")),
  ).runInContext(context);
  new Script(
    page.slice(page.indexOf('function mediaJobPanel('), page.indexOf('async function renderDecisionReports()')),
  ).runInContext(context);
  return {
    node,
    bindings,
    calls,
    pushed,
    render: () => new Script('renderMediaLibrary()').runInContext(context),
    importSelect: () => {
      const html = node('#content').innerHTML;
      return html.slice(
        html.indexOf('<form id="media-import">'),
        html.indexOf('</select>', html.indexOf('<form id="media-import">')),
      );
    },
  };
}

test('the media page follows the working client, and a Drive import needs an explicit account (regression: the first account of any client was preselected)', async () => {
  const two = mediaPage('?client=profile-a');
  await two.render();
  // The working client's recovery list, push targets and import accounts only.
  assert.equal(two.calls[0].args.profile_id, 'profile-a');
  assert.deepEqual(plain(two.pushed[0].map(t => t.account_id)), ['act_100', '123-456-7890']);
  const select = two.importSelect();
  assert.match(select, /<option value="" selected disabled>/, 'two accounts remain: an explicit placeholder');
  assert.doesNotMatch(select, /Account 200/, 'client B’s account is not offered');
  assert.doesNotMatch(select, /value="0" selected/);
  // Submitting the placeholder is refused before anything is prepared.
  two.node('#media-import').data = {target: '', name: 'Synthetic media', reuse: 'on'};
  await assert.rejects(two.bindings.get('#media-import')(two.node('#media-import')), /Choose the advertising account/);
  assert.ok(two.calls.every(c => c.args.action !== 'prepare'));
  // One account remaining is preselected, and the import prepares for it.
  const one = mediaPage('?client=profile-b');
  await one.render();
  assert.match(one.importSelect(), /<option value="0" selected>Account 200<\/option>/);
  assert.doesNotMatch(one.importSelect(), /selected disabled/);
  one.node('#media-import').data = {target: '0', name: 'Synthetic media', reuse: 'on'};
  await one.bindings.get('#media-import')(one.node('#media-import'));
  const prepared = one.calls.find(c => c.args.action === 'prepare');
  assert.equal(prepared.args.account_id, '200');
  // A client with no account here: the import says the working client hid them, not "connect an account".
  const none = mediaPage('?client=profile-c');
  await none.render();
  none.node('#media-import').data = {target: '', name: 'Synthetic media', reuse: 'on'};
  await assert.rejects(none.bindings.get('#media-import')(none.node('#media-import')), /Choose All clients/);
  // No working client: every account, still with an explicit choice.
  const all = mediaPage('');
  await all.render();
  assert.equal(all.calls[0].args.profile_id, undefined);
  assert.equal(all.pushed[0].length, 3);
  assert.match(all.importSelect(), /<option value="" selected disabled>/);
});

test('reviewer test accounts load no working clients', async () => {
  const f = shell({session: {authenticated: true, testAccount: true, id: 'workspace-test', workspaceId: 't'}});
  assert.deepEqual(JSON.parse(JSON.stringify(await f.run('loadWorkingClients()'))), []);
  assert.equal(f.requests.length, 0);
});

test('ad previews require an explicit account when several remain (regression: the first was silently chosen)', () => {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {hidden: false, innerHTML: '', addEventListener() {}});
    return nodes.get(id);
  };
  let bound;
  const context = createContext({
    platforms: [
      {
        gateway: 'meta_native_action',
        connections: [{id: 'meta', enabled: true, accounts: ['100', '200']}],
      },
    ],
    accountLabel: (_p, _c, a) => 'Account ' + a,
    esc: String,
    uiText: String,
    $: node,
    workspaceBind: (_selector, fn) => (bound = fn),
  });
  const source = readFileSync('web/ad-previews.js', 'utf8');
  new Script(source).runInContext(context);
  const html = new Script('adPreviewsPanel()').runInContext(context);
  assert.match(html, /<option value="" selected disabled>Choose an account<\/option>/);
  assert.doesNotMatch(html, /<option value="0" selected>/);
  node('#preview-form').elements = {target: {value: ''}, ad_ids: {value: ''}};
  new Script('bindAdPreviews()').runInContext(context);
  return assert.rejects(bound(node('#preview-form')), /Choose the advertising account to preview/);
});
