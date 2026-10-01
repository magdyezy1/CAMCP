import {operationsHealth} from './operations-health.js';
import {linkedinVersion} from './linkedin-version.js';
import {Store} from './store.js';
import {MirrorError} from './errors.js';
import {policyWarnings, unprotectedAccounts} from './spend-policy.js';
import {budgetUnits} from './budget-units.js';
import {mediaLimitProblem} from './drive-media.js';
import type {Actor, JsonObject} from './types.js';
import {ownerAccess, saveSpendPolicy, workspaceOwner} from './spend-policy.js';
import {googleAdsVersion} from './google-version.js';
import {metaApiVersion} from './meta-version.js';
import {disablePersonalData, enablePersonalData, personalDataAccounts} from './personal-data-access.js';
const writePauseId = 'workspace';
/** The owner's pause of every reviewed write of a workspace, or undefined when writes are not paused. */
export function writePause(store: Store, tenant: string): JsonObject | undefined {
  const row = store.db
    .prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='write_pause' AND id=?")
    .get(tenant, writePauseId) as {data: string} | undefined;
  return row ? JSON.parse(row.data) : undefined;
}
/** Refuses an execution while an owner has paused writes. Nothing reaches a provider after this refusal. */
export function assertWritesNotPaused(store: Store, tenant: string): void {
  const pause = writePause(store, tenant);
  if (pause)
    throw new MirrorError(
      'WRITES_PAUSED',
      'An owner paused every reviewed write of this workspace: ' +
        pause.reason +
        '. Nothing was submitted; ask an owner to resume writes.',
      {paused_at: pause.paused_at, paused_by: pause.paused_by},
      423,
    );
}
/**
 * Health for an administrator who does not own the workspace (Snapchat S7): whether each connection works and how
 * deep each job queue is. No labels, policies, e-mail, storage or backups; those stay the owner's.
 */
