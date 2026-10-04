# Original Snapchat top-snap creative references — 4 October 2026

Repository `magdyezy1/CAMCP`; sole working and push branch `Work-here`; checkout `CAMCP-Codes-final-branch`.
Batch 147 extends B10/B15/B22/B24 and improves local release qualification in B16. The full package matrix
remains 13 implemented / 14 partial / 1 open; remaining formats and actual provider/browser acceptance stay open.

## Delivered behavior

`amcp_media {action:"asset_usage",asset_id:"<original receipt>",reference_view:"snapchat_top_snap",limit:50}`
reads literal `creative.top_snap_media_id` references for an original Snapchat image/video upload receipt.
Omitting the view selects this same Snapchat view. Exact original account/media UUIDs, uploaded SHA-256,
current recorded Snapchat Marketing API permission and current account/connection access are required.
Reader role and a write-disabled deployment work; no upload or advertising write grant is required.

The original account and media observations bracket two complete account creative collections. Original
media is found through account-scoped media pages; each discovery stops at the exact original ID and is
bounded at 1,000 examined media rows. It does not claim a complete media inventory. The native page size is
50; the caller's 1–1,000 bound covers all examined creatives, rather than matching references alone. Each
operation shares 84 native attempts including retries, 4,102 collected rows, 8 MiB and 60 seconds. These are
AMCP inspection bounds, not claims about Snapchat account capacity or native row limits. A page or resource
outside these bounds requires a different qualified workflow; no partial reference result is returned.

Only fixed original-account GETs are issued. Continuation links are parsed for their opaque cursor and
reconstructed into the fixed current account/collection with page size 50. Changed origins, paths, accounts,
filters, duplicate query keys, malformed/missing tokens, repeated cursors, failed/foreign/missing identities,
duplicate rows and unexpected completion metadata are refused. Response chunks, requests and final output
check current actor/session, original receipt, recorded permissions and encrypted credential identity.
The source/account and selected complete creative projections must remain identical across observations.

Results retain exact creative ID/name/type, scalar media ID and separate native packaging/review states.
Missing fields stay unknown. Original media processing status is distinct. Native URLs, headlines, nested
objects, download links and opaque native cursors are omitted; read references contain only selected request
metadata, projected hashes and cursor hashes. Standard local timing/rate counters remain. No reference
snapshot, standalone-resource ownership record, plan, provider mutation or write grant is created.

The English/Arabic panel performs an explicit read and shows escaped names, LTR UUIDs, a focusable named
table, distinct statuses and bounded scoped counts. Input edits clear the displayed observation and stale
form/order/route/identity responses are withheld. Qualified MCP handoffs preserve the original asset and
selected bound; opening a handoff does not automatically read Snapchat. Meta paging and the three Google
image views preserve their original behavior. Unsupported receipts expose no native read control.

## Interpretation and remaining scope

This view covers literal top-snap creative references, including creative records outside retained AMCP
plans. It does not infer ads, ad squads or campaigns from a creative. Nested media, icons, previews,
dynamic templates, lead-form media, other associations, historical assignment and performance remain
outside it. Native packaging, review and media-processing states do not establish ad serving, policy
qualification for a new write or reuse eligibility. A complete result means that the selected visible
creative collection was observed twice and matched; it is not an atomic inventory or complete all-format
absence proof. Large-account original-media searches and additional formats/providers need separate
qualification. Actual Snapchat acceptance and rendered browser/assistive-technology acceptance remain open.

## Primary contracts consulted

The following current official sources were inspected on 2026-10-04:

