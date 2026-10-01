# Write coverage: what stays blocked and why

**1 October 2026, batch 61:** monitors add explicit personal email delivery and bounded original-notice recovery. All
3,247 action rows and the 167-family registry retain their classifications: 1,712 native reads, 800 reviewed writes
and 502 blocked writes. No new advertising write contract or provider acceptance is claimed. The dated table below
remains the native write coverage baseline; current product expansion is tracked in
[IMPLEMENTATION-2026-10-01.md](IMPLEMENTATION-2026-10-01.md).

Status on 2026-09-30 (batch 49), from the action ledger (`docs/implementation/ACTION-CONTRACT-COVERAGE.json`) only.
No provider was called. This plans the platform-by-platform coverage batches the owner asked for: which blocked
writes wait on an owner decision, which wait on evidence, and which are candidates to build as reviewed families.

## The ledger in one table

| Status | Routes | Meaning |
|---|---|---|
| `native_read` | 1,712 | Reads that pass the independent read classification |
| `reviewed_write_family` | 800 | Writes with a reviewed family (inspect, prepare, execute, verify) |
| `blocked_write` | 502 | Writes AMCP refuses: no family yet, or no family on purpose |
| `local_workflow` / `media_workflow` | 83 / 24 | Steps AMCP performs itself (OAuth, uploads) |
| `unmapped` | 79 | Advertised names with no provider request (Adjust 23, WooCommerce 31, OAuth steps and AMCP helpers) |
| `provider_unsupported` | 22 | Methods the provider withdrew; each refusal names the replacement |
| `unqualified_read` | 17 | POSTs catalogued as reads that are not read-only (lead reports, event validation, token checks) |
| `adapter_requires_input` | 8 | Legacy Google names whose route depends on the scope asked for |

## Blocked writes by kind

