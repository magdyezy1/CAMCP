// The Work-here validator as it was at commit 4035ad7c (the build production runs, and the rollback target of D21).
//
// A VENDORED, FAITHFUL COPY, kept as a fixture: it imports nothing from `src`, so the rollback tests judge what V2
// writes by what Work-here accepts, never by V2's own projection code. Do not "fix" it to follow V2; if Work-here's
// behaviour is ever re-read from its source, change this file in a commit that says why. Copied from, at 4035ad7c:
//
//   src/overview-levels.ts       14-56    overviewEntityLevels
//                                57-90    invalid, metaWindows, snapchatWindowsValid, campaignAttributionProfile
//                                91-168   overviewSourceLevel
//   src/provider-adapters.ts     678-694  Meta's explicit attribution windows (reportWindowFacts.meta)
//   src/report-metrics.ts        12-24    reportPlatforms (the names)
//                                25-68    metricDefinitions (the names, `better` and `formula`)
//                                73-80    kpiDirection, currencyTargetKey
//                                240-298  parseMetricFormula
//                                325-374  validateCustomMetrics
//                                382-391  objectiveGroups
//   src/recommendation-context.ts 4-50    validateRecommendationContext
//   src/report-periods.ts        30       reportGrains
//   src/reporting-overview.ts    321-486  ReportingOverview.config (the part that decides acceptance)
//
// Not copied, because they decide nothing about a stored definition's shape and need a running service: the connection
// check (`store.resolveConnection`), account-id normalisation, and the date-range resolution (`reportRange` of
// `resolveReportConfig`). The stored date range is the same in both builds. `fingerprint` is a stand-in (SHA-256 of
// key-sorted JSON) used only to fill `formula_fingerprint` in the result.
import {createHash} from 'node:crypto';

export const workHereCommit = '4035ad7c';

class Refused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const invalid = (message, code = 'INVALID_REPORT_LEVEL') => {
  throw new Refused(code, message);
};

