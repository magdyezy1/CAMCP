import type {ReviewedFamily} from './reviewed-family.js';
import {defineFamily, familyErrors, type ReasonFirstRefusal} from './family-kit.js';
import {xRead, xReader} from './x-creative-writes.js';
import {normalizeReviewState} from './review-state-core.js';
import {xReviewVolatile} from './x-review-volatile.js';
import {xAccountState} from './x-identity-state.js';
import {sha256, stable} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

type Kind = 'create' | 'update' | 'delete' | 'preview';
type Read = (p: CompiledRequest) => Promise<TransportResult>;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const native = /^[a-z0-9]{1,32}$/,
  snowflake = /^[1-9][0-9]{0,24}$/,
  mediaKey = /^[0-9]+_[1-9][0-9]{0,24}$/,
  cardUri = /^card:\/\/[1-9][0-9]{0,24}$/;
const fail: ReasonFirstRefusal = familyErrors('X_DRAFT_STATE_UNVERIFIED');
const input = (message: string): never => fail(message, 'INVALID_X_DRAFT');
const text = (v: unknown, max: number, empty = false) =>
  typeof v === 'string' &&
  (empty || !!v.trim()) &&
  [...v].length <= max &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff]/u.test(v);
const keys = (v: JsonObject, allowed: string[]) => {
  if (Object.keys(v).some(k => !allowed.includes(k))) input('The draft request contains an unqualified native field.');
};
const id = (p: CompiledRequest) => p.path.split('/').at(-1)!;
export function xDraftKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== 'x_ads_native_action' || (p.origin && p.origin !== 'https://ads-api.x.com')) return;
  const m = /^\/12\/accounts\/([a-z0-9]{1,32})\/draft_tweets(?:\/(preview\/)?([1-9][0-9]{0,24}))?$/.exec(p.path);
  if (!m) return;
  if (!m[3] && p.method === 'POST') return 'create';
  if (m[2] && p.method === 'POST') return 'preview';
  if (m[3] && !m[2] && ['PUT', 'DELETE'].includes(p.method)) return p.method === 'PUT' ? 'update' : 'delete';
}
function mediaInput(v: unknown): string[] {
  if (typeof v !== 'string') input('media_keys is the native comma-separated string; use an empty string to clear it.');
  const ids = v === '' ? [] : (v as string).split(',');
  if (ids.length > 4 || ids.some(x => !mediaKey.test(x)) || new Set(ids).size !== ids.length)
    input('Use at most four distinct native media keys without spaces.');
  return ids;
}
export function assertXDraft(p: CompiledRequest) {
  const kind = xDraftKind(p);
  if (!kind) return;
  const b = p.body ?? {};
  if (
    !object(b) ||
    Object.keys(p.query).length ||
    Object.keys(p.headers).length ||
    p.specialTransport ||
    p.path.split('/')[3] !== p.accountId ||
    !native.test(p.accountId ?? '')
  )
    input('Use the exact selected account, native body, fixed Ads origin and no query or header overrides.');
  const row = b as JsonObject;
  keys(
    row,
    kind === 'create'
      ? ['as_user_id', 'text', 'card_uri', 'media_keys', 'nullcast', 'name']
      : kind === 'update'
        ? ['text', 'card_uri', 'media_keys', 'nullcast', 'name']
        : [],
  );
  if (
    kind === 'create' &&
    (typeof row.as_user_id !== 'string' || !snowflake.test(row.as_user_id) || typeof row.nullcast !== 'boolean')
  )
    input(
      'Select an exact FULL promotable author and explicitly choose nullcast true or false. A draft is not published.',
    );
  if (kind === 'update' && !Object.keys(row).length) input('Provide at least one explicit draft change.');
  if (row.nullcast !== undefined && typeof row.nullcast !== 'boolean') input('nullcast must be a boolean.');
  if (row.name !== undefined && !text(row.name, 80, true)) input('Draft names use at most 80 characters.');
  // X owns weighted Tweet length and URL handling. This is a local payload bound,
  // not a claim that 8192 characters can be published as a Tweet.
  if (row.text !== undefined && !text(row.text, 8192, true))
    input('Draft text exceeds the local bound or contains invalid control/surrogate characters.');
  if (
    row.card_uri !== undefined &&
    (typeof row.card_uri !== 'string' || (row.card_uri !== '' && !cardUri.test(row.card_uri)))
  )
    input('Use a discovered card URI or an explicit empty string to clear it.');
  const media = row.media_keys === undefined ? [] : mediaInput(row.media_keys);
  if (row.card_uri && media.length)
    input('Combined card and direct media attachments require a separately qualified format.');
  if (kind === 'create' && !row.text?.trim() && !media.length)
    input('Creation requires text or registered media. A card alone does not supply Tweet text.');
}
function view(value: unknown, expectedId?: string): JsonObject {
  if (
    !object(value) ||
    typeof value.id !== 'string' ||
    !snowflake.test(value.id) ||
    (expectedId && value.id !== expectedId) ||
    typeof value.user_id !== 'string' ||
    !snowflake.test(value.user_id) ||
    typeof value.nullcast !== 'boolean' ||
    !text(value.text, 8192, true) ||
    value.deleted === true ||
    (value.status !== undefined && value.status !== 'DRAFT') ||
    value.error !== undefined ||
    value.errors !== undefined
  )
    fail('X did not return an exact, complete unpublished draft.');
  const row = {...(value as JsonObject)};
  row.name ??= null;
  row.card_uri ??= null;
  row.media_keys ??= [];
  if (
    (row.name !== null && !text(row.name, 80, true)) ||
    (row.card_uri !== null && !cardUri.test(row.card_uri)) ||
    !Array.isArray(row.media_keys) ||
    row.media_keys.length > 4 ||
    row.media_keys.some((k: unknown) => typeof k !== 'string' || !mediaKey.test(k)) ||
    new Set(row.media_keys).size !== row.media_keys.length
  )
    fail('X returned malformed draft attachments.');
  return normalizeReviewState(row, xReviewVolatile) as JsonObject;
}
function desired(p: CompiledRequest, before?: JsonObject): JsonObject {
  const b = (p.body ?? {}) as JsonObject,
    base: JsonObject = before
      ? {...before}
      : {user_id: b.as_user_id, nullcast: b.nullcast, name: null, card_uri: null, text: '', media_keys: []};
  for (const k of ['name', 'text', 'nullcast']) if (Object.hasOwn(b, k)) base[k] = b[k];
  if (Object.hasOwn(b, 'card_uri')) base.card_uri = b.card_uri || null;
  if (Object.hasOwn(b, 'media_keys')) base.media_keys = mediaInput(b.media_keys);
  if (!base.text?.trim() && !base.media_keys.length) input('The resulting draft needs text or registered media.');
  if (base.card_uri && base.media_keys.length)
    input('Clear the old attachment before changing between card and direct media formats.');
  return base;
}
function bounded(p: CompiledRequest, send: Read) {
  let count = 0,
    bytes = 0;
  const started = performance.now();
  return xReader(p, async read => {
    if (++count > 64 || performance.now() - started > 60000)
      fail('Draft checks exceeded their read or monotonic deadline bound.', 'X_DRAFT_DISCOVERY_LIMIT');
    const r = await send(read),
      size = Buffer.byteLength(JSON.stringify(r.data) ?? '');
    bytes += size;
    if (size > 4 * 1024 * 1024 || bytes > 8 * 1024 * 1024 || performance.now() - started > 60000)
      fail('Draft checks exceeded their response or deadline bound.', 'X_DRAFT_DISCOVERY_LIMIT');
    if (
      object(r.data) &&
      Object.keys(r.data).some(k => !['data', 'request', 'next_cursor', 'total_count', 'errors', 'error'].includes(k))
    )
      fail('X returned an unknown draft-read envelope; completeness cannot be established.');
    return r;
  });
}
async function author(read: ReturnType<typeof xReader>, user: string) {
  const rows = await read.list('/promotable_users');
  if (
    rows.length > 100 ||
    rows.some(r => typeof r.user_id !== 'string' || !snowflake.test(r.user_id)) ||
    new Set(rows.map(r => r.user_id)).size !== rows.length
  )
    fail('Promotable-user discovery is incomplete or ambiguous.');
  const selected = rows.filter(r => r.user_id === user);
  if (selected.length !== 1 || selected[0]!.promotable_user_type !== 'FULL')
    fail('The draft author must currently be a FULL promotable user of this account.');
  return normalizeReviewState(selected[0], xReviewVolatile) as JsonObject;
}
async function drafts(read: ReturnType<typeof xReader>, user: string) {
  const rows = await read.list('/draft_tweets', {user_id: user, count: 200});
  if (rows.length > 1000) fail('The selected author has more than 1000 drafts.', 'X_DRAFT_DISCOVERY_LIMIT');
  const seen = new Set<string>();
  return rows.map(row => {
    const v = view(row);
    if (v.user_id !== user || seen.has(v.id))
      fail('The author draft collection contains foreign or duplicate identities.');
    seen.add(v.id);
    return v;
  });
}
async function attachments(read: ReturnType<typeof xReader>, value: JsonObject) {
  const out: JsonObject = {media: []};
  if (value.card_uri) {
    const rows = await read.list('/cards/all', {card_uris: value.card_uri});
    if (rows.length !== 1 || rows[0]!.card_uri !== value.card_uri || rows[0]!.deleted !== false)
      fail('The exact card is unavailable in this account.');
    out.card = normalizeReviewState(rows[0], xReviewVolatile);
  }
  for (const key of value.media_keys) {
    const row = await read.single('/media_library/' + key, key, 'media_key');
    if (
      row.deleted !== false ||
      row.media_status !== 'TRANSCODE_COMPLETED' ||
      !['IMAGE', 'GIF', 'VIDEO'].includes(row.media_type)
    )
      fail('The selected media is not available and fully processed in this account.');
    // Native signed playback URLs and whether the media was used are observations.
    // Content identity, metadata and unknown fields remain protected.
    const {media_url, poster_media_url, tweeted, ...configuration} = row;
    out.media.push(normalizeReviewState(configuration, xReviewVolatile));
  }
  if (out.media.length > 1 && out.media.some((r: JsonObject) => r.media_type !== 'IMAGE'))
    input('A draft supports up to four images, one GIF or one video; do not mix types.');
  return out;
}
export function xDraftSnapshots(p: CompiledRequest): CompiledRequest[] {
  return [
    xRead(p, ''),
    xRead(p, '/promotable_users'),
    ...(xDraftKind(p) === 'create'
      ? [xRead(p, '/draft_tweets', {user_id: (p.body as JsonObject).as_user_id, count: 200})]
      : [xRead(p, '/draft_tweets/' + id(p))]),
  ];
}
export async function readXDraftState(p: CompiledRequest, send: Read): Promise<unknown[]> {
  const kind = xDraftKind(p)!,
    read = bounded(p, send),
    account = await read.single('', p.accountId!),
    draft = kind === 'create' ? undefined : view(await read.single('/draft_tweets/' + id(p), id(p)), id(p)),
    user = draft?.user_id ?? (p.body as JsonObject).as_user_id;
  // The account is kept to its identity (R2.5 M1, the ACCOUNT role).
  const state: JsonObject = {account: xAccountState(account) as JsonObject, author: await author(read, user)};
  if (draft) state.draft = draft;
  if (kind === 'create') {
    state.existing_draft_ids = (await drafts(read, user)).map(r => r.id).sort();
    state.attachments = await attachments(read, desired(p));
  }
  if (kind === 'update') state.attachments = await attachments(read, desired(p, draft));
  // A preview must also be usable, not merely refer to a retained draft ID.
  if (kind === 'preview') state.attachments = await attachments(read, draft!);
  if (draft && stable(draft) !== stable(view(await read.single('/draft_tweets/' + id(p), id(p)), id(p))))
    fail('The draft changed during dependency checks.');
  if (stable(state.author) !== stable(await author(read, user)))
    fail('The draft author permission changed during dependency checks.');
  return [state];
}
function receipt(p: CompiledRequest, r: TransportResult, before: unknown[]): JsonObject | undefined {
  const kind = xDraftKind(p),
    d = r.data as JsonObject,
    s = before[0] as JsonObject;
  if (
    r.status < 200 ||
    r.status >= 300 ||
    !object(d) ||
    Object.keys(d).some(k => !['data', 'request', 'message', 'errors'].includes(k)) ||
    (d.errors !== undefined && (!Array.isArray(d.errors) || d.errors.length))
  )
    return;
  if (d.request?.params?.account_id !== undefined && d.request.params.account_id !== p.accountId) return;
  if (kind === 'preview')
    return text(d.message, 1024) &&
      d.request?.params?.account_id === p.accountId &&
      d.request.params.draft_tweet_id === id(p) &&
      d.data === undefined
      ? {accepted: true}
      : undefined;
  if (
    !object(d.data) ||
    (d.data.account_id !== undefined && d.data.account_id !== p.accountId) ||
    d.data.user_id !== s.author.user_id
  )
    return;
  if (kind === 'delete') return d.data.id === id(p) && d.data.status === 'DELETED' ? d.data : undefined;
  try {
    const row = view(d.data, kind === 'create' ? undefined : id(p));
    if (kind === 'create' && s.existing_draft_ids.includes(row.id)) return;
    return row;
  } catch {
    return;
  }
}
export const xDraftOutcome = (p: CompiledRequest, r: TransportResult, before: unknown[]) => !!receipt(p, r, before);
export async function verifyXDraft(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
  send: Read,
): Promise<{status: string; checks: JsonObject[]}> {
  const kind = xDraftKind(p),
    s = before[0] as JsonObject,
    read = bounded(p, send);
  await read.single('', p.accountId!);
  await author(read, s.author.user_id);
  if (kind === 'preview')
    return {
      status: 'verified',
      checks: [
        {
          status: 'verified',
          verification_scope: 'provider_acceptance_only',
          notification_delivery: 'unverified',
          message:
            'The retained receipt confirms provider acceptance. Device notification delivery and rendering cannot be read back; never resend automatically.',
        },
      ],
    };
  let actual: unknown, expected: unknown;
  const resourceId = kind === 'create' ? result.data.data.id : id(p);
  if (kind === 'delete') {
    const rows = await drafts(read, s.author.user_id);
    expected = {present: false};
    actual = {present: rows.some(row => row.id === resourceId)};
  } else {
    const row = view(await read.single('/draft_tweets/' + resourceId, resourceId), resourceId);
    if (row.user_id !== s.author.user_id) fail('The draft read-back changed author.');
    const desiredState = desired(p, s.draft);
    expected = Object.fromEntries(
      ['user_id', 'nullcast', 'name', 'card_uri', 'text', 'media_keys'].map(k => [k, desiredState[k]]),
    );
    actual = Object.fromEntries(Object.keys(expected as JsonObject).map(k => [k, row[k]]));
  }
  const match = stable(expected) === stable(actual),
    changed = Object.keys(expected as JsonObject).filter(
      k => stable((expected as JsonObject)[k]) !== stable((actual as JsonObject)[k]),
    );
  return {
    status: match ? 'verified' : 'inconclusive',
    checks: [
      {
        resource_id: resourceId,
        status: match ? 'verified' : 'inconclusive',
        verification_scope: kind === 'delete' ? 'complete_author_collection_absence' : 'saved_draft_configuration',
        changed_fields: changed,
        expected_hash: sha256(stable(expected)),
        actual_hash: sha256(stable(actual)),
      },
    ],
  };
}
export function xDraftImpact(p: CompiledRequest) {
  return {
    provider: 'x',
    workflow: 'draft_tweet',
    may_affect_serving: false,
    publishes: false,
    notification:
      xDraftKind(p) === 'preview'
        ? 'Sends a preview notification to the authenticated user’s official X app devices. Execute only when the user requested this preview.'
        : 'none',
    effect:
      xDraftKind(p) === 'delete'
        ? 'Permanently removes the saved draft. It does not delete a previously published copy.'
        : 'Saves or inspects unpublished content. Publishing, scheduling and promotion are separate reviewed operations.',
    verification:
      xDraftKind(p) === 'preview'
        ? 'Provider acceptance only; notification delivery and rendering remain unverified.'
        : 'Exact account, current FULL author, native configuration or complete author-scoped absence after hard deletion.',
    recovery:
      'Retain the original review and idempotency key after uncertain outcomes. Never automatically recreate a draft or resend notifications.',
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const xDraftFamily: ReviewedFamily = defineFamily({
  name: 'x_drafts',
  files: ['src/x-draft-writes.ts', ['tests/x-draft-writes.test.ts']],
  kind: xDraftKind,
  assert: plan => assertXDraft(plan),
  snapshots: xDraftSnapshots,
  state: (plan, readers) =>
    readXDraftState(plan, readers.guarded('Creative dependency checks must be read-only.').read),
  impact: plan => xDraftImpact(plan),
  outcome: xDraftOutcome,
  verify: (plan, v) =>
    verifyXDraft(plan, v.result, v.state, v.guarded('Draft verification must remain read-only.')).then(o => ({
      status: o.status,
      checks: o.checks,
    })),
  exemptFromSpendTextMatch: true,
});
