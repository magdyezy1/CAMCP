import {googleJson, assertGoogleAdsScope} from './google-contracts.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {googleAdsCustomers} from './google-version.js';
import {fail, readOf} from './family-kit.js';

/**
 * Auto-apply recommendation subscriptions, Google Ads API v23 (pinned Discovery document:
 * RecommendationSubscriptionService.MutateRecommendationSubscription, RecommendationSubscriptionOperation and
 * RecommendationSubscription; checked 2026-09-27). While a subscription is ENABLED, Google applies recommendations of its
 * type to the customer's campaigns automatically. A subscription is created per type, which is immutable, and afterwards
 * only its status changes (ENABLED or PAUSED); its resource name is customers/{customer}/recommendationSubscriptions/{type}.
 */
type Read = CompiledRequest & {googleSubscriptionState?: {types: string[]}};
const legacy: Record<string, string> = {
  SUBSCRIBE_RECOMMENDATION: 'create',
  UNSUBSCRIBE_RECOMMENDATION: 'update',
  UPDATE_RECOMMENDATION_SUBSCRIPTION: 'update',
};
const statuses = ['ENABLED', 'PAUSED'],
  maxOperations = 10;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  return fail('INVALID_GOOGLE_RECOMMENDATION_SUBSCRIPTION', message);
}
function unverified(message: string): never {
  return fail('SUBSCRIPTION_STATE_UNVERIFIED', message, {}, 502);
}
const account = (p: CompiledRequest) => {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/^\d+$/.test(id)) invalid('Select one Google Ads customer.');
  return id!;
};
export function googleSubscriptionKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'google_ads_native_action' &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://googleads.googleapis.com') &&
    /^\/v\d+\/customers\/\d+\/recommendationSubscriptions:mutateRecommendationSubscription$/.test(p.path)
  );
}
const operations = (p: CompiledRequest) => (googleJson(p.body).operations ?? []) as JsonObject[];
const typeName = (v: unknown) =>
  typeof v === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(v) && !['UNSPECIFIED', 'UNKNOWN'].includes(v);
/** Each operation as the type it writes and the status it leaves. */
function changes(p: CompiledRequest): {type: string; status: string; create: boolean}[] {
  return operations(p).map(op =>
    op.create
      ? {type: String(op.create.type), status: String(op.create.status), create: true}
      : {type: String(op.update.resourceName).split('/').at(-1)!, status: String(op.update.status), create: false},
  );
}
export function assertGoogleSubscriptions(p: CompiledRequest): void {
  if (!googleSubscriptionKind(p)) return;
  const id = account(p);
  if (p.path.split('/')[3] !== id) fail('ACCOUNT_SCOPE_MISMATCH', 'The path must use the selected customer.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Subscription reviews take no query or header overrides.');
  const b = googleJson(p.body);
  if (
    !object(b) ||
    Object.keys(b).some(k => !['operations', 'partialFailure', 'validateOnly', 'responseContentType'].includes(k))
  )
    invalid('Send {operations} only.');
  if (b.partialFailure !== undefined && b.partialFailure !== false)
    invalid('partialFailure must be false: every operation is applied, or none.');
  if (b.validateOnly !== undefined && b.validateOnly !== false)
    invalid('validateOnly must be false; inspect the review instead.');
  if (!Array.isArray(b.operations) || !b.operations.length || b.operations.length > maxOperations)
    invalid('Send 1–' + maxOperations + ' operations.');
  const verb = legacy[p.action],
    seen = new Set<string>();
  (b.operations as unknown[]).forEach((op, i) => {
    const at = 'operations[' + i + ']';
    if (!object(op)) invalid(at + ' is an object.');
    const kinds = ['create', 'update'].filter(k => op[k] !== undefined);
    if (kinds.length !== 1 || Object.keys(op).some(k => ![...kinds, 'updateMask'].includes(k)))
      invalid(at + ' is exactly one of create or update (with updateMask); subscriptions are paused, not removed.');
    if (verb && kinds[0] !== verb) invalid(at + ': ' + p.action + ' takes ' + verb + ' operations only.');
    let type: string;
    if (op.create !== undefined) {
      const c = op.create;
      if (!object(c) || Object.keys(c).some(k => !['type', 'status'].includes(k)))
        invalid(at + '.create is {type, status}; Google names the subscription after its type.');
      if (!typeName(c.type)) invalid(at + '.create.type is a recommendation type such as CAMPAIGN_BUDGET or KEYWORD.');
      if (!statuses.includes(c.status)) invalid(at + '.create.status is ENABLED or PAUSED.');
      if (op.updateMask !== undefined) invalid(at + ': creation takes no updateMask.');
      type = c.type;
    } else {
      const u = op.update;
      if (!object(u) || Object.keys(u).some(k => !['resourceName', 'status'].includes(k)) || op.updateMask !== 'status')
        invalid(at + '.update is {resourceName, status} with updateMask "status"; the type cannot change.');
      const m = new RegExp('^customers/' + id + '/recommendationSubscriptions/([A-Z][A-Z0-9_]{1,80})$').exec(
        String(u.resourceName),
      );
      if (!m || !typeName(m[1]))
        invalid(at + '.update.resourceName is customers/' + id + '/recommendationSubscriptions/{type}.');
      if (!statuses.includes(u.status)) invalid(at + '.update.status is ENABLED or PAUSED.');
      if (p.action === 'UNSUBSCRIBE_RECOMMENDATION' && u.status !== 'PAUSED')
        invalid(at + ': UNSUBSCRIBE_RECOMMENDATION pauses a subscription.');
      type = m![1]!;
    }
    if (seen.has(type)) invalid('Each recommendation type appears once.');
    seen.add(type);
  });
}
const subscriptionQuery =
  'SELECT recommendation_subscription.resource_name, recommendation_subscription.type, recommendation_subscription.status FROM recommendation_subscription';
