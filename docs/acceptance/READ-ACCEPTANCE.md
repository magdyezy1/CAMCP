# Read acceptance: measurement, TikTok, Reddit value unit, X placement

The owner-run, read-only acceptance of ACC-06 in four parts, each run on its own under its own written authorization:

| Part | What it settles | Reads |
|---|---|---|
| `measurement` | The four measurement reads work on real provider answers, with nothing changed | `measurement_audit` (Tag Manager), `measurement_events` and `measurement_event_identity` (GA4), `measurement_conversions` (LinkedIn), once each |
| `tiktok` | TikTok's core reads work live, not only against fixtures | advertiser info, campaigns, ad groups, ads, the integrated report and identities: six one-page reads |
| `reddit_value_unit` | Whether Reddit's purchase value is in cents, as AMCP reads it | AMCP's own campaign report for one closed week, compared with Reddit Ads Manager |
| `x_publisher_network` | Whether X reports data for `placement=PUBLISHER_NETWORK` | the window's active campaigns, then one stats read for that placement |

Nothing here has been run live; ACC-06 stays open until the owner runs it ([rules for every run](README.md)). Every
run is a provider read: no test event, conversion, Tag Manager change or write is sent.

## What is in the product now (interim)

- **Reddit.** AMCP reads `CONVERSION_PURCHASE_TOTAL_VALUE` as cents (`redditConversionValueDivisor`, one constant for
  `normalizeNativeRow` and the metric sources) while `SPEND` is in micros. A Reddit report that reads the value carries
  the notice "Reddit conversion value and ROAS are unverified…", shown in English and Arabic on the reporting page.
  Reddit's result definition stays `unknown` on purpose, so sales recommendations keep asking for review.
- **X.** Reports request `ALL_ON_TWITTER`, `SPOTLIGHT` and `TREND` only. When X's active-entities answer names
  `PUBLISHER_NETWORK` for a campaign, the source is marked partial (budget guidance is withheld) and the notice
  "N X campaigns have activity on the publisher network…" names the count. A campaign active only there is never a
  zero row. Line items may still choose the placement.
- **TikTok.** No TikTok sandbox origin is qualified: sandbox mode refuses TikTok with `SANDBOX_ROUTE_UNQUALIFIED` before
  any URL exists and never falls back to `business-api.tiktok.com`.

Tests: `tests/read-acceptance-interim.test.mjs` (the three items above) and `tests/read-acceptance-harness.test.mjs`
(the harness: refusals, dry runs, the guard and a synthetic run of every part).

## Before a run (owner)

1. Designate the assets (owner request R2) and declare them in the [provider access register](../PROVIDER-ACCESS.md):
   GA4 `test_property`, Tag Manager `test_container`, TikTok `sandbox_advertiser` (whether one exists), and the Reddit,
   X and LinkedIn accounts by owner label. A `measurement_event_identity` read needs a property marked as a test
   property with an event-scoped `amcp_test_id` dimension (owner decision P4); skip that read otherwise.
2. Write the authorization for one part: the reads, the designated accounts by owner label (for example
   `tiktok-read-a`) and that they are reads. Give it a reference such as `owner-auth-2026-10-20-tiktok`.
3. Record the release: the `/versionz` revision and package hash of the build that runs the harness.
4. Print a blank plan with `node tools/acceptance/read-acceptance.mjs template <part>` and fill it outside the
   repository (it names account IDs, so it stays in the owner's private evidence store). Ranges are closed days in UTC:
   the TikTok report and the X window are 1 to 7 days, the Reddit week exactly 7, all ending before today.
5. Reddit only: in Reddit Ads Manager, read the purchase conversion value of the same week and account, and enter it in
   `manual.ui_conversion_value` (a decimal string in the account currency) with `manual.currency` and `manual.read_on`.

## Dry run (no request)

`npm run build`, then `node tools/acceptance/read-acceptance.mjs plan.json`. It validates the plan and lists every read
by route and owner label (TikTok's six reads are compiled against the registry exactly as the live run sends them),
with the guard and every live flag still missing. It reads no credential and sends nothing.

## Live run (owner, separately authorized)

Set these through a secret-safe mechanism, never on the command line or in a committed file:

| Variable | Value |
|---|---|
| `AMCP_ACCEPTANCE_LIVE` | `true` |
| `AMCP_ACCEPTANCE_AUTHORIZATION` | the plan's `authorization_ref` |
| `AMCP_ACCEPTANCE_PLAN_SHA256` | the SHA-256 of the exact plan file the owner approved |
| `AMCP_ACCEPTANCE_RUN_ID` | a run ID; the record is written to `.runtime/acceptance/<run-id>/record.json` |
| `AMCP_ACCEPTANCE_CREDENTIALS_JSON` | `{"<gateway>": {…}}`: a short-lived token of a read-only operator login per gateway the part reads (`{"accessToken": "…"}`; X needs `consumerKey`, `consumerSecret`, `accessToken`, `tokenSecret`) |

Then `node tools/acceptance/read-acceptance.mjs plan.json --live`. Any missing or different flag is a refusal before a
credential is read. The run uses AMCP's own read paths on an in-memory login that holds only the plan's accounts with
read permissions, as a read-only service, and nothing is saved after it. Every request passes a guard that allows only
the part's provider hosts, GET requests and the documented read POSTs (GA4 `runRealtimeReport`/`runReport`, Reddit
`/reports`), refuses method overrides and redirects, and stops at the part's request ceiling (measurement 150, TikTok
12, Reddit 8, X 4). Reddit logins send the website's User-Agent (`AMCP_REDDIT_USER_AGENT` or AMCP's default).

