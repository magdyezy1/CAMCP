# Provider contract implementation evidence — 2026-09-19

This is an implementation checkpoint, not completion of every provider action.
Base: `d7f3fad8f4fc499123e6be71f4d0d11408befcd4`, branch `Codex-branch`, remote
`https://github.com/magdyezy1/AMCP.git`. Only `implementation-Codex-branch` is edited;
the development and historical release checkouts are separate. No advertising,
credential, permission or production operations were performed.

## Implemented contracts

- Google Ads v23: labels and campaign/ad-group/ad/criterion associations,
  customizer attributes and customer/campaign/group/keyword bindings, ad parameters,
  campaign groups, conversion custom variables, remarketing actions, asset-group
  signals and customer exclusions. Sixteen resource descriptors add 32 reviewed
  action rows. They validate selected-customer references, mutable fields, native
  masks and prerequisites, then verify exact mutation receipts and configuration.
  Provider telemetry is excluded from state comparison after envelope validation.
- Apple Ads Platform v1: ad-group, ad, creative, keyword, negative-keyword and shared
  budget create/update/delete (18 new actions). Request types are extracted from
  the pinned official SDK. Shared budgets bind the union of old/new accounts to
  one organization and connection, require every write grant, compare currencies,
  and apply each account's spending policy atomically. Lost responses retain the
  submission claim and cannot be resubmitted using the same review.
- DV360 v4: advertiser-owned channel, negative-keyword-list and location-list
  configuration plus site/keyword/location membership (18 reviewed actions).
  Membership snapshots follow every page, reject foreign/duplicate/failed pages,
  and compare complete final sets after create/delete/bulk/replace. Replacement
  and bulk removal obey deletion policies even though their wire method is POST.

These are explicit operation contracts, not an authorization change based on a
catalog or generated schema. Native account grants, review expiry, confirmation,
owner policies, durable submission claims and read-back remain required.

## Qualification boundaries

All evidence here is source/documentation and synthetic local execution. No live
provider qualification is claimed. Route coverage does not imply all payload
variants are supported. Google customizer immutable UPDATE aliases are still
unsupported; no remove operation is invented for conversion variables or remarketing
actions. Temporary Google resource IDs and cross-customer references remain outside
these contracts. Selected customer access still depends on the provider.

Apple child creation requires paused serving entities and documented parent IDs.
Shared budget account membership is limited to 100 accounts, must retain the selected
account, and every member needs a current grant on the same connection. A positive
shared budget increase reserves that full increase against each member's policy;
this conservative accounting avoids guessing how delivery will be divided. Shared
budget and serving edits also respect the activation policy. Campaign creation's
existing bounded contract remains separate from the newly extracted SDK models.

DV360 contracts apply to advertiser-owned lists; partner-owned lists are not enabled.
Bulk changes are bounded to 1,000 members; before-state pagination is bounded to
100 pages / 10,000 members and fails before mutation when incomplete. Native targeting
option eligibility and provider processing/propagation still require live access.
Provider site normalization and eligibility are not inferred from a successful
transport receipt: read-back must match before a workflow is marked verified.

## Sources and regeneration

Reviewed on 2026-09-19:

