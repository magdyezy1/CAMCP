---
status: record
tier: engineering
---

# X promoted accounts, media creatives and scheduled promoted Tweets — 2026-09-27

Base revision: `4403458` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: follower campaigns promote an account, in-stream video and Audience Platform image campaigns
serve account media through media creatives, and scheduled promoted Tweets launch ads with Tweets
published later. Their create and delete routes were blocked writes (six rows), so these campaigns
could not be completed through AMCP.

Contract source: the X Ads API v12 Campaign Management reference, "Promoted Accounts", "Media
Creatives" and "Scheduled Promoted Tweets" (docs.x.com copy read on 2026-09-24 and rechecked
2026-09-27). Key facts:

- `POST accounts/:account_id/promoted_accounts` associates `user_id` with `line_item_id`: X refuses
  line items not configured for promoted accounts (`INCOMPATIBLE_LINE_ITEM`) and ineligible users,
  and ignores a user already promoted. Promoted accounts cannot be updated.
- `POST accounts/:account_id/media_creatives` associates `account_media_id` with `line_item_id` for
  in-stream (`PREROLL`) or image ads; `landing_url` is for image ads, ignored for preroll assets and
  required when the line item objective is `WEBSITE_CLICKS`.
- `POST accounts/:account_id/scheduled_promoted_tweets` associates `scheduled_tweet_id` with
  `line_item_id`; the scheduled Tweet becomes a promoted Tweet when it is published.
- None of them can be updated; promoted accounts and media creatives are created with
  `entity_status: ACTIVE`; DELETE marks an association deleted.

## Change

New reviewed family `x_line_item_associations` (`src/x-line-item-associations.ts`):

| Part | Behaviour |
|---|---|
| Request | Promoted account creation with a line item and a numeric user ID; media creative creation with a line item, account media and an optional website URL; scheduled promoted Tweet creation with a line item and a numeric scheduled Tweet ID; deletion by ID |
| State | The account, the association (deletions), the line item, its campaign, the line item's current associations, and the promotable users, the account media item or the scheduled Tweet |
| Checks | Deleted line items, campaigns and media refused; promoted accounts need a `PROMOTED_ACCOUNT` line item and a promotable user; the landing URL rules; scheduled Tweets need a `PROMOTED_TWEETS` or `PROMOTED_ACCOUNT` line item and must not be published yet; duplicates are `CONFIGURATION_EXISTS` |
| Safety | Creation needs `spend_change_confirmed` and counts as activation under owner policies; the impact says whether it serves at once or when the scheduled Tweet is published; deletion counts under the deletion policy |
| Receipt | The association X returns must carry the line item and user, media or scheduled Tweet sent (or be deleted); otherwise a failure that is never resubmitted |
| Verification | The association read by ID: line item, user, media or scheduled Tweet, landing URL, or deleted |

Other code: `src/spend-policy.ts`, `src/preflight.ts`, `src/write-review.ts`,
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (X contract version 8). Guidance: "X
promoted accounts, media creatives and scheduled promoted Tweets" in `Skills/amcp-campaign-builder/references/linkedin-x.md`
and an executable inspect example.

## Tests

`tests/x-line-item-associations.test.mjs`, six tests:

1. A user is promoted once after spending confirmation and verifies; a replay sends nothing; removing the promotion verifies.
2. A banner media creative with a landing URL is created and verifies; a missing landing URL on a WEBSITE_CLICKS line item and a landing URL on preroll media are refused; an owner policy without activation refuses a new media creative.
3. A scheduled Tweet is promoted once after confirmation and verifies; already promoted, published and unknown scheduled Tweets and a MEDIA line item are refused; removing the promotion verifies.
4. Ten malformed requests fail before any request.
5. Incompatible, deleted or unknown line items, users and media, and duplicates are refused after reading, without writes.
6. A receipt for another line item is a failure that is never resubmitted; an ignored deletion is not verified; the ledger lists the six writes in the family.

Red/green against a build of `4403458`: all six tests fail (no reviewed family: the six routes were blocked writes). Local log:
`.runtime/x-line-item-associations-20260927/red-check.log`.

## Verification

- Targeted: 157 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,820/1,820.
- Guidance coverage: 277 write-path refusals across 155 modules accounted for.
- Full qualification: see
  [X-LINE-ITEM-ASSOCIATIONS-VERIFICATION-2026-09-27.json](X-LINE-ITEM-ASSOCIATIONS-VERIFICATION-2026-09-27.json).

Remaining rows: 864 (six X rows reviewed; X blocked writes 64 → 58). Live acceptance is
unverified; it needs the updated deployment, a follower line item and a promotable user, an
in-stream or image line item with account media, and a scheduled Tweet.
