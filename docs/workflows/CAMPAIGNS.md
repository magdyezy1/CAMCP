---
status: reference
tier: operator
---

# Campaign review and recovery

Campaign plans from brief to reviewed launch, the guided packs, the Google Search bidding recipes and their prerequisite checks. Sections of the [workflow guide](../PRODUCT-WORKFLOWS.md), moved here with their text unchanged on 2026-10-24 (DOC-03).

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
[conversion-reference delivery record](../records/DELIVERY-2026-10-03-CONVERSION-REFERENCES.md).
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
readable exact IDs in English and Arabic. See the [delivery evidence](../records/DELIVERY-2026-10-03-SNAPCHAT-TRAFFIC.md).

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
See [contract, SDK and browser qualification](../records/DELIVERY-2026-10-04-SNAPCHAT-LEADS.md).

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
of 2026-10-11 names, see the [demand record](../DECISIONS.md#campaign-pack-demand-record-cmp-07-p7-prv-06)). The
brief names the exact advertiser and login, account currency, a daily budget with at most two decimal places, 1–20
TikTok location IDs, an existing TikTok post with the `TT_USER` or `BC_AUTH_TT` identity that owns it, an HTTPS
landing page, a call to action and an offset start time; the purchases pack adds the pixel and one purchase event. It
saves three reviewed creates: a `DISABLE` campaign and, under it, an `ENABLE` daily-budget ad group on the TikTok
placement and one `ENABLE` Spark Ad. Preflight reads the identity, the post and, for purchases, the pixel of this
advertiser before anything is created; ad review, event delivery, budget minimums and objective acceptance stay with
TikTok. **Prepare activation** enables the verified campaign as one separate reviewed status change. The website
preview shows the UTC times TikTok receives, in English and Arabic.

### TikTok Smart+ website traffic and purchases with an existing post

TikTok stops creating classic Sales campaigns on 2027-01-01; an Upgraded Smart+ web campaign replaces them.
Choose `tiktok_smart_plus_website_conversions` (a purchase event of a pixel) or `tiktok_smart_plus_website_traffic` (clicks
or landing page views, no pixel). The brief is the classic pack's with the ID of a dynamic CTA portfolio in place of a call
to action, and no end time. It saves three reviewed creates on the Smart+ routes: a `DISABLE` campaign with one daily budget and, under it,
an `ENABLE` ad group and one `ENABLE` Spark Ad; AMCP gives the first two a `request_id` when the plan is saved.
Preflight reads the identity, post, CTA portfolio and, for purchases, the pixel before anything is created.
**Prepare activation** enables the campaign as one reviewed status change. That TikTok accepts the two children created
`ENABLE` under the `DISABLE` campaign is unverified until the live check; ad review, event delivery and objective
acceptance stay with TikTok.

### TikTok Search ads with an existing post

Choose `tiktok_search_traffic` in Campaigns or MCP (R2.5 M4, stage 1 of the owner's Q6) for an advertiser TikTok has
allowlisted for Search Ads with the Traffic objective. Search Ads campaigns are allowlist-only for each objective,
TikTok documents no read of the allowlist, and an advertiser without it is refused with code `40118` at the campaign
create, recorded as rejected with nothing else sent. The brief is the traffic pack's plus 1–1,000 `keywords`, each a
keyword with a match type (`PRECISE_WORD`, `PHRASE_WORD` or `BROAD_WORD`); the website form takes one line
`MATCH_TYPE: keyword` each. It saves three reviewed creates: a `DISABLE` campaign with `is_search_campaign: true`, an
`ENABLE` daily-budget ad group on the TikTok placement that carries the keywords (clicks, maximum delivery) and one
`ENABLE` Spark Ad. It sends no audience, interest, pixel or keyword bid. Preflight reads the identity and the post;
keyword review, ad review and objective acceptance stay with TikTok. **Prepare activation** enables the verified campaign
as one separate reviewed status change, and the negative keywords of the new ad group go through the reviewed negative
keyword add, which accepts a manual Search Ads campaign. TikTok's migration guide to Upgraded Smart+ (read 2026-11-21)
says Manual Campaigns can no longer be created with `/campaign/create/` after December 31, 2026, which would end this
pack; the notice on its create pages names only Sales, App Promotion and Lead Generation campaigns that are not Search,
so it is not confirmed for Search. AMCP refuses nothing on that date, and the Smart+ Search pack below is the route that stays.
### TikTok Smart+ Search with an existing post

Choose `tiktok_smart_plus_search_website` for Sales Search through the Upgraded Smart+ routes: the Smart+ packs' brief with
your keywords (1–1,000, each with a match type, at most 80 characters, without emoji or the characters TikTok excludes:
hyphens, underscores and colons among them) and the goal `CLICK` (default) or `CONVERT` (a pixel and a purchase event).
It saves the same three reviewed creates, the campaign being a Search campaign and its `ENABLE` ad group carrying the
keywords. TikTok allows Search only with campaign budget optimization off, so the campaign carries no budget of its own
and the daily budget you give is the ad group's; the owner's budget caps read it there. Smart+ Search is allowlist-only
for each objective: TikTok refuses an advertiser without it with code `40118` and nothing is created, which no preflight
can check. **Prepare activation** enables the campaign as one reviewed status change, and says that the ad group's daily
budget is what starts spending. Keyword review, ad review and objective acceptance stay with TikTok.

### LinkedIn lead generation with an existing post and form

Choose `linkedin_lead_generation` in Campaigns or MCP (CMP-07 optional stretch, built before owner decision P7 of
2026-10-11 named it, see the [demand record](../DECISIONS.md#campaign-pack-demand-record-cmp-07-p7-prv-06)). The brief
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

### Google Search conversion bidding

Choose Google Search with Maximize Conversions for no CPA target, or Google Search with a target CPA for an exact
positive decimal target in account currency. Explicitly select account-default conversion goals; these recipes
do not configure custom/campaign-specific goals. Inspect the readable budget, target micros, scope and paused
intent, then save an unapproved plan. An approved client playbook may supply exact CPA/creative/targeting defaults.
Check current goals and primary actions, conversion delivery and eligibility before separate activation.
A target CPA is an average optimization target rather than a spending cap. Existing per-step review, native
strategy/target verification and original receipt recovery still apply. See
[batch 117 evidence](../records/DELIVERY-2026-10-03-GOOGLE-CONVERSION-RECIPES.md).

### Google Search conversion-value bidding

Choose Google Search with Maximize Conversion Value without a target, or Google Search with a target ROAS.
Explicitly choose recorded account values and account-default goals. For a target, enter ratio text: 3.5 means
350%, from 0.01 through 1000. The readable preview shows exact scope, budget/micros and ratio/percentage;
the native request uses Google's double. Save an unapproved paused draft, then review each dependent step.
Goals and value settings remain unchanged. Current primary goals can be inspected, but recorded-value delivery,
conversion history and account eligibility need separate verification before activation. A ROAS target is an
average optimization ratio rather than guaranteed return or a spending cap. See
[contract research and evidence](../records/DELIVERY-2026-10-04-GOOGLE-VALUE-RECIPES.md).

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
false for a local-only check. See [batch 118 qualification](../records/DELIVERY-2026-10-03-GOOGLE-GOAL-INSPECTION.md).

### Current primary conversion value settings

For either value-bidding Search recipe, Check account prerequisites now reads the matching primary actions'
configured value, original conversion currency and event-value override flag. Expand Current conversion value
settings for the scoped English/Arabic table. Zero and false remain explicit; missing optional fields are
unknown. Counts cover the whole matched collection, including undisplayed rows. Current configuration does
not confirm received values, conversion history, eligibility or actual return. It does not edit settings or
authorize activation. Readers can inspect it while write blockers remain. See
[scope and qualification](../records/DELIVERY-2026-10-04-GOOGLE-VALUE-INSPECTION.md).

### Last reported Google conversion activity

The two value-bidding prerequisite checks show the last reported conversion date and last tag-detection time
for the same current primary actions. Times retain the original advertising-account timezone; unknown dates
stay explicit. Counters cover the full matching primary collection, while at most twenty rows are displayed.
A detected tag may have no attributable conversion. These observations do not establish delivered values,
recent volume, consent, deduplication, bidding eligibility or actual return. The check creates no advertising
change or saved snapshot. See [scope and qualification](../records/DELIVERY-2026-10-04-GOOGLE-CONVERSION-ACTIVITY.md).
