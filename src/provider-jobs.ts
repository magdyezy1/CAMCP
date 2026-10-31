import {randomUUID} from 'node:crypto';
import {MirrorError} from './errors.js';
import {normalizeAccount} from './scope.js';
import {scopeKey, sha256} from './security.js';
import {accountWriteGranted} from './write-access.js';
import {optional} from './workspace-core.js';
import {sweepProviderJobReceipts} from './retention-repository.js';
import {providerJobCounts} from './report-repository.js';
import {providerOf} from './provider-adapters.js';
import {providerJobFamilies} from './provider-hooks.js';
import type {Store} from './store.js';
import type {Actor, Connection, JsonObject} from './types.js';

/**
 * Provider report and export jobs as their own effect (RPT-06, owner decision D18: a quota-bounded `provider_job`
 * allowed under an owner switch). A job creates a provider-side processing object and uses provider quota; it changes
 * no serving configuration or spend. This module holds what every job shares:
 *
 * - the policy matrix the review lifecycle applies (WriteReviewService.access, authorizeExecution): with the deployment
 *   owner's switch off (AMCP_PROVIDER_JOBS, the default) a job is a reviewed write exactly as before; with it on, a job
 *   is allowed while live writes are off and for a reader, on an account with an explicit report-jobs grant (or, while
 *   writes are on, an operator's write grant). Advertising writes are never affected by the switch or the grant.
 * - the report-jobs grant, per connection and account, which a workspace administrator gives on the website;
 * - admission: a deployment-wide hourly bound per provider account for jobs without their own provider quota check;
 * - receipts: one retained record per submitted job, which is never resubmitted automatically. A lost response leaves
 *   it `uncertain`: the original job is reconciled by polling or listing, never replaced.
 * - the declared contract of each job family (providerJobContracts), which a test holds against the family registry.
 */

/**
 * What each provider job family guarantees; the adapters keep their own code (src/<provider>-report-jobs.ts) and
 * declare these rows (`jobFamilies`, ARC-01 wave 4c round 6), which src/provider-hooks.ts orders by family.
 */
export const providerJobContracts: readonly {
  family: string;
  gateway: string;
  provider: string;
  kind: 'report' | 'export' | 'change_log';
  admission: string;
  lost_response: string;
  retrieval: string;
}[] = Object.freeze(
  providerJobFamilies.map(({hooks, job}) => ({
    family: job.family,
    gateway: hooks.gateway,
    provider: providerOf(hooks.gateway)!.id,
    kind: job.kind,
    admission: job.admission,
    lost_response: job.lost_response,
    retrieval: job.retrieval,
  })),
);
const pipelineFamilies = new Set(providerJobFamilies.filter(({job}) => job.pipeline).map(({job}) => job.family));
/** Whether reviewed families create the jobs of `family` (the reporting pipeline's jobs are not theirs). */
export function reviewedJobFamily(family: string): boolean {
  return !pipelineFamilies.has(family);
}

/** The gateways whose reviewed families create provider jobs, which a report-job grant can apply to. */
export const providerJobGateways: readonly string[] = Object.freeze([
  ...new Set(providerJobContracts.filter(j => reviewedJobFamily(j.family)).map(j => j.gateway)),
]);
/**
 * Settled receipts are kept this long after they settle; submitting and uncertain receipts this long after they were
 * created. A receipt names the account, login and actor of its job, so none is kept without bound (wave 3a review): a
 * provider keeps a report or export job for days to weeks, and its review expired after five minutes, so after 90 days
 * an unsettled receipt protects no resubmission AMCP could still make.
 */
export const providerJobRetentionDays = 90;
const hour = 3600000;
/** Jobs admitted per provider account and rolling hour across the deployment (AMCP_PROVIDER_JOB_HOURLY_LIMIT). */
export function providerJobHourlyLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AMCP_PROVIDER_JOB_HOURLY_LIMIT;
  if (raw === undefined || raw === '') return 1000;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > 10000)
    throw new MirrorError(
      'CONFIGURATION_INVALID',
      'AMCP_PROVIDER_JOB_HOURLY_LIMIT is a whole number of jobs from 1 to 10000.',
      {},
      500,
    );
  return n;
}
/**
 * Admits one job for a provider account before anything is sent: a deployment-wide rolling hourly bound shared by
 * every workspace and login of the account. Refused with PROVIDER_JOB_QUOTA (retryable, nothing sent) when full.
 */
