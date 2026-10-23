# Connected product workflows

Implemented on `magdyezy1/CAMCP`, branch `Work-here`, on 1 October 2026. These website views call the same
first-party service operations as MCP. The [implementation record](review/IMPLEMENTATION-2026-10-01.md) records
qualification and remaining blueprint scope. Provider acceptance is account/action-specific and remains separate
from local implementation.

## Find and resume work

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
readiness is a count with the accounts in a disclosure, and capability evidence (tool names, evidence levels) sits
under **Technical details**, so Home stays short on a phone. **Continue recent work** still lists recent plans.

**Working client (SEC-08).** In a workspace that serves several clients, the top bar's **Working client** narrows
pickers and lists to the accounts one approved playbook binds: Home (attention items, recent plans, readiness), plans,
operations, activity, media, Drive import, push, previews, the report builder, the capabilities account picker, the
composer, clone and capture sources, Portfolio, Measurement and Commerce. It is a view filter kept in `?client=` (links
keep it), never access control; a push or plan that no one client holds asks first, and pickers preselect only a sole
remaining account. MCP callers pass the same filter as `profile_id`. Limiting what a member, token or AI client may
reach is a separate, optional client access set; see
[clients in one workspace](USER-ACCOUNTS.md#clients-in-one-workspace-working-client-and-client-access-sets).

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
[Current contracts, primary sources and selected-account acceptance](review/DELIVERY-2026-10-07-CONDITIONAL-PROGRAMS.md).

These three are `mode: "live_read"`. Five more provider programs are listed for discovery only (ACC-05,
`src/discovery-programs.ts`): LinkedIn Lead Sync, LinkedIn Matched Audiences, LinkedIn saved media plans, X Ads API
access and Display & Video 360 reporting (Bid Manager). Capabilities lists them under `discovery_only_programs` (by
ID in the summary, whole in `view:"graph"`) with their prerequisites, reference and what they would unlock; they have no
account, no next call and `provider_requests: 0`, and `program_check` refuses them with `PROGRAM_CHECK_UNAVAILABLE` before
reading a login. The website's Capability Center shows them under "Programs that need provider approval". A blocked
write that waits on one names it as `program_id` in its refusal details and its action-ledger row, and its reason text
comes from the program entry. The Lead Sync entry never reads lead responses; they stay behind the personal-data
policy. The owner records each provider's approvals in the [provider access register](PROVIDER-ACCESS.md).

The MCP JSON text and `structuredContent` now carry the same serialized result. General discovery
help is `{success:true,data:{surface:"compact-v1",...}}`; text clients should read `data.surface`.
Existing success/error envelopes remain unchanged. The HTTP health probe validates the same
discovery envelope. Clients caching older action enums must refresh tool definitions or reconnect
before using `program_check`; already captured native read operations remain usable independently.

## Errors, run stops and next actions

The website presents every refusal through one layer in `web/app.js` (WEB-03). An error shows its message, what to do,
the provider's facts and AMCP's request reference as separate parts: each part on its own line in an alert, one line in
a short notice. The server writes its remedies for MCP clients as well as people; a remedy that names tool, action or
argument names, `details.*` paths or "send the call again" is replaced by the page's own wording for that code (for
example `REVIEW_EXPIRED`, `APPROVAL_REQUIRED`, `PLAN_CHANGED`, `STATE_TARGET_MISMATCH`) or, failing that, for its remedy
category, keeping a leading "Nothing was sent" and the safety facts the remedy states (a change whose outcome is not
confirmed is never sent again; a failed or incomplete read never authorizes a change). A remedy written for people is
shown as written, in the interface language. A refusal classified by the provider-error layer says who must act
(reconnect the login, the account's provider administrator, the deployment owner, wait for a rate limit). For a provider
refusal (the provider's answer, or a `PROVIDER_` code with the provider's HTTP status; not a link, Drive or AMCP status)
the page shows only allow-listed facts (owner decision D21): the HTTP status, the provider's error code and its request
ID when they are well-formed; never a provider body, message or token. The server's exact code, message and remedy stay
under **Technical details**.

A campaign run says what its stop means and offers the one control that continues it, never the raw `run.stopped` code:
**Continue the run** after a pause to stay responsive or a step not sent, **Read back** while a step settles, **Correct
blocked step**, **Check the provider**, **Compare observed values** or **Open Operations** for a step that needs a
person. A stop for a spending, cap, creative-edit or (when the owner turned it on, WRT-09) deletion acknowledgement
shows that step's review on the page with its consents unchecked; executing it sends exactly that review and key. A step
that waits for a person's website approval or the owner's (WRT-09) says nothing was sent and links its approval page;
nothing continues the run before that approval. `APPROVAL_REQUIRED` and `PLAN_CHANGED` offer **Review plan approval**,
`REVIEW_EXPIRED` and `STATE_CHANGED` offer **Prepare again**. A plan approval older than 24 hours, counted on the
server's clock (from the `Date` of AMCP's responses), is no longer offered as **Run**: the page says it expired and
labels the review **Review whole plan again**. The report builder shows a Pull or Save refusal next to its run bar,
focused and scrolled into view; a Pull with no account, or a custom range that ends before it starts, is refused there
before anything is sent. A JSON field that does not parse names the field. Owner Settings, recipe, account-approval and
media-job errors keep their remedy and request reference.

## Campaign review and recovery

Before saving, `amcp_campaign {action:"recipe_eligibility",recipe,business,profile_id?,live?}` assesses the
current brief using the same recipe compiler and approved defaults as plan creation. It is local by default;
explicit `live:true` reuses read-only account/resource/media preflight. No plan is saved and no provider mutation
is submitted. Account evidence expires after five minutes and is invalidated by authority, connection,
credential, pause or profile revision changes during collection. Confirmed dependency rows describe only their
stated evidence: local attribution/CPC settings, account currency or resource access do not prove objective
acceptance, event delivery or predecessor receipts. Missing, blocked and unknown checks stay explicit.

The composer offers **Check account prerequisites** and a readable bilingual result. Edits clear stale results;
delayed inspections, errors and targeting lookups cannot cross form/account, route or identity changes. Native
evidence and input provenance remain inspectable. Plan creation, paused status and each later native review
retain the existing behavior.

The Campaigns page starts with saved plans and a collapsible composer. Plans are listed newest first, 50 at a time
with **Load more** (`amcp_campaign list`: an SQL projection with one account and platform summary per plan, continued
with `next_cursor`), filtered by state, name or account, **Awaiting my approval** and **Archived plans**; the filters
stay in the URL. The list's `total` counts the plans that match the filters and that the caller owns, administers or
collaborates on, before the current account-access check: a shared plan whose accounts the caller can no longer access
is counted there but its row is withheld. **Archive plan** (complete, cancelled or superseded plans only) takes a plan out of the default list
and out of the workspace's bound of 500 plans, which counts only plans that are not archived; `get` still returns it
and **Unarchive plan** restores it. **Share plan** lets the plan's owner (or an administrator) name a workspace member
as viewer (reads it), editor (prepares, runs steps one by one, amends, archives) or approver (approves and runs it);
a collaborator sees the plan only while its accounts are within their access, every step still checks the acting
person's own account grant, and assignments and approvals are audited with their actors. When the workspace owner
turns on **A plan that changes spending or activates a launch needs an approver other than its owner** (Settings,
`save_plan_policy`; off by default; saving either choice asks first), the owner's own approval of such a plan is
refused with `DISTINCT_APPROVER_REQUIRED` and Review whole plan offers sharing instead; executing its steps one by one
also needs a current approval by someone other than its owner. Home shows plan counts, the five newest
plans needing attention and the eight newest plans (CMP-05). The readable review preserves exact native
units and shows account, request and impact alongside expandable source JSON. Required spend, cap and creative-edit
acknowledgements come from the server and start unchecked. A confirm-mode cap can be acknowledged; a block-mode cap
stays blocked.

The page exposes whole-plan approval/run/continue, the execution journal, supported clone creation, amendment of
server-declared editable fields and comparison with observed native state. An observed-state acceptance sends the
exact current `actual_hash`. Uncertain writes retain their original receipts and are never automatically replayed.
A plan blocked at preflight offers **Correct blocked step**: Check prerequisites and Review next step list each
blocked prerequisite with its remedy and open the amendment form, which patches one field or, when the correction
adds a field, saves the step's corrected native arguments (`recover_step`). Amending voids the plan approval and
clears the stored preflight, so Check prerequisites inspects the corrected step again. Run/continue resumes a step a restart left executing under its original review and key; a
completed receipt is replayed and an uncertain one stops the plan, never sent twice. A step the provider refused
without applying it (a Google request refused outright, recorded as `rejected`) is corrected the same way under a new
review and key. For a refusal AMCP cannot prove applied nothing (Meta), **Confirm the resource does not exist** runs
`confirm_absent`: a complete read-only list of the step's parent, matched by the step's name and claim time; only a
complete read with no match, confirmed by the person and audited, unlocks the correction. **Continue in a new linked
plan** (`continue_as_new`) moves the steps not yet done into a new draft that uses the IDs already created (each
adopted value records `adopted_from`), and marks the original plan superseded with a link both ways; a step whose
outcome is still unsettled is never carried. Google Search recipes are one all-or-nothing `googleAds:mutate` build by
default (`atomic: false` keeps one step per resource type). A completed recipe plan offers **Prepare activation**
(`activation_plan`, returned as `activation_call`, never `next_call`): a separate linked draft (`activation_of` /
`activation_plan`) built from the launch's verified IDs, with its own approval, spend confirmation and preflight.
For a launch that was continued in a new plan, the IDs come from the earlier plans in its `supersedes` chain
through the verified links an authorized person recorded; reading them checks each plan's integrity, not the drafting
person's view right on the earlier plans, and the activation still reads and checks every resource at preflight.
Meta and Google enable the paused campaign; TikTok enables the `DISABLE` campaign its pack created with enabled
children; Snapchat activates campaign, ad squad and ad, and LinkedIn campaign group, campaign and creative, in that
order, each after the one before is verified; Microsoft sets campaign, ad group, keywords and ad Active, and the
campaign needs a positive location criterion (owner decision P7): the Microsoft Search pack adds the brief's
`location_ids` as positive location criteria of the paused campaign (a plan drafted before it did is refused with
`RECIPE_INPUT_REQUIRED` until drafted again), and `UpdateCampaigns` with `Status: Active` is refused with
`LOCATION_CRITERIA_REQUIRED` when the campaign's location criteria read holds none. Read-only gates run at preflight
before any status write: the Microsoft campaign must hold a positive location criterion, and the gate lists each
location with the name Microsoft gives it; the Snapchat ad's creative review must be `APPROVED`; the Meta ad must not
be disapproved, have issues or carry review
feedback, and a Meta conversion launch's pixel must be readable and not unavailable; a Google conversion launch needs a
biddable account-default goal with an enabled primary action (the reads `recipe_eligibility` makes); a LinkedIn lead
launch's form must be `PUBLISHED` (the account's forms are read again), since the form's state decides whether the
creative serves. A failed or
unreadable gate blocks with `ACTIVATION_GATE_BLOCKED`, and each activation preflight is audited
(`campaign_activation_preflight`, with the gates that blocked it). Recipe and clone forms send one
creation key per exact request, so a retry after a lost response opens the plan already saved instead of a second
draft. Recipe and clone text is saved literally: `{{...}}` in ad copy is not template syntax there.
Clone support remains the existing Google Search, Snapchat, TikTok and LinkedIn scope. Guided Meta website
purchases (`meta_website_sales`) and website leads (`meta_website_leads`) add explicit pixel, event and attribution
choices to the image workflow. Choose a 1- or 7-day click window and explicitly include or exclude 1-day views.
The campaign starts PAUSED; children are ACTIVE under it. Activation requires a separate reviewed change. All three
Meta website packs send `is_adset_budget_sharing_enabled: false` on the campaign, the explicit choice Meta requires
from Graph API v24.0 when the budget is on the ad set; the review and plan approval explain it in English and Arabic.
Pixel/Page access is checked during preflight. Event delivery, objective eligibility and landing-page acceptance
still need account-specific evidence. Regulated categories require a tailored native plan; these recipes refuse them.

Client playbooks (`/profiles`) provide naming/UTM fields, selected-account bindings, recipe defaults, revisioned
approval and an expansion preview. Up to 50 named text conversion references have a guided editor with exact
string preservation. Structured, numeric, multiline, unusual and excess mappings remain unchanged in Advanced
JSON alongside variables and native templates. Duplicate guided/Advanced names and partial rows are refused.
The preview includes campaign defaults (including the existing Maximize Clicks CPC ceiling), readable exact
references and preserved complex mappings. References are declarations, not ownership/event-delivery evidence;
campaign preflight is still required. Add/remove clears approval and preview. See the
[conversion-reference delivery record](review/DELIVERY-2026-10-03-CONVERSION-REFERENCES.md).
Preview resolves the same template function as campaign creation without provider calls. A nonempty binding list
limits both recipe choices and generated/native plan steps to those exact accounts and connections. An empty list
retains the previous behavior of allowing the actor's currently authorized choices. Profiles never grant access.

**Playbook rules, saved briefs and composer state (CMP-06).** With a playbook selected, recipe preview, eligibility
and plan creation apply its naming template (`{{campaign_name}}` is the name typed) and append its UTM rules to the
landing page; existing query text and the fragment are kept byte for byte, an equal parameter is kept once, and a
different value already in the URL is refused (`PLAYBOOK_UTM_CONFLICT`) rather than rewritten. The playbook preview
uses the same tagging, so both previews show the same URL. Names (1–100) and URLs (2,048) are checked after
derivation. `provenance.conventions` and the composer's "Your input → Playbook result" table show each change;
the per-plan checkbox (`apply_playbook_rules:false`) uses the input as typed and is recorded. `defaults.common`
("Shared by every workflow" in the editor) applies to every recipe that takes the field; a recipe's own default
wins. Briefs saved with **Save as client brief** (`amcp_workspace save_brief`/`briefs`/`brief`/`delete_brief`, at
most 200 per workspace) reopen in the composer, and a plan created from one records `client_brief {id, revision}`.
A live **Check account prerequisites** returns `eligibility_ref`; a plan created from those exact values reuses
that read-only preflight and opens at plan approval only while person, playbook revision, inputs, compiled steps,
login, account grant and write pause all match (`eligibility_reuse` names the reason otherwise; `prepare` still
reads state again). The composer asks for the objective first and lists only workflows for platforms with a
connected account (Google Search bidding is a sub-choice). Drafts, the last workflow and playbook are kept per tab
and signed-in identity in `sessionStorage`, restored after in-app navigation or a reload, and forgotten on sign-out
or workspace switch. A sole eligible account is preselected with its currency; schedule times are picked in the
account timezone and sent with their offset. Meta image packs take one image source (Drive link, upload ID, public
HTTPS link or an `image_hash` that preflight reads back from the account) and an optional age range shown as 18–65
by default. When the selected playbook's bindings leave out every connected account, the composer says so and links
to the playbook. `/profiles` lists playbooks by name with their binding summary and a search, keeps the open one in
`?profile_id=`, asks before unsaved edits are discarded (another playbook, a new one or an in-app link), groups bound
accounts by platform (files, sheets and properties on request) and offers **Duplicate playbook**, which starts an
unsaved new playbook needing its own approval. The Advanced form lists the chosen profile's saved templates.

### Snapchat website traffic with an existing creative

Choose the Snapchat traffic workflow in Campaigns or use `amcp_campaign` with
`recipe:"snapchat_website_traffic"`. Provide the exact selected account/login, currency, daily budget,
one to twenty distinct uppercase country codes, an existing creative UUID, `regulated_content:false`,
and a valid `start_time` with a UTC offset. An optional end time must follow the start. Regulated content
requires a tailored native plan. The budget compiles exactly into micros and must be at least five
account-currency units under the documented ad-squad minimum; account acceptance remains separate.

Inspect plan compiles locally without saving or making provider calls. Check account prerequisites reads
only the selected account and its bounded creative collection, then the exact owned creative. Website ads
require WEB_VIEW and a full HTTPS destination without credentials. The original destination text is retained;
the check never downloads the landing page. Ownership and fields can be confirmed while advertising approval,
destination availability and objective eligibility remain unknown.

Create plan saves three paused steps: an auction TRAFFIC campaign, an automatically placed daily-budget
ad squad with AUTO_BID/SWIPES, and a REMOTE_WEBPAGE ad reusing the original creative. Verified native predecessor
receipts supply the new parent IDs. Every resolved change retains its own review, spending confirmation,
idempotency and read-back; activation is a separate reviewed change. Automatic bidding does not promise a
cost per result. Snapchat GET omits placement_v2, so the existing review retains its explicit verification
limitation. A read-back mismatch or lost receipt cannot count as a completed launch or permit automatic replay.

