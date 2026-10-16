// Shared synthetic Display & Video 360 API v4 answers for the conformance descriptors (not a descriptor itself).
export const scopes = ['https://www.googleapis.com/auth/display-video'];
/** A DV360 error answer, as Google APIs send it. */
export const error = (code, message, status) => ({json: {error: {code, message, status}}, status: code});
export const notFound = () => error(404, 'Not found', 'NOT_FOUND');
/**
 * A list answer. With `more`, every page declares another one with a fresh nextPageToken, as DV360 lists do, so a
 * reader that follows tokens meets its page bound and one that reads a single page meets the token. Rows come on the
 * first page only.
 */
export function list(key, rows, more, url) {
  const page = Number(url?.searchParams.get('pageToken') ?? 0);
  return {
    json: {
      ...(page === 0 ? {[key]: structuredClone(rows)} : {}),
      ...(more ? {nextPageToken: String(page + 1)} : {}),
    },
  };
}