Each blocked write is placed in the first kind that matches its path: batch first, then the columns from left to
right. *Reason recorded* counts the rows whose ledger reason and refusal already say why and what to use instead. Access covers users, roles, partners, agencies, system users, tokens, sharing and links; account,
creating or changing accounts, advertisers, locations, settings and terms; money, billing, funds, budgets outside
campaigns and bookings; personal data, audience members, contact uploads, events, conversions and leads; publishing,
posts, reactions, comments, messages and stories; media uploads, the raw steps of file uploads. A handful of routes
sit in a neighbouring kind, which does not change the decision they need. *Candidates* are the rest; the list below
says which of them hold up once their evidence is read (DV360's five do not).

| Platform | Access | Account | Money | Personal data | Publishing | Media uploads | Commerce and catalogs | Batch or async | Reason recorded | Candidates |
|---|---|---|---|---|---|---|---|---|---|---|
| TikTok | 31 | 7 | 12 | 14 | 35 | 6 | 10 | 6 | 44 | 0 |
| Meta | 49 | 2 | 3 | 4 | 9 | 0 | 8 | 11 | 8 | 0 |
| LinkedIn | 10 | 10 | 0 | 7 | 9 | 6 | 0 | 0 | 21 | 0 |
| Snapchat | 18 | 4 | 2 | 14 | 6 | 0 | 1 | 0 | 5 | 0 |
| Google Ads | 23 | 0 | 5 | 6 | 0 | 0 | 0 | 3 | 12 | 0 |
| X Ads | 4 | 7 | 3 | 2 | 0 | 0 | 0 | 2 | 4 | 0 |
| DV360 | 10 | 2 | 6 | 4 | 1 | 0 | 0 | 0 | 6 | 0 |
| Criteo | 1 | 7 | 6 | 2 | 0 | 1 | 0 | 0 | 4 | 0 |
| Google Business Profile | 0 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| **All** | **146** | **47** | **37** | **53** | **60** | **13** | **19** | **22** | **105** | **0** |

## Owner decisions of 2026-09-30

| Kind | Decision | Where it stands |
|---|---|---|
| Personal-data policy | Approved as drafted: the seven rules, the order (Meta customer lists and Google Customer Match first, removal included, then conversions), and removals by an operator (the page's recommendation) | Batch 43: the foundation and Meta customer lists (`meta_customer_lists`). Batch 44: Meta offline conversions (`meta_offline_conversions`). Batch 46: Google Customer Match (`google_customer_match`) and offline click conversions (`google_offline_conversions`) through the Data Manager API, after the owner's Google decisions (next row); see [PERSONAL-DATA-POLICY.md](PERSONAL-DATA-POLICY.md) |
| Google Data Manager ("Confirm on google") | Both confirmed: AMCP requests Google's `datamanager` OAuth permission, and sends the uploader's own confirmation of Google's Customer Match terms as the upload's terms field, only when the uploader confirmed it | Done in batch 46. The owner still enables the Data Manager API in the Google Cloud project, adds the scope to its data access (a sensitive scope, so Google's OAuth verification), and reconnects Google; AMCP changes none of these |
| Automated rules | Unblock | Meta done (`meta_ad_rules`): rules that raise spend or delivery name their objects, carry a limit and need a spending policy and confirmation, and AMCP maps Meta's documented rule update and delete so it can stop what it creates. TikTok's stay blocked on evidence: its rule pages cannot be read without signing in |

## Owner decisions of 2026-09-29

Recorded so they are not asked again. Each is the owner's answer to the recommendations of batch 34.

| Kind | Decision | Where it stands |
|---|---|---|
| Access (users, roles, partners, agencies, system users, tokens, sharing, links) | Stay blocked, not as a hard block: if a user asks for one, the owner may enable it | Blocked; each would come as its own reviewed family on request |
| Money (billing, funds, invoices, bookings, guaranteed orders) | Stay blocked, same terms as access | Blocked |
| Money: Meta budget schedules | Open, on conditions: a spending policy on the account (advise on unprotected accounts); the full scheduled increase, up to 8 times daily, counted against the caps at prepare; start and end in the account time zone and the maximum extra spend in the review, with `spend_change_confirmed`; how a period is cancelled said in the review; read back from the schedule list; Meta's limits (50 periods, 3 hours, daily budgets only, `CAN_USE_BUDGET_SCHEDULING_API`) | Done in batch 35 (`meta_budget_schedules`, F-116). Meta documents no API update or deletion of a period, so the review says it is changed in Ads Manager and that pausing stops spending at once; the Ads Manager path is not verifiable from here |
| Publishing (posts, comments, messages, stories) | Stay blocked, same terms as access | Blocked |
| Account setup (accounts, advertisers, settings, terms) | Stay blocked, same terms as access | Blocked |
| Batch or async | Generic batch passthroughs stay closed for good. Typed batch families that validate and verify each item, like the X campaign and line item batch, are considered case by case | Graph batch, async batches, Google batch jobs and copy tasks stay closed |
| Personal data (customer lists, conversions) | Stay blocked; a one-page policy drafted for the owner's approval, nothing opened. **2026-09-30: policy approved** | Opened platform by platform under [PERSONAL-DATA-POLICY.md](PERSONAL-DATA-POLICY.md). Meta customer lists done in batch 43, Meta offline conversions in batch 44, Google Customer Match and offline click conversions in batch 46 (above) |
| Commerce and catalogs | Make them available | Meta in batches 37 and 39 (catalogs, product sets, products, scheduled feeds); Snapchat in batch 38 (catalogs, product feeds); X in batch 39 (catalogs, product sets, scheduled feeds, products); TikTok blocked on evidence with a recorded reason (below). Still blocked: item batches, feed rules and uploads, stores, hotels, vehicles and home listings, TikTok GMV Max (Shop campaigns) |
| Meta shop opt-out (`destination_spec`) | Keep, on conditions: cite Meta's v26.0 changelog; accept exactly `{destination_type: "WEBSITE_AND_SHOP_OPT_OUT"}`; never set automatically; the review says "people go to your website only, not your Meta shop"; verified on read-back, or against the write response when the read omits it (inconclusive, not failed or passed) | Done in batch 35 (d875647). AMCP calls Graph API v26.0 by default since batch 15, and the value is accepted only from v26.0 |

Media uploads stay as recommended: the raw upload steps remain refused and `amcp_media` covers uploads end to end.

## Reason recorded

`src/withheld-writes.ts` gives these their own ledger reason and puts it in the refusal (`details.reason`):

- Blocked on evidence: TikTok's twenty catalog writes (catalogs, feeds, products, sets, videos, event sources). TikTok's
  docs portal, rendered in a browser, shows only Reporting and Authentication without signing in (read 2026-09-29), and
  its official SDK gives request fields without responses or meaning, so no review could state their effect or read
  them back; catalogs are managed in TikTok Catalog Manager for now. One of them, `catalog/capitalize`, was counted
  under personal data before because its path contains `capi`.
- Blocked on evidence: TikTok creative portfolio deletion (TikTok's SDK defines no delete; its pages are
  unreadable here) and X analytics job deletion (docs.x.com no longer documents it; the older reference put the job
  ID in the path the captured route lacks).
- Duplicates of reviewed routes: LinkedIn's `/rest/creatives` and `/rest/adCampaigns` (six routes; the current pages
  place both under `/rest/adAccounts/{id}/`), Snapchat's per-ID creative PUT (its page's example uses the reviewed
  collection PUT), and X's targeting criterion PUT (X documents no update: delete and create).
- Blocked on evidence: Google Ads campaign bid modifier creation. The v25 discovery document marks
  `CampaignBidModifier.campaign` output-only and expects no resource name on create, and Google's code samples show no
  campaign bid modifier creation. Update and removal of call modifiers are reviewed.
- Allowlist-only: DV360's four YouTube asset association writes ("only available to an informed subset of users").
- Outside the selected advertiser: DV360's Floodlight group patch, which needs a partner context and governs
  conversion counting for every advertiser in the group.
- Supply side: Criteo's keyword reviews (the retailer reviewer's step) and its fill rate, revenue and unfilled
  placement reports (Supply Side Reporting). AMCP connects demand accounts.
