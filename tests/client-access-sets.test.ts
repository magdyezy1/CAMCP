// SEC-08 phase 2 (owner direction P1: many clients per workspace): a connector token, AI client or member limited to a
// client access set reaches only that client's accounts. Before, the tenant was the only boundary: a token created for
// client A listed, read and reported on client B's accounts in the same workspace. Synthetic fixtures only; the provider
// transport is a recording fake and nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {
  choosableAccessSet,
  deleteAccessSet,
  listAccessSets,
  saveAccessSet,
  setMemberAccessSet,
} from '../src/access-sets.js';
import {clientViews} from '../src/client-scope.js';
import {firstPartyContract} from '../src/first-party-contracts.js';
import type {Actor, JsonObject} from '../src/types.js';

const tenant = 'agency',
  admin: Actor = {tenantId: tenant, userId: 'workspace-admin', role: 'admin'},
  A = '7100000001',
  B = '7200000002',
  marker = 'SECRET-B',
  policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true};
/** One account-scoped native read per direct native gateway, naming the given account. */
const directReads: Record<string, (id: string) => JsonObject> = {
  meta_native_action: id => ({action: 'meta_ad_account_id_campaigns_get', account_id: id}),
  tiktok_native_action: id => ({action: 'tiktok_ad_get', account_id: id}),
  snapchat_native_action: id => ({action: 'snapchat_account_get', account_id: id}),
  apple_ads_native_action: id => ({action: 'apple_ads_v1_campaigns_query', account_id: id}),
  dv360_native_action: id => ({action: 'DV360_ADVERTISERS_CAMPAIGNS_LIST', params: {advertiserId: id}}),
  linkedin_native_action: id => ({action: 'linkedin_rest_ad_account_trust_preferences_account_id_get', account_id: id}),
  google_ads_native_action: id => ({
    action: 'google_ads_v23_google_ads_search',
    account_id: id,
    payload: {query: 'SELECT campaign.id FROM campaign'},
  }),
  x_ads_native_action: id => ({action: 'x_accounts_account_id_get', account_id: id}),
  microsoft_ads_native_action: id => ({action: 'GetCampaignsByAccountId', account_id: id}),
};
const loginOf = (gateway: string) => gateway.replace('_native_action', '') + '-login';

