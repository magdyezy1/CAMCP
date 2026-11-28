---
status: record
tier: engineering
---

# AMCP Round 2.5: a seamless MCP connector. The plan for your approval

**Status:** Phase 1 is complete. It was read-only: nothing changed in code, contracts, config or deploys. This plan now waits for your approval, and Phase 2 builds only the items you approve.

**Basis:** Work-here-V2 at `5c2e5c19`, which is exactly what amcp.shop runs. Six audit lanes read the code:

- TikTok;
- Google and Merchant Center;
- Meta;
- X, LinkedIn and Snapchat;
- the core write path;
- media, health and the other gateways.

A plan drafter merged their reports, and I reviewed the draft and decided its open points (section 10). On 2026-11-15 I also ran read-only checks on the agreed test accounts (section 2).

**Detail:** Appendix A is the full record. It is kept as local evidence and is not part of the repository. It holds:

- 127 inventory rows with `file:line` evidence;
- the workflow maps for each platform;
- the design notes;
- the 49 live checks;
- all 33 questions.

Where this page and the appendix differ, this page wins.

---

## 1. The short version

**Where the White Friday time went.** It went into the connector, not the platforms.

1. **One defect blocks every TikTok build (T1).** The advertiser record has two fields that change by themselves: a signed `license_url` link and the account balance. Seven code sites fold that record into the check that a review runs before sending. Those sites cover nine write flows plus the TikTok media upload. Each of them fails with a false STATE_CHANGED whenever the link rotates or the balance moves between prepare and execute. The fix is small. Read only the fields that matter with TikTok's `fields` parameter, which I confirmed works live, and check only identity fields.
2. **Contract gaps push work back into the UIs:**
   - Standard Shopping and PMax product trees (G5);
   - Demand Gen ad-group location and language (G6);
   - a PMax asset group on an existing campaign (G1);
   - the Smart+ pixel and schedule (T5, T6);
   - TikTok Search;
   - Meta PAC and catalog creatives;
   - LinkedIn video and post ads;
   - Snapchat squad and ad edits.
3. **Recovery is manual.** Outside Google, a refusal that arrives after the request was sent is recorded as "uncertain". Reconcile can look up only Google and Meta campaign objects, and nothing reconciles on its own. That is why one Meta throttle cost more than 10 minutes.
4. **Friction is built in:**
   - one Meta change costs 4 to 14 requests;
   - a 20-account go-live costs 80 to 120 calls;
   - errors say "Platform returned HTTP 400" instead of what to change;
   - only 16 recipes exist.
5. **Coverage is thin.** Microsoft Ads has 31 of 291 operations mapped and GA4 Admin 1 of 55. Reddit has 49 of 105 mapped, or 55 callable actions by another count.

**Already fixed or stale on the older list:**

- Meta product sets with product-ID filters;
- Google custom methods (`c5d05b3e`);
- X creative assembly, and X's `media_category` (`d8ece0ce`);
- the LinkedIn post contract, which exists but cannot be used (section 4);
- two of the three X traps, which are already guarded and tested;
- Meta `/copies`, which works within Meta's synchronous limit.

The Meta creative-name suffix does not reproduce in the code, and Snapchat's E1166 appears nowhere in it.

**The plan.** It has 17 milestones. Each is shippable on its own, and each push to Work-here-V2 deploys production, so each one passes the full release gate first (section 9).

| Stage | Milestones | What you get |
|---|---|---|
| A. Unblock White Friday | M0 to M4 | TikTok and Google builds run end to end: no false STATE_CHANGED, Shopping trees, Demand Gen, Smart+, TikTok Search, automatic recovery |
| B. Scale | M5, M9, M10 | One approval for a multi-account go-live (about 80 calls become about 5); Meta with fewer requests, plus PAC and catalog creatives; one upload to many platforms |
| C. Coverage | M6, M7, M8, M15 | Microsoft Ads to at least 184 of 291 callable, GA4 Admin to at least 45 of 55, Reddit to at least 90 of 105; Merchant Center, reads first |
| D. Polish | M11 to M14, M16 | One health matrix, read helpers, X, LinkedIn and Snapchat contracts, docs and the eight recipes you named |

**What I need from you first** (section 11.1):

1. Approve the plan.
2. Answer five safety questions, which have recommendations: Q14, Q1, Q2, Q20 and Q5.
3. Approve one download.
4. Decide the test accounts for Microsoft Ads, GA4 and Reddit.
5. Run one health read, because only the owner can read it.

---

## 2. The checks I ran today

All of them were reads on the agreed test accounts. Nothing was created or changed, and no client account was touched.