export function admitProviderJob(store: Store, gateway: string, account: string, now = Date.now()): void {
  const id = sha256(scopeKey('provider-job', gateway, normalizeAccount(gateway, account))),
    limit = providerJobHourlyLimit();
  const quotas = store.serviceRepo('provider_job_quota');
  store.transaction(() => {
    const row = quotas.find(id);
    const stored = row ? row.times : [];
    const times = (Array.isArray(stored) ? stored : []).filter(
      (t: unknown): t is number => typeof t === 'number' && t > now - hour && t <= now + 60000,
    );
    if (times.length >= limit)
      throw new MirrorError(
        'PROVIDER_JOB_QUOTA',
        'This provider account already received the most report jobs AMCP sends in an hour. Nothing was sent; try again later.',
        {submission_started: false, limit, retry_after_ms: Math.max(1000, times[0]! + hour - now)},
        429,
        true,
      );
    quotas.put(id, {times: [...times, now].slice(-limit)});
  });
}

/** The accounts a connection grants report jobs on (RPT-06), among those it still selects. */
export function reportJobAccounts(store: Store, connection: Connection): string[] {
  const grant = optional(store, connection.tenantId, 'report_job_grant', connection.id);
  const accounts: unknown[] = Array.isArray(grant?.accounts) ? grant.accounts : [];
  return accounts.filter((a): a is string => typeof a === 'string' && connection.accounts.includes(a));
}
/** Whether the connection grants report jobs on the account, compared as enforcement compares it. */
export function reportJobGranted(store: Store, connection: Connection, account: string): boolean {
  const id = normalizeAccount(connection.gateway, account);
  return reportJobAccounts(store, connection).some(a => normalizeAccount(connection.gateway, a) === id);
}
/**
 * The account authority a provider job needs under the owner's switch: an explicit report-jobs grant, or, while
 * reviewed writes are on, an operator's account write grant. A reader always needs the report-jobs grant.
 */
export function assertProviderJobAccount(
  store: Store,
  actor: Actor,
  connection: Connection,
  account: string,
  writesEnabled: boolean,
): void {
  if (writesEnabled && actor.role !== 'reader' && accountWriteGranted(connection, account)) return;
  if (reportJobGranted(store, connection, account)) return;
  throw new MirrorError(
    'REPORT_JOB_GRANT_REQUIRED',
    'The selected connection has no report-job grant for this account. Nothing was sent. A workspace administrator grants report jobs for the account in AMCP Connections.',
    {
      gateway: connection.gateway,
      account_id: account,
      connection_id: connection.id,
      effect: 'provider_job',
      remediation: 'Connections → Manage → Report jobs → select this account → Save.',
    },
    403,
  );
}
/**
 * Saves the accounts a connection grants report jobs on (website, a workspace administrator). Granting needs the
 * deployment owner's switch and explicit confirmation; removing never does. Audited with what changed.
 */
export function saveReportJobAccess(
  store: Store,
  actor: Actor,
  connection: Connection,
  input: JsonObject,
  providerJobs: boolean,
): JsonObject {
  store.assertActorActive(actor);
  if (actor.role !== 'admin' || actor.testAccount === true)
    throw new MirrorError('FORBIDDEN', 'Only a workspace administrator can change report-job access.', {}, 403);
  const accounts = input.accounts;
  if (
    !Array.isArray(accounts) ||
    accounts.length > 10000 ||
    accounts.some(a => typeof a !== 'string') ||
    new Set(accounts).size !== accounts.length
  )
    throw new MirrorError('INVALID_REPORT_JOB_ACCOUNTS', 'Select valid, unique accounts for report jobs.');
  if (accounts.some(a => !connection.accounts.includes(a)))
    throw new MirrorError(
      'WRITE_ACCOUNT_NOT_SELECTED',
      'Report-job access is limited to this login’s selected accounts.',
      {},
      403,
    );
  const previous = reportJobAccounts(store, connection),
    added = accounts.filter(a => !previous.includes(a)),
    removed = previous.filter(a => !accounts.includes(a));
  if (added.length && !providerJobGateways.includes(connection.gateway))
    throw new MirrorError(
      'REPORT_JOBS_UNAVAILABLE',
      'This provider has no report or export jobs in AMCP, so there is nothing to grant.',
      {gateway: connection.gateway},
      400,
    );
  if (added.length && !providerJobs)
    throw new MirrorError(
      'PROVIDER_JOBS_DISABLED',
      'This deployment does not allow provider report jobs outside reviewed writes. Its owner turns them on with AMCP_PROVIDER_JOBS=true.',
      {},
      403,
    );
  if (added.length && input.confirmed !== true)
    throw new MirrorError(
      'REPORT_JOB_CONFIRMATION_REQUIRED',
      'Confirm that AI clients and members of this workspace, readers included, may create provider report jobs on these accounts.',
      {added},
    );
  const data = {
    connection_id: connection.id,
    gateway: connection.gateway,
    accounts,
    updated_at: Date.now(),
    updated_by: actor.userId,
  };
  store.putDocument(actor.tenantId, 'report_job_grant', connection.id, data);
  store.appendAudit(actor.tenantId, randomUUID(), {
    event: 'report_job_access_changed',
    actor: actor.userId,
    connection_id: connection.id,
    gateway: connection.gateway,
    added,
    removed,
    vendor_writes: 0,
  });
  return {connection_id: connection.id, report_job_accounts: accounts, added, removed};
}

