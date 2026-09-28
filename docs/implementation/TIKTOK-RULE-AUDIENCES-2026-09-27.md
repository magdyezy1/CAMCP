# TikTok audiences by rule — 2026-09-27

Base revision: `54e8dd1` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: retargeting on TikTok starts with an audience of past website visitors, ad engagers or lead
form users, created by rule. Only lookalikes and saved audiences could be created; the rule
creation row was a blocked write.

Contract source, read in the rendered TikTok API for Business documentation on 2026-09-27:
"Create an audience by rule" (`POST /v1.3/dmp/custom_audience/rule/create/`), "Get audience
details" and the Enumerations appendix ("Filter Value", "Lookback window"). Key facts:

- `audience_type` among nine types; event sources are pixel IDs for `PIXEL`, ad group IDs for
  `ENGAGEMENT` ("If not specified, all available event source IDs will be used") and none for
  `LEAD_GENERATION`. Rule sets use `OR`; each rule has one filter (`EVENT` `EQ` a value of the
  type's enumeration) and a lookback window of 7, 14, 30, 60, 90 or 180 days. Website rules may add
  `parameter_filters`: one URL filter and ten parameter filters, 1–10 values of up to 100
  characters each.
- `retention_in_days` 1–365 fixes the expiry; `is_auto_refresh` defaults to true; "Newly created
  audiences require at most 48 hours to be analyzed and processed". The reply carries
  `custom_audience_id`.
- The reference's own example filters on `PIXEL COMPLETE PAYMENT`, a value the enumeration does
  not list (it lists `COMPLETE PAYMENT`); AMCP follows the enumeration.

## Change

New reviewed family `tiktok_rule_audiences` (`src/tiktok-rule-audiences.ts`):

| Part | Behaviour |
|---|---|
| Request | Website traffic, ad engagement or lead generation audiences; name, sub type, expiry and refresh; 1–10 inclusion and 0–10 exclusion rules with the documented operators, lookback windows and per-type filter values; parameter filters for websites only. Other audience types and identity fields are refused |
| State | The advertiser's pixels (paged; names only), the named ad groups, or the advertiser itself when a rule names no event sources |
| Checks | Every pixel or ad group named belongs to the advertiser |
| Safety | A new audience reaches no one until an ad group uses it, so no spending confirmation |
| Receipt | A non-zero `code`, or a reply without a numeric `custom_audience_id`, is a failure never resubmitted |
| Verification | The new audience's details: name, type (for example `Website Audience`), sub type, ownership and refresh setting. The rule is not compared: TikTok returns it in its own format |

New refusal code: `INVALID_TIKTOK_RULE_AUDIENCE`; `STATE_NOT_FOUND` is reused.

Other code: `src/preflight.ts` (spending exemption), `src/write-review.ts`,
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`,
`src/reviewed-routes.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (TikTok
contract version 29). Guidance: "TikTok audiences by rule" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect example.

## Tests

`tests/tiktok-rule-audiences.test.mjs`, four tests:

1. A website audience (buyers over 50 on checkout pages or recent cart adders, excluding refund page visitors, fixed expiry, no auto refresh) is created after reading two pages of pixels and verifies; a replay sends nothing.
2. Engagement audiences of named ad groups and of all ad groups (the advertiser is read) and a Reach & Frequency lead audience are created and verify.
3. Eighteen malformed audiences (another advertiser, an app audience, identity fields, a long name, zero retention, a 45-day lookback, an engagement value on a website, the example-only value, missing or forbidden event sources, parameter filters on engagement, two URL filters, comparisons on URLs or text, two filters in a rule, AND, eleven rules, an unknown field) are refused before any request; a pixel or an ad group of another advertiser is refused after reading, without writes.
4. An error reply and a reply without an audience ID are never resubmitted; an ignored creation is not verified; the ledger lists the row in the family.

Red/green against a build of `54e8dd1`: all four tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/tiktok-rule-audiences-20260927/red-check.log`.

## Verification

- Targeted: 202 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,999/1,999.
- Guidance coverage: 337 write-path refusals across 199 modules accounted for.
- Full qualification: see
  [TIKTOK-RULE-AUDIENCES-VERIFICATION-2026-09-27.json](TIKTOK-RULE-AUDIENCES-VERIFICATION-2026-09-27.json).

Remaining rows: 720 (one TikTok row reviewed; TikTok blocked writes 170 → 169). Live acceptance is
unverified; it needs the updated deployment and a TikTok advertiser with a pixel.