| Check | Result | What it settles |
|---|---|---|
| TikTok advertiser read, once in full and once with `fields` | `fields` narrows the answer to exactly the fields asked for. This advertiser has no licence file (no `license_url`) but has a balance | The T1 fix works. T1 cannot show on this advertiser, so the fix is proven with the White Friday response as a test fixture. The live check proves that the narrowed read works and that prepare and execute pass |
| Google test account, read after you connected it | ENABLED, EGP, Africa/Cairo, not a manager. Google does not flag it as a test account, so creates there are real | Shopping checks can run because a **Merchant Center link exists**. Creates stay paused, and validate-only comes first |
| Snapchat ad squads | The read returns the old `placement` field but **not `placement_v2`** | Confirmed live (L4-30): squad and ad edits cannot pass prepare today, because the code requires a field the read omits |
| Account reads on Meta, LinkedIn and X | The agreed Meta, LinkedIn and X test accounts read fine. The two other agreed Meta test accounts return CONNECTION_REQUIRED | Which test accounts can be used |
| Connections and write grants (no provider call) | Write grants exist on all six connected test accounts. No Microsoft Ads or Reddit connection exists. The GA4 test property (your 2026-11-01 list) is connected with write access | Q11 |
| Workspace health | OWNER_REQUIRED for my connection | The review-friction baseline needs you (A6) |
| Misspelled action names on the native gateways | Refused, with `did_you_mean` already naming the right action | T7 is as reported: nothing accepts the near name |

Three errors I hit today do not say what to change. They are new items, all small:

- **LEAD-01:** `CAPABILITY_ACCOUNT_UNAVAILABLE` gives the remedy "What the message names is not available…" and names nothing (fixed in M0).
- **LEAD-02:** `amcp_workspace check` refuses `account_id` alone and asks for a `connection_id` that only another call shows (fixed in M11).
- **LEAD-03:** `OWNER_REQUIRED` on `health` says "only the owner", while its details say "owner or administrator" (fixed in M0).

---

## 3. The White Friday report, verified

None of the 17 items is fixed in code. T1 was reproduced offline with the real modules.

| ID | What | Status now | Fix | Milestone | Effort, risk |
|---|---|---|---|---|---|
| T1 | False STATE_CHANGED on every TikTok write: the advertiser record (rotating link, balance) is in the pre-send check | STILL PRESENT, blocker | Read with `fields` and check identity fields only. Remove signed links. Apply at all 7 sites and the media upload | M0, swept in M1 | S, low |
| T2 | "Provider check unavailable" next to STATE_CHANGED | Not a bug, since both messages are true; poor UX | Say why, and give the next call | M1 | S |
| T3 | A create's review reads "Update … STATUS_ENABLE → DISABLE" | STILL PRESENT, and wider: every RPC-style create | Name the real operation | M0 | S, low |
| T4 | The `amcp_campaign` step shape is learned only by failing | STILL PRESENT | A worked example in help and in the error; `validate_steps` later | M0, M14 | S |
| T5 | The Smart+ pixel cannot be attached | STILL PRESENT | Accept `tracking_info` with pixel checks and a merge patch | M4 | M, medium |
| T6 | Smart+ `schedule_type` refused | STILL PRESENT, left unqualified on purpose on 2026-09-26 | Accept it unchanged, and a start time before the group starts | M4 | S-M |
| T7 | Near-miss action names refused | PARTIAL: `did_you_mean` knows the right name, but nothing accepts it | Generated aliases that work, with a deprecation warning | M0 | S, low |
| T8 | Smart+ ads read with the wrong action | Platform rule; a docs gap | A docs note, and clone refuses a Smart+ source | M14 | S |
| G1 | An asset group plus its assets on an existing PMax campaign | STILL PRESENT | One build that reads the campaign first | M3 | M |
| G2 | `TALL_PORTRAIT_MARKETING_IMAGE` refused, with no operation index | STILL PRESENT; the ratio is probably 9:16, to be confirmed | Add the field type; put the operation index and field in every Google error | M3 | S |
| G3 | No 1.91:1 crop | STILL PRESENT; only this preset is missing | A `landscape_191` preset, and a prepare-time shape check | M10, M3 | S + M |
| G4 | `listingSource`, one asset group per review, ">25 splits" | PARTIAL; the split does not reproduce, because that family takes 500 operations | Default `listingSource`; several groups per review; refuse long temp-ID chains and never split them | M3 | S + M |
| G5 | Shopping and PMax trees cannot use temporary IDs | STILL PRESENT, blocker | A shared tree module, with temporary IDs inside builds | M3 | L, medium-high |
| G6 | Demand Gen ad-group location and language | STILL PRESENT, blocker; `requestError: UNKNOWN` is Google's own code | Accept them at the ad-group level for Demand Gen campaigns only; refuse the campaign-level form and name the right route | M3 | M, medium |
| G7 | `enableLocal:false` on a Shopping create | Platform rule; no early check | Refuse it at prepare, with the fix | M3 | S |
| G8 | PARENT_SERVING on a child created under a serving parent | Deliberate rule | A reviewed activation for child objects only, with the spend flag (after Q1) | M3 | S, medium |
| G9 | "Platform returned HTTP 400"; GAQL mistakes | PARTIAL: the GAQL rules are Google's, but the empty message is ours | Codes, operation index and field in the message (M0); a GAQL validator (M12) | M0, M12 | S-M |
| G10 | A false `VERIFICATION_MISMATCH` on every Google ad whose text assets are lists (responsive search, responsive display, Demand Gen, video, app, local and Smart ads), and a false `STATE_CHANGED` on an edit prepared before a text asset's policy review completes | FIXED by r25-field-gverify (field package, ships with M3, 2026-11-19). The same class as the Meta creative-name mismatch below (MT6, L3-04, M9), which was never recorded as a Google item | Two server-set names, `policy_summary_info` and `asset_performance_label`, dropped by name from Google Ads reads; no blanket ignore | M3 (field package) | S, low |

