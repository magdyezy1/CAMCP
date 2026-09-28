# TikTok custom audience edits — 2026-09-27

Base revision: `5119489` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: TikTok custom audiences could be created (lookalikes) and used in saved audiences and ad
group targeting, but not renamed, deleted, or added to existing ad groups through their own
endpoint. The update, deletion and apply rows were blocked writes.

Contract source, read in the rendered TikTok API for Business documentation on 2026-09-27:

- "Update an audience" (`POST /v1.3/dmp/custom_audience/update/`): `custom_audience_name` (at most
  128 characters) for every audience type; `audience_sub_type` `REACH_FREQUENCY` converts an
  audience one way ("If you update this field, changes to other data fields will be ignored"; a
  lookalike cannot be converted; such an audience "can only be used in R&F ads"); `file_paths` and
  `action` change customer file audiences. "An expiring or expired audience cannot be modified.
  It can only be deleted."
- "Delete audiences" (`POST /v1.3/dmp/custom_audience/delete/`): `custom_audience_ids`, 1–100.
- "Apply audiences to ad groups" (`POST /v1.3/dmp/custom_audience/apply/`): one
  `custom_audience_id`, `adgroup_ids` of the same advertiser, `action_mode` `Apply` or
  `Disconnect`, and `usage_mode` `Include` or `Exclude` when applying.
- "Get all audiences" (`GET /v1.3/dmp/custom_audience/list/`, filtered by up to 100 IDs) and "Get
  audience details" (`GET /v1.3/dmp/custom_audience/get/`, which adds `audience_sub_type`):
  `is_creator`, `shared`, `is_valid`, `is_expiring` and `expired_time`. All three writes reply with
  `code` 0 and empty data.

## Change

New reviewed family `tiktok_audience_edits` (`src/tiktok-audience-edits.ts`), three rows:

| Part | Behaviour |
|---|---|
| Request | Rename (1–128 characters, no leading or trailing spaces) or convert to `REACH_FREQUENCY`, never both; delete 1–100 audiences; include, exclude or disconnect one audience in 1–100 ad groups. Customer file changes are refused |
| State | The named audiences (list read, plus details for a conversion); for deletions and conversions every ad group and Upgraded Smart+ ad group with the audiences they include or exclude; for applying, the named ad groups with their status and audience lists |
| Checks | Unknown audiences or ad groups are refused; only the owner renames, converts or deletes (a shared-in audience can still be applied); expiring or expired audiences are not changed and expired ones not applied; lookalikes are not converted; a used audience is neither converted nor deleted; an audience shared with others is not deleted; unchanged names, sub types and ad group usage, and ad groups that use the audience the other way, are refused |
| Safety | Applying or disconnecting always needs spending confirmation, and the review names the enabled ad groups; renames, conversions and deletions need none; deletions count under owner deletion policies |
| Receipt | A non-zero `code` is a failure never resubmitted |
| Verification | The audience read again (name or sub type), the deleted audiences gone, or each ad group including, excluding or no longer using the audience |

New refusal codes: `INVALID_TIKTOK_AUDIENCE_EDIT`, `AUDIENCE_EXPIRING` and `AUDIENCE_SHARED`;
`AUDIENCE_IN_USE`, `STATE_NOT_FOUND` and `STATE_TARGET_MISMATCH` are reused.

Other code: `src/preflight.ts` (the confirmation for applying, and the spending exemption for the
rest), `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts` and
`src/provider-contracts.ts` (TikTok contract version 27; the lookalike scope text no longer lists
update and deletion as unqualified). Guidance: "TikTok custom audience edits" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` (the lookalike section points to it)
and an executable inspect example.

## Tests

`tests/tiktok-audience-edits.test.mjs`, five tests:

1. An audience is renamed and another converted to Reach & Frequency (after a usage scan that includes Upgraded Smart+ ad groups); both verify and a replay sends nothing.
2. Two unused audiences are deleted and verify gone; audiences an ad group or an Upgraded Smart+ ad group uses, an audience shared with others, a shared-in audience and an unknown one are refused; an owner deletion rule refuses deletions but not renames.
3. An audience is included in two ad groups (execution first refused without spending confirmation; the enabled ad group is named), another excluded and a third disconnected; each verifies and a replay sends nothing; a shared-in audience can be applied.
4. Fourteen malformed requests are refused before any request; expiring and expired audiences, an unchanged name, a lookalike or used audience to convert, a shared-in audience to rename, unknown audiences and ad groups, unchanged and conflicting ad group usage and an expired audience to apply are refused after reading, without writes.
5. An error reply is never resubmitted; ignored edits are not verified; the ledger lists the three writes in the family while lookalike refresh stays blocked.

Red/green against a build of `5119489`: all five tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/tiktok-audience-edits-20260927/red-check.log`.

## Verification

- Targeted: 200 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,991/1,991.
- Guidance coverage: 334 write-path refusals across 197 modules accounted for.
- Full qualification: see
  [TIKTOK-AUDIENCE-EDITS-VERIFICATION-2026-09-27.json](TIKTOK-AUDIENCE-EDITS-VERIFICATION-2026-09-27.json).

Remaining rows: 726 (three TikTok rows reviewed; TikTok blocked writes 178 → 175). Live acceptance
is unverified; it needs the updated deployment and a TikTok advertiser with custom audiences.