// ---- src/overview-levels.ts:14-56 ----
const overviewEntityLevels = {
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

// ---- src/provider-adapters.ts:678-694 ----
const metaAttributionWindows = Object.freeze(['1d_click', '7d_click', '28d_click', '1d_view', '1d_ev']);
const metaClickWindows = Object.freeze(['1d_click', '7d_click', '28d_click']);
const metaWindows = {
  message:
    'Choose at most one click window (1d_click, 7d_click or 28d_click), with optional 1d_view and 1d_ev (engaged view), or view windows alone.',
  valid: windows =>
    Array.isArray(windows) &&
    windows.length > 0 &&
    windows.length <= 3 &&
    new Set(windows).size === windows.length &&
    windows.every(v => typeof v === 'string' && metaAttributionWindows.includes(v)) &&
    windows.filter(v => metaClickWindows.includes(v)).length <= 1,
};

// ---- src/overview-levels.ts:62-90 ----
const snapchatWindowsValid = options =>
  ['1_DAY', '7_DAY', '28_DAY'].includes(options.swipe_up_attribution_window) &&
  ['none', '1_HOUR', '3_HOUR', '6_HOUR', '1_DAY', '7_DAY'].includes(options.view_attribution_window) &&
  !(options.view_attribution_window === '7_DAY' && options.swipe_up_attribution_window === '1_DAY');
function campaignAttributionProfile(source) {
  const options = source.report_options;
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

// ---- src/overview-levels.ts:91-168 ----
export function overviewSourceLevel(source, template = false) {
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
  return selected;
}

// ---- src/report-metrics.ts:12-24 (the platform names), 25-68, 73-80, 382-391 ----
const reportPlatforms = new Set([
  'google',
  'meta',
  'tiktok',
  'snapchat',
  'linkedin',
  'x',
  'microsoft',
  'apple',
  'reddit',
  'ga4',
  'gsc',
]);
const metricDefinitions = {
  spend: {},
  impressions: {},
  clicks: {},
  conversions: {},
  conversion_value: {},
  reach: {},
  frequency: {},
  video_views: {},
  video_completions: {},
  engagements: {},
  leads: {},
  purchases: {},
  installs: {},
  sessions: {},
  users: {},
  position: {},
  ctr: {better: 'higher'},
  cpc: {better: 'lower'},
  cpm: {better: 'lower'},
  cpa: {better: 'lower'},
  cpl: {better: 'lower'},
  cpi: {better: 'lower'},
  cpv: {better: 'lower'},
  roas: {better: 'higher'},
  conversion_rate: {better: 'higher'},
  video_completion_rate: {better: 'higher'},
};
function kpiDirection(kpi) {
  if (kpi === 'cost_per_engagement') return 'lower';
  const better =
    typeof kpi === 'string' && Object.hasOwn(metricDefinitions, kpi) ? metricDefinitions[kpi].better : null;
  return better === 'higher' || better === 'lower' ? better : null;
}
const currencyTargetKey = /^([a-z_]+):([A-Z]{3})$/;
const objectiveGroups = [
  'awareness',
  'traffic',
  'engagement',
  'video_views',
  'leads',
  'sales',
  'app_installs',
  'unknown',
];
const reportGrains = ['total', 'daily', 'weekly', 'monthly']; // src/report-periods.ts:30

// ---- src/report-metrics.ts:245-298 ----
function parseMetricFormula(source, known) {
  if (typeof source !== 'string' || source.length < 1 || source.length > 500)
    throw new Refused('INVALID_FORMULA', 'Use a formula of 1–500 characters.');
  const tokens = source.match(/(?:\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[()+\-*/])/g) ?? [];
  if (tokens.join('') !== source.replace(/\s/g, '') || tokens.length > 120)
    throw new Refused(
      'INVALID_FORMULA',
      'Use metric names, numbers, parentheses and + − * /. Functions and code are not accepted.',
    );
  let pos = 0;
  const dependencies = new Set();
  const atom = depth => {
    if (depth > 20) throw new Refused('INVALID_FORMULA', 'Formula nesting is too deep.');
    const token = tokens[pos++];
    if (token === '-') return {kind: 'unary', value: atom(depth + 1)};
    if (token === '+') return atom(depth + 1);
    if (token === '(') {
      const n = expression(0, depth + 1);
      if (tokens[pos++] !== ')') throw new Refused('INVALID_FORMULA', 'Close each parenthesis.');
      return n;
    }
    if (token && /^\d/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
        throw new Refused('INVALID_FORMULA', 'Numeric constant is out of range.');
      return {kind: 'value', value};
    }
    if (
      token &&
      /^[A-Za-z_]/.test(token) &&
      !['constructor', 'prototype', '__proto__', 'Infinity', 'NaN'].includes(token)
    ) {
      if (known && !known.has(token)) throw new Refused('UNKNOWN_METRIC', 'Unknown metric: ' + token);
      dependencies.add(token);
      return {kind: 'field', name: token};
    }
    throw new Refused('INVALID_FORMULA', 'Expected a metric, number or parenthesis.');
  };
  const expression = (precedence, depth) => {
    let left = atom(depth);
    while (pos < tokens.length) {
      const op = tokens[pos],
        rank = op === '+' || op === '-' ? 1 : op === '*' || op === '/' ? 2 : 0;
      if (rank <= precedence) break;
      pos++;
      left = {kind: 'binary', op, left, right: expression(rank, depth + 1)};
    }
    return left;
  };
  const tree = expression(0, 0);
  if (pos !== tokens.length) throw new Refused('INVALID_FORMULA', 'Unexpected formula token.');
  return {tree, dependencies: [...dependencies]};
}

// ---- src/report-metrics.ts:325-374 ----
function validateCustomMetrics(input, native = []) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 30)
    throw new Refused('INVALID_CUSTOM_METRICS', 'Use at most 30 custom metrics.');
  const ids = new Set();
  for (const m of input) {
    if (
      !m ||
      typeof m !== 'object' ||
      !/^[a-z][a-z0-9_]{0,47}$/.test(m.id) ||
      ['constructor', 'prototype', '__proto__'].includes(m.id) ||
      ids.has(m.id) ||
      Object.hasOwn(metricDefinitions, m.id) ||
      m.id.startsWith('native_') ||
      typeof m.label !== 'string' ||
      !m.label.trim() ||
      m.label.length > 80 ||
      !['number', 'decimal', 'percent', 'currency'].includes(m.format ?? 'decimal')
    )
      throw new Refused(
        'INVALID_CUSTOM_METRICS',
        'Custom metrics need a unique identifier, label, formula and valid format.',
      );
    ids.add(m.id);
  }
  const known = new Set([...Object.keys(metricDefinitions), ...native, ...ids]),
    byId = new Map(input.map(m => [m.id, m])),
    visiting = new Set(),
    done = new Set(),
    ordered = [];
  const visit = id => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Refused('METRIC_CYCLE', 'Custom metric formulas contain a cycle.');
    visiting.add(id);
    const m = byId.get(id),
      parsed = parseMetricFormula(m.formula, known);
    for (const d of parsed.dependencies) if (byId.has(d)) visit(d);
    visiting.delete(id);
    done.add(id);
    ordered.push({
      id: m.id,
      label: m.label.trim(),
      formula: m.formula,
      format: m.format ?? 'decimal',
      dependencies: parsed.dependencies,
    });
  };
  for (const id of ids) visit(id);
  return ordered;
}

