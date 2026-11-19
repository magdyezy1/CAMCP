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
/**
 * The list `result_ids` holds: the array a caller sends, or a JSON array sent as text (r25-field-snap, the field report of
 * 2026-11-19, #9). The gateway's served schema does not declare result_ids, so a client that is not told its type sends the
 * array as text, and AMCP's own next_call advertises the array form that client then fails to repeat. Text that is no JSON
 * array, and any other type, is refused for its shape and not for a count it does not have; the count and the ID rules
 * that follow are the same for both forms, and the filter is still only a view of the account's own list.
 */
function idList(value: unknown): unknown[] {
  let list: unknown = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      list = undefined;
    }
  }
  if (!Array.isArray(list))
    throw new MirrorError('INVALID_PARAMETER', 'result_ids must be a JSON array of 1-100 IDs, such as ["a","b"].', {
      field: 'result_ids',
      received: value === null ? 'null' : typeof value,
    });
  return list;
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
  const ids = idList(input.result_ids);
  if (ids.length < 1 || ids.length > 100)
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
