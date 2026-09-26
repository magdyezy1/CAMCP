# AMCP implementation handoff — 2026-09-26

The user asked to fix the Snapchat workflow defects found in live AMCP use on
2026-09-25, follow the [2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md) procedures,
and push only to CAMCP. That batch is finished. The user then asked to apply the
2026-09-25 ticket list, all of it that can be implemented locally. P1 campaign
blockers come first, starting with Snapchat. Deployment, live-login and
customer-data/PII tickets stay outside that request (see the boundaries below).

## Checkout and operating boundaries (changed)

- Worktree: `C:/Users/abdom/Downloads/CLaude workspace`, a copy of the Codex-branch
  checkout. The user asked that no other folder be used; the earlier worktrees
  (`Downloads/implementation-Codex-branch`, `AMCP Final With Claude recos - Copy/…`)
  are not to be read or edited.
- Push only to `https://github.com/magdyezy1/CAMCP` (remote `camcp`), branch
  `Codex-branch`. The `origin` (magdyezy1/AMCP) push URL is disabled in this checkout.
  Do not push to AMCP or any other remote. CAMCP is private.
- All other boundaries from the 2026-09-25 handoff still apply: no reading
  `.mirror/RESULTS/live-read-samples.json`, credentials, `.env` secrets or live
  databases; no live advertising mutations, credential/grant changes, deployment,
  Railway or DNS changes; qualification only in a fresh sanitized candidate.
- Customer-data work (lead reports and webhooks, customer-list and offline uploads)
  needs its own consent, retention and recipient policies. It is not part of the local
  ticket work.
- Git: pass `safe.directory` to the release assembler through `GIT_CONFIG_COUNT`,
  `GIT_CONFIG_KEY_0=safe.directory` and `GIT_CONFIG_VALUE_0=<worktree>` rather than
  changing global configuration. System Python on PATH (standard library only) serves
  `AMCP_SCHEMA_PYTHON`; FFmpeg 9.0.2 and the npm cache are under this worktree's `.runtime/`.

## Finished batch — Snapchat workflow defects

[Implementation](SNAPCHAT-WORKFLOW-2026-09-26.md) and
[qualification](SNAPCHAT-WORKFLOW-VERIFICATION-2026-09-26.json).

Fixed: plan currency for Snapchat (and TikTok/Reddit) preflight; ad squad
`placement_v2` verified from the write acknowledgment; ownership renewed by parent
reads that name the owning account; independent plan steps no longer stall behind an
inconclusive read-back; early `SNAPCHAT_PIXEL_NOT_OWNED`; Snapchat `result_fields`
envelopes; execute accepts the review's own gateway/connection; specific plan-step
errors. Tests: `tests/snapchat-workflow-fixes.test.mjs` (10, red before / green after).

Not changed, with reasons in the implementation record: BUG-7
(`get_creatives_by_ids` body), a Snapchat recipe, a `reconcile_step` verification
bypass, and nested-update PUT handling of the write-only `placement_v2`.

Fresh candidate `.release/snapchat-workflow-20260926-a` (664 files, source hash
`3a533427aea8b7696082a6d51fc492b56087be90ce5ea2b75645fca83425d64e`) passes
**2062 main and four capture tests**, no failures/skips, with FFmpeg required, every
generated/contract/provider gate and the Railway check. Staged code, tests and guidance
match the candidate (LF-normalized); see the qualification record for hashes.

## Finished batch — Snapchat lead generation forms

[Implementation](SNAPCHAT-LEAD-FORMS-2026-09-26.md) and
[qualification](SNAPCHAT-LEAD-FORMS-VERIFICATION-2026-09-26.json).

The three captured form create actions now use the reviewed Snapchat family:

- Documented-field validation before any request (`INVALID_SNAPCHAT_LEAD_FORM`).
- Banner-media ownership read.
- A `LEAD_GENERATION` creative reads its form before review and execution.
- Strict receipts.
- Read-back that ignores provider-added `is_required`/`strategy_type`.

Lead reports and webhooks stay unqualified (personal data).

Tests: `tests/snapchat-lead-forms.test.mjs` (8, red on `d88f1e0` / green after).
Pushed as `874038e`.

## Finished batch — Snapchat audience segments

