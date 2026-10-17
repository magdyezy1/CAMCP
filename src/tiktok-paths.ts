/**
 * TikTok API for Business v1.3 routes that several modules name (ARC-04). A leaf: a module may read one while it is
 * evaluated, whichever module a process imports first. src/tiktok-saved-audiences.ts read the audience route from
 * src/tiktok-lookalikes.ts at load; the two are evaluated through the family registry's import cycle, so importing
 * the lookalike module (or src/verification-reads.ts) first failed with a ReferenceError.
 */
export const tiktokLookalikePath = '/v1.3/dmp/custom_audience/lookalike/create/',
  tiktokAudienceGetPath = '/v1.3/dmp/custom_audience/get/';
