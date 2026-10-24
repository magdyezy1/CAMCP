---
status: record
tier: engineering
---

# Business Profile lodging facts — 2026-09-28

Base revision: `9d2011e` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: the lodging facts of hotel listings (Wi-Fi, check-in and check-out times, room counts, pools,
pets, languages spoken, guest unit types and hundreds more) could be read but not changed through
AMCP: `UPDATE_LODGING` (`PATCH /v1/{name}` on the Lodging API) was a blocked write.

Contract source: the pinned Lodging API v1 Discovery document
(`.mirror/VENDOR/business-lodging-v1.json`, revision 20260902: `locations.updateLodging`,
`locations.getLodging`, `Lodging` and the 41 messages it holds) and the
[Lodging reference](https://developers.google.com/my-business/reference/lodging/rest/v1/Lodging),
read on 2026-09-28. The `updateMask` names the fields to update ("Use "*" to update all fields,
which may include unsetting empty fields in the request. Repeated field items cannot be
individually updated"); `metadata.updateTime` is "Required. The latest time at which the Lodging
data is asserted to be true in the real world", an RFC 3339 UTC "Zulu" timestamp; each fact and its
`...Exception` are one union ("can be only one of the following"); `allUnits`, `someUnits` and
`greenBuildingDesign` are output only; `languageCode` takes the listed codes.

## Change

New reviewed family `google_business_lodging` (`src/google-business-lodging.ts`):

| Part | Behaviour |
|---|---|
| Request | The exact `locations/{id}` grant; `updateMask` of 1–100 distinct lowerCamelCase paths, none below a repeated field or naming its parent too; the Lodging body with a value or `null` (clear) for each path and nothing outside the mask; `metadata: {updateTime}` in UTC, not in the future |
| Schema | Every value is checked against a table of the 42 lodging messages derived from the pinned document (booleans, int32 counts, TimeOfDay parts, the float living area, enums, languages, repeated messages replaced whole); a fact and its exception are never both set; guest units need codes and a label, and codes are unique; `"*"`, `name`, other metadata and output-only fields are refused |
| State | The location (Voice of Merchant, open status) and the lodging (`readMask=*`), which may not exist yet |
| Checks | Listings without Voice of Merchant, permanently closed locations and unchanged facts are refused |
| Scope | `src/scope.ts` accepts the validated edit and the marked reads of the same location |
| Safety | Lodging facts change no spending, so no spending confirmation (a preflight exemption keeps fields such as `bidet` from reading as bids) |
| Receipt | 200 with the lodging of the same location; anything else is a failure never resubmitted |
| Verification | The lodging read again, each masked fact compared (lists as sets, times of day with omitted zeros) |

The 100-path and 50-item bounds and the 100-character strings are AMCP's. New refusal code:
`INVALID_BUSINESS_LODGING_EDIT`. `tests/google-business-sync.test.ts` expects the Business Profile
contract version this batch raises. The test checks the schema table against the pinned document
wherever the document is present (release candidates carry it).

Other code: `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/preflight.ts` (spend pattern exemption), `src/review-state.ts`, `src/reviewed-routes.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (Business Profile contract version 11).
Guidance: a lodging section in `Skills/amcp-campaign-builder/references/dv360-and-measurement.md` and
an executable inspect example.

## Tests

`tests/google-business-lodging.test.mjs`, three tests:

1. Facts across connectivity, policies and property are set with the asserted time in the mask; a check-out time replaces its exception; the spoken languages are replaced; a built year is cleared; a bidet is set without spending confirmation; a location without lodging facts gets them; each verifies; a replay sends nothing.
2. Eighteen malformed edits (`"*"`, an unknown field, output-only fields, a repeated item path, a parent with its child, `name`, other metadata, a value outside the mask, a masked field without value, a wrong type, an unknown exception, hour 25, a negative count, both union members, a unit without label, a repeated unit code, an unaccepted language) and four metadata faults are refused before any request, and an undocumented query parameter by the compiler; a listing without Voice of Merchant, a permanently closed location and unchanged facts after reading; a connection without business.manage is refused.
3. An error reply and a reply for another location are never resubmitted; an ignored edit is not verified; the ledger lists the row in the family; the schema table matches the pinned document.

Red/green against a build of `9d2011e`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/google-business-lodging-20260927/red-check.log`.

## Verification

- Targeted: 223 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 2,162/2,162.
- Guidance coverage: 352 write-path refusals across 214 modules accounted for.
- Full qualification: see
  [GOOGLE-BUSINESS-LODGING-VERIFICATION-2026-09-28.json](GOOGLE-BUSINESS-LODGING-VERIFICATION-2026-09-28.json).

Remaining rows: 692 (one Business Profile row reviewed; Business Profile blocked writes 10 → 9).
Live acceptance is unverified; it needs the updated deployment and a hotel location grant with Voice
of Merchant. The reference does not say whether `metadata.updateTime` must also be in the mask;
AMCP always sends it and accepts it in the mask.
