import {nativeAuthority} from './native-authority.js';
import {MirrorError} from './errors.js';
import {redact} from './security.js';
import {Store} from './store.js';
import {Registry} from './catalog.js';
import {ScopeGuard} from './scope.js';
import {CredentialProvider} from './auth.js';
import {NativeTransport} from './transport.js';
import {readGtmWorkspace, validateGtmWorkspaceState, gtmWorkspaceEntities} from './gtm-workspace-writes.js';
import {gtmSafeConfiguration} from './gtm-workflow-writes.js';
import {gtmConsentEvidence} from './gtm-consent-evidence.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {ownsRecord} from './actor-identity.js';

export const gtmDiagnosticOperations = new Set(['gtm_action_job_status', 'gtm_audit_ops']);
const gateway = 'gtm_native_action',
  prefix = '/tagmanager/v2/';
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const simple = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v);
function fail(code: string, message: string): never {
  throw new MirrorError(code, message);
}
const missing = (): never => fail('NOT_FOUND', 'No accessible Tag Manager verification job has this ID.');
function exact(row: JsonObject, path: string): void {
  if (row.path !== path) fail('STATE_TARGET_MISMATCH', 'Tag Manager returned a different resource.');
  const parts = path.split('/');
  for (const [key, value] of Object.entries({
    accountId: parts[1],
    ...(parts[2] === 'containers' ? {containerId: parts[3]} : {}),
    ...(parts[4] === 'workspaces' ? {workspaceId: parts[5]} : {}),
  }))
    if (row[key] !== undefined && row[key] !== value)
      fail('STATE_TARGET_MISMATCH', 'Tag Manager returned conflicting resource bindings.');
}
function jobStatus(store: Store, input: JsonObject, actor: Actor): JsonObject {
  const job = store.job(actor.tenantId, input.job_id);
  if (job.kind !== 'write_verification' || typeof job.input?.review_id !== 'string') missing();
  let review: JsonObject;
  try {
    review = store.document(actor.tenantId, 'write_review', job.input.review_id);
  } catch {
    return missing();
  }
  if (review.plan?.gateway !== gateway || (!ownsRecord(actor, review) && actor.role !== 'admin')) missing();
  store.resolveConnection(actor, gateway, review.plan.accountId, review.connection_id);
  let verification: JsonObject | undefined;
  try {
    verification = store.document(actor.tenantId, 'write_verification', job.input.review_id);
  } catch (e) {
    if (!(e instanceof MirrorError) || e.code !== 'NOT_FOUND') throw e;
  }
  return redact({
    source: 'AMCP verification queue',
    provider_job: false,
    job_id: job.id,
    review_id: job.input.review_id,
    connection_id: review.connection_id,
    account_id: review.plan.accountId,
    state: job.state,
    attempts: job.attempts,
    created_at: job.created_at,
    updated_at: job.updated_at,
    verification: verification ?? job.result ?? null,
    error: job.error ?? null,
    automatic_retry_of_mutation: false,
    next_call: {tool: 'amcp_campaign', arguments: {action: 'verify', review_id: job.input.review_id}},
    meaning: 'This job reads back an already submitted reviewed mutation. Polling never resubmits the mutation.',
  }) as JsonObject;
}
/** Native GETs plus local verification records. This never prepares, publishes,
 * repairs, synchronizes or acquires mutation authority on behalf of an audit. */
