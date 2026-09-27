# X line item tracking tags — 2026-09-27

Base revision: `1836baf` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: advertisers measure X campaigns with third-party impression and click trackers (for example
Campaign Manager 360). The tracking tag routes were blocked writes (three rows), so trackers had to
be set in X Ads Manager.

Contract source: the X Ads API v12 Campaign Management reference, "Tracking Tags" (docs.x.com copy
read on 2026-09-24 and rechecked 2026-09-27). Key facts:

- `POST accounts/:account_id/tracking_tags` associates a tag with a line item: `line_item_id`,
  `tracking_tag_type` (`IMPRESSION_TAG` or `CLICK_TRACKER`) and `tracking_tag_url`, "the tracking tag
  url provided by the tracking partner".
- `PUT accounts/:account_id/tracking_tags/:tracking_tag_id` takes only `tracking_tag_url`; `DELETE`
  disassociates the tag. Tags are read by ID (`with_deleted`) or listed by `line_item_ids`.

## Change

New reviewed family `x_tracking_tags` (`src/x-tracking-tags.ts`):

| Part | Behaviour |
|---|---|
| Request | Creation with a line item, type and URL; update of the URL only; deletion; https URLs of at most 2048 characters without spaces or credentials |
| State | The account, the tag (updates and deletions), its line item and every current tag of the line item |
| Checks | Deleted line items and tags refused; the same type and URL twice is `CONFIGURATION_EXISTS`; an unchanged URL is refused |
| Safety | Trackers change measurement, not delivery or budgets: no spending confirmation; the impact warns that a broken click tracker can break clicks; deletion counts under the owner's deletion policy |
| Receipt | The tag X returns must carry the line item, type and URL sent (or be deleted); otherwise a failure that is never resubmitted |
| Verification | The tag read again by ID: line item, type and URL, or deleted |

Other code: `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/review-state.ts`, `src/preflight.ts` (free-text URLs never demand spending confirmation),
`src/reviewed-routes.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (X contract
version 7). Guidance: "X line item tracking tags" in
`Skills/amcp-campaign-builder/references/linkedin-x.md` and an executable inspect example.

Test hardening: `tests/linkedin-media-resume.test.mjs` now removes its temporary directory with the
shared `removeTestDirectory` helper. Its own short `rmSync` retry kept failing the targeted runs
of this and the Criteo batch with EPERM while Windows still held the just-closed SQLite file; the
helper retries longer and never fails a passed test over a leftover temporary directory.

## Tests

`tests/x-tracking-tags.test.mjs`, five tests:

1. A click tracker is created once without spending confirmation and verifies; a replay sends nothing; a URL update and a deletion each verify.
2. Nine malformed requests fail before any request.
3. Deleted line items and tags, duplicates, unchanged URLs, unknown tags and unknown line items are refused after reading, without writes; the same URL as another type is accepted.
4. A receipt for another line item is a failure that is never resubmitted; an ignored change is not verified.
5. The ledger lists the three writes in the family.

Red/green against a build of `1836baf`: all five tests fail (no reviewed family: the three routes were blocked writes). Local log:
`.runtime/x-tracking-tags-20260927/red-check.log`.

## Verification

- Targeted: 155 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,809/1,809 on the second run (the first hit the
  LinkedIn resume EPERM flake fixed above).
- Guidance coverage: 275 write-path refusals across 153 modules accounted for.
- Full qualification: see
  [X-TRACKING-TAGS-VERIFICATION-2026-09-27.json](X-TRACKING-TAGS-VERIFICATION-2026-09-27.json).

Remaining rows: 872 (three X rows reviewed; X blocked writes 67 → 64). Live acceptance is
unverified; it needs the updated deployment and an X line item with a partner tracking URL.
