# DV360 advertiser targeting — 2026-09-26

Base revision: `ca8c6e8` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: advertiser targeting carries DV360 brand safety (excluded channels and keywords, digital
content labels, sensitive categories and OMID), and every line item of the advertiser inherits it.
Line item targeting was qualified in `ca8c6e8`. The advertiser routes remained blocked, so
account-wide exclusions could not be set.

Contract source: Display & Video 360 API v4, read in the rendered reference on 2026-09-26, and the
pinned Discovery document `.mirror/VENDOR/dv360-v4.json` (revision 20260902):

- [advertisers.editAssignedTargetingOptions](https://developers.google.com/display-video/api/reference/rest/v4/advertisers/editAssignedTargetingOptions):
  deletes, then creates, for `TARGETING_TYPE_CHANNEL`, `TARGETING_TYPE_DIGITAL_CONTENT_LABEL_EXCLUSION`,
  `TARGETING_TYPE_OMID`, `TARGETING_TYPE_SENSITIVE_CATEGORY_EXCLUSION` and `TARGETING_TYPE_KEYWORD`;
  the response lists the created options.
- advertisers.targetingTypes.assignedTargetingOptions create, delete and list, and
  advertisers.listAssignedTargetingOptions (filter by targeting type, up to 5,000 per page), from
  the pinned Discovery document.
- The channel details reference: for advertiser-level channel options, `negative` must be true.

## Change

The DV360 targeting module (`src/dv360-line-item-targeting.ts`) now serves two owners: line items
(unchanged behaviour) and the advertiser. The advertiser routes form the new reviewed family
`dv360_advertiser_targeting`.

| Part | Behaviour |
|---|---|
| Request | Only the five advertiser types; channel and keyword options must set `negative: true`; the edit body has no `lineItemIds`; the option rules of line item targeting apply |
| State | The advertiser (active or paused), every page of its targeting of the edited types (`:listAssignedTargetingOptions` filtered by type, with the same bounds) and each assigned channel under the advertiser |
| Checks | Partner-inherited options cannot be deleted; identical inherited or existing options are refused; absent deletions are refused |
| Safety | `spend_change_confirmed` is required; deletions count as removals under the owner's deletion policy; advertiser targeting always counts as serving under an activation-forbidding owner policy, because every line item inherits it |
| Receipt | The edit response must list every created option with its exact name and type, and the same count per type; otherwise the receipt is a failure and is never resubmitted |
| Verification | The complete advertiser targeting of the edited types is read again and compared per type |

Other code: `src/reviewed-routes.ts` (family by owner), `src/types.ts`, `src/action-contracts.ts`,
`src/provider-contracts.ts` (DV360 contract version 5). Guidance: "Advertiser targeting" in
`Skills/amcp-campaign-builder/references/dv360-and-measurement.md` and an executable inspect example.

## Tests

`tests/dv360-advertiser-targeting.test.ts`, eight tests:

1. An edit reads the advertiser, both pages of its targeting of the edited types and the assigned channel; shows account-wide, serving impact; needs spending confirmation; deletes a keyword and a content label (by alias), adds keywords, a channel, a sensitive category and OMID; writes once, verifies and replays.
2. The single create and delete routes add a keyword and remove a channel, and verify.
3. A partner-inherited deletion, an absent keyword, an existing and a partner-inherited duplicate, a partner channel and an advertiser scheduled for deletion are refused before any write.
4. A keyword without `negative`, a positive keyword and channel, a line-item-only type in creation and deletion, `lineItemIds` in the body and an empty edit fail without network requests.
5. A response that omits a created option is kept as a failure, replayed rather than resubmitted, and never verified as success.
6. Owner policies: an activation-forbidding policy refuses advertiser targeting even for a paused advertiser; a deletion-forbidding policy refuses removals and still accepts additions.
7. A row of another advertiser and a repeated page token never become complete state; a new option after review stops execution with `STATE_CHANGED`.
8. The pinned Discovery document has the advertiser methods and exactly the five types, and the advertiser and line item routes resolve to their own families.

Line item targeting tests (`tests/dv360-line-item-targeting.test.ts`, 8) pass unchanged.

Red/green: all eight new tests fail against a build of `ca8c6e8` (the advertiser routes had no
reviewed family, `WRITE_CONTRACT_UNAVAILABLE`, and the module had no advertiser types) and pass with
this change. Local log: `.runtime/dv360-advertiser-targeting-20260926/red-check.log`.

## Verification

- Targeted: 115 related suites, 1,425/1,425.
- Guidance coverage: 253 write-path refusals across 133 modules accounted for.
- Full qualification: see
  [DV360-ADVERTISER-TARGETING-VERIFICATION-2026-09-26.json](DV360-ADVERTISER-TARGETING-VERIFICATION-2026-09-26.json).

Remaining rows: 923 (three DV360 rows moved to the new family; DV360 blocked writes 59 → 56).
Live acceptance is unverified; it needs the updated deployment and a test advertiser.
