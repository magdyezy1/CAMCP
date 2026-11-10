import {MirrorError} from './errors.js';
import {metaWindowsOrdered, metaWindowsValid} from './meta-attribution-windows.js';
import {parseProviderDecimal, sumProviderDecimals} from './provider-decimal.js';
import {
  mappedReportResult,
  resolveReportResult,
  selectReportResultDefinition,
  unavailableReportResult,
  type ReportResultContext,
  type ReportResultDefinition,
  type ReportResultRules,
  type ResolvedReportResult,
} from './report-results.js';
import type {JsonObject} from './types.js';

/**
 * Meta’s own result is the insights `results` entry of the row (F-L5-12, read from the owner’s live read of Graph v26.0,
 * docs/records/META-RESULTS-PIN-2026-11-07.md). When a row has none, or the person set one exact action, this table maps
 * the optimization goal to a documented scalar or action field: the labelled fallback, whose rows say they are mapped.
 */
export const metaResultRules: ReportResultRules = {
  selectors: [
    {
      field: 'goal',
      required: true,
      values: {
        LINK_CLICKS: {
          id: 'meta:link_clicks',
          metric: 'link_clicks',
          label: 'Link clicks',
          native_metric: 'inline_link_clicks',
          aggregation: 'sum',
          unit: 'number',
        },
        IMPRESSIONS: {
          id: 'meta:impressions',
          metric: 'impressions',
          label: 'Impressions',
          native_metric: 'impressions',
          aggregation: 'sum',
          unit: 'number',
          cost_multiplier: 1000,
        },
        REACH: {
          id: 'meta:reach',
          metric: 'reach',
          label: 'Reach',
          native_metric: 'reach',
          aggregation: 'non_additive',
          unit: 'number',
          cost_multiplier: 1000,
        },
        POST_ENGAGEMENT: {
          id: 'meta:post_engagement',
          metric: 'engagements',
          label: 'Post engagements',
          native_metric: 'actions.post_engagement',
          aggregation: 'sum',
          unit: 'number',
        },
        LEAD_GENERATION: {
          id: 'meta:leads',
          metric: 'leads',
          label: 'Leads',
          native_metric: 'actions.lead',
          aggregation: 'sum',
          unit: 'number',
        },
        APP_INSTALLS: {
          id: 'meta:installs',
          metric: 'installs',
          label: 'App installs',
          native_metric: 'actions.mobile_app_install',
          aggregation: 'sum',
          unit: 'number',
        },
      },
    },
  ],
};

const goals = metaResultRules.selectors[0]!.values as Record<string, ReportResultDefinition>;
type IndicatorDefinition = Omit<ReportResultDefinition, 'native_metric'>;
const counted = (id: string, metric: string, label: string): IndicatorDefinition => ({
  id: 'meta:' + id,
  metric,
  label,
  aggregation: 'sum',
  unit: 'number',
});
const pinned = (goal: string): IndicatorDefinition => {
  const {native_metric: _field, ...definition} = goals[goal]!;
  return definition;
};
/**
 * The definition of each indicator Meta’s `results` names. The ids of lead, install, reach, link click and post
 * engagement are the ones the mapped table already has; the others are new. Different indicators are different results:
 * `groupReportResults` keys on the definition, so they are never added.
 */
