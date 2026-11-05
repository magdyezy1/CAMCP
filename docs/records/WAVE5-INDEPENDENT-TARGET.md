# Wave 5 rounds 1 and 2: independent engineering target

Written by the principal engineer (Claude Opus 5.5) on 2026-11-05, before reading `Codex changes.md`, the round 2 plan,
any handover file or any Wave 5 diff. Inputs were the approved plan (`wave5-plan.md`, including sections 12 and 12.1),
the `Work-here` baseline at 4035ad7c, the read-only evidence collected on 2026-11-01 and the public provider
documentation pins. This file records what the implementation must do and how it should be built, so the audit that
follows measures the code against an independent standard rather than against its own explanation.

Terms: **R1** and **R2** are rounds 1 and 2. **Dn** is an owner decision from section 12 of the plan. A "probe" is a
specific input the audit must run or trace, chosen because it is where a plausible implementation breaks.

## 1. Required behaviour

The owner's outcomes that rounds 1 and 2 must deliver:

| Owner ask | What must be true after round 2 |
| --- | --- |
| Reporting at campaign, ad group and ad level | One report holds all three levels for one account on every three-level platform. Each row names its parents. |
| Objective attributed to the campaign | Every row at every level shows its campaign's own objective from the platform. A user choice only fills a gap, or overrides one named campaign. The result metric follows the objective. |
| TikTok and LinkedIn reporting work | TikTok campaign and ad group reports return rows. LinkedIn shows spend, objective-led results, readable names and complete windows. |
| Charts in exports | Round 2 delivers the chart definition and the renderers. The PDF, XLSX and HTML layouts themselves are round 3. |
| Fluid website | Round 2 delivers the component set and the new shell and information architecture on real pages. |
| AMCP as an MCP server for LLMs | SDK v2, a typed reporting contract, tasks, progress, a truthful annotation surface and bounded responses. |

Non-negotiable anti-goals from the plan, which count as failure even if everything else works:

- totals that look complete but are not;
- a prettier site that is slower, less accessible or worse in Arabic;
- breaking saved reports, schedules or MCP clients;
- charts that mislead (mixed currencies, summed different result types, truncated axes, dual axes);
- previews that leak creatives or links outside the workspace.

## 2. Assessment of the baseline

### Strengths to keep

- **Reviewed-write model.** Approval, caps, spend policy, idempotency and reconcile are mature and must not change.
- **Collection engine.** Whole-job budget, per-source checkpoints, lease checks and actor rebinding in
  `OverviewReports.work()` are sound. Resume must keep working.
- **Registries.** `ReportSource`, `GuidedReporting`, `DetailParentReader` and `ProviderAdapter` give provider code a
  place to live. The seam rule (shared modules name no provider) is the right pressure.
- **Honest unknowns.** Null stays null, exact decimal strings exist for detail totals, and recommendations hold when
  data is partial.
- **Website foundations.** One route registry, escape-by-default `html```, a strict CSP, logical properties, Arabic
  chunks, snapshot-served assets and 1,392 browser cases.
- **Gates.** Token, colour, markup, route-byte, oracle, seam and docs ratchets.

### Weaknesses that drive the redesign

- `reporting-overview.ts` is a 1,836-line module holding schema, validation, bootstrap, job control and row assembly.
  Multi-level reporting must not be bolted into `work()` by copying.
- One level per platform and one source per account, so a snapshot cannot hold a hierarchy.
- The objective is resolved in three places, and the user's choice beats the platform.
- Summaries are all-or-nothing: one null blanks a total.
- Every row copies the whole lineage, then `sources` repeats it.
- Rules a client must know live only in code (`overviewSourceLevel`), and the website invents the defaults.
- `config` is an opaque object in the MCP schema, and every tool shares a generic output schema.
- Native gateways declare `readOnlyHint:false` only because an upload can save a media review.
- `server/mcp-modern.ts` hand-rolls the 2026-07-28 framing because SDK v1 cannot serve it.
- The shell has 14 breakpoints, four badge components, 468 hand-written spacings and a route change that blanks the
  page.

## 3. The redesign I would build

### 3.1 Reporting engine

**One rule table, read three ways.** A single server table of levels, option rules and defaults per platform feeds
config validation, the bootstrap payload and the generated MCP input schema. Nothing else may restate the rules. If a
rule exists in two places the audit counts it as a defect, because that is exactly the drift the plan set out to end
(principle 2).

**Source and level.** A v4 source names one account and `levels`. `level` stays accepted as a one-item list. Collection
expands a source into source-by-level units; each unit has its own checkpoint key inside the same budget, so a resumed
job neither re-collects a finished level nor double-counts its requests. A v3 snapshot already in flight must resume on
its v3 path.

