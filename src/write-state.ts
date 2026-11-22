/** State validation stage: what a snapshot read must show before a write is prepared or executed. */
import {type TransportResult} from './transport.js';
import {normalizeAccount} from './scope.js';
import {stable} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {nextPage} from './pagination.js';
import {familyOfRead} from './reviewed-families.js';
import {object, fail} from './write-common.js';
import {writeOutcome} from './write-outcome.js';
import {providerHooks} from './provider-hooks.js';

export function validateState(read: CompiledRequest, result: TransportResult): void {
  const family = familyOfRead(read);
  if (family?.validateState)
    family.validateState(read, result, identity => validateGatewayState(read, result, identity));
  else validateGatewayState(read, result);
}

/** How many of the IDs a read asked for its exact-target refusal names. */
const namedRequestedIds = 20;
/**
 * Refuses unless a state read returned exactly the requested targets (in any order). The refusal names the IDs the read asked for, the first twenty in the order
 * they were asked, so that a caller can tell which object it could not find (R2.5 field3, package r25-field3-livefix, item 6 and its fix round, S2-1: the plan engine
 * prepares a step again only when the refusal names an object an earlier step of its plan created). They are the request's own IDs, which the review shows anyway.
 */
function sameIds(actual: unknown[], expected: unknown[]) {
  const clean = (ids: unknown[]) => ids.map(x => String(x)).sort();
  if (actual.length !== expected.length || stable(clean(actual)) !== stable(clean(expected)))
    fail('STATE_TARGET_MISMATCH', 'State read did not return every exact requested target.', {
      requested_ids: expected.map(x => String(x)).slice(0, namedRequestedIds),
    });
}

/**
 * The checks a state read gets from its gateway: a successful, complete provider response that shows exactly the read's
 * target. `identity`, when given, replaces the gateway's target check for a family whose reads return another shape.
 * Each provider's own rules are its adapter's state checks (ARC-01 phase B, `checks.state`), asked where this stage
 * named the provider: its own response contract first, the documented results that end the checks early, the
 * envelope its success check reads, a read complete without paging, and the exact-target check.
 */
function validateGatewayState(
  read: CompiledRequest,
  result: TransportResult,
  identity?: (read: CompiledRequest, result: TransportResult) => void,
): void {
  const state = providerHooks(read.gateway)?.checks?.state;
  // A provider whose own response contract replaces the generic success check (Microsoft's contracts).
  state?.contract?.(read, result);
  if (state?.settled?.(read, result)) return;
  const data = object(result.data),
    id = normalizeAccount(read.gateway, read.accountId!);
  // The envelope the success check reads: the provider may set aside documented values that are not failures
  // (Search Console's sitemap error counts, Google's omitted empty results, a failed GA4 job's message).
  const statusResult = state?.envelope ? state.envelope(read, result, data) : result;
  if (!state?.contract && writeOutcome(statusResult).success !== true)
    fail('STATE_READ_FAILED', 'Failed or partial provider responses cannot verify before-state.');
  // A provider read complete by its own contract (TikTok's published Instant Forms, read page by page).
  if (state?.complete?.(read, data)) return;
  // Reuse provider pagination contracts (including Reddit pagination.next_url)
  // before envelope projection; discarding cursors is never proof of completeness.
  if (nextPage(read, data)) fail('INCOMPLETE_STATE', 'State read was paginated; narrow the mutation.');
  const inspect = (v: unknown) => {
    if (Array.isArray(v)) {
      v.forEach(inspect);
      return;
    }
    if (!v || typeof v !== 'object') return;
    const r = object(v);
    if (
      r.has_more === true ||
      r.hasMore === true ||
      r.nextPageToken ||
      r.next_page_token ||
      (r.next_cursor && r.next_cursor !== '0') ||
      r.next_link ||
      r.paging?.next ||
      r.page_info?.total_page > 1 ||
      (Array.isArray(r.links) && r.links.some((l: JsonObject) => l.rel === 'next'))
    )
      fail('INCOMPLETE_STATE', 'State read was paginated; narrow the mutation.');
    Object.values(r).forEach(inspect);
  };
  inspect(data);
  // A provider that checks its reads' targets whatever a family supplies (Microsoft's contracts, the measurement
  // providers' resources), then a family's identity check, then the provider's exact-target check.
  const context = {
    id,
    sameIds,
    // The ID the read's path ends with, read when a provider's check asks for it.
    target: () => decodeURIComponent(read.path.split('/').at(-1)!).replace(/^act_/, '').split(':').at(-1)!,
  };
  if (state?.ownTarget) {
    state.target?.(read, result, data, context);
    return;
  }
  if (identity) {
    identity(read, result);
    return;
  }
  if (state?.target) {
    state.target(read, result, data, context);
    return;
  }
  // The stage decoded the read's target ID before this refusal for every provider, so a malformed escape in the
  // path still fails as it did.
  context.target();
  fail('STATE_READ_FAILED', 'No response contract exists for this state read.');
}
