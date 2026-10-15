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
    // The refusal is a grant matter with its own next step, and never says whether the account exists here.
    assert.equal((read.error as JsonObject).category, 'grant');
    assert.match(String(((read.error as JsonObject).remedy as JsonObject).action), /get_workspace_context/);
    const unknown = await f.service.call('meta_native_action', directReads.meta_native_action!('7999999999'), f.scoped);
    assert.equal((unknown.error as JsonObject).code, 'ACCOUNT_SCOPE_RESTRICTED', 'an unknown account reads the same');
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
    assert.equal((plan.error as JsonObject)?.code, 'FORBIDDEN', 'B’s plan is not readable through a client A token');
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
      // A call that does not name client B's account never names it back either: a listing names no account outside
      // the set, not even by ID. (A refusal may echo an ID the caller sent; that reveals nothing.)
      if (!JSON.stringify(input).includes(B))
        assert.ok(!text.includes(B), tool + ' ' + JSON.stringify(input) + ' listed client B: ' + text.slice(0, 600));
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

test('records of a login the set shares stay with their client (regression: receipts, uploads and report tabs matched by login only)', async () => {
  const f = await fixture();
  try {
    // A Sheets login holding one spreadsheet of each client, with a report tab in each.
    f.store.putConnection(
      admin,
      {
        id: 'sheets-login',
        tenantId: tenant,
        gateway: 'google_sheets_native_action',
        accounts: ['sheet-a', 'sheet-b'],
        enabled: true,
        label: 'Agency Sheets',
        scopes: ['https://www.googleapis.com/auth/drive.file'],
      },
      {accessToken: 'synthetic', refreshToken: 'synthetic'},
    );
    for (const [id, sheet, tab] of [
      ['dest-a', 'sheet-a', 'Client A tab'],
      ['dest-b', 'sheet-b', marker + ' tab'],
    ] as const)
      f.store.putDocument(tenant, 'sheets_destination', id, {
        connection_id: 'sheets-login',
        spreadsheet_id: sheet,
        requested_tab_name: tab,
        tab_name: tab,
      });
    // A verified write receipt for each client's Meta account, both through the one Meta login the set shares.
    for (const [id, account] of [
      ['receipt-a', A],
      ['receipt-b', B],
    ] as const)
      f.store.putDocument(tenant, 'write_verification', id, {
        review_id: id,
        connection_id: 'meta-login',
        account_id: account,
        action: 'meta_campaign_update',
        status: 'verified',
        checks: [],
        checked_at: Date.now(),
      });
    // An upload of each client on LinkedIn, the platform of the campaign-structure probe below.
    for (const [id, account, name] of [
      ['linkedin-a', A, 'Client A LinkedIn upload'],
      ['linkedin-b', B, marker + ' LinkedIn upload'],
    ] as const)
      f.store.putDocument(tenant, 'workspace_asset', id, {
        platform: 'linkedin',
        connection_id: 'linkedin-login',
        account_id: account,
        name,
      });
    const set = saveAccessSet(f.store, admin, {
        name: 'Client A with Sheets',
        bindings: [
          {gateway: 'meta_native_action', connection_id: 'meta-login', account_id: A},
          {gateway: 'linkedin_native_action', connection_id: 'linkedin-login', account_id: A},
          {gateway: 'google_sheets_native_action', connection_id: 'sheets-login', account_id: 'sheet-a'},
        ],
      }),
      scoped = f.store.authenticate(
        f.store.createKey({
          tenantId: tenant,
          userId: 'connector/sheets-a',
          role: 'reader',
          accessSetId: String(set.id),
        }),
      );
    const probes: [string, JsonObject][] = [
      ['amcp_workspace', {action: 'dashboard', sections: ['accounts', 'providers', 'verified_writes', 'evidence']}],
      ['amcp_workspace', {action: 'dashboard', view: 'full'}],
      ['amcp_reporting_overview', {action: 'bootstrap'}],
      ['amcp_native_action', {operation: 'list_media_assets', arguments: {source: 'uploaded'}}],
      [
        'amcp_native_action',
        {
          operation: 'plan_campaign_structure',
          arguments: {
            platform: 'linkedin',
            account_id: A,
            objective: 'traffic',
            product_description: 'A synthetic product for this test',
          },
        },
      ],
    ];
    for (const [tool, input] of probes) {
      const limited = await f.service.call(tool, input, scoped),
        text = JSON.stringify(limited);
      assert.equal(limited.success, true, tool + ' ' + text.slice(0, 400));
      assert.ok(!text.includes(B) && !text.includes(marker), tool + ' revealed client B: ' + text.slice(0, 800));
    }
    // What the limited token does see, and the same records shown to whole-workspace access (so the probes can see).
    const sections = (actor: Actor) =>
      f.service.call('amcp_workspace', {action: 'dashboard', sections: ['verified_writes']}, actor);
    const receipts = (r: JsonObject) =>
      ((r.data as JsonObject).sections.verified_writes.items as JsonObject[]).map(w => w.account_id);
    assert.deepEqual(receipts(await sections(scoped)), [A]);
    assert.deepEqual(receipts(await sections(f.open)).sort(), [A, B]);
    const tabs = async (actor: Actor) =>
      (
        ((await f.service.call('amcp_reporting_overview', {action: 'bootstrap'}, actor)).data as JsonObject)
          .destinations as JsonObject[]
      ).map(d => d.id);
    assert.deepEqual(await tabs(scoped), ['dest-a']);
    assert.deepEqual((await tabs(f.open)).sort(), ['dest-a', 'dest-b']);
    const uploads = await f.service.call(
      'amcp_native_action',
      {operation: 'list_media_assets', arguments: {source: 'uploaded'}},
      f.open,
    );
    assert.ok(JSON.stringify(uploads).includes(marker + ' asset'), 'whole-workspace access lists client B’s upload');
    const structure = async (actor: Actor) =>
      JSON.stringify(await f.service.call('amcp_native_action', probes[4]![1], actor));
    assert.ok((await structure(scoped)).includes('Client A LinkedIn upload'));
    assert.ok((await structure(f.open)).includes(marker + ' LinkedIn upload'));
  } finally {
    f.store.close();
  }
});

