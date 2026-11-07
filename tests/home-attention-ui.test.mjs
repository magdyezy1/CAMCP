// OPS-06: Home kept its own list of plan states (blocked, failed, uncertain, awaiting_review, mismatch), so a plan the
// campaign runner put in `attention` vanished and Home read "No saved campaign plans currently need attention."; uploads,
// exports, incidents and the other Operations kinds never reached Home at all, and its readiness and capability blocks
// listed every account and tool name. These tests guard that Home renders the Operations classifier's attention page,
// names every feed kind in both languages, keeps the long lists collapsed, and that the new Operations kinds open their
// exact recovery views.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {operationsPage} from '../dist/src/operations-feed.js';
import {operationKinds} from '../dist/src/operation-types.js';

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
const escape = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c],
  );

/** localization.js, workspace.js and work-center.js in a page with the given language, as Home loads them. */
function home(locale) {
  const content = {innerHTML: ''},
    calls = [];
  const context = createContext({
    URL,
    URLSearchParams,
    Map,
    Set,
    Intl,
    content,
    document: {addEventListener() {}, querySelector: () => null, querySelectorAll: () => []},
    esc: escape,
    date: value => 'at ' + value,
    header: (title, description, action) => `<h1>${title}</h1><p>${description}</p>${action}`,
    glyph: () => '',
    session: {name: 'Synthetic Person'},
    workspaceBind() {},
    navigationGeneration: 1,
    identityGeneration: 1,
    catalog,
    calls,
  });
  const run = source => new Script(source).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  run(fs.readFileSync('web/routes.js', 'utf8'));
  run(fs.readFileSync('web/workspace.js', 'utf8'));
  run(fs.readFileSync('web/work-center.js', 'utf8'));
  if (locale === 'ar') run("uiLocale='ar'; uiMessages=new Map(Object.entries(catalog))");
  return {run, context, content, calls};
}
/** The markup a reader sees without opening any disclosure (nested <details> included). */
function collapsed(html) {
  let depth = 0,
    out = '';
  for (const part of html.split(/(<details\b[^>]*>|<\/details>)/)) {
    if (part.startsWith('<details')) depth++;
    else if (part === '</details>') depth--;
    else if (!depth) out += part;
  }
  return out;
}
const section = (html, heading) => {
  const start = html.indexOf('<h2>' + heading + '</h2>');
  assert.ok(start >= 0, heading);
  return html.slice(start, html.indexOf('</section>', start));
};

const actor = {tenantId: 'home', userId: 'operator', role: 'operator'};
/** A plan in `attention`, an uncertain upload, a failed export and an open incident, plus work that needs nothing. */
function attentionFixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 71).toString('base64'));
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'meta',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      writeAccounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const source = {platform: 'meta', connection_id: 'meta', account_id: '100'},
    put = (kind, id, value) => store.putDocument(actor.tenantId, kind, id, value),
    step = {gateway: 'meta_native_action', ...source, status: 'uncertain'};
  put('campaign_run', 'plan', {
    user_id: actor.userId,
    name: 'Launch',
    state: 'attention',
    updated_at: 900,
    steps: [step],
  });
  put('campaign_run', 'draft', {user_id: actor.userId, name: 'Draft', state: 'draft', updated_at: 950, steps: [step]});
  put('media_review', 'upload', {
    user_id: actor.userId,
    plan: {...source, name: 'Film'},
    created_at: 800,
    expires_at: Date.now() + 300000,
  });
  store.claim(actor.tenantId, 'upload', 'hash');
  store.uncertain(actor.tenantId, 'upload');
  put('overview_report', 'report', {state: 'complete', created_at: 700, config: {name: 'Results', sources: [source]}});
  const job = store.enqueue(actor.tenantId, 'sheets_export', {report_id: 'report', export_id: 'export'});
  store.db
    .prepare("UPDATE jobs SET state='failed',error=?,updated_at=600 WHERE id=?")
    .run(JSON.stringify({code: 'ACCESS_REQUIRED', message: 'synthetic'}), job);
  put('overview_export', 'export', {report_id: 'report', job_id: job});
  put('report_incident', 'incident', {...source, monitor_name: 'Spend ceiling', state: 'open', updated_at: 400});
  return store;
}

