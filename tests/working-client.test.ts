// SEC-08 phase 1 (owner direction P1): the working client is a view filter. An optional profile_id on the plan list,
// operations feed, change history, media lists and the report builder's bootstrap narrows each to the accounts that
// client profile binds, intersected with current access: it hides, it never reveals or grants. Before, every list
// mixed all clients of a workspace and nothing could narrow one to a client. Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveAccessSet} from '../src/access-sets.js';
import {clientView, clientViews, clientsOf} from '../src/client-scope.js';
import type {Actor, JsonObject} from '../src/types.js';

const tenant = 'agency-view',
  admin: Actor = {tenantId: tenant, userId: 'workspace-admin', role: 'admin'},
  // Two profiles and four accounts: client A has A1 (Meta) and A2 (Google); client B has B1 and B2.
  A1 = '1100000001',
  B1 = '1200000002',
  A2 = '2100000001',
  B2 = '2200000002';

async function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 59).toString('base64'));
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport((async () => Response.json({data: [], results: []})) as typeof fetch),
  );
  for (const [id, gateway, accounts] of [
    ['meta-login', 'meta_native_action', [A1, B1]],
    ['google-login', 'google_ads_native_action', [A2, B2]],
  ] as const)
    store.putConnection(
      admin,
      {
        id,
        tenantId: tenant,
        gateway,
        accounts: [...accounts],
        writeAccounts: [...accounts],
        enabled: true,
        label: id,
        scopes: [],
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
  const bindings = (meta: string, google: string) => [
    {gateway: 'meta_native_action', connection_id: 'meta-login', account_id: meta},
    // A binding without a login covers the account through any login that selects it.
    {gateway: 'google_ads_native_action', account_id: google},
  ];
  store.putDocument(tenant, 'client_profile', 'profile-a', {name: 'Client A', bindings: bindings(A1, A2)});
  store.putDocument(tenant, 'client_profile', 'profile-b', {name: 'Client B', bindings: bindings(B1, B2)});
  for (const [name, account] of [
    ['Plan A', A1],
    ['Plan B', B1],
  ]) {
    const plan = await service.call(
      'amcp_campaign',
      {
        action: 'create',
        name,
        brief: 'Synthetic',
        steps: [
          {
            id: 'campaign',
            kind: 'write',
            gateway: 'meta_native_action',
            connection_id: 'meta-login',
            account_id: account,
            arguments: {
              action: 'meta_campaign_create',
              payload: {name, status: 'PAUSED', objective: 'OUTCOME_TRAFFIC', special_ad_categories: []},
            },
          },
        ],
      },
      admin,
    );
    assert.equal(plan.success, true, JSON.stringify(plan));
  }
  for (const [id, account] of [
    ['asset-a', A1],
    ['asset-b', B1],
  ] as const)
    store.putDocument(tenant, 'workspace_asset', id, {
      platform: 'meta',
      connection_id: 'meta-login',
      account_id: account,
      name: id === 'asset-a' ? 'Asset of A' : 'Asset of B',
      media_id: 'media-' + id,
      media_type: 'image',
    });
  // Change history: one native read of each client's Meta account.
  for (const account of [A1, B1])
    assert.equal(
      (
        await service.call(
          'meta_native_action',
          {action: 'meta_ad_account_id_campaigns_get', account_id: account},
          admin,
        )
      ).success,
      true,
    );
  return {store, service};
}
const data = (r: JsonObject) => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 600));
  return r.data as JsonObject;
};

