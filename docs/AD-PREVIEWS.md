---
status: reference
tier: operator
---

# Ad previews

`amcp_ad_previews` reads existing ads' preview links. The Media library's *Preview your ads* offers status selection
and Load more; a Load more that fails keeps the rows read and offers Start again. No account changes.

Use `amcp_ad_previews {action:"help"}` for the full description and examples, or add `topic:"help"` for the local
help contract. Ordinary preview calls retain the platform/account inputs below and omit `action`.

```json
{"platform": "meta", "account_id": "111", "ad_format": "INSTAGRAM_STORY", "limit": 5}
```

Without `ad_ids`, `limit` defaults to 5 (maximum 10), and `statuses` to `["active"]`. Other choices are `paused`,
`archived` and `all`; old ads, meaning archived or deleted ones, are in `archived` and `all`. Named IDs ignore
statuses. For X, `active` is the promoted Tweet's own status, so it can include an active promoted Tweet under a
paused line item or campaign. Optional `campaign_ids` and `adset_ids` each accept 1–50 IDs; both filters must match, including for named
IDs. LinkedIn uses campaign groups and native campaigns respectively; Snapchat uses ad squads in `adset_ids`; X uses
line items there. Parent filters are tool inputs.

`ad_ids` name ads on Meta, TikTok and Reddit, creatives on Snapchat and LinkedIn. Bare LinkedIn numbers become
creative URNs. Google accepts asset-group IDs/resources or video `adGroupAds` resources. X accepts promoted-Tweet IDs
or the ID of a dark Tweet. Named reads search beyond the first list page. Missing IDs have `not_found` and
`not_found_reason`.

Results include `previews`, `next_cursor`, `has_more` and `order`. Continue with `cursor: next_cursor` and the same
selection. Five-minute signed cursors bind workspace, user, connection, account, permissions, filters, limit and
Meta placement. Changed logins, permissions or surplus-page identities invalidate continuation. Each call scans
at most ten native list pages. LinkedIn uses native creative-ID order. Snapchat requests `created_desc` unless
reading deleted entities: its API forbids combining that flag with sorting. Other reads report native order. Lists are
read 100 rows at a time (Snapchat's creative finder, 1,000) whatever `limit` is; the cursor resumes the rows left on
a page.

Snapchat must prove creative ownership through the account creative list before previewing an ad's `creative_id`.
The shared scan budget reserves ownership reads. A creative the gateway saw in that list within the last five minutes
is not proven again; named creatives always are, because their names come from the list. `selection_incomplete` and
`selection_note` disclose an unresolved proof or parent match; an incomplete search does not prove foreign ownership.
Listed items include `source_ad_id`, preserving separate ads that share a creative.

## Per platform

| Platform | Read and evidence |
|---|---|
| Meta | Account ads, or named `id,account_id` proof followed by metadata; `GET /{ad_id}/previews`. Captured placement enum, default `MOBILE_FEED_STANDARD`. |
| TikTok | Filtered `/ad/get/`, then `POST /creative/ads_preview/create/`, `preview_type: AD`. Qualified contract: `src/tiktok-preview-reads.ts`; 30-day links. |
| Snapchat | Ads → account creative ownership → `GET /creatives/{id}/creative_preview`. [Documented browser preview](https://developers.snap.com/marketing-api/Ads-API/creatives): no login, 90-day lifetime. The link's own `expires_at` is returned, read as epoch seconds or milliseconds and required to lie ahead; the documentation does not name the unit, so the real shape is to be captured at the live check. |
| LinkedIn | Account creatives `q=criteria` → `GET /rest/adPreviews?q=creative&creative=…&account=urn:li:sponsoredAccount:…`. [Documented](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/ad-preview?view=li-lms-2026-10) iframe sources, placement/device metadata and expiry up to three hours. |
| Reddit | Scoped `LIST_ADS`; `preview_url` works while `preview_expiry` is ahead. Pinned v3 OpenAPI. |
| Google Ads | `generateShareablePreviews` is a reviewed write; result supplies the `amcp_write` preparation call. `src/google-preview-writes.ts`. |
| X | The account's promoted Tweets (`promoted_tweets`), or named: promoted Tweets by `promoted_tweet_ids`, a dark Tweet proven among the account's `NULLCAST` `tweets`. One `GET tweet_previews` (`PUBLISHED`) gives one entry per Tweet. [Pinned](records/X-TWEET-PREVIEWS-PIN-2026-11-16.md); X states no expiry. |
| Microsoft, DV360, Criteo, Apple Ads | No readable preview route. |

## Access and safety

Native reads enforce accounts, grants, ownership, rate limits and audit. Audit stores sizes/hashes,
never preview links. Named Meta identity must match before broader reads or caching;
full unknown-node reads remain refused. That `id,account_id` read is this tool's alone: a direct
`meta_native_action` call with an unproven ID is refused before any provider read. A foreign ad and one Meta cannot
load answer alike, in the audit too: `Not in this account`. The metadata stays a second read, so the unproven read stays two
fields. TikTok and Reddit use account-scoped filters. Explicit foreign ownership
is refused. LinkedIn finder ownership lasts five minutes.

Only HTTPS platform-host links are returned; markup is withheld. A link that spells `&` or `;` before its query is
refused, and the page opens https links only. X's link is the iframe's `src`, only when it is exactly
`ton.twimg.com/ads-manager/tweet-preview/index.html` with one `data` parameter; otherwise the Tweet has a `reason`. LinkedIn accepts iframe sources only, reports
rejected placements and retains `links` as URLs with additive `placements` metadata. Meta response fields remain
unpinned. Links expire; share only with authorized viewers.

Only the exact preview GET preserves signatures in `creative_preview_link`; other URLs and all credentials stay
redacted. AMCP builds the browser URL from creative ID, expiry and signature, refusing expired or inconsistent
values. Snapcodes expire after seven days.
