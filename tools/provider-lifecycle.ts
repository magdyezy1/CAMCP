import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {providerMaintenance} from '../src/contract-evidence.js';
import {providerContracts} from '../src/provider-contracts.js';
import type {JsonObject} from '../src/types.js';

/**
 * Provider documentation watch (PRV-04). Each maintained official page reports one status:
 * - `unchanged`, or `changed_requires_review` when its visible text or its final URL changed since the baseline;
 * - `baseline_required` when no baseline exists yet;
 * - `unavailable` with a fixed reason (blocked, HTTP status, timeout, cross-domain redirect, ...);
 * - `parked` for a parked provider's page, which is not fetched.
 * Only `changed_requires_review` and an overdue manual check fail a live run. Redirects are followed within the same
 * registrable domain, and the final URL is recorded. Usage:
 *   node dist/tools/provider-lifecycle.js            offline: snapshot provenance, unbaselined and stale sources
 *   node dist/tools/provider-lifecycle.js --strict   offline, failing on unbaselined, stale or overdue sources
 *   node dist/tools/provider-lifecycle.js --live     public documentation GETs (owner-run; no provider API calls)
 *   node dist/tools/provider-lifecycle.js --refresh  --live that writes the new baseline for review and commit
 */
const artifact = '.mirror/VENDOR/lifecycle-pages.json';
/** Providers whose work is parked (PRK-02): their pages report `parked` and never fail the watch. */
export const parkedProviders = new Set(['criteo']);
/** Official pages watched beyond the provider maintenance records (src/contract-evidence.ts). */
export const additionalLifecycleSources: {provider: string; url: string}[] = [
  {provider: 'dv360', url: 'https://developers.google.com/display-video/api/deprecations'},
  {provider: 'dv360', url: 'https://developers.google.com/display-video/api/release-notes'},
  {provider: 'ga4', url: 'https://developers.google.com/analytics/devguides/reporting/data/v1/changelog'},
  {provider: 'ga4', url: 'https://developers.google.com/analytics/devguides/config/admin/v1/changelog'},
  {provider: 'gtm', url: 'https://developers.google.com/tag-platform/tag-manager/api/v2'},
  {provider: 'gsc', url: 'https://developers.google.com/webmaster-tools/v1/api_reference_index'},
  {provider: 'sheets', url: 'https://developers.google.com/workspace/sheets/release-notes'},
  {provider: 'drive', url: 'https://developers.google.com/workspace/drive/release-notes'},
  {provider: 'google_business', url: 'https://developers.google.com/my-business/content/sunset-dates'},
  {provider: 'apple', url: 'https://github.com/apple/apple-ads-platform-api-node'},
  {provider: 'reddit', url: 'https://ads-api.reddit.com/docs/v3/'},
  {
    provider: 'reddit',
    url: 'https://ads-api.reddit.com/docs/v3/guides/programs/reporting/upcoming-reporting-api-changes',
  },
];
/**
 * Pages read by a person instead: the page cannot be fetched (TikTok's portal renders with JavaScript and blocks
 * automated reads) or the provider publishes no versioned lifecycle page. The owner (D25/P10 in docs/DECISIONS.md)
 * records each reading by updating `last_checked`; a check past `last_checked + cadence_days` fails a live run.
 */
