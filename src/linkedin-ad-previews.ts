import type {Store} from './store.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import {MirrorError} from './errors.js';

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

/** A plain read of /rest/adPreviews: the requests authorizeLinkedInAdPreview decides (its read authorizer's claim). */
export const linkedinAdPreviewRead = (p: CompiledRequest) => plainRead(p) && decode(p.path) === '/rest/adPreviews';
export function authorizeLinkedInAdPreview(p: CompiledRequest, c: Connection, store: Store, selected: string): boolean {
  if (!linkedinAdPreviewRead(p)) return false;
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
