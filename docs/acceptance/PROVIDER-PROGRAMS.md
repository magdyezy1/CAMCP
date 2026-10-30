---
status: reference
tier: operator
---

# Provider programs: LinkedIn Media Planning, Audience Insights and Display & Video 360

ACC-08 is an externally blocked acceptance. AMCP's three program checks are implemented, but each needs approvals and
roles that only LinkedIn and Google can grant. It stays open until all three reads succeed under the owner's
authorization; documenting the blocker does not complete it.

## Where it stands

- **LinkedIn (authorized live read, 2026-10-08).** Both program checks for the designated LinkedIn account returned
  `state: blocked` with `blockers: [PROVIDER_ACCESS_DENIED]`, one provider request each, nothing saved, and
  `entitlement: unverified`. No HTTP status or provider message was retained then, so no cause is inferred. Since
  PRV-02 a check keeps the HTTP status, LinkedIn's documented code as a closed set and LinkedIn's request ID.
- **Display & Video 360.** No advertiser is configured and AMCP's Google identity has no user profile, so there is
  nothing to check against.

## What each program requires

These are the providers' documented prerequisites (the program references, read 2026-10-06 and 2026-10-08). The owner
requests them from the provider and declares each one in the [provider access register](../PROVIDER-ACCESS.md) with its
date. Approval e-mails and tickets stay in the owner's private evidence store, never in the repository.

