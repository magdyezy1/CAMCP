import {
  overviewV4Scope,
  overviewV4MeasurementLevel,
  overviewV4ScopeIdentity,
  type OverviewV4Capabilities,
} from './overview-v4.js';
import {reportMetricsSummaryV4} from './report-summary.js';
import {MirrorError} from './errors.js';
import {failedReportUnit} from './report-errors.js';
import type {JsonObject} from './types.js';

const order = ['campaign', 'adset', 'ad'];
const ownId = (row: JsonObject, level: string) =>
  level === 'campaign' ? (row.entity_id ?? row.campaign_id) : row.entity_id;
const parentId = (row: JsonObject, level: string) =>
  level === 'campaign' ? (row.parent_ids?.campaign_id ?? row.campaign_id) : row.parent_ids?.adset_id;
const context = (row: JsonObject, packet: JsonObject): JsonObject => row.period_context ?? packet;
const contextFrame = (value: JsonObject) => {
  const {rows: _rows, source: _source, ...frame} = value;
  return frame;
};
function dimensions(row: JsonObject, packet: JsonObject) {
  const period = row.report_period ?? packet.date_range,
    frame = context(row, packet);
  return [
    row.currency ?? frame.currency ?? null,
    frame.timezone ?? null,
    period?.since ?? null,
    period?.until ?? null,
    frame.attribution ?? null,
  ];
}
export function reportRollupLabel(row: JsonObject): string {
  if (row.aggregation?.kind !== 'rolled_up') return '';
  return row.aggregation.scope_field === 'ad_ids'
    ? 'Rolled up from selected ads'
    : 'Rolled up from selected child entities';
}

interface RollupBudget {
  rows(key: string, count: number): void;
  bytes(count: number): void;
}
function rolledRows(
  parent: JsonObject,
  child: JsonObject,
  capabilities: OverviewV4Capabilities,
  budget?: RollupBudget,
) {
  const level = parent.source.level,
    templates = new Map<string, JsonObject>(),
    groups = new Map<string, JsonObject[]>();
  let unassigned = 0;
  // The parent row that supplies the rolled row's identity (status, objective, name) is found by the entity and the
  // reporting frame it was measured in, not by attribution: the campaign read and the detail read of one source often
  // declare different attribution (the provider's configured one against unknown), and the same campaign must still be
  // found (F-L5-09). The children are grouped by attribution as well, so a total never mixes attribution.
  const templateKey = (id: string, currency: unknown, timezone: unknown, since: unknown, until: unknown) =>
    JSON.stringify([id, currency, timezone, since, until]);
  for (const row of parent.rows) {
    const id = overviewV4ScopeIdentity(capabilities, level, ownId(row, level));
    if (id)
      templates.set(
        templateKey(id, ...(dimensions(row, parent).slice(0, 4) as [unknown, unknown, unknown, unknown])),
        row,
      );
  }
  for (const row of child.rows) {
    const id = overviewV4ScopeIdentity(capabilities, level, parentId(row, level));
    if (!id) {
      unassigned++;
      continue;
    }
    const key = JSON.stringify([id, ...dimensions(row, child)]),
      members = groups.get(key) ?? [];
    members.push(row);
    groups.set(key, members);
  }
  // Derived rows consume the same whole-job limit; retries cannot refund earlier consumption.
  budget?.rows('rollup:' + parent.source.source_ref + ':' + level, groups.size);
  const rows: JsonObject[] = [];
  for (const [key, members] of groups) {
    const [id, currency, timezone, since, until, attribution] = JSON.parse(key),
      template = templates.get(templateKey(id, currency, timezone, since, until)),
      first = members[0]!,
      campaigns = new Set(
        members
          .map(row => overviewV4ScopeIdentity(capabilities, 'campaign', parentId(row, 'campaign')))
          .filter(Boolean),
      );
    if (level === 'adset' && campaigns.size > 1)
      throw new MirrorError(
        'REPORT_ACCOUNT_MISMATCH',
        'The detailed entity changed native parents during collection.',
        {},
        502,
      );
    const summary = reportMetricsSummaryV4(
        members.map(row => ({
          ...row,
          platform: child.source.platform,
          account_id: child.source.account_id,
          currency,
          date_from: since,
          date_to: until,
          attribution,
        })),
      ),
      result = summary.result_groups.length === 1 ? summary.result_groups[0] : undefined,
      descriptor = capabilities.levels.find(item => item.id === level),
      name =
        template?.entity_name ??
        template?.campaign_name ??
        first.parent_ids?.[level === 'campaign' ? 'campaign_name' : 'adset_name'] ??
        id,
      activity = members.map(row => row.native?.delivery_activity),
      omitted = [...new Set<string>(members.flatMap(row => row.omitted_as_zero ?? []))],
      // A requested ancestor never keeps a full-parent figure: its omissions and its results by objective or kept apart
      // (LinkedIn) describe every ad of the parent, not the selected ones this row totals (F-L5-17).
      {
        omitted_as_zero: _parentOmissions,
        results_by_objective: _parentResultsByObjective,
        other_results: _parentOtherResults,
        ...parentMetadata
      } = template ?? {},
      sourceField = overviewV4MeasurementLevel(parent.source) === 'ad' ? 'ad_ids' : 'adset_ids',
      row: JsonObject = {
        ...parentMetadata,
        ...(omitted.length ? {omitted_as_zero: omitted} : {}),
        entity_id: template ? ownId(template, level) : parentId(first, level),
        entity_name: name,
        entity_level: level,
        native_entity_type: descriptor?.native_type,
        campaign_id:
          level === 'campaign'
            ? (template?.campaign_id ?? parentId(first, level))
            : (first.parent_ids?.campaign_id ?? first.campaign_id ?? null),
        campaign_name: level === 'campaign' ? name : (first.parent_ids?.campaign_name ?? null),
        parent_ids:
          level === 'campaign'
            ? {}
            : {
                campaign_id: first.parent_ids?.campaign_id ?? first.campaign_id ?? null,
                campaign_name: first.parent_ids?.campaign_name ?? null,
              },
        status: template?.status ?? 'unknown',
        objective: template?.objective ?? 'unknown',
        currency,
        metrics: summary.metrics,
        metrics_coverage: summary.metrics_coverage,
        result: summary.result,
        result_groups: summary.result_groups,
        result_context: result ? {...result, result: undefined} : {unavailable_reason: 'mixed_goals'},
        result_definition: result?.definition?.label ?? 'unknown',
        mixed_result_definition: summary.result_groups.length > 1,
        report_period: {since, until},
        period_context: {...contextFrame(context(first, child)), currency, timezone, attribution},
        aggregation: {
          kind: 'rolled_up',
          from_level: child.source.level,
          scope_field: sourceField,
          child_rows: members.length,
        },
        native: {
          delivery_activity: activity.includes(true) ? true : activity.some(value => value == null) ? null : false,
          exact_totals: summary.metrics,
          exact_rows: members.flatMap(row => (row.native?.exact_rows?.length ? row.native.exact_rows : [row.metrics])),
          scope_rollup: {
            native_parent: template?.native ?? null,
            parent_captured_at: parent.captured_at ?? null,
            child_captured_at: child.captured_at ?? null,
          },
        },
      };
    row.aggregation.label = reportRollupLabel(row);
    rows.push(row);
  }
  budget?.bytes(Buffer.byteLength(JSON.stringify(rows)));
  return {rows, unassigned};
}

