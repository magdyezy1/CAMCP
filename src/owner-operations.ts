import {operationsHealth} from './operations-health.js';
import {linkedinVersionStatus} from './linkedin-version.js';
import {sunsetStatus} from './provider-sunsets.js';
import {Store} from './store.js';
import {MirrorError} from './errors.js';
import {policyWarnings, unprotectedAccounts} from './spend-policy.js';
import {budgetUnits, metaBudgetUnit, metaCurrencyOffsetsPinned, metaCurrencySource} from './budget-units.js';
import {recallAccountMetadata} from './account-metadata.js';
import {mediaLimitProblem} from './drive-media.js';
import type {Actor, JsonObject} from './types.js';
import {ownerAccess, saveSpendPolicy, spendPolicyKey, workspaceOwner} from './spend-policy.js';
import {googleAdsVersion, googleDeveloperTokenWarning} from './google-version.js';
import {metaApiVersion} from './meta-version.js';
import {disablePersonalData, enablePersonalData, personalDataAccounts} from './personal-data-access.js';
import {storageDetails} from './storage-health.js';
import {isDeploymentTenant, limitDiagnostics} from './limit-diagnostics.js';
import {mcpClientCapacity} from './mcp-clients.js';
import {viewerDownloadsAllowed} from './export-policy.js';
import {capOverrides} from './cap-overrides.js';
import {reviewFriction} from './review-friction.js';
import {mediaProcessorStatus} from './runtime-toolchain.js';
import {lastBackupReceipt} from './backup-receipt.js';
import {planInventory, planPolicy, purgeArchivedPlans, savePlanPolicy} from './campaign-inventory.js';
import {reportRetention, reportRetentionDefault, reportRetentionKinds} from './data-retention.js';
import {providerJobSummary, purgeProviderJobReceipts} from './provider-jobs.js';
/**
 * Parts of the owner's health that need modules a reviewed write must not load (this module is on the write path:
 * `assertWritesNotPaused`). The workspace tool supplies them; the guidance-coverage check stays on the write path.
 */
export interface OwnerHealthSources {
  withheldWorkbookRecords?(store: Store, actor: Actor): JsonObject;
  /** The 30-day baseline of legacy Google action names in the audit (MCP-10). */
  legacyAliasUsage?(store: Store, actor: Actor): JsonObject;
  /** The deployment's write and provider-job switches (RPT-06), which only the workspace tool knows. */
  providerJobs?: {allowWrites: boolean; enabled: boolean};
}
/**
 * The provider-job policy as the owner sees it (RPT-06): whether the deployment owner's switch is on, what a job needs,
 * and the jobs of the last seven days by provider and outcome from their receipts.
 */
function providerJobHealth(store: Store, tenant: string, switches?: {allowWrites: boolean; enabled: boolean}) {
  const enabled = switches?.enabled === true;
  return {
    effect: 'provider_job',
    switch: enabled ? 'on' : 'off',
    allowed_with_writes_off: enabled,
    ...(!enabled && switches && !switches.allowWrites
      ? {
          blocker: 'provider_jobs_disabled',
          reason:
            'Live writes are off and the deployment owner has not turned provider jobs on (AMCP_PROVIDER_JOBS=true), so report and export jobs are refused.',
        }
      : {}),
    requires: enabled
      ? 'An account report-job grant (Connections), or while writes are on an operator’s account write grant.'
      : 'A reviewed write: live writes on, an operator role and the account’s write grant.',
    paused: pauseCovers(writePause(store, tenant), 'provider_jobs'),
    receipts: providerJobSummary(store, tenant),
  };
}
const writePauseId = 'workspace';
/** Live keys of a workspace that the service, not a person, owns (owner health, SEC-06). Never the token or hash. */
export function serviceKeys(store: Store, tenant: string): JsonObject[] {
  return store.db
    .prepare(
      "SELECT a.user_id AS label,a.role,a.expires_at,coalesce(o.user_id,'service:legacy') AS owner FROM api_keys a LEFT JOIN credential_owners o ON o.hash=a.hash WHERE a.tenant_id=? AND a.revoked=0 AND (a.expires_at IS NULL OR a.expires_at>?) AND (o.user_id LIKE 'service:%' OR (o.hash IS NULL AND a.user_id NOT LIKE 'connector/%' AND a.user_id NOT LIKE 'oauth/%')) ORDER BY a.expires_at LIMIT 100",
    )
    .all(tenant, Date.now()) as JsonObject[];
}
const accountCurrencyOf = (metadata: JsonObject | undefined) =>
  typeof metadata?.currency === 'string' && /^[A-Z]{3}$/.test(metadata.currency)
    ? {account_currency: metadata.currency as string}
    : {};
