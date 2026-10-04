import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {audit, bad, fingerprint, identifier, validate, writer} from './workspace-core.js';
import {mediaPlatforms} from './media-routing.js';
import {normalizeAccount} from './scope.js';
import {
  creativePerformance,
  linkedAdStep,
  linkedPerformanceSupported,
  linkedPlanAdIds,
} from './creative-performance.js';
import {retainedMediaId} from './retained-media.js';

// Select metadata in SQLite: never materialize upload requests, Drive URLs, provider responses or credentials.
const projection = `SELECT a.id, coalesce(m.revision,0) AS metadata_revision,
  json_object('platform',json_extract(a.data,'$.platform'),'account_id',json_extract(a.data,'$.account_id'),
    'connection_id',json_extract(a.data,'$.connection_id'),'provider_name',json_extract(a.data,'$.name'),
    'name',coalesce(json_extract(m.data,'$.name'),json_extract(a.data,'$.name')),
    'tags',json(coalesce(json_extract(m.data,'$.tags'),'[]')),
    'uploaded_sha256',json_extract(a.data,'$.sha256'),'media_id',json_extract(a.data,'$.media_id'),
    'media_type',json_extract(a.data,'$.media_type'),'mime_type',json_extract(a.data,'$.mime_type'),
    'size_bytes',json_extract(a.data,'$.size_bytes'),'processing_status',json_extract(a.data,'$.processing_status'),
    'last_checked_at',json_extract(a.data,'$.provider_availability_checked_at'),
    'created_at',coalesce(json_extract(r.data,'$.created_at'),json_extract(r.data,'$.expires_at')-300000),
    'source_kind',json_extract(a.data,'$.source'),
    'dimensions_before',json_extract(r.data,'$.plan.transform.from'),
    'dimensions_uploaded',json_extract(r.data,'$.plan.transform.to')) AS metadata,
  json_object('id',s.id,'user_id',json_extract(s.data,'$.user_id'),'expires_at',json_extract(s.data,'$.expires_at'),
    'state',json_extract(s.data,'$.state'),'sha256',json_extract(s.data,'$.sha256'),
    'storage_kind',s.kind,'retained',json_extract(s.data,'$.retained'),
    'retained_bytes',EXISTS(SELECT 1 FROM retained_media held WHERE held.tenant_id=s.tenant_id AND held.id=s.id)) AS source
  FROM documents a
  LEFT JOIN documents m ON m.tenant_id=a.tenant_id AND m.kind='creative_metadata' AND m.id=a.id
  LEFT JOIN documents r ON r.tenant_id=a.tenant_id AND r.kind='media_review' AND r.id=a.id
  LEFT JOIN documents s ON s.tenant_id=a.tenant_id AND s.kind IN ('media_source','retained_media_source') AND
    s.id=coalesce((SELECT saved.id FROM documents saved WHERE saved.tenant_id=a.tenant_id AND saved.kind='retained_media_source'
      AND saved.id=CASE WHEN substr(json_extract(r.data,'$.plan.origin.source_id'),1,4)='src-'
        THEN 'lib-'||substr(json_extract(r.data,'$.plan.origin.source_id'),5) ELSE json_extract(r.data,'$.plan.origin.source_id') END
      AND (saved.id=json_extract(r.data,'$.plan.origin.source_id') OR json_extract(saved.data,'$.original_source_id')=json_extract(r.data,'$.plan.origin.source_id'))),
      json_extract(r.data,'$.plan.origin.source_id'))
  WHERE a.tenant_id=? AND a.kind='workspace_asset'`;
