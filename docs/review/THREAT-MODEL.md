---
status: reference
tier: engineering
---

# AMCP threat model

**Current implementation note, 1 October 2026.** The numbered threat ratings and gap descriptions below are
historical assessments; use the live [findings register](FINDINGS.md) for closure status and the
[implementation record](IMPLEMENTATION-2026-10-01.md) for this branch's evidence. They are not a list of unresolved
current defects. Out-of-band spending approval was declined; execute-time acknowledgements remain the control.

The delivery notes of the October 2026 batches that this page collected (batches 57 to 59, 61 to 82 and 122,
and one note on an increment of the October review) are kept as written in the
[threat model delivery notes of the October 2026 batches](../records/THREAT-MODEL-NOTES-2026-10.md) since
2026-10-24 (DOC-03). The sections below are the threat model.

Scope: the deployed AMCP process (website, MCP endpoint, worker), its SQLite store and its egress to provider APIs.
Out of scope: provider-side security, the Railway and Cloudflare control planes, and the MCP client's own sandbox.
Findings referenced as `F-nn` are in [FINDINGS.md](FINDINGS.md).

## 1. Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Provider OAuth access and refresh tokens | `connections` (sealed, AES-256-GCM, tenant+connection as additional data) | Full control of advertising accounts, often across many clients |
| Spending authority | `amcp_write` / `amcp_media` execute, owner spending policies, account write grants | Real money: budgets, bids, activation, deletion |
| MCP bearer tokens and OAuth grants | `api_keys`, `amcp_mcp_grants` (sha256), `amcp_mcp_clients` (sealed secrets) | Operator tokens can prepare and execute reviewed writes |
| Web sessions | `amcp_web_sessions` (sha256 of a 256-bit id) | Owner sessions change policies, grants and connectors |
| Master key `MIRROR_MASTER_KEY` | Railway variable | Decrypts every stored secret and backup |
| Account credentials | `amcp_users` (scrypt), `amcp_mfa` (sealed TOTP secret, hashed recovery codes); the administrator and reviewer passwords (environment, `amcp_web_doors` records the hash each was last opened with) | Account takeover |
| Customer and report data | Provider responses in reviews, receipts, audit rows, report exports, Sheets | Client confidentiality; lead forms can hold PII |
| Integrity of the audit trail | `audit` (one append-only hash chain across all workspaces: each row links to the last row of the whole table; each workspace reads only its own rows; an account erasure leaves receipted tombstones, SEC-07) | Evidence of who changed what |

## 2. Actors

| Actor | Capabilities | Main concern |
|---|---|---|
| Owner | Everything in their workspace, including policies and grants | Mistakes; a stolen owner session |
| Operator (human or MCP token) | Prepare and execute reviewed writes within grants and policies | Over-spending, wrong target, prompt-injected actions |
| Reader | Reads and dry runs | Must never mutate |
| Reviewer test account | Disposable test workspace, `role: admin`, `testAccount: true`; tools and AI clients act as operator at most | Must never change owner policies or reach the owner's accounts |
| Other tenant | Their own workspace on the same deployment | Cross-tenant read or write |
| Anonymous web user | Public pages, sign-in, sign-up, OAuth endpoints, DCR | Brute force, enumeration, denial of service |
| Compromised or confused MCP client | Arbitrary tool calls with a valid operator token | The strongest in-scope adversary for spending |
| Malicious provider content | Ad names, comments, lead fields, post text, error bodies flowing into LLM context | Prompt injection that steers the model into writes |
| Network attacker | Between browser and edge | TLS downgrade, cookie theft |

## 3. Trust boundaries

