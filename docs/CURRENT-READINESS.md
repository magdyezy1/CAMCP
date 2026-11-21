---
status: current
tier: operator
---

# Current readiness

What AMCP does today, how far each part has been accepted, and what is left. This page describes branch `Work-here`
of `magdyezy1/CAMCP` as deployed on amcp.shop on 2026-10-18 (the [deployment record](records/DEPLOYMENT-2026-10-18.md)
names the revision) together with the later work no deployment report covers yet: wave 4b, pushed on 2026-10-24, wave
4c, merged and qualified on 2026-10-30, and the V2 work of `Work-here-V2` (section 2). It was rewritten on 2026-10-22
(DOC-01).

Numbers in this page and every table marked "generated" are written from the code and the committed ledgers by
`npm run docs:index`, and `npm run docs:index:check` (part of `npm run check` and the Docker build) fails when one of
them no longer matches, so they cannot drift. Everything else is a dated description; the decision record
([decisions](DECISIONS.md)) and the [package status](review/PACKAGE-STATUS.md) are the sources for owner decisions and
package states.

## 1. How to read a status

Every part of AMCP is in one of these states:

- **Implemented in source.** The behaviour exists in the code and passes its automated tests, which use synthetic
  provider fakes and loopback browsers. No test reaches a real advertising account.
- **Owner-run acceptance pending.** What proves the behaviour against real accounts, the deployed site or real people
  (an authorized live read or write, a check on amcp.shop, an assistive-technology session, an editorial review) has
  not been run. Only the owner can authorize it: provider accounts stay read-only (owner instruction of 2026-10-09),
  and live acceptance stays read-only until test accounts are designated (R1). The runbooks are in
  [acceptance](acceptance/README.md); none has been run.
- **Externally blocked.** It needs an approval or a resource that only a provider can grant.
- **Parked.** The owner deliberately put it aside; it is not offered.

Nothing in AMCP is live-qualified yet: every one of the <!-- fact:ledger_actions -->3,261<!-- /fact --> actions in the
[action ledger](implementation/ACTION-CONTRACT-COVERAGE.json) still has `live_qualification: unverified`, and no
authorized live write has been accepted. Read-only observations made on owner-selected accounts in early October 2026
(account metadata and bounded report reads for Google Ads, Meta, Snapchat, LinkedIn, GA4 and Search Console) are kept
in the delivery records; they qualify no workflow, and no package acceptance rests on them.

## 2. Deployed state

**On amcp.shop (deployed 2026-10-18).** Waves 1 to 4a of the 2026-10-08 engineering review, the SDK upgrade to
1.32.1, the public documentation pins and the owner-approved legal pages (D3) were pushed to `Work-here` on
2026-10-18. Railway's Linux build then failed twice where the Windows release gate and the Windows container-parity
run had passed, and both causes were fixed and pushed:

1. `node:sqlite` in the image refuses the backup rate `-1` (SQLite's "every page in one step"), so `snapshotDatabase`
   uses `0x7fffffff`, the largest positive 32-bit page batch, which copies any database below 2^31 pages in one step
   from one read snapshot.
2. The Docker build runs `npm run check` as root, and the admin CLI refuses root without `--allow-root`, so the
   same-volume backup test passes `--allow-root` to reach the check it tests, `BACKUP_SAME_VOLUME`.

Once the build passed, the deployment refused to start because of the Railway variable `AMCP_LINKEDIN_API_VERSION`:
AMCP refuses to start with a LinkedIn version it has not reviewed. The owner set it to `202609`, and Railway reported
the deployment of the second fix successful and active (owner report, 2026-10-18). The
[deployment record](records/DEPLOYMENT-2026-10-18.md) names the pushed, fixed and deployed revisions. What the Railway
build log proves is not yet recorded: the owner exports it and runs `npm run evidence:railway`
([Linux evidence](DEPLOY-RAILWAY.md#per-release-linux-evidence-from-railway-builds)). The lessons for the next push are
in [the deployment guide](DEPLOY-RAILWAY.md#what-the-2026-10-18-deployment-taught).

**Not reported deployed.** Wave 4b, confirmed by the owner on 2026-10-22 (MCP quality, design review, design system,
this current-state documentation and the owner guide), was pushed to `Work-here` on 2026-10-24 once its release gate,
container parity and rendered browser qualification had passed ([qualification
record](records/QUALIFICATION-4b-2026-10-24.md)); no deployment of it has been reported yet. Wave 4c, which the owner
instructed on 2026-10-24, was pushed to `Work-here` on 2026-10-30 once the same checks had passed ([qualification
record](records/QUALIFICATION-4c-2026-10-30.md)): the documentation consolidation (each page's front matter, the
generated index and status page, the findings register as data, the operations and workflow task pages and the size
budget), the members-only Help page with the owner guide condensed in English and Arabic, Home's outcome labels, and
the ARC-01 and ARC-04 work (provider facts and hooks in the provider adapters, and no backend function of 400 lines or
more). Its last part is merged into `Work-here`: ARC-01's local targets (no shared module imports a provider module), a
reviewer pass in the browser qualification, with a test account no longer shown the account controls and report-job
grants it is always refused, a full qualification that finds an installed ffprobe, and reviewer approvals labelled
Reviewer, as the owner decided on 2026-10-31; outside its own test workspace a test account is a viewer. Its release
gate, container parity and rendered browser qualification passed on 2026-10-31 ([qualification
record](records/QUALIFICATION-4c-r7-2026-10-31.md)); no deployment of wave 4c has been reported yet.

### V2 on `Work-here-V2`

This tree also holds the V2 work of rounds 1 and 2, which no deployment reports: Reporting Overview v4 (campaign, ad set
or ad group and ad levels for every platform within bounded requests, scoped and delivered-only reads, platform-led
objectives, exact totals with row coverage, saved reports upgraded when they run), LinkedIn conversion-rule attribution
windows, ad previews behind provider hooks, charts in the report page and its PDF, the SDK v2 MCP server with typed
report schemas, progress, tasks and a per-client contract profile (V2 plan D26), one route registry and shell with the V2
components, the owner's brand kit, and the fixes of the differential reviews (credential redaction, audited transport
refusals, PDF export of names with combining marks). Its only checks so far are automated tests with synthetic fakes and
loopback browsers ([acceptance record](records/WAVE5-ROUNDS-1-2-CLAUDE-ACCEPTANCE.md)). No live check has run: staging does not exist (blocked: no staging (V2 plan D20)), provider use is not
permitted during development, and live deployment is the owner's deferral of 2026-11-03 (quoted in [the V2 round 1
qualification](records/QUALIFICATION-V2-R1-2026-11-03.md)).

**Tool-list budget.** The limit of 95 KiB (97,280 bytes) on `tools/list` is not raised. Measured on this tree on
2026-11-14 with `node tools/measure-tool-list.mjs`: <!-- fact:tools_list_bytes_writes -->97,253<!-- /fact --> bytes with
reviewed writes (27 under the limit) and <!-- fact:tools_list_bytes_read_only -->94,857<!-- /fact --> read-only; a client
whose registration record says `v2` is served 97,239 and 94,843. Tasks 16 to 18 fit under D14 without a raise: the typed
report schemas were paid for by savings first (argument notes moved to the help), and progress, tasks and the profile add
no listing entry. The next addition to the listing must find savings, or the limit is re-recorded under D14.

## 3. Package status

The blueprint's 28 packages report three separate axes (owner decision D25): source acceptance against the package's
blueprint property, native/live acceptance and manual/deployed acceptance. The axes are never added into one figure,
and a documented blocker never completes an axis.

<!-- doc-facts:package-status:begin (generated by npm run docs:index; do not edit) -->
Generated from [package-status.json](review/package-status.json), status as of 2026-10-10.
[Package status](review/PACKAGE-STATUS.md) has every remainder and the test files each package cites.

| Axis | Count |
|---|---|
| Source acceptance (of 28) | met 20 · not met 8 |
| Native/live acceptance | none 28 · read_verified 0 · write_verified 0 |
| Manual/deployed acceptance | not_recorded 26 · pending_owner 1 · accepted 0 · amended 1 |

| Package | Deliverable | Source | Native | Manual |
|---|---|---|---|---|
| B01 | Privacy and final dispatch-authority repairs | met | none | not recorded |
| B02 | Identity-safe drafts and navigation | met | none | not recorded |
| B03 | Reporting arithmetic, null and pagination correctness | met | none | not recorded |
| B04 | Media/report recovery and useful errors | met | none | not recorded |
| B05 | Requirements-driven readable review | met | none | not recorded |
| B06 | Campaign list/detail, whole-plan run and journal | met | none | not recorded |
| B07 | Guided clone, step amendment and observed-state comparison | met | none | not recorded |
| B08 | Capability graph and account/objective eligibility | not met: ARC-03 stage B route anchors and the per-family manifests (below); the gap recorded on 2026-10-10, readiness that took requested Meta permissions as granted and recorded no TikTok or X grants, closed with CON-03 in wave 1 | none | not recorded |
| B09 | Task-oriented Home, navigation and deep links | met | none | not recorded |
| B10 | Creative library, preparation matrix and durable progress | met | none | not recorded |
| B11 | Report library/builder/results, analysis bridge and whole-job collection bounds | met | none | not recorded |
| B12 | Schedule index, timing preview and delivery recovery | met | none | not recorded |
| B13 | Operations/recovery center and support bundle UI | met | none | pending owner |
| B14 | Typed client playbooks and template preview | met | none | not recorded |
| B15 | Typed MCP outcomes and workflow evaluations | not met: Source re-assessment pending (D25): the typed per-action contracts and outcome schemas the 2026-10-10 assessment found missing shipped with MCP-07 in wave 2; 'fewer unnecessary calls' has a local journey and task baseline (QA-04) but no external-client run yet (D14) | none | not recorded |
| B16 | Browser, container, accessibility and acceptance qualification | not met: No harvested Linux evidence record: the owner reported the Railway build of the 2026-10-18 deployment successful (docs/records/DEPLOYMENT-2026-10-18.md names its revision), but its log is not yet recorded (ACC-04), and container parity outside Git cannot reproduce the image's root user, Node patch version or OS; the finite assistive-technology protocol (ACC-07) has not been run | none | amended |
| B17 | First additional objective launch packs | not met: Source re-assessment pending (D25): the Microsoft location targeting and activation gating the 2026-10-10 assessment found missing shipped with CMP-03 in waves 2 to 3b, with the lookup by name since its Microsoft Learn page was pinned on 2026-10-17; no recipe has reached a verified outcome on a real account yet (native, ACC-01) | none | not recorded |
| B18 | Guided native report capture and richer reconciliation | not met: LinkedIn conversion windows are not verified | none | not recorded |
| B19 | Read-only monitors and incident lifecycle | met | none | not recorded |
| B20 | Measurement diagnostics workspace | not met: Source re-assessment pending (D25): the Google Ads conversion goals the 2026-10-10 assessment found unreachable from the measurement workspace are reachable since MSR-02 in wave 2; what closes the package is native, one authorized goal inspection on the configured Google Ads account (ACC-06) | none | not recorded |
| B21 | Commerce ingestion and destination reconciliation | met | none | not recorded |
| B22 | Controlled bulk jobs and creative performance lineage | met | none | not recorded |
| B23 | Measured scaling, caching and module simplification | met | none | not recorded |
| B24 | Full Arabic localization | not met: Owned diagnostics with translations still render in English and some journeys are untranslated | none | not recorded |
| B25 | Conditional provider programs and enterprise/reporting bridges | not met: No requested workflow has qualified: LinkedIn programs are denied for the owner-selected account and no DV360 advertiser is configured | none | not recorded |
| B26 | Scenario planning and more advanced optimization proposals | met | none | not recorded |
| B27 | Live account portfolio and qualified entity/dimension reporting | met | none | not recorded |
| B28 | Client-facing report packs | met | none | not recorded |
<!-- doc-facts:package-status:end -->

## 4. What is implemented, by area

Each area lists what exists in source, then what remains and who it waits for. The ticket-level detail is in the
integration records of each wave and in [package status](review/PACKAGE-STATUS.md).

### Website, accounts and teams

- **In source.** Email and password accounts with Google, Apple and Facebook linking; two-step verification, required
  for owners and administrators of write-enabled workspaces (P2); invitations that last 7 days; owner, administrator,
  operator and viewer roles; a working client per workspace and optional client access sets (P1); self-service
  account deletion with an erasure receipt; retention of sign-ups, revoked accounts and reports per document kind,
  designed to GDPR and the KSA PDPL (P3); System, Light and Dark appearance; English and Arabic.
- **Owner-run.** Walkthroughs on amcp.shop, counsel review of the privacy and data-deletion pages, the Arabic editorial
  review, and the 28 assistive-technology sessions of [ACC-07](acceptance/ASSISTIVE-TECHNOLOGY.md).

### Connections

- **In source.** Website OAuth for <!-- fact:website_platforms -->16<!-- /fact --> platforms (the callback and variable
  table is in [the deployment guide](DEPLOY-RAILWAY.md#3-register-provider-apps)), several logins per provider,
  explicit account selection, readiness from the scopes a login was actually granted, reauthorization that keeps the
  connection, and the provider access register ([provider access](PROVIDER-ACCESS.md)). Revoking a Google login at
  Google on disconnect is built but off (`AMCP_PROVIDER_REVOCATION`) until the owner answers Q25 with disposable
  logins.
- **Externally blocked.** Google Business Profile waits for Google's approval of the Cloud project
  (`AMCP_GBP_API_APPROVED`, R4).
- **Owner-run.** Sync each website Google Ads login saved before manager routes were recorded once in Connections; one
  authorized read per provider.

### AI clients (MCP)

- **In source.** <!-- fact:tools_writes -->25<!-- /fact --> tools on a deployment with reviewed writes, each with a
  title and the annotations clients use to decide when to ask the user (section 7); one result envelope with typed
  outcomes; OAuth with dynamic registration and client metadata documents, refresh-token rotation with a short reuse
  window, per-credential rate limits and refused JSON-RPC batches; <!-- fact:mcp_guides -->13<!-- /fact --> guide
  resources (an index and the workflow guides) and the `amcp_build_campaign` prompt. MCP revision 2026-07-28 is
  served at `/mcp/next` when `AMCP_MCP_MODERN_PROTOCOL` is `next`, and at `/mcp` too when it is `on`; it is `off` by
  default. The stdio server reads the same variable: `off` or unset serves the earlier revisions only.
- **Owner-run.** The client matrix of [ACC-02](acceptance/CLIENT-INTEROP.md) (Claude.ai and Desktop, Claude Code,
  ChatGPT, Codex, Cursor, VS Code) on a staging deployment (R7); who runs the evaluation sessions (D14) is open.

### Reviewed changes

- **In source.** Every advertising change goes through one path: inspect, prepare a five-minute review that freezes
  the current state, its effect and its spend, then execute once with idempotency, read back and verify. Owner
  spending policies with caps in the account currency (P5); only the owner executes beyond a cap; an opt-in tier for
  destructive confirmation and opt-in approval modes; a write pause; recovery of uncertain writes without sending
  again. <!-- fact:reviewed_families -->170<!-- /fact --> reviewed write families cover
  <!-- fact:ledger_reviewed_writes -->803<!-- /fact --> ledger actions ([adding a family](ADDING-A-REVIEWED-FAMILY.md)
  lists them). A write to a route with a pinned vendor request schema is compared with it in `shadow` mode, which
  records differences without refusing (`AMCP_WIRE_CONTRACTS`).
- **Owner-run.** [ACC-01](acceptance/WRITE-ACCEPTANCE.md): one paused campaign created and verified on a designated
  test account, then the same review refused as a duplicate. It needs test accounts (R1) and an explicit write
  authorization; nothing has been written to a real account.

### Campaigns

- **In source.** <!-- fact:campaign_recipes -->17<!-- /fact --> guided recipes (<!-- fact:campaign_recipe_platforms -->Google Ads 7, Meta 3, TikTok 3, Snapchat 2, LinkedIn 1 and Microsoft Advertising 1<!-- /fact -->),
  each with a synthetic run to read-back; campaign plans with preflight, step recovery, handoff to named colleagues,
  client naming and UTM conventions, and post-launch checks. The Microsoft Search recipe targets locations and finds
  them by name through Microsoft's geographical locations file, which became available when its Microsoft Learn
  page was pinned on 2026-10-17.
- **Owner-run.** A paused creation on a provider test account per recipe family (ACC-01).

### Media

- **In source.** Uploads from the computer, public links and Google Drive; fitted variants; push to Meta, TikTok,
  Snapchat, Google Ads, LinkedIn, X and Display & Video 360 after review; a reusable account-bound library with
  per-asset usage readers for Meta, Google images and Snapchat.
- **Owner-run.** The provider spec table is unverified until each entry is compared with the provider's page
  (`verified_on`, MED-06); one bounded Meta and one Google image usage read (B10).

### Reporting

- **In source.** Reporting Overview across platforms, accounts and objectives, with campaign, ad set or ad group and ad
  levels, period comparison, retained snapshots, CSV, Excel and PDF files, Google Sheets export now or on a schedule,
  and advisory decisions that never claim causality. Provider-side report and export jobs are their own effect class:
  with writes off they run only under the owner's switch (`AMCP_PROVIDER_JOBS`) on accounts granted report jobs. The
  guide AI clients read is [reporting overview](REPORTING-OVERVIEW.md).
- **Owner-run.** [ACC-03](acceptance/SHEETS-DELIVERY.md) on a disposable spreadsheet; closed-period reconciliation reads
  per platform, including the LinkedIn conversion window that closes B18.

### Measurement

- **In source.** The measurement hub (P8): Google Ads conversion goals, GA4, Tag Manager audits and consent drafts,
  Meta pixels and datasets, Snapchat pixels, TikTok pixels, Search Console and Adjust, all read-only and with no test
  events. TikTok pixel event statistics are read since their specification was pinned on 2026-10-17; their layer
  stays unknown until a native read confirms what the fields mean.
- **Owner-run.** One authorized read per adapter ([ACC-06](acceptance/READ-ACCEPTANCE.md)).

### Commerce

- **In source.** Catalog comparison and reviewed product updates for Meta and X, a read-only Snapchat comparison,
  saved supplier column mappings and explicit removals of listed X products.
- **Externally blocked.** Live X catalog changes need X's catalog early access (COM-02).
- **Parked.** Shopify, Salla and WooCommerce store sources (PRK-01) and Criteo (PRK-02); Zoho CRM, scoped on
  2026-10-13 as CRM to ads only, is not started. They are planned last, after everything else.

### Operations

- **In source.** `/healthz`, `/versionz` with the packaged identity, owner health, encrypted backups with a restore
  drill and restore quarantine, schema migrations, workers and schedules, the Operations attention feed, the
  qualification runner, container parity outside Git and the Railway build-evidence harvester.
- **Owner-run.** Enable Railway's scheduled volume backups and run one restore drill (D4); record the Railway settings
  before 2026-11-15 (D1; Railway's config as code ends 2026-12-01); turn off Cloudflare's Web Analytics injection and
  serve unversioned assets with `no-cache` (D2); set `AMCP_CLIENT_IP_SOURCE=railway+cloudflare` (D5); remove
  `AMCP_GOOGLE_DEVELOPER_TOKEN` if it is set.

### Architecture

- **In source.** Provider adapters with a lifecycle status (active or parked), registries for reviewed families,
  remedies, portfolio adapters, report sources and jobs, website routes and document kinds (P11), the composite MCP
  tools' actions as entries of staged action tables (`src/tool-actions.ts`, ARC-04), and ratchets that
  block regressions only: import cycles and provider coupling, SQL outside the store layer, hand-escaped markup,
  literal colours and page bytes (D26). [Architecture](review/ARCHITECTURE.md) shows the ratchet table.
- **Remaining, local.** ARC-01's target (fewer shared modules naming a provider or importing a provider module),
  ARC-04's review that re-exports keep public import paths and its sign-off of the deliberate removals the
  architecture record lists (its long functions are split), ARC-03's route anchors for five gateways, and B23's and
  B24's web items, each listed in [package status](review/PACKAGE-STATUS.md).

### Arabic

- **In source.** The website in English and Arabic with right-to-left layout, and Arabic for the owned refusal
  reasons in the localization inventory.
- **Remaining.** Owned text some journeys still show in English, and the refusal reasons of the family modules outside
  the inventory (B24); then the Arabic editorial and assistive-technology reviews (owner-run).

## 5. Public documentation pins

<a id="5-recorded-on-2026-10-17-public-documentation-pins"></a>The public, unauthenticated reads that earlier waves left
to the owner were completed on 2026-10-17 and are no longer pending owner steps. The
[deployment record](records/DEPLOYMENT-2026-10-18.md#the-public-documentation-pins-of-2026-10-17) names three of them,
with what each changed and the commit that recorded it: the Microsoft Learn location file page (CMP-03), the TikTok
Pixel Event Stats specification (MSR-03) and the Meta Business SDK v25.0.3 to v26.0.2 change evidence. The fourth is
not in it:

- **Apple Ads Platform API SDK**: the re-derivation of the model evidence at its pinned revision passed with 0
  problems (ARC-03; [package status](review/PACKAGE-STATUS.md) keeps it with ARC-03's manual acceptance).

Still owner-run from earlier waves (each a public read, or a record that such reads were allowed): compare the 66
Meta currency rows with Meta's Currencies page (WRT-07), re-read the Data Manager v1 Discovery document and compare
digests (PRV-05), re-read the Microsoft Learn pages pinned before 2026-10-17
(`node tools/microsoft-rest.mjs --refresh`, CMP-03), compare each media spec entry with the provider's page
(`verified_on`, MED-06), and refresh the Cloudflare range snapshot before relying on `railway+cloudflare` (SEC-01).

## 6. Providers

<!-- doc-facts:provider-matrix:begin (generated by npm run docs:index; do not edit) -->
Generated from the provider adapter registry (`src/provider-adapters.ts`), the provider contracts at the version
AMCP sends by default (`src/provider-contracts.ts`), the sunset registry (`src/provider-sunsets.ts`), the
reviewed-family registry and the [action ledger](implementation/ACTION-CONTRACT-COVERAGE.json). A parked provider
is offered only where `AMCP_PROVIDERS` names it.

| Provider | Gateway | Status | API version | Version ends | Reviewed families | Ledger actions | Reviewed write actions |
|---|---|---|---|---|---:|---:|---:|
| Google Ads | `google_ads_native_action` | active | v25 | 2027-08 (published) | 28 | 460 | 219 |
| Google Business Profile | `google_business_native_action` | active | v1 | no date recorded | 5 | 59 | 14 |
| Meta | `meta_native_action` | active | v26.0 | no date recorded | 21 | 593 | 74 |
| TikTok | `tiktok_native_action` | active | v1.3 | no date recorded | 29 | 561 | 71 |
| Snapchat | `snapchat_native_action` | active | v1 | no date recorded | 13 | 412 | 72 |
| LinkedIn | `linkedin_native_action` | active | 202609 | 2027-09 (support period) | 18 | 287 | 68 |
| X | `x_ads_native_action` | active | 12 | no date recorded | 17 | 186 | 67 |
| Microsoft Advertising | `microsoft_ads_native_action` | active | v13 | no date recorded | 3 | 31 | 16 |
| Apple Ads | `apple_ads_native_action` | active | v1 | no date recorded | 2 | 48 | 21 |
| Reddit | `reddit_native_action` | active | v3 | no date recorded | 2 | 55 | 13 |
| Display & Video 360 | `dv360_native_action` | active | v4 | no date recorded | 15 | 173 | 62 |
| Google Analytics 4 | `ga4_native_action` | active | v1beta/v1alpha | no date recorded | 1 | 24 | 2 |
| Google Tag Manager | `gtm_native_action` | active | v2 | no date recorded | 3 | 108 | 64 |
| Google Search Console | `google_search_console_native_action` | active | v3/v1 | no date recorded | 1 | 16 | 4 |
| Adjust | `adjust_native_action` | active | Reports Service (unversioned) | no date recorded | 0 | 29 | 0 |
| Google Drive | `google_drive_native_action` | active | v3 | no date recorded | 0 | — | — |
| Google Sheets | `google_sheets_native_action` | active | v4/v3 | no date recorded | 0 | — | — |
| Criteo | `criteo_native_action` | parked (owner_parked) | 2026-07 | 2027-07 (support period) | 12 | 108 | 36 |
| WooCommerce | `commerce_native_action` | parked (owner_parked) | — | — | 0 | 31 | 0 |
| Amazon Ads | `amazon_native_action` | parked (unimplemented) | catalog-dependent | no date recorded | 0 | 0 | 0 |
<!-- doc-facts:provider-matrix:end -->

**Externally blocked.** LinkedIn's Media Planning and Audience Insights products answer 403 for the owner-selected
account 559535022, and no Display & Video 360 advertiser is configured (ACC-08, [provider
programs](acceptance/PROVIDER-PROGRAMS.md)); a 403 alone does not show a missing scope. Amazon Ads is not offered:
it has no website login (CON-06).

## 7. Tool surface

<!-- doc-facts:tool-surface:begin (generated by npm run docs:index; do not edit) -->
Generated from `tools/list` as an MCP client receives it, with `MIRROR_FLAGS` and `AMCP_PROVIDERS` unset.
A read-only deployment lists 25 tools (94,857 bytes of `tools/list`),
and a deployment with reviewed writes 25 (97,253 bytes).
The hints tell clients when to ask the user; every safeguard stays on the server (`src/tool-annotations.ts`).
Where the two deployments differ, the read-only value follows in brackets.

| Tool | Title | Read-only | Destructive | Idempotent | Open world |
|---|---|---|---|---|---|
| `meta_native_action` | Meta Ads (native reads) | no | no | no | yes |
| `tiktok_native_action` | TikTok Ads (native reads) | no | no | no | yes |
| `snapchat_native_action` | Snapchat Ads (native reads) | no | no | no | yes |
| `apple_ads_native_action` | Apple Ads (native reads) | yes | no | yes | yes |
| `dv360_native_action` | Display & Video 360 (native reads) | no | no | no | yes |
| `linkedin_native_action` | LinkedIn Ads (native reads) | no | no | no | yes |
| `google_ads_native_action` | Google Ads (native reads) | no | no | no | yes |
| `x_ads_native_action` | X Ads (native reads) | no | no | no | yes |
| `amcp_platform_workspace` | AMCP workspace context | yes | no | yes | no |
| `amcp_native_action` | AMCP workflow operations | no | yes | no | yes |
| `reddit_native_action` | Reddit Ads (native reads) | yes | no | yes | yes |
| `ga4_native_action` | Google Analytics 4 (native reads) | no | yes | no | yes |
| `gtm_native_action` | Google Tag Manager (native reads) | yes | no | yes | yes |
| `google_business_native_action` | Business Profile (native reads) | no | yes | no | yes |
| `google_search_console_native_action` | Search Console (native reads) | no | yes | no | yes |
| `adjust_native_action` | Adjust (native reads) | yes | no | yes | yes |
| `amcp_tool_help` | AMCP tool help | yes | no | yes | no |
| `microsoft_ads_native_action` | Microsoft Advertising (native reads) | no | no | no | yes |
| `amcp_workspace` | AMCP workspace and readiness | no | yes | no | yes |
| `amcp_campaign` | AMCP campaign plans | no | yes | no | yes |
| `amcp_reporting` | AMCP report analysis | no | no | no | yes |
| `amcp_reporting_overview` | AMCP client reports | no | yes | no | yes |
| `amcp_ad_previews` | AMCP ad previews | yes | no | yes | yes |
| `amcp_write` | AMCP reviewed writes (AMCP write inspection) | no (yes) | yes (no) | no (yes) | yes (no) |
| `amcp_media` | AMCP media uploads (AMCP media library) | no (yes) | yes (no) | no (yes) | yes |
<!-- doc-facts:tool-surface:end -->

## 8. Owner steps

After the 2026-10-18 deployment, in order of need:

1. **Record the deployment.** Export the Railway build log of the deployed revision (the
   [deployment record](records/DEPLOYMENT-2026-10-18.md) names it) and run `npm run evidence:railway` on it, save
   `/versionz` and check that it names that revision, then pin the Dockerfile's two `node:24-bookworm-slim` stages to
   the base image digest the evidence record shows (ACC-04, OPS-08). Compare the public website bytes
   (`npm run check:public-website`).
2. **Settings and dashboards.** The Railway, Cloudflare and backup steps under Operations above; before 2027-04-01,
   review the security contact and move `security.txt`'s `Expires` forward (D3).
3. **Sign-offs.** A security reviewer signs off ARC-01 phase B's `src/scope.ts` and `src/transport.ts` changes, the
   OAuth grant move, and wave 4c's token renewal steps (`src/auth.ts`) and OAuth app facts (`server/platform-oauth.ts`);
   a reviewer signs off ARC-04's re-exports and the deliberate removals the architecture record lists; the owner signs
   off WEB-07's component colours in light and dark mode and says which "Home" its shell-chunk criterion means; the
   owner reviews ARC-03's unanchored routes
   ([route anchors](implementation/ROUTE-ANCHOR-COVERAGE.md)) and the withheld-capture declaration
   (`.mirror/RAW/WITHHELD.json`); the owner approves the retention per document kind
   ([document kinds](DOCUMENT-KINDS.md)) and the package-status taxonomy and counts (D25).
4. **Behaviour the deployment changed.** The 2026-10-18 deployment was the first since the revision the 2026-10-08
   review examined, so it brought every release note of waves 1 to 4a ([decisions](DECISIONS.md) holds them): 7-day
   invitations; owner-only execution beyond a cap; caps without a currency that block money changes until the owner
   saves them again; Meta
   destination-only values in the review set; Amazon Ads, Criteo and WooCommerce no longer offered; owners and
   administrators of write-enabled workspaces must turn on two-step verification within 14 days; sign-ups never approved
   are erased after 30 days, revoked accounts after 90 days and, in workspaces without their own period, finished
   report records after 365 days; reviewer-workspace logins are removed after 7 days; a restore quarantines access by
   default.
5. **Acceptance.** The runbooks of [acceptance](acceptance/README.md), once the owner authorizes each one (R1 to R8).
6. **Open decisions.** R1 to R8; D11's resend choice; D14's evaluator; D15's listing goal; D17's Adjust operations;
   D25's license; D26's dependency and budget choices; D27's time-zone question; Q25.

## 9. Keeping this page current

A change is documented when the one guide that describes the behaviour says what it does now, and so does the guide AI
clients read where they read one (`docs/REPORTING-OVERVIEW.md` and `Skills/amcp-campaign-builder/references/`, served
as MCP resources). Counts and tables come from `npm run build` and `npm run docs:index`, never by hand; a dated account
of how a change was built belongs in a record, not in this page or a guide. The deployed revision is the owner's
report of Railway, not something the code knows, and a commit reference on a current page breaks the documentation
freeze (`tools/docs-lint.mjs`): when the owner reports a new deployment, add its dated record beside
[the 2026-10-18 one](records/DEPLOYMENT-2026-10-18.md) and point section 2 and the README's status line at it.
Outside its markers the check refuses the retired package vocabulary (B25 called "open", single-label package counts)
and hand-typed family, recipe, guide or tool counts (`tools/doc-facts.mjs`).
