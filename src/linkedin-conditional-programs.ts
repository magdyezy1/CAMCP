import type {ConditionalProgram, ProviderConditionalProgram} from './provider-adapter.js';
import type {JsonObject} from './types.js';
import {bad, obj, validate} from './workspace-core.js';
import {linkedinVersion} from './linkedin-version.js';
import {linkedinPlanningTemplate} from './linkedin-planning-reads.js';
import {withEffects} from './workflow-outcomes.js';

/**
 * LinkedIn's conditional programs (CON-04): Media Planning's forecast and Audience Insights, each a private product
 * LinkedIn provisions per application. Moved verbatim from src/conditional-programs.ts (ARC-01, wave 4c round 6), which
 * lists them from LinkedIn's hooks (src/linkedin-adapter.ts) and keeps every shared rule of a check: these supply the
 * program, its requirements template, its native request and the evidence it keeps.
 */
const gateway = 'linkedin_native_action';
const forecast: ConditionalProgram = {
  id: 'program:linkedin_forecast',
  kind: 'conditional_program',
  mode: 'live_read',
  name: 'LinkedIn Media Planning forecast',
  gateway,
  objective: 'directional_forecast',
  description: 'Inspect a directional forecast for an exact account, audience, future period and USD budget.',
  effects: 'provider_reads',
  effect_details: 'This read creates no campaign or saved media plan. Estimates do not establish future delivery.',
  required_inputs: ['connection_id', 'account_id', 'forecast', 'request'],
  prerequisite_ids: ['private_application_product', 'member_account_access', 'positive_geographic_targeting'],
  actions: ['linkedin_rest_media_planning_post'],
  recorded_scopes: [] as string[],
  program: {
    access:
      'LinkedIn must provision the private Media Planning product for the application. A valid member token and account access are also required; this forecast has no additional OAuth scope.',
    reference:
      'https://learn.microsoft.com/en-us/linkedin/marketing/media-planning/media-planning-api?view=li-lms-2026-09',
    checked_on: '2026-10-06',
    limitations:
      'Forecasts require positive geographic targeting, an eligible audience, a future period within 90 days and a USD budget. The native provider decides eligibility. Saved media plans use a different product and permission.',
  },
  // LinkedIn's two documented 403 bodies for this private product (the program reference). Each names the
  // prerequisite LinkedIn reports; AMCP infers no other cause and the entitlement stays unverified (PRV-02).
  documented_refusals: {
    ACCESS_DENIED: {
      prerequisite_id: 'private_application_product',
      owner_action: 'request_provisioning',
      resolution:
        'LinkedIn reports that this application is not provisioned for Media Planning. Apply for, or confirm, Media Planning access for the production application, then check again.',
    },
    USER_NOT_AUTHORIZED: {
      prerequisite_id: 'member_account_access',
      owner_action: 'verify_member_role',
      resolution:
        'LinkedIn reports that the connected member has no role on this ad account. Ask an account manager to give the member a role on the account in Campaign Manager, then check again.',
    },
  },
  // A refusal without a documented code (CON-04): the owner follows it up with LinkedIn; no cause is inferred.
  undocumented_refusal: {
    kind: 'contact_provider',
    text: 'LinkedIn refused this exact request without a documented code. AMCP infers no cause. Confirm the application approval for this product and the member’s role on this ad account with LinkedIn, citing the provider request reference, then check again.',
  },
  // With no selected account there is nothing to inspect yet (CON-04): set up the login first.
  account_setup: {
    text: 'No LinkedIn ad account is selected for AMCP. On the Connections page, connect a LinkedIn member who has a role on the ad account, sync the login and select the account, then inspect this program again.',
    prerequisites: [
      {
        id: 'member_account_access',
        text: 'The connected LinkedIn member needs a role on the ad account in Campaign Manager.',
      },
      {
        id: 'private_application_product',
        text: 'LinkedIn must provision this private product for the application; the program reference describes how.',
      },
    ],
  },
  next_call: withEffects({
    tool: 'amcp_workspace',
    arguments: {action: 'program_check', workflow_id: 'program:linkedin_forecast', live: false},
  }),
  website_path: '/capabilities?workflow_id=program%3Alinkedin_forecast',
  source: 'src/conditional-programs.ts',
};
const audienceInsights: ConditionalProgram = {
  id: 'program:linkedin_audience_insights',
  kind: 'conditional_program',
  mode: 'live_read',
  name: 'LinkedIn Audience Insights',
  gateway,
  objective: 'audience_estimate',
  description: 'Inspect aggregated audience insights for an exact selected account and native targeting criteria.',
  effects: 'provider_reads',
  effect_details: 'This read creates no audience, segment or campaign and returns no member records.',
  required_inputs: ['connection_id', 'account_id', 'request'],
  prerequisite_ids: ['private_application_product', 'member_account_access', 'exact_targeting_criteria'],
  actions: ['linkedin_rest_targeting_audience_insights_post'],
  recorded_scopes: [] as string[],
  program: {
    access:
      'LinkedIn must provision Audience Insights for the application. Marketing API access alone does not establish access to this private product.',
    reference:
      'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/audience-insights-api?view=li-lms-2026-09',
    checked_on: '2026-10-06',
    limitations:
      'Audience estimates are aggregated and directional. An account read or a successful forecast does not qualify Audience Insights or matched-audience writes.',
  },
  // LinkedIn's two documented 403 bodies for this private product (the program reference), as for Media Planning.
  documented_refusals: {
    ACCESS_DENIED: {
      prerequisite_id: 'private_application_product',
      owner_action: 'request_provisioning',
      resolution:
        'LinkedIn reports that this application is not provisioned for Audience Insights. Apply for, or confirm, Audience Insights access for the production application, then check again.',
    },
    USER_NOT_AUTHORIZED: {
      prerequisite_id: 'member_account_access',
      owner_action: 'verify_member_role',
      resolution:
        'LinkedIn reports that the connected member has no role on this ad account. Ask an account manager to give the member a role on the account in Campaign Manager, then check again.',
    },
  },
  // A refusal without a documented code (CON-04): the owner follows it up with LinkedIn; no cause is inferred.
  undocumented_refusal: {
    kind: 'contact_provider',
    text: 'LinkedIn refused this exact request without a documented code. AMCP infers no cause. Confirm the application approval for this product and the member’s role on this ad account with LinkedIn, citing the provider request reference, then check again.',
  },
  // With no selected account there is nothing to inspect yet (CON-04): set up the login first.
  account_setup: {
    text: 'No LinkedIn ad account is selected for AMCP. On the Connections page, connect a LinkedIn member who has a role on the ad account, sync the login and select the account, then inspect this program again.',
    prerequisites: [
      {
        id: 'member_account_access',
        text: 'The connected LinkedIn member needs a role on the ad account in Campaign Manager.',
      },
      {
        id: 'private_application_product',
        text: 'LinkedIn must provision this private product for the application; the program reference describes how.',
      },
    ],
  },
  next_call: withEffects({
    tool: 'amcp_workspace',
    arguments: {action: 'program_check', workflow_id: 'program:linkedin_audience_insights', live: false},
  }),
  website_path: '/capabilities?workflow_id=program%3Alinkedin_audience_insights',
  source: 'src/conditional-programs.ts',
};