function administratorHealth(store: Store, tenant: string): JsonObject {
  return {
    scope: 'administrator',
    at: Date.now(),
    connections: store.listConnections(tenant).map(c => {
      const expires = store.credentials(tenant, c.id).expiresAt;
      return {
        id: c.id,
        gateway: c.gateway,
        enabled: c.enabled,
        account_count: c.accounts.length,
        needs_attention: !!expires && expires < Date.now() + 86400000,
      };
    }),
    jobs: store.db
      .prepare('SELECT kind,state,count(*) AS count FROM jobs WHERE tenant_id=? GROUP BY kind,state')
      .all(tenant),
    writes_paused: !!writePause(store, tenant),
    owner_view: 'Policies, e-mail delivery, storage, backups and API versions are in the owner’s health view.',
  };
}
export function ownerOperations(store: Store, input: JsonObject, actor: Actor): JsonObject {
  store.assertActorActive(actor);
  if (
    input.action === 'health' &&
    actor.testAccount !== true &&
    actor.role === 'admin' &&
    !workspaceOwner(store, actor)
  )
    return administratorHealth(store, actor.tenantId);
  ownerAccess(store, actor, String(input.action));
  const tenant = actor.tenantId;
  if (input.action === 'save_spend_policy') return saveSpendPolicy(store, actor, input);
  if (input.action === 'support_bundle') return operationsHealth(store, tenant);
  if (input.action === 'health') {
    const exists = (name: string) =>
        !!store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name),
      jobs = store.db
        .prepare(
          'SELECT kind,state,count(*) AS count,min(available_at) AS oldest_due,max(updated_at) AS last_update FROM jobs WHERE tenant_id=? GROUP BY kind,state',
        )
        .all(tenant),
      connections = store.listConnections(tenant).map(c => {
        const credentials = store.credentials(tenant, c.id);
        return {
          id: c.id,
          name: c.label,
          gateway: c.gateway,
          enabled: c.enabled,
          account_count: c.accounts.length,
          write_account_count: c.writeAccounts?.length ?? 0,
          expires_at: credentials.expiresAt ?? null,
          needs_attention: !!credentials.expiresAt && credentials.expiresAt < Date.now() + 86400000,
          refresh_available: !!credentials.refreshToken,
        };
      });
    return {
      operations: operationsHealth(store, tenant),
      at: Date.now(),
      connections,
      jobs,
      email: exists('amcp_email_outbox')
        ? store.db
            .prepare(
              'SELECT state,count(*) AS count,min(available_at) AS next_attempt FROM amcp_email_outbox WHERE tenant_id=? GROUP BY state',
            )
            .all(tenant)
        : [],
      policies: store.documents(tenant, 'spend_policy'),
      unprotected_accounts: unprotectedAccounts(store, actor),
      policy_warnings: policyWarnings(store, tenant),
      budget_units: budgetUnits,
      configuration_problems: [mediaLimitProblem].filter(Boolean),
      retention: store.documents(tenant, 'retention_policy')[0] ?? null,
      write_pause: writePause(store, tenant) ?? null,
      personal_data_accounts: personalDataAccounts(store, tenant),
      storage: {
        database_bytes:
          Number((store.db.prepare('PRAGMA page_count').get() as JsonObject).page_count) *
          Number((store.db.prepare('PRAGMA page_size').get() as JsonObject).page_size),
        report_rows: (
          store.db
            .prepare(
              "SELECT coalesce(sum(json_array_length(data,'$.rows')),0) AS n FROM documents WHERE tenant_id=? AND kind='overview_report'",
            )
            .get(tenant) as JsonObject
        ).n,
      },
      limits: {
        active_reports: 100,
        saved_views: 100,
        schedules: 50,
        accounts_per_report: 30,
        rows_per_source: 10000,
        sheets_cells: 200000,
        media_reviews_per_workspace: 2,
      },
      backup: store.documents(tenant, 'backup_receipt').at(-1) ?? {
        status: 'not_verified',
        message:
          'No verified backup receipt has been recorded. Use the encrypted backup command and test restoration before relying on recovery.',
      },
      api_versions: {
        google: googleAdsVersion,
        meta: metaApiVersion,
        tiktok: 'v1.3',
        snapchat: 'v1',
        linkedin: (() => {
          try {
            return linkedinVersion();
          } catch {
            return 'invalid AMCP_LINKEDIN_API_VERSION';
          }
        })(),
        x: 'v12',
        microsoft: 'v13',
        apple: 'v1',
      },
    };
  }
  if (input.action === 'enable_personal_data') return enablePersonalData(store, actor, input);
  if (input.action === 'disable_personal_data') return disablePersonalData(store, actor, input);
  if (input.action === 'pause_writes') {
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (input.confirmed !== true || !reason || reason.length > 500)
      throw new MirrorError(
        'INVALID_ARGUMENT',
        'Give a reason of at most 500 characters and confirmed=true to pause every reviewed write of this workspace.',
      );
    const pause = {paused: true, reason, paused_by: actor.userId, paused_at: Date.now()};
    store.putDocument(tenant, 'write_pause', writePauseId, pause);
    store.appendAudit(tenant, 'write_pause/' + writePauseId, {event: 'writes_paused', reason, by: actor.userId});
    return {
      ...pause,
      effect:
        'Every amcp_write and amcp_media execute of this workspace is refused with WRITES_PAUSED until an owner resumes writes. Reads, prepares and verification continue.',
    };
  }
  if (input.action === 'resume_writes') {
    if (input.confirmed !== true)
      throw new MirrorError('INVALID_ARGUMENT', 'Provide confirmed=true to resume reviewed writes.');
    const was = writePause(store, tenant);
    store.transaction(() => {
      store.db
        .prepare("DELETE FROM documents WHERE tenant_id=? AND kind='write_pause' AND id=?")
        .run(tenant, writePauseId);
    });
    store.appendAudit(tenant, 'write_pause/' + writePauseId, {event: 'writes_resumed', by: actor.userId});
    return {
      paused: false,
      was_paused: !!was,
      effect:
        'Reviewed writes run again under every other control. Reviews prepared before the pause expire after five minutes as usual.',
    };
  }
  if (input.action === 'save_retention') {
    if (input.confirmed !== true || !Number.isInteger(input.days) || input.days < 7 || input.days > 365)
      throw new MirrorError('INVALID_RETENTION', 'Confirm a report retention period of 7–365 days.');
    store.putDocument(tenant, 'retention_policy', 'reports', {
      days: input.days,
      updated_at: Date.now(),
      updated_by: actor.userId,
    });
    return {
      days: input.days,
      scope:
        'Finished Overview snapshots, captured analysis reports, resolved monitoring incidents and finished report jobs; active jobs, open or acknowledged incidents, audit records and write receipts are preserved.',
    };
  }
  throw new MirrorError('INVALID_ARGUMENT', 'Unknown owner operation.');
}
export function cleanupReports(store: Store) {
  const now = Date.now();
  for (const tenant of store.listTenants()) {
    // Spend reservations are only readable for the current UTC day, so older rows are unreachable
    // state. They are swept for every tenant, including those with no report retention policy,
    // because they accrue once per reviewed write and nothing else deletes them. Two days are kept
    // so the current and preceding UTC day survive for inspection. The audit log keeps the
    // durable record of each write independently.
    store.transaction(() => {
      store.db
        .prepare(
          "DELETE FROM documents WHERE tenant_id=? AND kind='spend_reservation' AND json_extract(data,'$.day')<date('now','-2 day')",
        )
        .run(tenant);
    });
    const policy = store.documents(tenant, 'retention_policy')[0];
    if (!policy) continue;
    const cutoff = now - policy.days * 86400000;
    store.transaction(() => {
      store.db
        .prepare(
          "DELETE FROM documents WHERE tenant_id=? AND ((kind='report_incident' AND (json_extract(data,'$.state')='resolved' OR json_extract(data,'$.superseded_by_version') IS NOT NULL) AND json_extract(data,'$.updated_at')<?) OR (kind='decision_report' AND json_extract(data,'$.captured_at')<?))",
        )
        .run(tenant, cutoff, cutoff);
      store.db
        .prepare(
          "DELETE FROM documents WHERE tenant_id=? AND kind='overview_report' AND json_extract(data,'$.created_at')<? AND json_extract(data,'$.state') IN ('complete','partial','failed','cancelled') AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.tenant_id=documents.tenant_id AND json_extract(jobs.input,'$.report_id')=documents.id AND jobs.state IN ('queued','running'))",
        )
        .run(tenant, cutoff);
      store.db
        .prepare(
          "DELETE FROM documents WHERE tenant_id=? AND kind='report_presentation' AND NOT EXISTS (SELECT 1 FROM documents r WHERE r.tenant_id=documents.tenant_id AND r.kind='overview_report' AND r.id=documents.id)",
        )
        .run(tenant);
      store.db
        .prepare(
          "DELETE FROM jobs WHERE tenant_id=? AND kind IN ('report_overview','sheets_export','report') AND state IN ('complete','failed','cancelled') AND updated_at<?",
        )
        .run(tenant, cutoff);
    });
  }
}
