---
status: record
tier: engineering
---

# Snapchat offer disclaimers — 2026-09-27

Base revision: `61f4621` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: ads in regulated verticals (auto, pharmaceutical and financial services) may need to show terms
or a disclaimer, which Snapchat keeps as offer disclaimers of the ad account. The two rows that create
and delete them were blocked writes.

Contract source: the Snapchat Marketing API "Offer Disclaimers" reference, read on 2026-09-27. Key
facts:

- `POST /v1/adaccounts/{ad_account_id}/offer_disclaimers` creates disclaimers from
  `{offer_disclaimers: [{name, ad_account_id, disclaimer_text, disclaimer_render_type}]}`; each item
  of the reply carries its own `sub_request_status` and the created `offer_disclaimer` with its ID.
- The render type is `STATIC` (the text is sent, up to 5000 characters) or `DYNAMIC` (the text comes
  from the product catalog); the name has up to 255 characters.
- `GET` on the same path lists the account's disclaimers and `DELETE .../offer_disclaimers/{id}`
  deletes one. No update is documented.

## Change

New reviewed family `snapchat_offer_disclaimers` (`src/snapchat-offer-disclaimers.ts`):

| Part | Behaviour |
|---|---|
| Request | Create 1–20 disclaimers of the selected ad account (name, render type, text for STATIC only), or delete one; no query or header overrides |
| State | Every disclaimer of the account in one bounded read (up to 1000; a longer list is refused as incomplete) |
| Checks | Names are unique in the request and the account (`CONFIGURATION_EXISTS`); a deleted disclaimer must exist (`STATE_NOT_FOUND`) |
| Safety | No spending change, so no spending confirmation; deletion counts as a deletion under owner policies and the review says ads that show it lose the disclosure |
| Receipt | A SUCCESS reply with a SUCCESS item and an ID for every disclaimer; anything else is a failure never resubmitted |
| Verification | The disclaimers listed again: each one created with its name, type and text, or the deleted one gone |

Other code: `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts`
and `src/provider-contracts.ts` (Snapchat contract version 10). Guidance: "Snapchat offer
disclaimers" in `Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable
inspect example.

## Tests

`tests/snapchat-offer-disclaimers.test.mjs`, three tests:

1. A static and a dynamic disclaimer are created and verify, and a replay sends nothing; a deletion names its effect and verifies gone; an owner deletion rule refuses deletions but not creation.
2. Eight malformed requests fail before any request; a name already in the account and an unknown disclaimer are refused after reading, without writes.
3. An error reply is a failure never resubmitted; an ignored creation or deletion is not verified; the ledger lists both writes in the family.

Red/green against a build of `61f4621`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/snapchat-offer-disclaimers-20260927/red-check.log`.

## Verification

- Targeted: 173 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,888/1,888.
- Guidance coverage: 300 write-path refusals across 170 modules accounted for.
- Full qualification: see
  [SNAPCHAT-OFFER-DISCLAIMERS-VERIFICATION-2026-09-27.json](SNAPCHAT-OFFER-DISCLAIMERS-VERIFICATION-2026-09-27.json).

Remaining rows: 798 (two Snapchat rows reviewed; Snapchat blocked writes 85 → 83). Live acceptance
is unverified; it needs the updated deployment and a Snapchat ad account.
