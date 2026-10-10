import type {Actor, JsonObject} from './types.js';
import type {Registry} from './catalog.js';
import type {Store} from './store.js';
import {actionContracts} from './action-contracts.js';
import {bad, fingerprint, obj, optional, validate, type ToolCall} from './workspace-core.js';
import {normalizeAccount} from './scope.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {linkedinVersion} from './linkedin-version.js';
import {storedLogin} from './connection-authority.js';
import {linkedinPlanningTemplate} from './linkedin-planning-reads.js';
import {withEffects} from './workflow-outcomes.js';

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
    // Display & Video 360 documents no program-specific refusal codes; a refusal points to the user profile (CON-04).
    undocumented_refusal: {
      kind: 'verify_member_role',
      text: 'Display & Video 360 refused this advertiser read. Confirm that the Google identity of this login has a Display & Video 360 user profile with Admin, Standard or Read only access to this advertiser or its partner, then check again. AMCP infers no other cause.',
    },
    account_setup: {
      text: 'No Display & Video 360 advertiser is selected for AMCP. On the Connections page, connect the Google identity that has Display & Video 360 access, sync it and select the advertiser, then inspect this program again.',
      prerequisites: [
        {
          id: 'dv360_customer_role',
          text: 'The Google identity needs a Display & Video 360 user profile with Admin, Standard or Read only access to the partner or advertiser.',
        },
        {
          id: 'display_video_oauth_scope',
          text: 'Grant the Display & Video 360 permission when you connect the Google identity.',
        },
        {
          id: 'exact_advertiser_access',
          text: 'AMCP lists advertisers through the partners the identity can see. After syncing, select the advertiser to expose to MCP.',
        },
      ],
    },
    next_call: withEffects({
      tool: 'amcp_workspace',
      arguments: {action: 'program_check', workflow_id: 'program:dv360_advertiser', live: false},
    }),
    website_path: '/capabilities?workflow_id=program%3Adv360_advertiser',
    source: 'src/conditional-programs.ts',
  },
] satisfies JsonObject[];

export function conditionalProgram(id: unknown) {
  return conditionalPrograms.find(p => p.id === id);
}
/** A provider correlation reference: at most 128 token characters, never free text. */
const reference = (v: unknown) =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:+=/-]{0,127}$/.test(v) ? v : null;
/**
 * The allow-listed facts of a refused program read (PRV-02): AMCP's code, the provider's HTTP status, the provider's code
 * as a closed set (a documented refusal of this program, otherwise OTHER; null when the provider named none), AMCP's
 * request ID and the provider's request ID. Never the response body or a provider message.
 */
export function programNativeError(program: {documented_refusals?: JsonObject}, response: JsonObject) {
  const error = obj(response.error) ? response.error : {},
    details = obj(error.details) ? error.details : {},
    upstream = obj(details.upstream) ? details.upstream : {},
    raw = details.provider_code ?? upstream.code,
    reported =
      typeof raw === 'number' && Number.isSafeInteger(raw)
        ? String(raw)
        : typeof raw === 'string' && /^[A-Z0-9_]{2,64}$/.test(raw)
          ? raw
          : undefined,
    documented = reported !== undefined && Object.hasOwn(program.documented_refusals ?? {}, reported),
    amcp = typeof response.meta?.requestId === 'string' ? response.meta.requestId : null;
  return {
    native_error: {
      code: typeof error.code === 'string' ? error.code : 'UPSTREAM_ERROR',
      http_status: Number.isInteger(details.http_status) ? details.http_status : null,
      provider_code: reported === undefined ? null : documented ? reported : 'OTHER',
      amcp_request_id: amcp,
      // `request_id` is AMCP's own request ID, kept as an alias of amcp_request_id for one release.
      request_id: amcp,
      provider_request_id: reference(details.request_id),
    },
    documented: documented ? (program.documented_refusals![reported!] as JsonObject) : undefined,
    reported,
  };
}

