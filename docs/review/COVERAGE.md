# Write coverage: what stays blocked and why

Status on 2026-09-29 (batch 34), from the action ledger (`docs/implementation/ACTION-CONTRACT-COVERAGE.json`) only.
No provider was called. This plans the platform-by-platform coverage batches the owner asked for: which blocked
writes wait on an owner decision, which wait on evidence, and which are candidates to build as reviewed families.

## The ledger in one table

| Status | Routes | Meaning |
|---|---|---|
| `native_read` | 1,711 | Reads that pass the independent read classification |
| `reviewed_write_family` | 739 | Writes with a reviewed family (inspect, prepare, execute, verify) |
| `blocked_write` | 558 | Writes AMCP refuses: no family yet, or no family on purpose |
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
| TikTok | 31 | 7 | 12 | 16 | 35 | 6 | 29 | 6 | 1 | 22 |
| Meta | 50 | 2 | 5 | 9 | 9 | 0 | 17 | 11 | 1 | 7 |
| LinkedIn | 10 | 10 | 0 | 8 | 9 | 6 | 0 | 0 | 6 | 28 |
| Snapchat | 18 | 4 | 2 | 14 | 6 | 0 | 10 | 0 | 1 | 7 |
| Google Ads | 23 | 0 | 5 | 13 | 0 | 0 | 0 | 7 | 0 | 1 |
| X Ads | 4 | 7 | 3 | 2 | 0 | 0 | 11 | 2 | 2 | 2 |
| DV360 | 11 | 2 | 6 | 4 | 1 | 0 | 0 | 0 | 0 | 5 |
| Criteo | 1 | 7 | 6 | 2 | 0 | 1 | 0 | 0 | 0 | 6 |
| Google Business Profile | 0 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| **All** | **148** | **47** | **39** | **68** | **60** | **13** | **67** | **26** | **11** | **79** |

### Kinds that need an owner decision, with a recommendation

- **Access** (users, roles, partners, agencies, system users and their tokens, Business Center assets, account and
  data links, OAuth tokens, sharing). These grant or remove people's and apps' access to money-bearing accounts.
  *Recommendation: keep blocked.* Access changes belong in each platform's own interface, where its owner
  verification applies; Google user access is the one exception already reviewed (administrator only).
- **Money** (billing setups, budget proposals, invoices, balances and funds, reservations, reach and frequency
  bookings, guaranteed orders, budget schedules, incentives). *Recommendation: keep blocked, except budget schedules*
  (Meta campaign and ad set high-demand periods), which the owner spending policy could hold like any budget; that
  one is worth a family if the owner wants scheduled budget increases.
- **Personal data** (customer list and contact uploads, offline events, conversion and call uploads, pixel and
  server events, lead forms, lead feedback). *Recommendation: keep blocked until the owner sets a personal-data
  policy* (what may be uploaded, hashing, retention, who may approve). Conversion uploads also change what bidding
  learns from, so they need the same care as a budget.
- **Publishing** (Page and profile posts, comments, replies, messages, stories, creator and TikTok One campaigns).
  These speak for the brand in public or to people directly. *Recommendation: keep blocked*; AMCP manages paid
  delivery, and Spark Ads and existing-post ads already use posts the owner published.
- **Account** (creating, changing or deleting ad accounts, advertisers and locations; tax and user settings; terms
  and subscriptions; verification). *Recommendation: keep blocked*; these are set up once, by the account owner, in
  the platform's interface.
- **Media uploads** (raw upload steps: LinkedIn images, videos and documents, TikTok file uploads, Criteo assets).
  `amcp_media` already uploads images and videos end to end for Meta, TikTok, Snapchat, Google Ads, LinkedIn, X and
  DV360, so the raw steps stay refused, as Snapchat's multipart steps do. *Recommendation: extend `amcp_media`* for the
  gaps (LinkedIn documents, TikTok music, Criteo assets) rather than open the raw steps.
- **Commerce and catalogs** (product catalogs, feeds, sets, TikTok Shop and GMV Max). A product decision rather than
  a safety one: AMCP does not manage catalogs today. *Recommendation: decide whether AMCP should*; if yes, product
  sets (Meta, TikTok) are the natural first family, since Snapchat's already exist.
- **Batch or async** (Graph batch, async batches, Google batch jobs and offline job runs, copy tasks). *Never*: each
  would carry many writes past one review. The reviewed families that need several writes send them one by one.

### Reason recorded

`src/withheld-writes.ts` gives these their own ledger reason and puts it in the refusal (`details.reason`):

- Blocked on evidence: TikTok creative portfolio deletion (TikTok's SDK defines no delete; its pages are
  unreadable here) and X analytics job deletion (docs.x.com no longer documents it; the older reference put the job
  ID in the path the captured route lacks).
- Duplicates of reviewed routes: LinkedIn's `/rest/creatives` and `/rest/adCampaigns` (six routes; the current pages
  place both under `/rest/adAccounts/{id}/`), Snapchat's per-ID creative PUT (its page's example uses the reviewed
  collection PUT), and X's targeting criterion PUT (X documents no update: delete and create).
- Unreviewable by design: Meta's `DELETE act_{id}/campaigns`, which deletes by rule (strategy, date, count), not by
  ID; each campaign is deleted with the reviewed per-campaign deletion.

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