- Account setup kept blocked by the owner: completing a Business Profile verification.
- Batch 41, the remaining candidates of four platforms:
  - Blocked on evidence: nineteen more TikTok writes (ACO, appeals, split tests, lookalike refresh, Spark
    authorization and others).
  - Unreviewable by design: automated rules (Meta rules library, TikTok optimizer rules), which change statuses,
    budgets and bids later without a review. Also Meta recommendations, applied by signature.
  - Cannot be undone through the API: Meta account tracking specs and business event source groups.
  - Personal data: X Do Not Reach lists and TikTok pixel events.
  - Duplicates or not documented: Meta `POST adpreviews`, Meta user-level ad studies and LinkedIn `/rest/example`.
- Batch 43, personal data:
  - Google Customer Match (seven routes of the offline user data jobs and `uploadUserData`): refused by Google since
    2026-04-01 for projects that sent no Customer Match request between October 2025 and March 2026. Replaced in batch
    46 by the Data Manager API (`google_customer_match`); the reason now names it.
  - Not yet opened: DV360 Customer Match members, LinkedIn DMP segment users and TikTok customer files, each waiting its
    turn under the policy.
  - Meta `usersreplace`: a 90-minute replacement session; people are added and removed instead.
- Batch 45:
  - Google click conversions: refused by Google since 2026-06-15 for projects that uploaded none between December
    2025 and June 2026. Replaced in batch 46 by the Data Manager API (`google_offline_conversions`).
  - Google call conversions: the caller's phone number goes to Google unhashed, which the policy's first rule forbids.
  - Snapchat: claims by ad code (the brand profile is read on Snap's Business API host), creative elements (no
    documented read), interaction zones (built from those elements) and ad squad UI render data (no documented
    request).
