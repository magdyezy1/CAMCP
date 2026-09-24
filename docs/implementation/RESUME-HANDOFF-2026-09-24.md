# AMCP continuation checkpoint — 2026-09-24

Use this checkpoint before the older September 20 handoff. Only `Codex-branch`
is authorized for changes/pushes. The implementation checkout is
`C:/Users/abdom/Downloads/AMCP Final With Claude recos - Copy/implementation-Codex-branch`;
the parent development tree and historical `.release/AMCP` remain separate.
No live ad mutations, provider permission changes, production configuration changes
or deployment operations were performed by these batches. A later DNS incident
was investigated with public DNS/RDAP and an unauthenticated HTTPS health request.

## Completed product work

Reporting commit `0d8204dfce2fc20e434a8f4ebd2a9a0c4f209d6e` was pushed and verified.
It provides independent client reports/templates, new/duplicate/select controls,
revision-checked edits/deletion, account selection, separate Sheets destinations,
daily/weekly/monthly native periods, independent delivery schedules and monthly
calendar handling. It repairs X terminal-error circuit poisoning, stale analytics
placements, null columns, provider-reset handling and resumable completed batches.

See [reporting evidence](REPORTING-2026-09-24-PROGRESS.md) and
[machine checkpoint](VERIFICATION-CHECKPOINT-2026-09-24.json). Local browser proof
includes two clients/accounts/Sheets URLs, weekly/monthly schedule edits, daily
results, CSV download, synthetic Sheets delivery and mobile/keyboard behavior.
The browser tab and fixture server were closed. No deployed/live claim is made.

R1's Meta direct-creative identity mismatch now has both failing baseline evidence
and a correction. See [Meta ownership evidence](META-CREATIVE-OWNERSHIP-2026-09-24.md)
for final verification status. `meta-creative-state.ts` runs on prepare and execute,
reuses the existing private Page-token reader, checks ownership/current authority,
and projects stable review fields. The six supported top-level create fields are
explicit. Other native source/actor overrides and advanced modes need their own
contracts; they cannot bypass this guard. Find the follow-on commit with
`git log -1 -- src/meta-creative-state.ts`; never assume the reporting commit also
contains that follow-on. No database migration or new runtime dependency.

The later [HTTP startup/DNS incident](STARTUP-DNS-2026-09-24.md) fixes misleading
stderr/localhost startup logs and ignored Express 5 bind errors. Combined full
check: 1417 main tests pass, zero fail, one optional FFmpeg skip; four capture
tests pass. Final test-only safe-port adjustment passes 15 compatibility tests;
production files are identical. Current site availability is corroborated by the user and fresh TLS-verified
HTTP 200 responses from / and /healthz at 19:17 UTC. Independent public DNS
resolvers still return NXDOMAIN; keep that discrepancy unresolved without
describing the application as down or requiring an unproven registrar repair.
See the incident record for historical observations and the latest public evidence.
No production DNS changes were made.

## Remaining implementation — not complete

The next implementation pass added client-owned portfolio bidding strategies and
fixed the existing bidding-event GAQL sortability defect. See
[portfolio verification and rollout](PORTFOLIO-AND-GAQL-2026-09-24.md).
Candidate C passed the full check (1440 main / four capture tests; zero failures,
one optional FFmpeg skip); the required seven-test media run then passed with real
FFmpeg 9.0.2 and zero skips. Portable verified binaries now exist in
`.runtime/contract-completion-20260924/ffmpeg-9.0.2/` for local reuse. They are not
installed globally or included in Git. Docker and live validation remain outstanding.

