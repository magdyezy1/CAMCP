import {DecisionReporting} from './decision-reporting.js';
import {fingerprint, reportContractVersion} from './report-quality.js';
import {detailParents} from './overview-parents.js';
import type {AccountLookupCache, ReportSource} from './report-source.js';
import type {ObjectiveTable} from './report-objectives.js';
import {detailContractVersion, detailedOverviewRows, overviewSourceLevel} from './overview-levels.js';
import type {MirrorService} from './service.js';
import type {Actor, JsonObject} from './types.js';

// The entity levels, the source level and attribution profile checks and the detailed rows live in the leaf
// src/overview-levels.ts (ARC-04 stage F: the native detail collectors build on them without this guided collector);
// this module keeps exporting them.
export {
  campaignAttributionProfile,
  detailContractVersion,
  detailedOverviewRows,
  overviewEntityLevels,
  overviewSourceLevel,
} from './overview-levels.js';

const declaredIncompleteWarning =
  'The reporting window was declared incomplete. The source stays partial and recommendations are held until a complete window is collected.';

export async function collectDetailedOverview(
  service: MirrorService,
  source: JsonObject,
  range: JsonObject,
  actor: Actor,
  metadata: JsonObject,
  currency: string | null,
  timezone: string | null,
  // RPT-07: the job's per-source cache, so each entity's parents are read once across periods.
  lookup: AccountLookupCache = {},
  objectives?: ObjectiveTable,
  resultReader?: ReportSource['readResult'],
  statusReader?: ReportSource['readStatus'],
  activityReader?: (raw: JsonObject) => boolean | null,
) {
  const descriptor = overviewSourceLevel(source),
    options = source.report_options;
  const reporting = new DecisionReporting(service.store, (gateway, args, current) =>
    service.call(gateway, args, current),
  );
  const captured = await reporting.collectGuided(
    {
      preset: descriptor.preset,
      ...(source.reporting_contract === 'overview-config-v4' ? {reporting_contract: 'overview-config-v4'} : {}),
      allow_partial: true,
      account_id: source.account_id,
      connection_id: source.connection_id,
      ...(source.campaign_id ? {campaign_id: source.campaign_id} : {}),
      ...(source.platform === 'meta'
        ? {result_action_type: options.result_action_type, attribution_windows: options.attribution_windows}
        : {}),
      ...(source.platform === 'snapchat'
        ? {
            swipe_up_attribution_window: options.swipe_up_attribution_window,
            view_attribution_window: options.view_attribution_window,
          }
        : {}),
      semantics: {
        currency,
        timezone: source.platform === 'linkedin' ? 'UTC' : timezone,
        date_from: range.since,
        date_to: range.until,
        attribution: options.attribution ?? 'unknown',
        conversion_definition: 'selected native result',
        source_name: descriptor.label,
        complete: options.complete_window === true,
      },
    },
    actor,
    lookup,
  );
  service.store.assertActorActive(actor);
  service.store.resolveConnection(actor, captured.gateway, source.account_id, source.connection_id);
  // RPT-07: parents of the reported entities where the report rows carry none (TikTok, Snapchat ads, LinkedIn
  // creatives), read after the report under the same login; IDs stay exact and an unread parent stays unknown.
  lookup.detailParents ??= {parents: {}, lineage: []};
  const parentCache =
    source.reporting_contract === 'overview-config-v4'
      ? ((lookup.detailParentsByLevel ??= {})[descriptor.id] ??= {parents: {}, lineage: []})
      : lookup.detailParents;
  const parents = await detailParents(
    service,
    source,
    descriptor.id,
    (Array.isArray(captured.rows) ? captured.rows : [])
      .map((row: JsonObject) => row.entity_id)
      .filter((id: unknown): id is string => typeof id === 'string' && !!id),
    actor,
    parentCache,
  );
  service.store.assertActorActive(actor);
  service.store.resolveConnection(actor, captured.gateway, source.account_id, source.connection_id);
  const lineage = [
    ...(captured.native_account_evidence?.checks ?? []),
    ...(captured.source_pages ?? []),
    ...parents.lineage,
  ];
  return {
    contract_version: reportContractVersion,
    quality: {
      version: 1,
      pages_collected: true,
      measurement_complete: options.complete_window !== true ? false : source.platform === 'snapchat' ? true : null,
      reporting_window_declared_complete: options.complete_window,
      status: 'declared_measurement',
      entity_level: descriptor.id,
      ...(captured.semantics.metric_rounding ? {metric_rounding: captured.semantics.metric_rounding} : {}),
    },
    lineage,
    query_fingerprint: fingerprint(captured.source_request),
    rows: detailedOverviewRows(
      source,
      captured,
      // An entity whose parents were not read carries why, so its missing objective is not blamed on the platform.
      {
        ...Object.fromEntries(
          Object.entries(parents.unread ?? {}).map(([id, cause]) => [id, {objective_unread: cause}]),
        ),
        ...parents.parents,
      },
      objectives,
      resultReader,
      statusReader,
      activityReader,
    ),
    metadata,
    account_name: metadata.name ?? metadata.displayName ?? null,
    currency,
    timezone: captured.semantics.timezone,
    date_range: range,
    // RPT-02 (detail contract v2): every page was collected, but a window declared incomplete keeps the source
    // partial and holds recommendations. Snapshots retained under v1 keep their original labels.
    detail_contract: source.reporting_contract === 'overview-config-v4' ? 'overview-detail-v4' : detailContractVersion,
    collection_complete: captured.collection?.complete !== false,
    complete: options.complete_window === true && captured.collection?.complete !== false,
    attribution: captured.semantics.attribution,
    result_definition: captured.semantics.conversion_definition,
    warnings: [
      'Detailed rows retain the original native entity level and exact additive daily totals. Reach and frequency are unavailable for multi-day totals; missing days are not filled with zero. Reporting-window completeness and attribution remain explicitly declared unless native finalization proves them.',
      ...(options.complete_window === true
        ? []
        : [
            options.complete_window === false
              ? declaredIncompleteWarning
              : 'The reporting window was not declared complete. Results remain partial and recommendations are withheld.',
          ]),
      ...(captured.collection?.warnings ?? []),
      ...parents.warnings,
    ],
    native_account_evidence: captured.native_account_evidence,
    metric_mapping: captured.mapping,
    source_hash: captured.source_hash,
    source_kind: 'paid',
    captured_at: captured.captured_at,
  };
}
