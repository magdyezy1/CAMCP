import {createHash} from 'node:crypto';
import {MirrorError} from './errors.js';
import {MAX_MEDIA_BYTES} from './drive-media.js';
import type {Store} from './store.js';
import {
  deleteRetainedManifest,
  insertRetainedChunk,
  insertRetainedManifest,
  retainedChunks,
  retainedManifest,
  retainedManifests,
  stagedChunkCount,
} from './retained-media-repository.js';

export const retainedMediaId = /^lib-[0-9a-f-]{36}$/;
const chunkLimit = 4 * 1024 * 1024;
const maximumChunks = Math.ceil(MAX_MEDIA_BYTES / (1024 * 1024));
const digestPattern = /^[0-9a-f]{64}$/;
interface Manifest {
  chunks: number;
  size: number;
  sha256: string;
}
function valid(manifest: Manifest, size: number) {
  if (
    !manifest ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size < 1 ||
    manifest.size > MAX_MEDIA_BYTES ||
    manifest.size !== size ||
    !Number.isSafeInteger(manifest.chunks) ||
    manifest.chunks < 1 ||
    manifest.chunks > maximumChunks ||
    !digestPattern.test(manifest.sha256)
  )
    throw new MirrorError('MEDIA_LIBRARY_INVALID', 'The retained original has an invalid encrypted manifest.');
  return manifest;
}
/** Only encrypted manifests establish retained-byte accounting. Plain SQLite counters cannot reduce the quota. */
export function retainedMediaStats(store: Store, tenant?: string) {
  const rows = retainedManifests(store, tenant);
  if (rows.length > 50)
    throw new MirrorError('MEDIA_LIBRARY_INVALID', 'The retained-original count exceeds its storage ceiling.');
  let bytes = 0;
  for (const row of rows) {
    if (!retainedMediaId.test(row.id))
      throw new MirrorError('MEDIA_LIBRARY_INVALID', 'Invalid retained-original identity.');
    const manifest = valid(
      store.openValue<Manifest>(row.tenant_id, 'retained-media-manifest', row.id, row.secret),
      row.size_bytes,
    );
    bytes += manifest.size;
  }
  return {count: rows.length, bytes};
}