---

## 4. The older known issues, verified

| Platform | Item | Status | Milestone |
|---|---|---|---|
| Meta | `/copies` | PARTIAL: works for the same account, paused, at most 3 children; a clone builder for larger trees | M9 |
| Meta | About 3 calls per change; throttles taking more than 10 minutes | Understated: 4 to 14 requests per change. The long wait came from uncertain-write handling | M9 (cache), M2 (pacing, reconcile) |
| Meta | Usage header discarded; throttle marked `retryable:false` | PARTIAL: the header is read only on a throttle | M2 |
| Meta | RESOURCE_SCOPE_REQUIRED; the scope lapses | FIXED for campaigns, ad sets, ads (6 h, r25-fr-window); 5 minutes for the rest | M9, M12 |
| Meta | No `/me`; Pages and posts only through workarounds | STILL PRESENT; Page tokens stay server-side by design | M9 (one identities read) |
| Meta | The creative-name suffix gives VERIFICATION_MISMATCH | Not reproduced in code; needs a live check | M9 |
| Meta | Catalog creates have no read contract | PARTIAL: verification exists, reconcile does not | M2 |
| Meta | 10 accounts with CONNECTION_REQUIRED | Connecting accounts is a human step, by design | M11 (one call names them all) |
| Meta | PAC creatives (`asset_feed_spec` + rules) | STILL PRESENT | M9 |
| Meta | Product sets with product-ID filters | **STALE: fixed** (up to 1,000 IDs) | M9 (convenience only) |
| Meta | Draft-mode publish | Unclear which flow you mean (Q19) | M9 |
| Meta | Safe merge of ad-set targeting | STILL PRESENT | M9 |
| Meta | Preview for each placement | PARTIAL: 7 formats, one per call | M9 |
| Google | Custom methods fail with ACCOUNT_SCOPE_MISMATCH | **STALE: fixed** in `c5d05b3e`; one message remains | M3 |
| Google | 25 operations per review | PARTIAL: groups take up to 1,000; chains and atomic edits do not | M5 |
| LinkedIn | `/rest/posts` and video upload | The contract exists, but the connection lacks `w_organization_social` and nothing can create the organization binding | M13 + Q8 |
| LinkedIn | Creates need read-only fields removed | STILL PRESENT for direct creates | M13 |
| X | Creative assembly | **STALE: fixed** since 2026-09-14 | M13 (media-key Tweets, previews) |
| X | `media_category` | **STALE: fixed** | M13 (live check) |
| X | MEDIA_MEMORY_BUSY | Partly stale: a shared pool, not a single lock | M10 |
| X | A card or Tweet edit deletes promoted-Tweet records; PAUSED ignored on promoted Tweets | Platform rules, **already guarded** | none |
| X | A single line-item create drops `goal` | The route is unguarded; the drop is unproven | M13 |
| Snapchat | PATCH broken (E1166) | Not in the code. The real defect is the missing `placement_v2`, confirmed live today | M13 |
| Snapchat | `placement_v2` at create; SKAdNetwork ignored; `creative_id` immutable; E2405 | Partial, still present, guarded and partial, in that order | M13 |
| General | Write grants lost when a connection is re-issued | By design, but silent | M11 |
| General | Reviews expire after 5 minutes | Your decision P5 | M5, after M1 |
| General | Step schema learned by failing; few recipes; prepare carries the full contract | STILL PRESENT; the contract is partly cut already (7,878 bytes full, 781 by reference) | M0, M14, M12 |
| Coverage | Microsoft Ads 31 of 291; GA4 Admin 1 of 55; Reddit 49 mapped (55 callable) of 105 | CONFIRMED | M6, M7, M8 |

---

## 5. Workflows before and after

These counts are derived from the code, not measured. The journeys added in each milestone will measure them, and their budgets may not go up.