The record keeps, per read, the outcome (`accepted`, `refused` or `inconclusive`), status codes, provider request IDs,
the provider's closed-set codes and response-shape digests (keys and value types, never values), and the routes with
every native ID replaced by `{id}`. `provider_mutations` is the count of sent requests that were neither GET nor a
documented read POST, and is always 0. It holds no account ID, token, payload or metric value: for Reddit only the
ratio of AMCP's value to the UI value and the divisors.

### What each part decides

- **measurement**: each read is accepted when AMCP answered and every provider answer was 2xx with AMCP's own write
  counters at 0. A 401 or 403, or a refusal code, is recorded as `refused` (the owner follows up the login or
  permission); nothing is inferred from it.
- **tiktok**: each of the six reads is accepted on a 2xx answer with TikTok's envelope `code` 0; another code is kept as
  a provider code and the read is not accepted. When all six are accepted, the readiness document lists TikTok among
  the providers with read-only live acceptance.
- **reddit_value_unit**: `accepted` when AMCP's week total matches the UI value within rounding (half a cent per
  campaign, at least one cent), in the same currency, from a complete report. Otherwise the run is `inconclusive` and
  `result.implied_divisor` says what Reddit's unit is (1,000,000 means micros). A correction changes
  `redditConversionValueDivisor` and the unit test, applies to new snapshots only (older snapshots keep their values
  and are labelled), and removes the interim notice; the same check names the result definition, or the document says
  why it stays unknown.
- **x_publisher_network**: a 2xx answer with data is `data_returned`: add `PUBLISHER_NETWORK` to the report placements,
  coordinated with the RPT-03 request budget (a fourth placement is a third more analytics requests). A 4xx refusal is `refused_by_x`, with
  X's code: refuse or warn on `PUBLISHER_NETWORK` line items with a clear message. Either answer settles the question
  (`outcome: accepted`); the stats route is recorded in the ledger only when X answered with data, so a refusal of the
  placement never marks the route AMCP uses as refused.

## Recording and closing

1. `node tools/acceptance/read-acceptance.mjs check .runtime/acceptance/<run-id>/record.json`, then
   `node tools/acceptance/ledger.mjs add .runtime/acceptance/<run-id>/record.json`, `npm run contracts:actions` and
   `node tools/acceptance/provider-access.mjs`; commit the ledger, the action ledger and the register.
2. The owner confirms counts against the provider UIs (measurement events, TikTok campaigns), and signs off the Reddit
   unit.
3. Make the follow-up change each result names (Reddit divisor or definition, the X branch) in its own commit with its
   test, and record the result in the qualification record (QA-01).
4. Deployed: the owner runs the same measurement reads on amcp.shop.

## TikTok sandbox

TikTok sandbox advertisers on a separate API origin are a hypothesis from secondary sources: the developer portal is
unreadable without signing in. The owner checks the signed-in portal and declares `tiktok` → `sandbox_advertiser` in the
register. Only then can a sandbox origin be added to `buildUrl`, gated on a sandbox connection flag and an advertiser
allowlist, with no production fallback; sandbox writes need their own authorization, and sandbox success is necessary,
not sufficient (Smart+ and Spark may be missing there). Until then the interim test above keeps TikTok out of sandbox
mode.

## Remaining (not in this repository)

- The owner designates the assets, authorizes each part and runs it (R2); the deployed and manual checks above.
- The capture mode of the TikTok family sources: 27 of the 28 reviewed TikTok families cite portal pages read on
  2026-09-26 or 27, one cites TikTok's SDK yml files; whether the portal pages were read signed in is not recorded in
  this repository. The engineer who read them, or the owner, confirms it before a provenance line is added to each
  family header.
