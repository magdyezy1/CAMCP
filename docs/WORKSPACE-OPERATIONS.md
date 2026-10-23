# Workspace operations

The [connected product workflow guide](PRODUCT-WORKFLOWS.md) covers the October 2026 website/MCP additions:
capability discovery, complete campaign controls, typed playbooks, detailed reporting, monitoring, portfolio,
measurement, commerce, resumable media plans and client report packs. Its limits and evidence states are explicit.

AMCP adds three tools: `amcp_workspace`, `amcp_campaign`, and `amcp_reporting`. `amcp_media` also supports private Drive, variants and a reusable account-bound library. `amcp_ad_previews` gathers preview links of existing ads ([ad previews](AD-PREVIEWS.md)). The runtime exposes 26 tools with writes disabled and 28 with reviewed writes enabled. Captured compatibility catalog counts are unchanged.

The website adds `/dashboard`, `/campaigns`, `/media`, `/reports` and `/profiles`. On `/media`, *Push creatives* brings in several files at once (uploaded, from a public link, or from Google Drive files and folders selected in a Drive login) and pushes them to advertising accounts on one or several platforms, fitted to each platform when asked; see [media uploads](MEDIA-UPLOADS.md). *Preview your ads* on the same page gathers the platforms' preview links for existing ads. These pages use the same service operations as MCP. Data calls require an AMCP session and CSRF token; campaign and media execution still require the frozen review and explicit confirmation. The server rechecks the website session at native access boundaries. Preview URLs are authenticated, owner/admin-bound and noncacheable.

The [workspace workflow guide](../Skills/amcp-campaign-builder/references/workspace.md) documents tool arguments, dependency references, profile templates, media processing and reporting semantics. MCP clients discover it at `amcp://guides/workspace`; the campaign prompt includes it.

## Runtime dependencies and setup

- Node.js 24 and the existing SQLite volume retain plans, profiles, source-linked reports, upload receipts and verification jobs across restart. Generated report downloads use pinned ExcelJS, PDFKit and Fontkit dependencies plus the licensed bundled font; see [generation bounds](records/DELIVERY-2026-10-01-CREATIVE-REPORTS.md).
- The Docker build and runtime include FFmpeg/ffprobe. Local users install these binaries and may set `AMCP_FFMPEG_PATH` and `AMCP_FFPROBE_PATH`. Conversion accepts one image/video stream, up to 40 megapixels and 180 seconds, with input and output within the configured media limit (128 MiB by default). At most two conversions run at once. The process uses no shell, fixed format/codec arguments, a protocol allowlist and strict time/output limits; originals are never overwritten.
- Google Drive uses `AMCP_DRIVE_CLIENT_ID` and `AMCP_DRIVE_CLIENT_SECRET`, or the existing Google app when both dedicated variables are unset. Enable Drive API, register `https://amcp.shop/api/auth/drive/callback`, and authorize the `drive.readonly` scope. It may require provider app verification. Connect Drive, sync files and select only the files AMCP may import. Drive access is always a read-only media source, independent of advertising write defaults. Refresh tokens are encrypted through the existing credential store.
- Reports and write-verification jobs run in the existing HTTP worker (unless `AMCP_RUN_WORKER=false`) or `npm run worker`. A stdio-only process can use `amcp_campaign verify` explicitly. Background verification retains the originating connector identity and stops when its key or account access is revoked. Verification never resubmits a mutation.
- Variant previews share the encrypted staging quota: two pending files per tenant, eight globally, five-minute expiry. A preview and its upload review consume the two slots until upload/cancellation/expiry. Variants are staged copies; import a new source when the preview expires. With explicit `reuse_existing:true`, an identical upload receipt is reused only after a fresh provider availability check confirms the media is ready; a platform without such a check needs a new reviewed upload.

## Qualification and limits

The campaign runner compiles explicit native steps from an LLM or approved template; prose alone does not create campaign settings. Missing Page identities, destinations, budgets, provider permissions or unimplemented write contracts remain blockers. Serving entities start paused/draft under their native contracts. Successful steps are retained; uncertain writes cannot be retried with another key automatically. Cancellation leaves provider resources intact.

Write verification projects the expected native configuration and validates resource identity on the read-back. Supported ad-platform adapters include Meta, Google Ads, TikTok, Snapchat, LinkedIn, X, DV360, Reddit and Microsoft; particular operations can still return `unsupported` or `unverified` when no complete read-back contract exists. Deletes, complex patches and certain provider-generated creative representations cannot be generically compared or rolled back. A mismatch identifies field paths and hashes. A failed verification cannot turn an uncertain write into permission to resubmit it.

Readiness reports only requested prerequisites. Recent inventory can establish that an asset was returned by the connected login; it does not prove every permission or placement is eligible. The dashboard displays the timestamp and actual account/action evidence instead of inferring live readiness from source code or catalog presence. Over MCP, `amcp_workspace dashboard` returns a bounded summary by default: counts per provider (accounts, write grants, readiness states, verified writes and the latest verification time), one row per account and campaign counts by state. `sections` (accounts, providers, connections, readiness, verified_writes, evidence, campaigns, features) returns bounded detail instead, narrowed by `gateway`, `connection_id` and `account_id`; `next_cursor` continues one section. `view:"full"` is the whole record the website's Overview reads.