test('a token limited to client A cannot delete or overwrite client B’s saved report by its ID', async () => {
  const f = await fixture();
  try {
    const view = f.store.document(tenant, 'overview_view', f.reportId);
    for (const input of [
      {action: 'delete_view', id: f.reportId, expected_revision: view.revision, confirmed: true},
      {
        action: 'save',
        id: f.reportId,
        expected_revision: view.revision,
        confirmed: true,
        config: {
          name: 'Replaced',
          sources: [{platform: 'meta', connection_id: 'meta-login', account_id: A}],
          date_range: {preset: 'last_complete_days', days: 7, timezone: 'UTC'},
          metrics: ['spend'],
          custom_metrics: [],
          targets: {},
          objectives: [],
        },
      },
    ]) {
      const refused = await f.service.call('amcp_reporting_overview', input, f.scoped);
      assert.equal(refused.success, false, input.action);
      assert.equal((refused.error as JsonObject).code, 'ACCOUNT_SCOPE_RESTRICTED', input.action);
    }
    const kept = f.store.document(tenant, 'overview_view', f.reportId);
    assert.equal(kept.revision, view.revision);
    assert.equal(kept.config.name, marker + ' weekly');
    // Whole-workspace access still deletes it, as before.
    const removed = await f.service.call(
      'amcp_reporting_overview',
      {action: 'delete_view', id: f.reportId, expected_revision: view.revision, confirmed: true},
      f.open,
    );
    assert.equal(removed.success, true, JSON.stringify(removed));
  } finally {
    f.store.close();
  }
});

test('a login read through a client access set is never saved back (it would drop every other account)', async () => {
  const f = await fixture();
  try {
    const narrowed = f.store.connectionsFor(f.scoped).find(c => c.id === 'meta-login')!;
    assert.deepEqual(narrowed.accounts, [A]);
    // Even under an administrator actor, and from a copy of the narrowed view.
    assert.throws(() => f.store.updateConnection(admin, {...narrowed, label: 'Renamed'}), {code: 'CONNECTION_CHANGED'});
    assert.throws(() => f.store.putConnection(admin, {...narrowed}, {accessToken: 'synthetic'}), {
      code: 'CONNECTION_CHANGED',
    });
    assert.deepEqual(f.store.listConnections(tenant).find(c => c.id === 'meta-login')!.accounts, [A, B]);
    // The whole login, as an administrator reads it, still saves as before.
    const whole = f.store.connectionsFor(admin).find(c => c.id === 'meta-login')!;
    f.store.updateConnection(admin, {...whole, label: 'Renamed'});
    const stored = f.store.listConnections(tenant).find(c => c.id === 'meta-login')!;
    assert.equal(stored.label, 'Renamed');
    assert.deepEqual(stored.accounts, [A, B]);
  } finally {
    f.store.close();
  }
});

