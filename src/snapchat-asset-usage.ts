import type {Actor, CompiledRequest, JsonObject} from './types.js';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {NativeTransport} from './transport.js';
import type {CredentialProvider} from './auth.js';
import {creativeAssetView} from './creative-library.js';
import {bad, fingerprint, obj, validate} from './workspace-core.js';
import {nativeAuthority} from './native-authority.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {MirrorError} from './errors.js';

const gateway = 'snapchat_native_action';
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const success = (v: unknown) => typeof v === 'string' && v.toUpperCase() === 'SUCCESS';
const invalid = (message: string): never => bad(message, 'ASSET_USAGE_INVALID_RESPONSE');
const changed = (): never =>
  bad(
    'The original Snapchat asset, login or selected native references changed. Read the original asset again.',
    'ASSET_USAGE_CHANGED',
  );
const signature = (asset: JsonObject) =>
  fingerprint(
    Object.fromEntries(
      [
        'asset_id',
        'platform',
        'account_id',
        'connection_id',
        'media_type',
        'media_id',
        'uploaded_sha256',
        'metadata_revision',
      ].map(k => [k, asset[k]]),
    ),
  );
const word = (value: unknown): string | null => {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value))
    invalid('Snapchat returned malformed native creative type or status.');
  return value as string;
};
const name = (value: unknown, fallback: string): string => {
  if (value == null) return fallback;
  if (typeof value !== 'string' || [...value].length > 375 || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value))
    invalid('Snapchat returned malformed native creative names.');
  return value as string;
};
function nextCursor(body: JsonObject, path: string): string | undefined {
  if (body.paging === undefined) return undefined;
  if (!obj(body.paging) || Object.keys(body.paging).some(k => k !== 'next_link'))
    invalid('Snapchat returned unqualified native-reference paging metadata.');
  if (body.paging.next_link === undefined) return undefined;
  try {
    const link = body.paging.next_link;
    if (typeof link !== 'string' || !link || link.length > 8192 || /[\x00-\x20\x7f\\]/.test(link)) throw Error();
    const u = new URL(link),
      token = u.searchParams.get('cursor');
    if (
      u.origin !== 'https://adsapi.snapchat.com' ||
      u.username ||
      u.password ||
      u.hash ||
      u.pathname !== path ||
      [...u.searchParams.keys()].some(k => !['limit', 'cursor'].includes(k) || u.searchParams.getAll(k).length !== 1) ||
      (u.searchParams.has('limit') && u.searchParams.get('limit') !== '50') ||
      typeof token !== 'string' ||
      !token ||
      token.length > 4096 ||
      /[\x00-\x20\x7f]/.test(token)
    )
      throw Error();
    return token;
  } catch {
    return invalid('Snapchat continuation changed the original account, selected collection or fixed page settings.');
  }
}

