---
status: record
tier: engineering
---

# Provider contract implementation evidence — 2026-09-19

Latest stop/resume checkpoint: [2026-09-20 handoff](RESUME-HANDOFF-2026-09-20.md).
Earlier numbered checkpoints below are historical; the AN entry and handoff
record the newest inventory and validation results.

## AN — Google Ads client-account user access (2026-09-20)

User requested finishing only the in-progress batch and documenting all remaining
work before stopping for the usage-limit refresh. No further family was started.

Six mapped writes now share google_user_access: the native user and invitation
mutation RPCs plus CREATE/REMOVE_CUSTOMER_USER_ACCESS_INVITATION and
UPDATE/REMOVE_CUSTOMER_USER_ACCESS. Native singular operation/result, exact mutable
role masks, administrator/test-account checks, current account write grants and
adwords scope are enforced. Client membership and invitation collections are read
completely twice, with semantic projections and bounded pages/bytes/deadlines.
Duplicate recipient, no-op role, pending authorization, nonpending revocation,
manager-wide effects and last-direct-admin removal/demotion are refused explicitly.
New/increased access obeys owner activation policy; removals/demotion obey deletion
policy. POST singular removals now have destructive metadata as well as policy
checks. No invitation or native permission was changed live.

Exact target receipts and independent read-back distinguish a sent PENDING
invitation from accepted account access. No AMCP ownership is inferred. The final
Discovery/proto comparison exposed the optional multiPartyAuthReview receipt field;
it is now validated and retained. Pending native authorization remains inconclusive.
A receipt containing only that review ID without a target remains uncertain and
cannot be resent; approval/rejection and manager-wide recovery are separate gaps.

Tests cover lifecycle, both action surfaces, malformed/native options, masks,
cross-account/workspace access, revocation, owner-policy changes, meaningful state
conflicts versus telemetry, paging/count/response bounds, lost/partial/foreign
receipts, pending authorization, concurrency, review tampering/expiry and SQLite
restart replay. Twenty-five new tests plus existing compatibility/guidance tests:
75 passed, zero failed or skipped. Build, nine-proto evidence regeneration,
contract/action generators and guidance checks passed (88 modules, 14 gateways,
no missing codes/gateways). Initial build narrowing errors are retained in
google-access-build-1.log; build-2/build-3 and final passed. Initial 21 tests passed;
the expanded final suite includes schema-driven receipt and verification cases.
Logs: .runtime/contract-completion-20260919/google-access-*.log.

Provider descriptor Google version 14 and two executable guide examples are
updated. Official evidence URLs/hashes, version constraints and recovery guidance
are in Skills/amcp-campaign-builder/references/google-ads.md,
tests/fixtures/google-user-access-v23.json and tools/google-access-evidence.mjs.
No new runtime dependency or database migration.

Recomputed inventory: 3241 actions; 423 reviewed-family, 894 blocked mapped writes,
91 unmapped, 27 unqualified reads, eight input-dependent, four provider-unsupported,
1704 native reads, 74 local workflows and 16 media workflows. Pinned vendor
denominator: 1208 methods, 454 with no mapped action; Apple 99/58 unmapped.
These totals do not certify all payload variants or live provider behavior.
Candidate AN completed successfully: npm ci --ignore-scripts and npm run check
both exited 0. Main suite: 1380 tests, 1379 passed, zero failed, one optional
FFmpeg skip; four capture tests passed. Every subsequent check stage passed.
Candidate manifest: 533 files, source_tree_hash
59489cbcc71ce291eb451d2b7becf92cac5c4b2bc5fa04bbec8797cf5a03d61c.
Logs: install-an.log and release-check-an.log under
.runtime/contract-completion-20260919. No executable source changed after the
candidate was assembled; only stop/resume documentation was completed.
Required FFmpeg mode, Docker and live provider/permission workflows remain unrun.
The user requested stopping here; remaining scope and exact resumption commands
are in RESUME-HANDOFF-2026-09-20.md, with all 1024 remaining/unsupported action
rows frozen separately. No next family is in progress.


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

## Canonical Meta alias inventory correction

`Compiler.compile` already resolves `meta_campaign_update/delete`,
`meta_adset_update/delete` and `meta_ad_update/delete` to the corresponding
`*_id_*` names. The action ledger used the alias and falsely marked them blocked.
The ledger now classifies the same canonical identity without removing alias rows
or changing authorization/routing. Unrelated creative/audience/access/batch actions
remain blocked. This corrects reporting; it does not add six new write contracts.

Seven regression tests initially failed at inventory assertions after successful
synthetic prepare/execute, actual state conflict, revoked grants, concurrent
single dispatch and durable replay. The corrected inventory passed all seven,
plus six existing action-contract tests: 13/13. Update read-back also passed;
existing generic Meta DELETE verification is unsupported and remains a separate
open capability, not a verified lifecycle in this batch. Files and logs:
`tests/meta-action-aliases.test.ts`, `meta-alias-baseline.log`,
`meta-alias-fixed.log`, `alias-ledger.log`, `alias-ledger-check.log` under the
existing runtime evidence directory. The generated strict ledger check passes.
Current counts: 3241 actions, 366 reviewed-family, 948 blocked writes, 105 unmapped,
31 unqualified reads, eight input-dependent and four withdrawn. Remaining records
are not marked complete. No external provider requests or mutations occurred.

Reviewing the generated delta caught an over-broad draft inventory correction:
Google legacy adapters intentionally retain their legacy names, including the
unsupported `UPDATE_CUSTOMIZER_ATTRIBUTE`. The classifier now preserves that
exception, with a regression test. Candidate O was assembled but never executed
or published; it is superseded. Final focused compatibility, alias, guide and
ledger tests passed 24/24 (`meta-alias-final.log`). Candidate P follows.

Candidate P completed the full sanitized `npm.cmd run check` with exit 0:
896 passed, zero failures, one FFmpeg skip, plus four capture tests passed.
Source tree hash `8816c5751027a38fb69a4b028ccaf2da2354dd55f388316466edabb199bb1868`,
471 files. Logs: `install-p.log` and `release-check-p.log` in the runtime evidence
directory. No live Meta call, container smoke or deployment was performed.

## Meta account labels and exact membership

Six catalog writes now have a `meta_labels` contract: create, rename and delete
account labels; attach existing labels to ads, campaigns and creatives. The
captured account-label GET lacked `act_`; a documented runtime override corrects
it while preserving the raw capture and its provenance. Discovery validates the
whole returned page before recording connection/account ownership. Error-bearing,
duplicate, malformed or foreign identities cannot partially establish grants.

State reads resolve the selected account and its complete label collection,
then the exact attachment target/account. Names and unknown configuration are
retained, while timestamp/envelope telemetry and label order cannot falsely
conflict. Pagination rebuilds a fixed scoped request and never follows the
provider URL or propagates its token. Limits are 25 pages, 1000 labels, 28 requests,
4 MiB per response, 8 MiB total and 60 seconds including the final response.
Creation at capacity is refused before dispatch. Attachment requires an explicit
complete array, including `[]`; an omitted field is not invented empty state.

Creation/renaming accepts a bounded nonempty name. Attachment accepts 1–25 distinct
existing label IDs only, preserving current membership. Provider receipts are
strict: new ID for creation, `success:true` for other mutations, no failure or
warning envelope. Read-back checks the exact name/presence/union; deletion uses
absence from a complete collection, never a 404 assumption. Only verified created
IDs gain immediate scoped reuse. Current scope, account grants and deletion
policy are rechecked; cached verification cannot bypass revoked scopes.

Official SDK sources checked 2026-09-19 (AMCP pinned v25.0):

- [AdAccount GET/create labels](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adaccount.py)
- [AdLabel fields/update/delete](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adlabel.py)
- [Campaign attachment](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/campaign.py)
- [Ad attachment](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/ad.py)
- [Creative attachment](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adcreative.py)
- [Explicit membership mixin](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/mixins.py)

The Meta HTML reference pages could not be fetched. SDK methods prove documented
routes/fields, not live receipt or omitted-empty-field behavior. Those remain
verification dependencies. Ad-set attachment and membership removal are not
introduced by this batch. No automation or delivery behavior is inferred from
organizational label changes, although external label-driven automation may exist.

`npm.cmd run build` passed. Initial focused 15/15 and expanded 21/21 tests passed;
final label, alias, scope, ledger and executable-guide tests passed 39/39. The
original capacity fixture was corrected because repeated first-page identities
tested duplicates rather than the named capacity boundary. Distinct 1000-label
complete reads now succeed, creation at 1000 fails, and 1001/26-page/byte/time
overflow cases fail independently. Other negatives cover changed state, revoked
and foreign access, ignored mutations, malformed/partial/lost receipts,
concurrent one-dispatch execution, verified immediate reuse, and both completed
and uncertain claims across SQLite reopen. Evidence logs: `meta-label-first.log`,
`meta-label-expanded.log`, `meta-label-final.log` under the runtime evidence
directory. Regenerated counts: 3241 actions, 372 reviewed-family, 942 blocked
writes, 105 unmapped and 31 unqualified reads. Candidate Q full check follows.

Candidate Q completed with 914 tests passed, three failures and one FFmpeg skip.
Its source hash was `3b881e6531b9bedf5f1ef8338373ce3ade8d80fe903374e72c7931ffc22e2562`,
473 files. `release-check-q.log` retains the failures: frozen full catalog pages,
deterministic path templates, and compatibility replay. The new override had added
provenance to the raw captured record. It now preserves raw metadata unchanged
and separately describes the documented effective mapping. The compiler test
asserts the one exact corrected template while retaining all 2207 other template
assertions. A dedicated test checks both original and effective representations.
Targeted catalog/compiler/label tests passed 34/34; compatibility replay also
passed. Capture assertions were not weakened. Candidate R reruns the full check.

