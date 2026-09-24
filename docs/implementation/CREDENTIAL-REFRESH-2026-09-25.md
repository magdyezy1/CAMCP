# Credential refresh and connection replacement

Base revision: 7fdfe3452c50faf6bf1d59ff15b61a789dab68c8, Codex-branch.
Implementation and 92 focused regressions pass, including 28 new adversarial
tests. Full sanitized required-FFmpeg validation passes: 1578 main and four
capture tests, zero failures/skips. See [machine evidence](CREDENTIAL-REFRESH-VERIFICATION-2026-09-25.json).
No live credentials, token exchanges, account changes or deployment operations
were used.

## Confirmed defects and corrections

**P1 correctness/authorization integrity, conditional on concurrent replacement.**
An expired connection began refreshing. While its provider response was pending,
an administrator replaced that connection with a different login. The old refresh
then called unconditional Store.replaceCredentials and overwrote the newer
access/refresh grant. Source of truth moved back to the previous principal. This
was reproduced for all 14 gateways using CredentialProvider, including Apple Ads
client credentials. No external unauthenticated exploit is claimed; a legitimate
concurrent replacement is sufficient. Native Google website reauthorization
already takes the shared refresh lease; that specific path was not the defective
example. Administrative provisioning and lease expiry still needed fencing.

Store.completeCredentialRefresh now compares the exact source credential object
and gateway inside the existing SQLite transaction before writing a refreshed
secret. A replacement or deletion raises CONNECTION_CHANGED/CONNECTION_REQUIRED;
the stale result is neither stored nor returned. The comparison uses semantic
credentials, not randomized ciphertext or connection names/grants. This keeps
valid refresh-token rotation after metadata edits and retains the latest grants.
No token or comparison input is included in errors. Shared worker locks still
coalesce normal refresh, and a late worker cannot overwrite a later result after
its lease expires. Store.connectionCredentials also checks gateway before any
token return/refresh, preventing a stale connection object from sending a newly
selected provider's credentials to the old endpoint.

**P2 crash consistency, conditional on ownership cleanup failure.** Connection
replacement and deletion of its previous resource-ownership evidence were two
separate autocommit writes. A SQLite trigger simulating cleanup failure left the
new credentials with old ownership despite reporting failure. Store.putConnection
now commits provisioning and ownership invalidation in one transaction. The
regression verifies rollback of credentials, metadata and ownership together.
Nested callers retain the existing savepoint behavior; there is no schema change.

**P2 reliability/input validation.** Ordinary refresh accepted empty tokens,
contradictory error/success bodies, unsupported token types, malformed/overflowing
expiry and unlimited JSON bodies. Apple bounded bytes but still decoded invalid
UTF-8 permissively and accepted overflowing expiry. Shared bounded parsing now
limits responses to 1 MiB, requires valid UTF-8 and an object, cancels oversized
streams and excludes secret-bearing response text from errors/audit. Bearer
syntax, opaque printable refresh tokens, optional case-insensitive Bearer type,
positive decimal integer lifetime and a representable expiry are validated before
encrypted replacement. Unknown extension fields are ignored, not interpreted.

The existing ordinary-refresh one-hour fallback when expires_in is omitted is
preserved for compatibility; it is an AMCP assumption, not proof of every vendor's
lifetime. Apple still requires expiry. Missing token_type remains accepted for
existing provider/fixture compatibility, but an explicit unsupported type fails.
Native endpoints, redirect refusal, Reddit Basic/user-agent encoding, Snapchat
registered callback and Microsoft scope behavior remain intact. TikTok and other
unsupported refresh methods do not acquire a fabricated OAuth refresh route.

## Verification and reproducibility

Node 24.19.0 / npm 11.17.0 / Windows PowerShell. Focused command after build:

```text
node --test --test-concurrency=1 dist/tests/credential-refresh-race.test.js dist/tests/connection-disconnect.test.js dist/tests/measurement-apple.test.js dist/tests/microsoft.test.js dist/tests/reddit.test.js dist/tests/review-regressions.test.js
```

Local evidence under .runtime/contract-completion-20260924/:

- refresh-race-baseline.log: isolated old refresh overwrites replacement login.
- refresh-race-tests-baseline.log: 21 tests, 17 fail / four pass. Fourteen races,
  gateway replacement, malformed and oversized responses fail as expected.
- refresh-race-fixed.log: 85 pass after first correction.
- refresh-race-expanded.log: 91 pass, adding stale-gateway, refresh-only changes,
  lease expiry, optional-field compatibility, Apple malformed bodies and stream
  cancellation/redaction.
- connection-atomic-baseline.log: one failing ownership-cleanup rollback test.
- refresh-race-final.log: 92 pass, zero failures/skips after atomic provisioning.
- An expanded-test patch stopped on a nonexistent guide heading before any files
  changed; the exact heading was read and the patch corrected. This was an editing
  error, not a product/test failure or exemption.

Fixtures include 14 gateways; same IDs in different tenants; two SQLite workers;
restart; deletion; changes to grants without credential replacement; a rotated
refresh token with an unchanged access token; failed transaction cleanup; finite
expiry; UTF-8/stream size errors; and provider text that must never be logged.

The final candidate is .release/credential-refresh-20260925-a (588 files), source
tree f7ab115ebded0e0c479f6a2b139c2f7caf4e453fb759777c34fc0a3ba9ed1896.
All staged code/tests/guidance were compared with this candidate after normal
Git line-ending normalization; final evidence recording changes documentation only.

## Primary references and limits

Checked September 25, 2026:

- [RFC 6749, sections 5.1, 6 and appendix A](https://www.rfc-editor.org/rfc/rfc6749):
  successful token fields, refresh rotation, decimal expiry and opaque refresh
  token syntax. Published October 2012, updated by RFC 9700 among others.
- [RFC 6750, section 2.1](https://www.rfc-editor.org/rfc/rfc6750#section-2.1):
  Bearer header token syntax, October 2012.
- [RFC 9700, section 4.14](https://www.rfc-editor.org/rfc/rfc9700#section-4.14):
  refresh-token protection and rotation, January 2025. The local compare-and-write
  transaction is an AMCP implementation choice, not an RFC-prescribed database.

No runtime dependency, database migration, framework or extra service. Roll out
the tested source artifact with the existing encrypted SQLite volume. Rolling
back does not require a data downgrade, but reinstates the race; avoid concurrent
credential provisioning during any emergency rollback. Existing review receipts
and report schedules remain intact. Tests do not establish provider approval,
live expiry/rotation behavior, independent-database coordination, or recovery of
a provider rotation whose response was lost before AMCP could persist it. Scope
metadata returned during refresh is not silently translated into AMCP account or
write grants. Provider-specific expiry defaults and scope-refresh semantics need
separate qualification; broadening grants is never a recovery mechanism.