export const manualLifecycleChecks: {
  provider: string;
  url: string;
  owner: string;
  cadence_days: number;
  last_checked: string;
  reason: string;
}[] = [
  {
    provider: 'tiktok',
    url: 'https://business-api.tiktok.com/portal/docs',
    owner: 'workspace owner',
    cadence_days: 30,
    last_checked: '2026-09-28',
    reason: 'The portal renders with JavaScript and blocks automated reads; read its changelog by hand.',
  },
  {
    provider: 'amazon',
    url: 'https://advertising.amazon.com/API/docs/en-us',
    owner: 'workspace owner',
    cadence_days: 90,
    last_checked: '2026-09-28',
    reason: 'Versions depend on the captured catalog; Amazon publishes no single lifecycle page for it.',
  },
  {
    provider: 'adjust',
    url: 'https://dev.adjust.com/en/api/rs-api/',
    owner: 'workspace owner',
    cadence_days: 90,
    last_checked: '2026-09-29',
    reason: 'The Report Service API is unversioned and publishes no end (provider-sunsets.ts).',
  },
];
const maintained = Object.entries(providerMaintenance).flatMap(([provider, m]) =>
  [m.changelog, ...(m.lifecycle ? [m.lifecycle] : [])].map(url => ({provider, url: String(url)})),
);
/** Every watched page and its provider. */
export const lifecycleSources = new Map<string, string>(
  [...maintained, ...additionalLifecycleSources].map(s => [s.url, s.provider]),
);
const day = 86400000;
const twoLevelSuffixes = new Set(['co.uk', 'com.au', 'co.jp', 'com.br', 'co.in', 'com.sa', 'com.eg']);
/** The registrable domain of a host (eTLD+1 for the hosts AMCP watches). */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  const two = labels.slice(-2).join('.');
  return twoLevelSuffixes.has(two) ? labels.slice(-3).join('.') : two;
}
export function lifecycleText(html: string): string {
  // Compare visible documentation, not scripts, styles, comments or rotating headers.
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? html;
  return main
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|#160);/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
class Unavailable extends Error {}
async function readPage(source: string, fetcher: typeof fetch) {
  let url = source;
  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetcher(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
      headers: {Accept: 'text/html,text/plain'},
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Unavailable('redirect_without_location');
      const next = new URL(location, url);
      if (next.protocol !== 'https:' || registrableDomain(next.hostname) !== registrableDomain(new URL(source).hostname))
        throw new Unavailable('cross_domain_redirect');
      url = next.href;
      continue;
    }
    if (!response.ok) throw new Unavailable('http_' + response.status);
    const reader = response.body?.getReader();
    if (!reader) throw new Unavailable('empty_response');
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        bytes += r.value.length;
        if (bytes > 4 * 1024 * 1024) {
          await reader.cancel();
          throw new Unavailable('too_large');
        }
        chunks.push(r.value);
      }
    } finally {
      reader.releaseLock();
    }
    return {final_url: url, text: lifecycleText(Buffer.concat(chunks).toString('utf8'))};
  }
  throw new Unavailable('too_many_redirects');
}
export async function checkLifecycle(
  source: string,
  previous: JsonObject | undefined,
  fetcher: typeof fetch,
  now = Date.now(),
): Promise<JsonObject> {
  const provider = lifecycleSources.get(source);
  if (!provider) throw Error('Lifecycle sources must be exact maintained official URLs.');
  const checked_at = new Date(now).toISOString(),
    kept = previous?.sha256
      ? {
          sha256: previous.sha256,
          characters: previous.characters,
          ...(previous.final_url ? {final_url: previous.final_url} : {}),
          baseline_checked_at: previous.baseline_checked_at ?? previous.checked_at,
        }
      : {};
  if (parkedProviders.has(provider))
    return {source, provider, status: 'parked', reason: 'provider_parked', ...kept, checked_at};
  try {
    const page = await readPage(source, fetcher);
    if (page.text.length < 200 || /just a moment|verify you are human|enable javascript and cookies/i.test(page.text))
      throw new Unavailable('blocked_or_empty');
    const sha256 = createHash('sha256').update(page.text).digest('hex'),
      // Baselines made before redirects were followed had no redirect: their final URL is the source itself.
      previousFinal = previous?.final_url ?? source,
      moved = !!previous?.sha256 && previousFinal !== page.final_url;
    return {
      source,
      provider,
      final_url: page.final_url,
      sha256,
      characters: page.text.length,
      status: !previous?.sha256
        ? 'baseline_required'
        : previous.sha256 === sha256 && !moved
          ? 'unchanged'
          : 'changed_requires_review',
      ...(moved ? {reason: 'final_url_changed', previous_final_url: previousFinal} : {}),
      checked_at,
      qualification:
        'Public documentation change only; inspect the official page and relevant version before changing a contract. No account qualification.',
    };
  } catch (e) {
    const reason =
      e instanceof Unavailable
        ? e.message
        : e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
          ? 'timeout'
          : 'fetch_failed';
    return {source, provider, status: 'unavailable', reason, ...kept, checked_at};
  }
}
/** Manual checks with their due day; overdue once `now` is past it. */
export function manualCheckStatus(now = Date.now()) {
  return manualLifecycleChecks.map(m => {
    const due = Date.parse(m.last_checked + 'T00:00:00Z') + m.cadence_days * day;
    return {...m, due: new Date(due).toISOString().slice(0, 10), overdue: now > due};
  });
}
/** Live exit status: 1 only on a page that changed or an overdue manual check. */
export function lifecycleExitCode(pages: JsonObject[], now = Date.now()): 0 | 1 {
  return pages.some(p => p.status === 'changed_requires_review') || manualCheckStatus(now).some(m => m.overdue) ? 1 : 0;
}
/** The offline view: provenance of the snapshot, which active sources lack a baseline, and which checks are stale. */
export function offlineLifecycle(previous: {pages: JsonObject[]}, now = Date.now()) {
  const manualProviders = new Set(manualLifecycleChecks.map(m => m.provider)),
    baseline = new Map(previous.pages.filter(p => p.sha256).map(p => [String(p.source), p]));
  const active = [...lifecycleSources].filter(([, provider]) => !parkedProviders.has(provider));
  const unbaselined = active
    .filter(([url, provider]) => !baseline.has(url) && !manualProviders.has(provider))
    .map(([url, provider]) => ({provider, source: url}));
  const stale = active
    .filter(([url]) => baseline.has(url))
    .map(([url, provider]) => {
      const at = Date.parse(String(baseline.get(url)!.checked_at ?? ''));
      return {provider, source: url, age_days: Number.isFinite(at) ? Math.floor((now - at) / day) : null};
    })
    .filter(s => s.age_days === null || s.age_days > 45);
  const manual = manualCheckStatus(now);
  const covered = new Set([...lifecycleSources.values(), ...manualProviders]);
  return {
    mode: 'offline',
    sources: [...lifecycleSources.keys()],
    baselined: baseline.size,
    unbaselined,
    stale_checks: stale,
    parked: [...lifecycleSources].filter(([, p]) => parkedProviders.has(p)).map(([url, provider]) => ({provider, source: url})),
    manual: manual.map(m => ({provider: m.provider, owner: m.owner, due: m.due, overdue: m.overdue})),
    providers_without_policy: providerContracts.map(c => String(c.id)).filter(id => !covered.has(id)),
    strict_failure: unbaselined.length > 0 || stale.length > 0 || manual.some(m => m.overdue),
    meaning:
      'Integrity/configuration only. The owner runs --live (public documentation GETs) on a machine they control and commits a reviewed --refresh.',
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const previous = fs.existsSync(artifact) ? JSON.parse(fs.readFileSync(artifact, 'utf8')) : {pages: []};
  for (const page of previous.pages)
    if (
      (!lifecycleSources.has(page.source) && !process.argv.includes('--refresh')) ||
      (page.sha256 && !/^[0-9a-f]{64}$/.test(page.sha256))
    )
      throw Error('Invalid lifecycle snapshot provenance.');
  if (!process.argv.includes('--live') && !process.argv.includes('--refresh')) {
    const view = offlineLifecycle(previous);
    console.log(JSON.stringify(view, null, 2));
    // The default offline run is part of `npm run check` and stays independent of the date and the network.
    if (process.argv.includes('--strict') && (view.strict_failure || view.providers_without_policy.length))
      process.exitCode = 1;
  } else {
    const pages: JsonObject[] = [];
    for (const source of lifecycleSources.keys())
      pages.push(
        await checkLifecycle(
          source,
          previous.pages.find((p: JsonObject) => p.source === source),
          fetch,
        ),
      );
    if (process.argv.includes('--refresh')) {
      // A reviewed refresh: unavailable or parked pages keep their earlier baseline; review the diff and commit it.
      fs.writeFileSync(artifact, JSON.stringify({formatVersion: 1, pages}, null, 2) + '\n');
      console.error('Wrote ' + artifact + '; review `git diff ' + artifact + '` before committing the new baseline.');
    }
    console.log(
      JSON.stringify(
        {
          mode: 'public-documentation-watch',
          summary: Object.fromEntries(
            ['unchanged', 'changed_requires_review', 'baseline_required', 'unavailable', 'parked'].map(s => [
              s,
              pages.filter(p => p.status === s).length,
            ]),
          ),
          manual: manualCheckStatus(),
          pages,
        },
        null,
        2,
      ),
    );
    if (!process.argv.includes('--refresh')) process.exitCode = lifecycleExitCode(pages);
  }
}