Candidate R passed the entire sanitized release check: 918 passed, zero failures,
one FFmpeg skip, plus four capture tests passed. Source tree hash
`b371ab7664ebdf7200096f5d776d76df054959426b7747342e5f98cdb554c0c9`, 473 files.
All generated/guide/provider/web/lifecycle checks passed. Logs: `install-r.log`
and `release-check-r.log`. A subsequent unregistered draft Google bid-modifier
module is excluded from this candidate and this Meta commit. No live provider
mutations, container checks or deployment were performed.

## Google ad-group bid modifiers

`adGroupBidModifiers:mutate` and its three legacy create/update/remove aliases
now use a dedicated reviewed contract. Device and all five hotel criteria have
native oneof, parent, range/date and multiplier validation. The native multiplier
is dimensionless; 1.2 means +20%, not 1.2 currency units. Zero is a device opt-out
only. Criterion and parent are immutable; updates accept only an explicit
`bid_modifier` mask. Existing explicit criteria must be updated, not recreated.

Server reads freeze the selected customer, all selected parent groups and their
campaigns/budget amounts, and the complete modifier collection. Explicit resource
identities, criterion IDs and source are checked. The selected Ads scope, account
grants and owner activation/deletion controls apply before dispatch and throughout
reads. An inherited override can become explicit; deletion can restore inherited
bidding. Read-back checks source and value, never treating HTTP 404 as a valid
deletion. Native receipts must cover the exact batch and parent identities;
partial, foreign, unknown and lost receipts retain their durable single claim.

Bounds: 25 operations, 1000 modifiers, 1100 total state rows, 25 pages per query,
80 requests, 4 MiB per response, 8 MiB total, 60 seconds using a monotonic clock.
Total-result counts and continuation types/loops are verified. Capacity checks
cover the entire creation batch. Semantically equal hotel int64 encodings are
normalized only in state/identity comparison; mutation inputs are preserved.
Query cost and envelope metadata do not participate in state hashes. Changes
to parent bids, campaign targets, budgets or sibling modifiers do conflict.

Official sources checked 2026-09-19:

- [AdGroupBidModifier v23 proto](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v23/resources/ad_group_bid_modifier.proto)
- [Complete v23 selectable modifier fields](https://developers.google.com/google-ads/api/fields/v23/ad_group_bid_modifier), updated 2026-09-10
- [Bid-modifier workflow](https://developers.google.com/google-ads/api/docs/campaigns/bidding/manage-bid-modifiers)
- [Bid-modifier targeting](https://developers.google.com/google-ads/api/docs/targeting/bid-modifiers)
- [CampaignBudget selectable fields](https://developers.google.com/google-ads/api/fields/v23/campaign_budget)
- [CampaignBidModifier v23](https://developers.google.com/google-ads/api/reference/rpc/v23/CampaignBidModifier)

The modifier field table is pinned with source hash and a regeneration/check
script in `tools/google-bid-field-evidence.mjs`. Direct HTML fetch failed and the
general campaign/ad-group field pages were unavailable through the web tool;
parent queries have local fixture/schema evidence, not live GAQL validation.
Shared portfolio strategy internals are not snapshotted by this contract.
No assertion is made that Smart Bidding uses a positive multiplier or that the
provider accepts every combination of channel, bidding type and criterion.
Those require credentialed read-only/validate-only staging and approved live
qualification. Campaign-level creation remains blocked: the resource documents
`campaign` as output-only while its create operation expects no resource name.
No parent field or temporary criterion ID was invented to work around that gap.

First build of the isolated draft required explicit TypeScript narrowing after
an unknown response envelope check; fixed without changing runtime validation.
Fourteen initial tests passed (`google-bids-first.log`). Expanded tests initially
passed 18 and failed one; a native-bypass fixture supplied unsupported
`before_state`, then a non-UUID idempotency key, so it never reached the intended
guard. Both were corrected while retaining the exact `WRITE_REVIEW_REQUIRED`
assertion. `google-bids-expanded.log` and `google-bids-final-focused.log` retain
the failures. Final `google-bids-qualified.log`: 56 passed, zero failures, including
21 dedicated bid tests, schema/policy/state/ledger and executable guides. Tests
cover all six criteria through create/update/remove/read-back; legacy aliases;
pagination and inherited removal; actual configuration drift; negative shapes,
foreign/missing parents, scope/grant revocation and native bypass; ignored,
partial/lost receipts; concurrent one-dispatch and completed/uncertain SQLite
restart; exact capacity/byte/time boundaries and numeric identity equivalence.
Counts: 3241 actions, 376 reviewed-family, 938 blocked writes, 105 unmapped,
31 unqualified reads. Candidate S full sanitized validation follows.

Candidate S passed: 939 tests, zero failures, one FFmpeg skip, and four capture
tests passed. Source tree hash
`30c176477a1632c59d338664d894000403be06ad711e72a1ba62f6bd67e78c00`, 477 files.
Evidence: `install-s.log`, `release-check-s.log` in the runtime evidence directory.
The entire check command completed successfully, including strict generation,
provider, contract, guide, website and lifecycle checks. FFmpeg, containers and
live provider behavior remain unverified; no live mutations were made.

## LinkedIn campaign conversion associations

Google bid modifiers were pushed as `92c261d`. The next batch adds all five
captured campaignConversions write rows: both single PUT aliases, single DELETE,
batch PUT and batch DELETE. Only the exact 25-pair association contract is enabled.
No conversion creation, event ingestion, automatic association or tracking setup
is silently authorized. The captured catalog and its raw templates remain intact;
the compiler fixes scalar encoding for valid compound keys at execution time.

The state reader proves every campaign and conversion against the selected
account, then follows the fixed campaigns finder with offset pagination. It
freezes full returned resource configuration and complete association membership,
excludes association timestamps, and normalizes only documented campaign-URN
sets. Unknown configuration remains protected. Bounds: 25 pairs, 1000 links,
25 pages, 80 requests, 4 MiB per response, 8 MiB total and 60 seconds monotonic.
An extra empty page proves completion when the final page is exactly full and
has no total. Malformed counts, errors, partial/unknown metadata and foreign or
duplicate membership fail before dispatch. Entire-batch capacity is checked.

Native REST.li empty 204 and exact per-key 200 receipts have separate validators.
Verification reads the complete collection; 404 is never removal evidence. Scope
and connection/account grants are checked again for every read and before cached
verification. Optimization-affecting association changes require spending
confirmation and respect owner activation and deletion restrictions. Lost or
partial receipts keep the durable submission claim across concurrency/restart.

Official sources checked 2026-09-19:

- [LinkedIn conversion tracking, 202605](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversion-tracking?view=li-lms-2026-05): association routes, scoped conversion reads, campaign finder, permissions and empty-success semantics.
- [LinkedIn REST.li protocol](https://linkedin.github.io/rest.li/spec/protocol): association tuple encoding, batch ids/entities and per-key result/error maps. The endpoint's batch PUT example is incomplete; its body is implemented from this official protocol and remains subject to staging qualification.

The first draft build caught a missing explicit never-return, a test cleanup
signature and an overly broad fixture type; all corrected without relaxing runtime
checks. First test run: seven passed, eight failed because the fixture compared
JSON objects to the parser's intentionally null-prototype objects. Comparing the
same own fields fixes the fixture while retaining exact wire assertions. The
original `linkedin-links-first.log` remains. Fifteen corrected tests passed.
Expanded contract, compiler, REST.li, existing DSC and spending tests: 50 passed,
zero failures (`linkedin-links-expanded.log`), including 21 dedicated tests.
Candidate T full release validation follows; this is synthetic qualification only.

TikTok's separate adgroup/budget/update route was researched but not enabled:
its captured mapping has no usable native request/response contract in the public
portal, and the current official Adgroup SDK documents standard update rather
than the separate budget route. Source:
[official TikTok Adgroup SDK](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/AdgroupApi.md).
The missing SDK entry does not prove provider withdrawal. Keep it open pending
authoritative contract evidence; do not guess its body from the route name.

Candidate T passed: 960 passed, zero failures, one FFmpeg skip; four capture tests
also passed. Source tree hash
`e69c28378f932999ae89eda6fa2bb5a9cd2527a4e370efd65e07b7a02ff0ac16`, 479 files.
Logs: `install-t.log`, `release-check-t.log`. Final contract inventory and guide
checks passed 34 tests (`linkedin-links-qualified.log`). All strict generated,
provider, web and lifecycle checks passed. A later unregistered Meta Ad Library
draft is excluded from this qualification and the LinkedIn commit. Native live
batch compatibility and installed conversion tracking remain unverified.

## Meta public Ad Library workflow

LinkedIn associations were pushed as `981b5f9`. The previously unmapped
`amcp_native_action/search_ads_library` now performs a bounded public archive
query through the sole/default enabled Meta connection. Its fixed GET contract
does not authorize other Graph paths or establish private advertiser ownership.
Actor/connection access is rechecked during pagination and cache reads.
Captured `ad_type` maps to native `media_type`; native category remains ALL and
status ACTIVE. Native search terms are limited to 100 characters; longer captured
schema input is rejected rather than silently truncated.

Results expose geographic coverage, query completeness, result limits, fetch time,
cache status and uncertainty, without performance inference. Token-bearing
snapshot/paging URLs are omitted; an ID-derived public library URL is returned.
Cursors stay on the fixed Graph origin. Bounds: 25 pages, 4 MiB per response,
8 MiB total, 60 seconds, 100 requested ads. Malformed/partial/unknown envelopes,
duplicate identities, cursor loops and provider errors fail explicitly. The
15-minute in-memory cache is tenant/connection scoped and capped at 128 entries
and 16 MiB per Store; backward clock jumps invalidate entries.

Official source checked 2026-09-19:
[Meta Ad Library API](https://br-fr.facebook.com/ads/library/api/?source=archive-landing-page).
Transport uses Graph v25.0. API coverage is narrower than the public website;
identity/location confirmation, app eligibility and geographic live results
remain unverified. The guide and executable example explain these distinctions.

Initial fixtures incorrectly used an enabled connection with no account binding;
Store correctly refused it. They now use a valid synthetic account. A second run
passed ten tests and failed two fixture assumptions: searching output for the
word "cursors" also matched the explanatory next-action message, and 129 rapid
requests exhausted the test transport's 100-call burst. Exact field/token
assertions and a larger isolated fixture burst correct those cases; production
pacing and Store constraints are unchanged. Logs `meta-library-first.log` and
`meta-library-corrected.log` remain. Twelve dedicated tests subsequently passed;
the executable example raises that count to 13. Final scope/inventory/guidance
checks passed 24 tests (`meta-library-qualified.log`). Candidate U follows.

Inventory: 3,241 actions, 381 reviewed-family rows, 933 blocked writes,
104 unmapped actions and 31 unqualified reads. This read workflow removes one
unmapped entry; it does not inflate write coverage or claim live qualification.

Candidate U passed the entire check command: 973 passed, zero failures, one
FFmpeg skip, plus four capture tests passed. Source tree hash
`3d5ef440ee51ddb2f0143555a197cf45e1b53e74b888c4371106c3488dc7f075`, 481 files.
Logs: `install-u.log`, `release-check-u.log`. All strict generation, provider,
contract, web and lifecycle checks passed. Subsequent LinkedIn state corrections
and conversion-rule drafts are excluded from U and the Meta commit. No live
calls or advertising mutations were performed; FFmpeg/container checks remain open.

## LinkedIn conversion rules and native-state correction

Meta Ad Library was pushed as `65c7f90`. Both captured `/rest/conversions` POST
routes now implement their explicit single/batch creation and partial-update
contracts. Requests retain native account binding, version headers, per-ID patch
maps, decimal-string value/currency, attribution settings and OR-of-AND matching.
Creation checks the existing account Insight Tag and complete conversion list;
updates freeze every affected rule and associated campaign. Creation defaults
are documented and verified, including the documented omitted DYNAMIC valueType.
No automatic campaign association, account transfer, event ingestion, tag creation,
sharing or website installation is implicitly qualified by these two route rows.

Research revealed an error in the preceding association batch: native
`associatedCampaigns` contains records, while `campaigns` contains URNs. The old
fixture omitted populated native records. The shared projection now checks both
forms, exact conversion identity, duplicates and consistency; it excludes
associatedAt and documented callback times. Callback telemetry and membership
order cannot cause false conflicts. Unknown configuration, changed budgets,
attribution windows and matching text remain protected. Logical OR/AND order and
decimal formatting normalize only within these documented fields.

Single and batch receipts are validated independently; failures, missing/foreign
IDs, partial results and lost responses retain durable claims. Created IDs must
not exist in the frozen list and require fresh scoped read-back. A subsequent
association prepare reads the new conversion in the exact selected account;
receipt data alone never grants ownership. Current scopes, AMCP write grants,
owner activation controls and spending-impact confirmation apply. Conversion
value is not counted as spend. A disabled unassociated create can respect an
activation prohibition without weakening existing-rule controls.

Local bounds: 25 mutation entries, 1000 complete conversion records, 25 pages,
50 affected campaigns, 80 reads, 4 MiB/response, 8 MiB total and 60 seconds.
These are AMCP review bounds, not claims of native provider maxima. Unsubmitted
reviews using the prior projection may require a new prepare. No migration clears
submitted idempotency claims; no database format or runtime dependency changes.

Official sources checked 2026-09-19:

- [LinkedIn conversion tracking, 202605](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversion-tracking?view=li-lms-2026-05): field semantics, account scope, native association records, telemetry and conversion lifecycle.
- [REST.li protocol](https://linkedin.github.io/rest.li/spec/protocol) and [server guide](https://linkedin.github.io/rest.li/user_guide/restli_server): patch/batch shapes, positional creation receipts and per-ID update errors.

Twenty-three association tests passed after the record correction. The shared
projection build initially caught missing TypeScript parameter annotations; fixed
without changing runtime behavior. Initial combined rules/links tests: 38 passed
(`linkedin-rules-first.log`). Expanded compiler/REST.li/spend compatibility: 67
passed (`linkedin-rules-expanded.log`). New fixtures cover native defaults,
empty 201, partial updates, capacity, same IDs on other connections, fresh created
ID handoff, clock deadlines and restart/concurrent replay. Candidate V follows.
No live account permission, provider mutation, installed tracking, event receipt
or attribution outcome has been verified. Remaining counts are explicit.

Final links/rules/inventory/guidance qualification passed 55 tests
(`linkedin-rules-qualified.log`), including 21 dedicated rule tests and 23
association tests. The updated action inventory retains 3,241 rows: 383 reviewed
families, 931 blocked writes, 104 unmapped actions and 31 unqualified reads.

Candidate V passed its test phase (996 tests, zero failures, one FFmpeg skip, plus
four capture tests) but failed the subsequent guidance check. The new refusal
`CONVERSION_STATE_UNVERIFIED` lacked an explicit guide entry. Its cause and safe
recovery are now documented; the check is unchanged. Source tree hash
`f6975a3608a07f5b05cd18a3987b5b88fc2ca2bd71fb0d44e26d70a7dcdbc621`, 484 files.
Logs: `install-v.log`, `release-check-v.log`. Later provider, contract, web and
lifecycle checks did not run. Candidate W will repeat the full command. The later
Google custom-segment drafts are excluded from this LinkedIn qualification.

Candidate W passed the entire sanitized check: 996 tests passed, zero failures,
one FFmpeg skip, plus four capture tests passed. Source tree hash
`4baf358341b10c836d0e2fa9296c1629011bfc51c4fe217572e9c84cf63932d6`, 484 files.
Logs: `install-w.log`, `release-check-w.log`. Guidance, generated contract,
provider, web and lifecycle checks passed. The Google custom-segment draft and
its tests are excluded. Live provider acceptance, FFmpeg-required and container
checks remain unverified; no advertising mutation or deployment was performed.

## Google reusable custom segments

LinkedIn conversion rules are pushed as `96d8bda`. Two previously blocked Google
v23 RPC rows now cover custom audience and custom interest creation, membership
replacement, editing and their distinct native deletion mechanisms. The latter
has no remove oneof; explicit REMOVED status is a destructive update and follows
the same owner policy. Type changes and output-only audience status inputs remain
refused. Scope is the exact selected Ads connection/customer with the Ads scope,
including refresh/read-back and cached verification checks.

Every requested target has a complete configuration read. Native member arrays
are unordered sets; unknown nested data remains protected and ordered. Known
empty ProtoJSON defaults normalize without erasing a meaningful edit. Read-back
checks replacement/clearing and customer-bound native identity; it does not
certify reach, provider approval or serving. URL members are targeting signals;
AMCP does not fetch those URLs. Bounds are explicit in the guide, including
1000 members per definition and the enclosing reviewed mutation limits.

The same native contract decides spend effects: unattached creation does not
activate advertising, including an explicit CustomInterest ENABLED status.
Existing definition edits can affect consumers and require impact confirmation
and owner activation permission. Arbitrary words such as "budget" in keywords
must not masquerade as budget operations. A focused failing test demonstrates
the old generic heuristic (`google-segments-policy-repro.log`); the segment
contract now supplies these effects, with no exemption for mixed update batches.
Native request validation still rejects every unqualified envelope/field.

Sources checked 2026-09-19: pinned Google Ads v23 Discovery and the official
[custom audience field table](https://developers.google.com/google-ads/api/fields/v23/custom_audience),
[custom interest field table](https://developers.google.com/google-ads/api/fields/v23/custom_interest),
[custom audience guide](https://developers.google.com/google-ads/api/docs/remarketing/audience-segments/custom-audiences)
and [type update restriction](https://ads-developers.googleblog.com/2023/08/change-to-updates-of-google-ads-custom.html).
The fixture contains all fourteen published fields and their selectable/repeated
flags, with source/date/hash and a public-text regeneration tool. Current guide
samples may use a newer API; request qualification uses the pinned v23 schema.

Initial pure tests passed three cases. The first integrated run passed 64 and
failed four because a simulated provider edit mutated a shared test member used
by later fixtures. Each fixture now owns a deep clone; runtime guards correctly
rejected the contaminated input. No assertion was weakened. Corrected segment,
configuration and bid-modifier suites passed 89 tests. Expanded policy, inventory
and guidance tests passed 41. Logs: `google-segments-first.log`,
`google-segments-corrected.log`, `google-segments-expanded.log`. Final qualification
and candidate X follow. Live native eligibility, legacy interest acceptance,
FFmpeg-required and container checks remain open. The inventory retains 3,241
rows: 385 reviewed families, 929 blocked writes, 104 unmapped actions and 31
unqualified reads. Remaining provider and payload contracts are not complete.

Final segment/guide/inventory qualification passed 31 tests
(`google-segments-qualified.log`), including 20 dedicated segment tests. Candidate X
passed the entire sanitized check: 1,018 passed, zero failures, one FFmpeg skip,
plus four capture tests passed. Source tree hash
`322289d8fb2d711ff70065b7aeb9a1fe8092c90fe763ce51c9fa711c8a22d959`, 488 files.
Logs: `install-x.log`, `release-check-x.log`. All strict generation, contract,
provider, guide, web and lifecycle checks passed. The later unregistered X draft
workflow is excluded from this qualification and the Google commit. Live calls,
FFmpeg-required and container checks were not performed.

## X unpublished draft lifecycle and device preview

Google custom segments are pushed as `112ee45`. Four captured v12 draft routes
now have a dedicated reviewed family: create, update, hard delete and preview.
The account path, author, exact string IDs and closed native fields are validated;
FULL promotable access, registered processed media and discovered cards are read
under the selected connection. An update cannot change authors. Text-only,
image/video/GIF and card variants are supported within documented bounds; combined
card and direct-media formats remain unqualified. Drafts do not publish or promote
content; choosing nullcast false records future intent, not immediate publication.

Preview is an explicit notification side effect requiring normal reviewed-write
confirmation. Its receipt must name the exact account/draft. Verification records
provider acceptance separately from unverified device delivery/rendering, and does
not resend. Draft creation IDs must be new to the bounded author collection;
read-back checks current author and exact configuration. Hard deletion uses complete
author-scoped absence, never an ambiguous 404. Current AMCP grants are rechecked on
every read and after credential acquisition. No ownership is granted by a receipt.

Image order remains meaningful. Signed playback links and documented observation
fields do not enter review hashes, while content, author, metadata and unknown
configuration do. The draft and author are reread after dependencies to detect
in-flight changes. Bounds: 1000 drafts/author, 25 pages/collection, 64 requests,
4 MiB per response, 8 MiB total and a 60-second monotonic deadline, checked after
responses too. The 8192-character text input cap is a local payload bound; native
weighted Tweet limits still apply. Existing public/nullcast publishing, scheduling,
promotion and other X families are not silently included by this draft contract.

Sources checked 2026-09-19: [X v12 creative reference](https://docs.x.com/x-ads-api/creatives/reference)
and [native response/error envelopes](https://docs.x.com/x-ads-api/fundamentals/error-codes-and-responses).
Campaign-management reference URLs were not accessible through the web tool in
this pass, so batch campaign contracts were not inferred from creative examples.
No notification, publishing, account modification or other live request was made.

Initial TypeScript checks caught missing object annotations in the new helper and
fixture; those were corrected. Initial runtime tests passed 17 and failed one
fixture: its literal connection ID was not the UUID required by the public gateway,
so validation stopped before the intended bypass guard. The corrected UUID fixture
reaches and asserts WRITE_REVIEW_REQUIRED. `x-drafts-first.log` retains the failure.
Expanded existing creative/targeting/spend compatibility passed 54 tests
(`x-drafts-expanded.log`). Final inventory/example qualification passed 33 tests,
including 22 dedicated draft tests (`x-drafts-qualified.log`). Candidate Y follows.
Native availability, weighted-text acceptance, device delivery, FFmpeg-required and
container checks remain external. Inventory: 3,241 rows, 389 reviewed-family rows,
925 blocked writes, 104 unmapped actions and 31 unqualified reads; work remains open.

Candidate Y (`.release/contract-batch-20260919-y`) completed `npm ci
--ignore-scripts --no-audit --no-fund` and `npm run check` successfully. Tests:
1,040 passed, zero failures, one FFmpeg skip; four capture tests also passed.
All subsequent generated-contract, guidance, provider and release checks passed.
Source manifest: 490 files, SHA-256
`cc4e8e539c75781e9e1617b3c2fe82a48b456c9d2c125248f9bb34ac60de7332`.
Exact output is retained in `.runtime/contract-completion-20260919/install-y.log`
and `release-check-y.log`. No required-FFmpeg, container or live-provider claim
is inferred from this successful local command.

## Google bidding seasonality adjustments and data exclusions

X draft contracts are pushed as `693c40c`. Both captured v23 event mutation RPCs
now implement atomic create/update/remove with exact native fields and masks,
selected-client ownership, provider Ads scopes, account-local date/DST validation,
complete old/new campaign scopes, budgets and local portfolio targets/bid limits.
The 23 selectable event fields are extracted from official public v23 reference
text into a checked fixture with source URL, date and source-content hash. Native
requests continue through pinned Discovery validation and ProtoJSON transport.

The review includes both complete event histories and rechecks them after parent
reads. Known campaign/channel/device sets are unordered; unknown arrays remain
ordered. Query cost and pagination envelopes are excluded only after completeness
validation. Creation receipts must have new exact-customer resource identities.
Read-back compares full configuration and explicit clearing, or complete collection
absence after removal. Success does not certify bid learning, auction effects,
future channel members or conversion repair. Uncertain writes retain durable claims.

Business restrictions are explicit: client customers only, API-supported CHANNEL
values, qualified Smart Bidding campaign types, no App beta or cross-customer
portfolio assumptions. Google website manager-account support is not an API
contract. Data exclusions use click dates and leave reporting intact; future outage
definitions are allowed as documented in Google help, but never invented by AMCP.
New seasonality starts must be future. Both boundaries must be unambiguous in the
account timezone and span at most 14 elapsed days. Empty devices means all devices.
Every operation requires spending-impact confirmation and respects activation and
deletion policies. Neither event type changes monetary budgets directly.

Bounds: 25 mutations, 1000 historical events per kind, 2000 current campaigns,
25 pages per collection, 128 reads, 10000 total rows, 4 MiB/response, 8 MiB total,
60-second monotonic deadline, plus Google's 500-active-exclusion constraint.
Creation reserves history capacity for read-back even if a removed row remains.
The whole history snapshot deliberately makes concurrent unrelated event edits
conflict; this is a known conservative limit rather than hidden pagination loss.

Sources checked 2026-09-19: Google v23
[seasonality](https://developers.google.com/google-ads/api/fields/v23/bidding_seasonality_adjustment),
[exclusion](https://developers.google.com/google-ads/api/fields/v23/bidding_data_exclusion)
and [portfolio](https://developers.google.com/google-ads/api/fields/v23/bidding_strategy)
field references; official
[seasonality API guide](https://developers.google.com/google-ads/api/docs/campaigns/bidding/seasonality-adjustments),
[exclusion API guide](https://developers.google.com/google-ads/api/docs/campaigns/bidding/data-exclusions),
[seasonality eligibility](https://support.google.com/google-ads/answer/10369906)
and [data-exclusion guidance](https://support.google.com/google-ads/answer/10370710).
No live Ads request occurred.

Initial TypeScript checks found missing explicit dictionary annotations, corrected
without changing runtime checks. `google-events-first.log` retains 20 passes and
one failing test: skip_preflight is an unsupported native parameter, so the fixture
did not reach the intended review guard. Separate tests now assert both rejections.
`google-events-expanded.log` passed 65 tests, including 26 event tests covering full
lifecycle, clearing, scope transfers, DST, telemetry, real conflicts, complete pages,
capacity, grants, policies, foreign/partial/lost receipts, concurrency and restart.
Generated contracts, guidance and the full sanitized candidate Z follow. Live
eligibility, provider edit-time rules, FFmpeg-required and container checks remain
unverified. Other provider families remain explicitly open in the action ledger.

Candidate Z completed the sanitized `npm ci --ignore-scripts --no-audit --no-fund`
and `npm run check` with exit 0. It passed 1,066 tests with zero failures and one
FFmpeg skip; all four capture tests and subsequent generated, guidance, provider
and release checks passed. Final qualification passed 37 tests, including 26 event
tests. Logs: `.runtime/contract-completion-20260919/install-z.log`,
`release-check-z.log`, `google-events-qualified.log`. Candidate manifest SHA-256:
`fab4c10246634a8bb541b14ec2d0c0b189d13135a7a4556600279f9cd22ee401`
(494 files). A later unregistered DV360 search draft is excluded. The ledger now
contains 391 reviewed-family rows and 923 blocked writes; 104 unmapped actions,
31 unqualified reads and the other previously recorded limitations remain.

## DV360 targeting-option search and explicit connection selection

Google bidding events are pushed as `ecfa30a`. The captured search operation was
incorrectly treated as a write. Its exact v4 POST now validates the GEO_REGION,
POI and BUSINESS_CHAIN body unions and the selected advertiser before credentials
or egress. Both action-name and resource/method entry points are exercised. Search
is usable by a reader on a deployment with advertising writes disabled. It does
not assign targeting, claim ownership or create an idempotent mutation receipt.

The captured DV360 schema had no connection selector. An independent effective
schema extension now exposes UUID `connection_id`; raw catalog/help evidence is
unchanged. Duplicate-account connections and a conflicting default are tested.
The native account field remains `advertiserId` in body/params as appropriate;
invented top-level account_id and aggregate_pages are not required or advertised.

Native response validation detects wrong resource/type identities, unknown detail
variants, duplicate IDs/cursors, unexpected envelopes and impossible pages. Empty
ProtoJSON results remain valid. Complete collection requires every page; starting
from a continuation never claims earlier pages. Bounds: 25 pages, 5000 options,
4 MiB per response, 8 MiB total and a 60-second monotonic deadline. Current scope,
tenant, exact connection and advertiser grants are checked before and after reads.
An interrupted/failed page is an error, never an empty successful collection.

Official evidence checked 2026-09-19: [v4 targeting search](https://developers.google.com/display-video/api/reference/rest/v4/targetingTypes.targetingOptions/search)
(last updated 2025-03-27) and pinned `.mirror/VENDOR/dv360-v4.json` Discovery models.
The public reference defines only discovery here; later targeting assignment
still requires its own write contract and user choice. No live request occurred.

`dv360-search-unit.log`: 11 passed. First integration: 13 passed/seven failed;
fixtures used nonexistent top-level account_id/aggregate_pages, a wrong local
table name and an enabled connection with no bindings. These failures exposed
the real missing connection-control schema extension as well. The second run
retained those failures because Windows selected its unavailable Python alias;
the explicit bundled Python applied the fixture corrections. Third integration:
20 passed. `dv360-search-qualified.log`: 50 passed, including 23 dedicated tests,
existing DV360 writes, action inventory and three executable guide examples.
Generated contracts and guidance checks pass. Candidate AA follows. Inventory:
3241 actions, 391 reviewed-family rows, 922 blocked writes, 104 unmapped actions,
31 unqualified reads, eight input-dependent adapters and four withdrawn routes.

Candidate AA ran the complete unit/integration suite: 1089 passed, one failed and
one FFmpeg skip. The failure was the old help-schema equality contract, which
assumed no direct-tool schema could gain an independent AMCP control. Raw captured
schemas remain unchanged. The regression now requires the exact documented DV360
connection property, requires tools/list and help to agree, and still compares
every original property unchanged. `release-check-aa.log` preserves this failure.
Candidate AB follows; an unregistered conversion-goal draft is excluded.

Candidate AB completed `npm ci --ignore-scripts --no-audit --no-fund` and the
entire `npm run check` with exit 0: 1090 tests passed, zero failures, one FFmpeg
skip; four capture tests also passed. Generation, guidance, web, provider and
contract checks all passed. The final search/capture regression passed 29 tests.
Manifest SHA-256 `3523764e716ed7679d7097fd0fc47935e5d3a33619f7ab1c09aa22d0f1733492`
(497 files). Logs: `install-ab.log`, `release-check-ab.log` and
`dv360-search-capture.log` under `.runtime/contract-completion-20260919/`.
Live provider availability, required-FFmpeg and container checks remain unverified.


## Google conversion goals — 2026-09-20

Predecessor DV360 targeting search is pushed as `38b2d96`. Six more action rows
now use explicit `google_conversion_goals` contracts: customer goal biddability,
campaign goal biddability, campaign goal configuration and custom definitions.
The first three support native updates; custom definitions support atomic create,
update and remove. The exact four Discovery request types have no partialFailure
field. Two legacy campaign/config aliases use the same qualified native path.

This change captures the whole current non-App goal graph plus customer conversion
ownership, current conversion definitions, campaign budgets and portfolio targets.
Response telemetry and defined membership sets are normalized, while material and
unknown configuration remain conflict-sensitive. Complete pagination, duplicate
identity checks, bounded reads and a second goal-graph read prevent partial state
from becoming successful empty state. The optimistic guard cannot provide a
provider-side multi-resource transaction; concurrent external writes remain a
provider limitation and post-write mismatch stays inconclusive.

Customer defaults propagate to current CUSTOMER-level campaigns. Campaign-specific
edits and custom attachment switch to CAMPAIGN level. Resetting CUSTOMER verifies
restored biddability and treats retained custom references as inactive. Custom
membership includes secondary actions and does not disable other standard goals.
The guide requires explicit business choices and separate reviews for each step.
A durable create-custom-goal -> attach-to-campaign fixture verifies actual native
receipts and automatic inheritance effects. Preflight now symbolizes this exact
parent action as a custom goal, with actual ownership checked when preparing the
resolved step. It never grants ownership from a preview placeholder.

Scopes, same-connection account grants, tenant/actor rights, deployment controls,
review immutability/expiry, spend confirmation, activation/deletion policies,
concurrent claims and restart recovery remain enforced. Unattached custom creation
has no serving effect; a mixed create/edit batch cannot borrow that exception.
Uncertain mutation results retain the original claim. Missing inheritance effects
produce an inconclusive verification even with a successful-looking receipt.

Limits: client accounts using their own conversion customer; current non-App
campaigns only. Shared manager conversion tracking, App selective optimization,
tracking correctness, historical conversion recalculation and actual bid learning
need separate scopes/contracts or live evidence. Bounds are 25 atomic operations,
100 custom members, 2,000 campaigns/actions/custom definitions and 10,000 campaign
goals, plus total request/row/byte/time limits. No provider call was live.

Official evidence checked 2026-09-20:
- https://developers.google.com/google-ads/api/docs/conversions/goals/overview
- https://developers.google.com/google-ads/api/docs/conversions/goals/customer-goals
- https://developers.google.com/google-ads/api/docs/conversions/goals/campaign-goals
- https://developers.google.com/google-ads/api/fields/v23/customer_conversion_goal
- https://developers.google.com/google-ads/api/fields/v23/campaign_conversion_goal
- https://developers.google.com/google-ads/api/fields/v23/conversion_goal_campaign_config
- https://developers.google.com/google-ads/api/fields/v23/custom_conversion_goal

The field pages were updated 2026-09-10. `tools/google-goal-field-evidence.mjs`
extracts all 18 field tables from public web-tool text into a source-hashed fixture.
Pinned official Discovery validates native wire shapes independently. Two direct
public HTTP fetch attempts timed out; public web-tool extraction succeeded. The
initial extracted text accidentally matched the find-query header and was rejected
as empty; the fixture uses the actual source headings, with exact field counts.

Verification: `npm.cmd run build`; `node --test dist/tests/google-conversion-goals.test.js`;
field-evidence extraction/check; contract/action generators; guidance coverage;
compatibility tests for goals, bidding events, campaign recovery, write review and
all guide examples. Logs remain under `.runtime/contract-completion-20260919/`.
Initial integration: 26 passes, three fixture errors (missing confirmed policy
flag and missing native idempotency key); corrected: 29 passes. Expanded: 37 passes;
compatibility: 80 passes. No assertions or safeguards weakened. Candidate AC full
release checks follow. Current inventory: 3,241 actions, 397 reviewed-family rows,
916 blocked writes, 104 unmapped, 31 unqualified reads, eight input-dependent
adapters and four explicit provider-unsupported actions. All-platform completion
and live acceptance remain unclaimed.

Separate unresolved research: campaign bid-modifier creation is not enabled merely
from a route. The v23 resource marks campaign output-only while the operation
creation description disallows a preassigned resourceName; no reliable campaign
selection contract has yet been established. Update/remove must be qualified
separately; do not silently reuse the ad-group wire shape or multiplier range.


Candidate AC passed the entire sanitized release check: 1,127 tests passed,
zero failed, one FFmpeg skip; all four capture tests passed. Every subsequent
report, web, provider, lifecycle, generated-contract and action-inventory check
exited successfully. The field-evidence regeneration check also passed.
Manifest: 501 files, SHA-256
`9808ca186ac22ce9dc4880717dd7de1e8c01db62e6fdf2be4211ef837d702c18`.
Live Google acceptance, FFmpeg-required and container checks remain unverified.
An evidence-log print hit Windows console encoding; no product check failed.
The conversion-goal batch is ready for the authorized Codex-branch push.


## Meta asynchronous Insights reports (2026-09-20; qualification in progress)

Google conversion goals are pushed as `bc4ffd0`. The next batch adds reviewed
account/campaign/ad-set Insights creation and its account alias: four catalog
rows formerly labeled read-only but correctly refused as side-effecting jobs.
Native creation, exact definition polling, scoped retrieval, partial-page recovery
and worker retry lifecycle are implemented. Completed processing never implies
rows downloaded. Resumed calls distinguish remaining-page completion from complete
first-to-last retrieval. Scoped report receipts grant no generic resource ownership.

Public official Python SDK tag 25.0.3 confirms three creation edges, response
models and the supported native fields/parameters. Five source hashes and a
reproducible extractor are committed as schema evidence; no live Meta acceptance
is claimed. Breakdowns, filters, exports, summary and other parameter families
remain explicitly outside this initial contract. Audience Network reports remain
unqualified. Jobs require an operator, deployment writes and a write grant;
subsequent authorized reads work for readers and read-only deployments.

Initial compiler integration: one pass, 12 failures because Graph field selectors
were flattened to CSV. Async creation now freezes native list parameters before
hashing/transport. The next run had seven passes and six fixture failures because
the stub coerced the native string time_increment to a number; fixed the stub
using the official SDK types. Corrected initial suite: 13/13. Expanded suite:
29/29, including restart/concurrency, worker polling, scope revocation, malformed
HTTP-200 pages/receipts, incomplete downloads, native null/zero handling, limits,
expiry and immutable reviews. Compatibility and guide examples: 73/73.
The initial TypeScript narrowing error was also corrected before those runs.
No assertions or safeguards were relaxed. All original logs remain in
`.runtime/contract-completion-20260919/meta-reports-*.log`.

Commands: `npm.cmd run build`; contract/action generators;
`node tools/meta-insights-evidence.mjs --source-dir .runtime/contract-completion-20260919/meta-sdk --check`;
`node --test dist/tests/meta-insights-jobs.test.js`; the compatibility suite also
ran meta-label-writes, meta-contracts, meta-action-aliases, write-review and all
guide-contract examples. Guidance coverage reports no missing codes or gateways.
Candidate AD will run the complete sanitized release check.

Inventory: 3,241 actions, 401 reviewed-family rows, 916 blocked writes, 104
unmapped, 27 unqualified reads, eight input-dependent adapters and four explicit
provider-unsupported actions. These are catalog rows, not all provider APIs or
all payload variants. FFmpeg-required, container and live checks remain open.


Candidate AD passed the entire sanitized release check: 1,156 tests passed,
zero failed, one FFmpeg skip; four capture tests passed. Generation, report, web,
provider integrity/lifecycle, generated-contract and action-inventory checks all
completed with exit zero. Manifest: 505 files, source-tree SHA-256
`cb5f0baf00cf83a2e7ec2f13395205a185c6e404532fc0568067acde004fa166`.
No live Meta acceptance, required-FFmpeg run or container smoke was performed.
This batch is ready for the authorized Codex-branch push.

## Local connection diagnostics and retired Q&A (2026-09-20)

Implemented the exact status variant of GA4, Search Console and Business Profile
connection operations, plus Business Profile's local Q&A retirement diagnostic.
Four formerly unmapped catalog rows now have executable, tested local workflows.
No OAuth start/exchange/refresh/disconnect or asset synchronization is claimed.
Status performs zero provider requests and does not decrypt credentials. It
checks current actor authority, selects only this tenant/provider's identities,
resolves a unique enabled default, and bounds output with explicit truncation.
Recorded provider scopes, account/write grants and unverified token/provider
health remain distinct. No discovered but ungranted website assets are exposed.
Connection failures also redact OAuth code/state before audit persistence;
ordinary provider diagnostic error codes remain intact.

Google's official sunset and Q&A change-log pages state that Q&A was withdrawn
on 2025-11-03 without replacement (checked 2026-09-20). A successful local status
response explicitly says provider_unsupported; it never claims a Q&A API works.
Guide examples execute all four diagnostics without credentials or egress.

Initial TypeScript fixture error used the wrong revokeKey signature. Two initial
focused runs each passed 13 and failed one because the fixture first assigned a
write grant outside an empty account set, then enabled an empty account set.
Both violate existing Store invariants; corrected the fixtures instead of
loosening those guards. Corrected focused run passed 14; the expanded diagnostic,
MCP guidance and executable guide suites passed 23/23. Initial logs are retained
under .runtime/contract-completion-20260919/connection-diagnostics-*.log.
Commands: npm.cmd run build; both contract generators; node --test for
connection-diagnostics, guidance and guide-contract-examples. Candidate AE is the
next sanitized full check. No live provider or credential checks were performed.

Inventory remains 3,241 actions: 401 reviewed-family rows, 916 blocked writes,
100 unmapped, 27 unqualified reads, eight input-dependent adapters, four explicit
provider-unsupported routes, 1,704 native reads, 65 local workflows and 16 media
workflows. The Q&A status row is local; the underlying retired service is not
counted as a newly working provider API.

Candidate AE passed the full sanitized release check: 1,171 tests passed, zero
failed, one FFmpeg skip; four capture tests passed. Generation, report, web,
provider integrity/lifecycle, generated-contract and action-inventory checks
completed with exit zero. Manifest: 507 files, source-tree SHA-256
6caa222f87623f6ae08b150a6584c17976c6d5dfbfbaeb8c8055c76c962b08e5.
Logs: install-ae.log and release-check-ae.log in the local evidence directory.
No required-FFmpeg, Docker or live acceptance is claimed.

## Google campaign call-bid update/removal (2026-09-20)

Three more action rows now have reviewed execution: the campaign bid-modifier
RPC and native UPDATE/REMOVE aliases. The CREATE alias remains blocked, and an
RPC create payload is explicitly rejected: the v23 resource makes campaign
output-only, so creation needs verified native identity semantics rather than
inventing a campaign field or criterion ID. This is not full family coverage.

Existing Search CALLS modifiers use an exact discovered composite resource;
0.1-10 is the native multiplier range, not micros or a percentage. Zero remains
a device-only opt-out. Review reads the client account, complete call modifiers,
selected campaign/budget configuration and client-owned portfolio configuration.
The entire native portfolio configuration field table is independently recorded;
only aggregate campaign counts and redundant ID are excluded. A second parent
read catches changes while dependencies are fetched. Cross-customer portfolios
remain unqualified. State bounds: 25 operations, 25 pages/query, 80 requests,
2100 total rows, 4 MiB/page, 8 MiB total and a 60-second monotonic deadline.

The existing durable claims, immutable reviews, current grants, native scopes,
spend acknowledgement and owner activation/deletion policies remain enforced.
Exact update and complete-collection deletion read-back cannot certify an ignored
write, permission failure or partial response. No created-resource ownership is
inferred. Google bid verification now rechecks OAuth scopes on each in-flight
read as well as before verification; this also protects existing ad-group bids.

Official evidence checked 2026-09-20: v23 CampaignBidModifier; the campaign_bid_modifier
and bidding_strategy field tables (last updated 2026-09-10); the current Manage
Bid Modifiers guide and Google Ads Help interaction adjustment range/eligibility.
URLs are in the maintained Google guide. Reproducible field extraction retains
five modifier fields and 30 portfolio fields with source hashes. No live query
or mutation was performed. Shared manual-bid configuration does not prove auction
effects, call-asset eligibility or that Smart Bidding applies the adjustment.

Initial build failures were a TypeScript unknown-response narrowing and fixture
cleanup signature, then an expanded fixture syntax error; corrected without
loosening checks. First focused run: 33 passed, two fixture failures (spend policy
confirmation/policy nesting and an already-parsed Store document). Corrected run:
35/35. Expanded lifecycle, pagination/byte/time limits and schema evidence: 39/39.
Compatibility with review/state and executable guides: 59/59. The first field
extractor retained 4/5 fields because a web line label was inline; it now handles
inline labels and still requires the complete field counts. Initial logs remain
in .runtime/contract-completion-20260919/campaign-bids-*.log.

Commands: npm.cmd run build; node --test for google-campaign-bid-modifiers,
google-bid-modifiers, write-review, review-state and guide-contract-examples;
node tools/google-bid-field-evidence.mjs .runtime/contract-completion-20260919
2026-09-20 --campaign (and --portfolio, with --check for integrity).
Candidate AF completed the sanitized release check: 1,189 tests passed, zero
failed, one optional FFmpeg test skipped, plus four capture tests passed.
All check stages exited zero. Its 511-file manifest records source-tree SHA256
61f4e9dcb2c69be21217dbf4bfc83627bff91ac9103379f3ffc8e12041e63294.
Evidence: .runtime/contract-completion-20260919/install-af.log and
release-check-af.log. The required-FFmpeg CI mode was not run on this host.

Inventory: 3,241 actions, 404 reviewed-family rows, 913 blocked writes, 100
unmapped, 27 unqualified reads, eight input-dependent adapters and four explicit
provider-unsupported routes. None of the remaining rows is marked completed by
this implementation. Required-FFmpeg, container and live verification remain open.

## 2026-09-20 — Business Profile public action links (candidate AG)

Implemented the exact CREATE/PATCH/DELETE_PLACE_ACTION_LINK contracts under
google_business_native_action / gmb_engagement_ops. This qualifies three more
mapped writes: 407 reviewed-family rows and 910 blocked writes out of 3,241
catalog actions. The 100 unmapped actions, 27 unqualified reads, eight
input-dependent adapters and four provider-unsupported actions remain explicit.

The contract requires an already provisioned business.manage identity and exact
locations/{id} read/write grants. A broader Business Profile account does not
confer location authority. Website OAuth and asset discovery remain unavailable;
the provider descriptor retains those limitations rather than inferring them
from the new guide. No live account, credential or provider mutation was used.

Preparation reads the public business identity/category configuration, native
location-filtered eligible action types and complete link collection, then
repeats the snapshot for consistency. Native envelope/identity validation precedes
projection; localized labels and create/update timestamps are omitted, while
real URI, type, editability, provider, preferences and business identity changes
conflict. Limits: 1,000 links, 25 pages/collection, 80 requests, 4,100 total rows,
2 MiB/page, 8 MiB total and 60 seconds per snapshot.

Creation/editing publishes a public link without a paused state. Owner
allow_activation=false forbids both; allow_deletion=false forbids deletion.
Exact field masks and explicit false clears are enforced. Unique URI/type pairs
and currently editable targets are required. Choosing a preferred link clears
the previous preference of that type; read-back compares the complete expected
collection including that side effect. Unknown/partial/foreign receipts, failed
discovery and lost outcomes never permit another mutation. Verified creation
returns the scoped link identity; it does not grant a global resource binding.

Public destinations are never fetched by AMCP. Private/signed URLs and credentials
are rejected, and rejected URL values are removed from inspect output, failed
receipts, provider error echoes and audit input. The original input remains
immutable. A URL containing "budget" does not falsely require spend confirmation
in this exact non-budget contract. All ordinary review/deployment/grant checks
remain enforced. Read-back does not establish Maps/Search display, public
destination availability, approval or conversions.

Official sources checked 2026-09-20: PlaceActionLink resource, create/patch/delete/
list methods, location-filtered placeActionTypeMetadata and Business Information
location data. URLs and version boundaries are in the maintained
dv360-and-measurement guide. Native field/enum coverage is checked against the
pinned business-place-actions-v1 Discovery artifact; SOLOPRENEUR_APPOINTMENT also
requires current location eligibility. Provider approval and live behavior remain
unverified.

Validation: initial 21/21 lifecycle tests passed. Expanded suite has 24 new tests;
53/53 passed with shared review/state/spending-policy checks, and 39/39 passed
with delegated-native and executable guide checks. Two test compilation failures
during expansion (optional payload narrowing; an extra mock response field) were
corrected without changing assertions; their build logs remain. Bounds tests
assert the specific byte/page/row/deadline failure, not merely any rejection.
Build, contract generators and guidance checks passed (80 traversed modules,
14 reviewed gateways, no missing guide coverage). Evidence:
.runtime/contract-completion-20260919/place-links-*.log.
Candidate AG ran the complete sanitized check; the failure and correction are recorded below.

## 2026-09-20 — Business Profile notification configuration (candidate AH)

Added UPDATE_NOTIFICATION_SETTING under gmb_notification_ops. Both native mutable
fields are covered: pubsubTopic and complete notificationTypes replacement, with
exact masks and unchanged unmasked fields. Disabling explicitly clears both.
The administrator-only contract verifies the exact numeric account grant,
business.manage scope, current actor, account identity and native setting.
Location grants and another login cannot substitute for the frozen connection.

The review explains the account-wide data destination, previous topic, selected
events and future-location effect. Topic provisioning, IAM, subscribers, test
messages and delivery validation are explicitly outside this contract. Pub/Sub
may incur Cloud charges; no advertising budget is edited. Activation policy
protects enablement/changes; clearing is classified as destructive despite PATCH
and respects deletion policy. Existing partial or lost outcomes cannot replay.

The complete state is read twice, bounded to four requests, 1 MiB per response,
4 MiB total and a 30-second monotonic deadline. Notification types are a set;
actual topic/type/account-authority changes remain conflicts. Missing defaults
on a correctly identified setting are empty values; a 404, 403, unknown envelope
or unidentified body is never an empty configuration. Read-back verifies saved
settings, not event delivery, topic IAM, retention or subscriber access.

The current official NotificationSetting reference (updated 2025-11-06) marks
Q&A events retired after 2025-11-03, unlike the captured Discovery enum. All six
current and five retired/deprecated values are accounted for in tests. Existing
old values remain visible for explicit removal/migration but cannot be newly
requested or silently retained when enabling a destination. LOSS_OF_VOICE_OF_MERCHANT
must migrate to VOICE_OF_MERCHANT_UPDATED. Captured vendor evidence was preserved.
Official setup, method, account and Pub/Sub sources checked 2026-09-20 are linked
in the maintained measurement guide; the setup guide resolves the generic field
mask wording using its concrete pubsubTopic mask example.

Validation: 18 new notification tests plus 24 place-link tests. Initial combined
run: 40 passed / one failed because the place-link inventory test counted every
Business Profile write instead of its engagement operation; scoped that fixture
to its named operation and retained the exact three-action assertion. Notification
and guide fixtures independently require the new family. Expanded compatibility
passed 101/101 across both new families, spending policy, shared state matrix and
executable guides. Guidance check initially reported undocumented ADMIN_REQUIRED;
added its administrator/reviewer remedy, then all 81 modules / 14 reviewed gateways
passed. Source and initial-failure logs are retained as business-notifications-*.log.

Candidate AG evidence is retained: 513 files, source-tree SHA256
056f2e5546d17a0974703548c8e5d45ec47059c46d413e9a0e04d3212f1c07e7.
Its first complete-check attempt failed when spawnSync python reached a broken
Windows shim. Retried with AMCP_SCHEMA_PYTHON set to the configured Python binary.
That attempt ran 1,214 tests: 1,212 passed, one failed, one optional FFmpeg skip.
The failure was the shared gateway snapshot matrix missing the newly enabled
Business Profile gateway. Added its compound-state fixture, preserving the
all-gateway equality assertion; all 38 envelope tests pass. No test was disabled.
Evidence: install-ag.log, release-check-ag.log, release-check-ag-retry.log and
place-links-envelope-fix.log in .runtime/contract-completion-20260919.

Candidate AH completed the sanitized full check with both Business Profile
families and the matrix correction: 1,232 tests passed, zero failed, one optional
FFmpeg skip, plus four capture tests passed. All check stages exited zero.
Its 515-file manifest records source-tree SHA256
25d7448d6910f74591fdc985c5689aa9158e0f309c53f14fd75baae50dd26663.
Evidence: install-ah.log and release-check-ah.log, with AMCP_SCHEMA_PYTHON set
to the configured Python runtime. Inventory now: 3,241 actions, 408
reviewed-family rows, 909 blocked writes, 100 unmapped, 27 unqualified reads,
eight input-dependent adapters and four provider-unsupported actions. Required
FFmpeg mode, Docker and live provider/deployment verification remain unrun.

## 2026-09-20 — Local connection disconnect (candidate AI)

Implemented the three explicit disconnect actions for GA4, Search Console and
Business Profile. A current administrator must name an exact connection UUID.
The default previews the named login and impact; dry_run:false performs the
authorized local disconnection. No implicit/default identity selection, provider
request, credential decryption or provider OAuth revocation occurs. Advertising
deployment write controls do not prevent removing local credential access.

The website and MCP now share one transaction that deletes the credential row,
resource bindings and discovery documents and records a receipt plus audit event.
Reports, reviews, submitted jobs and idempotency claims remain for reconciliation.
A replay returns the original local receipt; an in-flight token refresh cannot
restore a deleted connection. A submitted external mutation may still complete;
disconnect does not cancel it or permit a blind retry. Administrator test accounts
remain restricted to their isolated workspace. No live credentials were changed.

Seventeen new tests cover all three adapters, dry-run defaults, cross-tenant and
cross-gateway IDs, duplicate account identities, concurrent/restarted calls,
disabled connections, read-only deployments, atomic audit-failure rollback,
pending recovery evidence, delayed refresh, test accounts, website compatibility,
redacted labels and executable guide previews. Initial compatibility passed
61/61 tests; expanded diagnostic/disconnect/guidance validation passed 38/38.
Build, both contract generators and guidance checks passed (81 modules and
14 reviewed gateways). Logs: connection-disconnect-*.log under
.runtime/contract-completion-20260919. No failure was hidden or assertion relaxed.

Inventory: 3,241 actions, 408 reviewed-family rows, 909 blocked writes, 97 unmapped,
27 unqualified reads, eight input-dependent, four provider-unsupported and 68
local workflows. Start/exchange/refresh and other unmapped actions remain explicit.
Business Profile website OAuth is not enabled by local connection management.
Candidate AI completed the full sanitized check: 1,249 passed, zero failed,
one optional FFmpeg skip, plus four capture tests passed. All check stages
exited zero. The 517-file manifest records source-tree SHA256
77f1fdef9f032c5a61b28eb862bb4aa7f99e6148635a79cc4ba3a6c33f6ba475.
Exact commands: release assembly, npm.cmd ci --ignore-scripts, npm.cmd run check
with AMCP_SCHEMA_PYTHON set to the configured Python binary. Evidence is retained
in install-ai.log and release-check-ai.log. Required FFmpeg mode, Docker and
live provider/deployment qualification remain unrun.

## 2026-09-20 — Business Profile place-action discovery (candidate AJ)

Closed the public discovery path for LIST_PLACE_ACTION_TYPE_METADATA,
LIST_PLACE_ACTION_LINKS and GET_PLACE_ACTION_LINK. An isolated baseline with a
valid synthetic locations/456 grant reproduced RESOURCE_SCOPE_REQUIRED before
provider egress for location-filtered metadata. The compiler now binds the exact
location filter to that grant; a friendly location_id supplies the filter when
omitted. Global/CLDR-region metadata remains supported but never implies location
eligibility. A broader account cannot substitute for a selected location.

Current grants, selected connection and business.manage scope are checked before
and after every page. Lists follow at most 25 pages / 1000 rows, with 1-100 page
size, 2 MiB/page, 8 MiB total and a 60-second monotonic deadline. Continuations
retain native filter, locale, identity and cursor; resumption never claims prior
pages were included. Native empty lists, unknown/partial/error bodies, foreign
identities, duplicates and token loops stay distinct. Single GETs require their
exact resource identity. No ownership or write grant is inferred from metadata.

Read results retain native fields and timestamps, while private/invalid destination
URLs and error echoes are redacted before client/audit output. Explicit previews
need no credentials or network. Runtime help corrects the captured claim that
reads ignore dry_run; the original captured schema remains unchanged. Three
executable read examples and provider/action descriptors identify the qualified
implementation and its limits. These were already native-read inventory rows;
no action denominator or write backlog is reduced by relabeling them.

Initial 22-test run: 21 passed, one failed. The new negative fixture found that
locations/456/extra was silently shortened to locations/456 by generic resource
parsing. Fixed exact input validation instead of weakening the assertion. Expanded
validation passed 81/81 across 24 new read tests, both Business Profile write
families, delegated routing and all executable guides. Build, generators and
guidance checks passed (83 traversed modules / 14 reviewed gateways).
Evidence: business-place-read-*.log under .runtime/contract-completion-20260919.

Official metadata/list/get references checked 2026-09-20, with reference pages last
updated 2024-10-16; exact URLs are linked in dv360-and-measurement.md. Native field
and enum assertions use the unchanged business-place-actions-v1 Discovery artifact.
Provider approval, live location eligibility and actual public display remain
unverified. Candidate AJ completed the full sanitized check: 1,273 tests passed,
zero failed, one optional FFmpeg skip, plus four capture tests passed. All check
stages exited zero. Its 520-file manifest records source-tree SHA256
09ca0052759354b6e920df6ab3520c9dac2ec1d8a95ce391bc5e3698b9f3c2be.
Evidence: install-aj.log and release-check-aj.log, using npm.cmd ci --ignore-scripts
and npm.cmd run check with the configured AMCP_SCHEMA_PYTHON. Required FFmpeg mode,
Docker and live provider/deployment checks remain unrun.

## 2026-09-20 — Business Profile account and administrator access (candidate AK)

Added seven reviewed gmb_account_ops actions: accountName-only PATCH_ACCOUNT and
CREATE/PATCH/DELETE_ACCOUNT_ADMIN and CREATE/PATCH/DELETE_LOCATION_ADMIN. Current
AMCP administrator status, exact native parent read/write grant, business.manage
and all shared deployment/review/idempotency guards remain mandatory. Reviewer
test accounts cannot change external administrator access. Account administration
also requires a native non-personal business account with owner authority.

Preparation reads the exact parent and complete native membership twice.
accountAdmins and admins are distinct unpaginated wrappers; unknown, empty,
duplicate, foreign, changing or unexpectedly paginated responses fail closed.
Bounds: 1000 members, 2 MiB per response, 8 MiB total, 30-second monotonic deadline.
All prerequisite reads recheck current actor, scopes and grants before/after
credential retrieval and egress, including separately granted invitee groups.
Active display names and verification/vetting telemetry are excluded from state;
pending email, native group, stable ID, role and invitation state remain protected.

Invitation requires exactly one user-approved email or, for a location, a
currently readable LOCATION_GROUP on that same login. Creation receipt must
bind a new native ID to that exact principal/role. Read-back separates pending
acceptance from active access. A verified pending-email receipt permits only
the subsequent acceptance transition; changed roles/groups/other members remain
inconclusive and never report verified access. Role-only masks, exact recipients,
active-primary-owner preservation and immutable fields are enforced. New or
increased access obeys activation policy; deletion/demotion obeys deletion policy.
Account names containing budget terms do not produce false spend confirmation.

Native location lists do not identify the acting Google user: the review explicitly
leaves native owner authority/seven-day restrictions to provider enforcement.
PRIMARY_OWNER transfers, native account creation, invitation acceptance/decline
and validateOnly remain separate unqualified contracts. No live access changes
were attempted. Generic friendly-resource parsing also rejects trailing resource
paths instead of silently truncating them; valid complete GA4 names still work.

Validation: initial build found one test-fixture syntax error, corrected. Initial
25-test execution passed 20 and failed five because fixtures omitted policy
confirmation/nesting, violated Store's write-grant subset invariant, assumed an
in-flight duplicate completed, or expected review gating before the earlier
confirmation gate. Corrected fixtures now assert the exact current contracts and
deterministically hold a provider mutation to verify concurrency. The expanded
run then found a malformed JSON example and an assertion using an internal
resources field instead of public verified_resources; both corrected. All
initial logs remain. No guard or assertion was disabled to pass tests.

Twenty-nine new tests plus related Business Profile/delegated compatibility
passed; the final expanded run passed 133/133 across access, delegated compiler,
GA4/GSC/Apple/GTM measurement writes and executable guide families. Build, both
contract generators and guidance validation passed (84 modules, 14 reviewed
gateways). Evidence: business-access-*.log in .runtime/contract-completion-20260919.
The 100-test intermediate compatibility run also passed before four extra cases.

Current inventory: 3241 actions, 415 reviewed-family rows, 902 blocked writes,
97 unmapped, 27 unqualified reads, eight input-dependent, four provider-unsupported,
1704 native reads, 68 local workflows, 16 media workflows. Counts qualify action
families only; permitted payload limits and all live qualification gaps remain.
Official v1 Account/Admin, create/patch/delete/list references checked 2026-09-20
(reference pages updated 2024-10-16), plus owner-permission help. Exact URLs,
pending-versus-accepted behavior and recovery are in dv360-and-measurement.md;
five new inspect examples execute without credentials or network. Provider
descriptor version is 7. Pinned native Discovery is unchanged.

Sanitized candidate AK full verification is pending. Required FFmpeg, Docker,
provider approval and live/deployment behavior are not established by fixtures.
Candidate AK completed the full sanitized check: 1302 passed, zero failed,
one optional FFmpeg skip, plus four capture tests passed. Every check stage
exited zero. The 522-file release manifest records source-tree SHA256
6eb154b00650be00080b925ca15ebbd348c6d0fb496cb880a7f8207e6cf4be02.
Commands: release assembly, npm.cmd ci --ignore-scripts, npm.cmd run check with
the configured AMCP_SCHEMA_PYTHON. Logs: install-ak.log and release-check-ak.log.
Required FFmpeg mode, Docker and live/deployment qualification remain unrun.

## 2026-09-20 — Google Ads recommendation dismissal (candidate AL)

Added the v23 dismissal RPC and legacy DISMISS_RECOMMENDATION reviewed family.
Both accept 1-100 distinct selected-customer resource names in one atomic,
same-native-type batch. Partial-failure execution, invented validation fields,
header/query overrides and implicit replacement recommendations are refused.
Dismissal does not apply suggestions or alter provider auto-apply subscriptions.

Preparation reads the client customer and complete selected recommendations
twice. It freezes dismissal status, type and exact campaign/ad-group/budget
associations. Unordered campaign membership is compared as a set; provider
query cost, request IDs and forecast impact are excluded. No proposed campaign
configuration is executed by this contract. Changed state retains exact field
diagnostics. Failed, duplicate, foreign, moving, count-incomplete, expired or
unexpected results are never accepted as successful empty state.
Bounds: 25 pages/query, 100 total requests, 100 selected rows/collection,
2 MiB/response, 8 MiB total, 60-second monotonic deadline. Native opaque IDs
remain strings; current selected connection, manager routing, grants and adwords
scope are rechecked before and after reads. Owner deletion policy covers POST
dismissal; activation/monetary controls do not misclassify it as a budget edit.

A receipt must name every selected ID exactly once. Verification must actually
read dismissed:true for those IDs with unchanged associations. Expiry/disappearance
after execution remains inconclusive rather than proof of dismissal. Lost or
partial responses preserve the original claim; deterministic concurrency and
SQLite-reopen tests prove a single submission without automatic retries.

Initial test compilation exposed stale fixture assumptions (a nonexistent Store
deleteConnection helper and omitted Compiler options), corrected using the
actual shared disconnect function and compiler contract. Initial runtime:
16/18 passed. One real diagnostic defect placed prerequisites ahead of state
comparison, masking STATE_CHANGED with already-dismissed input advice; separated
preparation prerequisites and reapplied them after the execution comparison.
The other fixture attempted unsupported public fields and expected a later gate;
it now checks that schema refusal and independently asserts WRITE_REVIEW_REQUIRED
for a forged direct runPlan. No guard or assertion was removed.

Expanded compatibility passed 80/80 across dismissal, Business Profile access,
Google schemas, snapshot projection, execution risk, policies and executable
guides. The final 22-test dismissal suite plus the latter shared tests passed
52/52 after adding opaque-ID, manager-routing, native-parent and review-integrity
cases. Build, contract generators and guidance checks passed (85 modules,
14 reviewed gateways). All initial and final logs are retained as
recommendation-dismiss-*.log in .runtime/contract-completion-20260919.

Official v23 request/response references checked 2026-09-20 (updated 2026-02-23),
native recommendation field reference and official retrieval/dismissal guide.
They document the 100-operation same-type atomic constraint, explicit dismissed
field and recommendation expiry. The current sample uses a newer API version;
runtime remains pinned to v23 Discovery, independently checked in tests.
Exact URLs and limitations are in the maintained Google Ads guide and a new
executable no-egress inspect example. Provider contract version is 13.

Inventory: 3241 actions, 417 reviewed-family rows, 900 blocked writes, 97 unmapped,
27 unqualified reads, eight input-dependent, four provider-unsupported, 1704
native reads, 68 local workflows and 16 media workflows. This qualifies only
dismissal; recommendation application/subscriptions remain separate work.
Candidate AL full verification passed: npm ci --ignore-scripts and npm run check
both exited 0 in .release/contract-batch-20260919-al. Main suite: 1324 passed,
zero failed, one optional FFmpeg skip; four capture tests passed. All remaining
check stages passed. Sanitized manifest: 524 files, source_tree_hash
65ee83022b57f31a6b1a068a1761c0b7f397b6c82839bb027a1841a00cb483a3.
Logs: install-al.log and release-check-al.log under
.runtime/contract-completion-20260919. Required FFmpeg mode, Docker and live
Google Ads mutation remain unrun; no provider access or permission was changed.

### Batch AM: scoped Meta existing-post discovery (implementation complete; full check pending)

Six previously unmapped `fetch_meta_existing_posts` actions now have explicit
runtime contracts: GET_PAGE_POSTS, FETCH_PAGE_POSTS, LIST_IG_MEDIA, GET_IG_MEDIA,
GET_POST_BY_ID and LOOKUP_POST_BY_URL. The captured registry remains unchanged;
a maintained runtime extension exposes only executable selection and read fields.
Source: src/meta-existing-posts.ts and src/meta-post-extensions.ts, with service,
catalog, action ledger, provider descriptor (Meta version 6), errors and guidance.

Every live read selects the exact Meta login/ad account, completes its Page
identity discovery, obtains only that Page's ephemeral access token server-side,
and checks native content ownership. Instagram additionally verifies the Page's
professional-account link and the advertiser's Instagram identity list. Current
actor, account grants, read scopes and credential identity are rechecked around
each provider request. Token retrieval races and in-flight reauthorization abort.
The workflow creates no persistent ownership or write grants, publishes nothing,
and returns native creative references accepted by separate local write inspect.
Native advertising eligibility still requires its own reviewed provider workflow.

Canonical user permalinks are parsed, never fetched. Short/share/profile/private
URLs cannot escape fixed Graph endpoints. Token-bearing paging and CDN URLs are
not returned or logged; provider error bodies are omitted to avoid token echoes.
Native cursors stay inside authenticated encrypted 15-minute continuations, bound
to tenant, actor, connection credentials, selection and Page-linked identity.
They survive workers/restarts sharing the master key and allocate no database
rows. Partial and resumed segments never claim global completeness. A partial
URL lookup cannot establish absence. Missing permalink/owner/partial envelopes,
duplicates and pagination loops fail explicitly.

Limits: 1-100 list results/call; URL search 1000 records/25 pages/call; account
identity collections 1000 records/25 pages each; 80 total requests, 2 MiB/response,
8 MiB total, 60-second monotonic deadline. The caller follows the returned
next_call for later segments. `dry_run:true` is no-egress input validation.

Instagram's optional instagram_basic scope is documented through the existing
AMCP_META_SCOPES override; defaults, existing tokens and provider permissions
are not silently changed. Five executable examples reconcile native reference
fields with meta_creative_create inspection. Page versus advertiser access,
reauthorization, app approval and content eligibility remain distinct.

Initial build caught three TypeScript narrowing/recursive return annotations;
fixed before runtime verification. Initial 24 tests passed. Expanded 29 tests
caught one real parser edge: Node base64 decoding accepted trailing data after
padding. Enforced canonical three-part ciphertext encoding and added explicit
padding/extra-segment tests. Final targeted compatibility: 55 passed, zero failed,
including 30 new read/negative/restart tests, Meta contracts/provisioning/library,
OAuth scope controls, inventory and guidance. Initial logs remain under
.runtime/contract-completion-20260919/meta-post-*.log. Build, source fixture
regeneration, contract generators and guidance passed (87 modules, 14 gateways).

Official documentation accessed 2026-09-20: pinned Meta Python SDK 25.0.3 for
Page, PagePost, IGUser, IGMedia and AdAccount; Meta-owned Facebook and Instagram
Postman collections for Page token and linked-account authorization. Direct Meta
documentation returned 429. The source-hashed two-model/four-edge fixture is
regenerated by tools/meta-post-evidence.mjs from public files only; runtime uses
no SDK dependency. Current native field/token acceptance, approval and eligibility
remain unverified live. URLs and research limitations are in the Meta guide.

Current inventory: 3241 actions, 417 reviewed-family, 900 blocked writes,
91 unmapped, 27 unqualified reads, eight input-dependent, four provider-unsupported,
1704 native reads, 74 local workflows and 16 media workflows. Vendor denominator
still contains 1208 pinned methods with 454 unmapped; Apple SDK includes 99 methods
with 58 unmapped. Amazon remains zero captured actions with unknown API coverage.
No provider mutation or permission change occurred.
Candidate AM full verification passed: npm ci --ignore-scripts and npm run check
both exited 0 in .release/contract-batch-20260919-am. Main suite: 1354 passed,
zero failed, one optional FFmpeg skip; four capture tests passed. Every remaining
check stage passed. Sanitized manifest: 529 files, source_tree_hash
a7a3e79e1933d05d0fa9db82d1ca08b0fefccb09b3312e733e34e6c140803b29.
Logs: install-am.log and release-check-am.log under
.runtime/contract-completion-20260919. Required FFmpeg mode, Docker and live
Meta approval/token/content/advertising eligibility checks remain unrun.
