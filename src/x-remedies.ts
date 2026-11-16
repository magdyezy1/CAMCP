import type {ProviderRemedy} from './provider-remedies.js';

/**
 * The remedies X declares for its own refusals (ARC-04 stage C). errorRemedy (src/errors.ts) consults every provider’s
 * table (src/provider-remedies.ts) before its shared rules. A leaf: nothing is imported at load.
 */
export const xRemedies: readonly ProviderRemedy[] = [
  // An entity whose parent is in neither of the account's own lists (r12-fix item 3, V2-RPT-05; error 3 of the live checks of
  // 2026-11-16). The check proves ownership and reads only what the lists say, so a retry returns the same answer; the shared
  // advice asked for one. Narrowed by details.parent_kind, a closed set set by src/x-overview-detail.ts, so the other
  // REPORT_ACCOUNT_MISMATCH refusals keep the shared advice. No MCP action or argument is named: the website shows this as
  // written (WEB-03; tests/website-provider-remedies.test.mjs).
  {
    codes: ['REPORT_ACCOUNT_MISMATCH'],
    when: details => details.parent_kind === 'campaign' || details.parent_kind === 'line item',
    remedy: {
      category: 'report',
      owner: 'operator',
      action:
        'An entity’s parent (its line item or campaign) could not be found among the account’s own objects. This check protects ownership, so AMCP does not report an entity it cannot trace to the account. Retrying will not help. Check that the parent still exists in this account in X, or report these details to support.',
      mutation_retry_safe: false,
    },
  },
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
