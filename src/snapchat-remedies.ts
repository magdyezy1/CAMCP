import type {ProviderRemedy} from './provider-remedies.js';

/**
 * The remedies Snapchat declares for its own refusals (ARC-04 stage C). errorRemedy (src/errors.ts) consults every
 * provider’s table (src/provider-remedies.ts) before its shared rules. A leaf: nothing is imported at load.
 */
export const snapchatRemedies: readonly ProviderRemedy[] = [
  // A timestamp of a stats answer that AMCP refused (r12-fix item 3, V2-RPT-05; error 1 of the live checks of 2026-11-16). The
  // refusal reads only what one answer says, so the same request gets the same answer and a retry cannot help; the shared advice
  // asked for one. Each rule names the timestamp that failed (details.timestamp_field, a closed set in src/snapchat-evidence.ts)
  // in words, because the website shows a provider-data remedy as written and takes a snake_case name for an MCP client's
  // argument (WEB-03; tests/website-provider-remedies.test.mjs). A REPORT_DATE_MISMATCH that names none keeps the shared advice.
  {
    codes: ['REPORT_DATE_MISMATCH'],
    when: details => details.timestamp_field === 'finalized_data_end_time',
    remedy: {
      category: 'report',
      owner: 'operator',
      action:
        'Snapchat’s answer had a missing or invalid finalization time for its non-conversion data (the time through which it says that data is final), so AMCP did not accept the report as complete. Retrying the same report returns the same answer. Report these details to support.',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['REPORT_DATE_MISMATCH'],
    when: details => details.timestamp_field === 'conversion_data_processed_end_time',
    remedy: {
      category: 'report',
      owner: 'operator',
      action:
        'Snapchat’s answer had a missing or invalid processing time for its conversion data (the time through which it says it has processed that data), so AMCP did not accept the report as complete. Retrying the same report returns the same answer. Report these details to support.',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['REPORT_DATE_MISMATCH'],
    when: details => details.timestamp_field === 'start_time',
    remedy: {
      category: 'report',
      owner: 'operator',
      action:
        'Snapchat’s answer had a missing or invalid start time for a period it reports (the report window, an ad squad or a day), so AMCP did not accept the report as complete. Retrying the same report returns the same answer. Report these details to support.',
      mutation_retry_safe: false,
    },
  },
  {
    codes: ['REPORT_DATE_MISMATCH'],
    when: details => details.timestamp_field === 'end_time',
    remedy: {
      category: 'report',
      owner: 'operator',
      action:
        'Snapchat’s answer had a missing or invalid end time for a period it reports (the report window, an ad squad or a day), so AMCP did not accept the report as complete. Retrying the same report returns the same answer. Report these details to support.',
      mutation_retry_safe: false,
    },
  },
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
