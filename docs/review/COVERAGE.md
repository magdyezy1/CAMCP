# Write coverage: what stays blocked and why

**2 October 2026, batch 82:** Activity/MCP history now returns bounded, currently scoped event
metadata with safe diagnostics, request references and sequence pagination. Raw requests and receipts are withheld
for every role; the original append-only audit stays intact. No new write contract is added. All
3,247 action rows and the 167-family registry retain their classifications: 1,712 native reads, 800 reviewed writes
and 502 blocked writes. No new advertising write contract or provider acceptance is claimed. The dated table below
remains the native write coverage baseline; current product expansion is tracked in
[IMPLEMENTATION-2026-10-01.md](IMPLEMENTATION-2026-10-01.md).

Status on 2026-09-30 (batch 49), from the action ledger (`docs/implementation/ACTION-CONTRACT-COVERAGE.json`) only.
No provider was called. This plans the platform-by-platform coverage batches the owner asked for: which blocked
writes wait on an owner decision, which wait on evidence, and which are candidates to build as reviewed families.

## The ledger in one table

| Status                              | Routes  | Meaning                                                                                             |
| ----------------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `native_read`                       | 1,712   | Reads that pass the independent read classification                                                 |
| `reviewed_write_family`             | 800     | Writes with a reviewed family (inspect, prepare, execute, verify)                                   |
| `blocked_write`                     | 502     | Writes AMCP refuses: no family yet, or no family on purpose                                         |
| `local_workflow` / `media_workflow` | 83 / 24 | Steps AMCP performs itself (OAuth, uploads)                                                         |
| `unmapped`                          | 79      | Advertised names with no provider request (Adjust 23, WooCommerce 31, OAuth steps and AMCP helpers) |
| `provider_unsupported`              | 22      | Methods the provider withdrew; each refusal names the replacement                                   |
| `unqualified_read`                  | 17      | POSTs catalogued as reads that are not read-only (lead reports, event validation, token checks)     |
| `adapter_requires_input`            | 8       | Legacy Google names whose route depends on the scope asked for                                      |

## Blocked writes by kind

