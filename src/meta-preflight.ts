import type {CompiledRequest, JsonObject} from './types.js';
import type {CampaignPreflight} from './provider-adapter.js';
import {validateMetaCreative} from './meta-creative-features.js';
import {metaPrerequisites} from './meta-prerequisites.js';

// Meta's part of a campaign plan's preflight, its adapter's `campaign.preflight` (ARC-01 phase B, wave 4c: moved from
// src/campaign-preflight.ts, which keeps every check a step passes and their order).

/** A creative's own contract, and the step's Page and media read live before any predecessor is created. */
export const metaPreflight: CampaignPreflight = Object.freeze<CampaignPreflight>({
  async contract(plan: CompiledRequest) {
    if (plan.path.endsWith('/adcreatives')) validateMetaCreative(plan.body as JsonObject, plan.path);
    return undefined;
  },
  prerequisites: async (plan: CompiledRequest, {service, actor, connectionId}, refs: string[], declared: string[]) =>
    (await metaPrerequisites(service, actor, plan, connectionId, refs, declared)) ?? [],
});
