import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {familyStateErrors, type StateFlaggedRefusal} from './family-kit.js';
import {googleJson, assertGoogleAdsScope} from './google-contracts.js';
import {stable, sha256} from './security.js';
import {changedStateFields} from './review-state-core.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {googleAdsCustomers} from './google-version.js';

/**
 * Removing labels from a Google Ads customer (CustomerLabelService.MutateCustomerLabels, Google Ads API v25; discovery
 * document pinned in .mirror/VENDOR/google-ads-v25.json). A CustomerLabel is "a relationship between a customer and a
 * label"; the label usually belongs to a manager, and "additional CustomerLabels may be returned by increasing
 * permissions with login-customer-id", so reads and the removal go out under the connection's login customer for the
 * account. A remove names `customers/{customer_id}/customerLabels/{label_id}`; one request modifies one customer and,
 * with partialFailure false, is all or nothing. Creation stays outside the contract: the same document marks both
 * CustomerLabel fields (`customer`, `label`) output only and gives a create no resource name, so a create cannot be
 * stated unambiguously.
 */
const gateway = 'google_ads_native_action';
const actions = new Set(['google_ads_v23_customer_label_mutate_customer_labels']);
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
type Send = (read: CompiledRequest) => Promise<TransportResult>;
const fail: StateFlaggedRefusal = familyStateErrors(
  'INVALID_CUSTOMER_LABEL_REMOVAL',
  'CUSTOMER_LABEL_STATE_UNVERIFIED',
);
function only(value: JsonObject, allowed: string[], state = false) {
  if (Object.keys(value).some(k => !allowed.includes(k)))
    fail('The customer label contract received an unknown field or native envelope.', state);
}
function account(p: CompiledRequest): string {
  if (!p.accountId || !/^\d+$/.test(p.accountId)) fail('Select an exact Google Ads customer.');
  return p.accountId;
}
function name(p: CompiledRequest, value: unknown, state = false): string {
  if (typeof value !== 'string' || !new RegExp('^customers/' + account(p) + '/customerLabels/[1-9][0-9]*$').test(value))
    fail('Use the exact customerLabels resource name of the selected customer.', state);
  return value as string;
}
export function googleCustomerLabelKind(p: CompiledRequest): boolean {
  return (
    p.gateway === gateway &&
    actions.has(p.action) &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://googleads.googleapis.com') &&
    /^\/v\d+\/customers\/\d+\/customerLabels:mutate$/.test(p.path)
  );
}
const targets = (p: CompiledRequest): string[] =>
  googleJson(p.body).operations.map((op: JsonObject) => name(p, op.remove));