- Batch 47:
  - LinkedIn writes behind permissions AMCP does not request. Seven need `rw_dmp_segments`, an Audiences program
    permission "not granted automatically": page sets, segment sources, predictive audiences and segment
    destinations. Company lists need it too, and are also customer lists under the personal-data policy. Ad segment
    updates wait with them, because LinkedIn's pages disagree on their permission. Media plans need `rw_media_plans`
    (the Media Planning program). Each waits on the owner's decision to request the permission, and on LinkedIn's
    approval.
  - LinkedIn lift test survey questions: no documented request body for creating them.
  - Meta ad place page sets: created and read only, with no update or deletion in the SDK, so permanent through the
    API.
- Batch 49, LinkedIn reads that the catalog lists as writes:
  - `globalPublisherList` returns a signed download of LinkedIn's global publisher list from www.linkedin.com. It
    names no account, and AMCP does not call that host.
  - `adPreviews?action=livePreviewForCreative` previews a creative that does not exist yet, named by a campaign in
    the body. AMCP does not record LinkedIn campaign ownership for reads. Existing creatives are previewed with
    `amcp_ad_previews`.
- Unreviewable by design: Meta's `DELETE act_{id}/campaigns`, which deletes by rule (strategy, date, count), not by
  ID; each campaign is deleted with the reviewed per-campaign deletion.

## Done in batch 49

- **Snapchat targeting specs (`snapchat_targeting_specs`):** the GEO spec of an ad squad with more than 500 criteria
  (up to 4,000) is replaced after reading the ad squad, its campaign and the current spec. Spending confirmation is
  required, and the spec is read back with locations compared in any order and case (800 reviewed, 502 blocked).
- **Two reasons recorded** (above). 105 blocked writes carry a reason, and **no candidate is left**. Every
  blocked write either waits on an owner decision (by kind, in the table) or carries its own reason.

## Done in batch 48

- **LinkedIn engagement retargeting audiences (`linkedin_engagement_audiences`):**
  - Segments of ad engagement (video, lead form, single image, document and conversation ads) are created, renamed
    and deleted, singly or in batches of up to 25.
  - Their engagement rules take campaigns of the account as sources, with the documented triggers and lookbacks,
    and are added and removed singly or in batches.
  - Deletion is refused while a live campaign targets the segment's ad segment.
  - Segments of uploaded people stay blocked under the personal-data policy.
  - Seven writes leave the blocked list (799 reviewed, 503 blocked).
- Candidates left: LinkedIn 2 (the POST reads) and Snapchat 1 (targeting specs).

## Done in batch 47

- **LinkedIn brand lift tests (`linkedin_lift_tests`):**
  - Tests are created as DRAFT on the account or on 1–50 of its campaign groups, updated by execution state, and
    deleted before scheduling. Survey questions are removed while the test is still a draft.
  - READY needs one to six survey questions, spending confirmation, and counts as activation. The review lists the
    resumable tests it ends. CANCELED warns that it cannot be undone. Everything is read back.
- **Twelve reasons recorded** (above). 792 reviewed, 510 blocked, and 103 blocked writes carry a reason.
- Candidates left: LinkedIn 9 and Snapchat 1.
  - LinkedIn: 7 are DMP segment and engagement-rule routes for engagement retargeting, which needs only `rw_ads`
    (Engagement Retargeting page). The other 2 are POST reads: the live preview of a creative and the global
    publisher list download.
  - Snapchat: the ad squad targeting specs.

## Done in batch 46

- **Google Customer Match (`google_customer_match`) and offline click conversions (`google_offline_conversions`)**
  through Google's Data Manager API, under the personal-data policy and the owner's Google decisions of 2026-09-30:
  - People are added to and removed from a Customer Match list, up to 10,000 per request. Conversions go to an
    enabled UPLOAD_CLICKS conversion action, up to 2,000 per request, by hashed email or phone or by click ID.
  - The list or conversion action is read first through the Google Ads API. Consent comes from the uploader.
  - The terms field is sent only on the uploader's confirmation. Verification reads the request status.
  - Three new reviewed writes and one read (785 reviewed, 517 blocked). The nine Google Ads API routes they replace
    stay blocked, and their reasons now name the replacement.

