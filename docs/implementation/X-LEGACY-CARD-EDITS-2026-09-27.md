---
status: record
tier: engineering
---

# X poll and conversation card edits and deletions — 2026-09-27

Base revision: `24facf6` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: poll and conversation cards could be created (the previous batch), but not edited or deleted.
An edit or deletion can break the promoted Tweets that show the card, so it needs the promoted
Tweet usage scan that the website card contract already runs. The five rows (two edits, three
deletions) were blocked writes.

Contract source: the X Ads API v12 Creatives reference, read on 2026-09-27: `PUT` and `DELETE`
`accounts/:account_id/cards/image_conversation/:card_id` and `.../video_conversation/:card_id`
take the creation fields; `DELETE .../poll/:card_id` deletes a poll ("It is not possible to update
(PUT) poll cards"); `GET` of each route reads one card, with `deleted` after a deletion.

## Change

`src/x-creative-writes.ts` (the `x_creatives` family of website cards) now recognizes these routes:

| Part | Behaviour |
|---|---|
| Request | Conversation card edits take the creation fields of their type, each checked like creation (hashtags, text lengths, https URL, media keys); a deletion takes no body. Poll edits stay unmapped: X has none |
| State | The account, the card on its own route, any new media (ready, and an image or video as the field needs) and the promoted Tweets of every line item, with each Tweet's card |
| Checks | A card that promoted Tweets use is `CREATIVE_IN_USE` until `creative_edit_confirmed=true` is sent with the affected ads reviewed, as for website cards |
| Safety | Deletions count under owner deletion policies |
| Receipt | The returned card must be the one named, deleted after a deletion; anything else is a failure never resubmitted |
| Verification | The card read again on its route: the fields sent (poster and unlock media keys are write-only) or `deleted` |

Single-card reads accept a one-row array on these routes too. `tests/x-conversation-cards.test.mjs`
now expects poll deletion in the card family.

Other code: `src/action-contracts.ts` and `src/provider-contracts.ts` (X contract version 15).
Guidance: "X poll and conversation cards" in `Skills/amcp-campaign-builder/references/linkedin-x.md`
now covers edits and deletions, with an executable inspect example.

## Tests

`tests/x-legacy-card-edits.test.mjs`, four tests:

1. An unused image conversation card is edited (form data) and an unused poll deleted; both verify, a replay sends nothing, and an owner deletion rule refuses the deletion.
2. A video conversation card that a promoted Tweet uses is refused with `CREATIVE_IN_USE` and the affected Tweet; with `creative_edit_confirmed=true` its media and title change and verify, and it is then deleted the same way.
3. Eight malformed edits are refused before any write; media of the wrong type, missing media and an unknown card are refused after reading; the catalog has no poll edit.
4. An error reply is never resubmitted; an ignored edit or deletion is not verified; the ledger lists the five rows in `x_creatives`.

Red/green against a build of `24facf6`: all four tests fail (no reviewed route: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/x-legacy-card-edits-20260927/red-check.log`.

## Verification

- Targeted: 206 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 2,046/2,046.
- Guidance coverage: 338 write-path refusals across 200 modules accounted for.
- Full qualification: see
  [X-LEGACY-CARD-EDITS-VERIFICATION-2026-09-27.json](X-LEGACY-CARD-EDITS-VERIFICATION-2026-09-27.json).

Remaining rows: 712 (five X rows reviewed; X blocked writes 40 → 35). Live acceptance is
unverified; it needs the updated deployment and an X Ads account with these cards.