Native ad creates and creative replacements also read each unique referenced creative in the original
selected account. A missing/foreign owner fails closed. The native review freezes its content, including the
original destination; changing it after review prevents submission. Phone forms stack their actions and retain
readable exact IDs in English and Arabic. See the [delivery evidence](review/DELIVERY-2026-10-03-SNAPCHAT-TRAFFIC.md).

### Snapchat lead generation with the original form

Choose `snapchat_lead_generation` in Campaigns or MCP. Its explicit brief reuses the same exact account/login,
currency, daily budget, country codes, regulated-content declaration and offset schedule, plus the existing lead
creative UUID and an explicit SWIPES or LEAD_FORM_SUBMISSIONS goal. It saves a PAUSED LEADS campaign, a PAUSED
daily-budget AUTO_BID ad squad with LEAD_GENERATION child ads, and a PAUSED lead ad referencing that original creative.

Check account prerequisites reads complete bounded selected-account creative and form collections, then the exact
linked form definition. Ownership, original question fields and source references can be confirmed without reading
submitted leads. Native ad preparation freezes both original definitions and reads them again before execution;
changed questions, title, policy URL or disclosures require a fresh review. Missing/foreign ownership, incomplete
collections, unsafe references and revoked authority block writes. Optional policy fields stay optional; provider
approval, goal entitlement, policy availability and consent acceptance remain unknown. No terms are accepted and
no lead exports or webhooks are enabled. Preserve uncertain receipts; activation remains separately reviewed.
The English/Arabic preview preserves exact native goals, micros, IDs, original title and original policy URL.
See [contract, SDK and browser qualification](review/DELIVERY-2026-10-04-SNAPCHAT-LEADS.md).

### After a launch: launch check and serving diagnostics

`amcp_reporting launch_check {id}` checks a completed guided Meta or Snapchat launch (CMP-07): native reads of its
verified campaign, ad set or ad squad and account feed the rule-based campaign audit, with an optional retained
campaign × day capture (`reference_id`) for delivery and frequency. Missing evidence stays unknown; delivery is observed
only from reported impressions, and a paused campaign is never reported as failing. For Google accounts, Inventory
offers **Why is it serving or not?** (`amcp_reporting serving_diagnostics`): Google's primary status and reasons, policy
summary and ad strength per campaign, ad group, ad, asset group and asset link, each native symbol shown literally with
its English or Arabic explanation and any symbol newer than the pinned v25 enums listed as not named. Both are reads.

### Google Performance Max as one build

`google_performance_max` (CMP-07) compiles a brief into one all-or-nothing Google build, the request Google requires for
a Performance Max asset group and its minimum assets: a dedicated budget, a PAUSED Performance Max campaign with
Maximize Conversions on explicitly chosen account-default goals and brand guidelines off, location and language
criteria, the text assets, one ENABLED asset group and the links to existing image and logo assets. Asset counts and
text lengths are checked against pinned minimums before any request (`PMAX_ASSET_MINIMUMS`), and the review reads each
linked image or logo for its type (`PMAX_ASSET_TYPE_MISMATCH`). Image ratios, policy and ad strength stay with Google;
after the build, **Why is it serving or not?** shows the asset group's status and ad strength. Activation enables the
campaign as its own reviewed change.

### TikTok website traffic and purchases with an existing post

