import type {Store} from './store.js';
import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {sha256, stable} from './security.js';
import {objectiveFallbackGroups} from './report-objectives.js';
import {overviewConfigV4} from './overview-v4.js';
import {priorObjectiveMigrationNotice} from './report-repository.js';

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

/** Eligibility comes from a genuine stored legacy definition, never the v3 projection of a newly created v4 one. */
export function registerObjectiveMigration(
  store: Store,
  tenant: string,
  record: JsonObject,
  kind: 'overview_view' | 'overview_schedule',
): void {
  const config = record.config,
    key = objectiveMigrationKey(
      kind === 'overview_view' ? record.id : record.view_id,
      kind === 'overview_schedule' ? record.id : undefined,
    );
  if (
    !key ||
    record.config_v4 ||
    config?.contract_version === overviewConfigV4 ||
    !Array.isArray(config?.sources) ||
    config.sources.some((source: JsonObject) => source?.levels !== undefined) ||
    !config.sources.some((source: JsonObject) => objectiveFallbackGroups.includes(source?.objective)) ||
    optional(store, tenant, objectiveMigrationKind, key)
  )
    return;
  const prior = priorObjectiveMigrationNotice(
    store,
    tenant,
    kind === 'overview_view' ? record.id : record.view_id,
    kind === 'overview_schedule' && !record.view_id ? record.id : undefined,
  );
  store.putDocument(tenant, objectiveMigrationKind, key, {
    origin_kind: kind,
    origin_id: record.id,
    origin_fingerprint: sha256(stable(config)),
    registered_at: Date.now(),
    announced_report_id: prior?.id ?? null,
    ...(prior ? {announced_at: prior.completed_at, imported_from_history: true} : {}),
  });
}

/** Called inside the same transaction that records the completed snapshot. History deletion cannot reset the claim. */
export function claimObjectiveMigration(store: Store, tenant: string, report: JsonObject): JsonObject | undefined {
  if (
    report.config?.contract_version !== overviewConfigV4 ||
    report.comparison?.role === 'baseline' ||
    !report.rows?.length ||
    !['complete', 'partial'].includes(report.state) ||
    !report.config.sources.some((source: JsonObject) => source.objective_migrated_from_v3)
  )
    return undefined;
  const key = objectiveMigrationKey(report.view_id, report.schedule_id);
  if (!key) return undefined;
  // Explicit v4 runs linked to a still-legacy definition use the same durable registration as automatic upgrades.
  const definitionKind = report.view_id ? 'overview_view' : 'overview_schedule',
    definition = optional(store, tenant, definitionKind, report.view_id ?? report.schedule_id);
  if (definition) registerObjectiveMigration(store, tenant, definition, definitionKind);
  const migration = optional(store, tenant, objectiveMigrationKind, key);
  if (!migration || migration.announced_report_id) return undefined;
  store.putDocument(
    tenant,
    objectiveMigrationKind,
    key,
    {
      ...migration,
      announced_report_id: report.id,
      announced_at: report.completed_at,
    },
    migration.revision,
  );
  return objectiveMigrationNotice;
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

/** A standalone legacy schedule can acquire a linked view when it is edited; its existing notice claim follows it. */
export function linkObjectiveMigration(store: Store, tenant: string, scheduleId: string, viewId: string): void {
  const from = objectiveMigrationKey(undefined, scheduleId)!,
    to = objectiveMigrationKey(viewId)!,
    previous = optional(store, tenant, objectiveMigrationKind, from);
  if (!previous) return;
  const current = optional(store, tenant, objectiveMigrationKind, to);
  if (
    !current ||
    (current.origin_fingerprint === previous.origin_fingerprint &&
      previous.announced_report_id &&
      !current.announced_report_id)
  ) {
    const {id: _id, revision: _revision, ...claim} = previous;
    store.putDocument(tenant, objectiveMigrationKind, to, claim, current?.revision ?? 0);
  }
  store.deleteDocument(tenant, objectiveMigrationKind, from);
}