/** The JSON Schema of a program check's `requirements` (CON-04); with `account`, the ad account is fixed. */
export function conditionalProgramTemplate(id: string, account?: string): JsonObject {
  return id === 'program:linkedin_forecast'
    ? linkedinPlanningTemplate('forecast', account)
    : id === 'program:linkedin_audience_insights'
      ? linkedinPlanningTemplate('insights', account)
      : {type: 'object', additionalProperties: false, properties: {}};
}
/** The required argument paths of a live check, nested requirements included, e.g. requirements.request.groupBy. */
function requiredPaths(schema: JsonObject, prefix: string): string[] {
  return (schema.required ?? []).flatMap((key: string) => {
    const child = schema.properties?.[key] ?? {},
      path = prefix + '.' + key;
    return obj(child.properties) && Array.isArray(child.required) && !child.examples
      ? requiredPaths(child, path)
      : [path];
  });
}
/**
 * Program discovery for capabilities (CON-04): the requirements template, and for a program with no selected account
 * the setup path instead of a program_check that can only refuse (PROGRAM_ACCOUNT_REQUIRED or CONNECTION_REQUIRED).
 */
export function programDiscovery(workflow: JsonObject): JsonObject {
  const program = conditionalProgram(workflow.id);
  if (!program) return workflow;
  const {account_setup: _setup, ...discovered} = workflow;
  return {
    ...discovered,
    requirements_template: conditionalProgramTemplate(program.id),
    ...(workflow.accounts?.length
      ? {}
      : {
          next_call: null,
          website_path: '/connections',
          setup: {
            ...program.account_setup,
            website_path: '/connections',
            then: {tool: 'amcp_workspace', arguments: {action: 'capabilities', workflow_id: program.id}},
          },
        }),
  };
}

/** How long a program observation is kept (owner decision D20): timestamped evidence, never a grant. */
export const programObservationLifetimeMs = 30 * 86400000;
const observationKind = 'conditional_program_observation';
const observationId = (workflow: string, connection: string, account: string) =>
  fingerprint([workflow, connection, account]);
/** The latest unexpired observation of a program read for this exact workflow, login and account (D20). */
export function programObservation(
  store: Store,
  tenant: string,
  workflow: string,
  connection: string,
  account: string,
): JsonObject | undefined {
  const o = optional(store, tenant, observationKind, observationId(workflow, connection, account));
  return o?.workflow_id === workflow &&
    o.connection_id === connection &&
    o.account_id === account &&
    Number.isSafeInteger(o.expires_at) &&
    o.expires_at > Date.now()
    ? o
    : undefined;
}
/**
 * Keeps one live program read as a timestamped observation (D20, CON-04): the state, AMCP's and the provider's codes,
 * the HTTP status and the request references, never the request, the response or a provider message. It is labelled
 * not a grant, expires after 30 days, is replaced by the next read and is removed when the login is disconnected.
 */
function retainObservation(store: Store, actor: Actor, result: JsonObject, amcpRequestId: unknown) {
  const now = Date.now(),
    e = result.native_error ?? {};
  store.db
    .prepare("DELETE FROM documents WHERE tenant_id=? AND kind=? AND json_extract(data,'$.expires_at')<=?")
    .run(actor.tenantId, observationKind, now);
  const observation = {
    record_kind: observationKind,
    workflow_id: result.workflow_id,
    gateway: result.scope.gateway,
    connection_id: result.scope.connection_id,
    account_id: result.scope.account_id,
    state: result.state,
    code: e.code ?? null,
    http_status: e.http_status ?? null,
    provider_code: e.provider_code ?? null,
    provider_request_id: e.provider_request_id ?? null,
    amcp_request_id: e.amcp_request_id ?? (typeof amcpRequestId === 'string' ? amcpRequestId : null),
    checked_at: result.checked_at,
    expires_at: result.checked_at + programObservationLifetimeMs,
    grant: false,
    meaning:
      'A timestamped observation of one program read, kept for 30 days. It is not a grant and does not establish current access, entitlement or eligibility.',
  };
  store.putDocument(
    actor.tenantId,
    observationKind,
    observationId(result.workflow_id, result.scope.connection_id, result.scope.account_id),
    observation,
  );
  return {
    ...result,
    workspace_documents_saved: 1,
    observation: {kind: observationKind, expires_at: observation.expires_at, grant: false},
  };
}
const reconnect = {
    kind: 'reauthorize',
    text: 'Reconnect this login on the Connections page, then check the program again.',
  },
  regrant = {
    kind: 'reauthorize',
    text: 'Reconnect this login on the Connections page and grant the permission the program requires, then check the program again.',
  };
