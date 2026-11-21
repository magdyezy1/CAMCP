---
status: reference
tier: operator
---

# Write acceptance: zero-spend reviewed writes

The owner-run acceptance of AMCP's central promise (ACC-01): a guided recipe goes through preflight, the whole-plan
review, approval, each step's review and execution, and automatic read-back on a real provider, and executing the same
review again writes nothing. It runs on a non-serving Google Ads test account, so nothing serves and nothing is spent.
Nothing here has been run live; ACC-01 stays open until the owner runs it ([rules for every run](README.md)).

## What is proven locally

- Every one of the <!-- fact:campaign_recipes -->20<!-- /fact --> guided recipes has a synthetic run-to-read-back fixture: the Google Search recipes in
  `tests/campaign-plan-recovery.test.mjs`, `tests/google-clicks-recipe.test.mjs`, `tests/google-conversion-recipes.test.mjs`
  and `tests/google-value-recipes.test.mjs`, Performance Max in `tests/google-pmax-recipe.test.mjs`; the Snapchat
  recipes in `tests/snapchat-traffic-recipe.test.mjs` and `tests/snapchat-lead-recipe.test.mjs`; the TikTok traffic and
  purchases packs in `tests/tiktok-launch-recipes.test.mjs` and their Upgraded Smart+ twins in
  `tests/tiktok-smart-plus-recipe.test.mjs`; LinkedIn lead generation in
  `tests/linkedin-lead-recipe.test.mjs`; the three Meta website recipes and `microsoft_search` (with its location
  targets, CMP-03) in `tests/recipe-run-to-readback.test.mjs`. That file also proves a step whose response was lost stays `uncertain` and is
  never sent again (Meta and Microsoft), and that a re-executed review writes nothing.
- The harness (`tools/acceptance/write-acceptance.ts`) is tested in `tests/write-acceptance-harness.test.mjs`: it refuses
  without every live flag, refuses an account Google does not report as a test account before preparing anything, and
  on a synthetic Google test account records an accepted run whose ledger rows pass the ledger schema.

## Before the run (owner)

1. Designate a Google Ads **test manager account** and a **test account** under it, and record them in the provider
   access register (`google` → `test_manager_account`). Google documents that test accounts serve no ads and incur no
   charges, and that they work with Test access. Confirm that the Cloud project behind the OAuth client used for the run
   can reach test accounts.
2. Write the authorization: the action (one paused `google_search` build plus read-back), the test account (by its owner
   label, for example `google-test-a`), and that it is a write. Give it a reference such as `owner-auth-2026-10-20-1`.
3. Record the release: the `/versionz` revision and package hash of the build that runs the harness.
4. Write the plan file outside the repository (it names the account ID, so it stays in the owner's private evidence
   store):

```json
{
  "ticket": "ACC-01",
  "authorization_ref": "owner-auth-2026-10-20-1",
  "provider": "google",
  "recipe": "google_search",
  "account_type": "test",
  "account_label": "google-test-a",
  "account_id": "REPLACE_WITH_TEST_ACCOUNT_ID",
  "login_customer_id": "REPLACE_WITH_TEST_MANAGER_ID",
  "business": {
    "name": "AMCP acceptance search",
    "currency": "USD",
    "daily_budget": "1.00",
    "cpc_bid": "0.10",
    "country_criterion_ids": ["2840"],
    "language_criterion_ids": ["1000"],
    "keywords": ["acceptance test"],
    "headlines": ["Acceptance headline one", "Acceptance headline two", "Acceptance headline three"],
    "descriptions": ["An acceptance description for a test account.", "A second acceptance description."],
    "destination_url": "https://example.com/",
    "contains_eu_political_advertising": "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING"
  },
  "release": {"revision": "REPLACE_WITH_VERSIONZ_REVISION", "package_sha256": "REPLACE_WITH_PACKAGE_SHA256"}
}
```

## Dry run (no request)

