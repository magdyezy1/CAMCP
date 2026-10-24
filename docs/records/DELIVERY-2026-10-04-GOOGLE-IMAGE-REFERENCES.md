---
status: record
tier: engineering
---

# Current Google image references

Baseline: `8a50e75`. Batch 143 advances B08/B10/B15/B16/B22/B24 with a bounded original-image
reference read, website flow and MCP handoff. The original full plan continues; no package or native family
is declared complete by this increment.

## Selected evidence and scope

`amcp_media {action:"asset_usage",asset_id,limit:50}` now derives its adapter from the original asset.
Google images require the exact `customers/{original_customer}/assets/{asset_id}` receipt resource and
original uploaded SHA-256. The native customer must explicitly report `manager:false`, and both exact
asset reads must identify that same `IMAGE`. Google video and other providers remain outside this adapter.
Meta retains its original bounded scalar reference pages and encrypted identity-bound continuation.

Google's [v25 ad asset view](https://developers.google.com/google-ads/api/fields/v25/ad_group_ad_asset_view)
supports App, Demand Gen and Responsive Search ads; it explicitly excludes Responsive Display ads. Performance
Max and other formats therefore remain outside this selected evidence. The
[view proto](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/resources/ad_group_ad_asset_view.proto)
declares optional link presence. Only explicit true links with qualified roles and supported ad types appear
as current references. Known non-image roles also remain unresolved, following the documented [asset placement enum](https://developers.google.com/google-ads/api/reference/rpc/v25/AssetFieldTypeEnum.AssetFieldType). Missing/null flags or types remain unresolved; explicit false links are counted separately.
The [customer proto](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/resources/customer.proto)
also declares optional manager presence, so omission does not establish a client account. These sources and the
selected pinned schema were checked on 2026-10-04.

Google's [paging guide](https://developers.google.com/google-ads/api/docs/reporting/paging) documents fixed
pages and forbids setting `page_size`. This read chooses complete bounded collection instead: default 50,
explicit limit 1–1000 and a query limit one above the selection. It refuses overflow, a nonterminal native page
or inconsistent total counts, rather than returning a partial inventory as complete. The
[v25 search proto](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/services/google_ads_service.proto)
defines total result counts independently of the query limit. No Google continuation or persistent snapshot is
introduced. Other media actions retain their own smaller backend limits.

The read brackets two complete link collections with exact customer and asset reads. Normalized collections
must match, including role, link presence, hierarchy and configured statuses. Both original identities must
remain unchanged. The shared limit is 24 attempts, 2,100 rows, 4 MiB and 60 seconds, including retries and both
passes; six native searches suffice without retries. Exact positive native IDs remain strings, including values
above JavaScript's safe integer range. All selected campaign/ad-group/ad/resource links must agree with the
original account and asset; duplicates, malformed enums/text and unselected native fields refuse disclosure.

Current key/session/login/account/credential/scopes, uploaded source identity and local metadata revision are
checked around each request. Readers and disabled-write deployments can inspect without an upload write grant.
Source references retain selected query, response hashes, clocks and counts, without raw native bodies,
ad text, URLs, people, events, credentials or native page tokens. No write review, report snapshot or advertising
mutation is created. Configured status and a latest-version link do not establish serving, historical attribution,
performance, reuse eligibility or complete absence across all formats. Matching repeated reads are observations,
not a provider transaction or historical inventory.

## Website and workflow

The creative library exposes a Google-specific native reference panel only for qualified original image receipts.
The user chooses the maximum link count and explicitly starts the read. English/Arabic captions distinguish
ad groups, native image assets and link roles from Meta's creative/ad-set terminology. The table preserves original
names with escaping and exact IDs/types in LTR elements. A named keyboard-focusable scrolling region bounds a
large collection. Counts distinguish observed ads, links, unresolved links and removed links.

The Google flow has no page controls or opaque continuation. Original asset/navigation/session and request-order
guards discard stale responses; a mismatched original asset or chosen limit cannot replace the current view.
Meta retains its prior explicit read and paging behavior. Selected authored backend explanations are included
in the locale check; unfamiliar provider diagnostics stay source text.

Both read-only and write-enabled MCP descriptors explain these separate provider limits and qualifications.
The real SDK journey validates discovery and arguments, checks JSON text/structured parity, follows the
original `/media?asset_id=...` handoff and refuses revoked access before further native requests.

## Qualification and continuing scope

Feature baseline: **1/0/1/0, 689.252 ms**. Corrected baseline: **1/1/0/0, 3.194 seconds**.
Ten backend cases cover exact identities, explicit/omitted/removed links, multiple roles, unknown formats,
complete repeated-read changes, unqualified original receipts, reader access, mid-read authority/source withdrawal,
malformed native evidence, overflows/count gaps/continuation, 1,000 links, empty selected views and native retries.
Two authenticated HTTP cases verify viewer access, CSRF, no-store and mid-read session withdrawal.
Three bilingual controller cases use the real localization module and exercise exact IDs, escaping, captions,
explicit bounds, no Google paging, request ordering, changed-view protection and original-asset mismatches.
The real SDK journey makes three calls, 7,583 structured response bytes and six synthetic native reads, with
zero external provider requests or mutations. Combined Google/Meta/library/read-only/controller/HTTP/SDK suite:
**42/42/0/0, 4.329 seconds**. Website checks pass for 34 scripts, three pages and 3,428 selected Arabic messages.

Fresh sanitized report regeneration, full qualification and exact committed-source checks are recorded below
once complete. The current package matrix remains **13 implemented / 14 partial / one open**. Native totals
remain **3,247 exposed / 167 blocked / 800 reviewed rows**, with no added family or native action.
Actual browser/assistive acceptance, live provider/account entitlement, historical assignment and deployed
qualification remain separate. Browser availability was most recently checked at approximately 11:23 UTC on
2026-10-04 and failed with the kernel-assets missing-path error (os error 3); controller fixtures do not replace it.

The previous exact batch 142 release is fully qualified: code `deceeb117eb4abb8a0871a2be7406848766841e7`,
final revision `8a50e75c3b767c43ece4a1f20abb88ab4631056d`, 1,726 public Git blobs plus one generated empty sample,
three tracked report blobs and source hash `57d61c80b9293c620f32e80e4b5929a43943ce2f8e764575ca7eb983860b6bdb`.
Local final gates passed, main **4,213/4,208/0/5, 118.518 seconds**, capture **4/4/0/0, 71.412 ms**; reports kept
their bytes. [CI197](https://github.com/magdyezy1/CAMCP/actions/runs/37199340938), job `111427609975`, passed all
20 steps for that exact source: Linux **4,213/4,213/0/0, 601.726 seconds**, capture **4/4/0/0, 55.244 ms**;
Docker **4,213/4,213/0/0, 596.751 seconds**, capture **4/4/0/0, 55.469 ms**. Decoded logs independently match
the exact source proof, required FFmpeg, report freshness, full checks, Railway validation, image inspection
and both synthetic read/write smokes. This qualifies CI, not live provider behavior or Railway deployment health.

The earlier related suite selected 347 files and passed **3,204/3,199/0/5, 104.224 seconds**; five skips require local FFmpeg. The subsequent image-role and descriptor refinement passed the final focused suite above. The full sanitized gate qualifies the final source separately.

## Batch 143 sanitized release preflight

Fresh offline install/build/early tracked-report freshness/full check/Railway all passed with every exit zero.
Main **4,229/4,224/0/5, 133.970 seconds**; capture **4/4/0/0, 75.249 ms**. Five local skips require FFmpeg;
the exact Linux/Docker CI gates remain separate. Website: 34 scripts, three pages, 3,428 selected Arabic messages.
Documentation index: 309 documents. Manifest: 1,732 public source files plus one generated literal empty sample;
preflight source hash `e3da5b9ca57ca6cb9ad0630667c79aae6ca8f2a8d45d076e79eb4ae9ca0aef5f`.
All three public reports regenerated unchanged after the final sanitized build and preserved their bytes
through qualification. The private root sample was not read. Editorial metric/table corrections and this
preflight record follow that candidate; the final committed source therefore requires a fresh maintained Git
blob/manifest/report/sample proof and full gates before the sole Work-here push. No live/deployed/browser
acceptance is implied. The original full improvement plan continues.

## Subsequent exact committed release

Code `7dc10160a206704567efdb9a90d88d997802e7a1`; final `af9167be90e56e2681b36ac8700e4de1fcfa9d2e`.
Maintained source proof matched all 1,732 public Git blobs, one generated empty sample and three reports,
source hash `88eb29b4de6070b5d0ae914428b74d9de34d145ca999eae15db0e019bfb89a3c`. All final offline gates passed
and reports kept their bytes: main **4,229/4,224/0/5, 119.029 seconds**; capture **4/4/0/0, 73.545 ms**. Sole
Work-here push completed. Exact [CI198](https://github.com/magdyezy1/CAMCP/actions/runs/37201862558),
job 111435034041, is still running. This record does not imply completed Linux/Docker, live or deployed acceptance.

## Batch 143 exact Linux/Docker qualification confirmed during batch 144

Decoded [CI198](https://github.com/magdyezy1/CAMCP/actions/runs/37201862558), job `111435034041`, confirms exact revision
`af9167be90e56e2681b36ac8700e4de1fcfa9d2e` and source hash
`88eb29b4de6070b5d0ae914428b74d9de34d145ca999eae15db0e019bfb89a3c`: 1,732 public Git blobs,
one generated literal empty sample and all three tracked reports. All twenty job steps completed successfully,
including host FFmpeg, source verification before installation, early report freshness, full checks, Railway
checks, Docker build/image identification and both synthetic container smoke modes. Host main
**4,229/4,229/0/0, 760.507 seconds**; host capture **4/4/0/0, 78.251 ms**.
Docker main **4,229/4,229/0/0, 759.199 seconds**; Docker capture **4/4/0/0, 76.339 ms**.
This qualifies the prior source's Linux/Docker pipeline, not a later source, deployed service, browser/assistive
journey or live provider acceptance. The earlier running-CI observation remains historical.