/** A live planning read's native call (Media Planning's forecast or Audience Insights), from its requirements. */
function planningRequest(program: ConditionalProgram, requirements: JsonObject, account: string): JsonObject {
  validate(requirements, program.id === 'program:linkedin_forecast' ? ['forecast', 'request'] : ['request']);
  if (!obj(requirements.request)) bad('Supply the exact native planning request object.', 'PROGRAM_INPUT_REQUIRED');
  if (
    program.id === 'program:linkedin_forecast' &&
    !['forecastReaches', 'forecastImpressions', 'forecastLeads'].includes(requirements.forecast)
  )
    bad('Choose forecastReaches, forecastImpressions or forecastLeads.', 'PROGRAM_INPUT_REQUIRED');
  return {
    action: program.actions[0],
    api_version: linkedinVersion(),
    query: {action: program.id === 'program:linkedin_forecast' ? requirements.forecast : 'audienceInsights'},
    payload: {request: requirements.request},
    // LinkedIn's planning reads name the selected ad account.
    account_id: account,
  };
}

/** The evidence a live planning read keeps: the requested forecast curve and estimates, or the audience aggregates. */
function planningEvidence(
  program: ConditionalProgram,
  data: JsonObject,
  requirements: JsonObject,
  _account: string,
  rows: (kind: string, count: number) => void,
): JsonObject {
  if (!obj(data.value) || !Object.keys(data.value).length)
    bad('Retain the original nonempty native planning result.', 'PROGRAM_EVIDENCE_INVALID');
  if (program.id === 'program:linkedin_forecast') {
    const field = {
        forecastReaches: 'reachCurve',
        forecastImpressions: 'impressionCurve',
        forecastLeads: 'leadCurve',
      }[requirements.forecast as string],
      curve = data.value[field!];
    const point = (p: unknown) =>
      obj(p) &&
      Number.isSafeInteger(p.budgetMicros) &&
      p.budgetMicros >= 0 &&
      typeof p.metricValue === 'number' &&
      Number.isFinite(p.metricValue) &&
      p.metricValue >= 0 &&
      ['metricLower', 'metricUpper'].every(
        k => p[k] === undefined || (typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0),
      ) &&
      (p.metricLower === undefined || p.metricLower <= p.metricValue) &&
      (p.metricUpper === undefined || p.metricUpper >= p.metricValue);
    // LinkedIn's ForecastMetrics table types singlePointMetric as an array while its sample shows an object
    // (PRV-02): either is accepted, an array only with exactly one point. undefined: absent; null: refused.
    const single = (v: unknown): JsonObject | null | undefined =>
      v === undefined
        ? undefined
        : Array.isArray(v)
          ? v.length === 1 && point(v[0])
            ? (v[0] as JsonObject)
            : null
          : point(v)
            ? (v as JsonObject)
            : null;
    const target = requirements.request.targetBudgetMicros,
      selected = obj(curve) ? single(curve.singlePointMetric) : null;
    if (
      !obj(curve) ||
      !Array.isArray(curve.metricCurve) ||
      !curve.metricCurve.length ||
      curve.metricCurve.length > 101 ||
      !curve.metricCurve.every(point) ||
      new Set(curve.metricCurve.map((p: JsonObject) => p.budgetMicros)).size !== curve.metricCurve.length ||
      selected === null ||
      (target !== undefined && (!selected || selected.budgetMicros !== target))
    )
      bad(
        'Retain the requested native forecast curve and exact budget point; missing estimates are not zero.',
        'PROGRAM_EVIDENCE_INVALID',
      );
    const projectPoint = (p: JsonObject) => ({
      budgetMicros: p.budgetMicros,
      metricValue: p.metricValue,
      ...(p.metricLower !== undefined ? {metricLower: p.metricLower} : {}),
      ...(p.metricUpper !== undefined ? {metricUpper: p.metricUpper} : {}),
    });
    // The documented cost and frequency estimates at the selected budget, as LinkedIn reports them. One whose
    // shape or budget does not match is listed as unavailable, never as zero.
    const estimates: JsonObject = {},
      unavailable: string[] = [];
    for (const name of ['costPerReach', 'costPerThousandImpressions', 'costPerLead', 'averageFrequency']) {
      const metric = data.value[name];
      if (metric === undefined) continue;
      const p = obj(metric) ? single(metric.singlePointMetric) : null;
      if (p && (target === undefined || p.budgetMicros === target)) estimates[name] = projectPoint(p);
      else unavailable.push(name);
    }
    rows('forecast', curve.metricCurve.length + (selected ? 1 : 0) + Object.keys(estimates).length);
    return {
      forecast: requirements.forecast,
      currency: 'USD',
      curve: field,
      metric_curve: curve.metricCurve.map(projectPoint),
      single_point_metric: selected ? projectPoint(selected) : null,
      directional_estimates: {
        points: estimates,
        unavailable,
        meaning:
          'Directional LinkedIn estimates at the selected budget, not guaranteed results. Cost estimates are in USD and average frequency is impressions per member, as LinkedIn reports them.',
      },
    };
  }
  const value = data.value,
    insight = value.audienceInsight,
    outsideRange = value.totalAudienceCount === 0 || value.totalAudienceCount >= 100000000,
    suppressed = outsideRange && insight === undefined;
  if (
    !Number.isSafeInteger(value.totalAudienceCount) ||
    value.totalAudienceCount < 0 ||
    (value.totalAudienceCount > 0 && value.totalAudienceCount < 300) ||
    (!suppressed &&
      (!obj(insight) ||
        insight.groupedBy !== requirements.request.groupBy ||
        !Array.isArray(insight.segmentations) ||
        insight.segmentations.length > (requirements.request.maxReturnCount ?? 5) ||
        (outsideRange && insight.segmentations.length > 0) ||
        !insight.segmentations.every(
          (row: unknown) =>
            obj(row) &&
            typeof row.value === 'string' &&
            row.value.length <= 512 &&
            /^urn:li:[a-zA-Z][a-zA-Z0-9]*:[^\s<>]+$/.test(row.value) &&
            Number.isSafeInteger(row.entityCount) &&
            row.entityCount >= 30 &&
            row.entityCount <= value.totalAudienceCount &&
            Number.isInteger(row.entityPercentage) &&
            row.entityPercentage >= 0 &&
            row.entityPercentage <= 100,
        ) ||
        new Set(insight.segmentations.map((row: JsonObject) => row.value)).size !== insight.segmentations.length))
  )
    bad('Retain exact aggregated audience counts and the requested native grouping.', 'PROGRAM_EVIDENCE_INVALID');
  rows('audience_insights', suppressed ? 0 : insight.segmentations.length);
  return {
    total_audience_count: value.totalAudienceCount,
    grouped_by: suppressed ? null : insight.groupedBy,
    segmentations: suppressed
      ? null
      : insight.segmentations.map((row: JsonObject) => ({
          value: row.value,
          entityCount: row.entityCount,
          entityPercentage: row.entityPercentage,
        })),
    audience_range: outsideRange ? 'outside_supported_range' : 'within_supported_range',
    meaning: outsideRange
      ? 'LinkedIn suppressed audience segments outside its supported range. A reported zero does not establish an empty audience; a large count may be approximate.'
      : 'Returned segments are provider aggregates for this request. Omitted segments are not zero and these counts are not campaign performance.',
  };
}

/** LinkedIn's programs, in the order capabilities lists them, each with its check's steps. */
export const linkedinConditionalPrograms: readonly ProviderConditionalProgram[] = Object.freeze([
  Object.freeze({
    program: forecast,
    steps: Object.freeze({
      template: (account?: string) => linkedinPlanningTemplate('forecast', account),
      request: planningRequest,
      evidence: planningEvidence,
    }),
  }),
  Object.freeze({
    program: audienceInsights,
    steps: Object.freeze({
      template: (account?: string) => linkedinPlanningTemplate('insights', account),
      request: planningRequest,
      evidence: planningEvidence,
    }),
  }),
]);
