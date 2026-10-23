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

## History

What each batch added, from batch 34 to batch 181, is kept as it was written in the
[write coverage batch history](../records/COVERAGE-BATCH-HISTORY.md).