[Implementation](SNAPCHAT-SEGMENTS-2026-09-26.md) and
[qualification](SNAPCHAT-SEGMENTS-VERIFICATION-2026-09-26.json).

Customer-list and lookalike segment creation and segment name, description and
retention updates now use the reviewed Snapchat family:

- Lookalike seeds must be owned by the selected account; shared segments are not owned.
- A PUT must restate the existing description.
- Retention limits follow the source type.
- Review evidence ignores size and status telemetry.

User uploads/removals, segment deletion and pixel/mobile/engagement rule audiences stay
blocked. Tests: `tests/snapchat-segments.test.mjs` (10, red on `874038e` / green after).
Pushed as `8b97bdb`.

## Finished batch — TikTok custom identities

[Implementation](TIKTOK-IDENTITIES-2026-09-26.md) and
[qualification](TIKTOK-IDENTITIES-VERIFICATION-2026-09-26.json).

`tiktok_identity_create` is the new reviewed family `tiktok_identities`:

- Documented fields only.
- The optional avatar must be a square image in the advertiser's library, read before review and before execution.
- Verification reads `/identity/info/`; the avatar ID, which TikTok never returns, is reported under `unobservable_fields`.

Identity deletion and TikTok-account identities stay blocked. Tests:
`tests/tiktok-identities.test.mjs` (9, red on `8b97bdb` / green after); the creative-chain
test that pinned this gap now pins the local refusal of an undocumented field.
Pushed as `a99dfdd`.

## Finished batch — Meta native copies

[Implementation](META-COPIES-2026-09-26.md) and
[qualification](META-COPIES-VERIFICATION-2026-09-26.json).

Campaign (shallow), ad set (up to three ads) and ad copies form the reviewed family
`meta_copies`:

- Always `PAUSED`, and only into owned targets in the selected account.
- Source types are proven by type-only fields.
- Copied budgets count as new budgets under the spending policy.
- Every copy is read back paused under the right parent.

Deep campaign, asynchronous and override copies stay unqualified. Tests:
`tests/meta-copies.test.mjs` (9, red on `a99dfdd` / green after). Pushed as `6521d0d`.

## Finished batch — TikTok lookalike audiences

[Implementation](TIKTOK-LOOKALIKES-2026-09-26.md) and
[qualification](TIKTOK-LOOKALIKES-VERIFICATION-2026-09-26.json).

`tiktok_dmp_custom_audience_lookalike_create` is the new reviewed family
`tiktok_lookalikes`:

- v1.3 fields and documented enumerations only.
- The seed must be owned, available, not a lookalike, and at least 100 people; it is read before review and before execution.
- Verification compares name, type and ownership; the spec is listed as unobservable.

Also corrects the Snapchat segment impact, which listed an always-null audience size.
Tests: `tests/tiktok-lookalikes.test.mjs` (8, red on `6521d0d` / green after).
Pushed as `978b061`.

## Finished batch — Meta lookalike audiences

[Implementation](META-LOOKALIKES-2026-09-26.md) and
[qualification](META-LOOKALIKES-VERIFICATION-2026-09-26.json).

The custom audience create route becomes the reviewed family `meta_lookalikes`:

- `LOOKALIKE` only.
- The seed must be owned: account audience lists own only rows naming the account. It is read twice and refused if flagged.
- Verification compares the seed, type/ratio/country and name; `location_spec` is listed as unobservable.

Tests: `tests/meta-lookalikes.test.mjs` (8, red on `978b061` / green after).
Pushed as `d21fb76`.

## Finished batch — Google Ads audience signals

[Implementation](GOOGLE-AUDIENCES-2026-09-26.md) and
[qualification](GOOGLE-AUDIENCES-VERIFICATION-2026-09-26.json).

`google_ads_v23_audience_mutate_audiences` joins the reviewed `google_configuration` family:

- Customer-scoped audiences only.
- Validated against the pinned Discovery schema and the documented ages and enums.
- Segments must be resources of the selected customer.
- Updates need spend confirmation.
- Read-back is compared in a canonical form that tolerates reordering.

The v23 audience GAQL field table is recorded with its source hash. Tests:
`tests/google-audiences.test.mjs` (4) and an `audiences` lifecycle case in
`tests/google-configuration-writes.test.ts` (red on `d21fb76` / green after). Pushed as `e227872`.