| Program | What the provider requires | How to obtain it | Register entry |
|---|---|---|---|
| `program:linkedin_forecast` ([Media Planning](https://learn.microsoft.com/en-us/linkedin/marketing/media-planning/media-planning-api?view=li-lms-2026-09)) | Advertising API access for the production application; the application provisioned with the Media Planning API product (qualified developers only); a three-legged member token whose member has a role on the ad account | Confirm the Advertising API tier; file a LinkedIn Developer Support request for Media Planning, complete the application survey and the Technical Sign Off of the integration requirements | `linkedin.advertising_api_access`, `linkedin.media_planning_product` |
| `program:linkedin_audience_insights` ([Audience Insights](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/audience-insights-api?view=li-lms-2026-09)) | The application provisioned with the private Audience Insights API product; a member with an ad-account role of VIEWER or above | Complete the application survey for the private product; give the connected member a role on the account in Campaign Manager | `linkedin.audience_insights_product` |
| `program:dv360_advertiser` ([Display & Video 360 API](https://developers.google.com/display-video/api/guides/getting-started/overview)) | A Google Cloud project for the API; a Display & Video 360 user profile for AMCP's Google identity with Admin, Standard or Read only access to the partner or advertiser; the Display & Video 360 permission granted at connect | Ask an existing Display & Video 360 administrator to create the user profile (an organisation without Display & Video 360 contacts Google); connect that identity in Connections and select the advertiser | `dv360.user_profile` |

A forecast needs a USD budget in micros, positive geographic targeting and a future period within 90 days; Audience
Insights counts audiences of 300 to 100 million members and suppresses segments under 30. Display & Video 360 reach
forecasts are a beta for allowlisted partners and are not part of this acceptance.

## What AMCP shows on a refusal

A check never treats a refusal as a grant and never infers a cause from a 403. For LinkedIn's two documented 403 codes
it shows the resolution the code names (`documented_refusals` in `src/conditional-programs.ts`):

| LinkedIn code | Names | AMCP's follow-up |
|---|---|---|
| `ACCESS_DENIED` | The application is not provisioned for the private product | Apply for, or confirm, the product for the production application, then check again |
| `USER_NOT_AUTHORIZED` | The connected member has no role on the ad account | Ask an account manager to give the member a role in Campaign Manager, then check again |

Any other code keeps the generic text: LinkedIn refused without a documented code, AMCP infers no cause, and the owner
confirms the approval and the member's role with LinkedIn citing the request reference. A Display & Video 360 refusal
points to the user profile. Each live check keeps one observation for 30 days, labelled "not a grant" (owner decision
D20), which Settings (owner health) and Capabilities show. Tests: `tests/conditional-program-refusals.test.mjs` and
`tests/conditional-program-follow-up.test.mjs`.

## Recheck (owner, separately authorized)

Recheck after a provider answer (an approval e-mail or ticket update), and at least once per release cycle while the
programs stay blocked:

1. Write the authorization: one bounded read per named program, on the designated accounts by owner label (for
   example `linkedin-a`, `dv360-a`). Give it a reference such as `owner-auth-2026-10-20-programs`.
2. `npm run build`, then `node tools/acceptance/program-recheck.mjs template`. Fill the plan outside the repository
   (it names account IDs): the release, the authorization reference, the account IDs, and each LinkedIn request's
   `sponsoredAccountUrn` for that same account. The forecast that closes ACC-08 is `forecastReaches`.
3. Dry run: `node tools/acceptance/program-recheck.mjs plan.json`. AMCP inspects each program locally
   (`program_check` without `live`), lists the one read each makes and every live flag still missing. Nothing is
   sent.
4. Live run: set `AMCP_ACCEPTANCE_LIVE=true`, `AMCP_ACCEPTANCE_AUTHORIZATION` (the plan's reference),
   `AMCP_ACCEPTANCE_PLAN_SHA256` (of the approved plan file), `AMCP_ACCEPTANCE_RUN_ID` and
   `AMCP_ACCEPTANCE_CREDENTIALS_JSON` (`{"linkedin_native_action": {"accessToken": "…"}, "dv360_native_action":
   {"accessToken": "…"}}`, short-lived tokens of read-only logins) through a secret-safe mechanism, then add `--live`.
   Any missing or different flag is a refusal before a credential is read. Each program runs AMCP's own `program_check`
   once on an in-memory login that holds only its account; a guard lets through only that program's documented route
   (`POST /rest/mediaPlanning` with a forecast action, `POST /rest/targetingAudienceInsights` with `audienceInsights`,
   `GET /v4/advertisers/{id}`), refuses any other host, method, method override or redirect, and stops at three
   requests per program.
5. The record (`.runtime/acceptance/<run-id>/record.json`) keeps per program AMCP's state, code and closed-set provider
   code, the resolution it showed, and the provider's literal answer: HTTP status, LinkedIn's `code` and
   `serviceErrorCode` (Google's error status and code), its message with every ID, URN value, address and URL
   replaced, and the provider request ID. It holds no token, payload or account ID. A blocked program is a recorded
   answer, not a failed run.
6. `node tools/acceptance/program-recheck.mjs check <record.json>`, then `node tools/acceptance/ledger.mjs add
   <record.json>`. Copy each `record.register` entry into `src/provider-access.json` (`value` and `declared_at` from
   `checked_on`; the `status` stays the owner's declaration: `applied`, `approved` or `denied`), then `npm run build`,
   `node tools/acceptance/provider-access.mjs` and `npm run contracts:actions`, and commit the ledger, the register and
   the generated files.

## Closing ACC-08

ACC-08 closes only when, under the owner's authorization, all three reads succeed:

- `POST /rest/mediaPlanning?action=forecastReaches`;
- `POST /rest/targetingAudienceInsights?action=audienceInsights`;
- Display & Video 360 `advertisers.get`.

Only a record with all three observed says `status: unblocked`; `check` refuses any other claim. The measurable outcome
is, per program, its state (blocked, approved or verified), the date of the last recheck and the literal provider
code. Present: blocked, `PROVIDER_ACCESS_DENIED`, no literal code recorded (2026-10-08).

Removing or parking these features until approval would keep the capability listings shorter, but it is a scope
change and an owner decision; they stay listed with entitlement `unverified`, each check bounded to 3 requests, 1,000
rows, 2 MiB and 30 seconds.

Tests: `tests/program-recheck-harness.test.mjs` (plans, dry run and flags, the guard, documented and undocumented
refusals with literal codes, the closure rule and the record check).
