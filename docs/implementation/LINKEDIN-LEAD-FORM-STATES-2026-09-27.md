# LinkedIn lead form publishing and archiving — 2026-09-27

Base revision: `3a3a46d` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: lead gen forms could be created as DRAFT (an earlier batch) but not published or archived, so a
form could never go live through AMCP. `POST /rest/leadForms/{id}` was a blocked write.

Contract source: "Lead Syncing" (li-lms-2026-09), "Updating Lead Forms" and "Updating Form Status",
read on 2026-09-27. A PARTIAL_UPDATE (`X-RestLi-Method`) with `{patch: {$set: {state}}}` changes
the status and answers 204 No Content; "Form status can be changed from PUBLISHED to ARCHIVED ... the
status change only affects whether the form and the associated creative gets served or not". Content
fields are editable before publication and, on published forms, only those the reference names
(headline, description, legalDisclaimer, landingPageUrl, privacyPageUrl, thankYouMessage,
thankYouPageCta), which do not match the form schema's paths.

## Change

New reviewed family `linkedin_lead_form_states` (`src/linkedin-lead-form-states.ts`):

| Part | Behaviour |
|---|---|
| Request | Exactly `{patch: {$set: {state}}}` with `PUBLISHED` or `ARCHIVED`, as a versioned REST.li 2.0 PARTIAL_UPDATE; content edits and other states are refused |
| State | The form, read by a server-built marked read: owner, name, state |
| Checks | The form belongs to the selected sponsored account (`RESOURCE_SCOPE_REQUIRED` otherwise); only DRAFT becomes PUBLISHED and only PUBLISHED becomes ARCHIVED; unchanged states are refused; writes need `rw_ads` |
| Scope | `src/scope.ts` accepts the validated write and its marked read for the selected account; ownership comes from the read |
| Safety | The status decides whether creatives that use the form serve, so execution always needs `spend_change_confirmed=true` |
| Receipt | Anything but 204 (or an empty 200) is a failure never resubmitted |
| Verification | The form read again, expecting the new state |

`tests/linkedin-lead-forms.test.mjs` now expects archiving to be reviewed and a content edit to stay
unsupported. New refusal code: `INVALID_LINKEDIN_LEAD_FORM_STATE`.

Other code: `src/preflight.ts` (spending confirmation), `src/write-review.ts` (the check sits with
the other REST.li families), `src/write-verification.ts`, `src/write-impact.ts`,
`src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts` and
`src/provider-contracts.ts` (LinkedIn contract version 15). Guidance: the lead gen form section of
`Skills/amcp-campaign-builder/references/linkedin-x.md` and an executable inspect example.

## Tests

`tests/linkedin-lead-form-states.test.mjs`, three tests:

1. A DRAFT form is published and a PUBLISHED one archived, each refused without spending confirmation and then verified; a replay sends nothing.
2. Four malformed patches (a headline edit, a name edit, back to DRAFT, an unknown state) are refused before any request; forms of another account or an organization, an unchanged state and invalid transitions are refused after reading; a connection without `rw_ads` is refused.
3. An error reply is never resubmitted; an ignored change is not verified; the ledger lists the row in the family.

Red/green against a build of `3a3a46d`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/linkedin-lead-form-states-20260927/red-check.log`.

## Verification

- Targeted: 209 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 2,055/2,055.
- Guidance coverage: 341 write-path refusals across 203 modules accounted for.
- Full qualification: see
  [LINKEDIN-LEAD-FORM-STATES-VERIFICATION-2026-09-27.json](LINKEDIN-LEAD-FORM-STATES-VERIFICATION-2026-09-27.json).

Remaining rows: 708 (one LinkedIn row reviewed; LinkedIn blocked writes 94 → 93). Live acceptance
is unverified; it needs the updated deployment and a LinkedIn ad account with a lead form.
