import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * LinkedIn planning reads, per Microsoft Learn "Audience Insights" (POST /rest/targetingAudienceInsights?action=
 * audienceInsights) and "Media Planning" (POST /rest/mediaPlanning?action=forecastReaches, forecastImpressions or
 * forecastLeads), li-lms-2026-09, read 2026-09-29. Both return aggregated estimates for a targeting criteria and create
 * nothing, although they use POST and the captured catalog lists them with the writes. Both are private LinkedIn
 * products: an application LinkedIn has not provisioned is refused with 403 ACCESS_DENIED. The request names the ad
 * account in its body, which must be the selected one.
 */
const insightsPath = '/rest/targetingAudienceInsights',
  planningPath = '/rest/mediaPlanning',
  forecasts = ['forecastReaches', 'forecastImpressions', 'forecastLeads'],
  maxBytes = 64 * 1024,
  day = 86400000;
const groupBy = [
  'jobFunctions',
  'seniorities',
  'titles',
  'yearsOfExperienceRanges',
  'interests',
  'productInterests',
  'skills',
  'industries',
  'staffCountRanges',
  'growthRate',
  'employers',
  'bingContinent',
  'bingCountry',
  'bingCity',
  'bingState',
].map(f => 'urn:li:adTargetingFacet:' + f);
const objectives = ['BRAND_AWARENESS', 'VIDEO_VIEW', 'LEAD_GENERATION'],
  optimizations = ['MAX_REACH', 'MAX_IMPRESSION', 'MAX_VIDEO_VIEW', 'MAX_LEAD'];