A readiness check stores only actor-independent facts (CON-03): the connection binding, whether the exact account read succeeded, the account currency and timezone, and when. The viewer's role, the deployment write setting, the owner's write pause, account write grants and recorded permissions are evaluated for each viewer when Home shows the badge, so one member's check never changes another member's view. Evidence older than 15 minutes reads **Stale**. The recorded-permission check (`provider_scopes`) comes from the grant registry (`src/provider-grants.ts`) that write enforcement also reads, for every reviewed-write provider: `passed`, `blocked` with a reauthorize step, or `unknown` where no scope decides it (TikTok, X with write access requested, Criteo) or where Meta has not confirmed the grant. GA4 (Analytics Admin property), Tag Manager (account), Search Console (site), Apple Ads (ad account) and Business Profile (the selected `locations/{id}` with `readMask=name,title,storeCode`, or a selected business account; CON-06) checks make exactly one scoped read. Sheets, Drive and Criteo connections are **Not applicable** and have no account check. Advice to reauthorize appears only after a provider authentication failure; a denied account read asks for access from an account administrator, and a provider fault asks to check again.

Captured reports preserve exact decimal strings up to nine decimal places. Conversion of native divisors truncates finer sub-nanounit precision. Currency/timezone/attribution/date semantics are caller-declared and must match the actual native query. Source hashes permit consistency checks; they do not independently certify a caller's mapping. Reconciliation labels manually supplied references. Reach/frequency are not additive, and attributed cross-platform conversions are not unique business conversions. Optimization is heuristic, sample-gated, freshness-aware and review-only; bounded budget suggestions also require explicit current budget inputs.

`tests/workspace-operations.test.ts` exercises campaign dependencies, recovery, immutable plans, read-back budget mismatches, background revocation, profiles, readiness, report provenance, decimal totals, incomplete reads, reconciliation, optimization, Google validate-only and HTTP access controls. `tests/private-media.test.ts` exercises Drive OAuth, file selection, download permission, identity checks, revocation, encrypted staging, reuse and real FFmpeg conversion. Release CI requires FFmpeg; a local host without it explicitly skips the binary integration test. Existing provider/media/state-guard suites remain required.

No live advertising mutation is required to run these tests. Credentials, live-account acceptance and OAuth app approval remain separate qualification work.

## Sources

Provider behavior follows [Google Drive download documentation](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [Drive search documentation](https://developers.google.com/workspace/drive/api/guides/search-files), [Google Ads validation semantics](https://developers.google.com/google-ads/api/docs/concepts/api-structure), and the [FFmpeg protocol documentation](https://ffmpeg.org/ffmpeg-protocols.html).

## Accounts, reporting and operating controls

See [account setup](USER-ACCOUNTS.md), [Reporting Overview](REPORTING-OVERVIEW.md) and [implementation/acceptance notes](archive/RECOMMENDATIONS-IMPLEMENTED.md) for owner migration, team access, MFA, custom metrics, scheduled Sheets exports, campaign preflight/recovery, spending policies, asynchronous media and encrypted backups.


## Recovering original measurement reports

Operations and MCP can open a retained workbook run whose original native configuration uses a canonical GA4
property/resource parent, an exact Search Console site, a Tag Manager account path or a Business Profile
account/location resource name. Keep the original run ID when inspecting status or
retrieving its result. Current tenant, login and account access are checked again; read access suffices to inspect
an allowed retained result. A saved query's current replacement cannot grant access to an older different scope.

REPORT_SCOPE_UNAVAILABLE means the retained definition cannot establish one exact permitted account: conflicting,
malformed, duplicated or oversized scope remains unavailable. Inspect the original definition with authorized
access, save a corrected read-only query under its existing captured schema, and prepare a fresh run. Never change
historical job/source bytes to bypass the gate. Native write operations cannot become reporting reads.

The selected adapter accepts at most eight resource occurrences from a 64 KiB native argument object in a 128 KiB
retained envelope. GA4 projects only the exact property parent; Search Console preserves site bytes/trailing slash.
It does not infer scope from arbitrary paths, inspected page URLs or provider result rows. Legacy mapper aliases
do not expand the schema accepted for fresh queries. Tag Manager account parents retain exact opaque IDs;
Business Profile location names retain locations/{id}. Conflicting canonical parents or location selectors fail
closed. Account and location grants are separate contexts, and metadata parsing cannot establish provider ownership.
See [GA4/Search Console qualification](records/DELIVERY-2026-10-03-REPORT-RESOURCE-SCOPE.md) and
[Tag Manager/Business Profile qualification](records/DELIVERY-2026-10-03-REPORT-PARENT-SCOPE.md).

For new Business Profile GET_LOCATION and GET_LODGING reads, supply an explicit query.readMask. A location can
select "name,title"; a caller may deliberately choose "*" for lodging. Missing or blank masks fail before dispatch.
Use the original selected login and exact location grant. Older results are not rewritten to add a mask.
