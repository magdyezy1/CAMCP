import {nativeAuthority} from './native-authority.js';
import type {MirrorService} from './service.js';
import {MirrorError} from './errors.js';
import {ScopeGuard, normalizeAccount} from './scope.js';
import {assertWriteShape} from './write-shape.js';
import {assertAccountWrite} from './write-access.js';
import {redact} from './security.js';
import {audit, fingerprint, validate, writer} from './workspace-core.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Provider validation (WRT-06): the provider checks a mutation without applying it — Google Ads `validate_only` on a
 * mutate route, Meta `execution_options: ["validate_only"]` on a campaign or ad set create or edit. It is its own effect:
 * a remote, non-mutating call that uses write permission. It never creates a review, a claim or a spend reservation, and
 * it does not permit execute. It runs where reviewed writes are allowed or where the deployment owner opted in
 * (AMCP_PROVIDER_VALIDATION=true, owner decision D18), always needs the account's write grant, and is audited before
 * it is sent.
 */
/** Meta's campaign and ad set edits, by compiled (canonical) action: the meta_campaign_update and meta_adset_update
 * aliases compile to these. Creates are recognized by their account-edge path. */
const metaValidatedEdits = new Set(['meta_campaign_id_update', 'meta_ad_set_id_update']);
export const providerValidationScope =
  'Google Ads mutate requests, and Meta campaign and ad set creates and edits (meta_campaign_create, meta_adset_create, meta_campaign_id_update, meta_ad_set_id_update)';
/** The provider's own validation of `plan`, or undefined when the route has no qualified validation path. */
export function providerValidationRequest(plan: CompiledRequest): CompiledRequest | undefined {
  if (
    plan.gateway === 'google_ads_native_action' &&
    plan.method === 'POST' &&
    /^\/v\d+\/customers\/\d+\/[A-Za-z]+:mutate$/.test(plan.path)
  ) {
    const body: JsonObject = {...(plan.body as JsonObject), validate_only: true};
    delete body.validateOnly;
    return {...plan, body};
  }
  if (
    plan.gateway === 'meta_native_action' &&
    plan.method === 'POST' &&
    (/^\/v[^/]+\/act_\d+\/(?:campaigns|adsets)$/.test(plan.path) ||
      (metaValidatedEdits.has(plan.action) && /^\/v[^/]+\/\d+$/.test(plan.path)))
  )
    return {...plan, body: {...(plan.body as JsonObject), execution_options: ['validate_only']}};
  return undefined;
}
/** Where the provider refused the request: field paths only, which name the request's own fields. */
function fieldPaths(gateway: string, data: unknown): string[] {
  const paths = new Set<string>();
  const error = (data as JsonObject)?.error ?? data;
  if (gateway === 'google_ads_native_action')
    for (const detail of Array.isArray(error?.details) ? error.details : [])
      for (const e of Array.isArray(detail?.errors) ? detail.errors : []) {
        const path = (Array.isArray(e?.location?.fieldPathElements) ? e.location.fieldPathElements : [])
          .map((p: JsonObject) => String(p.fieldName) + (Number.isInteger(p.index) ? '[' + p.index + ']' : ''))
          .join('.');
        if (path) paths.add(path);
      }
  if (gateway === 'meta_native_action') {
    const blame = error?.error_data?.blame_field_specs;
    for (const spec of Array.isArray(blame) ? blame : []) paths.add([spec].flat().map(String).join('.'));
  }
  return [...paths].slice(0, 50);
}
export type ProviderCheck =
  | {status: 'provider_validated'; checked_at: number}
  | {
      status: 'provider_rejected';
      checked_at: number;
      field_paths: string[];
      http_status?: number;
      request_id?: string;
      response: unknown;
    };
/**
 * Sends the validation request through `send` (which applies the caller's authority checks) and classifies the reply.
 * A provider refusal of the request itself (HTTP 400 or 422, or an unsuccessful 200 reply) is a rejection; any other
 * failure (permission, rate, outage) is raised unchanged, since it says nothing about the request.
 */