async function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 58).toString('base64')),
    requests: string[] = [];
  const transport = new NativeTransport((async (url: unknown, init?: RequestInit) => {
    requests.push(String(url) + ' ' + (init?.body?.toString() ?? ''));
    return Response.json({data: [], results: []});
  }) as typeof fetch);
  const service = new MirrorService(new Registry(), store, transport, undefined, policy);
  for (const gateway of Object.keys(directReads))
    store.putConnection(
      admin,
      {
        id: loginOf(gateway),
        tenantId: tenant,
        gateway,
        accounts: [A, B],
        writeAccounts: [A, B],
        enabled: true,
        label: gateway + ' login',
        scopes: ['ads_management'],
        // Microsoft binds each account's verified parent customer.
        ...(gateway === 'microsoft_ads_native_action' ? {accountCustomers: {[A]: '9001', [B]: '9002'}} : {}),
      },
      {
        accessToken: 'synthetic',
        refreshToken: 'synthetic',
        developerToken: 'synthetic',
        consumerKey: 'synthetic',
        consumerSecret: 'synthetic',
        tokenSecret: 'synthetic',
      },
    );
  // Account names, a Page and an asset only client B's work has, each carrying the marker.
  store.putDocument(tenant, 'website_assets', 'meta-login', {
    groups: [
      {
        kind: 'ad_accounts',
        complete: true,
        assets: [
          {id: 'act_' + A, kind: 'ad_accounts', name: 'Client A account', source: 'vendor'},
          {id: 'act_' + B, kind: 'ad_accounts', name: marker + ' account', source: 'vendor'},
        ],
      },
      {kind: 'pages', complete: true, assets: [{id: '9900', kind: 'pages', name: marker + ' Page', source: 'vendor'}]},
    ],
    selected: ['ad_accounts:' + A, 'ad_accounts:' + B],
    lastSync: Date.now(),
  });
  store.putDocument(tenant, 'workspace_asset', 'asset-b', {
    platform: 'meta',
    connection_id: 'meta-login',
    account_id: B,
    name: marker + ' asset',
  });
  const binding = (account: string) => [
    {gateway: 'meta_native_action', connection_id: 'meta-login', account_id: account},
    {gateway: 'google_ads_native_action', connection_id: 'google_ads-login', account_id: account},
  ];
  store.putDocument(tenant, 'client_profile', 'profile-a', {
    name: 'Client A',
    approved_by: admin.userId,
    bindings: binding(A),
  });
  store.putDocument(tenant, 'client_profile', 'profile-b', {
    name: marker + ' client',
    approved_by: admin.userId,
    bindings: binding(B),
  });
  store.putDocument(tenant, 'client_brief', 'brief-b', {
    name: marker + ' brief',
    recipe: 'meta_website_traffic',
    profile_id: 'profile-b',
    business: {},
    created_by: admin.userId,
  });
  // The administrator's own plan and saved report for client B: the scoped token is the same person, so before this
  // change it saw them as its own.
  const plan = await service.call(
    'amcp_campaign',
    {
      action: 'create',
      name: marker + ' plan',
      brief: 'Synthetic',
      steps: [
        {
          id: 'campaign',
          kind: 'write',
          gateway: 'meta_native_action',
          connection_id: 'meta-login',
          account_id: B,
          arguments: {
            action: 'meta_campaign_create',
            payload: {
              name: marker + ' campaign',
              status: 'PAUSED',
              objective: 'OUTCOME_TRAFFIC',
              special_ad_categories: [],
            },
          },
        },
      ],
    },
    admin,
  );
  assert.equal(plan.success, true, JSON.stringify(plan));
  const report = await service.call(
    'amcp_reporting_overview',
    {
      action: 'save',
      confirmed: true,
      config: {
        name: marker + ' weekly',
        client_name: marker,
        sources: [{platform: 'meta', connection_id: 'meta-login', account_id: B}],
        date_range: {preset: 'last_complete_days', days: 7, timezone: 'UTC'},
        metrics: ['spend', 'clicks'],
        custom_metrics: [],
        targets: {},
        objectives: [],
      },
    },
    admin,
  );
  assert.equal(report.success, true, JSON.stringify(report));
  const set = saveAccessSet(store, admin, {
    name: 'Client A',
    bindings: Object.keys(directReads).map(gateway => ({gateway, connection_id: loginOf(gateway), account_id: A})),
  });
  const scoped = store.authenticate(
      store.createKey({tenantId: tenant, userId: 'connector/client-a', role: 'operator', accessSetId: String(set.id)}),
    ),
    open = store.authenticate(store.createKey({tenantId: tenant, userId: 'connector/whole', role: 'operator'}));
  return {
    store,
    service,
    requests,
    set,
    scoped,
    open,
    planId: (plan.data as JsonObject).id as string,
    reportId: (report.data as JsonObject).id as string,
  };
}

