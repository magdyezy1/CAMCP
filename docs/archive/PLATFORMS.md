---
status: archived
tier: engineering
---

# Platform contracts, workflows and integration

**Archived on 2026-10-22** (DOC-03, owner decision P12): kept as it was written, with links to current addresses.
Current per-platform facts are in the generated [contracts](../CONTRACTS.md) and the
[action ledger](../implementation/ACTION-CONTRACT-COVERAGE.json).

**Historical platform comparison.** The table below is the 29 September batch-34 snapshot. Current local route
classification comes from the generated [action ledger](../implementation/ACTION-CONTRACT-COVERAGE.json) and
[contracts](../CONTRACTS.md); the [October implementation matrix](../review/IMPLEMENTATION-2026-10-01.md) records current
workflow additions and limits. Neither record establishes current account-specific provider acceptance.

Status on 2026-09-29 (batch 34), from the code and the pinned evidence only: the action ledger
(`docs/implementation/ACTION-CONTRACT-COVERAGE.json`), `src/provider-contracts.ts`, `src/spend-policy.ts`
(`activationFields`), `src/report-metrics.ts` (`metricSources`), the pinned vendor documents in `.mirror/VENDOR/` and
the findings in [FINDINGS.md](../review/FINDINGS.md). Nothing here was checked against a live account: every ledger row is
`live_qualification: unverified`, and this review made no provider calls.

## Summary

Ledger columns count native routes. *Reviewed* routes belong to a reviewed write family (inspect → prepare → execute →
verify); *blocked* routes are writes AMCP refuses; *registered* counts families declared through the typed
registry (`src/reviewed-families.ts`): every family since batch 33.