test('Home lists a plan in attention, an uncertain upload, a failed export and an open incident from the classifier', () => {
  const store = attentionFixture();
  try {
    // The page Home asks for: the server scopes and classifies, and Home renders what comes back.
    const feed = operationsPage(store, actor, {state: 'attention', limit: 8}, true);
    assert.deepEqual(new Set(feed.operations.map(o => o.kind)), new Set(['campaign', 'upload', 'export', 'incident']));
    const dashboard = {
      campaigns: [
        {id: 'plan', name: 'Launch', state: 'attention', updated_at: 900},
        {id: 'draft', name: 'Draft', state: 'draft', updated_at: 950},
      ],
      connections: [],
      writes_paused: null,
    };
    for (const locale of ['en', 'ar']) {
      const page = home(locale);
      page.context.d = dashboard;
      page.context.feed = JSON.parse(JSON.stringify(feed));
      const html = page.run('workHome(d, [{}], feed)'),
        label = text => (locale === 'ar' ? catalog[text] : text),
        attention = section(html, label('Needs attention'));
      // Before, only `/campaigns?id=` links for five hard-coded plan states appeared here; `attention` was not one.
      for (const path of [
        '/campaigns?id=plan',
        '/media?review_id=upload',
        '/reporting-overview?report_id=report',
        '/monitors?incident_id=incident',
      ])
        assert.ok(attention.includes(`href="${path}"`), locale + ' ' + path);
      assert.doesNotMatch(attention, /campaigns\?id=draft/, 'A draft needs no attention');
      for (const kind of ['Campaign plan', 'Media upload', 'Export job', 'Incident'])
        assert.ok(attention.includes(label(kind) + ' · '), locale + ' ' + kind);
      assert.ok(attention.includes(label('Needs attention')), 'The plan state badge');
      assert.ok(attention.includes(`href="/operations?state=attention"`));
      assert.ok(
        attention.includes(
          label(
            'The most recent work that needs attention. Operations reads a bounded number of records per page and lists the rest.',
          ),
        ),
      );
      // Feed names stay literal; every word AMCP adds is Arabic.
      if (locale === 'ar')
        assert.doesNotMatch(
          collapsed(attention)
            .replace(/<[^>]+>/g, ' ')
            .replace(/Launch|Film|Results|Spend ceiling/g, ''),
          /[A-Za-z]{3,}/,
        );
      // The recent-work list keeps every plan, the draft included.
      assert.match(section(html, label('Continue recent work')), /campaigns\?id=draft/);
    }
  } finally {
    store.close();
  }
});

test('Home names every Operations kind in both languages, and its empty state names them all', () => {
  const english = home('en'),
    arabic = home('ar');
  for (const kind of operationKinds) {
    english.context.kind = kind;
    arabic.context.kind = kind;
    const name = english.run('homeOperationKind(kind)');
    assert.notEqual(name, 'Work', kind + ' has a Home label');
    assert.ok(Object.hasOwn(catalog, name), name);
    assert.equal(arabic.run('homeOperationKind(kind)'), catalog[name]);
  }
  const empty =
    'Nothing needs attention: no campaign plans, uploads, reports, exports, schedules, incidents, workbook runs, reviewed changes, email notices or connection logins.';
  for (const noun of [
    'campaign plans',
    'uploads',
    'reports',
    'exports',
    'schedules',
    'incidents',
    'workbook runs',
    'reviewed changes',
    'email notices',
    'connection logins',
  ])
    assert.ok(empty.includes(noun), noun);
  english.context.d = {campaigns: [], connections: [], writes_paused: null};
  arabic.context.d = english.context.d;
  for (const [page, text] of [
    [english, empty],
    [arabic, catalog[empty]],
  ]) {
    assert.ok(page.run('workHome(d, [{}], {operations: [], has_more: false})').includes(text));
    // Before this page loads, or when the feed had nothing to say, the same sentence.
    assert.ok(page.run('workHome(d, [{}])').includes(text));
  }
  // An empty first page with more to scan does not claim that nothing needs attention.
  const bounded = english.run('workHome(d, [{}], {operations: [], has_more: true})');
  assert.ok(bounded.includes('None of the most recent records needs attention. Open Operations to check older ones.'));
  assert.ok(!bounded.includes(empty));
  // A failed feed says so instead of reading as an empty one.
  const failed = english.run("workHome(d, [{}], {error: new Error('offline')})");
  assert.match(failed, /role="alert">Could not load the work that needs attention\. Open Operations to see it\./);
  assert.ok(!failed.includes(empty));
});

test('Home links only to internal paths and escapes feed names', () => {
  const page = home('en');
  page.context.d = {campaigns: [], connections: [{enabled: false}, {enabled: true}], writes_paused: null};
  page.context.feed = {
    operations: [
      {
        kind: 'notice',
        name: '<img src=x>',
        state: 'failed',
        website_path: 'https://elsewhere.invalid/x',
        updated_at: 1,
      },
      {kind: 'connection', name: 'Login', state: 'reauthorization_required', website_path: '//elsewhere.invalid'},
      {kind: 'write', name: 'Change', state: 'uncertain', website_path: '/operations?write_id=w%201'},
    ],
  };
  const html = page.run('workHome(d, [{}], feed)');
  assert.doesNotMatch(html, /elsewhere\.invalid/);
  assert.equal(html.match(/href="\/operations\?state=attention"/g).length, 3);
  assert.ok(html.includes('href="/operations?write_id=w%201"'));
  assert.ok(html.includes('&lt;img src=x&gt;'));
  // A record's name is the person's own text: its own direction, literal in Arabic (design review 2026-10, WEB-05).
  assert.ok(html.includes('<strong dir="auto" data-native>&lt;img src=x&gt;</strong>'));
  assert.ok(html.includes('Monitor email notice · '));
  assert.ok(html.includes('>Reauthorization required</span>'));
  // The dashboard's own connection facts: one login is turned off.
  assert.match(html, /Connection logins turned off: 1\./);
});