test('choosing a working client narrows plans, operations, history, media and the report builder to its accounts', async () => {
  const {store, service} = await fixture();
  try {
    const views = clientViews(store, admin);
    assert.deepEqual(
      views.map(v => [v.name, v.accounts.map(a => a.account_id).sort()]),
      [
        ['Client A', [A1, A2]],
        ['Client B', [B1, B2]],
      ],
    );
    const plans = async (filter: JsonObject) =>
      (data(await service.call('amcp_campaign', {action: 'list', ...filter}, admin)).campaigns as JsonObject[]).map(
        p => p.name,
      );
    assert.deepEqual((await plans({})).sort(), ['Plan A', 'Plan B']);
    assert.deepEqual(await plans({profile_id: 'profile-a'}), ['Plan A']);
    assert.deepEqual(await plans({profile_id: 'profile-b'}), ['Plan B']);
    const operations = JSON.stringify(
      data(await service.call('amcp_workspace', {action: 'operations', profile_id: 'profile-a'}, admin)),
    );
    assert.ok(operations.includes('Plan A') && !operations.includes('Plan B'), operations.slice(0, 600));
    // History names client A's account only; before, it could only be narrowed one account at a time.
    const history = data(await service.call('amcp_workspace', {action: 'history', profile_id: 'profile-a'}, admin)),
      historyText = JSON.stringify(history);
    assert.ok(historyText.includes(A1) && !historyText.includes(B1), historyText.slice(0, 600));
    const library = data(await service.call('amcp_media', {action: 'library', profile_id: 'profile-b'}, admin));
    assert.deepEqual(
      (library.assets as JsonObject[]).map(a => a.name),
      ['Asset of B'],
    );
    const bootstrap = data(
      await service.call('amcp_reporting_overview', {action: 'bootstrap', profile_id: 'profile-a'}, admin),
    );
    const offered = (bootstrap.platforms as JsonObject[]).flatMap(p =>
      (p.accounts as JsonObject[]).map(a => a.account_id),
    );
    assert.deepEqual(offered.sort(), [A1, A2]);
    assert.deepEqual(bootstrap.client, {profile_id: 'profile-a', name: 'Client A'});
    // Without a working client every list shows the whole workspace, as before.
    const all = data(await service.call('amcp_reporting_overview', {action: 'bootstrap'}, admin));
    assert.equal(
      (all.platforms as JsonObject[]).flatMap(p => p.accounts as JsonObject[]).length,
      4,
      'no filter: all four accounts',
    );
    // A cross-client plan names both profiles, so the website can ask for confirmation.
    assert.deepEqual(
      clientsOf(views, [
        {gateway: 'meta_native_action', connection_id: 'meta-login', account_id: A1},
        {gateway: 'google_ads_native_action', account_id: B2},
      ]).sort(),
      ['profile-a', 'profile-b'],
    );
  } finally {
    store.close();
  }
});

test('a stale or foreign working client is refused rather than silently showing every client', async () => {
  const {store, service} = await fixture();
  try {
    for (const [tool, input] of [
      ['amcp_campaign', {action: 'list'}],
      ['amcp_workspace', {action: 'operations'}],
      ['amcp_workspace', {action: 'history'}],
      ['amcp_media', {action: 'library'}],
      ['amcp_media', {action: 'list'}],
      ['amcp_reporting_overview', {action: 'bootstrap'}],
    ] as const) {
      const result = await service.call(tool, {...input, profile_id: 'removed-profile'}, admin);
      if (tool === 'amcp_campaign') {
        // A removed profile still finds the plans recorded with it (none here), never every plan.
        assert.deepEqual(data(result).campaigns, []);
        continue;
      }
      assert.equal(result.success, false, tool + ' ' + input.action);
      assert.equal((result.error as JsonObject).code, 'PROFILE_NOT_FOUND', tool + ' ' + input.action);
    }
  } finally {
    store.close();
  }
});

test('the working client never reveals an account outside current access', async () => {
  const {store, service} = await fixture();
  try {
    // A token limited to client A's Meta and Google accounts.
    const set = saveAccessSet(store, admin, {
        name: 'Client A',
        bindings: [
          {gateway: 'meta_native_action', connection_id: 'meta-login', account_id: A1},
          {gateway: 'google_ads_native_action', connection_id: 'google-login', account_id: A2},
        ],
      }),
      scoped = store.authenticate(
        store.createKey({tenantId: tenant, userId: 'connector/a', role: 'reader', accessSetId: String(set.id)}),
      );
    assert.deepEqual(
      clientViews(store, scoped).map(v => v.profile_id),
      ['profile-a'],
    );
    assert.throws(() => clientView(store, scoped, 'profile-b'), {code: 'PROFILE_NOT_FOUND'});
    const refused = await service.call(
      'amcp_reporting_overview',
      {action: 'bootstrap', profile_id: 'profile-b'},
      scoped,
    );
    assert.equal((refused.error as JsonObject).code, 'PROFILE_NOT_FOUND');
    assert.ok(!JSON.stringify(refused).includes('Client B'), 'the refusal does not name the other client');
    // A profile that binds an account outside access is narrowed to what access reaches.
    store.putDocument(tenant, 'client_profile', 'profile-mixed', {
      name: 'Mixed',
      bindings: [
        {gateway: 'meta_native_action', connection_id: 'meta-login', account_id: A1},
        {gateway: 'meta_native_action', connection_id: 'meta-login', account_id: B1},
      ],
    });
    const reader: Actor = {tenantId: tenant, userId: 'reader', role: 'reader'};
    assert.deepEqual(
      clientView(store, reader, 'profile-mixed')
        .accounts.map(a => a.account_id)
        .sort(),
      [A1, B1],
    );
    assert.throws(() => clientView(store, scoped, 'profile-mixed'), {code: 'PROFILE_NOT_FOUND'});
    const plans = data(await service.call('amcp_campaign', {action: 'list', profile_id: 'profile-a'}, scoped));
    assert.ok(!JSON.stringify(plans).includes('Plan B'));
  } finally {
    store.close();
  }
});
