// Shared synthetic Snapchat Marketing API v1 answers for the conformance descriptors (not a descriptor itself).
let n = 0;
/** A successful answer: Snapchat wraps every list in {request_status, request_id, <collection>: [...]}. */
export const ok = body => ({json: {request_status: 'SUCCESS', request_id: 'r' + ++n, ...body}});
/** A failed write: the request and every row report ERROR. */
export const failed = (collection, sent = [{}]) => ({
  json: {
    request_status: 'ERROR',
    request_id: 'r' + ++n,
    [collection]: sent.map(() => ({sub_request_status: 'ERROR', sub_request_error_reason: 'Synthetic refusal'})),
  },
});
/** Rows of a collection as Snapchat lists them: [{sub_request_status, <entity>: {...}}]. */
export const rows = (entity, list) => list.map(x => ({sub_request_status: 'SUCCESS', [entity]: structuredClone(x)}));
/**
 * A list answer. With `more`, Snapchat declares a next page (paging.next_link with a fresh cursor) on every page, so a
 * reader that follows cursors meets its page bound and one that reads a single page meets the link.
 */
export function page(collection, entity, list, more, url) {
  const cursor = Number(url?.searchParams.get('cursor') ?? 1);
  return ok({
    [collection]: rows(entity, cursor === 1 ? list : []),
    ...(more ? {paging: {next_link: 'https://adsapi.snapchat.com/v1/next?cursor=' + (cursor + 1)}} : {}),
  });
}
/** The selected ad account, with the organization Snapchat reports for it. */
export const adAccount = (id, organization = 'org-1', extra = {}) =>
  ok({
    adaccounts: rows('adaccount', [
      {id, name: 'Synthetic', organization_id: organization, currency: 'USD', timezone: 'UTC', ...extra},
    ]),
  });
