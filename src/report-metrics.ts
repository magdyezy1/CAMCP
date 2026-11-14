import {recommendationContext} from './recommendation-context.js';
import {zonedMidnight} from './workflows.js';
import {MirrorError} from './errors.js';
import {providerById} from './provider-adapters.js';
import type {JsonObject} from './types.js';

/**
 * A reporting platform (ARC-01): it reports through the gateway of the provider adapter with the same ID
 * (src/provider-adapters.ts); its display name and source kind are reporting's own.
 */
const reportPlatform = (id: string, name: string, kind: string) => ({name, gateway: providerById(id)!.gateway, kind});
export const reportPlatforms: Record<string, {name: string; gateway: string; kind: string}> = {
  google: reportPlatform('google', 'Google Ads', 'paid'),
  meta: reportPlatform('meta', 'Meta', 'paid'),
  tiktok: reportPlatform('tiktok', 'TikTok', 'paid'),
  snapchat: reportPlatform('snapchat', 'Snapchat', 'paid'),
  linkedin: reportPlatform('linkedin', 'LinkedIn', 'paid'),
  x: reportPlatform('x', 'X Ads', 'paid'),
  microsoft: reportPlatform('microsoft', 'Microsoft Ads', 'paid'),
  apple: reportPlatform('apple', 'Apple Ads', 'paid'),
  reddit: reportPlatform('reddit', 'Reddit Ads', 'paid'),
  ga4: reportPlatform('ga4', 'Google Analytics 4', 'measurement'),
  gsc: reportPlatform('gsc', 'Search Console', 'organic'),
};
export const metricDefinitions: Record<string, JsonObject> = {
  spend: {label: 'Spend', format: 'currency', aggregation: 'sum'},
  impressions: {label: 'Impressions', format: 'number', aggregation: 'sum'},
  clicks: {label: 'Clicks / taps / swipes', format: 'number', aggregation: 'sum'},
  conversions: {label: 'Primary conversions', format: 'number', aggregation: 'sum'},
  conversion_value: {label: 'Conversion value', format: 'currency', aggregation: 'sum'},
  reach: {label: 'Reach', format: 'number', aggregation: 'non_additive'},
  frequency: {label: 'Frequency', format: 'decimal', aggregation: 'non_additive'},
  video_views: {label: 'Video views', format: 'number', aggregation: 'sum'},
  video_completions: {label: 'Video completions', format: 'number', aggregation: 'sum'},
  engagements: {label: 'Engagements', format: 'number', aggregation: 'sum'},
  leads: {label: 'Leads', format: 'number', aggregation: 'sum'},
  purchases: {label: 'Purchases', format: 'number', aggregation: 'sum'},
  installs: {label: 'Installs', format: 'number', aggregation: 'sum'},
  sessions: {label: 'Sessions', format: 'number', aggregation: 'sum'},
  users: {label: 'Users', format: 'number', aggregation: 'non_additive'},
  position: {label: 'Average search position', format: 'decimal', aggregation: 'non_additive'},
  // `better` is each KPI's target direction (DEC-01): the default when a target omits `direction`.
  ctr: {label: 'Click-through rate', format: 'percent', formula: 'clicks / impressions * 100', better: 'higher'},
  cpc: {label: 'Cost per click', format: 'currency', formula: 'spend / clicks', better: 'lower'},
  cpm: {
    label: 'Cost per 1,000 impressions',
    format: 'currency',
    formula: 'spend / impressions * 1000',
    better: 'lower',
  },
  cpa: {label: 'Cost per conversion', format: 'currency', formula: 'spend / conversions', better: 'lower'},
  cpl: {label: 'Cost per lead', format: 'currency', formula: 'spend / leads', better: 'lower'},
  cpi: {label: 'Cost per install', format: 'currency', formula: 'spend / installs', better: 'lower'},
  cpv: {label: 'Cost per video view', format: 'currency', formula: 'spend / video_views', better: 'lower'},
  roas: {label: 'Return on ad spend', format: 'decimal', formula: 'conversion_value / spend', better: 'higher'},
  conversion_rate: {
    label: 'Conversion rate',
    format: 'percent',
    formula: 'conversions / clicks * 100',
    better: 'higher',
  },
  video_completion_rate: {
    label: 'Video completion rate',
    format: 'percent',
    formula: 'video_completions / video_views * 100',
    better: 'higher',
  },
};
/** The v4 result is selected by the source's native definition, never by summing a generic result column. */
export const reportMetricDefinitionsV4: Record<string, JsonObject> = {
  ...metricDefinitions,
  primary_result: {label: 'Primary result', format: 'number', aggregation: 'result_definition'},
  cost_per_result: {label: 'Cost per result', format: 'currency', aggregation: 'result_ratio', better: 'lower'},
};
/**
 * The derivable target direction of a KPI, or null when a target must declare it (custom, native and additive
 * metrics). cost_per_engagement is the engagement objective's built-in cost KPI.
 */
