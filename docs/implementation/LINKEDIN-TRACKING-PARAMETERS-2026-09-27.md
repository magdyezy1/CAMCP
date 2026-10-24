---
status: record
tier: engineering
---

# LinkedIn dynamic UTM tracking parameters — 2026-09-27

Base revision: `c156b32` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: advertisers measure LinkedIn campaigns with UTM parameters on landing page URLs. The
tracking parameter writes were blocked, so every creative URL had to carry static UTM values or
the parameters had to be set in Campaign Manager. Microsoft Learn, unreachable on 2026-09-26, was
reachable again on 2026-09-27.

Contract source: LinkedIn Marketing API, [Dynamic UTM Tracking](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/dynamic-utm-tracking)
(li-lms-2026-09), read on 2026-09-27. Key facts:

- `PUT /rest/adTrackingParameters/(adEntity:(sponsoredCampaign:{URN}))` creates the parameters
  (201). With `?idempotencyToken=` from a read of the current parameters it replaces them (200); a
  stale token returns 409. `DELETE` removes them (204). `GET` returns the maps, the token and
  timestamps.
- `dynamicValueParameters` map a name to `ACCOUNT_ID`, `ACCOUNT_NAME`, `CAMPAIGN_GROUP_ID`,
  `CAMPAIGN_GROUP_NAME`, `CAMPAIGN_ID`, `CAMPAIGN_NAME`, `CREATIVE_ID` or (from 202606)
  `CREATIVE_NAME`; `customValueParameters` map a name to fixed text.
- LinkedIn appends them to the landing page URLs of every creative under the campaign, including
  running ads, without another review; Conversation and Message Ads are not supported. Static UTM
  parameters remain, so names must not repeat. Account-level parameters (`sponsoredAccount`)
  need version 202608 or later; AMCP's default LinkedIn-Version is 202605.
- Writes need `rw_ads`; reads `r_ads` or `rw_ads`.

## Change

New reviewed family `linkedin_tracking_parameters` (`src/linkedin-tracking-parameters.ts`):

| Part | Behaviour |
|---|---|
| Request | The REST.li key of one campaign (or of the selected ad account from 202608), re-encoded canonically; 1–50 parameters with URL-safe names of 1–100 characters, unique across both maps without case; documented dynamic values; custom values of 1–500 characters without control characters |
| State | The ad account, the campaign (it must belong to the account) and the current parameters (none when LinkedIn answers 404) |
| Checks | Removed campaigns refused; creation only without parameters and without a token; replacement only with the current token (the review reports it with `CONFIGURATION_EXISTS`), refused when stale or unchanged; deletion only of existing parameters |
| Safety | No spending effect; deletion counts under the owner's deletion policy; parameter text such as "budget" is not a spending change |
| Receipt | 201 or 200 for PUT and 204 for DELETE; LinkedIn documents no body, so an empty one is accepted on this path only |
| Verification | The parameters read again, every name (hex-encoded against case folding) and value compared, or none after deletion |

Other code: `src/transport.ts` (the empty 200/201 of this PUT), `src/compiler.ts` (the canonical
key), `src/scope.ts`, `src/reviewed-routes.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/preflight.ts`, `src/action-contracts.ts` and
`src/provider-contracts.ts` (LinkedIn contract version 8; the review date of Snapchat and LinkedIn
is now 2026-09-27, which the Snapchat batch missed). Guidance: "Reviewed LinkedIn dynamic UTM
tracking parameters" in `Skills/amcp-campaign-builder/references/linkedin-x.md` and an executable
inspect example.

## Tests

`tests/linkedin-tracking-parameters.test.mjs`, eight tests:

1. Campaign parameters are created once with the canonical key and verify; the impact shows the change and a replay sends nothing.
2. Existing parameters are replaced only with the current token: none, a stale one and an unchanged request are refused; a token changed after review stops execution.
3. Deletion verifies absence; deleting none is refused; the owner's deletion policy applies.
4. Thirteen malformed requests fail before any request.
5. A foreign campaign is a target mismatch and a removed campaign is refused, without writes.
6. Account-level parameters and `CREATIVE_NAME` work with LinkedIn-Version 202608; a read-only login cannot write.
7. A write LinkedIn ignored is not verified.
8. The ledger lists the three writes in the family.

Red/green against a build of `c156b32`: all eight tests fail (no reviewed family: the three writes were blocked). Local log:
`.runtime/linkedin-tracking-20260927/red-check.log`.

## Verification

- Targeted: 149 related suite files, including every DV360, LinkedIn, Snapchat, media, scope and
  security suite, with FFmpeg configured: 1,777/1,777.
- Guidance coverage: 267 write-path refusals across 147 modules accounted for.
- Full qualification: see
  [LINKEDIN-TRACKING-PARAMETERS-VERIFICATION-2026-09-27.json](LINKEDIN-TRACKING-PARAMETERS-VERIFICATION-2026-09-27.json).

Remaining rows: 881 (three LinkedIn rows reviewed; LinkedIn blocked writes 118 → 115). Live
acceptance is unverified; it needs the updated deployment and a LinkedIn ad account with
`rw_ads`.