/** The owner's pause of every reviewed write of a workspace, or undefined when writes are not paused. */
export function writePause(store: Store, tenant: string): JsonObject | undefined {
  const row = store.db
    .prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='write_pause' AND id=?")
    .get(tenant, writePauseId) as {data: string} | undefined;
  return row ? JSON.parse(row.data) : undefined;
}
/**
 * What a pause stops (RPT-06): `all` (the default, and every pause saved before scopes existed), advertising writes
 * only, or provider report and export jobs only. Advertising writes are every reviewed write that is not a provider job.
 */
export const pauseScopes = ['all', 'advertising', 'provider_jobs'] as const;
export type PauseScope = (typeof pauseScopes)[number];
/** Whether a pause stops this effect: advertising writes, or provider jobs. */
export function pauseCovers(pause: JsonObject | undefined, effect: 'advertising' | 'provider_jobs'): boolean {
  if (!pause) return false;
  const scope: PauseScope = pauseScopes.includes(pause.scope) ? pause.scope : 'all';
  return scope === 'all' || scope === effect;
}
/** Whether the owner's pause currently stops this effect. */
export function writesPausedFor(store: Store, tenant: string, effect: 'advertising' | 'provider_jobs'): boolean {
  return pauseCovers(writePause(store, tenant), effect);
}
/**
 * Refuses an execution while an owner has paused writes. Nothing reaches a provider after this refusal. `effect` is
 * what the execution is: an advertising write (the default) or a provider job (RPT-06); a pause scoped to the other
 * effect lets it run.
 */