export function kpiDirection(kpi: unknown): 'higher' | 'lower' | null {
  if (kpi === 'cost_per_engagement' || kpi === 'cost_per_result') return 'lower';
  const better =
    typeof kpi === 'string' && Object.hasOwn(metricDefinitions, kpi) ? metricDefinitions[kpi]!.better : null;
  return better === 'higher' || better === 'lower' ? better : null;
}
/** A currency-specific objective target key, for example "sales:SAR" (DEC-01). */
export const currencyTargetKey = /^([a-z_]+):([A-Z]{3})$/;
/** Recommendations are computed once at capture and stay valid for the 48-hour freshness window (DEC-01). */
export const recommendationValidityMs = 48 * 3600000;
/**
 * The decision an export may show at `now`: frozen recommendations past `valid_until` (or, for snapshots without it,
 * 48 hours after capture) are rendered as expired instead of current advice. The stored snapshot is unchanged.
 */
export function exportedRecommendation(row: JsonObject, now = Date.now()): {decision: string; reason: string} {
  const r = row.recommendation ?? {},
    validUntil =
      typeof r.valid_until === 'number'
        ? r.valid_until
        : typeof row.captured_at === 'number'
          ? row.captured_at + recommendationValidityMs
          : null;
  if (validUntil === null || now <= validUntil) return {decision: r.decision, reason: r.reason};
  return {
    decision: 'expired',
    reason:
      'Expired — refresh before acting. Valid until ' +
      new Date(validUntil).toISOString() +
      '; original decision: ' +
      String(r.decision ?? 'unknown') +
      '.',
  };
}
/** One platform's source of a shared metric: a native field (`path` locates it in the provider row) or a rule. */
export interface MetricSource {
  from: string;
  path?: string;
  divisor?: number;
  note?: string;
}
const sourceField = (from: string, path = from, divisor?: number, note?: string): MetricSource => ({
  from,
  path,
  ...(divisor ? {divisor} : {}),
  ...(note ? {note} : {}),
});
const sourceRule = (from: string, note?: string): MetricSource => ({from, ...(note ? {note} : {})});
const metaActionSource = (types: string, field = 'actions') => sourceRule(field + ': the first reported of ' + types);
/**
 * ACC-06: AMCP reads Reddit's CONVERSION_PURCHASE_TOTAL_VALUE as cents, while SPEND is in micros (1e6). No primary
 * Reddit field reference or closed-week read against the Reddit UI confirms that unit yet, so a report that reads it
 * carries redditValueUnitWarning (report-native.ts). This one constant is the divisor of both sites, normalizeNativeRow
 * and metricSources; the authorized check (docs/acceptance/READ-ACCEPTANCE.md) confirms or corrects it, and a
 * correction applies to new snapshots only.
 */
export const redditConversionValueDivisor = 100;
/**
 * Where each platform's value of a shared metric comes from, exactly as normalizeNativeRow (report-native.ts) and, for
 * X, xCampaignReport compute it. "Conversions" is a different native measure on every platform, so the reporting view
 * shows this next to the numbers. A metric a platform does not list stays empty for it.
 * tests/report-metric-sources.test.mjs keeps this table true.
 */
