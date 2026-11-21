// ARC-02: the document-kind registry and the tenant-bound repository. Every kind the application names is declared
// once with its owner, scope, version, store contract and retention; a repository is bound to one workspace (or one
// service partition) and kind, so a read, change or deletion through it never reaches another workspace's documents.
// Synthetic in-memory stores only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../dist/src/store.js';
import {
  backupExcludedCondition,
  documentKind,
  documentKinds,
  documentProblems,
  isServicePartition,
  maintenanceSweeps,
  personDocumentsCondition,
  reportRetentionDocumentKinds,
  reportRetentionJobKinds,
  servicePartitions,
} from '../dist/src/document-kinds.js';
import {createEncryptedBackup, restoreEncryptedBackup} from '../dist/src/backup.js';
import {disconnectLocalConnection, disconnectedKinds} from '../dist/src/connection-disconnect.js';
import {documentKindsFile, documentKindsMarkdown} from '../dist/tools/document-kinds-doc.js';
import {removeTestDirectory} from '../dist/tests/temp.js';
import {applyReportRetention, reportSweepKinds} from '../dist/src/retention-repository.js';
import {eraseAccount} from '../dist/src/account-erasure.js';
import {WebStore} from '../dist/server/web-store.js';
import {UserAccounts} from '../dist/server/user-accounts.js';
import {reportRetentionKinds} from '../dist/src/data-retention.js';
import {namedKinds, scanTree} from '../tools/check-storage-boundary.mjs';

const tenants = ['tenant-a', 'tenant-b'];
function store() {
  const s = new Store(':memory:');
  for (const t of tenants) s.ensureTenant(t);
  return s;
}

