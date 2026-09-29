# Workspace operations

AMCP adds three tools: `amcp_workspace`, `amcp_campaign`, and `amcp_reporting`. `amcp_media` also supports private Drive, variants and a reusable account-bound library. `amcp_ad_previews` gathers preview links of existing ads ([ad previews](AD-PREVIEWS.md)). The runtime exposes 26 tools with writes disabled and 28 with reviewed writes enabled. Captured compatibility catalog counts are unchanged.

The website adds `/dashboard`, `/campaigns`, `/media`, `/reports` and `/profiles`. On `/media`, *Push creatives* brings in several files at once (uploaded, from a public link, or from Google Drive files and folders selected in a Drive login) and pushes them to advertising accounts on one or several platforms, fitted to each platform when asked; see [media uploads](MEDIA-UPLOADS.md). *Preview your ads* on the same page gathers the platforms' preview links for existing ads. These pages use the same service operations as MCP. Data calls require an AMCP session and CSRF token; campaign and media execution still require the frozen review and explicit confirmation. The server rechecks the website session at native access boundaries. Preview URLs are authenticated, owner/admin-bound and noncacheable.

The [workspace workflow guide](../Skills/amcp-campaign-builder/references/workspace.md) documents tool arguments, dependency references, profile templates, media processing and reporting semantics. MCP clients discover it at `amcp://guides/workspace`; the campaign prompt includes it.

## Runtime dependencies and setup

- Node.js 24 and the existing SQLite volume retain plans, profiles, source-linked reports, upload receipts and verification jobs across restart. No extra runtime npm dependency is added.
- The Docker build and runtime include FFmpeg/ffprobe. Local users install these binaries and may set `AMCP_FFMPEG_PATH` and `AMCP_FFPROBE_PATH`. Conversion accepts one image/video stream, up to 40 megapixels and 180 seconds, with input and output within the configured media limit (128 MiB by default). At most two conversions run at once. The process uses no shell, fixed format/codec arguments, a protocol allowlist and strict time/output limits; originals are never overwritten.
- Google Drive uses `AMCP_DRIVE_CLIENT_ID` and `AMCP_DRIVE_CLIENT_SECRET`, or the existing Google app when both dedicated variables are unset. Enable Drive API, register `https://amcp.shop/api/auth/drive/callback`, and authorize the `drive.readonly` scope. It may require provider app verification. Connect Drive, sync files and select only the files AMCP may import. Drive access is always a read-only media source, independent of advertising write defaults. Refresh tokens are encrypted through the existing credential store.
- Reports and write-verification jobs run in the existing HTTP worker (unless `AMCP_RUN_WORKER=false`) or `npm run worker`. A stdio-only process can use `amcp_campaign verify` explicitly. Background verification retains the originating connector identity and stops when its key or account access is revoked. Verification never resubmits a mutation.
- Variant previews share the encrypted staging quota: two pending files per tenant, eight globally, five-minute expiry. A preview and its upload review consume the two slots until upload/cancellation/expiry. Variants are staged copies; import a new source when the preview expires. With explicit `reuse_existing:true`, an identical upload receipt is reused only after a fresh provider availability check confirms the media is ready; a platform without such a check needs a new reviewed upload.

## Qualification and limits

The campaign runner compiles explicit native steps from an LLM or approved template; prose alone does not create campaign settings. Missing Page identities, destinations, budgets, provider permissions or unimplemented write contracts remain blockers. Serving entities start paused/draft under their native contracts. Successful steps are retained; uncertain writes cannot be retried with another key automatically. Cancellation leaves provider resources intact.

Write verification projects the expected native configuration and validates resource identity on the read-back. Supported ad-platform adapters include Meta, Google Ads, TikTok, Snapchat, LinkedIn, X, DV360, Reddit and Microsoft; particular operations can still return `unsupported` or `unverified` when no complete read-back contract exists. Deletes, complex patches and certain provider-generated creative representations cannot be generically compared or rolled back. A mismatch identifies field paths and hashes. A failed verification cannot turn an uncertain write into permission to resubmit it.

Readiness reports only requested prerequisites. Recent inventory can establish that an asset was returned by the connected login; it does not prove every permission or placement is eligible. The dashboard displays the timestamp and actual account/action evidence instead of inferring live readiness from source code or catalog presence.

Captured reports preserve exact decimal strings up to nine decimal places. Conversion of native divisors truncates finer sub-nanounit precision. Currency/timezone/attribution/date semantics are caller-declared and must match the actual native query. Source hashes permit consistency checks; they do not independently certify a caller's mapping. Reconciliation labels manually supplied references. Reach/frequency are not additive, and attributed cross-platform conversions are not unique business conversions. Optimization is heuristic, sample-gated, freshness-aware and review-only; bounded budget suggestions also require explicit current budget inputs.

`tests/workspace-operations.test.ts` exercises campaign dependencies, recovery, immutable plans, read-back budget mismatches, background revocation, profiles, readiness, report provenance, decimal totals, incomplete reads, reconciliation, optimization, Google validate-only and HTTP access controls. `tests/private-media.test.ts` exercises Drive OAuth, file selection, download permission, identity checks, revocation, encrypted staging, reuse and real FFmpeg conversion. Release CI requires FFmpeg; a local host without it explicitly skips the binary integration test. Existing provider/media/state-guard suites remain required.

No live advertising mutation is required to run these tests. Credentials, live-account acceptance and OAuth app approval remain separate qualification work.

## Sources

Provider behavior follows [Google Drive download documentation](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [Drive search documentation](https://developers.google.com/workspace/drive/api/guides/search-files), [Google Ads validation semantics](https://developers.google.com/google-ads/api/docs/concepts/api-structure), and the [FFmpeg protocol documentation](https://ffmpeg.org/ffmpeg-protocols.html).

## Accounts, reporting and operating controls

See [account setup](USER-ACCOUNTS.md), [Reporting Overview](REPORTING-OVERVIEW.md) and [implementation/acceptance notes](RECOMMENDATIONS-IMPLEMENTED.md) for owner migration, team access, MFA, custom metrics, scheduled Sheets exports, campaign preflight/recovery, spending policies, asynchronous media and encrypted backups.
