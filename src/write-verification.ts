import type {VerificationReadOptions} from './reviewed-family.js';
import {Store} from './store.js';
import {Registry} from './catalog.js';
import {NativeTransport, type TransportResult} from './transport.js';
import {CredentialProvider} from './auth.js';
import {ScopeGuard} from './scope.js';
import {independentlyReadOnly} from './execution-risk.js';
import {MirrorError} from './errors.js';
import {readConsistently} from './read-consistency.js';
import {optionalMissingState} from './write-common.js';
import {validateState} from './write-state.js';
import {audit, bad, fingerprint, obj, optional, read} from './workspace-core.js';
import type {Actor, CompiledRequest, Connection, Credentials, JsonObject} from './types.js';
import {nativeAuthority} from './native-authority.js';
import {familyOf, readThroughFamilies} from './reviewed-families.js';
import {normalize, differing, verificationReads, entity, verificationContractVersion} from './verification-reads.js';
import {loginStamp} from './connection-authority.js';
import {writeClaim} from './job-repository.js';
// The provider's parts of a verification (ARC-01 phase B, wave 4c): the other accounts its write changes (Apple's
// shared budget) and the phase its reads show (GA4's provider jobs), from its adapter's `writes` hooks.
import {providerHooks} from './provider-hooks.js';

