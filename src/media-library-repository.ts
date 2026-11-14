import type {Store} from './store.js';
import type {JsonObject} from './types.js';

/**
 * The creative library's projections (src/creative-library.ts) in the store layer (ARC-02), moved here verbatim:
 * workspace assets with their metadata, review and original file, and the campaign plans that used an asset.
 */
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
    'original_sha256',coalesce(json_extract(a.data,'$.original_sha256'),json_extract(r.data,'$.plan.origin.original_sha256')),
    'variant_preset',json_extract(r.data,'$.plan.origin.variant.preset'),
    'dimensions_before',json_extract(r.data,'$.plan.transform.from'),
    'dimensions_uploaded',json_extract(r.data,'$.plan.transform.to')) AS metadata,
  json_object('id',s.id,'user_id',json_extract(s.data,'$.user_id'),'principal',json_extract(s.data,'$.principal'),'expires_at',json_extract(s.data,'$.expires_at'),
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
/** One asset's row (metadata and source JSON text), or undefined. */
export function libraryAsset(store: Store, tenant: string, id: string): JsonObject | undefined {
  return store
    .sql()
    .prepare(projection + ' AND a.id=?')
    .get(tenant, id) as JsonObject | undefined;
}
/** Up to 501 asset rows after the id `after`, by id. */
export function libraryAssetPage(store: Store, tenant: string, after: string): JsonObject[] {
  return store
    .sql()
    .prepare(projection + ' AND a.id>? ORDER BY a.id LIMIT 501')
    .all(tenant, after) as JsonObject[];
}

// A usage claim requires an exact retained review and an explicit result-reference path, never just a dependency.
// The two inner subqueries are wrapped in json(): SQLite 3.54 does not keep a scalar subquery's JSON subtype, so without it
// json_object would quote each array as a string. The outer subquery is a result column, which the reader parses.
const usageProjection = `SELECT d.id,json_extract(d.data,'$.user_id') AS user_id,json_extract(d.data,'$.principal') AS principal,json_extract(d.data,'$.name') AS name,
  (SELECT json_group_array(json_object('id',json_extract(s.value,'$.id'),'kind',json_extract(s.value,'$.kind'),
    'gateway',CASE WHEN json_extract(s.value,'$.kind')='media' THEN json_extract(s.value,'$.arguments.platform')||'_native_action' ELSE json_extract(s.value,'$.gateway') END,
    'account_id',json_extract(s.value,'$.account_id'),'connection_id',json_extract(s.value,'$.connection_id'),
    'review_id',json_extract(s.value,'$.review_id'),'status',json_extract(s.value,'$.status'),'action',json_extract(s.value,'$.arguments.action'),
    'references',json((SELECT json_group_array(t.value) FROM json_tree(s.value,'$.arguments') t WHERE t.key='$ref' AND t.type='text')),
    'resources',json((SELECT json_group_array(x.value) FROM json_tree(s.value) x WHERE x.type IN ('text','integer') AND
      ((x.key='created_id' AND x.path='$.result') OR (x.key='media_id' AND x.path='$.result') OR
       (x.key IN ('resource_id','id') AND (instr(replace(x.path,'"',''),'$.verification.verified_resources[')=1 OR instr(replace(x.path,'"',''),'$.result.verified_resources[')=1)) OR
       (x.key='resource_id' AND instr(x.path,'$.verification.checks[')=1))))))
    FROM json_each(d.data,'$.steps') s) AS steps
  FROM documents d WHERE d.tenant_id=? AND d.kind='campaign_run' AND d.id>?
    AND EXISTS(SELECT 1 FROM json_each(d.data,'$.steps') s WHERE json_extract(s.value,'$.kind')='media' AND json_extract(s.value,'$.review_id')=?)`;
/** Up to 101 campaign plans after the id `after` whose media step used the review `assetId`, optionally one plan. */
export function assetUsage(
  store: Store,
  tenant: string,
  after: string,
  assetId: string,
  planId: string | undefined,
): JsonObject[] {
  return store
    .sql()
    .prepare(usageProjection + (planId ? ' AND d.id=?' : '') + ' ORDER BY d.id LIMIT 101')
    .all(tenant, after, assetId, ...(planId ? [planId] : [])) as JsonObject[];
}