Choose `tiktok_website_traffic` or `tiktok_website_conversions` in Campaigns or MCP (CMP-07; packs owner decision P7
of 2026-10-11 names, see the [demand record](DECISIONS.md#campaign-pack-demand-record-cmp-07-p7-prv-06)). The
brief names the exact advertiser and login, account currency, a daily budget with at most two decimal places, 1–20
TikTok location IDs, an existing TikTok post with the `TT_USER` or `BC_AUTH_TT` identity that owns it, an HTTPS
landing page, a call to action and an offset start time; the purchases pack adds the pixel and one purchase event. It
saves three reviewed creates: a `DISABLE` campaign and, under it, an `ENABLE` daily-budget ad group on the TikTok
placement and one `ENABLE` Spark Ad. Preflight reads the identity, the post and, for purchases, the pixel of this
advertiser before anything is created; ad review, event delivery, budget minimums and objective acceptance stay with
TikTok. **Prepare activation** enables the verified campaign as one separate reviewed status change. The website
preview shows the UTC times TikTok receives, in English and Arabic.

### LinkedIn lead generation with an existing post and form

Choose `linkedin_lead_generation` in Campaigns or MCP (CMP-07 optional stretch, built before owner decision P7 of
2026-10-11 named it, see the [demand record](DECISIONS.md#campaign-pack-demand-record-cmp-07-p7-prv-06)). The brief
names the exact ad account and login, account currency, a daily budget in the account currency, 1–50 LinkedIn location
URNs (`urn:li:geo:…`), the campaign locale (`en_US`), an existing post to sponsor (`urn:li:share:…` or
`urn:li:ugcPost:…`), the numeric ID of one of the account's lead forms, a lead form call to action, an explicit
`NOT_POLITICAL` declaration (political advertising needs a tailored native plan) and an offset start time. It saves
three reviewed creates, all `PAUSED`: a campaign group, a `LEAD_GENERATION` campaign with maximum delivery (`MAX_LEAD`,
no bid) and a daily budget, and a creative that sponsors the post with the form as its call to action. Preflight reads
the account's lead forms through the owner finder before anything is created: a form LinkedIn does not return for this
account, or an archived one, blocks the plan (`CAMPAIGN_PREREQUISITE_REQUIRED`). Post eligibility, privacy-policy
acceptance, ad review and objective acceptance stay with LinkedIn, which may spend up to 150% of a daily budget on a
day. **Prepare activation** activates the group, the campaign and the creative in that order, each as its own REST.li
`PARTIAL_UPDATE` review; its preflight reads the form again and blocks until it is `PUBLISHED` (publish a draft form
with its own reviewed state change). The website preview shows the UTC start LinkedIn receives, in English and Arabic.

## Creative preparation and durable uploads

Creative (`/media`) starts with a searchable, paginated metadata library. Filter by platform, account/login, name or
tag; open an exact asset to inspect native IDs, source hashes, transformation dimensions and retained plan usage.
Names and tags are revision-protected internal annotations. Confirming an edit never renames the provider object.
Verified plan usage follows actual media/creative/ad references and retains original plan links; dependency order
alone does not prove usage. Each receipt states how its file reached AMCP (uploaded on the website, a link import, a
Drive import or an owner-retained original) and the original's SHA-256, also for a fitted or preset copy and after the
original expired; **Uploads of this same original** lists that original's uploads across accounts (MED-04).
**Inspect linked ad performance** selects compatible retained guided Meta, Google Ads, Snapchat or standard TikTok ad
evidence, or LinkedIn creative evidence, from the same provider/account/login and shows daily rows for exact verified
ad IDs in that plan. Google retains its complete customer/ad-group/ad resource name; LinkedIn joins only an exact
`urn:li:sponsoredCreative:` URN on both sides and withholds any other form. Only the qualified ad action
and snapshot grain are supported; Smart+ and other aliases remain separate. It preserves source dates, currency,
timezone, attribution, result definition, completeness and unknown values. It does not allocate results to an image
or prove which creative served throughout the reporting window. External usage remains unknown. Every page/detail checks
current account access; asset reuse still requires the original fresh provider-availability check.

Source upload, variants and destination preparation follow the library. **Save as resumable upload plan** retains up to 50 eligible matrix rows as media-only
campaign steps named "file → platform · account", preserving every target and the exact planned file hash (the file the
platform receives); each step's review and receipt then record the original's own SHA-256. Saving does
not upload. Review and execute the saved plan through Campaigns; successful step receipts survive later target failures.
A plan whose steps use temporary files (`src-…`) is saved only after the member confirms their deadline
(`acknowledge_temporary_sources: true`; otherwise `TEMPORARY_MEDIA_SOURCES`), only while the earliest leaves at least
five minutes (`TEMPORARY_SOURCES_EXPIRING`), and the plan shows when it must run by ("Runnable until", owner decision
D23). A step whose file expired offers **Replace the file**: the new upload is planned for that destination and the
step is reviewed again; the old bytes are never reused.

The bulk push (MED-03) saves the confirmed rows as plans of at most 50 independent uploads, approves them with that
confirmation and runs them on the server (`amcp_campaign run_background`): leaving the page stops nothing, one failed
upload does not hold the others, busy media capacity waits, and each upload is still its own frozen review executed
once, one staged review at a time per person. The page follows the plans; their rows link to each plan. Fitted copies
made while planning are kept for the push, so each file converts once per limit group, and a file already in an
account can be reused after a fresh availability check instead of uploaded again. With `AMCP_SERVER_PUSH=false` the
page drives one row at a time through a durable job and warns before leaving. Website uploads, thumbnails, variants and review copies share one absolute deadline,
30 minutes after upload starts; creating a new review cannot extend it. Expired uploads are inaccessible immediately
and an independent 15-second timer removes their encrypted bytes even without a running worker. Website uploads
cannot be retained. For a separately imported link/Drive original, a current workspace owner can explicitly
**Retain this original**, confirming the selected SHA-256. Its separate encrypted library ID remains available until
owner-confirmed removal; both copies share the unchanged file count/byte quota. Retention costs another slot while
the temporary copy remains. The source picker distinguishes retained originals and exposes exact file details.
Select the library ID for reusable work; existing saved plans are not rewritten. Historical receipts can show the
matching retained original after temporary expiry. Metadata alone cannot resurrect unavailable bytes. See
[media uploads](MEDIA-UPLOADS.md) for provider limits and safe resume behavior.

## Reports, evidence and delivery

Reporting overview selects campaign, native ad-set/ad-group or ad detail separately from date grouping.
Google, Meta, TikTok and Snapchat support their qualified middle and ad levels; LinkedIn supports native
campaign and sponsored-creative levels. Detailed sources require their explicit measurement settings; unsupported
levels are refused. Original native IDs and source rows remain available, additive rollups preserve exact decimals,
and missing values and multi-day reach/frequency stay unknown. Select **Export now to Google Sheets** on a
collected snapshot, choose its destination and confirm the immediate export. The original snapshot is exported
even after setup edits; no schedule is created and unrelated spreadsheet tabs are preserved. See the
[appearance, media and detail delivery record](review/DELIVERY-2026-10-07-APPEARANCE-MEDIA-DETAIL.md).

Report library (`/report-library`) separates saved definitions, reusable account-free templates and retained
snapshots. Search finds definitions by client/name; snapshot history pages through older accessible results. A
snapshot link opens its retained results, and **Use this snapshot's setup** explicitly copies its original settings
into the builder. Changing the builder does not mutate the snapshot.

Every Overview collection has one durable allowance across accounts, periods, pages, retries and report downloads:

| Limit                  | Whole snapshot allowance |
| ---------------------- | -----------------------: |
| Native HTTP requests   |                    1,200 |
| Normalized source rows |                   25,000 |
| Active collection time |               300,000 ms |
| Response bytes         |                  128 MiB |

Counters are saved before egress and never reset by retry. Clean queue waiting is excluded; an interrupted process
conservatively charges elapsed wall time since its last active checkpoint. Between completed native periods, a
dispatch yields after 20 seconds so other queued work can run. This is not a per-request deadline shorter than the
remaining collection time and does not interrupt advertising mutations. A limit retains completed results and
explicit missing-source/period errors. Narrow the next run rather than retrying for a fresh allowance. Legacy
partially collected jobs without counters require a new run (`REPORT_RESTART_REQUIRED`).

TikTok integrated aggregation requires complete, consistent native page counts and stable totals, with unique
requested dimension tuples. Missing completion metadata, overlapping rows and malformed grain fail the source
before Overview retains metrics. Native page metadata is preserved; the outer pages/truncated fields describe
aggregation. Single-page raw reads and inventory lists retain their independent contracts.

X reporting assigns each UTC hour to one local calendar period by its midpoint. Fractional-hour boundary periods
are marked with the hourly-resolution limitation; adjacent daily totals do not count the same hour twice.
Successful empty or sparse native metrics remain valid dependencies with unknown values, rather than failing
custom formula validation.

**Analyze retained evidence** selects a single compatible account/login/currency/timezone/attribution/conversion
group. It retains original row capture timestamps, query fingerprints and snapshot lineage and makes no new
provider query. Pacing, reconciliation and recommendation operations remain advisory.

Detailed evidence includes a readable table of every retained mapped row, 50 at a time, with previous/next and
direct page selection. Exact IDs and decimal strings are preserved; missing metrics remain unknown. Paging reads
retained data under current account access and does not call the provider. Source/account/hash/count mismatches
clear the table. The source-details panel includes account checks, per-page evidence and Overview lineage when
available. English/Arabic labels keep native names and values unchanged.

Use **Download all rows as Excel** for all retained mapped rows, totals, mappings, measurement settings and
selected source hashes. Choose English or Arabic explicitly; it defaults to English independently of interface
language. Native headers and cell values remain unchanged. Numeric values are text to retain precision; missing
values stay blank and coverage distinguishes unknown from unmapped. Downloads recheck current session/account
access and report revision after generation. They make no provider request and do not save a binary copy.
The reporting capture/get response also exposes an authenticated relative `xlsx_path` handoff.

Open a retained report and choose a retained reference to compare the same account and period. AMCP checks the
saved measurement settings, guided native grain and field mappings, or the same Overview definition/group. It
refuses unknown or mismatched settings and shows exact additive differences, tolerances and unavailable values.
Both source hashes and capture times remain available. This compares retained declarations without a fresh
provider request or independent attribution verification. Manually entered totals remain available under their
own disclosure: a numerical match does not establish compatible report settings.

**Import a CSV reference** reads a UTF-8 CSV/TSV or BOM-marked UTF-16 file locally, up to 64 KiB. Use exactly
one header row and one aggregate totals row. Choose the delimiter and decimal separator, map each metric to its
own column, and specify currency units, hundredths or micros for each money metric. Preview the exact values;
then declare the original account, dates, currency, timezone, attribution, conversion definition and grain, and
explicitly confirm complete coverage and matching entities/filters. Multiple detail rows are refused rather than
silently summed with totals. Blank selected cells remain unknown. No grouping characters, formulas or rounding
are accepted. Only mapped totals, selected column names, settings and a SHA-256 of the original local bytes are
sent. The timestamp records the import comparison, not an independently established provider export time.
The server checks declarations against retained evidence but does not independently verify the file or attribution.

`amcp_reporting` adds:

| Action                  | Inputs / result                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture_presets`       | Available detailed native mappings and declared limits; with `connection_id`/`account_id`, also the account's stored currency, timezone and read time         |
| `capture_preset`        | `preset`, exact `connection_id`/`account_id`, and `semantics`; Meta also requires `result_action_type` and `attribution_windows`                              |
| `overview_sources`      | `id` of a retained Overview snapshot; lists eligible semantic groups                                                                                          |
| `capture_overview`      | Snapshot `id` and exact `group_id`; reuses retained evidence                                                                                                  |
| `scenarios`             | Evidence `id`, `options.budgets`, `efficiency_low`, `efficiency_high`; returns explicit sensitivity assumptions                                               |
| `allocation_candidates` | Guided campaign evidence `id`; paginated campaign metadata with `offset`/`limit` and `next_offset`                                                            |
| `allocation`            | Evidence `id`, explicit total period budget, campaign floors/caps, sensitivity factors, evidence age and minimum conversions; returns an inspectable proposal |

Provider metric values are parsed from their decimal text, never with float arithmetic. Additive metrics keep nine
decimal places: a longer value, such as a fractional data-driven Google conversion (`0.30000000000000004`) or exponent
text (`1e-7`), is rounded half to even (owner decision D10) instead of failing the source. Evidence that needed
rounding records `semantics.metric_rounding` (`{metric: {places: 9, rule: "half_even", rows_rounded}}`), which is part
of its source hash; allocation, calibration and recommendations then add a rounding limitation. Reach and frequency
are never summed and keep their exact native text. Negative or non-numeric provider values fail with a field-naming
`REPORT_SHAPE_CHANGED` error, and JSON numbers above 2^53 with `METRIC_PRECISION_LOSS`. Caller-declared totals,
tolerances and targets keep the strict grammar of at most nine decimal places. `AMCP_REPORT_LOSSLESS_NUMBERS=true`
(off by default) also keeps fractional JSON numbers in read-only Google search, Meta Insights, TikTok, Snapchat and
LinkedIn report responses as their exact source text. Keep it off until the reporting suites cover campaign-level
overview runs of each of those platforms with it on; only the qualified detail collectors are covered today.

Google presets are `google_campaign`, `google_adset`, `google_ad` and `google_search_terms`. Each needs currency, IANA
timezone, date_from/date_to, attribution, source_name and a boolean complete declaration. The fixed conversion
definition is `metrics.conversions`. Exact customer identity/currency/timezone are verified before and after complete
Search pages; account and page request/hash references are retained. Each row must match its native hierarchy and
requested date/grain. Counts, duplicate rows, malformed continuation and changed authority stop capture before saving.
The first three retain daily grain; ads use ad-group-ad resource names as entity IDs, keeping parent-specific ads
distinct. Search terms use search-term-view resource names over the selected period, preserving campaign/ad-group/term
identity; this endpoint excludes Performance Max. Campaign/ad-group IDs stay numeric strings. Existing evidence is
unchanged, and incompatible legacy mappings/grains cannot be reconciled. Native cost micros are divided exactly by
1,000,000. Up to 100 pages share limits of 120 requests, 10,000 rows, 120 seconds and 32 MiB. Empty proto3 default
responses require successful customer checks. Missing metrics stay unknown. Attribution and window completeness
remain declarations; search-term visibility can prevent reconciliation to campaign totals. See the
[Google evidence qualification](review/DELIVERY-2026-10-02-GOOGLE-EVIDENCE-INTEGRITY.md).

Meta presets are `meta_campaign`, `meta_adset` and `meta_ad`, each at entity × day grain. Supply currency, IANA
timezone, dates, source name and completeness. Select the exact native `result_action_type` (for example,
`offsite_conversion.fb_pixel_purchase`) and `attribution_windows`: at most one of `1d_click`/`7d_click`/`28d_click`,
optional `1d_view` and `1d_ev` (one-day engaged view), or view windows alone (RPT-07). Two click windows together, and
the `7d_view`/`28d_view` windows Meta removed on 2026-01-12, are refused. The request explicitly uses impression time and
disables account/unified attribution overrides; the saved attribution/result definitions are derived from that query.
Account identity, currency and timezone are verified before and after complete Insights pages, including empty
reports. Each native row must match its account, exact parent chain, currency, dates and unique entity/day grain.
Changed credentials/scopes/access stop collection. Only bounded native cursors on the original account/query are
reused; continuation URLs and their credentials are never followed or copied. Empty intermediate pages continue
when another page is advertised. At most 100 pages/10,000 rows share the same request/time/byte bounds. Both account
checks and every page retain source references. On a delivered row (impressions above 0) an absent selected action
counts as 0 and is named in `omitted_as_zero` (Meta omits zero-valued action entries); a row without delivery keeps
it unknown. Overlapping action aliases are never added. Window completeness remains declared, and complete paging does not prove conversion delivery.
See the [Meta evidence qualification](review/DELIVERY-2026-10-02-META-EVIDENCE-INTEGRITY.md); SDK/native fixture evidence
does not certify live provider acceptance.

**Dimension packs (RPT-07).** Five presets answer audience, placement, network and Performance Max questions that
campaign rows cannot, through the same verified collectors:

| Preset                     | Grain                                                 | Native dimension columns                                |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| `google_pmax_search_terms` | Performance Max campaign × search term (window total) | `search_term` from `campaign_search_term_view`          |
| `google_campaign_network`  | campaign × ad network × day                           | `native_ad_network` (`segments.ad_network_type`)        |
| `meta_campaign_age_gender` | campaign × age × gender × day                         | `native_age`, `native_gender`                           |
| `meta_campaign_country`    | campaign × country × day                              | `native_country`                                        |
| `meta_campaign_placement`  | campaign × publisher platform × placement × day       | `native_publisher_platform`, `native_platform_position` |

Values stay the literal provider values (never translated or merged) in the table, row search and English and Arabic
Excel exports. A value outside the documented native set (Google's AdNetworkType enum; Meta's age buckets, genders,
publisher platforms, ISO country codes or `unknown`, and lower-case placement names), a duplicate bucket/day row, an
unrequested breakdown field, an extra segment or a Performance Max term outside a `PERFORMANCE_MAX` campaign or under a
different `campaignSearchTermViews/{campaign}~{base64 term}` resource refuses capture and saves nothing. Saved evidence
carries `breakdown {dimensions, observed_values, absent_buckets:"unknown", reconciles_with_parent_totals:false}`: a
bucket the provider did not return is unknown, never zero, and bucket totals can differ from campaign totals (privacy
thresholds, unknown buckets). Reach and frequency stay per bucket and are never added together; Meta omits reach for
breakdown reports that start more than 13 months ago. The Google search-term view without keyword segments includes
Performance Max data; these terms do not qualify negative keywords, brand exclusions or budget changes.

LinkedIn presets are `linkedin_campaign_group`, `linkedin_campaign` and `linkedin_creative`, at the native
entity × UTC day grain. Supply the native account currency, `timezone:"UTC"`, dates, source name, attribution
definition (or `unknown`) and completeness declaration. The backend verifies currency against a fresh scoped
account read and derives `conversion_definition:"externalWebsiteConversions"` from its analytics request.
Native URNs are retained exactly; missing entity names and metrics remain unknown. Conversion-rule attribution
windows are not independently fetched. The website fixes the UTC/metric fields and restores prior declarations
when switching providers. The same request/row/time/byte limits cover the account and analytics reads together.
Use the current month and previous five calendar months, through today in UTC. Analytics has no pagination:
continuation metadata, provider ceilings, malformed/duplicate daily rows and empty responses refuse capture.
Empty responses can mean no activity or missing reporting access, so they cannot establish zero performance.
Narrow an oversized report or resolve access before making a new read. Retained account and analytics request/hash
references remain available; this does not qualify LinkedIn budget allocation or advertising writes.

**Verified LinkedIn conversion windows (RPT-07, B18).** `linkedin_campaign_conversion` reads campaign × conversion ×
UTC day evidence with the statistics finder (`q=statistics`, `pivots=List(CAMPAIGN,CONVERSION)`) and the
`externalWebsiteConversions`, post-click and post-view conversion counts and conversion value. Declare
`attribution:"verified_per_rule"`; a typed window (or `unknown`) is refused before any read with
`REPORT_ATTRIBUTION_DECLARED`. After the analytics response, and inside the same authorization bracket, AMCP reads
the account's current conversion rules (the same account finder as LinkedIn conversion settings) and joins each
reported conversion URN to its rule's `postClickAttributionWindowSize` and `viewThroughAttributionWindowSize`. The
result's `conversion_windows.status` is `verified_per_rule` (every conversion's rule has the same windows; the
semantics attribution names them), `mixed` (rules differ: no single window, and a declared single-window reference is
refused) or `unknown` (a reported conversion has no current rule, for example a deleted one, or no stated window;
attribution stays `unknown`). Spend, impressions and clicks are not split by conversion and stay unmapped. The
15,000-element ceiling, empty responses and malformed or duplicate campaign/conversion/day rows refuse capture as for
the other LinkedIn presets. Rule windows are today's settings, not a history. A live capture on an owner-designated
account (559535022) is still an owner acceptance step.

TikTok presets are `tiktok_campaign`, `tiktok_adgroup` and `tiktok_ad`, at native entity × advertiser-local
day grain. Declare exact advertiser/login, currency, IANA timezone, source name, attribution (or `unknown`),
dates and `complete:true`. Use 1–31 closed days. Currency/timezone are verified against advertiser metadata
before and after complete native report pages. Native `conversion` follows each entity optimization goal;
goals may differ, and attribution windows remain declarations. Smart+, GMV Max and specialized reports are
separate. The UI fixes only `conversion_definition:"conversion (optimization goal)"` and restores prior
declarations when changing providers. Exact decimal values and native IDs remain intact; missing metrics stay
unknown. No conversion value or reach is synthesized. Empty reports require explicit native zero counts.
Up to ten pages/10,000 rows are collected with strict page/count validation, duplicate checks and unchanged
authority; each page and both account checks retain request/hash references. Collection is not a point-in-time
snapshot. Current SDK request-contract and synthetic response tests are not live-provider qualification.

Scenarios accept 1–12 decimal budgets and positive low/high efficiency factors no greater than 10. They need positive
observed spend and conversions. They are linear CPA sensitivity models, with evidence age/completeness and source
hash attached, not calibrated delivery forecasts or automatic budget changes.

**Allocate a budget across campaigns** appears for guided Google/Meta campaign-by-day evidence. Choose 2–50
campaigns from paginated retained totals, then supply each floor/cap and a positive total period budget. The model
maximizes linear modeled conversions within those constraints. Amounts support six decimal places; exact integer
arithmetic preserves the total and constraints, and equal efficiencies use native ID ordering. A floor sum above
the budget or cap sum below it is refused. No campaign, currency or report is silently added to the selection.

The `allocation` options are `budget`, `allocations:[{entity_id,minimum,maximum}]`, `efficiency_low`,
`efficiency_high`, `minimum_conversions` (1–1,000,000) and `maximum_age_days` (1–90). Known positive spend and
enough observed conversions are required for every selected campaign. Incomplete reports, unknown measurement,
duplicate campaign/day rows, future/open periods and stale evidence are refused. Both capture time and the native
timezone's reporting end date must be recent; recapturing old dates does not satisfy the age check.

Proposals retain source hash, scope/measurement definitions, assumptions and binding constraints and can be
downloaded as JSON. Their budgets cover a comparable period of the same duration as the evidence. They are not
native daily budgets, calibrated forecasts or approvals. Linear response ignores saturation, causal effects and
changing auctions; the conversion threshold is an explicit planning assumption, not statistical significance.
Provider floors/caps, shared budget ownership and native units require separate validation before any reviewed
change. Editing a constraint clears the old result; late results cannot restore stale inputs or another report.
See the [allocation qualification record](review/DELIVERY-2026-10-01-ALLOCATION.md).

Schedules (`/schedules`) lists existing delivery definitions with a read-only preview of the next three windows.
Pause/resume/delete, destination links and recovery use the existing schedule/export engine. Timing preview performs
no provider request and does not create another schedule. Failed Sheets delivery and successful source collection
remain separate states.

## Read-only monitoring

Monitoring inbox (`/monitors`) creates an explicit rule from a retained measurement context. The workspace inbox
is always the evidence destination. Each person may separately enable brief email notices to their own verified
account address; no advertising change is sent.

`amcp_workspace` actions: `monitors`, `monitor`, `save_monitor`, `set_monitor_state`, `incidents`, `incident`,
`acknowledge_incident`, `snooze_incident`, `resume_incident`, and `evaluate_monitors`.
Saving requires operator authority, current account access, `confirmed:true`, and a monitor
containing name, platform, connection_id, account_id, currency, timezone, result_definition, attribution, metric,
comparison, threshold and max_age_hours. Up to 100 rules are retained. Supported metrics are spend, clicks,
conversions and CPA; comparisons are above/below; evidence age is 1–168 hours. Changes use the current revision.

Finished Overview snapshots evaluate matching enabled rules under the rule author's current authority. Incidents
deduplicate by rule version, objective and measurement window. Acknowledgement persists while the threshold stays
breached; only newer, complete, comparable evidence resolves an incident. Stale, missing and incomplete data never
becomes a successful zero. Freshness uses the oldest contributing row capture, not the later job completion time.
The latest evaluation records unavailable data/access or ignored older evidence. The API pages at up to 100 results;
the website has independent incident/rule search, state filters and previous/next controls. Both list actions return
`next_offset`; incident states include open, acknowledged, snoozed, resolved and superseded. `incident`/`monitor`
read an exact ID. A reporting snapshot links directly to monitor creation with its original snapshot ID.

Snooze requires the current revision and `snooze_hours` (integer 1–168). It defers `attention_state` while preserving
factual state and ongoing evaluation. Resume clears the deferral; expiry restores prior attention on the next read.
Neither action resolves evidence. Rule edits preserve paused/active state and supersede older unresolved incidents
atomically, keeping their original rule and evidence. A superseded incident is not evidence of recovery.
Resolved/superseded records cannot be snoozed or resumed.

Open a monitor detail to inspect **Your email notices**, then explicitly enable them for that rule version.
Future openings, reopenings and resolutions send a generic notice and authenticated incident link; account names,
values and report contents stay in the inbox. Existing incidents are not backfilled. Rule revision requires another
opt-in; pausing, opt-out, revoked access, security/email changes or obsolete evidence stop pending delivery. Snoozing
defers pending attention; acknowledgement withholds it. A message already submitted cannot be recalled.

`monitor_notifications` takes monitor `id` and returns your subscription, `subscription_version` and 20 recent
deliveries. `set_monitor_notifications` takes that `id`, exact `subscription_version`, `enabled` and `confirmed:true`.
Viewers can manage their own notices; arbitrary recipients and administrator/test identities are not supported.
`retry_monitor_notification` takes `notification_id`, its displayed `notification_version` and `confirmed:true`.
Only failed transient delivery can be recovered: the same encrypted recipient/body/key is reused within the
original 24-hour expiry. Five automatic attempts are allowed; one recovery permits up to ten total. `sent` means
provider acceptance, not verified inbox delivery. Configuration needs the deployment's existing email sender/key,
master key, public origin and running worker. Notice metadata lasts 30 days; failed transport does not remove inbox
evidence. See the [delivery record](review/DELIVERY-2026-10-01-MONITOR-DELIVERY.md) for limits and lifecycle checks.

The existing owner-selected report retention period includes captured analysis reports and resolved/superseded history.
Current open/acknowledged incidents and rules are preserved. Disconnecting a connection purges its retained reporting
evidence under the existing disconnect workflow.

## Portfolio, measurement and commerce

Live portfolio (`/portfolio`) supports Google Ads, Meta, LinkedIn, Snapchat, TikTok, X and Microsoft Advertising. Google campaigns, ad groups and ads use validated
signed keyset continuation bound to current actor/login/permissions, account, hierarchy, native version and page size,
with a five-minute expiry and 100-page limit. Exact customer, parent and resource identities are verified in the
account-scoped query. Duplicate, out-of-order, foreign, unsafe-integer and partial rows are refused. Each page is
limited to 100 visible entities plus one lookahead, 5 requests including retries, 60 seconds and 8 MiB. Only selected
native metadata is returned. Amounts remain exact micros; configured status is not evidence of serving. A missing
empty results array requires the exact requested native field mask and no contradictory count. This is current
inventory, not a point-in-time snapshot while a provider account changes.

Meta supports `amcp_workspace {action:"portfolio",gateway:"meta_native_action",account_id,connection_id,limit,
requirements:{entity:"campaign"}}`. Use the returned IDs for `entity:"adset",campaign_id` and then
`entity:"ad",campaign_id,adset_id`. Read each parent with the same account/login first; these ownership observations
last five minutes. Each child call re-reads the native parent and checks every returned row's exact account and
hierarchy before exposing the page or recording child ownership. A current read never grants write authority.

Meta pages contain 1–100 rows, use the provider's order/default status visibility, and retain configured and
effective status separately. Missing amounts remain null; exact native integers are not divided by an assumed
currency scale. Cursors are signed and bind the tenant/user, account/login/authorization, entity, parents and page
size. They expire after five minutes and bound a chain to 100 pages. Requests reuse only the opaque `after` token,
never a provider-supplied next URL. Repeated cursors, duplicate/overlapping adjacent pages, malformed IDs/amounts,
oversized pages, incomplete envelopes and changed scope fail. A page is bounded to eight requests, 60 seconds and
8 MiB. This is current inventory, with no guarantee of complete historical statuses or consistency across pages.
Expired parent observations require refreshing the parent inventory; other provider adapters remain qualified
native workflows in Capabilities.

LinkedIn supports `amcp_workspace {action:"portfolio",gateway:"linkedin_native_action",account_id,connection_id,limit,
requirements:{entity:"campaign_group"}}`. Read a group first, then `entity:"campaign",campaign_group_id`, then
`entity:"creative",campaign_group_id,campaign_id`. Qualified parent observations last five minutes and each child
re-reads its parents. Native account/group/campaign relationships must agree. Groups search all seven documented
statuses and include test/non-test entities. Follow the signed `next_cursor` with the same exact settings; it
expires after five minutes, binds the current login/actor/version and limits a chain to 100 pages. Each page is
bounded to 100 rows, eight requests, 60 seconds and 8 MiB. Repeated/unordered IDs and tokens or incomplete metadata
refuse the read. Empty inventory is valid. Decimal amounts keep their exact native currency; unknown timezone
stays unknown. Creative intended status, observed serving and hold reasons are separate. This is current inventory,
not a historical or point-in-time guarantee. MCP portfolio responses link to `/portfolio`.

The website uses Google ad groups, Meta ad sets and LinkedIn campaign groups/campaigns/creatives, provides parent/first-page navigation,
shows exact IDs and native states, and wraps controls at mobile widths. Account-selection changes clear previous
results immediately. Departed controls cannot initiate another read. Late responses/errors cannot repaint a newer account, route or identity. Wide tables have a
keyboard-focusable scroll region; returned headings receive focus.

Snapchat uses `gateway:"snapchat_native_action"`, exact UUID account/login bindings and `requirements:{entity:"campaign"}`.
Then select `entity:"adsquad",campaign_id`, and `entity:"ad",campaign_id,ad_squad_id`. Read qualified parent pages
first with the same login; observations and signed cursors expire after five minutes. Each child page rechecks the
full native parent chain. Limits are **50–100 rows** (the website uses 50), eight requests, 8 MiB and 60 seconds.
Only the validated opaque native cursor is reused; supplied URLs are never followed. Money stays in exact native
micros with current currency/timezone, and configured status stays separate from review status/delivery codes.
Created-at descending inventory uses provider default visibility and is not a point-in-time or deleted-entity
snapshot. [Snapchat qualification](review/DELIVERY-2026-10-02-SNAPCHAT-PORTFOLIO.md) documents the bounds.

TikTok supports the same portfolio action with `gateway:tiktok_native_action`, exact advertiser/login and
`requirements:{entity:campaign}`; follow with `entity:adgroup,campaign_id` and `entity:ad,campaign_id,adgroup_id`.
Standard v1.3 account-scoped lists use explicit non-deleted filters and exact native hierarchy checks. Current
account currency/timezone accompanies native amounts; JSON numbers and decimal strings keep their type and units.
Budget mode, operation status and secondary status remain separate. Five-minute signed cursors bind current
authority/hierarchy/page size and cap traversal at 100 pages. Changed counts and adjacent overlaps fail. Each page
has at most 100 entities, six requests including retries, 8 MiB and 60 seconds. Smart+, GMV Max and other specialized
route coverage is not implied. The page is not a point-in-time snapshot; live qualification remains separate.

X supports `gateway:x_ads_native_action` with `entity:campaign`, then `entity:line_item,campaign_id`,
then `entity:promoted_tweet,campaign_id,line_item_id`. Exact account routes, current account/parent reads and
response identities bind each page. Deleted/draft entities are excluded; post content, scheduled posts, promoted
accounts and media creatives are separate native workflows. Whole-micro amounts and original post IDs remain
exact. Configured/effective status, servability and approval remain independent and do not prove delivery.
Signed continuation binds current actor/login/permissions and hierarchy for five minutes, at most 100 pages;
repeated tokens and adjacent overlaps fail. Eight requests including retries, 103 parent/inventory rows, 8 MiB
and 60 seconds bound a page. Provider-order pagination is not a fixed snapshot.

Microsoft Advertising (RPT-07, B27) uses `gateway:microsoft_ads_native_action` with `entity:campaign`, then
`entity:ad_group,campaign_id`, then `entity:ad,campaign_id,ad_group_id` (the Google hierarchy, so the website
drill-down is the same). Microsoft does not page `GetCampaignsByAccountId`, `GetAdGroupsByCampaignId` or
`GetAdsByAdGroupId`, so each page reads the complete collection and serves an ascending native-ID slice: campaigns are
requested with every documented `CampaignType` (the API returns only Search campaigns by default) and ads with every
documented `AdType`. A collection above 1000 entities is refused with `PORTFOLIO_COLLECTION_LIMIT`, never truncated.
The signed five-minute cursor binds the actor, login, account, hierarchy, page size and the collection's content; a
collection that changes between pages is refused with `PORTFOLIO_CHANGED` so a reader restarts instead of merging two
states. Parents must be observed in the same login's portfolio first, and each child page re-reads its current parent
campaign (and ad group) by ID. Money (`DailyBudget`, `CpcBid`) stays unconverted decimal account currency; undocumented
campaign or ad types, repeated or malformed IDs and negative amounts refuse the page. `portfolio_reconcile` compares
two complete Microsoft observations like the other providers. There is no Microsoft guided evidence capture, so the
page offers no capture link.

### Google Ads change history

Below the inventory, **Google Ads change history** reads what changed in one selected Google Ads account (PRV-07).
Choose account-local dates: at most 30 days, starting no earlier than 29 days before today, because Google keeps
change events for 30 days. A wider or older window is refused in the page and again by the server, before any
request. One fixed `change_event` query (at most 1,000 events from the page, 10,000 over MCP, newest first) returns
the native resource type, operation, the tool used (`client_type`), changed field paths and the changed resource,
campaign, ad group or asset. Who made a change (`user_email`) is personal data and is never requested; old and new
values are not requested either. The page shows a timeline per day and counts by resource type, operation and tool
in English or Arabic; native values stay literal, and rows page 50 at a time without another read. A full read is
labelled: older changes in the window may exist. A response for another account, login or window, or with any
unselected field, is refused rather than shown. Nothing is saved. MCP: `amcp_workspace {action:"change_history",
gateway:"google_ads_native_action",account_id,connection_id?,requirements:{date_from,date_to,limit?,resource_types?}}`.

Measurement (`/measurement`) connects the existing Google Tag Manager configuration audit with GA4/Search Console
reporting, client conversion mappings and reviewed contract discovery. `measurement_audit` takes an exact GTM
account/login and optional container/workspace requirements. It establishes configuration evidence; actual event
delivery, deduplication and business attribution remain unmeasured by that audit.

**Inspect a sanitized event trace** is a separate browser-local task. Choose a
GA4 property and explicitly inspect version-1 synthetic scope, relative step
times, consent declarations and event observations. The editor rejects raw
URL/cookie/user-ID fields, original transaction identifiers, duplicate keys,
foreign property scope and invalid order. The table pages 25 steps and preserves
inherited or unknown consent state. Findings concern the supplied observations;
repeated purchase keys do not establish native double counting, and an event
under denied consent can be cookieless. The trace is never sent or retained;
Clear/navigation/identity changes discard it. Native/runtime consent,
deduplication and attribution remain unverified. See
[input shape and actual qualification](review/DELIVERY-2026-10-07-TRACE-RECOVERY.md).

Version 1 stays accepted unchanged. **Trace version 2** (MSR-03) adds `scope.visitor_region` (a region code such as
`US-CA`, or null), an optional `region` list and `wait_for_update_ms` (0–60,000) on consent defaults, and
`transaction_id_empty:true` on a purchase. It applies the most specific default that matches the declared visitor
region and keeps types an earlier default set unless a later one declares them; without a declared visitor region a
regional default is reported as `default_region_unknown` and only agreeing values survive. Events inside a declared
wait are consent-unknown (`event_during_consent_wait`), and a default that follows an update of the same type is
`ordering_ambiguous` (the type becomes unknown), not a conflict, because the documentation does not establish which
applies. In both versions the hashed empty transaction ID (and `transaction_id_empty`) is flagged as
`empty_transaction_key`, since GA4 deduplicates every purchase whose transaction ID is empty. Declared storage writes
have their own columns, and the trace stream is compared with the property's synchronized data streams (listed,
not listed or not synchronized; a non-web stream notes that transaction-ID deduplication applies to web streams).
A pasted trace over 128 KiB reports its size, not invalid JSON.

**Convert a dataLayer export or HAR file in this browser** (MSR-03) fills the trace field with a version 2 trace.
The chosen file's size is checked before it is read (2 MiB for a dataLayer export, 16 MiB for a HAR file), and it is
read only in the page: nothing is uploaded, stored or sent, and no request is made. A dataLayer export keeps only
`gtag('consent','default'|'update',…)` commands with the four Google consent types (with `region` and
`wait_for_update` on defaults), event names from `gtag('event',…)` and pushed `{event}` entries and, for a purchase,
an HMAC-SHA-256 of its transaction ID under a random key generated in the page and never exported or stored (an empty
ID becomes `transaction_id_empty`). A HAR file keeps only the event names (`en`) of GA4 `/g/collect` requests whose
`tid` is the synchronized measurement ID of the chosen stream (every GA4 stream, with a notice, when it is not
synchronized); GA4 does not document `gcs`/`gcd`, so a HAR import derives no consent. URLs, cookies, user and client
IDs, raw transaction IDs and every other parameter are left out. Times follow the original order (real timing is
unknown), coverage is always `partial`, and a session longer than 1,000 steps or 128 KiB keeps its first steps with a
notice. The synthetic test identifier is generated locally and can be replaced.

A workspace audit includes **Workspace consent settings**: filter additional-consent states, search native tag
names/IDs/types and page 50 rows at a time. Required literal consent types remain native; unsupported or variable
settings stay unknown. Omitted settings use the API default, while built-in checks, defaults/updates, runtime
order and event delivery stay unverified. This inventory does not classify legal compliance or publish changes.
The MCP audit handoff preselects only a current exact login/account/container/workspace on the website. Opening
it makes no provider request; select **Read configuration evidence** for a fresh audit.

The audit also summarizes the **published (live) version** it already reads: `live_consent_evidence` lists each
live tag's additional-consent setting, and a workspace audit adds `consent_diff`, a per-tag **Published vs draft
consent** comparison (`same`, `differs`, `draft_only`, `live_only`, `unknown`). Both reuse the version read, so the
request count is unchanged. An oversized or unrecognized live tag list is reported `unavailable`; foreign or
duplicate tag identities still fail the audit. The comparison does not show which version a site serves.

Trigger references missing from the workspace inventory (often provider-managed built-in triggers) produce **one**
`UNRESOLVED_OR_SYSTEM_TRIGGER` finding per trigger ID, with `entity_count`, `tag_count` and up to 20
`sample_paths`; the code, message and localization keys are unchanged. `complete` means every read succeeded. The
list keeps at most 1,000 findings, errors and warnings first; `finding_list:"truncated"` (with `finding_count`)
reports a shortened list without marking the audit incomplete. The website pages findings 25 at a time with a
severity filter.

The consent draft offers the seven documented Google consent types (`ad_storage`, `analytics_storage`,
`ad_user_data`, `ad_personalization`, `functionality_storage`, `personalization_storage`, `security_storage`) as
checkboxes. Any other literal type, such as the typo `analytic_storage`, needs
`requirements.custom_types_acknowledged:true` (refused with `CONSENT_CUSTOM_TYPES_UNACKNOWLEDGED` before any read
otherwise). Acknowledged non-standard types are returned as `scope.custom_types` and labelled in the preview, the
draft brief and each review step description. The draft stays additive-only, literal-only and unpublished.

Portfolio scope, catalog preview guidance and selected audit explanations are available in English/Arabic.
GTM findings show translated labels and severity beside the exact original code/path; observation limits are
displayed as a readable list. Dynamic findings use validated typed metadata for duplicate entity kinds, exact
trigger IDs and missing live/latest versions. Unknown messages or unsupported metadata keep the original text.
The expandable audit evidence retains the original messages and does not gain a live-tracking qualification.

Measurement also offers **Recent GA4 events**. Select an exact login/property, 1–20 case-sensitive event names,
a 1–30 minute window and optionally one stream ID. `measurement_events` takes the GA4 gateway, numeric property
`account_id`, `connection_id` and `requirements:{event_names,minutes?,stream_id?}`. Names support Unicode
letters/digits and underscores, starting with a letter, up to 40 characters; the default window is 30 minutes.
The response preserves count strings, null for absent events, native minute/stream rows, scope, times and source hash.
It performs a read-only realtime POST, bounded to 3 requests, 1,000 rows, 2 MiB and 30 seconds. Narrow the window,
events or stream if the complete table exceeds that bound. Changed scope or malformed/partial evidence is refused.
The website shows the same evidence in English/Arabic and clears it when inputs change. It never sends a test event,
polls automatically or saves a report snapshot. Positive counts establish reported aggregate activity only; missing
or zero counts may reflect delayed processing. Specific test identity, consent, deduplication, attribution and overall
tracking health remain unverified. The [delivery record](review/DELIVERY-2026-10-02-MEASUREMENT-EVENTS.md) explains qualification.

**Inspect a specific GA4 test identifier** uses an already registered event-scoped `amcp_test_id` custom dimension.
Choose an exact login/property, event name and original synthetic `amcp-test-` identifier. Enter explicit dates
covering at most seven property-calendar days, optionally a stream ID, and your declared expected count (1–1,000).
Generating an identifier is local and is useful only before your own separate instrumented test. AMCP does not
register the dimension or send a test event. Reading checks the dimension before/after a bounded exact-filtered
core report; source references remain inspectable. Counts remain exact strings and absent evidence stays null.
Above/below/matching counts compare only with your declaration. Higher counts are not proof of duplicate delivery,
and missing/zero counts can reflect processing lag or filters. Consent, deduplication and attribution remain
unverified. Original scope handoffs prefill without reading. Edits or generation clear prior evidence and pending
results cannot overwrite a newer selection. See the [qualification record](review/DELIVERY-2026-10-03-MEASUREMENT-IDENTITY.md).

**Realtime test identity** (MSR-04) is the faster report source of the same task. Choose **Realtime: user scope, test
properties only** and a window of the last 1–30 minutes instead of dates. It reads a user-scoped
`customUser:amcp_test_id` through the GA4 Realtime API, which cannot filter event-scoped dimensions, and only on a
property the workspace owner marked as a test property (`amcp_workspace save_ga4_test_property`; otherwise
`MEASUREMENT_TEST_PROPERTY_REQUIRED` before any GA4 request). The user-scoped dimension is checked before and after.
Counts cover every event of the synthetic test user, so a match is user-level, not event-level proof, and realtime
processing can lag a few minutes. The value persists on the test user: use a fresh identifier and a dedicated test
browser or device for each test. The GA4 configuration read reports `checks.realtime_identity_dimension`.

**LinkedIn conversion settings** reads current configuration for one selected login/advertising account.
Inspect native rule IDs, registration method, reported ownership, enabled state, type, attribution model,
click/view windows and exact configured values. Missing fields remain unknown; provider defaults do not fill
missing observations. This finder requests the provider default owned-rule selection, without shared rules.
Its collection_request describes the request separately from each reported ownership value. Search native
names/IDs/types/methods/ownership locally and page 50 rows without another native request. Complete older
envelopes without new fields stay readable with unknown metadata. See the
[method, ownership and scope qualification](review/DELIVERY-2026-10-05-LINKEDIN-CONVERSION-METADATA.md).
The MCP action is `measurement_conversions` with `gateway:linkedin_native_action`, exact `account_id` and
`connection_id`; it accepts no additional requirements. Its scoped website link only preselects the account.
The **Observed activity** column (MSR-04) shows LinkedIn's own `lastCallbackAt` (the last time a rule's URL match
fired) and `latestFirstPartyCallbackAt` as `last_callback_at` and `latest_first_party_callback_at` (epoch
milliseconds). LinkedIn may take about 20 minutes to update them. A missing time is Unknown, never "never fired",
and a time does not verify event delivery. The times stay out of conversion-rule write fingerprints.

Collection requires existing `r_ads` or `rw_ads`, verifies native account identity/currency before and after,
checks current authority around each read and retains source request/hash/time references. Bounds: 1,000 rules,
25 pages, 30 requests, 8 MiB and 60 seconds; partial, changed or foreign-account evidence is refused. No snapshot
is saved. Configured value is a rule setting, not spend or observed revenue. Campaign membership, event delivery,
deduplication, consent and historical report attribution remain unverified. Current settings do not establish
earlier reporting windows. No rule is changed or test event sent. See the [delivery record](review/DELIVERY-2026-10-02-LINKEDIN-CONVERSION-EVIDENCE.md).

**Google Ads conversion goals** (MSR-02) reads one selected Google Ads customer's account-default conversion
goals, enabled primary conversion actions with their value settings, and the last conversion date and last tag
detection Google Ads reports. The MCP action is `measurement_google_goals` with
`gateway:google_ads_native_action`, exact `account_id`, `connection_id` and optional `requirements:{currency}`
(when omitted the observed account currency is reported). It reuses the recipe goal inspection unchanged in
scope: every collection is read twice and must match, within 64 requests, 4,000 rows, 2 MiB and 60 seconds.
Manager accounts and customers whose conversions are tracked by another customer are refused instead of guessed,
and an incomplete read is labelled incomplete with no partial ready status. A fence covering the actor, the
login's account access, its stored credential and the owner write pause wraps the whole read; any change refuses
the response. `provider_mutations` is 0 and nothing is saved. Configuration is not proof of delivery,
deduplication, consent or attribution. The scoped website link (`/measurement?google_goals=1&…`) only
preselects the account.

**Measurement scope** (MSR-02) is chosen once at the top of `/measurement`: a Tag Manager account, then a
container from the synchronized inventory (or one the audit discovered) and a workspace the audit discovered; a
GA4 property and one of its synchronized data streams; a Google Ads account and a LinkedIn account. Choosing fills
each task's own fields and clears their earlier results; it never starts a read. The scope is kept only in the
page URL (`ms_*` parameters); entries that no longer match an account selected for the current identity are
removed with a notice. Each task keeps its free-text fields as a fallback for stale inventory. A container-level
or account-level audit now lists the workspaces or containers it found with **Use this workspace/container**
buttons instead of only raw JSON. Every task with no eligible account shows how to connect one (with a
Connections link) and disables its read; a single eligible account is preselected, so **Load a synthetic example**
works without a prior choice and otherwise explains inline which property to choose.

**GA4 property configuration** (MSR-03) reads one property's key events, custom dimensions and metrics, data
streams (with type and web measurement ID), Google Ads links and data retention through fixed GET routes of the
pinned Admin API v1beta under the existing analytics read permission. The MCP action is `measurement_ga4_config`
with `gateway:ga4_native_action`, numeric property `account_id`, `connection_id` and optional
`requirements:{sections}`. Every list is read completely (ten pages per list; 60 requests, 4 MiB, 60 seconds); a row
of another property, an unknown enum, an unpinned field, a repeated page token or a duplicate resource refuses the
read, and the login, permission and actor are rechecked around each request. It reports whether an event-scoped
`amcp_test_id` dimension exists (the test-identifier task needs it) and how many web streams exist. Google Ads link
creator e-mail addresses are checked and never returned. The website relates each stream's measurement ID to the
Google tag IDs of synchronized Tag Manager containers without a request; discovery now keeps each data stream's type
and web measurement ID and each container's public ID and Google tag IDs. Nothing is saved; configuration is not
proof of delivery. The scoped website link (`/measurement?ga4_config=1&…`) only preselects the property.

**Measurement evidence ledger** (MSR-03) shows, for one asset, where the evidence stops, in six fixed layers:
configuration, provider-observed activity, provider diagnostics, supplied runtime trace, consent and attribution
settings. Each layer is `observed`, `unknown`, `unavailable` or `not_applicable` with a reason code. A layer is
observed only from complete evidence of the selected asset; a failed, partial, foreign or thresholded read leaves only
that layer unknown with its error code and never upgrades it (a provider's own refusal also keeps its allow-listed
facts, D21: `http_status`, `provider_code` and `request_id`, never its message). Owner direction P8 (2026-10-11) made Measurement the
multi-provider conversion-health hub, so the MCP action `measurement_ledger` takes `gateway`
(`google_ads_native_action`, `ga4_native_action`, `meta_native_action`, `snapchat_native_action`,
`tiktok_native_action`, `google_search_console_native_action` or `adjust_native_action`), exact `account_id` and
`connection_id`, and for the three pixel providers an optional `requirements:{pixel_id}`. Every adapter is read-only:
no test event, Conversions API call, `/events/validate` request or provider change is ever sent.

- **Google Ads** reuses the conversion goals read (configuration; last conversion date and tag detection as activity,
  observed only when every primary action reports both), then reads `offline_conversion_upload_client_summary`
  (diagnostics: client, status, event counts, success and pending rates, last upload and alerts; no upload is
  `not_applicable`) and the attribution model and lookback windows of enabled conversion actions. Enum values are
  checked against the pinned v25 document. A manager or shared-conversion customer leaves every Google Ads layer
  unknown and nothing else is read.
- **GA4** reuses the configuration read, then one 30-minute realtime count of the property's key events (no
  reported key event stays unknown; a property without key events is not applicable). GA4 offers no diagnostics API,
  and its attribution settings exist only in the unpinned Admin API alpha (`unavailable`).
- **Meta** lists the ad account's pixels (`GET act_{id}/adspixels`, bounded pages; configuration with each pixel's
  owner business and last fire time). That validated list is also the ownership evidence: for five minutes this
  connection may read only two aggregate routes of a listed pixel, `/{pixel}/stats` and
  `/dataset_quality?dataset_id=`, never the pixel node, its other edges or any write (`src/meta-dataset-scope.ts`).
  Activity is 24 hours of hourly stats summed per event (AdsPixelStats entries `value`, `count`, `event`,
  `diagnostics_hourly_last_timestamp`); diagnostics is the Dataset Quality API for web events (match quality out of
  10 and match-key coverage, Conversions API coverage, deduplication-key coverage, upload frequency, ACR). Meta's
  description texts are never kept. Dataset quality needs `ads_management`, or `ads_read` with `business_management`;
  without either it stays unknown (`quality_permission_missing`) and no request is sent. Advanced access tiers are
  tracked in ACC-05.
- **Snapchat** lists the ad account's pixels (a pixel of another account refuses the list), then the domains that
  fired the pixel in the last 7 days (`/v1/pixels/{id}/domains/stats`) and the Signal Readiness scores and
  recommendations (`/v1/pixels/{id}/event_quality_scores`; codes, priority, score and title, never descriptions).
  Snap intends Signal Readiness for internal monitoring and asks for review before any public display; AMCP shows it
  only to signed-in workspace members.
- **TikTok** lists the advertiser's pixels in bounded pages with ownership (owned, or shared/unbound), then reads the
  selected pixel's event statistics ("Get Pixel Event statistics", `GET /v1.3/pixel/event/stats/`) with the request
  TikTok's official Business API SDK specification documents (`advertiser_id`, `pixel_ids` and `date_range`
  `{start_date, end_date}`, JSON-encoded). The dates have no documented format: AMCP sends the last seven complete UTC
  days as `YYYY-MM-DD`, which is a guess, not TikTok's documented format. AMCP sends a provider request only as a pinned
  document states it, so this read follows the pinned specification (`yml_files/pixel_event_stats.yml` of
  `tiktok/tiktok-business-api-sdk` at commit `f809c396`, pinned on 2026-10-17 with its SHA-256 and the request fields
  it documents; see [operations](OPERATIONS.md)). Without a pin, or when the pin documents another method, path, field
  or date format than AMCP sends, activity is `unavailable` (`unpinned_request`; a differing pin is named with
  `evidence.problem`) and nothing is sent. With the pin, the evidence names the pinned file the request followed
  (`request_specification`). The specification leaves the answer's `data` unspecified and the portal page's response
  table is drawn by TikTok's scripts, so AMCP checks only the documented envelope (`code`, `message`, `request_id`,
  `data`) and safety: at most 200 values, 6 levels and 100 items an array, field names of letters, digits and `_`, no
  unsafe number, no text over 128 characters, and no `pixel_id`, `pixel_ids`, `pixel_code` or `advertiser_id` other than
  the selected ones (each refused whole: the layer is unknown with `read_failed`; a failed envelope keeps TikTok's
  `provider_code` and `request_id`, never its message). Otherwise every value is returned as TikTok sent it, by path
  (`stats[0].count` style), and activity stays `unknown` (`unconfirmed_fields`, `field_meanings: "unconfirmed"`,
  `day_basis: "unconfirmed"`): AMCP names no field's meaning and never reports TikTok activity as observed until an
  owner-run read under ACC-06 confirms the fields and their day basis. The website lists the first 20 values literally.
  TikTok exposes no event-quality diagnostics to these reads.
- **Search Console** reads the site and the login's permission level (an unverified user stops there:
  `site_unverified`), seven complete days of final web search totals grouped by date in Pacific time (no final data
  stays unknown; data lags several days) and the submitted sitemaps with errors, warnings and pending state. Wire
  values follow Google's public reference (camelCase such as `siteOwner`, `sitemap`, `byProperty`). It has no consent
  setting and attributes no conversions (`not_applicable`).
- **Adjust** reuses the qualified Report Service reads (app grant, shared source-IP permit, token fence, audit
  record): the app's event catalog and seven complete UTC days of installs and events. A report with warnings or
  missing totals stays unknown (`report_incomplete`). Adjust apps are bound administratively, so the website lists
  them only when the workspace shows them; the MCP action always covers them.
- Pixel selection: the ledger reads the requested pixel when the account lists it, otherwise the account's only pixel.
  Several pixels without a choice (`pixel_not_selected`) or an unlisted pixel (`pixel_not_listed`) leave activity and
  diagnostics unknown without a pixel read; an account without pixels is `not_applicable`. Attribution windows belong
  to ad sets, ad groups or reports, not pixels (`not_pixel_setting`).
- Supplied traces never reach AMCP (`unavailable`, see the trace task), and no advertising provider exposes a consent
  setting to these reads (the Tag Manager audit reports tag consent configuration).

A change of actor, login, account access or (for Google Ads) the owner write pause refuses the whole ledger. One
allowance bounds it (96 requests, 8,000 rows, 8 MiB, 150 seconds; each adapter's own collections 24 requests, 2,000
rows, 2 MiB, 60 seconds), and `network_requests` counts every request. Nothing is saved, `provider_mutations` is 0 and
delivery, deduplication, consent and attribution stay unverified. `AMCP_MEASUREMENT_LEDGER_OFF` (a comma-separated list
of gateways) withdraws an adapter without a release. The website task lists Google Ads accounts and GA4 properties
first (it follows the kind last chosen in the scope bar), then Meta, Snapchat, TikTok and Search Console accounts,
with an optional pixel or dataset ID field that is sent only for a pixel provider. It explains each reason in English
or Arabic, keeps native values literal, links each layer to the task that holds its detail and accepts
`/measurement?ledger=1&gateway=…&connection_id=…&account_id=…[&pixel_id=…]` handoffs without reading.

Native acceptance (ACC-06) remains: one authorized read-only ledger call per adapter on a designated asset, which
also confirms the AdsPixelStats entry shape and the Meta access tier.

Commerce (`/commerce`) validates explicitly supplied Meta or X product CSV before creating an unapproved plan. The following native hundredths and optional-field rules describe Meta; X requires all ten source fields, exact original price/currency strings and explicit upsert as described below. Fields: retailer_id, name,
price, currency, image_url; optional url, availability, condition, brand and description. Files are capped at 192 KiB
and 500 products (more than 50 are saved as one plan group, see
[large stores](#large-stores-saved-column-mappings-and-plan-lineage)), with unique stable retailer IDs and HTTPS
media/product URLs. `catalog_preview` does no provider
egress; `catalog_plan` saves one native product step per item. Both require the exact selected account/login/catalog ID
and an explicit `allow_upsert` boolean. Decimal prices become exact integer hundredths through the existing qualified
Meta product contract. The precision applies to the value, not the text: `12.500 KWD` is 1250 and `0.10` is 10, while
`12.345 KWD` is refused with that price and currency named, because Meta counts hundredths; nothing is rounded.
Every item then gets the normal native ownership, before-state, review, receipt and
verification path. There is no implicit deletion and no direct write on import. WooCommerce synchronization,
simultaneous destination fan-out and automatic feed deletion are not implemented.

The page opens with the reviewed import and says that product imports support Meta and X, while Snapchat catalogs
change only through feeds and their products are compared read-only (COM-02 D). With no Meta, X or Snapchat account
it links to Connections. WooCommerce store sources follow the
import; until a source is configured they sit in one collapsed "Connect a store source (administrators)" disclosure.

The native product review and verification require exact account/catalog/business identities and a complete,
bounded product page for the selected retailer. Malformed rows, foreign retailers, unfinished paging and coerced
IDs are refused. Price and sale-price proof must identify the same product as the original mutation receipt.
Read-back checks current account/catalog ownership again; incomplete proof cannot become a verified result or
permission to repeat the product mutation. See the [catalog evidence repair](review/DELIVERY-2026-10-03-CATALOG-EVIDENCE.md).

For supplier or WooCommerce CSV exports, select **Map supplier or WooCommerce export columns** and load the file.
Choose source columns for the stable retailer ID, name, decimal price and image URL. Use either a currency column
or one explicit currency for all rows. Regular/sale price choice is explicit; sale dates, tax, stock and variants
are not interpreted. Select the first-URL image mode only when the source contains a comma-separated list.
All source rows are mapped, up to 500. Only the selected columns leave the browser: AMCP saves the mapping as this
account catalog's versioned column mapping and maps the rows on the server, so a later import of the same catalog
starts from the saved columns. Inspect **Exact product fields sent for review** before saving the draft. Changing a
file clears its mapping, and changing any input invalidates its preview/save.
Header names must be unique/nonempty (1–100 columns, up to 200 characters each). Use UTF-8 CSV; a leading BOM is
accepted. This is a local export-import workflow, not a connection to a live store. See the
[mapping delivery record](review/DELIVERY-2026-10-02-CATALOG-MAPPING.md).

## Client report packs and recovery

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
[download limits and evidence](review/DELIVERY-2026-10-01-CREATIVE-REPORTS.md).

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
described below. See the [branding delivery record](review/DELIVERY-2026-10-01-PROFILE-BRANDING.md).

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
[outcomes and recovery](WRITE-OPERATIONS.md#outcomes-and-recovery)), failed monitor email notices (`kind:notice`, for
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
its navigation name, its former names ("Media library", "MCP connectors", …) and their Arabic translations. The access
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
`tests/website-deep-links.test.mjs` and `tests/portfolio-url-state.test.mjs` cover these.

**Website composition and markup (WEB-07).** A page's lazily loaded scripts are its registry entry's `assets`. Scripts
extend the shell through `AMCP` (`web/routes.js`): `AMCP.routes.register(path, {render})` gives a workspace page its
body (one per page; a second is refused; Live portfolio, Measurement and Commerce register theirs from their own
modules, see [website feature loading](OPERATIONS.md#website-feature-loading)), `AMCP.routes.extend(path, part,
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
[workbook Operations delivery record](review/DELIVERY-2026-10-01-WORKBOOK-OPERATIONS.md).

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
See the [workbook schedule delivery record](review/DELIVERY-2026-10-01-WORKBOOK-SCHEDULES.md).

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
[saved query delivery record](review/DELIVERY-2026-10-01-REPORTING-MANAGEMENT.md) for limits and qualification.

Client packs can also be delivered on the existing report schedule to a local **PDF / Excel destination**.
Create it in the delivery dialog with explicit formats, branding and storage confirmation; a Sheets connection is
optional for this flow. Schedules collect their original scoped definition and queue a separate file job from the
retained snapshot. Delivery status, history and Operations preserve the original export ID and job. Successful
formats survive a failed-format retry, and each download rechecks current source access. The job freezes its
branding and source fingerprint. Encrypted files follow snapshot deletion/retention, with 20 MiB per-file and
256 MiB encrypted-storage limits per workspace. Complete-only partial snapshots remain undelivered.
The [reporting guide](REPORTING-OVERVIEW.md#scheduled-pdf-and-excel-files) documents the shared MCP contract,
queue limits and recovery. External email, Drive-folder and object-storage file destinations are not implemented.

## Allocation proposals and native budget drafts

Google campaign allocation results offer **Prepare a native budget draft**. Explicitly choose equal-daily conversion,
read the current dedicated daily budgets and inspect the exact amounts, micros and rounding residuals. Confirmation
saves a source-bound, unapproved Campaigns plan. Average daily amounts continue until separately changed; the
reference period does not schedule an end date or guarantee a period spend. Shared/lifetime/foreign budgets and
changed source/ownership are refused. The original source and current native ownership are checked before unsent
proposal steps, while the existing native review, spend acknowledgement and read-back remain required.

Google repeats the complete selected campaign/budget observation under one ten-attempt, 100-row,
2 MiB, 60-second budget and refuses changed supported native state before retaining the preview.
Snapchat repeats each selected ad-squad budget inside its existing parent/account brackets;
LinkedIn retains its independent-budget/group/account consistency checks. Original request/time
references identify the observations. Matching sequential reads are not an atomic snapshot.

Each daily amount rounds down to the smallest unit of the account currency (USD 0.01, JPY and CLP 1, KWD 0.001),
which Google requires (`NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT`); the preview shows `minimum_unit_micros` and the
residual, and period floors are checked after rounding. LinkedIn drafts also read the account's daily budget limits
once (`adBudgetPricing`, priced for the first selected campaign) and refuse a daily amount outside them with
`ALLOCATION_BUDGET_LIMIT`; when LinkedIn states no exact limits the preview says `daily_budget_limits.status:
"unavailable"` and LinkedIn checks the amount at execution.

MCP uses `preview_allocation_plan` with report `id`, allocation `options` and `conversion:"equal_daily"`, followed
by `create_allocation_plan` with the same `id`, exact `preview_id`/`preview_hash` and `confirmed:true`. Preview is
bound to the current session and lasts ten minutes. Follow its returned `amcp_campaign get` and website link to
inspect the original draft. Lost responses reuse the same plan. `amcp_campaign create` also supports optional
stable creation keys. See the [native budget-draft record](review/DELIVERY-2026-10-01-ALLOCATION-PLANS.md).

### Factor provenance and indicators (DEC-02)

**Use these historical factors** copies a retained calibration's envelope into the model and sends
`factor_source {kind:"calibration", evidence_fingerprint, ids, options}` with it. The server recomputes that
calibration and refuses `ALLOCATION_FACTOR_PROVENANCE` when the fingerprint, the factors or the entities differ, so
a proposal never claims history it does not have. The provenance is part of `model_fingerprint` (the same numbers with
and without it are different proposals), `assumptions.factor_provenance`, the limitations and the draft brief. Typed
factors say they have no historical provenance; calibrated ones say the calibration was one-day and spend-conditioned.

`allocation_indicators` compare each proposed daily average with the entity's observed daily spend range
(`proposed_to_observed_spend`; `outside_observed_range` means the linear model extrapolates there). The native budget
preview shows `budget_utilization` (observed spend ÷ today's daily budget × evidence days; below 80% is flagged, and
today's budget may differ from the one in force then) and, for Google, each campaign's Search budget-lost impression
share over the evidence period from one extra read after the two budget observations (`search_budget_lost_impression_share`:
`read`, `not_search`, `not_reported` or `unavailable`; Google reports shares above 90% as 0.9001, shown as "more than
90%"). Indicators are descriptive and never gate a proposal; a refused indicator read leaves it unavailable.

### Meta budget drafts (DEC-02)

A guided `meta_campaign` report can become a native draft of at most 20 campaigns. Inside one bounded bracket AMCP
reads the account (identity, currency, time zone, active status), observes every campaign in the account's own
collection, reads each campaign with its ad sets twice, and refuses anything it cannot bind exactly
(`ALLOCATION_BUDGET_MODE`): lifetime campaign or ad-set budgets, a campaign and ad-set budget at once, ad-set budgets
split across several spending ad sets, reserved buying, more ad sets than one bounded read, or a mode that changes
between observations. A campaign daily budget (Advantage campaign budget) is drafted with `meta_campaign_id_update`;
a campaign whose budget sits on its one spending ad set is drafted on that ad set with `meta_ad_set_id_update`. Amounts
are whole Meta minor units of the pinned currency offset (`daily_budget_native`), rounded down and never converted;
a currency without a pinned offset is refused before any read. The draft is unapproved and source-bound like the other
providers; every step still needs native review, spend acknowledgement, owner caps and read-back. On the website,
**Prepare a native budget draft** names the owner (campaign budget or ad set) and the minor units, and the saved plan
shows them in English and Arabic.

### Outcome review (DEC-02)

When every budget step of an allocation plan has been executed and verified by read-back, AMCP schedules its outcome
review. The outcome window is the plan's reference length (the evidence period's days), starting on the first
account-local day after the last verified step, so the new budgets were in force all day; it is complete once its
last day has ended in the account time zone. Nothing is read before then: `capture_allocation_outcome` refuses with
`ALLOCATION_OUTCOME_NOT_DUE`. After the window closes, a background job (as the person whose verified execution
completed the plan) repeats the proposal's own guided preset on the same login, account, currency, time zone,
attribution and result definition, and retains it as ordinary guided evidence. A provider that has not finalized the
window (Snapchat) or a rate limit is retried up to six times with growing delays; any other refusal is recorded and an
authorized member can review the outcome from the plan page (**Review the outcome now**) or with
`capture_allocation_outcome {id}`. A verified plan without an outcome record (it completed before this release, or
recording it failed) gets one when its owner, an administrator, an editor or an approver opens the outcome; a plan viewer
only sees `not_scheduled` with the reason `not_recorded`, so the background review never runs as a viewer.

`allocation_outcome {id}` (the campaign plan ID) shows the window, state and results: per entity and in total, the
proposed budget, realized spend and its share of the proposal, realized conversions beside the range the proposal
modeled at the proposed budget, the same range at the realized spend, and a realized factor on the proposal's
efficiency scale (1.0 is the evidence period's conversions per unit of spend), all exact at nine places, half to even.
An entity without outcome rows stays unknown and partial days are named; nothing is counted as zero. These are
observational comparisons: they do not show that the budget change caused a difference, are not forecast accuracy and
are not adjusted for seasonality, auctions, creatives, tracking or attribution changes. The outcome capture is offered
as calibration evidence (`calibrate_allocation` when it covers 14–31 closed days). A plan whose evidence was deleted
or changed, or whose proposal can no longer be reproduced exactly, is recorded `unavailable`. At most 500 outcome
records are kept per workspace; the oldest finished ones are removed first. Causal experiments (Google experiments,
LinkedIn lift tests) stay separate workflows.

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
cannot load, English remains usable. See the [foundation](review/DELIVERY-2026-10-01-ARABIC-FOUNDATION.md) and
[connection/control localization record](review/DELIVERY-2026-10-01-ARABIC-CONNECTIONS.md).

## Qualification boundaries

All additions use synthetic fixtures and existing provider contracts. No new OAuth scope, provider program,
advertising mutation, notification destination or deployment is authorized by this guide. Full Arabic translation,
broader objective recipes, additional portfolio providers, broader creative performance lineage and calibrated optimization
retain unfinished scope in the implementation matrix. See the dated implementation record for actual tests, browser checks and deployment
limitations rather than treating a capability card as live acceptance.

## Search-term exclusions from retained evidence

Open a completed guided Google search-term report in Reports. Choose minimum clicks (default 30) and maximum
evidence age (default seven days), then read possible exclusions. This uses retained rows without a provider call.
Known zero conversions is a selection aid, not proof that traffic has no business value. Review relevance and
conversion lag. Unknown metrics stay unknown. Only unchanged literal terms up to 80 UTF-16 characters/ten words
using letters, marks, numbers, spaces and apostrophes enter this guided subset.

Select one to 20 original rows across pages, then preview current native context. AMCP checks selected groups and
current exact keywords; conflicting positive or negative exact keywords block the proposal. Broader/phrase and
campaign/shared/account-level coverage is not assessed. Confirming saves an **unapproved** draft under Campaigns.
It changes no advertising account. Separate approval, spending acknowledgement, native review and verified execution
remain required. A save retry retains the original preview and reuses its plan. Source or selection changes require
a fresh preview; previews expire after ten minutes. See the [delivery record](review/DELIVERY-2026-10-02-SEARCH-EXCLUSION-PLANS.md).

MCP: `amcp_decision_report {action:"search_exclusion_candidates",id,options:{minimum_clicks,maximum_age_days},offset?,limit?}`;
follow `next_offset` and explicitly select native row IDs. Then call `preview_search_exclusions` with the same
report, options and `ids`. Use its exact `preview_id`/`preview_hash` with `create_search_exclusion_plan`,
report `id` and `confirmed:true`. Candidate reads support readers; preview/save require an operator/admin.

## Organic and paid search overlap

`amcp_workspace {action:"search_overlap",gateway:"google_ads_native_action",account_id,connection_id?,
requirements:{site_url,gsc_connection_id?,date_from,date_to,row_limit?,max_rows?,include_pages?}}` (PRV-07, MCP
only) reads the Search Console property's queries (`searchAnalytics.query`, dimension `query`, web,
`dataState: final`) and the customer's `search_term_view` for the same closed dates (at most 90 days, before today;
1–25,000 rows per source), and joins them locally on normalized text (NFKC, lower case, collapsed spaces). Every
match is labelled `approximate_normalized_text`: the products match queries differently, Search Console omits
anonymized queries, both report top rows (`top_rows_only`, `complete:false`), their days use different time zones,
and final Search Console data trails by two to three days (`recent_days_may_be_missing`). The table classifies each
query as `both`, `paid_only` or `organic_only`, keeps exact paid micros, clicks and conversions and an
impression-weighted organic position, and sorts deterministically. `include_pages:true` adds one `query × page`
read and lists each organic query's top three landing pages; those by-page metrics rank pages within a query and do
not add up to its totals. `review_hint` marks a strong organic position with paid spend, or a converting paid-only
term; it is a prompt for review, never a change. Findings feed the reviewed paths above: each paid row lists its
native `search_term_views` (up to 20, with `search_term_view_count`), the ids `preview_search_exclusions` takes from
a retained `google_search_terms` report of the same dates; a keyword is prepared through `amcp_write`. Both sources
stay in scope: the Search Console login must hold the exact property and be its default, and a foreign site,
customer, page, search term view or malformed row refuses the whole read. Nothing is saved.

## Opening website pages

Each page loads the feature files it needs on first visit and reuses them when revisited. A loading status appears
while these files arrive. If a download fails, **Try again** retries that page. If startup took too long or could
only finish partially, **Reload page** starts a fresh document. Leaving the page or changing identity invalidates
its pending result. Loading page files itself does not change an account or perform a provider operation.

## Google Search with Maximize Clicks

Choose **Google Search with Maximize Clicks** in Campaigns, or `google_search_clicks` through `amcp_campaign`.
Supply an explicit **Campaign CPC ceiling in account currency** as decimal text, such as `"1.25"`, together
with the Search brief. Keep manual bids, CPA/ROAS targets and other bidding strategies out of this recipe. Country
and language lookup, original copy, currency and the EU political-advertising declaration remain required. Budgets
and CPC amounts take no more decimal places than the currency has (JPY and CLP none, USD two, KWD three); a finer
amount such as 500.5 JPY is refused at preview with `INVALID_RECIPE_MONEY`, before any provider request.

Preview shows a dedicated budget and PAUSED campaign with Maximize Clicks; its children are enabled under the paused
campaign. Save creates an unapproved draft. Review and verify every step before separately approving activation.
Maximize Clicks seeks clicks using the budget and ceiling; it does not optimize conversions or guarantee delivery.
The existing manual-CPC Search recipe remains available when a fixed ad-group bid is the intended strategy.

## Snapchat daily purchase evidence

Open **Capture detailed native evidence** in Reports and choose Snapchat campaign, ad squad or ad performance. Select the
exact login/account, native currency and IANA timezone, then 1–31 closed dates. Choose the swipe and view attribution
windows explicitly and confirm the complete window. A seven-day view needs a seven- or 28-day swipe. The capture
uses purchase conversions across total sources at conversion time, swipes as clicks and exact native spend micros.

The server verifies account metadata before/after all pages and requires native delivery and conversion processing
to cover the requested end. Missing, conflicting, oversized or partial evidence is refused. Missing metrics stay
unknown; names, conversion value and creative assignment are not supplied. Fractional-hour account midnights cannot
be represented by this whole-hour native stats request; the workflow refuses them. Retained rows support the same
scoped paging/search, Excel and compatible reference comparison as other guided evidence.

For MCP use `capture_preset` with `preset:"snapchat_campaign"` or `"snapchat_ad"`, explicit
`swipe_up_attribution_window` (`1_DAY`, `7_DAY`, `28_DAY`) and `view_attribution_window`
(`none`, `1_HOUR`, `3_HOUR`, `6_HOUR`, `1_DAY`, `7_DAY`). Generic attribution/conversion text is replaced
by the generated native settings. Provider finalization does not verify measurement setup or guarantee an atomic
account snapshot. See [qualification and limits](review/DELIVERY-2026-10-02-SNAPCHAT-EVIDENCE.md).

For ad-squad evidence choose `snapchat_adsquad` and supply the exact `campaign_id` from Portfolio. The server
observes the campaign in this account's bounded native campaign collection, checks its exact ownership before/after
all stats pages, and retains every parent/account/page request, hash and time. This preset uses the campaign stats
route and native `AD_SQUAD` rows. English/Arabic forms require the parent only for this preset; other presets refuse
the unsupported filter. Comparisons require the same parent campaign. Collection membership is a positive ownership
observation, not complete inventory or an atomic snapshot. See [ad-squad qualification](review/DELIVERY-2026-10-03-SNAPCHAT-SQUAD-EVIDENCE.md).

## Snapchat ad-squad allocation drafts

Open a retained `snapchat_adsquad` report and choose **Allocate a budget across ad squads**. Select 2–50
units from this parent, declare total period budget, floors/caps, efficiency assumptions and evidence thresholds.
The model is illustrative. Explicitly choose equal daily conversion to read current budgets. Only owned auction
campaigns with explicit ad-squad pacing and ad squads with daily budgets qualify. The native account currency/timezone,
parent and ownership collections are checked; lifetime, reserved and Smart Budgets are refused. Proposed daily amounts
round down to the smallest unit of the account currency and must meet the native 5,000,000-micros minimum and your
period floor. Inspect current
amounts, residuals and expandable native request/hash/time references.

Confirm only the exact unapproved draft. Reporting sends no advertising change. The daily budgets are ongoing and this
draft adds no end date or automatic period cap. Current report/session/preview/parent/budget evidence binds every unsent
step; native review, execution/spending confirmation and receipt-bound read-back remain separate in Campaigns. The
review also freezes native delivery mode so a change prevents dispatch.

For MCP use `allocation_candidates`, `allocation`, `preview_allocation_plan` with `conversion:"equal_daily"`,
then `create_allocation_plan` with that session's `preview_id`, `preview_hash` and `confirmed:true`. Retain exact
report and account scope. Google retains its dedicated-budget flow, LinkedIn its independent-budget flow and Meta its
owner-bound flow (above); other providers remain unqualified for this handoff. See [qualification and limits](review/DELIVERY-2026-10-03-SNAPCHAT-ALLOCATION.md).

### Allocation selection and browser review

Candidates use compact Add/Added controls with full accessible names. Added items remain disabled until removed; selection changes preserve each remaining item's bounds and invalidate obsolete results. Report buttons identify their source, account and dates. Snapchat model/candidate responses identify `entity_kind:ad_squad` and the exact `parent_campaign_id`; daily-budget copy stays provider-specific. Conversion tables retain exact decimal strings and micros inside named horizontal scroll regions. The confirmation starts on Cancel, wraps Tab/Shift+Tab between its controls and supports Escape cancellation. Long native IDs fit the English/Arabic narrow-screen form. See [browser and keyboard qualification](review/DELIVERY-2026-10-03-BROWSER-ALLOCATION.md).

### Saved budget proposal review

Opening a recognized allocation draft shows **Retained budget proposal** with the exact provider/account, currency, timezone, reference duration and Snapchat parent. Its keyboard-accessible table compares the saved budgets at preview with the proposed native daily/average-daily amounts and micros. These settings are retained evidence, not a new live read. Inspect the original report for its date window and measurement definitions. Reference-period amounts are not an ongoing spending cap or end date.

The original plan brief and original native step descriptions remain expandable. A readable translated step is shown only for an exact matched single native budget request; additional/changed fields or older/unqualified bindings keep their stored descriptions. Language changes do not modify the original plan or request. Every advertising effect still needs the existing separate native review, spending acknowledgement and execution/read-back. Report metric cards and plan counts are available in both languages. See [review qualification](review/DELIVERY-2026-10-03-ALLOCATION-REVIEW.md).

### Tool timings in workspace health

Owners/administrators can open Settings or use the existing MCP health action to inspect completed tool
attempts in the current 15-minute interval. The bilingual named table separates fixed tool groups, success/error
response counts, means, approximate median/p95 buckets and omitted measurements. It scrolls inside the page
and supports keyboard access. A successful response may contain a blocked/pending/failed workflow. Handler
time excludes timing storage and response delivery; it does not measure end-to-end network latency.
Current in-flight calls appear in a later health refresh. Empty intervals and unavailable evidence stay explicit.
See [operating details](OPERATIONS.md#owner-tool-timings) and [delivery evidence](review/DELIVERY-2026-10-03-TOOL-TIMINGS.md).

### Owner Settings sections

An owner's Settings open with a sub-navigation (WEB-08): **Safety** first (Pause all writes, the account spending
policy and workspace default, executions over a cap and review friction), then **Access** (the instance owner's list of
who can use AMCP), **Health**, **Retention** (report snapshots and file downloads) and **Account** (platform setup).
Each link moves to its section. The command palette (Ctrl+K) offers owners **Pause all writes**, which only opens that
control; pausing still asks for confirmation and a reason. In the access list the owner's own row shows **You** and no
actions, because AMCP never changes the caller's own access; every other row keeps its controls.

### Recovering encoded workbook definitions

Operations and original workbook runs can identify accounts retained in supported DV360/LinkedIn/X JSON
body fields without revealing body text. Current login/account access remains required on every page.
Known credential fields in legacy definitions and run previews are masked; the existing configuration
redaction flag identifies changed projections. Fresh unsafe definitions and queued collection are refused.
Stored originals retain their own bytes and revision. See
[operating limits](OPERATIONS.md#encoded-native-reporting-definitions) and
[delivery evidence](review/DELIVERY-2026-10-03-REPORT-BODY-SCOPE.md).

### Compare an import before saving its changes

In Commerce, select the Meta account/login and catalog, load a canonical or explicitly mapped supplier/WooCommerce
CSV, choose create-only or explicit upsert, then validate the source. The preview has one row per product with
exact decimal source prices and native hundredths. Compare current catalog products starts a bounded read of
only the supplied retailer IDs. New, changed, matching and unknown states stay separate; create-only blocks every
existing ID. Matching means only submitted fields have matching evidence. Unknown fields need native review.
For Meta, as for X, each row also names the native attributes the product holds a value for although the source does
not send them (`unsent_fields`: for example a sale price, staging visibility or zero inventory), because neither
provider says whether an update keeps or clears them; the summary counts such products
(`with_destination_only_values`). On Meta such a product is never shown as matching: when every supplied field
matches, it is unknown, says that the catalog holds values this import does not send, and is among the products
needing review (owner decision P9 of 2026-10-11; before P9 it stayed matching). On X the note changes no state. The
native review of an upsert repeats it as a warning.

Save only products needing review excludes matching/blocked rows and preserves each selected original source
product. Save all supplied products keeps the whole import; after a comparison it says how many already match. In an
X plan a product that still matches when the plan reaches it is recorded as unchanged (`skipped_unchanged`) and nothing
is sent; a matching Meta product is reviewed and sent again. Both save unapproved local drafts; neither submits
product changes. Execution still requires fresh native reviews, write authority and per-item read-back. Missing
source items are retained. Revalidate after editing the file, mappings, account or policy. Scoped MCP handoffs
(`/commerce?catalog_comparison=1&gateway=…&connection_id=…&account_id=…&catalog_id=…`) select only a currently
accessible account of that gateway and its catalog ID, and ask for the source CSV again, without an automatic read. A
link without `gateway` is a Meta comparison; a gateway that does not match the account selects nothing.
See [comparison qualification and limits](review/DELIVERY-2026-10-03-CATALOG-COMPARISON.md).

### Google Search conversion bidding

Choose Google Search with Maximize Conversions for no CPA target, or Google Search with a target CPA for an exact
positive decimal target in account currency. Explicitly select account-default conversion goals; these recipes
do not configure custom/campaign-specific goals. Inspect the readable budget, target micros, scope and paused
intent, then save an unapproved plan. An approved client playbook may supply exact CPA/creative/targeting defaults.
Check current goals and primary actions, conversion delivery and eligibility before separate activation.
A target CPA is an average optimization target rather than a spending cap. Existing per-step review, native
strategy/target verification and original receipt recovery still apply. See
[batch 117 evidence](review/DELIVERY-2026-10-03-GOOGLE-CONVERSION-RECIPES.md).

### Google Search conversion-value bidding

Choose Google Search with Maximize Conversion Value without a target, or Google Search with a target ROAS.
Explicitly choose recorded account values and account-default goals. For a target, enter ratio text: 3.5 means
350%, from 0.01 through 1000. The readable preview shows exact scope, budget/micros and ratio/percentage;
the native request uses Google's double. Save an unapproved paused draft, then review each dependent step.
Goals and value settings remain unchanged. Current primary goals can be inspected, but recorded-value delivery,
conversion history and account eligibility need separate verification before activation. A ROAS target is an
average optimization ratio rather than guaranteed return or a spending cap. See
[contract research and evidence](review/DELIVERY-2026-10-04-GOOGLE-VALUE-RECIPES.md).

### Current conversion configuration before activation

For any Google conversion Search recipe, complete the brief and choose Check account prerequisites.
The read-only check now shows current account-default goal biddability and matching enabled primary actions
for the exact selected client when it uses its own conversion customer. It does not read conversion events.
The goal table keeps readable counts first; expand View resource or Matching primary actions for exact IDs.
English/Arabic mobile tables scroll within a named keyboard-accessible region. Missing optional primary flags,
shared/manager conversion customers, changed settings, incomplete reads and collection limits stay unknown.

Read access can inspect this configuration while write authority remains blocked. Saving creates an unapproved
paused draft; it does not retain this check as continuing activation authority. Current settings can change.
Verify event delivery, provider eligibility and current goals before the separate activation review. For MCP,
use amcp_campaign recipe_eligibility with the original recipe/business/profile and live:true; omit live or use
false for a local-only check. See [batch 118 qualification](review/DELIVERY-2026-10-03-GOOGLE-GOAL-INSPECTION.md).

## Snapchat submitted native lead forms

In Reports, choose Snapchat campaign, ad squad or ad native lead submissions. Select the exact login/account,
native currency/IANA timezone and 1–31 closed account-local dates, then confirm the complete window. These
presets read aggregate native_leads submitted-form counts, exact spend micros, impressions and swipes. They
read no submitted person records. Purchase attribution controls are unavailable for this measurement definition.
Ad squads and ads require the exact owned campaign UUID from Portfolio. Current account/parent evidence and
every complete page retain source hashes; non-conversion finalization must cover the entire selected window.

For MCP, use capture_preset with snapchat_campaign_leads, snapchat_adsquad_leads or snapchat_ad_leads. Child
presets require campaign_id. Omit swipe/view attribution windows. Generated definitions replace caller text;
incompatible purchase and native-form evidence cannot reconcile. Missing counts stay unknown. Lead quality,
off-platform attribution and historical creative assignments are not established by this capture.

Inspect/search/page retained rows or download all rows with an explicit English/Arabic language. Parent-scoped
downloads include original campaign identity and retained parent/account/page hashes, without native request
bodies. Creative library linked-ad performance separately offers compatible retained purchase or native-form
snapshots for exact verified ad IDs; metric labels distinguish otherwise identical saved names. It makes no
provider call and rechecks current access. See [qualification](review/DELIVERY-2026-10-04-SNAPCHAT-NATIVE-LEADS.md).

## Finding saved evidence

The saved-evidence view initially loads 30 source-linked metadata records. Search original report names, IDs, accounts
or presets, reset the query, or use **More saved evidence**. A page may contain no matching accessible reports while
still having further candidates; continue until the button disappears. Current access is rechecked on every page.
Expired or changed-scope continuation requires restarting the search. The open report remains inspectable while pages
load; comparison choices update without discarding a retained selected reference. Removed references clear obsolete
comparison results. Search makes no provider call and does not modify a saved report.

For MCP, use amcp_reporting list with limit (default 30, maximum 100), optional search and exact gateway/connection/preset
filters. Account filtering also requires gateway. Supply next_cursor under unchanged filters; nonzero offset is refused.
Continuations expire after 15 minutes and bind current identity/session/role and connection grants. Complete report rows,
native source definitions, analysis and exports remain available through the original report ID. See
[qualification](review/DELIVERY-2026-10-04-EVIDENCE-INDEX.md).

## X source products and current comparison

In Commerce, choose an accessible X account/login/catalog and supply all ten source fields: retailer_id, name,
price, currency, image_url, url, availability, condition, brand and plain-text description. Map local supplier
columns explicitly or use AMCP columns; unsupported canonical headers require supplier mapping. Prices keep
exact original decimal text, with the qualified six-fraction native bound. Select explicit upsert because X
updates matching IDs. Preview then inspect source/native fields. Early-access entitlement is not established.

Compare current catalog products reads up to 1,000 listed products twice, shares those scans across supplied
SKUs and brackets current catalog ownership. New/changed/matching/unknown/blocked remain separate. Supported
prices compare exactly; grouped/unknown metadata prevents treating a potentially hidden variant as absent.
Only original supplied rows are returned, with qualified omitted-attribute names and explicit update uncertainty.
Save only products needing review excludes matching/blocked rows. Both subset/all saves remain unapproved local
drafts with no product mutation; native review applies the same group guards and fresh ownership independently.
Missing source items are retained. This is sequential current evidence, not complete variant reconciliation or
a point-in-time inventory. See [workflow and qualification](review/DELIVERY-2026-10-04-X-CATALOG-COMPARISON.md).

### Preview explicitly selected X product removal

After current source comparison, choose the exact observed individual products intended for removal. The
unchecked per-SKU controls open a second preview of native keys, names and exact current prices. Changed
evidence requires comparing again. Save unapproved removal draft retains one original campaign plan without
deleting any product. Every selected key has a separate native review, confirmation, accepted receipt and
read-back; the review itself checks that the product it reads still matches the selected evidence, at prepare and
again at execute. A feed may restore products it still contains. Products outside the explicit selection stay retained;
missing/grouped/unknown records and deleting absent-source inventory are outside this workflow.
See [delivery](review/DELIVERY-2026-10-04-X-CATALOG-REMOVAL.md).

### Sale prices, retirement, variant groups and Snapchat comparisons

- **Sale prices (Meta and X).** Add optional `sale_price`, `sale_price_start_date` and `sale_price_end_date` columns (or
  map them). The sale is a decimal lower than the price in the product currency; the start and end are ISO 8601 times
  with an explicit offset, kept as written (X needs both or neither). The preview shows the native sale and the
  comparison checks it exactly. Without sale columns the destination keeps its current sale; the comparison names it as
  a note, and a product whose only differences are values your source does not send still counts as matching.
- **Retire instead of delete.** After an update comparison, tick **Retire** for existing products you stopped selling
  and save a retirement draft: each product is updated to "discontinued" or "out of stock", so ads stop showing it
  while the product stays. This is the only removal path for Meta, which has no product deletion.
- **X variant groups.** When a supplied product may be a hidden variant, the comparison names the grouped records that
  can hide it; add or change variants through the catalog's scheduled feed. After the owner qualifies X's group
  listing, AMCP reads the groups and new products outside them are no longer blocked.
- **Snapchat (read-only).** Choose a Snapchat ad account to compare supplied products with a Snapchat catalog. Exact
  prices and fields are compared twice; products that differ say **Fix this product in the product feed**, because
  Snapchat changes products only through feeds. Nothing is saved for Snapchat.

### Large stores, saved column mappings and plan lineage

- **More than 50 products.** A CSV of 51–500 products is validated part by part and shown as a plan group: how many
  products, how many plans of at most 50, and the first and last retailer ID of each part. **Save … products as …
  plans** saves one unapproved plan per part, and the page links to each. Approve and run each part separately; every
  product still gets its own native review and read-back. Compare at most 50 products at a time (a plan group is saved
  from its whole source), and a Snapchat comparison takes at most 50. Nothing is ever deleted because the file lacks a
  product.
- **Saved column mappings.** A supplier mapping is saved for the selected account and catalog, with a version.
  Loading the next file fills the saved columns and names the version and the retailer ID column. The retailer ID
  column decides which product each row is, so choosing another one needs **Identify products by another retailer ID
  column from now on**; without it the import is refused before anything is sent.
- **Where a plan came from.** Every catalog plan records its source (the file's hash, row count and mapping version)
  and, when it was saved after a comparison, that comparison. A part of a plan group says which part of which import
  it is. Open **Plan provenance and execution journal** on the plan to inspect it.

### Current primary conversion value settings

For either value-bidding Search recipe, Check account prerequisites now reads the matching primary actions'
configured value, original conversion currency and event-value override flag. Expand Current conversion value
settings for the scoped English/Arabic table. Zero and false remain explicit; missing optional fields are
unknown. Counts cover the whole matched collection, including undisplayed rows. Current configuration does
not confirm received values, conversion history, eligibility or actual return. It does not edit settings or
authorize activation. Readers can inspect it while write blockers remain. See
[scope and qualification](review/DELIVERY-2026-10-04-GOOGLE-VALUE-INSPECTION.md).

### Last reported Google conversion activity

The two value-bidding prerequisite checks show the last reported conversion date and last tag-detection time
for the same current primary actions. Times retain the original advertising-account timezone; unknown dates
stay explicit. Counters cover the full matching primary collection, while at most twenty rows are displayed.
A detected tag may have no attributable conversion. These observations do not establish delivered values,
recent volume, consent, deduplication, bidding eligibility or actual return. The check creates no advertising
change or saved snapshot. See [scope and qualification](review/DELIVERY-2026-10-04-GOOGLE-CONVERSION-ACTIVITY.md).

## Current Google image links

The creative library can inspect an original Google image receipt with an exact native asset resource and
uploaded SHA-256. Choose a maximum of 1–1000 links, then explicitly read the complete selected collection.
App, Demand Gen and Responsive Search links are covered; Responsive Display, Performance Max, Google video
and historical attribution remain outside this selected view. Missing link flags/types stay unresolved and
removed links are counted separately. Configured statuses do not prove serving or reuse eligibility. The
English/Arabic table preserves exact native IDs and source names; late results cannot replace a changed view.
Meta retains its existing reference pages. See [scope and qualification](review/DELIVERY-2026-10-04-GOOGLE-IMAGE-REFERENCES.md).

## Performance Max image asset-group links

Choose Performance Max in the original Google image's native reference panel, set a maximum of 1–1000 links
and explicitly read the selected view. The result identifies asset groups rather than individual ads. Native
enabled/paused link configuration, group/campaign status, removed links and unresolved links remain distinct.
Changing the view or limit clears displayed results and invalidates pending reads. The default Google ad-link
view and Meta paging remain. Campaign-level brand-guideline logos, other associations, serving and historical
attribution stay outside this evidence. See [scope and qualification](review/DELIVERY-2026-10-04-GOOGLE-PMAX-IMAGE-REFERENCES.md).

### Original Performance Max campaign logo references

Choose `reference_view:"performance_max_brand"` on `amcp_media {action:"asset_usage",asset_id,limit:50}` for the
original IMAGE receipt's bounded current campaign-logo view. Literal enabled brand guidelines and exact
Performance Max campaign/image identity are required. LOGO/LANDSCAPE_LOGO link configuration, removed and
unknown links remain distinct. Campaign links are not ads or asset groups. The default ad view and explicit
asset-group view remain independent. Google handoffs retain the original asset, chosen view and bounded
limit; the website waits for an explicit read and clears view choices when another asset is opened. No
write grant, serving/performance/history or all-format absence is established. See [qualification](review/DELIVERY-2026-10-04-GOOGLE-PMAX-CAMPAIGN-LOGOS.md).

### Selected WooCommerce source products

Use `amcp_workspace {action:"catalog_sources"}` for local configured-store metadata, then
`catalog_source` with exact `commerce_native_action` account/connection and
`requirements:{product_ids:["101"],price_field:"price"}`. Choose 1–50 explicit published product IDs and
price, regular_price or sale_price. A one-account encrypted wc/v3 connection with a public HTTPS origin
and recorded Read/Read/Write key permission is required. Four bounded fixed GETs repeat supported
products and bracket native currency with current actor/origin/login/permission checks. Basic keys stay
in headers on fresh public-DNS-checked sockets; redirects, caller URLs, incomplete/changed selections
and sandbox routes are refused. No snapshots, writes or full inventory/variant/tax/acceptance claims
are added. The bilingual source table exposes blockers; explicitly selected eligible simple products
enter the existing Meta supplied-product preview/comparison/unapproved draft. X retains its ten explicit
CSV fields. MCP handoffs preselect exact source IDs/price without an automatic read. See [qualification](review/DELIVERY-2026-10-04-WOOCOMMERCE-SOURCE.md).

### Original Snapchat top-snap references

Use `amcp_media {action:"asset_usage",asset_id,reference_view:"snapchat_top_snap",limit:50}` on an
original image/video UUID receipt with uploaded SHA-256. Reader access, current Snapchat Marketing API
permission and the original account/login are required. Two complete bounded creative collections and
bracketed original account/media observations must match. Native pages have 50 rows; the selected
1–1,000 limit covers all examined creatives, with separate 1,000-row original-media searches and shared
84-attempt/4,102-row/8MiB/60-second limits. Fixed account-scoped GETs grant no standalone ownership or
write authority. Only literal `creative.top_snap_media_id` is inspected; other/nested media and history
remain outside this view. Creative packaging/review and media processing do not prove ad serving.
The bilingual table keeps exact UUIDs and separate statuses; changes clear old results, and qualified
MCP handoffs preserve the original asset/bound without an automatic read. See [qualification](review/DELIVERY-2026-10-04-SNAPCHAT-TOP-SNAP-REFERENCES.md).

Native Meta catalog product read-back now covers all 35 accepted observable fields, including exact
integer inventory, ordered additional images and literal sale dates. An accepted receipt alone cannot
verify a missing field. Current field proof v2 retires partial caches before pending dependency
continuation; preserve original accepted receipts/keys and use read-only recovery. Website Meta CSV column mapping also accepts an explicitly supplied group. Explicit Meta API products and reviewed selected
WooCommerce variations can supply retailer_product_group_id; group keys do not qualify full
variant reconciliation, tax, live store sync or provider eligibility.

### Batch 149 — local rendered workflow checks

Narrow English/Arabic headers keep navigation clickable and wrap their actions. Long workflow actions
stay within their panels; decorative About/landing artwork stays within its own layer. Mobile navigation
keeps its visible Tab order until closed and restores its trigger after Escape or workspace search.
Owner-account and catalog comparison tables have named keyboard scroll regions/captions; privacy's
original skip target receives focus. Account grants, product selections and provider writes retain their
original controls. See [local browser setup and scope](LOCAL-BROWSER-QA.md) and
[delivery evidence](review/DELIVERY-2026-10-04-RENDERED-WORKFLOWS.md). Hosted CI remains owner-paused;
continue exact local source/report/full gates with required FFmpeg. Full Arabic privacy, broader
populated states, assistive technology and live/deployed/provider acceptance remain separate.

### Batch 150 — product readability and source mapping blockers

Product labels in the selected commerce preview/source tables remain readable inside their named
keyboard-scroll regions. A source SKU/name with surrounding whitespace stays exactly as read and
cannot be selected for Meta; correct the original store value and explicitly reread it. The supplied
Meta preview applies the native destination's product-field validation before offering a plan.
No identifier is trimmed or invented, and products keep their separate ownership/read-back/write-review
requirements. See [delivery evidence](review/DELIVERY-2026-10-04-COMMERCE-READABILITY.md) and
[local browser checks](LOCAL-BROWSER-QA.md). Broader inventory/variants and live acceptance remain separate.

### Batch 151 — complete privacy languages

The published privacy policy is fully readable in English/Arabic without login or JavaScript.
/privacy keeps English by default; /privacy?lang=en and /privacy?lang=ar select static versions.
Ordinary policy language links work without scripts, and the selected website language determines
website privacy-link destinations. The choice does not change workspace preference, consent or
provider permissions. English policy content, date, anchors and linked destinations remain.
See [qualification](review/DELIVERY-2026-10-04-ARABIC-PRIVACY.md). Structural/rendered checks do not
replace human legal/editorial or assistive/live/deployed acceptance.

### Selected WooCommerce variations and explicit Meta groups

Choose **Selected variations of one parent**, enter one published variable parent ID and 1–50
exact published child IDs, then choose the native price field and explicitly read the source.
The API equivalent is catalog_source with requirements:{source_kind:"variations",
parent_product_id:"101",variation_ids:["102"],price_field:"price"}. Native child SKU/attributes/price
and parent SKU remain literal. WooCommerce has no native child name: review or enter the suggested
destination title, then explicitly check each eligible child. The shown parent SKU becomes its
reviewed Meta retailer_product_group_id; the preview displays that exact group. Title/selection/
source changes clear stale previews. Saving creates only an unapproved draft; native per-child
review and receipt/read-back remain required before execution. Six repeated/bracketed GETs enforce
current access, parent membership, complete selected evidence, one deadline and combined body bounds.
There is no automatic read, image ancestry/tax/full-inventory proof or missing-source deletion.
Meta CSV also accepts an explicit optional group; X retains its ten original fields. See [qualification](review/DELIVERY-2026-10-04-WOOCOMMERCE-VARIATIONS.md) and [CSV group mapping](review/DELIVERY-2026-10-04-META-GROUP-CSV.md).

### Explicit Meta CSV product groups

Canonical Meta product CSV accepts optional retailer_product_group_id. Supplier mode exposes an
explicit **Meta product group ID** source-column choice; no parent-looking source column infers a
group and blank optional values are omitted. Original group/SKU/price/currency strings remain.
Choose the destination before loading mapped columns; changing account/login/destination clears
old mapping/preview evidence. X retains its ten fields and refuses Meta groups before submission.
Selected WooCommerce mode hides unrelated CSV layout controls; returning to CSV restores its choice.
Group previews/comparisons retain the existing unapproved-draft and per-product native review/receipt/
complete-field-proof path. See [workflow and qualification](review/DELIVERY-2026-10-04-META-GROUP-CSV.md).

### Readable recent GA4 event evidence

The recent-event summary and minute/stream details have English/Arabic captions and readable event
columns. Original names, exact counts and stream IDs stay literal with explicit LTR isolation.
No count returned remains unknown; editing scope clears old evidence and only an explicit request
reads the native aggregate report. Existing tracking-health/runtime-consent limits remain visible.
See [measured qualification](review/DELIVERY-2026-10-04-GA4-EVENT-LAYOUT.md).

### Choose retained evidence page length

Rows per page offers explicit 10/25/50/100 choices above the saved-row table, default 50. A change
returns to the first page of the active search under the original report/source. Native identity
columns form scoped row headers; hiding both never turns a metric into an identity. Search and
column choices remain local views, totals stay complete and Excel still includes every original row.
See [connected qualification](review/DELIVERY-2026-10-04-RETAINED-ROW-BROWSING.md).

### Retain Google keyword performance by day

Choose **Google keyword performance** in detailed native evidence, bind the exact Google account/login
and declare its original currency/timezone/date/attribution settings. Only an explicit capture reads
positive Search keyword_view pages; native text, full resource identity and EXACT/PHRASE/BROAD stay literal.
Search can filter the original match type; full totals and every-row Excel remain the original report.
Only explicitly mapped keyword workbooks append the native match-type column. Attribution/completeness
remain declared, and keyword evidence does not qualify exclusions or budget changes. See [workflow and
qualification](review/DELIVERY-2026-10-05-GOOGLE-KEYWORD-EVIDENCE.md).

### Readable saved-report controls

Retained row search, Rows per page, direct page choice and Excel language now use readable labels/type,
roomier fields and visible keyboard focus. Search/actions wrap into a phone layout; original values,
source identity, complete totals and every-row Excel remain. See [measurement and scope](review/DELIVERY-2026-10-05-EVIDENCE-CONTROL-LAYOUT.md).

### Recover from a refused Google evidence capture

A refused capture shows the reason, a recovery hint and its request reference in your interface
language. Check the reported issue and the selected account/date/currency/timezone settings, then
use **Read and retain evidence** again when appropriate. A failed collection saves no new report.
The form keeps its selected scope and settings; another read starts only after your explicit submit.
A successful capture retains original evidence, full totals and every-row Excel delivery. See
[scope and qualification](review/DELIVERY-2026-10-05-GOOGLE-CAPTURE-RECOVERY.md).

### Retain Google campaign performance by device

Choose **Google campaign device performance**, select the exact account/login and declare its
original currency/timezone/date/attribution settings. Explicit capture keeps campaign performance
by original device and account-local day; UNKNOWN and UNSPECIFIED remain original categories.
Missing categories do not prove zero activity. Search by device changes only displayed rows;
complete totals and every original Excel row remain. This report does not qualify device bids,
campaign budgets or exclusions. See [scope and qualification](review/DELIVERY-2026-10-05-GOOGLE-DEVICE-EVIDENCE.md).

### Inspect other listed X products without inferring source absence

After validating your supplied products for X, choose **Inspect other listed X products**.
The result shows listed products outside that source selection, original price strings, IDs
and group information. Search and page through this already collected view without another
provider read. Other listed products stay retained unless you select them: tick individual
listed products (none is selected for you; grouped and unknown products cannot be ticked), choose
**Preview removal of selected listed products**, check the native keys and current prices, and
type the number of products to save an unapproved removal draft. A listing that changed since
the inspection needs a new inspection. Each removal still has its own native review, the owner's
deletion policy and read-back; nothing is selected because your source lacks it.
X listings may hide variants, and your supplied selection does not establish full-store
absence. Changed native observations require a new explicit read. A current failure stays
visible with its request reference; editing the form clears old evidence and suppresses late
responses. Ordinary saved drafts still contain only the supplied products. See
[scope and checks](review/DELIVERY-2026-10-06-X-CATALOG-SELECTION-INVENTORY.md).

### Retain Google campaign performance by original hour

Choose **Google campaign hourly performance**, select the exact account/login and declare its
original currency, timezone, dates, attribution and completeness. Explicit capture retains
the original reported hour 0–23 and date with full campaign identities; midnight remains hour
0. Missing hours do not prove zero activity. Search by hour changes the view; downloads include
every captured row and the original full totals. No UTC/DST conversion or schedule, bid, budget
or exclusion change is inferred. A failed capture saves nothing; review its reason/settings
and explicitly submit again. See [scope and qualification](review/DELIVERY-2026-10-06-GOOGLE-HOUR-EVIDENCE.md).

### Keep a refused capture reason while reviewing settings

A current detailed-capture failure remains beside **Read and retain evidence**, with its reason,
recovery hint and original request reference. Review it and your settings before another explicit
submit. Editing settings clears that old message and retains the original completeness rules.
A reply from an older form/scope cannot paint a new error. See [scope and qualification](review/DELIVERY-2026-10-05-PERSISTENT-CAPTURE-FEEDBACK.md).

### Provider capture refusals

Guided Meta, LinkedIn, TikTok and Snapchat capture refusals now display authored English or Arabic
reason and recovery text through the current persistent capture feedback. Native API messages,
codes, identifiers, measurement settings and request references remain original. Feedback stays
until settings change or another explicit submit; edits do not automatically read the provider.
Unknown native diagnostics stay literal. A failed capture does not authorize a write or retry an
uncertain mutation. Exact-account refusal journeys are evaluated with fixed synthetic reads.

### Recovering a GA4 measurement read

Recent GA4 events and the exact synthetic test-identifier inspection now keep the current
refusal reason, recovery hint and reference beside the submit button in either interface language.
The message remains until you edit the form or explicitly read again; your selected scope and
settings survive. Editing invalidates the earlier observation and feedback without starting a
provider read. A response from an obsolete selection stays silent. An explicit second read uses
the current settings and retains exact native counts, unknown observations and property-calendar
boundaries. AMCP sends no test event, stores no snapshot and does not infer consent, deduplication
or attribution from these aggregates. See [measurement feedback delivery](review/DELIVERY-2026-10-05-MEASUREMENT-READ-FEEDBACK.md).

### Shared recovery guidance in your interface language

All 122 static shared recovery hints now have authored Arabic, including media/upload handling,
recipe inputs, review/idempotency, connection discovery, report tasks, owner controls and delivery.
The formatter retains the native reason, code, reference and retry metadata. Unknown text stays
literal. A 403 remains a provider access denial and does not establish a missing OAuth scope.
A translated instruction does not start a reconnect, grant access or retry an uncertain write.
See [delivery](review/DELIVERY-2026-10-05-SHARED-RECOVERY-GUIDANCE.md) and the
[current completion walkthrough](CURRENT-READINESS.md).

### Recovering other workspace forms

A current unhandled workspace form error now stays in a described alert inside the form, with
its original reason, recovery guidance and reference. Your settings are not reset by the shared
handler. Editing or another explicit submit clears the message; edits make no automatic provider
call. Failure responses from an obsolete identity, selection or attempt stay silent. Follow the actual
recovery guidance before continuing; an uncertain submitted write still needs its original receipt
and reconciliation. GTM audit and LinkedIn conversion settings qualify explicit read-only recovery,
while configuration remains distinct from live event delivery or historical attribution.
See [shared form feedback](review/DELIVERY-2026-10-05-WORKSPACE-FORM-FEEDBACK.md).

LinkedIn conversion tables keep rule names and IDs in a readable column and preserve literal
native IDs, types and exact amount/currency together. Use the named scroll region to inspect all
columns; configuration values and unknown measurement claims retain their original meaning.

### Moving between measurement inspections

Use Choose a measurement task to reach the original GTM audit, recent GA4 counts, exact synthetic
GA4 test-identifier inspection or LinkedIn conversion settings. The heading receives keyboard focus;
Back to measurement tasks returns to the choices. Ordinary section jumps keep your entries,
current results, local result search, original URL/history and any pending original read. They do
not submit a form. Read evidence only with that form's original submit button.

Open Related measurement workflows for reporting context, approved client conversion mappings and
exact capability discovery. Exact section fragments can focus a named inspection while keeping
the original current-account handoff query; an unknown fragment does not select a task. The normal
account/test/audit scope validation and read-only evidence boundaries still apply.
See [navigation evidence and limits](review/DELIVERY-2026-10-05-MEASUREMENT-NAVIGATION.md).

## Account inventory recovery language

The six supported inventory collectors and dispatcher now require Arabic for all 131 selected
AMCP-authored direct refusal/instruction sentences. Native/dynamic diagnostics and original
codes/IDs/amounts/selectors remain separate. The existing persistent described form alert retains
reason, recovery hint and reference; edit clearing makes no new read. See [account inventory diagnostic evidence](review/DELIVERY-2026-10-05-PORTFOLIO-DIAGNOSTICS.md).

## Effective operation help and inventory read recovery

amcp_tool_help with gateway and operation now normalizes the eight original versioned Google/Meta
captured descriptions to the configured effective API version. Known uncaptured original catalog
actions expose their effective route/method/required fields and risk flags with an explicit
extended-schema-unverified qualification. Canonical action names, input schemas and native write
qualification remain separate. Unknown/nonversioned/independent help retains its previous boundary.

A malformed native inventory response now identifies provider-owned recovery: keep the original
selected account/hierarchy, retry that read once, and report the original request ID if it recurs.
Its authored Arabic hint is required by the existing locale gate. No elapsed time, edit, navigation
or help read triggers an automatic provider retry. See [operation help and inventory recovery evidence](review/DELIVERY-2026-10-05-DISCOVERY-RECOVERY.md).

## Website account diagnostics and references — batch 170

Thirteen selected website server files now have 232 exact authored reasons covered by the Arabic
locale gate, with 193 new translations and all 4,222 prior catalog pairs retained. Early non-MCP
HTTP errors reaching the common handler keep their status/code/message and add a generated
meta.requestId. The existing browser formatter presents that reference in either language.
A matching six-field optional diagnostic event omits request payload, credentials and identity;
production stdout/stderr wiring already exists. MCP errors and reviewed-write authority remain exact.
See [website diagnostic evidence](review/DELIVERY-2026-10-05-WEBSITE-DIAGNOSTICS.md). Complete working-source local release/browser gates pass; exact committed-source qualification gates the sole push.
B13/B16/B24 remained partial ([package status](review/PACKAGE-STATUS.md) is current).

## Core contract diagnostics and public source comparison — batch 171

Six selected core modules now require Arabic for 239 distinct authored MirrorError reasons.
The catalog adds 239 translations, preserves every earlier 4,415 value and contains 4,654 entries;
the complete locale gate requires 4,484 messages. Original native IDs, amounts, tokens, codes,
authority, protocol and execution stay exact. Other static/dynamic copy and full editorial/assistive
acceptance remain separate. See [core diagnostic evidence](review/DELIVERY-2026-10-05-CORE-CONTRACT-DIAGNOSTICS.md).

An explicit public comparison command checks unauthenticated liveness and exact About/Arabic
asset bytes. Public HTTP 200 does not establish current backend Git/image or provider acceptance.
The October 5 observed locale bytes match an older known file; Railway deployment cause/settings
remain unverified. Complete working-source local release/browser gates pass; fresh exact committed-source checks gate the sole push.
B13/B16/B24 remained partial ([package status](review/PACKAGE-STATUS.md) is current).

## Published WooCommerce inventory and owner worker observations — batches 182/183

Commerce now offers explicit complete bounded published-parent/reported-child inventory inspection.
Choose the existing store/login and exact price field, submit once, and inspect exact native IDs,
values, memberships, statuses and currency. Search/paging are local; absent products are retained.
Inventory does not create a draft, establish unpublished-parent coverage or approve a destination.
[Store inventory operation and limits](review/DELIVERY-2026-10-06-WOOCOMMERCE-INVENTORY.md).

Owners can inspect shared process observations in Settings and refresh explicitly. The capped,
bilingual table distinguishes unavailable, uncertain, stale and recently observed processes while
explaining that queue progression, capacity, provider acceptance and delivery are separate. A verdict leads
(WEB-08): the newest report's age in human terms (for example "98 minutes"), the 90-second threshold and the
working/idle counts of the observations shown; the table itself starts collapsed and gives each exact age in seconds
on hover. Current request/session/identity/navigation checks prevent old health from replacing another view.
[Worker scope, measured tradeoff and simultaneous-client tasks](review/DELIVERY-2026-10-06-WORKER-HEALTH.md).

## Administrator store connections — batch 184

In Commerce, an owner/administrator can enter an existing WooCommerce Read key and exact public
HTTPS origin, explicitly acknowledge the key permission, and submit one bounded read verification.
Credentials clear immediately. The result records current access, unchanged currency and reported
published count; it does not qualify full inventory or a destination. Refresh the store list
explicitly before choosing a source. An interrupted reply can be inspected through the persistent
refresh action. An identical explicit retry recovers the original encrypted receipt without reads.

Local removal requires a specific source and two explicit confirmations. It removes the local
connection/credential/proof and related retained report data, with no native request or key change.
The removal tombstone prevents replay from recreating the old connection. Generic asset/write
controls refuse commerce. [Operator steps, limits and checks](review/DELIVERY-2026-10-06-WOOCOMMERCE-CONNECTIONS.md).
