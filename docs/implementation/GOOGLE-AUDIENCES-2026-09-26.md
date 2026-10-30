---
status: record
tier: engineering
---

# Google Ads audience signals — 2026-09-26

Base revision: `d21fb76` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes"
in the [2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). Performance Max and Demand Gen
signals point at `Audience` resources. Asset-group signals were already qualified, but the
audiences they reference could not be created or edited.

Contract sources:

- The v23 `Audience`, `AudienceOperation` and dimension/segment schemas in the pinned Google Ads Discovery document (`.mirror/VENDOR/google-ads-v23.json`, captured 2026-09-17):
  - `name` is required for customer scope, unique, 1–255 characters.
  - `dimensions` holds one-of age/gender/household income/parental status/audience segments.
  - `exclusionDimension` takes user lists.
  - `scope`: `ASSET_GROUP` requires `assetGroup` and forbids `name`.
  - `status` is output only.
  - Operations are create and update only.
  - Ages are 18/25/35/45/55/65 to 24/34/44/54/64; the pinned gender, income and parental enums apply.
- The [v23 audience GAQL field reference](https://developers.google.com/google-ads/api/fields/v23/audience), fetched directly on 2026-09-26. `dimensions` (repeated message), `exclusion_dimension`, `name`, `description`, `scope` and `status` are selectable; the nested segment resource names are not individually selectable. The field table is recorded in `tests/fixtures/google-configuration-fields-v23.json` with the HTML and extracted-text SHA-256.

## Contract

`google_ads_v23_audience_mutate_audiences` joins the existing reviewed
`google_configuration` family as a table entry (`audiences`), with record rules in the new
`src/google-audiences.ts`.

| Stage | Behaviour |
|---|---|
| Validation | Before any request, three layers apply. (1) The pinned Discovery schema refuses unknown fields, enums and types (`INVALID_VENDOR_BODY`). (2) The framework refuses missing `name`/`dimensions`, unmasked or immutable updates and the undocumented remove (`INVALID_CONFIGURATION_MUTATION`). (3) `INVALID_GOOGLE_AUDIENCE` refuses asset-group scope; a dimension without exactly one type, or a repeated type; documented ages only, with max above min; unique enum lists; boolean flags; and segments/exclusions that are not unique `customers/{selected}/…` resources of their documented collection. Exclusions must be user lists |
| Reads | Create reads the customer. Update reads the exact audience, frozen for the review (framework) |
| Impact | Create does not affect serving; an update may affect asset groups already using the audience and needs `spend_change_confirmed` (framework rule for signals and segments) |
| Receipt | Framework: one customer-scoped `audiences` resource name per operation |
| Verification | GAQL reads the audience. The request and the read-back are compared in canonical form (dimensions, ranges, segments and exclusions sorted; false `includeUndetermined` dropped, because ProtoJSON omits it). Reordering verifies; a changed value stays inconclusive |

Not qualified: asset-group-scoped audiences, scope upgrades, and anything touching segment
membership (user list uploads stay separate customer-data work).

Other code: `src/google-configuration-writes.ts` (table entry, record hook, canonical
expected/observed, serving rule), `src/provider-contracts.ts` (Google contract version 16,
reviewed 2026-09-26), `src/action-contracts.ts`. Guidance: "Audience signals" in
`Skills/amcp-campaign-builder/references/google-ads.md` and an executable inspect example.
Generated: `docs/CONTRACTS.md`, `ACTION-CONTRACT-COVERAGE.{csv,json}`,
`REMAINING-ACTIONS-2026-09-26.csv` (964 rows).

## Tests

- `tests/google-configuration-writes.test.ts` gains an `audiences` lifecycle case (create,
  verify, replay, masked update, verify; no remove). Its field-reference test now also
  covers every audience snapshot field.
- `tests/google-audiences.test.mjs` has four tests:
  1. 18 invalid audiences and a remove are refused before any request, with each refusal's layer pinned.
  2. The canonical form ignores order and omitted false flags but keeps a true flag.
  3. A create verifies despite reordered dimensions and ranges; an update reports serving impact, needs spend confirmation, and verifies.
  4. A changed age range reads back as inconclusive.

Red/green: against a build of `d21fb76` (with only the new helper import stubbed), the four
new tests, the audiences lifecycle case and the table-coverage count fail; the 52 existing
configuration tests pass. All pass with this change. Local log:
`.runtime/google-audiences-20260926/red-check.log`.

## Verification

- Targeted: 1104/1104 across 81 related suites, including every Google suite.
- Guidance coverage: 236 write-path refusals across 112 modules accounted for.
- Full qualification: see
  [GOOGLE-AUDIENCES-VERIFICATION-2026-09-26.json](GOOGLE-AUDIENCES-VERIFICATION-2026-09-26.json).

Live acceptance is unverified; it needs the updated deployment and a customer with existing
segments, which this batch does not authorize.
