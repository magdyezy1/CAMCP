---
status: reference
tier: operator
---

# Ad previews

`amcp_ad_previews` gathers each platform's own preview links for ads that already exist in an account. On the
website, *Preview your ads* on the Media library page does the same. It is read-only: nothing in the account changes.

```json
{"platform": "meta", "account_id": "111", "ad_format": "INSTAGRAM_STORY", "limit": 5}
```

Without `ad_ids`, AMCP previews the first `limit` ads (at most 10). With `ad_ids`, it previews those, and lists any it
could not find. Each result gives the ad's ID and name, its preview links, and the link's expiry where the platform
states one.

## Per platform

| Platform | How AMCP reads it | Evidence |
|---|---|---|
| Meta | The account's ads (`meta_ad_list`), then `GET /{ad_id}/previews` with `ad_format` (default `MOBILE_FEED_STANDARD`) | Placement values: the captured catalog's `get_ad_preview` contract |
| TikTok | The account's ads (`/ad/get/`), then `POST /creative/ads_preview/create/` with `preview_type: AD` | `src/tiktok-preview-reads.ts` (API for Business v1.3, checked 2026-09-27); links last 30 days |
| Snapchat | The account's creatives, then `GET /creatives/{id}/creative_preview` | Captured catalog route |
| LinkedIn | The account's creatives (`q=criteria` finder), then `GET /rest/adPreviews?q=creative&creative=urn:li:sponsoredCreative:…` | The creatives finder as `src/linkedin-dsc-edits.ts` uses it; the preview parameters of AMCP's `get_ad_preview` workflow |
| Reddit | The account's ads (`LIST_ADS`); each ad carries `preview_url` while `preview_expiry` is ahead | Pinned Reddit v3 OpenAPI |
| Google Ads | Not a read: shareable previews are created by `generateShareablePreviews`, which AMCP reviews as a write. The result names the `amcp_write` call to prepare | `src/google-preview-writes.ts` |
| X | Not called: the Tweet preview route exists, but its parameters are not pinned in AMCP's evidence | — |
| Microsoft Advertising, DV360, Criteo, Apple Ads | No preview route in their APIs | — |

**Limitation.** The response shapes of the Meta, Snapchat and LinkedIn preview reads are not pinned in AMCP's vendor
documents, and the official pages could not be fetched from the review environment. So AMCP does not depend on field
names there. It returns the HTTPS links on the platform's own hosts that appear in the response, including the
`src` of preview iframe markup. It never returns the markup itself, and never a link to another host (an ad's copy can
contain arbitrary links).

## Access and safety

- Every read goes through the ordinary native read path: the connection's accounts, the owner's grants, ownership
  checks, rate limits and the audit, which records each read by size and hash, not content. Preview links are
  returned and never stored.
- Listing the account's ads first establishes that each ad belongs to the account (the same ownership rule as every
  single-object read). An ID the list does not return is not previewed. TikTok scopes both reads by `advertiser_id`
  itself, so named TikTok ads need no list.
- LinkedIn previews are scoped by the new ownership rule in `src/linkedin-ad-previews.ts`: a creative is previewable
  through the connection for five minutes after the account's creatives list returned it. Before that, the refusal
  names that list as the read to run.
- Preview links open for anyone who has them and expire (TikTok after 30 days, Reddit at `preview_expiry`, others when
  the platform decides). Share them only with people who may see those ads.
