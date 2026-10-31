import {bad} from './workspace-core.js';
import {normalizeAccount} from './account-id.js';
import {metaWindowsMessage, metaWindowsOrdered, metaWindowsValid} from './meta-attribution-windows.js';
import {undocumentedBreakdownValue, type GuidedReporting} from './report-source.js';
import {collectMetaEvidence} from './meta-evidence.js';
import type {JsonObject} from './types.js';
import {metaAllocationDraft} from './meta-allocation-draft.js';

/**
 * Meta's guided reporting (ARC-04 stage F): what the shared guided modules (src/report-breakdowns.ts,
 * src/report-presets.ts and the modules above them) ask Meta instead of naming it: its capture presets, the Insights
 * read each defines, the checks of its evidence rows and its dimension packs. Meta's report source declares it.
 *
 * RPT-07 P1 dimension packs: campaign × age × gender, campaign × country, and campaign × publisher platform × placement
 * Insights breakdowns. Every dimension value stays the literal native value (never translated, renamed or merged).
 */

/** Meta Insights `age` buckets and `gender` values. */
export const metaAgeBuckets = Object.freeze(['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+', 'Unknown']);
export const metaGenders = Object.freeze(['female', 'male', 'unknown']);
/** Meta Insights `publisher_platform` values. Placements (`platform_position`) change often; their shape is checked. */
export const metaPublisherPlatforms = Object.freeze([
  'facebook',
  'instagram',
  'audience_network',
  'messenger',
  'threads',
  'unknown',
]);
const metaPosition = (v: unknown) => typeof v === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(v);
/** ISO 3166-1 alpha-2 country codes, or Meta's literal unknown bucket. */
const metaCountry = (v: unknown) => typeof v === 'string' && /^(?:[A-Z]{2}|unknown|Unknown)$/.test(v);

/** The mapped native dimension keys of Meta's packs and the native values each accepts. */
const dimensions: Record<string, (v: unknown) => boolean> = {
  native_age: v => typeof v === 'string' && metaAgeBuckets.includes(v),
  native_gender: v => typeof v === 'string' && metaGenders.includes(v),
  native_country: metaCountry,
  native_publisher_platform: v => typeof v === 'string' && metaPublisherPlatforms.includes(v),
  native_platform_position: metaPosition,
};

/** The Meta breakdown packs: Insights `breakdowns` and the row field each mapped dimension reads. */
export const metaBreakdownPresets: Record<string, {breakdowns: string[]; dimensions: Record<string, string>}> = {
  meta_campaign_age_gender: {breakdowns: ['age', 'gender'], dimensions: {native_age: 'age', native_gender: 'gender'}},
  meta_campaign_country: {breakdowns: ['country'], dimensions: {native_country: 'country'}},
  meta_campaign_placement: {
    breakdowns: ['publisher_platform', 'platform_position'],
    dimensions: {native_publisher_platform: 'publisher_platform', native_platform_position: 'platform_position'},
  },
};
/** Meta Insights breakdown fields AMCP never requests here; a row naming one is a different report. */
const otherMetaBreakdowns = [
  'age',
  'gender',
  'country',
  'region',
  'dma',
  'publisher_platform',
  'platform_position',
  'impression_device',
  'device_platform',
];
/**
 * The breakdown values of one Meta row (validated, in dimension order) for its grain key. A row must carry every
 * requested breakdown with a documented value and no other breakdown field.
 */
export function metaBreakdownKey(preset: string, row: JsonObject): string[] {
  const pack = metaBreakdownPresets[preset];
  if (!pack) return [];
  const requested = Object.values(pack.dimensions);
  if (otherMetaBreakdowns.some(field => !requested.includes(field) && row[field] !== undefined))
    bad('Meta returned a breakdown that was not requested.', 'REPORT_SHAPE_CHANGED');
  return Object.entries(pack.dimensions).map(([key, field]) => {
    const value = row[field];
    if (!dimensions[key]!(value)) undocumentedBreakdownValue(key);
    return String(value);
  });
}