test('every document kind the application and its tools name is declared once, with an owner and a retention', () => {
  const result = scanTree();
  assert.deepEqual(result.unregistered, {});
  const kinds = documentKinds();
  assert.equal(kinds.length, result.registered_kinds);
  assert.equal(new Set(kinds.map(k => k.name)).size, kinds.length);
  for (const kind of kinds) {
    assert.ok(fs.existsSync(kind.owner), kind.name + ' owner ' + kind.owner);
    assert.ok(Number.isSafeInteger(kind.version) && kind.version >= 1, kind.name + ' version');
    assert.ok(kind.summary.length > 10 && kind.retention.summary.length > 10, kind.name + ' summaries');
    assert.ok(['tenant', 'service'].includes(kind.scope), kind.name + ' scope');
    // A service kind names its partition; a workspace kind has none.
    assert.equal(kind.scope === 'service', Object.hasOwn(servicePartitions, kind.partition ?? ''), kind.name);
    for (const [field, type] of Object.entries(kind.fields)) {
      assert.match(field, /^[A-Za-z_][A-Za-z0-9_]*\??$/, kind.name + ' field ' + field);
      assert.ok(['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(type), kind.name + ' ' + field);
    }
    const r = kind.retention;
    if (r.rule === 'with_parent') assert.equal(documentKind(r.parent).name, r.parent);
    // Retention and expiry read their clock field, so the store contract declares it.
    const clock =
      r.rule === 'expires'
        ? [r.field]
        : r.rule === 'period'
          ? [r.from.replace(/^\$\./, '')]
          : r.rule === 'report'
            ? r.from.map(f => f.replace(/^\$\./, ''))
            : [];
    for (const field of clock)
      assert.ok(field in kind.fields || field + '?' in kind.fields, kind.name + ' declares its clock ' + field);
    if (kind.person) assert.equal(kind.scope, 'tenant', kind.name + ' person data belongs to a workspace');
  }
  // A kind used only by a test is not a declaration the registry has to hold.
  assert.throws(() => documentKind('report_snapshot'), /Undeclared document kind "report_snapshot"/);
});

test('the completeness check finds kinds named by literals, module constants and SQL predicates on documents', () => {
  const source = [
    "const reviewKind = 'write_review', other = 'not_a_kind';",
    "store.putDocument(t, 'alpha_kind', id, {});",
    'store.documents(tenant, reviewKind);',
    "store.repo('beta_kind', tenant).list();",
    "db.prepare(\"SELECT 1 FROM documents WHERE tenant_id=? AND kind IN ('gamma_kind','delta_kind')\");",
    // A statement on jobs names job kinds, not document kinds; one that reads both counts the documents alias only.
    'db.prepare("SELECT 1 FROM jobs WHERE kind=\'report_overview\'");',
    "db.prepare(\"SELECT 1 FROM jobs j JOIN documents d ON d.tenant_id=j.tenant_id WHERE j.kind='report' AND d.kind='epsilon_kind'\");",
  ].join('\n');
  assert.deepEqual([...namedKinds(source)].sort(), [
    'alpha_kind',
    'beta_kind',
    'delta_kind',
    'epsilon_kind',
    'gamma_kind',
    'write_review',
  ]);
});

test('a workspace repository reads, writes, counts and deletes only its own workspace and kind', () => {
  const s = store();
  try {
    s.putDocument('tenant-b', 'overview_view', 'shared-id', {name: 'B view'});
    s.putDocument('tenant-a', 'overview_template', 'shared-id', {name: 'A template'});
    const a = s.repo('overview_view', 'tenant-a');
    assert.equal(a.tenant, 'tenant-a');
    // The same id in another workspace, or of another kind in this workspace, is not this repository's document.
    assert.equal(a.find('shared-id'), undefined);
    assert.throws(() => a.get('shared-id'), {code: 'NOT_FOUND'});
    assert.deepEqual(a.list(), []);
    assert.equal(a.count(), 0);
    assert.deepEqual(a.select('1=1'), []);
    assert.equal(a.delete('shared-id'), false);
    assert.equal(a.deleteWhere('1=1'), 0);
    assert.equal(a.updateWhere("data=json_set(data,'$.name',?)", ['changed'], '1=1'), 0);
    assert.equal(s.document('tenant-b', 'overview_view', 'shared-id').name, 'B view');
    assert.equal(s.document('tenant-a', 'overview_template', 'shared-id').name, 'A template');
    // Writes land in this workspace only, with the store's revisions.
    assert.deepEqual(a.put('shared-id', {name: 'A view'}), {id: 'shared-id', revision: 1});
    assert.throws(() => a.put('shared-id', {name: 'stale'}, 0), {code: 'REVISION_CONFLICT'});
    assert.equal(a.get('shared-id').name, 'A view');
    assert.equal(s.repo('overview_view', 'tenant-b').get('shared-id').name, 'B view');
    assert.deepEqual(
      a.select("json_extract(data,'$.name')=?", ['A view']).map(d => [d.id, d.name, d.revision]),
      [['shared-id', 'A view', 1]],
    );
    assert.equal(a.updateWhere("data=json_set(data,'$.name',?)", ['A renamed'], '1=1'), 1);
    assert.deepEqual([a.get('shared-id').name, a.get('shared-id').revision], ['A renamed', 2]);
    assert.equal(s.document('tenant-b', 'overview_view', 'shared-id').name, 'B view');
    assert.equal(a.deleteWhere('1=1'), 1);
    assert.equal(s.repo('overview_view', 'tenant-b').count(), 1);
    // The binding comes first, so values go through the condition only.
    assert.throws(() => a.select('1=1', [], {columns: '?'}), /through its condition/);
    assert.throws(() => a.deleteWhere(' '), /needs a condition/);
  } finally {
    s.close();
  }
});

test('a condition that would leave the workspace binding is refused before any statement runs', () => {
  const s = store();
  try {
    s.putDocument('tenant-b', 'overview_view', 'b', {name: 'B view'});
    const a = s.repo('overview_view', 'tenant-a');
    // Regression: `1) OR (1=1` closed the binding's parenthesis and read every workspace's documents.
    for (const where of ['1) OR (1=1', '1=1)', '(1=1', '1=1; DELETE FROM documents', '1=1 -- ', '1=1 /* x */']) {
      assert.throws(() => a.select(where), /repository condition/, where);
      assert.throws(() => a.count(where), /repository condition/, where);
      assert.throws(() => a.deleteWhere(where), /repository condition/, where);
      assert.throws(() => a.updateWhere("data=json_set(data,'$.name','x')", [], where), /repository condition/, where);
    }
    assert.throws(() => a.updateWhere("data=json_set(data,'$.name','x')) OR (1", [], '1=1'), /repository assignment/);
    assert.throws(() => a.select('', [], {order: 'id) --'}), /repository order/);
    assert.throws(() => a.select('', [], {columns: "data) FROM documents; SELECT ('x"}), /repository column list/);
    assert.throws(() => a.select("json_extract(data,'$.name')='open"), /unterminated quote/);
    // Parentheses, semicolons and dashes inside quoted literals are text, not structure.
    s.putDocument('tenant-a', 'overview_view', 'a', {name: "a (b); c -- d's"});
    assert.deepEqual(
      a.select("json_extract(data,'$.name')='a (b); c -- d''s'").map(d => d.id),
      ['a'],
    );
    assert.equal(s.repo('overview_view', 'tenant-b').count(), 1, 'nothing reached the other workspace');
    assert.equal(s.document('tenant-b', 'overview_view', 'b').name, 'B view');
  } finally {
    s.close();
  }
});

test('the typed repository operations stay in their workspace and kind and apply each kind’s declared expiry', () => {
  const s = store(),
    now = Date.now();
  try {
    for (const t of tenants) {
      s.putDocument(t, 'allocation_preview', 'past', {expires_at: now - 1});
      s.putDocument(t, 'allocation_preview', 'now', {expires_at: now});
      s.putDocument(t, 'allocation_preview', 'future', {expires_at: now + 1});
      s.putDocument(t, 'gtm_consent_preview', 'now', {expires_at: now});
      s.putDocument(t, 'recipe_eligibility', 'no-deadline', {user_id: 'u'});
      s.putDocument(t, 'x_catalog_removal_preview', 'bound', {expires_at: now - 1, plan_id: 'plan-1'});
      s.putDocument(t, 'x_catalog_removal_preview', 'loose', {expires_at: now - 1});
    }
    const a = kind => s.repo(kind, 'tenant-a');
    // allocation_preview is strict: deleted once its deadline has passed, not when the clock reaches it.
    assert.equal(a('allocation_preview').purgeExpired(now), 1);
    assert.deepEqual(
      a('allocation_preview')
        .list()
        .map(d => d.id),
      ['future', 'now'],
    );
    // gtm_consent_preview is deleted when the clock reaches its deadline.
    assert.equal(a('gtm_consent_preview').purgeExpired(now), 1);
    // A recipe eligibility check without a deadline counts as expired.
    assert.equal(a('recipe_eligibility').purgeExpired(now), 1);
    // An X removal preview bound to a plan is kept past its deadline, and counts as no current preview.
    assert.equal(a('x_catalog_removal_preview').purgeExpired(now), 1);
    assert.deepEqual(
      a('x_catalog_removal_preview')
        .list()
        .map(d => d.id),
      ['bound'],
    );
    assert.equal(a('x_catalog_removal_preview').countUnexpired(now), 0);
    assert.equal(a('x_catalog_removal_preview').countUnexpired(now - 2), 1);
    const counts = {allocation_preview: 3, gtm_consent_preview: 1, recipe_eligibility: 1, x_catalog_removal_preview: 2};
    for (const [kind, n] of Object.entries(counts)) assert.equal(s.repo(kind, 'tenant-b').count(), n, kind);
    // An expiry another sweep applies (the media cleanup, the maintenance timer) is not the owner module's to run.
    assert.throws(() => a('media_review').purgeExpired(now), /no expiry its owner module applies/);
    assert.throws(() => a('x_report_run').purgeExpired(now), /no expiry its owner module applies/);
    // keepNewest keeps the newest of one person's documents, in this workspace only.
    for (let i = 0; i < 4; i++)
      s.putDocument('tenant-a', 'recipe_eligibility', 'r' + i, {user_id: 'u', saved_at: i, expires_at: now + 9});
    s.putDocument('tenant-a', 'recipe_eligibility', 'other-person', {user_id: 'v', saved_at: 0, expires_at: now + 9});
    s.putDocument('tenant-b', 'recipe_eligibility', 'r0', {user_id: 'u', saved_at: 0, expires_at: now + 9});
    assert.equal(a('recipe_eligibility').keepNewest('user_id', 'u', 'saved_at', 2), 2);
    assert.deepEqual(
      a('recipe_eligibility')
        .list()
        .map(d => d.id),
      ['other-person', 'r2', 'r3'],
    );
    assert.equal(s.repo('recipe_eligibility', 'tenant-b').count(), 2);
    // Reads by id, by field and the newest by a clock field never return another workspace's documents.
    s.putDocument('tenant-b', 'backup_receipt', 'b-new', {verified_at: now + 100});
    s.putDocument('tenant-a', 'backup_receipt', 'a-old', {verified_at: 1});
    s.putDocument('tenant-a', 'backup_receipt', 'a-new', {verified_at: 2});
    assert.equal(a('backup_receipt').newest('verified_at').verified_at, 2);
    assert.equal(s.repo('backup_receipt', 'tenant-b').newest('verified_at').verified_at, now + 100);
    assert.equal(s.repo('service_timings', 'tenant-b').newest('at'), undefined);
    assert.deepEqual(a('backup_receipt').payload('a-old'), {verified_at: 1});
    assert.equal(a('backup_receipt').payload('b-new'), undefined);
    assert.equal(a('backup_receipt').text('a-new'), '{"verified_at":2}');
    assert.deepEqual(
      a('backup_receipt')
        .texts(['a-new', 'b-new'])
        .map(r => r.id),
      ['a-new'],
    );
    assert.deepEqual(a('backup_receipt').texts([]), []);
    assert.deepEqual(
      a('recipe_eligibility')
        .findBy('user_id', 'u')
        .map(d => d.id),
      ['r2', 'r3'],
    );
    assert.equal(a('recipe_eligibility').deleteBy('user_id', 'u'), 2);
    assert.equal(s.repo('recipe_eligibility', 'tenant-b').findBy('user_id', 'u').length, 2);
    // Field names are validated, never spliced into the statement as given.
    for (const field of ["user_id') OR 1=1 --", '$.user_id', 'a..b', ''])
      assert.throws(() => a('recipe_eligibility').findBy(field, 'u'), /Invalid document field/);
  } finally {
    s.close();
  }
});

test('service documents have an explicit scope and partition that no workspace can open or become', () => {
  const s = store();
  try {
    const heartbeats = s.serviceRepo('worker_heartbeat');
    assert.equal(heartbeats.tenant, servicePartitions.limits);
    heartbeats.put('worker-1', {at: 1000, state: 'idle'});
    assert.equal(s.document(servicePartitions.limits, 'worker_heartbeat', 'worker-1').state, 'idle');
    assert.equal(s.serviceRepo('storage_volume').tenant, servicePartitions.system);
    // A workspace kind needs a workspace, a service kind needs the service, and a partition is never a workspace.
    assert.throws(() => s.repo('worker_heartbeat', 'tenant-a'), /belongs to the service/);
    assert.throws(() => s.serviceRepo('overview_report'), /belongs to a workspace/);
    for (const reserved of Object.values(servicePartitions)) {
      assert.ok(isServicePartition(reserved));
      assert.throws(() => s.repo('overview_report', reserved), /needs a workspace id/);
      // A coded refusal (an operator's id reaches it through tools/admin.ts), not an internal error.
      assert.throws(() => s.ensureTenant(reserved), {
        code: 'INVALID_TENANT',
        message: 'This workspace ID is reserved for AMCP service records. Choose another workspace ID.',
      });
    }
    assert.throws(() => s.repo('overview_report', ''), /needs a workspace id/);
    assert.throws(() => s.repo('no_such_kind', 'tenant-a'), /Undeclared document kind/);
    assert.deepEqual(s.listTenants(), tenants);
    assert.equal(s.repo('overview_report', 'tenant-a').count(), 0);
  } finally {
    s.close();
  }
});

test('a repository write keeps the store contract its retention and erasure rely on', () => {
  const s = store();
  try {
    const reports = s.repo('overview_report', 'tenant-a');
    // Without created_at the report retention could never delete the snapshot.
    assert.throws(() => reports.put('r1', {state: 'complete'}), /overview_report\.created_at is required/);
    assert.throws(() => reports.put('r1', {state: 'complete', created_at: '2026'}), /must be number, not string/);
    assert.equal(reports.count(), 0);
    assert.deepEqual(reports.put('r1', {state: 'complete', created_at: 1}), {id: 'r1', revision: 1});
    assert.deepEqual(documentProblems('overview_report', {state: 'queued', created_at: 2.5}), []);
    assert.deepEqual(documentProblems('report_incident', {}), []);
    assert.deepEqual(documentProblems('retention_policy', {days: 1.5}), [
      'retention_policy.days must be integer, not number.',
    ]);
    assert.deepEqual(documentProblems('access_set', []), ['access_set documents are JSON objects.']);
  } finally {
    s.close();
  }
});

test('erasure, backup and expiry conditions come from the declarations', () => {
  const person = personDocumentsCondition('user-1', 'hash-1');
  // The tasks of the MCP tasks extension (mcp_task, V2-MCP-02) belong to a person: their owner is the first group.
  // Package r25-admin-email: member_grant (how AMCP_ADMIN_EMAIL made a member's role) is a person's document too, by id, so account
  // erasure deletes it in every workspace; it joins member_access_set's group and adds no parameter.
  assert.equal(
    person.where,
    "(kind IN ('mcp_task') AND json_extract(data,'$.owner_user_id')=?) OR (kind IN ('member_access_set','member_grant') AND id=?) OR (kind IN ('monitor_notice','monitor_subscription') AND json_extract(data,'$.user_id')=?) OR (kind IN ('workspace_invite') AND json_extract(data,'$.emailHash')=?)",
  );
  assert.deepEqual(person.params, ['user-1', 'user-1', 'user-1', 'hash-1']);
  assert.equal(
    backupExcludedCondition(),
    "kind IN ('media_source','media_variant','upload_session') OR (kind='retained_media_source' AND json_extract(data,'$.origin')='upload')",
  );
  // The sweeps come in the order their first kind appears among the kinds by name: the tasks of the MCP tasks extension
  // (mcp_task, V2-MCP-02) expire by the maintenance timer, and sort before the service limits, so their group is first.
  assert.deepEqual(
    maintenanceSweeps().map(s => [s.kinds, s.sql]),
    [
      [
        ['mcp_task', 'tiktok_report_run', 'x_report_result', 'x_report_run'],
        "DELETE FROM documents WHERE kind IN ('mcp_task','tiktok_report_run','x_report_result','x_report_run') AND json_extract(data,'$.expires_at')<=?",
      ],
      [
        ['provider_budget', 'tiktok_report_quota', 'worker_heartbeat'],
        "DELETE FROM documents WHERE tenant_id='__service_limits__' AND kind IN ('provider_budget','tiktok_report_quota','worker_heartbeat') AND coalesce(json_extract(data,'$.at'),0)<?",
      ],
    ],
  );
});

test("the maintenance timer deletes the kinds the registry gives it once past each kind's deadline, and keeps the rest", () => {
  const s = store(),
    now = Date.now(),
    day = 86400000;
  try {
    const expiring = [],
      periodic = [];
    for (const kind of documentKinds())
      if (kind.retention.by === 'maintenance' && kind.retention.rule === 'expires') expiring.push(kind);
      else if (kind.retention.by === 'maintenance' && kind.retention.rule === 'period') periodic.push(kind);
    assert.ok(expiring.length && periodic.length);
    for (const kind of expiring)
      for (const t of tenants) {
        s.putDocument(t, kind.name, 'past', {[kind.retention.field]: now - 1});
        s.putDocument(t, kind.name, 'future', {[kind.retention.field]: now + 10 * 60000});
        // Without a deadline the document is kept, as before the registry.
        s.putDocument(t, kind.name, 'no-deadline', {});
      }
    for (const kind of periodic) {
      const field = kind.retention.from.replace(/^\$\./, ''),
        partition = servicePartitions[kind.partition];
      s.putDocument(partition, kind.name, 'old', {[field]: now - kind.retention.days * day - 60000});
      s.putDocument(partition, kind.name, 'recent', {[field]: now});
      // Without its clock a document counts as old; a workspace document of the kind is not the service's.
      s.putDocument(partition, kind.name, 'no-clock', {});
      s.putDocument('tenant-a', kind.name, 'stray', {[field]: 1});
    }
    s.cleanupTransient();
    for (const kind of expiring)
      for (const t of tenants)
        assert.deepEqual(
          s.documents(t, kind.name).map(d => d.id),
          ['future', 'no-deadline'],
          kind.name + ' in ' + t,
        );
    for (const kind of periodic) {
      assert.deepEqual(
        s.documents(servicePartitions[kind.partition], kind.name).map(d => d.id),
        ['recent'],
        kind.name,
      );
      assert.deepEqual(
        s.documents('tenant-a', kind.name).map(d => d.id),
        ['stray'],
      );
    }
  } finally {
    s.close();
  }
});

test('an encrypted backup restores every registered kind except those the registry leaves out of backups', async () => {
  const key = Buffer.alloc(32, 37).toString('base64'),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-document-registry-')),
    s = new Store(':memory:', key),
    future = Date.now() + 86400000;
  // A payload that keeps the kind's store contract, with clocks in the future so no sweep removes it first.
  const payload = (kind, extra = {}) => {
    const out = {marker: kind.name, ...extra};
    for (const [declared, type] of Object.entries(kind.fields))
      if (!declared.endsWith('?') && !(declared in out))
        out[declared] =
          type === 'string'
            ? 'synthetic'
            : type === 'number' || type === 'integer'
              ? future
              : type === 'boolean'
                ? false
                : type === 'object'
                  ? {}
                  : [];
    return out;
  };
  try {
    s.ensureTenant('tenant-a');
    const written = [];
    for (const kind of documentKinds()) {
      const tenant = kind.scope === 'service' ? servicePartitions[kind.partition] : 'tenant-a',
        variants =
          kind.backup === 'excluded_upload_origin'
            ? [
                ['upload', {origin: 'upload', created_at: future}],
                ['provider', {origin: 'provider', created_at: future}],
              ]
            : [['doc', {}]];
      for (const [suffix, extra] of variants) {
        const id = kind.name + '-' + suffix,
          data = payload(kind, extra);
        assert.deepEqual(documentProblems(kind.name, data), [], kind.name);
        s.putDocument(tenant, kind.name, id, data);
        written.push({
          tenant,
          kind: kind.name,
          id,
          data,
          excluded: kind.backup === 'excluded' || (kind.backup === 'excluded_upload_origin' && suffix === 'upload'),
        });
      }
    }
    const archive = path.join(dir, 'registry.amcp'),
      target = path.join(dir, 'restored.sqlite');
    await createEncryptedBackup(s, archive, key);
    await restoreEncryptedBackup(archive, target, key);
    const restored = new Store(target, key);
    try {
      for (const w of written) {
        const row = restored
          .sql()
          .prepare('SELECT data FROM documents WHERE tenant_id=? AND kind=? AND id=?')
          .get(w.tenant, w.kind, w.id);
        if (w.excluded) assert.equal(row, undefined, w.kind + ' is left out of backups');
        else assert.deepEqual(JSON.parse(row?.data ?? 'null'), w.data, w.kind + ' is restored unchanged');
      }
      assert.ok(written.some(w => w.excluded) && written.some(w => !w.excluded));
      assert.equal(restored.verifyAudit(), true);
    } finally {
      restored.close();
    }
  } finally {
    s.close();
    removeTestDirectory(dir, 'amcp-document-registry-');
  }
});

test('the report cleanup deletes exactly the kinds the registry gives a report retention, in its order, one workspace at a time', () => {
  assert.deepEqual(reportSweepKinds(), reportRetentionDocumentKinds());
  assert.deepEqual(reportRetentionKinds, [
    ...reportRetentionDocumentKinds(),
    ...reportRetentionJobKinds.map(k => 'job:' + k),
  ]);
  // Children follow their snapshot in the order, so a snapshot deleted in the same pass takes them along.
  const order = reportRetentionDocumentKinds();
  for (const kind of documentKinds())
    if (kind.retention.rule === 'with_parent' && kind.retention.by === 'report_cleanup')
      assert.ok(order.indexOf(kind.name) > order.indexOf(kind.retention.parent), kind.name);
  const s = store();
  try {
    const old = Date.now() - 400 * 86400000;
    for (const t of tenants) {
      s.putDocument(t, 'overview_report', 'r', {state: 'complete', created_at: old});
      s.putDocument(t, 'report_presentation', 'r', {title: 'presentation'});
      s.putDocument(t, 'decision_report', 'd', {captured_at: old});
    }
    const counts = s.transaction(() => applyReportRetention(s, 'tenant-a', Date.now()));
    assert.deepEqual(counts, {decision_report: 1, overview_report: 1, report_presentation: 1});
    for (const kind of ['overview_report', 'report_presentation', 'decision_report']) {
      assert.equal(s.documents('tenant-a', kind).length, 0, kind);
      assert.equal(s.documents('tenant-b', kind).length, 1, kind + ' of the other workspace is kept');
    }
  } finally {
    s.close();
  }
});

test("erasure follows the registry's person kinds into other workspaces: the membership's client access set goes too (regression: it outlived the erased membership)", () => {
  const master = Buffer.alloc(32, 91).toString('base64'),
    s = new Store(':memory:', master);
  try {
    const web = new WebStore(s, {
        origin: 'https://amcp.example.test',
        masterKey: master,
        adminPassword: 'synthetic-registry-admin-door',
        authEnv: {},
        fetcher: async () => {
          throw Error('No provider or e-mail traffic allowed');
        },
      }),
      accounts = new UserAccounts(web),
      erased = accounts.newUser('Erased Member', 'erased.member@example.test', null, true),
      kept = accounts.newUser('Kept Owner', 'kept.owner@example.test', null, true),
      K = String(kept.tenant_id);
    s.sql()
      .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'operator',?)")
      .run(K, erased.id, Date.now());
    s.putDocument(K, 'access_set', 'set-1', {name: 'Client one', bindings: []});
    s.putDocument(K, 'member_access_set', erased.id, {access_set_id: 'set-1'});
    s.putDocument(K, 'member_access_set', 'other-member', {access_set_id: 'set-1'});
    const options = {deploymentTenant: 'local', reason: 'operator_request', by: 'cli'},
      plan = eraseAccount(s, {userId: erased.id}, {...options, dryRun: true}),
      own = s.sql().prepare('SELECT count(*) AS n FROM documents WHERE tenant_id=?').get(String(erased.tenant_id)).n;
    assert.equal(plan.counts.documents, own + 1, "the plan counts the person's access set in the other workspace");
    eraseAccount(s, {userId: erased.id}, options);
    assert.equal(s.repo('member_access_set', K).find(erased.id), undefined);
    assert.equal(s.repo('member_access_set', K).get('other-member').access_set_id, 'set-1');
    assert.equal(s.repo('access_set', K).count(), 1);
    assert.equal(s.verifyAudit(), true);
  } finally {
    s.close();
  }
});

test('an erasure of a workspace without an account deletes nothing in other workspaces, even documents with an empty person field (regression: an empty user id and e-mail hash matched them)', () => {
  const s = store();
  try {
    s.ensureTenant('receipt-only');
    s.putDocument('receipt-only', 'monitor_subscription', 'own', {user_id: 'someone'});
    // Malformed person fields in another workspace: an empty user id, e-mail hash and document id.
    s.putDocument('tenant-a', 'monitor_subscription', 'blank-user', {user_id: ''});
    s.putDocument('tenant-a', 'monitor_notice', 'blank-notice', {user_id: '', created_at: 1});
    s.putDocument('tenant-a', 'workspace_invite', 'blank-invite', {emailHash: ''});
    s.putDocument('tenant-a', 'member_access_set', '', {access_set_id: 'set-1'});
    s.putDocument('tenant-a', 'mcp_task', 'blank-task', {owner_user_id: '', expires_at: 1});
    assert.deepEqual(personDocumentsCondition('', ''), {where: '', params: []});
    // The owner of an MCP task, the member of an access set and the subscriber of a monitor are the person's user id.
    assert.deepEqual(personDocumentsCondition('user-1', '').params, ['user-1', 'user-1', 'user-1']);
    const options = {deploymentTenant: 'local', reason: 'operator_request', by: 'cli'},
      plan = eraseAccount(s, {tenantId: 'receipt-only'}, {...options, dryRun: true});
    assert.equal(plan.counts.documents, 1);
    eraseAccount(s, {tenantId: 'receipt-only'}, options);
    assert.equal(s.repo('monitor_subscription', 'receipt-only').count(), 0);
    assert.equal(s.repo('monitor_subscription', 'tenant-a').count(), 1);
    assert.equal(s.repo('monitor_notice', 'tenant-a').count(), 1);
    assert.equal(s.repo('workspace_invite', 'tenant-a').count(), 1);
    assert.equal(s.repo('member_access_set', 'tenant-a').count(), 1);
    assert.equal(s.repo('mcp_task', 'tenant-a').count(), 1);
    assert.equal(s.verifyAudit(), true);
  } finally {
    s.close();
  }
});

test("erasure deletes the tasks an erased person was handed in other workspaces and keeps everyone else's (V2-MCP-02)", () => {
  const master = Buffer.alloc(32, 91).toString('base64'),
    s = new Store(':memory:', master);
  try {
    const web = new WebStore(s, {
        origin: 'https://amcp.example.test',
        masterKey: master,
        adminPassword: 'synthetic-registry-admin-door',
        authEnv: {},
        fetcher: async () => {
          throw Error('No provider or e-mail traffic allowed');
        },
      }),
      accounts = new UserAccounts(web),
      erased = accounts.newUser('Erased Member', 'erased.member@example.test', null, true),
      kept = accounts.newUser('Kept Owner', 'kept.owner@example.test', null, true),
      K = String(kept.tenant_id);
    s.sql()
      .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'operator',?)")
      .run(K, erased.id, Date.now());
    const task = owner => ({
      run: 'amcp_reporting_overview export',
      job_id: 'job',
      resource_id: 'export',
      owner_user_id: owner,
      binding: 'binding',
      created_at: Date.now(),
      expires_at: Date.now() + 86400000,
    });
    s.repo('mcp_task', K).put('task-of-erased', task(erased.id));
    s.repo('mcp_task', K).put('task-of-kept', task(kept.id));
    eraseAccount(s, {userId: erased.id}, {deploymentTenant: 'local', reason: 'operator_request', by: 'cli'});
    assert.equal(s.repo('mcp_task', K).find('task-of-erased'), undefined);
    assert.equal(s.repo('mcp_task', K).get('task-of-kept').owner_user_id, kept.id);
    assert.equal(s.verifyAudit(), true);
  } finally {
    s.close();
  }
});

