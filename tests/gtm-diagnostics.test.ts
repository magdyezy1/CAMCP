import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {actionContracts} from '../src/action-contracts.js';
import type {Actor, JsonObject} from '../src/types.js';

const actor: Actor = {tenantId: 'gtm-diagnostic-tests', userId: 'owner', role: 'admin'},
  gateway = 'gtm_native_action',
  a = 'accounts/44',
  c = a + '/containers/55',
  w = c + '/workspaces/66',
  prefix = '/tagmanager/v2/';
const row = (path: string, fields: JsonObject = {}): JsonObject => ({
  path,
  accountId: '44',
  ...(path.includes('/containers/') ? {containerId: path.split('/')[3]} : {}),
  ...(path.includes('/workspaces/') ? {workspaceId: path.split('/')[5]} : {}),
  ...fields,
});
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 85).toString('base64')),
    registry = new Registry(),
    connection = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      gateway,
      accounts: ['44'],
      writeAccounts: ['44'],
      enabled: true,
      label: 'Chosen GTM login',
      scopes: ['readonly', 'edit.containers'].map(s => 'https://www.googleapis.com/auth/tagmanager.' + s),
    },
    calls: JsonObject[] = [];
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  const resources = new Map<string, JsonObject>([
    [a, row(a, {name: 'Account'})],
    [c, row(c, {name: 'Container'})],
    [w, row(w, {name: 'Workspace', fingerprint: 'workspace-1'})],
    [w + '/status', {workspaceChange: [], mergeConflict: []}],
  ]);
  const tag = (id: string, extra: JsonObject = {}) =>
    row(w + '/tags/' + id, {
      tagId: id,
      name: 'Duplicate tag',
      type: 'html',
      firingTriggerId: ['3'],
      parameter: [],
      ...extra,
    });
  const lists = new Map<string, [string, JsonObject[]]>([
    [
      a + '/containers',
      [
        'container',
        [row(c, {containerId: '55', name: 'First'}), row(a + '/containers/56', {containerId: '56', name: 'Second'})],
      ],
    ],
    [
      c + '/workspaces',
      [
        'workspace',
        [row(w, {workspaceId: '66', name: 'Draft'}), row(c + '/workspaces/67', {workspaceId: '67', name: 'Other'})],
      ],
    ],
    [
      c + '/version_headers',
      [
        'containerVersionHeader',
        [row(c + '/versions/8', {containerVersionId: '8'}), row(c + '/versions/9', {containerVersionId: '9'})],
      ],
    ],
    [
      w + '/tags',
      [
        'tag',
        [
          tag('1', {
            parentFolderId: '99',
            firingTriggerId: ['3', 'provider-managed'],
            parameter: [{type: 'template', key: 'html', value: '{{Missing variable}}'}],
          }),
          tag('2'),
        ],
      ],
    ],
    [w + '/triggers', ['trigger', [row(w + '/triggers/3', {triggerId: '3', name: 'Trigger', type: 'pageview'})]]],
    [w + '/variables', ['variable', [row(w + '/variables/4', {variableId: '4', name: 'Known', type: 'c'})]]],
    [w + '/folders', ['folder', []]],
    [w + '/templates', ['template', []]],
    [w + '/clients', ['client', []]],
    [w + '/transformations', ['transformation', []]],
    [w + '/zones', ['zone', []]],
    [w + '/gtag_config', ['gtagConfig', []]],
    [
      w + '/built_in_variables',
      ['builtInVariable', [row(w + '/built_in_variables/pagePath', {type: 'pagePath', name: 'Page Path'})]],
    ],
  ]);
  const version = (id: string) =>
    row(c + '/versions/' + id, {
      containerVersionId: id,
      tag: structuredClone(lists.get(w + '/tags')![1]),
      trigger: structuredClone(lists.get(w + '/triggers')![1]),
      variable: structuredClone(lists.get(w + '/variables')![1]),
      builtInVariable: structuredClone(lists.get(w + '/built_in_variables')![1]),
    });
  resources.set(c + '/versions/9', version('9'));
  resources.set(c + '/versions:live', version('8'));
  resources.set(c + '/version_headers:latest', row(c + '/versions/9', {containerVersionId: '9'}));
  let mode = '',
    revoke = false;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(
      async (input, init) => {
        const url = new URL(String(input)),
          path = url.pathname.slice(prefix.length),
          method = init!.method!;
        calls.push({path, method, query: Object.fromEntries(url.searchParams)});
        if (revoke)
          store.putConnection(actor, {...connection, enabled: false, writeAccounts: []}, {accessToken: 'synthetic'});
        if (method === 'POST' && path === w + '/folders') {
          const created = row(w + '/folders/99', {folderId: '99', name: 'Reviewed folder', fingerprint: 'new'});
          resources.set(created.path, created);
          return Response.json(created);
        }
        assert.equal(method, 'GET', 'diagnostic attempted a mutation');
        if (mode === 'denied') return Response.json({error: {code: 403}}, {status: 403});
        if (mode === 'unpublished' && path === c + '/versions:live')
          return Response.json({error: {code: 404}}, {status: 404});
        const list = lists.get(path);
        if (list) {
          const offset = Number(url.searchParams.get('pageToken') ?? 0);
          if (mode === 'page-failure' && offset) return Response.json({error: {code: 503}}, {status: 503});
          const values = structuredClone(list[1].slice(offset, offset + 1));
          if (mode === 'foreign' && values[0]) values[0].path = values[0].path.replace('accounts/44', 'accounts/999');
          return Response.json({
            ...(values.length ? {[list[0]]: values} : {}),
            ...(mode === 'cycle'
              ? {nextPageToken: '1'}
              : offset + 1 < list[1].length
                ? {nextPageToken: String(offset + 1)}
                : {}),
          });
        }
        const found = resources.get(path);
        return found ? Response.json(found) : Response.json({error: {code: 404}}, {status: 404});
      },
      async () => {},
      30000,
      8 * 1024 * 1024,
      10000,
      1,
    ),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const audit = (arguments_: JsonObject = {}, who = actor) =>
    service.call(gateway, {operation: 'gtm_audit_ops', arguments: {connection_id: connection.id, ...arguments_}}, who);
  const job = (id: string, who = actor) =>
    service.call(gateway, {operation: 'gtm_action_job_status', arguments: {job_id: id}}, who);
  const reviewedJob = async () => {
    const p = await service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          operation: 'gtm_ops',
          arguments: {
            action: 'CREATE_FOLDER',
            account_id: '44',
            connection_id: connection.id,
            parent: w,
            payload: {name: 'Reviewed folder'},
          },
        },
      },
      actor,
    );
    assert.equal(p.success, true, JSON.stringify(p));
    const e = await service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        spend_change_confirmed: true,
      },
      actor,
    );
    assert.equal(e.success, true, JSON.stringify(e));
    return {id: e.data.verification.job_id, review: p.data.review_id};
  };
  return {
    store,
    registry,
    connection,
    service,
    calls,
    resources,
    lists,
    audit,
    job,
    reviewedJob,
    mode: (v: string) => {
      mode = v;
    },
    revoke: () => {
      revoke = true;
    },
  };
}
test('both remaining GTM catalog operations now have explicit local implementations', () => {
  const f = fixture();
  try {
    const rows = actionContracts(f.registry).filter(r => r.gateway === gateway);
    assert.equal(rows.filter(r => r.status === 'unmapped' || r.status === 'blocked_write').length, 0);
    for (const op of ['gtm_audit_ops', 'gtm_action_job_status']) {
      const r = rows.find(x => x.operation === op)!;
      assert.equal(r.status, 'local_workflow');
      assert.equal(r.implementation, 'src/gtm-diagnostics.ts');
    }
  } finally {
    f.store.close();
  }
});

