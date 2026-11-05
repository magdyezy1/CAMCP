import {MirrorError} from './errors.js';
import {resolveObjective, type ObjectiveTable} from './report-objectives.js';
import {fingerprint} from './report-quality.js';
import {metricNumber} from './report-metrics.js';
import {providerDecimalText} from './provider-decimal.js';
import type {ReportStatusReader} from './report-status.js';
import {providerById} from './provider-adapters.js';
import type {JsonObject} from './types.js';
import {
  groupReportResults,
  unavailableReportResult,
  type ReportResultContext,
  type ResolvedReportResult,
} from './report-results.js';

/**
 * The Overview's entity levels and its detailed rows (RPT-07): what a source's level means, the validation of a source's
 * level and attribution profile, and the entity totals of detailed rows. Pure and below the collectors: the guided
 * detailed collector (src/overview-granularity.ts, which re-exports these) and the native detail collectors
 * (src/overview-native-detail.ts) both build on it, so a native report source never imports the guided collector.
 */
/** UI levels retain the provider's actual hierarchy; no campaign row is relabeled as an ad. */
export const overviewEntityLevels: Record<string, {id: string; label: string; preset?: string; native_type: string}[]> =
  {
    google: [
      {id: 'campaign', label: 'Campaign', native_type: 'campaign'},
      {id: 'adset', label: 'Ad group', preset: 'google_adset', native_type: 'ad_group'},
      {id: 'ad', label: 'Ad', preset: 'google_ad', native_type: 'ad_group_ad'},
    ],
    meta: [
      {id: 'campaign', label: 'Campaign', native_type: 'campaign'},
      {id: 'adset', label: 'Ad set', preset: 'meta_adset', native_type: 'adset'},
      {id: 'ad', label: 'Ad', preset: 'meta_ad', native_type: 'ad'},
    ],
    tiktok: [
      {id: 'campaign', label: 'Campaign', native_type: 'campaign'},
      {id: 'adset', label: 'Ad group', preset: 'tiktok_adgroup', native_type: 'adgroup'},
      {id: 'ad', label: 'Ad', preset: 'tiktok_ad', native_type: 'ad'},
    ],
    snapchat: [
      {id: 'campaign', label: 'Campaign', native_type: 'campaign'},
      {id: 'adset', label: 'Ad squad', preset: 'snapchat_adsquad', native_type: 'adsquad'},
      {id: 'ad', label: 'Ad', preset: 'snapchat_ad', native_type: 'ad'},
    ],
    linkedin: [
      {
        id: 'campaign',
        label: 'Campaign group',
        preset: 'linkedin_campaign_group',
        native_type: 'sponsoredCampaignGroup',
      },
      {id: 'adset', label: 'Campaign', preset: 'linkedin_campaign', native_type: 'sponsoredCampaign'},
      {id: 'ad', label: 'Creative', preset: 'linkedin_creative', native_type: 'sponsoredCreative'},
    ],
    // RPT-07 granular parity: native report collectors in overview-native-detail.ts (window totals per entity).
    microsoft: [
      {id: 'campaign', label: 'Campaign', native_type: 'campaign'},
      {id: 'adset', label: 'Ad group', preset: 'microsoft_ad_group', native_type: 'ad_group'},
      {id: 'ad', label: 'Ad', preset: 'microsoft_ad', native_type: 'ad'},
    ],
    reddit: [
      {id: 'campaign', label: 'Campaign', native_type: 'campaign'},
      {id: 'adset', label: 'Ad group', preset: 'reddit_ad_group', native_type: 'ad_group'},
      {id: 'ad', label: 'Ad', preset: 'reddit_ad', native_type: 'ad'},
    ],
    apple: [
      {id: 'campaign', label: 'Campaign', native_type: 'campaign'},
      {id: 'adset', label: 'Ad group', preset: 'apple_adgroup', native_type: 'adgroup'},
      {id: 'ad', label: 'Ad', preset: 'apple_ad', native_type: 'ad'},
    ],
  };
