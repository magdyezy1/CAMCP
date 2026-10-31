import type {Actor, JsonObject} from './types.js';
import type {Registry} from './catalog.js';
import type {Store} from './store.js';
import type {ConditionalProgram, ConditionalProgramSteps} from './provider-adapter.js';
import {actionContracts} from './action-contracts.js';
import {bad, fingerprint, obj, optional, validate, type ToolCall} from './workspace-core.js';
import {normalizeAccount} from './scope.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {storedLogin} from './connection-authority.js';
import {withEffects} from './workflow-outcomes.js';
import {discoveryOnlyProgram} from './discovery-programs.js';
import {registeredProviderHooks} from './provider-hooks.js';

/** Exact existing read contracts. Product provisioning and customer access are separate prerequisites.
 * The official references were checked on 2026-10-06; discovery never treats them as an entitlement. Each is mode
 * live_read: one bounded read can check it. Programs AMCP lists but never checks are discovery_only
 * (src/discovery-programs.ts, ACC-05). Each program is its provider's (its hooks' `programs`,
 * src/<provider>-conditional-programs.ts; ARC-01), listed in the hooks registry's order with its check's provider
 * steps: its requirements template, its native request and the evidence it keeps. This module keeps every other rule
 * of a check and their order. */
const declared = registeredProviderHooks.flatMap(hooks =>
  (hooks.programs ?? []).map(declaration => {
    // A load-time check: a program is checked through its own provider's gateway, and named once.
    if (declaration.program.gateway !== hooks.gateway)
      throw new Error('The program ' + declaration.program.id + ' is not a program of ' + hooks.gateway + '.');
    return declaration;
  }),
);
if (new Set(declared.map(d => d.program.id)).size !== declared.length)
  throw new Error('Two providers declare one conditional program.');
export const conditionalPrograms: ConditionalProgram[] = declared.map(d => d.program);
/** The provider steps of a program's check. */
const programSteps = (id: unknown): ConditionalProgramSteps | undefined =>
  declared.find(d => d.program.id === id)?.steps;

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

/**
 * The JSON Schema of a program check's `requirements` (CON-04); with `account`, the ad account is fixed. A program
 * without a template of its own takes no requirements.
 */
export function conditionalProgramTemplate(id: string, account?: string): JsonObject {
  const template = programSteps(id)?.template;
  return template ? template(account) : {type: 'object', additionalProperties: false, properties: {}};
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
  // Expired observations go first (their declared expiry, src/document-kinds.ts).
  store.repo(observationKind, actor.tenantId).purgeExpired(now);
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
  // A discovery-only program has no request AMCP could make (ACC-05): it is refused before any login is read.
  if (!program && discoveryOnlyProgram(input.workflow_id))
    bad(
      'This program is listed for discovery only: AMCP makes no request for it. Capabilities lists its prerequisites.',
      'PROGRAM_CHECK_UNAVAILABLE',
    );
  if (!program) bad('Choose an exact conditional program returned by capabilities.', 'PROGRAM_NOT_FOUND');
  const steps = programSteps(program.id)!;
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
          ...(steps.liveArguments?.() ?? {}),
        },
      }),
      required_inputs: ['connection_id', 'account_id', ...requiredPaths(template, 'requirements')],
      requirements_template: template,
      ...(last ? {last_observation: last} : {}),
    };
  }
  if (!obj(input.requirements ?? {})) bad('Program requirements must be an object.');
  const requirements = input.requirements ?? {};
  // The program's native request from its requirements, which it refuses in its own order (its provider's step).
  const args: JsonObject = {
    ...steps.request(program, requirements, account),
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
      // The evidence the program keeps of the native data, refusing what it cannot retain (its provider's step).
      const evidence = steps.evidence(program, data, requirements, account, (kind, count) => bound.rows(kind, count));
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
