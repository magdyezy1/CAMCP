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

## Remaining work

The generated ledger currently contains 3,241 actions / 301 reviewed-family rows,
1,016 blocked mapped writes, 107 unmapped actions, 50 unqualified reads and eight
input-dependent adapters. Independent vendor evidence now inventories 1,208
methods, 454 without mapped actions. Every remaining row stays explicit in the
generated inventories. `CONTRACT-COMPLETION-PROGRESS.md` records the next families;
this checkpoint must not be presented as completion of those rows.
