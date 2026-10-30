---
status: reference
tier: operator
---

# Client report packs and recovery

Client report packs, their branding, files and recovery. A section of the [workflow guide](../PRODUCT-WORKFLOWS.md), moved here with its text unchanged on 2026-10-24 (DOC-03).

`amcp_reporting_overview {action:"report_pack", id}` presents a finished retained snapshot with its separate summary
groups, coverage, source hash and authenticated raw CSV/evidence links. The website provides a styled preview,
script-free HTML, generated PDF and Excel downloads, and browser print preview. A confirmed presentation editor
saves a brand name, accent color, footer, standard/compact layout and explicit PDF/Excel language against the snapshot's current revision.
The edit changes presentation metadata, never source rows or native objects. It performs no recollection, FX
conversion or silent cross-account aggregation. Review visible client/account labels before sharing the file.
Unknown metrics stay unknown; ratio charts name their shared scale.

`save_presentation` requires `id`, `presentation_revision`, `presentation` and `confirmed:true`, operator authority
and current access to every source. The authenticated `.pdf`/`.xlsx` paths returned by `report_pack` recheck session,
source access and snapshot/presentation revisions after asynchronous generation. Files are generated in memory,
with no server-side download archive. PDF includes source evidence and its embedded Latin/Arabic font; unsupported
glyphs produce an explicit error. Excel includes five formatted sheets: Report, Account summaries, Campaign rows,
Source coverage and Evidence. Literal names stay strings, numeric metrics stay numbers, missing values stay blank,
and the workbook states that retained values do not recalculate when edited. Evidence JSON is chunked in order.
Choose **PDF and Excel language** independently of the interface language. The optional presentation field
`artifact_language` accepts `en` or `ar`; omitted legacy settings remain English without rewriting their stored
shape. Arabic Excel uses translated sheet/header labels, RTL sheet views and original built-in metric IDs beside
translated metric labels. Native row values, custom identifiers, numeric cells, missing values and source JSON stay
unchanged. Arabic PDFs use logical contextual shaping and Unicode direction ordering, preserve Latin IDs and dates,
and embed the original source evidence and logical marked text. Unsupported glyphs still fail explicitly.
This setting is available in snapshot presentation, approved client branding and local file destinations. A queued
file export keeps its original language through retries; later settings cannot replace a retained accepted file.
This does not certify PDF/UA accessibility or independent Arabic editorial acceptance.

Presentation metadata follows snapshot deletion/retention. See the
[download limits and evidence](../records/DELIVERY-2026-10-01-CREATIVE-REPORTS.md).

Clients & templates can also retain optional `report_presentation` inside an approved client profile, using the
same bounded brand/color/footer/layout fields. From a report pack, **Use approved client branding** lists compatible
approved profiles, previews their exact values and requires confirmation before replacing the snapshot's style.
Nonempty profile bindings must cover every report source's exact provider/account/login. Empty bindings mean no
profile-specific account restriction; current report access is always required.

`presentation_profiles {id,offset?,limit?}` projects only approved branding metadata, with pages of 1–100 and at
most 100 candidate profiles checked per request. Continue with `next_offset` even after an empty filtered page.
`apply_profile_presentation` requires `id`, `profile_id`, `profile_revision`, `presentation_revision` and
`confirmed:true`. It copies the current approved revision atomically into the snapshot, records `presentation_source`
and preserves existing source rows. Later profile edits or deletion leave that copy unchanged; manual
`save_presentation` clears the copied-profile provenance. The report title receives keyboard focus after saving,
and delayed responses cannot replace a newer route or signed-in identity. Scheduled local file destinations are
described below. See the [branding delivery record](../records/DELIVERY-2026-10-01-PROFILE-BRANDING.md).

**Workbook setup** in Operations (`/operations?bindings=1`) lists saved local workbook associations. Search
by name/ID or an exact saved spreadsheet ID, follow pagination and open the original association to see linked
saved queries. These records do not prove current Google Sheets access, and workbook runs still store output
locally. Overview delivery destinations are separate. No stored URL or private preference is shown.

