---
status: record
tier: engineering
---

# Criteo asynchronous report contracts — 2026-09-24

Base revision: `1cfc82e74982445105d0f5381b244382f07ea58c`, branch
`Codex-branch`, remote `https://github.com/magdyezy1/AMCP.git`. Implementation
checkout: `C:/Users/abdom/Downloads/AMCP Final With Claude recos - Copy/implementation-Codex-branch`.
The parent development directory and historical release checkout are separate.
No live provider request, ad mutation, credential/permission change, production
deployment, DNS change or message to another person was performed in this batch.

## Confirmed gap and implemented workflow

The three advertised DSP report creation actions were unmapped. The captured
names omit `V2`, while the pinned official OpenAPI operation IDs include it.
Replaying the base revision's vendor routes through the unchanged delegated
compiler reproduces `DELEGATED_ROUTE_UNAVAILABLE` for all three. This is a P2
capability gap: these reporting workflows cannot start, while other providers'
existing reports are unaffected. Baseline evidence is retained locally at
`.runtime/contract-completion-20260924/criteo-baseline.json`.

Exact aliases now bind accounts, campaigns and line-items to their corresponding
`GenerateAsync*ReportV2` endpoints. They share a reviewed report-job family,
not a general permission for every POST or every Criteo report. Submission uses
the existing five-minute frozen review, actor/account grants, deployment controls
and persistent idempotency. It makes one provider attempt. The submitted report
changes no advertising budget or delivery configuration; reporting fields named
spend/bid/budget do not require spending confirmation.

Account reports select one account. Campaign/line reports select up to 50 exact
IDs after account-scoped discovery. Both preparation and execution freshly read
the demand account's currency/timezone and selected parent identities. IDs and
meaningful identity changes remain protected; changing spend/name telemetry is
excluded. Account reports require Accounts_Read plus Analytics_Read; scoped
campaign/line reports also require Campaign_Read. Provider permission and AMCP
account grants remain independent. Credentials/grants are rechecked around reads.

Only a retained successful original review/claim can authorize the returned UUID.
The binding is partitioned by tenant, connection and provider job, with account,
definition, currency and target parents retained. Different-account or different-
definition job-ID reuse is rejected. Status exposes no provider trace or private
URLs. Metadata bindings last seven days and are pruned on status observation;
the provider's `expiresAt` still controls output availability. Original review,
claim and audit retention follows the existing repository policy.

Clients resume pending jobs with the original verification call; the suggested
interval is six seconds for Criteo. Output GETs fetch current status, retrieve
bounded bytes using the existing transport/pacing/circuit controls, then reread
status. A shared monotonic deadline is checked around each read and bounds the
transport abort timer and retries, so an expired retrieval cannot start the next
provider request. No remote URL is accepted or followed. Native MD5 checks the original
bytes for transfer consistency (it is not an authentication mechanism); HTTPS,
the original claim and current grants establish authority. Count, size, columns,
exact account/date/entity IDs, duplicate dimension grains and status stability
are checked before returning complete output. JSON and compact JSON preserve
native values and nulls. Source-aware Node 24 JSON parsing preserves unsafe int64
numeric tokens as strings. No FX conversion, sums or ratio recomputation occurs.

## Scope and compatibility

Three actions move from unmapped to reviewed-family; the two existing status/
output actions gain this scoped job workflow. Current totals: 3241 actions,
430 reviewed-family, 890 blocked writes, 88 unmapped, 27 unqualified reads,
8 input-dependent, 4 provider-unsupported, 1704 native reads, 74 local workflows,
16 media workflows. Criteo specifically has 108 mapped actions: 12 reviewed,
51 native reads and 45 blocked writes. Mapping every pinned method does not
qualify every operation or field.

The separate vendor inventory has 1208 methods and 451 without action mappings,
down from 454. All 108 methods in the pinned Criteo document now have mappings;
other providers and unqualified Criteo writes remain in the denominator.

No runtime dependency, global tool installation, database migration, new queue
or new service is introduced. The raw-byte integrity metadata is internal to
qualified Criteo output reads. Other provider parsing is unchanged. Existing
manually provisioned global report-ID bindings cannot bypass the original-review
requirement; externally created jobs need a separately designed import contract.

This family qualifies explicit custom dimensions/metrics in `json` or
`json-compact`, with one account, 31 inclusive days for account scope and 100 for
campaign/line scope. Outputs are bounded to 25000 rows and 8 MiB, below the native
100000-row truncation boundary, with a 60-second monotonic retrieval deadline.
CSV/newline native formats, presets/aggregation hints, multi-account aggregation,
larger segmented outputs, revenue/SSP reports, website Criteo OAuth, dashboard
overview integration and the 2026.07 reporting redesign remain separate work.
Do not describe them as completed by this family. Current provider request/field
acceptance, quota/permission approval and live report reconciliation are unverified.

