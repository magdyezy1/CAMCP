import type {ProviderRemedy} from './provider-remedies.js';

/**
 * The remedies Snapchat declares for its own refusals (ARC-04 stage C). errorRemedy (src/errors.ts) consults every
 * provider’s table (src/provider-remedies.ts) before its shared rules. A leaf: nothing is imported at load.
 */
export const snapchatRemedies: readonly ProviderRemedy[] = [
  // A pixel or audience segment the selected ad account cannot use.
  {
    codes: ['SNAPCHAT_PIXEL_NOT_OWNED'],
    remedy: {
      category: 'grant',
      owner: 'provider_or_account_admin',
      action:
        'Nothing was submitted. Ask the user which pixel in details.owned_pixel_ids to use and amend the step with amcp_campaign recover_step, as the refusal’s next_call shows (a patch of the named pixel_id); the next prepare_next checks it again. Or have the pixel’s owner share it to this ad account in Snapchat Business Manager, then run preflight.',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['SNAPCHAT_SEGMENT_UNAVAILABLE'],
    remedy: {
      category: 'state',
      owner: 'operator',
      action:
        'Nothing was submitted. Ask the user to choose segments of the selected ad account (details.reason says why this one is refused): a foreign or unlisted segment cannot be added, and one that is not ready can be included once Snapchat lists it as READY. Then prepare the targeting edit again.',
      mutation_retry_safe: false,
    },
  },
];