// Design review 2026-10 (WEB-06): an empty workspace's Home offered two primary actions, "New campaign plan" in the
// heading and "Set up connections" in the first panel; a plan needs a connected account first.
test('Home has one primary action: Set up connections until an account is connected, then New campaign plan', () => {
  const page = home('en');
  page.context.d = {campaigns: [], connections: [], writes_paused: null};
  const primaries = html => [...html.matchAll(/<a [^>]*class="button primary"[^>]*>([^<]+)</g)].map(m => m[1]);
  assert.deepEqual(primaries(page.run('workHome(d, [], {operations: [], has_more: false})')), ['Set up connections']);
  assert.deepEqual(primaries(page.run('workHome(d, [{}], {operations: [], has_more: false})')), ['New campaign plan']);
});

test('Home asks Operations for its attention page, keeps readiness and capability detail collapsed, and survives a failed feed', async () => {
  const accounts = ['101', '102', '103', '104', '105', '106'],
    checks = [
      {ready: true, checked_at: 1},
      {ready: true, checked_at: 1},
      {blocked: true, checked_at: 1},
      {ready: true, stale: true, checked_at: 1},
      {},
      {readiness: 'not_applicable'},
    ],
    dashboard = {
      connections: [
        {
          id: 'meta',
          gateway: 'meta_native_action',
          label: 'Synthetic',
          enabled: true,
          write_accounts: ['101'],
          accounts_status: accounts.map((account_id, i) => ({account_id, check: checks[i], verified_writes: []})),
        },
      ],
      campaigns: [],
      writes_paused: null,
      capabilities: {
        meaning: 'Capability meaning',
        features: [
          {name: 'Feature A', coverage: 'Coverage A', tool: 'amcp_tool_a', implementation: 'implemented_unverified'},
          {name: 'Feature B', coverage: 'Coverage B', tool: 'amcp_tool_b', implementation: 'implemented_unverified'},
        ],
        evidence: [{gateway: 'meta_native_action', account_id: '101'}],
      },
    };
  for (const failing of [false, true]) {
    const page = home('en');
    page.context.workspaceCall = async (tool, args) => {
      page.calls.push({tool, args});
      if (args.action === 'dashboard') return dashboard;
      if (failing) throw Object.assign(Error('offline'), {code: 'NETWORK'});
      return {operations: [], has_more: false};
    };
    await page.run('renderOverview()');
    assert.deepEqual(JSON.parse(JSON.stringify(page.calls)), [
      {tool: 'workspace', args: {action: 'dashboard', view: 'full'}},
      {tool: 'workspace', args: {action: 'operations', state: 'attention', limit: 8}},
    ]);
    const html = page.content.innerHTML,
      visible = collapsed(html);
    // Counted as the badges show them: the stale check is to be checked again; the login without a read is left out.
    assert.ok(html.includes('Ready: 2 · Blocked: 1 · To check: 2'), html);
    // Each account row and each tool name is one disclosure away, so Home on a phone stays short (before: 6 rows and
    // every tool name with an evidence badge were always open).
    assert.equal((html.match(/class="token-row"/g) ?? []).length, accounts.length + 2);
    assert.doesNotMatch(visible, /class="token-row"|amcp_tool_|data-check-account/);
    // DOC-03: Home says in plain words what each capability does; the server's evidence sentence moved under Technical
    // details with the tool names and evidence states (before, that engineering sentence was Home's visible copy).
    assert.ok(!visible.includes('Capability meaning') && html.includes('Capability meaning'));
    assert.ok(visible.includes('Each is tested against simulated platforms.'));
    assert.ok(visible.includes('<li>Feature A</li>'), 'a capability without an outcome label shows its name');
    assert.ok(visible.includes('href="/capabilities"'));
    assert.ok(visible.length < html.length / 2, 'Most of the former Home height is collapsed');
    if (failing) assert.match(html, /Could not load the work that needs attention/);
    else assert.ok(html.includes('Nothing needs attention'));
  }
});