const forecastKeys = [
  'sponsoredAccountUrn',
  'targetingCriteria',
  'currencyCode',
  'objectiveType',
  'optimizationType',
  'startDateOn',
  'endDateOn',
  'targetBudgetMicros',
  'enableAudienceNetwork',
  'enableAudienceExpansion',
  'ctvOnly',
];
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  throw new MirrorError('INVALID_LINKEDIN_PLANNING_READ', message);
}
export function linkedinPlanningRoute(p: CompiledRequest): 'insights' | 'forecast' | undefined {
  if (
    p.gateway !== 'linkedin_native_action' ||
    p.method !== 'POST' ||
    p.specialTransport ||
    (p.origin !== undefined && p.origin !== 'https://api.linkedin.com')
  )
    return;
  return p.path === insightsPath ? 'insights' : p.path === planningPath ? 'forecast' : undefined;
}
const account = (p: CompiledRequest) => 'urn:li:sponsoredAccount:' + p.accountId;
function date(value: unknown, field: string): number {
  if (!obj(value) || Object.keys(value).some(k => !['day', 'month', 'year'].includes(k)))
    invalid(field + ' must be a {day, month, year} date.');
  const {day: d, month: m, year: y} = value as {day: unknown; month: unknown; year: unknown};
  const t = Date.UTC(Number(y), Number(m) - 1, Number(d));
  if (
    ![d, m, y].every(Number.isInteger) ||
    new Date(t).getUTCDate() !== d ||
    new Date(t).getUTCMonth() !== Number(m) - 1
  )
    invalid(field + ' is not a calendar date.');
  return t;
}
function targeting(value: unknown) {
  if (!obj(value) || !obj(value.include) || Object.keys(value).some(k => !['include', 'exclude'].includes(k)))
    invalid('targetingCriteria must be an object with include and an optional exclude.');
}
export function validateLinkedinPlanningRead(p: CompiledRequest, now = Date.now()): void {
  const kind = linkedinPlanningRoute(p);
  if (!kind) return;
  if (!p.accountId || !/^[1-9][0-9]{0,31}$/.test(p.accountId))
    throw new MirrorError(
      'ACCOUNT_SCOPE_MISMATCH',
      'Select the exact LinkedIn ad account for this planning read.',
      {},
      403,
    );
  if (Object.keys(p.headers).some(h => !['linkedin-version', 'x-restli-protocol-version'].includes(h.toLowerCase())))
    invalid('Planning reads take no header overrides.');
  const actions = kind === 'insights' ? ['audienceInsights'] : forecasts;
  if (Object.keys(p.query).length !== 1 || !actions.includes(String(p.query.action)))
    invalid('The only query parameter is action: ' + actions.join(', ') + '.');
  const b = p.body;
  if (!obj(b) || Object.keys(b).length !== 1 || !obj(b.request)) invalid('Send the native body: {request: {...}}.');
  if (Buffer.byteLength(JSON.stringify(b)) > maxBytes)
    invalid("The request exceeds AMCP's 64 KiB bound for planning reads.");
  const r = b.request as JsonObject;
  if (kind === 'insights') {
    const bad = Object.keys(r).find(
      k => !['requestMetaData', 'targetingCriteria', 'groupBy', 'segmentsOrderedBy', 'maxReturnCount'].includes(k),
    );
    if (bad) invalid('"' + bad + '" is not an Audience Insights request field.');
    const meta = r.requestMetaData;
    // The reference table names the field sponsoredAccountUrn; its sample sends sponsoredAccount. Either, not both.
    if (
      !obj(meta) ||
      Object.keys(meta).length !== 1 ||
      !['sponsoredAccount', 'sponsoredAccountUrn'].includes(Object.keys(meta)[0]!)
    )
      invalid('requestMetaData names only the ad account: {sponsoredAccountUrn: "urn:li:sponsoredAccount:<id>"}.');
    if (Object.values(meta)[0] !== account(p))
      throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'The planning read must name the selected ad account.', {}, 403);
    targeting(r.targetingCriteria);
    if (!groupBy.includes(r.groupBy))
      invalid('groupBy must be one of the documented facets: ' + groupBy.join(', ') + '.');
    if (r.segmentsOrderedBy !== undefined && !['AUDIENCE_PERCENTAGE', 'HIERARCHICAL'].includes(r.segmentsOrderedBy))
      invalid('segmentsOrderedBy must be AUDIENCE_PERCENTAGE or HIERARCHICAL.');
    if (
      r.maxReturnCount !== undefined &&
      (!Number.isInteger(r.maxReturnCount) || r.maxReturnCount < 1 || r.maxReturnCount > 100)
    )
      invalid('maxReturnCount must be a whole number from 1 to 100.');
    return;
  }
  const bad = Object.keys(r).find(k => !forecastKeys.includes(k));
  if (bad) invalid('"' + bad + '" is not a Media Planning request field.');
  if (r.sponsoredAccountUrn !== account(p))
    throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'The planning read must name the selected ad account.', {}, 403);
  targeting(r.targetingCriteria);
  if (!objectives.includes(r.objectiveType)) invalid('objectiveType must be ' + objectives.join(', ') + '.');
  if (r.optimizationType !== undefined && !optimizations.includes(r.optimizationType))
    invalid('optimizationType must be ' + optimizations.join(', ') + '.');
  if (r.currencyCode !== undefined && r.currencyCode !== 'USD') invalid('Media Planning forecasts in USD only.');
  for (const k of ['enableAudienceNetwork', 'enableAudienceExpansion', 'ctvOnly'])
    if (r[k] !== undefined && typeof r[k] !== 'boolean') invalid(k + ' must be true or false.');
  if (r.ctvOnly === true && (r.objectiveType !== 'BRAND_AWARENESS' || r.enableAudienceNetwork === false))
    invalid('ctvOnly needs the BRAND_AWARENESS objective with the Audience Network enabled.');
  if (
    r.targetBudgetMicros !== undefined &&
    (!Number.isSafeInteger(r.targetBudgetMicros) || r.targetBudgetMicros < 100000000)
  )
    invalid('targetBudgetMicros must be whole micros of at least 100000000 ($100).');
  const today = Math.floor(now / day) * day;
  const start = r.startDateOn === undefined ? undefined : date(r.startDateOn, 'startDateOn'),
    end = r.endDateOn === undefined ? undefined : date(r.endDateOn, 'endDateOn');
  for (const [t, f] of [
    [start, 'startDateOn'],
    [end, 'endDateOn'],
  ] as const)
    if (t !== undefined && t <= today) invalid(f + ' must be in the future.');
  if ((start ?? today) > (end ?? (start ?? today) + 90 * day)) invalid('endDateOn must not be before startDateOn.');
  if ((end ?? (start ?? today) + 90 * day) - (start ?? today) > 90 * day) invalid('A forecast covers at most 90 days.');
}
/** The ad account a planning read names in its body (validated at compile time), for the read scope check. */
export function linkedinPlanningAccount(p: CompiledRequest): string | undefined {
  const kind = linkedinPlanningRoute(p),
    r = obj(p.body) && obj(p.body.request) ? p.body.request : undefined;
  const value =
    !kind || !r
      ? undefined
      : kind === 'insights'
        ? obj(r.requestMetaData)
          ? Object.values(r.requestMetaData)[0]
          : undefined
        : r.sponsoredAccountUrn;
  return typeof value === 'string' ? /^urn:li:sponsoredAccount:(\d+)$/.exec(value)?.[1] : undefined;
}
/** Compiler hook: a valid planning request is a read and never a reviewed mutation. */
export function linkedinPlanningPlan(p: CompiledRequest): CompiledRequest {
  const kind = linkedinPlanningRoute(p);
  if (!kind) return p;
  validateLinkedinPlanningRead(p);
  return {
    ...p,
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    warnings: [
      ...p.warnings,
      kind === 'insights'
        ? 'Audience Insights are LinkedIn aggregates of the audience the targeting describes; they create and change nothing.'
        : "The forecasted results are directional estimates and don't guarantee the actual performance of campaigns (LinkedIn's required notice). The forecast creates, books and saves nothing.",
      "LinkedIn tools may not be used to discriminate based on personal characteristics like gender, age, race, or ethnicity (LinkedIn's required notice).",
    ],
  };
}
