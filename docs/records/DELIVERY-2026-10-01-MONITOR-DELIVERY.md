# Personal monitor email delivery — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `4a2b94b`. Implementation: `9d6be02`. Batch 61 completes B19's stated local delivery scope with an explicit email destination.

## Behavior

Each eligible signed-in person can enable notices for a particular monitor rule after reading its current version
and confirming. The only recipient is that person's existing verified account email. Viewers may manage their own
subscription; editing or acknowledging rules/incidents still requires operator authority. Administrator-door,
test and unowned connector identities cannot subscribe. No arbitrary address, webhook URL or third-party recipient
is accepted. Existing incidents are not backfilled, and no subscription is enabled by this release.

Future openings, reopenings and evidence-based resolutions enqueue a deterministic intent in the same transaction
as the incident. Repeated evidence does not create another notice. Email includes a generic status and an
authenticated incident link, with no client name, account number, metric value or report content. The website/MCP
history returns the current person's last 20 delivery records; it withholds recipient addresses, encrypted actor
bindings and provider responses. Links are navigation, not public report sharing or automatic authentication.

The subscription binds its rule version, recipient account/security version, email fingerprint and original
authority. Rule revision requires renewed confirmation. Opt-out and rule pause/revision cancel pending notices.
Recipient and rule-author authority, current account grants, original subscription generation, incident episode/state,
evidence freshness and retained source scope are checked again before every send/retry. Acknowledged attention is
withheld, snoozed attention is deferred, and obsolete opening/resolution events are cancelled. Re-enabling a
subscription creates a new generation; it does not transfer pending notices from the previous one.

## Delivery and recovery

The HTTP and standalone workers reuse the existing encrypted email outbox and configured Resend transport. The
standalone worker now uses the same configured public-origin fallbacks as HTTP, so Railway links do not silently
fall back to loopback when its public domain is available. Existing email sender/key/master-key configuration and
a public origin are still deployment prerequisites; no environment setting was read or changed during this work.

The original encrypted recipient/body and provider idempotency key remain fixed across transient network, 409,
429 and server-error retries. Five automatic attempts are allowed. A failed transient notice can be explicitly
recovered once using its exact displayed version, allowing at most ten attempts in total. Permanent rejections,
stale authority/source, expired, sent or cancelled notices cannot be recovered. Recovery never starts another
incident or sends to a replacement recipient. Reclaimed leases cannot exceed the attempt limit; a late response
cannot overwrite a cancellation or newer worker lease. Authentication/security email policies otherwise remain
unchanged; expired payloads are now cleared even when delivery configuration is unavailable.

The original notice lifetime is 24 hours, with a one-minute cutoff before expiry. Retries stop within that lifetime;
they never create a new key after the provider's documented idempotency window. Resend acceptance is recorded as
`sent`; it does not prove inbox delivery, and no bounce/delivery webhook integration is claimed. An in-flight
message cannot be recalled. Cancelled/expired work stops further attempts but cannot prove that a lost-response
attempt was never accepted by the provider.

Limits are explicit: 1,000 saved subscriptions and 1,000 unexpired notice intents per workspace, 20 returned history
rows, one intent and one mail claim per worker pass, and 30-day notice metadata retention. Capacity refusal leaves
the original incident in the inbox and records a metadata-only audit event. Sent, cancelled, expired and permanently
failed mail clears its encrypted payload; transient failures retain it only through the original lifetime. The
worker applies expiry and notice retention even if mail configuration is later disabled.

The website places personal delivery controls in the monitor detail, with separate opt-in/opt-out/retry confirmations,
current status/reason/attempt history and incident links. Late reads, confirmations, writes and errors are fenced
against changed routes, identities or newer refreshes. Label and error content is escaped. Matching
`amcp_workspace` actions are `monitor_notifications`, `set_monitor_notifications` and `retry_monitor_notification`.
Their version tokens and read-only handoffs identify the original rule/notice; these actions never change ads.

## Qualification

Twelve backend tests cover opt-in, self-only recipients, deduplication, original authority and grants, source loss,
rule changes, account changes, creator isolation, parallel claims, deferred attention, capacity, encrypted storage,
automatic/manual retry limits, permanent failures, expiry, retention and cancellation races. Three controller tests
cover exact confirmation/version payloads, escaping, canonical links and stale asynchronous work. A seven-call
real MCP SDK journey checks advertised schemas and matching structured/text envelopes, scoped opt-in/history/opt-out
and revoked credentials, with zero native provider requests and zero external messages.

API and controller cases were observed red before implementation. Targeted regressions also exposed a late failed
response restoring cancelled intent state and a reclaimed lease exceeding the attempt budget; both were repaired.
One fixture's same-millisecond event ordering assumption and one direct-SQL connection-field assumption were fixed
to assert the actual public behavior, without relaxing production assertions. Full-suite and sanitized release
evidence is recorded in [PROGRESS.md](PROGRESS.md); ignored logs are in `.runtime/monitor-delivery-20261001/`.

The matrix becomes **13 implemented / 13 partial / 2 open**, within the stated local scope. Live mailbox acceptance,
deployed worker configuration and visual/assistive-technology acceptance remain unverified. Browser control cannot
initialize its kernel assets in this environment. No OAuth permission, dependency, database migration, native write
family, real credential, advertising mutation, external message, production deployment or DNS change was used.

Protocol behavior was checked against Resend's official [idempotency documentation](https://resend.com/docs/dashboard/emails/idempotency-keys)
and [send-email reference](https://resend.com/docs/api-reference/emails/send-email). All transport tests use fakes.