/** Original-account GETs only. No standalone ownership grant, downloads, snapshot, ad joins or mutations. */
export async function snapchatAssetUsage(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  input: JsonObject,
) {
  validate(input, ['action', 'asset_id', 'limit', 'cursor', 'reference_view']);
  const asset = creativeAssetView(store, actor, input.asset_id),
    limit = input.limit ?? 50;
  if (input.reference_view !== undefined && input.reference_view !== 'snapchat_top_snap')
    bad('Choose the original Snapchat top-snap creative-reference view.', 'INVALID_ARGUMENT');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || input.cursor !== undefined)
    bad(
      'Choose a complete Snapchat creative-reference limit of 1–1000. This read has no native continuation.',
      'INVALID_ARGUMENT',
    );
  if (
    asset.platform !== 'snapchat' ||
    !['image', 'video'].includes(asset.media_type) ||
    !uuid(asset.account_id) ||
    !uuid(asset.media_id) ||
    typeof asset.uploaded_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(asset.uploaded_sha256)
  )
    bad(
      'Current Snapchat references require exact original account/media UUIDs, an image or video upload receipt and uploaded SHA-256.',
      'ASSET_USAGE_UNQUALIFIED',
    );
  const account = asset.account_id,
    original = signature(asset),
    requested_at = Date.now(),
    connection = store.resolveConnection(actor, gateway, account, asset.connection_id);
  if (!connection.scopes.includes('snapchat-marketing-api'))
    bad('This login requires Snapchat Marketing API permission for current creative references.', 'INSUFFICIENT_SCOPE');
  const auth = await credentials.get(connection),
    active = store.resolveConnection(actor, gateway, account, connection.id),
    login = fingerprint(store.connectionCredentials(active)),
    originalScopes = [...active.scopes];
  const current = () => {
    store.assertActorActive(actor);
    const c = store.resolveConnection(actor, gateway, account, active.id);
    if (!c.scopes.includes('snapchat-marketing-api') || originalScopes.some(s => !c.scopes.includes(s)))
      bad(
        'This login requires Snapchat Marketing API permission for current creative references.',
        'INSUFFICIENT_SCOPE',
      );
    if (fingerprint(store.connectionCredentials(c)) !== login)
      bad(
        'The Snapchat login changed during reference inspection. Restart with its current authorization.',
        'REAUTHORIZATION_REQUIRED',
      );
    if (signature(creativeAssetView(store, actor, input.asset_id)) !== original || Date.now() >= requested_at + 60000)
      changed();
  };
  let usage: JsonObject = {},
    closing = false;
  const references: JsonObject[] = [],
    budget = new ReportCollectionBudget(
      undefined,
      fingerprint({original, requested_at, limit}),
      state => {
        if (!closing) current();
        usage = state;
      },
      {requests: 84, rows: 4102, bytes: 8 * 1024 * 1024, elapsed_ms: 60000},
    );
  const accountPath = '/v1/adaccounts/' + account;
  const read = async (kind: 'adaccounts' | 'media' | 'creatives', pass: number, page: number, cursor?: string) => {
    current();
    const path = kind === 'adaccounts' ? accountPath : accountPath + '/' + kind,
      query = kind === 'adaccounts' ? {} : {limit: 50, ...(cursor ? {cursor} : {})},
      plan: CompiledRequest = {
        gateway,
        accountId: account,
        action: 'AMCP_SNAPCHAT_TOP_SNAP_REFERENCES',
        method: 'GET',
        path,
        query,
        headers: {},
        readOnly: true,
        destructive: false,
        requiresConfirmation: false,
        evidence: 'Original Snapchat media and creative top-snap reference observations',
        warnings: [],
      },
      authority = nativeAuthority(store, registry, actor, plan, active, auth, current);
    let response;
    try {
      response = await transport.request(plan, authority(), auth, undefined, {beforeAttempt: authority});
    } catch (error) {
      current();
      if (error instanceof MirrorError && error.code === 'REPORT_COLLECTION_LIMIT') throw error;
      bad(
        'Snapchat did not complete the current native-reference read. Inspect the current login and retry the original asset.',
        'ASSET_USAGE_READ_FAILED',
      );
    }
    authority();
    budget.check();
    const body = response.data as JsonObject;
    if (
      response.status !== 200 ||
      !obj(body) ||
      !success(body.request_status) ||
      Object.keys(body).some(k => !['request_status', 'request_id', 'paging', kind].includes(k)) ||
      !Array.isArray(body[kind]) ||
      body[kind].length > (kind === 'adaccounts' ? 1 : 50)
    )
      invalid('Snapchat did not return a complete successful bounded native-reference page.');
    const next = nextCursor(body, path),
      entityName = kind === 'adaccounts' ? 'adaccount' : kind === 'media' ? 'media' : 'creative';
    if (kind === 'adaccounts' && (next !== undefined || body[kind].length !== 1))
      invalid('Snapchat did not return one exact original upload account.');
    const rows = body[kind].map((wrapped: JsonObject) => {
      if (
        !obj(wrapped) ||
        !success(wrapped.sub_request_status) ||
        !obj(wrapped[entityName]) ||
        Object.keys(wrapped).some(k => !['sub_request_status', entityName].includes(k))
      )
        invalid('Snapchat returned failed or malformed native-reference entities.');
      const entity = wrapped[entityName];
      if (
        !uuid(entity.id) ||
        (kind === 'adaccounts' ? entity.id !== account : entity.ad_account_id !== account) ||
        entity.error !== undefined ||
        entity.errors !== undefined
      )
        invalid('Snapchat returned foreign or malformed original-account media or creative identities.');
      if (kind === 'adaccounts') return {id: entity.id};
      if (kind === 'media')
        return {
          id: entity.id,
          ad_account_id: entity.ad_account_id,
          type: word(entity.type),
          media_status: word(entity.media_status),
        };
      const mediaId = entity.top_snap_media_id;
      if (mediaId != null && !uuid(mediaId)) invalid('Snapchat returned a malformed scalar top-snap media reference.');
      return {
        creative_id: entity.id,
        ad_account_id: entity.ad_account_id,
        name: name(entity.name, entity.id),
        creative_type: word(entity.type),
        media_id: mediaId ?? null,
        packaging_status: word(entity.packaging_status),
        review_status: word(entity.review_status),
      };
    }) as JsonObject[];
    budget.rows(kind + ':' + pass + ':' + page, rows.length);
    references.push({
      resource: kind,
      pass,
      page,
      source_request: {
        method: 'GET',
        path,
        ...(kind !== 'adaccounts' ? {limit: 50} : {}),
        ...(cursor ? {cursor_hash: fingerprint(cursor)} : {}),
      },
      source_hash: fingerprint({rows, next_cursor_hash: next === undefined ? null : fingerprint(next)}),
      rows: rows.length,
      captured_at: Date.now(),
    });
    return {rows, next};
  };
  const collect = async (kind: 'media' | 'creatives', pass: number) => {
    const rows: JsonObject[] = [],
      ids = new Set<string>(),
      cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 1; page <= 40; page++) {
      const result = await read(kind, pass, page, cursor);
      for (const row of result.rows) {
        const id = (kind === 'media' ? row.id : row.creative_id).toLowerCase();
        if (ids.has(id))
          invalid('Snapchat returned repeated native media or creative identities across reference pages.');
        ids.add(id);
        rows.push(row);
      }
      if (rows.length > (kind === 'media' ? 1000 : limit))
        bad(
          'The Snapchat original-media search or complete creative collection exceeds its selected bounds. No partial references were returned.',
          'ASSET_USAGE_LIMIT',
        );
      if (kind === 'media') {
        const found = rows.find(row => row.id === asset.media_id);
        if (found) {
          if (found.type !== asset.media_type.toUpperCase())
            invalid('Snapchat returned a different original uploaded media type.');
          return [found];
        }
      } else if (result.next === undefined)
        return rows.sort((a, b) => (a.creative_id < b.creative_id ? -1 : a.creative_id > b.creative_id ? 1 : 0));
      if (result.next === undefined)
        bad(
          'The exact original Snapchat upload media was not found within the bounded account search.',
          'ASSET_USAGE_UNQUALIFIED',
        );
      if (cursors.has(result.next)) invalid('Snapchat returned a repeated native-reference continuation.');
      cursors.add(result.next);
      cursor = result.next;
    }
    return bad('Snapchat reference inspection reached its bounded page or request limit.', 'ASSET_USAGE_LIMIT');
  };
  try {
    return await budget.run(async () => {
      const firstAccount = (await read('adaccounts', 1, 1)).rows,
        firstMedia = await collect('media', 1),
        first = await collect('creatives', 1),
        second = await collect('creatives', 2),
        secondMedia = await collect('media', 2),
        secondAccount = (await read('adaccounts', 2, 1)).rows;
      current();
      if (
        fingerprint(firstAccount) !== fingerprint(secondAccount) ||
        fingerprint(firstMedia) !== fingerprint(secondMedia) ||
        fingerprint(first) !== fingerprint(second)
      )
        changed();
      const rows = first
        .filter(row => row.media_id === asset.media_id)
        .map(row => ({...row, match_field: 'creative.top_snap_media_id'}));
      return {
        record_kind: 'native_asset_references',
        platform: 'snapchat',
        asset_id: asset.asset_id,
        account_id: account,
        connection_id: active.id,
        media_id: asset.media_id,
        uploaded_sha256: asset.uploaded_sha256,
        api_version: 'v1',
        qualified_view: 'creative.top_snap_media_id',
        reference_view: 'snapchat_top_snap',
        complete: true,
        rows,
        native_media: firstMedia[0],
        examined_creatives: first.length,
        scalar_top_snap_creatives: first.filter(row => row.media_id !== null).length,
        unresolved_creatives: first.filter(row => row.media_id === null).length,
        other_top_snap_creatives: first.filter(row => row.media_id !== null && row.media_id !== asset.media_id).length,
        has_more: false,
        next_cursor: null,
        selected_limit: limit,
        requested_at,
        captured_at: Date.now(),
        source_hash: fingerprint({account: firstAccount, media: firstMedia, creatives: first}),
        source_references: references,
        collection: usage,
        provider_mutations: 0,
        saved_snapshot: false,
        meaning:
          'Current literal Snapchat creative top-snap media references in the original upload account. Both bounded creative collections and original media/account observations must match. Missing scalar references remain unresolved; nested images, icons, previews, dynamic templates, lead-form media and other associations are outside this view. Native packaging, review and media-processing statuses do not establish ad delivery, historical assignment, performance or reuse eligibility. Complete means the selected visible collection was observed twice, not an atomic inventory or complete all-format absence. This read grants no write authority.',
      };
    });
  } catch (error) {
    current();
    if (error instanceof MirrorError && error.code === 'REPORT_COLLECTION_LIMIT')
      bad('Snapchat reference inspection reached its bounded request, row, byte or time limit.', 'ASSET_USAGE_LIMIT');
    throw error;
  } finally {
    closing = true;
    budget.close();
  }
}