`amcp_workspace report_bindings` accepts `search`, `spreadsheet_id`, `offset` and `limit` (1–100), scanning at
most 50 records per call; follow `next_offset` even after an empty page. `report_binding {id}` returns a
`binding_version` and up to 100 query links, with the total and truncation flag. Current access to every linked
query is required; empty setup belongs to its creator or a workspace administrator. A viewer can inspect.

Review a local name with `preview_report_binding {id,binding_version,binding:{spreadsheet_name}}`, then explicitly
confirm `save_report_binding` with the same fields and `confirmed:true`. Names are single-line, 1–120 characters.
The transactional version includes the binding and all linked query revisions. Edits invalidate the website
preview and pending confirmation. This changes only AMCP's saved name: the spreadsheet ID, external name/access,
stored preferences, queries, schedules and existing runs are unchanged. No external permission or rename is implied.

To move a query to another existing association, open it and choose **Move saved query**. Search the accessible
workbook list, choose one destination and review both spreadsheet IDs plus schedule counts. Confirm the exact
move: all linked schedules move together and become paused; review/resume each separately when ready. The query
configuration and old runs stay unchanged, and one new report is prepared without submission.

MCP: call `preview_report_query_move {id,query_version,target_binding_id}` with the current query version.
Confirm `move_report_query` with the same fields, returned `rebinding_version` and `confirmed:true`. Refresh and
review again after any stale-version error; do not automatically resubmit an uncertain mutation. Current access
to every query in both associations is required. At most 100 linked schedules can move; the target supports
500 queries total.

After moving all queries and schedules away, its creator or a workspace administrator can review **Retire workbook
setup**. This preserves the original ID and private settings and hides it from active lists. Choose **Retired**
or **All** in the workbook-state filter to inspect it and review restoration. Until restored, the association
cannot receive queries or changes. Orphaned/paused schedules also prevent retirement; nothing is deleted.

MCP: `preview_report_binding_state {id,binding_version,active:false}` reviews retirement; use `active:true` for
restoration. `save_report_binding_state` adds `confirmed:true` to the same fields. State changes recheck current
creator/admin/operator authority, versions and absence of references. `report_bindings` defaults to `state:active`;
`state:retired` and `state:all` expose only currently authorized metadata.

