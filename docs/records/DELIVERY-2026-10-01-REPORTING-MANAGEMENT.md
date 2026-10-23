# Saved query management and scoped reporting setup — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `66c816b`. Implementation: `3ad6117`. Batch 62 extends B13 with saved-query discovery and reviewed editing.

## Workflow

Operations now lists saved workbook queries with search, bounded pagination, account/provider labels and links
from original report runs and schedules. Query detail displays its current account, connection and revision,
linked schedules, and explicit or rolling report dates. Legacy redacted configurations expose an advanced repair
editor so credential fields can be removed before review. Calendar weeks/months and complete-day windows retain
their explicit timezone; schedule-clock timezone remains separate. Native read queries expose an escaped advanced
JSON editor. Account/provider/connection are fixed in this editor; changing them requires a separate query.

Review returns the exact proposed definition, changed fields and number of active schedules that will pause.
Separate confirmation saves a revision and creates one prepared, unsubmitted report. Definition changes pause
active schedules atomically so their future runs require fresh schedule review/resume. Renaming alone keeps clocks
active. Existing queued/completed runs keep their original configuration and IDs. The returned prepared-run link
opens the original record; saving never submits a provider request or changes advertising settings.

`amcp_workspace` exposes `report_queries`, `report_query`, `preview_report_query` and `save_report_query`.
The editor version binds current scope, query revision and linked schedule revisions. Save requires an operator,
that exact version and `confirmed:true`, with a transactional recheck. Reader access is inspection-only. Native
queries must validate against captured schemas and the independent native read classifier; account aliases must
agree, and credentials are refused. Canonical report date ranges and rolling-window timezones are validated before
save. Late responses, confirmations and errors cannot cross route, identity, refresh or edited-form boundaries.

## Original-record access and bounded reads

F-136 was reproduced against the baseline: the three legacy reporting bootstraps exposed tenant-wide query and
schedule settings, and a legacy update could replace an inaccessible original query's scope with an accessible
one. Setup now authorizes projected account/connection metadata first, filters a requested spreadsheet before
pagination and strips encrypted actor bindings and legacy credentials. Editing checks the original record before
loading its body, as well as the proposed configuration and workbook. A workbook requires current access to all
attached query scopes; an empty binding is visible only to its creator or a workspace administrator. Existing
binding lookup no longer loads the entire collection. Path-only/opaque historical scope remains refused.

Query lists scan at most 500 candidates and return at most 100 metadata rows. Follow `next_offset` even after an
empty access-filtered page. Bootstrap returns at most 100 queries, schedules and bindings, with a 256 KiB aggregate
full-body budget; metadata fallbacks explicitly mark omitted settings. Each query configuration is limited to
64 KiB, with a separate 72 KiB complete-record envelope. Binding/schedule settings are capped at 64 KiB, and
oversized legacy bodies are identified in SQL before loading. Bindings support at most 500 attached queries;
the interactive editor supports 100 linked schedules. These limits preserve explicit continuation/refusal rather
than misreporting a truncated collection as complete. Query editing is available locally; a legacy workbook
binding does not establish a live Google Sheets destination.

F-137 was found during integration: batch 61's personal monitor controls passed positional arguments to the
object-shaped confirmation API. Its consequence text could therefore be missing. All three calls now supply the
documented object. Strengthened controller assertions first failed against the previous implementation and now
check the title, consequence and confirmation label. This correction does not silently enable any subscription.

## Qualification and remaining work

Eight backend tests cover access boundaries, original scope, native read classification, credentials, dates,
pagination, body limits, settings limits, schedule revisions, roles and retained-run preservation. Three editor
controller tests cover exact proposed values, confirmation, escaping and stale identity/form responses. The
seven-call MCP SDK journey validates advertised schemas, matching result envelopes, exact handoff links, schedule
pause, the original prepared run and stale-save refusal, with zero provider requests. Existing captured reporting
tests now provision explicit synthetic account grants instead of relying on the former missing scope checks.

The initial scoped-access, missing editor and confirmation-shape tests were observed red. An additional red
regression demonstrated oversized schedule-body loading before that was bounded; another exposed the missing
legacy credential-field repair path. Full-suite, sanitized-candidate
and CI evidence are recorded in [PROGRESS.md](PROGRESS.md); ignored logs remain in
`.runtime/reporting-management-20261001/`.

The matrix remains **13 implemented / 13 partial / 2 open**. B13 still includes broader audit telemetry, binding
management and adapters for unidentifiable historical job scope. Browser visual and assistive-technology
acceptance remains unverified because CUA cannot initialize its kernel assets. No live provider, real credential,
external message, advertising mutation, OAuth change, migration, dependency or production deployment was used.
