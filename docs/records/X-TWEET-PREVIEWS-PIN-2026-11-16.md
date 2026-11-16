---
status: record
tier: engineering
---

# X Tweet previews: the route and its parameters, pinned for package r12-xpreview (2026-11-16)

Read on 2026-11-16 from X's public documentation (no API call, no sign-in), and set beside one read-only live check of the
owner's X account made the same day. The pages are `[creatives]` = `https://docs.x.com/x-ads-api/creatives/reference.md`
(its sections "Tweet Previews" and "Tweets"), `[campaign-management]` =
`https://docs.x.com/x-ads-api/campaign-management/reference.md` (its sections "Promoted Tweets" and "Line Items") and
`[guide]` = `https://docs.x.com/x-ads-api/creatives` (the Scheduled Tweets guide). The page on developer.x.com that the old
Twitter documentation kept answered 402 Payment Required and was not read. Facts are paraphrased. The X fixtures of the tests
follow these pages where they state a shape, with synthetic IDs and a synthetic payload; no ID, handle or link of the live
check is kept anywhere.

The route's anchor is `tools/route-anchor-documents.json` (`anchor_status: documented_url`, read 2026-11-16), so `amcp_workspace
contracts` and the help of the action show it anchored and the advisory `read_unanchored` no longer applies to it.

## The route (documented)

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Page       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| TP1 | The read is `GET /12/accounts/:account_id/tweet_previews` (Ads API version 12). It previews published, scheduled or draft Tweets and returns an iframe. The account in the path must be associated with the authenticated user; nothing is said of whose Tweets may be previewed.                                                                                                                                                                      | [creatives] |
| TP2 | `tweet_ids`: required; a comma-separated list of up to 200 IDs; the IDs must be of the `tweet_type` asked for.                                                                                                                                                                                                                                                                                                                                         | [creatives] |
| TP3 | `tweet_type`: required; `DRAFT`, `PUBLISHED` or `SCHEDULED`. The page says that the ID of a scheduled Tweet sent with `PUBLISHED` gets no preview, which is how an ID can be missing from an answer that otherwise succeeded.                                                                                                                                                                                                                         | [creatives] |
| TP4 | The answer is `request` (an echo of the parameters, `account_id` among them) and `data`: one object per previewed Tweet, with `tweet_id` and `preview`. The example `preview` is one string, `<iframe class='tweet-preview' src='https://ton.twimg.com/ads-manager/tweet-preview/index.html?data=<percent-encoded payload>'>`: the attributes `class` and `src` only, one `data` query parameter, no closing tag. It runs to a thousand characters or more. | [creatives] |
| TP5 | The section states no expiry (the answer has no field for one) and no rate limit.                                                                                                                                                                                                                                                                                                                      | [creatives] |
| TP6 | The Scheduled Tweets guide shows the same snippet from API version 6 with the host `ton.smf1.x.com`. The version 12 page and the live answer show `ton.twimg.com`, which is the only host AMCP accepts.                                                                                                                                                                                        | [guide]    |

## The live answer (lead, read-only, 2026-11-16)

| #  | Observation                                                                                                                                                                                                                                                                                                                       |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 | The promoted Tweets read answers `{id, tweet_id, line_item_id, entity_status}` for each promoted Tweet. One Tweet can be promoted in two line items, so two promoted-Tweet IDs can share one `tweet_id`.                                                                                                                         |
| L2 | The Tweets read with `tweet_type: PUBLISHED` and `timeline_type: NULLCAST` lists the account's dark (nullcast) Tweets.                                                                                                                                                                                                         |
| L3 | `tweet_previews` with `tweet_ids` naming one promoted Tweet and one dark Tweet (comma-separated) and `tweet_type: PUBLISHED` answered `{"data": [{"tweet_id": "<id>", "preview": "<iframe class='tweet-preview' src='https://ton.twimg.com/ads-manager/tweet-preview/index.html?data=<url-encoded payload>'>"}]}`: one entry for each requested Tweet, both kinds included. |

## Related reads the resolver sends (documented 2026-11-16; their routes are not anchored by this pin)

| #  | Fact                                                                                                                                                                                                                                                                                                                                                     | Page                  |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| R1 | `GET /12/accounts/:account_id/promoted_tweets` takes `count` (1 to 1000, default 200), `cursor`, `line_item_ids` (up to 200), `promoted_tweet_ids` (up to 200), `sort_by`, `with_deleted` (default false) and `with_total_count`. A promoted Tweet has `id`, `line_item_id`, `tweet_id`, `entity_status`, `approval_status`, `deleted`, `created_at` and `updated_at`. The example ends with `next_cursor` null. The earlier pin X5 lists no `promoted_tweet_ids`. | [campaign-management] |
| R2 | `GET /12/accounts/:account_id/line_items` takes `campaign_ids` (up to 200), `line_item_ids` (up to 200), `count` (1 to 1000, default 200), `cursor`, `with_deleted` and `with_draft` (both default false); a line item has `id`, `campaign_id`, `entity_status` and `deleted`. A campaign has no objective and a promoted Tweet has no `campaign_id`.      | [campaign-management] |
| R3 | `GET /12/accounts/:account_id/tweets` takes `tweet_type` (required), `tweet_ids` (up to 200, of that type), `timeline_type` (`ALL`, `NULLCAST` or `ORGANIC`; default `NULLCAST`), `user_id` (default: the account's `FULL` promotable user), `include_mentions_and_replies` (default false), `count` (1 to 1000, default 200), `cursor`, `trim_user`, `name`. | [creatives]           |

## What AMCP does with them (`amcp_ad_previews`, platform `x_ads`: `src/x-ad-previews.ts`)

- An ad is a promoted Tweet (R1): listed, or named by its ID, with its own status, its line item and, through R2, its
  campaign. A Tweet named by its own ID is looked up among the account's dark Tweets (R3 with `timeline_type: NULLCAST`, for
  the default user) before it is previewed, since TP1 says nothing of whose Tweets are previewed; a Tweet named with its
  promoted Tweet is proven by that promotion. An ID that is neither an entity ID of X nor a Tweet ID (15 digits or more) is
  not sent. A read that names its IDs asks for a page of 200 (the most IDs X takes in a filter, R1 to R3), whatever number
  it names, so that an answer with every ID is complete: X can end a page that is exactly as large as its page size with a
  cursor, and one that still carries a cursor on a page of 200 is refused.
- The status of a promoted Tweet is its own (`entity_status`; a deleted one is archived): a paused line item or campaign above
  it is not considered.
- The Tweets of one call (at most ten) are previewed by one read with `tweet_type: PUBLISHED` (TP2, TP3), in batches of at most
  200. An entry is a Tweet, with the promoted-Tweet IDs of the call that share it. `limit` counts promoted Tweets, so a call can
  return fewer entries when some of them share a Tweet, and a Tweet promoted twice whose promotions fall in two calls has an
  entry in each, naming the promoted Tweets that call selected.
- Only the `src` of the `preview` iframe is read (TP4), and returned only when it is https on exactly `ton.twimg.com` at exactly
  `/ads-manager/tweet-preview/index.html`, with no user information, port or fragment. The host of TP6's older example is not
  accepted, and X's snippet is never returned.
- A Tweet that X has no entry for is reported `not_returned` (TP3), and one whose snippet fails the rule above, or has two
  entries, `link_not_accepted`. The answer says that X states no expiry (TP5) and states none itself.

## Still unpinned

- Whether a viewer without an X session can open the link, and how long X keeps it. The answer states no expiry, so AMCP states
  none either (it says that X states none).
- What X answers when one ID of a batch cannot be previewed. The page implies that its entry is left out (TP3); the live check
  had no such ID. AMCP reports an ID that has no entry as missing, and a batch that X refuses as that call's error.
- Whether X restricts a preview of a published Tweet to the account's own Tweets: the page says only that the account must be
  the authenticated user's (TP1). AMCP does not rely on it: it proves a Tweet named by ID belongs to the account before it asks.
- The Tweets of promotable users other than the account's default `FULL` user: R3's read answers for the default user unless
  `user_id` is sent.