| Workflow | MCP calls: today → after | Provider requests: today → after | UI steps removed |
|---|---|---|---|
| TikTok standard campaign, 1 advertiser | Fails at step 1 (built by hand) → 8, with 0 failures | 22 → 22 | The whole build |
| TikTok Smart+ Search, 1 advertiser | Cannot be built → about 7 | n/a → about 22 | All of it |
| TikTok go-live, 20 advertisers | 80 → about 6 | 160 → about 160 | none |
| TikTok edit of 20 ad groups | 40 → about 3 | 23 → 4 | Pixel attach, schedule type |
| Google PMax retail asset group with a tree | About 25 → about 11 | About 100 → about 22 | The 1.91:1 crop |
| Google Standard Shopping tree | 9-13 plus Ads Editor → 9 | About 20 → about 19 | 1 per account |
| Google Demand Gen | About 13 → about 9 | About 25 → about 19 | 1 per campaign |
| Google go-live, 20 accounts | About 120 → 4-6 by plan | About 760 → about 240 | none |
| Meta discovery, 10 accounts | About 43 → 1-2 | About 50 → about 50, then about 0 on repeats | none |
| Meta catalog + PAC creative | Cannot be done → 3 | n/a → about 10 | The creative |
| Meta go-live, 10 accounts | About 80 → about 4 | About 140 → about 120 | none |
| Meta recovery from a throttle | 6, after a wait of more than 10 minutes → 2 | 9-10 → N+1 | none |
| X video website-card ad | 28-39 → 16-18 | About 90 → about 55 | Preview |
| Snapchat squad | 19-26 → 14-16 | About 35 → n/a | Squad and ad edits |
| LinkedIn video or post ad | 25-34 and a hard stop → 15-17 | About 50 → about 30 | The video ad |
| Cross-platform go-live, 40 operations | 80 (about 120 with checks) → about 5 | 160 → about 120 | none |
| One creative to 20 accounts on 3 platforms | About 45 → 4-5 | 80-100 → 80-100 | The 1.91:1 crop |
| Readiness of 60 accounts | 60 or more → about 3 | 1 per account → similar | none |
| Reddit post to ad | About 11 plus a UI step → about 4 | n/a | Creative upload |

**The promise:** every row that fails today completes through AMCP. The White Friday build reproduces end to end with zero false STATE_CHANGED. The only UI steps left are genuine platform limits:

- Spark identity authorisation on TikTok;
- Merchant Center registration;
- LinkedIn's product approval;
- GA4 BigQuery and audience links, until Google's v1alpha document is pinned.

---

## 6. Your 11 ideas, and what I added

| # | Your idea | Verdict | What changes |
|---|---|---|---|
| 1 | Hash only the fields that matter | **CHANGE** | Account and parent reads check identity fields only (id, name, status, role, currency, timezone). The objects being changed stay fully checked, minus counters and timestamps, so a new field is protected by default. Signed-link parameters are never checked. STATE_CHANGED names the fields that matter and gives the exact next call. A real change is never auto-accepted, and no override flag is added |
| 2 | Batch reviews | **KEEP**, on the existing plan engine | One approval covers a multi-account plan. Each operation still has its own state re-check, idempotency key, spend and cap checks and receipt. A long temporary-ID chain is refused with a clear fix, never split; Google gets an atomic edit build |
| 3 | Plan-level builds | **KEEP**, scoped | A launch spec compiles to the existing reviewed steps. Everything is paused by default, the go-live is one reviewed batch, and plan-vs-live is the built-in check. No second graph engine is needed |
| 4 | Create active when approved | **KEEP, for child objects only** (Q1) | Ads, ad groups, keywords, asset groups and ad sets may be created active under a parent that is already serving, with the spend flag and `allow_activation`. Campaigns always start paused: "create paused, verify, activate" becomes the steps of one approved plan |
| 5 | Qualify the missing contracts | **KEEP**, ordered by what blocks | T1 first, then the blockers G5, G6 and T5, then G1, G2, G4, G8, T6, then TikTok Search and Meta PAC. Each addition ships with the provider's real error shape as a fixture |
| 6 | Actionable errors | **KEEP**, plus a `fix` field | The message carries closed-set tokens: code, operation index and field path. Example: "INVALID_ASSET_LINK at operations[3].create.fieldType". It also gets `fix: [{path, value}]` and `allowed`. The provider's own text sits in details, marked untrusted, so it cannot inject instructions |
| 7 | Media presets and fan-out | **CHANGE** | Four presets exist. Added are 1.91:1, the PMax shapes, and media sets: one push to many platforms, deduplicated by hash, with a status per platform. Also shared staging, and memory reserved by file size instead of the whole budget |
| 8 | Read helpers | **KEEP** | A GAQL validator: field names are checked offline, the other mistakes by a rule table. Scope proof for up to 100 IDs. A compact-mode switch on every gateway |
| 9 | QA tools | **KEEP**, plan-vs-live first | `verify_plan` compares budgets, dates and statuses with the live state. Then the stale promotion and sitelink scan, placement coverage, and offer coverage (after Merchant Center) |
| 10 | Health check | **KEEP**, on the existing capability graph | One `matrix` call covers read, write, credential, cooldown, rate-limit headroom and the next call for each account. Unknown stays unknown |
| 11 | Call shapes and recipes | **CHANGE** | Call shapes go in help, describe and errors, not in `tools/list`, which has no room left. Your eight recipes are added, plus LinkedIn, Reddit, Microsoft and GA4 |

**What I added:**

