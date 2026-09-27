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

Tests: `tests/tiktok-manual-ad-identities.test.mjs` (3; two red on `f440117`, one no-change guard; all green after). Pushed as `f289b11`.

## Finished batch — Google Ads conversion value rules

[Implementation](GOOGLE-VALUE-RULES-2026-09-26.md) and
[qualification](GOOGLE-VALUE-RULES-VERIFICATION-2026-09-26.json).

`conversionValueRules` and `conversionValueRuleSets` are new routes of the reviewed `google_configuration` family (rules in `src/google-value-rules.ts`):

- ADD and MULTIPLY rules with at most two audience, device or location conditions; SET, itineraries, store categories and NO_CONDITION sets are refused.
- Rule sets read every included rule and check it fits the set dimensions; a set's rule order is compared as sent because the first matching rule applies. Set changes and rule edits need spending confirmation.

Tests: `tests/google-value-rules.test.mjs` (5, red on `f289b11` / green after); the configuration lifecycle table gained both routes. Pushed as `3bd855f`.

## Finished batch — TikTok Upgraded Smart+ Instant Form lead generation ad groups

[Implementation](TIKTOK-SMART-PLUS-LEAD-ADGROUPS-2026-09-26.md) and
[qualification](TIKTOK-SMART-PLUS-LEAD-ADGROUPS-VERIFICATION-2026-09-26.json).

- The Smart+ ad group contract gains an Instant Form lead generation mode: `LEAD_GENERATION` promotion and goal with `INSTANT_PAGE`, no pixel or attribution fields, Global App Bundle placements allowed, a lead generation campaign, and a target CPA only with a daily budget.

Tests: `tests/tiktok-smart-plus-lead-adgroups.test.mjs` (4, red on `3bd855f` / green after). Pushed as `895cb29`.

## Finished batch — TikTok Upgraded Smart+ Instant Form lead generation ads

[Implementation](TIKTOK-SMART-PLUS-LEAD-ADS-2026-09-26.md) and
[qualification](TIKTOK-SMART-PLUS-LEAD-ADS-VERIFICATION-2026-09-26.json).

- Smart+ ads name one published Instant Form in `page_list` in lead generation ad groups, or one landing page in website ad groups; the review refuses the other destination.
- `/page/get/` cannot filter by page ID, so `src/tiktok-instant-forms.ts` reads the advertiser's published forms page by page (up to 10 pages of 100) through follow-up state reads, validated before the generic pagination guard. `src/scope.ts` now authorizes `/page/get/` for the selected advertiser only, never with a Business Center `library_id`.

Tests: `tests/tiktok-smart-plus-lead-ads.test.mjs` (4, red on `895cb29` / green after). Instant Form ad edits beyond renaming stay unqualified. Pushed as `d72743b`.

## Finished batch — DV360 line item targeting

[Implementation](DV360-LINE-ITEM-TARGETING-2026-09-26.md) and
[qualification](DV360-LINE-ITEM-TARGETING-VERIFICATION-2026-09-26.json).

- New reviewed family `dv360_line_item_targeting` (`src/dv360-line-item-targeting.ts`) for line item bulk edit and single create/delete of assigned targeting options: 1–10 line items, the 45 documented types, only the matching details member, no output-only fields.
- The review reads each line item, every page of its targeting of the edited types (bulk list filtered by type) and each assigned channel, negative keyword list or location list under the advertiser. It refuses YouTube & Partners, Demand Gen and archived line items, inherited or absent deletions, duplicates and documented limits. A partial bulk receipt stays a failure.
- Next DV360 step: audience group and inventory source assignment need reads of the advertiser's access to first-party, Google, custom and combined audiences and inventory sources.

Tests: `tests/dv360-line-item-targeting.test.ts` (8, red on `d72743b` / green after). Pushed as `ca8c6e8`.

## Finished batch — DV360 advertiser targeting

[Implementation](DV360-ADVERTISER-TARGETING-2026-09-26.md) and
[qualification](DV360-ADVERTISER-TARGETING-VERIFICATION-2026-09-26.json).

- New reviewed family `dv360_advertiser_targeting` for the advertiser edit, create and delete routes, served by the same module as line item targeting: the five advertiser types only, channel and keyword options as exclusions, the advertiser read (active or paused), its complete targeting of the edited types and the assigned channels.
- Advertiser targeting always needs spending confirmation and counts as serving under an activation-forbidding owner policy, because every line item inherits it. A response that omits a created option stays a failure.

Tests: `tests/dv360-advertiser-targeting.test.ts` (8, red on `ca8c6e8` / green after). Pushed as `4b67890`.

## Finished batch — Google Performance Max retail listing groups

[Implementation](GOOGLE-LISTING-GROUPS-2026-09-26.md) and
[qualification](GOOGLE-LISTING-GROUPS-VERIFICATION-2026-09-26.json).

- New reviewed family `google_listing_groups` (`src/google-listing-groups.ts`) for the listing group filter mutate route and its create and remove aliases. It covers one asset group per review, `SHOPPING` only, create and remove with temporary IDs, and leaves-first removal.
- The review reads the asset group with its campaign (Merchant Center link required) and the complete tree, applies the operations in order and validates the resulting tree. Verification compares shape, not IDs.
- Webpage listing groups and listing group updates (immutable fields) stay unqualified.

Tests: `tests/google-listing-groups.test.ts` (8, red on `4b67890` / green after). Pushed as `242470d`.

## Finished batch — TikTok Search Ads negative keywords

[Implementation](TIKTOK-NEGATIVE-KEYWORDS-2026-09-26.md) and
[qualification](TIKTOK-NEGATIVE-KEYWORDS-VERIFICATION-2026-09-26.json).

- New reviewed family `tiktok_negative_keywords` (`src/tiktok-negative-keywords.ts`) for add (including replace), update and delete on manual campaigns and ad groups with Automatic Search Placement.
- A bounded reader in both state and verification chains reads every page of each keyword list (up to 200 pages of 50), because add and delete return no keyword IDs. Plain additions need no spending confirmation; deletions, replacements and renames do.

Tests: `tests/tiktok-negative-keywords.test.mjs` (8, red on `242470d` / green after). Pushed as `e16d168`.

## Finished batch — TikTok account brand safety

[Implementation](TIKTOK-BRAND-SAFETY-2026-09-26.md) and
[qualification](TIKTOK-BRAND-SAFETY-VERIFICATION-2026-09-26.json).

- New reviewed family `tiktok_brand_safety` (`src/tiktok-brand-safety.ts`) for the Pangle block list and the Brand Safety Hub.
- Pangle apps must be iTunes IDs or package names, checked against the current list; blocking needs no confirmation, but unblocking and clearing do, and the receipt's added count must match.
- Hub updates send the tier, exclusions and vertical together, always need confirmation, and cannot switch back from all objectives.