export const metricSources: Record<string, Record<string, MetricSource>> = {
  google: {
    spend: sourceField('metrics.cost_micros', 'metrics.costMicros', 1e6),
    impressions: sourceField('metrics.impressions'),
    clicks: sourceField('metrics.clicks'),
    conversions: sourceField('metrics.conversions', undefined, undefined, 'conversion actions included in Conversions'),
    conversion_value: sourceField('metrics.conversions_value', 'metrics.conversionsValue'),
    video_views: sourceField('metrics.video_views', 'metrics.videoViews'),
    engagements: sourceField('metrics.engagements'),
  },
  meta: {
    spend: sourceField('spend'),
    impressions: sourceField('impressions'),
    clicks: sourceField('clicks'),
    reach: sourceField('reach'),
    frequency: sourceField('frequency'),
    leads: metaActionSource('lead, onsite_conversion.lead_grouped, offsite_conversion.fb_pixel_lead'),
    purchases: metaActionSource('purchase, omni_purchase, offsite_conversion.fb_pixel_purchase'),
    installs: metaActionSource('mobile_app_install, app_install'),
    conversions: sourceRule(
      'leads, installs or purchases, by the campaign objective',
      'empty for awareness, traffic, engagement and video objectives',
    ),
    conversion_value: metaActionSource(
      'purchase, omni_purchase, offsite_conversion.fb_pixel_purchase',
      'action_values',
    ),
    video_views: metaActionSource('video_view'),
    engagements: metaActionSource('post_engagement'),
  },
  tiktok: {
    spend: sourceField('spend', 'metrics.spend'),
    impressions: sourceField('impressions', 'metrics.impressions'),
    clicks: sourceField('clicks', 'metrics.clicks'),
    conversions: sourceField('conversion', 'metrics.conversion', undefined, 'the optimization event of each ad group'),
    reach: sourceField('reach', 'metrics.reach'),
    frequency: sourceField('frequency', 'metrics.frequency'),
    video_views: sourceField('video_play_actions', 'metrics.video_play_actions'),
    video_completions: sourceField('video_views_p100', 'metrics.video_views_p100'),
    purchases: sourceField('total_purchase', 'metrics.total_purchase'),
    conversion_value: sourceField('total_purchase_value', 'metrics.total_purchase_value'),
  },
  snapchat: {
    spend: sourceField('spend', 'stats.spend', 1e6),
    impressions: sourceField('impressions', 'stats.impressions'),
    clicks: sourceField('swipes', 'stats.swipes'),
    purchases: sourceField('conversion_purchases', 'stats.conversion_purchases'),
    conversion_value: sourceField('conversion_purchases_value', 'stats.conversion_purchases_value', 1e6),
    leads: sourceField('conversion_sign_ups', 'stats.conversion_sign_ups'),
    installs: sourceField('total_installs', 'stats.total_installs'),
    video_views: sourceField('video_views', 'stats.video_views'),
    video_completions: sourceField('view_completion', 'stats.view_completion'),
    conversions: sourceRule('installs, leads or purchases, by the campaign objective', 'empty for other objectives'),
  },
  linkedin: {
    spend: sourceField('costInLocalCurrency'),
    impressions: sourceField('impressions'),
    clicks: sourceField('clicks'),
    conversions: sourceField('externalWebsiteConversions'),
    conversion_value: sourceField('conversionValueInLocalCurrency'),
    leads: sourceField('oneClickLeads'),
    video_views: sourceField('videoViews'),
    video_completions: sourceField('videoCompletions'),
  },
  x: {
    spend: sourceRule('billed_charge_local_micro ÷ 1,000,000'),
    impressions: sourceRule('impressions'),
    clicks: sourceRule('clicks'),
    engagements: sourceRule('engagements'),
    video_views: sourceRule('video_total_views'),
  },
  microsoft: {
    spend: sourceField('Spend'),
    impressions: sourceField('Impressions'),
    clicks: sourceField('Clicks'),
    conversions: sourceField('Conversions'),
    conversion_value: sourceField('Revenue'),
  },
  apple: {
    spend: sourceField('localSpend.amount', 'totalMetrics.localSpend.amount'),
    impressions: sourceField('impressions', 'totalMetrics.impressions'),
    clicks: sourceField('taps', 'totalMetrics.taps'),
    installs: sourceField('totalInstalls', 'totalMetrics.totalInstalls'),
    conversions: sourceField('totalInstalls', 'totalMetrics.totalInstalls', undefined, 'installs'),
  },
  reddit: {
    spend: sourceField('spend', 'spend', 1e6),
    impressions: sourceField('impressions'),
    clicks: sourceField('clicks'),
    purchases: sourceField('conversion_purchase_total_items'),
    conversion_value: sourceField(
      'conversion_purchase_total_value',
      'conversion_purchase_total_value',
      redditConversionValueDivisor,
    ),
  },
  ga4: {
    sessions: sourceField('sessions'),
    users: sourceField('totalUsers'),
    conversions: sourceField('keyEvents', undefined, undefined, 'key events'),
    conversion_value: sourceField('totalRevenue'),
    purchases: sourceField('ecommercePurchases'),
  },
  gsc: {clicks: sourceField('clicks'), impressions: sourceField('impressions'), position: sourceField('position')},
};
type Node =
  | {kind: 'value'; value: number}
  | {kind: 'field'; name: string}
  | {kind: 'unary'; value: Node}
  | {kind: 'binary'; op: string; left: Node; right: Node};
