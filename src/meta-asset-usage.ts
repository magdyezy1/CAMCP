import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {creativeAssetView} from './creative-library.js';
import {normalizeAccount} from './scope.js';
import {metaApiVersion, resolveMetaVersion} from './meta-version.js';
import {ReportCollectionBudget} from './report-collection-budget.js';

const gateway = 'meta_native_action';
const nativeId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,39}$/.test(value);
const hash = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x20\x7f]/.test(value);
const token = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x20\x7f]/.test(value);
const cursorContext = Buffer.from('amcp.meta-asset-usage.v1');
const seal = (value: JsonObject, key: string) => {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAAD(cursorContext);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
};
const open = (bytes: Buffer, key: string) => {
  if (bytes.length < 30 || bytes[0] !== 1) throw Error();
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), bytes.subarray(1, 13));
  decipher.setAAD(cursorContext);
  decipher.setAuthTag(bytes.subarray(13, 29));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8'));
};
const invalid = (message: string): never => bad(message, 'ASSET_USAGE_INVALID_RESPONSE');
const text = (value: unknown, limit = 2000) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > limit) invalid('Meta returned malformed native reference text.');
  return value as string;
};
const fields = [
  'id',
  'account_id',
  'name',
  'campaign_id',
  'adset_id',
  'configured_status',
  'status',
  'effective_status',
  'updated_time',
  'creative{id,account_id,image_hash,video_id}',
];
const assetSignature = (asset: JsonObject) =>
  fingerprint({
    asset_id: asset.asset_id,
    platform: asset.platform,
    account_id: asset.account_id,
    connection_id: asset.connection_id,
    media_type: asset.media_type,
    media_id: asset.media_id,
    sha256: asset.uploaded_sha256,
    metadata_revision: asset.metadata_revision,
  });

