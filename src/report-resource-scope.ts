import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';
import {providerHooks} from './provider-hooks.js';

function unavailable(): never {
  throw new MirrorError(
    'REPORT_SCOPE_UNAVAILABLE',
    'The retained reporting resource selector is invalid or cannot establish an exact account. Inspect the original definition and prepare a corrected read-only run.',
    {},
    403,
  );
}

/**
 * Native selectors from the existing delegated compiler. Return only the exact account, never the child path. The
 * selector bounds are shared; which account a selector names is its provider's (ARC-01, reporting: the reportScope
 * hooks of src/<provider>-adapter.ts), and a gateway without them establishes none.
 */
export function reportingResourceAccount(gateway: string, row: JsonObject): string {
  const value: unknown = row?.value;
  if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x20\\]/.test(value)) unavailable();
  return providerHooks(gateway)?.reportScope?.account(row.kind, value) ?? unavailable();
}

/**
 * The accounts of a run's resource selectors. A provider whose selectors may only check another selector's
 * consistency decides which of them name accounts (Business Profile's location selectors); every other selector
 * names its account.
 */
export function reportingResourceAccounts(gateway: string, rows: JsonObject[], existingAccounts: unknown[]): string[] {
  const accounts = providerHooks(gateway)?.reportScope?.accounts;
  if (!accounts) return rows.map(row => reportingResourceAccount(gateway, row));
  return accounts(rows, existingAccounts, row => reportingResourceAccount(gateway, row)) ?? unavailable();
}

/**
 * The selector kind of an account anchor a provider writes in resource form (GA4 `properties/...`, Tag Manager and
 * Business Profile `accounts/...`), whose account its selector check establishes; undefined for an account ID.
 */
export const reportingAnchorKind = (gateway: string, anchor: string): string | undefined =>
  providerHooks(gateway)?.reportScope?.anchorKind?.(anchor);

// The resource selector projection is in the store layer (src/workbook-repository.ts, ARC-02).
export {reportResourceFieldsSQL} from './workbook-repository.js';
