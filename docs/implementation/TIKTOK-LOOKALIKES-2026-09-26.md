---
status: record
tier: engineering
---

# TikTok lookalike audiences — 2026-09-26

Base revision: `6521d0d` on `Codex-branch`, working copy `Downloads/CLaude workspace`. Push target: `magdyezy1/CAMCP` only. No live provider calls,
credentials, permissions, deployment or DNS changes were made. All evidence below is
synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes"
in the [2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). Prospecting campaigns target
lookalikes of existing audiences; TikTok lookalike creation was a blocked write. It uses an
existing seed and uploads no customer data.

Contract source: TikTok API for Business v1.3 reference, read in the rendered portal on
2026-09-26:

- [Create a lookalike audience](https://business-api.tiktok.com/portal/docs/create-a-lookalike-audience/v1.3). Name ≤128. `lookalike_spec` requires `source_audience_id` (not a lookalike; at least 100 people), `include_source`, `mobile_os`, `placements`, `location_ids` and `audience_size`. `audience_sub_type` is deprecated. The response returns `custom_audience_id`. Processing takes up to 48 hours. The page's own example still uses the v1.2 names `is_contain_source` and `system`.
- [Get audience details](https://business-api.tiktok.com/portal/docs/get-audience-details/v1.3): `audience_details` with `name`, `type`, `is_creator`, `owner_id`, `is_valid` and `cover_num`, plus `lookalike_spec`, which the documented example returns as `null`.
- [Enumerations](https://business-api.tiktok.com/portal/docs/enumerations-appendix/v1.3): Lookalike Locations (39 codes), Size (`NARROW`/`BALANCED`/`BROAD`) and System (`ALL`/`IOS`/`ANDROID`). No placement table exists; the create page names "TikTok, TopBuzz & BuzzVideo, Pangle", so only the unambiguous `TikTok` and `Pangle` are accepted.

## Contract

`tiktok_dmp_custom_audience_lookalike_create` is the new reviewed family
`tiktok_lookalikes` (`src/tiktok-lookalikes.ts`).

| Stage | Behaviour |
|---|---|
| Validation | Before any read, `INVALID_TIKTOK_LOOKALIKE` unless the request has only the documented v1.3 fields, a name of 1–128 characters, a numeric seed, a boolean `include_source`, and enumerated `mobile_os`, `placements`, `location_ids` and `audience_size`. v1.2 names, the deprecated sub type and customer-file fields are refused |
| Reads | Advertiser info and the seed from `/dmp/custom_audience/get/`, before review and again before execution. The seed read must return exactly the requested audience |
| Seed rules | The seed must be owned by this advertiser (`is_creator` and `owner_id`; otherwise `STATE_TARGET_MISMATCH`). It must also be available, not a lookalike, and meet the 100-person minimum (otherwise `INVALID_TIKTOK_LOOKALIKE`) |
| Review evidence | The seed's ID, type, ownership, availability and whether coverage meets 100. The daily-changing count, history and messages are excluded. The projection is idempotent, because a saved review is projected again at execution |
| Impact | `creative_impact` names the seed, size and locations. No delivery or spend until an ad group targets the audience |
| Receipt | `code: 0` and a numeric `data.custom_audience_id`. The generic TikTok create rule would have looked for `dmp_id` |
| Verification | `/dmp/custom_audience/get/` for the new ID compares `audience_id`, `name`, `type: "Lookalike Audience"` and `is_creator`. `lookalike_spec` is listed under `unobservable_fields` because TikTok documents it as possibly `null` |

Not qualified, and still blocked: lookalike update and refresh, customer-file create and
upload, audience deletion, sharing and application to ad groups.

Correction to the [Snapchat segments batch](SNAPCHAT-SEGMENTS-2026-09-26.md): its impact
listed `approximate_number_users`, which review normalization removes, so it was always
`null`. The field is removed; that record now says so.

Other code: `src/reviewed-routes.ts`; `src/write-review.ts` (shape, reads, seed-read
validation, receipt); `src/write-impact.ts`; `src/review-state.ts`;
`src/write-verification.ts`; `src/snapchat-segments.ts` (correction);
`src/provider-contracts.ts` (TikTok contract version 4); `src/action-contracts.ts`.
Guidance: "TikTok lookalike audiences" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect
example. Generated: `docs/CONTRACTS.md`, `ACTION-CONTRACT-COVERAGE.{csv,json}`,
`REMAINING-ACTIONS-2026-09-26.csv` (967 rows).

## Tests

`tests/tiktok-lookalikes.test.mjs`, eight tests:

1. Create inspects as reviewed with no network; update and file upload stay blocked.
2. 15 invalid requests are refused before any request, including the v1.2 names and an ambiguous placement.
3. An owned seed is read twice despite changing coverage and history; the audience is created once; name, type and ownership verify with `lookalike_spec` unobservable; replay makes no second POST.
4. The seed evidence projection is idempotent and keeps only the 100-person fact.
5. Shared (`STATE_TARGET_MISMATCH`), lookalike, unprocessed and 60-person seeds, and a missing seed, are refused before any write.
6. A different name reads back as inconclusive.
7. A TikTok-declared error, an empty receipt and a lost response each POST only once.
8. Concurrent execution submits once; a fresh service replays and verifies.

Development failures that shaped the design: the first impact read raw provider rows, but
impact receives the normalized review state. The first projection was not idempotent, so a
saved review was refused as `STATE_CHANGED` at execution; the new idempotency test pins
both. The same normalized-state review found the Snapchat segment correction above.

Red/green: see the qualification record.

## Verification

Full qualification: see
[TIKTOK-LOOKALIKES-VERIFICATION-2026-09-26.json](TIKTOK-LOOKALIKES-VERIFICATION-2026-09-26.json).
Live acceptance is unverified; it needs the updated deployment and an owned, available
seed, which this batch does not authorize.