**Row assembly leaves `work()`.** Building a row, resolving its objective and result, and producing coverage are pure
functions in their own modules, testable without a job. `work()` keeps job control only.

**Stored forms.** Saved definitions, schedules and snapshots read v3 and write v4, and the v3 fields stay beside the v4
fields so that `Work-here` can still read a definition after a rollback (D21). Old snapshots render as recorded. They
are never recomputed.

**Lineage once.** Lineage is stored per source. Rows carry `source_ref`. `get` returns neither lineage nor raw native
rows unless `include` asks. The target is under a third of today's bytes for a three-level TikTok get.

**Coverage.** Every sum carries `{value, known_rows, total_rows}`. A ratio uses only rows where both parts are known and
says so. Row values stay null when unknown. Money is never added across currencies. Different result definitions are
never added. The cross-level check compares additive totals of two levels of one account and window, and reports
"Levels agree" or the gap.

**Defaults.** `report_options` is optional. The server applies documented defaults and echoes what it applied. A detail
run without a complete-window declaration runs, is marked "window not declared complete", and holds recommendations.

### 3.2 Objective and result

Precedence is exactly: per-campaign `user_override`, then `provider`, then `provider_mapped`, then `user_fallback`, then
`unknown` with a specific reason. The regex table survives only as `provider_inferred` for values the pinned tables do
not know. Result selection is a pinned table per platform behind the `ReportSource` seam: shared code asks the source,
and never names a provider.

Results follow section 4.3 of the plan. The platform's own number wins where it exists: Meta `results` and
`cost_per_result`, TikTok `result` at ad group and ad level. LinkedIn uses the pinned pairing. Campaign rows on TikTok
sum ad groups only when they share one optimization goal, and otherwise show per goal. Summaries group by result
definition. An account with mixed objectives shows one group per objective.

### 3.3 MCP

- **SDK v2** is one package of work with nothing else in it, so that it can be reverted alone. No v1 import may remain.
  If v2 serves the 2026-07-28 revision natively, AMCP's hand-rolled framing should be retired rather than kept beside
  it, unless a measured behaviour requires it.
- **Typed `config`** is generated from the rule table in 3.1. The schema tightens the description of the input; it must
  not loosen the code-level checks, and an old client's valid call must still validate.
- **Typed outputs** are real schemas for `amcp_reporting_overview` and `amcp_reporting`, tested with AJV against real
  responses, including error envelopes.
- **Tasks** are offered only when the client declares the extension. Polling and `next_call` stay for everyone else.
  A task handle must be bound to tenant and actor, unguessable, and refused to anyone else.
- **Progress** is sent only when the client passes a `progressToken`.
- **Truthful annotations.** A native gateway may say `readOnlyHint:true` only if no call through it can change state,
  including AMCP's own state. Saving a media review counts as state.
- **Response budget.** A list result over budget is cut at a row boundary with `truncated`, counts and a continuing
  `next_call`. The continuation must be bound to the caller. Website calls are unaffected. Defaults that change for
  existing clients are announced in round 2 and stay opt-in per client from round 3 (D26).
- **D17** holds: the frozen help schema stays byte-identical in `tools/list`.

### 3.4 Charts

One chart specification computed on the server, three renderers. The spec is data, so an MCP client receives it too.
The renderers must share scale, tick and label-placement maths rather than reimplement them. Because the site has no
build step, the sharing mechanism is the hard part: a duplicated implementation is only acceptable with a parity test
that fails on any drift. Provider-supplied names reach SVG strings, so output encoding is a security requirement.

### 3.5 Website

Stay framework-free. New components are written with `html```, add zero raw HTML writes, carry every state and work in
RTL and both themes. The shell keeps the header and frame during a route change, shows skeletons and fills sections as
data arrives, so one failing section cannot blank a page. `web/routes.js` stays the only registry for navigation,
server shell routes and asset order. `web/mark.svg` stays byte-identical. Pages not yet moved keep working through
token aliases, and only finished screens ship (D25).

## 4. Module boundaries

| Concern | Owner | Must not |
| --- | --- | --- |
| Level, option and default rules | one table module | be restated in `web/`, schemas or docs by hand |
| Stored-form upgrade (v3 to v4) | one pure module | mutate stored records on read |
| Objective resolution | pure resolver plus per-source tables | name a provider in shared code |
| Result selection | per-source tables behind the seam | sum across result definitions |
| Coverage and cross-level | pure module | read the store |
| Collection | `work()` and collectors | assemble rows inline |
| Chart spec | pure server module | render |
| Chart renderers | SVG string, pdfkit, DOM | compute different scales |
| MCP transport and protocol | `server/` | contain report rules |
| Tool contracts | `src/` | import the SDK |

