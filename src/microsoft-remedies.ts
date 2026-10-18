import type {ProviderRemedy} from './provider-remedies.js';

/**
 * The remedies Microsoft Advertising declares for its own refusals (ARC-04 stage C). errorRemedy (src/errors.ts)
 * consults every provider’s table (src/provider-remedies.ts) before its shared rules. A leaf: nothing is imported at
 * load.
 */
export const microsoftRemedies: readonly ProviderRemedy[] = [
  // CMP-03 (owner decision P7): Microsoft activation waits for a readable positive location criterion.
  {
    codes: ['LOCATION_CRITERIA_REQUIRED'],
    remedy: {
      category: 'state',
      owner: 'operator',
      action:
        'While the campaign is paused, add its target locations with a reviewed AddCampaignCriterions (CriterionType Targets) or in Microsoft Advertising, then prepare the activation again. Nothing was activated.',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['LOCATION_PARENT_NOT_PAUSED'],
    remedy: {
      category: 'state',
      owner: 'operator',
      action:
        'Pause the campaign with a reviewed UpdateCampaigns (Status Paused), then review the location change; or change its locations in Microsoft Advertising. Nothing was sent.',
      mutation_retry_safe: false,
    },
  },
  // CMP-03: the Microsoft location lookup reads only; nothing is ever written.
  {
    codes: ['MICROSOFT_LOCATIONS_UNPINNED'],
    remedy: {
      category: 'deployment',
      owner: 'deployment_operator',
      action:
        'Nothing was sent. Enter location IDs from Microsoft’s geographical locations file instead. The deployment operator turns this search on by pinning Microsoft’s GetGeoLocationsFileUrl documentation (tools/microsoft-rest.mjs).',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['MICROSOFT_LOCATIONS_FILE_INVALID', 'MICROSOFT_LOCATIONS_FILE_UNAVAILABLE'],
    remedy: {
      category: 'provider',
      owner: 'operator',
      action:
        'No partial list was used. Search again in a moment, or enter location IDs from Microsoft’s geographical locations file; report the request ID if this recurs.',
      mutation_retry_safe: false,
    },
  },
];
