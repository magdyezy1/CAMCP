// Synthetic conversion rules, shaped from LinkedIn's Conversion Tracking reference (li-lms-2026-09), the account finder
// GET /rest/conversions?q=account that linkedInConversionEvidence reads (checked 2026-10-05, src/linkedin-conversion-evidence.ts):
// https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversion-tracking?view=li-lms-2026-09
// A rule states its post-click and its view-through window in days (`postClickAttributionWindowSize`,
// `viewThroughAttributionWindowSize`: 1, 7 or 30). A rule that states neither leaves them out.
export const linkedinConversionRule = (id, click = 30, view = 7, extra = {}) => ({
  id,
  account: 'urn:li:sponsoredAccount:100',
  name: 'Rule ' + id,
  enabled: true,
  type: 'PURCHASE',
  attributionType: 'LAST_TOUCH_BY_CONVERSION',
  postClickAttributionWindowSize: click,
  viewThroughAttributionWindowSize: view,
  ...extra,
});
/** A rule whose windows LinkedIn does not state. */
export const linkedinConversionRuleWithoutWindows = id =>
  linkedinConversionRule(id, undefined, undefined, {
    postClickAttributionWindowSize: undefined,
    viewThroughAttributionWindowSize: undefined,
  });
/** One page of the account finder, `count` rules to a page, with the documented offset paging and next link. */
export function linkedinConversionRulesPage(rules, start = 0, count = 100) {
  const next = start + count < rules.length;
  return {
    elements: rules.slice(start, start + count),
    paging: {
      start,
      count,
      total: rules.length,
      links: next ? [{rel: 'next', href: 'https://api.linkedin.com/rest/conversions?start=' + (start + count)}] : [],
    },
  };
}