Shared modules import provider modules only through the registries (`tools/architecture-map.mjs`).

## 5. Compatibility obligations

1. v3 definitions, schedules and snapshots run or render unchanged (principle 9).
2. A stored definition written by V2 must be readable by `Work-here` at 4035ad7c (D21): `level`, `objective` and the
   other v3 fields stay valid for that code.
3. A saved hand-chosen `objective` keeps overriding through round 1. In round 2 it becomes a fallback, with a one-time
   "numbers changed" note on the next delivery and in History (D22).
4. Saved LinkedIn reports show campaign groups in the campaign position from round 1, with a one-time note, and their
   stored definitions are not rewritten.
5. Clients on today's protocol versions and on 2026-07-28 both work.
6. Tool changes are additive, or announced in tool help before removal. `level` stays an alias.
7. Bookmarks keep working: paths stay and labels change. `/reports` stays Evidence and analysis, and
   `/reporting-overview` stays the builder's route.
8. The shell's test hooks (`.skip`, `#menu-toggle`, `.main-shell`, `.sidebar-close`, `#command-dialog`,
   `body.menu-open`) survive where possible.

## 6. Security controls

- **Tenant and client boundaries.** Every new read, filter, cursor, task handle and bootstrap field respects
  `resolveConnection`, client access sets and `overviewRecordListed`. A report filter may narrow, never widen.
- **Reviewed writes.** Unchanged. No new route, no changed cap, no write through a read gateway.
- **Cursors and continuations.** Signed or server-held, bound to tenant, actor, scope and arguments, and refused when
  reused against another scope.
- **Secret redaction.** The Snapchat allowlist applies in the preview path only. Everywhere else URL secrets stay
  redacted, and a test must prove it.
- **Output encoding.** Names, copy and labels from providers reach SVG, HTML, CSV and XLSX. They must be escaped, and
  the formula guard must hold.
- **Error detail.** Upstream code, message and request ID reach the user after sanitising, and never a token or a
  signed URL.
- **Resource limits.** Multi-level collection counts against the existing budget. LinkedIn's split requests and X's
  chunked requests are bounded. Response budgets and caps cannot be raised past a fixed ceiling.
- **Audit.** State changes through new paths are journalled as existing ones are.

## 7. Error handling

- A provider-data failure uses a non-HTTP status and the "provider data" category. Its card offers Retry, not "Manage
  connections", and never shows "HTTP 400".
- A refused TikTok page keeps exactly the six page facts, without metrics or IDs.
- One failed source yields a partial report, and every failed source yields `failed` with reasons.
- A failed unit of a multi-level source must not discard the source's finished levels.
- Retry after failure is idempotent: no doubled rows, no doubled budget.

## 8. Platform semantics that must hold

- **TikTok.** Requests carry STATUS_ALL and `enable_total_metrics`. Daily windows split at 30 days. Pages run
  1..total_page. A page longer than page_size, or more rows than declared, is refused. Fewer rows are kept and marked
  partial with both counts (D2). Collection is complete when additive sums equal `total_metrics`, independent of page
  counts. "-" is unknown. Campaign-level results are "-", so they roll up from ad groups.
- **LinkedIn.** Position map: campaign group, campaign, creative (D5). The window resolves in UTC. Absent cost with
  zero impressions and zero clicks is spend 0 marked `provider_omitted` (D3), and absent cost with any delivery stays
  unknown. At most 20 metrics, 15,000 elements with no paging (split near the cap), reach for 92 days or less. Names
  are the creative's `name`, else "Ad <id>", never a URN.
- **Meta.** Objective comes from the campaign. Results are read with the row's `optimization_goal`. A named preview ID
  is read directly, not through the first page.
- **X.** A null metric equals 0 as `provider_omitted`. Synchronous stats take at most 20 entities and 7 days per
  request. Spend is in micros. Line items that differ make a campaign "mixed".
- **Snapchat.** Ad squads across all campaigns of the source. The one-campaign UUID rule goes. The optimization goal
  selects the result. `creative_preview_link` has a 90-day lifetime.
- **Zones.** LinkedIn UTC; Meta, TikTok and Snapchat the account zone. A run at 01:00 Cairo time must give a complete
  LinkedIn window.
- **Apple.** Doc-shaped fixtures only, because it is not connected (D24).

## 9. Required tests

Each acceptance criterion in section 11 needs a test that fails without the change. Beyond those, I require:

- stored fixtures of every config version run through the upgrade, and the result read by a copy of the baseline
  validation;
- a resume test across every collection unit of a multi-level source;
- a property-style test that a summary never adds across currency or result definition;
- an AJV check of the output schemas against real responses, including refusals;
- protocol tests for a legacy client and a 2026-07-28 client through the real HTTP stack;
- hostile-name tests for every renderer;
- browser cases for each component in EN and AR, in both themes;
- tenant-crossing tests for every cursor and task handle.

Test names that touch writes, sessions, tokens and the like must pass the oracle rule (`tools/check-test-oracles.mjs`).
Fixtures for providers are shaped from the documentation, never built to agree with themselves, because that is how the
TikTok defect shipped.

## 10. Performance and UX expectations

- Route bytes stay inside their budgets, and Arabic should fall.
- A three-level TikTok `get` is under a third of today's bytes.
- `tools/list` is measured, and re-recorded under D14 only.
- A route change keeps the shell visible.
- No clipped sidebar at 800px height. A one-row top bar at 320px.
- Text is 12px or larger. Targets are 24px or larger, and 44px for primary actions.
- WCAG 2.2 AA in both themes and both languages from 320px.
- Long reports show progress as sources finish.

## 11. Acceptance criteria

These are the plan's criteria, restated as the checklist the audit will mark. "Live" items need staging and stay
unverified without it.

### Round 1

| Ticket | Criteria |
| --- | --- |
| V2-RPT-01 | Fixtures give the specified outcome for: short last page, empty first page with total_number above 0, total_page basis mismatch, changing totals, duplicate tuples, more rows than declared, total_number 0, missing page fields, rows that do and do not sum to total_metrics. Requests carry STATUS_ALL and enable_total_metrics, and spans stay within 30 days. "-" is unknown. Error details carry the page facts. Live: both levels return rows on both advertisers, page_info recorded. The cross-check reports agreement or the gap. |
| V2-RPT-02 | Every platform with a native objective: campaign, middle and ad rows carry it, with source provider. LinkedIn creatives carry their campaign's objective; groups follow the three steps. A fallback never replaces a provider value; an override wins and is labelled. New and edited reports store `objective_fallback` and `objective_overrides`. A saved hand-chosen objective keeps overriding until RPT-06. Reasons are specific. Live: TikTok ad rows, LinkedIn creative rows, Meta campaign rows. |
| V2-RPT-04 | Three levels return rows with parents and native labels, and the overview and guided presets share one mapping. Group objective fixtures for each step; "Mixed" shows results per objective. Saved LinkedIn reports carry the one-time note on next delivery and in History, definitions unchanged. Zero-delivery fixtures give spend 0 marked platform omitted. The summary shows spend, CPC, CPM and CPA. Readable names. Fake clock at 01:00 Cairo gives a complete UTC window. Live: 7-day report at three levels. |
| V2-RPT-05 | Unit tests for the mapping. A data error's card shows neither "HTTP 400" nor "Manage connections". Preview errors carry upstream detail. |
| V2-PRV-01 | An ID outside the first 100 is previewed. Paused and old ads are excluded by default. Cursor paging. Campaign and ad set filters. |
| V2-PRV-02 | `account` is sent and allowed by the authorizer. The contract is pinned. The iframe src is the link, with a 3-hour expiry. Doc-shaped fixture; upstream detail shown. Live: a creative returns a link. |
| V2-PRV-03 | The field passes unredacted in previews only; a test proves redaction holds elsewhere. expires_at is shown. Live: the link opens without login. |
| V2-MCP-01 | next_call after run and export_status. Summaries name every confirmation action and role, plus previews. Schema limits equal code limits, with defaults in the schema. Docs fixes. Every first-party tool answers `action:"help"`. No description advertises an argument its schema lacks (a test reads every description). tools/list measured under D14. |
| V2-WEB-01 | Old tokens aliased. Token and colour checks pass. Contrast checked for every text and control pair in both themes. Arabic subset to WOFF2. Route bytes measured. `web/mark.svg` unchanged (hash). |

### Round 2