test('workspace audit includes bounded additional-consent evidence through the existing authorized reads', async () => {
  const f = fixture();
  try {
    const tags = f.lists.get(w + '/tags')![1];
    tags[0]!.consentSettings = {
      consentStatus: 'needed',
      consentType: {type: 'list', list: [{type: 'template', value: 'ad_storage'}]},
    };
    tags[1]!.consentSettings = {consentStatus: 'notNeeded'};
    const out = await f.audit({account_id: '44', container_id: '55', workspace_id: '66', include_versions: false});
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.consent_evidence.workspace_path, w);
    assert.equal(out.data.consent_evidence.counts.needed, 1);
    assert.equal(out.data.consent_evidence.counts.notNeeded, 1);
    assert.deepEqual(out.data.consent_evidence.rows[0].required_types, ['ad_storage']);
    assert.equal(out.data.resources, undefined);
    assert.equal(out.data.publish_ready, null);
    assert.equal(out.data.provider_mutations, 0);
    assert.ok(f.calls.every(call => call.method === 'GET'));
    assert.equal(f.calls.filter(call => call.path === w + '/tags').length, 2);
    assert.equal(f.calls.filter(call => call.path.includes('/tags/')).length, 0);
    const inventory = await f.audit({account_id: '44', container_id: '55', include_versions: false});
    assert.equal(inventory.data.consent_evidence, undefined, 'container inventory is not a workspace consent audit');
  } finally {
    f.store.close();
  }
});
test('audit discovery is confined to granted accounts and complete paginated container/workspace lists', async () => {
  const f = fixture();
  try {
    const accounts = await f.audit();
    assert.equal(accounts.success, true, JSON.stringify(accounts));
    assert.equal(accounts.data.accounts[0].account_id, '44');
    assert.equal(accounts.data.network_requests, 1);
    const containers = await f.audit({account_id: '44'});
    assert.equal(containers.success, true);
    assert.equal(containers.data.counts.containers, 2);
    const workspaces = await f.audit({account_id: '44', container_id: '55'});
    assert.equal(workspaces.success, true, JSON.stringify(workspaces));
    assert.equal(workspaces.data.counts.workspaces, 2);
    assert.equal(workspaces.data.versions.count, 2);
    assert.equal(workspaces.data.versions.live.id, '8');
    assert.ok(f.calls.every(c => c.method === 'GET'));
    assert.ok(!f.calls.some(c => c.path === 'accounts'));
  } finally {
    f.store.close();
  }
});
test('workspace diagnostics detect duplicate names, unresolved references and conflicts without claiming publish readiness', async () => {
  const f = fixture();
  try {
    f.resources.get(w + '/status')!.mergeConflict = [
      {entityInWorkspace: {tag: structuredClone(f.lists.get(w + '/tags')![1][0]), changeStatus: 'updated'}},
    ];
    const out = await f.audit({account_id: '44', container_id: '55', workspace_id: '66'}, {...actor, role: 'reader'});
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.publish_ready, null);
    assert.equal(out.data.counts.tag, 2);
    assert.equal(out.data.complete, true);
    assert.equal(out.data.provider_mutations, 0);
    assert.equal(out.data.resources, undefined);
    assert.deepEqual(out.data.status, {workspace_changes: 0, merge_conflicts: 1});
    for (const code of [
      'DUPLICATE_NAME',
      'UNRESOLVED_FOLDER',
      'UNRESOLVED_OR_SYSTEM_TRIGGER',
      'UNRESOLVED_VARIABLE',
      'MERGE_CONFLICT',
    ])
      assert.ok(
        out.data.findings.some((r: JsonObject) => r.code === code),
        code,
      );
    assert.equal(
      out.data.findings.find((r: JsonObject) => r.code === 'UNRESOLVED_OR_SYSTEM_TRIGGER').severity,
      'unknown',
    );
    assert.ok(out.meta.untrusted_provider_content);
    assert.ok(!JSON.stringify(out).includes('{{Missing variable}}'));
  } finally {
    f.store.close();
  }
});
test('full resource output is explicit and excluding versions suppresses version reads', async () => {
  const f = fixture();
  try {
    const out = await f.audit({
      account_id: '44',
      container_id: '55',
      workspace_id: '66',
      include_resources: true,
      include_versions: false,
    });
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.resources.tag['1'].tagId, '1');
    assert.equal(out.data.versions, undefined);
    assert.ok(!f.calls.some(c => /\/versions|\/version_headers/.test(c.path)));
    assert.ok(f.calls.every(c => c.method === 'GET'));
  } finally {
    f.store.close();
  }
});