/**
 * Scope raw checkpoint packets only after collection. A requested ancestor never keeps full-parent metrics.
 * A packet whose rows `validate` refuses, or whose scoping or rollup throws, fails as a unit: its levels are named in
 * the report, the other levels keep their rows, and the job is not lost (F-L5-04).
 */
export function applyScopedRollups(
  packets: JsonObject[],
  capabilitiesFor: (platform: string) => OverviewV4Capabilities,
  budget?: RollupBudget,
  validate?: (scoped: JsonObject) => MirrorError | undefined,
): JsonObject[] {
  const ordinary = new Map<JsonObject, JsonObject>();
  const scoped = (packet: JsonObject): JsonObject => {
    if (ordinary.has(packet)) return ordinary.get(packet)!;
    if (packet.error) return packet;
    const selection = overviewV4Scope(packet.source, packet.rows, capabilitiesFor(packet.source.platform)),
      value = {
        ...packet,
        ...selection,
        complete: packet.complete && !selection.scope.excluded_unknown_rows,
        quality: {...packet.quality, scope: selection.scope},
      },
      refused = validate?.(value),
      result = refused ? failedReportUnit(refused, packet.source) : value;
    ordinary.set(packet, result);
    return result;
  };
  const rolled = (packet: JsonObject): JsonObject => {
    const measurement = overviewV4MeasurementLevel(packet.source);
    if (!measurement || order.indexOf(packet.source.level) >= order.indexOf(measurement) || packet.error)
      return scoped(packet);
    const capabilities = capabilitiesFor(packet.source.platform),
      rawChild = packets.find(
        value => value.source.source_ref === packet.source.source_ref && value.source.level === measurement,
      ),
      child = rawChild ? scoped(rawChild) : undefined,
      derived = child && !child.error ? rolledRows(packet, child, capabilities, budget) : {rows: [], unassigned: 0},
      ownSource = {
        ...packet.source,
        ...(packet.source.level === 'campaign' ? {adset_ids: []} : {}),
        ad_ids: [],
      },
      selected = overviewV4Scope(ownSource, derived.rows, capabilities),
      scope = {
        ...selected.scope,
        returned_rows: packet.rows.length,
        input_rows: derived.rows.length,
        rollup: {
          from_level: measurement,
          scope_field: measurement === 'ad' ? 'ad_ids' : 'adset_ids',
          derived_rows: derived.rows.length,
          selected_child_rows: child?.rows.length ?? 0,
          unassigned_child_rows: derived.unassigned,
          available: !!child && !child.error,
          parent_captured_at: packet.captured_at ?? null,
          child_captured_at: child?.captured_at ?? null,
        },
      },
      complete = packet.complete && !!child?.complete && !derived.unassigned && !scope.excluded_unknown_rows;
    const captures = [packet.captured_at, child?.captured_at].filter(value => Number.isFinite(value));
    return {
      ...packet,
      ...(captures.length ? {captured_at: Math.max(...captures)} : {}),
      rows: selected.rows,
      scope,
      complete,
      quality: {...packet.quality, scope},
    };
  };
  return packets.map(packet => {
    try {
      return rolled(packet);
    } catch (e) {
      return failedReportUnit(e, packet.source);
    }
  });
}
