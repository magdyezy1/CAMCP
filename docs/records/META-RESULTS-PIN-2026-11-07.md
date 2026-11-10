---
status: record
tier: engineering
---

# Meta insights `results`: the shape pinned for F-L5-12 and F-LEAD-02

Read on 2026-11-07 by the principal engineer through the production connector's `meta_native_action`, action
`meta_insights_get` (GET, Graph v26.0), on the owner's named Meta test account: campaign, ad set and ad levels, with
`date_preset` `maximum` (and `last_year` for the daily case), under the default attribution, the unified setting and
explicit windows. Nine insights GET calls and one `LIST_ACTIONS` metadata call (counted from the session transcript), no
writes, no report job. One of the nine asked for `result_fields`, which projected nested records to `{}`, so it showed
nothing of `results`: the facts below rest on the other eight. A production read pins a provider's response shape; it does
not qualify undeployed code. This record and `tests/fixtures/meta-results-samples.json` hold the shape only: the numbers
of the fixture are invented, and no account, campaign or custom conversion ID from the read is in either (the fixture's
custom conversion is `offsite_conversion.custom.1000000000000001`).

| #   | Fact                                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `results` and `cost_per_result` are lists of one entry. Every row seen had one entry, or no field at all. `result_rate` has the same form and Graph v26.0 accepts it.                                                                                                                                                                  |
| R2  | An entry is `{indicator: string, values?: [{value: decimal string, attribution_windows?: [string]}]}`.                                                                                                                                                                                                                                 |
| R3  | Indicators are `actions:<action_type>` or a bare metric name: `reach`, `estimated_ad_recallers`, `video_continuous_2_sec_watched_actions`, `profile_visit_view`, `total_profile_visits`.                                                                                                                                               |
| R4  | Action types seen: `post_engagement`, `onsite_conversion.messaging_conversation_started_7d`, `link_click`, `landing_page_view`, `omni_landing_page_view`, `offsite_conversion.fb_pixel_purchase`, `offsite_conversion.fb_pixel_add_to_cart`, `offsite_conversion.custom.<digits>`, `click_to_call_native_call_placed`, `rsvp`, `like`. |
| R5  | `{indicator}` alone, with no `values`, was seen on rows that counted no result in the window (a pixel purchase campaign with none; old ad sets).                                                                                                                                                                                       |
| R6  | A row can have neither `results` nor `cost_per_result` (seen with the goal `Unknown Optimization Goal`).                                                                                                                                                                                                                               |
| R7  | `attribution_windows` is absent on some entries: `estimated_ad_recallers`, `profile_visit_view` and `total_profile_visits` give `{value}` alone.                                                                                                                                                                                       |
| R8  | A default or unified request gives one value, `attribution_windows: ["default"]`.                                                                                                                                                                                                                                                      |
| R9  | Explicit windows (`action_attribution_windows`, `use_*_attribution_setting: false`) give one value per requested window that is not zero, plus `default`.                                                                                                                                                                              |
| R10 | A zero window is left out: it has no entry.                                                                                                                                                                                                                                                                                            |
| R11 | `default` does not follow the request. It is the ad set's own attribution setting, the Ads Manager column: a single requested window gave a smaller value than `default`, and `default` was the same under two windows as under that one.                                                                                              |
| R12 | Not every metric is split by window: `post_engagement` and the 2-second video metric gave `default` only under explicit windows, though `actions.post_engagement` carried the window key.                                                                                                                                              |
| R13 | `cost_per_result` follows the same entries. The `default` cost equals spend over the `default` value.                                                                                                                                                                                                                                  |
| R14 | Under explicit windows an `actions` entry is `{"action_type": "lead", "value": "<default setting>", "1d_click": "<count>"}`: `value` is the ad set's setting, the requested window's count is under the key named for it, and a window with no count has no key.                                                                       |
| R15 | `optimization_goal` is returned at campaign, ad set and ad level.                                                                                                                                                                                                                                                                      |
| R16 | A campaign row can say the literal `Unknown Optimization Goal` (seen with results present and absent) or `NONE` (older campaigns, results present).                                                                                                                                                                                    |
| R17 | Goals seen: `POST_ENGAGEMENT`, `REPLIES`, `TWO_SECOND_CONTINUOUS_VIDEO_VIEWS`, `OFFSITE_CONVERSIONS`, `LANDING_PAGE_VIEWS`, `NONE`, `AD_RECALL_LIFT`, `QUALITY_CALL`, `REACH`, `EVENT_RESPONSES`, `PAGE_LIKES`.                                                                                                                        |
| R18 | Objectives seen beyond `OUTCOME_*`: `LINK_CLICKS`, `MESSAGES`, `REACH`, `POST_ENGAGEMENT`, `EVENT_RESPONSES`, `BRAND_AWARENESS`, `PAGE_LIKES`.                                                                                                                                                                                         |
| R19 | Daily rows (`time_increment=1`) have the same shape.                                                                                                                                                                                                                                                                                   |

## What AMCP does with them

A v4 Meta row is read in this order (`src/meta-report-results.ts`):