function invalid(message: string, code = 'INVALID_REPORT_LEVEL'): never {
  throw new MirrorError(code, message);
}
// Wave 4c round 6 (w4c-arc6-reporting): Meta's explicit attribution windows are its adapter's facts (RPT-07).
const metaWindows = providerById('meta')!.reportWindows!;
const snapchatWindowsValid = (options: JsonObject) =>
  ['1_DAY', '7_DAY', '28_DAY'].includes(options.swipe_up_attribution_window) &&
  ['none', '1_HOUR', '3_HOUR', '6_HOUR', '1_DAY', '7_DAY'].includes(options.view_attribution_window) &&
  !(options.view_attribution_window === '7_DAY' && options.swipe_up_attribution_window === '1_DAY');
/**
 * RPT-04: an optional campaign-level attribution profile for Meta (`attribution_windows`) and Snapchat (swipe and view
 * windows), the same settings their detailed presets use, so campaign and detailed rows of one snapshot can share
 * attribution. Without one, campaign reporting keeps the provider default. Returns the validated profile.
 */
export function campaignAttributionProfile(source: JsonObject): JsonObject | undefined {
  const options = source.report_options;
  if (source.reporting_contract === 'overview-config-v4') {
    if (source.platform === 'meta')
      return options.attribution_windows === null ? undefined : {attribution_windows: options.attribution_windows};
    if (source.platform === 'snapchat')
      return options.swipe_up_attribution_window === null && options.view_attribution_window === null
        ? undefined
        : {
            swipe_up_attribution_window: options.swipe_up_attribution_window,
            view_attribution_window: options.view_attribution_window,
          };
    return undefined;
  }
  if (options === undefined) return undefined;
  const keys =
    source.platform === 'meta' ? ['attribution_windows'] : ['swipe_up_attribution_window', 'view_attribution_window'];
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).length !== keys.length ||
    !keys.every(k => Object.hasOwn(options, k))
  )
    invalid(
      'Campaign reporting accepts only an attribution profile: attribution_windows for Meta, or swipe_up_attribution_window and view_attribution_window for Snapchat.',
    );
  if (source.platform === 'meta' && !metaWindows.valid(options.attribution_windows)) invalid(metaWindows.message);
  if (source.platform === 'snapchat' && !snapchatWindowsValid(options))
    invalid('Choose supported Snapchat swipe and view windows. Seven-day view requires at least seven-day swipe.');
  return options;
}
export function overviewSourceLevel(source: JsonObject, template = false) {
  const level = source.level ?? 'campaign';
  if (typeof level !== 'string' || !['campaign', 'adset', 'ad'].includes(level))
    invalid('Choose campaign, ad set / ad group, or ad reporting.');
  const selected = overviewEntityLevels[source.platform]?.find(item => item.id === level);
  if (level !== 'campaign' && !selected?.preset)
    invalid(
      'This reporting source does not have a qualified collector for the selected entity level.',
      'REPORT_LEVEL_UNSUPPORTED',
    );
  // The v4 boundary has validated levels/options against the source's declaration. Legacy callers keep their rules.
  if (source.reporting_contract === 'overview-config-v4')
    return selected ?? {id: 'campaign', label: 'Campaign / resource', native_type: 'campaign_or_resource'};
  if (level === 'campaign') {
    if (
      source.campaign_id !== undefined ||
      (source.report_options !== undefined && !['meta', 'snapchat'].includes(source.platform))
    )
      invalid('Detailed report settings and parent filters require a supported ad or ad set / ad group level.');
    campaignAttributionProfile(source);
    return selected ?? {id: 'campaign', label: 'Campaign / resource', native_type: 'campaign_or_resource'};
  }
  if (source.native_metrics?.length)
    invalid(
      'Detailed reporting uses the preset metrics. Clear additional native metrics before selecting this level.',
      'INVALID_NATIVE_METRICS',
    );
  const options = source.report_options;
  const allowed =
    source.platform === 'meta'
      ? ['complete_window', 'result_action_type', 'attribution_windows']
      : source.platform === 'snapchat'
        ? ['complete_window', 'swipe_up_attribution_window', 'view_attribution_window']
        : ['complete_window', 'attribution'];
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(k => !allowed.includes(k)) ||
    typeof options.complete_window !== 'boolean'
  )
    invalid('Detailed reports require explicit supported measurement settings and a reporting-window declaration.');
  if (
    source.platform === 'meta' &&
    (typeof options.result_action_type !== 'string' ||
      !/^[a-z][a-z0-9_.]{0,159}$/.test(options.result_action_type) ||
      !metaWindows.valid(options.attribution_windows))
  )
    invalid(
      'Choose one exact Meta result action and at most one click window (1d_click, 7d_click or 28d_click), with optional 1d_view and 1d_ev (engaged view), or view windows alone.',
    );
  if (source.platform === 'snapchat') {
    if (
      !['1_DAY', '7_DAY', '28_DAY'].includes(options.swipe_up_attribution_window) ||
      !['none', '1_HOUR', '3_HOUR', '6_HOUR', '1_DAY', '7_DAY'].includes(options.view_attribution_window) ||
      (options.view_attribution_window === '7_DAY' && options.swipe_up_attribution_window === '1_DAY')
    )
      invalid('Choose supported Snapchat swipe and view windows. Seven-day view requires at least seven-day swipe.');
    if (options.complete_window !== true)
      invalid('Snapchat detailed reporting requires an explicitly complete closed reporting window.');
  } else if (
    source.platform !== 'meta' &&
    (typeof options.attribution !== 'string' ||
      !options.attribution.trim() ||
      options.attribution.length > 200 ||
      /[\x00-\x1f\x7f]/.test(options.attribution))
  )
    invalid('Declare the detailed report attribution or use unknown.');
  if (source.platform === 'tiktok' && options.complete_window !== true)
    invalid('TikTok detailed reporting requires an explicitly complete closed reporting window.');
  if (source.platform === 'snapchat' && level === 'adset') {
    if (
      !template &&
      (typeof source.campaign_id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source.campaign_id))
    )
      invalid('Choose the exact Snapchat parent campaign UUID for ad-squad reporting.');
  } else if (source.campaign_id !== undefined)
    invalid('This detailed preset does not accept a parent campaign filter.');
  return selected!;
}