/** Durable copies use their own tables and authenticated identities; temporary staging expiry never changes. */
export class RetainedMedia {
  constructor(private store: Store) {}
  manifest(tenant: string, id: string) {
    if (!retainedMediaId.test(id))
      throw new MirrorError('MEDIA_LIBRARY_INVALID', 'Invalid retained-original identity.');
    const row = retainedManifest(this.store, tenant, id);
    if (!row)
      throw new MirrorError('MEDIA_SOURCE_NOT_FOUND', 'The retained original was removed or is unavailable.', {}, 404);
    return valid(this.store.openValue<Manifest>(tenant, 'retained-media-manifest', id, row.secret), row.size_bytes);
  }
  copy(
    tenant: string,
    source: string,
    id: string,
    expected: {size: number; sha256: string},
    validateHead: (head: Buffer) => void,
  ) {
    if (!retainedMediaId.test(id) || !/^src-[0-9a-f-]{36}$/.test(source))
      throw new MirrorError('MEDIA_LIBRARY_INVALID', 'Invalid original-file identity.');
    return this.store.transaction(() => {
      const original = this.store.stagedMediaManifest(tenant, source);
      if (
        original.size !== expected.size ||
        original.sha256 !== expected.sha256 ||
        !digestPattern.test(expected.sha256) ||
        !Number.isSafeInteger(expected.size) ||
        expected.size < 1 ||
        expected.size > MAX_MEDIA_BYTES
      )
        throw new MirrorError(
          'MEDIA_SOURCE_CHANGED',
          'The original file no longer matches the confirmed hash and size.',
        );
      this.store.assertRetainedMediaCapacity(tenant, expected.size);
      const hash = createHash('sha256');
      let bytes = 0,
        chunks = 0;
      const write = (part: Buffer) => {
        if (!part.length || part.length > chunkLimit || chunks >= maximumChunks || bytes + part.length > expected.size)
          throw new MirrorError('MEDIA_LIBRARY_INVALID', 'The original file has invalid bounded chunks.');
        if (chunks === 0) validateHead(part);
        const secret = this.store.sealMediaChunk(tenant, 'retained-media-chunk', id + '.' + chunks, part);
        insertRetainedChunk(this.store, tenant, id, chunks++, secret);
        hash.update(part);
        bytes += part.length;
      };
      if (original.bytes !== undefined) {
        if (typeof original.bytes !== 'string' || original.bytes.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4)
          throw new MirrorError('MEDIA_LIBRARY_INVALID', 'The legacy original exceeds its byte ceiling.');
        const legacy = Buffer.from(original.bytes, 'base64');
        for (let offset = 0; offset < legacy.length; offset += chunkLimit)
          write(legacy.subarray(offset, offset + chunkLimit));
      } else {
        if (!Number.isSafeInteger(original.chunks) || original.chunks < 1 || original.chunks > maximumChunks)
          throw new MirrorError('MEDIA_LIBRARY_INVALID', 'The original file has an invalid chunk count.');
        for (let index = 0; index < original.chunks; index++) write(this.store.stagedMediaChunk(tenant, source, index));
        if (stagedChunkCount(this.store, tenant, source) !== chunks)
          throw new MirrorError('MEDIA_LIBRARY_INVALID', 'The original file has unexpected extra chunks.');
      }
      const manifest = {chunks, size: bytes, sha256: hash.digest('hex')};
      if (bytes !== expected.size || manifest.sha256 !== expected.sha256)
        throw new MirrorError('MEDIA_SOURCE_CHANGED', 'The original file failed its exact integrity check.');
      // Expiry/removal during copying cannot turn missing staging into a durable success.
      const fresh = this.store.stagedMediaManifest(tenant, source);
      if (fresh.size !== original.size || fresh.sha256 !== original.sha256)
        throw new MirrorError('MEDIA_SOURCE_CHANGED', 'The original file changed during retention.');
      insertRetainedManifest(
        this.store,
        tenant,
        id,
        this.store.sealValue(tenant, 'retained-media-manifest', id, manifest),
        manifest.size,
      );
      return manifest;
    });
  }
  private walk(tenant: string, id: string, visit?: (part: Buffer, offset: number) => void) {
    const manifest = this.manifest(tenant, id),
      hash = createHash('sha256');
    let index = 0,
      bytes = 0;
    for (const row of retainedChunks(this.store, tenant, id)) {
      if (row.chunk_index !== index || index >= manifest.chunks)
        throw new MirrorError('MEDIA_LIBRARY_INVALID', 'Retained-original chunk order is invalid.');
      // Either chunk format (OPS-01): v2 raw BLOBs and v1 base64 text, each bounded before use.
      const part = this.store.openMediaChunk(
        tenant,
        'retained-media-chunk',
        id + '.' + index,
        row.secret,
        'MEDIA_LIBRARY_INVALID',
      );
      if (!part.length || part.length > chunkLimit || bytes + part.length > manifest.size)
        throw new MirrorError('MEDIA_LIBRARY_INVALID', 'Retained-original chunk sizes are invalid.');
      visit?.(part, bytes);
      hash.update(part);
      bytes += part.length;
      index++;
    }
    if (index !== manifest.chunks || bytes !== manifest.size || hash.digest('hex') !== manifest.sha256)
      throw new MirrorError('MEDIA_LIBRARY_INVALID', 'The retained original failed its exact integrity check.');
    return manifest;
  }
  verify(tenant: string, id: string) {
    return this.walk(tenant, id);
  }
  read(tenant: string, id: string) {
    const bytes = Buffer.alloc(this.manifest(tenant, id).size);
    this.walk(tenant, id, (part, offset) => part.copy(bytes, offset));
    return bytes;
  }
  /**
   * Removes the manifest first, which makes the copy unreadable at once; the store then erases its chunks one row per
   * statement, after the enclosing transaction commits (OPS-01).
   */
  remove(tenant: string, id: string) {
    deleteRetainedManifest(this.store, tenant, id);
    this.store.sweepMediaChunks();
  }
}