test('a token limited to client A cannot list, read, report on or prepare for client B (regression: tenant-wide)', async () => {
  const f = await fixture();
  try {
    assert.equal(f.scoped.accessSetId, f.set.id, 'the key keeps its set through authentication');
    for (const c of f.store.connectionsFor(f.scoped)) assert.deepEqual(c.accounts, [A]);
    assert.throws(() => f.store.resolveConnection(f.scoped, 'meta_native_action', B), {
      code: 'ACCOUNT_SCOPE_RESTRICTED',
    });
    assert.equal(f.store.resolveConnection(f.scoped, 'meta_native_action', A).id, 'meta-login');
    // list: workspace context and accounts name only client A.
    const context = await f.service.call(
      'amcp_native_action',
      {operation: 'get_workspace_context', arguments: {}},
      f.scoped,
    );
    assert.equal(context.success, true, JSON.stringify(context));
    assert.equal((context.data as JsonObject).access_set.name, 'Client A');
    const listed = await f.service.call('amcp_native_action', {operation: 'list_accounts', arguments: {}}, f.scoped);
    assert.ok(!JSON.stringify(listed).includes(B) && !JSON.stringify(listed).includes(marker), JSON.stringify(listed));
    assert.ok(JSON.stringify(listed).includes('Client A account'));
    // read: refused before any request.
    const read = await f.service.call('meta_native_action', directReads.meta_native_action!(B), f.scoped);
    assert.equal(read.success, false);
    assert.equal((read.error as JsonObject).code, 'ACCOUNT_SCOPE_RESTRICTED');
    assert.equal(f.requests.length, 0);
    // prepare: neither a reviewed write nor a native dry run is prepared for B.
    const prepared = await f.service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway: 'meta_native_action',
        arguments: {
          action: 'meta_campaign_create',
          account_id: B,
          payload: {
            name: 'Draft',
            status: 'PAUSED',
            objective: 'OUTCOME_TRAFFIC',
            special_ad_categories: [],
            is_adset_budget_sharing_enabled: false,
          },
        },
      },
      f.scoped,
    );
    assert.equal(prepared.success, false, JSON.stringify(prepared));
    assert.equal((prepared.error as JsonObject).code, 'ACCOUNT_SCOPE_RESTRICTED');
    const dry = await f.service.call(
      'meta_native_action',
      {
        action: 'meta_ad_account_id_campaigns_create',
        account_id: B,
        payload: {name: 'Draft', status: 'PAUSED', objective: 'OUTCOME_TRAFFIC', special_ad_categories: []},
        dry_run: true,
      },
      f.scoped,
    );
    assert.equal((dry.error as JsonObject)?.code, 'ACCOUNT_SCOPE_RESTRICTED', JSON.stringify(dry));
    // report: the report builder offers only A, and B's saved report and plan are not listed.
    const bootstrap = await f.service.call('amcp_reporting_overview', {action: 'bootstrap'}, f.scoped);
    assert.equal(bootstrap.success, true, JSON.stringify(bootstrap).slice(0, 400));
    assert.ok(!JSON.stringify(bootstrap).includes(marker));
    const plans = await f.service.call('amcp_campaign', {action: 'list'}, f.scoped);
    assert.equal(plans.success, true);
    assert.ok(!JSON.stringify(plans).includes(marker), JSON.stringify(plans));
    const plan = await f.service.call('amcp_campaign', {action: 'get', id: f.planId}, f.scoped);
    assert.equal(plan.success, false, 'B’s plan is not readable through a client A token');
    assert.equal(f.requests.length, 0);
    // Audit rows of the limited token name its set.
    const audited = f.store.db
      .prepare("SELECT count(*) AS n FROM audit WHERE tenant_id=? AND json_extract(event,'$.access_set_id')=?")
      .get(tenant, f.set.id) as {n: number};
    assert.ok(audited.n > 0);
  } finally {
    f.store.close();
  }
});

test('an unscoped token behaves as before: it lists and reads client B', async () => {
  const f = await fixture();
  try {
    assert.equal(f.open.accessSetId, undefined);
    assert.deepEqual(
      f.store.connectionsFor(f.open).map(c => c.accounts),
      f.store.listConnections(tenant).map(c => c.accounts),
    );
    const listed = await f.service.call('amcp_native_action', {operation: 'list_accounts', arguments: {}}, f.open);
    assert.ok(JSON.stringify(listed).includes(marker + ' account'));
    const read = await f.service.call('meta_native_action', directReads.meta_native_action!(B), f.open);
    assert.equal(read.success, true, JSON.stringify(read));
    assert.equal(f.requests.length, 1);
    assert.ok(f.requests[0]!.includes(B));
    const plans = await f.service.call('amcp_campaign', {action: 'list'}, f.open);
    assert.ok(JSON.stringify(plans).includes(marker + ' plan'));
    assert.ok(JSON.stringify(f.service.store.documents(tenant, 'client_profile')).includes(marker));
    assert.equal(clientViews(f.store, f.open).length, 2);
  } finally {
    f.store.close();
  }
});