Rollback can disable this family or revert its commit without a schema rollback.
Retain reviews, claims and job bindings. An older binary cannot continue the new
workflow; never clear a claim or automatically recreate its job to work around it.
Native GET retries may repeat retrieval of a still-valid job. Lost/uncertain POSTs
never receive an automatic replacement submission.

## Files and evidence coverage

| Files | Review method and evidence |
| --- | --- |
| `src/criteo-report-jobs.ts` | Manual workflow, payload, scope, state, receipt, persistence and download review; focused end-to-end/negative fixtures |
| `src/transport.ts`, `src/types.ts`, `src/service.ts`, `src/scope.ts` | Manual boundary/delta review; lossless JSON, checked bytes, current credentials, exact job authorization and scoped result fixtures; existing transport/scope suite |
| `src/write-review.ts`, `src/write-verification.ts`, `src/preflight.ts`, `src/write-impact.ts`, `src/reviewed-routes.ts` | Manual integration/delta review; original review/key, concurrency, restart, owner zero-spend policy, native bypass and generated next-call tests |
| `tools/fetch-vendor-specs.mjs` | Manual exact-alias change; deterministic vendor-route generation and baseline unmapped reproduction |
| `tests/criteo-report-jobs.test.ts` | Manual fixture review; six complete account/campaign/line × JSON/compact journeys plus adverse cases; assertions retain initial failures |
| Criteo guidance, executable examples, provider/action registries and guidance coverage | Manually checked field names, nested MCP controls, actual next calls, scope, limits, recovery, live boundaries and migration warning; mechanical example/coverage checks |
| Generated vendor/action/method/contract outputs | Mechanically regenerated and checked; not manually audited line by line |
| Pinned Criteo OpenAPI | Relevant report/account/campaign/line/status/output schemas manually examined; all report enums/filters checked mechanically against it; full file is vendor material, not a manual line audit |

## Verification

Node 24.19.0, npm 11.17.0, Windows PowerShell. Fresh sanitized `.release`
candidates replace the historical private live-read fixture with `[]`; the
original private file is never read. Offline dependency installs use
`npm.cmd ci --offline --ignore-scripts --cache ../../.runtime/npm-cache`.

Initial TypeScript builds caught narrowing annotations and a test cleanup helper
argument; both were corrected before runtime validation. Candidate A's first
test command preceded its build and reported missing `dist/tests`; the subsequent
build/test is retained. A then had 7 pass / 9 fail: draft examples incorrectly put
delegated controls at the outer MCP level. B had 15 pass / 1 fail: the bypass
fixture supplied a control absent from the captured operation schema. C had
11 pass / 6 fail after strengthening next-call testing: the fixture accessed
`resources` instead of the real `verified_resources` response. No assertion was
weakened to accept a failed output; negative cases now assert their actual error
codes. D passes 17 / 17 with zero skipped tests. A–C do not establish output
qualification for the paths that had not reached their intended checks.

Candidate E includes final guidance, registry, report limits and poll-interval
changes. Its full run passed 1455 main tests and failed three stale delegated
route assertions, with zero skipped tests. The old assertions expected 339/338
mapped/JSON routes and still expected account reports to be unmapped. They now
require exactly 342/341 routes, reject an incomplete mapped report definition,
and retain actionable missing-route and special-transport checks. Candidate F
passed the complete suite after this test-only correction: 1458 main tests and
four capture tests, with zero failures or skips; all following stages passed.
Final manual review found that the composite retrieval deadline was checked only
after all three reads. Candidate G adds a shared transport deadline and checks
between reads; 28 focused Criteo/transport tests pass, including two new deadline
regressions. Candidate H narrows the timeout override strictly to qualified
Criteo reads, preserving other-provider behavior, and reruns the full suite.
Its final result is recorded in the verification checkpoint below. The command uses real FFmpeg/ffprobe 9.0.2 with
`AMCP_REQUIRE_FFMPEG=true`, whose portable publisher-verified binaries were
prepared in the prior portfolio batch. The binaries are not shipped or committed.

