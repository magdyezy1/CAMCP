import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {gtmWorkflowContracts} from '../src/gtm-workflow-writes.js';
import {redact} from '../src/security.js';
import {DelegatedNativeCompiler} from '../src/delegated-native.js';
import type {Actor, JsonObject} from '../src/types.js';
import {assertRefused} from './helpers/assert-refused.js';

const gateway = 'gtm_native_action',
  registry = new Registry(),
  actor: Actor = {tenantId: 'gtm-workflows', userId: 'owner', role: 'admin'},
  base = 'accounts/44',
  container = base + '/containers/55',
  workspace = container + '/workspaces/66',
  prefix = '/tagmanager/v2/';
const scope = (s: string) => 'https://www.googleapis.com/auth/tagmanager.' + s;
const entityCases = [
  ['CLIENT', 'clients', 'client', 'clientId'],
  ['FOLDER', 'folders', 'folder', 'folderId'],
  ['TAG', 'tags', 'tag', 'tagId'],
  ['TEMPLATE', 'templates', 'template', 'templateId'],
  ['TRANSFORMATION', 'transformations', 'transformation', 'transformationId'],
  ['TRIGGER', 'triggers', 'trigger', 'triggerId'],
  ['VARIABLE', 'variables', 'variable', 'variableId'],
  ['ZONE', 'zones', 'zone', 'zoneId'],
] as const;
type Scenario = {action: string; path: string; query?: JsonObject; body?: JsonObject; parent?: boolean};
const scenarios: Scenario[] = [
  ...entityCases.map(([kind, collection]) => ({action: 'REVERT_' + kind, path: workspace + '/' + collection + '/7'})),
  {action: 'CREATE_BUILT_IN_VARIABLES', path: workspace, parent: true, query: {type: ['pageUrl', 'clickId']}},
  {action: 'DELETE_BUILT_IN_VARIABLES', path: workspace + '/built_in_variables', query: {type: ['pagePath', 'event']}},
  {action: 'REVERT_BUILT_IN_VARIABLE', path: workspace, query: {type: 'pagePath'}},
  {
    action: 'MOVE_ENTITIES_TO_FOLDER',
    path: workspace + '/folders/7',
    query: {tagId: ['8'], triggerId: ['9'], variableId: ['10']},
    body: {},
  },
  {action: 'SET_LATEST_CONTAINER_VERSION', path: container + '/versions/7'},
  {action: 'UNDELETE_CONTAINER_VERSION', path: container + '/versions/7'},
  {
    action: 'IMPORT_TEMPLATE_FROM_GALLERY',
    path: workspace,
    parent: true,
    query: {
      galleryOwner: 'trusted-owner',
      galleryRepository: 'template',
      gallerySha: 'a'.repeat(40),
      acknowledgePermissions: true,
    },
  },
  {action: 'REAUTHORIZE_ENVIRONMENT', path: container + '/environments/7', body: {}},
  {action: 'UPDATE_ACCOUNT', path: base, body: {name: 'Reviewed account', shareData: false}},
  {
    action: 'CREATE_USER_PERMISSION',
    path: base,
    parent: true,
    body: {
      emailAddress: 'new@example.test',
      accountAccess: {permission: 'user'},
      containerAccess: [{containerId: '55', permission: 'read'}],
    },
  },
  {
    action: 'UPDATE_USER_PERMISSION',
    path: base + '/user_permissions/7',
    body: {
      emailAddress: 'member@example.test',
      accountAccess: {permission: 'user'},
      containerAccess: [{containerId: '55', permission: 'edit'}],
    },
  },
  {action: 'DELETE_USER_PERMISSION', path: base + '/user_permissions/7'},
];
function fixture(s: Scenario) {
  const store = new Store(':memory:', Buffer.alloc(32, 83).toString('base64')),
    calls: JsonObject[] = [],
    records = new Map<string, JsonObject>(),
    connection = {
      id: 'gtm',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['44'],
      writeAccounts: ['44'],
      enabled: true,
      label: 'Synthetic GTM',
      scopes: [
        'readonly',
        'edit.containers',
        'edit.containerversions',
        'publish',
        'manage.accounts',
        'manage.users',
      ].map(scope),
    };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  const row = (path: string, extra: JsonObject = {}): JsonObject => ({
    path,
    accountId: '44',
    ...(path.includes('/containers/') ? {containerId: '55'} : {}),
    ...(path.includes('/workspaces/') ? {workspaceId: '66'} : {}),
    ...extra,
  });
  const builtin = (type: string) => row(workspace + '/built_in_variables/' + type, {type, name: type});
  records.set(base, row(base, {name: 'Account', shareData: true, fingerprint: 'account-1'}));
  records.set(container, row(container, {name: 'Container'}));
  records.set(workspace, row(workspace, {name: 'Workspace', fingerprint: 'workspace-1'}));
  records.set(workspace + '/status', {});
  for (const [, collection, , id] of entityCases)
    records.set(
      workspace + '/' + collection + '/7',
      row(workspace + '/' + collection + '/7', {[id]: '7', name: 'Draft ' + collection, fingerprint: 'draft-1'}),
    );
  for (const [collection, id, key] of [
    ['tags', '8', 'tagId'],
    ['triggers', '9', 'triggerId'],
    ['variables', '10', 'variableId'],
  ])
    records.set(
      workspace + '/' + collection + '/' + id,
      row(workspace + '/' + collection + '/' + id, {[key!]: id, name: 'Moved ' + collection, parentFolderId: '2'}),
    );
  records.set(
    container + '/versions/7',
    row(container + '/versions/7', {
      containerVersionId: '7',
      name: 'Version',
      deleted: s.action === 'UNDELETE_CONTAINER_VERSION',
    }),
  );
  records.set(
    container + '/version_headers:latest',
    row(container + '/versions/6', {containerVersionId: '6', name: 'Previous version'}),
  );
  records.set(
    container + '/environments/7',
    row(container + '/environments/7', {
      environmentId: '7',
      type: 'user',
      name: 'Staging',
      authorizationCode: 'synthetic-old-preview-secret',
      authorizationTimestamp: '2026-09-01T00:00:00Z',
      fingerprint: 'environment-1',
    }),
  );
  let permissions = [
    row(base + '/user_permissions/7', {
      emailAddress: 'member@example.test',
      accountAccess: {permission: 'user'},
      containerAccess: [],
    }),
    row(base + '/user_permissions/11', {
      emailAddress: 'owner@example.test',
      accountAccess: {permission: 'admin'},
      containerAccess: [],
    }),
    row(base + '/user_permissions/12', {
      emailAddress: 'backup@example.test',
      accountAccess: {permission: 'admin'},
      containerAccess: [],
    }),
  ];
  let builtins = [builtin('pagePath'), builtin('event')],
    templates: JsonObject[] = [],
    writes = 0,
    reads = 0,
    mode = '',
    partial = false,
    lost = false,
    ignore = false,
    cycles = false,
    revoke = false,
    denyRead = false,
    pageFailure = false;
  const collection = (path: string) =>
    path === base + '/user_permissions'
      ? {key: 'userPermission', rows: permissions}
      : path === workspace + '/built_in_variables'
        ? {key: 'builtInVariable', rows: builtins}
        : path === workspace + '/templates'
          ? {key: 'template', rows: templates}
          : undefined;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async (input, init) => {
      const u = new URL(String(input)),
        path = u.pathname.slice(prefix.length),
        method = init!.method!,
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({path, method, body, query: Object.fromEntries(u.searchParams)});
      if (method === 'GET') {
        reads++;
        if (revoke) store.putConnection(actor, {...connection, writeAccounts: []}, {accessToken: 'synthetic'});
        if (denyRead) return Response.json({error: {code: 403}}, {status: 403});
        const list = collection(path);
        if (list) {
          const offset = Number(u.searchParams.get('pageToken') ?? 0);
          if (pageFailure && offset) return Response.json({error: {code: 503}}, {status: 503});
          const items = list.rows
            .slice(offset, offset + 1)
            .map(v => (mode === 'foreign-read' ? {...v, path: v.path.replace('accounts/44', 'accounts/999')} : v));
          return Response.json({
            ...(!items.length ? {} : {[list.key]: items}),
            ...(cycles || offset + 1 < list.rows.length ? {nextPageToken: cycles ? '1' : String(offset + 1)} : {}),
          });
        }
        const value = path.startsWith(base + '/user_permissions/')
          ? permissions.find(r => r.path === path)
          : records.get(path);
        return value
          ? Response.json({...value, ...(path.endsWith('/status') ? {} : {requestId: String(reads)})})
          : Response.json({error: {code: 404}}, {status: 404});
      }
      writes++;
      let response: JsonObject | null = null;
      const entity = entityCases.find(([name]) => s.action === 'REVERT_' + name);
      if (entity) {
        const target = path.replace(':revert', '');
        if (mode === 'revert-absent') {
          if (!ignore) records.delete(target);
          response = {};
        } else {
          const v = row(target, {[entity[3]]: '7', name: 'Base ' + entity[1], fingerprint: 'base-1'});
          if (!ignore) records.set(target, v);
          response = {[entity[2]]: v};
        }
      } else if (s.action === 'CREATE_BUILT_IN_VARIABLES') {
        const added = u.searchParams.getAll('type').map(builtin);
        if (!ignore) builtins.push(...added);
        response = {builtInVariable: partial ? added.slice(1) : added};
      } else if (s.action === 'DELETE_BUILT_IN_VARIABLES') {
        if (!ignore) builtins = builtins.filter(b => !u.searchParams.getAll('type').includes(b.type));
      } else if (s.action === 'REVERT_BUILT_IN_VARIABLE') {
        if (!ignore) builtins = builtins.filter(b => b.type !== u.searchParams.get('type'));
        response = {enabled: false};
      } else if (s.action === 'MOVE_ENTITIES_TO_FOLDER') {
        if (!ignore)
          for (const [key, collection] of [
            ['tagId', 'tags'],
            ['triggerId', 'triggers'],
            ['variableId', 'variables'],
          ])
            for (const id of u.searchParams.getAll(key!)) {
              const target = workspace + '/' + collection + '/' + id;
              records.set(target, {
                ...records.get(target),
                parentFolderId: s.path.split('/').at(-1) === '0' ? '' : s.path.split('/').at(-1),
              });
            }
      } else if (s.action === 'SET_LATEST_CONTAINER_VERSION') {
        response = records.get(s.path)!;
        if (!ignore) records.set(container + '/version_headers:latest', response);
      } else if (s.action === 'UNDELETE_CONTAINER_VERSION') {
        response = {...records.get(s.path), deleted: false};
        if (!ignore) records.set(s.path, response);
      } else if (s.action === 'IMPORT_TEMPLATE_FROM_GALLERY') {
        const v = row(workspace + '/templates/99', {
          templateId: '99',
          name: 'Imported template',
          templateData: 'Synthetic template content',
          galleryReference: {
            owner: u.searchParams.get('galleryOwner'),
            repository: u.searchParams.get('galleryRepository'),
            version: u.searchParams.get('gallerySha'),
          },
        });
        response = v;
        if (!ignore) {
          records.set(v.path, v);
          templates.push(v);
        }
      } else if (s.action === 'REAUTHORIZE_ENVIRONMENT') {
        response = {
          ...records.get(s.path),
          authorizationCode: 'synthetic-new-preview-secret',
          authorizationTimestamp: '2026-09-19T00:00:00Z',
          fingerprint: 'environment-2',
        };
        if (!ignore) records.set(s.path, response);
      } else if (s.action === 'UPDATE_ACCOUNT') {
        response = {...records.get(s.path), ...body, fingerprint: 'account-2'};
        if (!ignore) records.set(s.path, response!);
      } else if (s.action === 'CREATE_USER_PERMISSION') {
        response = row(base + '/user_permissions/99', body);
        if (!ignore) permissions.push(response);
      } else if (s.action === 'UPDATE_USER_PERMISSION') {
        response = row(s.path, body);
        if (!ignore) permissions = permissions.map(r => (r.path === s.path ? response! : r));
      } else if (s.action === 'DELETE_USER_PERMISSION') {
        if (!ignore) permissions = permissions.filter(r => r.path !== s.path);
      }
      if (lost) throw Error('Accepted mutation, response lost');
      if (mode === 'foreign-receipt') {
        if (entity)
          response = {
            [entity[2]]: {
              ...response![entity[2]],
              path: response![entity[2]].path.replace('accounts/44', 'accounts/999'),
            },
          };
        else if (response) response = {...response, path: 'accounts/999/containers/55/workspaces/66/templates/99'};
      }
      return response === null ? new Response(null, {status: 204}) : Response.json(response);
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const args = (extra: JsonObject = {}) => ({
    operation: 'gtm_ops',
    arguments: {
      action: s.action,
      account_id: '44',
      [s.parent ? 'parent' : 'path']: s.path,
      ...(s.query ? {params: s.query} : {}),
      ...(s.body ? {payload: s.body} : {}),
      ...extra,
    },
  });
  const prepare = (who = actor, extra: JsonObject = {}) =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: args(extra)}, who);
  const execute = (p: JsonObject, who = actor) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        spend_change_confirmed: true,
      },
      who,
    );
  const verify = (p: JsonObject) =>
    service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {
    store,
    service,
    calls,
    records,
    connection,
    args,
    prepare,
    execute,
    verify,
    writes: () => writes,
    mode: (v: string) => {
      mode = v;
    },
    partial: () => {
      partial = true;
    },
    lose: () => {
      lost = true;
    },
    ignore: () => {
      ignore = true;
    },
    cycle: () => {
      cycles = true;
    },
    revoke: () => {
      revoke = true;
    },
    deny: () => {
      denyRead = true;
    },
    pageFailure: () => {
      pageFailure = true;
    },
    permissions: (rows: JsonObject[]) => {
      permissions = rows;
    },
    permissionRows: () => permissions,
  };
}
for (const s of scenarios)
  test('Tag Manager reviewed lifecycle: ' + s.action, async () => {
    const f = fixture(s);
    try {
      const p = await f.prepare();
      assert.equal(p.success, true, JSON.stringify(p));
      assert.ok(f.calls.every(c => c.method === 'GET'));
      const e = await f.execute(p);
      assert.equal(e.success, true, JSON.stringify(e));
      const v = await f.verify(p);
      assert.equal(v.data.status, 'verified', JSON.stringify(v));
      const calls = f.calls.length;
      assert.equal((await f.execute(p)).data.replayed, true);
      assert.equal(f.calls.length, calls);
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  });
test('the workflow set is explicit and every declared mutation has independent Discovery method evidence', () => {
  assert.deepEqual(Object.keys(gtmWorkflowContracts).sort(), scenarios.map(s => s.action).sort());
  const d = JSON.parse(fs.readFileSync('.mirror/VENDOR/gtm-v2.json', 'utf8')).document,
    methods: JsonObject[] = [];
  const visit = (r: JsonObject) => {
    methods.push(...(Object.values(r.methods ?? {}) as JsonObject[]));
    Object.values(r.resources ?? {}).forEach(v => visit(v as JsonObject));
  };
  visit(d);
  const compiler = new DelegatedNativeCompiler();
  for (const [action, contract] of Object.entries(gtmWorkflowContracts)) {
    const route = compiler.data.routes.find(r => r.gateway === gateway && r.action === action)!;
    assert.ok(route, action);
    const method = methods.find(m => m.id === route.vendorMethod)!;
    assert.ok(method, action);
    assert.equal(method.httpMethod, contract.method, action);
    assert.ok(method.scopes.includes(contract.scope), action);
    for (const query of contract.queries)
      assert.equal(method.parameters[query].location, 'query', action + '/' + query);
  }
  assert.equal(
    d.resources.accounts.resources.containers.resources.workspaces.resources.templates.methods.revert.response.$ref,
    'RevertTemplateResponse',
  );
});
test('administrator roles and native scopes are independently required before reading sensitive administrative state', async () => {
  for (const s of scenarios.filter(s => /USER_PERMISSION|UPDATE_ACCOUNT|REAUTHORIZE/.test(s.action))) {
    const f = fixture(s);
    try {
      assert.equal((await f.prepare({...actor, role: 'operator'})).error.code, 'FORBIDDEN');
      f.store.putConnection(actor, {...f.connection, scopes: [scope('edit.containers')]}, {accessToken: 'synthetic'});
      assert.equal((await f.prepare()).error.code, 'PROVIDER_WRITE_SCOPE_REQUIRED');
      assert.equal(f.calls.length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('malformed, foreign, unpinned and implicit configuration inputs are refused without network requests', async () => {
  const choices: [string, JsonObject][] = [
    ['UPDATE_ACCOUNT', {payload: {name: 'Missing explicit data sharing'}}],
    ['UPDATE_ACCOUNT', {payload: {name: 'Changed', shareData: true, accountId: '999'}}],
    ['REAUTHORIZE_ENVIRONMENT', {payload: {authorizationCode: 'caller-secret'}}],
    ['CREATE_BUILT_IN_VARIABLES', {params: {type: ['pageUrl', 'pageUrl']}}],
    ['REVERT_BUILT_IN_VARIABLE', {params: {type: 'madeUpVariable'}}],
    [
      'IMPORT_TEMPLATE_FROM_GALLERY',
      {params: {galleryOwner: 'owner', galleryRepository: 'template', acknowledgePermissions: true}},
    ],
    [
      'IMPORT_TEMPLATE_FROM_GALLERY',
      {
        params: {
          galleryOwner: 'owner',
          galleryRepository: 'template',
          gallerySha: 'a'.repeat(40),
          acknowledgePermissions: false,
        },
      },
    ],
    [
      'CREATE_USER_PERMISSION',
      {
        payload: {
          emailAddress: 'member@example.test',
          accountAccess: {permission: 'admin'},
          containerAccess: [{containerId: '999', permission: 'invented'}],
        },
      },
    ],
  ];
  for (const [a, extra] of choices) {
    const f = fixture(scenarios.find(s => s.action === a)!);
    try {
      assertRefused(await f.prepare(actor, extra), [
        'INVALID_GTM_REQUEST',
        'ACCOUNT_SCOPE_MISMATCH',
        'INVALID_PARAMETER',
        'INVALID_VENDOR_BODY',
      ]);
      assert.equal(f.calls.length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('complete paginated permissions prevent duplicate users, immutable-recipient updates and removing the last administrator', async () => {
  const create = fixture(scenarios.find(s => s.action === 'CREATE_USER_PERMISSION')!);
  try {
    assert.equal(
      (
        await create.prepare(actor, {
          payload: {emailAddress: 'backup@example.test', accountAccess: {permission: 'user'}, containerAccess: []},
        })
      ).error.code,
      'CONFIGURATION_EXISTS',
    );
    assert.ok(create.calls.some(c => c.query.pageToken === '2'));
    assert.equal(create.writes(), 0);
  } finally {
    create.store.close();
  }
  const update = fixture(scenarios.find(s => s.action === 'UPDATE_USER_PERMISSION')!);
  try {
    assert.equal(
      (
        await update.prepare(actor, {
          payload: {
            emailAddress: 'someone-else@example.test',
            accountAccess: {permission: 'admin'},
            containerAccess: [],
          },
        })
      ).error.code,
      'INVALID_GTM_REQUEST',
    );
  } finally {
    update.store.close();
  }
  const remove = fixture(scenarios.find(s => s.action === 'DELETE_USER_PERMISSION')!);
  try {
    remove.permissions([
      {
        path: base + '/user_permissions/7',
        accountId: '44',
        emailAddress: 'only@example.test',
        accountAccess: {permission: 'admin'},
        containerAccess: [],
      },
    ]);
    assert.equal((await remove.prepare()).error.code, 'STATE_LAST_ADMIN');
    assert.equal(remove.writes(), 0);
  } finally {
    remove.store.close();
  }
});
test('failed pages, repeated cursors, foreign membership and in-flight grant revocation cannot yield a review', async () => {
  for (const mode of ['page', 'cycle', 'foreign', 'revoke']) {
    const f = fixture(scenarios.find(s => s.action === 'CREATE_USER_PERMISSION')!);
    try {
      if (mode === 'page') f.pageFailure();
      if (mode === 'cycle') f.cycle();
      if (mode === 'foreign') f.mode('foreign-read');
      if (mode === 'revoke') f.revoke();
      assertRefused(await f.prepare(), [
        'UPSTREAM_ERROR',
        'INCOMPLETE_STATE',
        'STATE_TARGET_MISMATCH',
        'WRITE_ACCOUNT_FORBIDDEN',
      ]);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});
test('real state changes conflict while request telemetry and collection order do not', async () => {
  const f = fixture(scenarios.find(s => s.action === 'UPDATE_USER_PERMISSION')!);
  try {
    const p = await f.prepare();
    assert.equal(p.success, true);
    f.permissions(f.permissionRows().toReversed());
    assert.equal((await f.execute(p)).success, true);
  } finally {
    f.store.close();
  }
  const g = fixture(scenarios[0]!);
  try {
    const p = await g.prepare();
    g.records.get(workspace + '/clients/7')!.name = 'Changed by another editor';
    assert.equal((await g.execute(p)).error.code, 'STATE_CHANGED');
    assert.equal(g.writes(), 0);
  } finally {
    g.store.close();
  }
});
test('environment rotation never persists or returns plaintext codes and read-back must confirm rotation', async () => {
  const f = fixture(scenarios.find(s => s.action === 'REAUTHORIZE_ENVIRONMENT')!);
  try {
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    const e = await f.execute(p);
    assert.equal(e.success, true);
    assert.equal((await f.verify(p)).data.status, 'verified');
    const rows = f.store.db.prepare('SELECT data FROM documents').all();
    const serialized = JSON.stringify({p, e, rows});
    assert.ok(!serialized.includes('synthetic-old-preview-secret'));
    assert.ok(!serialized.includes('synthetic-new-preview-secret'));
    assert.ok(serialized.includes('amcpAuthorizationCodeHash'));
    assert.deepEqual(redact({authorizationCode: 'secret', url: 'https://example.test/?gtm_auth=secret'}), {
      authorizationCode: '[REDACTED]',
      url: 'https://example.test/?gtm_auth=[REDACTED]',
    });
  } finally {
    f.store.close();
  }
});
test('reverting an added entity verifies scoped absence; permission errors do not prove removal', async () => {
  for (const deny of [false, true]) {
    const f = fixture(scenarios.find(s => s.action === 'REVERT_TAG')!);
    try {
      const p = await f.prepare();
      f.mode('revert-absent');
      assert.equal((await f.execute(p)).success, true);
      if (deny) f.deny();
      const v = await f.verify(p);
      assert.equal(v.data.status, deny ? 'unverified' : 'verified', JSON.stringify(v));
    } finally {
      f.store.close();
    }
  }
});
test('reverts and environment rotation respect deletion policy even though their method is POST', async () => {
  for (const action of ['REVERT_TAG', 'REVERT_BUILT_IN_VARIABLE', 'REAUTHORIZE_ENVIRONMENT']) {
    const f = fixture(scenarios.find(s => s.action === action)!);
    try {
      saveSpendPolicy(f.store, actor, {gateway, account_id: '44', confirmed: true, policy: {allow_deletion: false}});
      assert.equal((await f.prepare()).error.code, 'POLICY_DELETION_FORBIDDEN');
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});
test('foreign or partial receipts fail durably and unchanged provider state cannot pass read-back', async () => {
  for (const a of ['REVERT_TEMPLATE', 'CREATE_BUILT_IN_VARIABLES']) {
    const f = fixture(scenarios.find(s => s.action === a)!);
    try {
      const p = await f.prepare();
      if (a === 'REVERT_TEMPLATE') f.mode('foreign-receipt');
      else f.partial();
      assertRefused(await f.execute(p), 'WRITE_PARTIAL_OR_FAILED');
      assert.equal((await f.execute(p)).data.replayed, true);
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
  const f = fixture(scenarios.find(s => s.action === 'MOVE_ENTITIES_TO_FOLDER')!);
  try {
    const p = await f.prepare();
    f.ignore();
    assert.equal((await f.execute(p)).success, true);
    assert.equal((await f.verify(p)).data.status, 'inconclusive');
  } finally {
    f.store.close();
  }
});
test('concurrent executions and lost responses never automatically repeat a Tag Manager mutation', async () => {
  const f = fixture(scenarios.find(s => s.action === 'CREATE_BUILT_IN_VARIABLES')!);
  try {
    const p = await f.prepare();
    const outcomes = await Promise.all([f.execute(p), f.execute(p)]);
    assert.ok(outcomes.some(r => r.success));
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
  const g = fixture(scenarios.find(s => s.action === 'IMPORT_TEMPLATE_FROM_GALLERY')!);
  try {
    const p = await g.prepare();
    g.lose();
    assert.equal((await g.execute(p)).success, false);
    assert.equal((await g.execute(p)).error.code, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(g.writes(), 1);
  } finally {
    g.store.close();
  }
});