/** Current native scalar references only. No historical attribution, write eligibility or provider mutation. */
export async function metaAssetUsage(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  validate(input, ['action', 'asset_id', 'limit', 'cursor']);
  const asset = creativeAssetView(store, actor, input.asset_id),
    limit = input.limit ?? 50,
    version = metaApiVersion;
  if (asset.platform !== 'meta' || !['image', 'video'].includes(asset.media_type) || version !== 'v26.0')
    bad(
      'Current native usage is qualified only for Meta v26 image or video upload receipts.',
      'ASSET_USAGE_UNQUALIFIED',
    );
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) bad('Native reference pages contain 1–100 ads.');
  if (
    !(asset.media_type === 'image' ? hash(asset.media_id) : nativeId(asset.media_id)) ||
    typeof asset.uploaded_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(asset.uploaded_sha256)
  )
    bad('Retain an exact native image hash or video ID and the original uploaded SHA-256.', 'ASSET_USAGE_UNQUALIFIED');
  const account = normalizeAccount(gateway, asset.account_id);
  if (!nativeId(account)) bad('Retain the exact original Meta upload account.', 'ASSET_SCOPE_REQUIRED');
  const connection = store.resolveConnection(actor, gateway, account, asset.connection_id),
    original = assetSignature(asset);
  const authority = (c: typeof connection) =>
    fingerprint({
      credentials: store.connectionCredentials(c),
      scopes: [...c.scopes].sort(),
      accounts: [...c.accounts].sort(),
      enabled: c.enabled,
    });
  const authorization = authority(connection),
    current = () => {
      store.assertActorActive(actor);
      if (resolveMetaVersion() !== version)
        bad('The Meta API version changed. Restart the native reference read.', 'ASSET_USAGE_CHANGED');
      const c = store.resolveConnection(actor, gateway, account, connection.id);
      if (!c.scopes.some(s => ['ads_read', 'ads_management'].includes(s)))
        bad('This login requires Meta advertising read permission.', 'INSUFFICIENT_SCOPE');
      if (authority(c) !== authorization)
        bad('The selected login changed. Restart the native reference read.', 'REAUTHORIZATION_REQUIRED');
      if (assetSignature(creativeAssetView(store, actor, input.asset_id)) !== original)
        bad('The original asset changed. Restart its native reference read.', 'ASSET_USAGE_CHANGED');
    };
  current();
  const binding = fingerprint({
    tenant: actor.tenantId,
    user: actor.userId,
    role: actor.role,
    session: store.sessionIdentity(actor) ?? null,
    account,
    connection: connection.id,
    version,
    asset: original,
    limit,
    authorization,
  });
  let after: string | undefined,
    page = 0,
    expires = Date.now() + 300000,
    previousIds: string[] = [],
    seen: string[] = [],
    previousBudget: JsonObject | undefined;
  if (input.cursor !== undefined) {
    try {
      if (typeof input.cursor !== 'string' || input.cursor.length > 24000 || !/^[A-Za-z0-9_-]+$/.test(input.cursor))
        throw Error();
      const decoded = Buffer.from(input.cursor, 'base64url');
      if (decoded.toString('base64url') !== input.cursor) throw Error();
      const c = open(decoded, authorization);
      if (!obj(c)) throw Error();
      if (
        c.version !== 1 ||
        c.binding !== binding ||
        !token(c.after) ||
        !Number.isSafeInteger(c.page) ||
        c.page < 1 ||
        c.page >= 100 ||
        !Number.isSafeInteger(c.expires_at) ||
        c.expires_at <= Date.now() ||
        c.expires_at > Date.now() + 300000 ||
        !Array.isArray(c.previous_ids) ||
        c.previous_ids.length > limit ||
        !c.previous_ids.every(nativeId) ||
        new Set(c.previous_ids).size !== c.previous_ids.length ||
        !Array.isArray(c.seen) ||
        c.seen.length !== c.page ||
        !c.seen.every((s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)) ||
        new Set(c.seen).size !== c.seen.length ||
        c.seen.at(-1) !== fingerprint(c.after) ||
        !obj(c.collection)
      )
        throw Error();
      after = c.after;
      page = c.page;
      expires = c.expires_at;
      previousIds = c.previous_ids;
      seen = c.seen;
      previousBudget = c.collection;
    } catch {
      bad(
        'Restart this original asset, identity, login and page size; the native reference cursor is invalid or expired.',
        'INVALID_CURSOR',
      );
    }
  }
  let counters: JsonObject = {};
  const bound = new ReportCollectionBudget(
      previousBudget,
      binding,
      state => {
        counters = state;
      },
      {
        requests: Math.min(600, (previousBudget?.requests ?? 0) + 9),
        rows: Math.min(10000, (previousBudget?.rows ?? 0) + limit),
        bytes: Math.min(16 * 1024 * 1024, (previousBudget?.bytes ?? 0) + 384 * 1024),
        elapsed_ms: Math.min(120000, (previousBudget?.elapsed_ms ?? 0) + 30000),
      },
    ),
    references: JsonObject[] = [];
  const read = async (action: string, query: JsonObject) => {
    current();
    const args = {
        action,
        account_id: account,
        connection_id: connection.id,
        path_params: {ad_account_id: account},
        query,
        aggregate_pages: false,
        dry_run: false,
      },
      requested_at = Date.now();
    const out = await call(gateway, args, actor);
    current();
    if (!out.success)
      bad(
        out.error?.message ?? 'Meta native references could not be read.',
        out.error?.code ?? 'ASSET_USAGE_UNAVAILABLE',
      );
    if (
      out.data?.truncated ||
      !obj(out.data?.data) ||
      Buffer.byteLength(JSON.stringify(out.data.data)) > (action === 'meta_ad_account_id_get' ? 65536 : 262144)
    )
      invalid('Meta returned incomplete or oversized native reference evidence.');
    const {after: omitted, ...visibleQuery} = query;
    references.push({
      source_request: {...args, query: visibleQuery},
      api_version: version,
      continuation_present: omitted !== undefined,
      request_hash: fingerprint(args),
      source_hash: fingerprint(out.data.data),
      requested_at,
      received_at: Date.now(),
    });
    return out.data.data as JsonObject;
  };
  const accountCheck = async () => {
    const row = await read('meta_ad_account_id_get', {fields: 'id,account_id'});
    if (row.id !== 'act_' + account || (row.account_id !== undefined && row.account_id !== account))
      invalid('Meta returned a different native upload account.');
    return fingerprint({id: row.id, account_id: row.account_id ?? account});
  };
  try {
    const result = await bound.run(async () => {
      const firstAccount = await accountCheck(),
        body = await read('meta_ad_account_id_ads_get', {fields: fields.join(','), limit, ...(after ? {after} : {})});
      if (!Array.isArray(body.data) || body.data.length > limit)
        invalid('Meta did not return a bounded native ad page.');
      bound.rows('ads/' + page, body.data.length);
      const ids = new Set<string>(),
        rows: JsonObject[] = [];
      let unresolved = 0;
      for (const row of body.data) {
        if (
          !obj(row) ||
          !nativeId(row.id) ||
          ids.has(row.id) ||
          previousIds.includes(row.id) ||
          row.account_id !== account ||
          !nativeId(row.campaign_id) ||
          !nativeId(row.adset_id)
        )
          invalid('Meta returned a foreign, repeated or inexact native ad reference.');
        ids.add(row.id);
        const name = text(row.name),
          configured = text(row.configured_status ?? row.status, 100),
          effective = text(row.effective_status, 100),
          updated = text(row.updated_time, 100),
          creative = row.creative;
        if (creative != null && !obj(creative)) invalid('Meta returned a malformed native creative reference.');
        if (
          creative &&
          (!nativeId(creative.id) ||
            (creative.account_id !== undefined && creative.account_id !== account) ||
            (creative.image_hash != null && !hash(creative.image_hash)) ||
            (creative.video_id != null && !nativeId(creative.video_id)))
        )
          invalid('Meta returned a foreign or inexact native creative identity.');
        const field = asset.media_type === 'image' ? 'image_hash' : 'video_id',
          value = creative?.[field];
        if (!creative || creative.account_id !== account || value == null) {
          unresolved++;
          continue;
        }
        if (value !== asset.media_id) continue;
        rows.push({
          ad_id: row.id,
          name: name ?? row.id,
          campaign_id: row.campaign_id,
          adset_id: row.adset_id,
          creative_id: creative.id,
          match_field: field,
          media_id: value,
          configured_status: configured,
          effective_status: effective,
          native_updated_time: updated,
        });
      }
      if (body.paging !== undefined && !obj(body.paging)) invalid('Meta returned malformed native reference paging.');
      const paging = body.paging ?? {};
      if (
        (paging.cursors !== undefined && !obj(paging.cursors)) ||
        (paging.next !== undefined && (typeof paging.next !== 'string' || !paging.next || paging.next.length > 16000))
      )
        invalid('Meta returned malformed native reference paging.');
      const more = paging.next !== undefined,
        next = paging.cursors?.after;
      if (more && (!token(next) || seen.includes(fingerprint(next)) || page + 1 >= 100))
        invalid(
          'Meta continuation is missing, repeated or exceeds 100 native reference pages. Restart or narrow the view.',
        );
      if ((await accountCheck()) !== firstAccount)
        invalid('The native upload account changed during observation. Restart this view.');
      current();
      return {
        record_kind: 'native_asset_references',
        asset_id: asset.asset_id,
        platform: asset.platform,
        account_id: account,
        connection_id: connection.id,
        media_type: asset.media_type,
        media_id: asset.media_id,
        api_version: version,
        rows,
        examined_ads: body.data.length,
        unresolved_ads: unresolved,
        has_more: more,
        after: next,
        examined_ids: [...ids],
        page_number: page + 1,
        page_size: limit,
        captured_at: Date.now(),
        source_references: references,
        meaning:
          'Current scalar Meta creative image-hash or video-ID references in the original upload account. Missing and unsupported formats remain unknown. Configured and effective status do not prove delivery. This is not historical creative attribution or a point-in-time inventory; provider changes can move or repeat ads between pages. An empty matching page can still continue. This read grants no write authority.',
      };
    });
    bound.close();
    const {after: next, examined_ids: examinedIds, ...visible} = result;
    const continuation = {
      version: 1,
      binding,
      after: next,
      page: page + 1,
      expires_at: expires,
      previous_ids: examinedIds,
      seen: result.has_more ? [...seen, fingerprint(next)] : seen,
      collection: counters,
    };
    // Keep all examined IDs, including nonmatches, for the adjacent-page repeat guard; never expose provider bodies.
    // The collection cursor's counters bound this linear continuation. Replays are separately bounded reads.
    return {
      ...visible,
      collection: {
        requests: counters.requests,
        rows: counters.rows,
        bytes: counters.bytes,
        elapsed_ms: counters.elapsed_ms,
      },
      next_cursor: result.has_more ? seal(continuation, authorization) : null,
    };
  } catch (error) {
    bound.close();
    if ((error as {code?: string}).code === 'REPORT_COLLECTION_LIMIT')
      bad(
        'This native reference read reached its request, row, byte or time limit. Restart with a smaller page.',
        'ASSET_USAGE_LIMIT',
      );
    throw error;
  }
}
