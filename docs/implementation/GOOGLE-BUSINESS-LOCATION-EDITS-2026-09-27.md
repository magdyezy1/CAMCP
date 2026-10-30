---
status: record
tier: engineering
---

# Business Profile location hours and contact details — 2026-09-27

Base revision: `b84a511` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: a location's hours, holiday hours, phones, website, labels and Google Ads phone could not be
changed through AMCP: `PATCH_LOCATION` (`PATCH /v1/{location}`) was a blocked write. Google Ads
location assets show these details and filter locations by their labels.

Contract source: the pinned Business Information API v1 Discovery document
(`.mirror/VENDOR/business-info-v1.json`: `locations.patch`, `locations.get`, Location,
BusinessHours, TimePeriod, SpecialHours, SpecialHourPeriod, PhoneNumbers, AdWordsLocationExtensions,
Metadata, OpenInfo), read on 2026-09-28. A patch "Updates the specified location" for the fields in
the required `updateMask`. Times are "00:00-24:00"; "The closing time must occur after the opening
time"; special hours "cannot be set without regular hours", a special period "must represent a range
of less than 24 hours" and its end date is "equal to or at most 1 day after" its start;
phone numbers: "During updates, both fields must be set", with up to two additional phones; labels
are "NOT user facing ... between 1-255 characters per label". Metadata tells whether the listing has
Voice of Merchant.

## Change

New reviewed family `google_business_location_edits` (`src/google-business-location-edits.ts`):

| Part | Behaviour |
|---|---|
| Request | The exact `locations/{id}` grant; `updateMask` of `regularHours`, `specialHours`, `phoneNumbers`, `websiteUri`, `labels` and/or `adWordsLocationExtensions`, and a body of exactly those fields, each checked against the schema (days, times, dates, spans, both phone fields, http(s) website, 1–255-character labels, one Ads phone) |
| State | The location: title, open status, Voice of Merchant and the six editable fields in one comparable form (omitted zero times as 00:00); not its pending-edit flag or links |
| Checks | Listings without Voice of Merchant and permanently closed locations are refused; special hours need regular hours; unchanged values are refused |
| Scope | `src/scope.ts` accepts the validated edit and its read for the selected location grant |
| Safety | Listing details change no spending, so no spending confirmation; the impact says when labels or the Ads phone affect Google Ads location assets |
| Receipt | 200 with the location; anything else is a failure never resubmitted |
| Verification | The location read again: the edited fields |

The title, address, categories, open status, profile, store code (unique within the account) and
service data stay out: they change what the listing claims or may trigger re-verification. The
50-period, 100-special-period and 50-label bounds are AMCP's. New refusal code:
`INVALID_BUSINESS_LOCATION_EDIT`.

Other code: `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/preflight.ts` (spend pattern exemption), `src/review-state.ts`, `src/reviewed-routes.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (Business Profile contract version 9).
Guidance: a location edit section in `Skills/amcp-campaign-builder/references/dv360-and-measurement.md`
and an executable inspect example.

## Tests

`tests/google-business-location-edits.test.mjs`, three tests:

1. Weekday and Saturday hours with a closed and a short holiday are set, then phones, website, labels and the Ads phone; both verify, with omitted zero minutes read as 00:00; a replay sends nothing.
2. Twelve malformed edits (a title, an open status, a store code, a period that closes when it opens, an unspecified day, 24:30, a 25-hour special period, February 30, only the primary phone, three additional phones, an ftp website, a 256-character label), a mask field missing from the body and validateOnly are refused before any request; a listing without Voice of Merchant, a permanently closed location and unchanged values are refused after reading; a connection without business.manage is refused.
3. An error reply is never resubmitted; an ignored edit is not verified; the ledger lists the row in the family.

Red/green against a build of `b84a511`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/google-business-location-edits-20260927/red-check.log`.

## Verification

- Targeted: 217 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 2,079/2,079.
- Guidance coverage: 349 write-path refusals across 211 modules accounted for.
- Full qualification: see
  [GOOGLE-BUSINESS-LOCATION-EDITS-VERIFICATION-2026-09-27.json](GOOGLE-BUSINESS-LOCATION-EDITS-VERIFICATION-2026-09-27.json).

Remaining rows: 696 (one Business Profile row reviewed; Business Profile blocked writes 12 → 11).
Live acceptance is unverified; it needs the updated deployment and a location grant with Voice of
Merchant.
