import {MirrorError} from './errors.js';
import {DecisionReporting} from './decision-reporting.js';
import {fingerprint, reportContractVersion} from './report-quality.js';
import {metricNumber} from './report-metrics.js';
import type {MirrorService} from './service.js';
import type {Actor, JsonObject} from './types.js';

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
      {id: 'campaign', label: 'Campaign', native_type: 'sponsoredCampaign'},
      {id: 'ad', label: 'Creative (ad)', preset: 'linkedin_creative', native_type: 'sponsoredCreative'},
    ],
  };
function invalid(message: string, code = 'INVALID_REPORT_LEVEL'): never {
  throw new MirrorError(code, message);
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
  if (level === 'campaign') {
    if (source.report_options !== undefined || source.campaign_id !== undefined)
      invalid('Detailed report settings and parent filters require a supported ad or ad set / ad group level.');
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
      !Array.isArray(options.attribution_windows) ||
      !options.attribution_windows.length ||
      options.attribution_windows.length > 2 ||
      new Set(options.attribution_windows).size !== options.attribution_windows.length ||
      options.attribution_windows.some((v: unknown) => !['1d_click', '7d_click', '1d_view'].includes(String(v))) ||
      (options.attribution_windows.includes('1d_click') && options.attribution_windows.includes('7d_click')))
  )
    invalid('Choose one exact Meta result action and one click window, optional one-day view, or one-day view alone.');
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

const additive = ['spend', 'impressions', 'clicks', 'conversions', 'conversion_value'];
function exactSum(values: unknown[]) {
  if (values.some(value => value === null || value === undefined)) return {exact: null, display: null};
  let sum = 0n;
  for (const value of values) {
    if (typeof value !== 'string' || !/^\d+(?:\.\d{1,9})?$/.test(value))
      invalid('The detailed metric is not an exact native decimal.', 'REPORT_SHAPE_CHANGED');
    const [whole, fraction = ''] = String(value).split('.');
    sum += BigInt(whole!) * 1000000000n + BigInt(fraction.padEnd(9, '0'));
  }
  const exact =
    (sum / 1000000000n).toString() +
    (sum % 1000000000n ? '.' + (sum % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '') : '');
  return {exact, display: metricNumber(exact)};
}
export function detailedOverviewRows(source: JsonObject, captured: JsonObject) {
  const descriptor = overviewSourceLevel(source),
    groups = new Map<string, {mapped: JsonObject[]; raw: JsonObject[]; parents: JsonObject}>();
  if (
    !Array.isArray(captured.rows) ||
    !Array.isArray(captured.native_rows) ||
    captured.rows.length !== captured.native_rows.length ||
    captured.rows.length > 10000
  )
    invalid('The detailed preset did not return aligned bounded native rows.', 'REPORT_SHAPE_CHANGED');
  for (let index = 0; index < captured.rows.length; index++) {
    const row = captured.rows[index],
      raw = captured.native_rows[index];
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
              adset_id: raw.adset_id,
              adset_name: raw.adset_name ?? null,
            }
          : source.platform === 'snapchat' && source.campaign_id
            ? {campaign_id: source.campaign_id}
            : {};
    const prior = groups.get(row.entity_id);
    if (prior && fingerprint(prior.parents) !== fingerprint(parents))
      invalid('The detailed entity changed native parents during collection.', 'REPORT_ACCOUNT_MISMATCH');
    const group = prior ?? {mapped: [], raw: [], parents};
    group.mapped.push(row);
    group.raw.push(raw);
    groups.set(row.entity_id, group);
  }
  return [...groups].map(([id, group]) => {
    const sums = Object.fromEntries(additive.map(key => [key, exactSum(group.mapped.map(row => row[key]))]));
    return {
      entity_id: id,
      entity_name: group.mapped.find(row => row.entity_name !== null)?.entity_name ?? id,
      entity_level: descriptor.id,
      native_entity_type: descriptor.native_type,
      campaign_id: group.parents.campaign_id ?? null,
      campaign_name: group.parents.campaign_name ?? null,
      parent_ids: group.parents,
      objective: source.objective ?? 'unknown',
      objective_group: source.objective ?? 'unknown',
      currency: captured.semantics.currency,
      metrics: {
        ...Object.fromEntries(additive.map(key => [key, sums[key]!.display])),
        reach: group.mapped.length === 1 ? metricNumber(group.mapped[0]!.reach) : null,
        frequency: group.mapped.length === 1 ? metricNumber(group.mapped[0]!.frequency) : null,
      },
      native: {
        preset: descriptor.preset,
        entity_id: id,
        daily_rows: group.raw,
        exact_totals: Object.fromEntries(additive.map(key => [key, sums[key]!.exact])),
      },
    };
  });
}

export async function collectDetailedOverview(
  service: MirrorService,
  source: JsonObject,
  range: JsonObject,
  actor: Actor,
  metadata: JsonObject,
  currency: string | null,
  timezone: string | null,
) {
  const descriptor = overviewSourceLevel(source),
    options = source.report_options;
  const reporting = new DecisionReporting(service.store, (gateway, args, current) =>
    service.call(gateway, args, current),
  );
  const captured = await reporting.collectGuided(
    {
      preset: descriptor.preset,
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
        complete: options.complete_window,
      },
    },
    actor,
  );
  service.store.assertActorActive(actor);
  service.store.resolveConnection(actor, captured.gateway, source.account_id, source.connection_id);
  const lineage = [...(captured.native_account_evidence?.checks ?? []), ...(captured.source_pages ?? [])];
  return {
    contract_version: reportContractVersion,
    quality: {
      version: 1,
      pages_collected: true,
      measurement_complete: options.complete_window === false ? false : source.platform === 'snapchat' ? true : null,
      reporting_window_declared_complete: options.complete_window,
      status: 'declared_measurement',
      entity_level: descriptor.id,
    },
    lineage,
    query_fingerprint: fingerprint(captured.source_request),
    rows: detailedOverviewRows(source, captured),
    metadata,
    account_name: metadata.name ?? metadata.displayName ?? null,
    currency,
    timezone: captured.semantics.timezone,
    date_range: range,
    complete: true,
    attribution: captured.semantics.attribution,
    result_definition: captured.semantics.conversion_definition,
    warnings: [
      'Detailed rows retain the original native entity level and exact additive daily totals. Reach and frequency are unavailable for multi-day totals; missing days are not filled with zero. Reporting-window completeness and attribution remain explicitly declared unless native finalization proves them.',
    ],
    native_account_evidence: captured.native_account_evidence,
    metric_mapping: captured.mapping,
    source_hash: captured.source_hash,
    source_kind: 'paid',
    captured_at: captured.captured_at,
  };
}
