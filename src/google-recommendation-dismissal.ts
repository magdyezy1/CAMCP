import {MirrorError} from './errors.js';
import {googleJson} from './google-contracts.js';
import {stable, sha256} from './security.js';
import {changedStateFields} from './review-state.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

const gateway = 'google_ads_native_action';
const actions = new Set(['DISMISS_RECOMMENDATION', 'google_ads_v23_recommendation_dismiss_recommendation']);
const fields = ['resource_name', 'type', 'dismissed', 'campaign', 'campaigns', 'campaign_budget', 'ad_group'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
type Send = (read: CompiledRequest) => Promise<TransportResult>;
function fail(message: string, state = false): never {
  throw new MirrorError(
    state ? 'RECOMMENDATION_STATE_UNVERIFIED' : 'INVALID_RECOMMENDATION_DISMISSAL',
    message,
    {},
    state ? 502 : 400,
  );
}
function only(value: JsonObject, allowed: string[], state = false) {
  if (Object.keys(value).some(k => !allowed.includes(k)))
    fail('The dismissal contract received an unknown field or native envelope.', state);
}
function account(p: CompiledRequest): string {
  if (!p.accountId || !/^\d+$/.test(p.accountId)) fail('Select an exact Google Ads customer.');
  return p.accountId;
}
function resource(p: CompiledRequest, value: unknown, collection = 'recommendations', state = false): string {
  const pattern = collection === 'recommendations' ? '[A-Za-z0-9_.~=-]{1,1024}' : '[1-9][0-9]*';
  if (
    typeof value !== 'string' ||
    !new RegExp('^customers/' + account(p) + '/' + collection + '/' + pattern + '$').test(value)
  )
    fail('Use the exact selected-customer ' + collection + ' resource name.', state);
  return value as string;
}
export function googleDismissalKind(p: CompiledRequest): boolean {
  return (
    p.gateway === gateway &&
    actions.has(p.action) &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://googleads.googleapis.com') &&
    /^\/v23\/customers\/\d+\/recommendations:dismiss$/.test(p.path)
  );
}
const targets = (p: CompiledRequest): string[] =>
  googleJson(p.body).operations.map((op: JsonObject) => resource(p, op.resourceName));
export function assertGoogleDismissal(p: CompiledRequest): void {
  const body = googleJson(p.body);
  if (!object(body)) fail('Provide native dismissal operations.');
  only(body, ['operations', 'partialFailure']);
  if (p.path.split('/')[3] !== account(p) || Object.keys(p.query).length || Object.keys(p.headers).length)
    fail('Use the exact customer route without query or header overrides.');
  if (
    !Array.isArray(body.operations) ||
    !body.operations.length ||
    body.operations.length > 100 ||
    (body.partialFailure !== undefined && body.partialFailure !== false)
  )
    fail('Dismiss 1–100 recommendations atomically, with partialFailure omitted or false.');
  for (const op of body.operations) {
    if (!object(op)) fail('Each operation identifies one recommendation.');
    only(op, ['resourceName']);
    resource(p, op.resourceName);
  }
  if (new Set(targets(p)).size !== body.operations.length) fail('Each recommendation must occur only once.');
}
function read(p: CompiledRequest, kind: 'customer' | 'recommendation'): CompiledRequest {
  const query =
    kind === 'customer'
      ? 'SELECT customer.id, customer.currency_code, customer.time_zone, customer.manager FROM customer LIMIT 1'
      : 'SELECT ' +
        fields.map(f => 'recommendation.' + f).join(', ') +
        ' FROM recommendation WHERE recommendation.resource_name IN (' +
        targets(p)
          .map(n => "'" + n + "'")
          .join(', ') +
        ')';
  return {
    ...p,
    action: 'AMCP_RECOMMENDATION_DISMISS_READ',
    method: 'POST',
    path: '/v23/customers/' + account(p) + '/googleAds:search',
    body: {query},
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
  };
}
export function googleDismissalSnapshots(p: CompiledRequest): CompiledRequest[] {
  return [read(p, 'customer'), read(p, 'recommendation')];
}
async function currentState(p: CompiledRequest, send: Send, allowMissing = false): Promise<JsonObject> {
  let requests = 0,
    bytes = 0;
  const started = performance.now(),
    names = targets(p);
  const fetch = async (kind: 'customer' | 'recommendation') => {
    const values: JsonObject[] = [],
      tokens = new Set<string>();
    let token: string | undefined, count: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 25 || ++requests > 100 || performance.now() - started > 60000)
        fail('Dismissal reads exceeded their page, request or monotonic deadline bound.', true);
      const plan = read(p, kind);
      if (token) (plan.body as JsonObject).pageToken = token;
      const result = await send(plan),
        data = result.data;
      if (result.status !== 200 || !object(data)) fail('The native customer/recommendation read failed.', true);
      only(
        data,
        ['results', 'fieldMask', 'queryResourceConsumption', 'requestId', 'nextPageToken', 'totalResultsCount'],
        true,
      );
      const size = Buffer.byteLength(JSON.stringify(data));
      bytes += size;
      if (size > 2 * 1024 * 1024 || bytes > 8 * 1024 * 1024 || performance.now() - started > 60000)
        fail('Dismissal reads exceeded their response byte or deadline bound.', true);
      if (
        (data.results !== undefined && !Array.isArray(data.results)) ||
        (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string')
      )
        fail('The recommendation page is malformed.', true);
      if (data.totalResultsCount !== undefined) {
        const n = String(data.totalResultsCount);
        if (!/^\d+$/.test(n) || (count !== undefined && count !== n))
          fail('The result count is invalid or changed between pages.', true);
        count = n;
      }
      const rows = data.results ?? [];
      for (const row of rows) {
        if (!object(row) || Object.keys(row).length !== 1 || !object(row[kind]))
          fail('The native result row has an unknown shape.', true);
        values.push(row[kind]);
      }
      if (values.length > (kind === 'customer' ? 1 : 100))
        fail('The selected native collection exceeded its expected row bound.', true);
      if (!data.nextPageToken) break;
      if (!rows.length || data.nextPageToken.length > 4096 || tokens.has(data.nextPageToken))
        fail('The recommendation cursor repeated or returned an incomplete page.', true);
      tokens.add(data.nextPageToken);
      token = data.nextPageToken;
    }
    if (count !== undefined && BigInt(count) !== BigInt(values.length))
      fail('The native count proves incomplete state.', true);
    return values;
  };
  const snapshot = async () => {
    const customers = await fetch('customer'),
      c = customers[0];
    if (
      customers.length !== 1 ||
      c?.id !== account(p) ||
      typeof c.currencyCode !== 'string' ||
      !/^[A-Z]{3}$/.test(c.currencyCode) ||
      typeof c.timeZone !== 'string' ||
      !c.timeZone ||
      (c.manager !== undefined && c.manager !== false)
    )
      fail('The selected client customer identity, currency and time zone are required.', true);
    only(c, ['resourceName', 'id', 'currencyCode', 'timeZone', 'manager'], true);
    if (c.resourceName !== undefined && c.resourceName !== 'customers/' + account(p))
      fail('The customer resource identity differs.', true);
    const recommendations: JsonObject = {};
    for (const row of await fetch('recommendation')) {
      only(
        row,
        ['resourceName', 'type', 'dismissed', 'campaign', 'campaigns', 'campaignBudget', 'adGroup', 'impact'],
        true,
      );
      const name = resource(p, row.resourceName, 'recommendations', true);
      if (
        !names.includes(name) ||
        Object.hasOwn(recommendations, name) ||
        typeof row.type !== 'string' ||
        !/^[A-Z][A-Z0-9_]{1,127}$/.test(row.type) ||
        ['UNKNOWN', 'UNSPECIFIED'].includes(row.type) ||
        (row.dismissed !== undefined && typeof row.dismissed !== 'boolean')
      )
        fail('A recommendation is foreign, repeated or has unknown type/state.', true);
      const projected: JsonObject = {resourceName: name, type: row.type, dismissed: row.dismissed ?? false};
      for (const [field, collection] of [
        ['campaign', 'campaigns'],
        ['campaignBudget', 'campaignBudgets'],
        ['adGroup', 'adGroups'],
      ])
        projected[field!] =
          row[field!] === undefined || row[field!] === '' ? null : resource(p, row[field!], collection, true);
      if (row.campaigns !== undefined && (!Array.isArray(row.campaigns) || row.campaigns.length > 1000))
        fail('Recommendation campaign membership is malformed or too large.', true);
      const campaigns = (row.campaigns ?? []).map((id: unknown) => resource(p, id, 'campaigns', true));
      if (new Set(campaigns).size !== campaigns.length) fail('Recommendation campaign membership is duplicated.', true);
      projected.campaigns = campaigns.sort();
      recommendations[name] = projected;
    }
    if (!allowMissing && Object.keys(recommendations).length !== names.length)
      fail('A selected recommendation is absent or expired. Discover current IDs; do not replace it implicitly.', true);
    // Only dismissal identity/state is relevant. Estimated performance and query
    // telemetry do not authorize application and must not create false conflicts.
    return {customer: {id: c.id, currencyCode: c.currencyCode, timeZone: c.timeZone, manager: false}, recommendations};
  };
  const first = await snapshot(),
    second = await snapshot();
  if (stable(first) !== stable(second)) fail('Recommendation state changed during discovery.', true);
  return first;
}
export async function readGoogleDismissalState(p: CompiledRequest, send: Send): Promise<unknown[]> {
  return [await currentState(p, send)];
}
export function assertGoogleDismissalPrerequisites(p: CompiledRequest, state: unknown[]): void {
  if (!googleDismissalKind(p)) return;
  const rows = Object.values((state[0] as JsonObject).recommendations) as JsonObject[];
  if (rows.some(r => r.dismissed))
    fail('A selected recommendation is already dismissed. Inspect it instead of submitting another dismissal.');
  if (new Set(rows.map(r => r.type)).size !== 1)
    fail(
      'Atomic dismissal requires recommendations of the same native type. Prepare separate reviews for different types.',
    );
}
export function googleDismissalImpact(p: CompiledRequest, state: unknown[]): JsonObject {
  const before = state[0] as JsonObject,
    rows = Object.values(before.recommendations) as JsonObject[];
  return {
    provider: 'google_ads',
    effect:
      'Dismisses only the selected recommendations. Does not apply suggestions, edit campaigns or disable automatic recommendation subscriptions.',
    recommendations: rows,
    customer: before.customer,
    policy: 'Owner deletion policy covers dismissal. It does not activate serving or increase advertising spend.',
    estimates:
      'Forecast performance, optimization score and query cost are excluded from the concurrency state; dismissal does not apply the proposed configuration.',
    recovery:
      'Recommendations can expire and be replaced. Retain the original receipt and key; an absent or expired recommendation does not prove dismissal. Do not implicitly dismiss a replacement ID.',
  };
}
export function googleDismissalOutcome(p: CompiledRequest, result: TransportResult): boolean {
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
export async function verifyGoogleDismissal(p: CompiledRequest, state: unknown[], send: Send) {
  const expected = structuredClone(state[0]) as JsonObject;
  for (const row of Object.values(expected.recommendations) as JsonObject[]) row.dismissed = true;
  const actual = await currentState(p, send, true),
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
        dismissal_observed: status === 'verified',
        configuration_applied: false,
      },
    ],
  };
}