## Finished batch — Meta deep campaign copies

[Implementation](META-DEEP-COPIES-2026-09-26.md) and
[qualification](META-DEEP-COPIES-VERIFICATION-2026-09-26.json).

`meta_campaign_id_copies_copy` now accepts `deep_copy: true`:

- Within Meta's synchronous limit of three children.
- The campaign's ad sets and ads are read as complete pages.
- Child ad set budgets count as new budgets.
- Each copied ad set and ad is verified under the copy of its source parent.

Tests: three new cases in `tests/meta-copies.test.mjs`. Pushed as `927b73e`.

## Finished batch — Snapchat creative reference ownership

[Implementation](SNAPCHAT-CREATIVE-REFERENCES-2026-09-26.md) and
[qualification](SNAPCHAT-CREATIVE-REFERENCES-VERIFICATION-2026-09-26.json).

This closes the lead-form follow-up: a creative PUT or PATCH that changes `top_snap_media_id` or
`lead_generation_form_id` must reference media or a form this login owns. The check runs
against the frozen state at review and the fresh state at execution. Unchanged references
stay usable, so existing creative updates are unaffected. Tests:
`tests/snapchat-creative-references.test.mjs` (4). Pushed as `bbd3324`.

## Finished batch — TikTok ad group budgets

[Implementation](TIKTOK-BUDGETS-2026-09-26.md) and
[qualification](TIKTOK-BUDGETS-VERIFICATION-2026-09-26.json).

`tiktok_adgroup_budget_update` (and its alias) is the new reviewed family `tiktok_budgets`:

- Lifetime budgets change immediately; next-day scheduled daily budgets take effect tomorrow.
- Each ad group's mode is checked, and campaign-budget-optimized and Smart+ ad groups are refused.
- Each amount is compared with its own ad group's current budget under the spending policy.
- Read-back uses `budget` or `scheduled_budget`.

Tests: `tests/tiktok-budgets.test.mjs` (8, red on `bbd3324` / green after). Pushed as `e45400e`.

## Finished batch — LinkedIn lead gen forms

[Implementation](LINKEDIN-LEAD-FORMS-2026-09-26.md) and
[qualification](LINKEDIN-LEAD-FORMS-VERIFICATION-2026-09-26.json).

`linkedin_rest_lead_forms_post` is the new reviewed family `linkedin_lead_forms`:

- One sponsored form per review, in DRAFT, owned by the selected ad account; creation needs `rw_ads`.
- The request is checked against the li-lms-2026-09 schema before any request; organization forms, work-email criteria and batch creation are refused.
- The owner finder for the selected account and the creation receipt establish ownership, so owned forms can be read.
- Read-back compares the sent form after documented defaults; 64-bit form IDs are kept exact.
- Forms never spend, so question text mentioning budgets no longer asks for spending confirmation.

Tests: `tests/linkedin-lead-forms.test.mjs` (8, red on `e45400e` / green after). Pushed as `06cd154`.

## Finished batch — TikTok custom conversions

[Implementation](TIKTOK-CUSTOM-CONVERSIONS-2026-09-26.md) and
[qualification](TIKTOK-CUSTOM-CONVERSIONS-VERIFICATION-2026-09-26.json).

`tiktok_custom_conversion_create` is the new reviewed family `tiktok_custom_conversions`:

- Pixel sources only, with the documented name, event and rule limits checked before any request.
- The pixel must be owned by the advertiser, below 100 custom conversions and without the same name; pixel event data and activity counts do not invalidate a review.
- Read-back compares the definition, with rules treated as a set.
- Microsoft Learn and Google's developer site were unreachable here during this batch; TikTok's portal was readable.

Tests: `tests/tiktok-custom-conversions.test.mjs` (7, red on `06cd154` / green after). Pushed as `b4e1c25`.

## Finished batch — TikTok ad groups that use a custom conversion

[Implementation](TIKTOK-ADGROUP-CONVERSIONS-2026-09-26.md) and
[qualification](TIKTOK-ADGROUP-CONVERSIONS-VERIFICATION-2026-09-26.json).