export const metaResultIndicators: Readonly<Record<string, IndicatorDefinition>> = Object.freeze({
  'actions:link_click': pinned('LINK_CLICKS'),
  'actions:post_engagement': pinned('POST_ENGAGEMENT'),
  'actions:onsite_conversion.messaging_conversation_started_7d': counted(
    'messaging_conversations',
    'messaging_conversations',
    'Messaging conversations started',
  ),
  'actions:landing_page_view': counted('landing_page_views', 'landing_page_views', 'Landing page views'),
  'actions:omni_landing_page_view': counted(
    'omni_landing_page_views',
    'omni_landing_page_views',
    'Landing page views (all channels)',
  ),
  'actions:offsite_conversion.fb_pixel_purchase': counted(
    'website_purchases',
    'website_purchases',
    'Website purchases',
  ),
  'actions:offsite_conversion.fb_pixel_add_to_cart': counted(
    'website_adds_to_cart',
    'website_adds_to_cart',
    'Website adds to cart',
  ),
  'actions:click_to_call_native_call_placed': counted('calls_placed', 'calls_placed', 'Calls placed'),
  'actions:rsvp': counted('event_responses', 'event_responses', 'Event responses'),
  'actions:like': counted('page_likes', 'page_likes', 'Page likes'),
  'actions:lead': pinned('LEAD_GENERATION'),
  'actions:mobile_app_install': pinned('APP_INSTALLS'),
  video_continuous_2_sec_watched_actions: counted(
    'video_2s_plays',
    'video_2s_plays',
    '2-second continuous video plays',
  ),
  profile_visit_view: counted('profile_visit_views', 'profile_visit_views', 'Profile visits'),
  total_profile_visits: counted('total_profile_visits', 'total_profile_visits', 'Total profile visits'),
  reach: pinned('REACH'),
  estimated_ad_recallers: {
    id: 'meta:ad_recallers',
    metric: 'ad_recallers',
    label: 'Estimated ad recall lift (people)',
    aggregation: 'non_additive',
    unit: 'number',
  },
});
/**
 * Indicators are provider text: they enter an id and a stored definition, so their length and characters are bounded
 * (letters, digits, `_`, `.` and `-`, at most one `prefix:name` colon). One that fails is an unverified shape.
 */
const indicatorForm = /^(?=.{1,200}$)[A-Za-z][A-Za-z0-9_.-]*(?::[A-Za-z0-9][A-Za-z0-9_.-]*)?$/;
const customConversion = /^actions:offsite_conversion\.custom\.(\d{1,32})$/;
/** The definition of one indicator of Meta’s `results`, or null when the indicator is not a bounded name. */
export function metaIndicatorDefinition(indicator: string): ReportResultDefinition | null {
  if (!indicatorForm.test(indicator)) return null;
  const native_metric = 'results:' + indicator;
  if (Object.hasOwn(metaResultIndicators, indicator)) return {...metaResultIndicators[indicator]!, native_metric};
  const custom = customConversion.exec(indicator);
  if (custom)
    return {
      id: 'meta:custom_conversion:' + custom[1],
      metric: 'custom_conversion:' + custom[1],
      label: 'Custom conversion',
      native_metric,
      aggregation: 'sum',
      unit: 'number',
    };
  if (indicator.startsWith('actions:')) {
    const action = indicator.slice('actions:'.length);
    return {
      id: 'meta:action:' + action,
      metric: action,
      label: 'Meta result',
      native_metric,
      aggregation: 'sum',
      unit: 'number',
    };
  }
  return {
    id: 'meta:result:' + indicator,
    metric: indicator,
    label: 'Meta result',
    native_metric,
    aggregation: 'non_additive',
    unit: 'number',
  };
}

const isObject = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
/** The attribution windows a report asked Meta for, in AMCP’s order; undefined under the ad set’s own setting. */
export function metaRequestedWindows(options: unknown): string[] | undefined {
  const windows = isObject(options) ? options.attribution_windows : undefined;
  return metaWindowsValid(windows) ? metaWindowsOrdered(windows) : undefined;
}
/**
 * The count of one `actions` or `action_values` entry for the requested windows. Under explicit windows `value` is the
 * ad set’s own setting, not the requested window; the count of each requested window is under the key named for it,
 * and a window with no count has no key (the live read, 2026-11-07). The windows add exactly. Undefined when the entry
 * has none of the requested keys: Meta left the zero out.
 */
export function metaWindowCount(entry: JsonObject, windows: readonly string[], field = 'result'): string | undefined {
  const present = windows.filter(window => Object.hasOwn(entry, window) && entry[window] != null);
  return present.length
    ? sumProviderDecimals(
        present.map(window => entry[window]),
        {field},
      )
    : undefined;
}

