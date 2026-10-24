---
status: reference
tier: operator
---

# Creative preparation and durable uploads

Preparing creative, durable uploads, and reading where an uploaded image or video is used. Sections of the [workflow guide](../PRODUCT-WORKFLOWS.md), moved here with their text unchanged on 2026-10-24 (DOC-03).

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
[media uploads](../MEDIA-UPLOADS.md) for provider limits and safe resume behavior.

## Current Google image links

The creative library can inspect an original Google image receipt with an exact native asset resource and
uploaded SHA-256. Choose a maximum of 1–1000 links, then explicitly read the complete selected collection.
App, Demand Gen and Responsive Search links are covered; Responsive Display, Performance Max, Google video
and historical attribution remain outside this selected view. Missing link flags/types stay unresolved and
removed links are counted separately. Configured statuses do not prove serving or reuse eligibility. The
English/Arabic table preserves exact native IDs and source names; late results cannot replace a changed view.
Meta retains its existing reference pages. See [scope and qualification](../records/DELIVERY-2026-10-04-GOOGLE-IMAGE-REFERENCES.md).

## Performance Max image asset-group links

Choose Performance Max in the original Google image's native reference panel, set a maximum of 1–1000 links
and explicitly read the selected view. The result identifies asset groups rather than individual ads. Native
enabled/paused link configuration, group/campaign status, removed links and unresolved links remain distinct.
Changing the view or limit clears displayed results and invalidates pending reads. The default Google ad-link
view and Meta paging remain. Campaign-level brand-guideline logos, other associations, serving and historical
attribution stay outside this evidence. See [scope and qualification](../records/DELIVERY-2026-10-04-GOOGLE-PMAX-IMAGE-REFERENCES.md).

### Original Performance Max campaign logo references

Choose `reference_view:"performance_max_brand"` on `amcp_media {action:"asset_usage",asset_id,limit:50}` for the
original IMAGE receipt's bounded current campaign-logo view. Literal enabled brand guidelines and exact
Performance Max campaign/image identity are required. LOGO/LANDSCAPE_LOGO link configuration, removed and
unknown links remain distinct. Campaign links are not ads or asset groups. The default ad view and explicit
asset-group view remain independent. Google handoffs retain the original asset, chosen view and bounded
limit; the website waits for an explicit read and clears view choices when another asset is opened. No
write grant, serving/performance/history or all-format absence is established. See [qualification](../records/DELIVERY-2026-10-04-GOOGLE-PMAX-CAMPAIGN-LOGOS.md).

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
MCP handoffs preserve the original asset/bound without an automatic read. See [qualification](../records/DELIVERY-2026-10-04-SNAPCHAT-TOP-SNAP-REFERENCES.md).

Native Meta catalog product read-back now covers all 35 accepted observable fields, including exact
integer inventory, ordered additional images and literal sale dates. An accepted receipt alone cannot
verify a missing field. Current field proof v2 retires partial caches before pending dependency
continuation; preserve original accepted receipts/keys and use read-only recovery. Website Meta CSV column mapping also accepts an explicitly supplied group. Explicit Meta API products and reviewed selected
WooCommerce variations can supply retailer_product_group_id; group keys do not qualify full
variant reconciliation, tax, live store sync or provider eligibility.