export function assertGoogleCustomerLabels(p: CompiledRequest): void {
  const body = googleJson(p.body);
  if (!object(body)) fail('Provide native customer label operations.');
  only(body, ['operations', 'partialFailure']);
  if (p.path.split('/')[3] !== account(p) || Object.keys(p.query).length || Object.keys(p.headers).length)
    fail('Use the exact customer route without query or header overrides.');
  if (
    !Array.isArray(body.operations) ||
    !body.operations.length ||
    body.operations.length > 100 ||
    (body.partialFailure !== undefined && body.partialFailure !== false)
  )
    fail('Remove 1–100 customer labels atomically, with partialFailure omitted or false.');
  for (const op of body.operations) {
    if (object(op) && Object.hasOwn(op, 'create'))
      throw new MirrorError(
        'WRITE_CONTRACT_UNAVAILABLE',
        "Applying a label to a customer is outside the reviewed contract: Google's v25 reference marks both CustomerLabel fields output only and gives a create no resource name. Only removal is reviewed.",
        {operation: 'create', source: 'https://developers.google.com/google-ads/api/reference/rpc/v25/CustomerLabel'},
      );
    if (!object(op)) fail('Each operation removes one customer label.');
    only(op, ['remove']);
    name(p, op.remove);
  }
  if (new Set(targets(p)).size !== body.operations.length) fail('Each customer label must occur only once.');
}
function read(p: CompiledRequest): CompiledRequest {
  return {
    ...p,
    action: 'AMCP_CUSTOMER_LABEL_READ',
    method: 'POST',
    path: googleAdsCustomers + account(p) + '/googleAds:search',
    body: {
      query:
        'SELECT customer_label.resource_name, customer_label.customer, customer_label.label FROM customer_label WHERE customer_label.resource_name IN (' +
        targets(p)
          .map(n => "'" + n + "'")
          .join(', ') +
        ')',
    },
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
  };
}
export function googleCustomerLabelSnapshots(p: CompiledRequest): CompiledRequest[] {
  return [read(p)];
}
/** The selected customer labels, keyed by resource name; complete across pages and bounded. */
async function currentState(p: CompiledRequest, send: Send): Promise<JsonObject> {
  const labels: JsonObject = {},
    tokens = new Set<string>();
  let token: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 5) fail('Customer label reads exceeded their page bound.', true);
    const plan = read(p);
    if (token) (plan.body as JsonObject).pageToken = token;
    const result = await send(plan),
      data = result.data;
    if (result.status !== 200 || !object(data)) fail('The native customer label read failed.', true);
    only(
      data,
      ['results', 'fieldMask', 'queryResourceConsumption', 'requestId', 'nextPageToken', 'totalResultsCount'],
      true,
    );
    if (
      (data.results !== undefined && !Array.isArray(data.results)) ||
      (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string')
    )
      fail('The customer label page is malformed.', true);
    const rows = data.results ?? [];
    for (const row of rows) {
      if (!object(row) || Object.keys(row).length !== 1 || !object(row.customerLabel))
        fail('The native result row has an unknown shape.', true);
      const r = row.customerLabel;
      only(r, ['resourceName', 'customer', 'label'], true);
      const id = name(p, r.resourceName, true);
      if (
        Object.hasOwn(labels, id) ||
        !targets(p).includes(id) ||
        (r.customer !== undefined && r.customer !== 'customers/' + account(p)) ||
        (r.label !== undefined && (typeof r.label !== 'string' || !/^customers\/\d+\/labels\/\d+$/.test(r.label)))
      )
        fail('A customer label is foreign, repeated or malformed.', true);
      labels[id] = {resourceName: id, customer: 'customers/' + account(p), label: r.label ?? null};
    }
    if (!data.nextPageToken) break;
    if (!rows.length || tokens.has(data.nextPageToken)) fail('The customer label cursor repeated.', true);
    tokens.add(data.nextPageToken);
    token = data.nextPageToken;
  }
  return {customer: account(p), labels};
}
export async function readGoogleCustomerLabelState(p: CompiledRequest, send: Send): Promise<unknown[]> {
  return [await currentState(p, send)];
}
export function assertGoogleCustomerLabelPrerequisites(p: CompiledRequest, state: unknown[]): void {
  if (!googleCustomerLabelKind(p)) return;
  const s = state[0];
  if (!object(s) || !object(s.labels)) fail('Missing verified customer label state.', true);
  const missing = targets(p).filter(n => !Object.hasOwn(s.labels, n));
  if (missing.length)
    fail(
      'The customer does not carry ' +
        (missing.length === 1 ? 'this label' : 'these labels') +
        ' as seen by the login customer of the connection: ' +
        missing.join(', ') +
        '.',
      false,
      'STATE_NOT_FOUND',
      {missing},
    );
}
export function googleCustomerLabelImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!googleCustomerLabelKind(p)) return;
  const s = state[0];
  return {
    provider: 'google_ads',
    scope: 'customer_label',
    operation: 'remove',
    customer: account(p),
    labels: object(s) && object(s.labels) ? Object.values(s.labels) : [],
    may_affect_serving: false,
    effect:
      'Removes the selected labels from this customer account. The labels themselves, and other accounts carrying them, are unchanged; campaigns, budgets and serving are not affected.',
    verification: 'Reads the customer labels again and expects each one to be gone.',
    source: 'https://developers.google.com/google-ads/api/reference/rpc/v25/CustomerLabelService',
  };
}
export function googleCustomerLabelOutcome(p: CompiledRequest, result: TransportResult): boolean {
  const data = result.data;
  if (
    result.status !== 200 ||
    !object(data) ||
    Object.keys(data).some(k => k !== 'results') ||
    !Array.isArray(data.results)
  )
    return false;
  const expected = targets(p),
    seen = new Set<string>();
  return (
    data.results.length === expected.length &&
    data.results.every(
      row =>
        object(row) &&
        Object.keys(row).length === 1 &&
        expected.includes(row.resourceName) &&
        !seen.has(row.resourceName) &&
        !!seen.add(row.resourceName),
    )
  );
}
export async function verifyGoogleCustomerLabels(p: CompiledRequest, send: Send) {
  const expected = {customer: account(p), labels: {}},
    actual = await currentState(p, send),
    changed = changedStateFields([expected], [actual]),
    status = changed.length ? 'inconclusive' : 'verified';
  return {
    status,
    checks: [
      {
        status,
        resource_ids: targets(p),
        changed_fields: changed,
        expected_hash: sha256(stable(expected)),
        actual_hash: sha256(stable(actual)),
        still_present: Object.keys(actual.labels as JsonObject),
      },
    ],
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleCustomerLabelFamily: ReviewedFamily = {
  name: 'google_customer_labels',
  files: ['src/google-customer-labels.ts', ['tests/google-customer-labels.test.mjs']],
  kind: googleCustomerLabelKind,
  assert: plan => assertGoogleCustomerLabels(plan),
  scope: c => assertGoogleAdsScope(c),
  snapshots: googleCustomerLabelSnapshots,
  state: (plan, readers) =>
    readGoogleCustomerLabelState(plan, readers.guarded('Customer label prerequisites must remain read-only.').read),
  stateChecks: (plan, state) => assertGoogleCustomerLabelPrerequisites(plan, state),
  impact: googleCustomerLabelImpact,
  outcome: googleCustomerLabelOutcome,
  verify: (plan, v) =>
    verifyGoogleCustomerLabels(
      plan,
      v.guarded('Customer label verification must remain read-only.', {check: assertGoogleAdsScope}),
    ).then(o => ({status: o.status, checks: o.checks})),
  exemptFromSpendTextMatch: true,
  destructive: () => true,
};
