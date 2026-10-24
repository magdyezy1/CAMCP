---
status: record
tier: engineering
---

# GA4 and Search Console connection discovery

Base: 3068197b390ae032584b612bdc9f86428a96c6aa, Codex-branch only.
The two previously unmapped sync workflows are implemented. Focused synthetic
validation passes; full sanitized required-FFmpeg validation passes: 1603 main
and four capture tests, zero failed/skipped. [Machine evidence](MEASUREMENT-CONNECTION-SYNC-VERIFICATION-2026-09-25.json)
retains exact commands, log hashes and staged-source comparison.
No live Google credentials, provider modifications or deployment changes occurred.

## Completed journeys and contracts

P2 confirmed missing capability: ga4_sync_properties and gsc_connection_ops with
action sync_sites were catalogued but returned WORKFLOW_ADAPTER_REQUIRED. An
administrator now selects an exact connection, or the sole/unique default login,
previews without credentials or egress, and explicitly refreshes with dry_run
false. Google native GETs produce checked metadata, which is committed atomically
into website_assets. Neither AMCP account selection nor write grants expand or
shrink. A complete result identifies missing_selected_ids separately, so historical
reporting selections are not silently erased. An existing connection/recorded
measurement OAuth scope is required; social sign-in and Ads consent do not qualify.

GA4 uses Admin API v1beta accountSummaries.list with invariant page size and native
page tokens. Optional include_details reads the exact property and verifies
identity/account, timezone and currency when provided. Omitted currency remains
unknown. Distinct properties under the same account may span pages; duplicate
property records fail instead of being double-counted. Discovery does not claim
an atomic point-in-time provider snapshot or prove reporting/administrative access.

Search Console uses /webmasters/v3/sites with native siteUrl and permissionLevel.
URL-prefix and Domain identities are preserved exactly. Unverified users are
excluded with an explicit count. Unknown permissions, duplicate sites, unsafe
identity syntax and invented pagination fail; AMCP never fetches those site URLs.
Provider strings retain the shared untrusted-content warning.

The website's GA4 properties and Search Console site discovery use the same pure
collector, preventing a separate parser from drifting. Existing stream/sitemap
discovery remains separate. Website policy for pruning missing selected assets
is unchanged; the new MCP metadata-sync commands preserve selections explicitly.
The equivalence test compares the same fixture through both discovery surfaces.

## Failure, concurrency and persistence

The MCP wrapper verifies current administrator authority, gateway, scopes and
credential fingerprint before and after every request, including refresh failures.
An old login cannot publish results or an error onto a replacement login. A
SQLite lease serializes MCP syncs across workers. Monotonic deadlines bound the
underlying HTTP abort and prevent late persistence; lost/expired leases cannot
publish. New metadata/selection revisions win over an older sync. Successful
metadata and the count-only audit commit together. Failed/partial discovery
retains previous rows with complete false and an explicit stale error; it cannot
turn an unexpected response into a successful empty list. Raw provider error text
is not copied into this retained metadata or the success audit.

Bounds: 10000 assets, 250 requests, 60 seconds per MCP sync; GA4 max_pages 1–50,
default 10. The website retains its 25-page limit. Native transport retains its
byte limits and retry/pacing controls. Google documents no site-list pagination.
The sync lease is 120 seconds, longer than the bounded operation. Independent
database replicas cannot coordinate one lease. Failure handling never changes
grants, completes an advertising review or creates a provider mutation.

## Verification and original failures

Tests: tests/measurement-connection-sync.test.ts, 25 cases, plus existing
measurement/Apple, report-delivery discovery, transport, TikTok reports and guides.
Node 24.19.0, npm 11.17.0, Windows PowerShell. Evidence logs under
.runtime/contract-completion-20260924/:

- measurement-sync-baseline-build.log: fixture omitted required connection label;
  corrected before running the behavior baseline.
- measurement-sync-baseline.log: two WORKFLOW_ADAPTER_REQUIRED failures.
- measurement-sync-first.log: two initial paths pass.
- measurement-sync-expanded.log: 47 pass, one failure. An added duplicate-parent
  restriction rejected an existing fixture with distinct properties under one
  paginated account. There is no needed uniqueness assumption for parent summaries:
  merge disjoint properties while retaining duplicate-property rejection. The
  existing fixture/assertions were preserved; an explicit regression now covers
  both cases. No ambiguous property identity or partial completion was allowed.
- measurement-sync-final.log: 81 pass / zero failed/skipped.
- measurement-sync-guidance.log: 26 pass, including the then-current 24 new tests
  and two existing guide tests.
- measurement-sync-workers.log: final focused combined run, 86 pass / zero
  failed/skipped, including the additional separate-worker/restart case.
- An example patch was rejected before applying because two operations targeted
  the same file. It was combined into one file operation; no code/test exemption.

The new guide example file is exercised through actual MirrorService preview:
Skills/amcp-campaign-builder/examples/measurement-connection-sync.json. Tests also
cover credential-free defaults, role/scope/tenant/UUID/default selection, native
GET shape, scope/key/credential revocation in flight, failed-audit rollback, native
timezone/currency, unverified sites, unknown/empty/error envelopes, deadline abort,
lease loss, count bounds and newer selection preservation.

Final candidate .release/measurement-sync-20260925-a contains 594 files; source
tree hash 8f12ad087dc1d66ade7dc854344781231fad452ba196b0e8ba75b43ca9ca7a65.
All staged code/tests/guidance match the tested candidate after normal Git line
ending normalization. Subsequent evidence recording changes documentation only.

Generate after build with node dist/tools/generate-contracts.js and node
dist/tools/action-contracts.js. Remaining CSV retains all 14 fields. The denominator
stays 3241: 438 reviewed-family, 886 blocked writes, 86 unmapped, 23 unqualified
reads, eight input-dependent, four retired. There are 1007 remaining rows including
retired actions. The two sync commands are local workflows, not advertising write
contracts or live provider qualification.

## Official references and rollout

Accessed September 25, 2026:

- [GA4 account summaries](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/accountSummaries/list),
  v1beta, updated June 18, 2026: account/property summaries, page size/token and
  analytics.readonly or analytics.edit scope.
- [Exact GA4 property](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties/get)
  and [property fields](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties):
  identity/account, native reporting timezone and optional currency. No currency
  default or unchanged historical timezone is invented by this discovery layer.
- [Search Console sites.list](https://developers.google.com/webmaster-tools/v1/sites/list)
  and [site permissions/IDs](https://developers.google.com/webmaster-tools/v1/sites),
  v3, updated July 23, 2024: the four permissions, two identity formats and scopes.
- Business Profile account/location documentation was also inspected as next-work
  research; this batch does not implement Business Profile sync or browser OAuth.

No new dependency, schema migration or provider mutation. Reuse the current
encrypted SQLite volume. Old binaries can read the existing website_assets shape,
but will again lack MCP sync and the stricter shared collector. Preserve completed
metadata, selections and advertising receipts during rollback. Acceptance is
complete bounded native discovery, preserved grants, visible stale failures and
matching website/MCP fixture output. Live Google scopes/permissions, account volume,
fresh deployment UI behavior and container execution remain separately unverified.
OAuth start/exchange aliases, Google Business Profile discovery and other remaining
provider families stay in the machine inventory; no generic gateway bypass exists.
