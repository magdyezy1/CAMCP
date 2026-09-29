import {effectiveProviderContract, providerContracts} from './provider-contracts.js';

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
  unknown(
    'google',
    'v25',
    "v25's date was not readable from the review environment. v23, which AMCP sent until 2026-09-28, sunsets in 2027-02 (Google's sunset page, checked 2026-09-18).",
  ),
  unknown(
    'meta',
    'v26.0',
    'Released 2026-07-29. AMCP_META_API_VERSION=v25.0 moves back to v25.0, whose end date is also unverified.',
  ),
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
  unknown(
    'microsoft',
    'v13',
    "AMCP uses v13's JSON endpoints. Microsoft retires v13's SOAP endpoints on 2027-01-31 (F-50); AMCP's pinned v13 evidence is still the SOAP WSDL.",
  ),
  unknown('tiktok', 'v1.3'),
  unknown('snapchat', 'v1'),
  unknown('x', '12'),
  unknown('apple', 'v1'),
  unknown('reddit', 'v3'),
  unknown('dv360', 'v4'),
  unknown('ga4', 'v1beta/v1alpha'),
  unknown('gtm', 'v2'),
  unknown('gsc', 'v3/v1'),
  unknown('drive', 'v3'),
  unknown('sheets', 'v4/v3'),
  unknown('amazon', 'catalog-dependent'),
  unknown('adjust', 'Reports Service (unversioned)'),
  unknown('google_business', 'v1'),
];
const day = 86400000;
/** The first day a recorded sunset can take effect, in UTC; undefined without one. */
export function sunsetDate(entry: ProviderSunset): number | undefined {
  if (!entry.sunset) return;
  return Date.parse((/^\d{4}-\d{2}$/.test(entry.sunset) ? entry.sunset + '-01' : entry.sunset) + 'T00:00:00Z');
}
/** Each recorded version with the days left before its sunset; an alarm within `days` days, or once it has passed. */
export function sunsetStatus(now = Date.now(), days = 90): (ProviderSunset & {days_left?: number; alarm: boolean})[] {
  return providerSunsets.map(entry => {
    const at = sunsetDate(entry),
      left = at === undefined ? undefined : Math.ceil((at - now) / day);
    return {...entry, ...(left === undefined ? {} : {days_left: left}), alarm: left !== undefined && left <= days};
  });
}
/** The registry lists exactly the versions AMCP sends, one entry each, with well-formed dates. */
export function assertSunsetRegistry(entries: ProviderSunset[] = providerSunsets): void {
  const problems: string[] = [],
    recorded = new Map(entries.map(s => [s.provider, s]));
  if (recorded.size !== entries.length) problems.push('a provider is recorded twice');
  for (const contract of providerContracts) {
    const id = String(contract.id),
      version = String(effectiveProviderContract(id)?.api_version ?? contract.api_version),
      entry = recorded.get(id);
    if (!entry) problems.push(id + ': no sunset entry for ' + version);
    else if (entry.version !== version)
      problems.push(id + ': the sunset entry records ' + entry.version + ' but AMCP sends ' + version);
  }
  for (const entry of entries) {
    if (!providerContracts.some(c => c.id === entry.provider)) problems.push(entry.provider + ': not a provider');
    if ((entry.basis === 'unknown') !== (entry.sunset === undefined))
      problems.push(entry.provider + ': a date needs an official or policy basis, and such a basis needs a date');
    if (entry.sunset !== undefined && !Number.isFinite(sunsetDate(entry)))
      problems.push(entry.provider + ': malformed sunset ' + entry.sunset);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.checked)) problems.push(entry.provider + ': malformed checked date');
  }
  if (problems.length) throw Error('Provider sunset registry: ' + problems.join('; '));
}
/** The sunset entry of one provider. */
export function providerSunset(id: string): ProviderSunset | undefined {
  return providerSunsets.find(s => s.provider === id);
}
