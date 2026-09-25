# Snapchat workflow defects — 2026-09-26

Base revision: `11fc25c` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target for this batch: `magdyezy1/CAMCP` only, as the user directed; `origin`
push is disabled in this checkout. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: live AMCP use on 2026-09-25, cloning a Snapchat LEADS campaign (2 ad squads,
4 ads, 4 creatives) as a paused test campaign in one ad account. Nine defects were
recorded in the user's bug report (`AMCP-Snapchat-bug-report.md`). The durable plan
could not finish; the clone was completed with per-request `amcp_write`.

## Fixed

| ID | Defect | Root cause | Change |
|---|---|---|---|
| BUG-1 | Plans pinning `expected_currency` failed preflight with `actual_currency: null` | `campaignPreflight` read `data.currency`; Snapchat nests the account at `adaccounts[0].adaccount` | Shared `accountMetadata`/`accountCurrency`/`accountTimezone` beside `accountPlan`, used by preflight, native reports and `amcp_workspace check`, which now returns `account.currency`/`timezone`. Also fixes TikTok (`data.list[0]`) and Reddit (`data`) preflight currency |
| BUG-2 | Every ad squad created with `placement_v2` stayed `VERIFICATION_INCONCLUSIVE`, stalling the plan | Verification compared every sent field with `GET /v1/adsquads/{id}`, which never returns `placement_v2` (reads show `placement: "UNSUPPORTED"`) | Snapchat ad squad `placement_v2` is compared with the provider write response and reported as `acknowledged_fields`; a missing or different echo stays inconclusive with `unacknowledged_fields` |
| BUG-3 | `prepare` passed, `execute` failed `RESOURCE_SCOPE_REQUIRED` seconds later | The 5-minute ownership observation of the new campaign expired between prepare (+4m53s) and execute (+5m05s); prepare's own campaign read did not renew it | A successful single-entity Snapchat read of an entity `authorize()` already allowed renews its ownership when Snapchat names the owning ad account (campaigns, creatives, media) or a parent this login still owns (ad squad → campaign, ad → ad squad). Review state reads pass through this. Account pixel lists now establish pixel ownership |
| BUG-4 | A step stuck in `verifying` blocked steps that did not depend on it | `prepare_next`/`execute_next` only ever took the first unfinished step | While that step's read-back stays inconclusive or pending, the runner advances to the first executing, review-ready or pending step whose declared predecessors are all verified. Failed, uncertain, mismatched or processing steps still stop the plan |
| BUG-5 | A pixel the account does not own passed preflight; Snapchat rejected it at write time (`E2405`) | Preflight did not read pixel ownership | Ad squad `pixel_id` values are compared with `GET /v1/adaccounts/{id}/pixels`: `SNAPCHAT_PIXEL_NOT_OWNED` with `owned_pixel_ids`, before any step is submitted. An unreadable list is deferred to the provider |
| BUG-6 | `result_fields` returned no records for Snapchat ad squad lists | Projection did not know Snapchat's `adsquads`/`adsquad` (and media, pixel, segment…) wrappers, so a whole list was projected as one record | Snapchat-only envelope names; other providers' projection is unchanged |
| BUG-8 | `execute` rejected the review's own `gateway`/`connection_id` with a misleading message | Any presence of those arguments failed | Identical values are accepted; different ones fail with the bound values; `arguments` still fail, with a clearer message |
| BUG-9 | Invalid plan steps got one generic error | One combined condition | The error names each invalid field, requires `gateway` on write steps and shows the step shape and `$ref` syntax |

Code: `src/workspace.ts`, `src/campaign-preflight.ts`, `src/report-native.ts`,
`src/write-verification.ts`, `src/scope.ts`, `src/write-review.ts`,
`src/campaign-runner.ts`, `src/projection.ts`, `src/service.ts`, `src/errors.ts`.
Guidance: `Skills/amcp-campaign-builder/references/tiktok-snapchat.md` (served as
`amcp://guides/tiktok-snapchat`). Tests: `tests/snapchat-workflow-fixes.test.mjs`.

## Deliberately not changed

- **BUG-7** `snapchat_creative_get_by_ids` returning `E1001`: the mirror has no Snapchat
  vendor specification and the public creatives reference documents no batch read.
  The request mapping is unchanged until provider evidence names the body.
- **Snapchat recipe** (part of BUG-9): recipes need their own qualified contract for
  budget, currency, pixel and media inputs.
- **`reconcile_step` "accept with evidence"**: the root cause (BUG-2) is fixed instead;
  an operator verification bypass needs a separate design.
- **Review-bound ownership re-grant**: tried for BUG-3 and removed. Re-granting
  ownership recorded at prepare revived ownership after a connection was re-provisioned,
  which the existing test "Snapchat accepted receipts survive an access withdrawal
  before delivery" correctly refuses. Read-based renewal cannot do this, because the
  read itself is authorized only while ownership is still valid. A review executed in
  the last moments of its window, after an unrenewable parent observation lapsed, can
  still fail closed with `RESOURCE_SCOPE_REQUIRED`.
- **Nested-update PUT and `placement_v2`**: `snapchat-nested-updates` compares
  preserved fields with the GET before-state. Live GET omits `placement_v2`, so a
  complete PUT that includes it would be refused (its synthetic fixture returns the
  field on GET). Needs live evidence of PUT semantics before changing.
- The legacy campaign `objective` reading `BRAND_AWARENESS` for API-created LEADS
  campaigns is provider behaviour, not an AMCP defect.

## Verification

- **Red/green**: all 10 new tests failed against the `11fc25c` code (with the new
  helper import stubbed) and pass with the fixes. Local log:
  `.implementation/1790373715000-snapchat-fixes-red-check.log`.
- **Regression caught during development**: the review-bound re-grant above failed the
  existing access-withdrawal test; the approach was removed and a test now pins that
  re-provisioning still blocks a child prepare.
- **Targeted suites**: 210/210 across Snapchat writes/nested updates, parameters,
  review, verification, scope, recovery, workflows, error remedies, reporting,
  LinkedIn/Google execute-argument tests and recipes.
- **Full qualification**: see
  [SNAPCHAT-WORKFLOW-VERIFICATION-2026-09-26.json](SNAPCHAT-WORKFLOW-VERIFICATION-2026-09-26.json).

Live acceptance is unverified. These fixes reach the AMCP connector only after the
deployment that serves it is updated from this code, which this batch does not do.
Re-run the Snapchat clone as a single plan with `expected_currency` set afterwards.