export async function gtmDiagnostics(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  operation: string,
  input: JsonObject,
  actor: Actor,
): Promise<JsonObject> {
  store.assertActorActive(actor);
  if (operation === 'gtm_action_job_status') return jobStatus(store, input, actor);
  if (operation !== 'gtm_audit_ops') fail('UNKNOWN_OPERATION', 'Unknown Tag Manager diagnostic.');
  for (const key of ['account_id', 'container_id', 'workspace_id'])
    if (input[key] !== undefined && !simple(input[key]))
      fail('INVALID_ARGUMENT', 'Use an exact native account, container and workspace ID.');
  if ((input.workspace_id && !input.container_id) || (input.container_id && !input.account_id))
    fail('MISSING_PARAMETER', 'Container audits require account_id; workspace audits also require container_id.');
  const connection = store.resolveConnection(actor, gateway, input.account_id, input.connection_id),
    scope = new ScopeGuard(registry, store),
    observedAccounts = new Set<string>();
  let calls = 0,
    bytes = 0;
  const plan = (path: string, accountId = path.split('/')[1]): CompiledRequest => ({
    gateway,
    accountId,
    origin: 'https://tagmanager.googleapis.com',
    action: 'AMCP_GTM_DIAGNOSTIC',
    method: 'GET',
    path: prefix + path,
    headers: {},
    query: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    evidence: 'Explicit scoped Tag Manager diagnostic GET',
    warnings: [],
  });
  let auth: Awaited<ReturnType<CredentialProvider['get']>> | undefined;
  const request = async (p: CompiledRequest) => {
    if (p.method !== 'GET' || !p.readOnly || p.origin !== 'https://tagmanager.googleapis.com')
      fail('STATE_READ_UNSAFE', 'Diagnostic requests must be scoped native GETs.');
    store.assertActorActive(actor);
    const current = store.resolveConnection(actor, gateway, p.accountId, connection.id);
    scope.authorize(p, current);
    auth ??= await credentials.get(current);
    store.assertActorActive(actor);
    scope.authorize(p, store.resolveConnection(actor, gateway, p.accountId, connection.id));
    const access = nativeAuthority(store, registry, actor, p, current, auth);
    const result = await transport.request(p, access(), auth, undefined, {beforeAttempt: access});
    access();
    calls++;
    store.assertActorActive(actor);
    scope.authorize(p, store.resolveConnection(actor, gateway, p.accountId, connection.id));
    observedAccounts.add(p.accountId!);
    if (result.status !== 200 || !obj(result.data) || result.data.error)
      fail('STATE_READ_FAILED', 'Diagnostic read did not return a successful native object.');
    bytes += Buffer.byteLength(JSON.stringify(result.data));
    if (bytes > 16 * 1024 * 1024) fail('STATE_TOO_LARGE', 'Diagnostic read exceeded its 16 MiB bound.');
    return result;
  };
  const get = async (path: string, optional = false): Promise<JsonObject | null> => {
    try {
      return (await request(plan(path))).data as JsonObject;
    } catch (e) {
      if (optional && e instanceof MirrorError && e.code === 'UPSTREAM_ERROR' && e.status === 404) return null;
      throw e;
    }
  };
  const list = async (path: string, key: string, headers = false) => {
    const rows: JsonObject[] = [],
      seen = new Set<string>(),
      tokens = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const p = plan(path);
      p.query = cursor ? {pageToken: cursor} : {};
      const d = (await request(p)).data as JsonObject;
      if (
        Object.keys(d).some(k => ![key, 'nextPageToken', 'requestId'].includes(k)) ||
        !Array.isArray(d[key] ?? []) ||
        (d.nextPageToken !== undefined && typeof d.nextPageToken !== 'string')
      )
        fail('STATE_READ_FAILED', 'Unrecognized diagnostic collection response.');
      for (const row of d[key] ?? []) {
        if (!obj(row) || typeof row.path !== 'string' || seen.has(row.path))
          fail('STATE_TARGET_MISMATCH', 'Duplicate or missing diagnostic resource identity.');
        if (headers) {
          const base = path.replace(/\/version_headers$/, '');
          if (
            !simple(row.containerVersionId) ||
            !['/versions/', '/version_headers/'].some(k => row.path === base + k + row.containerVersionId)
          )
            fail('STATE_TARGET_MISMATCH', 'Version header belongs to another container.');
        } else if (!row.path.startsWith(path + '/') || !simple(row.path.slice(path.length + 1)))
          fail('STATE_TARGET_MISMATCH', 'Diagnostic collection returned a foreign resource.');
        exact(row, row.path);
        const identity = headers ? row.containerVersionId : row.path;
        if (seen.has(identity)) fail('STATE_TARGET_MISMATCH', 'Duplicate version header identity.');
        seen.add(identity);
        rows.push(row);
        if (rows.length > 1000) fail('STATE_TOO_LARGE', 'Diagnostic collections support up to 1000 entries.');
      }
      if (!d.nextPageToken) return rows;
      if (page === 99 || tokens.has(d.nextPageToken))
        fail('INCOMPLETE_STATE', 'Diagnostic pagination did not complete.');
      cursor = d.nextPageToken;
      tokens.add(cursor!);
    }
    return rows;
  };
  const findings: JsonObject[] = [];
  let findingCount = 0;
  const finding = (
    severity: string,
    code: string,
    path: string,
    message: string,
    message_localization?: JsonObject,
  ) => {
    findingCount++;
    if (findings.length < 1000)
      findings.push({severity, code, path, message, ...(message_localization ? {message_localization} : {})});
  };
  const result: JsonObject = {
    source: 'AMCP scoped native Tag Manager reads',
    provider_mutations: 0,
    connection_id: connection.id,
    account_id: input.account_id ?? null,
    complete: true,
    publish_ready: null,
    findings,
    limitations: [
      'Read-only configuration observations; no compiler, browser execution, consent or live tag-delivery qualification.',
      'References absent from the workspace inventory may include provider-managed system triggers; unknown is not passed.',
    ],
  };
  const finish = () => {
    store.assertActorActive(actor);
    for (const id of observedAccounts) store.resolveConnection(actor, gateway, id, connection.id);
    result.network_requests = calls;
    result.checked_at = new Date().toISOString();
    result.finding_count = findingCount;
    result.findings_truncated = findingCount > findings.length;
    if (result.findings_truncated) result.complete = false;
    result.configuration_findings = result.findings_truncated
      ? 'incomplete'
      : findingCount
        ? 'attention'
        : 'none_found';
    return redact(gtmSafeConfiguration(result)) as JsonObject;
  };
  if (!input.account_id) {
    if (connection.accounts.length > 100)
      fail('STATE_TOO_LARGE', 'Choose one account_id when the connection has more than 100 granted accounts.');
    const accounts: JsonObject[] = [];
    for (const id of connection.accounts) {
      const row = (await get('accounts/' + id))!;
      exact(row, 'accounts/' + id);
      accounts.push(input.include_resources ? row : {account_id: id, name: row.name ?? null});
    }
    result.accounts = accounts;
    result.coverage =
      'Current accounts granted to this exact connection; not every account visible to the Google login.';
    return finish();
  }
  const account = 'accounts/' + input.account_id,
    accountRow = (await get(account))!;
  exact(accountRow, account);
  if (!input.container_id) {
    const containers = await list(account + '/containers', 'container');
    result.counts = {containers: containers.length};
    result.containers = containers.map(c =>
      input.include_resources
        ? c
        : {container_id: c.containerId ?? c.path.split('/').at(-1), name: c.name ?? null, path: c.path},
    );
    return finish();
  }
  const container = account + '/containers/' + input.container_id,
    containerRow = (await get(container))!;
  exact(containerRow, container);
  result.container = {path: container, name: containerRow.name ?? null};
  if (!input.workspace_id) {
    const workspaces = await list(container + '/workspaces', 'workspace');
    result.counts = {workspaces: workspaces.length};
    result.workspaces = workspaces.map(r =>
      input.include_resources
        ? r
        : {workspace_id: r.workspaceId ?? r.path.split('/').at(-1), name: r.name ?? null, path: r.path},
    );
  } else {
    const w = container + '/workspaces/' + input.workspace_id,
      p = {...plan(w), gtmWorkspaceState: {latest: input.include_versions !== false}};
    const response = await readGtmWorkspace(p, request);
    validateGtmWorkspaceState(p, response);
    const snapshot = response.data as JsonObject,
      entities = snapshot.entities;
    result.workspace = {path: w, name: snapshot.workspace.name ?? null};
    result.counts = Object.fromEntries(Object.entries(entities).map(([k, v]) => [k, Object.keys(v as object).length]));
    result.status = input.include_resources
      ? snapshot.status
      : {
          workspace_changes: snapshot.status.workspaceChange.length,
          merge_conflicts: snapshot.status.mergeConflict.length,
        };
    result.latest_version_id = snapshot.latestVersionId;
    result.consent_evidence = gtmConsentEvidence(snapshot.workspace, Object.values(entities.tag));
    for (const tag of result.consent_evidence.rows)
      if (tag.setting === 'unknown')
        finding(
          'unknown',
          'CONSENT_CONFIGURATION_UNINTERPRETABLE',
          tag.path,
          'The additional consent configuration could not be interpreted. Inspect the tag settings before drawing a runtime conclusion.',
        );
    if (input.include_resources) result.resources = entities;
    for (const conflict of snapshot.status.mergeConflict) {
      const entity = conflict.entityInWorkspace,
        key = Object.keys(entity).find(k => k !== 'changeStatus')!;
      finding(
        'error',
        'MERGE_CONFLICT',
        entity[key].path,
        'Resolve this conflict in a separately reviewed request before version creation.',
      );
    }
    const variableNames = new Set(
      [...Object.values(entities.variable), ...Object.values(entities.builtInVariable)]
        .map((r: any) => r.name)
        .filter((n: unknown) => typeof n === 'string'),
    );
    for (const [kind, model] of Object.entries(gtmWorkspaceEntities)) {
      const names = new Map<string, string>();
      for (const row of Object.values(entities[kind]) as JsonObject[]) {
        if (typeof row.name === 'string') {
          if (names.has(row.name))
            finding(
              'warning',
              'DUPLICATE_NAME',
              row.path,
              'Another ' + kind + ' has this same name; choose IDs explicitly.',
              {key: 'duplicate_name', kind},
            );
          else names.set(row.name, row.path);
        }
        if (row.parentFolderId && row.parentFolderId !== '0' && !entities.folder[row.parentFolderId])
          finding(
            'error',
            'UNRESOLVED_FOLDER',
            row.path,
            'The parent folder is absent from the complete workspace inventory.',
          );
        for (const key of ['firingTriggerId', 'blockingTriggerId', 'enablingTriggerId', 'disablingTriggerId']) {
          const ids = row[key] ?? [];
          if (!Array.isArray(ids) || ids.some(id => !simple(id)))
            fail('STATE_READ_FAILED', 'Diagnostic trigger references must be native ID arrays.');
          for (const id of ids)
            if (!entities.trigger[id])
              finding(
                'unknown',
                'UNRESOLVED_OR_SYSTEM_TRIGGER',
                row.path,
                'Trigger ' +
                  id +
                  ' is not in the workspace inventory; resolve whether it is provider-managed or missing before publishing.',
                {key: 'unresolved_trigger', trigger_id: id},
              );
        }
        const visit = (v: unknown) => {
          if (Array.isArray(v)) {
            v.forEach(visit);
            return;
          }
          if (!obj(v)) return;
          if (v.type === 'template' && typeof v.value === 'string')
            for (const m of v.value.matchAll(/\{\{([^{}]{1,256})\}\}/g))
              if (!variableNames.has(m[1]!))
                finding(
                  'warning',
                  'UNRESOLVED_VARIABLE',
                  row.path,
                  'A template parameter references a variable name absent from this workspace inventory.',
                );
          Object.values(v).forEach(visit);
        };
        visit(row);
        if (kind === 'tag' && !row.paused && !(row.firingTriggerId ?? []).length)
          finding(
            'warning',
            'NO_FIRING_TRIGGER',
            row.path,
            'This unpaused tag has no explicit firing trigger; confirm whether tag sequencing invokes it.',
          );
        if (row[model.id] === undefined) fail('STATE_TARGET_MISMATCH', 'Diagnostic entity is missing its identity.');
      }
    }
  }
  if (input.include_versions !== false) {
    const headers = await list(container + '/version_headers', 'containerVersionHeader', true),
      latest = await get(container + '/version_headers:latest', true),
      live = await get(container + '/versions:live', true);
    for (const [label, row] of [
      ['latest', latest],
      ['live', live],
    ] as [string, JsonObject | null][]) {
      if (!row) {
        finding(
          'warning',
          label === 'live' ? 'NO_LIVE_VERSION' : 'NO_LATEST_VERSION',
          container,
          'No ' + label + ' version was returned (scoped 404).',
          {key: 'missing_version', version: label},
        );
        continue;
      }
      if (
        !simple(row.containerVersionId) ||
        !['/versions/', '/version_headers/'].some(k => row.path === container + k + row.containerVersionId)
      )
        fail('STATE_TARGET_MISMATCH', 'Version read belongs to another container.');
      exact(row, row.path);
    }
    result.versions = {
      count: headers.length,
      latest: latest ? {id: latest.containerVersionId, path: latest.path} : null,
      live: live ? {id: live.containerVersionId, path: live.path} : null,
      ...(input.include_resources ? {headers} : {}),
      consistent_with_workspace:
        result.latest_version_id === undefined
          ? null
          : result.latest_version_id === (latest?.containerVersionId ?? null),
    };
    if (result.versions.consistent_with_workspace === false) {
      result.complete = false;
      finding(
        'unknown',
        'VERSION_CHANGED_DURING_AUDIT',
        container,
        'Latest version changed during the audit. Read a fresh snapshot before reviewing a mutation.',
      );
    }
  }
  return finish();
}
