import {nativeAuthority} from './native-authority.js';
import type {MirrorService} from './service.js';
import {MirrorError, refusedBeforeSending} from './errors.js';
import {ScopeGuard, normalizeAccount} from './scope.js';
import {assertWriteShape} from './write-shape.js';
import {assertAccountWrite} from './write-access.js';
import {credentialFree, redact} from './security.js';
import {audit, fingerprint, validate, writer} from './workspace-core.js';
import {providerHooks, providerValidationProviders} from './provider-hooks.js';
import {providerRefusal, providerRowsFrom} from './provider-error-taxonomy.js';
import {maxProviderErrors, providerMessageText, type ProviderErrorToken} from './provider-error-core.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Provider validation (WRT-06): the provider checks a mutation without applying it — Google Ads `validate_only` on a
 * mutate route, Meta `execution_options: ["validate_only"]` on a campaign or ad set create or edit. It is its own effect:
 * a remote, non-mutating call that uses write permission. It never creates a review, a claim or a spend reservation, and
 * it does not permit execute. It runs where reviewed writes are allowed or where the deployment owner opted in
 * (AMCP_PROVIDER_VALIDATION=true, owner decision D18), always needs the account's write grant, and is audited before
 * it is sent.
 *
 * Each provider declares its validation request and what its refusal says (hooks `validation`, ARC-01 wave 4c round 6:
 * src/google-ads-adapter.ts, src/meta-adapter.ts); this module keeps every rule and its order.
 */
export const providerValidationScope =
  'Google Ads mutate requests, and Meta campaign and ad set creates and edits (meta_campaign_create, meta_adset_create, meta_campaign_id_update, meta_ad_set_id_update)';
/**
 * Why provider_check is unavailable for a request (R25 M1, T2): no validate-only route of its provider is qualified for it.
 * It names no provider, so it holds for every request that has none. provider_check is not AMCP's own check: execute reads
 * the provider's state again and refuses a changed state (STATE_CHANGED), and no flag skips that, with provider_check or
 * without it. The White Friday agent took the unavailable flag, next to a STATE_CHANGED, for a way past the check.
 */
export const providerCheckUnavailable =
  'No validate-only route of the provider is qualified for this request, so provider_check cannot ask the provider to validate it. It is separate from AMCP’s state check, which every execute runs: a changed state is refused as STATE_CHANGED, and no flag skips that check.';
/** The provider's own validation of `plan`, or undefined when the route has no qualified validation path. */
export function providerValidationRequest(plan: CompiledRequest): CompiledRequest | undefined {
  return providerHooks(plan.gateway)?.validation?.request(plan);
}
/**
 * Whether a prepare of this request's provider validates by default (R2.5 M3, L2-12): the provider declares it
 * (`validation.byDefault`, Google Ads) and the request has a validation route. Whether the deployment's policy turns it on,
 * and whether the call opted out, are the review's to decide (src/write-review.ts).
 */
export function providerValidatesByDefault(plan: CompiledRequest): boolean {
  return providerHooks(plan.gateway)?.validation?.byDefault === true && providerValidationRequest(plan) !== undefined;
}
/**
 * Whether a failure of a validation nobody asked for is the provider not being able to answer now, which leaves the review
 * prepared without the check (R2.5 M3, L2-12): a rate limit, an outage, a lost reply, a refusal before sending, or any answer
 * of the provider's that is no rejection of the request (a denied permission, say). An AMCP authority refusal (the grant, the
 * login, the connection) is none of these and is raised: only the provider's own answers carry its HTTP status, and a check
 * AMCP refuses to send is AMCP's refusal. An explicit provider_check never takes this exit.
 */