test('a missing write grant under a client access set names only the set’s logins (regression: every login of the account)', async () => {
  const f = await fixture();
  try {
    // A second Meta login outside the set may change client A's account; the set's own login may not.
    f.store.putConnection(
      admin,
      {
        id: 'meta-login-other',
        tenantId: tenant,
        gateway: 'meta_native_action',
        accounts: [A],
        writeAccounts: [A],
        enabled: true,
        label: 'Other Meta login',
        scopes: ['ads_management'],
      },
      {accessToken: 'synthetic'},
    );
    const whole = f.store.listConnections(tenant).find(c => c.id === 'meta-login')!;
    f.store.updateConnection(admin, {...whole, writeAccounts: [B]});
    const prepare = (actor: Actor) =>
      f.service.call(
        'amcp_write',
        {
          action: 'prepare',
          gateway: 'meta_native_action',
          connection_id: 'meta-login',
          arguments: {
            action: 'meta_campaign_create',
            account_id: A,
            payload: {
              name: 'Draft',
              status: 'PAUSED',
              objective: 'OUTCOME_TRAFFIC',
              special_ad_categories: [],
              is_adset_budget_sharing_enabled: false,
            },
          },
        },
        actor,
      );
    const candidates = (r: JsonObject) => {
      assert.equal((r.error as JsonObject)?.code, 'WRITE_ACCOUNT_FORBIDDEN', JSON.stringify(r).slice(0, 600));
      return (((r.error as JsonObject).details as JsonObject).connections as JsonObject[]).map(c => c.connection_id);
    };
    // The limited token is not pointed at a login it cannot use, and never learns that login exists.
    const limited = await prepare(f.scoped);
    assert.deepEqual(candidates(limited), ['meta-login']);
    assert.ok(!JSON.stringify(limited).includes('meta-login-other'), JSON.stringify(limited).slice(0, 600));
    // Whole-workspace access is still shown the login that may change the account, as before.
    assert.deepEqual(candidates(await prepare(f.open)).sort(), ['meta-login', 'meta-login-other']);
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('a job is found by ID under a client access set only when that set started it (regression: any job of the workspace)', async () => {
  const f = await fixture();
  try {
    const run = async (actor: Actor, account: string) => {
      const r = await f.service.call(
        'amcp_reporting_overview',
        {
          action: 'run',
          confirmed: true,
          config: {
            name: account === B ? marker + ' run' : 'Client A run',
            sources: [{platform: 'meta', connection_id: 'meta-login', account_id: account}],
            date_range: {preset: 'last_complete_days', days: 7, timezone: 'UTC'},
            metrics: ['spend'],
            custom_metrics: [],
            targets: {},
            objectives: [],
          },
        },
        actor,
      );
      assert.equal(r.success, true, JSON.stringify(r).slice(0, 600));
      return (r.data as JsonObject).job_id as string;
    };
    const jobB = await run(f.open, B),
      jobA = await run(f.scoped, A);
    const get = (actor: Actor, id: string) =>
      f.service.call('amcp_native_action', {operation: 'get_creative_generation_job', arguments: {job_id: id}}, actor);
    const refused = await get(f.scoped, jobB),
      text = JSON.stringify(refused);
    assert.equal((refused.error as JsonObject)?.code, 'NOT_FOUND', text.slice(0, 600));
    assert.ok(!text.includes(B) && !text.includes(marker), text.slice(0, 600));
    assert.equal((await get(f.scoped, jobA)).success, true, 'the set’s own job is found');
    // Whole-workspace access reads either job, as before.
    for (const id of [jobA, jobB]) assert.equal((await get(f.open, id)).success, true);
    assert.equal(f.requests.length, 0);
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
