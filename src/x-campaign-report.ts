import {MirrorError} from './errors.js';
import {metricNumber} from './report-metrics.js';
import {fingerprint} from './report-quality.js';
import {reportSourceError} from './report-errors.js';
import type {JsonObject} from './types.js';
import {xAnalyticsTime} from './x-report-jobs.js';
import {xReportPlacements, type XActiveSet} from './x-active-entities.js';
import {parseProviderDecimal, providerDecimalText} from './provider-decimal.js';
import {reportScaledText} from './report-math-v4.js';

/** Add native decimal text before applying the retained nine-place precision or native-unit conversion. */
function exactNativeAdd(total: string, value: unknown, field: string): string {
  const right = providerDecimalText(value, {field}),
    [a, af = ''] = total.split('.'),
    [b, bf = ''] = right.split('.'),
    places = Math.max(af.length, bf.length),
    digits = (BigInt(a! + af.padEnd(places, '0')) + BigInt(b! + bf.padEnd(places, '0')))
      .toString()
      .padStart(places + 1, '0'),
    fraction = places ? digits.slice(-places).replace(/0+$/, '') : '';
  return (places ? digits.slice(0, -places) : digits) + (fraction ? '.' + fraction : '');
}

/**
 * X's publisher-network placement (ACC-06). AMCP's line-item writes accept it, X's analytics guide lists it, but the
 * current parameter reference names only xReportPlacements, so these reports do not request it until an authorized read
 * shows whether X returns data for it (docs/acceptance/READ-ACCEPTANCE.md). Until then a campaign X reports as active
 * there is named and the source is partial, never a silently smaller total.
 */
export const xPublisherNetwork = 'PUBLISHER_NETWORK';
export const xPublisherNetworkWarning = (count: number) =>
  count +
  ' X campaign' +
  (count === 1 ? ' has' : 's have') +
  ' activity on the publisher network (PUBLISHER_NETWORK), which this report does not request yet. That delivery and its spend are not in these totals, so coverage is partial and budget guidance is withheld.';
/** The synchronous analytics ceiling per X source (X allows 250 requests per 15 minutes per user). */
export const xAnalyticsRequestLimit = 100;
/** RPT-07: shown when X refused the line item read, so campaign objectives stay unknown. */
export const xObjectivesUnavailableWarning =
  'X line item objectives could not be read, so campaign objectives stay unknown unless set in report settings.';
/** RPT-07: shown when a campaign's line items use different objectives. */
export const xObjectivesMixedWarning =
  'Some X campaigns run line items with different objectives; their objective stays unknown unless set in report settings.';
/**
 * RPT-07: X campaigns carry no objective; their line items do. A listed campaign whose line items share one objective
 * takes it (current line item metadata); different objectives give `null` (unknown, never a guess). Line items of
 * campaigns outside the listed inventory are ignored; a malformed line item refuses the source.
 */
export function xCampaignObjectives(inventory: JsonObject[], lineItems: JsonObject[]) {
  const listed = new Set(inventory.map(c => String(c.id))),
    objectives = new Map<string, Set<string>>();
  for (const item of lineItems) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.campaign_id !== 'string' ||
      (item.objective != null && (typeof item.objective !== 'string' || !/^[A-Z][A-Z_]{0,63}$/.test(item.objective)))
    )
      throw new MirrorError('REPORT_SHAPE_CHANGED', 'X returned a malformed line item.', {}, 502);
    if (!listed.has(item.campaign_id) || !item.objective) continue;
    const set = objectives.get(item.campaign_id) ?? new Set<string>();
    objectives.set(item.campaign_id, set.add(item.objective));
  }
  return {
    campaigns: Object.fromEntries(
      [...objectives].map(([id, set]) => [id, set.size === 1 ? [...set][0]! : null]),
    ) as Record<string, string | null>,
  };
}
/**
 * X requires a separate request for every placement. Conversion groups are requested apart from engagement and
 * billing (RPT-03), so a rejected conversion request cannot remove the placement's spend.
 */
export function xGroupSets(extra: string[]): string[][] {
  const groups = [...new Set(['ENGAGEMENT', 'BILLING', ...extra])];
  if (groups.some(g => !['ENGAGEMENT', 'BILLING', 'VIDEO', 'WEB_CONVERSION', 'MOBILE_CONVERSION'].includes(g)))
    throw new MirrorError('INVALID_REPORT_SOURCE', 'Choose a supported X metric group.');
  const conversion = ['WEB_CONVERSION', 'MOBILE_CONVERSION'];
  return [groups.filter(g => !conversion.includes(g)), ...conversion.filter(g => groups.includes(g)).map(g => [g])];
}
/**
 * With `active` (RPT-03), analytics are requested only for the campaigns X reported as active, per placement and
 * only in the 7-day chunks that overlap their activity windows (`windows:false` widens to the whole range). Campaigns
 * with no reported activity are counted, never returned as zero rows. Without `active` the inventory path is used.
 */
