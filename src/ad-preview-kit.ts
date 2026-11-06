import type {AdPreviewHooks} from './provider-adapter.js';
import type {JsonObject} from './types.js';

/**
 * What amcp_ad_previews (src/ad-previews.ts) shares with the platforms' own preview modules (src/<platform>-ad-previews.ts,
 * registered as the `previews` hooks of src/<platform>-adapter.ts): small helpers that name no platform. A leaf, so a
 * platform module may use it without importing the tool or the hooks registry (which would be an import cycle).
 */
export const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
export const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

/**
 * Whether a link, as written, spells a separator before its query: an entity (`&sol;`) or a `;`. A browser reading the
 * markup decodes `https://evil.com&sol;.linkedin.com/` to a link to evil.com, while the URL parser reads the whole text
 * as a host that ends in `.linkedin.com`. Only the text before the first `?` names a host or a path, and no platform
 * writes an entity or a `;` there (they write `&amp;` between the parameters of the query).
 */
export const spellsSeparator = (raw: string) => /[&;]/.test(raw.split('?', 1)[0]!);

/**
 * The platform links in a preview response, wherever the platform put them: string values that are HTTPS URLs, and
 * the `src`/`href` of HTML (Meta and LinkedIn return iframe markup). Only HTTPS links on the platform's own `hosts`
 * count; the markup itself is provider content and is never returned.
 */
export function previewLinksOn(hosts: RegExp, data: unknown): string[] {
  const found = new Set<string>();
  const consider = (candidate: string) => {
    if (spellsSeparator(candidate)) return;
    let url: URL;
    try {
      url = new URL(candidate.replaceAll('&amp;', '&'));
    } catch {
      return;
    }
    if (url.protocol === 'https:' && !url.username && !url.password && hosts.test(url.hostname)) found.add(url.href);
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || found.size >= 20) return;
    if (typeof v === 'string') {
      if (/^https:\/\/\S+$/.test(v)) consider(v);
      else if (v.includes('<')) for (const m of v.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) consider(m[1]!);
    } else if (Array.isArray(v)) for (const item of v.slice(0, 100)) walk(item, depth + 1);
    else if (object(v)) for (const item of Object.values(v)) walk(item, depth + 1);
  };
  walk(data, 0);
  return [...found];
}

/** A platform whose API has no ad preview route AMCP can read: its hooks say so, in the sentence the tool returns. */
export const noPreviewRoute = (platform: string, explanation: string): AdPreviewHooks =>
  Object.freeze({platform, explain: () => ({preview_route: 'none', explanation})});
