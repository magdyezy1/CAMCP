# Google list, items 1–10 — 2026-09-29

Source: the owner's list of Google edits found while rebuilding a Search campaign through AMCP (live use from
24 to 29 September 2026), with the request to "think and apply improvement to every other platform". Everything
below was built and tested against synthetic fixtures shaped from the pinned Google Ads v25 contract
(`.mirror/VENDOR/google-ads-v25.json`) and the owner's reports. No live provider call, credential, OAuth grant,
permission, deployment, Railway setting or DNS record was touched.

## Items

| Item | Status | Commit | Tests | Evidence |
|---|---|---|---|---|
| 1 Conversion-goal check rejects Google's own names | fixed (F-84) | `3efa931` | `tests/google-conversion-goals.test.ts`, `tests/google-conversion-actions.test.ts` | The check expected `{number}~{number}`; Google names goals `{category}~{origin}`. Red: 55 of 72 tests with fixtures moved to Google's names. Green: 72 of 72, including three non-purchase goals set non-biddable in one review and read back |
| 2 Capability list matches reality | fixed (F-87) | `ed5bd36` | `tests/capability-honesty.test.ts` | Every capability level is `unsupported`, `implemented_unverified` or `partial_unverified`; a workspace's dashboard lists what it has itself verified live, per provider |
| 3 Stay connected, truthful health | fixed (F-88) | `9e62ac9` | `tests/mcp-availability.test.ts` | `/healthz` checks the database, disk and an in-memory MCP round trip and answers 503 naming the failed check; refusals before MCP are JSON-RPC errors a client can read instead of "Connection closed"; one log line per refused request; keep-alive 65 s. Weeks without a dropout can only be shown live |
| 4 Split large requests | fixed (F-104) | `5ada95f` | `tests/grouped-reviews.test.ts` | 84 negative keywords: one review of four parts, approved and executed once, all 84 verified; a failed part stops the group and is never re-sent |
| 5 One review for a whole build | fixed, not all-or-nothing (F-105) | `4d1ec94` | `tests/campaign-plan-approval.test.ts` | An 11-step plan approved once and run in one call; each step still a frozen, read-back review. All-or-nothing needs Google's multi-resource mutate as its own reviewed family (open question 1) |
| 6 Paused parents cover children | fixed (F-103, the owner's loosening) | `cce3020`, `1490fa2` | `tests/google-paused-parents.test.ts` | Keywords, ad groups, asset groups and ads may start ENABLED when the review reads a parent as PAUSED, at prepare and at execute; under a serving parent they start PAUSED. A new campaign always starts PAUSED |
| 7 Slim responses | fixed (F-89, and S1 for plans) | `3e0b396`, `64bced8` | `tests/write-evidence.test.ts`, `tests/campaign-plan-views.test.ts` | The contract is sent once per session and gateway, then a reference; plan responses at most 12 KB |
| 8 Errors name the exact problem | fixed (F-86) | `3429c3a` | `tests/search-waste-format.test.ts` | Unsupported arguments are named with the accepted ones, or the size and the limit; every refusal names its field; the search-waste capture and analyze calls are documented |
| 9 Keyword Planner and Audience Insights | fixed (F-85) | `c5d05b3` | `tests/google-planning-reads.test.ts` | The two customer-less service reads were refused by the scope guard; all 28 planning reads and their 17 legacy names now reach Google once at the documented path |
| 10 Build templates: clone with changes | fixed (F-106) | this record's commit | `tests/campaign-clone.test.ts` | `amcp_campaign clone` reads a Search campaign (budget, bidding, networks, location, language and negative keyword criteria, ad groups, keywords, responsive search ads) into a draft plan under a new name with `changes`; approve once and run |

## Every other platform

| Improvement | Where it applies |
|---|---|
| Contract once per session, then a reference (7) | Every gateway's `amcp_write` inspect and prepare, and every campaign plan step |
| Refusals that name the field (8) | Every platform's refusal messages and the workspace tools |
| Capability honesty (2) | Every provider's contract view and `CONTRACTS.md` |
| Health and dropouts (3) | The server itself: every MCP client and platform |
| Parts behind one approval (4) | Google Ads mutations and Snapchat batches (the two families with a 25-record review limit) |
| Approve a plan once and run it (5) | Every platform's campaign plans |
| Compact plan views, in-place amendment, mismatch acceptance (Snapchat brief S1, S2, S5) | Every platform's campaign plans |
| Clone (10) | Google Search and Snapchat. Meta has its native copies (`meta copies`); other platforms are refused with `CLONE_UNSUPPORTED` |
| Paused parents (6) | Google only, as asked. Snapchat, Meta and the others keep "create PAUSED" (open question 2) |

## Open questions for the owner

1. **All-or-nothing builds.** Google's `googleAds:mutate` can create a budget, campaign, criteria, ad groups, keywords
   and ads atomically with temporary IDs. AMCP reviews one resource family per call, so today a failed step leaves
   the earlier ones in place (created PAUSED). Recommendation: add it as its own reviewed family, reviewed and
   verified per operation, if atomic builds matter more than the extra review size.
2. **Paused parents on other platforms.** The same rule would save a second pass on Snapchat (squads and ads under a
   paused campaign), Meta and TikTok. It loosens a check, so it waits for your yes per platform. Recommendation: yes
   for Snapchat, whose child reviews already read the parent; Meta and TikTok once their reviews are shown to read it.
3. **Owner policy `allow_activation: false`.** Such a policy still refuses any create with an ENABLED status, even
   under a paused parent; a clone or recipe under that policy must set its children PAUSED (`changes.set`).
   Recommendation: keep it; the policy is the owner's explicit "nothing goes live" switch.

## Retest plan (live, on the "test" account)

1. Set the non-purchase conversion goals non-biddable in one review and read them back (item 1).
2. Read the Google contract: levels say `implemented_unverified` until a live read-back; the dashboard's
   `live_verified` lists what this workspace has verified (item 2).
3. Watch `/healthz` and the server's refusal log for a week; any MCP refusal should reach the client as an error
   with its reason, not "Connection closed" (item 3).
4. Prepare the 84 negative keywords in one `amcp_write prepare`: one review, four parts, one execute (item 4).
5. `amcp_campaign clone` the rebuilt Search campaign under a new name with a budget change; `approve`, then `run`;
   every step verified, everything under the paused campaign ENABLED, and enabling the campaign the only activation
   left (items 5, 6 and 10).
6. Compare response sizes with the 24 September run: no 6 KB contract repeated after the first prepare (item 7).
7. Send a misnamed field to `amcp_reporting` and a legacy Google call: the refusal names it (item 8).
8. Run Keyword Planner ideas and Audience Insights eligible dates (item 9).