export async function xCampaignReport(
  inventory: JsonObject[],
  start: number,
  end: number,
  extra: string[],
  read: (query: JsonObject) => Promise<JsonObject>,
  options: {
    checkpoint?: JsonObject;
    save?: (value: JsonObject) => void;
    active?: XActiveSet;
    windows?: boolean;
    exact?: true;
  } = {},
): Promise<{rows: JsonObject[]; complete: boolean; warnings: string[]; no_activity_count: number; requests: number}> {
  // Fetch covering UTC hours, then assign each indivisible hour by its midpoint. Adjacent local calendar periods
  // must own disjoint buckets, including half/quarter-hour timezones. Never fractionally invent provider counts.
  const hour = 3600000,
    week = 7 * 86400000,
    requestedStart = start,
    requestedEnd = end,
    widened = start % hour !== 0 || end % hour !== 0;
  start = Math.floor(start / hour) * hour;
  end = Math.ceil(end / hour) * hour;
  const placements = [...xReportPlacements],
    groupSets = xGroupSets(extra),
    active = options.active,
    windows = options.windows !== false,
    names = new Map(inventory.map(c => [String(c.id), c]));
  const plan: {t: number; stop: number; placement: string; ids: string[]; group: string[]}[] = [];
  for (let t = start; t < end; t += week) {
    const stop = Math.min(end, t + week);
    for (const placement of placements) {
      const ids = active
        ? active.entities
            .filter(
              e =>
                (e.placements === null || e.placements.includes(placement)) &&
                (!windows || (e.start < stop && e.end > t)),
            )
            .map(e => e.entity_id)
        : inventory.map(c => String(c.id));
      for (let at = 0; at < ids.length; at += 20)
        for (const group of groupSets) plan.push({t, stop, placement, ids: ids.slice(at, at + 20), group});
    }
  }
  if (plan.length > xAnalyticsRequestLimit)
    throw new MirrorError(
      'REPORT_RANGE_LIMIT',
      active
        ? 'X reported more active campaigns in this window than 100 analytics requests can cover. Split the X date range.'
        : 'Split the X date range or account to stay within 100 analytics requests.',
      {
        platform: 'x',
        planned_requests: plan.length,
        limit: xAnalyticsRequestLimit,
        ...(active ? {active_campaigns: active.entities.length} : {}),
      },
    );
  // Version 3 (RPT-03): the active-entities response and the conversion group split are part of the definition, so a
  // resumed run never mixes request plans.
  const definition = fingerprint({
      version: options.exact ? 4 : 3,
      inventory,
      active: active ? active.fingerprint : null,
      windows,
      start,
      end,
      requestedStart,
      requestedEnd,
      groupSets,
      placements,
    }),
    saved = options.checkpoint ?? {};
  if (saved.definition && saved.definition !== definition)
    throw new MirrorError(
      'REPORT_DEFINITION_CHANGED',
      'The X checkpoint does not match this frozen report. Start a new run.',
    );
  const rows = new Map<string, JsonObject>((saved.rows ?? []).map((r: JsonObject) => [r.id, structuredClone(r)])),
    warnings = new Set<string>(saved.warnings ?? []);
  if (widened)
    warnings.add(
      'X reports whole UTC hours. Boundary hours are assigned by their midpoint so adjacent local periods do not overlap; exact fractional-hour totals are unavailable.',
    );
  let complete = saved.complete ?? true,
    successful = saved.successful ?? 0,
    index = 0;
  // ACC-06 interim: X documents a fourth placement, PUBLISHER_NETWORK, that these reports do not request. Until an
  // authorized read shows whether it returns data, activity X reports there is named and the totals are partial.
  const publisher = (active?.entities ?? []).filter(e => e.placements?.includes(xPublisherNetwork)).length;
  if (publisher) {
    warnings.add(xPublisherNetworkWarning(publisher));
    complete = false;
  }
  const failures: JsonObject[] = saved.failures ?? [];
  const checkpoint = () =>
    options.save?.({
      definition,
      next: index,
      rows: [...rows.values()],
      warnings: [...warnings],
      complete,
      successful,
      failures,
    });
  for (const step of plan) {
    if (index++ < (saved.next ?? 0)) continue;
    const {t, stop, placement, group} = step,
      expected = new Set(step.ids);
    let response: JsonObject;
    try {
      response = await read({
        entity: 'CAMPAIGN',
        entity_ids: [...expected].join(','),
        start_time: xAnalyticsTime(t),
        end_time: xAnalyticsTime(stop),
        granularity: 'HOUR',
        metric_groups: group.join(','),
        placement,
      });
      successful++;
    } catch (e) {
      if (!(e instanceof MirrorError) || e.retryable || ![400, 404, 422].includes(e.status)) throw e;
      complete = false;
      const diagnostic = reportSourceError(e, {platform: 'x'});
      failures.push(diagnostic);
      warnings.add(
        'X rejected ' +
          placement +
          ' / ' +
          group.join(',') +
          ': ' +
          (diagnostic.provider?.code ?? diagnostic.code) +
          ' — ' +
          (diagnostic.provider?.message ?? diagnostic.message) +
          '. Budget guidance is withheld for incomplete coverage.',
      );
      checkpoint();
      continue;
    }
    if (!Array.isArray(response.data))
      throw new MirrorError('REPORT_SHAPE_CHANGED', 'X analytics did not return a campaign collection.');
    const seen = new Set<string>();
    for (const r of response.data) {
      if (!expected.has(r.id) || seen.has(r.id) || !Array.isArray(r.id_data))
        throw new MirrorError('REPORT_SCOPE_MISMATCH', 'X returned an unexpected or duplicated campaign.');
      seen.add(r.id);
      const old = rows.get(r.id) ?? {
        id: r.id,
        name: names.get(r.id)?.name,
        objective: names.get(r.id)?.objective,
        native_metrics: {},
      };
      for (const segment of r.id_data) {
        if (segment.segment != null) throw new MirrorError('REPORT_SHAPE_CHANGED', 'Unexpected segmented X report.');
        const add = (values: JsonObject, prefix = '', depth = 0) => {
          if (depth > 5) throw new MirrorError('REPORT_SHAPE_CHANGED', 'X metric nesting is too deep.');
          for (const [k, v] of Object.entries(values)) {
            const key = prefix ? prefix + '_' + k : k;
            if (v && typeof v === 'object' && !Array.isArray(v)) {
              add(v, key, depth + 1);
              continue;
            }
            if (v === null) {
              old.native_metrics[key] ??= options.exact ? '0' : 0;
              if (options.exact) old.provider_omitted = [...new Set([...(old.provider_omitted ?? []), key])];
              continue;
            }
            if (!Array.isArray(v) || v.length !== (stop - t) / 3600000)
              throw new MirrorError('REPORT_BUCKET_MISMATCH', 'X returned inconsistent hourly buckets.');
            let sum: number | string = options.exact ? '0' : 0;
            for (const [bucket, item] of v.entries()) {
              const midpoint = t + (bucket + 0.5) * hour;
              if (midpoint < requestedStart || midpoint >= requestedEnd) continue;
              if (item === null) {
                if (options.exact) old.provider_omitted = [...new Set([...(old.provider_omitted ?? []), key])];
                continue;
              }
              if (options.exact) {
                sum = exactNativeAdd(String(sum), item, key);
                continue;
              }
              const n = metricNumber(item);
              if (n === null) throw new MirrorError('REPORT_SHAPE_CHANGED', 'X returned a nonnumeric analytics value.');
              sum = Number(sum) + n;
            }
            old.native_metrics[key] = options.exact
              ? exactNativeAdd(old.native_metrics[key] ?? '0', sum, key)
              : (old.native_metrics[key] ?? 0) + sum;
          }
        };
        add(segment.metrics ?? {});
      }
      rows.set(r.id, old);
    }
    if (seen.size !== expected.size) {
      complete = false;
      warnings.add('X omitted requested campaign IDs; the returned subset is retained.');
    }
    checkpoint();
  }
  if (plan.length && !successful)
    throw new MirrorError(
      'PROVIDER_REPORT_FAILED',
      'X rejected every requested analytics placement: ' + [...warnings].join(' '),
      {failures},
      502,
    );
  const activeIds = new Set(active?.entities.map(e => e.entity_id) ?? []),
    noActivity = active ? inventory.filter(c => !activeIds.has(String(c.id))).length : 0,
    unlisted = active ? active.entities.filter(e => !names.has(e.entity_id)).length : 0;
  if (noActivity)
    warnings.add(
      noActivity +
        ' X campaign' +
        (noActivity === 1 ? ' has' : 's have') +
        ' no reported activity in this window (X active entities). They are not listed and are never counted as zero.',
    );
  if (unlisted)
    warnings.add(
      unlisted +
        ' active X campaign' +
        (unlisted === 1 ? ' is' : 's are') +
        ' missing from the campaign list; ' +
        (unlisted === 1 ? 'it is' : 'they are') +
        ' shown by ID.',
    );
  const n = (v: unknown, divisor = 1) => {
    if (options.exact)
      return v === undefined || v === null
        ? null
        : reportScaledText(parseProviderDecimal(v, {field: 'x_total', divisor}).scaled);
    const value = metricNumber(v);
    return value === null ? null : value / divisor;
  };
  return {
    rows: [...rows.values()].map(r => ({
      ...r,
      metrics: {
        spend: n(r.native_metrics.billed_charge_local_micro, 1e6),
        impressions: n(r.native_metrics.impressions),
        clicks: n(r.native_metrics.clicks),
        engagements: n(r.native_metrics.engagements),
        video_views: n(r.native_metrics.video_total_views),
      },
    })),
    complete,
    no_activity_count: noActivity,
    requests: plan.length,
    warnings: [
      ...warnings,
      'X null hourly values mean no reported activity and count as zero; absent metric columns remain unavailable.',
    ],
  };
}
