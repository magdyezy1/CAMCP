---
status: reference
tier: operator
---

# Ad previews

`amcp_ad_previews` returns existing ads' preview links without changing the account. The website's Media library
offers the same reads through *Preview your ads*, with status selection and Load more.

```json
{"platform": "meta", "account_id": "111", "ad_format": "INSTAGRAM_STORY", "limit": 5}
```

Without `ad_ids`, `limit` defaults to 5 (maximum 10), and `statuses` to `["active"]`. Other choices are `paused`,
`archived` and `all`. Named IDs ignore statuses. Optional `campaign_ids` and `adset_ids` each accept 1–50 IDs;
both filters must match, including for named IDs. LinkedIn uses campaign groups and native campaigns respectively;
Snapchat uses ad squads in `adset_ids`. Parent filters are tool inputs.

`ad_ids` name ads on Meta, TikTok and Reddit, creatives on Snapchat and LinkedIn. Bare LinkedIn numbers become
creative URNs. Google accepts asset-group IDs/resources or video `adGroupAds` resources. Named reads search beyond
the first list page. Missing IDs have `not_found` and `not_found_reason`.

Results include `previews`, `next_cursor`, `has_more` and `order`. Continue with `cursor: next_cursor` and the same
selection. Five-minute signed cursors bind workspace, user, connection, account, permissions, filters, limit and
Meta placement. Changed logins, permissions or surplus-page identities invalidate continuation. Each call scans
at most ten native list pages. LinkedIn uses native creative-ID order. Snapchat requests `created_desc` unless
reading deleted entities: its API forbids combining that flag with sorting. Other reads report native order.

Snapchat must prove creative ownership through the account creative list before previewing an ad's `creative_id`.
The shared scan budget reserves ownership reads. `selection_incomplete` and `selection_note` disclose an unresolved
proof or parent match; an incomplete search does not prove foreign ownership. Listed items include `source_ad_id`,
preserving separate ads that share a creative.

## Per platform

| Platform | Read and evidence |
|---|---|
| Meta | Account ads, or named `id,account_id` proof followed by metadata; `GET /{ad_id}/previews`. Captured placement enum, default `MOBILE_FEED_STANDARD`. |
| TikTok | Filtered `/ad/get/`, then `POST /creative/ads_preview/create/`, `preview_type: AD`. Qualified contract: `src/tiktok-preview-reads.ts`; 30-day links. |
| Snapchat | Ads → account creatives (ownership search limit 1000) → `GET /creatives/{id}/creative_preview`. [Ads](https://developers.snap.com/marketing-api/Ads-API/ads), [paging](https://developers.snap.com/marketing-api/Ads-API/api-patterns). |
| LinkedIn | Account creatives `q=criteria` → `GET /rest/adPreviews?q=creative&creative=…&account=urn:li:sponsoredAccount:…`. [Documented](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/ad-preview?view=li-lms-2026-10) iframe sources, placement/device metadata and expiry up to three hours. |
| Reddit | Scoped `LIST_ADS`; `preview_url` works while `preview_expiry` is ahead. Pinned v3 OpenAPI. |
| Google Ads | `generateShareablePreviews` is a reviewed write; result supplies the `amcp_write` preparation call. `src/google-preview-writes.ts`. |
| X | Preview parameters remain unqualified; no automatic call. |
| Microsoft, DV360, Criteo, Apple Ads | No readable preview route. |

## Access and safety

Native reads enforce connection accounts, grants, ownership, rate limits and audit. Audit stores sizes/hashes;
preview links are returned without storage. Named Meta identity must match before broader reads or caching;
full unknown-node reads remain refused. TikTok and Reddit use account-scoped filters. Explicit foreign ownership
is refused. LinkedIn finder ownership lasts five minutes.

Only HTTPS platform-host links are returned; markup is withheld. LinkedIn accepts iframe sources only, reports
rejected placements and retains `links` as URLs with additive `placements` metadata. Meta response fields remain
unpinned. Links expire; share only with authorized viewers.
