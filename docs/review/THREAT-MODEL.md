---
status: reference
tier: engineering
---

# AMCP threat model

**Current implementation note, 1 October 2026.** The numbered threat ratings and gap descriptions below are
historical assessments; use the live [findings register](FINDINGS.md) for closure status and the
[implementation record](IMPLEMENTATION-2026-10-01.md) for this branch's evidence. They are not a list of unresolved
current defects. Out-of-band spending approval was declined; execute-time acknowledgements remain the control.

Batch 72 reuses scoped native reads for LinkedIn daily evidence. Account ID/currency checks precede analytics;
native pivots, UTC dates and duplicate grain are validated before persistence. Ambiguous empty data, continuation
metadata and provider ceilings cannot become zero or complete evidence. Both requests share the existing bounded
collection context. Original request/hash references, explicit attribution/completeness declarations and final
current-authority checks remain separate. No advertising write, additional OAuth scope or live qualification is added.

Batch 73 extends LinkedIn period/completion validation to Overview and leaves unverified conversion attribution
unknown, holding recommendations. Failed calendar periods retain coverage errors and cannot count as zero data.
The existing complete-only delivery rule still protects destinations. Older collected LinkedIn checkpoints require
a new snapshot and stay intact; untouched queued snapshots adopt the current contract before reading. All native
collectors recheck current actor/account access before returning. Completed historical snapshots are not rewritten.

Batch 74 compares retained report sources only after current account authorization and compatible declared
semantics/grain checks. Exact decimal differences retain nulls, source hashes and explicit tolerance. No comparison
claims independent provider verification. Manual totals are arithmetic only. Website form, result and identity
generations prevent old comparisons or report discovery from reaching a new view; current errors remain visible.

Batch 75 parses reference files only in the browser: 64 KiB, 64 unique columns and exactly one totals row.
Explicit field mapping, decimal separator and currency-unit scaling use exact integer arithmetic without rounding.
Raw file bytes and unselected values are not sent; selected totals, column names, declared scope and a client hash
are retained. The backend validates bounded metadata and matching known context, while explicitly denying
independent verification of file bytes, entities, filters or attribution. Edits invalidate previews and both
measurement acknowledgements; late file reads and comparisons remain bound to current form/view/identity.

Batch 76 restricts artifact language to explicit `en`/`ar` presentation metadata. Omitted legacy fields retain their
original serialized shape and destination creation fingerprints. Queued exports retain their original presentation
through destination edits and partial retries; accepted files are not regenerated. Authored labels alone are translated.
Native IDs, currency, numbers, custom metrics, raw values and the embedded evidence attachment remain unchanged.
PDF shaping uses bounded logical paragraphs, Unicode direction runs and the existing embedded font/glyph checks;
workbook strings remain literal cells. Current source access, role, confirmation and revision checks still apply.

Batch 77 projects only workbook association identity/name and authorized linked-query metadata. Stored URLs,
preferences and query configurations never reach the new view. Every linked query must pass current account
authorization; empty associations remain creator/admin-only. Lists scan at most 50 associations per request and
follow an explicit offset, including empty filtered pages. Details support at most 500 linked queries and display
100. Renames require operator authority, confirmation and a version bound to the association and all query
revisions, rechecked transactionally. Existing preferences, queries, schedules and jobs stay intact. The shared
page loader now fences identity as well as route/request/DOM lifetime and blocks departed handlers before reads.

Batch 78 indexes reporting-query membership by tenant, exact saved workbook association and query ID. The
partial index contains only reporting queries and changes query planning, not authorization or returned data.
No actor/account result is cached. Bootstrap adds the index within the existing serialized schema transaction;
record bytes, revisions, audit history, encryption and schema version 2 remain unchanged. Old-schema reopen,
concurrent bootstrap and encrypted backup/restore checks pass locally. The benchmark always creates a disposable
in-memory synthetic database and never consumes a configured database path or provider credential.

This increment checks current actor/account, pause, personal-data direction and spending policy immediately before
each unsent native mutation, including upload chunks, while preserving accepted receipts. Personal-data failures
scrub both keys and values and withhold unvalidated native arguments. Browser state is invalidated across identity
changes and route generations. Reporting requests, bytes, rows and active time share a durable whole-job budget.
Monitors retain local evidence and allow explicit self-subscription to generic email notices; commerce imports save reviewed plans; profile bindings restrict
selected accounts without creating grants. These are locally tested properties, not deployed/live certification.

Batch 61 adds per-person, per-rule email opt-in to an existing verified account address. No arbitrary recipient or
report content enters an email. Encrypted original payloads, deterministic provider keys, bounded attempts/lifetime,
current recipient and author authority, incident/source checks and fenced leases constrain background delivery.
Rule revisions require renewed consent. Opt-out/pause cancel unsent work; in-flight acceptance cannot be recalled.
The local inbox survives transport failures. Notice metadata and ciphertext have separate retention limits, and
provider acceptance remains distinct from inbox delivery. Tests use synthetic transports only.

