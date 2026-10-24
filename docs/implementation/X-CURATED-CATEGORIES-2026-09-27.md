---
status: record
tier: engineering
---

# X pre-roll curated categories — 2026-09-27

Base revision: `830de73` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: X pre-roll campaigns choose where their video ads run through curated categories of
publishers. With the media creatives of the previous batch, the category association was the
missing step, and its three routes were blocked writes.

Contract source: the X Ads API v12 Campaign Management reference, "Line Item Curated Categories"
and "Curated Categories" (docs.x.com copy read on 2026-09-24 and rechecked 2026-09-27). Key facts:

- `POST accounts/:account_id/line_item_curated_categories` associates `curated_category_id` with
  `line_item_id`; PUT replaces the category; DELETE removes the association. The list has no line
  item filter.
- The reference points to the Video Views Pre-roll objective guide for their use, so the review
  admits `PREROLL_VIEWS` line items only; "each curated_category is only available in specific
  countries".

## Change

New reviewed family `x_curated_categories` (`src/x-curated-categories.ts`):

| Part | Behaviour |
|---|---|
| Request | Creation with a line item and a category; replacement of the category only; deletion by ID |
| State | The account, the association (updates and deletions), the line item, its campaign, every association of the account for that line item (at most five pages), and the category |
| Checks | Deleted line items and associations refused; `PREROLL_VIEWS` line items only; an unchanged category refused; the same category twice is `CONFIGURATION_EXISTS` |
| Safety | Adding or replacing a category needs `spend_change_confirmed` and counts as activation under owner policies; deletion counts under the deletion policy |
| Receipt | The association X returns must carry the line item and category sent (or be deleted); otherwise a failure that is never resubmitted |
| Verification | The association read by ID: line item and category, or deleted |

Other code: `src/spend-policy.ts`, `src/preflight.ts`, `src/write-review.ts`,
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (X contract version 9). Guidance: "X
pre-roll curated categories" in `Skills/amcp-campaign-builder/references/linkedin-x.md` and an
executable inspect example.

## Tests

`tests/x-curated-categories.test.mjs`, four tests:

1. A category is added once after spending confirmation and verifies; a replay sends nothing; replacing and removing a category verify; an owner policy without activation refuses a new category.
2. Five malformed requests fail before any request.
3. Other objectives, deleted line items, unchanged, duplicate and unknown categories, and unknown associations are refused after reading, without writes.
4. A receipt for another line item is a failure that is never resubmitted; an ignored change is not verified; the ledger lists the three writes in the family.

Red/green against a build of `830de73`: all four tests fail (no reviewed family: the three routes were blocked writes). Local log:
`.runtime/x-curated-categories-20260927/red-check.log`.

## Verification

- Targeted: 159 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,829/1,829.
- Guidance coverage: 280 write-path refusals across 157 modules accounted for.
- Full qualification: see
  [X-CURATED-CATEGORIES-VERIFICATION-2026-09-27.json](X-CURATED-CATEGORIES-VERIFICATION-2026-09-27.json).

Remaining rows: 855 (three X rows reviewed; X blocked writes 58 → 55). Live acceptance is
unverified; it needs the updated deployment and a pre-roll line item, which X enables per account.