/**
 * v2: a declared-incomplete reporting window makes the detailed source partial (RPT-02). v3: TikTok ad group and ad,
 * Snapchat ad and LinkedIn creative rows carry their native parents from a bounded parent read (RPT-07).
 */
export const detailContractVersion = 'overview-detail-v3';
const additive = ['spend', 'impressions', 'clicks', 'conversions', 'conversion_value'];
function exactSum(values: unknown[], knownOnly = false) {
  const known = values.filter(value => value !== null && value !== undefined),
    coverage = {known: known.length, total: values.length};
  if (!known.length || (!knownOnly && known.length !== values.length)) return {exact: null, display: null, coverage};
  let sum = 0n;
  for (const value of known) {
    if (typeof value !== 'string' || !/^\d+(?:\.\d{1,9})?$/.test(value))
      invalid('The detailed metric is not an exact native decimal.', 'REPORT_SHAPE_CHANGED');
    const [whole, fraction = ''] = String(value).split('.');
    sum += BigInt(whole!) * 1000000000n + BigInt(fraction.padEnd(9, '0'));
  }
  const exact =
    (sum / 1000000000n).toString() +
    (sum % 1000000000n ? '.' + (sum % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '') : '');
  return {exact, display: knownOnly ? exact : metricNumber(exact), coverage};
}
/**
 * `nativeParents` holds the parents a bounded parent read returned for levels whose report rows carry none (RPT-07);
 * an entity it does not name keeps unknown parents.
 */