## Done in batch 45

- **Snapchat claim media (`snapchat_claim_media`):** an organic Snap claimed into the ad account's media library by
  its Snap ID, read back (782 reviewed, 517 blocked).
- **Eight reasons recorded** (above); 91 blocked writes carry one. Candidates left: LinkedIn 27, Snapchat 1 (targeting
  specs of ad squads with more than 500 criteria) and Meta 1 (`ad_place_page_sets`).

## Done in batch 44

- **Meta offline conversions (`meta_offline_conversions`):** standard events from offline sources sent to a pixel of
  the account through the Conversions API, under the personal-data policy (780 reviewed, 519 blocked). Website and
  app events stay outside: Meta needs the browser's or device's own data for them.

## Done in batch 43

- **Personal-data foundation** (policy approved 2026-09-30): people hashed in memory, reviews that keep counts and a
  digest, the owner's switch per ad account, uploads executed by the owner. See the policy's implementation section.
- **Meta customer lists (`meta_customer_lists`):** empty lists created, people added and removed. The two people routes
  leave the blocked writes (778 reviewed, 521 blocked); eleven more blocked writes carry a reason, 83 in all.

## Done in batch 42

- **Meta automated rules (`meta_ad_rules`)**, unblocked by the owner on 2026-09-30. Rules that raise spend or delivery
  name their objects, carry a limit and need a spending policy and confirmation. AMCP maps Meta's documented rule
  update and delete. TikTok's rules stay blocked on evidence.

## Done in batch 41

- **31 reasons recorded** (above): every former TikTok and X candidate and six of Meta's now say why they stay
  blocked. 73 blocked writes carry a recorded reason, and 35 candidates remain: LinkedIn 27, Snapchat 7 and Meta 1.
- **Owner decision to consider:** automated rules. A rule that only notifies changes nothing, and could come as its own
  family on request. Rules that act stay unreviewable by design.

## Done in batch 40

- **Criteo creatives** (`criteo_creatives`): create, and whole update keeping retailer and template. Every value is
  checked against the retailer's template read: variables, types, required and dependent variables, text length,
  options and file counts. Updates name the line items that use the creative.
- **Eleven more reasons recorded** (above): Google's campaign bid modifier creation, five DV360 writes, four Criteo
  supply-side writes and Business Profile verification completion. Every former Criteo, DV360, Google Ads and Business
  Profile candidate now has a family or a reason.

## Done in batch 39

- **X product catalogs** (`x_product_catalogs`, `x_product_sets`, `x_scheduled_feeds`, `x_catalog_products`), from
  X's "Catalog Management" reference on docs.x.com. An X catalog belongs to a user, one per user, so AMCP writes only
  catalogs of FULL promotable users of the selected ad account.
  - Catalogs are created, renamed, and deleted when empty.
  - Filtered and manual product sets are created. Manual sets are updated; X does not update filtered sets. Changes
    and deletions warn that X's API documents no link between ads and sets.
  - One scheduled feed per catalog, HTTPS without credentials.
  - Products are written one at a time. X has no lookup by ID, so AMCP finds products within the first 1,000
    (`CATALOG_SCAN_LIMIT` beyond that).
- **Meta catalogs themselves** (`meta_product_catalogs`): commerce catalogs created under the account's business,
  changed (name, display settings, images) and deleted. AMCP never sends
  `allow_delete_catalog_with_live_product_set`, so Meta's block on deleting a catalog with live product sets holds.
  `partner_integration`, which carries an access token, is refused. With batch 37, Meta catalogs are complete apart
  from item batches, feed rules and uploads, stores and the non-commerce verticals.

