---
status: record
tier: engineering
---

# Snapchat live portfolio hierarchy — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `4e66269`. Batch 85 expands B27/B15/B24 without reclassifying a native route or adding write authority.

Live portfolio now includes Snapchat campaign → ad squad → ad navigation. Select the exact Snapchat login/account,
read campaign inventory, then follow a returned campaign into its squads and a returned squad into its ads.
English/Arabic controls preserve original IDs, exact micro-currency strings, current account currency/timezone,
configured status, review status and independent delivery codes. An ACTIVE or APPROVED entity is not labeled as
serving based on those fields. Late responses and departed controls use the existing current-view guards.

MCP uses `amcp_workspace {action:"portfolio",gateway:"snapchat_native_action",account_id,connection_id,limit,
requirements:{entity:"campaign"}}`. Use `entity:"adsquad",campaign_id`, then
`entity:"ad",campaign_id,ad_squad_id`. IDs must be exact UUID strings. Snapchat page limits are **50–100**,
respecting its documented native minimum; the website requests 50. Other providers retain their existing limits.
The result remains `record_kind:portfolio`, with the shared handoff to `/portfolio`.

The adapter uses the existing six native GET actions: account detail, campaign list/detail, campaign-squad list,
squad detail and squad-ad list. Each child page requires this adapter's qualified parent observations under the
same account/login, then re-reads and verifies the full native parent chain. Observations last five minutes and
are recorded only after the whole page, continuation and current authorization pass. Native ownership is also
retained for scoped follow-up reads; observations never grant permission to write.

Each page is bounded to **eight requests including retries, 100 rows, 8 MiB and 60 seconds**. Current actor,
selected account, Marketing API scope and credential fingerprint are checked before and after every request and
before returning. Native request/item success wrappers accept the documented upper/lowercase SUCCESS variants.
Unknown/partial envelopes, failed items, foreign IDs or parent chains, duplicate IDs, adjacent-page overlap,
unsafe numbers, fractional money and malformed delivery codes are refused. Only selected metadata is returned;
billing, targeting, credentials, tracking URLs and arbitrary provider fields are withheld. Resolved hierarchy
appears in the top-level scope; missing native account/parent fields remain null instead of being invented.

Canonical base64url cursors carry a credential-keyed HMAC and bind tenant/user, login/authorization, account,
entity, exact requirements and page size. They expire after five minutes and bound chains to 100 pages.
The adapter validates each native next_link's HTTPS origin, exact hierarchy path, unique allowed query keys and
unchanged limit/sort, then reuses only its opaque cursor on the fixed authorized route. It never follows a supplied
URL. Missing/repeated tokens, altered queries and malformed or expired cursors fail. Inventory requests use
created_at-desc with provider default visibility. Provider changes across pages can still move/remove entities;
this is not a point-in-time or complete deleted-entity inventory.

Ten new tests: seven backend cases (five observed red; two negative cases already passed before implementation),
two UI cases and one real-SDK journey (all three observed red). Focused **49/49** passed, including existing Google,
Meta, LinkedIn and measurement/commerce navigation. The SDK validates published schemas, both envelopes, exact
hierarchy handoffs and native money/status evidence: **3 calls / 6,149 structured bytes / nine synthetic GETs /
zero provider mutations**. Other cases cover parent checks, revoked/replaced credentials, invalid continuation,
source withholding, exact integers and English/Arabic parity. Static checks cover **32 browser scripts / 2,581
selected Arabic messages**. These are synthetic/VM checks; live Snap, actual browser and deployed acceptance remain
separate. Evidence: `.runtime/snapchat-portfolio-20261002/`.

Primary sources checked 2 October 2026:
- [Pagination and native response patterns](https://developers.snap.com/marketing-api/Ads-API/api-patterns)
- [Campaign inventory](https://developers.snap.com/marketing-api/Ads-API/campaigns)
- [Ad squad inventory](https://developers.snap.com/marketing-api/Ads-API/ad-squads)
- [Ad inventory and review/delivery fields](https://developers.snap.com/marketing-api/Ads-API/ads)
- [Account currency and timezone](https://developers.snap.com/marketing-api/Ads-API/ad-accounts)
- [Micro-currency semantics](https://developers.snap.com/marketing-api/Ads-API/monetary-values)

No dependency, schema migration, provider mutation, external message, OAuth expansion or production deployment.
The native ledgers remain **3,247 actions / 167 families / 1,712 native reads / 800 reviewed writes / 502 blocked
writes**. Additional providers/dimensions and point-in-time reconciliation keep B27 partial. The blueprint remains
**13 implemented / 14 partial / 1 open**. No private root samples were read.

Batch 84 exact-source qualification on `4e66269` passed all checks/Railway: **3,424 passed, zero failed, five
local FFmpeg skips; 76.24 seconds**, four capture tests, **1,497 public files + one generated empty sample**,
source hash `9c6456453073a3449f228cb98a8e5d1e05d94aad094f33f00065ee736c77f088`.
[CI139](https://github.com/magdyezy1/CAMCP/actions/runs/36944047644) was running at this check.
[CI137](https://github.com/magdyezy1/CAMCP/actions/runs/36940352973) succeeded on `85239e1`: host and Docker each
passed **3,410 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and both container smokes.
Job `110630152171` uploaded release-evidence artifact `11200379540`.

Root regression: **3,439 tests / 3,434 passed / zero failed / five local FFmpeg skips; 72.97 seconds**.
Sanitized preflight `.release/snapchat-portfolio-preflight-20261002` passed every check/Railway stage:
**3,434 passed, zero failed, five local FFmpeg skips; 77.12 seconds**, four capture tests, 32 browser scripts
and 251 documents. Its **1,500 public source files** plus one generated empty sample have hash
`bb1aa4c1d565d38cff448414604529814f002bcb333f6039bc03a27ad1476c8f`. Exact committed-source checks follow before push.
