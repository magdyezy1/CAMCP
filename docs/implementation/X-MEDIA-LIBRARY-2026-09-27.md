# X media library and account media — 2026-09-27

Base revision: `5f2acb4` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: uploads to the X media library were reviewed, but naming, titling and removing library media
and account media assets were not. Three rows (edit and delete library media, delete account media)
were blocked writes.

Contract source: the X Ads API v12 Creatives reference, "Media Library" and "Account Media", read on
2026-09-27. Key facts:

- `PUT accounts/:account_id/media_library/:media_key` takes `name` (max 100), `file_name` (255) and,
  for videos, `title` (70), `description` (200) and `poster_media_key`; its example updates a GIF.
  `DELETE` answers the item with `deleted: true`. Reads by key take no `with_deleted`.
- An `AMPLIFY_VIDEO` added to the library "is automatically available as a `PREROLL` account_media
  asset"; account media rows name it in `video_id`, and `DELETE account_media/:id` answers
  `deleted: true`.
- Media creatives name their `account_media_id`; cards name library media in their components (and
  legacy cards, listed with `include_legacy_cards`, in their own fields). The reference does not say
  what happens to them when their media is deleted.

## Change

New reviewed family `x_media_library` (`src/x-media-library.ts`):

| Part | Behaviour |
|---|---|
| Request | Library edits (name, file name; title, description and poster for videos and GIFs), library deletions and account media deletions; no other fields, query or header overrides |
| State | The account, the item (media by key, account media with deleted rows) and the poster image; for deletions, every card (legacy included, up to 2000), the account media made from a video and the media creatives (up to 5000 each) |
| Checks | The item exists and is not deleted; video fields only on videos and GIFs; the poster is a ready image; unchanged values are refused; media still used by a card or media creative is refused (`MEDIA_IN_USE`) |
| Safety | No spending confirmation; deletions count as deletions under owner policies; Tweets that show an image are not checked, and the review says when X reports the media was tweeted |
| Receipt | The returned item must be the one named, with the values sent or `deleted: true`; anything else is a failure never resubmitted |
| Verification | The item read again: the values sent, or deleted or gone (a 404 after deletion) |

Other code: `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts`
and `src/provider-contracts.ts` (X contract version 11). Guidance: "X media library and account
media" in `Skills/amcp-campaign-builder/references/linkedin-x.md` and an executable inspect example.

## Tests

`tests/x-media-library.test.mjs`, five tests:

1. An image is renamed, and a video and a GIF get a title, description, file name and poster, each verified; a replay sends nothing.
2. An unused video and an account media asset are deleted and verify gone; media used by a card, a legacy card or a media creative is refused with `MEDIA_IN_USE`; an owner deletion rule refuses deletions but not edits.
3. Thirteen malformed requests fail before any request.
4. Video fields on an image, a video or deleted poster, unchanged values, deleted media and unknown media or account media are refused after reading, without writes.
5. A receipt for other media is a failure never resubmitted; ignored deletions are not verified; the ledger lists the three writes in the family.

Red/green against a build of `5f2acb4`: all five tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/x-media-library-20260927/red-check.log`.

## Verification

- Targeted: 175 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,898/1,898.
- Guidance coverage: 303 write-path refusals across 172 modules accounted for.
- Full qualification: see
  [X-MEDIA-LIBRARY-VERIFICATION-2026-09-27.json](X-MEDIA-LIBRARY-VERIFICATION-2026-09-27.json).

Remaining rows: 792 (three X rows reviewed; X blocked writes 52 → 49). Live acceptance is
unverified; it needs the updated deployment and an X Ads account.
