---
status: record
tier: engineering
---

# X scheduled Tweets — 2026-09-27

Base revision: `bff2fa6` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: line items can already promote a scheduled Tweet (scheduled promoted Tweets), but the scheduled
Tweet itself could not be created, edited or deleted. Its three rows were blocked writes.

Contract source: the X Ads API v12 Creatives reference and guide, "Scheduled Tweets", read on
2026-09-27. Key facts:

- `POST accounts/:account_id/scheduled_tweets` takes `as_user_id` and `scheduled_at` (ISO 8601, "at
  least 5 minutes in the future"), `text` (required without media), `card_uri`, `media_keys` (up to
  4 images, 1 GIF or 1 video) and `nullcast` (promoted-only by default).
- "For scheduled Tweets, edits can be made until the Tweet's scheduled_at time" (text, card, media,
  nullcast); DELETE removes it before it is published. At that time X publishes the Tweet and fills
  `tweet_id`; `scheduled_status` is SCHEDULED or FAILED.

## Change

New reviewed family `x_scheduled_tweets` (`src/x-scheduled-tweets.ts`):

| Part | Behaviour |
|---|---|
| Request | Create (author, UTC time at least 10 minutes ahead, text of up to 280 characters, a card or up to four images, one GIF or one video), edit (text, card, media; an empty string removes the card or media) or delete; promoted-only (`nullcast` true); the time never changes |
| State | The account, the scheduled Tweet, the author among the promotable users, the card and each media item; for deletions, the scheduled promoted Tweets that name it |
| Checks | Only a SCHEDULED Tweet without `tweet_id` changes, and edits stop 10 minutes before publication; the author is a FULL promotable user; the card exists and media is ready; a card and media do not go together; unchanged values are refused |
| Safety | Nothing serves until a line item promotes the Tweet, so no spending confirmation; deletions count as deletions under owner policies and the review lists the line items that promote the Tweet |
| Receipt | The returned scheduled Tweet must be the one named (author, time, SCHEDULED for a creation) with the values sent; anything else is a failure never resubmitted |
| Verification | The scheduled Tweet read again: text, card, media, nullcast and time, or gone |

Other code: `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts`
and `src/provider-contracts.ts` (X contract version 12). Guidance: "X scheduled Tweets" in
`Skills/amcp-campaign-builder/references/linkedin-x.md` and an executable inspect example.

## Tests

`tests/x-scheduled-tweets.test.mjs`, five tests:

1. A Tweet with a card and one with two images are scheduled and verify; the text and media of the first change and verify; a replay sends nothing.
2. A scheduled Tweet is deleted and verifies gone; the review names the line item that promotes it; an owner deletion rule refuses deletions but not creation.
3. Fifteen malformed requests fail before any request.
4. Published, imminent and unknown Tweets, another author type, a deleted card, media still processing, mixed media and unchanged values are refused after reading, without writes.
5. A receipt for another author is a failure never resubmitted; ignored changes are not verified; the ledger lists the three writes in the family.

Red/green against a build of `bff2fa6`: all five tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/x-scheduled-tweets-20260927/red-check.log`.

## Verification

- Targeted: 176 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,903/1,903. A first run reported one failure:
  `tests/google-upload-restart.test.mjs` could not remove its temporary directory (`ENOTEMPTY`) while
  another candidate was being qualified; that file passes alone and the rerun above passed in full.
- Guidance coverage: 304 write-path refusals across 173 modules accounted for.
- Full qualification: see
  [X-SCHEDULED-TWEETS-VERIFICATION-2026-09-27.json](X-SCHEDULED-TWEETS-VERIFICATION-2026-09-27.json).

Remaining rows: 789 (three X rows reviewed; X blocked writes 49 → 46). Live acceptance is
unverified; it needs the updated deployment and an X Ads account with a promotable user.
