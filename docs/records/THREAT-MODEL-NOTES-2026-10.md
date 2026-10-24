---
status: record
tier: engineering
---

# Threat model delivery notes of the October 2026 batches

The notes the delivery batches of October 2026 added to the [threat model](../review/THREAT-MODEL.md), kept as
they were written and in their order; they moved here from that page on 2026-10-24 (DOC-03). The threat model
itself (assets, actors, trust boundaries, threats and controls, assumptions and what would most reduce risk) stays
on its page. Each note describes the controls of its batch on its day; later batches and the findings register
say what changed since.

## Notes at the top of the threat model

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

## The note in its assumptions

October batch 59 adds retained PDF/XLSX files in the existing tenant database. Payloads use tenant/purpose/ID-bound
encryption, with a 20 MiB file limit, 256 MiB encrypted-storage limit and bounded renderer concurrency. Current
source grants, original actor and job lease are checked around rendering and persistence. Receipts bind the source
snapshot and exact bytes; retries validate existing files before skipping a format. Authenticated downloads recheck
source access, verify integrity and use `no-store`. Snapshot deletion/retention removes associated ciphertext.
The destination accepts no arbitrary filesystem path, URL or external recipient. Backups include encrypted files;
the database master key remains part of the existing backup/restore trust boundary. New visual and deployed
acceptance remain separate from synthetic HTTP, worker and controller tests.

## Notes after what would most reduce risk next

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
