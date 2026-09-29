import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Known Snapchat records by ID, from the account's own list (Snapchat S3). In the owner's live tests, reading four
 * creatives referenced by an owned campaign's ads was refused (no ownership yet) and the suggested read, the whole
 * account list of 312 creatives, was 52 KB even projected. `result_ids` pages through the account list and returns
 * only the records asked for. The list path names the account, so ownership comes from the path, and every ID the
 * list returns is recorded as owned for the usual five minutes; an ID the account does not list is reported missing
 * and stays unreadable. No request ever names an unverified ID.
 */
const accountList =
  /^\/v1\/adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives|media|pixels|lead_generation_forms|segments)$/;
export interface ResultIds {
  kind: string;
  ids: string[];
}
export function snapchatResultIds(plan: CompiledRequest, input: JsonObject): ResultIds | undefined {
  if (input.result_ids === undefined) return undefined;
  const kind =
    plan.gateway === 'snapchat_native_action' && plan.method === 'GET' ? accountList.exec(plan.path)?.[1] : undefined;
  if (!kind)
    throw new MirrorError(
      'INVALID_PARAMETER',
      'result_ids filters a Snapchat account list (such as snapchat_creative_list); ' + plan.action + ' is not one.',
      {field: 'result_ids'},
    );
  const ids: unknown = input.result_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100)
    throw new MirrorError('INVALID_PARAMETER', 'result_ids must list 1-100 IDs.', {field: 'result_ids'});
  ids.forEach((id, i) => {
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id))
      throw new MirrorError(
        'INVALID_PARAMETER',
        'result_ids[' + i + '] must be a Snapchat ID: letters, digits, _ or -, at most 64.',
        {field: 'result_ids[' + i + ']'},
      );
  });
  return {kind, ids: [...new Set(ids as string[])]};
}
/** The asked-for records of a merged account list, and what was and was not found within the pages read. */
export function keepResultIds(
  data: unknown,
  wanted: ResultIds,
  pages: number,
  truncated: boolean,
): {data: unknown; summary: JsonObject} {
  const d = (data && typeof data === 'object' ? data : {}) as JsonObject,
    singular = wanted.kind === 'media' ? 'media' : wanted.kind.slice(0, -1),
    rows: JsonObject[] = Array.isArray(d[wanted.kind]) ? d[wanted.kind] : [],
    want = new Set(wanted.ids),
    kept = rows.filter(w => want.has((w?.[singular] ?? w)?.id)),
    present = new Set(kept.map(w => (w?.[singular] ?? w).id)),
    missing = wanted.ids.filter(id => !present.has(id));
  return {
    data: {...d, [wanted.kind]: kept},
    summary: {
      requested: wanted.ids.length,
      found: wanted.ids.filter(id => present.has(id)),
      missing,
      pages_read: pages,
      complete: !truncated,
      ...(truncated && missing.length
        ? {
            note:
              'Not found within the first ' +
              pages +
              ' pages of the account list; raise max_pages (up to 100) to look further.',
          }
        : {}),
    },
  };
}