export function parseMetricFormula(source: unknown, known?: Set<string>): {tree: Node; dependencies: string[]} {
  if (typeof source !== 'string' || source.length < 1 || source.length > 500)
    throw new MirrorError('INVALID_FORMULA', 'Use a formula of 1–500 characters.');
  const tokens = source.match(/(?:\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[()+\-*/])/g) ?? [];
  if (tokens.join('') !== source.replace(/\s/g, '') || tokens.length > 120)
    throw new MirrorError(
      'INVALID_FORMULA',
      'Use metric names, numbers, parentheses and + − * /. Functions and code are not accepted.',
    );
  let pos = 0;
  const dependencies = new Set<string>();
  const atom = (depth: number): Node => {
    if (depth > 20) throw new MirrorError('INVALID_FORMULA', 'Formula nesting is too deep.');
    const token = tokens[pos++];
    if (token === '-') return {kind: 'unary', value: atom(depth + 1)};
    if (token === '+') return atom(depth + 1);
    if (token === '(') {
      const n = expression(0, depth + 1);
      if (tokens[pos++] !== ')') throw new MirrorError('INVALID_FORMULA', 'Close each parenthesis.');
      return n;
    }
    if (token && /^\d/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
        throw new MirrorError('INVALID_FORMULA', 'Numeric constant is out of range.');
      return {kind: 'value', value};
    }
    if (
      token &&
      /^[A-Za-z_]/.test(token) &&
      !['constructor', 'prototype', '__proto__', 'Infinity', 'NaN'].includes(token)
    ) {
      if (known && !known.has(token))
        throw new MirrorError('UNKNOWN_METRIC', 'Unknown metric: ' + token, {metric: token});
      dependencies.add(token);
      return {kind: 'field', name: token};
    }
    throw new MirrorError('INVALID_FORMULA', 'Expected a metric, number or parenthesis.');
  };
  const expression = (precedence: number, depth: number): Node => {
    let left = atom(depth);
    while (pos < tokens.length) {
      const op = tokens[pos]!,
        rank = op === '+' || op === '-' ? 1 : op === '*' || op === '/' ? 2 : 0;
      if (rank <= precedence) break;
      pos++;
      left = {kind: 'binary', op, left, right: expression(rank, depth + 1)};
    }
    return left;
  };
  const tree = expression(0, 0);
  if (pos !== tokens.length) throw new MirrorError('INVALID_FORMULA', 'Unexpected formula token.');
  return {tree, dependencies: [...dependencies]};
}
export function evaluateMetric(tree: Node, values: JsonObject): number | null {
  if (tree.kind === 'value') return tree.value;
  if (tree.kind === 'field') return metricNumber(values[tree.name]);
  if (tree.kind === 'unary') {
    const n = evaluateMetric(tree.value, values);
    return n === null ? null : -n;
  }
  const a = evaluateMetric(tree.left, values),
    b = evaluateMetric(tree.right, values);
  if (a === null || b === null || (tree.op === '/' && b === 0)) return null;
  const n = tree.op === '+' ? a + b : tree.op === '-' ? a - b : tree.op === '*' ? a * b : a / b;
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : null;
}
export function metricNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value);
  if (!/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text)) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER)
    throw new MirrorError(
      'METRIC_PRECISION_LOSS',
      'A metric exceeds supported numeric precision. Use the retained native source.',
    );
  return n;
}
export function validateCustomMetrics(input: unknown, native: string[] = []): JsonObject[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 30)
    throw new MirrorError('INVALID_CUSTOM_METRICS', 'Use at most 30 custom metrics.');
  const ids = new Set<string>();
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
      throw new MirrorError(
        'INVALID_CUSTOM_METRICS',
        'Custom metrics need a unique identifier, label, formula and valid format.',
      );
    ids.add(m.id);
  }
  const known = new Set([...Object.keys(metricDefinitions), ...native, ...ids]),
    byId = new Map(input.map(m => [m.id, m])),
    visiting = new Set<string>(),
    done = new Set<string>(),
    ordered: JsonObject[] = [];
  const visit = (id: string) => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new MirrorError('METRIC_CYCLE', 'Custom metric formulas contain a cycle.');
    visiting.add(id);
    const m = byId.get(id)!,
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
export function calculateMetrics(metrics: JsonObject, custom: JsonObject[] = []) {
  const values = {...metrics};
  for (const [id, m] of Object.entries(metricDefinitions))
    if (m.formula) values[id] = evaluateMetric(parseMetricFormula(m.formula).tree, values);
  for (const m of custom) values[m.id] = evaluateMetric(parseMetricFormula(m.formula).tree, values);
  return values;
}
export const objectiveGroups = [
  'awareness',
  'traffic',
  'engagement',
  'video_views',
  'leads',
  'sales',
  'app_installs',
  'unknown',
];
export function objectiveGroup(value: unknown): string {
  const s = String(value ?? '').toUpperCase();
  if (/LEAD/.test(s)) return 'leads';
  if (/APP_INSTALL|APP_PROMOTION|APP_DOWNLOAD|MOBILE_APP/.test(s)) return 'app_installs';
  if (/SALE|PURCHASE|CONVERSION|CATALOG|WEBSITE_CONVERSIONS/.test(s)) return 'sales';
  if (/VIDEO/.test(s)) return 'video_views';
  if (/TRAFFIC|CLICK|WEBSITE_VISIT/.test(s)) return 'traffic';
  if (/ENGAGEMENT|INTERACTION|FOLLOWER/.test(s)) return 'engagement';
  if (/AWARENESS|REACH|IMPRESSION|BRAND/.test(s)) return 'awareness';
  return 'unknown';
}
/**
 * The value a platform's v3 row takes for the objective group of its native objective: `values.leads`,
 * `values.app_installs` or `values.sales`, and `none` for every other group. The one place that reads the group's regex
 * for that choice, so a platform names what each group means instead of repeating the test.
 */