export function defaultCheckUnavailable(error: unknown): error is MirrorError {
  return (
    error instanceof MirrorError &&
    (error.retryable ||
      refusedBeforeSending.includes(error.code) ||
      error.code === 'UPSTREAM_UNAVAILABLE' ||
      typeof error.details.http_status === 'number')
  );
}
/** Where the provider refused the request: field paths only, which name the request's own fields. */
function fieldPaths(gateway: string, data: unknown): string[] {
  const paths = new Set<string>();
  const error = (data as JsonObject)?.error ?? data;
  // A path the provider chose that holds a credential shape is not kept: the paths reach views and a status (r25-field3-errors, AMCP-03).
  for (const path of providerHooks(gateway)?.validation?.fieldPaths(error) ?? [])
    if (credentialFree(path)) paths.add(path);
  return [...paths].slice(0, 50);
}
/**
 * What a check came to. `default: true` marks one the deployment ran without being asked (R2.5 M3, L2-12), and `not_run` is
 * what a default check that could not run comes to: the review is prepared without it, with the reason's error code and the
 * HTTP status of the provider's answer when it gave one (a number, never the provider's text).
 *
 * A rejection keeps what the provider named, so that every view of the review can say it (r25-field3-errors, AMCP-03): the
 * normalized rows (`provider_errors`, at most 20 and 4 KB, and how many were left out), the provider's own first sentence
 * (`provider_message`, untrusted text, at most 200 characters) and its whole answer (`response`) when that is 16 KB or less,
 * else its size (`response_omitted_bytes`), because a JSON body cannot be cut in the middle.
 */
export type ProviderCheck = (
  | {status: 'provider_validated'; checked_at: number}
  | {
      status: 'provider_rejected';
      checked_at: number;
      field_paths: string[];
      http_status?: number;
      request_id?: string;
      provider_errors?: ProviderErrorToken[];
      provider_errors_omitted?: number;
      provider_message?: string;
      response?: unknown;
      response_omitted_bytes?: number;
    }
  | {status: 'not_run'; checked_at: number; reason: string; http_status?: number}
) & {default?: true};
/** The longest provider answer a stored check keeps whole (r25-field3-errors, AMCP-03). */
export const maxStoredResponseBytes = 16 * 1024;
/** What a check keeps of the provider's whole answer: the redacted answer when it is small enough, else its size. */
function keptResponse(body: unknown): {response: unknown} | {response_omitted_bytes: number} {
  const redacted = redact(body),
    bytes = Buffer.byteLength(JSON.stringify(redacted) ?? '');
  return bytes <= maxStoredResponseBytes ? {response: redacted} : {response_omitted_bytes: bytes};
}
/** The rows of a rejection, and how many the bounds left out, as the check keeps them. */
const rowFields = (rows: ProviderErrorToken[], omitted: number) => ({
  ...(rows.length ? {provider_errors: rows} : {}),
  ...(omitted > 0 ? {provider_errors_omitted: omitted} : {}),
});
/**
 * Whether a default check that did not run was refused for access (R2.5 M3 round 2, S4-1): the provider answered that the login
 * is not accepted (401), may not do this (403) or has no such route (404). Preparing again does not change that answer, and the
 * write itself is refused the same way unless the access changes; an outage or a rate limit is what a later prepare may get past.
 */
