import type {Store} from './store.js';
import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {sha256, stable} from './security.js';
import {objectiveFallbackGroups} from './report-objectives.js';
import {overviewConfigV4} from './overview-v4.js';
import {reportSource} from './report-sources.js';
import {latestDefinitionContracts} from './report-repository.js';

/**
 * The "numbers changed" notes of a saved report (D22 and the platform-contract notes), kept in one durable record per
 * saved report. Its key is `view:<id>`, or `schedule:<id>` for a legacy schedule that has no saved report yet; deleting
 * the report deletes the record, and deleting History does not touch it.
 *
 * - `notices`: each note the report owes, by id: when it was registered, the first snapshot that carried it and the
 *   snapshot whose delivery spent it.
 * - `contracts`: the platform contracts the report last ran under, so a changed contract is seen without reading History.
 *   Absent while the report has never run (nothing changed for it).
 *
 * A note is registered once. Every snapshot recorded while it is unspent carries it, so History shows it. It is spent
 * when a delivery of a snapshot that carries it succeeds; a report with no scheduled delivery is its own delivery, so
 * it spends at record time. A skipped, failed or cancelled delivery spends nothing, so the next deliverable snapshot
 * still carries it (F-L6-03, F-L6-04, F-L2-06).
 */
export const objectiveMigrationKind = 'overview_objective_migration';
export const objectiveMigrationNotice = {
  id: 'objective-fallback-v4',
  message: "Saved report objectives now fill gaps in the platform's objective. Numbers may change.",
};
const optional = (store: Store, tenant: string, kind: string, id: string): JsonObject | undefined => {
  try {
    return store.document(tenant, kind, id);
  } catch (error) {
    if (error instanceof MirrorError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
};
export const objectiveMigrationKey = (viewId?: string, scheduleId?: string): string | undefined =>
  viewId ? 'view:' + viewId : scheduleId ? 'schedule:' + scheduleId : undefined;
const withoutIdentity = ({id: _id, revision: _revision, ...data}: JsonObject): JsonObject => data;

/** The schedule a saved report or schedule stands for, if it has one. */
function scheduleOf(store: Store, tenant: string, viewId?: string, scheduleId?: string): JsonObject | undefined {
  const id = scheduleId ?? (viewId ? optional(store, tenant, 'overview_view', viewId)?.schedule_id : undefined);
  return id ? optional(store, tenant, 'overview_schedule', id) : undefined;
}

/**
 * The record of a saved report, created when the report is first seen. That is the one time History is read: the
 * newest finished snapshot says what the report last ran under, and a schedule that has fired but kept no snapshot (the
 * workspace's retention purged it) counts as having run under the older contract. A report that never ran has no
 * `contracts`, so its first report has nothing to differ from. Later runs find the record and read nothing (F-L6-07).
 */
export function ensureNoticeRecord(
  store: Store,
  tenant: string,
  viewId?: string | null,
  scheduleId?: string | null,
): JsonObject | undefined {
  const view = viewId ?? undefined,
    schedule = scheduleId ?? undefined,
    key = objectiveMigrationKey(view, schedule);
  if (!key) return undefined;
  const existing = optional(store, tenant, objectiveMigrationKind, key);
  if (existing) return existing;
  const newest = latestDefinitionContracts(store, tenant, view, schedule),
    fired = typeof scheduleOf(store, tenant, view, schedule)?.last_occurrence_at === 'number';
  store.putDocument(
    tenant,
    objectiveMigrationKind,
    key,
    {registered_at: Date.now(), notices: {}, ...(newest !== undefined || fired ? {contracts: newest ?? {}} : {})},
    0,
  );
  return store.document(tenant, objectiveMigrationKind, key);
}

/**
 * A stored legacy definition whose saved objective was an override becomes a fallback when it is upgraded, so its
 * numbers can change: register that note, once, if the report has run before. A report that never ran has no earlier
 * numbers, so it is told nothing (F-L2-13). Eligibility comes from a genuine stored legacy definition, never the v3
 * projection of a newly created v4 one.
 */
export function registerObjectiveMigration(
  store: Store,
  tenant: string,
  record: JsonObject,
  kind: 'overview_view' | 'overview_schedule',
): void {
  const config = record.config,
    viewId = kind === 'overview_view' ? record.id : record.view_id,
    scheduleId = kind === 'overview_schedule' ? record.id : undefined,
    key = objectiveMigrationKey(viewId, scheduleId);
  if (
    !key ||
    record.config_v4 ||
    config?.contract_version === overviewConfigV4 ||
    !Array.isArray(config?.sources) ||
    config.sources.some((source: JsonObject) => source?.levels !== undefined) ||
    !config.sources.some((source: JsonObject) => objectiveFallbackGroups.includes(source?.objective))
  )
    return;
  const existing = ensureNoticeRecord(store, tenant, viewId, scheduleId);
  if (!existing || existing.notices[objectiveMigrationNotice.id] || existing.contracts === undefined) return;
  store.putDocument(
    tenant,
    objectiveMigrationKind,
    key,
    {
      ...withoutIdentity(existing),
      origin_kind: kind,
      origin_id: record.id,
      origin_fingerprint: sha256(stable(config)),
      notices: {
        ...existing.notices,
        [objectiveMigrationNotice.id]: {registered_at: Date.now(), first_report_id: null, spent_report_id: null},
      },
    },
    existing.revision,
  );
}

/** Whether a snapshot of this report is delivered later by a schedule, rather than being the delivery itself. */
function deliveredLater(store: Store, tenant: string, report: JsonObject): boolean {
  if (report.destination_id) return true;
  const schedule = scheduleOf(store, tenant, report.view_id ?? undefined, report.schedule_id ?? undefined);
  return schedule?.is_active === true && !!schedule.destination_id;
}

/**
 * Called in the transaction that records a finished snapshot. A comparison baseline, an empty capture and an
 * unfinished one change nothing. Otherwise: a contract that differs from the one the report last ran under registers its
 * note; every unspent note that applies to this snapshot is carried by it (and returned for its `notices`); the notes
 * are spent now when this snapshot is the delivery; and the contracts it ran under become the report's.
 */
export function settleNotices(store: Store, tenant: string, report: JsonObject): JsonObject[] {
  if (report.comparison?.role === 'baseline' || !report.rows?.length || !['complete', 'partial'].includes(report.state))
    return [];
  const viewId = report.view_id ?? undefined,
    scheduleId = report.schedule_id ?? undefined,
    key = objectiveMigrationKey(viewId, scheduleId),
    // A saved report deleted while one of its runs was still collecting has no record to keep: deleting it deleted the
    // record, and a record made now would never be deleted.
    owner = viewId
      ? optional(store, tenant, 'overview_view', viewId)
      : scheduleId
        ? optional(store, tenant, 'overview_schedule', scheduleId)
        : undefined,
    existing = key && owner ? ensureNoticeRecord(store, tenant, viewId, scheduleId) : undefined;
  if (!key || !existing) return [];
  const stamps: Record<string, string> = report.platform_contracts ?? {},
    notices: Record<string, JsonObject> = {...existing.notices},
    now = Date.now();
  // The notes that could apply to this snapshot, platform notes first and the objective note last.
  const applicable: JsonObject[] = Object.keys(stamps).flatMap(platform => {
    const notice = reportSource(platform)?.contract?.notice;
    if (!notice) return [];
    if (existing.contracts !== undefined && existing.contracts[platform] !== stamps[platform] && !notices[notice.id])
      notices[notice.id] = {registered_at: now, first_report_id: null, spent_report_id: null};
    return [{...notice}];
  });
  if (report.config?.contract_version === overviewConfigV4) applicable.push({...objectiveMigrationNotice});
  const carried = applicable.filter(notice => notices[notice.id] && !notices[notice.id]!.spent_report_id),
    spendNow = !deliveredLater(store, tenant, report);
  for (const notice of carried)
    notices[notice.id] = {
      ...notices[notice.id]!,
      first_report_id: notices[notice.id]!.first_report_id ?? report.id,
      spent_report_id: spendNow ? report.id : null,
    };
  const next = {...withoutIdentity(existing), notices, contracts: {...(existing.contracts ?? {}), ...stamps}};
  if (stable(next) !== stable(withoutIdentity(existing)))
    store.putDocument(tenant, objectiveMigrationKind, key, next, existing.revision);
  return carried;
}

/**
 * A delivery of this snapshot reached its destination (a file export delivered, or a Sheets tab written): the notes it
 * carried were seen by the client and are spent. Called in the transaction that records the delivery, so the two
 * commit or roll back together. A snapshot that carries no note, or one already spent, changes nothing.
 */
export function spendNotices(store: Store, tenant: string, report: JsonObject): void {
  const key = objectiveMigrationKey(report.view_id ?? undefined, report.schedule_id ?? undefined),
    existing = key ? optional(store, tenant, objectiveMigrationKind, key) : undefined;
  if (!key || !existing) return;
  const carried = new Set((report.notices ?? []).map((notice: JsonObject) => notice.id)),
    notices: Record<string, JsonObject> = {...existing.notices};
  let changed = false;
  for (const [id, state] of Object.entries(notices))
    if (carried.has(id) && !state.spent_report_id) {
      notices[id] = {...state, spent_report_id: report.id};
      changed = true;
    }
  if (changed)
    store.putDocument(tenant, objectiveMigrationKind, key, {...withoutIdentity(existing), notices}, existing.revision);
}

export function deleteObjectiveMigration(
  store: Store,
  tenant: string,
  kind: 'overview_view' | 'overview_schedule',
  id: string,
): void {
  store.deleteDocument(
    tenant,
    objectiveMigrationKind,
    objectiveMigrationKey(kind === 'overview_view' ? id : undefined, kind === 'overview_schedule' ? id : undefined)!,
  );
}

/** A standalone legacy schedule can acquire a linked view when it is edited; its record follows it. */
export function linkObjectiveMigration(store: Store, tenant: string, scheduleId: string, viewId: string): void {
  const from = objectiveMigrationKey(undefined, scheduleId)!,
    to = objectiveMigrationKey(viewId)!,
    previous = optional(store, tenant, objectiveMigrationKind, from);
  if (!previous) return;
  const current = optional(store, tenant, objectiveMigrationKind, to),
    spent = (record?: JsonObject) => !!record?.notices?.[objectiveMigrationNotice.id]?.spent_report_id;
  if (!current || (current.origin_fingerprint === previous.origin_fingerprint && spent(previous) && !spent(current)))
    store.putDocument(tenant, objectiveMigrationKind, to, withoutIdentity(previous), current?.revision ?? 0);
  store.deleteDocument(tenant, objectiveMigrationKind, from);
}