// ---- src/recommendation-context.ts:4-50 ----
function validateRecommendationContext(p, known) {
  const c = p.context;
  if (c === undefined) return;
  if (
    !c ||
    typeof c !== 'object' ||
    Array.isArray(c) ||
    Object.keys(c).some(
      k =>
        ![
          'note',
          'seasonal_event',
          'recent_change',
          'tracking_verified',
          'capacity_available',
          'budget_available',
          'secondary_kpi',
          'current_daily_budget',
          'maximum_daily_budget',
        ].includes(k),
    )
  )
    throw new Refused('INVALID_TARGET', 'Use supported recommendation context fields.');
  for (const k of ['note', 'seasonal_event'])
    if (c[k] !== undefined && (typeof c[k] !== 'string' || c[k].length > 1000))
      throw new Refused('INVALID_TARGET', 'Business context text is limited to 1,000 characters.');
  for (const k of ['recent_change', 'tracking_verified', 'capacity_available', 'budget_available'])
    if (c[k] !== undefined && typeof c[k] !== 'boolean')
      throw new Refused('INVALID_TARGET', 'Recommendation context flags must be booleans.');
  for (const k of ['current_daily_budget', 'maximum_daily_budget'])
    if (c[k] !== undefined && (typeof c[k] !== 'number' || !Number.isFinite(c[k]) || c[k] < 0))
      throw new Refused('INVALID_TARGET', 'Budget context must use nonnegative amounts in the target currency.');
  const s = c.secondary_kpi;
  if (
    s !== undefined &&
    (!s ||
      !known.has(s.kpi) ||
      typeof s.target !== 'number' ||
      !Number.isFinite(s.target) ||
      s.target <= 0 ||
      !['higher', 'lower'].includes(s.direction))
  )
    throw new Refused(
      'INVALID_TARGET',
      'A secondary KPI needs a valid metric, positive target and higher/lower direction.',
    );
}

const fingerprint = value =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
          : v,
      ),
    )
    .digest('hex');

