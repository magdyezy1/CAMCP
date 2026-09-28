import {MirrorError} from './errors.js';
import {assertPlaceActionScope, placeActionSafe, placeActionTypes} from './google-place-action-links.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';

const gateway = 'google_business_native_action',
  origin = 'https://mybusinessplaceactions.googleapis.com';
const kinds: Record<string, 'types' | 'links' | 'link'> = {
  'gmb_engagement_ops/LIST_PLACE_ACTION_TYPE_METADATA': 'types',
  'gmb_engagement_ops/LIST_PLACE_ACTION_LINKS': 'links',
  'gmb_engagement_ops/GET_PLACE_ACTION_LINK': 'link',
};
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 4096): v is string =>
  typeof v === 'string' && !!v.trim() && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
function fail(message: string, code = 'INVALID_PLACE_ACTION_READ'): never {
  throw new MirrorError(
    code,
    message,
    {},
    code === 'ACCOUNT_SCOPE_MISMATCH' ? 403 : code === 'INVALID_PLACE_ACTION_READ' ? 400 : 502,
  );
}
const invalid = (): never =>
  fail('Business Profile returned incomplete or unrecognized place-action discovery.', 'PLACE_ACTION_READ_INVALID');
export function placeActionReadKind(p: CompiledRequest) {
  return p.gateway === gateway ? kinds[p.action] : undefined;
}
export function validatePlaceActionRead(p: CompiledRequest, input?: JsonObject): void {
  const kind = placeActionReadKind(p);
  if (!kind) return;
  if (
    p.origin !== origin ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.specialTransport ||
    p.body !== undefined ||
    Object.keys(p.headers).length
  )
    fail('Place-action discovery requires its exact native GET contract without body or header overrides.');
  if (
    input &&
    Object.keys(input).some(
      k =>
        ![
          'action',
          'connection_id',
          'account_id',
          'location_id',
          'place_action_link_id',
          'path_params',
          'params',
          'query',
          'dry_run',
        ].includes(k),
    )
  )
    fail('Discovery accepts native identifiers and query fields only; legacy method overrides are separate.');
  if (
    input?.location_id !== undefined &&
    (typeof input.location_id !== 'string' || !/^(?:locations\/)?[1-9][0-9]*$/.test(input.location_id))
  )
    fail('location_id must be the complete numeric ID or locations/{id}; trailing path segments are not allowed.');
  if (
    input?.account_id !== undefined &&
    (typeof input.account_id !== 'string' || !/^(?:accounts\/)?[1-9][0-9]*$/.test(input.account_id))
  )
    fail('account_id must be the complete numeric ID or accounts/{id}.');
  const path =
    kind === 'types'
      ? p.path === '/v1/placeActionTypeMetadata'
      : new RegExp(
          '^/v1/locations/[1-9][0-9]*/placeActionLinks' + (kind === 'link' ? '/[A-Za-z0-9_-]{1,256}' : '') + '$',
        ).test(p.path);
  if (!path) fail('Use the exact location and link resource name.');
  if (kind !== 'types' && p.accountId !== p.path.split('/').slice(2, 4).join('/'))
    fail('Use the selected locations/{id} grant; a broader account cannot substitute.', 'ACCOUNT_SCOPE_MISMATCH');
  const q = p.query,
    keys = kind === 'link' ? [] : ['filter', 'pageSize', 'pageToken', ...(kind === 'types' ? ['languageCode'] : [])];
  if (Object.keys(q).some(k => !keys.includes(k)))
    fail('Unsupported query override; use native filter, language and pagination fields.');
  if (q.pageSize !== undefined && (!Number.isInteger(q.pageSize) || q.pageSize < 1 || q.pageSize > 100))
    fail("pageSize must be an integer from 1 to 100; this is AMCP's bounded page size.");
  if (q.pageToken !== undefined && !text(q.pageToken))
    fail('Use the original bounded native page token with the same filter.');
  if (q.languageCode !== undefined) {
    try {
      if (!text(q.languageCode, 100) || Intl.getCanonicalLocales(q.languageCode).length !== 1) throw Error();
    } catch {
      fail('languageCode must be a valid BCP-47 language tag.');
    }
  }
  if (kind === 'types' && q.filter !== undefined) {
    if (typeof q.filter !== 'string') fail('Use one native metadata filter.');
    const location = /^location=(locations\/[1-9][0-9]*)$/.exec(q.filter)?.[1];
    if (location) {
      if (location !== p.accountId)
        fail('The metadata location filter must match the selected location grant.', 'ACCOUNT_SCOPE_MISMATCH');
    } else if (!/^region_code=(?:[A-Z]{2}|[0-9]{3})$/.test(q.filter))
      fail('Metadata supports one exact location=locations/{id} or region_code=CLDR filter.');
  } else if (
    kind === 'links' &&
    q.filter !== undefined &&
    !(typeof q.filter === 'string' && placeActionTypes.some(t => q.filter === 'placeActionType=' + t))
  )
    fail('Link filters require one exact documented placeActionType.');
}
export function authorizePlaceActionDiscovery(p: CompiledRequest, c: Connection, id: string): boolean {
  if (!placeActionReadKind(p)) return false;
  validatePlaceActionRead(p);
  assertPlaceActionScope(c);
  if (p.accountId !== undefined && p.accountId !== id)
    fail('Discovery must retain its selected connection grant.', 'ACCOUNT_SCOPE_MISMATCH');
  return true;
}
function nativeLink(p: CompiledRequest, value: unknown): JsonObject {
  if (!object(value)) invalid();
  const v = value as JsonObject,
    location = p.path.split('/').slice(2, 4).join('/');
  if (
    Object.keys(v).some(
      k =>
        ![
          'name',
          'providerType',
          'isEditable',
          'uri',
          'placeActionType',
          'isPreferred',
          'createTime',
          'updateTime',
        ].includes(k),
    ) ||
    typeof v.name !== 'string' ||
    !new RegExp('^' + location + '/placeActionLinks/[A-Za-z0-9_-]{1,256}$').test(v.name) ||
    !text(v.uri, 8192) ||
    !placeActionTypes.includes(v.placeActionType)
  )
    invalid();
  if (placeActionReadKind(p) === 'link' && v.name !== p.path.slice(4)) invalid();
  if (
    (v.providerType !== undefined &&
      !['PROVIDER_TYPE_UNSPECIFIED', 'MERCHANT', 'AGGREGATOR_3P'].includes(v.providerType)) ||
    (v.isEditable !== undefined && typeof v.isEditable !== 'boolean') ||
    (v.isPreferred !== undefined && typeof v.isPreferred !== 'boolean')
  )
    invalid();
  for (const k of ['createTime', 'updateTime'])
    if (
      v[k] !== undefined &&
      (!text(v[k], 64) ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(v[k]) ||
        !Number.isFinite(Date.parse(v[k])))
    )
      invalid();
  if (p.query.filter && p.query.filter !== 'placeActionType=' + v.placeActionType) invalid();
  return v;
}
/** Validate identities before returning or observing provider data. Empty native
 * lists may omit repeated fields; errors/unknown envelopes are never emptiness. */