Focused command: `npm.cmd run build` then
`node --test dist/tests/criteo-report-jobs.test.js`. Full command: `npm.cmd run check`
with `AMCP_SCHEMA_PYTHON` pointing at the existing bundled Python and
`AMCP_FFMPEG_PATH` / `AMCP_FFPROBE_PATH` pointing into
`.runtime/contract-completion-20260924/ffmpeg-9.0.2/`.
Logs: A–D/G `criteo-focused.log` and E/F/H `criteo-check.log`, each retained
under its `.release/criteo-reports-20260924-<letter>` directory.
The [machine-readable verification checkpoint](CRITEO-REPORTS-VERIFICATION-2026-09-24.json)
retains every candidate tree hash, file count, log hash, exact command, failure and
result. Final candidate H has 563 files and source tree hash
`ff5e4cfe7b239f84475ebfb0d5bf71ddebaf1431f8228d59cdf7f776a3f6ccb6`;
full log SHA256 `787be5288e73c1e8b010e2bb096bd5a04b21121ffec041ee9ae4b429510c3c55`.
`node deploy/check-railway.mjs` also passes locally.

Docker/container execution, Linux execution, GitHub-hosted CI and deployment/live
provider validation are not established by these Windows synthetic checks. The
GitHub connector returned 404 when checking the preceding pushed commit
`1cfc82e74982445105d0f5381b244382f07ea58c`; no stored credentials were collected
to bypass this connector limitation.

## Official sources and version boundary

Accessed 2026-09-24. These are primary documentation, not live account evidence.

- [Pinned OpenAPI 2026-01](https://api.criteo.com/2026-01/retailmedia/open-api-specifications.json): method/path, native body enums, status shape, account/parent lists and OAuth scopes. Repository capture date 2026-09-04; canonical document SHA256 `8e6782adc10a3f295eff7d12329f1f766aa7c06f6018de74048645d7bdb72ab1`.
- [2026.01 overview](https://developers.criteo.com/retail-media/v2026.01/docs/demand-side-analytics-overview): 31/100-day ranges, 100000-row cap, delayed activity/attribution, expiry and per-app/account rate limits. Same-day completeness is not asserted.
- [2026.01 workflow](https://developers.criteo.com/retail-media/v2026.01/docs/demand-side-analytics-get-started): inclusive date-only inputs, up to 50 IDs, status/MD5 and compact output, attribution and win-rate prerequisites.
- [2026.01 metrics](https://developers.criteo.com/retail-media/v2026.01/docs/metrics-and-dimensions): parent/account identity dimensions, video grain, native spending and attribution definitions.
- [2026.01 release](https://developers.criteo.com/retail-media/changelog/version-202601-release-notes): new account reports and their five-account native maximum. AMCP deliberately scopes each job to one account.
- [2026.07 migration](https://developers.criteo.com/retail-media/docs/dsp-analytics-migration-guide): the newer API replaces these endpoints, moves scope into filters, and changes limits. The documentation says 2026.01 endpoints retain their version's behavior. AMCP does not silently upgrade them.

Documentation uncertainty: older guide examples use `timeZone`; the pinned
OpenAPI and release samples use `timezone`. AMCP freezes the latter spelling.
This is a recorded wire-qualification requirement, not a claim that both work.
The unversioned overview now describes 2026.07 and its 10-million-row limit;
using that limit for the pinned 2026.01 adapter would be incorrect. A former
unversioned reference URL returned 404 during this pass; the versioned guide,
release notes and pinned OpenAPI supply the retained evidence.

## Next engineering tickets

1. **Criteo live qualification (P1 before enabling in a live client workflow;
   access-dependent, S–M):** using an explicitly authorized test account, run
   the three report types in both formats represented here, verify timezone spelling, native
   JSON/compact shape, numeric IDs, checksum/count, scopes and actual rate limits.
   Reconcile known totals with Commerce Max, including an empty interval. No live
   permission was provided for this implementation pass.
2. **2026.07 report adapter (P2, M):** pin its official OpenAPI and migration
   evidence, add explicit versioned contracts for performance/missed opportunity/
   attributed transaction reports, keep existing reviews on 2026.01, and test
   old/new definitions independently. Rollback must retain original claims/jobs.
3. **Additional formats and larger reports (P2, M):** CSV/newline need bounded
   encoding/type parsing, lossless IDs, native quoting and checksums; segmented
   retrieval needs deterministic row offsets and explicit completeness. Do not
   raise byte/row bounds or silently sum non-additive metrics as a substitute.
4. **Criteo product integration (P2, M–L):** approved OAuth/discovery, connection
   selection and report-definition/dashboard scheduling interfaces. Reuse current
   per-client destinations and leases. Acceptance includes two independent
   client reports, revoked access, provider quota delay and failed delivery UI.
5. Continue the exact remaining action inventory and the earlier R2–R12 tickets.
   This batch is a bounded family completion, not completion of every provider.