This closes the custom conversion follow-up. An ad group create that sets `custom_conversion_id`
must send the conversion's pixel, `optimization_goal: CONVERT` and the conversion's
`optimization_event`, and the conversion must be `ACTIVE` or `NO_RECENT_ACTIVITY`. It is read
before review and again before execution. Ad group updates that set the field are refused, since
`/adgroup/update/` does not accept it. Tests: `tests/tiktok-adgroup-conversions.test.mjs`
(5; four red on `b4e1c25`, one no-change guard; all green after). Pushed as `21d351a`.

## Finished batch — TikTok saved audiences

[Implementation](TIKTOK-SAVED-AUDIENCES-2026-09-26.md) and
[qualification](TIKTOK-SAVED-AUDIENCES-VERIFICATION-2026-09-26.json).

`tiktok_dmp_saved_audience_create` is the new reviewed family `tiktok_saved_audiences`:

- Every documented targeting field is checked for type, enum and combination rules before any request; the example-only `interest_keyword_language` is refused.
- Referenced custom audiences are read before review and execution and must be owned and available.
- Read-back compares ID lists and actions as sets and the price range by its endpoints, since TikTok returns it in steps of 50.

Tests: `tests/tiktok-saved-audiences.test.mjs` (7, red on `21d351a` / green after). Pushed as `3967a83`.

## Finished batch — TikTok Upgraded Smart+ status

[Implementation](TIKTOK-SMART-PLUS-STATUS-2026-09-26.md) and
[qualification](TIKTOK-SMART-PLUS-STATUS-VERIFICATION-2026-09-26.json).

The Smart+ campaign, ad group and ad status routes (and aliases) are the new reviewed family
`tiktok_smart_plus_status`:

- `ENABLE` or `DISABLE` for 1–20 IDs; deletion and SKAN postback windows are refused.
- Entities are read before review and execution; missing ones are refused and a `FROZEN` ad is never enabled.
- Enabling needs spending confirmation and obeys an owner policy that forbids activation.
- Receipts must report every ID with the requested status; partial outcomes keep their claim. Read-back compares each entity's `operation_status`.

Tests: `tests/tiktok-smart-plus-status.test.mjs` (7, red on `3967a83` / green after). Pushed as `d2d5eec`.

## Finished batch — TikTok Upgraded Smart+ ad group budgets

[Implementation](TIKTOK-SMART-PLUS-BUDGETS-2026-09-26.md) and
[qualification](TIKTOK-SMART-PLUS-BUDGETS-VERIFICATION-2026-09-26.json).

`tiktok_smart_plus_adgroup_budget_update` is the new reviewed family `tiktok_smart_plus_budgets`:

- Immediate `budget` updates for 1–20 ad groups; allowlist-only scheduled budgets are refused.
- Ad groups are read before review and execution and must have their own lifetime or dynamic daily budget.
- Each amount is compared with its own ad group's budget under the spending policy; Goal-based budget increase is explained in the impact.

Tests: `tests/tiktok-smart-plus-budgets.test.mjs` (6, red on `d2d5eec` / green after). Pushed as `9371d74`.

## Finished batch — TikTok Upgraded Smart+ campaigns

[Implementation](TIKTOK-SMART-PLUS-CAMPAIGNS-2026-09-26.md) and
[qualification](TIKTOK-SMART-PLUS-CAMPAIGNS-VERIFICATION-2026-09-26.json).

`tiktok_smart_plus_campaign_create` (and alias) is the new reviewed family `tiktok_smart_plus_campaigns`:

- Paused website-conversion and lead-generation campaigns only, with the required 64-bit `request_id`.
- Documented budget modes per campaign budget optimization setting, with defaults applied for review and verification; the campaign budget is a new budget under the spending policy.
- App, catalog, search, promotional, iOS dedicated, RTA and Goal-based budget increase settings are refused.

Tests: `tests/tiktok-smart-plus-campaigns.test.mjs` (6, red on `9371d74` / green after). Pushed as `3497651`.

## Finished batch — TikTok Upgraded Smart+ ad groups

[Implementation](TIKTOK-SMART-PLUS-ADGROUPS-2026-09-26.md) and
[qualification](TIKTOK-SMART-PLUS-ADGROUPS-VERIFICATION-2026-09-26.json).

`tiktok_smart_plus_adgroup_create` (and alias) is the new reviewed family `tiktok_smart_plus_adgroups`:

- Paused website conversion ad groups only, with per-mode targeting allowlists so TikTok never silently drops a sent targeting field.
- Campaign, pixel, custom conversion and audience dependencies are read before review and execution; ad group budgets must fit the campaign's budget optimization setting.
- Targeting checks, projection and the owned-audience rule now live in `src/tiktok-targeting.ts`, shared with saved audiences.

Tests: `tests/tiktok-smart-plus-adgroups.test.mjs` (6, red on `3497651` / green after). Pushed as `ec0cddd`.

## Finished batch — TikTok Upgraded Smart+ campaign edits

[Implementation](TIKTOK-SMART-PLUS-CAMPAIGN-EDITS-2026-09-26.md) and
[qualification](TIKTOK-SMART-PLUS-CAMPAIGN-EDITS-VERIFICATION-2026-09-26.json).

`tiktok_smart_plus_campaign_update` (and alias) is the new reviewed family `tiktok_smart_plus_campaign_edits`:

- Name, campaign budget and PO number edits; Goal-based budget increase, status and other keys are refused.
- A budget edit needs a campaign that has a campaign budget, is compared with its current budget under the owner spending policy and needs spending confirmation; renames do not.

Tests: `tests/tiktok-smart-plus-campaign-updates.test.mjs` (6, red on `ec0cddd` / green after). The Smart+ campaign creation suite's negative check now uses the still-blocked campaign copy task. Pushed as `b8338ab`.

## Finished batch — TikTok dynamic CTA portfolios

[Implementation](TIKTOK-CTA-PORTFOLIOS-2026-09-26.md) and
[qualification](TIKTOK-CTA-PORTFOLIOS-VERIFICATION-2026-09-26.json).

`tiktok_creative_portfolio_create` (and alias) is the new reviewed family `tiktok_cta_portfolios`:

- CTA portfolios only: groups of recommended CTA texts and IDs; other portfolio types are refused.
- Verification compares the groups as sets, since TikTok reads texts back as keys (`learn_more`); a lost response is never resubmitted because the portfolio list omits CTA portfolios.
- Manual ads (`tiktok_entities`) that set `call_to_action_id` read the named portfolio before review and execution; `call_to_action` beside it, which TikTok ignores, is refused.

Tests: `tests/tiktok-cta-portfolios.test.mjs` (6, red on `b8338ab` / green after). Pushed as `bad418f`
(the first full run failed one unrelated LinkedIn test in teardown under concurrent load; the
repeated run passed).

## Finished batch — TikTok Upgraded Smart+ Spark Ads

[Implementation](TIKTOK-SMART-PLUS-ADS-2026-09-26.md) and
[qualification](TIKTOK-SMART-PLUS-ADS-VERIFICATION-2026-09-26.json).

`tiktok_smart_plus_ad_create` (and alias) is the new reviewed family `tiktok_smart_plus_ads`:

- Paused website conversion ads from 1-20 existing TikTok posts with `TT_USER` or `BC_AUTH_TT` identities, one landing page, a CTA portfolio and explicit automatic creative switches.
- Before review and execution: the ad group (website conversions, TikTok placement, fewer than 30 ads), each identity (available, may use its posts, not political, stated Business Center), each identity's posts and the portfolio. Signed media and profile URLs are left out of the compared state.

Tests: `tests/tiktok-smart-plus-ads.test.mjs` (6, red on `bad418f` / green after). Pushed as `3b009b2`.

## Finished batch — TikTok Upgraded Smart+ Spark Ad edits

[Implementation](TIKTOK-SMART-PLUS-AD-EDITS-2026-09-26.md) and
[qualification](TIKTOK-SMART-PLUS-AD-EDITS-VERIFICATION-2026-09-26.json).

`tiktok_smart_plus_ad_update` (and alias) is the new reviewed family `tiktok_smart_plus_ad_edits`:

- Any Smart+ ad can be renamed; ads from existing posts can have their posts, landing page and configuration changed with the creation checks, which now live in reusable parts of `src/tiktok-smart-plus-ads.ts`.
- `creative_list` is a full replacement, so the review lists kept, added and removed posts; removing posts from an enabled ad needs `creative_edit_confirmed` at review and execution (previously X-only). `TRANSLATE_AND_DUB` keeps its membership and existing UTM parameters must be restated.

