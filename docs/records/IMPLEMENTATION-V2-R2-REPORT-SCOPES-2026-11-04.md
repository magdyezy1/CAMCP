---
status: record
tier: engineering
---

# Round 2 explicit v4 reporting scopes — 2026-11-04

This follows the separately qualified explicit-v4 engine checkpoint. It adds source-owned activity and status
semantics, truthful filtering counts and rollback protection. Packages B/C, automatic migration, templates,
website controls and complete Round 2 qualification remain unfinished. No Round 2 push or live-provider acceptance
is claimed here.

## Filtering and compatibility

Paid sources observe delivery through spend, impressions or clicks. GA4 uses sessions or users; Search Console
uses impressions or clicks. A positive native decimal proves activity before display rounding. No positive value
with any relevant missing input remains uncertain. Explicit unknown exact values never fall back to a displayed
zero. The server replaces caller-supplied activity fields with the provider declaration.
Campaign and detailed collectors retain a separate native activity observation before applying the nine-place
metric precision contract. A positive value smaller than that precision can retain a row whose displayed spend is
zero; missing observations stay unknown. This does not change additive metric precision or totals.

Collected row counts survive scope filtering. V4 separately records rows after source scope, rows excluded by
source scope, rows excluded by objective and visible rows. Source and level capsules retain collected/scoped
counts. An empty scope returns `scope_filter`; an empty objective selection returns `objective_filter`; an empty
collection returns `no_provider_rows`. Existing v3 counters retain their contract.

Cross-level comparisons with status or objective exclusions withhold numerical gap/agreement claims when those
filters can select different entity populations. Known totals remain visible with an unavailable comparison reason.

Unknown statuses cannot satisfy a positive status filter. Excluding an unknown status, parent identity or activity
keeps the source partial and holds its recommendations. GA4 and Search Console permit only the all-status scope.
New delivered-only configurations that v3 cannot express refuse execution on the old projection; explicitly
retaining all delivery states can remain representable. No retained v3 snapshot is rewritten.

Child-ID filters at a parent reporting level still exclude identities they cannot establish and disclose the
uncertainty. They do not invent a parent total for selected children; further scope qualification remains pending.

## Status evidence and requests

Provider hooks own the native enums. Configured status is separate from effective/serving state. A paused parent
does not turn an enabled child into a user-paused child. Known deletion/removal states join the archived scope;
unmapped states stay unknown. Evidence is retained under native inclusion, while the compact row carries its
canonical status. These reads describe configuration at collection, not historical status at delivery.

Microsoft uses the explicitly labelled `provider_report_status` basis for its native performance-report status
columns; budget or system holds do not become an invented user-paused status. Analytics statuses are not applicable.
Apple reads advertiser-controlled entity metadata rather than interpreting the report's rolled-up display label.

Meta scans account-owned metadata through at most two 500-entity pages, retaining unknown status for unseen IDs.
It reuses a validated cursor on the fixed account path and never fetches a provider-supplied next URL. TikTok,
Snapchat, LinkedIn, Reddit and X reuse their native account-owned inventory or parent metadata. Apple campaign
metadata uses exact safe IDs under the same account context. Foreign ownership and malformed data fail the source;
only a qualifying optional metadata refusal retains unknown values. Authentication failures remain errors and
temporary server failures retain worker retries. Existing authority, account, row and request limits remain active.

The v4 first-page request baseline includes nonempty metadata reads and LinkedIn metric fragments. It can be
conservative for empty reports or metadata already cached by another level. Extra pages, retries, polls beyond the
first and further X windows remain bounded by the actual collection budget. V3 keeps its earlier estimate contract.

Native-field references checked 2026-11-04 include the official
[Google campaign status enum](https://developers.google.com/google-ads/api/reference/rpc/v23/CampaignStatusEnum.CampaignStatus),
[Meta generated campaign fields](https://github.com/meta/facebook-python-business-sdk/blob/main/facebook_business/adobjects/campaign.py),
[TikTok status enumerations](https://business-api.tiktok.com/portal/docs/enumerations-appendix/v1.3),
[LinkedIn status and serving distinction](https://learn.microsoft.com/en-us/linkedin/marketing/usecases/foundations/statuses?view=li-lms-2026-10),
[Snapchat campaign fields](https://developers.snap.com/marketing-api/Ads-API/campaigns),
[Apple status and display distinction](https://developer.apple.com/documentation/apple-ads-platform-api/campaigns-endpoints),
[Microsoft report status values](https://learn.microsoft.com/en-us/advertising/reporting-service/campaignstatusreportfilter?view=bingads-13)
and the [official X campaign examples](https://github.com/xdevplatform/docs/blob/main/x-ads-api/campaign-management.mdx).
Meta's reference page returned HTTP 429 and TikTok's full enumeration page had no readable body; their available
official generated fields/search excerpts and synthetic contract tests are documentation evidence, not live pins.

## Validation status

Targeted tests reproduced delivery uncertainty, analytics activity loss, filtered counts, status propagation and a
delivered-only rollback gap before their fixes. Native queue/collector tests cover all configured entity positions,
bounded metadata paging, refused reads and foreign accounts. The three-level TikTok fixture still checks the
unchanged one-third response-size target. Seven new explanations have Arabic entries; native-speaker sign-off
remains planned for Round 4.

Resume review on 2026-11-05 additionally reproduced sub-precision activity loss through the actual collector and
verified the fix at campaign, ad set and ad levels. A refused metadata read also rejects a login replaced during
that read. The latest seven-file focused run passes 67 tests. Earlier candidate inputs are preserved separately;
acceptance requires a fresh filtered candidate containing these follow-up fixes.

The corrected checkpoint subsequently passed fresh filtered qualification, recorded in the
[2026-11-05 receipt](QUALIFICATION-V2-R2-REPORT-SCOPES-2026-11-05.md). This record must not be read as full B/C or
Round 2 acceptance. No dependency or tool input schema was changed. Live provider and OAuth reads and actual Sheets
exports are not permitted during development (plan principle 4); live checks on staging are blocked: no staging (D20);
deployment to amcp.shop and Railway is deferred by the owner (C11, 2026-11-03: "leave the live deployment for now, push
to github, live deployment in a later stage").
