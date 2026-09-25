# AMCP implementation handoff — 2026-09-25

The user explicitly requested **finish the current work and hand off**. The current
batch is LinkedIn saved-audience templates; do not infer that every remaining
action is implemented. Resume broader work only when requested. No background
continuation or automation was created.

## Checkout and operating boundaries

- Worktree: `C:/Users/abdom/Downloads/AMCP Final With Claude recos - Copy/implementation-Codex-branch`.
- Remote: `https://github.com/magdyezy1/AMCP.git`; only **Codex-branch** may be edited
  or pushed. No main/other branch work and no force push.
- Parent development directory and historical `.release/AMCP` checkout are separate
  and were not modified. Use the exact worktree above, not the desktop default cwd.
- Current batch base is `5ea83ed2b5eddda004e464625a28f82f502b517b`. Resolve its final
  commit with `git log -1 -- src/linkedin-audience-templates.ts` and compare HEAD,
  working tree and remote before resuming. Use `git -c safe.directory=<worktree>`.
- Do not read root `.mirror/RESULTS/live-read-samples.json`, private credentials,
  .env secrets or live databases. Full checks run only in a **fresh sanitized
  release candidate**, assembled by the existing release tool. That tool replaces
  historical live samples with an empty fixture without reading their contents.
- No live advertising mutations, credential/grant changes, provider applications,
  messages, production/deployment/Railway/DNS changes are authorized here. Public
  official research and local synthetic tests were used. The user says the website
  works; do not reopen the old DNS incident as an assumed outage.
- Do not reset usage credits, update memory, create goals/automations/threads/PRs,
  or delegate to agents unless separately requested. Batch ordinary commits/pushes
  only after appropriate qualification; earlier authorization does not require a
  separate permission question for those Codex-branch pushes.

## Finished current batch

Four saved-audience create/update/single-delete/batch-delete routes now have exact
review contracts, native request validation, account and private-segment ownership,
complete two-pass collection reads, meaningful state projections, owner deletion
controls, strict receipts, original-key recovery and fresh final-state verification.
The contract does not apply targeting to campaigns or activate advertising.

Implementation: [LinkedIn template report](LINKEDIN-TEMPLATES-2026-09-25.md).
Code: `src/linkedin-audience-templates.ts`; integration in review/scope/verification,
transport deadline and action/provider descriptors. Tests:
`tests/linkedin-audience-templates.test.mjs` (39 new tests). Executable first-party
guidance: `Skills/amcp-campaign-builder/examples/linkedin-audience-templates.json`,
central `examples/contracts.json` index and `references/linkedin-x.md`.
Native evidence provenance: `tests/fixtures/linkedin-audience-template-evidence.json`.

Initial failures are retained, including blocked-route baseline, one TypeScript
narrowing error, zero-count empty-page handling and a missing central example-index
entry. The latter two were corrected without weakening the assertions. All 47
affected template/guidance tests pass; the wider first compatibility run had
224/225 pass before the index correction. Fresh full qualification is the final
gate. Candidate J passed **2052 main and four capture tests**, no failures/skips,
with FFmpeg required and Railway compatibility passing. Exact commands, candidate
hashes, original failure logs and staged-source comparison are in
[LINKEDIN-TEMPLATES-VERIFICATION-2026-09-25.json](LINKEDIN-TEMPLATES-VERIFICATION-2026-09-25.json).
Candidate: `.release/continuation-20260925-j`, 662 files,
source hash `9985375a9389fe3c59245c5e224aceb0853b368730c4683151f1fa774f5c867d`.

Live acceptance is unverified. In particular, the saved-template documentation
omits paging in a simplified example; the actual finder must return the complete
REST.li metadata required by this contract. Unknown/foreign/incomplete collections
remain blocked. Shared/ownerless private segments, unknown facets and nested patch
variants are not silently covered by the new family.

## Earlier completed checkpoints to preserve

| Commit | Delivered work | Local qualification |
|---|---|---|
| 90d5682 | Manual Google conversion definitions, nested Snapchat updates, scoped X async analytics; LinkedIn/Sheets authority and accepted-receipt fixes | Candidate D: 1899 main + four capture, required FFmpeg, zero failures/skips |
| 7668016 | X audience estimates, explicit unsupported Google customizer alias, authenticated offline backup/isolated restore | Candidate F: 1936 + four, zero failures/skips |
| a289304 | Resume only confirmed LinkedIn upload parts under the original review; encrypted receipts and renewable/fenced media leases | Candidate H: 1979 + four, including process-crash/SQLite recovery |
| 9d29b02 | X atomic targeting Create/Delete batches on paused line items, complete membership and private-reference verification | Candidate I: 2013 + four, zero failures/skips |
| 5ea83ed | Supported Node 24 GitHub action SHA pins and Ubuntu 24.04 runner family | Exact GitHub run #102 passed |

