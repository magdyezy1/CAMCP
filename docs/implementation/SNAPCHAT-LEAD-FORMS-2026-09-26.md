---
status: record
tier: engineering
---

# Snapchat lead generation forms — 2026-09-26

Base revision: `d88f1e0` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes"
in the [2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). A Snapchat LEADS campaign
needs a lead generation form before its `LEAD_GENERATION` creative can exist, and the
form create route was a blocked write. The 2026-09-25 live clone reused existing forms
for this reason.

Contract source: Snapchat Marketing API
[Lead Generation Ads guide](https://developers.snap.com/marketing-api/Ads-API/lead-generation-ads),
checked 2026-09-26. It documents create, get and list, but no form update or delete.

## Contract

Three captured actions for `POST /v1/adaccounts/{ad_account_id}/lead_generation_forms`
join the reviewed `snapchat_entities` family: `snapchat_lead_form_create`,
`snapchat_lead_generation_form_create` and
`snapchat_adaccounts_ad_account_id_lead_generation_forms_create`.

| Stage | Behaviour |
|---|---|
| Inspect / prepare | `src/snapchat-lead-forms.ts` validates every record before any read: only documented keys; `name`; `description` ≤180; `title` ≤25; `FIRST_NAME` + `LAST_NAME`; `EMAIL` or `PHONE_NUMBER`; not both `ADDRESS` and `POSTAL_CODE`; documented standard/custom field types; options only on multiple-choice questions; preferred options on one single-select question, every option marked, at least one `PREFERRED` and one `NOT_PREFERRED`; `legal_disclosures` title ≤35, description ≤80, one or two `{consent_description, required}` consents; documented end-page call to action and http(s) URLs; `ad_account_id` equal to the path account. Failures are `INVALID_SNAPCHAT_LEAD_FORM` with the record and field |
| Dependency reads | The review reads the account and, when present, `GET /v1/media/{banner_media_id}`. That read requires existing ownership, so a banner from another account is `RESOURCE_SCOPE_REQUIRED` before any write. A `LEAD_GENERATION` creative now reads `GET /v1/lead_generation_forms/{lead_generation_form_id}` at preparation and again before execution. A form ID that cannot be read is refused rather than skipped |
| Receipt | The existing Snapchat receipt rule now includes `lead_generation_forms`: request `SUCCESS`, one successful record with an ID per record sent. Failed, empty, duplicated and lost receipts never allow a second POST |
| Ownership | A created form is recorded for the connection and account only when the receipt names the same ad account. Account form lists and single-form reads renew it, as for other Snapchat global IDs |
| Verification | `GET /v1/lead_generation_forms/{id}`, compared on the documented configuration. `is_required` and `strategy_type`, which Snapchat adds, are ignored; any other difference stays `inconclusive` |

Not qualified: lead reports and lead webhooks (`leads_report`, `lead_gen/integrations`).
They carry submitted personal data and need their own consent, retention and recipient
policy. Their classification is unchanged.

Code: `src/snapchat-lead-forms.ts` (new), `src/reviewed-routes.ts`, `src/write-review.ts`,
`src/write-verification.ts`, `src/scope.ts`, `src/provider-contracts.ts` (Snapchat
contract version 4, reviewed 2026-09-26), `src/action-contracts.ts`. Guidance: "Snapchat
lead generation forms" in `Skills/amcp-campaign-builder/references/tiktok-snapchat.md`
and an executable inspect example in `Skills/amcp-campaign-builder/examples/contracts.json`.
Generated: `docs/CONTRACTS.md` and `ACTION-CONTRACT-COVERAGE.{csv,json}`.

## Tests

`tests/snapchat-lead-forms.test.mjs`, eight tests:

1. The three create actions inspect as reviewed with zero network requests. Webhook and report routes stay blocked or unqualified.
2. 24 invalid forms are refused before any request.
3. The banner is read; execution and replay each POST once; verification passes despite the provider-added fields; a native GET returns the form.
4. An unowned banner or form, and a malformed form ID, block preparation.
5. A `LEAD_GENERATION` creative reads its owned form twice.
6. A changed title reads back as inconclusive.
7. Failed, empty, duplicated and lost receipts give no second POST and never verify.
8. Two concurrent executions submit once. A fresh service over the same store replays and verifies. After a lost receipt, the review stays `WRITE_OUTCOME_UNCERTAIN`.

Red/green: all eight fail against a build of `d88f1e0` with the identical test file
(`WRITE_CONTRACT_UNAVAILABLE` / `review_contract_supported: false`) and pass with this
change. Local log: `.runtime/snapchat-lead-forms-20260926/red-check.log`.

Restart is modelled by a new service instance over the same store, which holds claims,
receipts and ownership. This keeps test files inside the workspace. Re-opening a file
store is covered generically by the existing Snapchat update restart tests.

## Deliberately not changed

- **Creative PUT/PATCH dependency reads.** The existing reviewed creative PUT and
  JSON Patch contracts can change `lead_generation_form_id`, as they can change
  `top_snap_media_id`, without reading the referenced resource. Adding reads there
  changes those contracts' state layout and belongs in their own batch.
- **Form update or delete.** Neither is documented by Snapchat.
- **Lead reports and webhooks.** Personal data; separate policy required (see above).

## Verification

- Targeted: 372/372 across 40 related suites (Snapchat writes, nested updates and
  workflow fixes, review, verification, scope, contracts, guidance, catalog,
  parameters, recovery and campaign suites).
- Guidance coverage: 227 write-path refusals across 106 modules accounted for,
  including the new module.
- Full qualification: see
  [SNAPCHAT-LEAD-FORMS-VERIFICATION-2026-09-26.json](SNAPCHAT-LEAD-FORMS-VERIFICATION-2026-09-26.json).

Live acceptance is unverified. It needs the updated AMCP deployment and a paused
account-owned test form, which this batch does not authorize.
