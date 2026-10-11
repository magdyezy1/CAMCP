// Shared synthetic Display & Video 360 API v4 answers for the conformance descriptors (not a descriptor itself).
export const scopes = ['https://www.googleapis.com/auth/display-video'];
/** A DV360 error answer, as Google APIs send it. */
export const error = (code, message, status) => ({json: {error: {code, message, status}}, status: code});
export const notFound = () => error(404, 'Not found', 'NOT_FOUND');
/** A list answer; `more` declares another page with nextPageToken, as every DV360 list does. */
export const list = (key, rows, more) => ({
  json: {[key]: structuredClone(rows), ...(more ? {nextPageToken: 'synthetic-next-page'} : {})},
});