/**
 * The owner's follow-up for a refused program read (CON-04). Repeating the same request returns the same refusal, so
 * there is no live retry: a documented code names its prerequisite, a credential or permission refusal needs the login
 * reconnected, and any other refusal is followed up with the provider. No cause is inferred.
 */
function ownerAction(program: JsonObject, code: string, documented?: JsonObject) {
  const action = documented
    ? {kind: documented.owner_action, text: documented.resolution}
    : ['AUTH_EXPIRED', 'REAUTHORIZATION_REQUIRED'].includes(code)
      ? reconnect
      : ['INSUFFICIENT_SCOPE', 'PROVIDER_PERMISSION_MISSING'].includes(code)
        ? regrant
        : program.undocumented_refusal;
  return {kind: action.kind, reference: program.program.reference, text: action.text};
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

/** Read-only qualification of one request. A live read keeps one timestamped observation, never a grant (D20); no
 * readiness grant, approval or job is saved. */
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
      ...(missing.length ? {owner_action: {...regrant, reference: program.program.reference}} : {}),
    };
  if (input.live !== true) {
    // The exact shape of a live check (CON-04): its requirements as JSON Schema and every required argument path.
    const template = conditionalProgramTemplate(program.id, account),
      last = programObservation(store, actor.tenantId, program.id, connection.id, account);
    return {
      ...base,
      state: 'unverified',
      blockers: [],
      next_call: withEffects({
        tool: 'amcp_workspace',
        arguments: {
          ...input,
          action: 'program_check',
          live: true,
          ...(program.id === 'program:dv360_advertiser' ? {requirements: {}} : {}),
        },
      }),
      required_inputs: ['connection_id', 'account_id', ...requiredPaths(template, 'requirements')],
      requirements_template: template,
      ...(last ? {last_observation: last} : {}),
    };
  }
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
          blocked = [
            'PROVIDER_ACCESS_DENIED',
            'INSUFFICIENT_SCOPE',
            'PROVIDER_PERMISSION_MISSING',
            'AUTH_EXPIRED',
            'REAUTHORIZATION_REQUIRED',
          ].includes(code);
        if (!counters.requests)
          bad(response.error?.message ?? 'The exact program request could not be validated.', code);
        const {native_error, documented, reported} = programNativeError(program as JsonObject, response),
          wait = response.error?.details?.retry_after_ms;
        return retainObservation(
          store,
          actor,
          {
            ...base,
            checked_at: Date.now(),
            state: blocked ? 'blocked' : 'unverified',
            blockers: [code],
            native_error,
            // What LinkedIn's documented refusal names, worded as reported by LinkedIn. No cause is inferred otherwise.
            ...(documented
              ? {
                  provider_reported_prerequisite: {
                    prerequisite_id: documented.prerequisite_id,
                    provider_code: reported,
                    resolution: documented.resolution,
                    reference: program.program.reference,
                    meaning:
                      'As reported by the provider in its documented refusal. AMCP infers no other cause, and the entitlement remains unverified.',
                  },
                }
              : {}),
            provider_requests: counters.requests,
            // A refusal is followed up by the owner, not by repeating the request (CON-04). Any other failure keeps one
            // retry of the same read, which can change the answer.
            ...(blocked
              ? {owner_action: ownerAction(program, code, documented), retry_after_provisioning: true, next_call: null}
              : {
                  retry_hint: {
                    text: 'The provider gave no usable answer to this read. It is not a refusal and no cause is inferred. One later check of this exact request can change the answer.',
                    ...(Number.isSafeInteger(wait) && wait > 0 ? {retry_after_ms: wait} : {}),
                  },
                  next_call: withEffects({tool: 'amcp_workspace', arguments: {...input, action: 'program_check'}}),
                }),
          },
          response.meta?.requestId,
        );
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
          bound.rows('forecast', curve.metricCurve.length + (selected ? 1 : 0) + Object.keys(estimates).length);
          evidence = {
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
      return retainObservation(
        store,
        actor,
        {
          ...base,
          state: 'observed',
          checked_at: Date.now(),
          provider_requests: counters.requests,
          blockers: [],
          evidence,
          source_reference: {
            source_request: args,
            source_hash: fingerprint(data),
            requested_at,
            captured_at: Date.now(),
          },
          next_call: withEffects({tool: 'amcp_workspace', arguments: {...input, action: 'program_check', live: false}}),
        },
        response.meta?.requestId,
      );
    });
  } finally {
    bound.close();
  }
}
