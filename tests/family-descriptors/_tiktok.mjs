// Shared synthetic TikTok API for Business v1.3 answers for the conformance descriptors (not a descriptor itself).
export const ok = data => ({json: {code: 0, message: 'OK', request_id: 'r', data}});
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
