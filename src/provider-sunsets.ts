import {effectiveProviderContract, providerContracts} from './provider-contracts.js';
import {metaApiVersions} from './meta-version.js';

/**
 * When each provider API version AMCP sends stops working, as far as AMCP has evidence (F-56). The basis says how the
 * date is known: `official`, a date the provider published for this version; `policy`, the first day the provider's
 * support period allows it to end; `unknown`, no date recorded. A date is a day (YYYY-MM-DD) or a month (YYYY-MM,
 * counted from its first day). Where to check is the provider's recorded lifecycle, changelog or documentation page
 * (`providerMaintenance`, `providerContracts`). The versions must equal the ones AMCP sends (`assertSunsetRegistry`),
 * so moving a provider to a new version also means recording what is known about the new one.
 */
export interface ProviderSunset {
  provider: string;
  version: string;
  basis: 'official' | 'policy' | 'unknown';
  sunset?: string;
  checked: string;
  note?: string;
}
const unknown = (provider: string, version: string, note?: string): ProviderSunset => ({
  provider,
  version,
  basis: 'unknown',
  checked: '2026-09-28',
  ...(note ? {note} : {}),
});
export const providerSunsets: ProviderSunset[] = [
  {
    provider: 'google',
    version: 'v25',
    basis: 'official',
    sunset: '2027-08',
    checked: '2026-09-29',
    note: 'Released 2026-07-22 (Google Ads API "Sunset dates" timetable). v23, which AMCP sent until 2026-09-28, sunsets in 2027-02.',
  },
  {
    ...unknown(
      'meta',
      'v26.0',
      'Released 2026-07-29, available until "TBD" (Graph API Versions page and v26.0 changelog). AMCP_META_API_VERSION=v25.0 moves back to v25.0 (its own entry below).',
    ),
    checked: '2026-09-29',
  },
  {
    // The emergency rollback version (src/meta-version.ts) has its own entry, so the registry and its alarms work while
    // the rollback is in use (PRV-04). Record the Marketing API end date once Meta publishes it.
    ...unknown(
      'meta',
      'v25.0',
      'The rollback version (AMCP_META_API_VERSION=v25.0). The Graph API Versions table gives it until 2028-07-29; the Marketing API table says "TBD" (read 2026-10-08), so no date is recorded for advertising requests.',
    ),
    checked: '2026-10-08',
  },
  {
    provider: 'linkedin',
    version: '202609',
    basis: 'policy',
    sunset: '2027-09',
    checked: '2026-09-29',
    note: 'LinkedIn supports each monthly version for at least one year (Marketing API Versioning). Published so far: 202510 ends 2026-10-15 and 202511 ends 2026-11-16 (Recent Marketing API changes, read 2026-09-29).',
  },
  {
    provider: 'criteo',
    version: '2026-07',
    basis: 'policy',
    sunset: '2027-07',
    checked: '2026-09-29',
    note: 'Criteo supports each version for 12 months (Versioning Policy); 2026-07 was released in July 2026. 2026-01, which AMCP sent until 2026-09-29, is supported until 2027-01-27 (the same page).',
  },
  {
    ...unknown(
      'microsoft',
      'v13',
      'AMCP sends v13 REST requests, pinned from Microsoft Learn (F-50). Microsoft deprecates the SOAP API on 2027-01-31 ("Migrate to REST", read 2026-09-29); AMCP sends no SOAP. No end is published for v13 REST.',
    ),
    checked: '2026-09-29',
  },
  unknown('tiktok', 'v1.3'),
  {
    ...unknown(
      'snapchat',
      'v1',
      "Snapchat's Marketing API has one version, v1; its changelog (read 2026-09-29) announces no end for it.",
    ),
    checked: '2026-09-29',
  },
  {
    ...unknown(
      'x',
      '12',
      'Deprecation and end of life "TBD" (X Ads API Versioning). A version is deprecated six months after its successor is announced.',
    ),
    checked: '2026-09-29',
  },
  {
    ...unknown(
      'apple',
      'v1',
      'AMCP sends the Apple Ads Platform API (api.ads.apple.com/v1), whose documentation (read 2026-09-29) publishes no end. The older Campaign Management API, which AMCP does not send, is deprecated and sunsets on 2027-01-26 (Apple Ads documentation).',
    ),
    checked: '2026-09-29',
  },
  {
    ...unknown(
      'reddit',
      'v3',
      'v3 is current and v2 is marked deprecated (Ads API history, read 2026-09-29); no end is published for v3. Onsite lead forms ended on 2026-09-21 (reddit-creative-writes.ts).',
    ),
    checked: '2026-09-29',
  },
  {
    ...unknown('dv360', 'v4', 'Released 2025-03-27; no deprecation announced (Display & Video 360 API Deprecations).'),
    checked: '2026-09-29',
  },
  {
    ...unknown(
      'ga4',
      'v1beta/v1alpha',
      "Neither the Data API nor the Admin API changelog (read 2026-09-29) publishes an end for these versions; alpha methods can be removed with notice, as in the Admin API's 2023 removals.",
    ),
    checked: '2026-09-29',
  },
  {
    ...unknown('gtm', 'v2', 'The Tag Manager API v2 overview (read 2026-09-29) publishes no end.'),
    checked: '2026-09-29',
  },
  {
    ...unknown(
      'gsc',
      'v3/v1',
      'The Search Console API reference and about pages (read 2026-09-29) publish no end for Webmasters v3 or Search Console v1.',
    ),
    checked: '2026-09-29',
  },
  {
    ...unknown('drive', 'v3', 'The Drive API release notes (read 2026-09-29) deprecate single parameters, not v3.'),
    checked: '2026-09-29',
  },
  {
    ...unknown(
      'sheets',
      'v4/v3',
      'Sheets v4, with Drive v3 for finding the spreadsheet. The Sheets release notes (read 2026-09-29) publish no end for v4; the old Sheets API v3, which AMCP does not send, was turned down on 2021-08-02.',
    ),
    checked: '2026-09-29',
  },
  unknown('amazon', 'catalog-dependent'),
  {
    ...unknown(
      'adjust',
      'Reports Service (unversioned)',
      'The Report Service API page (read 2026-09-29) publishes no version or end.',
    ),
    checked: '2026-09-29',
  },
  {
    ...unknown(
      'google_business',
      'v1',
      "The Business Profile APIs' deprecation schedule (read 2026-09-29) lists no end for the v1 APIs AMCP sends; its past entries are v4.9 methods and two Business Information v1 methods AMCP never exposed.",
    ),
    checked: '2026-09-29',
  },
];
const day = 86400000;
/** The first day a recorded sunset can take effect, in UTC; undefined without one. */
export function sunsetDate(entry: ProviderSunset): number | undefined {
  if (!entry.sunset) return;
  return Date.parse((/^\d{4}-\d{2}$/.test(entry.sunset) ? entry.sunset + '-01' : entry.sunset) + 'T00:00:00Z');
}
/** The version AMCP sends for a provider now (after AMCP_META_API_VERSION and the LinkedIn version setting). */
export function sentVersion(id: string): string | undefined {
  const contract = providerContracts.find(c => c.id === id);
  return contract ? String(effectiveProviderContract(id)?.api_version ?? contract.api_version) : undefined;
}
/** Every version AMCP can be configured to send: the Meta rollback adds v25.0 (src/meta-version.ts). */
export function acceptedVersions(id: string): string[] {
  const sent = sentVersion(id);
  return [...new Set([...(sent ? [sent] : []), ...(id === 'meta' ? metaApiVersions : [])])];
}
/**
 * Each recorded version with the days left before its sunset; an alarm within `days` days, or once it has passed.
 * `active` marks the version AMCP sends now; an inactive accepted version (the Meta rollback) is still alarmed.
 */