Tests: `tests/tiktok-smart-plus-ad-updates.test.mjs` (7, red on `3b009b2` / green after). Pushed as `53fb3ad`.

## Finished batch — TikTok Upgraded Smart+ ad group edits

[Implementation](TIKTOK-SMART-PLUS-ADGROUP-EDITS-2026-09-26.md) and
[qualification](TIKTOK-SMART-PLUS-ADGROUP-EDITS-VERIFICATION-2026-09-26.json).

`tiktok_smart_plus_adgroup_update` (and alias) is the new reviewed family `tiktok_smart_plus_adgroup_edits`:

- Name, end time, dayparting, comment and share settings, and the custom bid; budgets, status and targeting are refused with the family to use instead.
- A bid edit reads the campaign's ad groups after the ad group read (a follow-up state read in `src/write-review.ts`) and lists every bid that moves with it; bid, end time and dayparting edits need `spend_change_confirmed`.

Tests: `tests/tiktok-smart-plus-adgroup-updates.test.mjs` (7, red on `53fb3ad` / green after). Pushed as `533efac`.

## Finished batch — TikTok Upgraded Smart+ creative status

[Implementation](TIKTOK-SMART-PLUS-CREATIVE-STATUS-2026-09-26.md) and
[qualification](TIKTOK-SMART-PLUS-CREATIVE-STATUS-VERIFICATION-2026-09-26.json).

`tiktok_smart_plus_ad_material_status_update` is the new reviewed family `tiktok_smart_plus_material_status`:

- Pauses or enables 1-20 explicitly selected creatives inside a Smart+ ad, read before review and execution; automatically added creatives are refused because the ad read does not list them.
- Carousels and other creatives go in separate requests; the receipt must name every creative; verification compares each creative's status.

Tests: `tests/tiktok-smart-plus-material-status.test.mjs` (6, red on `533efac` / green after). The Smart+ ad group creation suite's still-blocked example is now Smart+ ad appeals. Pushed as `1d971f2`.

## Finished batch — Google Ads rule-based remarketing lists

[Implementation](GOOGLE-RULE-USER-LISTS-2026-09-26.md) and
[qualification](GOOGLE-RULE-USER-LISTS-VERIFICATION-2026-09-26.json).

`userLists` is a new route of the reviewed `google_configuration` family (rules in `src/google-user-lists.ts`):

- Open rule-based lists with explicit operators and 1-540 day lookback windows; Customer Match, lookalike, logical and basic lists, `membershipLifeSpan` (ignored by Google for rule-based lists) and removal are refused.
- Verification compares operands, groups and items as sets against Google's read-back form; closing a list needs spending confirmation. The `user_list` GAQL fields were added to the pinned field fixture.

Tests: `tests/google-user-lists.test.mjs` (5, red on `1d971f2` / green after); the configuration lifecycle table gained the `userLists` case. Pushed as `f440117`.

## Finished batch — TikTok manual ads with custom identities

[Implementation](TIKTOK-MANUAL-AD-IDENTITIES-2026-09-26.md) and
[qualification](TIKTOK-MANUAL-AD-IDENTITIES-VERIFICATION-2026-09-26.json).

- Reviewed manual ad creation refuses a `CUSTOMIZED_USER` non-Spark ad in an ad group that delivers on TikTok, with `TIKTOK_CUSTOM_IDENTITY_PLACEMENT`, using the ad group already read before review and execution. Pangle-only ad groups, Spark identities and ad updates are unaffected.

Tests: `tests/tiktok-manual-ad-identities.test.mjs` (3; two red on `f440117`, one no-change guard; all green after).

## CI and live evidence

The push to CAMCP was the first commit there. Its GitHub Actions run must be checked by
exact SHA (Actions may need enabling on the new repository). This checkout has no
GitHub CLI and CAMCP is private, so the runs for `d88f1e0` and later commits were not
read from here. Nothing is claimed green from the local result alone. Live acceptance is unverified: the fixes reach the AMCP
connector only after its deployment is updated from this code (not authorized here).
Afterwards, re-run the Snapchat clone as one plan with `expected_currency` set and
confirm BUG-1 to BUG-6 live.

## Remaining inventory

