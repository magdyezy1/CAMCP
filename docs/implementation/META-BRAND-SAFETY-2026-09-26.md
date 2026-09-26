# Meta account controls and publisher block lists — 2026-09-26

Base revision: `2743949` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: Advantage+ campaigns take their audience limits (minimum age, locations, exclusions) and
placement exclusions from the ad account's controls, the documented way to meet regulatory and
brand requirements with broad targeting. Publisher block lists start the Audience Network
brand-safety workflow. Both write routes were blocked.

Contract source, read in the rendered Meta for Developers reference on 2026-09-26 (AMCP stays on
Graph v25.0): [Ad Account Account Controls](https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/account_controls),
[Ad Account Business Constraints](https://developers.facebook.com/docs/marketing-api/reference/ad-account-business-constraints/),
[Audience Controls](https://developers.facebook.com/docs/marketing-api/reference/audience-controls/)
and [Ad Account Publisher Block Lists](https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/publisher_block_lists).
Key facts: posting account controls creates or updates them for every eligible campaign; minimum
age 18–25; included countries and regions; excluded regions, cities, DMAs and zip codes;
interest and employment exclusions; five excludable placements. The read shows the controls with
an application status and campaigns in error. A block list is created with a name only.

## Change

New reviewed family `meta_brand_safety` (`src/meta-brand-safety.ts`).

| Part | Account controls | Publisher block list |
|---|---|---|
| Request | The documented audience and placement controls, with valid ages, codes and keys, and distinct targets | A name of 1–255 characters only |
| State | The current controls, normalized (sorted targets without names, no status or paging) | The account's lists (up to 100; more is `INCOMPLETE_STATE`) |
| Checks | The request must change the controls; controls left out are removed, and the review shows before and after | The name must be new in the account |
| Safety | `spend_change_confirmed` required; counts as serving under an activation-forbidding owner policy | None needed: the new list is empty and unapplied |
| Receipt | `success: true` without an error code | A numeric `id` |
| Verification | The controls, compared exactly as one serialized value (status ignored) | The new list by ID and name |

Other code: `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/review-state.ts`, `src/preflight.ts`, `src/spend-policy.ts`, `src/reviewed-routes.ts`,
`src/types.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (Meta contract version
12). Guidance: "Account controls and publisher block lists" in
`Skills/amcp-campaign-builder/references/meta.md` and an executable inspect example.

## Tests

`tests/meta-brand-safety.test.mjs`, six tests:

1. Strict controls need confirmation, write once and verify exactly, although Meta returns the countries in another order and changes the application status between reads; a replay makes no second write.
2. A request with only a minimum age removes the other controls; the impact shows the removed placement exclusion, and the smaller set verifies.
3. Nine invalid controls fail without network requests, and a request that matches the current controls is refused after reading.
4. An empty block list is created without confirmation and verifies; a duplicate name (other case) and four malformed requests are refused.
5. Owner policies: controls are refused when activation is forbidden; a new block list passes.
6. A refused controls receipt stays a failure and is not resubmitted, a paged block list read is incomplete, and controls changed after review stop execution with `STATE_CHANGED`.

Red/green: all six fail against a build of `2743949` (no reviewed family) and pass with this
change. Local log: `.runtime/meta-brand-safety-20260926/red-check.log`.

## Verification

- Targeted: 130 related suites, 1,570/1,570.
- Guidance coverage: 259 write-path refusals across 139 modules accounted for.
- Full qualification: see
  [META-BRAND-SAFETY-VERIFICATION-2026-09-26.json](META-BRAND-SAFETY-VERIFICATION-2026-09-26.json).

Remaining rows: 908 (two Meta rows reviewed; Meta blocked writes 128 → 126). Adding publishers to
a block list and applying it to campaigns are not part of this family. Live acceptance is
unverified; it needs the updated deployment and a Meta ad account.
