import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Snapchat's "Fetch Multiple" reads (Snapchat Marketing API reference, Campaigns, Ad Squads, Ads, Creatives and Media,
 * read 2026-09-29): POST /v1/adaccounts/{ad_account_id}/get_<entities>_by_ids with the body
 * {"entity_ids": [{"id": "<id>"}, …]}, up to 2,000 entities of the same ad account. The owner's live tests of
 * 2026-09-25 and 2026-09-29 failed with HTTP 400 E1001 on guessed bodies; AMCP now sends only the documented one.
 * The account in the path scopes the read. It never records ownership: only the account's own lists do.
 */
const route = /^\/v1\/adaccounts\/([^/]+)\/get_(campaigns|adsquads|ads|creatives|media)_by_ids$/;
const singular: Record<string, string> = {
  campaigns: 'campaign',
  adsquads: 'adsquad',
  ads: 'ad',
  creatives: 'creative',
  media: 'media',
};
export const snapchatByIdsLimit = 2000;

export function snapchatByIdsKind(p: CompiledRequest): string | undefined {
  if (p.gateway !== 'snapchat_native_action' || p.method !== 'POST') return;
  return route.exec(p.path)?.[2];
}
const refuse = (message: string, field = 'payload'): never => {
  throw new MirrorError('INVALID_ARGUMENT', message, {
    field,
    documented_body: {entity_ids: [{id: '<id>'}]},
    limit: snapchatByIdsLimit,
  });
};
/** Before any request: exactly the documented body, 1–2,000 distinct IDs, and no query parameters. */
export function validateSnapchatByIds(p: CompiledRequest): void {
  const kind = snapchatByIdsKind(p);
  if (!kind) return;
  const body = p.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'entity_ids')
    refuse('Snapchat reads these by the body {"entity_ids": [{"id": "<id>"}, …]} and nothing else.');
  const ids = (body as JsonObject).entity_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > snapchatByIdsLimit)
    refuse('entity_ids holds 1–' + snapchatByIdsLimit + ' entries of {"id": "<id>"}.', 'payload.entity_ids');
  const seen = new Set<string>();
  ids.forEach((e: unknown, i: number) => {
    const entry = e as Record<string, unknown>;
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).join() !== 'id' ||
      typeof entry.id !== 'string' ||
      !/^[\w-]{1,64}$/.test(entry.id)
    )
      refuse('Each entity_ids entry is {"id": "<id>"} with a Snapchat ID.', 'payload.entity_ids.' + i);
    const id = entry.id as string;
    if (seen.has(id)) refuse('entity_ids names ' + id + ' twice.', 'payload.entity_ids.' + i);
    seen.add(id);
  });
  if (Object.keys(p.query).length) refuse('These reads take no query parameters.', 'query.' + Object.keys(p.query)[0]);
}
/**
 * After the read: a returned record that names an ad account names the selected one. Snapchat documents these reads
 * as returning entities of the same ad account; a record of another is refused rather than passed on.
 */
export function checkSnapchatByIdsResult(p: CompiledRequest, data: unknown, account: string): void {
  const kind = snapchatByIdsKind(p);
  if (!kind || !data || typeof data !== 'object') return;
  const rows = (data as JsonObject)[kind];
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    const entity = row?.[singular[kind]!];
    if (entity && typeof entity === 'object' && entity.ad_account_id !== undefined && entity.ad_account_id !== account)
      throw new MirrorError(
        'ACCOUNT_SCOPE_MISMATCH',
        'Snapchat returned a record of another ad account for this read, so none of it is returned.',
        {entity_id: typeof entity.id === 'string' ? entity.id : null},
        502,
      );
  }
}