Each blocked write is placed in the first kind that matches its path: batch first, then the columns from left to
right. _Reason recorded_ counts the rows whose ledger reason and refusal already say why and what to use instead. Access covers users, roles, partners, agencies, system users, tokens, sharing and links; account,
creating or changing accounts, advertisers, locations, settings and terms; money, billing, funds, budgets outside
campaigns and bookings; personal data, audience members, contact uploads, events, conversions and leads; publishing,
posts, reactions, comments, messages and stories; media uploads, the raw steps of file uploads. A handful of routes
sit in a neighbouring kind, which does not change the decision they need. _Candidates_ are the rest; the list below
says which of them hold up once their evidence is read (DV360's five do not).

| Platform                | Access  | Account | Money  | Personal data | Publishing | Media uploads | Commerce and catalogs | Batch or async | Reason recorded | Candidates |
| ----------------------- | ------- | ------- | ------ | ------------- | ---------- | ------------- | --------------------- | -------------- | --------------- | ---------- |
| TikTok                  | 31      | 7       | 12     | 14            | 35         | 6             | 10                    | 6              | 44              | 0          |
| Meta                    | 49      | 2       | 3      | 4             | 9          | 0             | 8                     | 11             | 8               | 0          |
| LinkedIn                | 10      | 10      | 0      | 7             | 9          | 6             | 0                     | 0              | 21              | 0          |
| Snapchat                | 18      | 4       | 2      | 14            | 6          | 0             | 1                     | 0              | 5               | 0          |
| Google Ads              | 23      | 0       | 5      | 6             | 0          | 0             | 0                     | 3              | 12              | 0          |
| X Ads                   | 4       | 7       | 3      | 2             | 0          | 0             | 0                     | 2              | 4               | 0          |
| DV360                   | 10      | 2       | 6      | 4             | 1          | 0             | 0                     | 0              | 6               | 0          |
| Criteo                  | 1       | 7       | 6      | 2             | 0          | 1             | 0                     | 0              | 4               | 0          |
| Google Business Profile | 0       | 8       | 0      | 0             | 0          | 0             | 0                     | 0              | 1               | 0          |
| **All**                 | **146** | **47**  | **37** | **53**        | **60**     | **13**        | **19**                | **22**         | **105**         | **0**      |

## Owner decisions of 2026-09-30

| Kind                                      | Decision                                                                                                                                                                                                           | Where it stands                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal-data policy                      | Approved as drafted: the seven rules, the order (Meta customer lists and Google Customer Match first, removal included, then conversions), and removals by an operator (the page's recommendation)                 | Batch 43: the foundation and Meta customer lists (`meta_customer_lists`). Batch 44: Meta offline conversions (`meta_offline_conversions`). Batch 46: Google Customer Match (`google_customer_match`) and offline click conversions (`google_offline_conversions`) through the Data Manager API, after the owner's Google decisions (next row); see [PERSONAL-DATA-POLICY.md](PERSONAL-DATA-POLICY.md) |
| Google Data Manager ("Confirm on google") | Both confirmed: AMCP requests Google's `datamanager` OAuth permission, and sends the uploader's own confirmation of Google's Customer Match terms as the upload's terms field, only when the uploader confirmed it | Done in batch 46. The owner still enables the Data Manager API in the Google Cloud project, adds the scope to its data access (a sensitive scope, so Google's OAuth verification), and reconnects Google; AMCP changes none of these                                                                                                                                                                  |
| Automated rules                           | Unblock                                                                                                                                                                                                            | Meta done (`meta_ad_rules`): rules that raise spend or delivery name their objects, carry a limit and need a spending policy and confirmation, and AMCP maps Meta's documented rule update and delete so it can stop what it creates. TikTok's stay blocked on evidence: its rule pages cannot be read without signing in                                                                             |

## Owner decisions of 2026-09-29

Recorded so they are not asked again. Each is the owner's answer to the recommendations of batch 34.

| Kind                                                                            | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Where it stands                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access (users, roles, partners, agencies, system users, tokens, sharing, links) | Stay blocked, not as a hard block: if a user asks for one, the owner may enable it                                                                                                                                                                                                                                                                                                                                                                                       | Blocked; each would come as its own reviewed family on request                                                                                                                                                                                                                                                                                                                                |
| Money (billing, funds, invoices, bookings, guaranteed orders)                   | Stay blocked, same terms as access                                                                                                                                                                                                                                                                                                                                                                                                                                       | Blocked                                                                                                                                                                                                                                                                                                                                                                                       |
| Money: Meta budget schedules                                                    | Open, on conditions: a spending policy on the account (advise on unprotected accounts); the full scheduled increase, up to 8 times daily, counted against the caps at prepare; start and end in the account time zone and the maximum extra spend in the review, with `spend_change_confirmed`; how a period is cancelled said in the review; read back from the schedule list; Meta's limits (50 periods, 3 hours, daily budgets only, `CAN_USE_BUDGET_SCHEDULING_API`) | Done in batch 35 (`meta_budget_schedules`, F-116). Meta documents no API update or deletion of a period, so the review says it is changed in Ads Manager and that pausing stops spending at once; the Ads Manager path is not verifiable from here                                                                                                                                            |
| Publishing (posts, comments, messages, stories)                                 | Stay blocked, same terms as access                                                                                                                                                                                                                                                                                                                                                                                                                                       | Blocked                                                                                                                                                                                                                                                                                                                                                                                       |
| Account setup (accounts, advertisers, settings, terms)                          | Stay blocked, same terms as access                                                                                                                                                                                                                                                                                                                                                                                                                                       | Blocked                                                                                                                                                                                                                                                                                                                                                                                       |
| Batch or async                                                                  | Generic batch passthroughs stay closed for good. Typed batch families that validate and verify each item, like the X campaign and line item batch, are considered case by case                                                                                                                                                                                                                                                                                           | Graph batch, async batches, Google batch jobs and copy tasks stay closed                                                                                                                                                                                                                                                                                                                      |
| Personal data (customer lists, conversions)                                     | Stay blocked; a one-page policy drafted for the owner's approval, nothing opened. **2026-09-30: policy approved**                                                                                                                                                                                                                                                                                                                                                        | Opened platform by platform under [PERSONAL-DATA-POLICY.md](PERSONAL-DATA-POLICY.md). Meta customer lists done in batch 43, Meta offline conversions in batch 44, Google Customer Match and offline click conversions in batch 46 (above)                                                                                                                                                     |
| Commerce and catalogs                                                           | Make them available                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Meta in batches 37 and 39 (catalogs, product sets, products, scheduled feeds); Snapchat in batch 38 (catalogs, product feeds); X in batch 39 (catalogs, product sets, scheduled feeds, products); TikTok blocked on evidence with a recorded reason (below). Still blocked: item batches, feed rules and uploads, stores, hotels, vehicles and home listings, TikTok GMV Max (Shop campaigns) |
| Meta shop opt-out (`destination_spec`)                                          | Keep, on conditions: cite Meta's v26.0 changelog; accept exactly `{destination_type: "WEBSITE_AND_SHOP_OPT_OUT"}`; never set automatically; the review says "people go to your website only, not your Meta shop"; verified on read-back, or against the write response when the read omits it (inconclusive, not failed or passed)                                                                                                                                       | Done in batch 35 (d875647). AMCP calls Graph API v26.0 by default since batch 15, and the value is accepted only from v26.0                                                                                                                                                                                                                                                                   |

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

## Batch 122 — guided Snapchat traffic and creative dependencies

The guided website traffic recipe composes the existing Snapchat campaign, ad-squad and ad reviewed families.
It adds no native routes or classified writes: 3,247 actions / 167 reviewed families / 800 reviewed writes remain
unchanged. Existing creative references in native ad creates/replacements now have independent exact-account
snapshots; website references also require current WEB_VIEW and HTTPS fields. Campaign preflight checks the
selected account's complete bounded creative collection before creating predecessors. The three paused steps,
explicit offset schedule and exact daily micros are synthetic-qualified; live creative approval, objective
eligibility, destination availability and conditional programs remain unqualified. See
[delivery](DELIVERY-2026-10-03-SNAPCHAT-TRAFFIC.md).

## Batch 125 — guided Snapchat leads and original form dependencies

The tenth recipe composes the same qualified campaign/ad-squad/ad routes. Native action counts and reviewed
families remain unchanged: 3,247 actions / 167 families / 800 reviewed writes. Current selected-account creative
and form collection proofs precede global definition reads; native ad creation and qualified creative replacements
freeze the exact original linked form. The two supported explicit goals, three PAUSED steps, optional native policy
fields, no-personal-data read scope, current ownership and no-replay behavior have synthetic contract/SDK/browser
qualification. Provider approval, consent acceptance, optimization entitlement and broader launch packs remain
unqualified. See [delivery](DELIVERY-2026-10-04-SNAPCHAT-LEADS.md).

## Batch 126 — aggregate Snapchat native lead evidence

Three new guided native_leads presets bring detailed capture to 19 presets across five platforms. Child
ad-squad/ad capture retains exact current parent ownership; all levels retain complete finalized pages and
current account/authority checks. Original purchase definitions remain separate. Compatible verified
linked-ad performance and English/Arabic all-row exports preserve exact counts and parent references.
No submitted leads, new native routes/scopes/families or advertising writes are introduced. Native ledger
counts remain unchanged. See [delivery](DELIVERY-2026-10-04-SNAPCHAT-NATIVE-LEADS.md).

## Batch 127 — saved-evidence metadata index

No provider route or action classification changes: 3,247 actions / 167 families / 1,712 reads / 800 reviewed writes /
502 blocked writes. The new first-party discovery projection in src/evidence-index.ts uses existing scoped document
storage and encrypted continuations. Original complete reports and native source definitions remain inspectable through
get and existing exports. Ten synthetic index checks and the real advertised SDK contract cover current authorization,
scope/session/filter binding, bounded scans, original IDs, legacy unknown metadata and restored storage. EN/AR renderer
checks qualify search/paging/comparison behavior; actual visual/assistive and external-client acceptance remain separate.
The reproducible benchmark qualifies this local in-memory workload only. See
[delivery](DELIVERY-2026-10-04-EVIDENCE-INDEX.md). Original package totals remain 13 implemented / 14 partial / one open.

## Batch 128 — source-bound additional-consent drafts

New src/gtm-consent-plans.ts composes only the existing GTM GET_WORKSPACE/GET_TAG/UPDATE_TAG contracts.
Campaign creation/unsent prepare/execute and compact scope projection retain original source binding and native
review/receipt recovery. web/account-workflows.js and campaign-workflows.js expose explicit bilingual selection,
preview/save and original proposal review; tools/check-locales.mjs restricts translation to the selected authored
refusals, leaving wire/native diagnostics unchanged. The new synthetic fixture/backend/UI/SDK checks qualify
identity, strict model bounds, current source/authority/session, saved replay, concurrency, independent native
acceptance/read-back and original uncertainty recovery. No new native action/family/scope or provider publish.
3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes remain unchanged.
See [delivery](DELIVERY-2026-10-04-GTM-CONSENT-PLANS.md); actual new visual/keyboard/assistive, external/live/deployed acceptance remain separate.
Package totals remain 13 implemented / 14 partial / one open.

## Batch 129 — LinkedIn source-bound daily budgets

New src/linkedin-allocation-budgets.ts brackets exact account/campaign/group reads with current authority and
request/byte/time/resource limits. report-allocation.ts qualifies original UTC analytics/URN/currency evidence;
allocation-plan.ts binds exact current model allocations and existing decimal REST.li PARTIAL_UPDATE steps, retains
original native review/receipt recovery and counts current previews in SQL. decision-reporting.ts and the workspace
guide describe the same bounded workflow. Website allocation controls/preview and campaign proposal projection
retain original IDs/native decimal amounts, group caps, overage and confirmation/expiry/current-view behavior.
Selected authored allocation refusals/explanations and controls gain 65 Arabic entries. Fifteen backend, five UI
and one SDK checks cover these boundaries; related set 152/152/0/0. No native action/family/scope or live mutation.
See [delivery](DELIVERY-2026-10-04-LINKEDIN-ALLOCATION.md); native ledger and 13/14/1 package totals unchanged.
New visual/assistive, real-provider/deployed and current revision CI acceptance remain separate.

## Batch 130 — LinkedIn observed budget controls

src/linkedin-portfolio.ts validates group daily money and projects bounded current parent/shared/pacing context
without added reads. src/workflows.ts corrects the generic shortcut explanation while preserving native DRAFT
compilation. account-workflows.js and ar.json display exact context/unknown modes and escape original values.
The workspace guide retains the independent allocation boundary. Three backend, two UI, one compiler and one
real-SDK regression cover the source omission, unknown modes, original hierarchy, schema parity and revoked
continuations. A shared synthetic fixture serves backend and SDK checks. Related 31/31/0/0, 11 GETs/no writes.
See [qualification and limits](DELIVERY-2026-10-04-LINKEDIN-BUDGET-CONTEXT.md). Native and 13/14/1 package totals remain unchanged.

## Batch 131 — current native upload references

New src/meta-asset-usage.ts composes only existing Meta account/ads GET contracts. Original safe asset metadata,
exact account/creative/ad identities, current authority and source fingerprints bind bounded pages and encrypted
continuations. creative-library.ts projects supported metadata; service.ts/media-upload.ts expose the workflow
and repair read-only media discovery. workflow-outcomes.ts adds original-asset links and typed read continuation.
creative-library.js uses the shared current-view page loader with an asset guard; selected first-party meanings
and refusals localize through a finite checked set. Native diagnostics and wire values remain unchanged.
Eleven backend, two authenticated HTTP, four UI, one discovery and one SDK regressions qualify these paths;
related suite 145/145/0/0. The selected official SDK field matrix and synthetic transports do not certify live
eligibility, historical attribution, unsupported creative formats or point-in-time reconciliation. See
[delivery](DELIVERY-2026-10-04-NATIVE-ASSET-REFERENCES.md). Native ledger and 13/14/1 package totals remain unchanged.

## Batch 132 — chronological efficiency diagnostics

New src/allocation-calibration.ts qualifies bounded exact original daily history and keeps every training/test
date, unknown ratio, rational error and empirical factor band. report-allocation.ts shares its existing complete/
native source/grain/current-calendar/freshness gates without changing allocation semantics. decision-reporting.ts
advertises and dispatches only the read action, with final current account/actor checks. report-allocation.js
adds explicit reader-compatible bilingual evaluation/use, source-bound pending-result guards and old model/native
callback invalidation. report-quality.js/check-locales.mjs translate only the selected authored set; original
provider messages and IDs remain exact. Fourteen backend, five UI, one full-panel integration, one authenticated
HTTP and one real-SDK regression qualify these paths; related set 119/119/0/0. Zero native requests, saved records
or advertising mutations occur from calibration. See [method and qualification](DELIVERY-2026-10-04-ALLOCATION-CALIBRATION.md).
The diagnostic does not certify future forecasts, causal budget effects, real load, new browser/assistive or
deployed/provider acceptance. Native ledger and 13/14/1 package totals remain unchanged.

## Batch 133 — indexed schedule selection and actual worker contention

New src/scheduled-work.ts selects due candidates under the original tenant/kind/order and handles failure only
for the exact attempted revision. ReportWorker and ReportingOverview share it; store.ts adds two schema-2
indexes inside serialized bootstrap. Existing creator authority, native effects, timing, de-duplication and
leases remain. F-203's two failing races use a second SQLite connection. Eight backend/five actual child-process
checks qualify projection/coercion/upgrade/backup, pending revocation, expired generations and owned databases.
Two no-input synthetic benchmarks measure independent schedule scans and one/four-worker contention without
provider actions or production settings. Related **3,386/3,381/0/5**. See [delivery and limits](DELIVERY-2026-10-04-SCHEDULER-WORKERS.md);
native and 13/14/1 package totals unchanged.

## Batch 134 — exact X price projections and legacy recovery

src/x-catalogs.ts now preserves the existing accepted decimal range with bounded internal integers and canonical
string money views. x-catalog-products.ts uses exact sale ordering and rejects non-string native prices; product
sets inherit exact price/sale-price filter projections. reviewed-family.ts/write-verification.ts add optional
family cache versions without changing other families, retaining original accepted receipts and current authority.
The existing X fixture exposes its synthetic service/actor to a real SDK evaluator. A shared price fixture and
15 new backend/set/SDK checks qualify stale reviews, old caches, stable read-back mismatch and original-key
recovery; ordinary native catalog tests retain exact wire fields. Focused 34/34/0/0; zero external requests.
See [delivery and limits](DELIVERY-2026-10-04-X-CATALOG-PRICES.md). No native action/family/scope is added and
the 13 implemented / 14 partial / one open roadmap count remains unchanged.

## Batch 135 — source-product adapter and bilingual X workflow

catalog-ingestion.ts composes bounded explicit source products into existing X per-SKU PUT steps;
x-catalog-products.ts shares the same pure native field validator without granting ownership. workspace.ts
updates discovery meaning; campaign-runner.ts corrects F-205's generic product approval wording. The actual
account-workflows.js supplier parser/mapping/controller now selects Meta/X, preserves native strings, refuses
unsupported canonical headers and fences pending scope/form changes. Finite known messages/refusals localize
through check-locales.mjs and ar.json; shared deterministic UI fixtures retain existing Meta tests. Six backend,
five UI, one approval and one real-SDK regression qualify the bounded scope, with final focused **78/78/0/0**.
See [delivery and remaining scope](DELIVERY-2026-10-04-X-CATALOG-IMPORT.md). No action/family/scope or entitlement
is added; live stores, other mappings and full reconciliation/deletion remain partial.

## Batch 136 — bounded X source comparison and native group evidence

New x-catalog-comparison.ts composes only existing owned internal GETs with shared complete repeated product
scans, current authority, exact prices, finite response projection and collection bounds. catalog-comparison.ts
dispatches X without changing the Meta adapter. x-catalogs.ts shares a pure group classifier; native product
before-state retains both original group fields and prevents hidden/unknown absence or grouped upserts (F-206).
workspace.ts advertises exact bounds. account-workflows.js validates/renders X differences and source subsets
with existing form/view guards; ten authored messages localize. Eight backend, four controller, one real-SDK
and three native guard checks qualify the scope; final focused **107/107/0/0**. See
[delivery and limits](DELIVERY-2026-10-04-X-CATALOG-COMPARISON.md). Native/roadmap totals remain unchanged.

## Batch 137 — shared X native identity boundaries

x-catalogs.ts enforces exact unique collection identities, explicit parent consistency, literal cursors/count
bounds and complete manual membership without added reads. Existing four native families share identity-v3
cache versions, exact outcome IDs and uncoerced original create receipts; native bodies, price/group semantics
and accepted receipt recovery remain. Eight native/lifecycle and one real-SDK checks qualify the correction;
final focused **82/82/0/0**. The existing decimal regression now expects the current v3 marker. See
[delivery and upgrade behavior](DELIVERY-2026-10-04-X-CATALOG-IDENTITIES.md). No action/family/scope is added;
native and 13/14/1 roadmap totals remain unchanged.

## Batch 138 — selected product deletion provenance and recovery

x-catalog-removal.ts composes existing owned X source comparisons into bounded expiring previews and guarded
local single-key DELETE plans, including current-authority signatures, exact creation provenance, concurrency,
original plan association recovery and unsent product checks. workspace.ts publishes two actions and typed
selection; campaign-runner.ts binds/checks them without changing accepted native recovery; campaign-view.ts
keeps compact original-scope provenance. account-workflows.js renders unchecked per-SKU controls and guarded
English/Arabic exact-key preview/save. check-locales.mjs narrowly validates the new authored meanings/refusals,
including literal fallback copy while retaining original native diagnostics. Eleven backend, three controller
and one real SDK checks plus 329 related regressions qualify the scope. See [delivery](DELIVERY-2026-10-04-X-CATALOG-REMOVAL.md).
No new native action/family or live/browser/entitlement claim is added.

## Batch 139 — maintained release source gate

verify-public-release.mjs provides bounded manifest/path/regular-file/HEAD/blob/sample/report verification and
read-only proof output. package.json exposes `release:verify`; checks.yml requires and uploads its proof before
other gates. Dockerfile includes Git in the build stage for six real-Git failure-mode fixtures, covering Arabic/space
paths and filter-masked CRLF alongside existing private-sample assembly checks. No provider contract, deployment
mutation, private root sample or new supported native route is involved. See [delivery](DELIVERY-2026-10-04-RELEASE-SOURCE.md).

## Batch 140 — Google Search value bidding and exact native target proof

campaign-recipes.ts, recipe-values.ts, capability-eligibility.ts, recipe-context.ts and recipe-eligibility.ts add
explicit account-recorded values and bounded ratio-text ROAS through existing paused native families.
verification-reads.ts/write-verification.ts correct F-208 typed target/default proof and scoped cache retirement
without changing accepted wire requests or receipt recovery. campaign-runner.ts publishes their accurate MCP
description. campaign-recipes.js/client-playbooks.js and authored Arabic copy render explicit choices and
exact readable previews. Twelve backend, three bilingual controller and one real SDK tests cover both modes;
capability and contract-example loops qualify every discovered recipe. Related suite: 237/237/0/0.
See [delivery](DELIVERY-2026-10-04-GOOGLE-VALUE-RECIPES.md). Delivered values/history and live/provider/browser
acceptance remain separate; no new native route, scope or provider action is introduced.

Batch 140 upgrade follow-up also guards retired value proofs in pending plans through original receipts;
current and historical completed behavior is retained. evidence-index.test.mjs validates its uniquely created
real temporary path before bounded cleanup retries after the full candidate exposed ENOTEMPTY on Windows.
Focused value/controller/SDK/evidence-index suite: 47/47/0/0. No production retention path is changed.

Final batch 140 related suite: 248/248/0/0. Corrected full sanitized gates: main 4,191/4,186/0/5; capture 4/4/0/0. All three public reports regenerated unchanged and retained their bytes. Exact committed qualification follows separately.

## Batch 141 — current primary conversion values

google-goal-inspection.ts privately selects three optional value settings for the two value recipes, projects
typed original values/currency/overrides, includes them in repeated-state hashes and calculates readiness from
the full matched collection. Original queries, authority and budgets remain. capability-eligibility.ts and
recipe-eligibility.ts declare the narrow configuration dependency; campaign-runner.ts/recipe-context.ts explain
it. campaign-recipes.js renders an escaped scope-bound bilingual accessible table, and controller fixtures use
the real localization module. Eight backend, two controller and one real SDK additions qualify the feature;
combined focused 55/55/0/0 and final related 156/156/0/0. See
[delivery](DELIVERY-2026-10-04-GOOGLE-VALUE-INSPECTION.md). No new provider action, event read or write scope is added.

Batch 141 sanitized gates: main 4,202/4,197/0/5; capture 4/4/0/0. All three public reports regenerated unchanged and retained their exact bytes. Final committed source proof and full qualification follow separately.

## Batch 142 — aggregate Google activity dates

Covered selected v25 optional metrics, exact action joins, original timezone/date strings, complete repeated
collections, collection/authority/brief limits, null/empty/missing observations and whole-primary counts;
bilingual current-scope rendering, real localization and SDK schema/text parity with source/receipt boundaries.
Focused 66/66/0/0; related 159/159/0/0; website checks passed. See
[delivery record](DELIVERY-2026-10-04-GOOGLE-CONVERSION-ACTIVITY.md). No native/package totals change or live verdict.

Batch 142 fresh sanitized full gates: main 4,213/4,208/0/5, capture 4/4/0/0; all three public reports regenerated unchanged and retained their exact bytes. Final committed source proof and qualification follow separately. Actual browser runtime remains unavailable after a fresh attempt.

## Batch 143 — selected original Google image references

Covered exact uploaded account/IMAGE/receipt/SHA identity, optional native link flags and manager presence,
complete repeated collections and result counts, native hierarchy/string IDs, bounded rows/bytes/time/attempts,
current source/session/key/login/scopes/credentials, reader and disabled-write access, overflow refusal and
synthetic native retries. Added Google-specific bilingual bounds/table/limits, real localization, authenticated
HTTP CSRF/session boundaries and real MCP schema/text/asset-handoff qualification. Focused **42/42/0/0**; web checks
passed. See [delivery record](DELIVERY-2026-10-04-GOOGLE-IMAGE-REFERENCES.md). No provider/program/package total or live verdict changes.

Batch 143 sanitized full gate: main 4,229/4,224/0/5; capture 4/4/0/0. Final report regeneration/freshness and byte preservation passed. Final committed source and full checks follow separately.

## Batch 144 — selected Performance Max image-group references

Covered exact original IMAGE/source/SHA/client/account and group/campaign hierarchy, native link/parent modes,
explicit view selection, enabled/paused/removed/unknown semantics, duplicate and malformed metadata, complete
matching order-independent collections, bounds/count gaps/continuation, current authority/source withdrawal,
default/Meta separation, bilingual original IDs/escaping/counts, selector/limit invalidation and response-order
guards, authenticated viewer/CSRF/no-store and actual SDK discovery/schema/text/original handoff/revocation.
Focused 54/54/0/0; related 28/28/0/0; website checks passed. See [delivery](DELIVERY-2026-10-04-GOOGLE-PMAX-IMAGE-REFERENCES.md). Native/package totals
and real acceptance states are unchanged.

Batch 144 sanitized full gate: main 4,241/4,236/0/5; capture 4/4/0/0. Final report regeneration/freshness and byte preservation passed. Final committed source and full checks follow separately.

Batch 143 exact CI198 (af9167b): maintained 1,732-source/one-empty/three-report proof, host and Docker 4,229/4,229/0/0, both capture suites 4/4/0/0 and all twenty steps/synthetic smoke gates passed. Batch 144 still requires its own committed-source and CI qualification.

## Original Performance Max campaign logos and exact view handoffs

Batch 145 adds explicit `amcp_media {action:"asset_usage",asset_id,reference_view:"performance_max_brand",limit:50}`
through current original-account `campaign_asset` associations. Exact campaign/image identity, explicit
PERFORMANCE_MAX channel and literal enabled brand mode are required. LOGO/LANDSCAPE_LOGO enabled/paused
configuration is separate from removed and unknown/non-logo links. Campaign links are not ads or asset groups.
The existing six-read brackets, repeated complete collections, original source/authority fences and shared
1–1000/24-attempt/2,100-row/4MiB/60-second bounds remain. Ad and asset-group views stay independent; Meta
paging is preserved. No advertising write, snapshot or serving/policy/history/performance claim is added.

The bilingual chooser/table exposes exact original IDs, escaped names and scoped statuses/counts. Qualified
Google MCP links preserve the chosen view and numeric bound on the original asset; current explicit website
edits preserve bounded URL choices and selecting another asset clears them. Handoffs make no native read
until the user chooses it. Backend/outcome, authenticated viewer, real SDK and localized controller checks
pass. Combined regression: 68/68/0/0. SDK: three tool calls, 7,571 structured bytes, six synthetic native reads,
zero external requests/mutations. Website: 34 scripts, three pages, 3,452 selected Arabic messages; all 3,646
previous catalog values are preserved, with eleven new entries. Full sanitized release checks follow
separately. Actual browser/assistive/deployed/provider acceptance and the full plan remain open.

Batch 144 exact CI199 (fd4a016): maintained 1,735-source/one-empty/three-report proof, host and Docker 4,241/4,241/0/0, both capture suites 4/4/0/0 and all twenty steps/synthetic smoke gates passed. Batch 145 still requires its own committed-source/CI qualification.

Batch 145 sanitized full gate: main 4,255/4,250/0/5; capture 4/4/0/0. Final report regeneration/freshness and byte preservation passed. Final committed source and full checks follow separately.

## Batch 146: explicit WooCommerce product-source evidence

Read-only current store metadata and 1–50 explicitly selected published WooCommerce products now feed
the existing reviewed Meta supplied-product workflow. Native selected price and store currency remain
exact, four fixed HTTPS reads repeat/bracket evidence, authenticated egress uses checked public sockets
with no redirects, and current actor/account/origin/API/permission/key identity is fenced throughout.
Complete native selection/counts, malformed body/overflow/changed source and sandbox checks are explicit.
Unsupported source types/delivery/missing SKU/image/price precision/duplicate SKUs stay visible blockers.
Bilingual unchecked selections, exact fields, stale-view guards and original MCP handoff pass synthetic
checks; X still requires full explicit CSV fields. No actual store credentials, provider write or production
settings were accessed. [Delivery evidence](DELIVERY-2026-10-04-WOOCOMMERCE-SOURCE.md). Combined focused 100/100/0/0; related 3,256/3,251/0/5;
SDK seven calls/8,318 structured bytes/four synthetic reads/one unapproved draft/zero external or mutation.
Website 34 scripts/three pages/3,500 selected Arabic messages; 3,657 previous values preserved plus 48.
Full sanitized/current-source evidence follows independently. B21 remains partial for live acceptance,
store setup, additional destinations, full/variant inventory and absent-source deletion policy.

Previous exact CI200 (dcaedc3) decoded and verified: 1,738 public Git blobs/one empty sample/three reports,
Linux and Docker main 4,255/4,255/0/0, both capture suites 4/4/0/0 and all twenty steps/synthetic smoke modes
successful. No later-source/deployed/browser/live acceptance is inferred.

Batch 146 sanitized full gate: main 4,273/4,268/0/5; capture 4/4/0/0; early report freshness, final regeneration and report byte preservation passed. Final committed source and full checks follow separately.

## Batch 147: original Snapchat top-snap creative references

Exact original image/video UUID upload receipts and SHA-256 now support current literal creative media
references outside retained AMCP plans. Original account/media observations bracket two complete bounded
creative collections. Fixed account GETs, native page size 50, exact current credential/scope/source fences,
foreign/partial/duplicate/cursor/overflow refusals and shared bounds prevent incomplete results. No native
write, retained reference snapshot or standalone ownership grant is added. Packaging/review/media statuses
remain separate from ad delivery; nested references and history remain outside the view. Bilingual explicit
reads keep exact escaped fields and original bounded MCP handoffs with stale-view refusal.
[Delivery evidence](DELIVERY-2026-10-04-SNAPCHAT-TOP-SNAP-REFERENCES.md). Combined reference regression 81/81/0/0 (18.866 seconds); real SDK four calls,
7,350 structured bytes, six synthetic native reads and zero external/mutation. Maximum positive search:
1,000 creatives, original media at 1,000-row bound, 82 requests/4,002 rows. Website 34 scripts/three pages/
3,535 selected Arabic messages; all 3,705 previous values preserved plus 36 (3,741 total).

An archive-size/digest-verified ignored FFmpeg/ffprobe dependency runs every previously skipped local media
case: 20/20/0/0 with required FFmpeg, synthetic flat-color media and unchanged reviewed upload bytes.
CI201 failed twice before runner assignment or any step. The owner confirmed exhausted Actions minutes
and explicitly directed continuing without CI; no further retries. Authorized batch tips use [skip ci];
local exact-source release/report gates remain. Previous CI200 qualifies only dcaedc3. New Linux/Docker,
actual browser/assistive, deployed/provider acceptance and the remaining full plan are separate.

Batch 147 sanitized full gate: main 4,293/4,293/0/0; capture 4/4/0/0; required local FFmpeg, early report freshness, final sanitized regeneration and byte preservation passed. Exact committed source and full checks follow separately. Hosted CI is skipped at the owner's direction.

## Batch 148: complete Meta catalog product field proof

F-209's three synthetic provider-discard cases falsely verified group key, custom label and sale date
(3/0/3/0, 955.591 ms). Complete fixed original-catalog/retailer/receipt-bound observation now covers all
35 accepted observable fields with typed exact inventory, ordered additional images and literal date
text. Before/after 3/3/0/0 (5.805 seconds); combined catalog/cache/Google-value/X regression 72/72/0/0
(20.744 seconds). Ten added tests include current v26.0.2 SDK models, malformed/missing/changed fields,
original receipt replay, legacy-cache retirement and pending dependency refusal. Real SDK five calls,
21,805 structured bytes, eleven synthetic reads, one synthetic mutation and zero external requests.
[Delivery and limits](DELIVERY-2026-10-04-META-CATALOG-FIELD-PROOF.md).

Pending chains read the current family verification version before relying on retired proof, preserving
original accepted keys/receipts and completed historical records. Twenty-two authored catalog diagnostic
translations preserve every previous value; website 34 scripts/three pages/3,557 selected messages.
All 3,741 prior catalog entries remain, with 3,763 total. Product-group semantics, full variant/store
reconciliation, live/deployed/browser/assistive acceptance remain separate; packages stay 13/14/1.
Owner-directed no-CI releases continue with full fresh sanitized local source/report checks and required
FFmpeg. The final source-specific gates follow separately.

Batch 148 sanitized full gate: main 4,303/4,303/0/0; capture 4/4/0/0; required local FFmpeg, early report freshness, final sanitized regeneration and byte preservation passed. Exact committed source and full checks follow separately. Hosted CI is skipped at the owner's direction.

## Batch 149: actual local rendered workflow qualification

Eight observed reflow/focus/table defects F-210–F-217 are corrected using actual isolated Chromium
journeys and original first-party source. The maintained runner and synthetic fixture use current served
controllers/APIs, 132 selected cases/27 paths, exact native values, no implicit provider reads, unchecked
selections and stale source/limit clearing. Public privacy retains its English policy scope. See [rendered qualification and limits](DELIVERY-2026-10-04-RENDERED-WORKFLOWS.md).

The 36 narrow About/navigation/source/reference/catalog-plan regressions pass with no failures/skips;
final rendered and source-specific full release results are recorded separately. Browser evidence is
local headless Chromium 148.0.7778.96/Playwright 1.62.1, separate from assistive technologies, other
engines/devices, production/provider acceptance and current Linux/Docker checks. No actual credentials,
root private sample or live database is read. B16/B24 remain partial; the owner-directed no-CI workflow
retains all fresh sanitized source/report/FFmpeg/full local gates.

## Batch 149 sanitized full release preflight

Fresh offline install/build/early report freshness/full checks/Railway passed with every exit zero.
Main **4,303/4,303/0/0 in 146.564 seconds**, capture **4/4/0/0 in 87.288 ms**;
required FFmpeg ran every media case. Website checks cover 34 scripts, three pages and 3,557 selected
Arabic messages; documentation index 317. All three sanitized public reports regenerated unchanged
and preserved their bytes. The private root sample was not read. Source manifest contains 1,761
public files plus one generated literal empty sample, hash
`eb5682b3b5db8df0ec5992b8566ab4451ca11fa629f58d305e257f3a10b3d492`. Exact committed-source and rendered gates follow before the sole Work-here
push; hosted CI remains owner-paused. The full remaining plan continues.

## Batch 150: selected commerce readability and source/native agreement

Fourteen of sixteen actual baseline product-column measurements failed at the original source; all
sixteen now retain at least 192 pixels without whole-page overflow. Two of four baseline contract tests
failed; shared native field validation and preserved whitespace blockers address those mismatches.
Eight focused suites pass 75/75/0/0, including original values, bilingual blocked selections and native
lifecycle behavior. See [commerce readability and contract evidence](DELIVERY-2026-10-04-COMMERCE-READABILITY.md). B16/B21/B24 remain partial; no live, full-inventory, variant,
assistive, deployed or current Linux/Docker acceptance is inferred.

## Batch 150 full local release preflight

Fresh offline install/build/early report freshness/full checks/Railway all passed; main
4,308/4,308/0/0 in 168.879 seconds and capture 4/4/0/0 in 77.489 ms.
Required FFmpeg ran all media cases. Source manifest 1,763 public files plus one generated literal
empty sample, hash 8fa4f3507cdbaafd7ec3594ee7091076fc9204aaaa2b9bdec6251ead9fccbb23. The three sanitized public reports regenerated
unchanged and preserved their bytes; the private root sample was unread. Website checks cover 34
scripts, three pages and 3,559 selected interface messages; documentation index 318.
Actual working-tree rendered QA passes 132/132/0, including 16 readable product-label cases, from
2026-10-04T17:49:56.523Z through 2026-10-04T17:52:18.712Z. Website digest
161c000455d15ad5032231ac0e1e3724e93d4e328379fbb9a78c21e93bb072da; this identifies the served working-tree bytes, not the earlier
Git base as qualification of uncommitted code. Fresh exact clean-HEAD and browser gates follow
before the sole Work-here push. Hosted CI remains owner-paused; remaining plan work continues.

## Batch 151: full static Arabic privacy and public language selection

All eight policy sections have authored Arabic counterparts with matching paragraph/list/emphasis,
technical scopes/methods, linked destinations, anchors and date. Public GET/HEAD support exact en/ar
selection and deterministic invalid/repeated fallback without authentication, session cookies,
JavaScript or provider access. Existing English article bytes and Arabic interface entries remain.
Five focused suites pass 31/31/0/0; eight no-script rendered views and inspected screenshots support
the selected layout. Maintained browser cases extend to 136. See [Arabic privacy delivery and boundaries](DELIVERY-2026-10-04-ARABIC-PRIVACY.md). B16/B24 stay partial;
structural/rendering checks do not establish human legal/editorial, assistive, deployed or live acceptance.

## Batch 151 final local release preflight

Fresh offline install/build/early report freshness/full checks/Railway passed after the canonical
metadata correction. Main 4,312/4,312/0/0 in 150.741 seconds; capture 4/4/0/0
in 74.568 ms. Required FFmpeg ran every media case; website checks cover 34 scripts,
four pages and 3,559 selected interface messages, docs index 319. Source manifest: 1,766 public
files plus one generated literal empty sample, hash 9640e9159a78c22037c65fe6af49a50d36f195981399844157bd9361fc5cba5f.
All three sanitized public reports regenerated unchanged and preserved their bytes; the root private
sample was unread. English policy article and the entire Arabic interface catalog are unchanged.
Final working-tree browser QA passes 136/136/0 from 2026-10-04T18:19:36.569Z through
2026-10-04T18:22:24.574Z; website digest f4808ec7e260df1ab14b171812038a4f2abd50bedc358b3fbab142e9af4f1ba5 includes the new static
Arabic page. These served working-tree bytes are identified separately from their earlier Git base.
Earlier 136-case developer runs and the 4,311-test pre-canonical candidate remain diagnostic history;
this final record supersedes them. Fresh exact clean-HEAD/source/browser gates follow before the sole
Work-here push. Hosted CI remains owner-paused; full-plan work continues.

## Batch 152 — explicitly selected WooCommerce variations

Read-only six-GET sources preserve exact parent membership, original child attributes/SKU/price and
currency, with shared current-authority/deadline/body bounds. Eligible children need an explicit
reviewed destination title and unchecked selection before the shown native parent SKU maps to Meta
retailer_product_group_id. Group intent is displayed, compared and retained in the original unapproved
draft; existing complete field proof and per-child native review/receipts remain. Eighteen authored
Arabic entries preserve all previous 3,765 pairs. Current-authority interruption, 50-child bounds,
changed hierarchy, original native values, real SDK and bilingual stale-response checks are recorded
in [delivery evidence](DELIVERY-2026-10-04-WOOCOMMERCE-VARIATIONS.md). The maintained browser runner adds eight variation cases.
Fresh full/source/browser release proof follows. B15/B16/B21/B24 remain partial; full-plan work continues.

## Focused and rendered qualification

The combined twelve-suite check passes 55/55/0/0 in 6.008 seconds, including group comparison and
the unchanged standalone/X workflows. The maintained served-browser runner passes 144/144/0
from 2026-10-04T19:04:07.440Z through 2026-10-04T19:06:49.833Z; all eight new variation journeys
complete twelve fake GETs (two explicit six-GET source reads), exact local title/group previews,
unchecked rereads and title/parent invalidation with zero provider writes or external egress.
Actual English 1280 and Arabic 375 screenshots were inspected; original long fields remain in
captioned keyboard-scroll regions. Source-label widths and both directions retain their measured
checks. Website digest 547dd3bae56f595fed1f8a4b7d3bce0e7bd4765a6b0e4b4374bdc67212b613c0 records the served working-tree bytes;
its Git base is not claimed as qualification of uncommitted changes. Fresh sanitized report generation
passes after local build; all three validated public artifacts regenerated unchanged. The root
private sample was unread. Full required-FFmpeg and clean committed-source/browser gates follow.

## Batch 152 full local release preflight

Fresh offline install/build/early report freshness/full checks/Railway pass: main
4,328/4,328/0/0 in 146.264 seconds, capture 4/4/0/0 in
70.935 ms. Required FFmpeg runs all media cases with zero skips. Website
checks cover 34 scripts, four pages and 3,576 selected messages; docs index 320. The sanitized
source manifest contains 1,773 public files plus one generated literal empty sample, hash
93cd654b1eba87495e222e1220d6aab37f90959c11ed8a85dca4aec2d27ba3aa. All three public report artifacts regenerate unchanged and preserve
their bytes throughout full checks; the root private sample remains unread. The 144-case actual
working-tree browser proof remains bound to website digest 547dd3bae56f595fed1f8a4b7d3bce0e7bd4765a6b0e4b4374bdc67212b613c0.
Fresh clean committed-source/default/browser qualification follows before the sole Work-here push.
Hosted CI remains owner-skipped; the remaining improvement plan continues.

## Batch 153 — exact Meta group CSV mapping and source controls

Canonical and explicitly mapped supplier CSVs retain an optional native Meta group without inferred
parent relationships, omitted-row changes or private-column disclosure. X/unknown destinations
refuse group intent. Loaded mappings bind exact destination scope, changed scope/file/view invalidates
old results and WooCommerce mode hides unrelated CSV layout controls. One authored Arabic message
preserves all 3,783 earlier pairs. Real MCP, bilingual controllers and eight added served-browser
cases qualify selected source-to-unapproved-plan behavior. See [evidence](DELIVERY-2026-10-04-META-GROUP-CSV.md).
Fresh full/source/browser gates follow; B15/B16/B21/B24 remain partial and the whole plan continues.

## Final focused and rendered evidence

The combined twelve-suite check passes 49/49/0/0 in 5.841 seconds, including unchanged source/
variation/X/native group comparison contracts. The real SDK journey measures seven calls and
9,481 structured response bytes, two local unapproved drafts and zero native/external reads
or provider writes. Final served browser proof after exact destination-column binding passes
152/152/0 from 2026-10-04T19:35:55.905Z through 2026-10-04T19:39:33.258Z; website digest
95e33d345d98054963f28148778cc9b200561d8c3196f0ac6b41fd31350526fe. All eight group-CSV cases retain exact source fields, explicit
local previews and current comparisons; sixteen WooCommerce cases check hidden unrelated CSV
controls. Earlier developer 152-case proof remains diagnostic history and does not qualify the
subsequent destination-binding change. English 1280 variation and Arabic 375 supplier screenshots
were inspected; native data stays in the existing captioned keyboard-scroll regions.
Fresh local build and sanitized report generation pass; all three validated public artifacts
regenerate unchanged. The private root sample remains unread. Full required-FFmpeg and clean-HEAD
source/browser gates follow separately before the sole Work-here push; whole-plan work continues.

## Batch 153 full local release preflight

Fresh offline install/build/early report freshness/full checks/Railway pass: main
4,333/4,333/0/0 in 145.161 seconds, capture 4/4/0/0 in
82.209 ms. Required FFmpeg runs all media cases with zero skips. Website
checks cover 34 scripts, four pages and 3,576 selected messages; docs index 321. The sanitized
source manifest contains 1,776 public files plus one generated literal empty sample, hash
4c6429f0b33bb3cae502315e58be5050ffb37d87ded985be25ed0516c1d91ae6. All three public report artifacts regenerate unchanged and preserve
their bytes throughout full checks; the root private sample remains unread. The 152-case final
working-tree browser proof binds website digest 95e33d345d98054963f28148778cc9b200561d8c3196f0ac6b41fd31350526fe.
Fresh clean committed-source/default/browser qualification follows before the sole Work-here push.
Hosted CI remains owner-skipped; the remaining improvement plan continues.

## Batch 154 — populated GA4 event layout

Sixteen actual selected tables lacked captions and ten had compressed event labels. Existing
authored captions, scoped readable columns and literal LTR native values now improve English/Arabic
summary/minute views. Eight maintained rendered journeys preserve exact large counts, unknown missing
events, explicit-only reads and changed-window invalidation. No contract/permissions/tracking-health
meaning changes; all 3,784 Arabic pairs remain byte-identical. See [evidence](DELIVERY-2026-10-04-GA4-EVENT-LAYOUT.md).
B16/B20/B24 stay partial and the full remaining plan continues.

## Final focused and rendered evidence

Final served Chromium qualification passes 160/160/0 from 2026-10-04T20:03:22.025Z through
2026-10-04T20:07:05.910Z, website digest fbdad7fd0489c02ae4175f75a719071fe524007b15401ef6357c80bbba8aac0d. All eight GA4 cases
retain exact aggregate 9007199254740995 and authored unknown-count text, two original minute rows,
captioned readable event labels, actual keyboard scrolling and changed-window invalidation.
Navigation/control changes start no report; each case makes two explicit synthetic report reads
and zero native writes/external requests. Focused backend/bilingual/identity/controller checks
pass 57/57/0/0 in 2.961 seconds. Independent geometry checks measure sixteen captioned table
instances at 192–312.203 CSS pixels for event labels. Arabic 375 and English 1280 result screenshots
were inspected. All 3,784 Arabic catalog pairs retain exact previous bytes.
Local build and sanitized report generation pass; all three public artifacts regenerate unchanged.
Full required-FFmpeg and exact committed-source qualification follow before the sole Work-here push.
Hosted CI stays owner-skipped; remaining plan work continues.

## Batch 154 full local release preflight

Fresh offline install/build/early report freshness/full checks/Railway pass: main
4,333/4,333/0/0 in 129.860 seconds, capture 4/4/0/0 in
74.354 ms. Required FFmpeg runs all media cases with zero skips. Website
checks cover 34 scripts, four pages and 3,576 selected messages; docs index 322. The sanitized
source manifest contains 1,778 public files plus one generated literal empty sample, hash
7a989de363bd71c6b14abf0e92eefdbc1ac7bb6a764bff67c79768493ae6ed02. All three public report artifacts regenerate unchanged and preserve
their bytes through full checks; the private root sample remains unread. The final 160-case
working-tree browser proof binds website digest fbdad7fd0489c02ae4175f75a719071fe524007b15401ef6357c80bbba8aac0d.
Fresh clean committed-source/default/browser qualification follows before the sole Work-here push.
Hosted CI remains owner-skipped; the remaining improvement plan continues.

## Batch 155 — bounded retained-row browsing and full workbook journey

Explicit 10/25/50/100-row choices reduce long pages while retaining active search, original source
and totals, pending-control/response fences and scoped retry. Visible native identity columns use
readable scoped row headers; local hiding/restoring preserves original values. Four meaningful
feature regressions, a four-call measured real SDK journey and eight added actual served-browser
workflows qualify page/search/column and filtered-view-to-all-151-row workbook delivery. One
authored Arabic message preserves all 3,784 earlier pairs. See [evidence](DELIVERY-2026-10-04-RETAINED-ROW-BROWSING.md).
B15/B16/B18/B24 stay partial; whole-plan work continues.

## Final focused and rendered evidence

Final served Chromium qualification passes 168/168/0 from 2026-10-04T20:33:19.231Z through
2026-10-04T20:37:20.326Z, website digest c8458c33fde298b8543dd4a9dcdb943da5707f6bc94d0901d3c466bd7ced3859. All eight retained-evidence
cases exercise explicit 25-row/next/final/search/empty/clear and local column choices. Eight actual
current-language downloaded workbooks retain every original row, 1,208 inspected rows in total,
exact text IDs/money/full totals/native headers/unknown cells and selected worksheet direction.
Two thousand actual native cell ranges remain on one line within keyboard-scrollable regions;
full page reflow and focus checks pass. Scoped row headers measure 192 pixels in all eight views.
Arabic 375 and English 1280 filtered screenshots were inspected. Earlier developer 168-case proof
remains diagnostic history and does not qualify the subsequent single-line native-value refinement.
Focused checks pass 49/49/0/0 in 2.754 seconds; the real SDK journey measures four calls/9,994 response
bytes, retained 151-row scope, filtered/full-last bounds and revoked-client refusal. No provider
request, mutation or write review occurs. All 3,784 earlier Arabic pairs retain original values,
with one authored addition. Local build and all three sanitized public artifacts regenerate unchanged.
Full required-FFmpeg and exact committed-source checks follow before the sole Work-here push.
Hosted CI remains owner-skipped; the full remaining plan continues.

## Batch 155 full local release preflight

Fresh offline install/build/early report freshness/full checks/Railway pass: main
4,338/4,338/0/0 in 160.049 seconds, capture 4/4/0/0 in
77.771 ms. Required FFmpeg runs all media cases with zero skips. Website
checks cover 34 scripts, four pages and 3,577 selected messages; docs index 323. The sanitized
source manifest contains 1,781 public files plus one generated literal empty sample, hash
9436a5cc01f014b5eca00bb48ace362acef13178d58f8e2e65926459d3768481. All three public report artifacts regenerate unchanged and preserve
their bytes through full checks; the private root sample remains unread. The final 168-case
working-tree browser proof binds website digest c8458c33fde298b8543dd4a9dcdb943da5707f6bc94d0901d3c466bd7ced3859.
Fresh clean committed-source/default/browser qualification follows before the sole Work-here push.
Hosted CI remains owner-skipped; the remaining improvement plan continues.

## Batch 156 — native Google keyword/day evidence

A fifth Google detailed preset retains positive Search keyword_view × day performance, literal native
text/match type and full view identity through the existing v25 Search read. Exact criterion/parent/day/
count/immutable-metadata checks, current authority around every read and bracketed account/page hashes
precede persistence. Authored bilingual scope/filter labels and optional native workbook columns preserve
all earlier catalog values and report formats. Six focused suites pass 62/62/0/0; the real SDK journey
measures five calls/37,253 response bytes and four synthetic native reads, with no effects/plans/reviews.
See [research, workflow and qualification](DELIVERY-2026-10-05-GOOGLE-KEYWORD-EVIDENCE.md). B18/B27 and connected B15/B16/B24 remain partial;
full package counts stay 13 implemented / 14 partial / one open. Hosted CI stays owner-skipped.

## Final local release and rendered qualification

Fresh sanitized offline install/build/early report freshness/full checks/Railway pass: main
4,351/4,351/0/0 in 137.482 seconds; capture 4/4/0/0 in
78.547 ms. Required FFmpeg exercises all media cases with zero skips.
There are 1,785 public sources plus one generated literal empty sample; preflight source hash
1b869a433312a0d24b42a86a18f6661b44ab3ebf691c883b6bf2c5d1f80316b3. Three public report artifacts regenerate unchanged and preserve exact
bytes throughout full checks; the root private sample stays unread. Web checks cover 34 scripts /
four pages / 3,581 selected messages; documentation index has 324 documents.

The maintained final-source browser suite passes 176/176/0 from 2026-10-04T21:13:48.450Z through
2026-10-04T21:18:49.723Z; website digest 4f1c0dd4b3a09507ad6c94c40ea8c52ded857b446013b41acc08adbb5106b097. All eight new keyword
journeys retain text-first context, literal match type/resource IDs, four explicit synthetic native
reads, one-row retained match filtering and all four original XLSX rows. Thirty-two original
keyword/day workbook rows are inspected; original eight retained-report cases still inspect 1,208
workbook rows and 2,000 native single-line cell ranges. Row headers measure at least 192 pixels;
named-region keyboard scrolling, skipped-main/drawer focus and contained page reflow pass.
No provider mutation or external provider request occurs. Earlier diagnostic/mixed-source runs do
not qualify this final revision. Arabic 375 context-first and English 1280 filtered screenshots
were inspected, with keyboard-scrolled table positions distinguished from page reflow.
Fresh clean committed-source/default/browser checks follow before the sole Work-here push. Hosted
CI remains owner-skipped. Full-plan work and broader external acceptance remain separate.

## Batch 157 — readable report controls and phone layout

Measured 21–29-pixel native report fields with inherited 11-pixel type now use scoped readable labels,
16-pixel fields, usable dimensions and explicit selector focus. Search/actions fit a phone grid and
footer controls wrap. Sixteen served journeys check 144 control targets, literal values and all
1,240 downloaded source rows; seven focused suites pass 56/56/0/0. Every report/native contract and
all 3,789 Arabic catalog pairs remain. See [measurement and limits](DELIVERY-2026-10-05-EVIDENCE-CONTROL-LAYOUT.md). B16/B24 remain partial;
counts stay 13 implemented / 14 partial / one open. Full local qualification and whole-plan work continue.

## Final local release and rendered qualification

The early sanitized format gate correctly stopped a noncanonical runner method-chain layout before
any push. The second Prettier 3.9.9 pass changes only whitespace and preserves the same executable
Babel AST; the earlier full rendered run remains diagnostic. A fresh final-source candidate passes
offline install/build/early report freshness/full checks/Railway: main 4,351/4,351/0/0 in
136.668 seconds; capture 4/4/0/0 in 89.319 ms.
Required FFmpeg exercises all media cases with zero skips. The manifest contains 1,786 public
sources plus one literal generated empty sample, hash cea67fb2a015aaf9e82a12e69ff27fecc106de6f36121d003d615a2082eafccb. All three
public report artifacts regenerate unchanged and preserve bytes; the private root sample stays
unread. Checks cover 34 scripts / four pages / 3,581 selected messages / 325 indexed documents.

Final maintained browser qualification passes 176/176/0 from 2026-10-04T21:39:47.111Z through
2026-10-04T21:44:43.182Z; website digest e3e90e3ea6967c0b708dd4d9cf1d4682334dbc1397d552b786b8ed3f4fba87e1. Sixteen populated report
cases check all 144 native fields/action targets, at least 44 pixels in both dimensions. Sixty-four
fields preserve 16-pixel type and original accessible labels; actual Tab/Shift+Tab and selector
focus outlines pass. Sixteen filtered-view downloads retain all 1,240 original rows, native values,
full totals, zero/null distinctions and current-language worksheet direction. Original eight
retained cases still check 2,000 single-line native cell ranges. Named tables, skip/drawer focus
and contained page reflow pass. English/Arabic 375-pixel screenshots were inspected, with actual
keyboard table scroll positions distinguished from page reflow. No provider mutation or actual
provider egress occurs. Catalog bytes remain unchanged. Fresh exact committed-source/full/browser
checks follow before the sole Work-here push; hosted CI stays owner-skipped and full-plan work continues.

## Exact committed-source follow-through

Batch 157 clean HEAD a4c01b54fbc176b82f304b9b6bc098bb98d322b5 passed every local
install/build/report-freshness/check/Railway stage: main 4,351/4,351/0/0 in
161.621 seconds; capture 4/4/0/0 in 94.712 ms.
Required FFmpeg ran with zero skips. The exact candidate matched 1,786 public Git blobs,
one generated empty sample and all three tracked report artifacts; source digest
182d103a84884c8289f3f30422d8db1fae3a5512a36ffeea76f12cefa61cd310. Clean-head browser
qualification passed 176/176/0, with 144 measured targets and 64 original readable labelled
fields, unchanged native values and all 1,240 downloaded rows. The guarded sole Work-here
push completed from 536c945 to a4c01b5. No hosted CI was started or polled.

## Batch 158 — authored Google capture diagnostics and explicit recovery

Twenty-seven first-party Google collector refusals and five selected recovery hints now have
authored Arabic, preserving all 3,789 previous pairs. The maintained locale gate selects only
direct owned refusal literals and the specific shared recovery branches reached by nine Google
failure codes. Dynamic native diagnostics, fallback expressions, error codes and protocol values
are excluded. The original collector, error envelope, error formatter and capture workflow remain
byte-identical. B15/B16/B24 advance; the full-plan matrix stays 13 implemented / 14 partial / one open.
See [scope and qualification](DELIVERY-2026-10-05-GOOGLE-CAPTURE-RECOVERY.md).

## Final repaired-source qualification

A fresh sanitized candidate passes offline install/build/regenerated report/early freshness/full
checks/Railway: main 4,358/4,358/0/0 in 136.659 seconds; capture 4/4/0/0
in 92.611 ms. Required FFmpeg runs every media case with zero skips. The manifest contains
1,788 public sources plus one generated literal empty sample, digest 19b34f7b0f1a2c135e6691b7f378127ce8238b8990f143570a64308d76bcae50. All three
public report artifacts regenerate identically and preserve tracked bytes; root private samples
stay unread. Checks retain 34 scripts / four pages / 3,613 selected messages / 326 indexed documents.
The fixture compatibility repair passes 61/61/0/0 in 3.166 seconds; the unrelated recorded Windows
cleanup failure is superseded by this complete fresh pass with its original assertions unchanged.

The final repaired maintained browser suite passes 184/184/0 from 2026-10-04T22:19:04.954Z through
2026-10-04T22:24:19.863Z, website digest b6d62697db54ea9e7e4349a0885625128d0a08911b658d33af1ddec15de12e42. Eight new failed-capture/retry
journeys verify authored error and recovery hint in both languages, original API code/message and
request reference, no failed persistence/automatic retry, exact preserved form scope and the separate
complete capture. All 1,272 original rows in 24 actually downloaded current-language workbooks remain;
216 original controls meet the scoped 44-pixel minimum, with original keyboard labels/focus/table
scroll/reflow checks. Earlier rendered runs precede the fixture interface repair and remain diagnostic.
All 3,789 earlier catalog pairs remain; collector/error envelope/formatter/capture bytes stay identical.
No actual provider egress or mutation occurs; report journeys add no plan or write review. Fresh exact committed-source/full
and clean-head browser checks follow before the sole Work-here push, with hosted CI owner-skipped.

## Local qualification cleanup follow-through

The initial 27cdf301cf4947e22adf564b1578ec8a9a4e9ee9 committed-source browser pass is
184/184/0, but its full gate remains failed on the recorded Windows multiprocess SQLite cleanup
lock (main 4,357/4,358 passed; zero skips). Selected fixtures now wait for all child outcomes and
full process/stream closure before cleanup, including when a sibling fails. Both existing guarded
disposable-directory removals allow ten 100-ms native linear retries, retaining failure after the
bounded window and every original functional assertion. No provider/browser/application/catalog
or public-report byte changes. Focused timing/index suites pass 16/16/0/0 in 1.934 seconds, including
three real processes and exact 225-attempt read-back. A new clean commit, regenerated reports, full
required-FFmpeg gate and fresh exact-head browser run are mandatory before the sole Work-here push.
The earlier full/browsing attempts are retained as dated evidence, not current release qualification.

## Batch 159 — original Google campaign/device/day evidence

Baseline: 25fa7c4. A sixth separate guided Google preset captures campaign × native device × day
through the existing read-only v25 Search transport. Exact customer/campaign resources, two-field
grain, all seven literal device enums, daily dates, duplicate tuple, unchanged account/authority
and complete bounded counts/pages are required before persistence. Missing categories do not
establish zero activity; attribution/completeness remain declared. The new grain refuses campaign
budget/search-exclusion eligibility and incompatible guided reconciliation.

Optional plain native_device mapping preserves missing cells as unknown, filters retained rows
only when mapped and appends one exact Excel column. Old unmapped rows/eleven-column and keyword
twelve-column workbooks remain. English/Arabic controls retain full resources, original native
values/totals and every original workbook row. Primary current v25 field/proto/segmentation
research supports the selected query; no live-provider acceptance is claimed. Focused Google and
evidence verification passes 58/58/0/0 in 3.694 seconds, including the six-call real SDK journey.
See [research, scope and qualification](DELIVERY-2026-10-05-GOOGLE-DEVICE-EVIDENCE.md). Fresh full/source/browser gates follow;
B18/B27/B15/B16/B24 stay partial and whole-plan work continues under owner-skipped hosted CI.

## Final working-source qualification

The fresh sanitized candidate passes install/build/regenerated report/early freshness/full checks/
Railway: main 4,372/4,372/0/0 in 161.876 seconds; capture 4/4/0/0 in
91.5686 ms. Required FFmpeg runs with zero skips. The manifest contains 1,792
public sources and one generated literal empty sample, digest ea1a183c08b690e4ac8ee3e094c9c3d3128be45164c66073b4ac6e830f30f10c. All
three public report artifacts regenerate identically and preserve tracked bytes; root private
samples stay unread. Checks retain 34 scripts/four pages/3,620 selected messages/327 documents.

The maintained rendered suite passes 192/192/0 from 2026-10-04T23:00:21.155Z through 2026-10-04T23:05:22.854Z,
website digest c1d025bbf6b3836b4f804b2e6599ec9609138de3380446995052651ec351ddbc. Eight actual device capture/filter/download journeys
retain all seven literal categories and full campaign resources, original huge spend/zero/unknown
cells, complete totals and every original workbook row. The 32 populated retained-report journeys
inspect 1,336 original downloaded rows and 288 original controls meeting the scoped 44-pixel minimum,
with original labels/keyboard/table scroll/reflow checks. All earlier 3,821 catalog pairs remain.
No actual provider egress or mutation occurs, and report journeys create no plan or write review.
Fresh exact committed-source/full and clean-head browser checks follow before the sole Work-here
push; hosted Actions remains owner-skipped. Whole-plan work continues after this delivery.

## Batch 160 — persistent current capture feedback

Baseline: 6f58a6e. Actual English/Arabic phone captures confirm that the old six-second toast
removes the only visible reason/reference. Current guided failures now remain beside the original
submit in one described alert, using the original formatter with escaped literal native diagnostics.
No duplicate toast or forced focus is added. Settings edits/new explicit submission clear current
feedback; original completeness rules and stale setting/form/route/identity guards remain. Only
explicit retry reads again. A neutral title avoids claiming every transport failure proves no save.

Focused controller/localization/binding/route verification passes 57/57/0/0 in 1.740 seconds. Original
provider wire values and all earlier catalog pairs remain. Primary W3C informative guidance supports
descriptive persistent feedback and programmatic announcements; independent assistive acceptance
remains separate. The maintained served suite retains 192 cases and adds eight actual delayed-response
journeys while strengthening eight persistent failure/recovery cases. See [research and qualification](DELIVERY-2026-10-05-PERSISTENT-CAPTURE-FEEDBACK.md).
Fresh full/source/browser gates follow. B15/B16/B24 stay partial and the whole remaining plan continues.

## Stable submit identity correction

The first maintained browser attempt reaches 192 passed / eight failed among 200 cases. The
new focus assertion catches a pre-existing capture submit without an ID or data key: the shared
focus helper therefore falls back to the form’s first control after disabling the button. An
explicit stable capture-submit ID now lets that unchanged helper return to the original submit.
The later alternating recovery failures are fixture-phase fallout from the earlier aborted case,
not separate native acceptance evidence. No focus assertion is removed. The first full sanitized
suite passes 4,379/4,379/0/0 and capture 4/4/0/0, but this earlier source/browser attempt remains
diagnostic. Fresh corrected-source full and maintained browser gates must qualify the complete fix.

## Batch 160 local gate follow-through

The fresh corrected full check exposed actual SQLite BUSY contention in a worker health write.
The optional health update now tolerates only that condition without affecting critical claims,
renewals or completion, and old observations remain eligible to become stale. Actual held-writer
regressions prove one completed result, independent lease renewal, strict critical refusal and
recovery. Four new tests plus existing queue/concurrency/operations tests pass 19/19/0/0. The
199/200 browser attempt passes all new error journeys; one early heading count now waits for its
original visible render before keeping the exact count assertion. Earlier attempts remain
diagnostic. See [scope and primary sources](DELIVERY-2026-10-05-PERSISTENT-CAPTURE-FEEDBACK.md).
B16/B23/B24 remain partial; counts stay 13 implemented / 14 partial / one open.

## Complete working-source qualification

The fresh sanitized follow-through passes install/build/regenerated report/freshness/default full
checks/Railway: main 4,383/4,383/0/0 in 194.050 seconds; capture 4/4/0/0 in
76.2556 ms. Required FFmpeg runs with zero skips. The candidate contains 1,795 public
sources and one generated empty sample, digest da3e2abc200c80c7c51d0ed6c2ed7a97ccf6321d16cacdfc15155ae4d1a93d0b.
All three public reports regenerate identically and retain their tracked bytes; private root samples
stay unread. The actual four-process queue and new held-writer tests pass in this default full run.

The maintained browser suite passes 200/200/0, 2026-10-05T00:12:05.268Z through
2026-10-05T00:19:10.107Z, website digest 0fc083d0303ac319195c8c89e09f376df252009fbe36f9aa2b662a395b9fbdf7.
All eight current failures remain visible after 6,600 ms with original reference, hint, form/submit
descriptions and submit focus. All eight delayed obsolete failures stay silent after settings edits.
Forty populated retained-report journeys inspect 1,368 original downloaded rows, 360 original
44-pixel controls and 160 retained labeled 16-pixel fields. Earlier native values and workbook
assertions remain. Provider egress/mutations are zero. Fresh exact committed-source and clean-head
browser checks follow before the sole Work-here push; Actions remains owner-skipped.

## Batch 161 — authored provider capture refusal localization

[Delivery](DELIVERY-2026-10-05-PROVIDER-CAPTURE-LOCALIZATION.md) adds 76 distinct exact-owned Meta,
LinkedIn, TikTok and Snapchat refusal sentences plus three reachable recovery hints, preserving
all 3,830 previous catalog pairs and fifteen native/controller files byte-for-byte. All 77 source
occurrences and 15 codes/eight shared hints use the actual English/Arabic formatter with unchanged
structured retry semantics. Four real MCP-client negative capture/list journeys perform one fixed
native account GET each, preserve original wire messages/references and save no reports or effects.
Fresh focused checks pass 23/23/0/0; the locale gate selects 3,701 messages with zero problems.
The maintained browser suite adds 32 exact native account-refusal/persistent-feedback journeys to
all prior 200 cases. Fresh full/exact source/clean-head browser qualification remains required
before the sole Work-here push. B15/B16/B24 stay partial; counts remain 13/14/1.

## Complete working-source qualification

The fresh sanitized candidate passes install/build/regenerated report/freshness/default full checks/
Railway: main 4,392/4,392/0/0 in 132.760 seconds and capture 4/4/0/0 in
81.8996 ms. Required FFmpeg runs with zero skips. The manifest contains 1,799 public
sources plus one generated empty sample, digest 7f6c649c6dbb940b42c6b4e3c26860f274431a603684f8592139953558281ca4.
All three public reports regenerate identically and preserve tracked bytes; root private samples
stay unread. The locale gate selects 3,701 messages with zero problems; all 3,830 previous catalog
pairs and fifteen native/controller files remain unchanged.

The served browser suite passes 232/232/0 from 2026-10-05T00:43:08.397Z through
2026-10-05T00:53:48.016Z, website digest 5e79190f3859a13f0c40ba7460d72c93200bab10a007df2110cbfe6a179118d1.
All 32 new refusal journeys retain the original native account/measurement wire and English API
message/code/reference while displaying authored reason/hint in the selected language. They retain
original settings/submit focus, form/submit descriptions and feedback after 6,600 ms, then clear
on explicit edit with no automatic retry. Each stops after one fixed native GET, saves no report
or effects and produces no duplicate toast. All previous 200 cases remain, including forty populated
retained-report journeys, 1,368 original workbook rows, 360 scoped control targets and 160 retained
fields. Actual provider egress and advertising writes are zero. Fresh exact-source/full and clean-head
browser qualification follow before the sole Work-here push, with Actions waived by the owner.

## Batch 162 — shared worker stage recovery

[Delivery](DELIVERY-2026-10-05-WORKER-LOOP-RECOVERY.md) closes an inspected standalone/embedded
loop gap: continuous schedule/mail/job failures now retain metadata-only diagnostics and one-second
pacing in both entry points. Explicit --once still propagates its original failure. Stop checks
prevent new stages/claims after observed shutdown while awaited work settles; original cleanup,
disabled embedded workers, leases, authority and all native/website contracts remain. Fifteen new
behavioral tests include a real blocked SQLite lease/release/exactly-once original result and an
actual owned idle --once process. Existing queue/authority/heartbeat/HTTP startup checks remain;
focused qualification passes 28/28/0/0. Fresh full/exact-source/clean-head browser gates follow before
the sole Work-here push with hosted Actions owner-waived. B16/B23 remain partial; counts stay 13/14/1.

## Complete working-source qualification

The fresh sanitized candidate passes all six install/build/regenerated report/freshness/default full
check/Railway stages: main 4,407/4,407/0/0 in 142.807 seconds, capture
4/4/0/0 in 80.0746 ms. Required FFmpeg runs with zero skips and default concurrency.
The manifest contains 1,802 public sources plus one generated empty sample, digest
c65946624e14f434c0c710d2aa6d6b6be9016c176cad5d3906b5864a01fb9203. All three public reports regenerate identically;
private root samples stay unread. Seventy original native/lease/authority/website sources retain
their baseline bytes. All fifteen new shared-loop behaviors and original four-process queue,
current-authority, critical lease and HTTP startup tests pass in this full run.

All 232 served browser cases pass from 2026-10-05T01:21:32.012Z through 2026-10-05T01:32:08.852Z,
website digest 5e79190f3859a13f0c40ba7460d72c93200bab10a007df2110cbfe6a179118d1. Forty populated retained-report journeys
retain 1,368 original workbook rows, 360 scoped controls and 160 labeled fields. All 32 four-provider
refusals retain their original wire/reference/focus/settings and persistent authored feedback.
Actual provider egress/mutations remain zero. The first browser invocation stopped before creating
a case because its per-process local dependency settings were absent; the configured fresh run
above uses the verified owned Chromium and installed Playwright. No browser assertion was weakened.
Fresh exact committed-source/full and clean-head browser gates follow before the sole Work-here
push with hosted Actions waived by the owner.

## Batch 163 — measurement read feedback qualification

This increment changes the two GA4 read-form feedback paths and exact authored diagnostic
selection; all 425 backend files retain their preceding Git bytes. It adds no advertising
write family, collector, event sender, provider acceptance or consent/deduplication verification.
The 29 new controlled/real-SDK cases preserve original refusal/native evidence and explicit
recovery; the maintained served selection adds 32 English/Arabic current/obsolete cases to 232.
The 34 exact owned sentences, four missing hints and two labels preserve all 3,909 existing
catalog pairs. B15/B16/B20/B24 stay partial. See [delivery](DELIVERY-2026-10-05-MEASUREMENT-READ-FEEDBACK.md).

## Complete working-source qualification

All six fresh sanitized install/build/regenerated-report/freshness/default-full/Railway stages
pass. The main suite passes 4,436/4,436/0/0 in 140.405 seconds; capture passes
4/4/0/0 in 82.6556 ms. Required FFmpeg runs with zero skips at default concurrency.
The candidate contains 1,807 public files plus one generated literal empty sample, digest
50f156d9bd043b353bd79607cc2dd39453c9b01d7a43d54ee5f95dc71e80ac6b. All three tracked public reports regenerate identically.
All 425 backend files and all 3,909 preceding catalog pairs retain their original bytes/values.

All 264 served browser cases pass from 2026-10-05T02:07:24.476Z through 2026-10-05T02:20:32.989Z,
website digest c5862436140a88d8ff2a0864693af8f1cda7bf208b52d921a1fdf9b650c2c753. This includes 16 current measurement
refusal/recovery and 16 obsolete-response journeys, all original 232 cases, 40 populated retained
report journeys, 1,368 workbook rows, 360 scoped controls and 160 labeled fields. Current
measurement failures remain described after 6,600 ms; original focus/settings/wire references
and exact recovery values survive, without automatic retries, snapshots, event senders or
duplicate toasts. The 32 measurement refusals perform 32 bounded native reads; the 16 explicit
recoveries perform another 32. Original four-provider/Google current and obsolete failure
assertions remain. Representative Arabic 320-pixel event and identifier alert screenshots
were visually inspected. External provider requests/mutations remain zero.

Fresh exact committed-source/default full and clean-head browser qualification follow before
the sole Work-here push. Hosted Actions stay waived at the owner's direction.

## Batch 164 — shared recovery copy and remaining-work orientation

All 122 shared authored recovery hints are covered by exact source selection and bilingual
formatter checks. The 110 added Arabic pairs do not change native error/retry authority,
backend/controller bytes or the preceding 3,949 pairs. Two actual SDK and sixteen served
native-403 journeys retain original access denial and explicit read recovery, with zero effects.
[Current completion walkthrough](../CURRENT-READINESS.md) maps remaining implementation and
external acceptance for all 28 packages; B15/B16/B24 remain partial. No new write family, provider
entitlement or production/readiness claim is added. See [delivery](DELIVERY-2026-10-05-SHARED-RECOVERY-GUIDANCE.md).

## Complete working-source qualification

All six fresh sanitized install/build/regenerated-report/freshness/default-full/Railway stages
pass. Main 4,443/4,443/0/0 in 153.807 seconds; capture 4/4/0/0 in 71.4348 ms.
Required FFmpeg runs with zero skips at default concurrency. The candidate contains 1,811 public
files plus one generated literal empty sample, digest e453e82fe3dee90b60dc35738c1d7ebc9d1fcccb2f3fe00c7aa22777a4c90234.
All three tracked public reports regenerate identically. All 425 backend files, 53 website
files outside the catalog and 3,949 preceding Arabic pairs retain their original bytes/values.

All 280 served cases pass from 2026-10-05T02:37:48.099Z through 2026-10-05T02:52:56.621Z, website
digest 5f04101761417e25a6fe5dd529e33791789300d484773e1bdf683069ef21c7ef. All preceding 264 cases remain, including
1,368 original workbook rows, 360 scoped controls, 160 labeled fields, four-provider/Google
refusals and original measurement current/obsolete behavior. Sixteen additional native-403
journeys retain original denial/category/wire/reference/settings/focus and persistent authored
shared recovery after 6,600 ms. They require sixteen refused reads and thirty-two explicit
recovery reads, with no automatic retries, saved reports, event senders, grant changes or effects.
An Arabic 320-pixel native-403 panel was visually inspected. External provider traffic/mutations
remain zero. The current indexed completion guide retains 13 implemented / 14 partial / one open
and distinct remaining source expansion/host/provider/destination/editorial acceptance.

Fresh exact committed-source/default full and clean-head browser gates follow before the sole
Work-here push. Hosted Actions remain waived at the owner's direction.

## Batch 165 — shared workspace form feedback

Reviewed the actual shared binding/focus/error formatter, GTM account/container reads, LinkedIn
conversion collector and real served forms. A before-change browser baseline proves diagnostic
loss at 6,600 ms. New shared-handler and SDK evaluations cover current/obsolete/overlapping
attempts, preserved descriptions/focus/settings/native envelopes and explicit original-scope
recovery. Existing specialized controllers/backend bytes remain unchanged. The maintained browser
selection preserves all 280 cases and adds 32 GTM/LinkedIn journeys. Complete default full,
required FFmpeg/report regeneration/freshness/exact-source and clean-head browser gates precede
release. This does not add live/host/assistive-technology evidence or close B15/B16/B24.

Batch 165 also addresses F-234: populated LinkedIn conversion rules receive the readable native
row-column minimum and unbroken literal LTR IDs/types/amount/currency within their named scroll
region. Intermediate missing-baseline/table-width browser failures are retained and rejected;
fresh complete qualification follows the corrections with all original assertions intact.

## Complete working-source qualification

All six fresh sanitized install/build/regenerated-report/freshness/default-full/Railway stages
pass. Main 4,468/4,468/0/0 in 135.688 seconds; capture
4/4/0/0 in 98.4570 ms. Required FFmpeg runs with zero skips at default
concurrency. The candidate contains 1,816 public files and one literal empty generated sample,
digest d5d4e8f5f500da2303b2d24deff4a8e6c93c45ad35ca500e4914a60dcb1c3076. All three tracked public reports regenerate identically.
All 425 backend files, 51 other website files and 4,059 preceding Arabic pairs remain unchanged.

All 312 actual served cases pass from 2026-10-05T04:01:28.138Z through 2026-10-05T04:19:10.421Z,
website digest 088b85e9a56054792ffec0fc0be7871480c3d71a4bbdbb0d5a28a94625831df9. Every preceding 280 assertion remains,
including 1,368 original workbook rows, 360 scoped controls, 160 labeled fields, provider/Google
capture refusal and original measurement current/obsolete/native-denial behavior. The 32 new
shared form cases include sixteen persistent original native-403/reference/hint/settings/focus
and explicit original-scope recovery journeys and sixteen delayed obsolete responses. Their
thirty-two refused reads and forty explicit recovery GETs save no reports/plans/reviews, retry
nothing automatically and broaden no access or mutation authority. Representative Arabic
320-pixel GTM/LinkedIn alerts are visually inspected. External provider traffic/effects remain
zero. B15/B16/B24 and whole-plan counts remain partial and 13/14/1 respectively.

Fresh exact committed-source/default full and clean-head served checks follow before the sole
Work-here push. Hosted Actions remain waived by the owner.

## Batch 166 — native conversion metadata and scope

Selected-account LinkedIn inspection exposes exact native method/ownership metadata and an explicit
default owned-rule request record. Missing fields remain unknown; future codes remain literal,
malformed/foreign evidence refuses the whole result and the shared-rule filter remains unqualified.
Bilingual nine-column search/paging preserves exact IDs/values and unknown measurement states.
All 25 authored conversion refusals and four labels gain Arabic; 4,061 prior pairs and 122 shared
hints retain their rules. Typecheck and 121 focused native/controller/real-MCP/localization checks
pass with no skips; 39 cases are new. All 424 other backend and 52 other website files retain Git bytes.
The maintained browser selection adds 32 scoped metadata/refusal/recovery/obsolete-success journeys
to all preceding 312. Failed preliminary runner evidence remains rejected; fresh complete and
exact-HEAD qualification precede the sole Work-here push. B15/B16/B20/B24 remain partial; the whole-plan counts stay 13/14/1.
See [delivery](DELIVERY-2026-10-05-LINKEDIN-CONVERSION-METADATA.md).

## Complete working-source qualification

All six fresh sanitized install/build/regenerated-report/freshness/default-full/Railway stages
pass. Main 4,507/4,507/0/0 in 124.456 seconds; capture 4/4/0/0 in
83.2802 ms. Required FFmpeg runs with zero skips at default concurrency.
The candidate contains 1,822 public files and one literal empty generated sample; digest
a3a20a56412454c6a5467590559bda71151f22f401355932a75f5749691ad6bf. All three tracked public reports regenerate identically.
All 424 other backend files, 52 other website files and 4,061 prior Arabic pairs retain their
Git bytes/values. Exact account authorization is unchanged. Arabic is 3,882 required / 4,090 catalog.

All 344 actual served cases pass from 2026-10-05T05:02:35.133Z through 2026-10-05T05:22:09.664Z,
website digest 15e5ae6c6d21c480a1a864e7a89f04e1a3cdf6090309df1e6f2a17ae623176f6. Every preceding 312 journey remains,
including all 1,368 workbook rows, 360 scoped controls, 160 labeled fields and original
capture/provider/measurement/form current/obsolete/recovery assertions. The 32 new journeys
expose native metadata and original request scope, retain missing/future fields, search/page
locally, retain malformed native reason/hint/reference for 6,600 ms and recover only on explicit
original-scope submission, while obsolete successful responses remain silent. Their 112
synthetic GETs include sixteen refused and twenty-four separate recovery reads; they retain
no reports/plans/reviews, grant no shared-rule access and perform no automatic retry or effect.
The Arabic 320-pixel form/table/reflow screenshot is visually inspected. External provider
traffic/effects remain zero; this does not supply live, Linux/Docker or assistive acceptance.

Rejected preliminary browser/full-suite artifacts remain separate; the earlier queue outcome
failure did not reproduce in four isolated cohorts or this full default run. Its root cause
remains unconfirmed. Exact committed full/clean-head checks follow before the sole Work-here push.
Hosted Actions remain waived; B15/B16/B20/B24 and the 13/14/1 whole-plan counts remain unchanged.

## Batch 167 — preserved measurement task navigation

Observed baseline LinkedIn settings begin 3,505/3,879 px down the 320-pixel English/Arabic page.
Named task and return links now reach all four original inspection forms without changing drafts,
results, local search, URL/history or a pending original native read. Exact known fragments focus
their heading after original scope binding. Native collectors, authority, response guards and
query-only handoffs remain unchanged. Four authored Arabic labels/help retain 4,090 earlier pairs.

Type/locale coverage and all 77 focused cases pass; six are new. The isolated final sixteen served
journeys pass with strict original-scope/three-GET/no-effect limits and readable mobile heading
focus, link reflow and normal/hover contrast. Rejected earlier harness/timeouts/visual evidence
is retained. The maintained selection extends 344 to 360; complete fresh working and clean-HEAD
qualification follows before the sole Work-here push. B15/B16/B20/B24 remain partial; the whole-plan
matrix remains 13 implemented / 14 partial / one open.
See [delivery](DELIVERY-2026-10-05-MEASUREMENT-NAVIGATION.md).

## Complete working-source qualification

All six fresh sanitized install/build/regenerated-report/freshness/default-full/Railway stages
pass. Main 4,513/4,513/0/0 in 137.572 seconds; capture 4/4/0/0 in
83.5309 ms. Required FFmpeg runs with zero skips at default concurrency.
The candidate contains 1,825 public files and one literal empty generated sample; digest
61c4829a91a3cd4e7c659db96fc23603a1231415cd49ca4f26c1d215af7f6431. All three tracked public reports regenerate identically.
This working candidate precedes final qualification notes and the deployment runbook correction;
the complete final committed candidate is assembled and requalified separately before pushing.
All 429 tracked backend/deployment files, 51 other website files, 60 other tools and 4,090 prior
Arabic pairs retain their Git bytes/values. Forty original controller functions and the original
GTM submit callback retain their exact source. Arabic is 3,886 required / 4,094 catalog.

All 360 actual served cases pass from 2026-10-05T06:13:56.653Z through 2026-10-05T06:33:44.704Z,
website digest ea139fa451bd43f8e35ad456430b30d9d2972204dd87900e46415a1ea79e4454. Every preceding 344 journey remains,
including all 1,368 workbook rows, 360 scoped controls, 160 labeled fields, eight About Us cases,
and original capture/provider/measurement/form/metadata current/obsolete/recovery assertions.
The sixteen new journeys preserve 120 distinct form fields through eighty task jumps and eighty
returns, check forty exact fragment focuses and sixteen ignored fragments, and retain sixty-four
normal/hover contrast checks. The eight local journeys use only twenty-four fixed synthetic GETs
from explicit original-scope submissions; navigation retains the pending response, completed
result and local metadata search. All other navigation/fragment journeys make no automatic read.
No external provider request, effect, retained report, plan, review or retry occurs.
Actual Arabic 320-pixel and English 1280-pixel navigation screenshots are visually inspected;
the separate maintained geometry assertions check focus clearance below the mobile header.
Selected synthetic/layout checks do not supply live, Linux/Docker, physical-device or full
Arabic editorial/assistive acceptance. Connected tool-help metadata exposes thirteen current
curated guides and the public reporting bootstrap schema only; no provider read, deployment
revision or account eligibility is attested by that metadata response.

F-238 aligns the deployment runbook with the owner-waived hosted CI mode. No Railway dashboard
setting is changed or claimed verified, and no actual deployment crash cause is inferred.
Rejected preliminary artifacts remain separate. Exact committed full/clean-head checks follow
before the sole guarded Work-here push. Hosted Actions remain waived; B15/B16/B20/B24 and the
13 implemented / 14 partial / one open whole-plan counts remain unchanged.

## Batch 168 — selected account inventory recovery language

A source-owned inventory identifies 131 distinct direct instructions/refusals across the dispatcher
and six supported collectors; 127 previously fall back to English. Authored Arabic now covers that
exact set while preserving all 4,094 earlier catalog values, native selectors/quantities and original
error envelopes. A narrowly selected literal source gate excludes dynamic/provider fallback values.

All 110 focused six-provider/native/controller/localization cases pass; ten are new. Twelve isolated
served English 1280-pixel/Arabic 320-pixel previews retain original refusal/hint/reference, current
selection/focus and described persistent feedback for 6,600 ms, with one synthetic read each and no
retry/effect/saved record. Rejected first-probe reference-location evidence remains separate.
The maintained selection preserves all 360 preceding journeys and adds 48 across six providers,
two languages and four widths. Complete fresh working and exact committed gates precede the sole
Work-here push. B16/B24 and the 13 implemented / 14 partial / one open matrix remain unchanged.
See [delivery](DELIVERY-2026-10-05-PORTFOLIO-DIAGNOSTICS.md).

## Complete working-source qualification

All six fresh sanitized install/build/regenerated-report/freshness/default-full/Railway stages
pass. Main 4,523/4,523/0/0 in 161.028 seconds; capture 4/4/0/0 in
86.7022 ms. Required FFmpeg runs with zero skips at default concurrency.
The candidate contains 1,829 public files and one literal empty generated sample; digest
5e062ef7139ddcdadf2f510581bfeff1079169a45cc14cab6ee6605bf8a02357. All three tracked public reports regenerate identically.
This working candidate precedes final qualification notes; the complete final committed candidate
is assembled and requalified separately before the sole guarded Work-here push.
All 429 tracked backend/deployment files, 53 other website files, 59 other tools and 4,094 prior
Arabic pairs retain their Git bytes/values. Eight original locale gate functions retain their
exact source; only the source-ownership inventory loop and one bounded extractor are extended.
The 127 authored additions bring Arabic to 4,013 required / 4,221 catalog entries.

All 408 actual served cases pass from 2026-10-05T07:37:26.325Z through 2026-10-05T08:04:10.947Z,
website digest cbd2540a7c1f1cc482fcb735c0a89eef357abb42ed13e83b63aa5a9c7e631c7b. Every preceding 360 journey remains,
including all 1,368 workbook rows, 360 scoped controls, 160 labeled fields, eight About Us cases,
and original capture/provider/measurement/form/metadata/navigation current/obsolete/recovery
assertions. Forty-eight new inventory refusal cases span six providers, both languages and
320/375/768/1280-pixel widths. They retain the original selected request, native code/message,
request reference, original submit focus and described persistent feedback after 6,600 ms.
Each makes exactly one fixed synthetic native read: eight original Google readonly GAQL POSTs
and forty GETs. Explicit form editing clears feedback without automatic reads. No external
provider request, provider mutation, saved report, plan, review or retry is introduced.
Actual Arabic 320-pixel Google, LinkedIn and X diagnostics are visually inspected; authored
copy and recovery hints remain readable and the original reference wraps inside the viewport.
This is selected local Windows synthetic/layout evidence, not complete live, Linux/Docker,
physical-device or full Arabic editorial/assistive acceptance. Rejected draft proofs remain.

A current connected-client get_reporting_bootstrap call succeeds with dry_run true: zero
workbooks, queries and schedules are visible, Google Sheets is disconnected and external
writes are false in that response. This actual scoped read is separate from the earlier
public tool-help metadata and does not attest all tenant records, account eligibility, other
MCP clients or the deployed Git revision. No advertising-provider read or external write occurs.
Bounded unauthenticated public reads at 2026-10-05T07:18:41.547Z and
2026-10-05T07:18:42.283Z return HTTP 200 for /healthz (status up) and /about
(About us · AMCP). These responses attest current public reachability only; they do not supply
an image digest, exact deployed revision, persistent storage or authenticated/live-provider proof.
A separate lightweight connected-client context read succeeds with ten configured connections
and ten configured account bindings across eight gateways. Raw identities are not published.
This local configured-context response does not establish current provider access or entitlements.
An additional isolated Chromium accessibility-tree review covers 100 initial views across 25
routes, both languages and 320/1280-pixel widths: all 2,218 controls have nonblank computed names,
each view has one main/primary heading, and no missing ARIA reference or duplicate ID occurs.
It introduces no provider read or write and does not substitute for full assistive acceptance.
No Railway setting is changed or claimed verified. Hosted Actions remain waived by the owner;
B15/B16/B24 and the 13 implemented / 14 partial / one open whole-plan counts remain unchanged.

## Current selected native read

A bounded actual connected-client Google Ads search succeeds with dry_run false and LIMIT 1:
one page, one exact selected-customer row and no truncation. The original configured account
identity matches; native currency has the uppercase ISO shape and a native timezone is present.
No customer identity or value is published, and no campaign, creative, budget or other write is
requested. This verifies one current account-metadata read only. It does not close broader
provider/objective eligibility, reviewed-write, historical, deployed-revision/image or all-client
acceptance. Discovery advertises an effective v25 gateway while DESCRIBE_ACTION identifies the
recorded v23 descriptor; this metadata provenance distinction is investigated separately.

## Batch 169 — effective operation help and inventory read recovery

All eight captured Google/Meta operation descriptions are normalized through the existing current
version adapter; all 1,039 uncaptured actions from their original versioned catalogs expose qualified
metadata instead of generic gateway help. Recorded captures, canonical names, schemas, risk flags,
unknown/nonversioned/independent behavior and native execution remain unchanged. A separate exact-code
inventory remedy gives useful selected-account/hierarchy read recovery, preserving stronger provider
and uncertain-write precedence. One authored Arabic pair preserves every prior value.

The isolated combined prototype passes 52/52, zero skips/failures/cancellations; eighteen tests are
new, including real SDK/owned HTTP parity and revoked-caller refusal. Two rejected draft test
assumptions are preserved; stronger existing provider-body guidance is now explicitly asserted.
The maintained full 408 browser journeys retain all prior assertions, with stronger manual read
recovery/Arabic checks in the 48 inventory refusals. Fresh complete source/report/default FFmpeg
and working/clean-HEAD browser gates precede the sole guarded Work-here push. B15/B16/B24 and the
13 implemented / 14 partial / one open matrix remain unchanged. See
[delivery](DELIVERY-2026-10-05-DISCOVERY-RECOVERY.md).

Exact source review: src/catalog.ts (help branch and unchanged Registry methods), src/errors.ts
(exact inventory code after stronger provider/access rules), web/locales/ar.json (one authored hint),
existing tests/fixtures/portfolio-diagnostics-browser.mjs (stronger assertions), and four new tests:
tool-help-version.test.mjs, mcp-tool-help-version.test.mjs, tool-help-version-http.test.mjs and
portfolio-recovery.test.mjs. All six native inventory collectors, actual input/refusal fixtures,
existing schema/version/catalog/MCP/error/locale regressions and source-preservation records are read.
The original locale gate, native transport/auth/ownership/worker/controller/style contracts remain.

## Preserved first full working rejection

The first complete default main suite is preserved at 4,539/4,541 passed, two failures, zero skips
in 156.071 seconds. Both failures are existing assertions that the shared hint inventory contains
122 entries; the exact new authored hint correctly makes 123. Each original test now requires all
123 and explicitly verifies that excluding the new hint leaves the preceding 122. Every original
selector/formatter/native-token/quantity assertion remains. The fresh working candidate and full
default checks are repeated; the served browser run retains the same production source and helper.

## Complete working-source qualification

All six fresh sanitized install/build/regenerated-report/freshness/default-full/Railway stages pass.
Main 4,541/4,541/0/0 in 142.295 seconds; capture 4/4/0/0 in 71.6974 ms.
Required FFmpeg runs at default concurrency with zero skips. The corrected working candidate contains
1,834 public files and one literal empty generated sample; digest e05009eebc5d3423151a491a9647a8ad3be4649705b193ecfbd60c8567ddf304.
All three tracked public reports regenerate identically. This candidate precedes these closing notes;
a fresh exact committed candidate and full clean-head browser proof qualify the sole guarded push.

All 408 served browser journeys pass from 2026-10-05T08:48:33.736Z through 2026-10-05T09:14:22.092Z.
Website digest a2109f4ec5032035ec1ef42edb770c7cc5fa5a84a9cfd91d6ab669f1b87f1f5a. All preceding 408 case identities remain. Original
1,368 workbook rows, 360 scoped controls, 160 labeled fields, eight About Us cases and every existing
capture/provider/measurement/permission/form/metadata/navigation assertion remain required. All 48
six-provider inventory refusals retain original requests/codes/messages/references/selection/focus,
described alerts for 6,600 ms, viewport bounds, no automatic repeat and no saved report/plan/review.
They now also assert provider-owned manual read recovery and authored Arabic hints. The same 48 fixed
synthetic reads occur: eight Google readonly GAQL POSTs and forty GETs, with no external provider traffic
or mutation. Actual Arabic 320-pixel Google and X diagnostics are visually inspected; the new guidance
is readable and original references wrap inside the viewport. Full physical/assistive acceptance is separate.

Source preservation verifies 541 other tracked files: 427 backend/deployment, 53 other website and 61
other tool files. All 4,221 earlier Arabic values remain exact. Nine other Registry methods, ten other
help branches, four other error functions and all 59 preceding remedy branches retain their exact bytes
and order. All 42 preceding inventory browser statements/proof properties remain, with seven added
assertions and four added proof properties. The two old hint-count tests retain their original assertions
and explicitly preserve the earlier 122 hints while requiring all 123. The focused root run passes
60/60/0/0 in 1,614.8552 ms. No native execution/schema/transport/auth/worker/controller/style changes occur.

All eight operation help descriptions now match effective native versions, with zero mismatches; all
1,039 catalog-only actions retain exact original raw metadata and unverified-extended-schema labeling.
No provider read or write is needed for this metadata proof. The optional first metadata probe assumed
a common string action field that some original raw catalog representations do not contain; that
assumption is rejected and exact raw parity is verified instead, without source or test changes.
The failed first full-run/count assumptions remain preserved. Hosted Actions stay waived and unpolled.
B15/B16/B24 and the 13 implemented / 14 partial / one open whole-plan matrix remain unchanged.

## Website account diagnostics and references — batch 170

Thirteen selected website server files now have 232 exact authored reasons covered by the Arabic
locale gate, with 193 new translations and all 4,222 prior catalog pairs retained. Early non-MCP
HTTP errors reaching the common handler keep their status/code/message and add a generated
meta.requestId. The existing browser formatter presents that reference in either language.
A matching six-field optional diagnostic event omits request payload, credentials and identity;
production stdout/stderr wiring already exists. MCP errors and reviewed-write authority remain exact.
See [website diagnostic evidence](DELIVERY-2026-10-05-WEBSITE-DIAGNOSTICS.md). Complete working-source local release/browser gates pass; exact committed-source qualification gates the sole push.
B13/B16/B24 and the 13 implemented / 14 partial / one open matrix remain unchanged.

## Complete working-source qualification

All six fresh sanitized install/build/regenerated-report/freshness/default-full/Railway stages pass.
Main 4,553/4,553/0/0 in 147.528 seconds; capture 4/4/0/0 in 87.7679 ms.
Required FFmpeg runs at default concurrency with zero skips. The fresh working candidate contains
1,838 public files and one literal empty generated sample; digest f3c23a87b0abeb2c150df7efe12c8d3f4505bda39f54e37f0a382e0f2b8561f1.
All three tracked reports regenerate identically. Closing documentation follows this candidate;
a fresh exact committed candidate and full clean-head served proof qualify the sole guarded push.

All 408 maintained served journeys pass from 2026-10-05T09:59:31.188Z through 2026-10-05T10:25:16.970Z.
Website digest 4be9acc84956807a03e48ea58eeacfa08ade4770d439f6fbfc2a75b2f2745ec8. All preceding 408 identities and original
1,368 workbook rows, 360 scoped controls, 160 labeled fields, eight About Us views and every
capture/provider/measurement/permission/form/metadata/navigation/inventory assertion remain required.
The selected inventory refusals retain all 48 manual-only recovery assertions and their original
fixed native reads with zero external provider requests or mutations. Twelve new HTTP/VM tests
qualify selected website diagnostic ownership and early error correlation separately; they do not
represent a live OAuth callback roundtrip or physical assistive-technology acceptance.

Source preservation verifies 537 other tracked files: 424 backend, 53 other website and 60 other
tool files. All 4,222 previous Arabic values stay exact; 193 entries are added. Nine old locale
selectors/all 45 complete-gate statements remain, with one added required-message loop. Two other
HTTP functions/all 20 setup statements/all three normalization statements and the original MCP
branch selector/response retain exact bytes. Native execution, scopes/auth/CSRF, reviews, workers,
browser controllers/styles/helpers and old test assertions remain unchanged. The actual production
entry already connects the optional sink to stdout/stderr; deployed log retention is unverified.
Prototype assumption failures and the rejected probe remain preserved. Hosted Actions stay waived
and unpolled. B13/B16/B24 and the 13 implemented / 14 partial / one open matrix remain unchanged.