3241 captured actions; 506 in reviewed write families. **931 remaining rows** are in
[REMAINING-ACTIONS-2026-09-26.csv](REMAINING-ACTIONS-2026-09-26.csv), derived from the
coverage ledger with the same status filter as the 2026-09-25 file:

| Category | Rows |
|---|---:|
| blocked_write | 816 |
| unmapped | 79 |
| unqualified_read | 23 |
| adapter_requires_input | 8 |
| provider_unsupported | 5 |

Blocked writes by platform: TikTok 191, Meta 131, LinkedIn 118, Google Ads 101,
Snapchat 91, X 67, DV360 62, Criteo 43, Business Profile 12.

An approximate keyword triage of the 959 rows at the TikTok saved audience batch (a local
planning script in this checkout, not committed and not a ledger):

| Group | Rows | Notes |
|---|---:|---|
| Campaign building and management | ~297 | Real candidates; a few account-admin and funding routes fall here by keyword |
| Deletions of ad entities | 87 | Destructive; lower priority |
| Account, business, billing and access administration | 103 | Needs separate authorization |
| Organic, social and community | 103 | Not advertising |
| Catalogs and commerce | 91 | Separate area |
| Personal and customer data | 85 | Excluded by instruction |
| Experiments, measurement and planning | 78 | Lower priority |
| Not blocked writes (unmapped, unqualified reads, adapter input, unsupported) | 115 | Mostly reads and local tooling |

Microsoft Learn was still unreachable from this environment on 2026-09-26 evening, so LinkedIn
candidates wait for it; Google's developer documentation was reachable again. The ticket list in the
2026-09-25 handoff remains the backlog, plus these Snapchat follow-ups:

| Priority | Task | Acceptance |
|---|---|---|
| P1 | Deploy this build where the AMCP connector runs (separately authorized) | Live clone as one plan: currency passes, ad squads verify, no ownership race |
| P2 | Snapchat PUT semantics for write-only `placement_v2` | Live evidence of PUT with/without the field before changing preservation rules |
| P3 | `get_creatives_by_ids` request body | Provider documentation or a captured successful request |
| P3 | Snapchat campaign recipe | Qualified inputs for currency, budget, pixel and media; paused entities only |
| P2 | Live lead form acceptance (after deployment) | One paused account-owned test form and `LEAD_GENERATION` creative verify live |
| P2 | Snapchat pixel/mobile rule audiences | Live GET evidence of `pixel_spec_object`/mobile specs before qualifying their creation |
| P3 | Snapchat segment deletion | A way to find ad squads that target a segment, or an explicit owner policy, before permanent deletion |
| P2 | TikTok identity avatar read-back | Live evidence linking `profile_image_url` to the sent `image_uri` before comparing it |
| P2 | TikTok pixel creation | An owner policy for the API's data-sharing defaults first: manual advanced matching of emails and phone numbers, first-party cookies and expanded data sharing are on unless disabled. This is customer-data processing, kept separate by instruction |
| P2 | Meta budget scheduling (high demand periods) | Exact `budget_value` units for `ABSOLUTE` and `MULTIPLIER` and the `CAN_USE_BUDGET_SCHEDULING_API` capability before spending-policy checks can be built |
| P3 | TikTok asynchronous campaign copy | `/campaign/copy/task/create/` is allowlist-only; needs an allowlisted advertiser, a paused-copy guarantee for every ad group and a task-result verification design |
| P2 | LinkedIn lead gen creatives must reference owned forms | The documented creative field and URN type that point a lead gen creative at a form, then the same owned-reference check as Snapchat creatives |
| P2 | LinkedIn lead form edits, publishing and archiving | A read of the creatives and campaigns that use a form, to tell pre-published from published forms and limit edits to the documented fields, plus the documented warning about CRM integrations |
| P2 | TikTok Upgraded Smart+ ad group targeting edits | Name, schedule, dayparting, comment, share and bid edits are qualified. Targeting needs evidence of whether a partial `targeting_spec` update replaces or merges (a live read-back after a one-field edit) before it can be reviewed |
| P3 | LinkedIn work-email submission criteria | The wire form of the `questionSubmissionCriteria` union, which the schema does not show |
| P3 | X remaining writes (promoted accounts, cards, tracking tags) | The official X Ads API reference returned HTTP 402 from this environment; needs an accessible, versioned source first |
