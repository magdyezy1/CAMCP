import type {SQLInputValue} from 'node:sqlite';
import type {Store} from './store.js';
import type {JsonObject} from './types.js';

/**
 * The retained-original tables (`retained_media`, `retained_media_chunks`; src/retained-media.ts) in the store layer
 * (ARC-02), moved here verbatim. Manifests and chunks are sealed; these statements never open them.
 */
/** Up to 51 retained manifests (tenant, id, sealed manifest, size), of one workspace or of the deployment. */
export function retainedManifests(store: Store, tenant?: string): JsonObject[] {
  return (
    tenant === undefined
      ? store.sql().prepare('SELECT tenant_id,id,secret,size_bytes FROM retained_media LIMIT 51').all()
      : store
          .sql()
          .prepare('SELECT tenant_id,id,secret,size_bytes FROM retained_media WHERE tenant_id=? LIMIT 51')
          .all(tenant)
  ) as JsonObject[];
}
/** One retained original's sealed manifest and size, or undefined. */
export function retainedManifest(store: Store, tenant: string, id: string): JsonObject | undefined {
  return store
    .sql()
    .prepare('SELECT secret,size_bytes FROM retained_media WHERE tenant_id=? AND id=?')
    .get(tenant, id) as JsonObject | undefined;
}
/** Records one sealed chunk of a retained original. */
export function insertRetainedChunk(store: Store, tenant: string, id: string, index: number, secret: SQLInputValue) {
  store.sql().prepare('INSERT INTO retained_media_chunks VALUES(?,?,?,?)').run(tenant, id, index, secret);
}
/** How many staged chunks an uploaded original has. */
export function stagedChunkCount(store: Store, tenant: string, source: string): number {
  return (
    store.sql().prepare('SELECT count(*) AS n FROM media_chunks WHERE tenant_id=? AND id=?').get(tenant, source) as {
      n: number;
    }
  ).n;
}
/** Records a retained original's sealed manifest and size; its chunks are written first. */
export function insertRetainedManifest(store: Store, tenant: string, id: string, secret: string, size: number) {
  store.sql().prepare('INSERT INTO retained_media VALUES(?,?,?,?)').run(tenant, id, secret, size);
}
/** A retained original's sealed chunks in order (index, sealed chunk), read one at a time. */
export function retainedChunks(store: Store, tenant: string, id: string): Iterable<JsonObject> {
  return store
    .sql()
    .prepare('SELECT chunk_index,secret FROM retained_media_chunks WHERE tenant_id=? AND id=? ORDER BY chunk_index')
    .iterate(tenant, id) as Iterable<JsonObject>;
}
/** Deletes a retained original's manifest, which makes its chunks unreadable at once. */
export function deleteRetainedManifest(store: Store, tenant: string, id: string) {
  store.sql().prepare('DELETE FROM retained_media WHERE tenant_id=? AND id=?').run(tenant, id);
}
