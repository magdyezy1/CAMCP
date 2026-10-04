# Batch 131 — current native media references

Baseline `37bb851`. Sole repository `magdyezy1/CAMCP`, branch `Work-here`, checkout
`CAMCP-Codes-final-branch`. This advances B08/B10/B15/B22/B24 without a new native action, write family,
OAuth scope, credential or advertising mutation. Accounts, media, people and sessions here are synthetic.

## Current reference workflow

`amcp_media {action:"asset_usage",asset_id,limit}` reads current Meta v26 ad references in an original upload's
exact account and login. Image receipts match the original opaque native `image_hash`; video receipts match the
exact native `video_id`, including IDs outside JavaScript's safe-integer range. No name, filename, URL, thumbnail
or source SHA is substituted for the native reference. The original uploaded SHA-256 must remain qualified;
this read does not establish that Meta's served or transformed bytes equal that original file.

The current account is verified before and after one bounded account ad page. Exact ad/creative account fields,
native IDs, original source, current actor/session, advertising read scope and credential/account/scope state are
checked. Native parent campaign/ad-set IDs are observed associations; their resources are not independently
refreshed. Missing creative ownership or selected scalar fields counts as unresolved, not absence of usage. An
unmatched page can still continue. Configured status uses the native configured field or original `status` when
omitted; effective status stays separate. Neither proves delivery or historical creative assignment.

Only selected interpreted fields leave the workflow. Raw provider creative bodies, unrelated fields, source URLs,
private account fields and paging URLs are omitted. Read references retain fixed request selectors, request/hash/time
proof and a continuation-presence flag; opaque native after-tokens are omitted from public request selectors.
Continuations use authenticated AES-GCM encryption bound to the exact source, current credentials/configuration,
actor/session, original login, compiled API version and page size. They expire after five minutes. Previous-page IDs
and prior cursor fingerprints reject adjacent duplicate IDs and repeated continuations. Provider changes or
non-adjacent repeats remain possible; this is not a point-in-time account inventory.

Each call permits at most nine actual transport attempts including native retries, 384 KiB response allowance,
30 seconds and 1–100 examined ads. An account resource is at most 64 KiB and an ad page at most 256 KiB. A linear
continuation carries counters capped at 600 attempts, 10,000 rows, 16 MiB and 120 seconds, with at most 100 pages.
Old-page replays/failed-call retries are separately bounded reads; counters are not a durable server job or a
deduplicated whole-account scan. Provider transport/rate limits remain in force. No result is returned until current
account and authority checks finish. Original-file expiry does not require resurrecting bytes to read metadata.

MCP returns a typed inspect outcome with the original asset's website link and an exact next read. The website
adds an explicit read button, paged English/Arabic reference table, original hierarchy/status, unresolved counts,
empty-page meaning and read proof. It performs no native read merely by opening a library asset. A changed asset,
route, identity or detached view suppresses pending results and subsequent paging. Native values remain escaped
and untranslated. Twenty-one selected authored explanations and controls gain 39 new Arabic entries.

## Discovery fix F-202

When native writes were disabled, `MirrorService.listTools()` hid `amcp_media` entirely, including its existing
local library/asset/performance reads. A corrected red regression found no media descriptor. Read-only deployments
now advertise only **list, library, asset, asset_performance and asset_usage**. The compact tool count becomes
27 in that mode; write-enabled discovery is unchanged. The MCP schema rejects upload actions in the read-only
descriptor, and the existing engine's role/write-grant/confirmation/frozen-review/receipt/read-back controls remain.
No write policy was enabled. The native ledger remains **3,247 actions / 167 families / 800 reviewed writes**.

## Qualification

The current API field/edge matrix was checked 2026-10-04 against Meta's official Python SDK 26.0.2:
[AdAccount ads read](https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/26.0.2/facebook_business/adobjects/adaccount.py),
[Ad fields](https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/26.0.2/facebook_business/adobjects/ad.py),
[AdCreative fields](https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/26.0.2/facebook_business/adobjects/adcreative.py).
The retained selected field matrix is contract evidence, not a live account or complete SDK byte snapshot.

Eleven backend regressions cover image/video matching, original receipt/source/privacy, scope/session/credential
and API-version withdrawal, malformed/foreign/unsafe identities, empty pages, expiry, cursor corruption and loops,
adjacent duplicates, oversized responses, exact native fields and actual retry counters. Four deterministic UI checks
cover English/Arabic escaping, explicit reader-compatible reads, paging, changed-view races, unknown providers and
selected diagnostic translation. Two authenticated loopback HTTP checks use real viewer membership/session and
CSRF protection, and revoke the website session during native observation. One discovery regression verifies the
read-only schema; the real MCP client follows the typed continuation from a read-only deployment and rejects
revoked access without another request. No extra provider request is needed to discover or render metadata.

Final related set: **145 passed / no failures / no skips in 7.498 seconds**. Real MCP: **3 tool calls / 9,077
structured bytes / six synthetic GETs / zero mutations**. Initial feature baseline: **seven checks / two passes /
five feature-gap failures, 844.356 ms**. The read-discovery baseline separately reproduced the missing descriptor
after correcting a test helper method name. Intermediate HTTP fixtures initially lacked the production JSON error
handler; the final tests use the actual HTTP app. A temporary SDK assertion used the wrong outcome property and
was corrected to the existing `meta.workflow` contract. These fixture repairs are not production findings.

The website checks cover 34 shipped scripts and 3,269 explicitly selected Arabic messages. Full sanitized report,
release and exact-commit qualification is recorded below when complete. The private root sample is never read.

The first full sanitized preflight found one stale deployment smoke assertion, still expecting 26 read-only
tools. That expectation now matches 27 and independently verifies the five advertised media read actions.
No source was pushed from the failed candidate. Fresh qualification follows after that smoke repair.

## Remaining acceptance

Browser inspection again failed at its Windows kernel-asset path. Deterministic DOM checks do not replace new
actual visual/keyboard/assistive observations. Current native references do not qualify historical media-level
performance, dynamic/catalog/carousel/post-native completeness, other providers, point-in-time reconciliation,
live account eligibility or deployed Railway behavior. Broader task evaluations and external clients remain
separate. Roadmap totals stay **13 implemented / 14 partial / one open**, and work continues through that roadmap.

## Sanitized release preflight

The fresh second candidate passed offline install, build, early tracked-report freshness, full check and Railway
configuration gates, each exit zero. Its main suite passed **4,064 tests / 4,059 passes / zero failures / five
expected local FFmpeg skips in 95.168 seconds**. All four capture checks passed without skips in 72.660 ms.
Document index: 297; browser scripts: 34; selected Arabic messages: 3,269. The manifest contains **1,671 public
source files plus one generated empty sample**, source hash
`5e8a44af95884820e26e7974e39b914d7c03fc4008dbd86ad7395b22fc5126d9`.
All three public report artifacts regenerated unchanged from the empty sample and remained byte-identical
during qualification. The private root sample was never read. This preflight precedes these final evidence
paragraphs; exact committed-source parity and all release gates follow before the sole authorized push.
No local Docker/FFmpeg, new actual browser or deployed result is claimed.
