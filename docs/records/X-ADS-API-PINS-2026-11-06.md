---
status: record
tier: engineering
---

# X Ads API: facts pinned for V2-RPT-07 Task 12 (F-L7-12)

Read on 2026-11-06 from X's public documentation (no API call, no sign-in). The pages are
`[campaign-management]` = `https://docs.x.com/x-ads-api/campaign-management/reference.md` and
`[analytics]` = `https://docs.x.com/x-ads-api/analytics.md`; the objective table is also in the "Objective Based Campaigns"
section of `https://docs.x.com/x-ads-api/campaign-management`. Facts are paraphrased. The X fixtures of the tests follow these
pages where they state a shape, and the tests that cite one say so.

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Page                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| X1  | `GET accounts/:account_id/line_items` takes `campaign_ids`, `count` (default 200, 1 to 1000), `cursor`, `funding_instrument_ids`, `line_item_ids`, `q`, `sort_by`, `with_deleted` (default false), `with_draft`, `with_total_count` (default false). The response is `data` with `next_cursor` (null at the end in the example).                                                                                                                                                                                                                                                                         | [campaign-management] |
| X2  | **`with_total_count` is exclusive with `cursor`**, and a request with it has a lower rate limit (200 a 15 minutes). The same holds for the campaign and promoted tweet lists. A paged read therefore cannot check a declared total.                                                                                                                                                                                                                                                                                                                                                                      | [campaign-management] |
| X3  | A line item has `id`, `name`, `campaign_id`, `objective`, `entity_status`, `deleted`, `currency`, `placements`, `start_time`, `end_time`, `created_at`, `updated_at` and bidding and budget fields. **`objective` takes eight values: `APP_ENGAGEMENTS`, `APP_INSTALLS`, `REACH`, `FOLLOWERS`, `ENGAGEMENTS`, `VIDEO_VIEWS`, `PREROLL_VIEWS`, `WEBSITE_CLICKS`.** `WEBSITE_CONVERSIONS` is not among them.                                                                                                                                                                                               | [campaign-management] |
| X4  | A campaign has `id`, `name`, `entity_status`, `effective_status`, `deleted`, `currency`, `funding_instrument_id`, budget fields; **no objective**. `GET accounts/:account_id/campaigns` takes `campaign_ids` (up to 200), `count` (default 200, 1 to 1000), `cursor`, `with_deleted`, `with_total_count`.                                                                                                                                                                                                                                                                                                | [campaign-management] |
| X5  | `GET accounts/:account_id/promoted_tweets` takes `count` (default 200, 1 to 1000), `cursor`, `line_item_ids` (up to 200), `with_deleted`, `with_total_count`. **A promoted tweet has `id`, `line_item_id`, `tweet_id`, `entity_status`, `approval_status`, `deleted`, `created_at`, `updated_at` and no `name`, no `currency` and no `account_id`.**                                                                                                                                                                                                                                                     | [campaign-management] |
| X6  | `GET stats/accounts/:account_id/active_entities` takes `entity` `CAMPAIGN`, `FUNDING_INSTRUMENT`, `LINE_ITEM`, `PROMOTED_ACCOUNT` or **`PROMOTED_TWEET`**, and a time range of at most 90 days.                                                                                                                                                                                                                                                                                                                                                                                                          | [analytics]           |
| X7  | `GET stats/accounts/:account_id` takes `entity` `ACCOUNT`, `CAMPAIGN`, `FUNDING_INSTRUMENT`, `LINE_ITEM`, `PROMOTED_ACCOUNT` or `PROMOTED_TWEET`; **up to 20 `entity_ids`**; `granularity` `DAY`, `HOUR` or `TOTAL`; **at most 7 days**; `start_time` and `end_time` **in whole hours**; one `placement` of `ALL_ON_TWITTER`, `SPOTLIGHT`, `TREND` a request.                                                                                                                                                                                                                                            | [analytics]           |
| X8  | `metric_groups` takes `BILLING`, `ENGAGEMENT`, `LIFE_TIME_VALUE_MOBILE_CONVERSION`, `MOBILE_CONVERSION`, `VIDEO`, `WEB_CONVERSION`. ENGAGEMENT: `engagements`, `impressions`, `retweets`, `replies`, `likes`, `follows`, `card_engagements`, `clicks`, `app_clicks`, `url_clicks`, `qualified_impressions`, `carousel_swipes`. BILLING: `billed_engagements`, `billed_charge_local_micro`. VIDEO: `video_total_views`, `video_views_25`, `video_views_50`, `video_views_75`, `video_views_100`, `video_cta_clicks`, `video_content_starts`, `video_3s100pct_views`, `video_6s_views`, `video_15s_views`. | [analytics]           |
| X9  | **Rates such as an engagement rate are derived metrics** in the metrics tables (names in curly brackets), calculated from returned counts and amounts; they are not metrics of a group.                                                                                                                                                                                                                                                                                                                                                                                                                  | [analytics]           |

