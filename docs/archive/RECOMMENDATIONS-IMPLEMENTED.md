# Recommendations: implementation and acceptance

**Archived on 2026-10-22** (DOC-03, owner decision P12): kept as it was written, with links to current addresses.
For what AMCP does today see [current readiness](../CURRENT-READINESS.md) and the
[connected product workflows](../PRODUCT-WORKFLOWS.md).

This release implements the attached account/MCP recommendations and Reporting Overview. The evidence is automated checks and synthetic browser QA, not certification of live provider acceptance or production deployment.

| Area | Implemented |
|---|---|
| Owner and registration | Verified-email migration preserving the administrator workspace; verify-before-password signup, resend, recovery and explicit social linking |
| Delivery | Encrypted durable email queue with bounded retry, idempotency and owner diagnostics |
| People/workspaces | Owner/Admin/Operator/Viewer memberships, invites, switching, revocation |
| MFA/passwords | TOTP, one-use recovery codes, stronger bounded scrypt, session/MCP/account-version revocation |
| Campaign preflight | All-step compilation/grants before execution; account reads, media preparation, Meta Page/Instagram/pixel prerequisites, deferred-ID checks |
| Recipes | Paused Meta website-traffic/image, Google Search and Microsoft Search hierarchies from business inputs; optional native schedules and explicit regulatory declarations |
| Discovery/recovery | Per-account execution prerequisites; correct unsubmitted failed/preflight-blocked inputs, retain verified predecessors, never duplicate unknown/submitted creates |
| Owner policies | Activation/deletion controls, budget caps, percentage and cumulative daily requested increases; unknown money mappings fail closed |
| Background work | Durable reports/media/exports, progress, cancellation, retry timing, leases and completion/delivery status |
| Reporting/Sheets | Multiple platforms/accounts/objectives, native/common/custom metrics, currency-safe summaries, advisory decisions, CSV, scoped Sheets OAuth and scheduled refresh |
| Media | Encrypted chunk staging, default 128 MiB bound, Google resumable upload, placement inspection, asynchronous execution and fresh reuse checks |
| MCP output | Output schemas, structuredContent, consistent errors, missing-input and next-action guidance |
| Operations | Owner health/expiry/jobs/mail/API version/backup visibility, quotas, retention and encrypted restore verification |

## Explicit limits

- Real email delivery, identity-provider approval, Sheets OAuth and persistence require configuration and live acceptance. This implementation's tests sent no real inbox messages, Sheet exports or ad mutations.
- MFA uses TOTP, not passkeys. Recovery codes must be stored privately.
- Recipes cover three specified campaign types. Other objectives/platforms, regulated Meta categories and Microsoft geographical criteria still require qualified native steps or provider configuration before activation. Preflight does not certify landing-page policy, pixel event delivery or vendor approval.
- A request that reached the provider is not automatically resubmitted, even if an error could be a definitive rejection. Reconcile retained receipts/resources first.
- Metric availability depends on platform, version, objective and breakdown. The Overview includes eleven report/context adapters; [coverage](../REPORTING-OVERVIEW.md) names unsupported adapters. Metrics are never fabricated.
- Media inspection checks AMCP geometry/codec presets, not all provider rules. FFmpeg/ffprobe are required locally; Docker and CI install them. Encrypted staging is chunked, while transfers still use bounded buffers: configure limits to fit RAM. Google video transfer is resumable; other protocols retain their own limits.
- Completion is visible through status/polling and delivery history. No unsolicited email/webhook job-completion service is included; email delivery is for account messages.
- Shared throttling and refresh locks coordinate processes on the same SQLite database. This is a persistent-volume, single-database deployment, not a multi-region database architecture.

## Operator setup

1. Preserve MIRROR_MASTER_KEY and the persistent MIRROR_DB. Take a backup before upgrading.
2. Configure Resend and social clients using [account setup](../USER-ACCOUNTS.md). Claim the owner account and enable MFA.
3. Enable Drive/Sheets APIs and configure Sheets OAuth. Connect sources/destination and keep a worker running.
4. Set objective targets and conversion lag. Reconcile provider totals and conversion definitions for a fixed period.
5. Set spending caps and optional report retention in owner Settings. Monetary caps use native API units and constrain requested changes, not provider billing.
6. Run `npm run admin -- backup-encrypted <new-file>`, then `npm run admin -- backup-verify <file>`. Keep an off-host copy with the master key separately. Verification restores a disposable copy, checking SQLite integrity, audit chain and credential decryption without overwriting the running database.

Run npm run check and the website JavaScript syntax checks before release. CI also requires real FFmpeg conversion and container smoke checks. Production credentials, deployment and live qualification remain separate from these local checks.
