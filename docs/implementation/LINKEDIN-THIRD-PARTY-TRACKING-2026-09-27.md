---
status: record
tier: engineering
---

# LinkedIn third-party tracking tags — 2026-09-27

Base revision: `3a2d50d` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: advertisers that measure with Campaign Manager 360 add DoubleClick impression and click tags
to their LinkedIn creatives. The tag create and delete routes were blocked writes (two rows).

Contract source: [Third-Party Tracking](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/third-party-tracking)
of the LinkedIn Marketing API (versions 202510 to 202609), read on 2026-09-27. Key facts:

- A tag has `entity` (a sponsored creative URN), `event` (`IMPRESSION` or `CLICK`), `platform`
  (`DOUBLECLICK`, the only value) and `trackingUrl`; `id` and `account` are read-only.
- `POST /rest/thirdPartyTrackingTags` returns 201 with the ID in `x-restli-id`; a tag without https
  or with unknown enums fails with 400. "Impression and click tracker tags are accepted; monitoring
  or blocking tags are not accepted." `DELETE /rest/thirdPartyTrackingTags/{id}` returns 204.
- Tags are read by ID or with the `creative` finder; they work for Sponsored Content, Spotlight
  Dynamic Ads and Text Ads. Click tags together with landing page link wrappers double count clicks.

## Change

New reviewed family `linkedin_third_party_tracking` (`src/linkedin-third-party-tracking.ts`):

| Part | Behaviour |
|---|---|
| Request | Creation with a sponsored creative, event, `DOUBLECLICK` and an https URL of at most 2048 characters; deletion by ID; REST.li 2.0 headers only |
| State | The ad account, the tag (deletions; its account must be the selected one), the creative read in the ad account, and the creative's current tags |
| Checks | Removed or canceled creatives refused; the same event, platform and URL twice is `CONFIGURATION_EXISTS`; `rw_ads` for writes |
| Safety | Measurement only: no spending confirmation; deletion counts under the owner's deletion policy |
| Receipt | 201 with a numeric `x-restli-id`, or 204 for deletion; otherwise a failure that is never resubmitted |
| Verification | The new tag read by ID (creative, event, platform, URL), or the deleted tag gone from its ID and from the creative's tags |

Other code: `src/scope.ts` (server-built reads, and the finder only for a creative just read in
the ad account), `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/review-state.ts`, `src/preflight.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts`
and `src/provider-contracts.ts` (LinkedIn contract version 9). Guidance: "Reviewed LinkedIn
third-party tracking tags" in `Skills/amcp-campaign-builder/references/linkedin-x.md` and an
executable inspect example.

## Tests

`tests/linkedin-third-party-tracking.test.mjs`, five tests:

1. A click tag is created once without spending confirmation and verifies by its `x-restli-id`; a replay sends nothing; deleting a tag verifies that it is gone.
2. Eight malformed requests fail before any request.
3. Foreign and removed creatives, foreign tags, duplicates and unknown tags are refused after reading, without writes; a connection without `rw_ads` is refused.
4. A creation without an ID is a failure that is never resubmitted; an ignored deletion is not verified.
5. The ledger lists both writes in the family.

Red/green against a build of `3a2d50d`: all five tests fail (no reviewed family: both routes were blocked writes). Local log:
`.runtime/linkedin-tracking-tags-20260927/red-check.log`.

## Verification

- Targeted: 156 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,814/1,814.
- Guidance coverage: 276 write-path refusals across 154 modules accounted for.
- Full qualification: see
  [LINKEDIN-THIRD-PARTY-TRACKING-VERIFICATION-2026-09-27.json](LINKEDIN-THIRD-PARTY-TRACKING-VERIFICATION-2026-09-27.json).

Remaining rows: 870 (two LinkedIn rows reviewed; LinkedIn blocked writes 115 → 113). Live
acceptance is unverified; it needs the updated deployment and a Sponsored Content creative with a
DoubleClick tag.
