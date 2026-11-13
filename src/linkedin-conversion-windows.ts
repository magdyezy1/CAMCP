import {bad, fingerprint} from './workspace-core.js';
import type {JsonObject} from './types.js';

/**
 * RPT-07 (B18): LinkedIn attribution windows verified per conversion rule. The `linkedin_campaign_conversion` preset
 * reads analytics by campaign and conversion (statistics finder, CAMPAIGN and CONVERSION pivots) and, in the same
 * authorization bracket, the account's current conversion rules. Each conversion URN in the report is joined to its
 * rule's post-click and post-view windows:
 *  - every reported conversion has a rule and all rules share one window pair: `verified_per_rule`;
 *  - the rules use different window pairs: `mixed`, and no single window describes the report;
 *  - a reported conversion has no current rule (deleted or not owned) or a rule without both windows: `unknown`.
 * LinkedIn documents post-click and view-through windows of 1, 7 or 30 days (Conversion Tracking, li-lms-2026-09).
 */
export const linkedInConversionWindowSentinel = 'verified_per_rule';
export const linkedInConversionUrn = /^urn:lla:llaPartnerConversion:[1-9][0-9]{0,19}$/;
export type LinkedInWindowStatus = 'verified_per_rule' | 'mixed' | 'unknown';

const pair = (w: JsonObject) => w.post_click_days + 'd click / ' + w.post_view_days + 'd view';
/** An attribution is a retained setting of at most 200 characters (a monitor, a capture, a report option). */
const attributionLimit = 200;
const mixedWindows = 'LinkedIn conversion rules with mixed windows, no single window';

/** Joins reported conversion URNs to current rules. Pure: the reads and their bracket stay with the caller. */
export function linkedInConversionWindows(rules: JsonObject[], conversions: string[]) {
  if (!Array.isArray(rules) || !Array.isArray(conversions))
    bad('LinkedIn conversion windows need the reported conversions and current rules.', 'REPORT_SHAPE_CHANGED');
  const byUrn = new Map(rules.map(rule => [String(rule.urn), rule])),
    windows = [...new Set(conversions)].sort().map(urn => {
      if (!linkedInConversionUrn.test(urn))
        bad('LinkedIn returned a conversion pivot that is not a conversion rule URN.', 'REPORT_SHAPE_CHANGED');
      const rule = byUrn.get(urn),
        click = rule?.post_click_days,
        view = rule?.post_view_days,
        known = Number.isSafeInteger(click) && Number.isSafeInteger(view);
      return {
        conversion: urn,
        rule_id: rule?.id ?? null,
        name: rule?.name ?? null,
        post_click_days: known ? click : null,
        post_view_days: known ? view : null,
        // A rule missing from the current account read (deleted, shared or foreign) never inherits a window.
        status: known ? 'verified_per_rule' : 'unknown',
        reason: rule ? (known ? null : 'rule_window_missing') : 'rule_not_found',
      };
    });
  const known = windows.filter(w => w.status === 'verified_per_rule'),
    pairs = [...new Set(known.map(pair))].sort(),
    status: LinkedInWindowStatus =
      pairs.length > 1 ? 'mixed' : known.length === windows.length && windows.length ? 'verified_per_rule' : 'unknown';
  const attribution =
    status === 'verified_per_rule'
      ? 'LinkedIn conversion rules: ' +
        known[0]!.post_click_days +
        '-day post-click / ' +
        known[0]!.post_view_days +
        '-day post-view (verified per rule)'
      : status === 'mixed'
        ? // The pairs follow while the whole fits an attribution; an account can hold nine, and `distinct_windows` has them.
          (mixedWindows + ': ' + pairs.join('; ')).length <= attributionLimit
          ? mixedWindows + ': ' + pairs.join('; ')
          : mixedWindows
        : 'unknown';
  return {
    status,
    attribution,
    single_window:
      status === 'verified_per_rule'
        ? {post_click_days: known[0]!.post_click_days, post_view_days: known[0]!.post_view_days}
        : null,
    distinct_windows: pairs,
    unknown_conversions: windows.filter(w => w.status === 'unknown').map(w => w.conversion),
    windows,
    windows_fingerprint: fingerprint(windows),
    meaning:
      status === 'verified_per_rule'
        ? "Every reported conversion was joined to a current LinkedIn conversion rule with the same post-click and post-view windows. The rules were read in the same authorization bracket as the analytics response. Windows describe today's rule settings, not historical changes."
        : status === 'mixed'
          ? 'The reported conversions use rules with different attribution windows. No single window describes this report; declared single-window references and comparisons are refused.'
          : 'At least one reported conversion has no current rule (deleted, shared or not owned) or no stated window, so the windows cannot be verified.',
  };
}
