import {MirrorError} from './errors.js';
import {parseProviderDecimal} from './provider-decimal.js';
import {
  mappedReportResult,
  resolveReportResult,
  selectReportResultDefinition,
  unavailableReportResult,
  type ReportResultContext,
  type ReportResultRules,
} from './report-results.js';
import type {JsonObject} from './types.js';

/** Documented scalar/action fields only. Native AdsInsightsResult inner shapes remain owner-deferred. */
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

export function metaMappedResult(raw: JsonObject, context: ReportResultContext) {
  const override = context.report_options?.result_action_type;
  if (override !== undefined && (typeof override !== 'string' || !/^[a-z][a-z0-9_.]{0,159}$/.test(override)))
    throw new MirrorError('INVALID_REPORT_SOURCE', 'Choose one exact Meta result action.');
  const selected = selectReportResultDefinition(metaResultRules, {goal: context.goal ?? raw.optimization_goal}),
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
  if (!definition)
    return unavailableReportResult(
      raw.results !== undefined ? 'unverified_native_shape' : selected.unavailable_reason!,
    );
  if (!definition.native_metric.startsWith('actions.'))
    return mappedReportResult(metaResultRules, {goal: context.goal ?? raw.optimization_goal}, raw, {spend: raw.spend});
  const actionType = definition.native_metric.slice('actions.'.length),
    actions = raw.actions;
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
  const omitted =
      found.length === 0 &&
      raw.impressions != null &&
      parseProviderDecimal(raw.impressions, {field: 'impressions'}).scaled > 0n,
    resolved = resolveReportResult(
      {...definition, native_metric: 'actions.' + selectedType},
      {value: found[0]?.value ?? (omitted ? '0' : null), spend: raw.spend},
      'mapped',
    );
  return {...resolved, ...(omitted ? {provider_omitted: true as const} : {})};
}