function read(p: CompiledRequest): Read {
  return readOf<Read>(
    p,
    {
      action: 'AMCP_GOOGLE_SUBSCRIPTION_READ',
      method: 'POST',
      path: googleAdsCustomers + account(p) + '/googleAds:search',
      body: {query: subscriptionQuery},
      query: {},
      clears: ['responseControls'],
    },
    {googleSubscriptionState: undefined},
  );
}
export function googleSubscriptionSnapshots(p: CompiledRequest): Read[] {
  return [
    {
      ...read(p),
      googleSubscriptionState: {
        types: changes(p)
          .map(c => c.type)
          .sort(),
      },
    },
  ];
}
export function isGoogleSubscriptionRead(p: CompiledRequest): p is Read {
  return !!(p as Read).googleSubscriptionState;
}
/** Every subscription of the customer, keyed by type (a customer holds one per type). */
export async function readGoogleSubscriptions(
  p: CompiledRequest,
  send: (p: Read) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).googleSubscriptionState;
  if (!s) return send(p);
  const r = await send({...(p as Read), googleSubscriptionState: undefined}),
    d = r.data;
  if (r.status !== 200 || !object(d) || (d.results !== undefined && !Array.isArray(d.results)) || d.nextPageToken)
    unverified('Google returned a failed, paged or unrecognized search response.');
  const subscriptions: JsonObject = {};
  for (const row of (d.results ?? []) as unknown[]) {
    const v = object(row) && object(row.recommendationSubscription) ? row.recommendationSubscription : undefined,
      type = String(v?.type);
    if (
      !v ||
      v.resourceName !== 'customers/' + account(p) + '/recommendationSubscriptions/' + type ||
      Object.hasOwn(subscriptions, type)
    )
      unverified('A subscription row is foreign, malformed or repeated.');
    subscriptions[type] = {status: v!.status ?? null};
  }
  return {status: 200, headers: {}, data: {customer: {id: account(p)}, subscriptions}};
}
export function validateGoogleSubscriptionState(p: CompiledRequest, r: TransportResult): void {
  const d = r.data;
  if (
    !(p as Read).googleSubscriptionState ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.customer) ||
    d.customer.id !== account(p) ||
    !object(d.subscriptions)
  )
    unverified('Complete subscription state is missing.');
}
export function googleSubscriptionPrerequisites(p: CompiledRequest, states: unknown[]): void {
  if (!googleSubscriptionKind(p)) return;
  const s = states[0];
  if (!object(s) || !object(s.subscriptions)) unverified('Complete subscription state is missing.');
  for (const c of changes(p)) {
    const current = s.subscriptions[c.type];
    if (c.create && object(current))
      fail(
        'CONFIGURATION_EXISTS',
        'A ' + c.type + ' subscription exists (' + String(current.status) + '); update its status instead.',
        {type: c.type},
      );
    if (!c.create && !object(current))
      fail('STATE_NOT_FOUND', 'The customer has no ' + c.type + ' subscription; create one instead.', {type: c.type});
    if (!c.create && current.status === c.status)
      invalid('The ' + c.type + ' subscription is already ' + c.status + '.');
  }
}
/** An ENABLED subscription lets Google change campaigns automatically. */
export function googleSubscriptionEnables(p: CompiledRequest): boolean {
  return googleSubscriptionKind(p) && changes(p).some(c => c.status === 'ENABLED');
}
export function googleSubscriptionImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!googleSubscriptionKind(p)) return;
  const first = state[0],
    s: JsonObject = object(first) && object(first.subscriptions) ? first.subscriptions : {};
  const items = changes(p).map(c => ({type: c.type, from: object(s[c.type]) ? s[c.type].status : null, to: c.status}));
  const enables = items.some(i => i.to === 'ENABLED');
  return {
    provider: 'google',
    scope: 'recommendation_subscription',
    changes: items,
    may_affect_serving: enables,
    effect: enables
      ? 'While ENABLED, Google applies recommendations of these types to the campaigns automatically and without a review; depending on the type they change budgets, bids, keywords or ads.'
      : 'Paused subscriptions stop automatic application; applied changes stay.',
    verification: 'Reads the subscriptions again and compares each status.',
    source: 'https://developers.google.com/google-ads/api/docs/recommendations',
  };
}
export function googleSubscriptionOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const d = r.data,
    c = changes(p);
  if (
    r.status !== 200 ||
    !object(d) ||
    (d.partialFailureError !== undefined && d.partialFailureError !== null) ||
    !Array.isArray(d.results) ||
    d.results.length !== c.length
  )
    return false;
  return c.every(
    (x, i) =>
      object(d.results[i]) &&
      d.results[i].resourceName === 'customers/' + account(p) + '/recommendationSubscriptions/' + x.type,
  );
}
export function googleSubscriptionVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const c = changes(p),
    probe: Read = {...read(p), googleSubscriptionState: {types: c.map(x => x.type).sort()}};
  return [
    {
      read: probe,
      expected: {subscriptions: Object.fromEntries(c.map(x => [x.type, {status: x.status}]))},
      id: c.map(x => x.type).join(','),
    },
  ];
}
export function googleSubscriptionObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const found = object(data.subscriptions) ? data.subscriptions : {},
    types = (read as Read).googleSubscriptionState?.types ?? [];
  return {subscriptions: Object.fromEntries(types.map(t => [t, object(found[t]) ? found[t] : {status: null}]))};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleSubscriptionFamily: ReviewedFamily = {
  name: 'google_recommendation_subscriptions',
  files: ['src/google-recommendation-subscriptions.ts', ['tests/google-recommendation-subscriptions.test.mjs']],
  kind: googleSubscriptionKind,
  assert: assertGoogleSubscriptions,
  scope: assertGoogleAdsScope,
  snapshots: googleSubscriptionSnapshots,
  isRead: isGoogleSubscriptionRead,
  reader: readGoogleSubscriptions,
  validateState: validateGoogleSubscriptionState,
  prerequisites: googleSubscriptionPrerequisites,
  impact: googleSubscriptionImpact,
  outcome: googleSubscriptionOutcome,
  verification: googleSubscriptionVerification,
  observed: googleSubscriptionObserved,
  spendConfirmation: {
    needed: googleSubscriptionEnables,
    message:
      'An enabled recommendation subscription lets Google change budgets, bids, keywords or ads automatically. Review it and provide spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
  activates: googleSubscriptionEnables,
};
