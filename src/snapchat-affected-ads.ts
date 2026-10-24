import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {stateRead} from './write-snapshots.js';
import {readSnapchatAffectedAds} from './snapchat-affected-ad-pages.js';

/**
 * The ads a Snapchat creative edit changes (WRT-05 Stage C), read with the review's state read: the bounded read of the
 * account's ads collection moved to the leaf src/snapchat-affected-ad-pages.ts (ARC-01 wave 4c), where Snapchat's
 * adapter takes it with the review's builder; this module keeps its import path and signature.
 */
export {snapAffectedAdPages, snapAffectedAdsListed} from './snapchat-affected-ad-pages.js';
export function snapchatAffectedAds(
  plan: CompiledRequest,
  creativeIds: unknown[],
  read: (request: CompiledRequest) => Promise<TransportResult>,
): Promise<JsonObject> {
  return readSnapchatAffectedAds(plan, creativeIds, read, stateRead);
}