export function assertWritesNotPaused(
  store: Store,
  tenant: string,
  effect: 'advertising' | 'provider_jobs' = 'advertising',
): void {
  const pause = writePause(store, tenant);
  if (pause && pauseCovers(pause, effect))
    throw new MirrorError(
      'WRITES_PAUSED',
      (pause.scope === 'provider_jobs'
        ? 'An owner paused provider report and export jobs of this workspace: '
        : pause.scope === 'advertising'
          ? 'An owner paused advertising writes of this workspace: '
          : 'An owner paused every reviewed write of this workspace: ') +
        pause.reason +
        '. Nothing was submitted; ask an owner to resume writes.',
      {paused_at: pause.paused_at, paused_by: pause.paused_by, scope: pause.scope ?? 'all'},
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
export function ownerOperations(
  store: Store,
  input: JsonObject,
  actor: Actor,
  sources: OwnerHealthSources = {},
): JsonObject {
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
      }),
      linkedinVersion = linkedinVersionStatus();
    // Deployment-wide rate-limit attribution, for the deployment workspace's owner only (SEC-01).
    const rateLimits = limitDiagnostics(store, tenant);
    return {
      operations: operationsHealth(store, tenant),
      ...(rateLimits ? {rate_limits: rateLimits} : {}),
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
      // The policy each selected account answers to, by the server's own normalized key (WRT-03): the settings form
      // prefills from it instead of guessing from a formatted account ID.
      spend_policy_bindings: store.listConnections(tenant).flatMap(c =>
        c.accounts.map(a => ({
          gateway: c.gateway,
          connection_id: c.id,
          account_id: a,
          policy_id: spendPolicyKey(c.gateway, a),
          // The currency its last live read recorded, which prefills the currency of its caps (WRT-07 Stage C).
          ...accountCurrencyOf(recallAccountMetadata(store, tenant, c.id, a)),
        })),
      ),
      unprotected_accounts: unprotectedAccounts(store, actor),
      policy_warnings: policyWarnings(store, tenant),
      // WRT-05: executions over a cap with the user's acknowledgement, and how reviews fare, from the audit.
      cap_overrides: capOverrides(store, tenant),
      review_friction: reviewFriction(store, tenant),
      // Meta is listed while its pinned currency offsets are loaded, so the settings page offers Meta caps in currency.
      budget_units: metaBudgetUnit() ? {...budgetUnits, meta_native_action: metaBudgetUnit()} : budgetUnits,
      // Whether Meta caps can be stated in account currency: only with a pinned capture of Meta's offsets (WRT-07).
      meta_currency_offsets: metaCurrencyOffsetsPinned() ? 'pinned' : 'not_pinned',
      ...(metaCurrencySource() ? {meta_currency_source: metaCurrencySource()} : {}),
      configuration_problems: [mediaLimitProblem, googleDeveloperTokenWarning()].filter(Boolean),
      // Workbook runs and schedules the Operations feed cannot show, counted by reason (B13, DOC-02).
      withheld_workbook_records: sources.withheldWorkbookRecords?.(store, actor) ?? null,
      // How often Google requests still use the legacy alias names, before the owner decides on them (MCP-10, Q23).
      google_legacy_aliases: sources.legacyAliasUsage?.(store, actor) ?? null,
      // The cached startup `ffmpeg -version` probe (QA-01): media conversion needs it.
      media_processor: mediaProcessorStatus(),
      retention: store.documents(tenant, 'retention_policy')[0] ?? null,
      // The report retention in force (SEC-07, owner decision P3): this workspace's period or the deployment default.
      report_retention: {
        ...reportRetention(store.documents(tenant, 'retention_policy')[0], deploymentReportRetention()),
        kinds: reportRetentionKinds,
      },
      plan_policy: planPolicy(store, tenant),
      // Plans against the workspace bound of 500 not archived (CMP-05 baseline), every person's, counted only.
      plan_inventory: planInventory(store, tenant),
      write_pause: writePause(store, tenant) ?? null,
      // RPT-06: the provider-job switch, what a job needs, and the last seven days of job receipts.
      provider_jobs: providerJobHealth(store, tenant, sources.providerJobs),
      export_policy: {viewer_downloads: viewerDownloadsAllowed(store, tenant)},
      personal_data_accounts: personalDataAccounts(store, tenant),
      storage: {
        ...storageDetails(store),
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
      // The newest receipt by verification time, with its age (OPS-04); document order is by random ID.
      backup: lastBackupReceipt(store, tenant) ?? {
        status: 'not_verified',
        message:
          'No verified backup receipt has been recorded. Use the encrypted backup command and test restoration before relying on recovery.',
      },
      // AI-client registrations are deployment wide, so only the deployment's own workspace (its administrator door, or
      // the owner it was migrated to) sees the count and the headroom under the cap (MCP-03), by the same test as the
      // rate-limit attribution above.
      ...(isDeploymentTenant(store, tenant) ? {mcp_clients: mcpClientCapacity(store)} : {}),
      // Keys created on the server (`admin create-key`, SEC-06): a member's credential change never ends them, so the
      // owner sees every live one. Older server keys without an owner row are listed as legacy.
      service_keys: serviceKeys(store, tenant),
      // The LinkedIn-Version configuration (an AMCP_LINKEDIN_API_VERSION override, the reviewed window) and every
      // provider version within 90 days of its recorded sunset (PRV-02).
      linkedin_version: linkedinVersion,
      provider_version_alarms: sunsetStatus().filter(s => s.alarm),
      api_versions: {
        google: googleAdsVersion,
        meta: metaApiVersion,
        tiktok: 'v1.3',
        snapchat: 'v1',
        linkedin: linkedinVersion.version ?? 'invalid AMCP_LINKEDIN_API_VERSION',
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
    // RPT-06: a pause stops everything unless the owner narrows it to advertising writes or to provider jobs.
    const scope = input.pause_scope ?? 'all';
    if (!pauseScopes.includes(scope))
      throw new MirrorError(
        'INVALID_ARGUMENT',
        'pause_scope is all (the default), advertising (advertising writes only) or provider_jobs (report and export jobs only).',
        {field: 'pause_scope', accepted: [...pauseScopes]},
      );
    const pause = {paused: true, scope, reason, paused_by: actor.userId, paused_at: Date.now()};
    store.putDocument(tenant, 'write_pause', writePauseId, pause);
    store.appendAudit(tenant, 'write_pause/' + writePauseId, {
      event: 'writes_paused',
      reason,
      scope,
      by: actor.userId,
    });
    return {
      ...pause,
      // A Reporting overview snapshot's Microsoft report submission is a provider job (report-native.ts), so the scopes
      // that cover provider jobs stop it too (wave 3a review).
      effect:
        scope === 'provider_jobs'
          ? 'Every provider report and export job of this workspace, the Microsoft report submission of a Reporting overview snapshot included, is refused with WRITES_PAUSED until an owner resumes writes. Advertising writes, other reads, prepares and verification continue.'
          : scope === 'advertising'
            ? 'Every advertising amcp_write and amcp_media execute of this workspace is refused with WRITES_PAUSED until an owner resumes writes. Provider report and export jobs (Microsoft report submissions of Reporting overview included), reads, prepares and verification continue.'
            : 'Every amcp_write and amcp_media execute of this workspace, and the Microsoft report submission of a Reporting overview snapshot, is refused with WRITES_PAUSED until an owner resumes writes. Other reads, prepares and verification continue.',
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
  if (input.action === 'save_plan_policy') return savePlanPolicy(store, actor, input);
  if (input.action === 'save_retention') {
    // Archived campaign plans are purged only when the owner opts in (CMP-05); 0 turns that off again.
    const plans = input.archived_campaign_plans_days;
    if (
      plans !== undefined &&
      (input.confirmed !== true || !Number.isInteger(plans) || (plans !== 0 && (plans < 7 || plans > 3650)))
    )
      throw new MirrorError(
        'INVALID_RETENTION',
        'Confirm an archived campaign plan retention of 7–3650 days, or 0 to keep archived plans.',
      );
    if (
      (plans === undefined || input.days !== undefined) &&
      (input.confirmed !== true || !Number.isInteger(input.days) || input.days < 7 || input.days > 365)
    )
      throw new MirrorError('INVALID_RETENTION', 'Confirm a report retention period of 7–365 days.');
    const {id: _id, revision: _revision, ...previous} = store.documents(tenant, 'retention_policy')[0] ?? {};
    const policy: JsonObject = {
      ...previous,
      ...(input.days !== undefined ? {days: input.days} : {}),
      ...(plans ? {archived_campaign_plans_days: plans} : {}),
      updated_at: Date.now(),
      updated_by: actor.userId,
    };
    if (plans === 0) delete policy.archived_campaign_plans_days;
    store.putDocument(tenant, 'retention_policy', 'reports', policy);
    if (plans !== undefined)
      store.appendAudit(tenant, 'retention_policy/reports', {
        event: 'plan_retention_saved',
        archived_campaign_plans_days: plans || null,
        by: actor.userId,
      });
    return {
      days: policy.days ?? null,
      scope:
        'Finished Overview snapshots, captured analysis reports, resolved monitoring incidents and finished report jobs; active jobs, open or acknowledged incidents, snapshots with an unconfirmed Google Sheets delivery, audit records and write receipts are preserved.',
      archived_campaign_plans_days: policy.archived_campaign_plans_days ?? null,
      campaign_plans_scope:
        'Campaign plans archived longer than this are deleted. Their audit records, write receipts and reviews are kept. Plans that are not archived are never deleted.',
    };
  }
  throw new MirrorError('INVALID_ARGUMENT', 'Unknown owner operation.');
}
/** The deployment's report retention default for health; an unknown value (it stops start-up) reads as off here. */
function deploymentReportRetention() {
  try {
    return reportRetentionDefault(process.env);
  } catch {
    return null;
  }
}
/**
 * The hourly report cleanup. Report records past the retention period are deleted per document kind
 * (src/data-retention.ts): the workspace owner's own period, else the deployment default `defaultDays`
 * (AMCP_REPORT_RETENTION_DAYS, 365 days unless `off`). Each workspace where it deleted anything gets one
 * `report_retention_applied` audit record with the period, its source and the count per kind.
 */
export function cleanupReports(store: Store, defaultDays: number | null = reportRetentionDefault(process.env)) {
  const now = Date.now();
  for (const tenant of store.listTenants()) {
    // Spend reservations are only readable for the current UTC day, so older rows are unreachable
    // state. They are swept for every tenant, including those with no report retention policy,
    // because they accrue once per reviewed write and nothing else deletes them. Two days are kept
    // so the current and preceding UTC day survive for inspection. The audit log keeps the
    // durable record of each write independently.
    // Provider-job receipts (RPT-06) are kept 90 days: settled ones from when they settled, submitting and uncertain
    // ones from when they were created.
    purgeProviderJobReceipts(store, tenant, now);
    store.transaction(() => {
      store.db
        .prepare(
          "DELETE FROM documents WHERE tenant_id=? AND kind='spend_reservation' AND json_extract(data,'$.day')<date('now','-2 day')",
        )
        .run(tenant);
    });
    store.db
      .prepare(
        "DELETE FROM documents WHERE tenant_id=? AND kind='report_file' AND NOT EXISTS (SELECT 1 FROM documents r WHERE r.tenant_id=documents.tenant_id AND r.kind='overview_report' AND r.id=json_extract(documents.data,'$.report_id'))",
      )
      .run(tenant);
    const policy = store.documents(tenant, 'retention_policy')[0];
    // Opt-in purge of archived campaign plans (CMP-05); audit and write receipts are separate records and stay.
    if (Number.isInteger(policy?.archived_campaign_plans_days) && policy!.archived_campaign_plans_days > 0)
      purgeArchivedPlans(store, tenant, now - policy!.archived_campaign_plans_days * 86400000);
    // The workspace's own period, else the deployment default (SEC-07, owner decision P3); `off` keeps everything.
    const retention = reportRetention(policy, defaultDays);
    if (retention.days === null) continue;
    const cutoff = now - retention.days * 86400000;
    const deleted = store.transaction(() => {
      const counts: Record<string, number> = {};
      const remove = (kind: string, sql: string, ...params: (string | number)[]) => {
        const changes = Number(store.db.prepare(sql).run(...params).changes);
        if (changes) counts[kind] = (counts[kind] ?? 0) + changes;
      };
      remove(
        'report_incident',
        "DELETE FROM documents WHERE tenant_id=? AND kind='report_incident' AND (json_extract(data,'$.state')='resolved' OR json_extract(data,'$.superseded_by_version') IS NOT NULL) AND json_extract(data,'$.updated_at')<?",
        tenant,
        cutoff,
      );
      remove(
        'decision_report',
        "DELETE FROM documents WHERE tenant_id=? AND kind='decision_report' AND json_extract(data,'$.captured_at')<?",
        tenant,
        cutoff,
      );
      remove(
        'overview_report',
        "DELETE FROM documents WHERE tenant_id=? AND kind='overview_report' AND json_extract(data,'$.created_at')<? AND json_extract(data,'$.state') IN ('complete','partial','failed','cancelled') AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.tenant_id=documents.tenant_id AND json_extract(jobs.input,'$.report_id')=documents.id AND jobs.state IN ('queued','running')) AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.tenant_id=documents.tenant_id AND d.kind='sheets_delivery' AND json_extract(d.data,'$.report_id')=documents.id AND json_extract(d.data,'$.state') IN ('pending','uncertain'))",
        tenant,
        cutoff,
      );
      // A snapshot with an unconfirmed Sheets delivery is kept above (its recovery needs the identical report).
      // Only terminal receipts of removed snapshots are deleted, once they are older than the retention period.
      remove(
        'sheets_delivery',
        "DELETE FROM documents WHERE tenant_id=? AND kind='sheets_delivery' AND json_extract(data,'$.state') IN ('complete','rejected','abandoned') AND coalesce(json_extract(data,'$.abandoned_at'),json_extract(data,'$.completed_at'),json_extract(data,'$.sent_at'),0)<? AND NOT EXISTS (SELECT 1 FROM documents r WHERE r.tenant_id=documents.tenant_id AND r.kind='overview_report' AND r.id=json_extract(documents.data,'$.report_id'))",
        tenant,
        cutoff,
      );
      remove(
        'report_presentation',
        "DELETE FROM documents WHERE tenant_id=? AND kind='report_presentation' AND NOT EXISTS (SELECT 1 FROM documents r WHERE r.tenant_id=documents.tenant_id AND r.kind='overview_report' AND r.id=documents.id)",
        tenant,
      );
      remove(
        'report_file',
        "DELETE FROM documents WHERE tenant_id=? AND kind='report_file' AND NOT EXISTS (SELECT 1 FROM documents r WHERE r.tenant_id=documents.tenant_id AND r.kind='overview_report' AND r.id=json_extract(documents.data,'$.report_id'))",
        tenant,
      );
      remove(
        'jobs',
        "DELETE FROM jobs WHERE tenant_id=? AND kind IN ('report_overview','sheets_export','report_file_export','report') AND state IN ('complete','failed','cancelled') AND updated_at<? AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.tenant_id=jobs.tenant_id AND d.kind='sheets_delivery' AND json_extract(d.data,'$.report_id')=json_extract(jobs.input,'$.report_id') AND json_extract(d.data,'$.state') IN ('pending','uncertain'))",
        tenant,
        cutoff,
      );
      if (Object.keys(counts).length)
        store.appendAudit(tenant, 'retention_policy/reports', {
          event: 'report_retention_applied',
          days: retention.days,
          source: retention.source,
          deleted: counts,
        });
      return counts;
    });
    if (Object.keys(deleted).length) store.scheduleCheckpoint();
  }
}