export function byObjectiveGroup<T>(objective: unknown, values: {leads: T; app_installs: T; sales: T}, none: T): T {
  const group = objectiveGroup(objective);
  return group === 'leads'
    ? values.leads
    : group === 'app_installs'
      ? values.app_installs
      : group === 'sales'
        ? values.sales
        : none;
}
export interface ReportAdviceMath {
  formula(formula: string, values: JsonObject): string | null;
  compare(a: unknown, b: unknown, factor?: unknown): number;
  primaryResult?: true;
}
export function campaignRecommendation(
  row: JsonObject,
  policy: JsonObject = {},
  now = Date.now(),
  math?: ReportAdviceMath,
): JsonObject {
  const result = (decision: string, reason: string, evidence: JsonObject = {}) => ({
    decision,
    reason,
    evidence,
    confidence: ['scale', 'maintain', 'pull_back'].includes(decision) ? 'moderate' : 'limited',
    limitations: ['Observational evidence does not establish causality or adjust for seasonality.'],
    objective: row.objective_group,
    automatic_execution: false,
    requires_review: true,
    // Frozen with an as-of label (owner policy P6): exports render it expired after valid_until.
    as_of: typeof row.captured_at === 'number' ? row.captured_at : null,
    valid_until: typeof row.captured_at === 'number' ? row.captured_at + recommendationValidityMs : null,
  });
  if (row.source_kind !== 'paid')
    return result(
      'observe',
      'Measurement and organic reports provide context; they do not establish an advertising budget action.',
    );
  // RPT-02: completeness holds come before any objective-specific logic, so they apply to every objective.
  if (row.quality?.open_window === true)
    return result(
      'wait',
      'The reporting window includes a day that has not ended in the source time zone. Wait until it closes.',
      {window_closes_at: row.quality.window_closes_at ?? null},
    );
  if (row.quality?.reporting_window_declared_complete === false || row.quality?.measurement_complete === false)
    return result(
      'needs_review',
      'The reporting window was declared incomplete or its measurement is incomplete. Collect a complete window before recommending a change.',
    );
  if (!row.complete || !row.currency || !row.timezone || now - row.captured_at > recommendationValidityMs)
    return result(
      'needs_review',
      'Refresh complete data with verified currency and timezone before recommending a change.',
    );
  if (row.objective_group === 'unknown' || row.objective_group === 'mixed')
    return result('needs_review', 'Confirm this campaign’s objective and primary result metric.');
  // Campaign key, then a currency-specific objective target ("sales:SAR"), then the objective target (DEC-01).
  const p =
      policy[row.campaign_key] ?? policy[row.objective_group + ':' + row.currency] ?? policy[row.objective_group] ?? {},
    metric =
      p.kpi ??
      (math?.primaryResult ? 'cost_per_result' : undefined) ??
      (
        {
          awareness: 'cpm',
          traffic: 'cpc',
          engagement: 'cost_per_engagement',
          video_views: 'cpv',
          leads: 'cpl',
          sales: 'cpa',
          app_installs: 'cpi',
        } as JsonObject
      )[row.objective_group];
  const context = recommendationContext(row, p);
  if (context) return result(context.decision, context.reason, context.evidence);
  const m = row.metrics,
    actual =
      metric === 'cost_per_engagement'
        ? math
          ? math.formula('spend / engagements', m)
          : m.spend != null && m.engagements > 0
            ? m.spend / m.engagements
            : null
        : m[metric],
    target = metricNumber(p.target);
  if (target === null || target <= 0) {
    // F-L5-13: a result counted in money has no cost per result to set a target for, so a row that falls to the default KPI
    // is asked for its return instead. A target that names its own KPI keeps it.
    const asked =
      p.kpi === undefined && metric === 'cost_per_result' && row.result_context?.definition?.unit === 'currency'
        ? 'roas'
        : metric;
    return {
      ...result(
        'needs_target',
        'Set a ' + asked.toUpperCase() + ' target in ' + row.currency + ' for this objective or campaign.',
        {kpi: asked},
      ),
      reason_localization: {key: 'target_required', kpi: asked.toUpperCase(), currency: row.currency},
    };
  }
  if (p.currency !== row.currency)
    return result('needs_review', 'The target currency must match the campaign account currency.', {
      target_currency: p.currency ?? null,
      currency: row.currency,
    });
  // DEC-01: the direction comes from the target or the KPI definition, never from a single special case.
  const direction =
    p.direction ?? (metric === 'cost_per_result' && math?.primaryResult ? 'lower' : kpiDirection(metric));
  if (direction !== 'higher' && direction !== 'lower')
    return result(
      'needs_review',
      'Set whether higher or lower is better for this target KPI (direction) before recommending a change.',
      {kpi: metric, field: 'direction'},
    );
  const resultField =
      p.result_metric ??
      (math?.primaryResult ? 'primary_result' : undefined) ??
      (
        {
          awareness: 'impressions',
          traffic: 'clicks',
          engagement: 'engagements',
          video_views: 'video_views',
          leads: 'leads',
          sales: 'conversions',
          app_installs: 'installs',
        } as JsonObject
      )[row.objective_group],
    n = m[resultField],
    minimum =
      p.minimum_results ??
      (row.objective_group === 'awareness'
        ? 1000
        : ['sales', 'leads', 'app_installs'].includes(row.objective_group)
          ? 10
          : 30),
    lag = p.conversion_lag_days ?? 3;
  // RPT-04: conversions of different optimization events in one campaign are not one result.
  if (['sales', 'leads', 'app_installs'].includes(row.objective_group) && row.mixed_result_definition === true)
    return result(
      'needs_review',
      'This campaign’s ad groups optimize for different events, so its conversions are not one result. Review each ad group before acting on cost per result.',
      {result_definition: row.result_definition ?? null},
    );
  if (
    ['sales', 'leads', 'app_installs'].includes(row.objective_group) &&
    (row.attribution === 'unknown' || row.result_definition === 'unknown')
  )
    return result(
      'needs_review',
      'Confirm attribution and the primary conversion definition before making budget recommendations.',
    );
  let end: number;
  try {
    end = zonedMidnight(new Date(Date.parse(row.date_to) + 86400000).toISOString().slice(0, 10), row.timezone, true);
  } catch {
    return result('needs_review', 'The reporting window needs an unambiguous account timezone boundary.');
  }
  if (['sales', 'leads', 'app_installs'].includes(row.objective_group) && now - end < lag * 86400000)
    return result('wait', 'The reporting window is still inside the configured conversion-lag period.', {
      conversion_lag_days: lag,
    });
  // DEC-01: without delivered spend (or below the target's minimum_spend) a ratio cannot justify a budget move;
  // zero spend made CPA 0 and recommended "scale".
  const minimumSpend = typeof p.minimum_spend === 'number' ? p.minimum_spend : 0;
  // Unknown spend cannot meet a declared minimum.
  if (typeof m.spend === 'number' ? m.spend <= 0 || m.spend < minimumSpend : minimumSpend > 0)
    return result(
      'insufficient_data',
      'No spend, or less than the minimum spend, in this window. Wait for delivered spend before recommending a change.',
      {spend: m.spend ?? null, minimum_spend: minimumSpend, kpi: metric},
    );
  if (
    n === 0 &&
    (math ? math.compare(m.spend, target, 3) >= 0 : m.spend >= target * 3) &&
    [
      'cpa',
      'cpl',
      'cpi',
      ...(math?.primaryResult && ['sales', 'leads', 'app_installs'].includes(row.objective_group)
        ? ['cost_per_result']
        : []),
    ].includes(metric)
  )
    return result(
      'reconsider_pause',
      'Spend exceeded three target acquisition costs with no reported results. Check tracking and conversion lag, then consider pausing.',
      {
        spend: m.spend,
        target,
        results: n,
        // RPT-04: the zero is the provider omitting the action on a delivered row.
        ...(Array.isArray(row.omitted_as_zero) && row.omitted_as_zero.includes(resultField)
          ? {results_basis: 'provider_omitted'}
          : {}),
      },
    );
  // F-L5-13: a result counted in money (a value-based campaign's conversion value) has a return, not a cost, so a target
  // that is a cost per result cannot be compared with it. That is not a small sample: more results would not help.
  if (metric === 'cost_per_result' && row.result_context?.definition?.unit === 'currency')
    return result(
      'needs_review',
      'This campaign’s result is a conversion value, so a cost per result target cannot be compared with it. Set a return on ad spend target for it, or review it by hand.',
      {kpi: metric},
    );
  if (n == null || n < minimum || actual == null)
    return result('insufficient_data', 'Wait for enough results to distinguish a signal from a small sample.', {
      results: n ?? null,
      minimum_results: minimum,
      kpi: metric,
    });
  const higher = direction === 'higher',
    relative = higher ? target / actual : actual / target,
    atMost = (limit: number) =>
      math
        ? (higher ? math.compare(target, actual, limit) : math.compare(actual, target, limit)) <= 0
        : relative <= limit,
    atLeast = (limit: number) =>
      math
        ? (higher ? math.compare(target, actual, limit) : math.compare(actual, target, limit)) >= 0
        : relative >= limit,
    evidence = {
      kpi: metric,
      actual,
      target,
      currency: row.currency,
      results: n,
      maximum_budget_change_percent: Math.min(20, p.maximum_change_percent ?? 10),
    };
  if (atMost(0.85)) {
    const c = p.context ?? {};
    if (c.capacity_available === false || c.budget_available === false)
      return result(
        'maintain',
        'Performance supports growth, but a confirmed capacity or budget constraint prevents increasing delivery.',
        {...evidence, business_context: c},
      );
    if (c.current_daily_budget !== undefined && c.maximum_daily_budget !== undefined) {
      const headroom =
        c.current_daily_budget > 0
          ? math
            ? Number(
                math.formula('(maximum / current - 1) * 100', {
                  maximum: c.maximum_daily_budget,
                  current: c.current_daily_budget,
                }),
              )
            : (c.maximum_daily_budget / c.current_daily_budget - 1) * 100
          : 0;
      if (headroom <= 0)
        return result('maintain', 'The supplied daily budget limit leaves no room for an increase.', {
          ...evidence,
          business_context: c,
        });
      evidence.maximum_budget_change_percent = Math.min(evidence.maximum_budget_change_percent, headroom);
    }
  }
  if (atMost(0.85))
    return result(
      'scale',
      'Performance is comfortably above target. Consider a bounded budget increase after checking capacity and recent changes.',
      evidence,
    );
  if (atLeast(1.5))
    return result(
      'reconsider_pause',
      'Performance is materially below target. Review tracking, targeting and creative before deciding whether to pause.',
      evidence,
    );
  if (atLeast(1.15))
    return result(
      'pull_back',
      'Performance is below target. Consider a bounded budget reduction and diagnose the cause.',
      evidence,
    );
  return result('maintain', 'Performance is close to the configured target. Maintain delivery and monitor.', evidence);
}
const additiveMetrics = Object.entries(metricDefinitions)
  .filter(([, d]) => d.aggregation === 'sum')
  .map(([id]) => id);