const decode = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
function access(store: Store, actor: Actor, p: JsonObject) {
  if (
    !mediaPlatforms.includes(p.platform) ||
    typeof p.account_id !== 'string' ||
    !p.account_id ||
    typeof p.connection_id !== 'string' ||
    !p.connection_id
  )
    bad('This asset has no valid account binding.', 'ASSET_SCOPE_REQUIRED');
  store.resolveConnection(actor, p.platform + '_native_action', p.account_id, p.connection_id);
}
function view(row: JsonObject, actor: Actor) {
  const p = decode(row.metadata),
    s = decode(row.source);
  const retained =
    s.storage_kind === 'retained_media_source' &&
    retainedMediaId.test(s.id) &&
    s.retained === 1 &&
    s.expires_at === null &&
    s.retained_bytes === 1;
  const available = Boolean(
    s.id &&
    (s.user_id === actor.userId || actor.role === 'admin') &&
    (retained || (s.storage_kind === 'media_source' && s.expires_at > Date.now())) &&
    s.state === 'complete',
  );
  const googleImage =
    p.platform === 'google_ads' &&
    p.media_type === 'image' &&
    typeof p.account_id === 'string' &&
    /^\d{1,20}$/.test(normalizeAccount('google_ads_native_action', p.account_id)) &&
    typeof p.media_id === 'string' &&
    new RegExp(
      '^customers/' + normalizeAccount('google_ads_native_action', p.account_id) + '/assets/[1-9][0-9]{0,19}$',
    ).test(p.media_id) &&
    typeof p.uploaded_sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(p.uploaded_sha256);
  const snapchatMedia =
    p.platform === 'snapchat' &&
    ['image', 'video'].includes(p.media_type) &&
    [p.account_id, p.media_id].every(
      v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
    ) &&
    typeof p.uploaded_sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(p.uploaded_sha256);
  return {
    asset_id: row.id,
    ...p,
    metadata_revision: row.metadata_revision,
    source: available
      ? {
          available: true,
          source_id: s.id,
          original_sha256: s.sha256,
          expires_at: retained ? null : s.expires_at,
          retained,
        }
      : {available: false},
    availability: 'requires_fresh_check',
    linked_performance_supported: linkedPerformanceSupported(p.platform),
    native_usage_supported:
      googleImage || snapchatMedia || (p.platform === 'meta' && ['image', 'video'].includes(p.media_type)),
    native_usage_kind: googleImage
      ? 'google_image_links'
      : snapchatMedia
        ? 'snapchat_top_snap'
        : p.platform === 'meta'
          ? 'meta_scalar_references'
          : null,
    ...(googleImage ? {native_usage_views: ['ad_images', 'performance_max', 'performance_max_brand']} : {}),
    ...(snapchatMedia ? {native_usage_views: ['snapchat_top_snap']} : {}),
    reuse_call: {tool: 'amcp_media', arguments: {action: 'reuse', asset_id: row.id}},
    website_path: '/media?asset_id=' + encodeURIComponent(row.id),
  };
}
function binding(store: Store, actor: Actor, filters: JsonObject) {
  return fingerprint({
    tenant: actor.tenantId,
    user: actor.userId,
    role: actor.role,
    session: store.sessionIdentity(actor) ?? null,
    filters,
  });
}
function cursor(input: unknown, bound: string) {
  if (input === undefined) return '';
  try {
    if (typeof input !== 'string' || input.length > 1024) throw Error();
    const c = JSON.parse(Buffer.from(input, 'base64url').toString('utf8'));
    if (c.version !== 1 || c.binding !== bound) throw Error();
    return identifier(c.after);
  } catch {
    return bad('Refresh or use the continuation from this identity and exact filters.', 'INVALID_CURSOR');
  }
}
const continuation = (bound: string, after: string) =>
  Buffer.from(JSON.stringify({version: 1, binding: bound, after})).toString('base64url');