/**
 * The cost per action of one `cost_per_action_type` entry for the requested windows. Its entry has an action’s shape: `value`
 * is the ad set’s own cost, and each requested window’s own cost is under the key named for it. A cost does not add across
 * windows (the cost of two windows is the spend over their joint count, not the sum of their costs) and Meta sends none for a
 * pair, so one window has its key and several windows have no cost here. Undefined: no cost for these windows; the cost of
 * a result under any windows is `cost_per_result`, spend over the counted windows.
 */
export function metaWindowCost(entry: JsonObject, windows: readonly string[]): unknown {
  const window = windows.length === 1 ? windows[0]! : undefined;
  return window !== undefined && Object.hasOwn(entry, window) && entry[window] != null ? entry[window] : undefined;
}

/** A decimal as the text the result reader keeps, or null when it is not a nonnegative decimal. Never throws. */
function decimalText(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = typeof value === 'string' ? value.trim() : value;
  try {
    parseProviderDecimal(text, {field: 'result'});
  } catch (error) {
    if (error instanceof MirrorError) return null;
    throw error;
  }
  return String(text);
}
const windowName = /^[a-z0-9_]{1,40}$/;
interface WindowValue {
  /** The window the value is for, or null when the entry names none. */
  window: string | null;
  value: string;
}
/** The values of one `results` or `cost_per_result` entry, or null when they are not the recorded shape. */
function windowValues(values: unknown): WindowValue[] | null {
  if (!Array.isArray(values)) return null;
  const out: WindowValue[] = [];
  for (const item of values) {
    if (!isObject(item)) return null;
    const value = decimalText(item.value);
    if (value === null) return null;
    let window: string | null = null;
    if (item.attribution_windows !== undefined) {
      const names = item.attribution_windows;
      if (!Array.isArray(names) || names.length !== 1 || typeof names[0] !== 'string' || !windowName.test(names[0]))
        return null;
      window = names[0];
    }
    out.push({window, value});
  }
  // Two values for one window are ambiguous: neither is chosen.
  return new Set(out.map(item => item.window)).size === out.length ? out : null;
}
/** Meta’s own cost per result for the indicator, or null when the field is not the recorded shape (it is then ignored). */
function costValues(cost: unknown, indicator: string): WindowValue[] | null {
  if (!Array.isArray(cost) || cost.length !== 1 || !isObject(cost[0]) || cost[0].indicator !== indicator) return null;
  return windowValues(cost[0].values);
}
const sameDecimal = (a: string, b: string) =>
  parseProviderDecimal(a, {field: 'result'}).scaled === parseProviderDecimal(b, {field: 'result'}).scaled;
/** Whether the row delivered: impressions above 0. Unparseable impressions are a changed shape, as for mapped results. */
const delivered = (raw: JsonObject) =>
  raw.impressions != null && parseProviderDecimal(raw.impressions, {field: 'impressions'}).scaled > 0n;

/**
 * The count of the row’s one `actions` entry for `indicator`, summed over the requested windows. `absent`: the row has no
 * such entry (or no `actions`); `shape`: `actions` cannot be read cleanly, so no count is guessed from it; `none`: the entry
 * has none of the requested keys; `counted`: the sum.
 */
function actionCount(
  raw: JsonObject,
  indicator: string,
  windows: readonly string[],
): {found: 'absent' | 'shape' | 'none'} | {found: 'counted'; count: string} {
  if (!indicator.startsWith('actions:') || raw.actions === undefined) return {found: 'absent'};
  const actions = raw.actions;
  if (!Array.isArray(actions) || actions.some(item => !isObject(item) || typeof item.action_type !== 'string'))
    return {found: 'shape'};
  const entries = actions.filter(item => item.action_type === indicator.slice('actions:'.length));
  if (!entries.length) return {found: 'absent'};
  if (entries.length > 1) return {found: 'shape'};
  try {
    const count = metaWindowCount(entries[0]!, windows);
    return count === undefined ? {found: 'none'} : {found: 'counted', count};
  } catch (error) {
    if (error instanceof MirrorError) return {found: 'shape'};
    throw error;
  }
}

/**
 * Rules 3 to 7 of the record: Meta’s own result, read from the row’s one `results` entry. A shape that is not the one
 * recorded is unknown and never throws; the row’s other metrics are unaffected.
 */