/** A guarded-reader binding: the connection's login (its revision, not token bytes) must stay the one the first read used. */
const sameLogin = (message: string) => ({
  value: (credentials: Credentials) => loginStamp(credentials),
  changed: (): never => bad(message, 'CONNECTION_AUTHORITY_CHANGED'),
});
export class WriteVerifier {
  constructor(
    private store: Store,
    private registry: Registry,
    private transport: NativeTransport,
    private credentials: CredentialProvider,
  ) {}
  private async request(actor: Actor, plan: CompiledRequest, connection: Connection, auth: Credentials) {
    const access = nativeAuthority(this.store, this.registry, actor, plan, connection, auth);
    const response = await this.transport.request(plan, access(), auth, undefined, {beforeAttempt: access});
    access();
    return response;
  }
  /**
   * The reader a family's verification uses, the counterpart of the review's. Each read must be read-only. Before the
   * credentials are fetched, after, and after the response, the actor must still be active, the `actor` check runs,
   * the connection is resolved, `check` runs on it and the scope guard authorizes the read. A binding keeps the login
   * the first read used; `after` sees the connection and response last checked and may return the response to use.
   */
  private guardedReader(
    actor: Actor,
    plan: CompiledRequest,
    connectionId: string,
    unsafe: string,
    options: VerificationReadOptions = {},
  ) {
    let bound: string | undefined;
    return async (read: CompiledRequest): Promise<TransportResult> => {
      if (!independentlyReadOnly(read)) bad(unsafe, 'VERIFICATION_UNSUPPORTED');
      const access = () => {
        this.store.assertActorActive(actor);
        options.actor?.();
        const current = this.store.resolveConnection(actor, plan.gateway, plan.accountId, connectionId);
        options.check?.(current);
        new ScopeGuard(this.registry, this.store).authorize(read, current);
        if (
          options.binding &&
          bound !== undefined &&
          options.binding.value(this.store.credentials(actor.tenantId, current.id)) !== bound
        )
          options.binding.changed();
        return current;
      };
      const current = access(),
        auth = await this.credentials.get(current);
      if (options.binding) bound ??= options.binding.value(auth);
      access();
      const response = await this.request(actor, read, current, auth);
      return options.after?.(read, access(), response, auth) ?? response;
    };
  }
  async verify(actor: Actor, reviewId: string): Promise<JsonObject> {
    const review = read(this.store, actor, 'write_review', reviewId);
    if (review.user_id !== actor.userId && actor.role !== 'admin')
      bad('This write belongs to another actor.', 'FORBIDDEN');
    const row = writeClaim(this.store, actor.tenantId, reviewId);
    if (row?.state !== 'complete' || !row.result)
      bad(
        'The write outcome is uncertain or unavailable; verification cannot make it safe to resubmit.',
        'WRITE_OUTCOME_UNCERTAIN',
      );
    const result = JSON.parse(row.result),
      plan = review.plan as CompiledRequest,
      c = this.store.resolveConnection(actor, plan.gateway, plan.accountId, review.connection_id);
    // Every other account the write changes (Apple's shared budget) is checked like the selected one, at each read.
    const checkSharedAccounts = () => {
      for (const account of providerHooks(plan.gateway)?.writes?.sharedAccounts?.(plan) ?? [])
        this.store.resolveConnection(actor, plan.gateway, account, c.id);
    };
    checkSharedAccounts();
    const family = familyOf(plan);
    family?.actor?.(plan, actor, true);
    family?.scope?.(c, false, plan);
    if (result.success !== true)
      bad('Inspect the retained partial failure before recovery.', 'WRITE_PARTIAL_OR_FAILED');
    const cached = optional(this.store, actor.tenantId, 'write_verification', reviewId),
      cacheVersion = verificationContractVersion(plan);
    if (
      !family?.verifyEveryTime &&
      cached?.status === 'verified' &&
      cached.verification_cache_version === cacheVersion &&
      Date.now() - cached.checked_at < 10000
    )
      return {...cached, cached: true};
    let reads: ReturnType<typeof verificationReads> = [],
      status = 'unverified',
      checks: JsonObject[] = [],
      resources: JsonObject[] = [],
      retryUseful = false;
    const previousChecks: JsonObject[] = Array.isArray(cached?.checks) ? cached.checks : [];
    try {
      const own = family?.verify?.(plan, {
        result,
        state: review.state,
        reviewId,
        connection: c,
        store: this.store,
        actor,
        guarded: (unsafe, options) => this.guardedReader(actor, plan, c.id, unsafe, options),
        sameLogin,
        current: () => this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id),
      });
      if (own) {
        const verified = await own;
        status = verified.status;
        checks = verified.checks;
        resources = verified.resources ?? [];
      } else {
        reads = verificationReads(plan, result, this.registry, review.state);
        for (const item of reads) {
          family?.bindVerificationRead?.(plan, item.read, reviewId);
          if (!obj(item.expected) || !Object.keys(item.expected).length || !independentlyReadOnly(item.read))
            bad('No complete configuration read contract exists for this write.', 'VERIFICATION_UNSUPPORTED');
          const planned = normalize(item.expected),
            optional = item.readOptional ?? [],
            // A read-optional field the read omits is compared with the write response instead.
            split = (actual: unknown) => {
              const exp = {...planned},
                ack = {...(item.acknowledged ?? {})};
              for (const field of optional)
                if (obj(actual) && actual[field] === undefined && Object.hasOwn(exp, field)) {
                  ack[field] = {sent: exp[field], echoed: obj(result.data) ? result.data[field] : undefined};
                  delete exp[field];
                }
              return {exp, ack};
            },
            readback = await readConsistently(
              async () => {
                this.store.assertActorActive(actor);
                checkSharedAccounts();
                const current = this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id);
                new ScopeGuard(this.registry, this.store).authorize(item.read, current);
                const auth = await this.credentials.get(current);
                this.store.assertActorActive(actor);
                new ScopeGuard(this.registry, this.store).authorize(
                  item.read,
                  this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id),
                );
                let response;
                try {
                  response = await readThroughFamilies(item.read, async page => {
                    this.store.assertActorActive(actor);
                    const latest = this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id);
                    family?.readCheck?.(latest);
                    new ScopeGuard(this.registry, this.store).authorize(page, latest);
                    const result = await this.request(actor, page, latest, auth);
                    this.store.assertActorActive(actor);
                    const current = this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id);
                    family?.readCheck?.(current);
                    new ScopeGuard(this.registry, this.store).authorize(page, current);
                    return result;
                  });
                } catch (e) {
                  const absent = optionalMissingState(item.read, e);
                  if (!absent) throw e;
                  response = absent;
                }
                this.store.assertActorActive(actor);
                new ScopeGuard(this.registry, this.store).authorize(
                  item.read,
                  this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id),
                );
                validateState(item.read, response);
                checkSharedAccounts();
                return normalize(entity(item.read, response.data as JsonObject));
              },
              actual => differing(split(actual).exp, actual).length === 0,
            );
          const actual = readback.value,
            {exp: expected, ack: acknowledged} = split(actual),
            changed = differing(expected, actual),
            unacknowledged = Object.entries(acknowledged)
              .filter(([, v]) => differing(normalize(v.sent), normalize(v.echoed)).length)
              .map(([k]) => '/' + k);
          // The provider's phase of what the write started (GA4's provider jobs); verified without one.
          const providerPhase = providerHooks(item.read.gateway)?.writes?.verificationPhase,
            measured = readback.consistent
              ? providerPhase
                ? providerPhase(item.read, actual)
                : 'verified'
              : 'inconclusive',
            actualHash = fingerprint(actual ?? null),
            // Every read of this round returned the same differing state. When the previous round saw the same
            // state too, the disagreement is not propagation: it is a mismatch, and reading again changes nothing.
            stableReads = !readback.consistent && readback.stable === true,
            settled =
              stableReads &&
              previousChecks.some(
                (p: JsonObject) => p.resource_id === item.id && p.actual_hash === actualHash && p.stable_reads === true,
              ),
            phase = settled ? 'mismatch' : measured === 'verified' && unacknowledged.length ? 'inconclusive' : measured;
          if (phase === 'inconclusive' && !readback.consistent && !settled) retryUseful = true;
          checks.push({
            resource_id: item.id,
            status: phase,
            code:
              phase === 'inconclusive'
                ? 'VERIFICATION_INCONCLUSIVE'
                : phase === 'mismatch'
                  ? 'VERIFICATION_MISMATCH'
                  : undefined,
            read_attempts: readback.attempts,
            changed_fields: changed,
            ...(phase === 'mismatch' ? {diff: fieldDiff(expected, actual, changed)} : {}),
            ...(stableReads ? {stable_reads: true} : {}),
            expected_hash: fingerprint(expected),
            actual_hash: actualHash,
            checked_fields: Object.keys(expected),
            ...(Object.keys(acknowledged).length
              ? {
                  acknowledged_fields: Object.keys(acknowledged),
                  acknowledgment:
                    'The native read did not return these fields; they are compared with the provider write response.',
                  ...(unacknowledged.length ? {unacknowledged_fields: unacknowledged} : {}),
                }
              : {}),
            ...(item.unobservable?.length
              ? {
                  unobservable_fields: item.unobservable,
                  unobservable:
                    'Neither the write response nor any native read returns these sent fields, so they cannot be compared.',
                }
              : {}),
            ...(item.observe?.(actual) ?? {}),
          });
          family?.afterReadBack?.(
            plan,
            {id: item.id, expected: item.expected, actual, consistent: readback.consistent},
            {
              store: this.store,
              result,
              current: () => this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id),
            },
          );
          const created = readback.consistent ? (family?.verifiedResources?.(plan, actual as JsonObject) ?? []) : [];
          if (created.length) {
            const current = this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id);
            family!.scope?.(current, true, plan);
            for (const id of created) this.store.rememberResource(current, plan.accountId!, id);
          }
        }
        status = reads.length
          ? checks.some(c => c.status === 'failed')
            ? 'failed'
            : checks.every(c => c.status === 'verified')
              ? 'verified'
              : checks.some(c => c.status === 'pending')
                ? 'pending'
                : checks.some(c => c.status === 'mismatch')
                  ? 'mismatch'
                  : 'inconclusive'
          : 'unsupported';
      }
    } catch (e) {
      if (family?.pendingOnRetryableError?.(plan) && e instanceof MirrorError && e.retryable) status = 'pending';
      checks.push({
        status: status === 'pending' ? 'pending' : 'unverified',
        code: e instanceof MirrorError ? e.code : 'READ_FAILED',
        message: e instanceof MirrorError ? e.message : 'Verification read failed.',
      });
    }
    this.store.assertActorActive(actor);
    const receipt = {
      review_id: reviewId,
      connection_id: c.id,
      account_id: plan.accountId,
      action: plan.action,
      status,
      ...(cacheVersion ? {verification_cache_version: cacheVersion} : {}),
      ...(status === 'inconclusive' ? {code: 'VERIFICATION_INCONCLUSIVE'} : {}),
      ...(status === 'mismatch' ? {code: 'VERIFICATION_MISMATCH'} : {}),
      checks,
      // What the operator accepts when accepting the observed state: one hash over every resource read back.
      ...(['mismatch', 'inconclusive'].includes(status) && checks.every(c => typeof c.actual_hash === 'string')
        ? {actual_hash: observedHash(checks)}
        : {}),
      checked_at: Date.now(),
      automatic_retry_of_mutation: false,
      recovery:
        'Preserve successful resources. Field disagreement after bounded reads is inconclusive, not permission to repeat a mutation. Corrective writes need a new review; verification never resets idempotency.',
      // Another read is suggested only when it can change the answer: never for a mismatch or a missing echo.
      ...(status === 'pending' || (status === 'inconclusive' && (retryUseful || !reads.length))
        ? {
            retry_read_after_ms:
              family?.retryReadAfterMs ??
              (checks.some(c => c.stable_reads === true && c.status === 'inconclusive') ? 5000 : 1000),
            next_call: {tool: 'amcp_campaign', arguments: {action: 'verify', review_id: reviewId}},
          }
        : {}),
    };
    if (resources.length) Object.assign(receipt, {verified_resources: resources});
    this.store.putDocument(actor.tenantId, 'write_verification', reviewId, receipt);
    audit(this.store, actor, 'write_verification', {
      connection_id: c.id,
      account_id: plan.accountId,
      review_id: reviewId,
      status,
    });
    return receipt;
  }
}
/** The fields a mismatch disagrees on, with what was sent and what the provider holds (bounded; provider text). */
function fieldDiff(expected: unknown, actual: unknown, changed: string[]): JsonObject[] {
  const at = (v: unknown, path: string) =>
      path
        .slice(1)
        .split('/')
        .reduce((o: any, k) => (o && typeof o === 'object' ? o[k] : undefined), v),
    clip = (v: unknown) => {
      const text = JSON.stringify(v ?? null);
      return text.length > 300 ? {omitted_bytes: Buffer.byteLength(text)} : (v ?? null);
    };
  return changed
    .slice(0, 20)
    .map(field => ({field, expected: clip(at(expected, field)), actual: clip(at(actual, field))}));
}
/** One hash over every resource a verification read back; with one resource, that resource's own actual_hash. */
export function observedHash(checks: JsonObject[]): string {
  return checks.length === 1
    ? checks[0]!.actual_hash
    : fingerprint(checks.map(c => [c.resource_id ?? null, c.actual_hash]));
}
