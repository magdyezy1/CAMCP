import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => (resolve = done));
  return {promise, resolve};
};
const response = (data, status = 200) => ({ok: status < 400, status, json: async () => data});
test('deferred startup waits for feature scripts while the document is interactive', async () => {
  let loaded,
    requests = 0,
    rendered = false,
    featureReady = false;
  const source = readFileSync('web/app.js', 'utf8'),
    start = source.indexOf('(async () => {'),
    end = source.indexOf('})();', start) + 5;
  const context = createContext({
    document: {
      readyState: 'interactive',
      querySelectorAll: () => [],
      addEventListener(event, callback) {
        if (event === 'change') return;
        assert.equal(event, 'DOMContentLoaded');
        loaded = callback;
      },
    },
    session: {},
    api: async () => {
      requests++;
      return {};
    },
    refresh: async () => {
      assert.equal(featureReady, true);
      rendered = true;
    },
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  const pending = new Script(source.slice(start, end)).runInContext(context);
  await Promise.resolve();
  assert.equal(requests, 0);
  assert.equal(rendered, false);
  featureReady = true;
  loaded();
  await pending;
  assert.equal(requests, 1);
  assert.equal(rendered, true);
});
const identity = (workspaceId = 'workspace-a', id = 'person-a') => ({
  authenticated: true,
  id,
  workspaceId,
  workspaceRole: 'viewer',
  name: 'Synthetic member',
  csrf: workspaceId + '-csrf',
});

test('structured server errors keep their recovery advice and request reference in browser messages', () => {
  const context = createContext({
    document: {querySelector: () => ({}), addEventListener() {}, getElementById: () => ({})},
    window: {addEventListener() {}},
    location: {pathname: '/dashboard'},
    Map,
    Set,
    URLSearchParams,
    setTimeout() {},
    clearTimeout() {},
  });
  const source = readFileSync('web/app.js', 'utf8');
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(source.slice(source.indexOf('function requestError('), source.indexOf('const content ='))).runInContext(
    context,
  );
  const message = new Script(
    `errorMessage(requestError({error:{message:'The plan state changed.',next_action:'Inspect the original receipt.',code:'STATE_CHANGED',retryable:false},meta:{requestId:'fixture-request'}}))`,
  ).runInContext(context);
  assert.match(message, /Inspect the original receipt/);
  assert.match(message, /fixture-request/);
  // WEB-03 (design review 2026-10): an uncertain write is said in the page's own words, which keep its recovery advice
  // (nothing is sent again; the change is not repeated unless a read-back or the account shows it was not applied, and
  // an upload's recovery is in Operations, as uploads have no read-back) and the reference; the server's text stays
  // under Technical details. This case once pinned the server's advice verbatim.
  const uncertain = text =>
    new Script(
      `errorMessage(requestError({error:{message:${JSON.stringify(text)},next_action:'Inspect the original receipt.',code:'WRITE_OUTCOME_UNCERTAIN',retryable:false},meta:{requestId:'fixture-request'}}))`,
    ).runInContext(context);
  const upload = uncertain('The upload outcome is uncertain.');
  assert.match(
    upload,
    /AMCP never repeats an upload or step whose outcome is not confirmed\. Check its recovery in Operations/,
  );
  assert.doesNotMatch(upload, /read-back/);
  assert.match(upload, /fixture-request/);
  const change = uncertain('The change outcome is uncertain.');
  assert.match(change, /AMCP cannot confirm whether this change was applied\./);
  assert.match(
    change,
    /AMCP never sends it again\. Do not repeat the change unless a read-back or the account itself shows it was not applied/,
  );
  assert.match(change, /fixture-request/);
});

// Execute the actual browser scripts with a small DOM adapter. Requests are entirely synthetic and deferred by
// each test; no server, credentials, provider traffic, build output or browser dependency is required.
function browserFixture(fetcher = async () => response({})) {
  const elements = new Map(),
    documentListeners = new Map(),
    windowListeners = new Map(),
    scrolls = [],
    bindings = new Map();
  const node = selector => {
    if (elements.has(selector)) return elements.get(selector);
    const listeners = new Map();
    const element = {
      id: selector.startsWith('#') ? selector.slice(1) : '',
      tagName: selector.endsWith('-form') || selector === '#overview-config' ? 'FORM' : 'BUTTON',
      dataset: {},
      attributes: [],
      innerHTML: '',
      textContent: '',
      value: '',
      disabled: false,
      isConnected: true,
      parentElement: null,
      lastElementChild: {
        textContent: '',
        setAttribute(name, value) {
          this[name] = value;
        },
        getAttribute(name) {
          return this[name] ?? null;
        },
      },
      classList: {toggle() {}, add() {}, remove() {}},
      setAttribute(name, value) {
        this[name] = value;
      },
      removeAttribute(name) {
        delete this[name];
      },
      getAttribute(name) {
        return this[name] ?? null;
      },
      hasAttribute(name) {
        return this[name] !== undefined;
      },
      focus() {
        context.document.activeElement = this;
      },
      scrollIntoView() {
        scrolls.push(selector);
      },
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      removeEventListener(type) {
        listeners.delete(type);
      },
      querySelector: node,
      querySelectorAll: () => [],
      insertAdjacentHTML(_position, html) {
        this.innerHTML += html;
      },
      close() {
        this.open = false;
      },
      showModal() {
        this.open = true;
      },
      async click() {
        if (this.disabled) return;
        return listeners.get('click')?.({preventDefault() {}, target: this, button: 0});
      },
    };
    elements.set(selector, element);
    return element;
  };
  const location = {pathname: '/connections', search: '', hash: ''};
  const updateLocation = value => {
    const url = new URL(value, 'https://amcp.invalid');
    Object.assign(location, {pathname: url.pathname, search: url.search, hash: url.hash});
  };
  const context = createContext({
    URL,
    URLSearchParams,
    Intl,
    structuredClone,
    CSS: {escape: value => value},
    location,
    history: {pushState: (_a, _b, url) => updateLocation(url), replaceState: (_a, _b, url) => updateLocation(url)},
    sessionStorage: {
      setItem() {},
      getItem() {
        return null;
      },
      removeItem() {},
    },
    fetch: (...args) => fetcher(...args),
    setTimeout: () => 1,
    clearTimeout() {},
    window: {
      scrollTo: () => scrolls.push('top'),
      addEventListener(type, fn) {
        const list = windowListeners.get(type) ?? [];
        list.push(fn);
        windowListeners.set(type, list);
      },
    },
    document: {
      body: {classList: {toggle() {}}},
      activeElement: null,
      querySelector: node,
      getElementById: id => node('#' + id),
      querySelectorAll: selector => (selector.startsWith('#') ? [node(selector)] : []),
      addEventListener(type, fn) {
        const list = documentListeners.get(type) ?? [];
        list.push(fn);
        documentListeners.set(type, list);
      },
    },
    renderLanding() {
      node('#content').innerHTML = 'Public landing page';
    },
    // This fixture explicitly installs its reporting controllers below. Loader behavior has dedicated coverage.
    pageAssetsPending: () => false,
    ensurePageAssets: async () => {},
    async renderAuthPage() {
      node('#content').innerHTML = 'Sign in to AMCP';
    },
    async renderAccountPage() {
      node('#content').innerHTML = 'Your account';
      // Like identity.js's page, then the parts other scripts register (account security, WEB-07).
      await run("AMCP.routes.renderParts('/account')");
    },
    glyph: () => '',
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(readFileSync('web/routes.js', 'utf8'));
  // Omit only the initial page-load IIFE: each test explicitly chooses when it starts a request.
  const app = readFileSync('web/app.js', 'utf8');
  const startup = app.indexOf('(async () => {');
  const startupEnd = app.indexOf('})();', startup) + '})();'.length;
  run(app.slice(0, startup) + app.slice(startupEnd));
  const workspace = readFileSync('web/workspace.js', 'utf8');
  run(workspace.slice(0, workspace.indexOf('async function workspaceCall(')));
  const identitySource = readFileSync('web/identity.js', 'utf8');
  // The shell's helpers before the account page this fixture replaces (the sign-in pages are account-security.js's).
  run(identitySource.slice(0, identitySource.indexOf('async function renderAccountPage()')));
  for (const file of ['report-library', 'report-quality', 'report-workflows', 'reporting-overview'])
    run(readFileSync('web/' + file + '.js', 'utf8'));
  context.nextIdentity = identity();
  run('session = nextIdentity; overviewState.bootstrap={platforms:[],metrics:{}}');
  return {context, run, node, location, scrolls, documentListeners, windowListeners, bindings, updateLocation};
}

function seedPrivateState(f) {
  f.run(`
    overviewState.config = {...overviewDefault(), client_name:'Previous private client'};
    overviewState.report = {id:'previous-report'};
    overviewState.selection = {kind:'view', id:'previous-view', revision:1};
    overviewState.destinationId = 'previous-destination';
    overviewState.deliveryDraft = {spreadsheet_id:'previous-sheet'};
    overviewState.history = [{id:'previous-history'}];
    tokens = [{id:'previous-token'}]; oauthClients = [{id:'previous-client'}];
    currentConnection = 'previous-login'; selected = new Set(['previous-account']);
    writeSelected = new Set(['previous-account']);
  `);
}
function assertPrivateStateCleared(f) {
  for (const field of ['config', 'report', 'selection', 'destinationId', 'deliveryDraft'])
    assert.equal(f.run('overviewState.' + field) ?? null, null, 'clear reporting ' + field);
  assert.equal(f.run('overviewState.history.length'), 0);
  assert.equal(f.run('tokens.length + oauthClients.length + selected.size + writeSelected.size'), 0);
  assert.equal(f.run('currentConnection'), null);
}

test('a late activity response cannot append old workspace data after navigating away', async () => {
  const gate = deferred();
  const f = browserFixture(async url => {
    assert.equal(url, '/api/activity');
    await gate.promise;
    return response({events: [{event: {event: 'private_previous_activity'}, at: 1}]});
  });
  f.updateLocation('/activity');
  const pending = f.run('render()');
  await f.run("navigate('/connections')");
  const currentPage = f.node('#content').innerHTML;
  gate.resolve();
  await pending;
  assert.equal(f.node('#content').innerHTML, currentPage);
});

test('a late failed page request cannot replace the current page with its error', async () => {
  const gate = deferred();
  const f = browserFixture(async () => {
    await gate.promise;
    return response({error: {code: 'OLD_REQUEST_FAILED', message: 'The old page failed'}}, 503);
  });
  f.updateLocation('/activity');
  const pending = f.run('render()');
  await f.run("navigate('/connections')");
  const currentPage = f.node('#content').innerHTML;
  gate.resolve();
  await pending;
  assert.equal(f.node('#content').innerHTML, currentPage);
});

test('returning to the same route still fences the first visit response', async () => {
  const gate = deferred();
  let reads = 0;
  const f = browserFixture(async () => {
    if (++reads === 1) {
      await gate.promise;
      return response({events: [{event: {event: 'superseded_visit'}, at: 1}]});
    }
    return response({events: [{event: {event: 'current_visit'}, at: 2}]});
  });
  f.updateLocation('/activity');
  const first = f.run('render()');
  await f.run("navigate('/connections')");
  await f.run("navigate('/activity')");
  // Current navigate is synchronous; allow its fetch and JSON microtasks to settle too.
  await new Promise(resolve => setImmediate(resolve));
  const currentPage = f.node('#content').innerHTML;
  gate.resolve();
  await first;
  assert.match(currentPage, /current visit/);
  assert.equal(f.node('#content').innerHTML, currentPage);
});

test('session expiry clears private browser state and preserves the replacement sign-in page', async () => {
  const f = browserFixture(async () => response({error: {code: 'UNAUTHORIZED', message: 'Sign in again'}}, 401));
  seedPrivateState(f);
  f.updateLocation('/activity');
  await f.run('render()');
  assert.equal(f.location.pathname, '/login');
  assertPrivateStateCleared(f);
  assert.equal(f.node('#content').innerHTML, 'Sign in to AMCP');
});

test('logging out clears report, connector and account-selection state in the same document', async () => {
  const f = browserFixture(async url =>
    response(url === '/api/platforms' ? {platforms: []} : {authenticated: false, csrf: null}),
  );
  seedPrivateState(f);
  const button = f.node('#logout-button');
  await f.documentListeners.get('click')[0]({target: {closest: () => button}, button: 0, preventDefault() {}});
  assertPrivateStateCleared(f);
});

test('switching workspaces clears the previous reporting state before opening the new workspace', async () => {
  const f = browserFixture(async url =>
    response(
      {
        '/api/account': {id: 'person-a', workspaceId: 'workspace-a', workspaceRole: 'viewer'},
        '/api/account/options': {},
        '/api/workspaces': {
          workspaces: [
            {id: 'workspace-a', name: 'A', role: 'viewer'},
            {id: 'workspace-b', name: 'B', role: 'viewer'},
          ],
        },
        '/api/workspaces/switch': {},
        '/api/session': identity('workspace-b'),
        '/api/platforms': {platforms: []},
      }[url] ?? {},
    ),
  );
  seedPrivateState(f);
  f.run('authBind = (selector, fn) => recordBinding(selector, fn)');
  f.context.recordBinding = (selector, fn) => f.bindings.set(selector, fn);
  f.run(readFileSync('web/account-security.js', 'utf8'));
  f.updateLocation('/account');
  await f.run('renderAccountPage()');
  await f.bindings.get('[data-switch-workspace]')({dataset: {switchWorkspace: 'workspace-b'}});
  assert.equal(f.run('session.workspaceId'), 'workspace-b');
  assertPrivateStateCleared(f);
});

test('refreshing an unchanged identity preserves its unsaved reporting setup', async () => {
  const f = browserFixture(async () => response(identity()));
  seedPrivateState(f);
  await f.run(
    "session = await api('/api/session')".replace('session = await', '(async () => { session = await') + '; })()',
  );
  assert.equal(f.run('overviewState.config.client_name'), 'Previous private client');
});

test('fragment navigation scrolls to the requested section after the destination renders', async () => {
  const f = browserFixture();
  // The landing page's sections are for visitors who are not signed in: a signed-in visitor at / opens Home (P12).
  f.run('session = {authenticated: false, csrf: null}');
  await f.run("navigate('/#how-it-works')");
  assert.equal(f.location.hash, '#how-it-works');
  assert.equal(f.scrolls.at(-1), '#how-it-works');
});

// Owner decision P12 (DOC-03): a signed-in visitor to / goes to Home. The server redirects a load of /
// (tests/signed-in-home.test.mjs); in the shell, Back to / or a link to / while signed in rendered the public landing
// page instead, with an "Open your workspace" button.
test('a signed-in visitor at / opens Home in place of the landing page; a signed-out visitor keeps the landing page', async () => {
  const member = browserFixture();
  let home = 0;
  member.context.renderWorkspacePage = async () => {
    home++;
    member.node('#content').innerHTML = 'Home';
  };
  for (const address of ['/', '/#how-it-works']) {
    member.updateLocation(address);
    await member.run('render()');
    assert.equal(member.location.pathname + member.location.hash, '/dashboard', address);
    assert.equal(member.node('#content').innerHTML, 'Home', address);
  }
  assert.equal(home, 2);
  // Back to the entry of / replaces it with Home too.
  member.updateLocation('/');
  await member.windowListeners.get('popstate')[0]();
  assert.equal(member.location.pathname, '/dashboard');
  assert.equal(home, 3);
  const visitor = browserFixture();
  visitor.run('session = {authenticated: false, csrf: null}');
  visitor.context.renderWorkspacePage = async () => assert.fail('A signed-out visitor never renders Home');
  visitor.updateLocation('/');
  await visitor.run('render()');
  assert.equal(visitor.location.pathname, '/');
  assert.match(visitor.node('#content').innerHTML, /class="landing"/);
});

// WEB-01 regression: a native "#main" fragment step fired popstate, which re-rendered the route and cleared typed input.
test('a fragment-only history step focuses its section without re-rendering; a real Back still renders', async () => {
  let requests = 0;
  const f = browserFixture(async () => {
    requests++;
    return response({events: []});
  });
  f.updateLocation('/connections');
  await f.run('render()');
  let renders = 0;
  f.context.countRender = () => renders++;
  f.run('const originalRender = render; render = () => { countRender(); return originalRender(); }');
  const [popstate] = f.windowListeners.get('popstate');
  const before = requests;
  f.updateLocation('/connections#main');
  await popstate();
  assert.equal(renders, 0, 'A hash-only history step must not re-render the route');
  assert.equal(requests, before, 'A hash-only history step must not repeat page requests');
  assert.equal(f.context.document.activeElement, f.node('#main'));
  f.updateLocation('/activity');
  await popstate();
  assert.equal(renders, 1, 'Back to a different path still renders it');
  f.updateLocation('/activity?cursor=next');
  await popstate();
  assert.equal(renders, 2, 'A different query is a different view');
});

test('the skip link and in-page jumps move focus without history, rendering or API requests', async () => {
  let requests = 0;
  const f = browserFixture(async () => {
    requests++;
    return response({});
  });
  f.updateLocation('/connections');
  await f.run('render()');
  const before = requests,
    pushes = [];
  f.context.history.pushState = (_a, _b, url) => pushes.push(url);
  for (const href of ['#main', '#overview-config']) {
    let prevented = false;
    const link = {
      tagName: 'A',
      dataset: {},
      getAttribute: name => (name === 'href' ? href : null),
      hasAttribute: () => false,
    };
    await f.documentListeners.get('click')[0]({
      target: {closest: () => link},
      button: 0,
      get defaultPrevented() {
        return prevented;
      },
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true, href + ' must not fall through to a native fragment navigation');
    assert.equal(f.context.document.activeElement, f.node(href), href);
    assert.equal(f.scrolls.at(-1), href);
  }
  assert.deepEqual(pushes, []);
  assert.equal(requests, before);
});

// WEB-01 regression: an explicit smooth scroll animates even when the CSS reduced-motion reset applies.
test('the landing section jump honours a reduced-motion preference', async () => {
  for (const reduce of [true, false]) {
    const f = browserFixture(),
      calls = [];
    f.context.requestAnimationFrame = callback => callback();
    f.context.matchMedia = query => ({matches: reduce && query === '(prefers-reduced-motion: reduce)'});
    f.node('#how-it-works').scrollIntoView = options => calls.push(options);
    f.updateLocation('/#how-it-works');
    await f.run('renderLanding()');
    assert.deepEqual(
      calls.map(options => options.behavior),
      [reduce ? 'auto' : 'smooth'],
    );
  }
});

test('late feature downloads or failures cannot render across a route or identity change', async () => {
  for (const change of ['route', 'identity', 'same-route'])
    for (const failure of [false, true]) {
      const gate = deferred(),
        f = browserFixture();
      let entered = 0;
      f.context.pageAssetsPending = path => path === '/campaigns';
      f.context.ensurePageAssets = async () => {
        await gate.promise;
        if (failure) throw Error('Old asset error');
      };
      f.context.renderWorkspacePage = () => {
        entered++;
        f.node('#content').innerHTML = 'Old campaigns';
      };
      f.updateLocation('/campaigns');
      const pending = f.run('render()');
      // V2-WEB-03: the frame (the page's heading over skeletons) replaced "Loading this page…".
      assert.match(f.node('#content').innerHTML, /id="route-loading"/);
      assert.doesNotMatch(f.node('#content').innerHTML, /Loading this page/);
      if (change === 'identity') f.run('resetPrivateState()');
      else await f.run("navigate('/connections')");
      if (change === 'same-route') f.updateLocation('/campaigns');
      f.node('#content').innerHTML = 'Current page';
      gate.resolve();
      await pending;
      assert.equal(entered, 0, change);
      assert.equal(f.node('#content').innerHTML, 'Current page', change);
    }
});

test('an asset download retry stays on the page; uncertain initialization instead offers a full reload', async () => {
  const f = browserFixture();
  let attempts = 0,
    reloads = 0;
  f.context.pageAssetsPending = () => true;
  f.context.ensurePageAssets = async () => {
    if (++attempts === 1) throw Object.assign(Error('Download unavailable'), {code: 'PAGE_ASSET_UNAVAILABLE'});
  };
  f.updateLocation('/connections');
  await f.run('render()');
  assert.match(f.node('#content').innerHTML, /Download unavailable/);
  assert.equal(f.context.document.activeElement, f.node('h1'));
  await f.node('[data-retry-page]').click();
  assert.equal(attempts, 2);
  assert.doesNotMatch(f.node('#content').innerHTML, /Download unavailable/);
  f.location.reload = () => reloads++;
  // This fixture's query stub finds every selector, so the page would look edited; a pristine page reloads at once,
  // and the unsaved-edit confirmation has its own coverage (tests/asset-version-skew.test.mjs, WEB-04).
  f.context.uiHasUnsavedEdits = () => false;
  f.run("showPageError({code:'PAGE_ASSET_RELOAD_REQUIRED',message:'Reload required'})");
  assert.match(f.node('#content').innerHTML, /Reload page/);
  await f.node('[data-retry-page]').click();
  assert.equal(reloads, 1);
  assert.equal(attempts, 2);
});

test('a failed login page retains an escaped server reference and recovery advice', async () => {
  const f = browserFixture();
  f.updateLocation('/login');
  f.context.renderAuthPage = async () => {
    throw Object.assign(Error('Request could not be processed.'), {
      code: 'INTERNAL_ERROR',
      requestId: 'original-reference-<img>',
      next_action: 'Contact the workspace administrator.',
    });
  };
  await f.run('render()');
  const html = f.node('#content').innerHTML;
  assert.match(html, /Request could not be processed\./);
  assert.match(html, /Contact the workspace administrator\./);
  assert.match(html, /Reference: original-reference-&lt;img&gt;/);
  assert.doesNotMatch(html, /original-reference-<img>/);
  assert.equal(f.context.document.activeElement, f.node('h1'));
});

const report = offset => ({
  id: 'snapshot',
  state: 'complete',
  offset,
  row_count: 300,
  has_more: offset < 200,
  sources: [],
  summary: [],
  exports: [],
  config: {
    name: 'Synthetic report',
    sources: [],
    date_range: {since: '2026-09-01', until: '2026-09-01'},
    metrics: [],
    custom_metrics: [],
  },
  rows: [
    {
      campaign_name: 'Row ' + offset,
      platform: 'google',
      native: {},
      metrics: {},
      recommendation: {decision: 'keep', reason: 'Synthetic'},
    },
  ],
  job: {state: 'complete'},
});

test('failed report pagination retains the displayed page and surfaces the error without rejecting the click', async () => {
  const offsets = [];
  const f = browserFixture(async (_url, options) => {
    const {offset} = JSON.parse(options.body);
    offsets.push(offset);
    if (offset === 100) return response({error: {message: 'Synthetic page unavailable'}}, 503);
    return response({success: true, data: report(offset)});
  });
  f.updateLocation('/reporting-overview');
  await f.run("loadOverviewReport('snapshot')");
  let rejection;
  try {
    await f.node('#report-next').click();
  } catch (e) {
    rejection = e;
  }
  assert.equal(f.run('overviewState.page'), 0, 'keep the displayed page after the failed request');
  assert.equal(rejection, undefined, 'the click handler must handle its failure');
  assert.match(f.node('#auth-error').textContent + f.node('#toast').textContent, /Synthetic page unavailable/);
  assert.deepEqual(offsets, [0, 100]);
});

test('repeated Next clicks while a page is loading cannot skip a report page', async () => {
  const gate = deferred(),
    offsets = [];
  const f = browserFixture(async (_url, options) => {
    const {offset} = JSON.parse(options.body);
    offsets.push(offset);
    if (offset > 0) await gate.promise;
    return response({success: true, data: report(offset)});
  });
  f.updateLocation('/reporting-overview');
  await f.run("loadOverviewReport('snapshot')");
  const first = f.node('#report-next').click(),
    repeated = f.node('#report-next').click();
  gate.resolve();
  await Promise.all([first, repeated]);
  assert.deepEqual(offsets, [0, 100]);
  assert.equal(f.run('overviewState.page'), 1);
});

// WEB-02: every public call to action pointed at a sign-up that production could not complete (no email delivery and
// no social sign-in), and anonymous /connectors offered enabled create-token buttons.
const closedOptions = {providers: [], emailEnabled: false, signupEnabled: true, registrationAvailable: false};
function publicFixture(options) {
  const requests = [];
  const f = browserFixture(async url => {
    requests.push(url);
    return response(url === '/api/account/options' ? options : {});
  });
  f.run('session = {authenticated: false, csrf: null}');
  return {...f, requests};
}
test('the landing offers sign-in, not a sign-up, when registration cannot complete; open registration keeps sign-up', async () => {
  const closed = publicFixture(closedOptions);
  closed.updateLocation('/');
  await closed.run('renderLanding()');
  const html = closed.node('#content').innerHTML;
  assert.deepEqual(closed.requests, ['/api/account/options']);
  assert.doesNotMatch(html, /href="\/signup"/, 'No call to action may lead to an unavailable sign-up');
  assert.match(html, /class="button primary" href="\/login"/);
  assert.match(html, /class="button primary large" href="\/login"/);
  assert.match(html, /Ask your workspace owner for access/);
  // About stays reachable from the footer on phones, and the legal links carry the interface language.
  assert.match(html, /<footer class="public-footer">[\s\S]*href="\/about"/);
  assert.match(html, /href="\/privacy\?lang=en"[\s\S]*href="\/terms\?lang=en"[\s\S]*href="\/data-deletion\?lang=en"/);

  for (const options of [
    {...closedOptions, emailEnabled: true, registrationAvailable: true},
    // An older server without the flag: derived from the same rule.
    {providers: [{id: 'google', configured: true}], emailEnabled: false, signupEnabled: true},
  ]) {
    const open = publicFixture(options);
    open.updateLocation('/');
    await open.run('renderLanding()');
    assert.equal((open.node('#content').innerHTML.match(/href="\/signup"/g) ?? []).length, 4);
    assert.doesNotMatch(open.node('#content').innerHTML, /Ask your workspace owner/);
  }
  // Signed-in visitors go to their workspace without asking about registration.
  const member = browserFixture(async url => assert.fail('No request expected: ' + url));
  member.updateLocation('/');
  await member.run('renderLanding()');
  assert.doesNotMatch(member.node('#content').innerHTML, /href="\/signup"|href="\/login"/);
});

// WEB-07 regression: identity.js kept its own sign-in page, field and social-button builders, which account-security.js
// replaced by reassignment at load time. The copy never rendered, yet this test rendered it, so a fix made there (or a
// regression in the live page) went unnoticed. Each builder is now declared once, and the test renders the live page.
test('a closed sign-up page explains access and links sign-in instead of a disabled form', async () => {
  const scripts = readdirSync('web')
    .filter(file => file.endsWith('.js'))
    .map(file => [file, readFileSync('web/' + file, 'utf8')]);
  for (const name of ['renderAuthPage', 'formField', 'socialButtons'])
    assert.deepEqual(
      scripts
        .filter(([, text]) => new RegExp('(?:^|\\n)(?:async )?function ' + name + '\\(').test(text))
        .map(([f]) => f),
      ['account-security.js'],
      name + ' is declared once',
    );
  for (const [options, closed] of [
    [closedOptions, true],
    [{...closedOptions, emailEnabled: true, registrationAvailable: true}, false],
  ])
    for (const mode of ['/signup', '/login']) {
      const f = publicFixture(options);
      f.run('authBind = () => {}');
      f.run(readFileSync('web/account-security.js', 'utf8'));
      f.updateLocation(mode);
      await f.run('renderAuthPage()');
      const html = f.node('#content').innerHTML;
      assert.match(html, /href="\/about"/, 'The sign-in layout links About');
      if (mode === '/signup') {
        assert.equal(html.includes('id="member-form"'), !closed);
        assert.equal(html.includes('Registration is currently closed.'), closed);
        if (closed) assert.match(html, /class="button primary full" href="\/login"/);
      } else assert.equal(/href="\/signup"/.test(html), !closed, 'Sign-in offers sign-up only when it can complete');
    }
});

// Browser QA regression (wave 2, every /login case): the sign-in page people see is web/account-security.js's
// renderer, which then replaced identity.js's and had dropped WEB-02's About link and closed-registration state. The
// test above rendered only identity.js's version, so it kept passing while the rendered page lost both (WEB-07 removed
// that copy).
test('the live sign-in renderer links About and offers sign-up only when registration can complete', async () => {
  for (const [options, closed] of [
    [closedOptions, true],
    [{...closedOptions, emailEnabled: true, registrationAvailable: true}, false],
  ])
    for (const mode of ['/signup', '/login']) {
      const f = publicFixture(options);
      f.run('authBind = () => {}');
      f.run(readFileSync('web/account-security.js', 'utf8'));
      f.updateLocation(mode);
      await f.run('renderAuthPage()');
      const html = f.node('#content').innerHTML;
      assert.match(html, /<p class="auth-legal"><a href="\/about">About us<\/a><\/p>/, 'The sign-in page links About');
      if (mode === '/signup') {
        assert.equal(html.includes('id="member-form"'), !closed);
        assert.equal(html.includes('Registration is currently closed.'), closed);
        assert.equal(html.includes('data-social'), false, 'No configured social sign-in in these options');
        if (closed) assert.match(html, /class="button primary full" href="\/login"/);
      } else {
        assert.equal(/href="\/signup"/.test(html), !closed, 'Sign-in offers sign-up only when it can complete');
        assert.equal(html.includes('Ask your workspace owner for access.'), closed);
      }
    }
});

test('anonymous MCP connectors offer sign-in instead of enabled create-token buttons', async () => {
  for (const role of [null, 'operator', 'viewer']) {
    const authenticated = role !== null,
      f = browserFixture(async url =>
        response(
          url === '/api/connector-tokens' ? {tokens: []} : url === '/api/mcp/authorizations' ? {clients: []} : {},
        ),
      );
    f.run(
      authenticated
        ? `session = {...nextIdentity, workspaceRole: '${role}', writesEnabled: true, origin: 'https://amcp.invalid'}`
        : "session = {authenticated: false, csrf: null, writesEnabled: true, origin: 'https://amcp.invalid'}",
    );
    f.updateLocation('/connectors');
    await f.run('renderConnectors()');
    const html = f.node('#content').innerHTML;
    assert.equal(html.includes('data-create-token="true"'), authenticated, String(role));
    // A viewer connects read-only tools only (MCP-08).
    assert.equal(html.includes('data-create-operator-token="true"'), role === 'operator', String(role));
    assert.equal(html.includes('Sign in to create a token'), !authenticated, String(role));
  }
});

// WEB-06: titles, breadcrumbs and headings named 11 of 18 pages differently from the navigation ("Creative" opened
// "Media library", "AI connectors" opened "MCP connectors"). They now come from the route registry.
test('each page shows its navigation name as tab title, breadcrumb and heading', async () => {
  const f = browserFixture(async url => response(url === '/api/activity' ? {events: []} : {}));
  const workspace = readFileSync('web/workspace.js', 'utf8');
  f.run(workspace.slice(workspace.indexOf('async function workspaceCall(')));
  for (const [path, label, signedIn] of [
    ['/activity', 'Audit activity', true],
    ['/connections', 'Connections', true],
    ['/settings', 'Workspace settings', true],
    ['/media', 'Creative', false],
    ['/report-library', 'Reporting', false],
    ['/profiles', 'Clients & templates', false],
  ]) {
    f.run(signedIn ? 'session = nextIdentity' : 'session = {authenticated: false, csrf: null}');
    f.updateLocation(path);
    await f.run('render()');
    assert.equal(f.context.document.title, label + ' · AMCP', path);
    assert.equal(f.node('#breadcrumb').textContent, label, path);
    assert.match(f.node('#content').innerHTML, new RegExp('<h1>' + label + '</h1>'), path);
    // V2-WEB-03: and the sentence under it, from the registry (design review S8).
    const subtitle = f.run('routeSubtitle(' + JSON.stringify(path) + ')');
    assert.ok(subtitle.length > 20, path + ' has a registry subtitle');
    assert.ok(
      f.node('#content').innerHTML.includes('<h1>' + label + '</h1><p>' + subtitle + '</p>'),
      path + ' says its registry subtitle',
    );
  }
  // A child page names its parent first.
  f.run('session = nextIdentity');
  f.updateLocation('/oauth/result');
  f.context.renderCallback = async () => {};
  await f.run('render()');
  assert.equal(f.node('#breadcrumb').textContent, 'Connections / Connection result');
});

test('a page that is still loading shows its own heading, never the previous page’s controls', async () => {
  const f = browserFixture(async () => response({platforms: []}));
  f.updateLocation('/connections');
  await f.run('render()');
  assert.match(f.node('#content').innerHTML, /data-action="refresh"/);
  const gate = deferred();
  f.context.gate = gate.promise;
  f.run(
    "renderActivity = async () => { await gate; content.innerHTML = header(uiText('Audit activity'), '') + '<p>Loaded</p>'; }",
  );
  f.context.document.activeElement = null;
  const pending = f.run("navigate('/activity')");
  await new Promise(resolve => setImmediate(resolve));
  const loading = f.node('#content').innerHTML;
  assert.doesNotMatch(loading, /data-action="refresh"/, 'the previous page is gone at once');
  assert.match(loading, /<h1>Audit activity<\/h1>/);
  assert.match(loading, /role="status" aria-busy="true"/);
  assert.notEqual(f.context.document.activeElement, f.node('h1'), 'focus moves only once the page has rendered');
  gate.resolve();
  await pending;
  assert.match(f.node('#content').innerHTML, /Loaded/);
  assert.equal(f.context.document.activeElement, f.node('h1'), 'navigation lands on the page heading');
});

test('Back and Forward land on the page heading after the page renders', async () => {
  const f = browserFixture(async url => response(url === '/api/activity' ? {events: []} : {platforms: []}));
  f.updateLocation('/connections');
  await f.run('render()');
  const [popstate] = f.windowListeners.get('popstate');
  f.context.document.activeElement = null;
  f.updateLocation('/activity');
  await popstate();
  assert.equal(f.context.document.activeElement, f.node('h1'));
  // A Back that is superseded by another navigation leaves focus to the newer page.
  const gate = deferred();
  f.context.gate = gate.promise;
  f.run('renderConnections = async () => { await gate; }');
  f.context.document.activeElement = null;
  f.updateLocation('/connections');
  const back = popstate();
  f.updateLocation('/activity?later=1');
  gate.resolve();
  await back;
  assert.equal(f.context.document.activeElement, null);
});

// SEC-08: a chosen working client stays in the address of the next page (?client=), and that page still receives focus.
// Before, render() added ?client= after a link had pushed its address, so the link's own check no longer matched the
// address, and focus and scrolling were skipped on every page while a client was chosen (Back likewise).
test('with a working client chosen, links and Back keep ?client= and still land on the page heading', async () => {
  const f = browserFixture(async url => response(url.startsWith('/api/activity') ? {events: []} : {platforms: []}));
  const memory = new Map();
  f.context.sessionStorage = {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: key => memory.delete(key),
    key: index => [...memory.keys()][index] ?? null,
    get length() {
      return memory.size;
    },
  };
  f.run(
    "session = {...nextIdentity, workingClients: [{profile_id: 'profile-a', name: 'Client A', accounts: [{gateway: 'meta_native_action', connection_id: 'meta', account_id: '100'}]}]}",
  );
  f.updateLocation('/connections?client=profile-a');
  await f.run('render()');
  f.context.document.activeElement = null;
  f.scrolls.length = 0;
  await f.run("navigate('/activity')");
  assert.equal(f.location.pathname + f.location.search, '/activity?client=profile-a');
  assert.equal(f.context.document.activeElement, f.node('h1'), 'navigation lands on the page heading');
  assert.deepEqual(f.scrolls, ['top']);
  // An older history entry without ?client= gains it from this tab's memory as it renders, and still gets focus.
  const [popstate] = f.windowListeners.get('popstate');
  f.context.document.activeElement = null;
  f.updateLocation('/connections');
  await popstate();
  assert.equal(f.location.pathname + f.location.search, '/connections?client=profile-a');
  assert.equal(f.context.document.activeElement, f.node('h1'));
});

test('a failed shell action stays on screen until the next action, then clears', async () => {
  let fail = true;
  const f = browserFixture(async () =>
    fail
      ? response({error: {code: 'UNAVAILABLE', message: 'Platforms unavailable'}, meta: {requestId: 'req-1'}}, 503)
      : response({platforms: []}),
  );
  f.updateLocation('/connections');
  const click = dataset =>
    f.documentListeners.get('click')[0]({
      target: {closest: () => ({tagName: 'BUTTON', dataset, isConnected: true, getAttribute: () => null})},
      button: 0,
      preventDefault() {},
    });
  await click({action: 'refresh'});
  const alert = f.node('#shell-alert');
  assert.equal(alert.hidden, false);
  assert.match(alert.textContent, /Platforms unavailable/);
  assert.match(alert.textContent, /req-1/);
  assert.doesNotMatch(f.node('#toast').textContent, /Platforms unavailable/, 'not a six-second toast');
  fail = false;
  await click({filter: 'connected'});
  assert.equal(alert.hidden, true);
  assert.equal(alert.textContent, '');
  // Opening another page clears it too.
  fail = true;
  await click({action: 'refresh'});
  assert.equal(alert.hidden, false);
  fail = false;
  await f.run("navigate('/activity')");
  assert.equal(alert.hidden, true);
});

test('the access line names the person’s role and the deployment, not the deployment alone', async () => {
  const f = browserFixture(async () => response({platforms: []}));
  f.updateLocation('/connections');
  for (const [session, expected] of [
    [{authenticated: false}, 'Not signed in'],
    [
      {authenticated: true, testAccount: true, workspaceRole: 'owner', writesEnabled: true},
      'Test account · Read + reviewed writes',
    ],
    // Outside its own test workspace a test account is a viewer (/api/account reports it): no reviewed writes there.
    [
      {authenticated: true, testAccount: true, workspaceRole: 'viewer', writesEnabled: true},
      'Test account · Read-only access',
    ],
    [{authenticated: true, workspaceRole: 'viewer', writesEnabled: true}, 'Viewer · read-only access'],
    [{authenticated: true, workspaceRole: 'operator', writesEnabled: true}, 'Operator · read + reviewed writes'],
    [{authenticated: true, workspaceRole: 'admin', writesEnabled: true}, 'Admin · read + reviewed writes'],
    [{authenticated: true, workspaceRole: 'owner', writesEnabled: true}, 'Owner · read + reviewed writes'],
    [{authenticated: true, workspaceRole: 'owner', writesEnabled: false}, 'Owner · read-only workspace'],
    [
      {authenticated: true, administrator: true, workspaceRole: 'owner', writesEnabled: true},
      'Deployment administrator · read + reviewed writes',
    ],
  ]) {
    f.context.nextSession = {...identity(), ...session};
    f.run('session = nextSession');
    await f.run('render()');
    // V2-WEB-03: the words sit in a span, so the rail can clip them without removing them.
    assert.equal(
      f.node('.readonly-indicator').innerHTML,
      '<i></i><span>' + expected + '</span>',
      JSON.stringify(session),
    );
    assert.equal(f.node('.sidebar .brand').href, session.authenticated ? '/dashboard' : '/');
  }
});

test('the sidebar workspace card switches workspaces in place and clears the previous workspace’s state', async () => {
  const requests = [];
  const f = browserFixture(async (url, options = {}) => {
    requests.push((options.method ?? 'GET') + ' ' + url);
    return response(
      {
        '/api/workspaces': {
          workspaces: [
            {id: 'workspace-a', name: 'Agency <A>', role: 'viewer'},
            {id: 'workspace-b', name: 'Client B', role: 'operator'},
          ],
        },
        '/api/workspaces/switch': {},
        '/api/session': {...identity('workspace-b'), workspaceRole: 'operator'},
        '/api/platforms': {platforms: []},
      }[url] ?? {},
    );
  });
  f.updateLocation('/campaigns?id=plan-in-a');
  f.context.renderWorkspacePage = async () => {};
  await f.run('render()');
  assert.equal(f.node('#workspace-switch-open').hidden, false);
  assert.deepEqual(requests, [], 'nothing is read until the switcher opens');
  const click = el =>
    f.documentListeners.get('click')[0]({target: {closest: () => el}, button: 0, preventDefault() {}});
  await click({...f.node('#workspace-switch-open'), tagName: 'BUTTON', id: 'workspace-switch-open', dataset: {}});
  const menu = f.node('#workspace-switch-menu');
  assert.equal(menu.hidden, false);
  assert.match(menu.innerHTML, /data-shell-switch="workspace-b"/);
  assert.match(menu.innerHTML, /Agency &lt;A&gt;/);
  assert.match(menu.innerHTML, /data-shell-switch="workspace-a" aria-current="true" disabled/);
  seedPrivateState(f);
  await click({tagName: 'BUTTON', dataset: {shellSwitch: 'workspace-b'}, isConnected: true});
  assert.deepEqual(requests, [
    'GET /api/workspaces',
    'POST /api/workspaces/switch',
    'GET /api/session',
    'GET /api/platforms',
  ]);
  assert.equal(f.run('session.workspaceId'), 'workspace-b');
  assertPrivateStateCleared(f);
  assert.equal(f.location.pathname + f.location.search, '/campaigns', 'IDs from the previous workspace are dropped');
  // A test account has one workspace and no switcher.
  f.run('session = {...nextIdentity, testAccount: true}');
  await f.run('render()');
  assert.equal(f.node('#workspace-switch-open').hidden, true);
});

// CMP-06: unsaved playbook edits were dropped silently when a navigation link was followed.
test('an in-app link asks before leaving unsaved edits; render and identity resets clear the guard', async () => {
  const f = browserFixture();
  f.updateLocation('/connections');
  await f.run('render()');
  const asked = [],
    pushes = [];
  let answer = false;
  f.context.confirmAction = async options => {
    asked.push(options.title);
    return answer;
  };
  f.context.history.pushState = (_a, _b, url) => pushes.push(url);
  const link = {
    tagName: 'A',
    dataset: {},
    getAttribute: name => (name === 'href' ? '/profiles' : null),
    hasAttribute: () => false,
  };
  const click = () =>
    f.documentListeners.get('click')[0]({target: {closest: () => link}, button: 0, preventDefault() {}});
  // Nothing unsaved: no question.
  await click();
  assert.deepEqual(asked, []);
  assert.deepEqual(pushes, ['/profiles']);
  f.run('pageLeaveGuard = () => true');
  await click();
  assert.deepEqual(asked, ['Leave without saving?']);
  assert.deepEqual(pushes, ['/profiles'], 'a cancelled leave stays on the page');
  answer = true;
  await click();
  assert.deepEqual(pushes, ['/profiles', '/profiles']);
  assert.equal(f.run('pageLeaveGuard'), null, 'the next render clears the guard');
  f.run('pageLeaveGuard = () => true; resetPrivateState()');
  assert.equal(f.run('pageLeaveGuard'), null, 'signing out or switching workspace is never blocked');
});