test('every MCP tool entry point with a client A token leaves client B unseen and unrequested', async () => {
  const f = await fixture();
  try {
    const tools = f.service.listTools(),
      names = tools.map(t => t.name),
      probed = new Set<string>();
    const referencing: JsonObject = {
      account_id: B,
      connection_id: 'meta-login',
      gateway: 'meta_native_action',
      platform: 'meta',
      id: f.planId,
      plan_id: f.planId,
      report_id: f.reportId,
      profile_id: 'profile-b',
      brief_id: 'brief-b',
    };
    /** The referencing arguments an action reads, by its contract (MCP-07): anything else would be refused outright. */
    const own = (tool: (typeof tools)[number], action: string, keys = Object.keys(referencing)) => {
      const accepted =
        firstPartyContract(tool, action)?.argumentsSchema.properties ?? tool.inputSchema?.properties ?? {};
      return Object.fromEntries(Object.entries(referencing).filter(([k]) => k in accepted && keys.includes(k)));
    };
    const check = async (tool: string, input: JsonObject) => {
      probed.add(tool);
      const before = f.requests.length,
        result = await f.service.call(tool, input, f.scoped),
        text = JSON.stringify(result);
      assert.ok(
        !text.includes(marker),
        tool + ' ' + JSON.stringify(input) + ' revealed client B: ' + text.slice(0, 600),
      );
      for (const request of f.requests.slice(before))
        assert.ok(!request.includes(B), tool + ' sent a request for client B: ' + request);
      return result;
    };
    for (const tool of tools) {
      const actions = tool.inputSchema?.properties?.action?.enum as string[] | undefined;
      if (directReads[tool.name]) {
        const refused = await check(tool.name, directReads[tool.name]!(B));
        assert.equal((refused.error as JsonObject)?.code, 'ACCOUNT_SCOPE_RESTRICTED', tool.name);
        // The same read of client A's account is sent: the probe reaches the provider path.
        const before = f.requests.length,
          allowed = await check(tool.name, directReads[tool.name]!(A));
        assert.ok(f.requests.length > before, tool.name + ' read of client A was not sent: ' + JSON.stringify(allowed));
      } else if (tool.name === 'amcp_tool_help') await check(tool.name, {gateway: 'meta_native_action'});
      else if (!actions)
        // A delegated gateway: its workspace context, account and asset listings.
        for (const operation of ['get_workspace_context', 'list_accounts', 'list_workspace_assets'])
          await check(tool.name, {operation, arguments: {}});
      else
        // A first-party tool: every action bare (its unfiltered listing), then naming client B's account, then also
        // client B's records (plan, report, profile, brief).
        for (const action of actions)
          for (const keys of [[], ['account_id', 'connection_id', 'gateway', 'platform'], Object.keys(referencing)])
            await check(tool.name, {...own(tool, action, keys), action});
    }
    assert.deepEqual(
      names.filter(n => !probed.has(n)),
      [],
      'every listed tool has a scoped-actor probe',
    );
    assert.ok(names.length >= 27, names.join(' '));
    // The same first-party probes reveal client B to an unscoped token, so the probes above can see a leak.
    const revealing = new Set<string>();
    for (const tool of tools) {
      const actions = tool.inputSchema?.properties?.action?.enum as string[] | undefined;
      if (!actions || directReads[tool.name] || tool.name === 'amcp_write' || tool.name === 'amcp_media') continue;
      for (const action of actions.filter(a => ['list', 'profiles', 'briefs', 'bootstrap', 'get', 'brief'].includes(a)))
        if (JSON.stringify(await f.service.call(tool.name, {...own(tool, action), action}, f.open)).includes(marker))
          revealing.add(tool.name + ' ' + action);
    }
    for (const expected of ['amcp_campaign list', 'amcp_workspace profiles', 'amcp_workspace briefs'])
      assert.ok(
        revealing.has(expected),
        expected + ' shows client B to an unscoped token: ' + [...revealing].join(', '),
      );
  } finally {
    f.store.close();
  }
});