- **A rate governor.** It reads the providers' usage headers and paces requests before sending; nothing that was already sent is ever retried.
- **Automatic read-only reconcile** 60 seconds after any uncertain write.
- **A duplicate-create guard.**
- **Google validate-only on by default.**
- **Compact prepare responses with a handle.**
- **Field contracts as data**, one table per route, which also generates the payload skeletons.
- **Safe merge patches:** Smart+ `ad_configuration`, and Meta targeting.
- **One discovery call per account set.**
- **"Wait" states that are not errors.**
- **Live-faithful fixtures.** The Snapchat bug survived because a test fixture returned a field the live API does not.
- **A request count in every response.**

---

## 7. The roadmap

**Order.** M0 comes first, then M1. M2 and M3 can run in parallel, M4 follows M0, and M5 follows M1 and M2.

**My call on Q13:** Meta (M9) runs right after M5, alongside Microsoft wave 1, because Meta is part of the White Friday goal. M6, M7 and M8 are independent of each other, and M15 follows M8. M10 to M14 can run beside the coverage work.

**After each milestone** I push it and report what remains.

| # | Milestone | Delivers (issue IDs in Appendix A, kept as local evidence) | Done when (measurable) | Effort, risk | Needs first |
|---|---|---|---|---|---|
| M0 | Unblock | The T1 fix everywhere; T3 review text; T4 step help; T7 aliases; G9 error tokens; no spend flag on paused TikTok creates; LEAD-01 and LEAD-03 | The White Friday TikTok create prepares and executes with 0 STATE_CHANGED while the link rotates and the balance falls, on all 9 flows and the upload. A real currency, status or name change still stops it. Every create review reads "Create". `tools/list` is byte-identical. The TikTok build journey passes in 8 calls with 0 failures | S, low | Q14 |
| M1 | One check policy, every provider | Identity-only checks for account and parent reads (TikTok, X, LinkedIn, DV360); a signed-link rule; STATE_CHANGED with the fields that matter and the next call; a plan step returns to pending | Rotation tests pass on 100% of the write families. A real status, currency or budget change still fails the check | S-M, low | none |
| M2 | Recovery | Automatic read-only reconcile; lookups for TikTok, Google builds and trees, and Meta catalogs, sets, feeds, creatives and audiences; TikTok definitive refusals marked "rejected"; the duplicate-create guard; Meta usage headers and pacing before sending; a TikTok `request_id` fixed at prepare | The reconcile job never sends a write (asserted). A lost response resolves in 1 call, a rejected one in about 2. A duplicate of an uncertain create is refused | M; low, but medium-high for any "not applied" proof | Q16, Q20 |
| M3 | Google contracts | G5 Shopping and PMax trees; G1; G2; G6; G7; G4 chain refusal; G8 child activation; validate-only by default; G3 shape check | PMax retail asset group with a tree in about 11 calls (from about 25) and about 22 requests (from about 100). Standard Shopping and Demand Gen with 0 UI steps (journeys J10 to J12) | M-L; medium-high (G5) | Q1, Q28 |
| M4 | TikTok contracts | Native `tiktok_ad_update`; T5 pixel; T6 schedule; Smart+ go-live in 1 review (from 3); a TikTok Search recipe; Smart+ Search after a reference read | A Search campaign in about 7 calls, with no UI step except Spark identity authorisation | M (Search L), medium | Q6, Q16-Q18 |
| M5 | Batch and plan | One approval for up to 200 steps; background runs with progress; a receipt per operation; a stop at the first uncertain write, with resume; a Google atomic edit build; batched read-backs; `verify_plan`; the switchover recipe | 20 accounts × 2 changes in about 5 calls (from about 80) under one approval. A Google 20-account go-live in about 240 requests (from about 760) | M-L, moderate | Q2, Q3 |
| M6 | Microsoft Ads | 8 waves: every read, then budgets and bids, negatives and shared sets, audiences, conversion goals, product partitions and asset groups, media, bulk | Callable 31 → at least 126 after wave 1 → at least 184 of 291 (63%) after wave 7. Every operation mapped or blocked with a reason. A Search + Shopping launch with no UI step | L, medium | A test account (A5), Q31 |
| M7 | GA4 Admin | 6 waves: reads, custom dimensions and metrics, key events, data streams and Measurement Protocol secrets, Ads and Firebase links, retention | Admin callable 1 → at least 45 of 55 (82%). Measurement setup in about 5-6 calls with no UI step. Secrets never returned or logged | M, medium | A5, Q32 |
| M8 | Reddit | 6 waves: reads, creative assets, conversions, audiences, catalogs, account updates and a recipe | Callable 49 → at least 90 of 105 (86%). A build in about 4 calls (from about 11 plus a UI step). Content-only edits stop asking for the spend flag | M-L, medium | A5, Q31 |
| M9 | Meta | An identity-list cache (60 s at most; execute re-reads); ownership for 1-6 h; one identities read; tolerant comparison for Meta's own rewrites; PAC; catalog creatives; `targeting_patch`; previews for several placements | Requests per change: campaign 4, ad set 5, ad 5 (from 4, 6 and 6-8), and a creative from a post 6-8 (from 14). A catalog + PAC creative in 3 calls with no UI step | M (PAC L), medium | Q19, Q22-Q25 |
| M10 | Media | The 1.91:1 preset; PMax shapes; `import`; media sets; shared staging; reservation by size | One creative to 20 accounts on 3 platforms in 4-5 calls (from about 45) | M, medium | none |
| M11 | Health and grants | `matrix`; grant carry-over on re-authorisation, with confirmation; unbound accounts named in one call; LEAD-02; a read-only owner-health view for the owner's own AI session, with e-mail addresses left out and owner changes staying on the website (owner, 2026-11-15) | 60 accounts across 3 connections answered in at most 3 calls (from 60 or more). A re-issued connection names any grant it dropped | M, low | Q4, Q24, Q29 |
| M12 | Read helpers and context size | The GAQL validator; scope proof for 100 IDs; a compact switch for every gateway; paging; `prepare detail:"compact"` | The five G9 query mistakes are caught before the call, each with a hint. Prepare stays within a byte budget for each gateway | S-M, low-medium | Q30 |
| M13 | X, LinkedIn, Snapchat | Snapchat edits work (`placement_v2` treated as write-only), plus SKAdNetwork and pixel checks; the LinkedIn organization binding (admin-only, audited), a scope check and read-only fields removed; the X `goal` guard, media-key Tweets, promotion under a paused parent, previews | X video ad in 16-18 calls (from 28-39), Snapchat squad 14-16 (from 19-26), LinkedIn video or post ad 15-17 (impossible today) | M, medium | Q8, Q26, Q27, F1, F4 |
| M14 | Docs and recipes | Call shapes in help, describe and errors; your 8 recipes, plus LinkedIn, Reddit, Microsoft and GA4 | Every documented example passes the validator; every recipe passes its journey; `tools/list` unchanged unless the surface golden shows room | S-M, low | none |
| M15 | Merchant Center, reads first | A read-only gateway: accounts, products and statuses, data sources, issues, the `product_view` report; offer coverage | Parity checks pass, and scope and binding tests pass. Writes come only after a separate yes (Q7) | M, medium | Q7, Q12; Merchant API registration |
| M16 | Backlog | DV360 audience create, Apple, Business Profile, Adjust | No criteria until you set a priority | n/a | Q33 |

