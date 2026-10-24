---
status: record
tier: engineering
---

# Business Profile location attributes — 2026-09-27

Base revision: `ee25dfa` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: location attributes (Wi-Fi, payment types, menu and booking links and the like) could be read
but not changed through AMCP: `UPDATE_LOCATION_ATTRIBUTES` (`PATCH /v1/{location}/attributes`) was
a blocked write.

Contract source: the pinned Business Information API v1 Discovery document
(`.mirror/VENDOR/business-info-v1.json`: `locations.updateAttributes`, `locations.getAttributes`,
`attributes.list`; Attributes, Attribute, AttributeMetadata, RepeatedEnumAttributeValue,
UriAttributeValue), read on 2026-09-28. The `attributeMask` names the attributes to update; "If you'd
like to delete certain attributes, they must be specified in the attribute_mask with no matching
entry in the attributes list". Values follow the attribute's type (values, uriValues or
repeatedEnumValue); `attributes.list` with `parent` returns the attributes available to the
location with their value type, repeatability, deprecation ("updates will not be saved") and
supported values.

## Change

New reviewed family `google_business_location_attributes`
(`src/google-business-location-attributes.ts`):

| Part | Behaviour |
|---|---|
| Request | The exact `locations/{id}` grant; `attributeMask` of 1–50 distinct `attributes/{attribute}` names; `{name: "locations/{id}/attributes", attributes}` with at most one entry per masked attribute and exactly one value field each; masked attributes without an entry are cleared |
| State | The location (open status, Voice of Merchant), its attributes and the attributes available to it (paged, ten pages of 200) |
| Checks | Each attribute is available and not deprecated; values match the metadata type and supported values; a URL takes one value unless repeatable; listings without Voice of Merchant, permanently closed locations and unchanged values are refused |
| Scope | `src/scope.ts` accepts the validated edit and the marked reads of the same location |
| Safety | Attributes change no spending, so no spending confirmation; the impact names the attributes set and cleared |
| Receipt | 200 with the location attributes; anything else is a failure never resubmitted |
| Verification | The attributes read again: set values, and cleared attributes absent |

The 50-attribute and 10-URL bounds are AMCP's. New refusal code:
`INVALID_BUSINESS_LOCATION_ATTRIBUTE`. `tests/google-business-sync.test.ts` expects the Business
Profile contract version this batch raises.

Other code: `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/preflight.ts` (spend pattern exemption), `src/review-state.ts`, `src/reviewed-routes.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (Business Profile contract version 10).
Guidance: a location attribute section in
`Skills/amcp-campaign-builder/references/dv360-and-measurement.md` and an executable inspect example.

## Tests

`tests/google-business-location-attributes.test.mjs`, three tests:

1. BOOL, ENUM and REPEATED_ENUM attributes are set, a URL attribute is cleared and then set again; each verifies; a replay sends nothing.
2. Eight malformed edits (a name without `attributes/`, an attribute outside the mask, two value fields, a read-only value type, two values, an ftp URL, a value set and unset, a repeated attribute) are refused before any request; an unavailable, a deprecated, a mistyped enum, a mistyped bool, a repeated URL, an unknown repeated enum value, unchanged values and a listing without Voice of Merchant are refused after reading; a connection without business.manage is refused.
3. An error reply is never resubmitted; an ignored edit is not verified; the ledger lists the row in the family.

Red/green against a build of `ee25dfa`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/google-business-location-attributes-20260927/red-check.log`.

## Verification

- Targeted: 218 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 2,082/2,082.
- Guidance coverage: 350 write-path refusals across 212 modules accounted for.
- Full qualification: see
  [GOOGLE-BUSINESS-LOCATION-ATTRIBUTES-VERIFICATION-2026-09-27.json](GOOGLE-BUSINESS-LOCATION-ATTRIBUTES-VERIFICATION-2026-09-27.json).

Remaining rows: 695 (one Business Profile row reviewed; Business Profile blocked writes 11 → 10).
Live acceptance is unverified; it needs the updated deployment and a location grant with Voice of
Merchant.
