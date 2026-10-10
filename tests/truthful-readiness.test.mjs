// CON-03: truthful readiness. Before it: GA4, Tag Manager, Search Console and Apple checks threw a contract error that
// the catch turned into "blocked — Reconnect" with zero provider requests; Drive and Sheets showed a readiness badge;
// only Meta, LinkedIn, Reddit and Microsoft could ever pass the write-permission check; one member's check (role and
// requirements included) was stored for everyone, so a reader's check flipped the administrator's badge; the Home
// badge never went stale; and every capability dependency was the placeholder `requires_evidence`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {providerGrant, recordedWriteGrant} from '../dist/src/provider-grants.js';
import {readinessId, readinessLifetimeMs} from '../dist/src/readiness.js';
import {writeContractGateways} from '../dist/src/write-shape.js';

const tenantId = 'readiness',
  admin = {tenantId, userId: 'owner', role: 'admin'},
  reader = {tenantId, userId: 'viewer', role: 'reader'},
  g = s => 'https://www.googleapis.com/auth/' + s,
  site = 'https://example.com/';

function fixture(respond = () => undefined) {
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64')),
    requests = [];
  const transport = new NativeTransport(
    async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        method: init?.method ?? 'GET',
        href: url.origin + url.pathname,
        context: new Headers(init?.headers).get('X-AP-Context'),
      });
      const custom = respond(url);
      if (custom) return custom;
      if (url.origin === 'https://graph.facebook.com')
        return Response.json({id: url.pathname.split('/').at(-1), currency: 'USD', timezone_name: 'UTC'});
      if (url.origin === 'https://analyticsadmin.googleapis.com')
        return Response.json({name: 'properties/123456', currencyCode: 'EUR', timeZone: 'Europe/Berlin'});
      if (url.origin === 'https://tagmanager.googleapis.com') return Response.json({accountId: '6000', name: 'Tags'});
      if (url.origin === 'https://www.googleapis.com')
        return Response.json({siteUrl: site, permissionLevel: 'siteRestrictedUser'});
      if (url.origin === 'https://api.ads.apple.com')
        return Response.json({data: null, result: {id: 777, name: 'Apple account', currency: 'USD'}});
      throw Error('Unexpected synthetic provider route: ' + url.href);
    },
    async () => {},
  );
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const add = (id, gateway, scopes, accounts = ['100'], extra = {}) =>
    store.putConnection(
      admin,
      {id, tenantId, gateway, accounts, writeAccounts: accounts, enabled: true, label: id, scopes, ...extra},
      {accessToken: 'synthetic-' + id},
    );
  const grants = (id, value) =>
    store.putDocument(tenantId, 'website_connection', id, {platform: 'synthetic', createdAt: 1, grants: value});
  const call = async (input, actor = admin) => {
    const r = await service.call('amcp_workspace', input, actor);
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
    return r.data;
  };
  return {store, requests, add, grants, call, close: () => store.close()};
}
const knownMeta = (granted, declined = []) => ({
  source: 'permissions_endpoint',
  known: true,
  granted,
  declined,
  expired: [],
  checked_at: Date.now(),
});
const scopeCheck = r => r.checks.find(c => c.key === 'provider_scopes');
const readCheck = r => r.checks.find(c => c.key === 'provider_read');
const advice = r => r.checks.map(c => (c.message ?? '') + ' ' + (c.next_step ?? '')).join(' | ');

