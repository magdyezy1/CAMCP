---
status: record
tier: engineering
---

# LinkedIn lead gen forms — 2026-09-26

Base revision: `e45400e` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes"
in the [2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). Lead gen campaigns on LinkedIn
need a form before any lead gen creative can exist; `POST /rest/leadForms` was a blocked
write, and the form reads were blocked by account scope because the route has no
account in its path.

Contract source: Microsoft Learn, li-lms-2026-09, read on 2026-09-26:

- [Lead Syncing](https://learn.microsoft.com/en-us/linkedin/marketing/lead-sync/leadsync?view=li-lms-2026-09):
  `rw_ads` manages and reads ad forms, but lead responses need the separate Lead Sync
  program. Creation answers `201 Created` with the form ID in `x-restli-id`. The owner
  finder is `q=owner` with a `sponsoredAccount` or `organization` URN, paged by `count`
  and `start`. Updates are partial and limited once a form is published.
- [Lead Syncing Schema](https://learn.microsoft.com/en-us/linkedin/marketing/lead-sync/lead-sync-schema?view=li-lms-2026-09):
  required and read-only fields, the predefined field and call-to-action lists, the
  documented defaults (`responseEditable` and `responseRequired` true,
  `maxResponseLength` 300, `checkRequired` false, no consents), at most 20 hidden fields,
  legal disclaimers of 1–2,000 characters and 2–15 multiple-choice options with required
  integer IDs. Form IDs are 64-bit longs.

## Contract

`linkedin_rest_lead_forms_post` is the new reviewed family `linkedin_lead_forms`
(`src/linkedin-lead-forms.ts`).

| Stage | Behaviour |
|---|---|
| Validation | Before any request, `INVALID_LINKEDIN_LEAD_FORM` unless the body is a single sponsored form: owner `{sponsoredAccount}` of the selected account, `state: DRAFT`, a valid `creationLocale`, every text field in `{localized}` form with the creation-locale key, the required hidden fields, questions, legal information and documented enums and limits. Read-only fields, `questionSubmissionCriteria`, `DOWNLOAD_NoW`, query parameters and REST.li methods other than `CREATE` are refused |
| Scope | Creation needs `rw_ads`; form reads accept `r_ads`, `rw_ads` or `r_marketing_leadgen_automation` (`INSUFFICIENT_SCOPE`) |
| Reads | The selected ad account, before review and again before execution |
| Spending | None. Lead forms are excluded from the word heuristic that asks for spending confirmation, so question text mentioning budgets does not trigger it |
| Impact | `creative_impact` lists the account, predefined fields, custom questions, required consents, privacy policy URL and hidden field names |
| Receipt | `201` with a numeric or `urn:li:leadGenForm:` ID in `x-restli-id` and no body |
| Ownership | The receipt, and the selected account's owner finder, establish ownership of the listed forms for owned single reads |
| Verification | One server-built read of `/rest/leadForms/{id}` that must be owned by the selected account, compared with the sent form after documented defaults. Server question and legal IDs, versions, timestamps and review status are not compared |

64-bit IDs: responses from `/rest/leadForms` now keep integers beyond JavaScript's safe
range as their exact source text (the transport already did this for report outputs).

Not qualified: publishing, edits and archiving (`POST /rest/leadForms/{id}`),
organization-owned forms, batch creation, batch `ids` reads, work-email submission
criteria, lead responses and lead notifications.

Other code: `src/transport.ts`, `src/scope.ts`, `src/reviewed-routes.ts`,
`src/write-review.ts`, `src/write-impact.ts`, `src/write-verification.ts`,
`src/preflight.ts`, `src/provider-contracts.ts` (LinkedIn contract version 7),
`src/action-contracts.ts`. Guidance: "Reviewed LinkedIn lead gen forms" in
`Skills/amcp-campaign-builder/references/linkedin-x.md` and an executable inspect
example. Generated: `docs/CONTRACTS.md`, `ACTION-CONTRACT-COVERAGE.{csv,json}`,
`REMAINING-ACTIONS-2026-09-26.csv` (961 rows).

## Tests

`tests/linkedin-lead-forms.test.mjs`, eight tests:

1. The create route inspects as reviewed with no network; the edit route stays blocked.
2. 34 invalid forms and 3 invalid request shapes are refused with `INVALID_LINKEDIN_LEAD_FORM` before any request.
3. With an owner policy that forbids activation, a form whose question mentions budgets is created without spending confirmation. The exact body and headers are sent once, the 64-bit ID verifies, replay makes no second POST, and the form is then readable with its exact ID.
4. The account's owner finder (REST.li string or JSON owner) establishes ownership of its own forms only; foreign owners, organization owners, extra parameters and batch reads are refused without a request.
5. Creation without `rw_ads` is refused before any request; `r_ads` can list forms; other scopes cannot.
6. A renamed, published, reordered or default-changed read-back is inconclusive; a read-back under another owner is not verified.
7. A changed account between review and execution stops the write.
8. A LinkedIn error, a missing ID and a lost response each POST once across a restart; an unrecognized receipt ID fails without granting ownership; concurrent executions submit once.

Red/green: all eight fail against a build of `e45400e` (`WRITE_CONTRACT_UNAVAILABLE`, and
blocked reads) and pass with this change. Local log:
`.runtime/linkedin-lead-forms-20260926/red-check.log`.

## Verification

- Targeted: 1236/1236 across 85 related suites.
- Guidance coverage: 238 write-path refusals across 114 modules accounted for.
- Full qualification: see
  [LINKEDIN-LEAD-FORMS-VERIFICATION-2026-09-26.json](LINKEDIN-LEAD-FORMS-VERIFICATION-2026-09-26.json).

Live acceptance is unverified; it needs the updated deployment and an ad account whose
login has `rw_ads`.
