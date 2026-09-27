# X pre-roll calls to action — 2026-09-27

Base revision: `5b0caa4` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: in-stream video (pre-roll) line items can show a button that sends viewers to the advertiser's
site. With curated categories reviewed in an earlier batch, the button was the remaining pre-roll
setting; its three rows (create, update, delete) were blocked writes.

Contract source: the X Ads API v12 Creatives reference, "Preroll Call To Actions", read on
2026-09-27. Key facts:

- `POST accounts/:account_id/preroll_call_to_actions` "Set the optional Call-to-Action (CTA) for a
  `PREROLL_VIEWS` line item" with the required `line_item_id`, `call_to_action` (`GO_TO`, `SEE_MORE`,
  `SHOP`, `VISIT_SITE`, `WATCH_NOW`) and `call_to_action_url`.
- `PUT .../preroll_call_to_actions/:id` changes the button or URL (both optional); `DELETE` removes
  the button; the list can be scoped with `line_item_ids`, and reads by ID take `with_deleted`.

## Change

New reviewed family `x_preroll_ctas` (`src/x-preroll-ctas.ts`):

| Part | Behaviour |
|---|---|
| Request | Create (line item, button, URL), change (button and/or URL) or delete; no other fields, query or header overrides |
| URL | Absolute HTTP(S), at most 2048 characters, no spaces, control characters or embedded credentials |
| State | The account, the button by ID (changes and deletions), the line item, its campaign and the line item's buttons |
| Checks | The line item exists, is not deleted and has the `PREROLL_VIEWS` objective; one button per line item (`CONFIGURATION_EXISTS`); unchanged buttons and deleted buttons are refused |
| Safety | Delivery and budgets do not change, so no spending confirmation; the review says when an active line item and campaign make it apply at once; deletions count as deletions under owner policies |
| Receipt | The returned button must match the request (line item, button, URL, not deleted; deleted for a deletion); anything else is a failure never resubmitted |
| Verification | The button read again by ID with deleted rows: line item, button and URL, or deleted |

Other code: `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts`
and `src/provider-contracts.ts` (X contract version 10). Guidance: "X pre-roll calls to action" in
`Skills/amcp-campaign-builder/references/linkedin-x.md` and an executable inspect example.

## Tests

`tests/x-preroll-ctas.test.mjs`, five tests:

1. A button is set without spending confirmation and verifies, and a replay sends nothing; its button and then its URL change and it is deleted, each verified.
2. Twelve malformed requests fail before any request.
3. Another objective, a deleted line item, a second button, an unchanged button, a deleted button and unknown IDs are refused after reading, without writes.
4. A receipt for another line item is a failure never resubmitted; an ignored change is not verified; an owner deletion rule refuses deletions but not creation.
5. The ledger lists the three writes in the family.

Red/green against a build of `5b0caa4`: all five tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/x-preroll-ctas-20260927/red-check.log`.

## Verification

- Targeted: 174 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,893/1,893.
- Guidance coverage: 301 write-path refusals across 171 modules accounted for.
- Full qualification: see
  [X-PREROLL-CTAS-VERIFICATION-2026-09-27.json](X-PREROLL-CTAS-VERIFICATION-2026-09-27.json).

Remaining rows: 795 (three X rows reviewed; X blocked writes 55 → 52). Live acceptance is
unverified; it needs the updated deployment and an X Ads account with pre-roll line items.