const presets = [
  ...['campaign', 'adset', 'ad'].map(level => ({
    id: 'meta_' + level,
    name: 'Meta ' + (level === 'adset' ? 'ad set' : level) + ' performance',
    level,
    grain: (level === 'adset' ? 'ad set' : level) + ' × day',
    gateway: 'meta_native_action',
    max_rows: 10000,
    max_requests: 120,
    meaning:
      'Daily native Insights with an exact action type, explicit attribution windows and impression-time reporting. Pixel and aggregate purchase aliases are never added together. Missing action values remain unknown. Currency and timezone are verified against the account before and after complete pages; each account/page read retains a source reference.',
  })),
  // RPT-07 P1 dimension packs: campaign Insights by one native breakdown set.
  ...[
    {
      id: 'meta_campaign_age_gender',
      name: 'Meta campaign age and gender',
      grain: 'campaign × age × gender × day',
    },
    {id: 'meta_campaign_country', name: 'Meta campaign country', grain: 'campaign × country × day'},
    {
      id: 'meta_campaign_placement',
      name: 'Meta campaign placement',
      grain: 'campaign × publisher platform × placement × day',
    },
  ].map(p => ({
    ...p,
    level: 'campaign',
    breakdowns: metaBreakdownPresets[p.id]!.breakdowns,
    gateway: 'meta_native_action',
    max_rows: 10000,
    max_requests: 120,
    meaning:
      'Daily campaign Insights by the native breakdown values Meta returns (literal age, gender, country, publisher platform or placement), with an exact action type, explicit attribution windows and impression-time reporting. Account, currency, timezone, breakdown values and the campaign/breakdown/day grain are checked around complete pages. Buckets Meta does not return (privacy thresholds, no delivery) stay unknown and bucket totals need not equal campaign totals. Reach and frequency stay per bucket; Meta omits reach for breakdown reports that start more than 13 months ago.',
  })),
];