See [ARCHITECTURE.md §3](ARCHITECTURE.md#3-trust-boundaries) for the diagram. The boundaries that carry the most risk:

1. **MCP client → `MirrorService.call`.** Every argument is attacker-controlled once a token leaks or a model is
   steered. Controls: schema validation, compile-time path encoding, `ScopeGuard`, family `assert…`, the review
   protocol, the spending policy.
2. **Review → execution.** The frozen plan, fingerprint, state hash and idempotency claim make "what was reviewed"
   equal "what is sent". Controls verified correct (write-review.ts execute path).
3. **Provider content → model.** Labelled but not enforced (`meta.untrusted_provider_content`). The confirmation
   flags are set by the model, so they are advisory against injection; the hard stops are the kill switch, account
   write grants and owner policies (F-05).
4. **Browser → website.** Session cookie (`__Host-`, HttpOnly, Secure, SameSite=Lax), CSRF token plus `Origin` on
   every mutation, strict CSP without inline sources.
5. **Server → provider.** Origin allowlists per gateway, `redirect: 'error'`, 8 MB response cap, reads-only
   retries, no automatic resubmission of mutations.

## 4. Threats and controls

Rated by likelihood × impact for this deployment (one replica, one owner workspace plus invited members).

| # | Threat (STRIDE) | Scenario | Existing controls | Gap / finding | Rating |
|---|---|---|---|---|---|
| T1 | Elevation / tampering: spend without owner-intended limits | Operator raises a Reddit ad group budget 10,000× | Owner policy caps budgets | Reddit `goal_value` not counted (F-02) | High → fixed |
| T2 | Elevation: activation despite `allow_activation:false` | `status: 2` (ProtoJSON ENABLED) on a Google campaign | Activation contract per gateway | Numbers not recognised (F-01) | High → fixed |
| T3 | Elevation: delivery change without spend acknowledgement | Target CPA, LinkedIn `unitCost`, DV360 pacing, end dates, targeting on active entities | Text match for budget/bid/spend | Structural fields missed (F-03) | High → fixed |
| T4 | Tampering: policy meaning differs by provider | One workspace cap applied to micros, cents and whole units | Per-account policies exist | Unit-less workspace default (F-04) | Medium, owner decision |
| T5 | Spoofing: injected instructions executed | Provider text asks the model to raise budgets; model follows a pre-filled `next_call` | Untrusted label, review, policies | `next_call` pre-fills `spend_change_confirmed` (F-05) | Medium |
| T6 | Denial of service: sign-in lockout for everyone | Anonymous POSTs exhaust a limiter keyed on the proxy address | Per-key limits; since SEC-01 (2026-10-08) `AMCP_CLIENT_IP_SOURCE` keys limits on `X-Real-IP`, and on `CF-Connecting-IP` only from Cloudflare's published ranges; `/token` counts failures only | Shared bucket behind Railway; SDK limiters on `req.ip` (F-08); fixed in source, effective once the owner sets the profile | High → fixed in source |
| T7 | Spoofing: MFA brute force | Password known, TOTP guessed across many IPs | Per-IP limit, replay block | No per-user limit (F-09) | Medium |
| T8 | Elevation: stolen session escalates to takeover | Old session re-freshed via workspace switch, then e-mail change | 15-minute recent sign-in | `signedInAt` reset on switch (F-10) | Medium |
| T9 | Denial of service: connector registration exhausted | 1,000 anonymous DCR registrations | Rate limit 20/h; since MCP-03 (2026-10-08) stale clients are released, metadata-document clients never register, and registrations are limited per client address (30) and per deployment (300) in 24 hours with an owner alarm, replacing the permanent 1,000 cap | A flood from many addresses (for example one IPv6 /48, which spans 65,536 per-address /64 keys) can still hold the daily limit for up to a day (registration only; existing connections and metadata-document clients are unaffected) | Medium → fixed in source |
| T10 | Information disclosure: plaintext response history | Database or backup copy exposes report rows and lead PII | Secrets sealed; tokens hashed; since batch 7 a read is audited by size, hash and row counts, not content | Rows written before batch 7 keep full outcomes; no purge on disconnect; plain `admin backup` (F-18) | Medium |
| T11 | Tampering: family misclassification | Enhanced mode `native_request` with a spoofed `action` | Strict mode default | `amcp_write` accepts native requests (F-07) | Medium (non-default) |
| T12 | Cross-tenant access | Operator guesses another tenant's review or connection id | Tenant column in every key and query | Verified correct | Low |
| T13 | SSRF | Media URL or Drive link to internal addresses | Host allowlists, pinned DNS for report downloads, `redirect: 'error'`; since batch 12 a public-link import (`source_url`) accepts HTTPS on port 443 with a host name, requires every resolved address to be public, connects to the checked address and re-checks each of at most three redirects | Verified correct; dot-segment hardening (F-20); link guard tested through the real HTTPS transport | Low |
| T14 | Injection | CSV/Sheets formulas, GAQL, REST.li, path traversal, FFmpeg arguments | Escaping, strict regexes, `shell:false`, protocol whitelist | Verified correct | Low |
| T15 | Repudiation | A write without a trail | One append-only hash chain across all workspaces (`Store.appendAudit` links each row to the last row of the table); reads are per workspace (Activity, the website and MCP history), while `Store.verifyAudit`, `admin audit-verify` and the `audit_chain_valid` field of the per-workspace `admin status <workspace>` verify the whole chain | Verified correct as one global chain, tombstones included (SEC-07); there is no per-workspace verification, so a per-workspace answer reports the global one; retention missing (F-18) | Low |
| T16 | Tampering: stored secret forgery | Truncated GCM tag accepted | AES-256-GCM | Tag length unchecked (F-19); needs DB write access | Low |
| T17 | Downgrade | HTTP to the site | Cloudflare TLS, `Secure` cookies | No HSTS (F-17) | Low |
| T18 | Availability: provider sunset | Microsoft SOAP 2027-01-31 (Google Ads moved from v23, sunset 2027-02, to v25 in batch 14) | Pinned versions, drift tooling, one Google version module | No dated sunset registry or alarm (F-50…F-56) | Medium |
| T19 | Denial of service: uploads fill disk or memory | Many or large uploads, or parts sent in parallel | Since batch 12: four waiting uploads per workspace and eight in all, each within the media limit; parts of at most 1 MiB read only after session, CSRF, ownership and exact length are checked; 16 parts in flight server-wide; 30-minute expiry; a link import holds the media byte admission | New surface; bounded | Low |
| T20 | Tampering: hostile file to FFmpeg | A crafted upload aimed at the decoder | Type from magic bytes, fixed demuxer per type, local-file protocols only, no QuickTime external references, bounded allocation, time limits, 40 MP / 180 s, two processes at once | Existing controls, now also on uploaded files | Low |
| T21 | Information disclosure: preview links | A preview link, which anyone holding it can open, is kept or shown to the wrong person | Links are returned, never stored; every read behind them is audited by size and hash; only HTTPS links on the platform's own hosts are returned; the website opens them with no referrer and says who can open them | New surface (batch 13) | Low |
| T22 | Information disclosure: people in customer lists | An upload of emails or phones is kept in a review, the audit trail, a receipt or an error, or sent without the owner | Since batch 43 (approved policy of 2026-09-30): people travel beside the request and are hashed in memory; a review keeps counts and one digest, execution takes the people again and refuses another batch; the error audit keeps the row count only and scrubs the arguments of a request that carries people; replies and errors are scrubbed of hashes and e-mail addresses; the owner's switch per ad account, off by default; the owner executes each upload. Batch 46 adds Google's Data Manager API: its one origin is allowed for Google only, the `datamanager` scope is requested only when writes are enabled, AMCP builds the body itself (a body that differs from the reviewed people is refused), the terms field is sent only on the uploader's confirmation, and Google's reply is kept as the request ID and a warning count | New surface: Meta customer lists and offline conversions, and Google Customer Match and offline click conversions. The people pass through the MCP client, which AMCP does not control | Medium |
| T23 | Denial of service: one key amplifies `/mcp` load for every workspace | A JSON-RPC array of thousands of `tools/list` calls in one POST, or a key sending without pause | Since SEC-02 (2026-10-08): arrays refused with `-32600` before any item runs; per-actor token bucket (60 a minute, burst 20) shared in SQLite and 4 requests in flight per instance, all environment-tunable (owner decision D6) | Body limit still 4 MiB until measured (X01-F01) | High → fixed in source |
| T24 | Denial of service: one person kept out of sign-in and recovery | Anyone who knows an email address sends 10 wrong passwords or 5 reset requests every 15 minutes | Since SEC-03 (2026-10-08): a browser that completed a sign-in holds an HMAC-bound known-device cookie (account version in the MAC) with its own budget; reset, registration and email-change requests at the per-email cap answer the same and send nothing; address limits unchanged | A new browser without a linked social sign-in still waits out the per-email cap | Medium → fixed in source |
| T25 | Information disclosure: one client's access reaches another client in the same workspace | A viewer invited for client A, a connector token made for A or an AI client approved for A lists, reads and reports on client B's accounts | Tenant isolation; per-account write grants fence writes. Since SEC-08 (owner direction P1): optional client access sets limit a member, token or AI client to one client's accounts at the single account-resolution chokepoint (`Store.connectionsFor`), refusing others with `ACCOUNT_SCOPE_RESTRICTED`; a test probes every MCP tool entry point with a limited actor; records of a login the set shares (write receipts, uploads, report tabs) stay with their client's accounts; another client's saved reports cannot be changed by ID, nor its jobs read by ID; a missing-grant refusal names only the set's logins; a limited view of a login is never saved back | Whole-workspace access stays the default, and the website's working client is a view filter only. Local PDF/XLSX delivery presets name no account and stay workspace-wide | Medium → fixed in source (opt-in) |

## 5. Assumptions

- Railway terminates TLS and forwards to one replica, overwriting `X-Real-IP` with its connecting client (Railway's
  documented behavior; it publishes no proxy CIDRs). The operator sets `AMCP_CLIENT_IP_SOURCE=railway+cloudflare`,
  which believes `CF-Connecting-IP` only when that client is a Cloudflare edge address (SEC-01, owner decision D5).
  `AMCP_TRUSTED_PROXY_CIDRS` stays empty there; it serves the `xff-cidrs` profile of other hosts.
- `MIRROR_MASTER_KEY` is only in Railway variables and never in the repository.
- MCP clients present tool calls to a human for approval according to their own policy; AMCP does not rely on that.
- Provider APIs enforce their own authorization; AMCP never widens a grant beyond what the OAuth token allows.

## 6. What would most reduce risk next

1. Out-of-band confirmation for spend and activation (MCP elicitation, or a website approval bound to the review's
   state hash) so that a steered model cannot supply `spend_change_confirmed` on its own (F-05).
2. Unit-aware policies: caps per gateway in canonical units and currency (F-04).
3. Audit minimisation and retention (F-18).
4. Rate limits keyed on resolved client address and per account (F-08). Source done in SEC-01 through
   `AMCP_CLIENT_IP_SOURCE`; it takes effect once the owner sets the profile on Railway.