- [Snapchat creatives](https://developers.snap.com/marketing-api/Ads-API/creatives): account collection GET,
  literal top-snap reference, creative identity/name/type and system packaging/review fields. Creative
  objects may be used by more than one ad; a creative record is not an ad identity.
- [Snapchat media](https://developers.snap.com/marketing-api/Ads-API/media): account-owned media collection,
  image/video types and media processing states. Media can be used by more than one creative.
- [Snapchat API patterns](https://www.developers.snap.com/marketing-api/Ads-API/api-patterns): account
  creative/media pagination, native 50–1,000 page-size range and `paging.next_link`.

The unavailable standalone pagination URL was not used as evidence. No native write family or captured
catalog route was promoted by this high-level read; ledger support counts remain unchanged.

## Synthetic verification

Before implementation the original reader test failed with `ASSET_USAGE_UNQUALIFIED` (1/0/1/0,
717.886 ms); the same test passed after implementation (1/1/0/0, 2,945.353 ms). An earlier incorrect
fixture import was corrected before that behavioral baseline. Twenty new backend/controller/SDK/HTTP
tests cover exact image/video sources, native completion/paging, empty and unknown observations, all
bounded selections, source/status changes, credential/scope/session withdrawal and malformed/oversized
response chunks. The maximum positive fixture examines 1,000 creatives and finds original media at the
1,000-row discovery bound with 82 native requests and 4,002 collected rows, without ownership grants.

The combined Snapchat/Meta/Google reference regression passes **81/81/0/0, 18.866 seconds**. The real MCP
SDK journey uses **four tool calls, 7,350 structured response bytes, six synthetic native reads and zero
external provider requests/mutations**; input-schema, text/structured parity, exact original handoff,
wrong provider view and revoked access are checked. Authenticated website viewers preserve CSRF/no-store
and withhold results after session withdrawal. Website checks cover 34 browser scripts, three pages and
3,535 selected Arabic messages. All 3,705 previous Arabic catalog values are preserved; 36 new entries
bring the catalog to 3,741. Controller fixtures are VM tests. Actual rendered-browser acceptance is separate.

## Local FFmpeg qualification

An ignored workspace dependency now permits the five formerly skipped media cases to execute locally.
[FFmpeg's official download page](https://ffmpeg.org/download.html) links the BtbN Windows build publisher.
Observed [publisher release metadata](https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest) pins
`ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip`, 86,574,821 bytes and archive SHA-256
`af22cb6fb0af76c1cbb8053e6aa778c78d99cea2ce047e9a83f187972a5b1fcb`. Certificate-validated HTTPS,
exact size/hash verification and bounded archive-path validation preceded extraction and execution.
FFmpeg and ffprobe report `n9.0.2-22-g46d8f462ee-20261003`. The executables and DLLs remain inside ignored
`.runtime/`; machine settings, production configuration and public release contents are unchanged.
The Windows Schannel download attempts failed; the successful download used the bundled Python/OpenSSL
runtime with certificate validation. No TLS verification was disabled.

`AMCP_REQUIRE_FFMPEG=true` with explicit `AMCP_FFMPEG_PATH` and `AMCP_FFPROBE_PATH` runs the media-source
and private-media suites: **20/20/0/0, 9.523 seconds**, including all five previously skipped conversions
and synthetic reviewed-upload byte checks. Generated flat-color images/videos are the only media used.
This is Windows FFmpeg qualification; Linux/Docker acceptance of new source remains separate.

## Owner-directed CI policy

[CI201](https://github.com/magdyezy1/CAMCP/actions/runs/37210299617), revision
`29335ed8b38362c5196e59ddf3f5732ea843d7a0`, failed twice before receiving a runner. Jobs
`111459941415` and `111461556351` have runner ID 0 and zero executed steps; no application/report build
failure or log was observed. The owner confirmed exhausted GitHub Actions minutes and explicitly directed
continuing without further CI runs. No further CI retries are performed. Authorized batch commits use
the documented [GitHub skip marker](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)
`[skip ci]` for push-triggered checks. The checked workflow remains available for future funded runners.

Fresh local sanitized release/build/report freshness/full checks/Railway compatibility and exact committed
Git blob/manifest/report/empty-sample proof remain required before the sole Work-here push. Previous CI200
qualifies only `dcaedc3`; no new Linux/Docker, deployed, browser or provider acceptance is inferred.
Public report regeneration and the final source-specific release results are recorded after their checks.

## Batch 147 sanitized release preflight

Fresh offline install/build/early tracked-report freshness/full check/Railway all passed with every exit zero.
Required local FFmpeg ran all media cases: main **4,293/4,293/0/0, 157.161 seconds**; capture **4/4/0/0, 70.706 ms**.
Website checks cover 34 scripts, three pages and 3,535 selected Arabic messages; documentation index 313.
The manifest contains 1,753 public source files plus one generated literal empty sample, source hash
`a85161f5782c55d0253fac0db3a478b69dc8432185638e6fff020b484d7036da`. All three public reports regenerated unchanged after the
final sanitized build and preserved their bytes throughout qualification. The private root sample was not
read. This record follows that candidate; the final committed source requires fresh maintained Git blob/
manifest/report/sample proof and full gates before the sole Work-here push. GitHub Actions are skipped
at the owner's direction; no new Linux/Docker, deployed/browser or live provider acceptance is inferred.
The full plan continues with the remaining scope recorded in the package matrix.

## Exact committed source qualification

Revision 2225a6c0716d663c5cc2546273765ae0e4ccec40 passed fresh offline install/build/early report
freshness/full check/Railway with all exits zero and required local FFmpeg. Main 4,293/4,293/0/0
(137.982 seconds); capture 4/4/0/0 (73.255 ms); no skips. Maintained Git blob verification matched
1,753 public sources, one generated literal empty sample and three tracked reports, source hash
b6758de7b8e486e599ef7438bd7135262e4252b0de57ff9db3ae3f3c5c9890bf. Every report's bytes were preserved
and the private root sample was not read. The sole CAMCP Work-here push succeeded with [skip ci]
at the owner's direction. No new hosted CI/Linux/Docker/deployed/browser/provider acceptance is inferred.