test('write readiness of every reviewed-write provider is passed, blocked or unknown consistently with enforcement', async () => {
  const f = fixture();
  try {
    const satisfy = w => [...(w.all ?? []), ...(w.any?.slice(0, 1) ?? [])];
    const seen = {};
    for (const gateway of writeContractGateways) {
      const grant = providerGrant(gateway),
        id = gateway.replace(/_native_action$/, '');
      f.add(id + '-ok', gateway, grant.write ? satisfy(grant.write) : []);
      f.add(id + '-none', gateway, []);
      if (grant.grantSource === 'permissions_endpoint') f.grants(id + '-ok', knownMeta(satisfy(grant.write)));
      const check = async suffix =>
        scopeCheck(
          await f.call({action: 'check', connection_id: id + suffix, account_id: '100', requirements: {write: true}}),
        );
      const ok = await check('-ok'),
        none = await check('-none');
      seen[id] = [ok.status, none.status];
      const enforced = recordedWriteGrant({gateway, scopes: satisfy(grant.write ?? {})});
      if (grant.write) {
        // Passed exactly where enforcement accepts the recorded scopes; blocked with a reauthorize step where it refuses.
        assert.equal(enforced, true, gateway);
        assert.equal(ok.status, 'passed', gateway);
        assert.equal(none.status, 'blocked', gateway);
        assert.match(none.next_step, /Reauthorize this login/);
        assert.deepEqual(none.missing_scopes.length > 0, true, gateway);
      } else {
        assert.equal(enforced, undefined, gateway);
        assert.deepEqual([ok.status, none.status], ['unknown', 'unknown'], gateway);
      }
    }
    // Before CON-03 only meta, linkedin, reddit and microsoft could reach "passed".
    assert.deepEqual(Object.keys(seen).filter(k => seen[k][0] === 'passed').length, writeContractGateways.size - 3);
    assert.equal(f.requests.length, 0, 'live:false checks contact no provider');
    // X records only the access type AMCP asked for: read-only is a definite blocker, write stays unknown.
    f.add('x-read', 'x_ads_native_action', []);
    f.grants('x-read', {source: 'requested_access_type', known: false, requested_access_type: 'read'});
    const x = scopeCheck(
      await f.call({action: 'check', connection_id: 'x-read', account_id: '100', requirements: {write: true}}),
    );
    assert.equal(x.status, 'blocked');
    assert.match(x.next_step, /allow write access/);
  } finally {
    f.close();
  }
});

test('Meta write permission is unknown until Meta confirms it, and a declined ads_management blocks with a reauthorize step', async () => {
  const f = fixture();
  try {
    f.add('meta', 'meta_native_action', ['ads_read', 'ads_management']);
    const write = async () =>
      f.call({action: 'check', connection_id: 'meta', account_id: '100', requirements: {write: true}});
    // Recorded from the request only (the exchange returns no scope): never "passed".
    let s = scopeCheck(await write());
    assert.equal(s.status, 'unknown');
    assert.equal(s.known, false);
    f.grants('meta', {source: 'permissions_endpoint', known: false, reason: 'UPSTREAM_ERROR', checked_at: 1});
    assert.equal(scopeCheck(await write()).status, 'unknown', 'a failed permissions read is unknown');
    f.store.updateConnection(admin, {...f.store.listConnections(tenantId)[0], scopes: ['ads_read']});
    f.grants('meta', knownMeta(['ads_read'], ['ads_management']));
    s = scopeCheck(await write());
    assert.equal(s.status, 'blocked');
    assert.deepEqual(s.declined_scopes, ['ads_management']);
    assert.match(s.next_step, /^Reauthorize this login from Connections/);
  } finally {
    f.close();
  }
});

