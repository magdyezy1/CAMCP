import type {Store} from './store.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';

/**
 * A LinkedIn ad preview names its creative in the query (GET /rest/adPreviews?q=creative&creative=urn:li:sponsoredCreative:…,
 * the parameters of AMCP's get_ad_preview workflow), not in an account path, so the account scope comes from
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

export function authorizeLinkedInAdPreview(p: CompiledRequest, c: Connection, store: Store, selected: string): boolean {
  if (!plainRead(p) || decode(p.path) !== '/rest/adPreviews') return false;
  if (Object.keys(p.query).some(k => !['q', 'creative'].includes(k)) || p.query.q !== 'creative') return false;
  const creative = creativeUrn.exec(decode(p.query.creative))?.[1];
  return !!creative && store.ownsResource(c, selected, 'creatives/' + creative);
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
  for (const row of elements) {
    const creative = creativeUrn.exec(String((row as JsonObject)?.id ?? ''))?.[1];
    if (creative) store.rememberResource(c, selected, 'creatives/' + creative);
  }
}