## Done in batch 38

- **Snapchat catalogs** (`snapchat_catalogs`): create, update and delete COMMERCE catalogs of the ad account's
  organization, one at a time, with the account's pixels as event sources. Snapchat's update "expects the entire
  object", so the review names any event source an update drops. An organization holds at most 200 catalogs
  (`CONFIGURATION_LIMIT`). Snapchat does not say what deleting a catalog does to its feed, sets and ads, so only an
  empty catalog is deleted (`CATALOG_NOT_EMPTY`).
- **Snapchat product feeds** (`snapchat_product_feeds`): a catalog's one feed ("1:1"), created, updated whole and
  deleted, with schedules checked against Snapchat's interval table, HTTPS only and without credentials. Supplemental
  feeds and feed uploads stay refused.
- **TikTok catalogs**: blocked on evidence with a recorded reason (above).

## Done in batch 37

- **Meta product sets** (`meta_product_sets`): create, change and delete sets of catalogs of the account's business,
  with the documented filter grammar, a check with Meta that a filter selects products, and the account's ad sets and
  creatives that use a set (a set in use is not deleted; one live ad sets use is not emptied).
- **Meta catalog products** (`meta_catalog_products`): one product at a time. Meta replaces an existing `retailer_id`
  by default, so AMCP does so only with an explicit `allow_upsert: true` and shows before and after. The price is read
  back through Meta's numeric price filter.
- **Meta product feeds** (`meta_product_feeds`): scheduled feeds with an explicit deletion choice, HTTPS schedules
  without credentials, and Meta's own warning on deleting a feed.
- Still blocked for Meta commerce: item batches, feed rules and uploads, catalog creation and deletion, catalog
  sharing (`assigned_users`), stores, hotels, vehicles and home listings.

## Done in batch 35

- **Meta budget schedules** (`meta_budget_schedules`) on the owner's conditions above; `budget_schedule_specs` on
  campaign and ad set requests is refused so every period passes this review (F-116).
- **Meta shop opt-out** on the owner's conditions, and new ads name an existing creative only (F-115).
- **X reports**: analytics times are sent in whole hours without fractional seconds (F-114).

## Done in batch 34

- **TikTok pixels** (`tiktok_pixels`): creation and renaming of owned pixels, from TikTok's official SDK request fields
  and the documented pixel list; partner integrations and advanced matching stay out.
- **LinkedIn planning reads**: Audience Insights and Media Planning (three forecasts) run as reads, bound to the
  account in their body, with LinkedIn's required notices.
- Eleven blocked rows carry a recorded reason (above).
- Found not viable on reading: DV360's YouTube asset associations are allowlist-only ("only available to an informed
  subset of users"), and AMCP keeps allowlist-only methods unqualified.

## Candidates to build, platform by platform

Ordered by value to campaign management, then by the evidence at hand. Each becomes a reviewed family to the full
standard (red tests, reads, impact, receipt, read-back) in its own batch.

1. **LinkedIn** — none left. Lift tests (batch 47) and engagement retargeting (batch 48) are done. The two POST reads
   carry a reason (batch 49). Page sets, segment sources, company lists, predictive
   audiences, destinations and media plans wait on permissions the owner decides. Evidence: Microsoft Learn.
2. **Snapchat** — none left. Targeting specs are done (batch 49). Interaction zones, creative elements and media
   claimed by ad code carry a recorded reason (batch 45).
3. **Meta** — none left: ad place page sets carry a recorded reason (batch 47).

TikTok, X and Criteo have no candidate left: TikTok's are blocked on evidence (its portal shows only Reporting and
Authentication without signing in), apart from automated rules and pixel events. X's Do Not Reach lists hold
customer emails. Criteo's keyword reviews and supply-side reports serve retailers.

DV360, Google Ads and Business Profile have no candidate left either. Their remaining blocked writes carry a recorded
reason (above), and the refusal gives it.