export const checkRefusedForAccess = (check: {http_status?: number}): boolean =>
  check.http_status === 401 || check.http_status === 403 || check.http_status === 404;
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
    if (
      e instanceof MirrorError &&
      (e.code === 'PLATFORM_ERROR' || [400, 422].includes(Number(e.details.http_status)))
    ) {
      // What the transport made of the refusal (its rows and the provider's sentence) is kept, checked again against the request
      // the check was for (r25-field3-errors, AMCP-03): the review used to keep only the field paths and the whole answer.
      const found = providerRowsFrom(e.details.provider_errors, plan.body),
        left = Number.isSafeInteger(e.details.provider_errors_omitted) ? Number(e.details.provider_errors_omitted) : 0,
        sentence = providerMessageText(e.details.provider_message);
      return {
        status: 'provider_rejected',
        checked_at: Date.now(),
        field_paths: fieldPaths(plan.gateway, e.details.upstream),
        ...(typeof e.details.http_status === 'number' ? {http_status: e.details.http_status} : {}),
        ...(typeof e.details.request_id === 'string' ? {request_id: e.details.request_id} : {}),
        ...rowFields(found.rows, found.omitted + left),
        ...(sentence !== undefined ? {provider_message: sentence} : {}),
        ...keptResponse(e.details.upstream),
      };
    }
    // The transport words a lost reply to any non-read request as a write whose outcome is uncertain. A validation
    // applies nothing, so its lost reply only means the check did not finish.
    if (e instanceof MirrorError && e.code === 'WRITE_OUTCOME_UNCERTAIN')
      throw new MirrorError(
        'UPSTREAM_UNAVAILABLE',
        'The provider did not answer the validation request. Validation applies nothing, so nothing changed; it can be sent again.',
        {validation_only: true},
        502,
        true,
      );
    throw e;
  }
  const data = response.data as JsonObject;
  if (
    response.status >= 300 ||
    data?.error ||
    data?.partialFailureError ||
    providerHooks(request.gateway)?.validation?.unsuccessful?.(data)
  ) {
    // An unsuccessful answer inside a 2xx reply is read as a refusal is (r25-field3-errors, AMCP-03): its rows and sentence too.
    const refusal = providerRefusal(plan.gateway, data, undefined, plan.body);
    return {
      status: 'provider_rejected',
      checked_at: Date.now(),
      field_paths: fieldPaths(plan.gateway, data),
      http_status: response.status,
      ...rowFields(refusal.errors, refusal.omitted ?? 0),
      ...(refusal.text !== undefined ? {provider_message: refusal.text} : {}),
      ...keptResponse(data),
    };
  }
  return {status: 'provider_validated', checked_at: Date.now()};
}
/**
 * The refusal of a review the provider rejected when it validated it at prepare (WRT-06): the one `PROVIDER_VALIDATION_FAILED` that
 * every place raises, so that its words, its details and their Arabic are written once (r25-field3-errors, AMCP-03 and M5-a): the
 * execute of a review and a group's admit (src/write-review.ts), a group's prepare (src/write-groups.ts) and a plan step's
 * prepare (src/campaign-runner.ts). It carries what the provider named: the rows (at most 20, and how many were left out),
 * the field paths, the provider's sentence, its HTTP status and request reference, and the review. Nothing was sent: the
 * review was never claimed.
 */
export function providerRejection(check: JsonObject, reviewId?: string): MirrorError {
  const rows: unknown[] = Array.isArray(check.provider_errors) ? check.provider_errors.slice(0, maxProviderErrors) : [],
    omitted = Number.isSafeInteger(check.provider_errors_omitted) ? Number(check.provider_errors_omitted) : 0;
  return new MirrorError(
    'PROVIDER_VALIDATION_FAILED',
    'The provider rejected this request when it validated it at prepare, so this review cannot be executed. Nothing was submitted; correct what details.provider_errors and details.field_paths name and prepare it again.',
    {
      field_paths: Array.isArray(check.field_paths) ? check.field_paths : [],
      ...(rows.length ? {provider_errors: rows} : {}),
      ...(omitted > 0 ? {provider_errors_omitted: omitted} : {}),
      ...(typeof check.provider_message === 'string' ? {provider_message: check.provider_message} : {}),
      ...(typeof check.http_status === 'number' ? {http_status: check.http_status} : {}),
      ...(typeof check.request_id === 'string' ? {request_id: check.request_id} : {}),
      ...(reviewId !== undefined ? {review_id: reviewId} : {}),
      // Refused before anything was claimed or sent: the review stays unsent, and a correction is a new review.
      submission: 'not_sent',
    },
  );
}
export async function validateProviderRequest(
  service: MirrorService,
  actor: Actor,
  input: JsonObject,
): Promise<JsonObject> {
  writer(service.store, actor);
  if (!providerValidationProviders.some(hooks => hooks.gateway === input.gateway))
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
  const refused = providerHooks(plan.gateway)?.validation?.refusal?.(plan);
  if (refused) throw refused;
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
        // The whole answer as it always came back (a body over 16 KB comes as its size), and now the rows and the provider's
        // sentence beside it (r25-field3-errors, AMCP-03).
        ...(check.response !== undefined ? {response: check.response} : {}),
        ...(check.response_omitted_bytes !== undefined ? {response_omitted_bytes: check.response_omitted_bytes} : {}),
        field_paths: check.field_paths,
        ...rowFields(check.provider_errors ?? [], check.provider_errors_omitted ?? 0),
        ...(check.provider_message !== undefined ? {provider_message: check.provider_message} : {}),
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
