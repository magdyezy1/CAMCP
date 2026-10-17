import type {ProviderRemedy} from './provider-remedies.js';

/**
 * The remedies X declares for its own refusals (ARC-04 stage C). errorRemedy (src/errors.ts) consults every provider’s
 * table (src/provider-remedies.ts) before its shared rules. A leaf: nothing is imported at load.
 */
export const xRemedies: readonly ProviderRemedy[] = [
  // Audience targeting (atomic batches and line-item edits): a pause first, then the audience change.
  {
    codes: ['TARGETING_PARENT_NOT_PAUSED'],
    remedy: {
      category: 'state',
      owner: 'operator',
      action:
        'Prepare and review a separate pause for each affected line item, then review the audience change. Do not activate automatically.',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['X_TARGETING_LIMIT'],
    remedy: {
      category: 'state',
      owner: 'operator',
      action:
        'Narrow the explicitly reviewed operation or selected line items. An incomplete collection cannot authorize execution. Preserve the original key for any submitted request.',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['X_TARGETING_*', 'INVALID_X_TARGETING_BATCH'],
    remedy: {
      category: 'state',
      owner: 'operator',
      action:
        'Inspect the exact targeting input, selected account, current private-reference eligibility and complete membership. Preserve the original review/key after submission; correct an uncertain result only after scoped read-back.',
      mutation_retry_safe: false,
    },
  },
];