`npm run build`, then `node dist/tools/acceptance/write-acceptance.js plan.json`. It validates the plan, compiles the
recipe locally and prints the steps, the paused parent, the guard and every live flag still missing. It reads no
credential and sends nothing. Fix any `problems` before going further.

## Live run (owner, separately authorized)

Set these through a secret-safe mechanism, never on the command line or in a committed file:

| Variable | Value |
|---|---|
| `AMCP_ACCEPTANCE_LIVE` | `true` |
| `AMCP_ACCEPTANCE_AUTHORIZATION` | the plan's `authorization_ref` |
| `AMCP_ACCEPTANCE_PLAN_SHA256` | the SHA-256 of the exact plan file the owner approved |
| `AMCP_ACCEPTANCE_RUN_ID` | a stable run ID; reuse it to resume after an interruption |
| `AMCP_ACCEPTANCE_STORAGE_KEY` | a 32-byte base64 key for the run's encrypted local state; keep it with the run ID |
| `AMCP_ACCEPTANCE_CREDENTIALS_JSON` | `{"accessToken":"…"}`: a short-lived token of a login that can reach the test account |

Then `node dist/tools/acceptance/write-acceptance.js plan.json --live`. The harness, in order:

1. asks Google for `customer.test_account` of the plan's account. Anything but `true` for that exact account ends the
   run as `refused`, with nothing prepared or sent;
2. saves a local spending policy for the run: a budget above the plan's own is refused, and so is any deletion;
3. creates the plan from the recipe, runs preflight (a block ends the run) and approves the whole plan;
4. prepares and executes each step under its own review, every entity created paused or under a paused parent, and
   waits for the automatic read-back to verify it;
5. executes the last review again and counts the writes that reach Google: a duplicate must write nothing.

Every request passes a guard that allows only `googleads.googleapis.com` and the plan's own account, refuses DELETE,
redirects and any `remove` operation, and refuses every mutate until step 1 reported test status. The state is kept
encrypted in `.runtime/acceptance/<run-id>/`; an interrupted run resumes with the same run ID and key, and an uncertain
step is never sent again (reconcile it as the plan's recovery says).

The record (`.runtime/acceptance/<run-id>/record.json`) holds the review IDs, read-back digests, the provider contract
digest and API version, the duplicate's write count and the ledger rows: no account ID, token or payload. The run is
`accepted` only when every step verified and the duplicate wrote nothing.

## Recording and closing

1. `node tools/acceptance/ledger.mjs add .runtime/acceptance/<run-id>/record.json`, then `npm run contracts:actions` and
   `node tools/acceptance/provider-access.mjs`; commit the ledger, the action ledger and the register.
2. In the Google Ads UI, the owner confirms that the entities exist, are paused, that no production account was touched
   and that nothing was spent.
3. Optional cleanup goes through AMCP's own reviewed deletes and needs its own authorization. Activation is out of scope.
4. Record the result in the qualification record (QA-01). B17's acceptance closes on this evidence, or is formally
   amended under D25.

## Other providers

- **Microsoft Advertising and X**: the sandbox runner (`npm run test:sandbox`, [sandbox verification](../SANDBOX-VERIFICATION.md))
  maps their documented sandbox hosts; `microsoft_search` runs to read-back there after PRV-03.
- **Meta**: a sandbox ad account is described only in a 2016 Meta developer blog. Until Meta's current documentation
  shows one and a guard can read its sandbox status from Meta, the harness refuses Meta.
- **Snapchat**: an owner-designated non-serving account cannot be proven non-serving from an API answer, so the harness
  refuses it; a paused-only run on a real account is an owner decision with residual risk and is not built here.

## Remaining (not in this repository)

- The owner designates the test manager and test account and authorizes the run (R1).
- The deployed run (the same recipe through amcp.shop by the owner, matching receipts) and the manual checks above.
- A server-side test-account connection profile, and the inverse guard that refuses an acceptance-tagged plan on a
  production login, are not built: the harness keeps its own local login and guard instead.