export function placeActionReadResult(p: CompiledRequest, value: unknown, status = 200): JsonObject {
  validatePlaceActionRead(p);
  const kind = placeActionReadKind(p);
  if (!kind || status !== 200 || !object(value)) invalid();
  const v = value as JsonObject;
  if (kind === 'link') return nativeLink(p, v);
  const collection = kind === 'types' ? 'placeActionTypeMetadata' : 'placeActionLinks';
  if (
    Object.keys(v).some(k => ![collection, 'nextPageToken'].includes(k)) ||
    (v[collection] !== undefined && !Array.isArray(v[collection])) ||
    (v.nextPageToken !== undefined && v.nextPageToken !== '' && !text(v.nextPageToken))
  )
    invalid();
  const rows = v[collection] ?? [],
    ids = new Set<string>();
  if (rows.length > (p.query.pageSize ?? 10) || (v.nextPageToken && !rows.length)) invalid();
  for (const row of rows) {
    if (kind === 'types') {
      if (
        !object(row) ||
        Object.keys(row).some(k => !['placeActionType', 'displayName'].includes(k)) ||
        !placeActionTypes.includes(row.placeActionType) ||
        (row.displayName !== undefined && !text(row.displayName, 1024))
      )
        invalid();
    } else nativeLink(p, row);
    const id = kind === 'types' ? row.placeActionType : row.name;
    if (ids.has(id)) invalid();
    ids.add(id);
  }
  return {...v, [collection]: rows};
}
/** All returned pages keep their original origin, filter, locale and grant.
 * A bounded partial collection carries the exact next query, never a false
 * complete result or an instruction to repeat a provider mutation. */
