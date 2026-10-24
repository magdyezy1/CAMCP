---
status: reference
tier: operator
---

# Find and resume work

Home, the navigation and deep links, the working client, the interface language and how pages load. Sections of the [workflow guide](../PRODUCT-WORKFLOWS.md), moved here with their text unchanged on 2026-10-24 (DOC-03).

Home (`/dashboard`) links to new plans, recent plans, attention items, creative preparation, reports and account
readiness. The navigation has seven main destinations with expandable campaign, reporting, connection and
management tools. Exact plan, media review, report and evidence IDs are retained in internal links. Session expiry,
logout and workspace changes clear private drafts and invalidate pending responses. Ordinary navigation preserves
an unsaved report setup within the same identity; an explicit new report clears the old selection and destination.

**Needs attention** on Home is the Operations classifier's own page (`amcp_workspace {action:"operations",
state:"attention", limit:8}`), so Home and Operations agree (OPS-06): a plan in `attention` or awaiting review, an
uncertain upload or reviewed change, a failed export or schedule, an open incident, a failed monitor email notice and,
for administrators, a login to reauthorize. Home shows the eight most recent, because each feed page scans a bounded
number of records; **All operations** opens `/operations?state=attention`. The states that mean attention are
`attentionStates` in `src/operation-types.ts`, and a test keeps every campaign runner plan state classified. Account
readiness is a count with the accounts in a disclosure. **Capabilities and evidence** names each capability by what it
does for the owner ("Prepare campaigns that start paused", in English and Arabic, from Home's own script
`web/work-center.js`) with one sentence on what verified means; the capability names, coverage, tool names and
evidence states sit under **Technical details** (DOC-03), so Home stays short on a phone and shows no tool name outside
that disclosure (`tests/home-capability-cards.test.mjs`). **Continue recent work** still lists recent plans.

**Working client (SEC-08).** In a workspace that serves several clients, the top bar's **Working client** narrows
pickers and lists to the accounts one approved playbook binds: Home (attention items, recent plans, readiness), plans,
operations, activity, media, Drive import, push, previews, the report builder, the capabilities account picker, the
composer, clone and capture sources, Portfolio, Measurement and Commerce. It is a view filter kept in `?client=` (links
keep it), never access control; a push or plan that no one client holds asks first, and pickers preselect only a sole
remaining account. MCP callers pass the same filter as `profile_id`. Limiting what a member, token or AI client may
reach is a separate, optional client access set; see
[clients in one workspace](../USER-ACCOUNTS.md#clients-in-one-workspace-working-client-and-client-access-sets).

`amcp_workspace {action:"capabilities", gateway?, workflow_id?, account_id?, connection_id?}` projects executable
campaign recipes, Overview adapters, detailed capture presets, media routes and conditional programs into workflow cards. Exact workflow
and account/login filters expose dependencies, lifecycle handoffs, native actions, registered review families and
their evidence paths. The recipe dependencies are tested against the compiled plans. Recorded scopes and current
local access are prerequisites; a dated successful account read is separate evidence, never objective acceptance.
Readiness expires after 15 minutes and is invalidated by connection/credential changes. `contracts` remains the
paginated, searchable action ledger. Neither view creates a grant or replaces native preflight/review.

Graph version 3 resolves every dependency (CON-03). Each has a `status` and a `resolution` class, explained once in
`dependency_resolutions`: `resolved_locally` (exact account, destination account, currency: `ready` with a recent
account read and, for a destination, a write grant; otherwise `blocked` with the `resolver_call` that fixes it),
`user_input` (`needs_user_input`; recipes name `recipe_eligibility` with `live:false`, the website's **Check this
brief**), `collection_time` (`unknown` until the report is collected or the upload processed) and
`native_review_only` (provider and objective acceptance: always `unknown`, never ready in advance). Read workflows
check the registry's read scopes, so a Google login without the Ads scope shows `provider_scope:` on its recipes,
reports and captures; a permission Meta reports as declined shows `provider_scope_declined:` with a reauthorize remedy.
The graph stays at zero provider requests. `AMCP_CAPABILITY_GRAPH_VERSION=2` restores the version 2 placeholders.
Over MCP, `capabilities` returns a summary by default (MCP-01): per workflow its kind, effects, every per-account
blocker and evidence status (a conditional program's evidence with its last retained read), what stays unresolved and
its next call (or, for a program with no selected account, its `setup` path), 20 workflows per page (`limit` up to 25)
with a `next_cursor` bound to the caller, session and filters. A summary never upgrades an unknown to ready.
`view:"graph"` returns the whole dependency graph, unchanged apart from the `effects` each suggested call now carries
(MCP-09); the website's Capability Center asks for it. Filtering by `workflow_id`, or by `connection_id` and
`account_id`, fills each account's next call in.

The Capability Center (`/capabilities`) loads with one graph request: the graph that fills the filter choices also
answers the first page (WEB-08). It lists **Available to me** first (workflows with a selected account on their
platform), grouped by objective with counts and naming each group's platforms, and keeps the others discoverable in
a collapsed **Not available yet** group. The workflow, account and search filters stay in the address, so a reload or
a shared link shows the same view. Choosing an account asks the server again, because account-scoped prerequisites
resolve only when exactly one account is in view; a workflow link shows that workflow as it is.

Each suggested `check` or `program_check` call (in `capabilities`, the graph, `program_check` results and
`list_accounts`) carries `effects {provider_requests, saves, advertising_writes:0}` (MCP-09). `check` with
`live:false` makes no provider request and saves nothing; with `live:true` it reads the provider account and saves the
shared account-read evidence and the account's metadata (`saves:["readiness","account_metadata"]`). `program_check`
with `live:false` saves nothing; with `live:true` it keeps one timestamped observation of the read
(`saves:["conditional_program_observation"]`, owner decision D20). `saves` is the most a call saves: a read that
fails before the provider answers saves less. The labels describe what the call already does; following one never
changes an advertising account.

`check` also takes `account_ids` (1 to 20 distinct accounts of one `connection_id`, CON-05) instead of `account_id`:
every account must be selected on that login before anything is read, each gets exactly the single-account check and
its own readiness record, four at a time, and the result is a `readiness_batch` with one entry per account. The
website's **Save and check access** saves a selection and then checks the newly selected accounts this way, on that
click only.

One account-metadata resolver (`src/account-metadata.ts`, CON-05) names accounts in `list_accounts`, `recipe_context`
and `capabilities`: the last live account read, then the login's cached discovery listing, then nothing. Each carries
`metadata {source: live_account_read | cached_discovery, checked_at}` (or `null`) and `list_accounts` a `kind`
(`ad_account`, `analytics_property`, `tag_account`, `search_property`, `business_profile`, `destination`). Sheets
and Drive bindings are destinations: `list_accounts` lists them only when `platform` asks for `sheets` or `drive`, and
never suggests an account `check` for them. A connection's label is never shown as an account name.

Over MCP, `dashboard` returns a bounded summary by default: counts per provider and one row per account whose
`readiness` is the viewer's own (`ready`, `blocked`, `stale`, `unknown`, `unchecked` or `not_applicable`),
evaluated from the shared account-read evidence with the viewer's role and grants, as the website badge is (CON-03).
`sections` returns bounded detail, and `view:"full"` is the whole record the website's Overview reads.

Capabilities also offers three exact conditional programs: LinkedIn Media Planning forecast,
LinkedIn Audience Insights and one configured DV360 advertiser read. Program requirements remain
visible without a connected account. Select an exact account/login, enter the guided forecast or
geography/professional-attribute audience inputs, and explicitly inspect the native request.
The Audience Insights advanced editor preserves exact native JSON. Edits/navigation/login changes
discard obsolete results; readable evidence tables preserve original units and missing values.
Opening a saved handoff never starts a read. Private application/customer access remains separate
from ordinary account readiness, saved media plans and report-job permission.

For MCP, first use `capabilities` to select one returned `program:*` workflow. Then call
`amcp_workspace` with `action:"program_check"`, its `workflow_id`, exact `connection_id` and
`account_id`. The default or explicit `live:false` returns recorded prerequisites without native
requests. Explicit `live:true` adds `requirements:{forecast,request}` for Media Planning,
`requirements:{request}` for Audience Insights, or `requirements:{}` for DV360. Use the exact
native request shape returned by discovery/help and the guided website; arbitrary URLs/actions
are refused. The complete operation is bounded to three attempts, 1,000 rows, 2 MiB and 30 seconds.
Results save no plan, approval, report job or qualification grant. A successful observation is
specific to its original request/time; denied access is not a successful entitlement check.
A refusal keeps only allow-listed facts in `native_error`: the provider's `http_status`, a closed-set
`provider_code` (LinkedIn's documented `ACCESS_DENIED` or `USER_NOT_AUTHORIZED`, otherwise `OTHER`),
`amcp_request_id` (also `request_id` for one release) and `provider_request_id` (LinkedIn's `x-li-uuid`).
A documented code adds `provider_reported_prerequisite`, worded as reported by LinkedIn; no body or provider
message is kept and no other cause is inferred. A forecast's `singlePointMetric` may be an object or a
one-element array at the exact requested budget; LinkedIn's cost-per and average-frequency estimates are
retained as directional `directional_estimates`. Capabilities show the member's LinkedIn role recorded at the
last discovery as `member_account_access` evidence, never as current access.

`live:false` also returns `requirements_template`, the JSON Schema of the live `requirements` (the selected
account fixed, enumerations and bounds from the native validator), and `required_inputs` as argument paths such as
`requirements.request.groupBy`; capabilities carry the same template per program. A refusal
(`PROVIDER_ACCESS_DENIED`, `INSUFFICIENT_SCOPE`, `PROVIDER_PERMISSION_MISSING`, `AUTH_EXPIRED`,
`REAUTHORIZATION_REQUIRED`) returns `next_call: null`, `retry_after_provisioning: true` and an `owner_action`
`{kind, reference, text}`: `request_provisioning` or `verify_member_role` for LinkedIn's documented codes (DV360
refusals point to the Display & Video 360 user profile), `reauthorize` for credential or permission refusals, and
`contact_provider` otherwise, still with no cause inferred. Assistants must not repeat the same read until the owner
has acted. Any other failure is `unverified` with one `retry_hint` (and `retry_after_ms` when the provider names a
wait) and keeps the retry `next_call`. Each live read keeps one `conditional_program_observation` per workflow,
login and account (owner decision D20): state, AMCP and provider codes, HTTP status, AMCP and provider request IDs and
time, never the request, response or provider message; `grant: false`, replaced by the next read, kept 30 days and
removed when the login is disconnected (`local_changes.program_observations`). Capabilities show it as
`program_evidence.last_observation` and `live:false` as `last_observation`; the website card shows "Last observed"
and its chip reads "Provider refused · time" (D21: sanitized status and request IDs only). A program with no
selected account (for example no DV360 login, or one with zero advertisers) has `next_call: null`, `website_path:
"/connections"` and a `setup` listing its prerequisites, instead of a `program_check` that can only refuse; an empty
DV360 discovery names the user profile and permission to set up. Forecast budgets display in USD currency style with
the exact six-decimal value in the title.
[Current contracts, primary sources and selected-account acceptance](../records/DELIVERY-2026-10-07-CONDITIONAL-PROGRAMS.md).

These three are `mode: "live_read"`. Five more provider programs are listed for discovery only (ACC-05,
`src/discovery-programs.ts`): LinkedIn Lead Sync, LinkedIn Matched Audiences, LinkedIn saved media plans, X Ads API
access and Display & Video 360 reporting (Bid Manager). Capabilities lists them under `discovery_only_programs` (by
ID in the summary, whole in `view:"graph"`) with their prerequisites, reference and what they would unlock; they have no
account, no next call and `provider_requests: 0`, and `program_check` refuses them with `PROGRAM_CHECK_UNAVAILABLE` before
reading a login. The website's Capability Center shows them under "Programs that need provider approval". A blocked
write that waits on one names it as `program_id` in its refusal details and its action-ledger row, and its reason text
comes from the program entry. The Lead Sync entry never reads lead responses; they stay behind the personal-data
policy. The owner records each provider's approvals in the [provider access register](../PROVIDER-ACCESS.md).

The MCP JSON text and `structuredContent` now carry the same serialized result. General discovery
help is `{success:true,data:{surface:"compact-v1",...}}`; text clients should read `data.surface`.
Existing success/error envelopes remain unchanged. The HTTP health probe validates the same
discovery envelope. Clients caching older action enums must refresh tool definitions or reconnect
before using `program_check`; already captured native read operations remain usable independently.

## Interface language

Choose **English** or **العربية (جزئي)** in the top bar, public navigation or sign-in screen. The choice is saved
in this browser. Arabic currently covers the public introduction, authentication and MFA, account/security/team
controls, Home, navigation and schedule-center labels. Connections, asset selection/write permissions, MCP setup
and consent, owner access review, health, spending and retention controls also have Arabic interface copy. The shell
uses right-to-left layout and the existing local Arabic font. Principal campaign, creative, reporting, operations,
client and account workflow controls also have Arabic copy, including selected authored explanations and typed
GTM findings. Remaining diagnostic copy and legacy dynamic reasons can still be English; provider/user text
keeps its original value. Full editorial, visual, keyboard and assistive-technology acceptance remains unfinished.
Existing legal agreements remain English and retain their original wording.

Switching language refreshes the current view. Changed inputs, visible recovery codes or one-time connector tokens require confirmation;
save them first. Saved records remain available. Account names, campaign names, identifiers, exact numeric strings,
native request fields and technical codes keep their original values. Dates use the chosen interface locale while
report/schedule timezones keep their own meaning. The fixed local catalog is requested only for Arabic; if it
cannot load, English remains usable. See the [foundation](../records/DELIVERY-2026-10-01-ARABIC-FOUNDATION.md) and
[connection/control localization record](../records/DELIVERY-2026-10-01-ARABIC-CONNECTIONS.md).

## Opening website pages

Each page loads the feature files it needs on first visit and reuses them when revisited. A loading status appears
while these files arrive. If a download fails, **Try again** retries that page. If startup took too long or could
only finish partially, **Reload page** starts a fresh document. Leaving the page or changing identity invalidates
its pending result. Loading page files itself does not change an account or perform a provider operation.