test('an erasure without an account keeps keys, grants, memberships, sessions and logins of other workspaces whose person field is empty (regression: the person steps bound an empty id)', () => {
  const master = Buffer.alloc(32, 92).toString('base64'),
    s = new Store(':memory:', master);
  try {
    new WebStore(s, {
      origin: 'https://amcp.example.test',
      masterKey: master,
      adminPassword: 'synthetic-registry-admin-door',
      authEnv: {},
      fetcher: async () => {
        throw Error('No provider or e-mail traffic allowed');
      },
    });
    for (const t of ['receipt-only', 'tenant-a']) s.ensureTenant(t);
    const sql = s.sql(),
      now = Date.now();
    // The erased workspace's own key and membership go; the other workspace's rows with an empty person field stay.
    sql
      .prepare("INSERT INTO api_keys(hash,tenant_id,user_id,role) VALUES('own-key','receipt-only','someone','admin')")
      .run();
    sql.prepare("INSERT INTO api_keys(hash,tenant_id,user_id,role) VALUES('blank-key','tenant-a','','admin')").run();
    sql.prepare("INSERT INTO credential_owners(hash,user_id) VALUES('blank-key','')").run();
    sql
      .prepare(
        "INSERT INTO workspace_memberships(tenant_id,user_id,role,active,created_at) VALUES('receipt-only','someone','owner',0,?)",
      )
      .run(now);
    sql
      .prepare(
        "INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES('tenant-a','','operator',?)",
      )
      .run(now);
    sql
      .prepare(
        "INSERT INTO amcp_mcp_grants(hash,kind,client_id,tenant_id,data,expires_at) VALUES('blank-grant','access','client','tenant-a',?,?)",
      )
      .run(JSON.stringify({ownerUserId: ''}), now + 60000);
    sql
      .prepare("INSERT INTO amcp_web_sessions(hash,actor,csrf,expires_at) VALUES('blank-session',?,'csrf',?)")
      .run(JSON.stringify({tenantId: 'tenant-a', userId: ''}), now + 60000);
    sql.prepare("INSERT INTO amcp_mfa(user_id,secret,recovery,enabled_at) VALUES('','sealed','[]',?)").run(now);
    sql
      .prepare("INSERT INTO amcp_identities(provider,subject,user_id,created_at) VALUES('google','blank-subject','',?)")
      .run(now);
    const count = (table, where = '1') => sql.prepare('SELECT count(*) AS n FROM ' + table + ' WHERE ' + where).get().n,
      options = {deploymentTenant: 'local', reason: 'operator_request', by: 'cli'},
      plan = eraseAccount(s, {tenantId: 'receipt-only'}, {...options, dryRun: true});
    assert.equal(plan.user_id, null);
    for (const [table, n] of [
      ['api_keys', 1],
      ['credential_owners', 0],
      ['workspace_memberships', 1],
      ['amcp_mcp_grants', 0],
      ['amcp_web_sessions', 0],
      ['amcp_mfa', 0],
      ['amcp_identities', 0],
      ['amcp_users', 0],
    ])
      assert.equal(plan.counts[table], n, table);
    eraseAccount(s, {tenantId: 'receipt-only'}, options);
    assert.equal(count('api_keys', "hash='own-key'"), 0);
    assert.equal(count('workspace_memberships', "tenant_id='receipt-only'"), 0);
    for (const [table, where] of [
      ['api_keys', "hash='blank-key'"],
      ['credential_owners', "hash='blank-key'"],
      ['workspace_memberships', "tenant_id='tenant-a'"],
      ['amcp_mcp_grants', "hash='blank-grant'"],
      ['amcp_web_sessions', "hash='blank-session'"],
      ['amcp_mfa', "user_id=''"],
      ['amcp_identities', "subject='blank-subject'"],
    ])
      assert.equal(count(table, where), 1, table + ' of another workspace is kept');
    assert.equal(s.verifyAudit(), true);
  } finally {
    s.close();
  }
});

