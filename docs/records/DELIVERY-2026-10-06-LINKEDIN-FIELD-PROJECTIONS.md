---
status: record
tier: engineering
---

# LinkedIn field projections and read-only live acceptance

Batch 181 corrects a reproduced native reporting defect. A LinkedIn account analytics read
with `fields=impressions,clicks,costInLocalCurrency,dateRange,pivotValues` returned HTTP 400:
the provider interpreted the encoded separator commas as part of one field name. The current
local serializer reproduces that exact wire shape. Default metrics and one cost field each
returned a row through the connected gateway; those reads do not prove this checkout is deployed.

## Correct native selectors without changing account scope

The LinkedIn-only `fields` string now retains native selector punctuation for comma lists,
child objects and `$*` map children. Other query values keep their original scalar/List/record
encoding. Query separators, fragments, credential-like text and literal percent-encoded leaves
stay escaped; selectors cannot introduce a sibling account filter. Existing query byte/node
limits, API headers, read/write classification, account ownership, retries and provider error
handling remain. No new action, dependency, account grant or Arabic message is added.

This is wire rendering, not a field allowlist or a new entitlement. Unknown native fields
still fail explicitly. Legacy non-string/List/record forms retain their old serialization;
they are not newly qualified as field projections. There is no fallback to unrequested
default metrics after a projected read fails.

[LinkedIn field projections](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/projections)
defines CSV selection and nested child/map syntax. [Protocol 2.0](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/protocol-version)
distinguishes structural punctuation from encoded scalar values. Both were checked on October 6, 2026. The focused regression checks exercise those examples at the actual production URL and
transport boundaries, preserve bound account/date values, test injection attempts, unchanged
other providers and limits, and retain bounded read retries plus a native unknown-field failure.

The formatted sanitized prototype passes **32/32**, zero failure/skip, in 407.6949 ms;
20 checks are newly added. Its earlier unformatted run also passed 32/32 in 416.2538 ms.
Fresh final source/build/report/default-full checks remain mandatory before the guarded push.

## Owner-authorized reads; zero account changes

The owner authorized any accessible account for acceptance and prohibited account changes.
Current discovery returned ten accounts/properties/sites across eight connected gateways.
All observations below used existing bound identities. No account mutation, manual binding/grant,
saved AMCP report/draft, OAuth change, asset upload, asynchronous report creation, Sheet export
or external delivery was performed. Account names, IDs, native request IDs and performance values
are excluded from this public record.

| Read                            | Actual result and boundary                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Ads customer             | One enabled, non-manager, non-test customer; original currency/timezone matched before and after the bounded reads.                                                                                                                                                                                                             |
| Google hourly queries           | Both the October 3 window and native LAST_7_DAYS query succeeded with zero rows, under a 200-row limit. This establishes accepted query access, not populated hour grain, complete inventory or zero activity.                                                                                                                  |
| Meta account and daily Insights | Account identity/currency/timezone read passed. The corrected native `act_` account binding returned one October 3 account row with original date, currency and metric fields. The initial unprefixed request remained a scope refusal. Monetary precision, objective eligibility and complete attribution are not established. |
| Snapchat accounts and totals    | One account was pending; another was active. Native account totals rejected a multi-metric request with E1008 and accepted the corrected synchronous spend-only request for an explicit hour-aligned UTC window. Local daily grain, conversion attribution and a complete performance pack remain unverified.                   |
| LinkedIn account and analytics  | Active non-test account metadata, one daily default-metrics row, and one native string cost-only row passed. The CSV-projection failure is retained. The cost-only result omitted identity/date fields and cannot qualify a complete multi-field capture; the new serializer still needs same-source deployed read acceptance.  |
| GA4                             | One dated sessions row and native quota metadata returned for October 3. This is an aggregate read, not event delivery, consent, deduplication or attribution evidence.                                                                                                                                                         |
| Search Console                  | One dated row returned for October 3. This does not establish complete reporting or checkout deployment.                                                                                                                                                                                                                        |
| X                               | The account-scoped promotable-user read returned one row. Catalog discovery remained RESOURCE_SCOPE_REQUIRED before and after that read; no binding was provisioned and no catalog/product inventory was qualified.                                                                                                             |
| WooCommerce                     | Connected store discovery returned WORKFLOW_ADAPTER_REQUIRED. No store, selected product/variation or live commerce comparison was qualified.                                                                                                                                                                                   |
| Runtime health                  | The connected owner-only health action returned OWNER_REQUIRED. Runtime/deployment identity remains unavailable.                                                                                                                                                                                                                |

Failed reads remain failed evidence. Successful corrected reads do not relabel the original
failure, and read access does not authorize changes. The private transient connector responses
were not added to the repository or its generated reports.

## Qualification carried forward by exact component bytes

Batch 180 completed its clean-head qualification at
`09b1adc5020d2d126c043469cf0f6ce5d683b5c2`: all six sanitized stages passed, main
4,720/4,720 and capture 4/4, with required FFmpeg/default concurrency and zero skips.
All **456/456** original browser cases passed between 2026-10-05T23:35:08.256Z and
2026-10-06T00:08:03.063Z. They retain 912 semantic and 912 pinned selected-WCAG snapshots,
zero automated violations, 866 manual phases, 1,511 incomplete-rule rows and 13,279 nodes.
All original workbook/native-read/keyboard and outside-selection retention assertions remain.
These manual records are incomplete-rule evidence, not physical assistive certification.

The correction changes no web, locale, browser runner/helper or native fixture bytes. Final
qualification must verify that equality before reusing the completed browser component record.
It must separately qualify the new backend and exact committed public source; the earlier
browser run cannot be called a browser run on a later commit. Batch 180 and this bounded
correction share one guarded Work-here push. Hosted Actions remains owner-waived and unused.

The package matrix remains **13 implemented / 14 partial / one open**. Wider native dimensions,
real store setup, full variants/absence policy, conditional programs, provider writes/destinations,
Linux/Docker/Railway identity, capacity, raw measurement and complete physical/editorial
acceptance are not completed by these reads. Follow the
[remaining implementation and acceptance walkthrough](../CURRENT-READINESS.md).

## Precommit release evidence

The six sanitized precommit commands passed: offline install, build, report regeneration,
report freshness, web/locales and Railway configuration. All three tracked report files
regenerated byte-identically, including implementation-status.json; no artificial change is
made. The first wrapper exited one only after recording all six successful commands because
its final summary selected the full-check filename for the web-only phase. The original result
is retained; the corrected phase-specific footer is syntax checked. Mandatory default-full
qualification remains on the subsequent exact clean committed head.

Independent workers measure matching local/sanitized application bytes and both build records:
1,334 files / 52,061,013 bytes /
26b9a9fd4b35dab6bcce054183a75cc9b1c7af9a8d967fe4ea1714d60538378b,
in 235.7500/243.1942 ms. Source revision remains explicitly null; these observations do not
attest an image, operating system or deployed Git source. Preservation checks retain 1,869
unrelated public sources, 427 other backend TypeScript files, all 54 web files and all 683
previous test files byte-for-byte. The first helper counted only src TypeScript under its
backend label; its retained successor explicitly includes the unchanged server files.
The 12-file scope adds one test and one delivery document. All 8,091 Arabic values and the
7,923-message selected locale boundary stay exact; the generated documentation index contains
349 documents. The complete default suite and exact head parity still gate the single push.