Batch 57 extends those boundaries to workbook reporting jobs. Status/feed queries project bounded metadata in
SQLite and never materialize query bodies, report rows, encrypted actor bindings or raw error messages in the
response. Result retrieval and resume also recheck the retained job's account scope against current grants. Changing
the saved query cannot transfer access to its old results. Native account aliases must agree; path-only or opaque
scope fails closed. Website recovery is operator-only, requires explicit confirmation and the displayed run version,
and cannot restart running/completed work. Creator/session checks and independent worker read classification remain
in force. These changes do not make the mutable Operations feed an immutable audit history.

Batch 58 adds workbook schedule metadata and editing. Future schedule access follows the current saved query;
last-run links independently recheck that historical run's retained scope. Preview makes no changes. Saving requires
an operator, explicit confirmation, current grants and a version binding both schedule and query revisions in one
transaction. Pausing cannot cancel queued work, and resuming binds current creator authority without catch-up jobs.
Clock changes cannot replace query identity, transfer workbook bindings or introduce an external destination.
Website confirmation is preceded by server validation and suppressed after identity/route changes. New visual
browser qualification remains unverified because the browser tool failed before initialization in this batch.

Batch 62 scopes the legacy reporting bootstraps and edits against current account grants before loading original
query bodies. Native query definitions require an independent read classification and unambiguous account anchors;
inline credentials are refused. Workbook access requires every attached query scope, or creator/admin authority
for an empty binding. SQL size projections, bounded candidate scans and body budgets constrain legacy records.
Reviewed edits bind current query/schedule revisions; changed definitions atomically pause active schedules while
original jobs retain their configuration. This is local configuration authority, not approval for provider writes.

Batch 63 uses an explicitly selected local interface language and a fixed same-origin catalog path. Catalog values
must be plain text with identical interpolation slots. Callers escape HTML/attributes; user/provider content and
native values remain outside translation. Language changes require confirmation for unsaved input or displayed
recovery codes and discard stale route/identity responses. Tests compare English/Arabic authentication requests
byte-for-value, including leading-zero MFA codes. A source check rejects translated protocol/control comparisons.
These controls do not change backend permissions or translate legal policy; advanced workflows remain partial.

Batch 64 extends parity checks to selected asset keys, write grants/acknowledgements, connector roles, OAuth consent
request IDs/scopes, account-access flags and owner spending units/retention. One-time connector tokens now require
the same refresh confirmation as recovery codes. Technical identifiers are rejected as translation keys; provider
variables, copied config, callback URLs and original legal wording are tested unchanged. Only first-party platform
kind/description fields are added to catalog coverage; native names and provider values remain original.

Batch 65 compares native campaign approvals, recipe inputs, exact creative source hashes and preview requests
between English and Arabic. Default form values/types/names cannot be translation targets. All original consent
requirements remain unchecked. Queued uploads keep their pending status and original recovery identity instead
of appearing completed; no status display triggers an extra provider submission.

Batch 66 preserves original workbook run/query/schedule and monitor notice versions across Arabic confirmations.
Tests compare both languages' native requests and cancellation paths. Schedule dates follow the explicit interface
locale without changing the clock timezone, and monitor thresholds/attribution remain original values. Email state
labels distinguish provider acceptance from mailbox delivery. Translation introduces no new recipient or transport.

Batch 67 keeps report names, native field examples, formulas, account IDs and saved revisions unchanged during
Arabic report editing. Tests preserve separate delivery and reporting clocks, explicit file formats/retention
consent, cancellation and export identity. Known metric labels are translated separately from user-defined labels
and source evidence. Conditional message alternatives now participate in catalog validation; exact decimal strings
are never converted by display formatting. No destination authority or retention policy changes.

Batch 68 extends current-view isolation to measurement and product-import forms, including asynchronous local
file reading, provider preview, local plan creation and the resulting navigation. Input changes and newer attempts
invalidate earlier responses and save handlers; detached nodes and changed identities/routes reject stale work.
Current errors still surface. Account IDs, native status/money/CSV values and create-only policy remain exact in
both languages. These UI checks complement existing server account grants and per-item native reviews.

Batch 69 captures a playbook's original ID/revision before deletion confirmation and checks that the reviewed
selection, form, route and identity remain current before submission. Editing clears local approval and invalidates
pending previews and save responses. Report-branding changes and downloads also reject obsolete callbacks and
errors. These checks do not cancel already submitted writes or automatically retry them. Native templates, UTM
values, approved profile revisions, explicit snapshot replacement consent and account restrictions remain exact.

