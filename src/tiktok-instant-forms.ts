import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Published Instant Forms of the selected advertiser, per API for Business v1.3 "Get the Page ID" (checked
 * 2026-09-26). /page/get/ cannot filter by page ID, so the review reads the advertiser's published LEAD_GEN pages page
 * by page, up to maxPages pages of 100, and finds the form among them. Business Center form libraries (library_id) are
 * outside the advertiser boundary and never read here.
 */
export const tiktokPagesPath = '/v1.3/page/get/';
const maxPages = 10,
  pageSize = 100;
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const formsRead = (read: CompiledRequest) =>
  read.gateway === 'tiktok_native_action' &&
  read.path === tiktokPagesPath &&
  read.query?.business_type === 'LEAD_GEN' &&
  read.query?.status === 'PUBLISHED';

export function tiktokInstantFormRead(accountId: string | undefined, page = 1) {
  return {
    path: tiktokPagesPath,
    query: {advertiser_id: accountId, business_type: 'LEAD_GEN', status: 'PUBLISHED', page, page_size: pageSize},
    action: 'tiktok_page_get',
  };
}
/** After the first page, the remaining pages, up to the cap; a longer list is refused in the prerequisite check. */
export function tiktokInstantFormFollowUps(read: CompiledRequest, data: unknown): CompiledRequest[] {
  if (!formsRead(read) || read.query.page !== 1 || !obj(data) || !obj(data.data) || !obj(data.data.page_info))
    return [];
  const total = Number(data.data.page_info.total_page);
  if (!Number.isInteger(total) || total <= 1) return [];
  return Array.from({length: Math.min(total, maxPages) - 1}, (_, i) => ({
    ...read,
    query: {...read.query, page: i + 2},
  }));
}
export function validateTiktokInstantFormState(read: CompiledRequest, data: JsonObject): boolean {
  if (!formsRead(read)) return false;
  const info = data.data?.page_info;
  if (
    data.code !== 0 ||
    !Array.isArray(data.data?.list) ||
    !obj(info) ||
    Number(info.page) !== Number(read.query.page) ||
    data.data.list.length > pageSize
  )
    throw new MirrorError(
      'STATE_READ_FAILED',
      'TikTok must return the requested page of published Instant Forms with its page information.',
    );
  return true;
}
/** Review state: the page number, the page count and each form's ID and status; preview links and thumbnails are left out. */
export function tiktokInstantFormState(read: CompiledRequest, d: JsonObject): JsonObject | undefined {
  if (!formsRead(read)) return;
  if (obj(d.data) && obj(d.data.instant_forms)) return {data: {instant_forms: d.data.instant_forms}};
  if (!Array.isArray(d.data?.list)) return;
  return {
    data: {
      instant_forms: {
        page: Number(read.query.page),
        total_page: Number(d.data.page_info?.total_page ?? 1),
        forms: d.data.list
          .map((p: JsonObject) => ({page_id: String(p?.page_id), status: p?.status ?? null}))
          .sort((a: JsonObject, b: JsonObject) => (a.page_id < b.page_id ? -1 : a.page_id > b.page_id ? 1 : 0)),
      },
    },
  };
}
/** The form must be one of the advertiser's published Instant Forms, found within the pages read. */
export function tiktokInstantFormCheck(
  pageId: string,
  values: unknown[],
  invalid: (field: string, message: string) => never,
): void {
  const pages = values
    .map(v => (obj(v) && obj(v.data) && obj(v.data.instant_forms) ? v.data.instant_forms : undefined))
    .filter((p): p is JsonObject => !!p);
  if (!pages.length) throw new MirrorError('STATE_READ_FAILED', 'The Instant Forms of the advertiser were not read.');
  const total = Math.max(...pages.map(p => Number(p.total_page)));
  const form = pages.flatMap(p => p.forms as JsonObject[]).find(f => f.page_id === pageId);
  if (!form && total > maxPages)
    invalid(
      'page_list',
      'The advertiser has more than ' +
        maxPages * pageSize +
        ' published Instant Forms, more than this review reads; form ' +
        pageId +
        ' was not among them.',
    );
  if (!form)
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'Instant Form ' + pageId + ' is not a published Instant Form of the selected advertiser.',
      {page_id: pageId},
    );
}
