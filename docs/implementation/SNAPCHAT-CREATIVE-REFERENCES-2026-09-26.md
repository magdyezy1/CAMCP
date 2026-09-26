# Snapchat creative reference ownership — 2026-09-26

Base revision: `927b73e` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the follow-up recorded by the
[Snapchat lead generation form batch](SNAPCHAT-LEAD-FORMS-2026-09-26.md). Creative
creation ownership-reads a `LEAD_GENERATION` creative's form. The existing reviewed
creative collection PUT and JSON Patch contracts, however, could change
`lead_generation_form_id` or `top_snap_media_id` to any value without checking that this
login owns the new resource.

## Change

`assertSnapCreativeReferences` in `src/snapchat-lead-forms.ts` runs against the frozen
state at review and the fresh state at execution. It checks each creative in a
`PUT /v1/adaccounts/{id}/creatives` body, or the target of a
`PATCH /v1/adaccounts/{id}/creatives/{creative_id}` `add`/`replace`:

- A `lead_generation_form_id` or `top_snap_media_id` equal to the creative's current value is
  kept as it is. This leaves existing creative updates unaffected; the existing creative PUT
  test still passes with an unowned but unchanged media ID.
- A changed value must be a Snapchat ID (`INVALID_ARGUMENT`) and be owned by the connection
  for the selected account (`lead_generation_forms/{id}` or `media/{id}`). Otherwise the
  review fails with `RESOURCE_SCOPE_REQUIRED`, naming the path, field and creative.
- Ownership comes from the account collections (`snapchat_media_list`,
  `snapchat_lead_forms_list`) or from AMCP's own creations, with the usual five-minute window.
  A reference whose ownership lapses between review and execution stops the write.

Why ownership rather than an extra state read: the referenced resource is known to change
only after the creative's state has been read. Adding a read for every reference would have
made unchanged references need listing, changing existing behaviour.

Other code: `src/write-review.ts` (review and execute hooks), `src/provider-contracts.ts`
(Snapchat contract version 6), `src/action-contracts.ts`. Guidance: the "Snapchat lead
generation forms" section of `Skills/amcp-campaign-builder/references/tiktok-snapchat.md`.

## Tests

`tests/snapchat-creative-references.test.mjs`, four tests:

1. A PUT and a PATCH that keep unowned media and form references execute.
2. A PUT changing top-snap media to unowned media is refused (`/v1/media/media2`), then executes after the media list.
3. A PATCH repointing a lead creative to an unowned form is refused (`/v1/lead_generation_forms/form2`); a malformed media ID is `INVALID_ARGUMENT`; it executes after the forms list.
4. Removing the media's ownership after review stops execution with no write.

Red/green: against a build of `927b73e`, the unchanged-reference test passes, confirming
existing behaviour is untouched. The three changed-reference tests fail, because the base
prepares and executes updates to unowned media and forms. All four pass with this change.
Local log: `.runtime/snapchat-creative-refs-20260926/red-check.log`.

## Verification

- Targeted: 1111/1111 across 82 related suites, including every Snapchat suite and the
  creative-chain audit.
- Guidance coverage: unchanged at 236 write-path refusals (no new refusal code).
- Full qualification: see
  [SNAPCHAT-CREATIVE-REFERENCES-VERIFICATION-2026-09-26.json](SNAPCHAT-CREATIVE-REFERENCES-VERIFICATION-2026-09-26.json).

Live acceptance is unverified; it needs the updated deployment.