function assetRow(store: Store, actor: Actor, id: unknown) {
  const row = store.db.prepare(projection + ' AND a.id=?').get(actor.tenantId, identifier(id, 'asset_id')) as
    JsonObject | undefined;
  if (!row) throw new MirrorError('NOT_FOUND', 'Asset not found in this workspace.', {}, 404);
  access(store, actor, decode(row.metadata));
  return row;
}
function dimensions(value: any) {
  const d = decode(value);
  if (!d || typeof d !== 'object') return null;
  return Object.fromEntries(['width', 'height', 'bytes'].filter(k => Number.isFinite(d[k])).map(k => [k, d[k]]));
}
function safeView(row: JsonObject, actor: Actor) {
  const result = view(row, actor);
  result.dimensions_before = dimensions(result.dimensions_before);
  result.dimensions_uploaded = dimensions(result.dimensions_uploaded);
  return result;
}
/** Account-scoped metadata only; never load an original upload/review or provider response. */
export function creativeAssetView(store: Store, actor: Actor, id: unknown): JsonObject {
  store.assertActorActive(actor);
  return safeView(assetRow(store, actor, id), actor);
}
export function creativeLibrary(store: Store, actor: Actor, input: JsonObject): JsonObject {
  store.assertActorActive(actor);
  if (input.action === 'asset_performance') {
    const row = assetRow(store, actor, input.asset_id);
    return creativePerformance(store, actor, input, safeView(row, actor), () =>
      usage(store, actor, row.id, {plan_id: input.plan_id}, decode(row.metadata)),
    );
  }
  if (input.action === 'save_asset_metadata') {
    writer(store, actor);
    if (input.confirmed !== true)
      bad('Confirm saving this library name and tags. Provider media is unchanged.', 'CONFIRMATION_REQUIRED');
    validate(input.metadata, ['name', 'tags'], 4096, 'creative metadata');
    const {name, tags = []} = input.metadata;
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 160 ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      !Array.isArray(tags) ||
      tags.length > 20 ||
      tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 40 || /[\u0000-\u001f\u007f]/.test(t))
    )
      bad('Use a name up to 160 characters and at most 20 tags of 40 characters each.');
    if (!Number.isSafeInteger(input.revision) || input.revision < 0)
      bad('Supply the current metadata_revision, or 0 for new metadata.');
    return store.transaction(() => {
      const row = assetRow(store, actor, input.asset_id);
      if (row.metadata_revision !== input.revision)
        throw new MirrorError('REVISION_CONFLICT', 'Reload the asset before updating its metadata.', {}, 409);
      store.putDocument(actor.tenantId, 'creative_metadata', row.id, {
        name: name.trim(),
        tags: [...new Set(tags.map(t => t.trim().toLowerCase()))],
        updated_at: Date.now(),
        updated_by: actor.userId,
      });
      audit(store, actor, 'creative_metadata_saved', {asset_id: row.id, revision: input.revision + 1});
      return {...safeView(assetRow(store, actor, row.id), actor), network_requests: 0};
    });
  }
  if (input.action === 'asset') {
    const row = assetRow(store, actor, input.asset_id);
    return {...safeView(row, actor), ...usage(store, actor, row.id, input, decode(row.metadata)), network_requests: 0};
  }
  const limit = input.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) bad('Use a page size of 1–100.');
  for (const key of ['search', 'tag', 'platform', 'account_id', 'connection_id'])
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 200))
      bad('Use a short exact ' + key + '.');
  if (input.platform && !mediaPlatforms.includes(input.platform)) bad('Choose a supported media platform.');
  const filters = {
    search: (input.search ?? '').trim().toLowerCase(),
    tag: (input.tag ?? '').trim().toLowerCase(),
    platform: input.platform ?? '',
    account_id: input.account_id ?? '',
    connection_id: input.connection_id ?? '',
  };
  const bound = binding(store, actor, filters),
    after = cursor(input.cursor, bound);
  const rows = store.db
    .prepare(projection + ' AND a.id>? ORDER BY a.id LIMIT 501')
    .all(actor.tenantId, after) as JsonObject[];
  const assets: JsonObject[] = [];
  let last = after,
    more = false;
  for (let i = 0; i < rows.length; i++) {
    if (i === 500) {
      more = true;
      break;
    }
    const row = rows[i]!,
      p = decode(row.metadata);
    let permitted = true;
    try {
      access(store, actor, p);
    } catch (e) {
      if (!(e instanceof MirrorError)) throw e;
      permitted = false;
    }
    const match =
      permitted &&
      (!filters.platform || p.platform === filters.platform) &&
      (!filters.account_id || p.account_id === normalizeAccount(p.platform + '_native_action', filters.account_id)) &&
      (!filters.connection_id || p.connection_id === filters.connection_id) &&
      (!filters.tag || p.tags.includes(filters.tag)) &&
      (!filters.search ||
        [p.name, p.provider_name, p.media_id, row.id, ...p.tags].join(' ').toLowerCase().includes(filters.search));
    if (match && assets.length === limit) {
      more = true;
      break;
    }
    last = row.id;
    if (match) assets.push(safeView(row, actor));
  }
  store.assertActorActive(actor);
  return {
    assets,
    filters,
    has_more: more,
    next_cursor: more ? continuation(bound, last) : null,
    network_requests: 0,
    meaning:
      'Retained account-scoped upload metadata. Original files keep their existing expiry. Stored status is historical; reuse always requires a fresh provider check. Refresh to see metadata changes. Empty pages may have a continuation.',
  };
}