test('access set lifecycle: changes apply at the next request, removal fails closed, administrators are never limited', async () => {
  const f = await fixture();
  try {
    const listed = listAccessSets(f.store, f.scoped);
    assert.deepEqual(
      (listed.sets as JsonObject[]).map(s => Object.keys(s).sort()),
      [['accounts', 'id', 'name']],
      'a limited token sees its own set by name, not its bindings',
    );
    assert.throws(() => saveAccessSet(f.store, f.open, {name: 'x', bindings: []}), {code: 'FORBIDDEN'});
    assert.throws(
      () =>
        saveAccessSet(f.store, admin, {
          name: 'Unknown',
          bindings: [{gateway: 'meta_native_action', connection_id: 'meta-login', account_id: '999'}],
        }),
      {code: 'INVALID_ARGUMENT'},
    );
    // Adding B to the set reaches B at the next request.
    const current = (listAccessSets(f.store, admin).sets as JsonObject[])[0]!;
    saveAccessSet(f.store, admin, {
      id: current.id,
      revision: current.revision,
      name: 'Client A and B',
      bindings: [
        ...(current.bindings as JsonObject[]),
        {gateway: 'meta_native_action', connection_id: 'meta-login', account_id: B},
      ],
    });
    assert.equal(f.store.resolveConnection(f.scoped, 'meta_native_action', B).id, 'meta-login');
    assert.throws(() => saveAccessSet(f.store, admin, {...current, name: 'Stale'}), {code: 'REVISION_CONFLICT'});
    // Removing the set leaves the token limited to nothing.
    const latest = (listAccessSets(f.store, admin).sets as JsonObject[])[0]!;
    assert.throws(() => deleteAccessSet(f.store, admin, {id: latest.id, revision: latest.revision}), {
      code: 'CONFIRMATION_REQUIRED',
    });
    deleteAccessSet(f.store, admin, {id: latest.id, revision: latest.revision, confirmed: true});
    assert.deepEqual(f.store.connectionsFor(f.scoped), []);
    assert.throws(() => f.store.resolveConnection(f.scoped, 'meta_native_action', A), {
      code: 'ACCOUNT_SCOPE_RESTRICTED',
    });
    const context = await f.service.call(
      'amcp_native_action',
      {operation: 'get_workspace_context', arguments: {}},
      f.scoped,
    );
    assert.equal((context.data as JsonObject).access_set.removed, true);
    assert.deepEqual((context.data as JsonObject).connections, []);
    // An administrator key or actor never carries a set.
    assert.throws(() => f.store.createKey({...admin, accessSetId: 'x'}), {code: 'INVALID_ROLE'});
    assert.throws(() => f.store.assertActorActive({...admin, accessSetId: 'x'}), {code: 'MEMBERSHIP_REVOKED'});
  } finally {
    f.store.close();
  }
});

test('a member limited to a client: their credentials must carry that set, and they can hand on only that set', async () => {
  const f = await fixture();
  try {
    const other = saveAccessSet(f.store, admin, {
      name: 'Client B',
      bindings: [{gateway: 'meta_native_action', connection_id: 'meta-login', account_id: B}],
    });
    // An account member with an active membership, as the website records them.
    f.store.db.exec(
      'CREATE TABLE IF NOT EXISTS amcp_users(id TEXT PRIMARY KEY,version INTEGER,approved INTEGER,disabled INTEGER)',
    );
    f.store.db.prepare('INSERT OR IGNORE INTO amcp_users VALUES(?,1,1,0)').run('person-1');
    f.store.db
      .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,active,created_at) VALUES(?,?,?,1,?)')
      .run(tenant, 'person-1', 'operator', Date.now());
    const credential = (accessSetId?: string): Actor => ({
      tenantId: tenant,
      userId: 'connector/person-1',
      ownerUserId: 'person-1',
      role: 'operator',
      ...(accessSetId ? {accessSetId} : {}),
    });
    f.store.assertActorActive(credential());
    setMemberAccessSet(f.store, tenant, 'person-1', String(f.set.id));
    // A credential approved before the limit, or for another set, stops at once.
    assert.throws(() => f.store.assertActorActive(credential()), {code: 'MEMBERSHIP_REVOKED'});
    assert.throws(() => f.store.assertActorActive(credential(String(other.id))), {code: 'MEMBERSHIP_REVOKED'});
    f.store.assertActorActive(credential(String(f.set.id)));
    const member = credential(String(f.set.id));
    assert.equal(choosableAccessSet(f.store, member, undefined), f.set.id, 'a limited member hands on their limit');
    assert.throws(() => choosableAccessSet(f.store, member, other.id), {code: 'ACCOUNT_SCOPE_RESTRICTED'});
    assert.throws(() => choosableAccessSet(f.store, f.open, 'missing'), {code: 'ACCESS_SET_NOT_FOUND'});
    assert.equal(choosableAccessSet(f.store, f.open, undefined), undefined);
    // Lifting the limit restores whole-workspace access for an unlimited credential.
    setMemberAccessSet(f.store, tenant, 'person-1', null);
    f.store.assertActorActive(credential());
  } finally {
    f.store.close();
  }
});
