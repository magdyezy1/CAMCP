import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {assertDV360WriteScope} from './dv360-scope.js';
import {fail} from './family-kit.js';

/**
 * Duplication of DV360 line items, per the pinned Display & Video 360 API v4 Discovery document
 * (advertisers.lineItems.duplicate, DuplicateLineItemRequest and DuplicateLineItemResponse, LineItem; checked 2026-09-27)
 * and the "Activate Line Item" guide. The copy is created in the insertion order of the source line item under
 * targetDisplayName (at most 240 UTF-8 bytes), and the response returns its ID. A new line item needs
 * containsEuPoliticalAds unless the advertiser declares that it does not contain EU political ads, so the review requires
 * it. Line items must be created in draft; YouTube & Partners line items cannot be created through the API. The method
 * regularly experiences high latency: a request that times out is a lost receipt and is never resubmitted.
 */
type Read = CompiledRequest & {dv360DuplicateState?: {lineItemId: string}};
const origin = 'https://displayvideo.googleapis.com',
  route = /^\/v4\/advertisers\/([1-9]\d*)\/lineItems\/([1-9]\d*):duplicate$/;
const euValues = ['CONTAINS_EU_POLITICAL_ADVERTISING', 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'];
const youtube = /^LINE_ITEM_TYPE_YOUTUBE_AND_PARTNERS/;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  return fail('INVALID_DV360_LINE_ITEM_DUPLICATE', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
const advertiserOf = (p: CompiledRequest) => route.exec(p.path)![1]!,
  sourceOf = (p: CompiledRequest) => route.exec(p.path)![2]!;
const body = (p: CompiledRequest): JsonObject => (object(p.body) ? p.body : {});
export function dv360LineItemDuplicateKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'dv360_native_action' &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (p.origin === undefined || p.origin === origin) &&
    route.test(p.path)
  );
}
export function assertDV360LineItemDuplicate(p: CompiledRequest): void {
  if (!dv360LineItemDuplicateKind(p)) return;
  if (advertiserOf(p) !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'The request must use the selected advertiser.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers ?? {}).length)
    invalid('Line item duplication takes no query parameters or header overrides.');
  const b = p.body;
  if (!object(b)) invalid('Provide the native DuplicateLineItemRequest.');
  const extra = Object.keys(b).filter(k => !['targetDisplayName', 'containsEuPoliticalAds'].includes(k));
  if (extra.length) invalid('Unqualified fields: ' + extra.join(', ') + '.');
  const name = b.targetDisplayName;
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name !== name.trim() ||
    Buffer.byteLength(name, 'utf8') > 240 ||
    /[\u0000-\u001f\u007f]/.test(name)
  )
    invalid('targetDisplayName names the copy: 1–240 UTF-8 bytes without surrounding spaces or control characters.');
  if (!euValues.includes(b.containsEuPoliticalAds))
    invalid(
      'containsEuPoliticalAds is CONTAINS_EU_POLITICAL_ADVERTISING or DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING; a new line item needs the declaration.',
    );
}
function read(p: CompiledRequest, path: string): Read {
  return {
    ...p,
    action: 'AMCP_DV360_LINE_ITEM_DUPLICATE_READ',
    method: 'GET',
    path,
    query: {},
    body: undefined,
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
    queryArrayEncoding: undefined,
    dv360DuplicateState: undefined,
  };
}
const stateRead = (p: CompiledRequest, lineItemId: string): Read => ({
  ...read(p, '/v4/advertisers/' + advertiserOf(p)),
  dv360DuplicateState: {lineItemId},
});
/** One marked read of the advertiser; the reader adds the line item and its insertion order. */
export function dv360LineItemDuplicateSnapshots(p: CompiledRequest): Read[] {
  return [stateRead(p, sourceOf(p))];
}
export function isDV360LineItemDuplicateRead(p: CompiledRequest): p is Read {
  return p.gateway === 'dv360_native_action' && !!(p as Read).dv360DuplicateState;
}
export async function readDV360LineItemDuplicate(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).dv360DuplicateState;
  if (!s) return fetch(p);
  const advertiser = p.path.split('/')[3]!;
  const get = async (path: string) => {
    const r = await fetch(read(p, path)),
      d = r.data;
    if (r.status !== 200 || !object(d) || d.error) unverified('DV360 did not return ' + path + '.');
    return d as JsonObject;
  };
  const adv = await get('/v4/advertisers/' + advertiser);
  if (String(adv.advertiserId) !== advertiser) unverified('DV360 returned another advertiser.');
  const d = await get('/v4/advertisers/' + advertiser + '/lineItems/' + s.lineItemId);
  if (String(d.advertiserId) !== advertiser || String(d.lineItemId) !== s.lineItemId)
    fail(
      'STATE_TARGET_MISMATCH',
      'Line item ' + s.lineItemId + ' is not a line item of the selected advertiser.',
      {line_item_id: s.lineItemId},
      409,
    );
  const io = String(d.insertionOrderId ?? '');
  if (!/^[1-9]\d*$/.test(io)) unverified('Line item ' + s.lineItemId + ' names no insertion order.');
  const o = await get('/v4/advertisers/' + advertiser + '/insertionOrders/' + io);
  if (String(o.insertionOrderId) !== io) unverified('DV360 returned another insertion order.');
  return {
    status: 200,
    headers: {},
    data: {
      advertiserId: advertiser,
      lineItem: {
        lineItemId: s.lineItemId,
        insertionOrderId: io,
        campaignId: String(d.campaignId ?? ''),
        displayName: d.displayName ?? null,
        lineItemType: d.lineItemType ?? null,
        entityStatus: d.entityStatus ?? null,
        containsEuPoliticalAds: d.containsEuPoliticalAds ?? null,
      },
      insertionOrder: {insertionOrderId: io, displayName: o.displayName ?? null, entityStatus: o.entityStatus ?? null},
    },
  };
}
export function validateDV360LineItemDuplicateState(p: CompiledRequest, r: TransportResult): void {
  const d = r.data,
    s = (p as Read).dv360DuplicateState;
  if (
    !s ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.lineItem) ||
    d.lineItem.lineItemId !== s.lineItemId ||
    !object(d.insertionOrder)
  )
    unverified('Missing verified line item state.');
}
export function dv360LineItemDuplicatePrerequisites(p: CompiledRequest, states: unknown[]): void {
  if (!dv360LineItemDuplicateKind(p)) return;
  const s = states[0];
  if (!object(s) || !object(s.lineItem) || !object(s.insertionOrder)) unverified('Missing verified line item state.');
  const li = s.lineItem,
    io = s.insertionOrder,
    id = sourceOf(p);
  if (youtube.test(String(li.lineItemType)))
    invalid(
      'Line item ' +
        id +
        ' is ' +
        li.lineItemType +
        '; YouTube & Partners line items cannot be created through the API.',
    );
  if (li.entityStatus === 'ENTITY_STATUS_ARCHIVED') invalid('Line item ' + id + ' is archived.');
  if (io.entityStatus === 'ENTITY_STATUS_ARCHIVED')
    invalid('Insertion order ' + io.insertionOrderId + ' is archived; the copy would be created there.');
}
export function dv360LineItemDuplicateImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!dv360LineItemDuplicateKind(p)) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    b = body(p);
  return {
    provider: 'dv360',
    scope: 'line_item_duplicate',
    source: object(s.lineItem) ? s.lineItem : null,
    insertion_order: object(s.insertionOrder) ? s.insertionOrder : null,
    copy: {
      displayName: b.targetDisplayName,
      containsEuPoliticalAds: b.containsEuPoliticalAds,
      entityStatus: 'ENTITY_STATUS_DRAFT',
    },
    may_affect_serving: false,
    effect:
      'Creates a draft copy of the line item in the same insertion order. A draft line item serves nothing; activate the copy with a reviewed update once its settings are checked.',
    verification: 'Reads the copy: the insertion order, type and name, the EU declaration, and the draft status.',
    source_reference:
      'https://developers.google.com/display-video/api/reference/rest/v4/advertisers.lineItems/duplicate',
  };
}
export function dv360LineItemDuplicateOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const d = r.data;
  return (
    r.status === 200 &&
    object(d) &&
    typeof d.duplicateLineItemId === 'string' &&
    /^[1-9]\d*$/.test(d.duplicateLineItemId) &&
    d.duplicateLineItemId !== sourceOf(p)
  );
}
export function dv360LineItemDuplicateVerification(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const copy = result.data?.duplicateLineItemId;
  if (typeof copy !== 'string' || !/^[1-9]\d*$/.test(copy))
    fail('VERIFICATION_UNSUPPORTED', 'The receipt names no line item to verify.');
  const first = before[0],
    source = object(first) && object(first.lineItem) ? first.lineItem : {},
    b = body(p);
  return [
    {
      read: stateRead(p, copy),
      expected: {
        lineItem: {
          lineItemId: copy,
          insertionOrderId: source.insertionOrderId,
          lineItemType: source.lineItemType,
          displayName: b.targetDisplayName,
          containsEuPoliticalAds: b.containsEuPoliticalAds,
          entityStatus: 'ENTITY_STATUS_DRAFT',
        },
      },
      id: 'line item ' + copy,
    },
  ];
}
export function dv360LineItemDuplicateObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {lineItem: object(data.lineItem) ? data.lineItem : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const dv360LineItemDuplicateFamily: ReviewedFamily = {
  name: 'dv360_line_item_duplicate',
  files: ['src/dv360-line-item-duplicate.ts', ['tests/dv360-line-item-duplicate.test.mjs']],
  kind: dv360LineItemDuplicateKind,
  assert: assertDV360LineItemDuplicate,
  scope: assertDV360WriteScope,
  snapshots: dv360LineItemDuplicateSnapshots,
  isRead: isDV360LineItemDuplicateRead,
  reader: readDV360LineItemDuplicate,
  validateState: validateDV360LineItemDuplicateState,
  prerequisites: dv360LineItemDuplicatePrerequisites,
  impact: dv360LineItemDuplicateImpact,
  outcome: dv360LineItemDuplicateOutcome,
  verification: dv360LineItemDuplicateVerification,
  observed: dv360LineItemDuplicateObserved,
  exemptFromSpendTextMatch: true,
};