Operations (`/operations`) uses `amcp_workspace operations` for paginated campaign plans, upload reviews, Overview
snapshots, export jobs, Overview schedules, incidents, workbook report runs (`kind:workbook_report`), workbook
schedules (`kind:workbook_schedule`) and standalone reviewed changes (`kind:write`, opened at
`/operations?write_id=<review_id>` with their state, claim and a read-only provider check; see
[outcomes and recovery](../WRITE-OPERATIONS.md#outcomes-and-recovery)), failed monitor email notices (`kind:notice`, for
their subscriber only, opened on their rule at `/monitors?monitor_id=<rule>&incident_id=<incident>` where the one
confirmed retry is offered; past their 24 hours they read `undelivered` and leave attention) and, for workspace
administrators only, logins that need a person (`kind:connection`: `reauthorization_required`, `refresh_failed`, or
`disabled`, which is deferred; `/connections?connection_id=<id>` opens that login's Manage view, and the `next_call`,
`dashboard` with `sections:["connections"]`, reads its recorded credential health). Filter by
kind, attention category, name/ID and exact account/login.
Continue with `next_cursor` using the same identity and filters, including after an empty page with `has_more:true`.
The new feed projects only metadata and checks at most 500 candidates per call. It rechecks current engine ownership
and account grants on every page, and exposes only an original-object path and read-only next call. Updates may
move rows between pages; refresh for current state.

Activity (`/activity`) is the separate retained audit history. Search by event/action/request reference or filter
an exact account, then use Previous/Next. Empty pages may still have a continuation. Refresh starts a new window
including later events; page navigation keeps its original sequence ceiling. Ordinary members see current account
metadata and their own unscoped events. Owners see workspace metadata, including disconnected-login diagnostics.
Raw request bodies, receipts and arbitrary event fields are omitted for every role. Native diagnostic fields are
bounded and independently scoped. The underlying audit and hash chain are unchanged.

MCP `amcp_workspace history` accepts `limit` (1–100), `search`, `gateway`, `account_id`, `connection_id` and returned
`cursor`; keep the same identity/filters/page size for continuation. Each call scans up to 500 candidates and
returns up to 256 KiB of event JSON, with current authorization checked again. This is retained AMCP history,
not complete vendor history or a new integrity verification. Clients should inspect the original operation for
currently authorized payloads instead of depending on arbitrary legacy history fields.

Owner-only support bundle preview/export preserves the backend's sanitized projection. Backend error codes,
safe recovery advice and request references survive the website wrapper. First-party MCP envelopes add versioned
`meta.workflow` state, original `source_state`, exact internal path, permitted next call and required acknowledgements
when present. Native provider payloads cannot supply these links. `automatic_retry_of_mutation` is always false.
Its schema is declared under `meta.properties.workflow` in the `outputSchema` of every AMCP tool, so an SDK client
validates it (MCP-07). `amcp_write` carries it as well: `inspect`; `review_required` after prepare; `running` with the
`amcp_campaign verify` call after an executed write; `attention_required` for a provider-reported failure or an
uncertain execute, whose next call reads the review's history instead of sending it again; `blocked` for an execute
refused before anything was sent. Each action of the AMCP tools has a contract row (`src/first-party-contracts.ts`):
its arguments as JSON Schema, effects, least role and usual next calls, served by `amcp_tool_help {gateway,
operation}`. An argument the action does not read draws `meta.argument_warnings`; `MIRROR_FLAGS
{"actionArguments":"enforce"}` refuses it with `INVALID_ARGUMENT` naming it.
The path comes from an explicit table by tool and action (MCP-09): a plan opens `/campaigns?id=`, a media review
`/media?review_id=`, a captured report `/reports?id=` and an Overview snapshot `/reporting-overview?report_id=`.
Overview `export`, `retry` and `cancel` return the `report_id` they belong to, so their link opens the report and not
the export or job; a media variant, which no page loads, gets no link. On an HTTP deployment `website_url` adds the
absolute address on the configured public origin; stdio, which serves no website, returns `website_path` only. A
`next_call` naming a tool the deployment does not list is withheld. `tests/mcp-handoff-links.test.mjs` opens each
link for its owner and checks that another workspace is refused.

**Website navigation and deep links (WEB-06).** Every workspace page is listed once in `web/routes.js`: path,
canonical name (the navigation label, owner decision D27), group, former names, test-account scope and whether a
sign-in may return to it. Tab title, breadcrumb, heading, command palette, client routing, sign-in returns and
test-account scope read it; `tools/check-routes.mjs` (part of `check-web`) fails when the navigation in
`web/index.html`, the lazily loaded page assets or the server's shell pages drift from it. The palette finds a page by
its navigation name, its former names ("Media library", "MCP connectors", …) and their Arabic translations. **Help**
(`/help`, DOC-03) has no sidebar link: the shell footer and the palette open it for signed-in members, and the server
(`server/help-routes.ts`) adds the owner guide to that page only for a signed-in member, as escaped HTML that
`tools/help-pages.mjs` builds from `docs/owner/` and `docs/owner/ar/` (`npm run docs:index:check` fails when it is
stale); a signed-out visitor goes to sign-in, and the page is never cached or listed for crawlers. The access
line combines the person's role with the deployment switch; the sidebar workspace card switches workspaces in place
(private state is reset); a failed shell action stays as an inline alert until the next action. Hand-off links only
preselect, they never read a provider or save: `/campaigns?recipe=&profile_id=&connection_id=&account_id=
#campaign-create` (playbook "Build a campaign", Capabilities "Open workflow", a `recipe_eligibility` result's
`website_path`), `/campaigns?clone=1&connection_id=&account_id=&source_id=#campaign-clone` (Portfolio "Clone into a
draft", supported gateways with write access) and `/reports?connection_id=&account_id=&campaign_id=#report-capture`
(Portfolio "Capture evidence for this campaign"; Snapchat opens the parent-scoped ad-squad preset). A value the
person cannot use is named ("Previously selected account — check access"), never replaced by another. Portfolio keeps
the account and drill-down in its address: Back returns to the parent level, and a reload restores the selection and
waits for *Read inventory*. Google, Snapchat and X micros show the exact account-currency decimal beside the native
value; Meta and TikTok amounts stay unconverted. `tests/route-registry.test.mjs`, `tests/website-navigation.test.mjs`,
`tests/website-deep-links.test.mjs` and `tests/portfolio-url-state.test.mjs` cover these. Since the design review of
2026-10 each navigation label takes the row beside its icon and reads from its start (the icon's 20 px box had held
the label too, breaking two-word names word by word), the links of an opened group are 14 px; Home's one primary
action is **Set up connections** until an account is connected, then **New campaign plan**; a platform the
deployment has not set up offers **Set up →** only to the site administrator, whose Settings hold its setup (everyone
else reads "Administrator setup required" on the card); and Home and Schedules no longer download the campaign plan
and review code they never call.

**Website composition and markup (WEB-07).** A page's lazily loaded scripts are its registry entry's `assets`. Scripts
extend the shell through `AMCP` (`web/routes.js`): `AMCP.routes.register(path, {render})` gives a workspace page its
body (one per page; a second is refused; Live portfolio, Measurement and Commerce register theirs from their own
modules, see [website feature loading](../operations/OPERATING-CONTROLS.md#website-feature-loading)), `AMCP.routes.extend(path, part,
{order})` adds a part after the page in a declared order (the owner's Settings sections at 10, account access at 20;
account security on `/account`), and
`AMCP.hooks.beforeRender`/`afterRender` run around every render (test-account scope). Nothing reassigns `render`,
`renderSettings` or `renderAccountPage` any more, and identity.js's replaced sign-in builders are gone;
`tools/check-extensions.mjs` refuses the pattern in `check-web` and `tests/web-extensions.test.mjs` covers the order.
New markup is escape-by-default: in `` html`…` `` (`web/localization.js`) every `${}` value is escaped unless it is
already markup (another `` html`…` ``, a list of them, or `raw()` for a fragment AMCP escaped itself); `null`,
`undefined` and `false` insert nothing, so `` ${condition && html`…`} `` shows nothing when the condition fails (an
attribute that must read "false" interpolates `String(value)`). The result reads as its markup wherever a string is
expected, and `setHtml` and `insertHtml` refuse a plain string. `tools/check-markup.mjs` counts, per script, the HTML
writes and values still
escaped by hand (`tools/web-markup-baseline.json`, which only goes down) and refuses a conversion that would show
markup as text or escape a value twice; `tests/web-markup.test.mjs` renders hostile provider strings as text.

**Workspace search in the palette (WEB-09, owner opt-in).** Beside the pages, the palette (Ctrl+K, "Search workspace")
lists, under **In this workspace**, up to five each of the campaign plans, saved reports, report snapshots, uploaded
media and accounts whose name or ID contains the query (two characters or more, after a short pause). It asks
`POST /api/workspace-search` (`server/workspace-search.ts`; the search text stays out of addresses): plans, snapshots
and media come from the same list operations their pages use, as the signed-in person, so another member's unshared
plan or an inaccessible snapshot never appears; saved reports are those the report builder lists to this person and
accounts those the person's logins hold, so a member limited to a client access set (SEC-08) finds only that client's
saved reports, account IDs and account names. The working client chosen in the shell narrows every kind to that
client's accounts, and a client that is not the person's to choose is refused (`PROFILE_NOT_FOUND`), never ignored. A
search sends no provider request and saves nothing (each first-party call only adds to its tool timing counters). A result only opens its page (`/campaigns?id=`, `/reporting-overview?view_id=` or
`?report_id=`, `/media?asset_id=`, `/connections?connection_id=`); nothing runs from the palette. Results belong to
the identity and the query that asked for them: a newer query wins, and signing out or switching workspace clears
them. A test account keeps the page list only. `tests/workspace-search.test.ts` and
`tests/website-entity-search.test.mjs` cover this.
Monitoring adds `attention_required`, `deferred` and `complete` outcomes without replacing factual incident state.
The synthetic SDK journey tests measure calls and response bytes; external MCP client acceptance is separate.

Workbook runs open `/operations?run_id=<original-id>`. `amcp_workspace report_run` takes that `id` and returns a
bounded status, original query revision, current account/login, attempt count and retained-result availability.
Prepared runs need explicit execution and appear under Attention; queued runs already await a worker. Operators
can resume prepared, failed or cancelled runs after confirmation with the displayed `run_version` through
`resume_report_run`. A changed run requires refreshing; queued/running/completed work is not restarted. The worker
retains its current-creator and independent read-only checks. A rejected write query requires a corrected new query.
Rolling dates resolve at execution, so a resumed rolling run may collect a different date window.

The older `amcp_native_action get_reporting_run_status` now returns this metadata summary; use `get_reporting_run`
to retrieve retained input/results explicitly. Both reads and `execute_reporting_run` recheck the saved run's account
scope and current connection access, independent of later query edits. Native compiler account aliases in structured
argument bags are recognized and conflicting anchors are refused. Jobs whose scope exists only in opaque body
strings, resource paths or provider results remain unavailable until a new explicitly scoped query is prepared.
Unscoped historical runs are not assigned an account by guesswork. Full job inputs/results, encrypted actor bindings,
leases and raw errors are absent from status and the feed. Legacy workbook bindings still describe local storage;
this view does not establish a live Google Sheets destination. See the
[workbook Operations delivery record](../records/DELIVERY-2026-10-01-WORKBOOK-OPERATIONS.md).

Workbook schedules, shown as **Local report schedules**, open `/operations?workbook_schedule_id=<original-id>`, also
reachable from Schedules. Their runs (shown as **Local report runs**) keep results in AMCP and never write to the saved
spreadsheet; the page says so and links to Reporting overview, where a schedule delivers to Google Sheets.
Inspect the current saved query revision/account and the next three clock occurrences, then edit the name,
hourly/daily/weekly/monthly clock and explicit IANA timezone. The saved query still controls report date windows;
changing the clock timezone does not change the query timezone. Before confirmation, a server preview validates
the proposed fields and shows their changes and three future times. Pausing prevents future enqueues while existing
queued/running work retains its state and saved query. Resuming uses the operator's current access and the next future
occurrence, without creating a catch-up job. Monthly dates clamp to the last day of shorter months; a nonexistent DST
time runs at the first valid time after the change (`dst_shifted` in the previews) and repeated local times run once. Previewed times remain visible while paused and are labeled as
clock previews. A last-run link appears only when the user still has access to that original run.

`amcp_workspace report_schedule` returns bounded metadata and `schedule_version`. Send that version with `id`,
`active` and `schedule:{name,timezone,schedule_kind,minute,hour,weekday?,day?}` to `preview_report_schedule`.
The preview makes no changes. Save through `save_report_schedule` with the same fields and `confirmed:true`.
The server rechecks current scope, operator access, schedule revision and saved query revision transactionally.
`STALE_REPORT_SCHEDULE` requires refresh and another review. Readers can inspect but cannot save. This editor
keeps query identity and workbook binding intact and does not configure external spreadsheet delivery.
See the [workbook schedule delivery record](../records/DELIVERY-2026-10-01-WORKBOOK-SCHEDULES.md).

**Move to Reporting overview (EXP-04, owner policy P6).** A local schedule can move into Reporting overview, which
delivers to the workbook's own spreadsheet. The move is explicit and reversible, and it never changes the saved query
or its revision. *Check whether it can move* (`amcp_reporting_overview preview_workbook_move` with the schedule `id`)
is a dry run: it saves nothing, makes no network request, converts the saved campaign query into one Overview report
source (platform, account, login, rolling window, native metrics; compileReport's day, month and all grouping become
daily, monthly and total rows) with the schedule's own clock, and lists the Google Sheets report tabs that Reporting
overview bound for the workbook's spreadsheet (`bind_destination` verified each with an authenticated read). A query
without an exact equivalent is refused with its reasons and stays local: a native provider request, fixed dates, an
ad set or ad level, another grouping, campaign filters or other settings, or unusable metric names. With a tab chosen
(`destination_id`), the preview returns `move_version`; *Move to Reporting overview*
(`move_workbook_schedule` with `move_version` and `confirmed:true`, operator role) creates the report and its schedule
on that tab and pauses the local schedule in the same transaction (`pause_reason: migrated_to_overview`). A paused
local schedule moves as a paused Overview schedule; an active one delivers at its next occurrence under the mover's
current access. While moved, the local schedule cannot be enabled (`WORKBOOK_SCHEDULE_MIGRATED`). *Undo the move*
(`undo_workbook_move`, `confirmed:true`) pauses the Overview schedule, keeping its report and snapshots, and restores
the local schedule as it was; one whose saved query changed meanwhile stays paused for review
(`query_definition_changed`). A changed schedule, query or tab after the preview is `STALE_WORKBOOK_MIGRATION`; a tab
of another spreadsheet is `WORKBOOK_DESTINATION_MISMATCH`. Moves and undos are audited
(`workbook_schedule_migrated`, `workbook_migration_reverted`).

Operations also lists **Saved workbook queries**, with search and continuation through authorized records.
Open a query directly at `/operations?query_id=<id>` or follow its original run/schedule link. Edit its name and
explicit dates, complete-day window or last complete calendar week/month. Rolling windows use the specified
report timezone, independently of the schedule clock. An advanced native read has a JSON editor; account/provider/
connection are fixed and credentials belong in Connections. Review the exact proposed settings and number of
schedules to pause, then confirm. A changed definition pauses active schedules for separate review/resume and
creates one prepared, unsubmitted report. Naming alone keeps schedules active. Existing runs remain unchanged.

`amcp_workspace report_queries` accepts search, account/connection/spreadsheet filters and offset/limit; follow
`next_offset` even if a page has no visible results. `report_query` returns `query_version`; use it with `id` and
`query:{name,query_config}` in `preview_report_query`, then `save_report_query` with `confirmed:true`. Query or linked
schedule changes invalidate the version and require refresh. The returned `prepared_run_id` links the original
unsubmitted report. Viewer access cannot save. The legacy setup bootstraps now require current query scope and
withhold oversized bodies; they do not establish a live Sheets destination. They also list, under
`provider_deprecation_warnings`, each saved Reddit report (with its schedules) that Reddit's 2026-12-08 breakdown rules
will refuse; from that day AMCP refuses such a run with `PROVIDER_DEPRECATED` before any request. See the
[saved query delivery record](../records/DELIVERY-2026-10-01-REPORTING-MANAGEMENT.md) for limits and qualification.

Client packs can also be delivered on the existing report schedule to a local **PDF / Excel destination**.
Create it in the delivery dialog with explicit formats, branding and storage confirmation; a Sheets connection is
optional for this flow. Schedules collect their original scoped definition and queue a separate file job from the
retained snapshot. Delivery status, history and Operations preserve the original export ID and job. Successful
formats survive a failed-format retry, and each download rechecks current source access. The job freezes its
branding and source fingerprint. Encrypted files follow snapshot deletion/retention, with 20 MiB per-file and
256 MiB encrypted-storage limits per workspace. Complete-only partial snapshots remain undelivered.
The [reporting guide](../REPORTING-OVERVIEW.md#scheduled-pdf-and-excel-files) documents the shared MCP contract,
queue limits and recovery. External email, Drive-folder and object-storage file destinations are not implemented.