export const metaGuidedReporting: GuidedReporting = {
  dimensions,
  presets,
  presetPrefix: 'meta_',
  // DEC-01: an allocation models campaign × day evidence by native campaign ID.
  allocation: {preset: 'meta_campaign', entity: id => typeof id === 'string' && /^\d{1,40}$/.test(id)},
  presetRequest(preset, input, range) {
    const account = normalizeAccount(preset.gateway, input.account_id ?? '');
    if (!/^[1-9][0-9]{0,31}$/.test(account)) bad('Use the exact Meta advertising account ID.');
    if (typeof input.result_action_type !== 'string' || !/^[a-z][a-z0-9_.]{0,159}$/.test(input.result_action_type))
      bad('Choose the exact native Meta result action_type; overlapping aliases are never combined.');
    const windows = input.attribution_windows;
    // RPT-07: 28d_click and 1d_ev are explicit Meta windows too (central rule in meta-attribution-windows.ts).
    if (!metaWindowsValid(windows)) bad(metaWindowsMessage);
    const selected = metaWindowsOrdered(windows),
      pack = metaBreakdownPresets[preset.id];
    return {
      gateway: preset.gateway,
      account_id: account,
      connection_id: input.connection_id,
      arguments: {
        action: 'meta_ad_account_id_insights_get',
        ad_account_id: 'act_' + account,
        query: {
          fields: [
            'account_id',
            'account_currency',
            'campaign_id',
            'campaign_name',
            ...(preset.level !== 'campaign' ? ['adset_id', 'adset_name'] : []),
            ...(preset.level === 'ad' ? ['ad_id', 'ad_name'] : []),
            'date_start',
            'date_stop',
            'spend',
            'impressions',
            'clicks',
            'reach',
            'frequency',
            'actions',
            'action_values',
          ].join(','),
          level: preset.level,
          ...(pack ? {breakdowns: pack.breakdowns} : {}),
          time_range: range,
          time_increment: 1,
          action_report_time: 'impression',
          action_attribution_windows: selected,
          use_account_attribution_setting: false,
          use_unified_attribution_setting: false,
          limit: 100,
        },
        aggregate_pages: false,
        max_pages: 100,
      },
      semantics: {
        ...input.semantics,
        attribution: 'Meta ' + selected.join(' + ') + '; impression time',
        conversion_definition: input.result_action_type,
      },
      rows_pointer: '/data/data/data',
      mapping: {
        entity_id: '/' + preset.level + '_id',
        entity_name: '/' + preset.level + '_name',
        ...(pack ? Object.fromEntries(Object.entries(pack.dimensions).map(([key, field]) => [key, '/' + field])) : {}),
        date: '/date_start',
        spend: '/spend',
        impressions: '/impressions',
        clicks: '/clicks',
        reach: '/reach',
        frequency: '/frequency',
        conversions: {path: '/actions', action_type: input.result_action_type},
        conversion_value: {path: '/action_values', action_type: input.result_action_type},
      },
    };
  },
  /** Guided evidence must retain its requested native hierarchy, reporting window and grain. */
  validateRows(preset, input, rows) {
    const level = presets.find(p => p.id === preset)?.level;
    if (!level) bad('Unknown Meta preset.');
    const seen = new Set<string>(),
      parents = new Map<string, string>();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row))
        bad('Meta returned a malformed Insights row.', 'REPORT_SHAPE_CHANGED');
      if (row.account_id !== normalizeAccount('meta_native_action', input.account_id))
        bad('Meta returned an unbound or different account.', 'REPORT_ACCOUNT_MISMATCH');
      if (row.account_currency !== input.semantics.currency)
        bad('Meta returned a different or missing account currency.', 'REPORT_CURRENCY_MISMATCH');
      for (const entity of [
        'campaign',
        ...(level !== 'campaign' ? ['adset'] : []),
        ...(level === 'ad' ? ['ad'] : []),
      ]) {
        if (typeof row[entity + '_id'] !== 'string' || !/^[1-9][0-9]{0,31}$/.test(row[entity + '_id']))
          bad('Meta did not return the exact requested entity and parent IDs.', 'REPORT_SHAPE_CHANGED');
        if (entity !== 'campaign') {
          const key = entity + ':' + row[entity + '_id'],
            parent = entity === 'ad' ? row.adset_id : row.campaign_id;
          if (parents.has(key) && parents.get(key) !== parent)
            bad('Meta returned an entity under different native parents.', 'REPORT_ACCOUNT_MISMATCH');
          parents.set(key, parent);
        }
      }
      const date = row.date_start;
      if (
        typeof date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date ||
        date !== row.date_stop ||
        date < input.semantics.date_from ||
        date > input.semantics.date_to
      )
        bad('Meta returned a different reporting period or grain.', 'REPORT_DATE_MISMATCH');
      // RPT-07: a breakdown pack's grain is the entity, its breakdown values and the day.
      const key = JSON.stringify([row[level + '_id'], ...metaBreakdownKey(preset, row), date]);
      if (seen.has(key)) bad('Meta returned duplicate entity/day rows.', 'REPORT_DUPLICATE_ROWS');
      seen.add(key);
    }
  },
  // ARC-01 (reporting): a capture of a Meta preset collects complete Insights pages (src/meta-evidence.ts).
  collect: ({store, call, actor, args, semantics}) => collectMetaEvidence(store, call, actor, args, semantics),
  sourceCollection: 'meta_insights_pages',
  semanticsSource: () =>
    'Meta account currency and timezone verified before and after complete Insights pages; action/window/report-time settings come from the retained request, native account/parent/day grain is checked, and reporting-window completeness remains declared. Collection is not a point-in-time snapshot.',
  // RPT-04 (owner policy P6): guided Meta pages are complete and Meta omits zero-valued action entries.
  omittedAsZero: true,
  // Wave 4c round 6 (w4c-arc6-reporting): DEC-02's native budget draft of the allocation model (campaign or ad set).
  allocationDraft: metaAllocationDraft,
};
