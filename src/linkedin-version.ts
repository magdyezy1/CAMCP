import {MirrorError} from './errors.js';
/**
 * The LinkedIn-Version AMCP sends: 202609 (Marketing September 2026) since batch 32, after a review of LinkedIn's
 * changes for 202606–202609 ("Recent Marketing API changes", read 2026-09-29), all additive for what AMCP sends and
 * reads. AMCP_LINKEDIN_API_VERSION or a call's api_version chooses another monthly version.
 */
export function linkedinVersion(explicit?: unknown): string {
  const value = explicit ?? process.env.AMCP_LINKEDIN_API_VERSION ?? '202609';
  if (typeof value !== 'string' || !/^20\d{2}(?:0[1-9]|1[0-2])$/.test(value))
    throw new MirrorError(
      'INVALID_API_VERSION',
      'LinkedIn-Version must be a monthly YYYYMM version. Verify that the chosen version is supported by LinkedIn.',
    );
  return value;
}