export function detailedOverviewRows(
  source: JsonObject,
  captured: JsonObject,
  nativeParents: Record<string, JsonObject> = {},
  objectives?: ObjectiveTable,
  resultReader?: (raw: JsonObject, context: ReportResultContext) => ResolvedReportResult,
  statusReader?: ReportStatusReader,
  activityReader?: (raw: JsonObject) => boolean | null,
) {
  const descriptor = overviewSourceLevel(source),
    groups = new Map<string, {mapped: JsonObject[]; raw: JsonObject[]; parents: JsonObject}>();
  if (
    !Array.isArray(captured.rows) ||
    !Array.isArray(captured.native_rows) ||
    captured.rows.length !== captured.native_rows.length ||
    captured.rows.length > 10000
  )
    invalid('The detailed preset did not return aligned bounded native rows.', 'REPORT_SHAPE_CHANGED');
  const scopedParent = captured.native_account_evidence?.parent_campaign;
  if (
    source.platform === 'snapchat' &&
    source.campaign_id &&
    scopedParent &&
    (scopedParent.id !== source.campaign_id || scopedParent.account_id !== source.account_id)
  )
    invalid('The detailed entity changed native parents during collection.', 'REPORT_ACCOUNT_MISMATCH');
  for (let index = 0; index < captured.rows.length; index++) {
    const row = captured.rows[index],
      raw = captured.native_rows[index],
      metadataParents = nativeParents[row.entity_id] ?? {};
    if (typeof row.entity_id !== 'string' || !row.entity_id)
      invalid('The detailed report did not return its native entity identity.', 'REPORT_ID_MISSING');
    const parents: JsonObject =
      source.platform === 'google'
        ? {
            campaign_id: raw.campaign.id,
            campaign_name: raw.campaign.name ?? null,
            adset_id: raw.adGroup.id,
            adset_name: raw.adGroup.name ?? null,
          }
        : source.platform === 'meta'
          ? {
              campaign_id: raw.campaign_id,
              campaign_name: raw.campaign_name ?? null,
              ...(typeof raw.objective === 'string' ? {objective: raw.objective} : {}),
              adset_id: raw.adset_id,
              adset_name: raw.adset_name ?? null,
              ...(metadataParents.entity_metadata ? {entity_metadata: metadataParents.entity_metadata} : {}),
            }
          : source.platform === 'snapchat' && source.campaign_id
            ? {
                ...metadataParents,
                campaign_id: source.campaign_id,
                campaign_name: scopedParent?.name ?? null,
                ...(typeof scopedParent?.objective === 'string' ? {objective: scopedParent.objective} : {}),
              }
            : metadataParents;
    if (source.campaign_id && metadataParents.campaign_id && metadataParents.campaign_id !== source.campaign_id)
      invalid('The detailed entity changed native parents during collection.', 'REPORT_ACCOUNT_MISMATCH');
    const prior = groups.get(row.entity_id);
    if (prior && fingerprint(prior.parents) !== fingerprint(parents))
      invalid('The detailed entity changed native parents during collection.', 'REPORT_ACCOUNT_MISMATCH');
    const group = prior ?? {mapped: [], raw: [], parents};
    group.mapped.push(row);
    group.raw.push(raw);
    groups.set(row.entity_id, group);
  }
  return [...groups].map(([id, group]) => {
    const v4 = source.reporting_contract === 'overview-config-v4',
      sums = Object.fromEntries(
        additive.map(key => [
          key,
          exactSum(
            group.mapped.map(row => row[key]),
            v4,
          ),
        ]),
      ),
      additionalKeys = [...new Set<string>(group.mapped.flatMap(row => Object.keys(row.additional_metrics ?? {})))],
      additionalSums = Object.fromEntries(
        additionalKeys.map(key => [
          key,
          exactSum(
            group.mapped.map(row => row.additional_metrics?.[key]),
            v4,
          ),
        ]),
      ),
      // RPT-04: provider-omitted actions counted as 0 on delivered days stay named on the entity total.
      omitted = additive.filter(key => group.mapped.some(row => row.omitted_as_zero?.includes(key))),
      {objective: nativeObjective, entity_metadata: entityMetadata, ...parentIds} = group.parents,
      status = v4 ? statusReader?.(group.raw[0]!, {level: descriptor.id, metadata: entityMetadata}) : undefined,
      activity = v4 && activityReader ? group.raw.map(activityReader) : undefined,
      resolved = resolveObjective({
        platform: source.platform,
        table: objectives,
        native: nativeObjective,
        campaignId: typeof group.parents.campaign_id === 'string' ? group.parents.campaign_id : undefined,
        mappedInputs: group.raw[0],
        overrides: source.objective_overrides,
        legacy: source.objective,
        fallback: source.objective_fallback,
      });
    let resultFields: JsonObject = {};
    let measurementRows: JsonObject[] | undefined;
    if (v4 && resultReader) {
      const resolvedRows = group.raw.map(raw =>
        resultReader(raw, {
          level: descriptor.id,
          range: {since: captured.semantics.date_from, until: captured.semantics.date_to},
          objective: nativeObjective,
          goal: group.parents.optimization_goal,
          event: group.parents.optimization_event,
          format: group.parents.format,
          report_options: source.report_options,
        }),
      );
      measurementRows = group.mapped.map((row, index) => ({
        ...Object.fromEntries([...additive, 'reach', 'frequency'].map(key => [key, row[key] ?? null])),
        ...row.additional_metrics,
        primary_result: resolvedRows[index]!.result.value,
        cost_per_result: resolvedRows[index]!.result.cost_per_result,
      }));
      const scope = JSON.stringify([
          source.platform,
          source.account_id,
          descriptor.id,
          id,
          captured.semantics.date_from,
          captured.semantics.date_to,
          captured.semantics.attribution,
        ]),
        resultGroups = groupReportResults(
          group.raw.map((_raw, index) => ({
            resolved: resolvedRows[index]!,
            scope,
            currency: captured.semantics.currency,
            spend: group.mapped[index]!.spend ?? null,
          })),
        ),
        one = resultGroups.length === 1 ? resultGroups[0] : undefined;
      resultFields = {
        result: one?.result ?? unavailableReportResult('mixed_goals').result,
        result_groups: resultGroups,
        result_context: one
          ? {
              definition: one.definition,
              source: one.source,
              cost_source: one.cost_source,
              unavailable_reason: one.unavailable_reason,
              coverage: one.coverage,
              cost_coverage: one.cost_coverage,
              cost_basis: one.cost_basis,
              rounding: one.rounding,
            }
          : {unavailable_reason: 'mixed_goals'},
        result_definition: one?.definition?.label ?? 'unknown',
        ...(resultGroups.length > 1 ? {mixed_result_definition: true} : {}),
        metrics_coverage: Object.fromEntries(additive.map(key => [key, sums[key]!.coverage])),
      };
    }
    return {
      ...(status ? {status: status.status} : {}),
      ...(omitted.length ? {omitted_as_zero: omitted} : {}),
      entity_id: id,
      entity_name: group.mapped.find(row => row.entity_name !== null)?.entity_name ?? id,
      entity_level: descriptor.id,
      native_entity_type: descriptor.native_type,
      campaign_id: group.parents.campaign_id ?? null,
      campaign_name: group.parents.campaign_name ?? null,
      parent_ids: parentIds,
      objective: resolved.native ?? 'unknown',
      objective_group: resolved.group,
      objective_source: resolved.source,
      objective_reason: resolved.reason,
      ...(typeof group.mapped[0]?.result_definition === 'string'
        ? {result_definition: group.mapped[0].result_definition}
        : {}),
      currency: captured.semantics.currency,
      metrics: {
        ...Object.fromEntries(additive.map(key => [key, sums[key]!.display])),
        ...Object.fromEntries(additionalKeys.map(key => [key, additionalSums[key]!.display])),
        ...Object.fromEntries(
          ['reach', 'frequency'].map(key => {
            const value = group.mapped[0]![key];
            return [
              key,
              group.mapped.length !== 1 || value == null
                ? null
                : v4
                  ? providerDecimalText(value, {field: key})
                  : metricNumber(value),
            ];
          }),
        ),
      },
      native: {
        ...(status ? {status_evidence: status} : {}),
        ...(activity
          ? {delivery_activity: activity.includes(true) ? true : activity.includes(null) ? null : false}
          : {}),
        preset: descriptor.preset,
        entity_id: id,
        daily_rows: group.raw,
        ...(measurementRows ? {exact_rows: measurementRows} : {}),
        exact_totals: {
          ...Object.fromEntries(additive.map(key => [key, sums[key]!.exact])),
          ...Object.fromEntries(additionalKeys.map(key => [key, additionalSums[key]!.exact])),
        },
      },
      ...resultFields,
    };
  });
}