- [Google Ads v23 RPC reference](https://developers.google.com/google-ads/api/reference/rpc/v23/overview)
  and [AdParameter](https://developers.google.com/google-ads/api/reference/rpc/v23/AdParameter).
  `tests/fixtures/google-configuration-fields-v23.json` records 82 selectable field
  facts across 16 official field-reference pages with individual URLs, capture date
  and hashes of the public parsed reference text. It does not represent raw HTML.
  `tools/google-configuration-field-evidence.mjs <public-text-directory> 2026-09-19`
  regenerates this fixture; extraction reuses `google-asset-field-evidence.mjs`.
- [Official Apple SDK source](https://github.com/apple/apple-ads-platform-api-node/blob/f90ac18b616e0ba2bbf2d17d73f54deeb2dd7af1/src/api/apple-ads-api.ts),
  revision `f90ac18b616e0ba2bbf2d17d73f54deeb2dd7af1`.
  `tools/apple-model-evidence.mjs <model-directory> <api-source-file>` extracts
  82 model facts and all 99 SDK HTTP methods. Source hashes normalize line endings
  and a final newline explicitly. No SDK runtime dependency is added.
  The vendor inventory includes all 99 methods, including 58 without mappings.
- [DV360 v4 Discovery](https://displayvideo.googleapis.com/$discovery/rest?version=v4),
  pinned document revision `20260902`, captured 2026-09-04; current official
  [site](https://developers.google.com/display-video/api/reference/rest/v4/advertisers.channels.sites),
  [negative-keyword](https://developers.google.com/display-video/api/reference/rest/v4/advertisers.negativeKeywordLists.negativeKeywords)
  and [assigned-location](https://developers.google.com/display-video/api/reference/rest/v4/advertisers.locationLists.assignedLocations)
  references checked on 2026-09-19. Request validation uses only selected models
  from the pinned Discovery document; separate contract code controls permission.

The generators fail for missing/unrecognized evidence instead of silently supplying
guessed fields. Runtime errors and guide examples are covered by existing guidance
checks; action and vendor inventories remain mechanically reproducible.

## Verification record

Windows PowerShell, Node 24.19.0, npm 11.17.0. Commands run in the isolated branch
checkout unless noted. Logs are retained locally under
`.runtime/contract-completion-20260919/` and contain synthetic fixtures only.

1. `npm.cmd run build` — passed after fixing initial TypeScript issues in the new
   modules. Type validation is performed by `tsc`, not syntax checking alone.
2. `node --test --test-concurrency=1 dist/tests/google-configuration-writes.test.js`
   — 25 passed. The first run caught an undefined association identity matching a
   customer row; corrected the lookup instead of weakening the assertion.
3. New Google plus existing measurement lifecycle tests — 62 passed.
4. New Apple plus existing spending-policy tests — 35 passed. The first Apple run
   exposed two incorrect fixture assumptions: the current SDK includes PHRASE and
   CATEGORY, and transport errors retain an uncertain submission claim. Fixtures
   now test an actually invalid enum and the durable uncertain-outcome behavior.
5. DV360 lifecycle tests initially caught an omitted default-origin case. The
   classifier now accepts the compiler's canonical default host as well as the
   explicit correct host. Foreign origins remain rejected. Subsequent coverage
   adds malformed names, duplicate assignment receipts and keyword encoding.
6. Coverage/guidance tests initially assumed vendor evidence could only exist in
   `.mirror/VENDOR`. The test now asserts the exact source set plus the Apple SDK
   artifact and its 99-method denominator, including mapped/unmapped examples.
7. `node --test --test-concurrency=1 dist/tests/action-contracts.test.js
   dist/tests/action-contract-artifacts.test.js dist/tests/guidance*.test.js
   dist/tests/google-configuration-writes.test.js dist/tests/apple-entity-writes.test.js
   dist/tests/dv360-list-writes.test.js` — **70 passed, zero failed/skipped**.

8. `node tools/prepare-public-release.mjs .release/contract-batch-20260919-a` —
   445 public files; historical response samples replaced by `[]`. Candidate source
   tree hash `7438021819bf4df83f4305f369fc0c294bc5e2bd116f072ace9538c6a25a0ccb`.
9. In that candidate: `npm.cmd ci --ignore-scripts --no-audit --no-fund --cache
   ../../.runtime/npm-cache`, then `npm.cmd run check` with `AMCP_SCHEMA_PYTHON`
   pointing to bundled Python 3.12 — **exit 0; 700 tests passed, one FFmpeg test
   skipped; four additional capture tests passed**. Generation, provider evidence,
   guidance, web, lifecycle integrity and exact contract artifact checks all passed.
   Log: `release-check-a.log`. `node deploy/check-railway.mjs` also passed.

FFmpeg and Docker are unavailable locally; the required FFmpeg and container CI
smoke checks are not established by this local pass. No hosted CI result or live
provider qualification is claimed. Branch push follows this verified checkpoint.

## First checkpoint remaining work

The generated ledger currently contains 3,241 actions / 301 reviewed-family rows,
1,016 blocked mapped writes, 107 unmapped actions, 50 unqualified reads and eight
input-dependent adapters. Independent vendor evidence now inventories 1,208
methods, 454 without mapped actions. Every remaining row stays explicit in the
generated inventories. `CONTRACT-COMPLETION-PROGRESS.md` records the next families;
this checkpoint must not be presented as completion of those rows.

## Tag Manager contract completion checkpoint

The next batch adds 24 reviewed action rows: eight entity reverts; built-in
variable creation/deletion/revert; folder moves; latest-version selection and
undelete; pinned gallery import; account update and permission CRUD; environment
reauthorization; workspace bulk edits, sync, quick preview and conflict resolution.
These are explicit contracts in `src/gtm-workflow-writes.ts` and
`src/gtm-workspace-writes.ts`, with native Discovery model/method evidence.

Administrative actions require the AMCP administrator role and the exact native
scope, without broadening default consent. Complete permission pagination protects
against duplicate grants and removing the last observed administrator. Environment
codes are replaced with one-way hashes before review/result persistence; code and
`gtm_auth` URL fields are redacted. Version latest selection does not publish.

Workspace snapshots cover all ten entity collections and the latest complete
version for sync/preview. Each page rechecks grants; missing/foreign/duplicate
entities, cursor loops and concurrently changed status prevent execution. Bounds:
100 bulk changes, 1000 entities per kind, 5000 total, 100 pages per collection,
16 MiB cumulatively read and an 8 MiB retained snapshot. Updates explicitly preserve
or clear current configuration; field hashes verify cleared arrays/objects. Trigger
ID membership is unordered; parameter and tag sequencing arrays remain ordered.

Bulk receipts are matched by exact existing IDs or unique per-kind create names
(Google tag configs use distinct types), never response position. Temporary ID
references are rewritten only in qualified identity/reference fields. Full read-back
checks affected configuration and deletion. Native semantic eligibility, container
type restrictions, template behavior and provider acceptance remain live checks.

Sync conflicts are retained as partial outcomes with recovery instructions; no
automatic mutation replay occurs. Resolution freezes the conflicted entity's
fingerprint, preserves unrelated conflicts and verifies the resolved configuration.
Quick preview validates its temporary version against the frozen intended merged
contents and reads the workspace afterward; it never invents a persistent-version
GET or claims publishing/browser execution. Uncertain outcomes keep their claim.

### Current official references

The following official pages were checked on 2026-09-19, independently of the
pinned Discovery document. These are documentation observations, not live calls:

- [Bulk update](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces/bulk_update),
  updated 2025-12-08: temporary `new_N` IDs, ProposedChange request and unordered
  Entity receipt; deleted/system-updated entities are absent from the receipt.
- [Resolve conflict](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces/resolve_conflict),
  updated 2025-03-06: Entity body, conflicted-entity fingerprint and empty response.
- [Sync](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces/sync),
  updated 2025-03-06: latest-version synchronization can succeed with unresolved
  conflicts, which still prevent version creation.
- [Quick preview](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces/quick_preview),
  updated 2025-03-06: temporary version and separate sync/compiler status.
- [Set latest](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.versions/set_latest)
  and [gallery import](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces.templates/import_from_gallery):
  exact native scope and gallery parameters. AMCP requires an explicit gallery SHA.

Four historical mappings are **provider_unsupported**, retained in the denominator:
[combine](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers/combine)
and [move_tag_id](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers/move_tag_id)
(updated 2026-08-25), plus
[destination link](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.destinations/link)
and [destination get](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.destinations/get)
(updated 2026-06-04). Google explicitly marks each as no longer supported. The
runtime refuses them before credential acquisition or provider egress. Three were
previously blocked writes and one a read; none is counted as implemented.

### Validation and initial failures

- Initial GTM compilation exposed fixture type inference mistakes; corrected them.
  The first tests caught a latest-version header scope comparison using the container
  root instead of its exact resource path, and an invalid nested `dry_run` fixture.
- Strengthening the method/scope parity check caught an incorrect scope on
  `SET_LATEST_CONTAINER_VERSION`. Fixed it to the documented edit.containers scope.
- 61 new/existing measurement tests passed; an additional focused run passed 32.
- Public candidate `.release/contract-batch-20260919-b`: 449 files, tree hash
  `6f679644b2816739fdd27dcba487aef73bab0e2c9b72b5d7f0bfbc89550b7d11`.
  `npm.cmd ci --ignore-scripts --no-audit --no-fund --cache ../../.runtime/npm-cache`
  passed. The first `npm.cmd run check` emitted a failure in the existing test
  `the reviewer scope holds however the path is spelled`, then retained a listener;
  it was interrupted. Log: `release-check-b.log`. The same test file passed in
  isolation, then 16 diagnostic `node --test --test-reporter=tap --test-force-exit
  dist/tests/test-account-scope.test.js` runs passed. The cause remains unconfirmed;
  no production change or assertion weakening was justified by this evidence.
- Full candidate rerun completed: 731 passed, one failed, one FFmpeg skip. The
  actionable failure was missing executable guidance for the new GTM family.
  Added a real inspect example, plus the new workspace-family example; the test
  still requires every declared family. Log: `release-check-b-retry.log`.
- Workspace contract tests first passed 18; then explicit field-clearing, ordered
  versus unordered configuration and byte-bound regressions were added. Command:
  `node --test --test-concurrency=1 dist/tests/gtm-workspace-writes.test.js
  dist/tests/gtm-workflow-writes.test.js dist/tests/retired-provider-actions.test.js
  tests/guide-contract-examples.test.mjs` — **57 passed, zero failed/skipped**.
  Log: `gtm-workspace-second.log`. Full fresh release validation follows this point.

The checkpoint above had 107 unmapped rows. The two remaining GTM operations are
now explicit AMCP diagnostics in `src/gtm-diagnostics.ts`: native read-only account,
container and workspace audit; and local reviewed-write verification job status.
Discovery stays within the exact connection's existing account grants. Complete
bounded pagination, current permissions, native scopes and foreign-resource checks
apply. Default output excludes full tag configuration. Missing references, duplicate
names, merge conflicts and latest/live-version observations are returned as findings;
unrecognized system trigger references remain unknown, and publish readiness is never
inferred. Job polling requires the same tenant, creator/admin and current account
access, excludes authority/lease fields, and never submits a mutation or reads tokens.

Public candidate C contained 451 files, tree hash
`e1d7f92609391eb8c66394905ce6e93e278cfa31ac6c48c42c328da8e02bc60b`.
Full check passed **753 tests and four capture tests**, with one FFmpeg skip,
then the report's guidance check correctly rejected the undocumented
`VERIFICATION_UNSUPPORTED` refusal. Documented its cause and safe recovery instead
of exempting the code. Log: `release-check-c.log`. No passing full-check claim is
made for that attempt.

The first diagnostic tests passed eight and failed one: its fixture attempted to
represent revocation as an enabled connection with zero accounts, which Store
correctly forbids. Both diagnostic and workspace in-flight revocation fixtures now
disable the connection through its valid API, so they test actual authority loss.

Current denominator: 3,241 actions; 325 reviewed-family rows, 989 blocked mapped
writes, 105 unmapped actions, 50 unqualified reads, eight input-dependent adapters,
four withdrawn methods. GTM has 64 reviewed-family rows, 38 native reads, two local
diagnostics and four withdrawn methods. Family membership is conditional on the
documented payload limits; no live qualification or exhaustive variant claim is made.

Fresh public candidate D contained 453 files, tree hash
`6de60aeb7923c6bcf6d856af4622ebac305d96c35c284e26c697712f48d9cb0a`.
Installation used `npm.cmd ci --ignore-scripts --no-audit --no-fund --cache
../../.runtime/npm-cache`; `AMCP_SCHEMA_PYTHON` selected bundled Python 3.12.
`npm.cmd run check` exited **0**: **762 passed, zero failed, one FFmpeg skip**,
plus **four capture tests passed**. Schema generation/integrity, guide examples,
refusal documentation, source/browser checks and both contract inventories passed.
Log: `.runtime/contract-completion-20260919/release-check-d.log`. FFmpeg/ffprobe
and Docker are unavailable on this host; this is not a container smoke or live
provider qualification. Earlier failed attempts remain recorded above.

The GTM batch was committed and pushed as `cde2b60` to `Codex-branch` only.

## Google asset sets and feed links

Five new resource descriptors add 16 reviewed rows: asset-set create/update/remove,
and asset, campaign, ad-group and customer associations. Nine advertiser feed types,
Merchant Center feed settings, static location groups and Business Profile group
filters have explicit native validation. Membership reads follow all pages and bind
every member and asset to the selected account and exact set. Parent groups are
checked against the source LOCATION_SYNC set. Current content/configuration and
membership are frozen, with bounded fan-out and a second membership/config read.
Asset and label ordering is semantic; final URL lists remain ordered. Object
replacement verification uses exact field hashes to detect ignored clears.

The field generator now handles CRLF reference captures. The checked GAQL fixture
contains 117 fields across 21 resources. Feed asset selectors derive from 133
already captured selectable fields across 11 explicitly declared asset types;
`generate:feeds:check` checks regeneration in every release check.

Official documentation checked 2026-09-19:
- [AssetSet v23](https://developers.google.com/google-ads/api/reference/rpc/v23/AssetSet),
  resource page dated 2026-02-23; pinned Discovery request fields also checked.
- [Asset-set fields v23](https://developers.google.com/google-ads/api/fields/v23/asset_set),
  reference dated 2026-09-10; association resource field tables checked separately.
- [Customer asset-set fields](https://developers.google.com/google-ads/api/fields/v23/customer_asset_set),
  reference dated 2026-09-10: `customer` is not selectable; identity is bound through
  the exact selected-customer resource name instead.
- [Asset overview](https://developers.google.com/google-ads/api/docs/assets/overview),
  dated 2026-09-10: feed type/linkage restrictions checked against the implementation.
- [Location assets](https://developers.google.com/google-ads/api/docs/assets/location-assets),
  dated 2026-09-10: static group parent membership, the separate business.manage
  authorization token requirement, and signed int64 listing-ID conversion checked.

Limits remain explicit: creation of LOCATION_SYNC, CHAIN_DYNAMIC_LOCATION_GROUP,
HOTEL_PROPERTY and TRAVEL_FEED is unqualified. Sync authorization must be sourced
from a separately granted Business Profile connection; some chain/map settings lack
selectable v23 read-back. These variants were not made executable with partial
verification or caller-pasted OAuth tokens. Native current membership does not freeze
external Merchant Center inventory or future synchronization. Provider rules, account
access, processing and serving remain live qualification dependencies.

Verification: first 30 focused tests passed. The expanded run passed 35 and failed
one because a synthetic location-group fixture retained a PAGE_FEED member; the
contract correctly rejected the incompatible asset. Corrected the fixture, then
three targeted regressions passed. A final focused run of configuration, asset-link,
state-comparison and guide tests passed **71/71**, zero failures/skips. Logs are
`google-feed-first.log` through `google-feed-fourth.log` under the current runtime
evidence directory. The earlier user-supplied CI failure was a stale CSV contract
ledger; the current source generator and index both use LF and retain strict
content equality. Full sanitized release validation follows this checkpoint.

Current inventory: 3,241 rows; 341 reviewed-family, 973 blocked mapped writes,
105 unmapped, 50 unqualified reads, eight input-dependent adapters, four withdrawn.

Saved-planning candidate G (`d694b6af1adf5d8160bb1885f1611ae1624a14336144caf69c77e3e47280ba71`,
459 files) completed `npm.cmd run check` successfully: 792 tests passed, zero failed,
one FFmpeg test skipped; four capture tests passed. Generation, public evidence,
guidance, web, provider maintenance and strict contract-ledger checks passed.
Evidence: `.runtime/contract-completion-20260919/release-check-g.log`.

Candidate E (`66da668037d6b9c7cb239c0b0dfc13b907f12de67aa844ca54b75daad74c9711`,
456 files) completed 773 tests successfully, failed one and skipped one FFmpeg
test. `release-check-e.log` preserves the failure: the activity HTTP fixture failed
before network I/O with Node Fetch `bad port`. The test used an unrestricted OS
ephemeral port; the actual rejected port was not logged. The Fetch standard blocks
listed ports even on loopback ([port blocking](https://fetch.spec.whatwg.org/#port-blocking),
checked 2026-09-19). This is distinct from the earlier unexplained URL-spelling
failure; no causal connection to that failure has been established.

Added a test-only listener shared by 20 HTTP fixture files. It releases forbidden
OS allocations and bounds retries at ten, retains explicit restart ports, and
propagates binding errors. It never retries HTTP calls/assertions or changes
application safeguards. Four deterministic regressions cover Fetch rejection,
successful reallocation and cleanup, retry exhaustion, and genuine bind failure.
All 13 listener/activity/deployment tests passed (`http-listener.log`). Fresh full
candidate F validation follows; candidate E's failed result remains recorded.

Candidate F (`99753c73cd606148a3c3dc41ea975873a35b1f993869779dec486df68338c895`,
458 files) passed the entire `npm.cmd run check` command, including generation,
runtime tests, capture replay, web checks, provider integrity/lifecycle and strict
contract ledgers. Test totals: 777 passed, zero failed, one FFmpeg test skipped;
four additional capture tests passed. `node deploy/check-railway.mjs` also passed.
Evidence: `release-check-f.log`. FFmpeg and Docker remain unavailable locally;
no hosted CI, container execution, provider mutation or live qualification claim.

## Saved Keyword Planner contract batch

Added five reviewed RPC routes covering saved plans, planning campaigns/groups,
positive or negative group keywords and negative campaign keywords. Native parent
bindings, oneofs, update masks, account-currency micros and optional CPC clears
are validated separately from serving-ad contracts. Planning bids do not trigger
ad-spend confirmation; deployment, review, grants, immutable requests, idempotency
and owner deletion policy still apply. Parent changes snapshot both hierarchies.

For existing plans, server-derived reads resolve all ancestors and capture all five
resource types twice with complete bounded pagination. Descendant changes invalidate
parent-removal reviews. A changed inherited bid is a conflict; geo ordering and query
telemetry are not. Exact replacement hashes detect an old forecast interval retained
beside a new date range. Cleared optional fields are checked against ProtoJSON defaults.
The field evidence grows to 148 captured fields across 26 resources; every actual
selected field is checked against the pinned public reference fixture. The
`keyword_plan_campaign.geo_targets` message is selectable; its nested constant field
is not separately selectable and is not used as a GAQL projection.

Official references checked 2026-09-19, v23 resource pages dated 2026-02-23:
- [KeywordPlan](https://developers.google.com/google-ads/api/reference/rpc/v23/KeywordPlan)
  and the five public GAQL field tables recorded in the fixture.
- [KeywordPlanCampaign](https://developers.google.com/google-ads/api/reference/rpc/v23/KeywordPlanCampaign):
  native bid/currency, network, one campaign per plan, geo and language boundaries.
- [KeywordPlanAdGroupKeyword](https://developers.google.com/google-ads/api/reference/rpc/v23/KeywordPlanAdGroupKeyword):
  inherited optional bids and immutable negativity.
- [KeywordPlanForecastPeriod](https://developers.google.com/google-ads/api/reference/rpc/v23/KeywordPlanForecastPeriod):
  future-date constraints apply when forecasting; editing a saved plan does not
  invent new dates or convert account locale to the server UTC calendar.
- Pinned Google v23 Discovery schemas independently checked for all five resource
  shapes, operation oneofs and request/response envelopes.

Verification: initial lifecycle suite passed 42/42 (`keyword-plan-first.log`),
followed by configuration/state/Discovery regressions 58/58 (`keyword-plan-second.log`).
Final expanded configuration and executable-guide checks passed 55/55
(`keyword-plan-third.log`), including two-plan parent moves, uncertain/foreign/partial
receipts, concurrent execution, revocation inside hierarchy reads and ignored clears.
No assertions were weakened. These fixture tests now inject a large synthetic
transport burst to avoid real-time provider pacing; dedicated transport-budget tests
still exercise the production budget controls. Full sanitized candidate G follows.

Limits: 15,000 resources across affected plans, 300 requests, 100 pages/query,
32 MiB read and 16 MiB retained state. Complete-plan comparison can conflict with an
unrelated concurrent edit inside the same saved plan. Provider quotas, field-level
eligibility and forecast quality require live qualification. A removed parent's
read-back proves that parent's absence, not independent cleanup of every descendant.
No live advertising or account changes were made. Google contract version is now 6.
Current inventory: 3,241 actions, 346 reviewed-family rows, 968 blocked mapped writes,
105 unmapped, 50 unqualified reads, eight input-dependent adapters, four withdrawn.

## Reddit post metadata and lead-form contracts

Added three exact reviewed routes: PATCH posts/structured_posts (allow_comments
only), and POST account lead_gen_forms. Post updates bind the exact t3 post's t2
author to a current profile of the selected account, independently of historical
resource discovery. Numeric profile IDs and Reddit user IDs are kept distinct.
Account profiles are read with complete bounded pagination, current grant checks
on every page, and strict response validation. Only the selected profile binding
is included in review state; unrelated profile edits do not cause false conflicts.
Real content/author changes still do. Comments can affect shared serving content,
so owner activation restrictions also apply. Exact read-back proves the requested
flag and author. Lead forms require explicit native questions and consent text;
their receipt must match the full requested form and selected account before scope
is learned. This creates a definition, not an ad or lead-record download.

Official Reddit v3 references checked 2026-09-19:
- [Update post](https://ads-api.reddit.com/docs/v3/api/update-post) and
  [update structured post](https://ads-api.reddit.com/docs/v3/api/update-structured-post):
  only comments configuration is editable; content replacement needs a new post.
- [Create lead form](https://ads-api.reddit.com/docs/v3/api/create-lead-gen-form)
  and pinned official OpenAPI schemas for profile identity, native questions and
  response envelopes. Pinned metadata is documentation evidence, not live proof.
- [Changelog](https://ads-api.reddit.com/docs/v3/history): onsite forms are withdrawn
  September 21, with existing dependent ads paused September 30. The announcement
  has no timezone; AMCP conservatively stops new form creation at 00:00 UTC on
  September 21, including reviews crossing the deadline during reads. Completed
  receipts and historical reads remain available. Use external forms with Pixel
  or CAPI tracking afterward; legacy-route retries cannot bypass the deadline.

Initial focused run: 7 pass, 8 fail (`reddit-creative-first.log`), caused by test
fixtures selecting the wrong delegated wrappers. Corrected those fixture tool
names; no production assertions were weakened. The second run passed 15/15.
The final new/existing Reddit and guide run passed 19/19, zero skips/failures
(`reddit-creative-third.log`). Negative cases cover foreign/revoked grants, stale
or ambiguous authors, incomplete/error-200 pagination, real conflicts, duplicate
concurrent execution, ignored writes, uncertain receipts and sunset boundaries.
Candidate H full validation follows. No live provider calls were made.

Limits: profile discovery is capped at 100 pages, 1,000 profiles and 4 MiB.
Legacy post creation and asynchronous structured-post creation are still separate
unfinished contracts. Media import, Reddit Max and customer-list ingestion are
not implied by these three contracts. Reddit contract version is now 2.
Current inventory: 3,241 actions, 349 reviewed-family rows, 965 blocked mapped writes,
105 unmapped, 50 unqualified reads, eight input-dependent adapters, four withdrawn.

Candidate H (`ce771c3106994c3754a17b108d11924ddf3af8403ae1ec0999b092fb2bca71dc`,
461 files) passed the complete `npm.cmd run check`: 802 tests passed, zero failed,
one FFmpeg skip, four capture tests passed. All generation, guidance, provider and
strict contract-ledger checks passed. Evidence: `release-check-h.log`. This is
local synthetic validation; hosted CI, Docker and live Reddit remain unverified.

## Reddit post creation and asynchronous verification

Added CREATE_POST and CREATE_STRUCTURED_POST_JOB with fresh account/profile
association, immutable native payloads, bounded prerequisites, current grants,
normal reviewed execution and retained idempotency. Legacy TEXT/IMAGE/VIDEO/
CAROUSEL and structured TEXT/IMAGE/VIDEO/CAROUSEL/PROMOTED_POST are validated.
Media uses the native public-URL ingestion path; private Drive and Max asset
uploads remain separate unfinished workflows. Media fields are not silently
dropped from verification: the receipt describes provider-hosted URL
transformation and explicitly does not prove byte or visual identity. Strict
comparison covers author, comments, destinations, ordered cards, crop, event and
enhancement configuration. Deprecated UGC boolean fields project to explicit
native enrollment; contradictory representations remain a mismatch.

The accepted job receipt grants only its exact scoped job read. A durable
resolution tied to tenant/review/connection/account authorizes an internal read
of the resulting post, not general ownership. Only successful read-back grants
post reuse. Changed job IDs, ambiguous receipts, foreign authors, revoked profiles
and missing scopes cannot confer access. Queued/processing states and transient
read errors use existing bounded worker polling; terminal provider failures remain
failed. Restart, concurrency and lost-response tests prove no automatic second
POST. Campaign steps preserve verified_resources on immediate verification,
later polling and reconciliation, so dependent ads use a verified post ID.
Attaching a post to a classic ad now also refreshes account/profile authority.

Community promotion requires an already scoped original post authored by the
selected profile, its unchanged headline and canonical community URL. Original
content is frozen for concurrency review, owner activation policy applies, and
read-back checks that original comments were disabled. The documented voting
side effect is displayed but not independently exposed by this API's read shape.
Provider SFW/public-community eligibility and publication/approval are live checks.

Official v3 evidence checked 2026-09-19:
- [Legacy create](https://ads-api.reddit.com/docs/v3/api/create-post): still callable,
  with structured creation recommended; successful response is 201.
- [Create structured job](https://ads-api.reddit.com/docs/v3/api/create-structured-post-creation-job)
  and [get original job](https://ads-api.reddit.com/docs/v3/api/get-structured-post-creation-job):
  accepted jobs and subsequent outcomes are separate operations.
- [Campaign setup](https://ads-api.reddit.com/docs/v3/guides/programs/campaign/campaign-setup):
  native creative fields, original-post effects, job processing and post-to-ad flow.
  Its 2–7 carousel range conflicts with OpenAPI's 1–40 schema; AMCP qualifies their
  common range and reports this limit rather than guessing broader acceptance.
- [Changelog](https://ads-api.reddit.com/docs/v3/history) and the pinned public
  OpenAPI: explicit UGC opt-out, reminder events and media URL replacement.
  Current REMINDER validation is stricter than the September 5 pinned schema.

Verification: first compilation found TypeScript narrowing errors, corrected
without changing contract assertions. Initial lifecycle run passed 26/26
(`reddit-post-first.log`). Expanded run passed 42 and failed four chain tests:
the new ad fixture returned a nonnumeric ID, which the published vendor schema
correctly rejected. Corrected the synthetic receipt; no vendor assertion weakened.
Final expanded run passed 48/48 (`reddit-post-third.log`), including all four
post-to-paused-ad chains, worker terminal/transient/poll-limit states and restart
recovery. The failed second log remains retained. Full sanitized candidate I
follows. No live provider calls or actual publication were performed.

Reddit contract version 3; 13 reviewed-family and 38 native-read captured rows.
Total inventory: 3,241 actions; 351 reviewed-family, 963 blocked mapped writes,
105 unmapped, 50 unqualified reads, eight input-dependent adapters, four withdrawn.
Unknown vendor actions and explicit private-media/Max/audience limitations remain
open; route-family coverage is not a statement that every provider action works.

Candidate I (`b3ef8034897f7fc44ccb7a45e7609614977fd3ef2bda5d36e80cc5a7736a1da4`,
463 files) passed 828 tests, failed one and skipped FFmpeg. `release-check-i.log`
retains the obsolete guide assertion requiring post publishing to be described as
unqualified. Updated it to check the supported structured-post workflow, verified
resource handoff, no-retry instruction, byte-identity limits and still-unsupported
private Drive/Max/customer ingestion. Fresh candidate J follows; assertions about
actual execution and unsupported capabilities remain mandatory.

Candidate J: `.release/contract-batch-20260919-j`, 463 files, source hash
`43ceca198fe58b66b2d7c12af0c5bdfd30105612cb2dc4f8737da30219eef90a`.
The same sanitized `npm.cmd ci --ignore-scripts --no-audit --no-fund` and
`npm.cmd run check` sequence exited 0: 829 tests passed, zero failed, one FFmpeg
skip; all four capture tests passed. Generated contracts and action ledgers,
guidance, web, vendor integrity and offline lifecycle checks passed.
Evidence: `.runtime/contract-completion-20260919/release-check-j.log`.
FFmpeg/container, hosted CI and live credentials remain unavailable. This is
synthetic/local qualification, not evidence of live publication or ad approval.

## Documented GET diagnostics with ambiguous resource names

Thirteen catalog rows used names such as `set`, `publish` or `authorization`,
which the independent risk classifier conservatively rejected. Added exact GET
contracts in `provider-read-contracts.ts`, retaining the method/body/origin,
override, batch, account and connection checks. Method override headers and query
keys now also use case-insensitive refusal. No POST or undocumented route is
enabled by this exception. The captured GET anchor/create remains unqualified.

Meta's account value-rule-set list uses the selected `act_ID`. TikTok's fixed
paths cover product sets/products, organic publishing status/location, post ad
authorization, hashtag verification, brand-safety partner status, CTM event sets,
Shop exclusive authorization and video music rights. Additional business/catalog,
Shop, message-account and identity authority requires an administrator binding
containing the exact path and native identifier tuple on that same connection.
Broad prefix bindings cannot substitute for this check. LinkedIn's documented
company/member/account composite requires exact binding and `rw_ads`; a returned
Denied value stays negative permission evidence, not publication authority.

Current official sources checked 2026-09-19:
- [Meta official SDK, get_value_rule_set](https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/adobjects/adaccount.py)
  explicitly uses GET; AMCP remains pinned to Graph v25.0.
- [LinkedIn account access controls, 202607](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/account-access-controls?view=li-lms-2026-07)
  documents the GET tuple, `rw_ads`, Approved/Denied (updated 2026-06-24).
  Existing configurable LinkedIn version is unchanged.
- [TikTok v1.3 endpoint catalog](https://business-api.tiktok.com/gateway/docs/index?doc_id=1735713875563521&language=ENGLISH)
  documents the read purposes and permission categories; native shapes use the
  captured catalog. The documentation search index was readable while the clean
  direct URL intermittently returned a fetch error. No live account acceptance
  or response-field completeness is inferred from these metadata sources.

Verification commands: `npm.cmd run build`; `node --test --test-concurrency=1`
with `dist/tests/provider-read-contracts.test.js`, existing account/security/read
verification, action-ledger and scope/guidance suites. Initial 25, expanded 27
and final 27 tests passed (`read-contracts-first.log`, `-expanded.log`, `-final.log`).
The fixtures execute actual compiled requests through a reader actor and a
read-only deployment, test native error envelopes, wrong grants/IDs, absent and
broad bindings, in-flight revocation, malformed verbs/paths and mixed-case
overrides with no unauthorized egress. Strict regenerated inventory has 1,697
native reads and 37 unqualified reads; 963 mapped writes still lack a family.
Candidate K full release check follows. No read was performed on a live account.

Candidate K `.release/contract-batch-20260919-k`: 465 files, source hash
`fa7cb02091c999c05ed0ac8a4f6c69e7edaded53086218f0ef19d4e7a814d50c`.
Sanitized `npm.cmd ci --ignore-scripts --no-audit --no-fund`, then `npm.cmd run
check`, exited 0. Main suite 848 passed, zero failed, one FFmpeg skip; capture
suite four passed. Generated ledgers, provider integrity, guidance and remaining
release checks passed. Log: `release-check-k.log` in the existing evidence folder.

## Criteo preferred-line-item targeting

Added nine independently reviewed operations for audience, store and add-to-basket
targets: native PUT scope changes and POST append/delete. The new family is
`criteo_targeting`, implemented in `src/criteo-targeting-writes.ts` and integrated
with the existing frozen review, deployment, actor, account, policy, idempotency
and verifier services. Criteo contract version 2, API 2026-01. The native connection
remains administrator-provisioned; adding a guide does not claim website OAuth.

Before a mutation, discover the line through the chosen account's native list.
The review rechecks filtered complete account membership, its preferred campaign
and account, current retailer, detailed line settings and full target membership.
Audience searches check every referenced audience belongs to the same account and
retailer, including its current definition. An internal read authority exists only
after these fresh checks and cannot be supplied by the client. Every request and
verification cache observes current access. Compound state excludes raw response
envelopes and only documented spent/remaining/timestamp telemetry; unknown
configuration remains protected. Native member arrays are canonical sets.

The current reference describes PUT as setting scope. The qualified contract
therefore requires preserving member arrays, and uses separate append/delete
operations for membership changes. It does not assume that PUT implements a full
replacement. Scope and membership affect delivery immediately: explicit spend
acknowledgement and owner activation/deletion permissions apply. These routes do
not alter budgets. Store/product/category validity and retailer eligibility are
provider checks, not invented locally or claimed from the captured catalog.

Receipts require native complete target data. HTTP 200 errors/warnings, malformed,
empty and lost responses cannot establish success. The separate read-back compares
the entire resulting membership and scope. Uncertain claims remain claimed across
SQLite reopen; concurrent calls and replay do not dispatch a second write.
Supported bounds: 100 requested member changes (PUT preserves at most 100), 1000
retained target IDs, 24 requests, 4 MiB per response and 8 MiB total per state read.
There is a monotonic between-request 60-second budget. Filtered account lists
must completely return the one exact target; no provider-returned URL is followed.

Official sources checked 2026-09-19:
- [Pinned official OpenAPI 2026-01](https://api.criteo.com/2026-01/retailmedia/open-api-specifications.json)
  supplies request/response shapes, account list filters, metadata and
  `RetailMedia_Campaign_Read` / `RetailMedia_Campaign_Manage` scopes.
- [Audience append](https://developers.criteo.com/retail-media/reference/appendaudiencetargetsbylineitemid),
  [audience delete](https://developers.criteo.com/retail-media/reference/deleteaudiencetargetsbylineitemid),
  [store scope](https://developers.criteo.com/retail-media/reference/putstoretargetbylineitemid),
  [store append](https://developers.criteo.com/retail-media/reference/appendstoretargetsbylineitemid)
  and [basket scope](https://developers.criteo.com/retail-media/reference/putaddtobaskettargetbylineitemid)
  describe the separate native effects and resulting target data.

Verification: initial TypeScript compilation found narrowing errors in a new
throw helper, corrected with an explicit never-returning function. An exploratory
compiler invocation used the wrong helper signature; the production request
fixtures use the actual nested delegated arguments. Initial 17 lifecycle tests
passed (`criteo-first.log`); expanded/guidance 27 passed (`criteo-expanded.log`);
final 79 Criteo, state-envelope, spending-policy and action-contract tests passed
(`criteo-final.log`). Commands: `npm.cmd run build` followed by
`node --test --test-concurrency=1` with those compiled suites. Three executable
inspect examples and `amcp://guides/criteo` are included. Required matrix tests
were extended for this newly enabled gateway, not weakened.

Inventory remains 3,241 actions: 360 reviewed-family, 954 blocked writes, 105
unmapped, 37 unqualified reads, eight input-dependent and four withdrawn. Criteo
still has 45 blocked writes and three unmapped actions. Full candidate L follows;
no retailer credentials, live mutations or provider approval claims are involved.

Candidate L (`809079431febd2729026dc69cc1543f4b229a9f860e717a219c344a0b0b8755c`,
468 files) failed with 868 passed, two failed, one FFmpeg skip. Both failures were
the same stale guide-count assertion in `deploy/smoke-api.mjs`, exercised with
writes enabled and disabled. Corrected the expected count from 11 to 12 and added
an explicit Criteo guide URI assertion. The four deployment/guidance tests then
passed (`criteo-smoke.log`); initial `release-check-l.log` is retained. A fresh
sanitized candidate M must pass the entire release check before this batch is pushed.

Candidate M completed `npm.cmd ci --ignore-scripts --no-audit --no-fund` and
`npm.cmd run check` with exit 0: 870 passed, zero failed, one FFmpeg skip, plus
four capture tests passed. All generated-source, vendor, WSDL, feed, guidance,
web, lifecycle and action-ledger checks passed. Source tree hash:
`2d16ab5f376fa7d85db6e91da7336e178b6710c2c6d3f6eaa53d4d8ecf70cfea`, 468 files.
Logs: `.runtime/contract-completion-20260919/install-m.log` and
`release-check-m.log`. FFmpeg and Docker remain unavailable on this host; this
does not establish container or live-provider qualification.

## Google draft generation (batch N)

Six previously unqualified rows (legacy plus RPC forms of text generation, image
generation and recommendation generation) now execute through an exact v23 POST
read contract. No mutate/apply/dismiss/shareable-preview route is enabled by it.
Inputs use pinned Discovery types plus independent native required/conditional
fields and oneofs. Both protobuf and ProtoJSON casing work. The selected customer,
current Ads scope and connection are checked before egress and again before
returning a response. Duplicate logins require an explicit connection.

Results keep native draft data and add generation metadata. Empty repeated fields
may be omitted by ProtoJSON; these produce `no_output`, with missing recommendation
types and uncertainty retained. Errors, malformed or unknown envelopes, wrong
output types and unsafe temporary URLs are rejected. A generation request makes
one attempt, cannot paginate and creates no reviewed-write/idempotency claim.
Content is not saved as an asset or applied. Temporary URLs are returned only as
data, with no download or invented expiry. Audit redaction now removes image bytes
and existing URL-signature redaction remains intact; prior audit rows are untouched.

All three image inputs, both text-context variants and ten recommendation types
have local fixtures. Search impression-share micros, Performance Max retail input,
zero counts and budget micros preserve their native meaning. Public HTTP(S)
inputs reject embedded credentials/literal private hosts, but Google's redirect,
DNS and content processing is not controlled or verified by AMCP. Product-recontext
inputs are bounded to 1–3 base64 values of at most 700000 encoded characters each;
format/dimensions and provider eligibility remain provider checks. Private Drive
ingestion into this generation RPC is still incomplete and the guide forbids
asking the LLM to download and relay private files.

Official evidence checked 2026-09-19, in addition to the pinned v23 Discovery:
- [v23 AssetGenerationService protobuf](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/services/asset_generation_service.proto)
  confirms the three fixed image inputs, text contexts and temporary URL output.
  The image request has no existing-context field despite its descriptive prose.
- [v23 RecommendationService protobuf](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/services/recommendation_service.proto)
  separates generation from application and defines the native input fields.
- [Recommendation construction guidance](https://developers.google.com/google-ads/api/docs/recommendations)
  explains why an empty result need not mean an optimal plan.
- [Release notes](https://developers.google.com/google-ads/api/docs/release-notes)
  describe text/image generation as initially limited to closed-beta participants.
  No access, successful live response or provider approval is claimed here.

Initial compilation found a TypeScript union access in the new test fixture;
corrected with an explicit property-presence check. Then 18 initial tests passed
(`google-generation-first.log`), 54 expanded compatibility/ledger/guide tests
passed (`google-generation-expanded.log`) and 40 final generation, security,
transport, Google schema and guide tests passed (`google-generation-final.log`).
Commands: `npm.cmd run build`, `node dist/tools/generate-contracts.js`,
`node dist/tools/action-contracts.js`, and `node --test --test-concurrency=1`
with the named compiled suites and `tests/guide-contract-examples.test.mjs`.
Inventory: 3241 actions, 360 reviewed-family, 954 blocked writes, 105 unmapped,
31 unqualified reads, 1703 native reads, eight input-dependent and four withdrawn.
Candidate N must pass the full sanitized release check before push.

Candidate N passed `npm.cmd ci --ignore-scripts --no-audit --no-fund` and
`npm.cmd run check` with exit 0: 889 tests passed, zero failures, one FFmpeg skip;
four capture tests passed. Source hash:
`c175be9da9553a0281798f76264f518431519f7c4914f543e8e6082cb2aeeecf`, 470 files.
Logs: `.runtime/contract-completion-20260919/install-n.log` and
`release-check-n.log`. The subsequent Meta alias reproductions are a separate
pending batch and were not part of candidate N. No live generation was attempted.
