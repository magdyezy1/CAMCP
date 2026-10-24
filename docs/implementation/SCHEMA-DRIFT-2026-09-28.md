---
status: record
tier: engineering
---

# Public schema drift found and handled (2026-09-28)

`node dist/tools/provider-drift.js --live` compares every pinned vendor document with the one its official URL serves
today. It reads public documents only, without credentials. On 2026-09-28 it reported:

| Pinned document | Result |
|---|---|
| Google Ads v25, GTM v2, GA4 Admin v1beta, Search Console v1, six Business Profile APIs | Unchanged |
| DV360 v4 (revision 20260902 → 20260928) | Changed within the version: read-only flags |
| GA4 Data v1beta and v1alpha (20260902 → 20260924) | Changed within the version: a response field |
| Business Information v1 (20260902 → 20260927) | Descriptions only |
| Criteo 2026-01, Reddit v3, six Microsoft Advertising v13 documents | Not reachable here (HTTP 403 from the environment's network policy) |

No method was added or removed anywhere. The detail comes from comparing each document's schemas, properties, enum
values, read-only and deprecated flags, and method parameters; descriptions are ignored.

## DV360 v4

| Change | In AMCP |
|---|---|
| `DeviceTypeAssignedTargetingOptionDetails.youtubeAndPartnersBidMultiplier` is no longer output-only | Device targeting may now set it. It multiplies bids, so its name makes the write a spending change: prepare lists `spend_change_confirmed` (`tests/dv360-ad-group-targeting.test.mjs`) |
| `YoutubeVideoDetails.unavailableReason`, `CommonInStreamAttribute.trackingUrl`, `VideoPerformanceAd.domain` and `.trackingUrl` became output-only | Refused in requests, dropped from state. The Demand Gen ad family had special-cased the video availability note as output-only; the pinned model now says so, and the special case is gone (the read-back fixture now carries the note) |
| `AdGroupAd.bumperAd`, `nonSkippableAd`, `videoPerformanceAd` and `inStreamAd` are no longer output-only | No effect: the Demand Gen ad family writes only the four Demand Gen types |

Google served revisions 20260924 and 20260928 alternately while this was checked. Their content is identical apart from
the revision label, and the drift fingerprint ignores the label. The pin holds 20260928.

## GA4 Data v1beta and v1alpha

GA4 added `ResponseMetaData.dataTruncationReasons`: why data is missing from a report (Google Ads' 36-month retention,
DV360 and CM360 two-year policies, event data before the property's retention date, attribution model dates, new
ecommerce metrics, or a date range not fully served). A report that silently misses data is the kind of error AMCP's
source quality exists to show, so:

- the quality of each GA4 page keeps the truncation type, date, date ranges and GA4's message;
- a truncated GA4 source is not measurement-complete, so its report is partial, with a warning naming the limits;
- period comparisons and the website's quality line carry it (`Truncated by GA4`).

Tests: `tests/audit-report-quality.test.mjs` (the quality record) and `tests/ga4-campaign-report.test.ts` (a truncated
run is partial and says why); both failed before.

## Refreshing a pin

`node tools/fetch-vendor-specs.mjs --refresh <name…>` fetches only the named documents (for example
`ga4-data-v1beta`); `--refresh` alone fetches all of them. DV360 has its own `node tools/fetch-dv360.mjs`. Both
regenerate the vendor routes; then run `node codegen/generate.mjs`, `node dist/tools/action-contracts.js` and every
generated-artifact check. The re-pin changed no route (511 routes, no gaps) and no ledger record: the 1,207 method
records of `docs/implementation/VENDOR-METHOD-COVERAGE.json` are identical, in the documents' new order.
