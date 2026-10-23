# Original Performance Max campaign logo references and selected-view handoffs

Baseline: `fd4a016`. Batch 145 advances B08/B10/B15/B16/B22/B24 through a separately selected campaign-logo
view and preserves the original native view and bound when opening the website. The full plan continues;
this increment adds no native family, grants no write authority and establishes no live provider acceptance.

## Native contract and evidence boundaries

`amcp_media {action:"asset_usage",asset_id,reference_view:"performance_max_brand",limit:50}` reads the original
IMAGE upload's current campaign associations through `campaign_asset`. The default App/Demand Gen/Responsive
Search ad view and explicit Performance Max asset-group view remain separate. Each selected view uses six
searches without fanout: original client, original image, two complete link collections, image and client.

The [campaign setup guide](https://developers.google.com/google-ads/api/performance-max/create-campaign)
places LOGO/LANDSCAPE_LOGO brand images at campaign level when brand guidelines are enabled. The
[v25 campaign-asset fields](https://developers.google.com/google-ads/api/fields/v25/campaign_asset)
and [official proto](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/resources/campaign_asset.proto)
define the campaign, asset, role and advertiser-controlled link configuration. Campaign is a selectable
segmenting resource; the selected query includes no metrics or other segments. The
[campaign field reference](https://developers.google.com/google-ads/api/fields/v25/campaign), official source
search and pinned v25 Campaign/CampaignAsset schemas were checked on 2026-10-04. This supports the selected
read design; it is not live query acceptance.

Each projected association requires the exact original account image, exact string campaign ID/resource,
matching native link campaign, explicit PERFORMANCE_MAX channel and literal true brand-guidelines mode.
Removed campaigns, disabled/missing/string-valued mode, malformed/foreign IDs and fields, unknown enum values
outside the pinned schema and duplicate campaign/role associations refuse disclosure. Native campaign names
are optional selected metadata, with an AMCP disclosure bound of 512 code points and control/lone-surrogate
refusal. This bound is not presented as a provider name limit. No ad ID, asset-group ID or synthetic native
campaign-link resource is invented.

ENABLED/PAUSED LOGO/LANDSCAPE_LOGO links remain separate configurations. REMOVED links are counted separately.
Missing/UNKNOWN/UNSPECIFIED roles or statuses, non-logo image roles and other known roles remain unresolved.
Normalized complete collections must agree independent of native ordering. Exact receipt/SHA/IMAGE/client
brackets and current actor/key/session/login/account/scopes/credential/metadata guards remain unchanged.
Default 50, explicit 1–1000 links, 24 attempts, 2,100 rows, 4 MiB and 60 seconds bound both collections and
retries. Overflow, count gaps, nonterminal pages or changed source/authority never produce a partial inventory
labelled complete. Reader grants and disabled-write deployments remain supported.

Campaign links are not individual ads or asset groups. This view excludes asset-group/ad-image associations,
other associations and video. It establishes no serving, policy, performance, historical attribution, reuse
eligibility or complete all-format absence. No provider write, review, report snapshot, people/events, raw
native response, media URL or native cursor is retained or disclosed.

## Website and MCP workflow

Qualified Google original images advertise three independently selected views. English/Arabic controls add
a campaign-logo choice and a named, keyboard-focusable scrolling table with exact LTR campaign/image/role IDs,
escaped original names, link/campaign configuration, enabled brand mode and separate campaign/link counts.
Empty, unknown and removed observations preserve their scope. View/limit edits clear results and invalidate
pending responses; a mismatched response view cannot render. No view choice triggers a native read.

The handoff regression showed that an image result linked to its original asset but lost its selected view
and collection bound. Qualified complete Google results now append only recognized view/resource pairs and
an integer 1–1000 bound to the original media link. The website restores those choices only for the matching
asset. Current explicit edits update the bounded URL state; opening a different asset clears those choices.
Unqualified or malformed outcome fields cannot choose a view or bound. Meta's original asset/cursor handoff
remains unchanged. The handoff initializes controls and waits for the explicit read button.

Both MCP deployment descriptions and the argument schema describe the third view and its exclusions.
The real SDK journey validates discovery/schema/text parity, exact original asset/view/limit handoff and
revoked-access refusal. It uses three tool calls, 7,571 structured response bytes and six synthetic native reads,
with zero external requests or mutations.

## Qualification and continuing scope

Feature baseline **1/0/1/0, 563.024 ms**; corrected **1/1/0/0, 3.034 seconds**. Handoff baseline
**1/0/1/0, 72.605 ms**; corrected **1/1/0/0, 81.096 ms**. Nine backend/outcome cases cover exact hierarchy,
configured/unknown/removed roles, literal brand mode, multiple logo roles and ordering, current authority/source,
collection bounds/counts/bytes/cursors, complete 1,000 links, empty selected views, default/Meta separation and
qualified handoff parameters. Three bilingual controller cases cover escaped exact IDs, scoped meaning/status,
view/limit changes, stale/mismatched responses, original handoff initialization and changed-asset clearing.
An authenticated viewer case verifies original scope, CSRF and no-store.

Combined Google/Meta/library/reader/controller/HTTP/SDK suite: **68/68/0/0, 2.131 seconds**. Website checks:
34 scripts, three pages and 3,452 selected Arabic messages. All 3,646 previous Arabic catalog entries are
preserved; eleven entries were added, with UTF-8 without BOM and LF source bytes. Fresh sanitized report
regeneration and full gates follow separately; this targeted record is not full release qualification.

Prior batch 144 code: `ed36044f814c9753b775111b1148b4c0c5d99850`; final revision:
`fd4a01667a17342146b5edb2904fe70b4c020963`. Maintained exact-source proof matched 1,735 public Git blobs,
one generated literal empty sample and all three tracked reports, source hash
`f88a19b0929a4b4725ed998642b7b08fddae632517efb37118888b07491e2dd4`. Final offline install/build/early freshness/
full check/Railway passed; main **4,241/4,236/0/5, 120.528 seconds**, capture **4/4/0/0, 72.957 ms**, unchanged
tracked report bytes. Sole Work-here push completed. Exact [CI199](https://github.com/magdyezy1/CAMCP/actions/runs/37203914148),
job `111441041201`, is running; it still requires decoded exact-source Linux/Docker/smoke qualification.

The matrix remains **13 implemented / 14 partial / one open**, with **3,247 exposed / 167 blocked / 800 reviewed
native rows**. Selected read views and handoff metadata do not add native families. Public MCP discovery replied
with compact metadata; no deployed revision was identified by that response. Actual browser/assistive, deployed,
provider and entitlement acceptance remain separate. The browser runtime failed again around 12:57 UTC with
the kernel-assets missing-path error; controller/HTTP/SDK checks do not replace browser acceptance.

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

The related workflow/metadata/locale suite passes **19/19/0/0, 3.803 seconds** after the final changes.

## Batch 145 sanitized release preflight

Fresh offline install/build/early tracked-report freshness/full check/Railway all passed with every exit zero.
Main **4,255/4,250/0/5, 131.702 seconds**; capture **4/4/0/0, 79.301 ms**. Five local skips require FFmpeg;
the exact Linux/Docker gates remain separate. Website: 34 scripts, three pages, 3,452 selected Arabic messages.
Documentation index: 311 documents. Manifest: 1,738 public source files plus one generated literal empty sample;
preflight source hash `718fd02ea960b40b91f7b226185ffb1d5bb5809f9fc771ab5c739bf151b7bf4d`.
All three public reports regenerated unchanged after the final sanitized build and preserved their bytes
through qualification. The private root sample was not read. This record follows that candidate; the final
committed source therefore requires fresh maintained Git blob/manifest/report/sample proof and full gates
before the sole Work-here push. No live/deployed/browser acceptance is implied. The full plan continues.

## Exact batch 145 CI200 qualified during batch 146

Decoded [CI200](https://github.com/magdyezy1/CAMCP/actions/runs/37207099517), job 111450455240, confirms
exact dcaedc3c27d78e9285ba2719e231baf29606b304 and source hash
`2c0534fa0a1c3c2bd77ad6bbd2e8a238c1f1d9cea6ee578d52607f8b1da9ba3b`: 1,738 public Git blobs, one
generated empty sample and all three tracked reports. Linux main 4,255/4,255/0/0 (737.250 seconds),
Docker main 4,255/4,255/0/0 (744.891 seconds), both capture suites 4/4/0/0, and all twenty steps including
FFmpeg, early freshness, maintained source proof, Railway, Docker image identification, both synthetic
container smoke modes and upload completed successfully. This is exact-source CI, not deployed/browser
or live-provider acceptance. Earlier running observations are historical.
