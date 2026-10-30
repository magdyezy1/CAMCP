---
status: record
tier: engineering
---

# Operations and monitoring delivery — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `f22fca9`. This delivery advances B13, B15 and B19 of the
[product blueprint](../review/PRODUCT-BLUEPRINT-2026-10-01.md). The
[28-package implementation matrix](../review/IMPLEMENTATION-2026-10-01.md) remains the scope record; this delivery does not
claim completion of every package, acceptance by external MCP clients, or deployed/provider behavior.

## Resulting workflow

Operations is a searchable, paginated feed across six retained work types: campaign plans, upload reviews,
Overview snapshots, export jobs, schedules and monitoring incidents. Filter by type, attention category, name/ID
and account. Open the exact original record in the website or follow its read-only MCP `next_call`. A failed export
and a successful collection remain distinct. Uncertain uploads keep their original review and mutation key.

The monitoring inbox pages beyond the previous 100-incident ceiling. Rules and incidents have independent search,
state filters and pagination. An incident opens by exact ID with its account, measurement context, rule version,
evidence history and supporting snapshot. A snapshot offers a direct **Create a monitor** handoff carrying its ID.
The rule editor has typed controls and an explicit confirmation; it preserves the current paused/active state.

Snooze defers attention for 1–168 whole hours. It does not replace the factual `open`/`acknowledged` state and does
not stop evaluation. Expiry restores that prior attention state on the next read, without requiring a new snapshot.
Resume clears the deferral. Only fresh, complete, comparable evidence resolves the incident; stale or incomplete
data cannot do so. Fresh recurrence clears an old resolution and deferral.

Rule revisions explicitly supersede older unresolved incidents, in the same transaction as saving the rule. Their
original threshold, factual state and evidence remain available. Superseded does not mean resolved. Historical
resolved/superseded incidents follow the owner's existing report retention period; current active incidents and
rules remain preserved. No migration or runtime dependency is added.

## Contracts and access

| Operation | Contract |
|---|---|
| `amcp_workspace operations` | `kind`, `state`, `search`, exact `account_id`/`connection_id`, `cursor`, `limit` 1–100 |
| Work kinds | `all`, `campaign`, `upload`, `report`, `export`, `schedule`, `incident` |
| Attention categories | `all`, `attention`, `active`, `complete`, `deferred` |
| `incidents` / `monitors` | Exact account/login/gateway and name search, state filter, `offset`/`limit`, `next_offset` |
| `incident` / `monitor` | Exact `id`, current access, original website path |
| `acknowledge_incident` / `resume_incident` | Exact `id`, current `revision`, operator role and current account access |
| `snooze_incident` | Same controls plus integer `snooze_hours` 1–168 |
| `save_monitor` | Current old and new account access, revision and confirmation; preserves paused state and versions evidence |

Feed cursors bind identity, credential session and filters. They are continuation positions, never authorization.
Every page rechecks current tenant, actor, engine ownership and account/login access. Media retains its stricter
original-user, operator, deployment-write-policy and write-grant requirements. A different administrator cannot
inspect another user's upload review through this feed. Account and login filters must match the same scope.

SQLite projects metadata without loading report rows, checkpoints, plan arguments, upload source URLs, actor
bindings, provider receipts or raw error messages. Each request examines at most 500 candidates and returns at most
100 records. An empty page can still carry `next_cursor` when filtering or current access hides its candidates.
The database may scan/sort a larger source set; this is a response/processing bound, not a production query-cost SLA.
Updates can move records between pages, so refresh for current state. The feed is not an immutable audit log.
Legacy workbook runs and arbitrary native action history remain in their existing surfaces rather than being
misrepresented as part of this six-type feed.

Browser page loaders reject late responses from older filters, detached views, routes or identities. Page failures
retain the last successful page without advancing its cursor. Monitor filters survive same-page state changes.
Mobile action bars wrap; recovery never presents automatic replay of an uncertain advertising mutation.

## Evidence and qualification

The initial red tests reproduced the absent feed, incident detail/snooze actions, rule-supersession behavior and
superseded-history retention. Green regressions exercise ties and cursors, 505 inaccessible candidates before
visible work, metadata-only projections, revocation, upload ownership/write grants, durable failed jobs, expired
snoozes, evidence updates, recurrence, 107-incident paging, stale revisions and paused rule editing.

The MCP SDK evaluator runs the real `tools/list` and `tools/call` transport, validates advertised schemas and checks
text/structured-result agreement. The incident journey takes seven tool calls and about 8.3 KB of structured
responses; original campaign/upload inspection takes four calls and about 5.4 KB. Both issue zero provider requests.
Viewer refusal and revocation remain enforced. These are synthetic protocol journeys, not Claude/Codex/Cursor
client acceptance or measured model token savings.

A local backend projection benchmark used 200 reports × 500 retained rows (100,000 synthetic rows), two warm-ups
and seven samples. A 20-item page measured **25.90 ms p50 / 26.98 ms maximum sampled latency**, with a **10,916-byte**
response and zero network requests. It establishes no baseline speedup or production capacity claim.

Browser qualification used `node tests/fixtures/reporting-browser.mjs 43281 operations`, an in-memory database,
synthetic credentials and fake transport. Its report snapshot is produced by the reporting engine. Verified:
operations page two and filters; original uncertain-upload recovery; inbox page two; snapshot-to-rule creation;
evidence inspection; acknowledgement; snooze/resume; rule revision with retained superseded evidence. Desktop and
390×844 mobile views were inspected. A clipped mobile action row and an unstyled snooze selector were corrected.
Screenshots and logs remain under ignored `.runtime/delivery-20261001/`.

Release qualification is recorded in the batch 51 entry of [PROGRESS.md](PROGRESS.md). Local FFmpeg/container gaps,
remote CI, live-provider acceptance and deployment are reported separately. No live advertising, external
notification, provider/OAuth permission, production deployment or DNS change is part of this delivery.

## Remaining expansion

- B13: complete cross-engine audit telemetry and legacy workbook job integration, beyond the six-type current feed.
- B15: broader task evaluations and external-client acceptance; no claim of fewer model calls against a baseline.
- B19: external notifications and delivery/retry policy remain unimplemented. The explicit destination is this inbox.
- B23: real tenant load, indexed feed ordering and bounded large-history monitor counting require separate measurement.
  Monitor lists preserve their existing account-filtered offset/count semantics; this delivery bounds the new feed.
- The other partial/open packages, Arabic localization, provider-program eligibility and deployed acceptance remain
  listed in the implementation matrix.
