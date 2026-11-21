// Text a person could paste into a plan reference by mistake, and what counts as opaque, for the tests of package r25-field3-refs (the owner's
// second Google report of 2026-11-21, AMCP-02, F2-2; the fix round, the lead's review S3-1). A refusal of a reference repeats the step ID and the
// pointer it was given so that they can be corrected, and never text of another shape: a token, a digest, an identifier, a link.
//
// `opaque` states the rule in the test's own words, with no import from the code, so that a test using it cannot agree with the code by construction.
// `hostile` is one of each shape, all invented: nothing here is a real credential or ID.

/**
 * Text shaped like an opaque identifier or a credential: an alphanumeric run of 20 or more that mixes letters and digits, a hex run of 16 or more, a UUID,
 * or the start of a well-known token. A letters-only name of any length is a field name, not a secret: the build result
 * `assetGroupListingGroupFilterResult` has 34 characters, so a rule of "32 characters of any kind" would refuse a correct pointer.
 */
export const opaque = text =>
  (text.match(/[A-Za-z0-9]{20,}/g) ?? []).some(run => /[A-Za-z]/.test(run) && /[0-9]/.test(run)) ||
  /[0-9a-fA-F]{16,}/.test(text) ||
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.test(text) ||
  /(?:^|[^A-Za-z0-9])(?:ya29\.|EAA|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|eyJ|AIza|sk-|xox[abeprs]-)/.test(text);

/** One of each shape the lead's review named, none of which carries a `?` or a `:` (the first round's inputs all did, and so never reached the boundary). */
export const hostile = {
  'a 40-character hex token': 'a3f9c2e81b7d4f60a9e2c5b81d3f7a6e9c0b2d4f',
  'a UUID': 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6',
  // Built from two pieces so that no source line holds a whole token-shaped literal.
  'a GitHub-style token': 'ghp_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC2dE4fG6',
  'a JWT': ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJzeW50aGV0aWMifQ', 'c3ludGhldGljc2lnbmF0dXJlMDEyMzQ1Njc4OQ'].join('.'),
  'the header of a JWT': 'eyJhbGciOiJIUzI1NiJ9',
};

/** Whether a value, as the response carries it, holds the text. */
export const echoes = (value, text) => JSON.stringify(value).includes(text);
