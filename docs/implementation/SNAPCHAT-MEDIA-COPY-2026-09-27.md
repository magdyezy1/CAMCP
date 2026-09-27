# Snapchat media copy between ad accounts — 2026-09-27

Base revision: `e24d475` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: cloning a Snapchat campaign into another ad account of the same organization needs its media
there. The copy route was a blocked write, so media had to be uploaded again from their source
files.

Contract source: Snap Marketing API, [Media](https://developers.snap.com/api/marketing-api/Ads-API/media)
(Copy Media), read on 2026-09-27. Key facts:

- `POST /v1/adaccounts/{destination}/media_copy` with `media_copy: [{source_media_id,
  source_ad_account_id}]`, at most 20; the response lists each copy with its status and media.
- The ad accounts must be of the same organization; the login must read the source media and
  write media in the destination; the media must be READY images or videos (not Lens media).
- A copy keeps the name, type and download link under a new ID; the request is not atomic.

## Change

New reviewed family `snapchat_media_copy` (`src/snapchat-media-copy.ts`):

| Part | Behaviour |
|---|---|
| Request | 1–20 copies into the selected ad account; native IDs; each source media once; never from the selected account |
| State | The destination and each source ad account (organization) and each source media read under its own ad account, which must be bound to the login |
| Checks | Same organization; the media named by its ad account; READY images and videos only |
| Safety | No spending effect; nothing serves until a creative uses a copy |
| Receipt | Every copy SUCCESS with a new, distinct ID in the destination; otherwise a failure that is never resubmitted |
| Ownership | The copies become media of the selected ad account for creative reviews, from the receipt |
| Verification | Each copy read in the destination: account, name and type equal to the source |

Other code: `src/scope.ts` (the server-built reads of bound source accounts, and ownership from a
copy receipt), `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts` and
`src/provider-contracts.ts` (Snapchat contract version 9). Guidance: "Snapchat media copy between
ad accounts" in `Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable
inspect example.

## Tests

`tests/snapchat-media-copy.test.mjs`, five tests:

1. An image and a video are copied once, verify under their new IDs and become media of the selected ad account; a replay sends nothing.
2. Six malformed requests fail before any request.
3. Another organization, an unbound account, media of another account, pending and Lens media and unknown media are refused after reading, without writes.
4. A partial copy is a failure that is never resubmitted; a copy that differs from its source is not verified.
5. The ledger lists the route in the family.

Red/green against a build of `e24d475`: all five tests fail (no reviewed family: the route was a blocked write). Local log:
`.runtime/snapchat-media-copy-20260927/red-check.log`.

## Verification

- Targeted: 152 related suite files, including every Google, DV360, LinkedIn, Snapchat, media, scope and
  security suite, with FFmpeg configured: 1,794/1,794.
- Guidance coverage: 271 write-path refusals across 150 modules accounted for.
- Full qualification: see
  [SNAPCHAT-MEDIA-COPY-VERIFICATION-2026-09-27.json](SNAPCHAT-MEDIA-COPY-VERIFICATION-2026-09-27.json).

Remaining rows: 877 (one Snapchat row reviewed; Snapchat blocked writes 86 → 85). Live acceptance
is unverified; it needs the updated deployment and two Snapchat ad accounts of one organization.