Tests: `tests/tiktok-brand-safety.test.mjs` (8, red on `e16d168` / green after). Pushed as `1140286`.

## Finished batch — Snapchat planning reads

[Implementation](SNAPCHAT-PLANNING-READS-2026-09-26.md) and
[qualification](SNAPCHAT-PLANNING-READS-VERIFICATION-2026-09-26.json).

- `targeting_insights` and `reserved_forecasting` are POST reads, validated during compilation by `src/snapchat-planning-reads.ts` and allowlisted in `src/execution-risk.ts`. They run through the native read path, never `amcp_write`.
- The forecast accepts only the documented ad squad attributes with `REACH_AND_FREQUENCY` delivery, dates 12 hours to 365 days ahead and the goal of its type.

Tests: `tests/snapchat-planning-reads.test.mjs` (4, red on `1140286` / green after); `tests/compiler.test.ts` supplies valid planning bodies. Pushed as `40fd508`.

## Finished batch — Meta value rule sets

[Implementation](META-VALUE-RULES-2026-09-26.md) and
[qualification](META-VALUE-RULES-VERIFICATION-2026-09-26.json).

- New reviewed family `meta_value_rules` (`src/meta-value-rules.ts`) for value rule set create, complete update and delete, with the documented rule, criterion and account limits.
- Listing the account's sets records their IDs (`src/scope.ts`), which the update and delete paths need. Updates and deletion need spending confirmation; creation does not.

Tests: `tests/meta-value-rules.test.mjs` (6, red on `40fd508` / green after). Pushed as `2743949`.

## Finished batch — Meta account controls and publisher block lists

[Implementation](META-BRAND-SAFETY-2026-09-26.md) and
[qualification](META-BRAND-SAFETY-VERIFICATION-2026-09-26.json).

- New reviewed family `meta_brand_safety` (`src/meta-brand-safety.ts`). Account controls are set as sent (left-out controls are removed), need spending confirmation and verify exactly against a normalized read. Empty publisher block lists are created by a new name without confirmation.
- Adding publishers to block lists and applying them remain separate, uncaptured workflows.

Tests: `tests/meta-brand-safety.test.mjs` (6, red on `2743949` / green after). Pushed as `8fa32bf`.