// A usage claim requires an exact retained review and an explicit result-reference path, never just a dependency.
const usageProjection = `SELECT d.id,json_extract(d.data,'$.user_id') AS user_id,json_extract(d.data,'$.name') AS name,
  (SELECT json_group_array(json_object('id',json_extract(s.value,'$.id'),'kind',json_extract(s.value,'$.kind'),
    'gateway',CASE WHEN json_extract(s.value,'$.kind')='media' THEN json_extract(s.value,'$.arguments.platform')||'_native_action' ELSE json_extract(s.value,'$.gateway') END,
    'account_id',json_extract(s.value,'$.account_id'),'connection_id',json_extract(s.value,'$.connection_id'),
    'review_id',json_extract(s.value,'$.review_id'),'status',json_extract(s.value,'$.status'),'action',json_extract(s.value,'$.arguments.action'),
    'references',(SELECT json_group_array(t.value) FROM json_tree(s.value,'$.arguments') t WHERE t.key='$ref' AND t.type='text'),
    'resources',(SELECT json_group_array(x.value) FROM json_tree(s.value) x WHERE x.type IN ('text','integer') AND
      ((x.key='created_id' AND x.path='$.result') OR (x.key='media_id' AND x.path='$.result') OR
       (x.key IN ('resource_id','id') AND (instr(replace(x.path,'"',''),'$.verification.verified_resources[')=1 OR instr(replace(x.path,'"',''),'$.result.verified_resources[')=1)) OR
       (x.key='resource_id' AND instr(x.path,'$.verification.checks[')=1)))))
    FROM json_each(d.data,'$.steps') s) AS steps
  FROM documents d WHERE d.tenant_id=? AND d.kind='campaign_run' AND d.id>?
    AND EXISTS(SELECT 1 FROM json_each(d.data,'$.steps') s WHERE json_extract(s.value,'$.kind')='media' AND json_extract(s.value,'$.review_id')=?)`;
function usage(store: Store, actor: Actor, assetId: string, input: JsonObject, asset: JsonObject) {
  const planId = input.plan_id === undefined ? undefined : identifier(input.plan_id, 'plan_id');
  const bound = binding(store, actor, {asset_id: assetId, view: 'usage', ...(planId ? {plan_id: planId} : {})}),
    after = cursor(input.cursor, bound);
  const rows = store.db
    .prepare(usageProjection + (planId ? ' AND d.id=?' : '') + ' ORDER BY d.id LIMIT 101')
    .all(actor.tenantId, after, assetId, ...(planId ? [planId] : [])) as JsonObject[];
  const result: JsonObject[] = [];
  let last = after,
    more = false;
  for (let index = 0; index < rows.length; index++) {
    if (index === 100) {
      more = true;
      break;
    }
    const row = rows[index]!,
      steps = decode(row.steps) as JsonObject[];
    if ((row.user_id !== actor.userId && actor.role !== 'admin') || !steps.length || steps.length > 50) {
      last = row.id;
      continue;
    }
    try {
      for (const s of steps) {
        if (!s.gateway || !s.account_id || !s.connection_id) bad('Incomplete plan binding.');
        store.resolveConnection(actor, s.gateway, s.account_id, s.connection_id);
      }
    } catch (e) {
      if (!(e instanceof MirrorError)) throw e;
      last = row.id;
      continue;
    }
    const linked = new Set<string>();
    for (let pass = 0; pass < steps.length; pass++)
      for (const s of steps) {
        const resources = decode(s.resources);
        if (
          ['verified', 'verified_with_acceptance'].includes(s.status) &&
          resources.length &&
          ((s.kind === 'media' && s.review_id === assetId) ||
            decode(s.references).some((r: string) => linked.has(r.split('#/')[0]!)))
        )
          linked.add(s.id);
      }
    if (!linked.size) {
      last = row.id;
      continue;
    }
    if (result.length === 20) {
      more = true;
      break;
    }
    last = row.id;
    const shown = steps
      .filter(s => linked.has(s.id))
      .map(s => ({
        step_id: s.id,
        status: s.status,
        resource_ids: [
          ...new Set(
            decode(s.resources)
              .filter((id: unknown) => typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id)))
              .map(String),
          ),
        ],
        gateway: s.gateway,
        account_id: s.account_id,
        connection_id: s.connection_id,
        entity_type: linkedAdStep(s.gateway, s.action) ? 'ad' : 'other',
      }));
    result.push({
      plan_id: row.id,
      name: row.name,
      website_path: '/campaigns?id=' + encodeURIComponent(row.id),
      steps: shown,
      linked_performance_available: linkedPlanAdIds(asset, shown).length > 0,
    });
  }
  return {
    usage: result,
    usage_has_more: more,
    next_cursor: more ? continuation(bound, last) : null,
    usage_evidence: 'retained_verified_plan_references',
    external_usage: 'unknown',
    performance: 'not_joined',
  };
}
