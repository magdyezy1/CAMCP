// Shared synthetic Meta Marketing API v26.0 answers for the conformance descriptors (not a descriptor itself).
export const v = '/v26.0';
/** The error Graph answers for a node or edge it does not know. */
export const unsupported = () => ({
  json: {error: {message: 'Unsupported get request.', type: 'GraphMethodException', code: 100, error_subcode: 33}},
  status: 400,
});
/** Meta form fields arrive as text; JSON-valued fields are decoded as Meta decodes them. */
export const decode = body =>
  Object.fromEntries(
    Object.entries(body && typeof body === 'object' ? body : {}).map(([k, value]) => {
      try {
        return [k, JSON.parse(value)];
      } catch {
        return [k, value];
      }
    }),
  );
/**
 * Cursor pages of two rows from `after`, for a family that reads an edge to its end. `endless` names another page every
 * time (empty after the first), a list that never completes within the family's page bound.
 */
export const paged = (rows, url, endless) => {
  const at = Number(url.searchParams.get('after') ?? 0),
    next = endless ? at + 1 : at + 2 < rows.length ? at + 2 : undefined;
  return {
    json: {
      data: structuredClone(endless && at ? [] : rows.slice(at, at + 2)),
      paging: {
        cursors: {before: String(at), after: String(next ?? at + 2)},
        ...(next !== undefined ? {next: 'https://graph.facebook.com' + url.pathname + '?after=' + next} : {}),
      },
    },
  };
};
/** An edge answer; `more` declares another page, as Graph does with paging.next. */
export const edge = (path, rows, more) => ({
  json: {
    data: rows.map(r => structuredClone(r)),
    ...(more ? {paging: {cursors: {after: 'x'}, next: 'https://graph.facebook.com' + path + '?after=x'}} : {}),
  },
});
