import type {Actor, JsonObject} from './types.js';
import type {Registry} from './catalog.js';
import type {Store} from './store.js';
import {actionContracts} from './action-contracts.js';
import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {normalizeAccount} from './scope.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {linkedinVersion} from './linkedin-version.js';
import {storedLogin} from './connection-authority.js';

/** Exact existing read contracts. Product provisioning and customer access are separate prerequisites.
 * The official references were checked on 2026-10-06; discovery never treats them as an entitlement. */
export const conditionalPrograms = [
  {
    id: 'program:linkedin_forecast',
    kind: 'conditional_program',
    name: 'LinkedIn Media Planning forecast',
    gateway: 'linkedin_native_action',
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
    next_call: {
      tool: 'amcp_workspace',
      arguments: {action: 'program_check', workflow_id: 'program:linkedin_forecast', live: false},
    },
    website_path: '/capabilities?workflow_id=program%3Alinkedin_forecast',
    source: 'src/conditional-programs.ts',
  },
  {
    id: 'program:linkedin_audience_insights',
    kind: 'conditional_program',
    name: 'LinkedIn Audience Insights',
    gateway: 'linkedin_native_action',
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
    next_call: {
      tool: 'amcp_workspace',
      arguments: {action: 'program_check', workflow_id: 'program:linkedin_audience_insights', live: false},
    },
    website_path: '/capabilities?workflow_id=program%3Alinkedin_audience_insights',
    source: 'src/conditional-programs.ts',
  },
  {
    id: 'program:dv360_advertiser',
    kind: 'conditional_program',
    name: 'Display & Video 360 advertiser access',
    gateway: 'dv360_native_action',
    objective: 'advertiser_access',
    description: 'Read the exact configured advertiser and retain its native partner, currency and status.',
    effects: 'provider_reads',
    effect_details: 'This read changes no advertiser settings, line items, reports or download jobs.',
    required_inputs: ['connection_id', 'account_id'],
    prerequisite_ids: ['display_video_oauth_scope', 'dv360_customer_role', 'exact_advertiser_access'],
    actions: ['DV360_ADVERTISERS_GET'],
    recorded_scopes: ['https://www.googleapis.com/auth/display-video'],
    program: {
      access:
        'The Google identity must have access to the selected Display & Video 360 advertiser or its parent partner. The recorded OAuth scope is a separate prerequisite.',
      reference: 'https://developers.google.com/display-video/api/guides/getting-started/overview',
      checked_on: '2026-10-06',
      limitations:
        'An advertiser read does not establish write permission, line-item eligibility or Bid Manager reporting access. Bid Manager uses its own OAuth scope and report workflow.',
    },
    next_call: {
      tool: 'amcp_workspace',
      arguments: {action: 'program_check', workflow_id: 'program:dv360_advertiser', live: false},
    },
    website_path: '/capabilities?workflow_id=program%3Adv360_advertiser',
    source: 'src/conditional-programs.ts',
  },
] satisfies JsonObject[];

export function conditionalProgram(id: unknown) {
  return conditionalPrograms.find(p => p.id === id);
}

/** Add current executable workflow discovery without rewriting captured catalog method/risk flags. */
export function conditionalProgramDescription(registry: Registry, gateway: string, action: unknown) {
  const program = conditionalPrograms.find(p => p.gateway === gateway && p.actions.includes(action as string));
  if (!program) return undefined;
  const contract = actionContracts(registry).find(c => c.gateway === gateway && c.action === action);
  return {
    workflow_id: program.id,
    native_contract_status: contract?.status ?? 'unmapped',
    effects: program.effects,
    required_inputs: program.required_inputs,
    required_recorded_scopes: program.recorded_scopes,
    program: program.program,
    entitlement: 'unverified',
    meaning:
      'Captured catalog flags are separate from AMCP’s validated read contract. Inspect this exact conditional workflow before making a provider request.',
    next_call: {tool: 'amcp_workspace', arguments: {action: 'capabilities', workflow_id: program.id}},
  };
}