| Platform | API pinned | Reads | Reviewed (families, registered) | Blocked | Activation field | Primary conversions in reports | Lifecycle |
|---|---|---|---|---|---|---|---|
| Google Ads | v25 | 173 | 216 (26, 26) | 49 | `status` ENABLED | `metrics.conversions` | on v25 since batch 14; v25 sunsets 2027-08 (F-49) |
| Meta | v26.0 | 420 | 55 (14, 14) | 111 | `status` ACTIVE | leads, installs or purchases by objective; empty otherwise | on v26.0 since batch 15, available until "TBD"; v25.0 kept as a fallback (F-52) |
| TikTok | v1.3 | 313 | 70 (28, 28) | 165 | `operation_status` ENABLE | `conversion` (the ad group's optimization event) | no dated sunset recorded |
| Snapchat | v1 | 271 | 60 (10, 10) | 62 | `status` ACTIVE | installs, sign-ups or purchases by objective | one version, v1; no end announced (checked 2026-09-29) |
| LinkedIn | 202609 | 146 | 54 (17, 17) | 77 | `status` ACTIVE (creatives: `intendedStatus`) | `externalWebsiteConversions` | monthly versions; on 202609 since batch 32 (F-53) |
| X Ads | 12 | 96 | 56 (14, 14) | 33 | `entity_status` ACTIVE | not reported | end of life "TBD" (checked 2026-09-29) |
| DV360 | v4 | 78 | 62 (16, 16) | 29 | `entityStatus` ENTITY_STATUS_ACTIVE | — (no DV360 report source) | no deprecation announced |
| Microsoft Ads | v13 | 14 | 14 (2, 2) | — | `Status` Active | `Conversions` | SOAP deprecated 2027-01-31; AMCP sends REST, pinned from Microsoft Learn (F-50, batch 32) |
| Apple Ads | v1 | 20 | 21 (2, 2) | — | `status` ENABLED | `totalInstalls` | Platform API: no end published; the Campaign Management API (not sent) sunsets 2027-01-26 (checked 2026-09-29) |
| Reddit | v3 | 38 | 13 (2, 2) | — | `configured_status` ACTIVE | not reported (purchases are) | onsite lead-form creation withdrawn 2026-09-21; ads using those forms paused by Reddit on 2026-09-30 |
| Criteo Retail Media | 2026-07 | 51 | 34 (11, 11) | 23 | `status` active, scheduled | — | 2026-07 support can end from 2027-07 by the 12-month policy (F-51, moved in batch 32) |
| Google Business Profile | v1 | 28 | 14 (6, 6) | 9 | public place links | — | — |
| GA4 | v1beta / v1alpha | 16 | 2 (1, 1) | — | none (no delivery) | `keyEvents` | alpha surfaces can change without notice |
| GTM | v2 | 38 | 64 (3, 3) | — | none | — | — |
| Search Console | v3 / v1 | 6 | 4 (1, 1) | — | none | — | — |

Reads outnumber reviewed writes on every advertising platform; the blocked writes are refused on purpose (no
qualified contract), not missing work; [COVERAGE.md](../review/COVERAGE.md) sorts them by the decision each needs. Adjust (29 routes, reporting only) and Amazon (catalog-dependent, delegated)
have no reviewed writes. TikTok lists 313 reads since SEC-04 (wave 1 review): its three lead reads (`/v1.3/lead/get/`,
`/v1.3/page/lead/task/download/`, `/v1.3/page/lead/mock/get/`) are refused as personal data and now count as
unqualified reads in the ledger.

## What is the same on every platform

- **One write workflow.** `amcp_write inspect` names the family and what it needs; `prepare` reads the current
  state, returns the impact and a 5-minute review; `execute` re-reads, refuses `STATE_CHANGED`, claims the
  idempotency key and sends exactly one mutation; `amcp_campaign verify` reads the result back. Plans
  (`amcp_campaign`) chain these steps and, since batch 2, pass `account_id` only to tools whose schema declares it and
  re-prepare a step whose review expired.
- **Three spending checks** apply regardless of platform: structural (numeric statuses, delivery-field edits of
  campaigns, ad groups and line items), family-declared confirmations, and the generic budget/bid/status text match
  (see [ADDING-A-REVIEWED-FAMILY.md](../ADDING-A-REVIEWED-FAMILY.md#spending)).
- **Owner policies** use each platform's activation field (table above) and native budget fields. GA4, GTM and Search
  Console have no activation contract because they do not deliver ads; an `allow_activation=false` policy refuses
  writes on any other platform without one.
- **Reports** normalize each platform's rows to shared metrics and keep native numeric fields as `native_<platform>_…`.
  Since this batch the reporting view and the evidence download show which native field feeds each shared metric
  (`metricSources`), because "conversions" is a different measure on every platform; a test keeps that table equal to
  the normalization code.

## Platform notes

**Google Ads.** The largest surface (216 reviewed routes, 26 families). Customer labels can be removed since batch 33
(applying one stays refused: v25 marks both of its fields output only; F-58). On v25 since batch 14 (F-49): the families were
rechecked against the v25 contract, and the seven names whose operation v25 removed (lifecycle goals, campaign-level
brand safety) are refused with their replacement ([the migration record](../implementation/GOOGLE-ADS-V25-2026-09-28.md)). Numeric enum values in writes are refused since batch 1, so a changed enum number cannot slip
through.

**Meta.** Broad reads (420) with writes limited to 14 families; library videos no creative uses can be removed since
batch 33 (F-58). On Graph v26.0 since batch 15 (F-52): Meta's official
SDK at 26.0.2 keeps every catalog request AMCP could compare and removes nothing AMCP sends
([the migration record](../implementation/META-V26-2026-09-28.md)); `AMCP_META_API_VERSION=v25.0` moves back. The
v26.0 changelog's refusals (Explore placement, poll components, the Advantage+ Audience choice of special-category ad
sets) are refused before any request, and the shop destination default is said in the review (F-113). Reports count conversions only for lead, app-install and sales objectives; traffic and
awareness campaigns show an empty conversions column by design.

**TikTok.** The most families (28) and the most blocked writes (165); pixels can be created and renamed since batch 34. Smart+ and Upgraded Smart+ flows are reviewed
families with their own budget handling. `conversion` in reports is the optimization event of each ad group, so it
is not comparable across ad groups optimizing for different events.

**Snapchat.** Nested campaign/ad squad/ad updates run through `snapchat_nested_updates` with mandatory spend
confirmation. Its families are all registered (batches 31 and 33); only the entity routes use the gateway's generic
path. An ad squad's `lifetime_budget_micro` is held to the owner's caps in native micros, the unit Snapchat's ad
squad reference gives it (F-55, batch 33).

**LinkedIn.** One version source since batch 2 (`linkedinVersion()`); AMCP sends `202609` since batch 32, after a
review of LinkedIn's changes for 202606–202609 (F-53). Audience Insights and Media Planning run as reads since batch 34; the
unscoped `/rest/creatives` and `/rest/adCampaigns` routes stay blocked and name the account-scoped actions. Ten unversioned Marketing routes (`adCampaignsV2`, `adCreativesV2`, `dmpSegments`,
`organizationalEntityAcls`) are withdrawn with their versioned replacements named (F-58, batch 31).

**X Ads.** v12 across 14 families including entity batches, tracking tags and media library. Reports carry spend,
impressions, clicks, engagements and video views; X has no conversion metric in AMCP reports.

**DV360.** 16 families, all registered (batch 33); each declares the display-video write scope through its own scope
hook (`src/dv360-scope.ts`). Its pinned discovery document is
sealed since batch 5 (F-72).

**Microsoft Advertising.** AMCP sends v13 REST requests. Since batch 32 each operation's REST method, URL and request
fields are pinned from Microsoft Learn and checked when a request is compiled (F-50); the v13 WSDLs remain the type
model. Microsoft deprecates SOAP on 2027-01-31, which AMCP does not send.

**Criteo Retail Media.** 11 families on the 2026-07 contract since batch 32 (F-51), pinned from Criteo's official
document; the report family now uses 2026-07's performance report, and the campaign family its balance page. Criteo's
12-month policy lets 2026-07 end from July 2027. Two families (catalog requests, budget overrides) keep
their authorizers in the ordered scope chain because they must run before the generic qualified-read check.

**Reddit.** Classic campaign and creative writes. Spend arrives in micros and purchase value in cents; the metric-source
table in the reporting view names both divisors. Onsite lead-form creation ended on 2026-09-21 and is refused; Reddit pauses the
existing ads that use those forms on 2026-09-30, so any running lead-form campaign needs an external form before then.

**Apple Ads, GA4, GTM, Search Console, Google Business Profile.** Small, well-bounded surfaces. GA4 uses v1alpha for
some data endpoints, which Google can change without notice; Business Profile place links count as activation
because they have no paused state.

## Integration health

| Check | State | Gap |
|---|---|---|
| Pinned vendor documents | 22 in `.mirror/VENDOR/` (Google Ads, Business Profile ×7, Criteo, DV360, GA4 ×3, GTM, Microsoft ×6, Reddit, Search Console) | All 22 sealed with `document_sha256` since batch 5 (7 were before, F-72); Meta, TikTok, Snapchat, LinkedIn, X and Apple have no pinned document and rely on captured catalogs and cited documentation |
| Drift job | `tools/provider-drift.ts --live` compares public schemas with the pinned ones | Fails weekly and only uploads an artifact; no issue is opened (F-56) |
| Lifecycle pages | `.mirror/VENDOR/lifecycle-pages.json` hashes release-note pages | No dated sunset registry or alarm (F-56) |
| Live qualification | none recorded for any route | Owner-run sandbox qualification (`npm run test:sandbox`) per platform |

## Recommendations, in order

1. Decide the Microsoft REST evidence (2027-01-31), which has a hard date inside the next five months. (Google Ads moved
   to v25 in batch 14.)
2. Add a dated sunset registry with a 90-day alarm and make the drift job open an issue on change (F-56).
3. Pin public schemas for the platforms that have none, where the vendor publishes one (every pinned document is
   sealed since batch 5, F-72).
4. Criteo moved to 2026-07 in batch 32 (F-51); Meta moved to v26.0 in batch 15.
5. LinkedIn moved to 202609 in batch 32 (F-53).
6. Finish the registry migration so every platform's families are declared in one place (ROADMAP P2).