**Old call shapes keep working.** Every rename or new shape keeps the old one as an alias with a deprecation warning, and the surface golden test proves `tools/list` does not grow.

---

## 8. Safety gates

**These stay, because they are real protection:**

1. **Every write is reviewed and approved.** A plan's single approval still re-checks every operation at execute.
2. **Spend confirmation for every real spend change:** any ENABLE, budget, bid, schedule or targeting widening. A paused create with no spend is exempt only where its shape fixes it as paused (Q14).
3. **Your caps, with overrides by you only.** A plan's parts count together.
4. **`allow_activation` and `allow_deletion`.**
5. **Idempotency keys and single dispatch.** A lost response is never resent; now it is reconciled by reads.
6. **The state re-check at execute, on the fields that matter.** The execute-time reads are never cached.
7. **Uncertain writes fail closed.** "Not applied" is accepted only where the provider proves it.
8. **Paused creation by default.** Campaigns always start paused.
9. **The review fingerprint:** what was reviewed is what is sent.
10. **Ownership and scope checks.** Renewal comes only from the account's own list, never from an ID the caller supplies, and never at execute.
11. **Redaction.** No secrets or signed links in logs, responses or audits; provider text stays in details, marked untrusted.
12. **Human gates stay human.** Write grants are given on the website only, with no MCP path, and two-step verification stays.
13. **Checks that mirror real provider refusals:**
    - TikTok identity and pixel;
    - Meta Page and Instagram;
    - Snapchat pixel;
    - local copies of documented provider rules, each now with a review date;
    - all-or-nothing builds;
    - tree completeness;
    - the personal-data blocks;
    - one write at a time per target;
    - the 5-minute review window, until you reopen P5.

**These go, because they are false alarms or friction:**

- Fields that change by themselves inside the check (the T1 class).
- Wrong review text (T3).
- The spend flag on paused creates (Q14).
- Smart+ children forced to DISABLE.
- X and LinkedIn child objects forced paused under a paused parent.
- The X promotion flag under a paused parent (Q26).
- PARENT_SERVING as a second gate when you confirm spend for a child object (Q1).
- "Uncertain" for refusals the provider declares definitive (narrow, with evidence first).
- A STATE_CHANGED that fails a plan step and gives no next call.
- Required extra `inspect` calls and triple reads.
- "HTTP 400" with nothing to change.
- 5-minute ownership for IDs that cannot change account.
- A person's sign-off after a complete empty read (Q21).
- Exact comparison of values the provider normalises.
- A second approval to register an X video.
- Four Tweets per promotion.
- Whole-budget media reservations.
- Reddit's spend flag on content-only edits.
- Grants dropped silently on re-authorisation.

**These are not friction and stay untouched:**

- the ENABLE flag and your caps;
- STATE_CHANGED on real changes;
- PARENT_SERVING under a serving parent, except for children after Q1;
- the destructive tier;
- one ad per review on TikTok;
- X `CREATIVE_IN_USE`;
- Snapchat `INCOMPLETE_*_REPLACEMENT`;
- the LinkedIn binding and scope checks.

