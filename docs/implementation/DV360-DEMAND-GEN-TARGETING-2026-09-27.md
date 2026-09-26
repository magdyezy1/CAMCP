# DV360 Demand Gen targeting — 2026-09-27

Base revision: `9e46fd9` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: after Demand Gen ad groups (`9e46fd9`), their targeting was still blocked, and the line
item targeting family refused Demand Gen line items altogether. Google's Demand Gen guide
documents which targeting types each level takes.

Contract source: the pinned Display & Video 360 API v4 Discovery document
(`adGroups.bulkEditAssignedTargetingOptions`, `bulkListAssignedTargetingOptions`,
`adGroups.targetingTypes.assignedTargetingOptions` create and delete, and their request and
response models) and [Assign targeting](https://developers.google.com/display-video/api/guides/tasks/serve-demand-gen-ad/assign-targeting)
of the Demand Gen guide, read on 2026-09-27. Key facts:

- Demand Gen line items take carrier and ISP, day and time, device make and model, device type,
  geo region, keyword, language, negative keyword list, operating system and POI targeting.
- Demand Gen ad groups take age range, app, app category, audience group, category, gender, geo
  region, household income, keyword, language, parental status, URL, YouTube channel and YouTube
  video targeting.
- Geo region, POI and language belong to the line item when its
  `demandGenSettings.geoLanguageTargetingEnabled` is true, and to its ad groups otherwise.
- An ad group bulk edit names up to 25 ad groups; the response lists updated and failed ad groups.

## Change

The DV360 targeting module (`src/dv360-line-item-targeting.ts`) gains an ad group level, as the
new reviewed family `dv360_ad_group_targeting`:

| Part | Behaviour |
|---|---|
| Routes | Ad group bulk edit (1–25 ad groups), single create and delete |
| Types | The documented ad group types; assigning audience groups stays refused (their access is not read yet), removing them is qualified |
| State | Each ad group with its line item through the Demand Gen ad group reader (other formats and archived ad groups or line items are refused), then every page of the ad groups' targeting of the edited types |
| Checks, limits, receipts, verification | As for line items; a bulk receipt with failed ad groups is a failure |
| Safety | `spend_change_confirmed`; an owner policy that forbids activation forbids edits of active ad groups; deletions are deletions |

Demand Gen line items are no longer refused: they take their documented types, and location
and language only when the line item keeps them (`geoLanguageTargetingEnabled`); ad groups take
location and language only when it does not.

The Demand Gen ad group reader (`src/dv360-demand-gen-ad-groups.ts`) now exposes its state read
and the line item's location and language setting. Other code: `src/types.ts`,
`src/reviewed-routes.ts`, `src/preflight.ts` (message), `src/action-contracts.ts` and
`src/provider-contracts.ts` (DV360 contract version 7). Guidance: "Demand Gen targeting" in
`Skills/amcp-campaign-builder/references/dv360-and-measurement.md` and an executable inspect
example.

## Tests

`tests/dv360-ad-group-targeting.test.mjs`, eight tests:

1. A bulk edit of a paused and an active ad group creates an age range and a YouTube channel exclusion and verifies.
2. Single creates and deletes verify; removing an audience group is qualified and assigning one is refused.
3. Location targeting goes to ad groups or to the line item as the line item setting says, and is refused at the other level.
4. Demand Gen ad groups and line items take only their documented types (device type on an ad group is refused before any request; age range on a Demand Gen line item after reading it).
5. Other ad group formats, archived ad groups and bulk edits of more than 25 ad groups are refused.
6. Owner policies: targeting an active ad group counts as serving, and deletions are deletions.
7. A bulk receipt with a failed ad group stays a failure and is not resubmitted, targeting changed after review stops execution with `STATE_CHANGED`, and an ignored create is inconclusive.
8. The routes and models match the pinned Discovery document.

The first run showed that verification asserted a targeting marker on every snapshot read, while
ad group holders carry the ad group read marker; the resulting exception made verification
unverified. Verification now skips reads without a targeting marker.

Red/green against a build of `9e46fd9` (with the pinned document present): seven tests fail and
the pinned-document test passes; all pass with this change, as do the existing line item and
advertiser targeting suites. Local log: `.runtime/dv360-ad-group-targeting-20260927/red-check.log`.

## Verification

- Targeted: 137 related suite files, including every DV360 suite, 1,647/1,647.
- Guidance coverage: 264 write-path refusals across 143 modules accounted for.
- Full qualification: see
  [DV360-DEMAND-GEN-TARGETING-VERIFICATION-2026-09-27.json](DV360-DEMAND-GEN-TARGETING-VERIFICATION-2026-09-27.json).

Remaining rows: 893 (three DV360 rows reviewed; DV360 blocked writes 53 → 50). Audience groups
(for ad groups and line items), YouTube video ad assets and Demand Gen ads are the next DV360
steps. Live acceptance is unverified; it needs the updated deployment and a DV360 advertiser with
Demand Gen enabled.