// ---- src/reporting-overview.ts:321-486, the acceptance decision. `legacyTargets` is true for a stored definition. ----
export function workHereConfig(input, template = false, legacyTargets = false) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.length > 100
  )
    throw new Refused('INVALID_REPORT', 'Name this report (1–100 characters).');
  if (!Array.isArray(input.sources) || (!template && !input.sources.length) || input.sources.length > 30)
    throw new Refused('REPORT_SOURCES_REQUIRED', 'Choose between 1 and 30 platform accounts.');
  const seen = new Set();
  input = structuredClone(input);
  for (const s of input.sources) {
    if (
      !s ||
      !reportPlatforms.has(s.platform) ||
      typeof s.account_id !== 'string' ||
      typeof s.connection_id !== 'string'
    )
      throw new Refused('INVALID_REPORT_SOURCE', 'Choose a platform, connection and account.');
    const key = s.platform + ':' + s.account_id.replace(/^act_/, '');
    if (seen.has(key))
      throw new Refused('DUPLICATE_REPORT_ACCOUNT', 'Select an account once, even if it has multiple connections.');
    seen.add(key);
    if (s.objective !== undefined && !objectiveGroups.includes(s.objective))
      throw new Refused('INVALID_OBJECTIVE', 'Choose a supported objective.');
    if (
      s.native_metrics !== undefined &&
      (!Array.isArray(s.native_metrics) ||
        s.native_metrics.length > 30 ||
        s.native_metrics.some(m => typeof m !== 'string' || !/^(metrics\.)?[A-Za-z][A-Za-z0-9_]{0,90}$/.test(m)))
    )
      throw new Refused('INVALID_NATIVE_METRICS', 'Use native metric names, without query expressions.');
    overviewSourceLevel(s);
  }
  if (input.client_name !== undefined && (typeof input.client_name !== 'string' || input.client_name.length > 100))
    throw new Refused('INVALID_REPORT', 'Use a client name of at most 100 characters.');
  if (input.grain !== undefined && !reportGrains.includes(input.grain))
    throw new Refused('INVALID_REPORT_GRAIN', 'Choose total, daily, weekly or monthly grouping.');
  const defaults = input.source_defaults ?? {};
  if (
    !defaults ||
    typeof defaults !== 'object' ||
    Array.isArray(defaults) ||
    Object.keys(defaults).some(p => !reportPlatforms.has(p))
  )
    throw new Refused('INVALID_REPORT_SOURCE', 'Template defaults must name supported reporting platforms.');
  for (const d of Object.values(defaults))
    if (
      !d ||
      typeof d !== 'object' ||
      Array.isArray(d) ||
      Object.keys(d).some(k => !['objective', 'native_metrics', 'level', 'report_options'].includes(k)) ||
      (d.objective !== undefined && !objectiveGroups.includes(d.objective)) ||
      (d.native_metrics !== undefined &&
        (!Array.isArray(d.native_metrics) ||
          d.native_metrics.length > 30 ||
          d.native_metrics.some(m => typeof m !== 'string' || !/^(metrics\.)?[A-Za-z][A-Za-z0-9_]{0,90}$/.test(m))))
    )
      throw new Refused(
        'INVALID_REPORT_SOURCE',
        'Use objective and native metric names for template defaults, without account identities.',
      );
  for (const [platform, value] of Object.entries(input.source_defaults ?? {}))
    overviewSourceLevel({platform, ...value}, true);
  if (
    input.objectives !== undefined &&
    (!Array.isArray(input.objectives) || input.objectives.some(o => !objectiveGroups.includes(String(o))))
  )
    throw new Refused('INVALID_OBJECTIVE', 'Select valid objectives.');
  const nativeNames = new Set();
  for (const m of input.custom_metrics ?? [])
    for (const d of parseMetricFormula(m.formula).dependencies)
      if (/^native_[a-z][a-zA-Z0-9_]{1,150}$/.test(d)) nativeNames.add(d);
  const custom = validateCustomMetrics(input.custom_metrics, [...nativeNames]),
    known = new Set([...Object.keys(metricDefinitions), ...custom.map(m => m.id)]);
  const metrics = input.metrics ?? ['spend', 'impressions', 'clicks', 'conversions', 'cpa', 'roas'];
  if (
    !Array.isArray(metrics) ||
    !metrics.length ||
    metrics.length > 80 ||
    metrics.some(m => typeof m !== 'string' || (!known.has(m) && !/^native_[a-z][a-zA-Z0-9_]{1,150}$/.test(m)))
  )
    throw new Refused('INVALID_METRICS', 'Select valid common, native or custom metrics.');
  const policies = input.targets ?? {};
  if (!policies || typeof policies !== 'object' || Array.isArray(policies) || Object.keys(policies).length > 500)
    throw new Refused('INVALID_TARGET', 'Use objective or campaign target settings.');
  for (const [key, p] of Object.entries(policies)) {
    if (p && typeof p === 'object') validateRecommendationContext(p, known);
    if (
      !p ||
      typeof p !== 'object' ||
      typeof p.target !== 'number' ||
      !Number.isFinite(p.target) ||
      p.target <= 0 ||
      typeof p.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(p.currency) ||
      (p.kpi !== undefined && !known.has(p.kpi) && p.kpi !== 'cost_per_engagement') ||
      (p.direction !== undefined && !['higher', 'lower'].includes(p.direction)) ||
      (p.minimum_results !== undefined &&
        (!Number.isInteger(p.minimum_results) || p.minimum_results < 1 || p.minimum_results > 1000000)) ||
      (p.conversion_lag_days !== undefined &&
        (!Number.isInteger(p.conversion_lag_days) || p.conversion_lag_days < 0 || p.conversion_lag_days > 90)) ||
      (p.maximum_change_percent !== undefined &&
        (typeof p.maximum_change_percent !== 'number' ||
          p.maximum_change_percent < 1 ||
          p.maximum_change_percent > 20)) ||
      (p.result_metric !== undefined && !known.has(p.result_metric))
    )
      throw new Refused(
        'INVALID_TARGET',
        'Targets need a positive value, ISO currency, valid KPI and sensible sample/lag limits.',
      );
    const currencyKey = currencyTargetKey.exec(key);
    if (currencyKey && (!objectiveGroups.includes(currencyKey[1]) || p.currency !== currencyKey[2]))
      throw new Refused(
        'INVALID_TARGET',
        'Key a currency target as objective:CURRENCY, for example sales:SAR, with the same target currency.',
      );
    if (!legacyTargets && p.kpi !== undefined && p.direction === undefined && !kpiDirection(p.kpi))
      throw new Refused(
        'INVALID_TARGET',
        'Set direction to higher or lower for this KPI; its better direction cannot be derived.',
      );
    if (
      p.minimum_spend !== undefined &&
      (typeof p.minimum_spend !== 'number' || !Number.isFinite(p.minimum_spend) || p.minimum_spend < 0)
    )
      throw new Refused('INVALID_TARGET', 'Use a nonnegative minimum spend in the target currency.');
  }
  if (input.partial_delivery !== undefined && !['allow_marked', 'complete_only'].includes(input.partial_delivery))
    throw new Refused('INVALID_REPORT', 'Choose marked partial delivery or complete reports only.');
  return {
    formula_version: 'arithmetic-v1',
    formula_fingerprint: fingerprint(custom),
    source_contract_version: 'campaign-source-v4',
    partial_delivery: input.partial_delivery ?? 'allow_marked',
    name: input.name.trim(),
    client_name: (input.client_name ?? '').trim(),
    grain: input.grain ?? 'total',
    sources: structuredClone(input.sources),
    source_defaults: defaults,
    date_range: input.date_range,
    metrics: [...new Set(metrics)],
    custom_metrics: custom,
    targets: policies,
    objectives: input.objectives ?? [],
    version: 1,
  };
}

/** The levels Work-here can collect for a platform: campaign, and each level it has a qualified preset for (overviewSourceLevel). */
export const workHereLevels = platform => [
  'campaign',
  ...(overviewEntityLevels[platform] ?? []).filter(item => item.preset).map(item => item.id),
];

/**
 * What Work-here's `run` and scheduler `tick` decide for a stored definition: accepted, with the config it would
 * store, or refused with the code its `config()` throws (a schedule is then paused with that error).
 * A stored definition is checked with `legacyTargets` (src/reporting-overview.ts:871 at 4035ad7c), a template as one.
 */
export function workHereValidates(config, {template = false} = {}) {
  try {
    return {ok: true, config: workHereConfig(config, template, true)};
  } catch (error) {
    if (error instanceof Refused) return {ok: false, code: error.code, message: error.message};
    throw error;
  }
}
