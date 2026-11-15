import type {ProviderRemedy} from './provider-remedies.js';

/**
 * The rules of TikTok's page-count check (src/tiktok-report-pagination.ts) that refuse a report on what one TikTok answer
 * says: the page counts are missing, do not match the page asked for, or contradict the rows. The check reads only the
 * answer, so the same request gets the same answer and a retry cannot help (r25-hotfix, V2-RPT-01). The rules that may
 * follow TikTok's own data still moving (`total_changed`, `fewer_rows_than_declared`, `totals_mismatch`) are left out:
 * they keep the shared retry advice.
 */
const pageCountRules: readonly string[] = [
  'page_info_missing',
  'page_not_echoed',
  'total_not_integer',
  'page_longer_than_size',
  'more_rows_than_declared',
];
const pageCountRefusal = (details: Record<string, unknown>): boolean => {
  const facts = details.page_facts;
  return (
    !!facts &&
    typeof facts === 'object' &&
    !Array.isArray(facts) &&
    pageCountRules.includes((facts as Record<string, unknown>).rule as string)
  );
};

/**
 * The remedies TikTok declares for its own refusals (ARC-04 stage C). errorRemedy (src/errors.ts) consults every
 * provider’s table (src/provider-remedies.ts) before its shared rules. A leaf: nothing is imported at load.
 */
export const tiktokRemedies: readonly ProviderRemedy[] = [
  // A report whose page counts AMCP's check refused (live checks of 2026-11-15, error 7). It names what AMCP saw, that
  // the same request returns the same answer, and what to do, instead of the shared advice to retry the report.
  {
    codes: ['REPORT_INCOMPLETE'],
    when: pageCountRefusal,
    remedy: {
      category: 'report',
      owner: 'operator',
      action:
        'TikTok’s page counts for this report were missing or did not match the page AMCP asked for or the rows TikTok returned, so AMCP did not accept it as complete (details.page_facts.rule names the check that failed). Retrying the same request returns the same answer. Report these details to support, or narrow the request (a shorter date range, or fewer levels) and send that instead.',
      mutation_retry_safe: false,
    },
  },
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
