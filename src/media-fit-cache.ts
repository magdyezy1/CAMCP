import {MirrorError} from './errors.js';
import {mediaType} from './drive-media.js';
import {sha256, stable} from './security.js';
import {startMediaProcessorProbe} from './runtime-toolchain.js';
import type {Store} from './store.js';
import type {FitLimits, FittedMedia} from './media-fit.js';
import type {JsonObject} from './types.js';

/**
 * Fitted outputs cached across calls (MED-03 C). A push planned the fit of each original once per platform limit
 * group; every review of the push then repeated it, so one video sent to N accounts was converted about N+1 times and
 * each conversion held the shared media budget. `amcp_media plan` with `stage_fits: true` (the website's push opts in;
 * MCP callers' plans stage nothing by default) keeps each changed output as encrypted staging, and `prepare` with the
 * same original and limits uses it instead of converting again.
 *
 * A cached copy is bound to the exact original (its source id and SHA-256), the limits, this fit pipeline's version and
 * the FFmpeg build, so a build change can never make a planned row fail MEDIA_CHANGED or reuse another encoder's
 * output. It lapses at the original's own deadline (a retained original's copy after an hour), counts against the
 * original-file quota and gives way to any upload that needs the room; removing the original removes its copies.
 */
export const FIT_PIPELINE_VERSION = 'fit-2026-10-v1';
/** How long a copy of a retained original (which has no deadline) is kept; a temporary original's copy ends with it. */
export const FIT_CACHE_TTL_MS = 60 * 60000;

export interface FitSource {
  /** The exact original: `src-…` (an upload or import) or `lib-…` (a retained original). */
  id: string;
  sha256: string;
}
/** The encoder a copy is bound to: this pipeline's version and the FFmpeg build's validated version line. */
export async function fitEncoderVersion(): Promise<string> {
  let line = 'unavailable';
  try {
    line = (await startMediaProcessorProbe()).version;
  } catch {
    /* An unreadable build still yields a stable key; no conversion runs without FFmpeg anyway. */
  }
  return FIT_PIPELINE_VERSION + '|' + line;
}
export function fitCacheId(source: FitSource, limits: FitLimits, encoder: string): string {
  const key = sha256(
    stable({source_sha256: source.sha256, image_bytes: limits.imageBytes, mp4_only: limits.mp4Only, encoder}),
  );
  return 'fit-' + source.id + '-' + key.slice(0, 16);
}
const usable = (source: FitSource) =>
  /^(?:src|lib)-[0-9a-f-]{36}$/.test(source.id) && /^[0-9a-f]{64}$/.test(source.sha256);
/** What a cached copy says about itself, checked against the original it must come from; undefined when absent. */
async function entry(store: Store, tenant: string, source: FitSource, limits: FitLimits) {
  if (!usable(source)) return;
  const id = fitCacheId(source, limits, await fitEncoderVersion()),
    found = store.fitCache(tenant, id);
  if (
    !found ||
    found.metadata.source_id !== source.id ||
    found.metadata.source_sha256 !== source.sha256 ||
    found.metadata.image_bytes !== limits.imageBytes ||
    found.metadata.mp4_only !== limits.mp4Only
  )
    return;
  return {id, ...found};
}
/** The cached fitted copy of `source` for `limits`, read and verified byte for byte; undefined when there is none. */
export async function cachedFit(
  store: Store,
  tenant: string,
  source: FitSource,
  limits: FitLimits,
): Promise<FittedMedia | undefined> {
  const found = await entry(store, tenant, source, limits);
  if (!found) return;
  const bytes = store.stagedMedia(tenant, found.id),
    type = mediaType(bytes),
    m = found.metadata;
  if (sha256(bytes) !== m.sha256 || type.mime !== m.mime || !m.transform) return;
  return {bytes, ...type, width: m.width, height: m.height, transform: m.transform};
}
/** The facts of a cached copy (SHA-256, size, type) without reading its bytes, for a plan's preflight. */
export async function cachedFitFacts(
  store: Store,
  tenant: string,
  source: FitSource,
  limits: FitLimits,
): Promise<{sha256: string; size: number; mime: string; kind: 'image' | 'video'; expires_at: number} | undefined> {
  const found = await entry(store, tenant, source, limits);
  if (!found) return;
  const m = found.metadata;
  return {sha256: m.sha256, size: m.size, mime: m.mime, kind: m.kind, expires_at: found.expires_at};
}
/**
 * Keeps `fitted` as the cached copy of `source` for `limits` until `deadline` (the original's own staging expiry, or
 * an hour for a retained original), best effort: an output that did not change, a full quota, low storage or an
 * original already gone skip it and return false. Every later review still checks its expected SHA-256.
 */
export async function cacheFit(
  store: Store,
  tenant: string,
  source: FitSource,
  limits: FitLimits,
  fitted: FittedMedia,
  deadline?: number,
): Promise<boolean> {
  if (!fitted.transform || !usable(source)) return false;
  const now = Date.now(),
    expires = Math.min(now + FIT_CACHE_TTL_MS, deadline ?? Number.MAX_SAFE_INTEGER);
  if (expires <= now + 1000) return false;
  const encoder = await fitEncoderVersion(),
    id = fitCacheId(source, limits, encoder),
    metadata: JsonObject = {
      source_id: source.id,
      source_sha256: source.sha256,
      image_bytes: limits.imageBytes,
      mp4_only: limits.mp4Only,
      encoder,
      sha256: sha256(fitted.bytes),
      mime: fitted.mime,
      kind: fitted.kind,
      extension: fitted.extension,
      width: fitted.width,
      height: fitted.height,
      transform: fitted.transform as unknown as JsonObject,
      created_at: now,
    };
  try {
    store.stageFitCache(tenant, id, expires, metadata, fitted.bytes);
  } catch (e) {
    if (e instanceof MirrorError && ['MEDIA_STAGING_FULL', 'STORAGE_LOW', 'REVIEW_EXPIRED'].includes(e.code))
      return false;
    throw e;
  }
  store.noteMedia(tenant, 'fit_cache_writes');
  return true;
}