export async function runProviderValidation(
  plan: CompiledRequest,
  request: CompiledRequest,
  send: () => Promise<TransportResult>,
): Promise<ProviderCheck> {
  let response: TransportResult;
  try {
    response = await send();
  } catch (e) {
    if (e instanceof MirrorError && (e.code === 'PLATFORM_ERROR' || [400, 422].includes(Number(e.details.http_status))))
      return {
        status: 'provider_rejected',
        checked_at: Date.now(),
        field_paths: fieldPaths(plan.gateway, e.details.upstream),
        ...(typeof e.details.http_status === 'number' ? {http_status: e.details.http_status} : {}),
        ...(typeof e.details.request_id === 'string' ? {request_id: e.details.request_id} : {}),
        response: redact(e.details.upstream),
      };
    throw e;
  }
  const data = response.data as JsonObject;
  if (
    response.status >= 300 ||
    data?.error ||
    data?.partialFailureError ||
    (request.gateway === 'meta_native_action' && data?.success === false)
  )
    return {
      status: 'provider_rejected',
      checked_at: Date.now(),
      field_paths: fieldPaths(plan.gateway, data),
      http_status: response.status,
      response: redact(data),
    };
  return {status: 'provider_validated', checked_at: Date.now()};
}
export async function validateProviderRequest(
  service: MirrorService,
  actor: Actor,
  input: JsonObject,
): Promise<JsonObject> {
  writer(service.store, actor);
  if (!['google_ads_native_action', 'meta_native_action'].includes(input.gateway))
    return {
      status: 'unsupported',
      executed: false,
      reason: 'Provider validation is qualified only for ' + providerValidationScope + '.',
    };
  // A provider request that uses write permission: allowed where reviewed writes are, or by the deployment owner's
  // explicit opt-in (owner decision D18). Refused before any account, credential or network access.
  if (!service.policy.allowWrites && service.policy.providerValidation !== true)
    throw new MirrorError(
      'LIVE_WRITES_DISABLED',
      'This deployment permits reads and dry-run previews only, and its owner has not allowed provider validation (AMCP_PROVIDER_VALIDATION=true). Nothing was sent.',
      {},
      403,
    );
  const args = input.arguments;
  validate(args ?? {}, Object.keys(service.registry.tools.get(input.gateway)!.inputSchema.properties ?? {}));
  service.registry.validate(input.gateway, args, service.options);
  const plan = service.compiler.compile(input.gateway, args, service.options);
  if (plan.gateway === 'meta_native_action' && (plan.body as JsonObject)?.execution_options !== undefined)
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'Omit execution_options: provider validation adds validate_only itself.',
      {field: 'execution_options'},
    );
  assertWriteShape(plan);
  const request = providerValidationRequest(plan);
  if (!request)
    throw new MirrorError(
      'PROVIDER_VALIDATION_UNSUPPORTED',
      'Select a supported request: ' + providerValidationScope + '.',
    );
  const c = service.store.resolveConnection(
    actor,
    plan.gateway,
    plan.accountId,
    input.connection_id ?? args.connection_id,
  );
  const account = normalizeAccount(plan.gateway, plan.accountId ?? '');
  assertAccountWrite(service.store, c, account);
  new ScopeGuard(service.registry, service.store).authorize(plan, c);
  const auth = await service.credentials.get(c);
  service.store.assertActorActive(actor);
  const current = service.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id);
  assertAccountWrite(service.store, current, account);
  const access = nativeAuthority(service.store, service.registry, actor, request, current, auth, () =>
    assertAccountWrite(
      service.store,
      service.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id),
      account,
    ),
  );
  const subject = {
    gateway: plan.gateway,
    account_id: plan.accountId,
    connection_id: c.id,
    action: plan.action,
    request_hash: fingerprint(plan),
    deployment_writes_enabled: service.policy.allowWrites,
  };
  // Audited before it is sent: the record exists even when the reply is lost.
  access();
  audit(service.store, actor, 'provider_validation_started', subject);
  const check = await runProviderValidation(plan, request, () =>
    service.transport.request(request, access(), auth, undefined, {beforeAttempt: access}),
  );
  access();
  service.store.assertActorActive(actor);
  if (check.status === 'provider_rejected') {
    audit(service.store, actor, 'provider_validation_failed', {...subject, field_paths: check.field_paths});
    throw new MirrorError(
      'PROVIDER_VALIDATION_FAILED',
      'The provider rejected this request in validation; nothing was applied.',
      {
        response: check.response,
        field_paths: check.field_paths,
        ...(check.http_status !== undefined ? {http_status: check.http_status} : {}),
        ...(check.request_id !== undefined ? {request_id: check.request_id} : {}),
      },
    );
  }
  const receipt = {
    status: 'provider_validated',
    gateway: plan.gateway,
    account_id: plan.accountId,
    connection_id: c.id,
    action: plan.action,
    request_hash: subject.request_hash,
    checked_at: check.checked_at,
    executed: false,
    objects_created: false,
    limitation:
      'Provider validation does not prove a subsequent write will succeed. Prepare and review again before execution.',
  };
  service.store.putDocument(actor.tenantId, 'provider_validation', receipt.request_hash, receipt);
  audit(service.store, actor, 'provider_validated', receipt);
  return receipt;
}
