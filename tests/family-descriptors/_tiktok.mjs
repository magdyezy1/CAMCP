// Shared synthetic TikTok API for Business v1.3 answers for the conformance descriptors (not a descriptor itself).
export const ok = data => ({json: {code: 0, message: 'OK', request_id: 'r', data}});
// A refusal TikTok declares in an HTTP 200 answer: a parameter code (40002) and empty data. It applied nothing, so AMCP
// rejects the review (package r25-m2-refusal, L1-07): the first execute is TikTok's own error (PLATFORM_ERROR) marked
// rejected, and its replay is WRITE_REJECTED. The descriptors whose partial mode answers with it name those two codes in
// `partialCodes`, and leave WRITE_OUTCOME_UNCERTAIN out on purpose: an uncertain outcome would replay as that code and fail.
export const failed = (message = 'Synthetic refusal') => ({json: {code: 40002, message, request_id: 'r', data: {}}});
/** A list answer; `more` declares a second page, as TikTok does with page_info.total_page. */
export const list = (rows, more) =>
  ok({
    list: rows,
    page_info: {page: 1, page_size: 100, total_number: rows.length + (more ? 100 : 0), total_page: more ? 2 : 1},
  });
/** Rows of `table` whose ID field is in the request's `filtering[ids]`. */
export function filtered(url, table, ids) {
  const filtering = JSON.parse(url.searchParams.get('filtering') ?? '{}'),
    wanted = filtering[ids];
  return Object.values(table)
    .filter(row => !wanted || wanted.includes(row[ids.slice(0, -1)]))
    .map(row => structuredClone(row));
}