/** Where a receipt's job came from: a reviewed family, the reporting pipeline, or a direct native call. */
export type ProviderJobSource = 'reviewed' | 'reporting_pipeline' | 'native_call';
/** A receipt's state: sent and not yet answered, accepted with the provider's job ID, refused, or lost. */
export type ProviderJobState = 'submitting' | 'accepted' | 'rejected' | 'uncertain';
/**
 * Records a job about to be sent, before it is sent, so a lost response leaves a record that refuses a resubmission.
 * Returns the receipt id. `id` reuses a caller's own key (a review id) when it has one.
 */
export function beginProviderJob(
  store: Store,
  tenant: string,
  job: {
    gateway: string;
    account_id: string;
    connection_id: string;
    actor: string;
    source: ProviderJobSource;
    family?: string;
    review_id?: string;
    id?: string;
  },
): string {
  const id = job.id ?? randomUUID(),
    now = Date.now();
  store.putDocument(tenant, 'provider_job', id, {
    receipt_id: id,
    effect: 'provider_job',
    gateway: job.gateway,
    family: job.family ?? null,
    account_id: job.account_id,
    connection_id: job.connection_id,
    actor: job.actor,
    source: job.source,
    ...(job.review_id ? {review_id: job.review_id} : {}),
    state: 'submitting' satisfies ProviderJobState,
    job_id: null,
    created_at: now,
    resubmission: 'never_automatic',
  });
  return id;
}
/** Settles a receipt once the provider answered (accepted or rejected) or the answer was lost (uncertain). */
export function settleProviderJob(
  store: Store,
  tenant: string,
  id: string,
  state: Exclude<ProviderJobState, 'submitting'>,
  extra: JsonObject = {},
): void {
  const receipt = optional(store, tenant, 'provider_job', id);
  if (!receipt) return;
  const {id: _id, revision: _revision, ...data} = receipt;
  store.putDocument(tenant, 'provider_job', id, {
    ...data,
    ...extra,
    state,
    settled_at: Date.now(),
    ...(state === 'uncertain' ? {} : {retain_until: Date.now() + providerJobRetentionDays * 86400000}),
  });
}
export function providerJobReceipt(store: Store, tenant: string, id: unknown): JsonObject | undefined {
  return typeof id === 'string' && id ? optional(store, tenant, 'provider_job', id) : undefined;
}
/**
 * The receipt state a failed submission leaves: `rejected` when the provider definitively refused it (an HTTP 4xx
 * with a parsed body, so nothing was created), otherwise `uncertain` (a lost response, timeout, 5xx or rate limit).
 */
export function failedJobState(error: unknown): 'rejected' | 'uncertain' {
  const e = error as MirrorError,
    status = Number(e?.details?.http_status ?? e?.status);
  return e instanceof MirrorError &&
    e.details.upstream !== undefined &&
    status >= 400 &&
    status < 500 &&
    ![408, 409, 425, 429].includes(status)
    ? 'rejected'
    : 'uncertain';
}
/** Provider jobs of the last `days` days by gateway and state, for the owner (counted, never their contents). */
export function providerJobSummary(store: Store, tenant: string, days = 7): JsonObject {
  const since = Date.now() - days * 86400000;
  const rows = providerJobCounts(store, tenant, since);
  return {days, created: rows.reduce((n, r) => n + Number(r.count), 0), by_gateway_and_state: rows};
}
/**
 * Deletes settled receipts past their retention, and submitting or uncertain receipts created more than
 * providerJobRetentionDays ago (a receipt without a creation time counts as that old). Returns how many went.
 */
export function purgeProviderJobReceipts(store: Store, tenant: string, now = Date.now()): number {
  return sweepProviderJobReceipts(store, tenant, now, providerJobRetentionDays);
}
