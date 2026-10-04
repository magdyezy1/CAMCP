# Current Performance Max image asset-group references

Baseline: `af9167b`. Batch 144 advances B08/B10/B15/B16/B22/B24 with an explicit second Google image view.
The original full plan continues; this increment does not close a package, add a native family or qualify
live provider behavior.

## Native scope and meaning

`amcp_media {action:"asset_usage",asset_id,reference_view:"performance_max",limit:50}` inspects current
configured image links in the original upload account through `asset_group_asset`. The default `ad_images`
view retains its original App/Demand Gen/Responsive Search query and semantics. Each selected view performs
six bounded read searches independently; it does not fan out to another view. Meta rejects the Google view
selector and retains its scalar-reference paging flow.

The [v25 asset-group link reference](https://developers.google.com/google-ads/api/fields/v25/asset_group_asset)
allows selected asset-group, campaign, asset and customer fields. The
[asset-group proto](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/resources/asset_group.proto)
defines exact resource and campaign associations and the native name bounds. The
[link proto](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/resources/asset_group_asset.proto)
and [link status enum](https://developers.google.com/google-ads/api/reference/rpc/v25/AssetLinkStatusEnum.AssetLinkStatus)
distinguish advertiser configuration from primary serving signals. Sources and the selected pinned schema
were checked on 2026-10-04. Known ENABLED and PAUSED image associations remain distinct current link
configurations; REMOVED links are counted separately. Missing/UNKNOWN/UNSPECIFIED role or status values remain
unresolved. Known non-image roles cannot become qualified image links.

Asset-group IDs are preserved as strings, including IDs above JavaScript's safe integer range. They never
become invented ad IDs. Each selected link must point to the exact original image resource and exact native
asset group, whose campaign association must match the same customer and explicitly report PERFORMANCE_MAX.
Removed group/campaign observations, foreign resources, incompatible modes, duplicate group/role links,
malformed names/enums and unselected fields refuse disclosure. Normalized complete collections must agree
independently of native ordering.

The shared original receipt/SHA/IMAGE/customer brackets and actor/key/session/login/account/scopes/credential/
metadata guards remain. Explicit client identity is required. Default 50, selected 1–1000 links, 24 attempts,
2,100 rows, 4 MiB and 60 seconds bound each read, including both collections and retries. Overflow, count gaps,
nonterminal native pages or changed source observations cannot return a partial inventory as complete.
Readers and disabled-write deployments can inspect; no upload write grant is required.

The view excludes campaign-level brand-guideline logos, Responsive Display, other associations and video.
It does not establish serving, policy approval, historical attribution, performance, reuse eligibility or
complete absence across other formats. Only selected typed metadata and query/hash/time/count references
are disclosed. No ad text, media URLs, events, people, raw native bodies, credentials or native continuation
are retained. No write review, advertising mutation or report snapshot is created.

## Website and MCP

Qualified original Google image assets advertise both selected views. The creative library adds an explicit
English/Arabic chooser with separate ad-link and Performance Max asset-group labels. PMax results show
group ID/name/resource, campaign, original image, role and independent link/group/campaign configuration.
Original native IDs/types are LTR and source names are escaped. A named keyboard-focusable scrolling table
bounds large results. Counts distinguish links, asset groups, unresolved links and removed links.

Changing the selected view or limit invalidates pending responses and clears current results without issuing
a native read. The read button captures exact view/limit and requires those values, the original asset,
navigation and session to remain current before rendering. Response view mismatches refuse display.
Meta paging and the default Google read remain available. Selected authored refusals and the new static
meaning are part of the locale coverage check; dynamic provider text is preserved as source text.

The MCP schema and both deployment descriptions explain the explicit view selector and exclusions. The real
reader SDK journey discovers the original asset's views, validates arguments, checks text/structured parity,
follows the original media handoff and refuses revoked access before further native work.

## Qualification and continuing scope

Feature baseline: **1/0/1/0, 784.795 ms**; corrected baseline: **1/1/0/0, 3.152 seconds**.
Eight backend cases cover selected-view identity/configuration, removed/unknown/non-image links, multiple roles,
order-independent collections, malformed/foreign hierarchy, changed native results and current authority/source,
collection bounds/count gaps/continuation/bytes, 1,000 links, empty selected views and default/Meta separation.
Two bilingual controller cases use real localization and exercise exact group IDs, source escaping, status/count
semantics, explicit view choice, stale response refusal and view/limit invalidation. One authenticated HTTP
viewer case verifies original scope, no-store and CSRF. The real SDK journey uses three calls, 7,460 structured
response bytes and six synthetic native reads, with zero external requests or mutations.

Combined PMax/default Google/Meta/library/reader/controller/HTTP/SDK suite: **54/54/0/0, 4.251 seconds**.
Related suite: **28/28/0/0, 3.679 seconds**. The later Meta-selector refusal passed the eight-case backend suite.
Website checks pass for 34 scripts, three pages and 3,443 selected Arabic messages. All 3,630 previous Arabic
catalog entries are preserved; sixteen entries were added, with UTF-8 without BOM and LF source bytes.
Fresh report regeneration, sanitized full gates and exact committed-source verification follow separately.

The prior batch 143 code is `7dc10160a206704567efdb9a90d88d997802e7a1`, final revision
`af9167be90e56e2681b36ac8700e4de1fcfa9d2e`. Fresh maintained source proof matched 1,732 public Git blobs,
one generated literal empty sample and three tracked reports, source hash
`88eb29b4de6070b5d0ae914428b74d9de34d145ca999eae15db0e019bfb89a3c`. All final offline gates passed;
main **4,229/4,224/0/5, 119.029 seconds**, capture **4/4/0/0, 73.545 ms**, report bytes preserved. Sole Work-here
push completed. Its exact [CI198](https://github.com/magdyezy1/CAMCP/actions/runs/37201862558), job `111435034041`,
is running; a running job does not establish Linux/Docker qualification for this source.

The package matrix remains **13 implemented / 14 partial / one open** and native totals remain
**3,247 exposed / 167 blocked / 800 reviewed rows**. Actual browser/assistive and deployed/provider/entitlement
acceptance remain separate. The browser runtime most recently failed with the kernel-assets missing-path
error; controller/HTTP/SDK fixtures do not replace visual or live acceptance. Work on the full plan continues.

## Batch 144 sanitized release preflight

Fresh offline install/build/early tracked-report freshness/full check/Railway all passed with every exit zero.
Main **4,241/4,236/0/5, 123.952 seconds**; capture **4/4/0/0, 84.343 ms**. Five local skips require FFmpeg;
the exact Linux/Docker gates remain separate. Website: 34 scripts, three pages, 3,443 selected Arabic messages.
Documentation index: 310 documents. Manifest: 1,735 public source files plus one generated literal empty sample;
preflight source hash `9a13c2de19c8cdaecb0b2f92a280abc29a78ccfd53306caabf5823c050bcf50f`.
All three public reports regenerated unchanged after the final sanitized build and preserved their bytes
through qualification. The private root sample was not read. This record follows that candidate; the final
committed source therefore requires fresh maintained Git blob/manifest/report/sample proof and full gates
before the sole Work-here push. No live/deployed/browser acceptance is implied. The full plan continues.

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

## Batch 144 committed-source release

Code ed36044 and final fd4a016 were pushed solely to Work-here after fresh exact-source proof matched 1,735
public Git blobs, one generated literal empty sample and all three tracked reports. Source hash
`f88a19b0929a4b4725ed998642b7b08fddae632517efb37118888b07491e2dd4`. All final offline gates passed; main
4,241/4,236/0/5 (120.528 seconds), capture 4/4/0/0 (72.957 ms), report bytes unchanged. Exact CI199,
run 37203914148/job 111441041201, is running; final Linux/Docker qualification follows separately.

## Batch 144 exact Linux/Docker qualification confirmed during batch 145

Decoded [CI199](https://github.com/magdyezy1/CAMCP/actions/runs/37203914148), job `111441041201`, confirms exact revision
`fd4a01667a17342146b5edb2904fe70b4c020963` and source hash
`f88a19b0929a4b4725ed998642b7b08fddae632517efb37118888b07491e2dd4`: 1,735 public Git blobs,
one generated literal empty sample and all three tracked reports. All twenty job steps completed successfully,
including host FFmpeg, source proof before installation, early report freshness, full checks, Railway checks,
Docker build/image identification and both synthetic container smoke modes. Host main
**4,241/4,241/0/0, 732.299 seconds**; host capture **4/4/0/0, 73.813 ms**.
Docker main **4,241/4,241/0/0, 743.655 seconds**; Docker capture **4/4/0/0, 74.754 ms**.
This qualifies the prior source's Linux/Docker pipeline, not later source, deployed service, actual
browser/assistive journey or live provider acceptance. Earlier running-CI observations remain historical.