/** Read-only, ephemeral qualification of one request. No readiness grant, document, approval or job is saved. */
export async function checkConditionalProgram(
  store: Store,
  registry: Registry,
  call: ToolCall,
  actor: Actor,
  input: JsonObject,
) {
  validate(input, ['action', 'workflow_id', 'connection_id', 'account_id', 'requirements', 'live']);
  if (input.live !== undefined && typeof input.live !== 'boolean')
    bad('Choose an explicit live read or local prerequisite inspection.');
  const program = conditionalProgram(input.workflow_id);
  if (!program) bad('Choose an exact conditional program returned by capabilities.', 'PROGRAM_NOT_FOUND');
  if (typeof input.account_id !== 'string' || typeof input.connection_id !== 'string')
    bad('Select the exact configured account and login for this program.', 'PROGRAM_ACCOUNT_REQUIRED');
  const account = normalizeAccount(program.gateway, input.account_id),
    connection = store.resolveConnection(actor, program.gateway, account, input.connection_id),
    authorization = fingerprint(storedLogin(store, connection)),
    missing = program.recorded_scopes.filter(s => !connection.scopes.includes(s)),
    contracts = actionContracts(registry).filter(
      c => c.gateway === program.gateway && program.actions.includes(c.action),
    ),
    qualified = contracts.length === program.actions.length && contracts.every(c => c.status === 'native_read');
  if (!/^[1-9][0-9]{0,19}$/.test(account))
    bad('Select the exact native numeric account identifier.', 'PROGRAM_ACCOUNT_REQUIRED');
  const current = () => {
    store.assertActorActive(actor);
    const c = store.resolveConnection(actor, program.gateway, account, connection.id);
    if (connection.scopes.some(s => !c.scopes.includes(s)))
      bad('The selected login lost recorded permissions. Inspect the program again.', 'INSUFFICIENT_SCOPE');
    if (fingerprint(storedLogin(store, c)) !== authorization)
      bad('The selected login changed. Inspect the program again.', 'CONNECTION_AUTHORITY_CHANGED');
  };
  current();
  const base = {
    record_kind: 'conditional_program_check',
    workflow_id: program.id,
    scope: {gateway: program.gateway, connection_id: connection.id, account_id: account},
    program: program.program,
    checked_at: Date.now(),
    provider_requests: 0,
    advertising_writes: 0,
    workspace_documents_saved: 0,
    recorded_scopes: {required: program.recorded_scopes, missing},
    contracts: contracts.map(c => ({action: c.action, status: c.status, live_qualification: c.live_qualification})),
    entitlement: 'unverified',
    meaning:
      'Qualification applies only to this exact request and observation time. It grants no access and does not establish other program, write or delivery eligibility.',
    website_path:
      program.website_path +
      '&connection_id=' +
      encodeURIComponent(connection.id) +
      '&account_id=' +
      encodeURIComponent(account),
  };
  if (missing.length || !qualified)
    return {
      ...base,
      state: 'blocked',
      blockers: [...missing.map(s => 'provider_scope:' + s), ...(!qualified ? ['native_read_contract_required'] : [])],
    };
  if (input.live !== true)
    return {
      ...base,
      state: 'unverified',
      blockers: [],
      next_call: {tool: 'amcp_workspace', arguments: {...input, action: 'program_check', live: true}},
      required_inputs: program.required_inputs,
    };
  if (!obj(input.requirements ?? {})) bad('Program requirements must be an object.');
  const requirements = input.requirements ?? {};
  let args: JsonObject;
  if (program.id === 'program:dv360_advertiser') {
    validate(requirements, []);
    args = {action: program.actions[0], pathParams: {advertiserId: account}};
  } else {
    validate(requirements, program.id === 'program:linkedin_forecast' ? ['forecast', 'request'] : ['request']);
    if (!obj(requirements.request)) bad('Supply the exact native planning request object.', 'PROGRAM_INPUT_REQUIRED');
    if (
      program.id === 'program:linkedin_forecast' &&
      !['forecastReaches', 'forecastImpressions', 'forecastLeads'].includes(requirements.forecast)
    )
      bad('Choose forecastReaches, forecastImpressions or forecastLeads.', 'PROGRAM_INPUT_REQUIRED');
    args = {
      action: program.actions[0],
      api_version: linkedinVersion(),
      query: {action: program.id === 'program:linkedin_forecast' ? requirements.forecast : 'audienceInsights'},
      payload: {request: requirements.request},
    };
  }
  args = {
    ...args,
    ...(program.gateway === 'linkedin_native_action' ? {account_id: account} : {}),
    connection_id: connection.id,
    dry_run: false,
  };
  let counters: JsonObject = {};
  const bound = new ReportCollectionBudget(
    undefined,
    fingerprint({scope: base.scope, args}),
    state => {
      counters = state;
    },
    {requests: 3, rows: 1000, bytes: 2 * 1024 * 1024, elapsed_ms: 30000},
  );
  try {
    return await bound.run(async () => {
      const requested_at = Date.now();
      current();
      const response = await call(program.gateway, args, actor);
      current();
      if (!response.success) {
        const code = response.error?.code ?? 'UPSTREAM_ERROR',
          blocked = ['PROVIDER_ACCESS_DENIED', 'INSUFFICIENT_SCOPE', 'AUTH_EXPIRED'].includes(code);
        if (!counters.requests)
          bad(response.error?.message ?? 'The exact program request could not be validated.', code);
        return {
          ...base,
          checked_at: Date.now(),
          state: blocked ? 'blocked' : 'unverified',
          blockers: [code],
          native_error: {code, request_id: response.meta?.requestId ?? null},
          provider_requests: counters.requests,
          next_call: {tool: 'amcp_workspace', arguments: {...input, action: 'program_check'}},
        };
      }
      const data = response.data?.data;
      if (
        !obj(data) ||
        response.data?.truncated ||
        data.error !== undefined ||
        data.errors !== undefined ||
        data.partial === true ||
        data.truncated === true ||
        data.nextPageToken !== undefined
      )
        bad('The provider returned incomplete or ambiguous program evidence.', 'PROGRAM_EVIDENCE_INVALID');
      let evidence: JsonObject;
      if (program.id === 'program:dv360_advertiser') {
        if (
          data.advertiserId !== account ||
          typeof data.partnerId !== 'string' ||
          !/^[1-9][0-9]{0,19}$/.test(data.partnerId) ||
          !obj(data.generalConfig) ||
          typeof data.generalConfig.currencyCode !== 'string' ||
          !/^[A-Z]{3}$/.test(data.generalConfig.currencyCode) ||
          (data.entityStatus !== undefined &&
            (typeof data.entityStatus !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(data.entityStatus)))
        )
          bad('Retain the exact native advertiser, parent partner and currency.', 'PROGRAM_EVIDENCE_INVALID');
        evidence = {
          advertiser_id: data.advertiserId,
          partner_id: data.partnerId,
          currency: data.generalConfig.currencyCode,
          entity_status: data.entityStatus ?? null,
        };
      } else {
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
          if (
            !obj(curve) ||
            !Array.isArray(curve.metricCurve) ||
            !curve.metricCurve.length ||
            curve.metricCurve.length > 101 ||
            !curve.metricCurve.every(point) ||
            new Set(curve.metricCurve.map((p: JsonObject) => p.budgetMicros)).size !== curve.metricCurve.length ||
            (curve.singlePointMetric !== undefined && !point(curve.singlePointMetric)) ||
            (requirements.request.targetBudgetMicros !== undefined &&
              (!point(curve.singlePointMetric) ||
                curve.singlePointMetric.budgetMicros !== requirements.request.targetBudgetMicros))
          )
            bad(
              'Retain the requested native forecast curve and exact budget point; missing estimates are not zero.',
              'PROGRAM_EVIDENCE_INVALID',
            );
          bound.rows('forecast', curve.metricCurve.length + (curve.singlePointMetric ? 1 : 0));
          const projectPoint = (p: JsonObject) => ({
            budgetMicros: p.budgetMicros,
            metricValue: p.metricValue,
            ...(p.metricLower !== undefined ? {metricLower: p.metricLower} : {}),
            ...(p.metricUpper !== undefined ? {metricUpper: p.metricUpper} : {}),
          });
          evidence = {
            forecast: requirements.forecast,
            currency: 'USD',
            curve: field,
            metric_curve: curve.metricCurve.map(projectPoint),
            single_point_metric: curve.singlePointMetric ? projectPoint(curve.singlePointMetric) : null,
          };
        } else {
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
                new Set(insight.segmentations.map((row: JsonObject) => row.value)).size !==
                  insight.segmentations.length))
          )
            bad(
              'Retain exact aggregated audience counts and the requested native grouping.',
              'PROGRAM_EVIDENCE_INVALID',
            );
          bound.rows('audience_insights', suppressed ? 0 : insight.segmentations.length);
          evidence = {
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
      }
      return {
        ...base,
        state: 'observed',
        checked_at: Date.now(),
        provider_requests: counters.requests,
        blockers: [],
        evidence,
        source_reference: {source_request: args, source_hash: fingerprint(data), requested_at, captured_at: Date.now()},
        next_call: {tool: 'amcp_workspace', arguments: {...input, action: 'program_check', live: false}},
      };
    });
  } finally {
    bound.close();
  }
}
