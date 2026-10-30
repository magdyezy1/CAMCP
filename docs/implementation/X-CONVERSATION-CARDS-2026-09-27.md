---
status: record
tier: engineering
---

# X poll and conversation cards — 2026-09-27

Base revision: `b45d675` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: X website cards could be created, but not the poll, image conversation and video
conversation cards that engagement campaigns use. Their three creation rows were blocked writes.

Contract source: the X Ads API v12 Creatives reference ("Poll Cards", "Image Conversation Cards",
"Video Conversation Cards"), read on 2026-09-27. Key facts:

- Poll cards: `name`, `duration_in_minutes` (5–10080; "This starts as soon as the card is created
  and not when it is added to a Tweet"), two to four choices of up to 25 characters (the third
  needs the first two, the fourth the third) and an optional `media_key` from the media library
  (Media Forward Polls need the `PROMOTED_MEDIA_POLLS` account feature). "It is not possible to
  update (PUT) poll cards."
- Conversation cards: `name`, `media_key` (an image of at least 800 px at 1.91:1, or a 16:9 video),
  `first_cta` and `first_cta_tweet`, up to three more CTAs (hashtags of up to 20 characters after
  the #, each with its Tweet text), `thank_you_text` (up to 23 characters), `title` (up to 23,
  required without a second CTA), and optional `thank_you_url`, unlock media and, for video cards,
  `poster_media_key`.
- Each card reads back at `GET accounts/:account_id/cards/{type}/:card_id`; media keys are
  write-only on polls.

## Change

New reviewed family `x_conversation_cards` (`src/x-conversation-cards.ts`), creation only:

| Part | Behaviour |
|---|---|
| Request | The documented fields of each card type in the body, with their lengths, order rules and distinct choices or hashtags; https thank-you URLs; media keys of the media library |
| State | The account, each media item (type, transcoding status, deleted) and, for a media poll, the account features |
| Checks | Missing or deleted media is `STATE_NOT_FOUND`; media of the wrong type or not yet transcoded, and media polls without `PROMOTED_MEDIA_POLLS`, are refused |
| Safety | A card reaches no one until a promoted Tweet uses it, so no spending confirmation; the review says a poll opens at creation |
| Receipt | A reply without a card ID and card URI is a failure never resubmitted |
| Verification | The new card read again, comparing every field sent (media keys except on polls) |

Editing and deleting these cards stay blocked: they need the promoted Tweet usage scan of the
website card contract (`src/x-creative-writes.ts`). New refusal code:
`INVALID_X_CONVERSATION_CARD`; `STATE_NOT_FOUND` is reused.

Transport: `src/transport.ts` sent every POST or PUT under `/cards/` as JSON, which the newer `/cards`
route requires. The poll and conversation card routes take form parameters (the reference passes them
as parameters), so they now go as form data, like the other X Ads writes; `/cards` keeps JSON.

Other code: `src/preflight.ts` (spending exemption), `src/write-review.ts`,
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`,
`src/reviewed-routes.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (X contract
version 14). Guidance: "X poll and conversation cards" in
`Skills/amcp-campaign-builder/references/linkedin-x.md` and an executable inspect example.

## Tests

`tests/x-conversation-cards.test.mjs`, four tests:

1. A text poll, a media poll (the account features are read), an image conversation card with an unlock image and a video conversation card with a poster are created as form data and verify; a replay sends nothing.
2. Sixteen malformed cards (another account, one choice, a fourth choice without a third, a long choice, equal choices, 4 and 10081 minutes, a CTA without #, a long hashtag, a CTA without its Tweet, a third CTA without a second, one CTA without a title, a long thank-you text, an http URL, a malformed media key, an unqualified field) are refused before any request.
3. Missing and deleted media, a video still transcoding, a video as a card image, a video as a poster and a media poll without the feature are refused after reading, without writes.
4. An error reply and a receipt without a card ID are never resubmitted; a card X did not keep or changed is not verified; the ledger lists the three rows in the family while card deletion stays blocked.

Red/green against a build of `b45d675`: all four tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/x-conversation-cards-20260927/red-check.log`.

## Verification

- Targeted: 205 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 2,042/2,042.
- Guidance coverage: 338 write-path refusals across 200 modules accounted for.
- Full qualification: see
  [X-CONVERSATION-CARDS-VERIFICATION-2026-09-27.json](X-CONVERSATION-CARDS-VERIFICATION-2026-09-27.json).

Remaining rows: 717 (three X rows reviewed; X blocked writes 43 → 40). Live acceptance is
unverified; it needs the updated deployment and an X Ads account with media library assets.