/**
 * DEC-01: for daily, weekly or monthly grouping, one entity's guidance comes from its additive aggregate over the
 * whole window instead of each small period. Every row of the entity shares that recommendation (basis
 * "entity_window"). Non-additive metrics, and native fields without a declared aggregation, stay unknown there.
 */
export function windowRecommendations(
  rows: JsonObject[],
  policy: JsonObject = {},
  custom: JsonObject[] = [],
  now = Date.now(),
  adapter?: WindowAdapter,
): JsonObject[] {
  for (const group of windowGroups(rows, adapter)) shareWindowRecommendation(group, policy, custom, now, adapter);
  return rows;
}
/** How a report version aggregates the rows of one entity and advises on the aggregate (v4: exact decimal metrics). */
export interface WindowAdapter {
  aggregate(rows: JsonObject[], custom: JsonObject[]): JsonObject;
  recommend(row: JsonObject, policy: JsonObject, now: number): JsonObject;
}
/**
 * The rows of each entity that has more than one; v4 tells entities apart by currency, attribution, objective and result
 * definition too.
 */
export function windowGroups(rows: JsonObject[], adapter?: WindowAdapter): JsonObject[][] {
  const groups = new Map<string, JsonObject[]>();
  for (const row of rows) {
    const key = adapter
      ? JSON.stringify([
          row.campaign_key,
          row.currency,
          row.attribution,
          row.objective_group,
          row.result?.definition_id ?? null,
        ])
      : row.campaign_key;
    const members = groups.get(key);
    if (members) members.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()].filter(group => group.length >= 2);
}
/**
 * The one recommendation the rows of an entity share (basis `entity_window`): from their aggregate over the whole window.
 * It is one unit of work, so a pass over many entities can hand the event loop back between two of them (NF-1).
 */
