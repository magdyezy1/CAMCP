import type {Store} from './store.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import type {AdPreviewLink} from './provider-adapter.js';

/**
 * LinkedIn documents GET /rest/adPreviews?q=creative&creative=...&account=... (Ad Preview, read 2026-11-03).
 * The query must name the selected account, and the creative's scope also comes from
 * ownership: the account's creatives finder (GET /rest/adAccounts/{id}/creatives?q=criteria) lists that account's own
 * creatives, and each one it returns may be previewed through the same connection for five minutes.
 */
const creativeUrn = /^urn:li:sponsoredCreative:([1-9][0-9]{0,19})$/;
const decode = (v: unknown) => {
  try {
    return decodeURIComponent(String(v ?? ''));
  } catch {
    return '';
  }
};
const plainRead = (p: CompiledRequest) =>
  p.gateway === 'linkedin_native_action' &&
  p.method === 'GET' &&
  p.readOnly &&
  (p.body === undefined || p.body === null) &&
  !p.specialTransport &&
  (!p.origin || p.origin === 'https://api.linkedin.com');

/** A plain read of /rest/adPreviews: the requests authorizeLinkedInAdPreview decides (its read authorizer's claim). */
export const linkedinAdPreviewRead = (p: CompiledRequest) => plainRead(p) && decode(p.path) === '/rest/adPreviews';
export function authorizeLinkedInAdPreview(p: CompiledRequest, c: Connection, store: Store, selected: string): boolean {
  if (!linkedinAdPreviewRead(p)) return false;
  if (
    Object.keys(p.query).length !== 3 ||
    Object.keys(p.query).some(k => !['q', 'creative', 'account'].includes(k)) ||
    p.query.q !== 'creative' ||
    p.query.account !== 'urn:li:sponsoredAccount:' + selected
  )
    return false;
  const creative = creativeUrn.exec(decode(p.query.creative))?.[1];
  return !!creative && store.ownsResource(c, selected, 'creatives/' + creative);
}

/** Only the documented accurate-preview iframe's src, never links embedded elsewhere in provider HTML. */
export function linkedInPreviewLinks(elements: unknown, now: number): AdPreviewLink[] {
  if (!Array.isArray(elements) || elements.length > 100 || !Number.isFinite(now)) return [];
  const links: AdPreviewLink[] = [],
    seen = new Set<string>(),
    expires_at = new Date(now + 3 * 3600000).toISOString();
  for (const element of elements) {
    if (
      !element ||
      typeof element !== 'object' ||
      typeof element.preview !== 'string' ||
      element.preview.length > 16384
    )
      continue;
    const tag = /^\s*<iframe\b([^<>]*)>\s*<\/iframe\s*>\s*$/i.exec(element.preview);
    if (!tag) continue;
    const attributes = new Map<string, string>();
    let rest = tag[1]!,
      valid = true;
    while (rest.length) {
      const leading = /^\s+/.exec(rest);
      if (!leading) {
        valid = false;
        break;
      }
      rest = rest.slice(leading[0].length);
      if (!rest) break;
      const attr = /^([a-z][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/i.exec(rest);
      if (!attr || attributes.has(attr[1]!.toLowerCase())) {
        valid = false;
        break;
      }
      attributes.set(attr[1]!.toLowerCase(), attr[2] ?? attr[3] ?? attr[4] ?? '');
      rest = rest.slice(attr[0].length);
    }
    const src = attributes.get('src');
    if (!valid || attributes.has('srcdoc') || !src || /[\x00-\x20<>]/.test(src)) continue;
    let url: URL;
    try {
      url = new URL(src.replaceAll('&amp;', '&'));
    } catch {
      continue;
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !(url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com'))
    )
      continue;
    const placement = element.placement?.linkedin,
      value = (v: unknown) => (typeof v === 'string' && v.trim() && v.length <= 200 ? v : null),
      link = {
        placement: value(placement?.placementName) ?? 'UNKNOWN',
        device: value(placement?.contentPresentationType),
        url: url.href,
        expires_at,
      },
      key = JSON.stringify([link.placement, link.device, link.url]);
    if (!seen.has(key)) {
      links.push(link);
      seen.add(key);
    }
  }
  return links;
}

export function observeLinkedInCreatives(
  p: CompiledRequest,
  c: Connection,
  store: Store,
  selected: string,
  data: unknown,
): void {
  if (!plainRead(p) || decode(p.path) !== '/rest/adAccounts/' + selected + '/creatives') return;
  const elements = (data as JsonObject)?.elements;
  if (p.query.q !== 'criteria' || !Array.isArray(elements)) return;
  if (
    elements.some(
      row =>
        row &&
        typeof row === 'object' &&
        (row as JsonObject).account !== undefined &&
        (row as JsonObject).account !== 'urn:li:sponsoredAccount:' + selected,
    )
  )
    throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'Not in this account', {}, 403);
  for (const row of elements) {
    const creative = creativeUrn.exec(String((row as JsonObject)?.id ?? ''))?.[1];
    if (creative) store.rememberResource(c, selected, 'creatives/' + creative);
  }
}
