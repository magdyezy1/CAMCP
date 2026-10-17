import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

function unavailable(): never {
  throw new MirrorError(
    'REPORT_SCOPE_UNAVAILABLE',
    'The retained reporting resource selector is invalid or cannot establish an exact account. Inspect the original definition and prepare a corrected read-only run.',
    {},
    403,
  );
}

/** Native selectors from the existing delegated compiler. Return only the exact account, never the child path. */
export function reportingResourceAccount(gateway: string, row: JsonObject): string {
  const value: unknown = row?.value;
  if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x20\\]/.test(value)) unavailable();
  if (gateway === 'ga4_native_action') {
    if (row.kind === 'property') {
      const match = /^(?:properties\/)?([0-9]{1,32})$/.exec(value);
      return match?.[1] ?? unavailable();
    }
    if (row.kind === 'resource') {
      // Discovery uses properties/{property}/... resource names. ScopeGuard derives the same exact parent.
      const match = /^properties\/([0-9]{1,32})(?:\/[^/\x00-\x20\\?#%]+)*$/.exec(value);
      if (!match || value.split('/').some(part => part === '.' || part === '..')) unavailable();
      return match[1]!;
    }
  }
  if (gateway === 'google_search_console_native_action' && row.kind === 'site') {
    if (value.length > 200) unavailable();
    if (/^sc-domain:[^/?#]+$/.test(value)) return value;
    if (/^https?:\/\//.test(value)) {
      try {
        const url = new URL(value);
        if (!url.username && !url.password) return value; // Preserve prefix-property bytes, including trailing slash.
      } catch {}
    }
  }
  if (gateway === 'reddit_native_action' && row.kind === 'account') {
    // Delegated Reddit routes identify their exact ad-account parent by ad_account_id.
    // Do not derive scope from a campaign/ad child ID or an arbitrary HTTP path.
    return /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : unavailable();
  }
  if (['gtm_native_action', 'google_business_native_action'].includes(gateway)) {
    const id = '[A-Za-z0-9_-]{1,200}';
    if (row.kind === 'account') {
      if (gateway === 'google_business_native_action' && new RegExp('^locations/' + id + '$').test(value)) return value;
      const match = new RegExp('^(?:accounts/)?(' + id + ')$').exec(value);
      return match?.[1] ?? unavailable();
    }
    if (gateway === 'google_business_native_action' && row.kind === 'location') {
      const match = new RegExp('^(?:locations/)?(' + id + ')$').exec(value);
      return match ? 'locations/' + match[1] : unavailable();
    }
    if (row.kind === 'resource') {
      if (value.split('/').some(part => part === '.' || part === '..')) unavailable();
      const account = new RegExp('^accounts/(' + id + ')(?:/[^/\\x00-\\x20\\\\?#%]+)*$').exec(value);
      if (account) return account[1]!;
      if (gateway === 'google_business_native_action') {
        const location = new RegExp('^locations/(' + id + ')(?:/[^/\\x00-\\x20\\\\?#%]+)*$').exec(value);
        if (location) return 'locations/' + location[1];
      }
    }
  }
  return unavailable();
}

/** Business Profile's location is a child consistency check when an account parent is present.
 * A bare location selector can establish locations/{id} only when no existing account context is supplied.
 */
export function reportingResourceAccounts(gateway: string, rows: JsonObject[], existingAccounts: unknown[]): string[] {
  if (gateway !== 'google_business_native_action') return rows.map(row => reportingResourceAccount(gateway, row));
  const locationRows = rows.filter(row => row.kind === 'location'),
    otherRows = rows.filter(row => row.kind !== 'location'),
    accounts = otherRows.map(row => reportingResourceAccount(gateway, row)),
    locations = locationRows.map(row => reportingResourceAccount(gateway, row));
  if (locations.length) {
    const referenced = [
      ...accounts.filter(account => account.startsWith('locations/')),
      ...existingAccounts.filter(account => typeof account === 'string' && account.startsWith('locations/')),
      ...otherRows
        .filter(row => row.kind === 'resource')
        .flatMap(row => {
          const match = /(?:^|\/)locations\/([A-Za-z0-9_-]{1,200})(?:\/|$)/.exec(row.value);
          return match ? ['locations/' + match[1]] : [];
        }),
    ];
    if (new Set([...locations, ...referenced]).size > 1) unavailable();
  }
  return accounts.length || existingAccounts.length ? accounts : locations;
}

// The resource selector projection is in the store layer (src/workbook-repository.ts, ARC-02).
export {reportResourceFieldsSQL} from './workbook-repository.js';
