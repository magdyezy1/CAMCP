---
status: record
tier: engineering
---

# Criteo preferred line items — 2026-09-27

Base revision: `ac37309` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: the targeting of preferred (onsite display) line items was already reviewed, but the line items
themselves could not be created or changed. Their two rows were blocked writes.

Contract source: the pinned Criteo Retail Media 2026-01 OpenAPI document
(`CreatePreferredLineItemByCampaignId`, `UpdatePreferredLineItemByLineItemId`,
`GetPreferredLineItemsByLineItemId`, `PreferredLineItemCreateModelV2`,
`PreferredLineItemUpdateModelV2`, `PreferredLineItemV2`, `CampaignV202301` and `Creative2`),
checked 2026-09-27. Key facts:

- Creation requires `name`, `startDate`, `endDate`, `pacing`, `page`, `targetRetailerId` and
  `budget`, with optional `capping` (`day` or `session`), `creativeId` and `status`.
- The update model requires `name`, `startDate`, `endDate` and `status`; like auction line items it
  is a PUT of the whole line item, so AMCP sends every writable field.
- Campaigns have a `type` that includes `preferred`; creatives name their retailer and status.

## Change

New reviewed family `criteo_preferred_line_items` (`src/criteo-preferred-line-items.ts`):

| Part | Behaviour |
|---|---|
| Request | Creation in a preferred campaign (draft or paused) and the complete PUT (active or paused); the retailer never changes; page types, categories (category pages) and search keywords (search pages) are checked |
| Scope | Writes need account-scoped membership of the campaign or line item first; internal reads keep the account, origin and verified line item |
| State | The account (currency), the line item membership and the line item, the campaign, and the creative |
| Checks | The campaign is preferred and, when tied to a retailer, takes only that retailer; the creative is not archived or deleted and has the same retailer; unchanged PUTs and archived line items are refused |
| Safety | Every write needs `spend_change_confirmed`; an active status counts as activation and budgets follow owner budget limits |
| Receipt | The returned line item must be in the campaign (creation) or be the line item named (update); anything else is a failure never resubmitted |
| Verification | The line item read again: every writable field and the status; a created line item is then remembered as the account's |

Other code: `src/types.ts`, `src/scope.ts`, `src/spend-policy.ts`, `src/preflight.ts`,
`src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`,
`src/reviewed-routes.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (Criteo contract
version 11). Guidance: "Preferred line items (2026.01)" in
`Skills/amcp-campaign-builder/references/criteo.md` and an executable inspect example.

## Tests

`tests/criteo-preferred-line-items.test.mjs`, six tests:

1. A line item is created once in a preferred campaign and verifies; it starts draft; a replay sends nothing.
2. The complete PUT verifies and reports the budget change; activation needs spending confirmation and is refused by an owner rule against activation.
3. Fourteen malformed requests fail before any request.
4. An auction campaign, a campaign of another retailer, a creative of another retailer, an archived and an unknown creative, and an unchanged PUT are refused after reading, without writes.
5. Writes need account-scoped membership first; an ignored write is not verified.
6. The models match the pinned document; the ledger lists both writes in the family.

Red/green against a build of `ac37309`: all six tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/criteo-preferred-20260927/red-check.log`.

## Verification

- Targeted: 178 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,914/1,914.
- Guidance coverage: 307 write-path refusals across 175 modules accounted for.
- Full qualification: see
  [CRITEO-PREFERRED-LINE-ITEMS-VERIFICATION-2026-09-27.json](CRITEO-PREFERRED-LINE-ITEMS-VERIFICATION-2026-09-27.json).

Remaining rows: 784 (two Criteo rows reviewed; Criteo blocked writes 29 → 27). Live acceptance is
unverified; it needs the updated deployment and a Criteo Retail Media account with a preferred
campaign.