---

## 9. How each milestone is tested and released

**Offline first, for every change:**

- unit and contract tests;
- property tests:
  - fields that rotate never trip the check, and real changes always do;
  - no temporary-ID chain is ever split;
  - nothing is dispatched twice;
  - no child serves under a paused parent;
  - every tolerant comparison has a negative case;
- journeys whose call and byte budgets may not go up.

The White Friday responses become fixtures, and every entity gets one live-faithful fixture.

**Release gate.** Every push deploys production, so a milestone ships only after all of these pass:

1. The full gate on **Node 24.22.x, the version Railway uses, and on the local Node 24.19.0**. Both runs record their Node and SQLite versions, and a runtime-parity test pins the SQLite-dependent behaviour (the 3.54 lesson).
2. The browser qualification.
3. The container check.
4. The pre-push scan: no test-account IDs, local paths or secrets.

After the deploy:

- `/healthz` responds;
- `/versionz` shows the pushed commit;
- the MCP `tools/list` matches the golden.

A rollback is a revert push, so storage changes carry forward-and-back tests.

**Live checks.** Only the agreed test accounts are used, never client accounts.

- Objects are named DNU, stay paused with no spend, and are **deleted after the check** (the scope of the deletions is Q5).
- Test images come from your Drive folder, through AMCP's media upload from the Drive links. If that path needs the Drive connection switched on, I'll tell you.
- Reads come first and validate-only next. A write is made only where a fact can be settled no other way.
- **A go-live is never tested live**, because nothing may go live. It is proven by fixtures and validate-only.
- TikTok has no sandbox, so the real test advertiser is used, paused.
- The X sandbox has no uploads.

**Test-account readiness, checked today:**

| Platform | Account | Connected | Write grant | Note |
|---|---|---|---|---|
| Google | the agreed test account | yes, since your message today | yes | Merchant Center linked; a real account, so creates stay paused |
| Meta | the agreed test account | yes | yes | Use this one |
| Meta | the two other agreed test accounts | **no** | n/a | Optional: connect them only if you want them used |
| TikTok | the agreed test account | yes | yes | No licence file, so T1 is proven offline |
| Snapchat | the agreed test account | yes | yes | |
| LinkedIn | the agreed test account | yes | yes | Lacks `w_organization_social` (Q8) |
| X | the agreed test account | yes | yes | |
| GA4 | the agreed test property (the 2026-11-01 list) | yes | yes | Confirm it is still your test property (A5) |
| Microsoft Ads, Reddit | none | **no** | n/a | Needed for M6 and M8 (A5) |

**Round 1-2 live checks.** You also allowed these on production. They are what moves the Round 1-2 label from BLOCKED, so I'll run them alongside M0 under the same rules.

---

## 10. My rulings on the drafter's open points

| Point | Ruling |
|---|---|
| Fixed field lists only for account and parent reads; objects being changed stay fully checked | Accepted. A fixed list on a target would silently stop protecting a new field |
| A long temporary-ID chain is refused, never split | Accepted. A split chain breaks its own references, so the refusal names the two-phase plan |
| Create-active for child objects only | Accepted, and recommended to you as Q1 |
| Throttles are retryable only when nothing was sent; a Meta "not applied" proof only after your decision | Accepted (Q20). It protects against double creates |
| Meta: no response echo to verify from; the savings come from caching identity lists | Accepted |
| Write groups stay single-account; cross-account work goes through plans | Accepted |
| GAQL validator: field names offline, the rest by a rule table | Accepted |
| `tools/list` growth is settled by the surface golden | Accepted: nothing grows unless the golden shows room |
| Error messages carry tokens only, with provider text in details | Accepted. It keeps the prompt-injection guard and still says exactly what to change |
| `TALL_PORTRAIT` is probably 9:16 | To be confirmed against Google's reference and a live link check in M3 |
| The X creative and `media_category` items are stale; X `goal` gets a guard and a live check | Accepted |
| Q13: coverage before Meta? | Meta (M9) runs right after M5, alongside Microsoft wave 1 |

---

## 11. Decisions and facts I need

### 11.1 To start Phase 2

My recommendation comes first in each item.

- **A1. Approve the plan.** Approve M0 to M15 in the order of section 7. Each milestone is pushed to Work-here-V2, which deploys production, when its gate passes, and I report the gaps after each one. M16 stays a backlog.
- **A2. Five safety decisions:**
  - **Q14** A paused TikTok create stops needing `spend_change_confirmed`. **Yes.** Caps, `allow_activation` and the flag on every ENABLE stay.
  - **Q1** Create-active. **Child objects only, under a serving parent, with the spend flag and `allow_activation`.** Campaigns always start paused.
  - **Q2** Review window. **Keep 5 minutes now.** Revisit after M1, with the friction numbers in hand.
  - **Q20** Meta throttles counted as "not applied". **No, for now.** Pacing and automatic reconcile need no such rule.
  - **Q5** What "delete what you create" covers. **Everything I create on a test account:** campaigns, ad sets and groups, ads, creatives, media and audiences. Anything a platform will not delete stays paused, named DNU and listed. Deleting needs `allow_deletion` on the test accounts; if it is off, I'll tell you at the first clean-up.
