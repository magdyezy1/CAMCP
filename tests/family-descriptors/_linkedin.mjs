// Shared synthetic LinkedIn Marketing API (li-lms) answers for the conformance descriptors (not a descriptor itself).
export const account = 'urn:li:sponsoredAccount:507';
/** A REST.li error answer. */
export const restliError = (status = 400, message = 'Synthetic refusal') => ({
  json: {status, serviceErrorCode: 100, code: 'ILLEGAL_ARGUMENT', message},
  status,
});
/** An empty answer with the given status (204 for PARTIAL_UPDATE and DELETE). */
export const empty = (status = 204, headers = {}) => new Response(null, {status, headers});
/** A collection answer; `more` declares another page, as LinkedIn does with paging.total or metadata.nextPageToken. */
export const elements = (rows, more, paging = 'total') => ({
  json: {
    elements: rows.map(r => structuredClone(r)),
    ...(paging === 'token'
      ? {metadata: more ? {nextPageToken: 'next'} : {}}
      : {paging: {start: 0, count: rows.length + (more ? 1 : 0), total: rows.length + (more ? 10 : 0), links: []}}),
  },
});