Batch 70 applies form/view/identity and attempt-order checks to evidence discovery/capture, scenarios and allocation.
Measurement edits invalidate completeness declarations; the declaration control does not clear itself. Old errors,
results, allocation submissions and download/print handlers cannot act on a departed or changed view. Native amounts,
attribution windows, selected action names, exact preview IDs/hashes and separate native draft approval are retained
in both languages. Saved HTML declares its locale/direction without modifying source evidence or issuing new reads.

Batch 71 restricts analytical translation to 42 authored sentences checked against explicit backend explanation
positions. Native diagnostics, protocol values and user context remain outside that set. Missing-target localization
uses new optional typed message parameters while preserving the original reason and decision; unknown/legacy
metadata falls back to the original text. Rendering does not mutate retained objects, alter thresholds, grant
approval or initiate any provider request. Raw evidence continues to carry the original language and values.

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
| Reviewer test account | Disposable test workspace, `role: admin`, `testAccount: true` | Must never change policies or real accounts |
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

October batch 59 adds retained PDF/XLSX files in the existing tenant database. Payloads use tenant/purpose/ID-bound
encryption, with a 20 MiB file limit, 256 MiB encrypted-storage limit and bounded renderer concurrency. Current
source grants, original actor and job lease are checked around rendering and persistence. Receipts bind the source
snapshot and exact bytes; retries validate existing files before skipping a format. Authenticated downloads recheck
source access, verify integrity and use `no-store`. Snapshot deletion/retention removes associated ciphertext.
The destination accepts no arbitrary filesystem path, URL or external recipient. Backups include encrypted files;
the database master key remains part of the existing backup/restore trust boundary. New visual and deployed
acceptance remain separate from synthetic HTTP, worker and controller tests.

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

Batch 79 bounds query moves to two currently accessible existing associations, up to 500 queries per binding
and 100 linked schedules of at most 64 KiB each. Query, both binding memberships and schedule revisions are
rechecked transactionally. All schedules move and pause together; existing job configurations and authority stay
intact. A separate schedule review/resume captures fresh authority. Legacy query moves use the same source/target
checks and atomic schedule handling. Preview exposes only selected identities and affected counts; website
selection, approval and callbacks retain current form/view/identity. No external spreadsheet permission is implied.

Batch 80 restricts retirement/restoration to empty associations under creator/admin access and current
operator authority. The transaction rechecks association/query versions and linked schedules, including orphans.
Default access rejects retired associations for new use; explicit inspection withholds private preferences/URLs.
Active lists and bootstrap exclude retired setup before limits. Restoration retains the original identity and
settings. No jobs or external actions are generated. Older releases do not enforce the new retirement marker,
so a deliberate code rollback must account for that semantic difference.

Batch 81 LinkedIn inventory uses signed canonical cursors bound to tenant/user, native API version, exact
account/login/credentials/entity/parents/page size and five-minute expiry. Qualified parent observations are
recorded only after full page validation and current authorization. Fresh native account/group/campaign reads
verify hierarchy; eight requests, 100 rows, 8 MiB, 60 seconds and 100 continuation pages bound collection. Native
decimal money is never converted through floating point. Only selected safe provider fields are projected.
Departed portfolio handlers now stop before requests (F-151). Inventory observations grant no advertising authority.

Batch 82 closes raw tenant-wide history exposure (F-152). The website and MCP project bounded audit metadata
in SQLite; event payloads/receipts are never loaded into discovery. Current account access or matching local actor
is needed by non-owners, and diagnostic items are scoped separately. The existing owner definition, not generic
admin membership, permits workspace-wide metadata diagnostics. All roles lose raw body/outcome/arbitrary fields.
Canonical cursors bind identity/session/role/filters/limit and the original maximum sequence; continuation still
checks current grants. Inputs and projections are byte/count-bounded. Original append-only events/hashes remain
unchanged; the endpoint makes no new whole-chain integrity claim.

Batch 122 closes an existing Snapchat ad creative-dependency gap (F-197). Owned paused parents do not establish
ownership of a referenced creative. The server derives up to 25 unique safe creative GET paths from native ad
creates/replacements, independently enforces current resource scope, requires an exact returned ID and explicit
matching ad_account_id, and binds the full creative snapshot to the native review hash. Missing/foreign ownership
or changed original content stops submission. Website references recheck WEB_VIEW and credential-free HTTPS at
actual preparation/execution. Campaign preflight first requires complete bounded selected-account discovery
(25 pages maximum) before any global creative read or hierarchy create. Revocation remains effective between
discovery and the exact read. This evidence does not authorize advertising, certify approval, fetch the destination
or remove accepted/uncertain receipt safeguards. Money, frozen review, predecessor verification and activation
controls remain mandatory. Other ad formats retain their own provider acceptance requirements.