Other planning candidates checked and left: TikTok Automated Rules are limited by TikTok to direct advertisers (notifications go to the developer's email), and TikTok ACO ads are marked deprecated in the API reference.

## Finished batch — Criteo auction line items (2026-09-27)

[Implementation](CRITEO-AUCTION-LINE-ITEMS-2026-09-27.md) and
[qualification](CRITEO-AUCTION-LINE-ITEMS-VERIFICATION-2026-09-27.json).

- New reviewed family `criteo_auction_line_items` (`src/criteo-auction-line-items.ts`) for auction line item creation (in draft) and the complete PUT. Every writable field is required, the review reads the account, campaign, line item and the campaign's line item names, and verification compares every field and the status.
- A verified creation records the new line item as owned (`src/write-verification.ts`); updates otherwise need the line item listed with `GET_LINE_ITEMS_BY_ACCOUNT_ID`.

Tests: `tests/criteo-auction-line-items.test.mjs` (7, red on `8fa32bf` / green after). Pushed as `78c1252`.

## Finished batch — Criteo promoted products (2026-09-27)

[Implementation](CRITEO-PROMOTED-PRODUCTS-2026-09-27.md) and
[qualification](CRITEO-PROMOTED-PRODUCTS-VERIFICATION-2026-09-27.json).

- New reviewed family `criteo_promoted_products` (`src/criteo-promoted-products.ts`) for append (with bid overrides), delete, pause and unpause. The line item reader now also reads the line item's products (up to 1500), and verification keys products by a hexadecimal form of their case-sensitive IDs.
- Line item read-back compares flight days case-insensitively (the 2026.01 guide shows `Weekends` in a read sample).

Tests: `tests/criteo-promoted-products.test.mjs` (7) and a capitalized-day case in `tests/criteo-auction-line-items.test.mjs`, red on `78c1252` / green after. Pushed as `c96529c`.

## Finished batch — Criteo keywords and bid multipliers (2026-09-27)

[Implementation](CRITEO-KEYWORDS-BID-MULTIPLIERS-2026-09-27.md) and
[qualification](CRITEO-KEYWORDS-BID-MULTIPLIERS-VERIFICATION-2026-09-27.json).

- New reviewed families `criteo_keywords` (add/remove and bids) and `criteo_bid_multipliers` (complete PUT) in `src/criteo-line-item-bidding.ts`. The line item reader also reads keywords or multipliers; phrases are matched case-insensitively within their match type through Criteo's normalized keywords.
- `ADD_REMOVE_KEYWORDS` stays a deletion under owner policies (the delegated compiler's name rule), additions included; kept as a fail-closed default.
- The generic "bid/budget/spend" preflight heuristic no longer applies to the line item bidding and promoted product families, which decide spending confirmation themselves.
- Left for later: keyword review (a retailer action), preferred line items, budget overrides (a complete PUT of ordered daily and monthly sequences), balance-to-campaign mapping (the 2026.01 guide shows an `ids` body while the pinned document has a list of resources; resolve before qualifying), creatives and assets.

Tests: `tests/criteo-line-item-bidding.test.mjs` (7) and a product ID case in `tests/criteo-promoted-products.test.mjs`, red on `c96529c` / green after. Pushed as `ff9c443`.

## Finished batch — DV360 Demand Gen ad groups (2026-09-27)

[Implementation](DV360-DEMAND-GEN-AD-GROUPS-2026-09-27.md) and
[qualification](DV360-DEMAND-GEN-AD-GROUPS-VERIFICATION-2026-09-27.json).

- New reviewed family `dv360_demand_gen_ad_groups` (`src/dv360-demand-gen-ad-groups.ts`) for create, patch (update mask) and delete of Demand Gen ad groups. A reader reads the advertiser, the ad group and its Demand Gen line item; verification compares every setting sent or confirms a deletion.
- Next DV360 Demand Gen steps, in Google's order: ad group targeting (`adGroups.targetingTypes.assignedTargetingOptions` create/delete and bulk edit), ad assets (create, upload, bulk create) and ad group ads (create, patch, delete).
- Also checked and left: Meta lead forms need a Page access token, which AMCP does not resolve (`src/parameters.ts`), so they need credential work first; Criteo budget overrides merge adjacent equal overrides and drop chained start dates in read-back, and whether expired overrides may be omitted is undocumented; Criteo balance-to-campaign mapping has a guide body (`ids`) that differs from the pinned document.

Tests: `tests/dv360-demand-gen-ad-groups.test.mjs` (7), red on `ff9c443` / green after. Pushed as `9e46fd9`.

## Finished batch — DV360 Demand Gen targeting (2026-09-27)

[Implementation](DV360-DEMAND-GEN-TARGETING-2026-09-27.md) and
[qualification](DV360-DEMAND-GEN-TARGETING-VERIFICATION-2026-09-27.json).

- The DV360 targeting module has an ad group level (`dv360_ad_group_targeting`: bulk edit, create, delete) with the documented Demand Gen ad group types, reading each ad group and its line item through the Demand Gen ad group reader.
- Demand Gen line items take their documented types instead of being refused; geo region, POI and language follow `demandGenSettings.geoLanguageTargetingEnabled`.
- Next DV360 Demand Gen steps: audience group assignment (reads of the advertiser's access to first-party and partner, Google, custom and combined audiences; also the existing P2 for line items), YouTube video ad assets (`adAssets.create` and `bulkCreate`; image assets need a media upload) and ads (`adGroupAds` create, patch, delete; a video ad also needs a logo image asset).

Tests: `tests/dv360-ad-group-targeting.test.mjs` (8), red on `9e46fd9` / green after. Pushed as `1d90531`.

## Finished batch — DV360 YouTube video ad assets and Demand Gen exclusions (2026-09-27)

[Implementation](DV360-AD-ASSETS-2026-09-27.md) and
[qualification](DV360-AD-ASSETS-VERIFICATION-2026-09-27.json).

- New reviewed family `dv360_ad_assets` (`src/dv360-ad-assets.ts`) for YouTube video ad asset create and bulk create, with a per-video check for an existing active asset and verification by ID. The generic DV360 state check now maps `adAssets` paths to `adAssetId`.
- Demand Gen targeting refuses positive keyword, category, URL, app, app category and YouTube channel or video targeting (DV360 Help: exclusions only).
- Next: Demand Gen ads (`adGroupAds` create, patch, delete: four ad types; video assets can be checked by ID, image assets cannot be read back through the API). Image asset upload (`adAssets:uploadAdAsset`) needs a qualified media upload.

Tests: `tests/dv360-ad-assets.test.mjs` (6) and Demand Gen exclusions in `tests/dv360-ad-group-targeting.test.mjs`, red on `1d90531` / green after. Pushed as `e8e4a8a`.

## Finished batch — DV360 Demand Gen ads (2026-09-27)

[Implementation](DV360-DEMAND-GEN-ADS-2026-09-27.md) and
[qualification](DV360-DEMAND-GEN-ADS-VERIFICATION-2026-09-27.json).

- New reviewed family `dv360_demand_gen_ads` (`src/dv360-demand-gen-ads.ts`) for `adGroupAds` create, patch (top-level `updateMask`) and delete of the four Demand Gen ad types. The review reads the ad, its ad group and line item (through the ad group reader) and each YouTube video asset by ID; archived parents, archived or non-video assets, type changes and patches that change nothing are refused.
- An active ad needs `spend_change_confirmed` and is an activation under owner policies; deletion is a deletion. Verification compares the name, status, type and every creative field sent, ignoring output-only fields.
- Image, logo and carousel images must already exist: image asset upload (`adAssets:uploadAdAsset`) needs a qualified media upload, and the API does not read image assets back, so DV360 checks those IDs.
- Next DV360 steps: audience group assignment (see the Demand Gen targeting batch above) and image asset upload.

Tests: `tests/dv360-demand-gen-ads.test.mjs` (7), red on `e8e4a8a` / green after. Pushed as `a9f32c0`.

## Finished batch — DV360 Demand Gen image ad assets (2026-09-27)

[Implementation](DV360-IMAGE-AD-ASSETS-2026-09-27.md) and
[qualification](DV360-IMAGE-AD-ASSETS-VERIFICATION-2026-09-27.json).

- `amcp_media` takes `dv360_target: ad_asset` (and optional `synthetic_content`) for DV360, and the native `DV360_ADVERTISERS_AD_ASSETS_UPLOAD` routes to the same reviewed media import: PNG or JPEG up to 5120 KB, one multipart `adAssets.upload` after confirmation, and a receipt checked for the image type, advertiser and label. The result gives `creative_reference: {assetId}` for Demand Gen ads.
- The API reads back only YouTube video assets, so the receipt is the evidence; `platform_media_upload` keeps its captured schema and uploads creative assets only.
- Every Demand Gen level below the line item now has a reviewed route: ad groups, targeting, video and image assets, and ads. Remaining DV360 Demand Gen gap: audience group assignment (see the Demand Gen targeting batch above).

Tests: `tests/dv360-image-ad-assets.test.mjs` (6), red on `a9f32c0` / green after. Pushed as `bc4faba`.

## Finished batch — DV360 audience targeting (2026-09-27)

[Implementation](DV360-AUDIENCE-TARGETING-2026-09-27.md) and
[qualification](DV360-AUDIENCE-TARGETING-VERIFICATION-2026-09-27.json).

- `src/dv360-audiences.ts` and `src/scope.ts`: gets and lists of first-party and partner, Google, custom-list and combined audiences are in scope with the selected `advertiserId` (no `partnerId`, documented list parameters only). They were refused before, so audience IDs could not be found.
- `TARGETING_TYPE_AUDIENCE_GROUP` is assignable on line items and Demand Gen ad groups: each audience is read with the advertiser's access; recency only on first-party audiences; only affinity, in-market and installed-apps Google audiences excluded; no repeats, at most 5 combined audiences and 100 audiences per review. Audience sizes are left out of the reviewed state; verification ignores DV360's order and treats `RECENCY_NO_LIMIT` as no recency.
- Inventory source and inventory source group targeting stay refused (the other half of the P2).

Tests: `tests/dv360-audience-targeting.test.mjs` (8) and updated audience cases in `tests/dv360-line-item-targeting.test.ts` and `tests/dv360-ad-group-targeting.test.mjs`, red on `bc4faba` / green after. Pushed as `fefc545`.

## Finished batch — Snapchat chunked media upload (2026-09-27)

[Implementation](SNAPCHAT-CHUNKED-MEDIA-2026-09-27.md) and
[qualification](SNAPCHAT-CHUNKED-MEDIA-VERIFICATION-2026-09-27.json).

- `src/media-upload.ts`: Snapchat files over 32,000,000 bytes use `multipart-upload-v2` INIT, ADD (16 MiB parts, at most 32) and FINALIZE as multipart forms; returned paths must name the allocated media and action; confirmed parts are journaled; an interrupted upload is uncertain and is not resumed (a new review can target the same `existing_media_id`).
- `src/transport.ts` allows field-only multipart forms only for those INIT and FINALIZE paths; `src/media-routing.ts` routes the native INIT actions to the import. Ownership of an `existing_media_id` is checked before the Drive download.
- Not done: resuming a partially uploaded Snapchat file (Snap documents no part listing), and the public profile media upload.

Tests: `tests/snapchat-chunked-media.test.mjs` (6), red on `fefc545` / green after. Pushed as `c156b32`.

## Finished batch — LinkedIn dynamic UTM tracking parameters (2026-09-27)

[Implementation](LINKEDIN-TRACKING-PARAMETERS-2026-09-27.md) and
[qualification](LINKEDIN-TRACKING-PARAMETERS-VERIFICATION-2026-09-27.json).

- New reviewed family `linkedin_tracking_parameters` (`src/linkedin-tracking-parameters.ts`) for `/rest/adTrackingParameters` PUT and DELETE of campaign parameters (and account-level ones with LinkedIn-Version 202608): canonical REST.li key, documented dynamic values, unique URL-safe names, the current `idempotencyToken` for replacement, owner deletion policy and exact read-back.
- `src/transport.ts` accepts the undocumented empty body of this PUT's 201/200 on this path only. The provider review date of Snapchat and LinkedIn is now 2026-09-27.
- Microsoft Learn is reachable again; LinkedIn candidates (engagement retargeting audiences, Conversation Ads, document uploads) can use it.

Tests: `tests/linkedin-tracking-parameters.test.mjs` (8), red on `c156b32` / green after. Pushed as `3dac065`.

## Finished batch — Google Performance Max brand guidelines (2026-09-27)

[Implementation](GOOGLE-PMAX-BRAND-GUIDELINES-2026-09-27.md) and
[qualification](GOOGLE-PMAX-BRAND-GUIDELINES-VERIFICATION-2026-09-27.json).

- New reviewed family `google_pmax_brand_guidelines` (`src/google-pmax-brand-guidelines.ts`) for `campaigns:enablePMaxBrandGuidelines` (RPC and legacy alias): 1–10 campaigns; explicit brand assets (business name of at most 25 characters, 1–5 logos with at least one square logo of 128 x 128 or more, 4:1 landscape logos of 512 x 128 or more) or Google-chosen ones; paired hex colors; a documented font.
- Reads the customer, campaigns (Performance Max, not removed, no travel goals, not yet enabled) and assets; irreversible, so `spend_change_confirmed` is required; any enablement error fails the outcome; read-back compares links, colors and font.
- LinkedIn engagement retargeting was researched: DMP segments document the `rw_dmp_segments` permission of LinkedIn's Audiences program, which AMCP does not request, while engagement rules list `rw_ads`. It needs that permission question settled first.

Tests: `tests/google-pmax-brand-guidelines.test.mjs` (6), red on `3dac065` / green after. Pushed as `903b5c5`.

## Finished batch — DV360 line item bulk status updates (2026-09-27)

[Implementation](DV360-LINE-ITEM-BULK-UPDATE-2026-09-27.md) and
[qualification](DV360-LINE-ITEM-BULK-UPDATE-VERIFICATION-2026-09-27.json).

- New reviewed family `dv360_line_item_bulk_update` (`src/dv360-line-item-bulk-update.ts`) for `lineItems:bulkUpdate`: 1–100 line items, `entityStatus` (active, paused, archived; never back to draft) and/or `containsEuPoliticalAds`, with each line item and insertion order read, YouTube & Partners and archived line items refused, activation confirmation, and read-back of every line item.
- DV360 YouTube asset associations stay blocked: the pinned document marks them "only available to an informed subset of users" (allowlist).

Tests: `tests/dv360-line-item-bulk-update.test.mjs` (6), red on `903b5c5` / green after. Pushed as `e24d475`.

## Finished batch — Snapchat media copy between ad accounts (2026-09-27)

[Implementation](SNAPCHAT-MEDIA-COPY-2026-09-27.md) and
[qualification](SNAPCHAT-MEDIA-COPY-VERIFICATION-2026-09-27.json).

- New reviewed family `snapchat_media_copy` (`src/snapchat-media-copy.ts`) for `POST /v1/adaccounts/{ad_account_id}/media_copy`: 1–20 READY images and videos from other ad accounts of the same organization, each source account bound to the login, each source media read under its own account, a partial receipt kept as a failure and never resubmitted, and each copy read back in the selected ad account under its new ID.
- The copies become media of the selected ad account from the receipt, so creatives can use them without another listing.

Tests: `tests/snapchat-media-copy.test.mjs` (5), red on `e24d475` / green after. Pushed as `3123374`.

## Finished batch — Criteo line items in retailer-billed campaigns (2026-09-27)

[Implementation](CRITEO-RETAILER-BILLED-LINE-ITEMS-2026-09-27.md) and
[qualification](CRITEO-RETAILER-BILLED-LINE-ITEMS-VERIFICATION-2026-09-27.json).

- Defect fix in `src/criteo-auction-line-items.ts`: the campaign read took only a numeric string as the retailer, while the pinned document types `CampaignV202301.retailerId` as an int32, so every auction line item, promoted product, keyword and bid multiplier review in a retailer-billed campaign stopped as incomplete state. The retailer is now compared as a string.
- Criteo preferred (onsite display) line items stay blocked: Criteo documents Preferred Deals as a beta "available only to our Retailer partners", with documentation from the account manager, and AMCP connects demand accounts.

Tests: `tests/criteo-auction-line-items.test.mjs` (fixture and model test changed), red on `3123374` / green after. Pushed as `220e746`.

## Finished batch — Google Ads user list customer types (2026-09-27)

[Implementation](GOOGLE-USER-LIST-CUSTOMER-TYPES-2026-09-27.md) and
[qualification](GOOGLE-USER-LIST-CUSTOMER-TYPES-VERIFICATION-2026-09-27.json).

- New reviewed family `google_user_list_customer_types` (`src/google-user-list-customer-types.ts`) for `UserListCustomerTypeService.MutateUserListCustomerTypes`: 1–100 attach or remove operations, with the customer's conversion tracking, each list and its current types read; CRM-based or rule-based lists only, conflicting types (the seven documented pairs and loyalty tiers) refused on the types after the request, and every list read back.

Tests: `tests/google-user-list-customer-types.test.mjs` (5), red on `220e746` / green after. Pushed as `37b18b3`.

## Finished batch — DV360 line item duplication (2026-09-27)

[Implementation](DV360-LINE-ITEM-DUPLICATE-2026-09-27.md) and
[qualification](DV360-LINE-ITEM-DUPLICATE-VERIFICATION-2026-09-27.json).

- New reviewed family `dv360_line_item_duplicate` (`src/dv360-line-item-duplicate.ts`) for `lineItems.duplicate`: one line item, a required name (240 UTF-8 bytes) and EU declaration, with the line item and insertion order read; YouTube & Partners and archived sources refused; the copy read back in draft, so no spending confirmation.

Tests: `tests/dv360-line-item-duplicate.test.mjs` (5), red on `37b18b3` / green after. Pushed as `1836baf`.

## Finished batch — X line item tracking tags (2026-09-27)

[Implementation](X-TRACKING-TAGS-2026-09-27.md) and
[qualification](X-TRACKING-TAGS-VERIFICATION-2026-09-27.json).

- New reviewed family `x_tracking_tags` (`src/x-tracking-tags.ts`) for the three `tracking_tags` writes: impression and click trackers created on a line item, their URL replaced and the tag deleted, with the tag, the line item and its current tags read; duplicates, unchanged URLs and deleted targets refused; each tag read back by ID.

Tests: `tests/x-tracking-tags.test.mjs` (5), red on `1836baf` / green after. Pushed as `3a2d50d`.

## Finished batch — LinkedIn third-party tracking tags (2026-09-27)

[Implementation](LINKEDIN-THIRD-PARTY-TRACKING-2026-09-27.md) and
[qualification](LINKEDIN-THIRD-PARTY-TRACKING-VERIFICATION-2026-09-27.json).

- New reviewed family `linkedin_third_party_tracking` (`src/linkedin-third-party-tracking.ts`) for `POST /rest/thirdPartyTrackingTags` and `DELETE /rest/thirdPartyTrackingTags/{id}`: DoubleClick impression and click tags of creatives, with the ad account, the creative, the tag and the creative's tags read; duplicates refused; the new tag read back by its `x-restli-id`, or a deleted tag checked gone.

Tests: `tests/linkedin-third-party-tracking.test.mjs` (5), red on `3a2d50d` / green after. Pushed as `4403458`.

## Finished batch — X promoted accounts, media creatives and scheduled promoted Tweets (2026-09-27)

[Implementation](X-LINE-ITEM-ASSOCIATIONS-2026-09-27.md) and
[qualification](X-LINE-ITEM-ASSOCIATIONS-VERIFICATION-2026-09-27.json).

- New reviewed family `x_line_item_associations` (`src/x-line-item-associations.ts`) for the create and delete routes of `promoted_accounts`, `media_creatives` and `scheduled_promoted_tweets`: PROMOTED_ACCOUNT line items and promotable users, account media with the landing URL rules, unpublished scheduled Tweets, duplicates refused, creation with activation confirmation (it serves ACTIVE), and each association read back by ID.
- X preroll call to actions stay blocked for now: they are documented in the Creatives reference, which this checkout has no copy of.

Tests: `tests/x-line-item-associations.test.mjs` (6), red on `4403458` / green after. Pushed as `d355933`.

## Finished batch — Google Ads campaign drafts (2026-09-27)

[Implementation](GOOGLE-CAMPAIGN-DRAFTS-2026-09-27.md) and
[qualification](GOOGLE-CAMPAIGN-DRAFTS-VERIFICATION-2026-09-27.json).

- New reviewed family `google_campaign_drafts` (`src/google-campaign-drafts.ts`) for `CampaignDraftService` mutate (create, rename, remove; legacy actions limited to their own operation) and promote: base campaigns and their drafts read, duplicate names and invalid status transitions refused, promotion with spending confirmation and activation policy, drafts read back and a promotion verified once PROMOTED.
- Google campaign call bid modifier creation stays blocked: its resource name needs the criterion ID of the CALLS interaction type, which the pinned v23 document does not give.

Tests: `tests/google-campaign-drafts.test.mjs` (5), red on `d355933` / green after. Pushed as `830de73`.

## Finished batch — X pre-roll curated categories (2026-09-27)

[Implementation](X-CURATED-CATEGORIES-2026-09-27.md) and
[qualification](X-CURATED-CATEGORIES-VERIFICATION-2026-09-27.json).

- New reviewed family `x_curated_categories` (`src/x-curated-categories.ts`) for the three `line_item_curated_categories` writes: PREROLL_VIEWS line items only, the category, the line item and every association of the account for it read, duplicates and unchanged categories refused, additions and replacements with spending confirmation, and each association read back.

Tests: `tests/x-curated-categories.test.mjs` (4), red on `830de73` / green after. Pushed as `268cd70`.

## Finished batch — LinkedIn Message Ads and Conversation Ads content (2026-09-27)

[Implementation](LINKEDIN-MESSAGE-ADS-2026-09-27.md) and
[qualification](LINKEDIN-MESSAGE-ADS-VERIFICATION-2026-09-27.json).

- New reviewed family `linkedin_message_ads` (`src/linkedin-message-ads.ts`) for InMail content (create, partial update) and sponsored conversations (create, first message and headline updates, message creation single or batch, message updates and batch deletion): the whole message tree checked as it will be, lead forms and conversations of the selected ad account, and read-back. Compound message URNs are fully REST.li-encoded in paths (`src/compiler.ts`).

Tests: `tests/linkedin-message-ads.test.mjs` (5), red on `268cd70` / green after. Pushed as `6bf3f05`.

## Finished batch — Criteo campaign and line item budget overrides (2026-09-27)

[Implementation](CRITEO-BUDGET-OVERRIDES-2026-09-27.md) and
[qualification](CRITEO-BUDGET-OVERRIDES-VERIFICATION-2026-09-27.json).

- New reviewed family `criteo_budget_overrides` (`src/criteo-budget-overrides.ts`) for the two override PUTs: both lists required, chronological without overlaps, null starts following the previous override, membership and current overrides read, expired overrides kept with their caps, spending confirmation, owner monetary limits refusing what they cannot measure, and read-back of every start, duration and cap as merged runs (Criteo merges back-to-back equal caps and returns following starts as null, as noted earlier).

Tests: `tests/criteo-budget-overrides.test.mjs` (6), red on `6bf3f05` / green after. Pushed as `b45a4b5`.

## Finished batch — DV360 inventory source groups (2026-09-27)

[Implementation](DV360-INVENTORY-SOURCE-GROUPS-2026-09-27.md) and
[qualification](DV360-INVENTORY-SOURCE-GROUPS-VERIFICATION-2026-09-27.json).

- New reviewed family `dv360_inventory_source_groups` (`src/dv360-inventory-source-groups.ts`) for the six group and assignment writes, always owned by the selected advertiser (`advertiserId`; `partnerId` refused). A new authorizer also admits advertiser-named reads of groups, assignments and inventory sources. The reader reads every assignment and, for sources to assign, the advertiser's usable sources page by page; membership changes and deletion need spending confirmation and count as activation and deletion under owner policies.
- Line item targeting still refuses `TARGETING_TYPE_INVENTORY_SOURCE` and `..._GROUP` assignments; with these reads available, that contract can now be extended to check the referenced group or sources.
- Also checked and left: DV360 YouTube asset associations (line item and ad group create and delete, four rows) are documented as available only to an informed subset of users, so they stay allowlist-only.

Tests: `tests/dv360-inventory-source-groups.test.mjs` (6), red on `b45a4b5` / green after. Committed as `0679aef`.

## Finished batch — Google Ads experiments and experiment arms (2026-09-27)

[Implementation](GOOGLE-EXPERIMENTS-2026-09-27.md) and
[qualification](GOOGLE-EXPERIMENTS-VERIFICATION-2026-09-27.json).

- New reviewed family `google_experiments` (`src/google-experiments.ts`) for the experiment and experiment arm mutate services and their six legacy aliases: system-managed experiments in SETUP (create, edit, remove) and their arms (all created together around a BASE control campaign of the right channel with its own daily budget and EU declaration; edits and removals that keep the arms valid). Nothing serves in SETUP, so no spending confirmation; removals count as deletions.
- Next: `scheduleExperiment` and `promoteExperiment` (long-running operations), `endExperiment` and `graduateExperiment` (budget mappings), eight more rows.

Tests: `tests/google-experiments.test.mjs` (5), red on `0679aef` / green after. Committed as `1970383`.

## Finished batch — Google Ads experiment scheduling, ending, promotion and graduation (2026-09-27)

[Implementation](GOOGLE-EXPERIMENT-LIFECYCLE-2026-09-27.md) and
[qualification](GOOGLE-EXPERIMENT-LIFECYCLE-VERIFICATION-2026-09-27.json).

- The `google_experiments` family now covers `scheduleExperiment`, `endExperiment`, `promoteExperiment` and `graduateExperiment` and their legacy aliases. Scheduling, promotion and graduation need spending confirmation and count as activation; ending needs neither. Verification waits for ENABLED, an end date of today, `promote_status` COMPLETED, or GRADUATED with the new budget on the campaign.

Tests: `tests/google-experiment-lifecycle.test.mjs` (6), red on `1970383` / green after. Committed as `e9db0db`.

## Finished batch — Google Ads account settings, automatically created assets and YouTube uploads (2026-09-27)

[Implementation](GOOGLE-ACCOUNT-SETTINGS-ASSETS-UPLOADS-2026-09-27.md) and
[qualification](GOOGLE-ACCOUNT-SETTINGS-ASSETS-UPLOADS-VERIFICATION-2026-09-27.json).

- New reviewed families `google_customer_settings` (customer update of tracking, name, call reporting and video suitability), `google_auto_assets` (removal of automatically created ad and campaign assets, checked against the links' source) and `google_youtube_uploads` (privacy of brand channel uploads and removal, with the video assets that use each video).
- Also checked and left: lifecycle goal configuration (four rows) has only output-only fields in v23; the v23 retention `Goals` services are partly allowlisted.

Tests: `tests/google-customer-settings.test.mjs` (4), `tests/google-auto-assets.test.mjs` (3) and `tests/google-youtube-uploads.test.mjs` (3), red on `e9db0db` / green after. Committed as `b6124bd`.

## Finished batch — Google Ads recommendation subscriptions and Smart campaign settings (2026-09-27)

[Implementation](GOOGLE-SUBSCRIPTIONS-SMART-SETTINGS-2026-09-27.md) and
[qualification](GOOGLE-SUBSCRIPTIONS-SMART-SETTINGS-VERIFICATION-2026-09-27.json).

- New reviewed families `google_recommendation_subscriptions` (auto-apply subscriptions and their three aliases; enabling needs spending confirmation and counts as activation) and `google_smart_campaign_settings` (Smart campaign landing page, phone, language and business, one choice each where the API offers two).
- Also checked and left: the SkAdNetwork conversion value schema mutation (two rows) carries only output-only fields in v23, so there is nothing to write.

Tests: `tests/google-recommendation-subscriptions.test.mjs` (3) and `tests/google-smart-campaign-settings.test.mjs` (3), red on `b6124bd` / green after. Committed as `a7f4754`.

## Finished batch — DV360 advertiser settings (2026-09-27)

[Implementation](DV360-ADVERTISER-SETTINGS-2026-09-27.md) and
[qualification](DV360-ADVERTISER-SETTINGS-VERIFICATION-2026-09-27.json).

- New reviewed family `dv360_advertiser_settings` (`src/dv360-advertiser-settings.ts`) for `advertisers.patch` of the selected advertiser: name, status (activation needs spending confirmation), domain, default business name and logo (an active image ad asset), integration code, TV viewability exemption and EU political declaration. Deletion scheduling, billing, ad server, currency, partner, data access and consent flags stay out.

Tests: `tests/dv360-advertiser-settings.test.mjs` (4), red on `a7f4754` / green after. Committed as `3faac7b`.

## Finished batch — Criteo audience segments (2026-09-27)

[Implementation](CRITEO-AUDIENCE-SEGMENTS-2026-09-27.md) and
[qualification](CRITEO-AUDIENCE-SEGMENTS-VERIFICATION-2026-09-27.json).

- New reviewed family `criteo_audience_segments` (`src/criteo-audience-segments.ts`) for bulk creation (Events segments, empty contact list segments), update (name, description, event rules) and deletion, with the account's retailer or segment search before and after. New event rules need spending confirmation; contact list uploads stay out (customer data).

Tests: `tests/criteo-audience-segments.test.mjs` (4), red on `3faac7b` / green after. Committed as `bf6e4a1`.

## Finished batch — Meta creative and custom audience renames and deletions (2026-09-27)

[Implementation](META-OBJECT-EDITS-2026-09-27.md) and
[qualification](META-OBJECT-EDITS-VERIFICATION-2026-09-27.json).

- New reviewed family `meta_object_edits` (`src/meta-object-edits.ts`) for renaming and deleting the account's own ad creatives and custom audiences (seven rows with aliases). A deleted object reads as Meta's "does not exist" error or status DELETED; deleting an audience stops ads that use it, and Meta refuses while lookalikes derive from it.

Tests: `tests/meta-object-edits.test.mjs` (4), red on `bf6e4a1` / green after. Committed as `61f4621`.

## Finished batch — Snapchat offer disclaimers (2026-09-27)

[Implementation](SNAPCHAT-OFFER-DISCLAIMERS-2026-09-27.md) and
[qualification](SNAPCHAT-OFFER-DISCLAIMERS-VERIFICATION-2026-09-27.json).

- New reviewed family `snapchat_offer_disclaimers` (`src/snapchat-offer-disclaimers.ts`) for creating (1–20, STATIC with text or DYNAMIC from the catalog) and deleting the ad account's offer disclaimers. The review lists every disclaimer of the account (up to 1000); no update is documented, so a changed text is a new disclaimer.

Tests: `tests/snapchat-offer-disclaimers.test.mjs` (3), red on `61f4621` / green after. Committed as `5b0caa4`.

## Finished batch — X pre-roll calls to action (2026-09-27)

[Implementation](X-PREROLL-CTAS-2026-09-27.md) and
[qualification](X-PREROLL-CTAS-VERIFICATION-2026-09-27.json).

- New reviewed family `x_preroll_ctas` (`src/x-preroll-ctas.ts`) for the call-to-action button of `PREROLL_VIEWS` line items (create, change, delete; one button per line item, HTTP(S) destination). No spending confirmation: delivery and budgets do not change.

Tests: `tests/x-preroll-ctas.test.mjs` (5), red on `5b0caa4` / green after. Committed as `5f2acb4`.

## Finished batch — X media library and account media (2026-09-27)

[Implementation](X-MEDIA-LIBRARY-2026-09-27.md) and
[qualification](X-MEDIA-LIBRARY-VERIFICATION-2026-09-27.json).

- New reviewed family `x_media_library` (`src/x-media-library.ts`) for media library edits (name, file name; title, description and poster for videos and GIFs) and deletions, and account media deletions. Deletion is refused while a card (legacy included) or a media creative uses the media (`MEDIA_IN_USE`); X does not document what happens to them.

Tests: `tests/x-media-library.test.mjs` (5), red on `5f2acb4` / green after. Committed as `bff2fa6`.

## Finished batch — X scheduled Tweets (2026-09-27)

[Implementation](X-SCHEDULED-TWEETS-2026-09-27.md) and
[qualification](X-SCHEDULED-TWEETS-VERIFICATION-2026-09-27.json).

- New reviewed family `x_scheduled_tweets` (`src/x-scheduled-tweets.ts`) for promoted-only scheduled Tweets: create (FULL promotable author, at least 10 minutes ahead), edit text, card or media until 10 minutes before publication, delete before publication. The time never changes; organic (nullcast=false) scheduling stays outside the contract.

Tests: `tests/x-scheduled-tweets.test.mjs` (5), red on `bff2fa6` / green after. Committed as `63ad83a`.

## Finished batch — X custom audiences (2026-09-27)

[Implementation](X-CUSTOM-AUDIENCES-2026-09-27.md) and
[qualification](X-CUSTOM-AUDIENCES-VERIFICATION-2026-09-27.json).

- New reviewed family `x_custom_audiences` (`src/x-custom-audiences.ts`) for placeholder creation, renames and deletions of the account's own custom audiences. Deletion reads what targets the audience and is refused while any line item does (`AUDIENCE_IN_USE`). Users (customer data) and sharing stay outside the contract.

Tests: `tests/x-custom-audiences.test.mjs` (5), red on `63ad83a` / green after. Committed as `ac37309`.

## Finished batch — Criteo preferred line items (2026-09-27)

[Implementation](CRITEO-PREFERRED-LINE-ITEMS-2026-09-27.md) and
[qualification](CRITEO-PREFERRED-LINE-ITEMS-VERIFICATION-2026-09-27.json).

- New reviewed family `criteo_preferred_line_items` (`src/criteo-preferred-line-items.ts`) for creating preferred line items in preferred campaigns (draft or paused) and the complete PUT. Writes need account-scoped membership, every write needs spending confirmation, and a verified creation is remembered as the account's.

Tests: `tests/criteo-preferred-line-items.test.mjs` (6), red on `ac37309` / green after. Committed as `a20537d`.

## Finished batch — Criteo catalog requests and exports (2026-09-27)

[Implementation](CRITEO-CATALOG-REQUESTS-2026-09-27.md) and
[qualification](CRITEO-CATALOG-REQUESTS-VERIFICATION-2026-09-27.json).

- New reviewed family `criteo_catalog_requests` (`src/criteo-catalog-requests.ts`) for the four catalog request and export POSTs. No spending confirmation; verification reads the catalog status by the receipt's ID, and a verified catalog is then readable natively for five minutes.

Tests: `tests/criteo-catalog-requests.test.mjs` (4), red on `a20537d` / green after. Committed as `295b1e3`.

## Finished batch — DV360 custom bidding algorithms (2026-09-27)

[Implementation](DV360-CUSTOM-BIDDING-2026-09-27.md) and
[qualification](DV360-CUSTOM-BIDDING-VERIFICATION-2026-09-27.json).

- New reviewed family `dv360_custom_bidding` (`src/dv360-custom-bidding.ts`) for creating advertiser-owned custom bidding algorithms and patching their name and status. Partner-owned algorithms are refused; scripts and rules (uploads, two rows) remain blocked.

Tests: `tests/dv360-custom-bidding.test.mjs` (4), red on `295b1e3` / green after. Committed as `9782618`.

## Finished batch — Meta ad image deletion and custom conversion creation (2026-09-27)

[Implementation](META-IMAGES-CONVERSIONS-2026-09-27.md) and
[qualification](META-IMAGES-CONVERSIONS-VERIFICATION-2026-09-27.json).

- New reviewed families `meta_ad_images` (deletion by hash; Meta refuses images in use) and `meta_custom_conversions` (creation on a pixel of the account with an explicit JSON rule and a unique name; advanced multi-source rules stay outside).

Tests: `tests/meta-ad-images.test.mjs` (3) and `tests/meta-custom-conversions.test.mjs` (3), red on `9782618` / green after. Committed as `7c5d198`.

## Finished batch — Snapchat audience segment deletion (2026-09-27)

[Implementation](SNAPCHAT-SEGMENT-DELETION-2026-09-27.md) and
[qualification](SNAPCHAT-SEGMENT-DELETION-VERIFICATION-2026-09-27.json).

- New reviewed family `snapchat_segment_deletions` (`src/snapchat-segment-deletions.ts`) for deleting listed segments of the ad account (two rows with the alias). A segment that an ad squad includes or excludes is refused (`AUDIENCE_IN_USE`); users and rule audiences stay blocked.

Tests: `tests/snapchat-segment-deletions.test.mjs` (3), red on `7c5d198` / green after. Committed as `993ee35`.

## Finished batch — LinkedIn Insight Tags (2026-09-27)

[Implementation](LINKEDIN-INSIGHT-TAGS-2026-09-27.md) and
[qualification](LINKEDIN-INSIGHT-TAGS-VERIFICATION-2026-09-27.json).

- New reviewed family `linkedin_insight_tags` (`src/linkedin-insight-tags.ts`) for creating the ad account's Insight Tag (one per account) and switching its first-party tracking (FULL access; the setting reaches every account sharing the tag). Permissions and domain blocking stay blocked.

Tests: `tests/linkedin-insight-tags.test.mjs` (3), red on `993ee35` / green after. Committed as `2ac1127`.

## Finished batch — Applying Google Ads keyword and campaign budget recommendations (2026-09-27)

[Implementation](GOOGLE-RECOMMENDATION-APPLY-2026-09-27.md) and
[qualification](GOOGLE-RECOMMENDATION-APPLY-VERIFICATION-2026-09-27.json).

- New reviewed family `google_recommendation_apply` (`src/google-recommendation-apply.ts`) for applying KEYWORD and CAMPAIGN_BUDGET recommendations (one type per review, 1–20). Spending confirmation always; keywords count as activation; budgets follow owner limits. Other recommendation types stay outside.

Tests: `tests/google-recommendation-apply.test.mjs` (4), red on `2ac1127` / green after. Committed as `f2c29f9`.

## Finished batch — DV360 SDF download tasks (2026-09-27)

[Implementation](DV360-SDF-DOWNLOADS-2026-09-27.md) and
[qualification](DV360-SDF-DOWNLOADS-VERIFICATION-2026-09-27.json).

- New reviewed family `dv360_sdf_downloads` (`src/dv360-sdf-downloads.ts`) for advertiser SDF download tasks. Verification waits until the operation is done; the verified operation and its files' resource name are then authorized for the advertiser for AMCP's five-minute window.

Tests: `tests/dv360-sdf-downloads.test.mjs` (3), red on `f2c29f9` / green after. Committed as `4298a36`.

## Finished batch — LinkedIn A/B tests (2026-09-27)

[Implementation](LINKEDIN-AB-TESTS-2026-09-27.md) and
[qualification](LINKEDIN-AB-TESTS-VERIFICATION-2026-09-27.json).

- New reviewed family `linkedin_ab_tests` (`src/linkedin-ab-tests.ts`) for creating, updating (by execution state) and deleting (while PENDING) A/B tests, five rows with the alternate path names. Running a test needs spending confirmation and counts as activation.

Tests: `tests/linkedin-ab-tests.test.mjs` (4), red on `4298a36` / green after. Committed as `8becdaa`.

## Finished batch — Snapchat custom conversions (2026-09-27)

[Implementation](SNAPCHAT-CUSTOM-CONVERSIONS-2026-09-27.md) and
[qualification](SNAPCHAT-CUSTOM-CONVERSIONS-VERIFICATION-2026-09-27.json).

- New reviewed family `snapchat_custom_conversions` (`src/snapchat-custom-conversions.ts`) for creating custom conversions on a pixel of the selected ad account and deleting them, two rows. Taken names are refused; deletions count under owner policies; mobile app conversions stay blocked.

Tests: `tests/snapchat-custom-conversions.test.mjs` (3), red on `8becdaa` / green after. Committed as `09b5472`.

## Finished batch — Snapchat product sets (2026-09-27)

[Implementation](SNAPCHAT-PRODUCT-SETS-2026-09-27.md) and
[qualification](SNAPCHAT-PRODUCT-SETS-VERIFICATION-2026-09-27.json).

- New reviewed family `snapchat_product_sets` (`src/snapchat-product-sets.ts`) for creating, updating and deleting product sets of the catalogs of the selected account's organization, six rows with aliases and the update by ID. Filters follow the guide's attribute and operator table; default sets and sets that ad squads or creatives use are protected.

Tests: `tests/snapchat-product-sets.test.mjs` (3), red on `09b5472` / green after. Committed as `38b5f00`.

## Finished batch — LinkedIn Insight Tag domains (2026-09-27)

[Implementation](LINKEDIN-INSIGHT-DOMAINS-2026-09-27.md) and
[qualification](LINKEDIN-INSIGHT-DOMAINS-VERIFICATION-2026-09-27.json).

- New reviewed family `linkedin_insight_tag_domains` (`src/linkedin-insight-domains.ts`) for blocking and allowing Insight Tag domains of the selected account, singly or in a batch of up to 20, two rows. Keys are re-encoded at compile time as in the reference; only FULL access to the tag may change domains.

Tests: `tests/linkedin-insight-domains.test.mjs` (3), red on `38b5f00` / green after. Committed as `683a2da`.

## Finished batch — Snapchat dynamic templates (2026-09-27)

[Implementation](SNAPCHAT-DYNAMIC-TEMPLATES-2026-09-27.md) and
[qualification](SNAPCHAT-DYNAMIC-TEMPLATES-VERIFICATION-2026-09-27.json).

- New reviewed family `snapchat_dynamic_templates` (`src/snapchat-dynamic-templates.ts`) for creating and updating dynamic templates of the selected ad account, two rows. Fields follow the guide's tables; overlay media must be READY account images; updates show the dynamic creatives that use each template.

Tests: `tests/snapchat-dynamic-templates.test.mjs` (3), red on `683a2da` / green after. Committed as `140396f`.

## Finished batch — Snapchat event details (2026-09-27)

[Implementation](SNAPCHAT-EVENT-DETAILS-2026-09-27.md) and
[qualification](SNAPCHAT-EVENT-DETAILS-VERIFICATION-2026-09-27.json).

- New reviewed family `snapchat_event_details` (`src/snapchat-event-details.ts`) for creating and deleting the event details of Reminder creatives, two rows. Starts are UTC instants in the future; event details that creatives promote are not deleted.

Tests: `tests/snapchat-event-details.test.mjs` (4), red on `140396f` / green after.

## CI and live evidence

The push to CAMCP was the first commit there. Its GitHub Actions run must be checked by
exact SHA (Actions may need enabling on the new repository). This checkout has no
GitHub CLI and CAMCP is private, so the runs for `d88f1e0` and later commits were not
read from here. Nothing is claimed green from the local result alone. Live acceptance is unverified: the fixes reach the AMCP
connector only after its deployment is updated from this code (not authorized here).
Afterwards, re-run the Snapchat clone as one plan with `expected_currency` set and
confirm BUG-1 to BUG-6 live.

## Remaining inventory

3241 captured actions; 681 in reviewed write families. **750 remaining rows** are in
[REMAINING-ACTIONS-2026-09-26.csv](REMAINING-ACTIONS-2026-09-26.csv), derived from the
coverage ledger with the same status filter as the 2026-09-25 file:

| Category | Rows |
|---|---:|
| blocked_write | 635 |
| unmapped | 79 |
| unqualified_read | 23 |
| adapter_requires_input | 8 |
| provider_unsupported | 5 |

Blocked writes by platform: TikTok 186, Meta 117, LinkedIn 96, Snapchat 69,
Google Ads 57, X 43, DV360 32, Criteo 23, Business Profile 12.

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
| P2 | DV360 inventory-source targeting | Reads of the advertiser's access to inventory sources and groups, then the existing line item targeting review for `TARGETING_TYPE_INVENTORY_SOURCE` and `TARGETING_TYPE_INVENTORY_SOURCE_GROUP` (audience groups done 2026-09-27) |
| P3 | LinkedIn work-email submission criteria | The wire form of the `questionSubmissionCriteria` union, which the schema does not show |
| P3 | X remaining writes (promoted accounts, cards, tracking tags) | The official X Ads API reference returned HTTP 402 from this environment; needs an accessible, versioned source first |