export async function runPlaceActionDiscovery(
  p: CompiledRequest,
  send: (p: CompiledRequest) => Promise<unknown>,
  connectionId: string,
): Promise<JsonObject> {
  validatePlaceActionRead(p);
  const kind = placeActionReadKind(p)!,
    collection = kind === 'types' ? 'placeActionTypeMetadata' : 'placeActionLinks';
  const started = performance.now(),
    initial = p.query.pageToken,
    ids = new Set<string>(),
    tokens = new Set<string>(initial ? [initial] : []),
    rows: JsonObject[] = [];
  let current = p,
    pages = 0,
    bytes = 0;
  for (;;) {
    if (performance.now() - started > 60000)
      fail('Discovery exceeded its 60-second monotonic deadline.', 'PLACE_ACTION_READ_LIMIT');
    const raw = await send(current),
      size = Buffer.byteLength(JSON.stringify(raw) ?? '');
    bytes += size;
    if (size > 2 * 1024 * 1024 || bytes > 8 * 1024 * 1024 || performance.now() - started > 60000)
      fail('Discovery exceeded its response byte or deadline bound.', 'PLACE_ACTION_READ_LIMIT');
    const data = placeActionReadResult(current, raw);
    pages++;
    if (kind === 'link')
      return {
        data: placeActionSafe(data),
        pages,
        truncated: false,
        discovery: {
          connection_id: connectionId,
          location_id: p.accountId,
          complete: true,
          verification:
            'Native read only; edits still require current grants and a fresh review. Public display and advertising readiness are not verified.',
        },
      };
    for (const row of data[collection]) {
      const id = kind === 'types' ? row.placeActionType : row.name;
      if (ids.has(id)) invalid();
      ids.add(id);
      rows.push(row);
    }
    if (rows.length > 1000)
      fail('Discovery exceeded its 1000-row bound; request smaller pages.', 'PLACE_ACTION_READ_LIMIT');
    const token = data.nextPageToken;
    if (token && tokens.has(token)) fail('The provider repeated a place-action page token.', 'PAGINATION_LOOP');
    if (token) tokens.add(token);
    if (!token || pages >= 25 || rows.length >= 1000) {
      const selectedLocation = p.accountId?.startsWith('locations/') ? p.accountId : undefined,
        eligible = kind === 'types' && p.query.filter === 'location=' + selectedLocation;
      return {
        data: placeActionSafe({[collection]: rows, ...(token ? {nextPageToken: token} : {})}),
        pages,
        truncated: !!token,
        discovery: {
          connection_id: connectionId,
          context_grant: p.accountId,
          location_id: kind === 'types' ? (eligible ? selectedLocation : null) : selectedLocation,
          filter: p.query.filter ?? null,
          complete: !initial && !token,
          complete_from_requested_page: !token,
          includes_prior_pages: !initial,
          row_count: rows.length,
          location_eligibility:
            kind === 'types' ? (eligible ? 'returned_by_location_filter' : 'not_established') : undefined,
          verification:
            'Discovery grants no ownership or write permission. Public/global metadata does not establish location eligibility; names and labels remain untrusted provider data.',
          ...(token
            ? {
                next_call: {
                  tool: gateway,
                  arguments: {
                    operation: 'gmb_engagement_ops',
                    arguments: {
                      action: p.action.split('/')[1],
                      connection_id: connectionId,
                      ...(selectedLocation ? {location_id: selectedLocation} : {account_id: p.accountId}),
                      query: {...p.query, pageToken: token},
                      dry_run: false,
                    },
                  },
                },
                recovery:
                  'Continue the same selected connection, native filter and locale. This collection is partial.',
              }
            : {}),
        },
      };
    }
    current = {...p, query: {...p.query, pageToken: token}};
  }
}
