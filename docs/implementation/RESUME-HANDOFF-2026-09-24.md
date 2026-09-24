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
production files are identical. Public DNS resolution remains an external issue: assigned Cloudflare
authorities and routed HTTPS health work, while tested recursive resolvers and one
.shop authority return NXDOMAIN. Await the user's Hostinger status/delegation
information; do not invent a hold or make unrequested production DNS changes.

## Remaining implementation — not complete

The latest action check still matches the September 20 inventory: 3241 actions,
423 reviewed-family, 894 blocked writes, 91 unmapped, 27 unqualified reads, eight
input-dependent and four provider-unsupported. The latter four were retired by the
provider. The separate vendor denominator remains 1208 pinned methods, including
454 unmapped; it overlaps rather than adding directly to the action denominator.
Neither reporting nor the Meta guard adds a new native action family.

Continue the exact rows in [remaining actions](REMAINING-ACTIONS-2026-09-20.csv),
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
FFmpeg/ffprobe/Docker were unavailable locally. Required FFmpeg mode, container
smoke, deployment, live permissions/quotas/provider payload acceptance and restore
are not qualified by these results. The GitHub connector returned 404 for Actions;
Git push and ref verification worked with network-enabled execution. Do not obtain
or print stored credentials to work around connector access.

Each family needs current official evidence, positive/negative fixtures, scoped
reads, reviewed/policy-controlled execution, meaningful state projection and
verified outcomes, guidance, regenerated contracts, a sanitized check and a push
only to Codex-branch. Preserve initial failures and receipts. For report rollback,
pause monthly schedules before running a binary that cannot interpret them.
For Meta, preparing new reviews is appropriate only for unsubmitted work; retained
uncertain/completed receipts remain authoritative and must never be cleared.
