import type {DatabaseSync} from 'node:sqlite';
import {sealedBytesOverhead} from './security.js';

/**
 * Encrypted media storage bounds (OPS-01). Media bytes are kept in SQLite as 4 MiB encrypted chunks. Format v2 stores
 * each chunk as one raw BLOB (format byte, IV, tag, ciphertext), so stored size stays within about 0.001% of the raw
 * file. Format v1 (JSON with base64 inside AES-GCM, then base64 text: about 1.78 times the raw file) stays readable,
 * and `AMCP_MEDIA_CHUNK_FORMAT=v1` keeps writing it for one release so a rollback can still read new uploads.
 */
export const MEDIA_CHUNK_BYTES = 4 * 1024 * 1024;
/** SQLite truncates a larger write-ahead log back to this size after each checkpoint. */
export const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
export type MediaChunkFormat = 'v1' | 'v2';
export function mediaChunkFormat(raw = process.env.AMCP_MEDIA_CHUNK_FORMAT): MediaChunkFormat {
  return raw === 'v1' ? 'v1' : 'v2';
}
const base64Length = (bytes: number) => 4 * Math.ceil(bytes / 3);
/** The stored size of one chunk of `bytes` raw bytes in the given format. */
export function encodedChunkBytes(bytes: number, format: MediaChunkFormat): number {
  if (format === 'v2') return bytes + sealedBytesOverhead;
  // JSON {"bytes":"<base64>"}, sealed by AES-GCM, then iv.tag.body each in base64.
  const plaintext = base64Length(bytes) + '{"bytes":""}'.length;
  return base64Length(12) + 1 + base64Length(16) + 1 + base64Length(plaintext);
}
/** The stored size of a file of `raw` bytes, chunked as staging stores it. */
export function encodedMediaBytes(raw: number, format: MediaChunkFormat = mediaChunkFormat()): number {
  if (!Number.isSafeInteger(raw) || raw <= 0) return 0;
  const full = Math.floor(raw / MEDIA_CHUNK_BYTES),
    rest = raw % MEDIA_CHUNK_BYTES;
  return full * encodedChunkBytes(MEDIA_CHUNK_BYTES, format) + (rest ? encodedChunkBytes(rest, format) : 0);
}
const mib = 1024 * 1024,
  gib = 1024 * mib;
/**
 * Free space that must remain after admitting new media: `AMCP_STORAGE_FLOOR_MB` when it is set to an integer from 0
 * to 65536, otherwise the larger of 256 MiB and 10% of the volume, the percentage capped at 1 GiB so a large host disk
 * does not demand an unrelated amount of space.
 */
export function storageFloorBytes(totalBytes: number, raw = process.env.AMCP_STORAGE_FLOOR_MB): number {
  if (raw !== undefined && /^\d{1,5}$/.test(raw) && Number(raw) <= 65536) return Number(raw) * mib;
  return Math.max(256 * mib, Math.floor(Math.min(Math.max(0, totalBytes) * 0.1, gib)));
}
/** Free bytes required before admitting `rawBytes` more media: twice its stored size plus the floor. */
export function storageAdmissionRequirement(
  rawBytes: number,
  totalBytes: number,
  format: MediaChunkFormat = mediaChunkFormat(),
): number {
  return 2 * encodedMediaBytes(rawBytes, format) + storageFloorBytes(totalBytes);
}
/**
 * Deletes rows one statement at a time: `select` names one row's rowid (as `r`) per call with `parameters`. Outside an
 * explicit transaction each delete commits on its own, so secure deletion of a large file needs a write-ahead log
 * of about one row rather than the whole file. Returns the number of rows removed.
 */
export function deleteRowsOneByOne(db: DatabaseSync, table: string, select: string, ...parameters: string[]): number {
  const next = db.prepare(select),
    remove = db.prepare('DELETE FROM ' + table + ' WHERE rowid=?');
  let removed = 0,
    previous: number | bigint | undefined;
  for (;;) {
    const row = next.get(...parameters) as {r?: number | bigint} | undefined;
    if (row?.r === undefined) return removed;
    const changes = Number(remove.run(row.r).changes);
    // A row that cannot be removed must not turn maintenance into an endless loop.
    if (!changes && row.r === previous) return removed;
    removed += changes;
    previous = row.r;
  }
}
