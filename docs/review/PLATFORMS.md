# Platform contracts, workflows and integration

Status on 2026-09-28, from the code and the pinned evidence only: the action ledger
(`docs/implementation/ACTION-CONTRACT-COVERAGE.json`), `src/provider-contracts.ts`, `src/spend-policy.ts`
(`activationFields`), `src/report-metrics.ts` (`metricSources`), the pinned vendor documents in `.mirror/VENDOR/` and
the findings in [FINDINGS.md](FINDINGS.md). Nothing here was checked against a live account: every ledger row is
`live_qualification: unverified`, and this review made no provider calls.

## Summary

Ledger columns count native routes. *Reviewed* routes belong to a reviewed write family (inspect → prepare → execute →
verify); *blocked* routes are writes AMCP refuses; *registered* counts families already declared through the typed
registry (`src/reviewed-families.ts`).

| Platform | API pinned | Reads | Reviewed (families, registered) | Blocked | Activation field | Primary conversions in reports | Lifecycle |
|---|---|---|---|---|---|---|---|
| Google Ads | v25 | 173 | 212 (23, 8) | 53 | `status` ENABLED | `metrics.conversions` | on v25 since batch 14; v25 sunset date not read (F-49) |
| Meta | v26.0 | 420 | 54 (13, 6) | 112 | `status` ACTIVE | leads, installs or purchases by objective; empty otherwise | on v26.0 since batch 15; v25.0 kept as a fallback (F-52) |
| TikTok | v1.3 | 316 | 68 (27, 7) | 167 | `operation_status` ENABLE | `conversion` (the ad group's optimization event) | no dated sunset recorded |
| Snapchat | v1 | 271 | 60 (10, 0) | 66 | `status` ACTIVE | installs, sign-ups or purchases by objective | no dated sunset recorded |
| LinkedIn | 202605 | 146 | 54 (17, 9) | 87 | `status` ACTIVE (creatives: `intendedStatus`) | `externalWebsiteConversions` | monthly versions; 12 modules cite li-lms-2026-09 (F-53) |
| X Ads | 12 | 96 | 56 (14, 4) | 33 | `entity_status` ACTIVE | not reported | no dated sunset recorded |
| DV360 | v4 | 78 | 62 (16, 4) | 29 | `entityStatus` ENTITY_STATUS_ACTIVE | — (no DV360 report source) | no dated sunset recorded |
| Microsoft Ads | v13 | 14 | 14 (2, 0) | — | `Status` Active | `Conversions` | SOAP fully deprecated 2027-01-31; evidence is SOAP WSDL for a JSON transport (F-50) |
| Apple Ads | v1 | 20 | 21 (2, 0) | — | `status` ENABLED | `totalInstalls` | no dated sunset recorded |
| Reddit | v3 | 38 | 13 (2, 0) | — | `configured_status` ACTIVE | not reported (purchases are) | onsite lead-form creation withdrawn 2026-09-21; ads using those forms paused by Reddit on 2026-09-30 |
| Criteo Retail Media | 2026-01 | 51 | 34 (11, 0) | 23 | `status` active, scheduled | — | 2026-01 end of life ≈ 2027-01 by the 12-month policy (F-51) |
| Google Business Profile | v1 | 28 | 14 (6, 3) | 9 | public place links | — | — |
| GA4 | v1beta / v1alpha | 16 | 2 (1, 0) | — | none (no delivery) | `keyEvents` | alpha surfaces can change without notice |
| GTM | v2 | 38 | 64 (3, 0) | — | none | — | — |
| Search Console | v3 / v1 | 6 | 4 (1, 0) | — | none | — | — |

Reads outnumber reviewed writes on every advertising platform; the blocked writes are refused on purpose (no
qualified contract), not missing work. Adjust (29 routes, reporting only) and Amazon (catalog-dependent, delegated)
have no reviewed writes.

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

**Google Ads.** The largest surface (212 reviewed routes, 23 families). On v25 since batch 14 (F-49): the families were
rechecked against the v25 contract, and the seven names whose operation v25 removed (lifecycle goals, campaign-level
brand safety) are refused with their replacement ([the migration record](../implementation/GOOGLE-ADS-V25-2026-09-28.md)). Numeric enum values in writes are refused since batch 1, so a changed enum number cannot slip
through.

**Meta.** Broad reads (420) with writes limited to 13 families. On Graph v26.0 since batch 15 (F-52): Meta's official
SDK at 26.0.2 keeps every catalog request AMCP could compare and removes nothing AMCP sends
([the migration record](../implementation/META-V26-2026-09-28.md)); `AMCP_META_API_VERSION=v25.0` moves back. Reports count conversions only for lead, app-install and sales objectives; traffic and
awareness campaigns show an empty conversions column by design.

**TikTok.** The most families (27) and the most blocked writes (167). Smart+ and Upgraded Smart+ flows are reviewed
families with their own budget handling. `conversion` in reports is the optimization event of each ad group, so it
is not comparable across ad groups optimizing for different events.

**Snapchat.** Nested campaign/ad squad/ad updates run through `snapchat_nested_updates` with mandatory spend
confirmation. None of its ten families is registered yet: their assertions run after the method-override check, so
they move in pass 2. `lifetime_budget_micro` stays refused under numeric owner policies until a vendor document names
its unit (F-55, fail-closed).

**LinkedIn.** One version source since batch 2 (`linkedinVersion()`), still `202605` while twelve modules cite the
2026-09 documentation; moving to `202609` is an owner decision that needs a read-only review of the changed fields
(F-53). Nineteen legacy routes are candidates for reclassification (F-58).

**X Ads.** v12 across 14 families including entity batches, tracking tags and media library. Reports carry spend,
impressions, clicks, engagements and video views; X has no conversion metric in AMCP reports.

**DV360.** 16 families, four registered. The display-video write scope is still one gateway-level check that lists
the DV360 families; it moves to the registry once every DV360 family is registered. Its pinned discovery document is
sealed since batch 5 (F-72).

**Microsoft Advertising.** The transport speaks JSON while the pinned evidence is the v13 SOAP WSDL; Microsoft ends
SOAP on 2027-01-31, so REST evidence should be pinned before then (F-50).

**Criteo Retail Media.** 11 families on the 2026-01 contract, which reaches end of life around January 2027 under
Criteo's 12-month policy (F-51); 2026-07 changes reporting. Two families (catalog requests, budget overrides) keep
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
4. Verify the Criteo 2026-01 end date on Criteo's pages and schedule the upgrade (F-51). (Meta moved to v26.0 in batch 15.)
5. Review LinkedIn 202609 read-only and move the version (F-53).
6. Finish the registry migration so every platform's families are declared in one place (ROADMAP P2).
