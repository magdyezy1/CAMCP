---
status: record
tier: engineering
---

# Exact Google portfolio evidence and continuation — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `20ef776`. Batch 86 strengthens B27/B15 without adding provider writes or route classifications.

**F-153 (medium), reproduced:** Google portfolio accepted an edited keyset cursor and reused a cursor after
credentials changed between requests. It also returned unselected synthetic provider fields, accepted wrong-account
resource names and unsafe integer money, and could follow a native page token despite its bounded keyset contract.
These are fixture-proven integrity/data-minimization defects, not a demonstrated live cross-account incident.
The native request layer already refused authorization changes during a request; that independent guard remains.

Google's adapter now lives in `src/google-portfolio.ts`; `src/portfolio.ts` only dispatches the four adapters.
The existing native search action still targets the pinned **Google Ads v25** contract. One account-scoped GAQL
query reads campaigns, ad groups or ads, always selecting current customer ID/currency/timezone plus the requested
hierarchy. Parent IDs are exact predicates, and returned customer, campaign, group and native resource names must
agree before any rows leave the adapter. Direct child reads remain available: the account-scoped query proves the
full returned chain without extra global-ID lookups. Removed entities stay excluded; this is not a deleted inventory.

IDs are canonical positive int64 strings; money accepts exact nonnegative int64 strings or safe JSON integers and
returns strings without rounding or conversion. Account metadata must be consistent within a page. Missing optional
name/status/currency/timezone/amount values remain null (display names fall back to the ID); no serving state or
zero amount is inferred. Selected native metadata is explicitly projected. Tracking/final URLs, targeting, billing,
arbitrary provider fields and credentials are not passed through this portfolio view.

Canonical base64url cursors have credential-keyed HMACs and bind the current tenant/user, exact login and permissions,
account, native API version, hierarchy and page size. They expire after five minutes and cap a chain at 100 pages.
Edited, noncanonical, expired, cross-actor, changed-size and replaced-login cursors fail before provider egress.
Every response is checked again against current actor/account/login authority. A page is bounded to five requests
including retries, 101 fetched rows (100 visible plus a lookahead), 8 MiB and 60 seconds. Native auto-pagination is
disabled; unexpected native continuation, partial/errors, duplicates, unordered IDs and invalid resource chains fail.
Provider changes between pages remain possible; the cursor does not create a point-in-time snapshot.

An omitted empty ProtoJSON results collection is accepted only when the native field mask exactly matches the
requested fields and any supplied total is zero. An arbitrary empty object, incomplete mask, nonzero total or
explicitly null/malformed collection is refused. This fixes the empty-account workflow without treating unknown
provider responses as evidence of an empty account.

Ten new tests: nine backend cases (eight observed red; the in-flight native authorization case already passed),
and one real-SDK case reproduced red against the exact batch 85 release. Focused **56/56** passed, including existing
product acceptance, other portfolio UI, localization and SDK journeys. The new SDK task exercises root page,
continuation, group, ad and changed-page-size refusal: **5 calls / 7,487 structured bytes / four synthetic read-only
POSTs / zero provider mutations**, validating published schemas, both result envelopes and the website handoff.
Two older fixtures now include the customer ID and resource names returned for the selected Google fields.
Evidence: `.runtime/google-portfolio-20261002/`. No actual browser, live-provider or deployed acceptance is claimed.

Primary evidence checked 2 October 2026:
- Pinned `.mirror/VENDOR/google-ads-v25.json`, captured 28 September, document hash
  `38d286135f0f56170c654aa4a92a26d9a4b1f5d043eaa04776d0a21942729d70`: exact IDs, money and resource-name formats,
  selected field masks and native search continuation. Extracted schema evidence is retained in the runtime folder.
- [Google Ads GAQL structure](https://developers.google.com/google-ads/api/docs/query/structure): attributed resources,
  automatic resource names, filters, ordered queries and LIMIT.
- [ProtoJSON representation](https://protobuf.dev/programming-guides/json/): int64 strings, field masks and omitted
  empty repeated fields. No new native route or OAuth scope was introduced.

The native ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
The blueprint remains **13 implemented / 14 partial / 1 open**. Additional providers/dimensions and point-in-time
reconciliation keep B27 partial. No private root samples, live credentials, ad mutations or deployment were used.

Batch 85 exact-source checks/Railway passed on `20ef776`: **3,434 passed, zero failed, five local FFmpeg skips;
76.35 seconds**, four capture tests, **1,500 public files + one generated empty sample**, source hash
`79d6828dec0a22dc183b9a9940959aa6bf71d4d34df66b9ceffe0e6923225203`.
[CI140](https://github.com/magdyezy1/CAMCP/actions/runs/36945928154) was running at this check.
[CI138](https://github.com/magdyezy1/CAMCP/actions/runs/36942604511) succeeded on `e75b5aa`: host and Docker each
passed **3,422 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and both container smokes.
Job `110637339008` uploaded release-evidence artifact `11200844109`.

Root regression: **3,449 tests / 3,444 passed / zero failed / five local FFmpeg skips; 84.98 seconds**.
Sanitized preflight `.release/google-portfolio-preflight-20261002` passed every check/Railway stage:
**3,444 passed, zero failed, five local FFmpeg skips; 81.77 seconds**, four capture tests, 32 browser scripts
and 252 documents. Its **1,503 public source files** plus one generated empty sample have hash
`e75b34b479f58b2e87773b9dd2f751aec8cecff26b7e9f35c6aeaa2ea6b8ea88`. Exact committed-source checks follow before push.
