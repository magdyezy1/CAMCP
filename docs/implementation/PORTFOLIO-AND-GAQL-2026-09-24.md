# Portfolio contracts and GAQL correction — 2026-09-24

Implementation starts at `48054ff54a18e78a26e97f615580b108771fad21`, in the
`implementation-Codex-branch` checkout of `https://github.com/magdyezy1/AMCP.git`.
Only `Codex-branch` is authorized. Parent development/release directories were
not changed. No advertising writes, account/permission changes, production
configuration changes or messages were sent. Provider execution below is synthetic.

## Implemented behavior

Four previously blocked actions now share a qualified portfolio contract:
`CREATE_BIDDING_STRATEGY`, `UPDATE_BIDDING_STRATEGY`, `REMOVE_BIDDING_STRATEGY`,
and `google_ads_v23_bidding_strategy_mutate_bidding_strategies`.

The six schemes are target CPA, target ROAS, maximize conversions, maximize
conversion value, target impression share and maximize clicks (`targetSpend`).
The contract validates native fields, oneofs, int64 units, trimmed UTF-8 byte
names, exact leaf masks, immutable type, account identity and unique names.
Creation is unattached; campaign assignment remains a separate reviewed action.
Removal requires zero total campaign associations, a deliberately conservative
limit for historical associations. Aligned budgets and manager/cross-customer
portfolios are explicit unsupported variants of this family.

Prepare and execute each collect a bounded, twice-checked snapshot of customer,
selected portfolios, current affected campaigns, budget configuration and other
campaigns sharing those budgets. Portfolio counts must match campaign discovery.
Only name-changing operations depend on unrelated portfolio names. Projections
exclude telemetry and unrelated portfolio targets, while keeping meaningful
configuration, campaign membership and shared-budget changes. Grants/scopes are
checked around each read; credential changes during reads fail closed.

CPA/CPC units remain distinct from budgets. Scheme edits require spend confirmation
and obey owner activation policy; removals obey deletion policy. Rename-only
requests no longer trigger the generic word match on `biddingStrategies`.
Receipts must match exact resources and batch order; new receipts cannot reuse a
previous resource identity. Read-back compares complete qualified configuration
or active-collection absence. Concurrent submissions and lost responses retain
their exact claim across SQLite reopen, preventing automatic mutation replay.

No runtime dependency or schema migration. Wiring includes reviewed route gate,
shape/state/outcome dispatch, preflight, spending policy, verification, impact,
action catalog, provider contract version 15 and AI-facing examples/guidance.

## Confirmed additional defect: non-sortable GAQL field

The pre-existing `google-bidding-events.ts` query builder appended
`ORDER BY <resource>.resource_name`. The initial portfolio implementation inherited
that pattern. Google's v23 field references mark bidding strategy, seasonality
adjustment, data exclusion and campaign-budget resource names **Sortable False**.
The independent query-error protocol includes
`PROHIBITED_FIELD_IN_ORDER_BY_CLAUSE = 40`.

This is a P1 correctness blocker for the affected event state reads, with high
source/contract confidence. A strict synthetic provider reproduces failure before
any mutation: all three reader tests failed on the uncorrected source. The fix
removes the invalid ORDER BY, follows complete native page tokens and continues
comparing identity-keyed maps. All three regressions pass afterward. Existing
event and portfolio lifecycle fixtures now reject the forbidden sort too. This
does not remove concurrency checks, pagination bounds or meaningful state fields.
No live Google query was sent, so observed live rejection is not claimed.

Repository search found these two automatic GAQL resource-name sort builders.
Caller-supplied legacy `order_by` remains explicit input and provider-validated;
this correction does not claim a full arbitrary GAQL semantic validator.

## Official evidence and qualifications

Checked on 2026-09-24:

- [v23 BiddingStrategy fields](https://developers.google.com/google-ads/api/fields/v23/bidding_strategy): selectable configuration fields, IDs/counts, native currency and non-sortable resource name.
- [BiddingStrategy resource](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/resources/bidding_strategy.proto), [mutation service](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/services/bidding_strategy_service.proto), [bidding schemes](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/common/bidding.proto) and [strategy errors](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/errors/bidding_strategy_error.proto): oneof/type, request/response, units and association constraints.
- [Scheme contexts](https://developers.google.com/google-ads/api/docs/campaigns/bidding/strategy-types): current portfolio/standard distinction and retired enhanced CPC. Newer guide samples do not upgrade the pinned v23 transport.
- [Seasonality fields](https://developers.google.com/google-ads/api/fields/v23/bidding_seasonality_adjustment), [exclusion fields](https://developers.google.com/google-ads/api/fields/v23/bidding_data_exclusion), [budget fields](https://developers.google.com/google-ads/api/fields/v23/campaign_budget) and [QueryError](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/errors/query_error.proto): sortability defect and native error classification.

Seven exact public proto byte streams are retained under
`.runtime/contract-completion-20260924/`. Their source URLs, SHA-256 values,
extracted fields/enums and resource/service contracts are in
`tests/fixtures/google-portfolio-v23.json`. Reproduce with:

```powershell
node tools/google-portfolio-evidence.mjs --source-dir .runtime/contract-completion-20260924 --check
```

On another checkout, fetch only the seven listed public URLs into the filenames
expected by the generator; no credentials or provider account data are needed.
The sources are version-pinned paths on upstream master plus content hashes.
Source changes must be reviewed rather than silently replacing the fixture.

One unresolved documentation mismatch was examined, not converted into a false
bug claim: the [API exclusion guide](https://developers.google.com/google-ads/api/docs/campaigns/bidding/data-exclusions)
describes a past start, while [Ads Help](https://support.google.com/google-ads/answer/10370710)
recommends scheduling known future outages. Existing local future-date acceptance
is preserved, with explicit guidance that it does not establish v23 live eligibility.
Native eligibility evidence is still needed for that variant.

## Verification record

Node 24.19.0, npm 11.17.0, PowerShell on Windows. Tests use synthetic encrypted
stores and fake providers. Full checks use a newly assembled public release with
an empty live-evidence fixture; the root historical live-response file was not read.

Initial failures are retained:

1. Initial build found strict TypeScript narrowing/return annotations and missing
   hash imports in the new module. Corrected before runtime tests.
2. `.release/portfolio-20260924-a/portfolio-focused-1.log`: 18 passed, one failed.
   The failing rename-only policy test exposed the generic bidding-word match;
   the exact family serving classifier now handles that route. The assertion
   was preserved; the broad fallback was narrowed to the qualified contract.
3. The first public-proto extraction check failed because required-field options
   follow the native repeated operations declaration. The extractor was corrected
   to recognize that declaration; it still verifies the exact native operation
   and result types/tags. Multiline proto declarations are extracted correctly.
4. `.runtime/contract-completion-20260924/gaql-sortability-before.log`: three
   failed. `gaql-sortability-after.log`: the same three passed after the query fix.

Focused candidate B: 20 passed, zero failed/skipped, including all six native
scheme lifecycles, legacy create/update/remove, exact clearing, policies,
cross-account/malformed requests, telemetry, real conflicts, missing/inconsistent
reads, in-flight authority changes, receipts, concurrency and restart. Candidate B
predates the subsequently reproduced sortability correction; do not claim it
alone proves the final source.

Final executable candidate C is `.release/portfolio-20260924-c`, 558 files,
source tree hash `e1799f7d01750af85634ecabe2e0c486e787bc298492d73e7273b3ba1079ce68`.
Its baseline revision is the earlier commit plus the recorded working changes.
Install uses `npm.cmd ci --offline --ignore-scripts --cache <implementation>/.runtime/npm-cache`.
The complete check is `npm.cmd run check` with `AMCP_SCHEMA_PYTHON` pointing to the
bundled Python. `portfolio-check.log` retains complete output. Final completion
and hashes are recorded below.

Final complete check exited 0: **1440 main tests passed, zero failed, one optional
FFmpeg skip; all four capture tests passed**. Code generation, vendor/WSDL/feed
checks, reporting evidence, website checks, provider drift/lifecycle, contract
generation and action coverage all passed. The skipped FFmpeg case was then run
successfully with required mode in the separate seven-test media run below; do
not describe the earlier full command as having run with required FFmpeg enabled.
`node deploy/check-railway.mjs` and `git diff --check` also passed. Docker was not run.

Evidence SHA-256:

| Artifact | SHA-256 |
| --- | --- |
| Candidate C complete check | `76f31bc6902613873bcd51efc4493197d0ff7fd76feade7c8a3bba20de78c568` |
| Candidate C required-media run | `6b19bd8be0aa6dcaaa3f4f37b9f8c80f4cb70bcd88048fba831bb1f3edfdb064` |
| GAQL sortability before | `14337adeaadab612941f599906f2b5f7908699b2e05bc9844de4304096f9c793` |
| GAQL sortability after | `d409bdd467ef285ad39c24a992c36b35cd7855ada7423c0aafd1cd22d7669526` |

Required native media validation also ran in candidate C:

```powershell
$env:AMCP_FFMPEG_PATH='<implementation>/.runtime/contract-completion-20260924/ffmpeg-9.0.2/ffmpeg.exe'
$env:AMCP_FFPROBE_PATH='<implementation>/.runtime/contract-completion-20260924/ffmpeg-9.0.2/ffprobe.exe'
$env:AMCP_REQUIRE_FFMPEG='true'
node --test dist/tests/private-media.test.js
```

All seven tests passed with zero skips, including actual image/video conversion,
dimension/placement checks and malformed input rejection. This closes the prior
local FFmpeg availability gap. It is a Windows FFmpeg 9.0.2 test, not a Docker or
Ubuntu image test. The binary is a portable local testing tool, not a new shipped
dependency or a system installation. No global PATH was changed.

The [FFmpeg download page](https://ffmpeg.org/download.html) links the
[Gyan Windows builds](https://www.gyan.dev/ffmpeg/builds/). The exact 9.0.2 essentials
archive was fetched over HTTPS and matched its [published checksum](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip.sha256):
`60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba`.
Only ffmpeg, ffprobe, LICENSE and README were extracted inside `.runtime`.
The archive/tool files are excluded from Git and public release assembly.

## Remaining work and rollout

The action denominator remains 3241. This batch changes four routes from blocked
to reviewed-family: 427 reviewed-family and 890 blocked writes. It does not change
91 unmapped, 27 unqualified reads, eight input-dependent, four retired/provider-
unsupported, 1704 native-read, 74 local-workflow or 16 media-workflow actions.
These are route-family counts, not proof that every payload variant executes.

The separate vendor denominator remains 1208 with 454 unmapped. The September 20
roadmap R2–R12 continues; the new remaining-action CSV supersedes its old counts.
Live account/app permissions, provider eligibility, quotas, mutable payload
acceptance, hosted CI, container smoke, deployment and restore remain unverified.
Hostinger/.shop delegation remains an external investigation, not a code fix.

Deploy through the existing Codex-branch review/release process. No database
migration or settings change is needed. Fresh portfolio prepares begin using the
new contract; old binaries will refuse that new family after rollback. Retain
completed/uncertain idempotency receipts and queued verification jobs; never clear
them to resubmit. Existing bidding-event reviews remain comparable because the
query correction changes ordering, not projected state. Review any exact-request
policy refusal rather than removing safeguards.