| Ticket | Criteria |
| --- | --- |
| V2-MCP-13 | v2 packages at the approved versions, nothing left on v1. Every MCP test and journey passes unchanged, eval:mcp unchanged. Clients on today's version and on 2026-07-28 both work. D17 byte-identical. tools/list measured. Container parity and full gate on the rebuilt dependency folder. supply-chain-risk-auditor and differential-review recorded. |
| V2-RPT-03 | Pinned tables tested value by value. A Meta row's result equals insights `results` for its goal. A TikTok ad group's result equals its `result` metric, and campaign rows combine ad groups only when they share a goal. LinkedIn lead-gen reports oneClickLeads, and awareness reports reach for 92 days or less. Mixed-objective summaries never add different results. Meta detail runs without `result_action_type`. |
| V2-RPT-06 | Saved hand-chosen objectives become fallbacks, with the one-time note (D22), v3 forms stay readable (D21). A snapshot holds campaign, middle and ad rows on each three-level platform. Scope filters work, and requests are estimated per level. A get without include carries no lineage, and a 3-level TikTok get is under a third of today's bytes. v3 definitions and schedules run unchanged; old snapshots render as recorded. Totals carry coverage; the cross-level check is shown. Defaults are echoed and listed in bootstrap. |
| V2-RPT-07 | A fixture per platform and level. Bootstrap names every level natively. Live per platform. Apple through an owner runbook step. |
| V2-EXP-01 | Golden SVGs per chart type. PDF render check by text extraction. Palette validator passes in both themes. Every chart has its table. Web charts are axe-clean with keyboard tooltips. Charts never mix currencies or results. |
| V2-MCP-02 | Typed config. Bootstrap returns option rules and defaults. Filters on get and list. Include flags. Typed outputSchema for both tools. Progress with a progressToken. Tasks where declared. Polling and next_call kept. Eval cases pass, and schemas validate real responses. |
| V2-MCP-06 | Annotation tests show native gateways read-only. Media hand-off returns MEDIA_REVIEW_REQUIRED with a next_call. Truncation and continuation tested on every list path. Guide sections under a size cap. Response and tool-list bytes measured (D14). New defaults announced in round 2, opt-in per client from round 3 (D26). |
| V2-WEB-02 | A members-only component page shows every state. Zero raw HTML writes. Browser cases per component in EN and AR, both themes. |
| V2-WEB-03 | check-routes passes on the new registry. Keyboard, drawer and geometry cases updated. No clipping at 800px height. One-row top bar at 320px. Section-level loading. Error links follow `parent`. |

## 12. Audit probes

Specific inputs I will trace or run, chosen because a plausible implementation fails them:

1. TikTok: rows that sum to `total_metrics` but declare more rows than they list. Expected: complete, with no false
   partial. Rows that fall short of both. Expected: partial with both counts.
2. TikTok: a 62-day daily window. Expected: three spans, and `total_metrics` compared per span.
3. TikTok: an empty report where page fields are 0 or missing. Expected: empty and complete, not a refusal.
4. LinkedIn: a creative or campaign response with exactly 15,000 elements. Expected: never trusted as complete.
5. LinkedIn: zero impressions, clicks present and non-zero, cost absent. Expected: spend stays unknown.
6. A saved report with `objective: 'unknown'`. Expected: no override of a provider value.
7. A campaign override with the same ID on two accounts. Expected: applied to the right account only.
8. A failed unit of a three-level source. Expected: finished levels kept, and the report partial.
9. A job killed between two levels, then resumed. Expected: no doubled budget and no doubled rows.
10. A currency mix inside one account's summary. Expected: split, never summed.
11. A ratio where cost is known on 26 of 28 rows. Expected: uses only rows with both parts, and says so.
12. A v4 definition read by the `Work-here` validator. Expected: accepted.
13. D22 note: delivered once, never again, and shown in History.
14. A task handle or continuation used by another tenant, and by another actor of the same tenant. Expected: refused.
15. A native gateway upload after the annotation change. Expected: nothing stored, MEDIA_REVIEW_REQUIRED.
16. A chart title holding `</svg><script>`. Expected: escaped in every renderer.
17. A chart with two currencies. Expected: split or refused.
18. A truncated result continued with changed arguments. Expected: refused.
19. A client that validates against `inputSchema` calling with an old `level` string. Expected: valid.
20. A route change on a slow connection. Expected: shell and header stay, and focus lands correctly.
21. Sidebar at 800px height with every group open, in Arabic. Expected: nothing clipped.
22. A viewer or test account reaching a new route. Expected: the same gates as before.

## 13. Decision rule

After the audit I will choose keep, rework or rebuild by evidence:

- **Keep and improve** if the structure matches sections 3 to 8 in substance, and the defects are local.
- **Substantial rework** if a major module violates a boundary or a compatibility obligation, but the rest stands.
- **Clean rebuild from `Work-here`** only if the foundations are unsound or unsafe, or if repair would cost more and
  risk more than replacing them.

A different design from the one above is acceptable where it meets the same requirements and is demonstrably no worse.
I will not rewrite sound code to make it look like this document, and I will not lower this document to fit the code.
