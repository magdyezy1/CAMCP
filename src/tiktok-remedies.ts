import type {ProviderRemedy} from './provider-remedies.js';

/**
 * The remedies TikTok declares for its own refusals (ARC-04 stage C). errorRemedy (src/errors.ts) consults every
 * provider’s table (src/provider-remedies.ts) before its shared rules. A leaf: nothing is imported at load.
 */
export const tiktokRemedies: readonly ProviderRemedy[] = [
  // Report tasks: the original task, its access token and its receipt are kept.
  {
    codes: ['TIKTOK_REPORT_TOKEN_CHANGED'],
    remedy: {
      category: 'report',
      owner: 'operator',
      action:
        'Preserve the original task and receipt. TikTok requires its original access token; do not silently switch logins or regenerate the report. If that authorization is unavailable, explicitly review a new task.',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['TIKTOK_REPORT_PENDING'],
    remedy: {
      category: 'report',
      owner: 'operator',
      action: 'Poll the same task later; do not submit another task.',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['TIKTOK_REPORT_FAILED', 'TIKTOK_REPORT_CANCELED', 'TIKTOK_REPORT_EXPIRED', 'TIKTOK_REPORT_NOT_CANCELLABLE'],
    remedy: {
      category: 'report',
      owner: 'operator',
      action:
        'Inspect the original task status and reviewed definition. Preserve completed output; only an explicit new review may create a replacement.',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['TIKTOK_REPORT_*'],
    remedy: {
      category: 'report',
      owner: 'operator',
      action:
        'Inspect the report contract and original status. Retry only a failed read; fix the definition or split large output through an explicit new review.',
      mutation_retry_safe: false,
    },
  },
];