- **A3. Node 24.22.x.** May I download the official Node 24.22.x zip from nodejs.org again, checked by SHA-256 and kept in the scratchpad for Round 2.5? The release gate needs it. **Yes recommended.**
- **A4. Round 1-2 live checks.** These run alongside M0, under the rules in section 9.
- **A5. Test accounts (Q11):**
  - **Confirm the GA4 test property of the 2026-11-01 list** as the agreed GA4 test account.
  - **Connect a Microsoft Ads test account** (or let me use the sandbox harness) **and a Reddit ad account** before M6 and M8. Without them those milestones ship on fixtures only, labelled "unverified live".
  - Connecting the two other Meta accounts is optional.
- **A6. Friction baseline.** Before M1, please run `amcp_workspace health` once and paste its `review_friction` block. Only the owner can read it. Otherwise I can measure only after M1.

### 11.2 Before each milestone

I'll follow these recommendations unless you say otherwise.

| # | Question | Recommendation |
|---|---|---|
| Q3 | Default approval mode for spend, caps and deletion | Keep it; opt-in website approval for high-spend accounts; one plan-level approval (M5) |
| Q4 | Grant carry-over on re-authorisation | One confirmation by you, same provider login only, each account re-verified |
| Q6 | TikTok Search order | Standard Search first; Smart+ Search after a reference build you make in the UI (paused, DNU) |
| Q7 | Merchant Center scope | Read-only first; writes only after a separate yes |
| Q8 | LinkedIn `w_organization_social` | Check the developer portal and apply for Community Management now; the binding and the scope check ship regardless |
| Q9 | The 10 unbound Meta accounts | Connect only what a launch needs; one call names the missing ones (M11) |
| Q10 | Ratify the SDK v2 dependency | Ratify, with the Node-parity evidence on the deployed commit |
| Q12 | Merchant Center order | After M8; its prerequisites start during M3 |
| Q15 | TikTok advertiser record kept in reviews | Only id, name, status, role, currency, timezone, country |
| Q16 | TikTok `request_id` and the "rejected" proof | `request_id` after the dedupe check; the proof after the invalid-create check |
| Q17 | TikTok's native `tiktok_ad_update` shape (additive) | Yes |
| Q18 | Read TikTok's signed-in documentation (catalogs, pixel events, copy, rules) | Yes, as a read-only evidence task in M4 |
| Q19 | Meta "draft-mode publish": which flow did you mean? | Default: build paused and validated, then publish once; please confirm |
| Q21 | A person's sign-off after a complete empty read | No; the read is recorded as evidence |
| Q22 | Meta ownership lifetime | 6 h for IDs that AMCP listed or created, 24 h after a verified read-back; shared classes stay 5 min |
| Q23 | A 60-second identity-list cache at prepare | Yes; execute re-checks |
| Q24 | Who sees reachable but unbound accounts | Administrators only |
| Q25 | Meta order | PAC and catalog creative, then the targeting merge, then the clone builder |
| Q26 | X promotion under a paused parent without the spend flag | Yes |
| Q27 | X targeting batch under an ACTIVE parent | No change |
| Q28 | Raise Google's 25-operation family limit | Decide after batched read-backs ship |
| Q29 | Provider access register | You fill it in for Google Ads, Meta, TikTok and LinkedIn (data entry only) |
| Q30 | Compact profile for agent clients | Build the switch in M12; your own client moves first |
| Q31 | Conversion uploads and audience user uploads (Microsoft, Reddit) | Stay blocked until a hashed-identifier contract is agreed |
| Q32 | GA4 key events and Ads links treated as spend changes | Yes |
| Q33 | Later gateways | Nothing before M15; DV360 audience create first |

### 11.3 Facts only you have

- **F1:** Were LinkedIn organization bindings ever set up by hand on production?
- **F2:** Does the Meta app hold `catalog_management` and advanced access?
- **F3:** Is `native_request` (enhanced mode) on in production?
- **F4:** For the Snapchat E1166 incident: the version, the request body and the error.
- **F6:** Is there a DV360 test account?
- **F7:** What are the production `AMCP_MEDIA_*` values?
- **F5** was answered today: Google has a Merchant Center link, and the TikTok advertiser has no licence file.

---

## 12. After you approve

1. I cut a branch from Work-here-V2 and start M0.
2. Sonnet 5.5 at maximum effort implements, working from complete briefs. I review each task and the branch, then run the gates on both Node versions.
3. The milestone is pushed to Work-here-V2, which deploys production. Then come the smoke check and a short report of what remains.
4. The plan enters the repo as `docs/plan/workflow-seamlessness.md`, with the test-account IDs removed, because repository records never carry them.
5. Round 3 is still waiting for your separate authorization.
