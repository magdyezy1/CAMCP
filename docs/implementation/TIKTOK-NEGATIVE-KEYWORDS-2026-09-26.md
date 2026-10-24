---
status: record
tier: engineering
---

# TikTok Search Ads negative keywords — 2026-09-26

Base revision: `242470d` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: manual TikTok ad groups serve in Search results when Automatic Search Placement is on (the
default when objective and placement allow it). Negative keywords are how advertisers keep those
Search Ads off irrelevant or brand-unsafe queries. The three write routes were blocked.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:
[Create negative keywords](https://business-api.tiktok.com/portal/docs/create-negative-keywords/v1.3),
[Update a negative keyword](https://business-api.tiktok.com/portal/docs/update-a-negative-keyword/v1.3),
[Delete negative keywords](https://business-api.tiktok.com/portal/docs/delete-negative-keywords/v1.3),
[Get negative keywords](https://business-api.tiktok.com/portal/docs/get-negative-keywords/v1.3) and
[Create Search Ads](https://business-api.tiktok.com/portal/docs/create-search-ads/v1.3).
Key facts: campaigns need an ad group with Automatic Search Placement; up to 50 objects and 1,000
keywords per add; names of at most 80 characters without 15 special characters; one match type
per name; at most 10,000 keywords per ad group. Add and delete return an empty `data`; update
returns `new_keyword_id`. The keyword list reads 1–50 per page.

## Change

New reviewed family `tiktok_negative_keywords` (`src/tiktok-negative-keywords.ts`).

| Part | Behaviour |
|---|---|
| Request | The documented fields only; the selected advertiser; `CAMPAIGN` or `ADGROUP`; up to 10 objects per add (each list is read completely); names, characters and match types as documented; one entry per name; updates need an explicit `match_type` because TikTok otherwise sets `BROAD_WORD` |
| State | The ad groups, or the campaigns and their ad groups (up to 100, else `INCOMPLETE_STATE`); every page of each keyword list through a bounded reader (page counts must stay stable; more than 200 pages is refused after the first page) |
| Checks | Automatic Search Placement on the ad group, or on an ad group of the campaign; existing names (without case) refused unless replacing; absent deletions refused; updates must change something and must not clash with another keyword; at most 10,000 keywords after the edit |
| Safety | Plain additions only narrow delivery and need no spending confirmation. Deletions, replacements and updates need `spend_change_confirmed` and count as serving under an activation-forbidding owner policy; deletions and replacements count as removals |
| Receipt | `code 0` with a data object; an update must return `new_keyword_id`. A failed receipt is never resubmitted |
| Verification | Every list is read again and compared by name (without case) and match type |

Other code: the reader chains of `src/write-review.ts` and `src/write-verification.ts`,
`src/write-impact.ts`, `src/preflight.ts`, `src/spend-policy.ts`, `src/execution-risk.ts`,
`src/reviewed-routes.ts`, `src/types.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts`
(TikTok contract version 21). Guidance: "TikTok Search Ads negative keywords" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect example.

## Tests

`tests/tiktok-negative-keywords.test.mjs`, eight tests:

1. Two keywords added to an ad group with 60 keywords read both pages, need no spending confirmation, write once, verify and replay.
2. A campaign with a search-enabled ad group gets a keyword and verifies; a campaign without one is refused.
3. A deletion, a rename with a new match type and a replacement each need spending confirmation, and each result verifies.
4. An ad group without search, an existing name (other case), an absent keyword, a clashing rename, an empty update and an unknown ad group are refused before any write.
5. Ten malformed requests (forbidden character, 81 characters, a repeated name, an unknown match type, an update without match type, eleven objects, a numeric ID, an unknown field, an unknown object type, an empty deletion) fail without network requests.
6. Owner policies: deletions and replacements are refused when deletions are forbidden; a rename is refused when activation is forbidden; plain additions pass.
7. A page count that changes during the read, a list over 200 pages (refused after one page) and a campaign with more than 100 ad groups never become complete state; a keyword added after review stops execution with `STATE_CHANGED`.
8. An update receipt without `new_keyword_id` stays a failure, is replayed rather than resubmitted, and is not verified as success.

Red/green: all eight fail against a build of `242470d` (no reviewed family,
`WRITE_CONTRACT_UNAVAILABLE`) and pass with this change. Local log:
`.runtime/tiktok-negative-keywords-20260926/red-check.log`.

## Verification

- Targeted: 117 related suites (including every TikTok suite), 1,441/1,441.
- Guidance coverage: 255 write-path refusals across 135 modules accounted for.
- Full qualification: see
  [TIKTOK-NEGATIVE-KEYWORDS-VERIFICATION-2026-09-26.json](TIKTOK-NEGATIVE-KEYWORDS-VERIFICATION-2026-09-26.json).

Remaining rows: 917 (three TikTok rows reviewed; TikTok blocked writes 191 → 188). Live acceptance
is unverified; it needs the updated deployment and a test advertiser with a search-enabled ad group.
