# DV360 custom bidding algorithms — 2026-09-27

Base revision: `295b1e3` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: custom bidding starts with an algorithm of the advertiser; creating, renaming and archiving it
were blocked writes (two rows). Its scripts and rules are file uploads and stay outside this batch.

Contract source: the pinned Display & Video 360 API v4 Discovery document (`customBiddingAlgorithms`
create, patch and get; `CustomBiddingAlgorithm`), checked 2026-09-27. Key facts:

- The display name is "Required ... maximum size of 240 bytes"; the type (`SCRIPT_BASED` or
  `RULE_BASED`) is "Required. Immutable"; the owner is an advertiser (`advertiserId`) or a partner.
- `entityStatus` "Controls whether or not the custom bidding algorithm can be used as a bidding
  strategy. Accepted values are: `ENTITY_STATUS_ACTIVE`, `ENTITY_STATUS_ARCHIVED`".
- Patch takes `updateMask`; "Requests updating a custom bidding algorithm assigned to a line item
  will return an error." Reads take the advertiser (or partner) as accessor.

## Change

New reviewed family `dv360_custom_bidding` (`src/dv360-custom-bidding.ts`):

| Part | Behaviour |
|---|---|
| Request | Creation owned by the selected advertiser (name, type, optional status) and patches of `displayName` and/or `entityStatus`, the body carrying exactly the masked fields and the owner; partner ownership, sharing and third-party partners are refused |
| Scope | Writes and algorithm reads name the selected advertiser; partner access is never used |
| State | The advertiser and, for a patch, the algorithm read with the advertiser as accessor |
| Checks | Only algorithms the advertiser owns change (`ACCOUNT_SCOPE_MISMATCH`); unchanged values are refused |
| Safety | An algorithm bids only after scripts or rules exist and a line item uses it, so no spending confirmation; an active status counts as activation under owner policies; DV360's refusal for an assigned algorithm is a failure never resubmitted |
| Receipt | The returned algorithm must belong to the advertiser (and be the one patched) with the values sent |
| Verification | The algorithm read again: name, type, status and owner |

Other code: `src/scope.ts`, `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts`
and `src/provider-contracts.ts` (DV360 contract version 16). Guidance: "Custom bidding algorithms"
in `Skills/amcp-campaign-builder/references/dv360-and-measurement.md` and an executable inspect
example.

## Tests

`tests/dv360-custom-bidding.test.mjs`, four tests:

1. An algorithm is created without spending confirmation and verifies, and a replay sends nothing; it is renamed and archived, each verified.
2. Eleven malformed requests fail before any request.
3. A partner-owned, an unknown and an unchanged algorithm are refused after reading, without writes; DV360's refusal for an assigned algorithm is never resubmitted; an owner rule against activation refuses an active creation but not an archived one.
4. A receipt for another advertiser is a failure; an ignored patch is not verified; reads name the advertiser and refuse partner access; the models match the pinned document; the ledger lists both writes in the family.

Red/green against a build of `295b1e3`: three of the four tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE); the malformed-request test passes because the base refuses the route before any request. Local log:
`.runtime/dv360-custom-bidding-20260927/red-check.log`.

## Verification

- Targeted: 180 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,922/1,922.
- Guidance coverage: 309 write-path refusals across 177 modules accounted for.
- Full qualification: see
  [DV360-CUSTOM-BIDDING-VERIFICATION-2026-09-27.json](DV360-CUSTOM-BIDDING-VERIFICATION-2026-09-27.json).

Remaining rows: 778 (two DV360 rows reviewed; DV360 blocked writes 35 → 33). Live acceptance is
unverified; it needs the updated deployment and a DV360 advertiser.