## What AMCP does with them

- The X source's objective table holds X3's eight values (`xLineItemObjectives`, `src/x-report-source.ts`); a campaign
  whose line items differ is Mixed; `WEBSITE_CONVERSIONS`, which older code used, is not pinned and resolves by inference.
- Hourly values are summed only for the count and amount metrics of X8 (and the conversion objects), never a rate (X9);
  anything else is left out with a warning.
- A promoted tweet is named `Promoted tweet <id>` (X5); the lists never send `with_total_count` with a cursor (X2).
- Active entities accepts `PROMOTED_TWEET` (X6); if X refuses it, the documented fallback requests every scoped entity.

## Still unpinned (checked in the live read of `docs/acceptance/ROUND2-TASK12-READ-ACCEPTANCE.md`, step 3)

- The synchronous stats echo (`request.params`, `time_series_length`), whether metrics come as JSON numbers or strings, and
  the null semantics beyond the earlier pin (null equals 0).
- How far back hourly history reaches, a daylight saving week of an account time zone, and the rate-limit headers against the
  documented 250 requests a 15 minutes.
- Whether `with_deleted` lists deleted promoted tweets on cursor pages, the values of `entity_status` and
  `effective_status` on each object (a line item's example shows no `effective_status`), and a full last page.
- Whether PUBLISHER_NETWORK delivery shows on the placements AMCP does not request.

## Addendum: DRAFT entities in the population read (package r12-fix, 2026-11-16)

The population lists of the Overview's X detail levels (`src/x-overview-detail.ts`) read campaigns, line items and promoted
tweets with `with_deleted`. A live read-only check of a test account on 2026-11-16 (V2-RPT-07, O-5) found that this left DRAFT
line items out of the line item list while the promoted tweet list still held their promotions, so one promoted tweet on a
DRAFT line item refused the whole level.

- X1 stands: the line item list takes `with_draft` (default false), so a DRAFT line item is listed only when it is asked for.
- X4 (read 2026-11-06) does not list `with_draft` for the campaign list. The same live check answered the campaign list read
  with `with_draft` and `with_deleted` both true, and it returned DRAFT campaigns that the read without `with_draft` left out
  (all of them deleted, and the parents of deleted DRAFT line items). `src/x-portfolio.ts` already sends `with_draft` on its
  campaign and line item inventory reads. Without it on the campaign list, a deleted DRAFT line item has no listed campaign.
  This is an observed answer, not a documented one: the public page was not read again.
- X5 lists no `with_draft` for the promoted tweet list, which was listed whatever the status of the line item holding the
  promotion. The population read sends none there.
- The population read therefore sends `with_draft: true` and `with_deleted: true` on the campaign and line item lists only,
  with the cursor handling unchanged (X2).

Still unpinned: whether X's analytics read accepts a DRAFT line item or a promotion on one, and whether the active entities read
names them. The population now holds them, but analytics are requested only for entities X reports active in the window (and for
every scoped entity when X refuses that read or the read is not used), so a DRAFT entity is requested only on those paths.
