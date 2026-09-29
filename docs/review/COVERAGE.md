# Write coverage: what stays blocked and why

Status on 2026-09-29 (batch 38), from the action ledger (`docs/implementation/ACTION-CONTRACT-COVERAGE.json`) only.
No provider was called. This plans the platform-by-platform coverage batches the owner asked for: which blocked
writes wait on an owner decision, which wait on evidence, and which are candidates to build as reviewed families.

## The ledger in one table

| Status | Routes | Meaning |
|---|---|---|
| `native_read` | 1,711 | Reads that pass the independent read classification |
| `reviewed_write_family` | 757 | Writes with a reviewed family (inspect, prepare, execute, verify) |
| `blocked_write` | 540 | Writes AMCP refuses: no family yet, or no family on purpose |
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
| TikTok | 31 | 7 | 12 | 15 | 35 | 6 | 10 | 6 | 21 | 22 |
| Meta | 50 | 2 | 3 | 9 | 9 | 0 | 10 | 11 | 1 | 7 |
| LinkedIn | 10 | 10 | 0 | 8 | 9 | 6 | 0 | 0 | 6 | 28 |
| Snapchat | 18 | 4 | 2 | 14 | 6 | 0 | 1 | 0 | 1 | 7 |
| Google Ads | 23 | 0 | 5 | 13 | 0 | 0 | 0 | 7 | 0 | 1 |
| X Ads | 4 | 7 | 3 | 2 | 0 | 0 | 11 | 2 | 2 | 2 |
| DV360 | 11 | 2 | 6 | 4 | 1 | 0 | 0 | 0 | 0 | 5 |
| Criteo | 1 | 7 | 6 | 2 | 0 | 1 | 0 | 0 | 0 | 6 |
| Google Business Profile | 0 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| **All** | **148** | **47** | **37** | **67** | **60** | **13** | **32** | **26** | **31** | **79** |

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
| Personal data (customer lists, conversions) | Stay blocked; a one-page policy drafted for the owner's approval, nothing opened | Draft: [PERSONAL-DATA-POLICY.md](PERSONAL-DATA-POLICY.md) |
| Commerce and catalogs | Make them available | Meta done in batch 37 (product sets, products, scheduled feeds); Snapchat in batch 38 (catalogs, product feeds); TikTok blocked on evidence with a recorded reason (below); X next, from docs.x.com |
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
- Unreviewable by design: Meta's `DELETE act_{id}/campaigns`, which deletes by rule (strategy, date, count), not by
  ID; each campaign is deleted with the reviewed per-campaign deletion.

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

1. **TikTok** — ACO ads (create, update, material status), lookalike refresh, Smart+ and ad group appeals, split
   tests. Evidence: TikTok's official SDK gives request shapes but no responses, and not split tests; TikTok's pages
   render only in a browser, so behaviour needs a readable source first.
2. **LinkedIn** — lift tests and their surveys, matched-audience engagement rules and company lists (`dmpSegments`,
   versioned), page sets and segment sources. Evidence: Microsoft Learn.
3. **Snapchat** — ad squad targeting specs (the sub-resource of ad squads with more than 500 criteria; a targeting
   contract, since it changes who a serving ad squad reaches), interaction zones, creative elements, media claimed by
   ad code. Evidence: Snapchat's documentation.
4. **Meta** — ad previews (a read), ad place page sets, tracking specs, ad studies beyond split tests. Evidence:
   Meta's official SDK and references.
5. **Criteo** — creatives (create, update) and keyword reviews. Evidence: the pinned 2026-07 document.

DV360 has no candidate left: its YouTube asset associations are allowlist-only and Floodlight group changes belong
with measurement (an owner decision).