test('diagnostic localization metadata retains original finding messages and exact native IDs without additional reads', async () => {
  const f = fixture();
  try {
    f.mode('unpublished');
    const out = await f.audit({account_id: '44', container_id: '55', workspace_id: '66'}, {...actor, role: 'reader'});
    assert.equal(out.success, true, JSON.stringify(out));
    const find = (code: string) => out.data.findings.find((r: JsonObject) => r.code === code);
    assert.deepEqual(find('DUPLICATE_NAME').message_localization, {key: 'duplicate_name', kind: 'tag'});
    assert.equal(find('DUPLICATE_NAME').message, 'Another tag has this same name; choose IDs explicitly.');
    assert.deepEqual(find('UNRESOLVED_OR_SYSTEM_TRIGGER').message_localization, {
      key: 'unresolved_trigger',
      trigger_id: 'provider-managed',
    });
    assert.equal(
      find('UNRESOLVED_OR_SYSTEM_TRIGGER').message,
      'Trigger provider-managed is not in the workspace inventory; resolve whether it is provider-managed or missing before publishing.',
    );
    assert.deepEqual(find('NO_LIVE_VERSION').message_localization, {key: 'missing_version', version: 'live'});
    assert.equal(find('NO_LIVE_VERSION').message, 'No live version was returned (scoped 404).');
    assert.equal(find('UNRESOLVED_FOLDER').message_localization, undefined);
    assert.equal(out.data.provider_mutations, 0);
    assert.equal(out.data.publish_ready, null);
    assert.ok(f.calls.every(call => call.method === 'GET'));
    f.resources.delete(c + '/version_headers:latest');
    const missingLatest = await f.audit({account_id: '44', container_id: '55'});
    assert.equal(missingLatest.success, true, JSON.stringify(missingLatest));
    const latest = missingLatest.data.findings.find((r: JsonObject) => r.code === 'NO_LATEST_VERSION');
    assert.deepEqual(latest.message_localization, {key: 'missing_version', version: 'latest'});
    assert.equal(latest.message, 'No latest version was returned (scoped 404).');
  } finally {
    f.store.close();
  }
});
test('failed or incomplete audit sources never turn into a successful empty audit', async () => {
  for (const mode of ['foreign', 'page-failure', 'cycle', 'denied']) {
    const f = fixture();
    try {
      f.mode(mode);
      const out = await f.audit({account_id: '44'});
      assert.equal(out.success, false, mode);
      assert.equal(out.data, undefined);
      assert.ok(f.calls.every(c => c.method === 'GET'));
    } finally {
      f.store.close();
    }
  }
});
test('audit checks exact inputs, current account grants and in-flight revocation', async () => {
  for (const input of [
    {account_id: '999'},
    {container_id: '55'},
    {account_id: '44', workspace_id: '66'},
    {account_id: '44', container_id: '55', workspace_id: '66/..'},
  ]) {
    const f = fixture();
    try {
      assert.equal((await f.audit(input)).success, false);
      assert.equal(f.calls.length, 0);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    f.revoke();
    assert.equal((await f.audit({account_id: '44'})).success, false);
    assert.equal(f.calls.length, 1);
  } finally {
    f.store.close();
  }
});
test('unpublished container is reported only from a scoped 404 and stays distinct from authorization failure', async () => {
  const f = fixture();
  try {
    f.mode('unpublished');
    const out = await f.audit({account_id: '44', container_id: '55'});
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.versions.live, null);
    assert.ok(out.data.findings.some((x: JsonObject) => x.code === 'NO_LIVE_VERSION'));
  } finally {
    f.store.close();
  }
});
test('real reviewed-write verification jobs can be polled without credentials or another provider call', async () => {
  const f = fixture();
  try {
    const {id, review} = await f.reviewedJob(),
      before = f.calls.length;
    const queued = await f.job(id);
    assert.equal(queued.success, true, JSON.stringify(queued));
    assert.equal(queued.data.state, 'queued');
    assert.equal(queued.data.review_id, review);
    assert.equal(queued.data.provider_job, false);
    assert.equal(queued.data.automatic_retry_of_mutation, false);
    assert.equal(queued.data.input, undefined);
    assert.equal(queued.data.lease_token, undefined);
    assert.equal(f.calls.length, before);
    const checked = await f.service.call('amcp_campaign', {action: 'verify', review_id: review}, actor);
    assert.equal(checked.data.status, 'verified', JSON.stringify(checked));
    assert.equal((await f.job(id)).data.verification.status, 'verified');
  } finally {
    f.store.close();
  }
});
test('job status cannot expose other tenants, providers, actors or revoked account access', async () => {
  const f = fixture();
  try {
    const {id, review} = await f.reviewedJob();
    assert.equal((await f.job(id, {...actor, tenantId: 'another-workspace'})).error.code, 'NOT_FOUND');
    assert.equal((await f.job(id, {...actor, userId: 'other-operator', role: 'operator'})).error.code, 'NOT_FOUND');
    assert.equal((await f.job(id, {...actor, userId: 'another-admin', role: 'admin'})).success, true);
    const unrelated = f.store.enqueue(actor.tenantId, 'report', {private: 'must not be returned'});
    assert.equal((await f.job(unrelated)).error.code, 'NOT_FOUND');
    f.store.putConnection(actor, {...f.connection, enabled: false, writeAccounts: []}, {accessToken: 'synthetic'});
    assert.equal((await f.job(id)).success, false);
    f.store.putConnection(actor, f.connection, {accessToken: 'synthetic'});
    const record = f.store.document(actor.tenantId, 'write_review', review);
    f.store.putDocument(actor.tenantId, 'write_review', review, {
      ...record,
      plan: {...record.plan, gateway: 'ga4_native_action'},
    });
    assert.equal((await f.job(id)).error.code, 'NOT_FOUND');
  } finally {
    f.store.close();
  }
});