test('a local disconnect deletes every kind the registry declares with a connection, for that login and workspace only', () => {
  const key = Buffer.alloc(32, 29).toString('base64'),
    s = new Store(':memory:', key),
    actor = {tenantId: 'tenant-a', userId: 'admin-1', role: 'admin'},
    gone = '6f3c2a10-8f1e-4c7a-9a55-0d2c1b7e4a01',
    kept = '0c9b8a7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d';
  try {
    for (const t of tenants) s.ensureTenant(t);
    for (const id of [gone, kept])
      s.putConnection(
        actor,
        {id, tenantId: 'tenant-a', gateway: 'ga4_native_action', label: id, enabled: true, accounts: ['1'], scopes: []},
        {accessToken: 'synthetic-never-sent'},
      );
    const declared = documentKinds().filter(k => k.connection);
    assert.deepEqual(
      declared.map(k => k.name),
      [...disconnectedKinds],
      'the disconnect handles exactly the declared kinds',
    );
    const write = (tenant, kind, login, tag) => {
      const c = kind.connection,
        id = c.match === 'id' ? login : tag + '-' + login;
      const data =
        c.match === 'sources'
          ? {state: 'complete', created_at: 1, rows: [{connection_id: login}], config: {sources: []}}
          : c.match === 'field'
            ? {[c.field]: login}
            : {};
      s.putDocument(tenant, kind.name, id, data);
      return id;
    };
    const expectGone = [],
      expectKept = [];
    for (const kind of declared) {
      expectGone.push([kind.name, write('tenant-a', kind, gone, 'a')]);
      expectKept.push(['tenant-a', kind.name, write('tenant-a', kind, kept, 'a')]);
      expectKept.push(['tenant-b', kind.name, write('tenant-b', kind, gone, 'b')]);
    }
    // A snapshot that only configured the login as a source goes too; an unfinished one stays.
    s.putDocument('tenant-a', 'overview_report', 'configured', {
      state: 'partial',
      created_at: 1,
      config: {sources: [{connection_id: gone}]},
    });
    s.putDocument('tenant-a', 'overview_report', 'running', {
      state: 'running',
      created_at: 1,
      rows: [{connection_id: gone}],
    });
    const receipt = disconnectLocalConnection(s, actor, 'ga4_native_action', gone, 'website');
    assert.equal(receipt.disconnected, true);
    for (const [kind, id] of expectGone) assert.equal(s.repo(kind, 'tenant-a').has(id), false, kind + ' ' + id);
    for (const [tenant, kind, id] of expectKept) assert.equal(s.repo(kind, tenant).has(id), true, tenant + ' ' + kind);
    assert.equal(s.repo('overview_report', 'tenant-a').has('configured'), false);
    assert.equal(s.repo('overview_report', 'tenant-a').has('running'), true);
    assert.equal(receipt.local_changes.report_snapshots, 2);
    assert.equal(receipt.local_changes.discovery_documents, 2);
    assert.deepEqual(
      s.listConnections('tenant-a').map(c => c.id),
      [kept],
    );
  } finally {
    s.close();
  }
});

test('docs/DOCUMENT-KINDS.md is the reference the registry generates, with every kind and its retention', () => {
  const generated = documentKindsMarkdown();
  assert.equal(
    fs.readFileSync(documentKindsFile, 'utf8'),
    generated,
    'regenerate it: npm run build && node dist/tools/document-kinds-doc.js',
  );
  for (const kind of documentKinds()) assert.ok(generated.includes('| `' + kind.name + '` |'), kind.name);
});

test('every index and trigger on documents is declared by the kinds it serves, and the schema ledger creates it', () => {
  const s = new Store(':memory:');
  try {
    const onDocuments = s
      .sql()
      .prepare(
        "SELECT name FROM sqlite_master WHERE tbl_name='documents' AND type IN ('index','trigger') AND sql IS NOT NULL",
      )
      .all()
      .map(r => r.name)
      .sort();
    const declared = [...new Set(documentKinds().flatMap(k => k.indexes ?? []))].sort();
    assert.deepEqual(onDocuments, declared);
  } finally {
    s.close();
  }
});