function metaProviderResult(raw: JsonObject, context: ReportResultContext): ResolvedReportResult {
  const unverified = () => unavailableReportResult('unverified_native_shape'),
    results = raw.results;
  if (
    !Array.isArray(results) ||
    results.length !== 1 ||
    !isObject(results[0]) ||
    typeof results[0].indicator !== 'string'
  )
    return unverified();
  const indicator: string = results[0].indicator,
    definition = metaIndicatorDefinition(indicator);
  if (!definition) return unverified();
  const values = results[0].values === undefined ? [] : windowValues(results[0].values);
  if (values === null) return unverified();
  // The row counted none: a zero Meta left out on a row that delivered, unknown on one that did not.
  const empty = () => {
    const omitted = delivered(raw),
      resolved = resolveReportResult(definition, {value: omitted ? '0' : null, spend: raw.spend}, 'provider');
    return {...resolved, periods_add: true as const, ...(omitted ? {provider_omitted: true as const} : {})};
  };
  if (!values.length) return empty();
  const windows = metaRequestedWindows(context.report_options),
    named = (window: string | null) => values.find(item => item.window === window),
    // The value that follows the ad set’s own setting: the entry named default, or the only entry when it names no window.
    own = () => named('default') ?? (values.length === 1 && values[0]!.window === null ? values[0] : undefined);
  let gave: WindowValue[], total: string;
  if (windows === undefined) {
    const entry = own();
    if (!entry) return unverified();
    gave = [entry];
    total = entry.value;
  } else {
    const requested = values.filter(item => item.window !== null && windows.includes(item.window));
    if (requested.length) {
      gave = requested;
      total = sumProviderDecimals(
        requested.map(item => item.value),
        {field: 'result'},
      );
    } else {
      // The values hold no requested window. An action that has a count per window says it itself; a metric that is not
      // split by window has only the default.
      const keys = actionCount(raw, indicator, windows);
      if (keys.found === 'shape') return unverified();
      if (keys.found === 'none') return empty();
      if (keys.found === 'counted') {
        gave = [];
        total = keys.count;
      } else {
        const entry = own();
        if (!entry) return unverified();
        gave = [entry];
        total = entry.value;
      }
    }
  }
  // A sum that is not a decimal the shared reader accepts (windows of absurd exponents add up past its length bound) is
  // not a result: unknown, like any shape that is not the recorded one.
  if (decimalText(total) === null) return unverified();
  // Meta’s cost of the entry that gave the value. A sum of windows has Meta’s default cost only when it is the default
  // value; otherwise, and for a count taken from the action’s keys, the cost is derived from spend.
  const costs = costValues(raw.cost_per_result, indicator);
  let cost: string | undefined;
  if (costs && gave.length === 1) cost = costs.find(item => item.window === gave[0]!.window)?.value;
  else if (costs && gave.length > 1) {
    const base = named('default');
    if (base && sameDecimal(base.value, total)) cost = costs.find(item => item.window === 'default')?.value;
  }
  return {
    ...resolveReportResult(definition, {value: total, spend: raw.spend, cost_per_result: cost}, 'provider'),
    periods_add: true as const,
  };
}

/** Not goals: Meta says them of a campaign with no single optimization goal. */
const notGoals = new Set(['Unknown Optimization Goal', 'NONE']);
/**
 * The labelled fallback: AMCP maps the optimization goal, or the one exact action the person chose, to a documented
 * field. Under explicit windows an action’s count is the sum of the requested windows’ keys (F-LEAD-02).
 */