test('the new Operations kinds have localized guidance and open their exact recovery views', () => {
  const source = fs.readFileSync('src/operations-feed.ts', 'utf8'),
    handoffs = source.slice(
      source.indexOf("if (kind === 'notice')"),
      source.indexOf("if (kind === 'workbook_schedule')"),
    ),
    guidance = [...handoffs.matchAll(/'([A-Z][^']{60,})'/g)].map(m => m[1]);
  assert.equal(guidance.length, 5, 'two notice and three connection instructions');
  const context = createContext({
    document: {addEventListener() {}, querySelector: () => null, querySelectorAll: () => []},
    esc: escape,
    pretty: value => String(value).replaceAll('_', ' '),
    catalog,
    Intl,
    Map,
  });
  new Script(fs.readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(fs.readFileSync('web/routes.js', 'utf8')).runInContext(context);
  new Script(fs.readFileSync('web/operations-center.js', 'utf8')).runInContext(context);
  new Script("uiLocale='ar'; uiMessages=new Map(Object.entries(catalog))").runInContext(context);
  for (const text of guidance) {
    context.text = text;
    assert.ok(Object.hasOwn(catalog, text), text);
    assert.equal(new Script('operationGuidance(text)').runInContext(context), catalog[text], text);
  }
  for (const kind of ['notice', 'connection']) {
    context.kind = kind;
    assert.equal(
      new Script('operationLabel(kind)').runInContext(context),
      catalog[kind === 'notice' ? 'Monitor email notice' : 'Connection login'],
    );
  }
});

/** web/app.js without its start-up, as tests/connection-localization.test.mjs loads it. */
function connectionsPage(search) {
  const nodes = new Map(),
    replaced = [];
  const node = selector => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        innerHTML: '',
        textContent: '',
        dataset: {},
        hidden: true,
        isConnected: true,
        classList: {add() {}, remove() {}, toggle() {}},
        getAttribute: () => null,
        setAttribute() {},
        addEventListener() {},
        querySelector: node,
        querySelectorAll: () => [],
        append() {},
        focus() {},
        close() {
          this.open = false;
        },
        showModal() {
          this.open = true;
        },
      });
    return nodes.get(selector);
  };
  const context = createContext({
    catalog,
    Intl,
    Date,
    URL,
    URLSearchParams,
    location: {pathname: '/connections', search, hash: '', assign() {}},
    history: {replaceState: (_state, _title, url) => replaced.push(url), pushState() {}},
    window: {addEventListener() {}, scrollTo() {}},
    document: {
      querySelector: node,
      getElementById: id => node('#' + id),
      querySelectorAll: () => [],
      createElement: () => node('section'),
      body: {classList: {toggle() {}}},
      addEventListener() {},
    },
    setTimeout: () => 1,
    clearTimeout() {},
    pretty: value => String(value).replaceAll('_', ' '),
  });
  const run = code => new Script(code).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  run(fs.readFileSync('web/routes.js', 'utf8'));
  const app = fs.readFileSync('web/app.js', 'utf8'),
    start = app.indexOf('(async () => {'),
    end = app.indexOf('})();', start) + 5;
  run(app.slice(0, start) + app.slice(end));
  run("session={authenticated:true,administrator:false,workspaceRole:'owner',origin:'https://amcp.invalid'};");
  context.platform = {
    id: 'google',
    name: 'Google',
    kind: 'Advertising',
    description: 'Provider description',
    configured: true,
    selectionKind: 'ad_accounts',
    selectableKinds: ['ad_accounts'],
    assetKinds: ['ad_accounts'],
    gateway: 'google_ads_native_action',
    callback: 'https://amcp.invalid/oauth/google/callback',
    scopes: ['https://www.googleapis.com/auth/adwords'],
    env: 'GOOGLE',
    connections: ['other', 'login-002'].map((id, i) => ({
      id,
      name: 'Login ' + i,
      gateway: 'google_ads_native_action',
      enabled: true,
      isDefault: i === 0,
      accounts: ['00123' + i],
      writeAccounts: [],
      defaultWriteAccess: false,
      selected: [],
      groups: [],
    })),
  };
  run('platforms=[platform]');
  return {run, node, replaced};
}

test('an Operations connection link opens that login in Connections once; an unknown one says so', () => {
  const page = connectionsPage('?connection_id=login-002');
  page.run('openLinkedConnection()');
  assert.equal(page.node('#manage-dialog').open, true);
  // Not the platform's default login: the exact one the Operations item named.
  assert.equal(page.run('currentConnection'), 'login-002');
  assert.deepEqual(page.replaced, ['/connections']);
  const missing = connectionsPage('?connection_id=gone');
  missing.run('openLinkedConnection()');
  assert.notEqual(missing.node('#manage-dialog').open, true);
  assert.equal(missing.node('#toast').textContent, 'That connection is no longer in this workspace.');
  const plain = connectionsPage('');
  plain.run('openLinkedConnection()');
  assert.notEqual(plain.node('#manage-dialog').open, true);
  assert.deepEqual(plain.replaced, []);
});