The latest action check supersedes the September 20 inventory: 3241 actions,
432 reviewed-family, 888 blocked writes, 88 unmapped, 27 unqualified reads, eight
input-dependent and four provider-unsupported. The latter four were retired by the
provider. The separate vendor denominator remains 1208 pinned methods, including
451 unmapped; it overlaps rather than adding directly to the action denominator.
Reporting and the Meta guard added no new native action family; the portfolio
pass moves four native/legacy routes into one qualified reviewed family. The
[Criteo report batch](CRITEO-REPORTS-2026-09-24.md) adds three exact 2026.01 DSP
report creation contracts and scoped status/output recovery. It supplies native
JSON/compact outputs with checked bytes, checksum, count and account/date/entity
identities. Criteo website OAuth, dashboard integration, other formats, multi-
account aggregation, remaining writes and the 2026.07 redesign remain separate.
The updated remaining-action CSV has 1015 rows, including retired/unsupported
entries. Latest complete check and manifest are in the Criteo evidence report.

The [Criteo campaign batch](CRITEO-CAMPAIGNS-2026-09-24.md) adds standard auction
campaign create/update with complete PUT fields, stable scoped funding/line-item
reads, owner policies and durable verification. Candidate A passed 1481 main plus
four capture tests with required FFmpeg, zero failures/skips. Preferred campaigns,
retailer budgets, auto pacing, overrides and other Criteo writes remain unqualified.

Continue the exact rows in [remaining actions](REMAINING-ACTIONS-2026-09-24.csv),
checked against `contracts:actions:check`, and tickets R2–R12 in the
[earlier handoff](RESUME-HANDOFF-2026-09-20.md). Priorities:

1. Bounded, documented core write families with ownership, spend policy, immutable
   reviews, read-back and lost-response/restart evidence. Do not bulk-allowlist.
2. Scoped async reporting/preview jobs for Criteo/TikTok/Snapchat; delegated OAuth
   routes and remaining Google experiment/draft recovery.
3. Microsoft/Apple/Reddit vendor methods that are absent from the captured catalog;
   verify the actual wire protocol and supported variants before exposure.
4. Shared manager/partner approval, automatic recommendation changes and customer
   data upload require separate authority/consent/business rules. They remain
   blocked until those contracts are decided and implemented.
5. Adjust/Commerce/Amazon and unknown delegated actions still need exact provider
   product/version/auth specifications and possibly private entitlements/docs.
6. Meta new-story media ownership/eligibility, mutable post attachments beyond the
   current projection, partnership creatives and advanced source fields remain
   separate work; current owned-content fixtures do not establish them.
7. Continue broader identity/security/operations/UX audit follow-up from the earlier
   handoff. A complete action ledger is not a complete product audit or live test.

## Verification and operational boundary

Use fresh sanitized release candidates for full `npm run check`, never the root
historical `.mirror/RESULTS/live-read-samples.json`. Do not read that private file.
The assembler supplies an empty public live-evidence fixture. Root focused tests
are synthetic; retained logs are under `.runtime/reporting-20260924/`.

Node 24.19.0/npm 11.17.0/PowerShell. Offline install works with
`npm.cmd ci --offline --ignore-scripts --cache <implementation>/.runtime/npm-cache`.
Set `AMCP_SCHEMA_PYTHON` to the existing bundled Python path for generator checks.
FFmpeg/ffprobe were initially unavailable; the portable 9.0.2 paths above now pass
required media tests. Docker remains unavailable. Container smoke, deployment,
live permissions/quotas/provider payload acceptance and restore are not qualified
by these results. The GitHub connector returned 404 for Actions;
Git push and ref verification worked with network-enabled execution. Do not obtain
or print stored credentials to work around connector access.

Each family needs current official evidence, positive/negative fixtures, scoped
reads, reviewed/policy-controlled execution, meaningful state projection and
verified outcomes, guidance, regenerated contracts, a sanitized check and a push
only to Codex-branch. Preserve initial failures and receipts. For report rollback,
pause monthly schedules before running a binary that cannot interpret them.
For Meta, preparing new reviews is appropriate only for unsubmitted work; retained
uncertain/completed receipts remain authoritative and must never be cleared.