export function sunsetStatus(
  now = Date.now(),
  days = 90,
): (ProviderSunset & {days_left?: number; alarm: boolean; active: boolean})[] {
  return providerSunsets.map(entry => {
    const at = sunsetDate(entry),
      left = at === undefined ? undefined : Math.ceil((at - now) / day);
    return {
      ...entry,
      ...(left === undefined ? {} : {days_left: left}),
      alarm: left !== undefined && left <= days,
      active: sentVersion(entry.provider) === entry.version,
    };
  });
}
/** Entries whose recorded `checked` day is more than `days` days old: the source needs reading again (PRV-04). */
export function staleSunsetChecks(now = Date.now(), days = 45) {
  return providerSunsets
    .map(entry => ({
      provider: entry.provider,
      version: entry.version,
      checked: entry.checked,
      age_days: Math.floor((now - Date.parse(entry.checked + 'T00:00:00Z')) / day),
    }))
    .filter(entry => entry.age_days > days);
}
/** The registry lists every version AMCP sends or can be configured to send, one entry each, with well-formed dates. */
export function assertSunsetRegistry(entries: ProviderSunset[] = providerSunsets): void {
  const problems: string[] = [],
    key = (s: {provider: string; version: string}) => s.provider + ' ' + s.version,
    recorded = new Map(entries.map(s => [key(s), s]));
  if (recorded.size !== entries.length) problems.push('a provider version is recorded twice');
  for (const contract of providerContracts) {
    const id = String(contract.id),
      version = sentVersion(id)!;
    if (!entries.some(e => e.provider === id)) problems.push(id + ': no sunset entry for ' + version);
    else
      for (const accepted of acceptedVersions(id))
        if (!recorded.has(key({provider: id, version: accepted})))
          problems.push(
            id +
              ': no sunset entry records ' +
              accepted +
              (accepted === version ? ', the version AMCP sends' : ', a version AMCP can be configured to send'),
          );
  }
  for (const entry of entries) {
    if (!providerContracts.some(c => c.id === entry.provider)) problems.push(entry.provider + ': not a provider');
    else if (!acceptedVersions(entry.provider).includes(entry.version))
      problems.push(
        entry.provider +
          ': the sunset entry records ' +
          entry.version +
          ' but AMCP sends ' +
          acceptedVersions(entry.provider).join(' or '),
      );
    if ((entry.basis === 'unknown') !== (entry.sunset === undefined))
      problems.push(entry.provider + ': a date needs an official or policy basis, and such a basis needs a date');
    if (entry.sunset !== undefined && !Number.isFinite(sunsetDate(entry)))
      problems.push(entry.provider + ': malformed sunset ' + entry.sunset);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.checked)) problems.push(entry.provider + ': malformed checked date');
  }
  if (problems.length) throw Error('Provider sunset registry: ' + problems.join('; '));
}
/** The sunset entry of the version AMCP sends for one provider. */
export function providerSunset(id: string): ProviderSunset | undefined {
  const version = sentVersion(id);
  return (
    providerSunsets.find(s => s.provider === id && s.version === version) ??
    providerSunsets.find(s => s.provider === id)
  );
}
