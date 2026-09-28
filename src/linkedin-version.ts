import {MirrorError} from './errors.js';
export function linkedinVersion(explicit?: unknown): string {
  const value = explicit ?? process.env.AMCP_LINKEDIN_API_VERSION ?? '202605';
  if (typeof value !== 'string' || !/^20\d{2}(?:0[1-9]|1[0-2])$/.test(value))
    throw new MirrorError(
      'INVALID_API_VERSION',
      'LinkedIn-Version must be a monthly YYYYMM version. Verify that the chosen version is supported by LinkedIn.',
    );
  return value;
}