export function metaMappedResult(raw: JsonObject, context: ReportResultContext) {
  const override = context.report_options?.result_action_type;
  if (override !== undefined && (typeof override !== 'string' || !/^[a-z][a-z0-9_.]{0,159}$/.test(override)))
    throw new MirrorError('INVALID_REPORT_SOURCE', 'Choose one exact Meta result action.');
  const rawGoal = context.goal ?? raw.optimization_goal,
    selection = {goal: typeof rawGoal === 'string' && notGoals.has(rawGoal) ? undefined : rawGoal},
    selected = selectReportResultDefinition(metaResultRules, selection),
    definition =
      typeof override === 'string'
        ? {
            id: 'meta:action:' + override,
            metric: override,
            label: 'Selected Meta action',
            native_metric: 'actions.' + override,
            aggregation: 'sum' as const,
            unit: 'number' as const,
          }
        : selected.definition;
  if (!definition) return unavailableReportResult(selected.unavailable_reason!);
  if (!definition.native_metric.startsWith('actions.'))
    return mappedReportResult(metaResultRules, selection, raw, {spend: raw.spend});
  const actionType = definition.native_metric.slice('actions.'.length),
    actions = raw.actions,
    windows = metaRequestedWindows(context.report_options);
  if (
    actions !== undefined &&
    (!Array.isArray(actions) ||
      actions.some(
        item => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.action_type !== 'string',
      ))
  )
    throw new MirrorError('REPORT_SHAPE_CHANGED', 'Meta returned malformed actions.', {}, 502);
  // Existing Meta action aliases overlap. Prefer one field; never sum aliases or call a returned alias an omitted zero.
  const aliases =
      override === undefined && actionType === 'lead'
        ? ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']
        : override === undefined && actionType === 'mobile_app_install'
          ? ['mobile_app_install', 'app_install']
          : [actionType],
    selectedType = aliases.find(alias => actions?.some((item: JsonObject) => item.action_type === alias)) ?? actionType,
    found = actions?.filter((item: JsonObject) => item.action_type === selectedType) ?? [];
  if (found.length > 1)
    throw new MirrorError('REPORT_SHAPE_CHANGED', 'Meta returned duplicate selected result actions.', {}, 502);
  // Under explicit windows `value` is the ad set’s setting: the count is the requested windows’ keys (F-LEAD-02).
  const entry = found[0],
    count = entry !== undefined && windows !== undefined ? metaWindowCount(entry, windows) : entry?.value,
    // Meta omits a zero: an absent action, and under explicit windows an action with a count in none of the windows.
    left = entry === undefined || (windows !== undefined && count === undefined),
    omitted = left && delivered(raw),
    resolved = resolveReportResult(
      {...definition, native_metric: 'actions.' + selectedType},
      {value: count ?? (omitted ? '0' : null), spend: raw.spend},
      'mapped',
    );
  return {...resolved, ...(omitted ? {provider_omitted: true as const} : {})};
}

/**
 * Whether a v4 row’s result is read from its insights `results` (rules 3 to 7) rather than mapped by AMCP (rules 1 and 2):
 * the person chose no exact action, and the row has a `results` that is not empty.
 */
export function metaReadsResults(raw: JsonObject, options: unknown): boolean {
  const results = raw.results;
  return (
    !(isObject(options) && options.result_action_type !== undefined) &&
    results !== undefined &&
    !(Array.isArray(results) && results.length === 0)
  );
}

/**
 * A v4 Meta row’s result (rules 1 to 7 of the record). The exact action the person chose wins; a row with no `results`,
 * or an empty list, is mapped from its goal; any other `results` is read as Meta’s own result.
 */
export function metaResult(raw: JsonObject, context: ReportResultContext): ResolvedReportResult {
  return metaReadsResults(raw, context.report_options)
    ? metaProviderResult(raw, context)
    : metaMappedResult(raw, context);
}

/** What a v3 report, and a v4 report whose rows are all mapped, has always said its Meta results are. */
export const metaMappedDefinition = 'Objective-mapped lead, purchase or app-install action; aliases are not summed';
const metaResultsDefinition = 'Meta’s own result for each row’s optimization goal (insights results)';
const metaBothDefinition =
  'Meta’s own result (insights results) for rows that have one, otherwise the field mapped from the optimization goal';
/**
 * The sentence a v4 source states for its result definition, true of the rows it collected: Meta’s own results, the
 * mapped table, or both. It is never one sentence for rows of two kinds.
 */
export function metaResultDefinition(rows: JsonObject[], options: unknown): string {
  const read = rows.filter(raw => metaReadsResults(raw, options)).length;
  return read === 0 ? metaMappedDefinition : read === rows.length ? metaResultsDefinition : metaBothDefinition;
}