export function shareWindowRecommendation(
  group: JsonObject[],
  policy: JsonObject = {},
  custom: JsonObject[] = [],
  now = Date.now(),
  adapter?: WindowAdapter,
): void {
  const base: JsonObject = {},
    qualities = group.map(row => row.quality ?? {}),
    open = qualities.filter(q => q.open_window === true);
  for (const key of additiveMetrics) {
    const values = group.map(row => row.metrics?.[key]);
    base[key] = values.every(v => typeof v === 'number' && Number.isFinite(v))
      ? values.reduce((sum, v) => sum + v, 0)
      : null;
  }
  const aggregate = {
    ...group[0],
    omitted_as_zero: [...new Set(group.flatMap(row => row.omitted_as_zero ?? []))],
    date_from: group.map(row => row.date_from).sort()[0],
    date_to: group
      .map(row => row.date_to)
      .sort()
      .at(-1),
    complete: group.every(row => row.complete),
    captured_at: Math.min(...group.map(row => row.captured_at)),
    quality: {
      ...(open.length ? {open_window: true, window_closes_at: open.at(-1)!.window_closes_at ?? null} : {}),
      ...(qualities.some(q => q.reporting_window_declared_complete === false)
        ? {reporting_window_declared_complete: false}
        : {}),
      measurement_complete: qualities.some(q => q.measurement_complete === false)
        ? false
        : qualities.every(q => q.measurement_complete === true)
          ? true
          : null,
    },
    ...(adapter ? adapter.aggregate(group, custom) : {metrics: calculateMetrics(base, custom)}),
  };
  const shared = adapter ? adapter.recommend(aggregate, policy, now) : campaignRecommendation(aggregate, policy, now);
  for (const row of group)
    row.recommendation = {
      ...shared,
      basis: 'entity_window',
      evidence: {
        ...shared.evidence,
        periods: group.length,
        date_from: aggregate.date_from,
        date_to: aggregate.date_to,
      },
    };
}