Follow the linked implementation/verification records in
[CONTRACT-COMPLETION-PROGRESS.md](CONTRACT-COMPLETION-PROGRESS.md) for earlier work.
Old totals are historical, not a substitute for current qualification. Reporting
already supports separate reports/templates/client/account selections, edit/delete,
daily/weekly/monthly periods and independently scheduled Sheets destinations. The
X circuit-breaker correction is already implemented; preserve its negative tests.

## CI and release evidence

GitHub [run #102](https://github.com/magdyezy1/AMCP/actions/runs/36117668608), job
`108015461743`, passed exact commit `5ea83ed2b5eddda004e464625a28f82f502b517b`:
21m 49s total, full required-FFmpeg suite 10m 9s, Docker build 10m 59s, smoke and
evidence upload successful. Run #101 also passed exact a289304. Details and action
provenance: [CI runtime record](CI-RUNTIME-2026-09-25.md). These runs do not certify
later source changes. A new push needs its own exact-commit GitHub result.

The handoff commit's post-push CI must be checked by exact SHA on resume; it is
not claimed green by the local result. No further feature work is running after
this handoff. Do not rerun the whole suite merely because the next session starts:
first compare current source with the recorded qualified candidate and CI result.

This Windows environment has Node 24.19.0/npm 11.17.0. Use npm.cmd. Portable FFmpeg
9.0.2 is in `.runtime/contract-completion-20260924/ffmpeg-9.0.2/` under the worktree.
Bundled Python is `C:/Users/abdom/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`.
There is no local Docker or gh; GitHub job UI supplies exact Linux/container
evidence. Do not convert an unavailable local Docker run into a claimed pass.

Requalification procedure, using a new unused candidate name:

1. Check branch/status; read applicable instructions. Stage only intended changes.
2. Set Git safe.directory for the assembler subprocess and run
   `node tools/prepare-public-release.mjs .release/<new-name>` from the worktree.
3. In that candidate, run `npm.cmd ci --offline --ignore-scripts --cache ../../.runtime/npm-cache`.
4. Set `AMCP_REQUIRE_FFMPEG=true`, `AMCP_SCHEMA_PYTHON`, `AMCP_FFMPEG_PATH` and
   `AMCP_FFPROBE_PATH` to the explicit binaries above. Run `npm.cmd run check`,
   retaining exit code and complete log, then `node deploy/check-railway.mjs`.
5. Compare staged code/test/guidance with the candidate. The local checkpoint helper
   `.runtime/contract-completion-20260924/checkpoint-verification.mjs` records hashes,
   failures and LF-normalized index comparison. Generated empty live samples and
   evolving docs/implementation audit records are explicitly excluded from that
   comparison. Do not edit assembled candidates or overwrite failed logs.
6. Commit/push only Codex-branch, then check the exact run SHA and container smoke.
   Keep uncertain provider claims and receipts through rollback; no deletion or replay.

## Exact remaining inventory

The current machine inventory contains **3241 captured actions**, of which
458 have a reviewed-write family, 1705 are native reads, 83 are local workflows,
and 16 are media workflows. Each still has exact input/permission/live limits.
The **979 remaining rows** are in [REMAINING-ACTIONS-2026-09-25.csv](REMAINING-ACTIONS-2026-09-25.csv):

| Category | Rows | Meaning |
|---|---:|---|
| blocked_write | 864 | Mapped write lacks a qualified review contract; must not bypass review |
| unmapped | 79 | Advertised/delegated action lacks a native implementation |
| unqualified_read | 23 | Read-like route lacks complete scoped execution/response evidence |
| adapter_requires_input | 8 | Payload-dependent semantics need a qualified contract |
| provider_unsupported | 5 | Explicitly retired/nonexistent native behavior; not implementable by allowlisting |

Remaining blocked writes by platform: TikTok 219, Meta 136, LinkedIn 119,
Google Ads 108, Snapchat 98, X 67, DV360 62, Criteo 43, Business Profile 12.
This is an implementation backlog, **not all an external-credentials blocker**.
The independent pinned-vendor denominator has 1208 methods and 451 unmapped
methods. It overlaps the captured inventory; never add the counts. Amazon coverage
is unknown, and zero remaining captured rows on Apple/Microsoft/Reddit does not
establish complete provider coverage. Both full coverage files remain canonical.

## Next implementable tickets, with acceptance gates

| Priority / effort | Bounded next task | Acceptance and dependencies |
|---|---|---|
| P2 / M | LinkedIn dynamic UTM account/campaign contracts | Three captured routes have public research only. Prove native GET/404 semantics, account fallback inheritance, exact native idempotency token/update/delete receipts; compare effective URL impact, ownership and resulting state. No implementation yet. Preserve existing ad/creative behavior. |
| P2 / M | GA4/Search Console/Business Profile delegated OAuth start/exchange/refresh | Nine advertised operations remain unmapped. Reuse existing website state/PKCE/session services with exact identity, consent, replay/resource/client binding, original-grant refresh races and recovery tests. Business Profile has no website OAuth/discovery adapter yet; its MCP metadata sync exists. Live login/approval is a separate gate. |
| P1 / M per family | Prioritize real campaign blockers among remaining scoped writes | For each family: official versioned contract, no-egress inspect, account/dependency reads, native units/policy, immutable review, partial/lost receipt, read-back, concurrency/restart, executable example, regenerated inventories and full qualification. Never add a blanket allowlist. |
| P2 / M-L | Remaining async report/task families | Keep source identity, complete pagination/results and explicit partial/error state, bounded polling/download, leases and resume. Several X/Criteo/TikTok paths already exist; select only still-unqualified inventory rows. X analytics cancellation has no verified native contract; do not invent DELETE behavior. |
| P2 / L | Google draft/experiment graph and promotion recovery | Pin original IDs, copied graph, proposed state, budget effect and operation ownership; negative grant, partial LRO, restart and exact final-state tests. No implicit activation. Preserve persisted readers if job schema changes. |
| P2 / M-L | Pinned Microsoft/Apple/Reddit vendor-method expansion | Qualify exact native schemas/receipts one family at a time. Independent denominator prevents captured-catalog totals hiding missing provider methods. Existing CSV/Sheets/OAuth/review behavior must stay green. |
| P2 / M | Unknown Commerce/Amazon/Adjust delegated workflows | Public product/version/auth/request/response research before mapping. Adjust native reporting is implemented; it does not imply app automation, spend ingestion or a normalized reporting dashboard. Private specifications/entitlements may need external access. |
| P2 / M | Finish UI/backend/CSV/Sheets/recovery reconciliation | Reuse the reporting fixture across surfaces, preserving IDs, timezone, currencies, missing metrics, partial-source status and independent schedules. Finish manual deletion confirmation and failed-delivery/reconnect journeys; do not rebuild working reporting to solve a browser-tool issue. |
| P2 / S-M | Guidance provenance and family example maintenance | New template examples are tested through the lifecycle. Extend exact executable example/provenance coverage to earlier families and unsupported variants, retaining ownership/version metadata. Generated schemas do not prove native success. |
| P1 / M | Staging restoration and deployed operating checks | Offline encrypted backup/isolated restore is implemented. Authorized disposable deployment must prove volume persistence, rotation/restore/rollback, worker recovery, capacity and alerting. Production access is not supplied/authorized by this handoff. |

Manager/partner/cross-account approvals, recommendation auto-apply subscriptions,
PII/offline uploads and customer-data processing require their own affected-account
policies, consent and recovery contracts. Some also require owner/business decisions
and provider approvals. They remain separate from ordinary resource CRUD.
Google campaign call-bid-modifier creation has an unresolved output-only campaign
field contradiction; exact existing-resource update/remove are already qualified.
TikTok Smart Text has request research without sufficient response evidence.

## Browser and end-to-end evidence limits

Synthetic browser reporting checks created separate client/account reports and
independent Sheets destinations/schedules; daily/weekly/monthly configuration,
CSV download, typed synthetic Sheets delivery and template identity clearing were
observed. A later fixture also edited a report and saved its template.

Manual final deletion remains unverified: the automation API stalled at native
window.confirm in both IAB and Chrome. Correct named confirmation was visible;
backend revision/ownership/deletion regressions pass. This demonstrates a tool
limitation, not a proven deletion product defect. Reuse a supported browser path
or make a separately justified accessible dialog improvement with keyboard/focus,
cancel-default, revision/selection-race and deletion tests. The fixture server on
loopback 43287 was stopped; it is not a production service. A stale agent-created
fixture tab may remain at its confirmation; do not close unrelated user tabs.

Broader source/audit coverage and live readiness are distinct. Passing tests and
ledger classification do not certify all identity/OAuth/security, production UX,
media/provider approval, privacy operations or scale claims from the original audit.
Use the older audit/handoff deliverables to retain unreviewed workflow boundaries,
and the current generated inventories to avoid implementing already completed rows.

## Resume discipline

Before editing, read this handoff, the latest qualification JSON, current Git status
and the exact CI run. Keep successful behavior and regression assertions. Preserve
every failing log, distinguish fixture errors from production defects, and keep
documented/synthetic/live evidence separate. Update this checkpoint when the user
resumes and a new bounded batch finishes; do not state full completion while the
remaining-action or live qualification inventories are nonempty.
