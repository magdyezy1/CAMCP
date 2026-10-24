---
status: record
tier: engineering
---

# TikTok account brand safety — 2026-09-26

Base revision: `e16d168` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: advertisers keep ads off unsuitable Pangle apps and set brand safety defaults for Upgraded
Smart+ campaigns at the account level. Both write routes were blocked.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:
[Update the Pangle block list](https://business-api.tiktok.com/portal/docs/update-the-pangle-block-list/v1.3),
[Get the Pangle block list](https://business-api.tiktok.com/portal/docs/get-the-pangle-block-list/v1.3),
[Set or update the Brand Safety Hub settings of an ad account](https://business-api.tiktok.com/portal/docs/set-or-update-the-brand-safety-hub-settings-of-an-ad-account/v1.3)
and [Get the Brand Safety Hub settings of an ad account](https://business-api.tiktok.com/portal/docs/get-the-brand-safety-hub-settings-of-an-ad-account/v1.3).
Key facts: apps are iTunes IDs or Android package names; `clear_old_app` replaces the list; the
update response counts only added apps. The hub applies to future Upgraded Smart+ campaigns, not
to regular campaigns. Its tier, category exclusions and vertical sensitivity are sent together;
exclusions and sensitivity apply only to the standard and limited tiers. `cover_all_ad_objectives`
cannot be turned back off once true.

## Change

New reviewed family `tiktok_brand_safety` (`src/tiktok-brand-safety.ts`).

| Part | Pangle block list | Brand Safety Hub |
|---|---|---|
| Request | Up to 1,000 distinct valid app IDs per list; no app both added and deleted; no deletions with `clear_old_app`; at least one change | `cover_all_ad_objectives` required; tier among the three settable values (`NO_BRAND_SAFETY` is read-only); exclusions and a vertical for the standard and limited tiers, neither for the expanded tier |
| State | The block list, stored sorted so provider order is not a change | The settings |
| Checks | Deleted apps must be blocked; added apps must not be, unless clearing | No switch back from all objectives; an update must change something |
| Safety | Blocking needs no confirmation (it only narrows delivery). Unblocking and clearing need `spend_change_confirmed`, count as removals and count as serving under owner policy | Always needs `spend_change_confirmed`; the impact names the irreversible switch |
| Receipt | `success_count` must equal the added apps; otherwise the receipt is a failure and is never resubmitted | `code 0` with a data object |
| Verification | The complete set of apps | All four settings, exclusions as a set |

Other code: `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/review-state.ts`, `src/preflight.ts`, `src/spend-policy.ts`, `src/execution-risk.ts`,
`src/reviewed-routes.ts`, `src/types.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts`
(TikTok contract version 22). Guidance: "TikTok account brand safety" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect example.

## Tests

`tests/tiktok-brand-safety.test.mjs`, eight tests:

1. Blocking two apps needs no spending confirmation, writes once, verifies and replays; the provider returning the list in another order between reads is not a change.
2. Unblocking and clearing need spending confirmation, and each result verifies.
3. An absent app deletion and an already blocked app are refused after reading; six malformed updates fail without network requests.
4. Hub settings with a switch to all objectives show the irreversible note and sorted exclusions, need confirmation and verify; a later expanded-tier update verifies with no irreversible note.
5. Switching back from all objectives and an update that changes nothing are refused; five incomplete or invalid settings fail without network requests.
6. Owner policies: unblocking is refused when deletions are forbidden, clearing is refused when activation is forbidden, and blocking passes.
7. A Pangle receipt that counts fewer added apps stays a failure, is replayed rather than resubmitted, and is not verified as success.
8. A list changed after review stops execution with `STATE_CHANGED`, and an update of only `cover_all_ad_objectives` keeps the other settings.

Red/green: all eight fail against a build of `e16d168` (no reviewed family,
`WRITE_CONTRACT_UNAVAILABLE`) and pass with this change. Local log:
`.runtime/tiktok-brand-safety-20260926/red-check.log`.

## Verification

- Targeted: 118 related suites, 1,449/1,449.
- Guidance coverage: 256 write-path refusals across 136 modules accounted for.
- Full qualification: see
  [TIKTOK-BRAND-SAFETY-VERIFICATION-2026-09-26.json](TIKTOK-BRAND-SAFETY-VERIFICATION-2026-09-26.json).

Remaining rows: 915 (two TikTok rows reviewed; TikTok blocked writes 188 → 186). Live acceptance is
unverified; it needs the updated deployment and a test advertiser.
