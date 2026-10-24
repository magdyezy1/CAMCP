import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {assertMeasurementWrite, validateMeasurementState} from './measurement-writes.js';
import {gtmSafeConfiguration} from './gtm-workflow-writes.js';
// Writes and campaigns (wave 4c).
import type {VendorRoute} from './delegated-native.js';
import {assertMeasurementScopes} from './measurement-writes.js';
import {fail, object} from './write-common.js';

/**
 * Google Tag Manager's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: a
 * folder's entity listing is a POST read. Readiness reads the selected Tag Manager account (CON-03). Its writes follow
 * the measurement resource contract (src/measurement-writes.ts) and may carry the workspace fingerprint; a resource's
 * 404, or its status read, is its documented state, and the resource checks every state read's target.
 */
export const gtmHooks: ProviderHooks = Object.freeze({
  gateway: 'gtm_native_action',
  checks: Object.freeze({
    routeWrite: assertMeasurementWrite,
    shape: Object.freeze({queryParameter: 'fingerprint'}),
    state: Object.freeze({
      settled(read: CompiledRequest, result: TransportResult) {
        if (result.status !== 404 && !(read.path.endsWith('/status') && result.status === 200)) return false;
        validateMeasurementState(read, result);
        return true;
      },
      ownTarget: true as const,
      target: (read: CompiledRequest, result: TransportResult) => validateMeasurementState(read, result),
    }),
  }),
  // A review keeps a Tag Manager resource's configuration, its authorization code as a digest and its container
  // access and trigger lists in one order (src/gtm-workflow-writes.ts).
  review: Object.freeze({snapshot: (_read: CompiledRequest, d: JsonObject) => gtmSafeConfiguration(d)}),
  reads: Object.freeze({
    postRead: (_plan: CompiledRequest, pathname: string) => /\/folders\/[^/:]+:entities$/.test(pathname),
  }),
  accountRead: Object.freeze({
    readiness: (id: string, read: (path: string, origin: string) => CompiledRequest) =>
      read('/tagmanager/v2/accounts/' + id, 'https://tagmanager.googleapis.com'),
    names: (id: string, data: JsonObject) => String(data.accountId) === id,
  }),
  // A delete answers 200 without a body.
  wire: Object.freeze({
    emptyWrite: (plan: CompiledRequest, response: Response) => response.status === 200 && plan.method === 'DELETE',
  }),
  // Writes and campaigns (wave 4c): its parts of the reviewed write lifecycle (src/write-review.ts): the Tag Manager
  // permission a write needs, and the workspace fingerprint a route takes from the state read.
  writes: Object.freeze({
    writePermission: assertMeasurementScopes,
    concurrency: gtmConcurrency,
    // A container version's publish takes effect for everyone at once (src/write-effects.ts).
    publishesLive: (plan: CompiledRequest) => plan.method === 'POST' && /:publish$/.test(plan.path),
  }),
});

// Writes and campaigns (wave 4c): moved verbatim from WriteReviewService.prepareReview (src/write-review.ts).
/** A route that takes the workspace fingerprint takes the state read's, refusing a stale one the caller supplied. */
function gtmConcurrency(plan: CompiledRequest, state: unknown[], routes: readonly VendorRoute[]): void {
  const route = routes.find(
      r => r.gateway === plan.gateway && r.operation + (r.action ? '/' + r.action : '') === plan.action,
    ),
    fingerprint = object(state[0]).fingerprint;
  if (route?.parameters.fingerprint && typeof fingerprint === 'string' && fingerprint) {
    if (plan.query.fingerprint !== undefined && plan.query.fingerprint !== fingerprint)
      fail('STATE_CHANGED', 'The supplied Tag Manager fingerprint is stale.');
    plan.query.fingerprint = fingerprint;
  }
}