test('GA4, Tag Manager, Search Console and Apple checks each perform exactly one scoped read of the selected resource', async () => {
  const f = fixture();
  try {
    f.add('ga4', 'ga4_native_action', [g('analytics.readonly')], ['123456']);
    f.add('gtm', 'gtm_native_action', [g('tagmanager.readonly')], ['6000']);
    f.add('gsc', 'google_search_console_native_action', [g('webmasters.readonly')], [site]);
    f.add('apple', 'apple_ads_native_action', ['searchadsorg'], ['777']);
    const expected = {
      ga4: ['123456', 'https://analyticsadmin.googleapis.com/v1beta/properties/123456'],
      gtm: ['6000', 'https://tagmanager.googleapis.com/tagmanager/v2/accounts/6000'],
      gsc: [site, 'https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(site)],
      apple: ['777', 'https://api.ads.apple.com/v1/ad-accounts/777'],
    };
    for (const [id, [account, href]] of Object.entries(expected)) {
      const before = f.requests.length;
      const r = await f.call({action: 'check', connection_id: id, account_id: account, live: true});
      assert.equal(f.requests.length - before, 1, id + ' performs exactly one read');
      assert.deepEqual(
        [f.requests.at(-1).method, f.requests.at(-1).href.replace(/%2F/g, '%2F')],
        ['GET', href.replace(/%2F/g, '%2F')],
      );
      assert.equal(readCheck(r).status, 'passed', id + ': ' + JSON.stringify(r.checks));
      assert.equal(r.ready, true, id);
      assert.equal(r.readiness, 'account_read');
    }
    assert.equal(f.requests.find(r => r.href.startsWith('https://api.ads.apple.com')).context, 'adAccountId=777;');
    const ga4 = await f.call({action: 'check', connection_id: 'ga4', account_id: '123456', live: true});
    assert.deepEqual(ga4.account, {currency: 'EUR', timezone: 'Europe/Berlin'});
  } finally {
    f.close();
  }
  // A read that names another property is not evidence for the selected one.
  const wrong = fixture(url =>
    url.origin === 'https://analyticsadmin.googleapis.com' ? Response.json({name: 'properties/999'}) : undefined,
  );
  try {
    wrong.add('ga4', 'ga4_native_action', [g('analytics.readonly')], ['123456']);
    const r = await wrong.call({action: 'check', connection_id: 'ga4', account_id: '123456', live: true});
    assert.equal(readCheck(r).status, 'blocked');
    assert.equal(readCheck(r).code, 'STATE_TARGET_MISMATCH');
    assert.doesNotMatch(advice(r), /reconnect|reauthori/i);
  } finally {
    wrong.close();
  }
});

test('no reconnect or reauthorize advice appears without a provider authentication failure', async () => {
  for (const [status, expected] of [
    [403, /account administrator/],
    [404, /Inspect the provider diagnostic/],
    [401, /Reauthorize it from Connections/],
  ]) {
    const f = fixture(url =>
      url.origin === 'https://analyticsadmin.googleapis.com'
        ? Response.json({error: {code: status, message: 'Synthetic refusal'}}, {status})
        : undefined,
    );
    try {
      f.add('ga4', 'ga4_native_action', [g('analytics.readonly')], ['123456']);
      const r = await f.call({action: 'check', connection_id: 'ga4', account_id: '123456', live: true});
      const read = readCheck(r);
      assert.equal(read.status, 'blocked', String(status));
      assert.match(read.next_step, expected);
      if (status !== 401) assert.doesNotMatch(advice(r), /reconnect|reauthori/i, String(status));
      assert.doesNotMatch(advice(r), /reconnect/i, 'reconnecting would orphan saved work; renewal is in place');
    } finally {
      f.close();
    }
  }
  // A disabled connection and the deployment checks name their own remedy, not a reconnect.
  const f = fixture();
  try {
    f.add('meta', 'meta_native_action', ['ads_management'], ['100'], {enabled: false});
    const r = await f.call({
      action: 'check',
      connection_id: 'meta',
      account_id: '100',
      live: true,
      requirements: {write: true},
    });
    assert.doesNotMatch(advice(r), /reconnect/i);
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});

test('Drive and Sheets are not applicable: no badge, no account read, no "Check account"', async () => {
  const f = fixture();
  try {
    f.add('drive', 'google_drive_native_action', [g('drive.readonly')], ['file-1']);
    f.add('sheets', 'google_sheets_native_action', [g('drive.file')], ['sheet-1']);
    for (const [id, account] of [
      ['drive', 'file-1'],
      ['sheets', 'sheet-1'],
    ]) {
      const r = await f.call({action: 'check', connection_id: id, account_id: account, live: true});
      assert.equal(r.readiness, 'not_applicable');
      assert.equal(readCheck(r).status, 'unknown');
      assert.equal(readCheck(r).reason, 'not_applicable');
      assert.equal(r.ready, false);
      assert.equal(r.blocked, false);
    }
    // The website's Overview reads the whole dashboard (view:"full", MCP-01).
    const d = await f.call({action: 'dashboard', view: 'full'});
    for (const c of d.connections) {
      assert.equal(c.readiness, 'not_applicable', c.gateway);
      assert.equal(c.accounts_status[0].check.readiness, 'not_applicable');
    }
    // The MCP summary says the same, per account and in the provider counts.
    const summary = await f.call({action: 'dashboard'});
    assert.deepEqual(
      summary.accounts.items.map(a => [a.gateway, a.readiness]),
      [
        ['google_drive_native_action', 'not_applicable'],
        ['google_sheets_native_action', 'not_applicable'],
      ],
    );
    for (const p of summary.providers) assert.equal(p.readiness.not_applicable, 1, p.gateway);
    const section = await f.call({action: 'dashboard', sections: ['readiness']});
    for (const row of section.sections.readiness.items) assert.equal(row.check.readiness, 'not_applicable');
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});

test('a reader check does not change the administrator view, and evidence turns stale after 15 minutes', async t => {
  t.mock.timers.enable({apis: ['Date'], now: 1800000000000});
  const f = fixture();
  try {
    f.add('meta', 'meta_native_action', ['ads_read', 'ads_management']);
    f.grants('meta', knownMeta(['ads_read', 'ads_management']));
    const write = {action: 'check', connection_id: 'meta', account_id: '100', live: true, requirements: {write: true}};
    const badge = async actor =>
      (await f.call({action: 'dashboard', view: 'full'}, actor)).connections[0].accounts_status[0].check;
    // The MCP summary state of the same account for a viewer (MCP-01 with CON-03).
    const state = async actor => (await f.call({action: 'dashboard'}, actor)).accounts.items[0].readiness;
    assert.equal(await state(admin), 'unchecked');
    const mine = await f.call(write);
    assert.equal(mine.ready, true, JSON.stringify(mine.checks));
    assert.equal((await badge(admin)).ready, true);
    const theirs = await f.call(write, reader);
    assert.equal(theirs.ready, false, 'the reader role is blocked for the reader');
    assert.equal(theirs.checks.find(c => c.key === 'operator').status, 'blocked');
    // The administrator's badge is unchanged: the reader's role was never stored for everyone.
    const view = await badge(admin);
    assert.equal(view.ready, true);
    assert.equal(view.stale, false);
    assert.equal((await badge(reader)).checks.find(c => c.key === 'operator').status, 'blocked');
    // The summary is the viewer's too: ready for the administrator, blocked by role for the reader.
    assert.equal(await state(admin), 'ready');
    assert.equal(await state(reader), 'blocked');
    const stored = f.store.document(tenantId, 'readiness', readinessId('meta', '100'));
    assert.equal(stored.live_read, true);
    for (const key of ['checks', 'requirements', 'actor', 'role', 'ready']) assert.equal(stored[key], undefined, key);
    t.mock.timers.tick(readinessLifetimeMs + 60000);
    const stale = await badge(admin);
    assert.equal(stale.stale, true);
    assert.equal(stale.ready, false);
    assert.equal(stale.live_read, false);
    assert.equal(stale.checks.find(c => c.key === 'provider_read').reason, 'stale');
    assert.equal(await state(admin), 'stale');
    const summary = await f.call({action: 'dashboard'});
    assert.equal(summary.accounts.items[0].stale, true);
    assert.equal(summary.accounts.items[0].live_read, false);
    assert.equal(summary.providers[0].readiness.stale, 1);
    assert.equal(f.requests.length, 2);
  } finally {
    f.close();
  }
});

test('capability graph v3: scope blockers on Google read workflows, resolved dependencies, zero egress', async () => {
  const f = fixture();
  try {
    f.add('google', 'google_ads_native_action', ['openid', 'profile'], ['100']);
    f.add('meta', 'meta_native_action', ['ads_read', 'ads_management'], ['200']);
    const graph = await f.call({action: 'capabilities', view: 'graph'});
    assert.equal(graph.version, 3);
    assert.equal(graph.network_requests, 0);
    const blocked = id =>
      graph.workflows
        .find(w => w.id === id)
        .accounts.find(a => a.connection_id === 'google')
        .blockers.includes('provider_scope:' + g('adwords'));
    for (const id of ['recipe:google_search', 'report:google', 'capture:google_campaign', 'media:google_ads'])
      assert.ok(blocked(id), id + ' shows the missing Google Ads scope');
    // Every dependency has a resolution class; none is the version 2 placeholder.
    const dependencies = graph.workflows.flatMap(w => [...w.dependencies, ...w.accounts.flatMap(a => a.dependencies)]);
    assert.ok(dependencies.length > 100);
    for (const d of graph.workflows.flatMap(w => w.dependencies)) {
      assert.notEqual(d.status, 'requires_evidence', d.id);
      assert.ok(Object.keys(graph.dependency_resolutions).includes(d.resolution), d.id);
    }
    // Provider and objective acceptance is never ready in advance.
    const acceptance = dependencies.filter(d => d.id === 'provider_objective_acceptance');
    assert.ok(acceptance.length >= 12);
    assert.ok(acceptance.every(d => d.status === 'unknown' && d.resolution === 'native_review_only'));
    // Meta permissions recorded from the request alone are not known; a declined permission names its remedy.
    let meta = graph.workflows.find(w => w.id === 'recipe:meta_website_traffic').accounts[0];
    assert.equal(meta.recorded_scopes.known, false);
    f.store.updateConnection(admin, {
      ...f.store.listConnections(tenantId).find(c => c.id === 'meta'),
      scopes: ['ads_read'],
    });
    f.grants('meta', knownMeta(['ads_read'], ['ads_management']));
    meta = (await f.call({action: 'capabilities', view: 'graph', workflow_id: 'recipe:meta_website_traffic'}))
      .workflows[0].accounts[0];
    assert.ok(meta.blockers.includes('provider_scope_declined:ads_management'), JSON.stringify(meta.blockers));
    // An exact account read resolves exact_account for that account only; it never makes the objective ready.
    let report = (
      await f.call({
        action: 'capabilities',
        view: 'graph',
        workflow_id: 'report:meta',
        connection_id: 'meta',
        account_id: '200',
      })
    ).workflows[0];
    assert.equal(report.dependencies.find(d => d.id === 'exact_account').status, 'blocked');
    assert.deepEqual(report.dependencies.find(d => d.id === 'exact_account').resolver_call.arguments, {
      action: 'check',
      connection_id: 'meta',
      account_id: '200',
      live: true,
    });
    await f.call({action: 'check', connection_id: 'meta', account_id: '200', live: true});
    report = (
      await f.call({
        action: 'capabilities',
        view: 'graph',
        workflow_id: 'report:meta',
        connection_id: 'meta',
        account_id: '200',
      })
    ).workflows[0];
    assert.equal(report.dependencies.find(d => d.id === 'exact_account').status, 'ready');
    assert.equal(report.dependencies.find(d => d.id === 'measurement_context').status, 'needs_user_input');
    assert.equal(report.dependencies.find(d => d.id === 'complete_source_evidence').status, 'unknown');
    assert.equal(f.requests.length, 1, 'only the explicit account check contacted a provider');
  } finally {
    f.close();
  }
});

test('AMCP_CAPABILITY_GRAPH_VERSION=2 rolls back to the version 2 placeholders', async () => {
  const f = fixture();
  process.env.AMCP_CAPABILITY_GRAPH_VERSION = '2';
  try {
    const graph = await f.call({action: 'capabilities', view: 'graph', workflow_id: 'recipe:meta_website_traffic'});
    assert.equal(graph.version, 2);
    assert.ok(graph.workflows[0].dependencies.every(d => d.status === 'requires_evidence'));
    assert.equal(graph.dependency_resolutions, undefined);
  } finally {
    delete process.env.AMCP_CAPABILITY_GRAPH_VERSION;
    f.close();
  }
});

test('Home and Connections render stale, not-applicable and declined-permission states', () => {
  const esc = v =>
    String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const context = createContext({
    document: {addEventListener() {}},
    esc,
    date: () => 'Synthetic date',
    badge: (v, label) => `<span data-state="${v}">${label ?? v}</span>`,
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  const load = (file, name) => {
    const source = readFileSync(file, 'utf8'),
      start = source.indexOf('function ' + name + '('),
      end = source.indexOf('\n}', start) + 2;
    new Script(source.slice(start, end)).runInContext(context);
  };
  load('web/workspace.js', 'readinessBadge');
  load('web/workspace.js', 'readinessAge');
  load('web/app.js', 'renderGrantedPermissions');
  const run = (fn, value) => {
    context.value = value;
    return new Script(fn + '(value)').runInContext(context);
  };
  assert.match(run('readinessBadge', {readiness: 'not_applicable'}), /data-state="not_applicable">Not applicable/);
  assert.match(run('readinessBadge', {readiness: 'account_read', stale: true}), /data-state="stale">Stale/);
  assert.match(run('readinessBadge', {readiness: 'account_read', ready: true}), /data-state="ready"/);
  assert.equal(
    run('readinessAge', {readiness: 'account_read', checked_at: 1, stale: true}),
    'Synthetic date · Older than 15 minutes; check again',
  );
  assert.equal(run('readinessAge', {readiness: 'not_applicable'}), 'No account readiness read for this connection');
  const declined = run('renderGrantedPermissions', {
    id: 'meta"<x>',
    reauthorizeAvailable: true,
    grants: {
      source: 'permissions_endpoint',
      known: true,
      granted: ['ads_read'],
      declined: ['ads_management'],
      checked_at: 1,
    },
  });
  assert.match(declined, /Declined permissions/);
  assert.match(declined, /ads_management/);
  assert.match(declined, /data-reauthorize="meta&quot;&lt;x&gt;"/);
  assert.match(
    run('renderGrantedPermissions', {grants: {source: 'permissions_endpoint', known: false}}),
    /could not confirm which permissions/,
  );
  assert.equal(
    run('renderGrantedPermissions', {grants: {source: 'permissions_endpoint', known: true, declined: []}}),
    '',
  );
  assert.match(
    run('renderGrantedPermissions', {grants: {source: 'requested_access_type', requested_access_type: 'read'}}),
    /read access only/,
  );
});

test('capability cards show each dependency status, resolution and remedy in English and Arabic', () => {
  const card = locale => {
    const context = createContext({
      document: {addEventListener() {}, querySelectorAll: () => []},
      esc: v =>
        String(v ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;'),
      pretty: String,
      date: () => 'Synthetic date',
      badge: (v, label) => `<span data-state="${v}">${label ?? v}</span>`,
      recordDetails: () => '',
      URLSearchParams,
      Intl,
    });
    const run = code => new Script(code).runInContext(context);
    run(readFileSync('web/localization.js', 'utf8'));
    if (locale === 'ar')
      run('uiLocale="ar"; uiMessages=new Map(Object.entries(' + readFileSync('web/locales/ar.json', 'utf8') + '))');
    run(readFileSync('web/capability-center.js', 'utf8'));
    context.w = {
      id: 'recipe:meta_website_traffic',
      name: 'Meta website traffic',
      objective: 'website_traffic',
      description: 'Synthetic',
      effect_details: 'Synthetic',
      required_inputs: ['account_id'],
      website_path: '/campaigns?recipe=meta_website_traffic',
      dependencies: [
        {
          id: 'landing_page',
          status: 'needs_user_input',
          resolution: 'user_input',
          resolver_call: {arguments: {action: 'recipe_eligibility'}},
        },
        {id: 'provider_objective_acceptance', status: 'unknown', resolution: 'native_review_only'},
        {
          id: 'exact_account',
          status: 'blocked',
          resolution: 'resolved_locally',
          resolver_call: {website_path: '/connections'},
        },
      ],
      accounts: [
        {
          label: 'Meta',
          account_id: '100',
          local_state: 'blocked',
          blockers: ['provider_scope_declined:ads_management'],
          provider_evidence: {status: 'missing', meaning: 'Exact account-read evidence only.'},
          dependencies: [{id: 'exact_account', status: 'blocked'}],
          unresolved: [],
        },
      ],
      lifecycle: [],
      contracts: [],
    };
    return run('capabilityCard(w)');
  };
  const en = card('en');
  assert.match(
    en,
    /Needs your inputs · From your brief or request <a href="\/campaigns\?recipe=meta_website_traffic">Check this brief<\/a>/,
  );
  assert.match(en, /Not known yet · Decided only by the provider/);
  assert.match(en, /<a href="\/connections">Manage account access<\/a>/);
  assert.match(en, /Declined permission; reauthorize and allow it: ads_management/);
  assert.doesNotMatch(en, /Current evidence required/);
  const ar = card('ar');
  for (const text of ['يحتاج إلى مدخلاتك', 'يقرره المزوّد وحده', 'تحقّق من هذا الموجز', 'صلاحية مرفوضة'])
    assert.ok(ar.includes(text), text);
  assert.ok(ar.includes('ads_management'), 'the native permission name stays literal');
});