1. The exact action set in `result_action_type`: that action, mapped (rule 5 below gives its number).
2. `results` absent or an empty list: the goal's mapped table, source `mapped`, labelled mapped.
3. `results` that is not one object with a string `indicator`, or `values` that are not a list of objects with a decimal
   `value` and at most one window name: unknown, `unverified_native_shape`, no throw; the row keeps its other metrics.
   A second entry, two values for one window, and an indicator outside a bounded name (letters, digits, `_`, `.`, `-`, one
   `:`, at most 200 characters) are the same case.
4. An indicator with no values counted none: `0` with `provider_omitted` on a row that delivered (impressions above 0),
   unknown (`missing_metric`) on one that did not. The definition still comes from the indicator.
5. The value: under the ad set's own setting, the entry named `default` (or the only entry when it names no window);
   under explicit windows, the exact sum of the requested windows' entries, a requested window with no entry counting 0;
   when the values hold no requested window, the sum of the requested keys of the row's one `actions` entry for an
   `actions:<type>` indicator (R12), else `default` (a metric with no window split). Several entries and no `default`
   under the ad set's own setting is unknown.
6. The cost: Meta's `cost_per_result` of the entry that gave the value. A sum of windows uses the `default` cost only when
   the sum equals the `default` value; otherwise, and when the count came from the action's keys, the cost is spend over
   the result, exactly. A cost that is not the recorded shape or not a decimal is ignored, never fatal.
7. Source `provider`. The definition (id, label, aggregation) comes from one declared table, `metaResultIndicators`, with
   `meta:action:<type>` (summed) and `meta:result:<indicator>` (not summed) for an indicator Meta adds later, so different
   indicators never add. A custom conversion, an action and a metric Meta adds later are labelled with their own bounded value
   (`Custom conversion <digits>`, `Meta action <type>`, `Meta result <indicator>`), so two of them in one report never share a
   label. A multi-day detail row built from provider days stays `provider` (`periods_add`).

F-LEAD-02: under explicit windows a v4 report reads the requested windows' keys of every Meta list of action stats it reads
(R14): the campaign metrics, conversion value, a detail level's exact action and every native metric that is such a list
(`native_meta_<list>_<action>`; any field name can be a native metric of a campaign source). Meta types all of these lists as
AdsActionStats: an entry has `value`, the ad set's own setting, and a number under each requested window's name. Only
`actions` was read live (R14); `results` and `cost_per_result` have the shape of R2 and are read as R9 and R13 say. The other
lists follow from the type and have not been read. AMCP reads them by what a number is (`src/meta-report-results.ts`, one
place for the lists):

- Counts add the requested windows' keys, exactly: `actions`, `action_values`, `conversions`, `conversion_values`,
  `catalog_segment_actions`, `catalog_segment_value`, `converted_product_quantity`, `converted_product_value`. A key that
  is absent counts 0 and an entry with none of the requested keys is the omitted case.
- Costs, ratios and people do not add, so one requested window gives that window's own number and several windows give none:
  `cost_per_action_type`, `cost_per_conversion`, `cost_per_unique_action_type`, `unique_actions` (a person can be counted
  in two windows), `purchase_roas`, `website_purchase_roas`, `mobile_app_purchase_roas`. The cost of two windows is the spend
  over their joint count, not the sum of their costs, and a ratio is not a sum either. The cost of a result under any windows
  is the row's `cost_per_result`.
- Any other list is split when its entries carry one of AMCP's window names (one window gives its key, several give none) and
  not split when they carry none, as the video metrics came back (R12): `value` stands.

A v3 report reads `value`, as before, and so does a v4 report under the ad set's own setting.

The older objectives of R18 are v4 provider values (`LINK_CLICKS` to traffic, `REACH` and `BRAND_AWARENESS` to awareness,
`MESSAGES`, `EVENT_RESPONSES`, `PAGE_LIKES` and `POST_ENGAGEMENT` to engagement); a v3 report resolves them as before.

## Still unverified

- A row with two entries in `results` was not seen, nor an entry naming several windows; both are unknown here.
- Under explicit windows, an action that carries `value` but none of the requested keys although that window had a count was
  not seen; AMCP counts it as the omitted zero, as R14 says a window with no count has no key.
- Only the `default` cost was checked against spend over the `default` value (R13); a single window's own cost is used as
  Meta sends it.
- A JSON number in place of a decimal string was not seen; AMCP reads it as the decimal it spells.
- Every list of action stats other than `actions` was not read: `action_values`, `conversions`, `conversion_values`,
  `cost_per_action_type`, `cost_per_conversion`, `cost_per_unique_action_type`, `unique_actions`, `purchase_roas`,
  `website_purchase_roas`, `mobile_app_purchase_roas` and the catalog and product lists are taken to have an action's keys,
  because Meta types them all as AdsActionStats, which the per-window `cost_per_result` of R13 suggests. That each of them is
  split by window, and that a ratio or a cost of two windows has no value of its own, are assumptions.
- The key under which Meta returns the engaged-view window AMCP asks for as `1d_ev` was not seen: the notes of the live read
  name `7d_click`, `1d_view` and `1d_click` and none names `1d_ev`. AMCP reads the key named as the request names it.
- The V2 code has not been read against a live account: that check waits for staging (D20).
