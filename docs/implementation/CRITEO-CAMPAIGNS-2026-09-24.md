# Criteo auction campaigns: implementation and evidence

Base: Codex-branch at 6065847f96edde164b9b697cecc1f0500ad81ccc.
Only the implementation checkout changed. This batch qualifies two exact actions
under criteo_campaign_ops: CREATE_CAMPAIGNS_BY_ACCOUNT_ID (POST, 201) and
UPDATE_CAMPAIGN_BY_CAMPAIGN_ID (PUT, 200), pinned to Retail Media 2026.01.
Both formerly failed with WRITE_CONTRACT_UNAVAILABLE. The original two desired
end-to-end tests failed before implementation; the retained log proves that gap.
This is a bounded campaign family, not a claim that every Criteo variant works.

## User workflow and contract

1. Select an explicit login/account and discover its campaigns and balances.
   An update needs an account-scoped campaign observation on that connection.
2. Inspect the exact native Campaign request; prepare with amcp_write. Supply all
   13 editable attributes explicitly: name, budget, dailyPacing, monthlyPacing,
   isAutoDailyPacing, startDate, endDate, clickAttributionWindow,
   viewAttributionWindow, clickAttributionScope, viewAttributionScope, companyName,
   onBehalfCompanyName. PUT additionally binds data.id to the selected campaign.
   Create sets type auction and an explicit drawableBalanceIds array (0-50).
3. Budget is a finite nonnegative native number; daily/monthly pacing are finite
   positive numbers. Auto pacing must be false. Dates are valid offset-bearing ISO
   instants, end after start. Attribution enums/scopes and company fields validate.
   Company fields may be explicit null; omission is never inferred as preservation.
4. Review freezes the exact request and complete stable account/campaign/funding/
   line-item configuration. Execution independently rechecks current authority,
   credentials, state and owner spending policy before the single mutation.
5. Provider receipts validate against pinned schemas and exact account/target.
   A create receipt does not grant ownership. Verification freshly proves scoped
   membership, intended fields and preserved dependencies before registering it.
   The returned read_result is an executable account-scoped next call.
6. Lost, malformed, partial and uncertain results keep the original durable claim.
   A restart never retries the mutation. Verify the original review; an unresolved
   outcome requires operator diagnosis, not a fresh create or cleared receipt.

The provider clears omitted PUT fields to null where supported. This is why the
complete field set is required instead of manufacturing defaults from user intent.
The account-global child GET is used only after fresh account-scoped membership;
admin bindings and forged internal context cannot substitute for that proof.

## Implementation and safeguards

src/criteo-campaign-writes.ts owns validation, semantic projection, bounded reads,
receipt checks and exact request comparison. scope, write-review, write-verification,
spend-policy, preflight, write-impact, transport and types integrate the family.
Reviewed-route/action/provider descriptors and the task guide expose its real scope.

A snapshot is collected twice and must agree. Account currency/timezone, campaign
editable/ownership fields, selected standard Onsite balances and scoped auction
line-item settings are projected; request meters and spending telemetry are not.
Budget overrides must be explicitly empty. Unsupported overrides are refused,
never cleared. Account names are not configuration. Known member/balance/line ID
collections are sorted; nested flight legs retain order. A line's computed daily
pacing is ignored only when that line explicitly uses automatic daily pacing.

Pagination continues until an explicit empty terminal page, not a short page or
an assumed metadata.count meaning. Native total counts, per-page counts and null
counts are exercised; inconsistent terminal totals fail. Limits: 1000 line items,
16 provider calls, 8 MiB and one 60-second monotonic deadline shared with transport.
Current actor, read/manage scopes, grants and original credential identity are
checked around reads. Verification requires current read rights; provider URLs
cannot redirect these reads elsewhere.

Budget, dailyPacing and monthlyPacing are independently mapped to owner policy in
native units with their own current campaign baseline. Positive changes accumulate
without netting decreases; child budgets never become a parent baseline. Create
uses zero baseline and update uses percentage controls. All campaign creates and
updates conservatively require activation permission and explicit spend confirmation.
The shared financial arithmetic is unchanged by this batch; decimal precision is
a separate follow-up investigation, not evidence that these limits are exact.

The generator keeps only 11 transitively referenced pinned schema components and
adds response schemas for these two methods. Delegated Criteo request/response
validation therefore checks the exact qualified wire contracts without marking
other native methods qualified. IDs must be positive signed-int64-range strings.
No new runtime dependency or SQL schema migration is introduced.

## Verification and first failures

[Machine evidence](CRITEO-CAMPAIGNS-VERIFICATION-2026-09-24.json) records commands,
log hashes, initial results and the full candidate manifest. Node 24.19.0,
npm 11.17.0, Windows/PowerShell; portable FFmpeg 9.0.2 required, not globally installed.

- Baseline: 0 pass / 2 fail, both WRITE_CONTRACT_UNAVAILABLE.
- First implementation: 2 pass. Expansion initially had a native-bypass fixture
  missing confirmation, then an extra nested parameter rejected by the catalog;
  both fixtures were corrected to reach the intended native review guard.
- Adding response schemas exposed unresolved references: 8 pass / 9 fail.
  The generator was corrected to retain dependencies; validation was not disabled.
- Final expansion: 93 pass / 1 fail because a revocation fixture attempted to save
  an enabled connection with no accounts. It now revokes the actual required scope.
- Final family: 21 pass / 0 fail / 0 skip. Covers create/update/verify, state drift,
  telemetry stability, 501-page boundaries/null counts/1001 caps, foreign ownership,
  PUT clearing, policy and activation gates, revoked/replaced credentials, exact
  schemas and receipts, concurrent claims/daily caps, SQLite restart, immediate
  scoped reuse and transport deadline cancellation.
- Sanitized candidate A: **1481 main + 4 capture pass; 0 fail; 0 skip.** Offline
  install and every npm run check stage exit 0 with required real FFmpeg. Manifest
  contains 566 files; tree 7560219762811847ad47196bb8a9854bce253f8d89e784c14a1eaf4f68581ceb.
  Check log SHA256 f61c70c4ea43922b00bdc43534632575c5aa7040f3c54d9ad4764450778adfde.

Full checks use fresh assembled candidates. Historical live-read samples are
replaced with [] without reading their private source. Root focused tests are
synthetic. Docker/Linux/hosted CI and all live Criteo behavior remain unverified.

## Explicit limits, rollout and next work

Not covered: preferred campaigns, retailer-budget funding, automatic/uncapped
campaign pacing, nonempty budget overrides, funding/balance reassignment, campaign
deletion, line-item creation, Criteo website OAuth/dashboard integration or 2026.07
migration. Those require their own state, money, authority and recovery contracts.
Do not turn an inspect mapping or the family count into a blanket executable claim.

Roll out in staging with read-only discovery first, then a separately authorized
provider test account with known funding, permissions and a reviewed bounded write.
Prove native PUT semantics and account-scoped read-back before production use.
Reverting this family restores blocked routes; keep all receipts and observations.
Never remove uncertain claims to make an older binary retry. No stored schema
migration is needed; older binaries ignore the new schema metadata.

Current inventory: 3241 actions, 432 reviewed-family, 888 blocked writes, 88 unmapped,
27 unqualified reads, eight input-dependent and four retired provider-unsupported.
Remaining ledger: 1015 rows including retired entries. Criteo: 108 mapped methods,
14 reviewed, 51 native reads, 43 blocked writes. Vendor denominator remains separate:
1208 pinned methods, 451 unmapped. Native read labels are not live qualification.

## Official evidence inspected 2026-09-24

- [Versioned campaign endpoint guide](https://developers.criteo.com/retail-media/v2026.01/docs/campaigns-endpoints):
  PUT clearing, editable fields, native budget units, computed status, Criteo versus
  retailer budgets and supported attribution rules. Its shortened PUT example
  omits fields required by the pinned schema; the implementation uses the schema
  plus documented preservation semantics, not that incomplete example.
- [Campaign create reference](https://developers.criteo.com/retail-media/reference/createcampaignsbyaccountid)
  and [auction line collection](https://developers.criteo.com/retail-media/reference/getauctionlineitemsbycampaign).
- [Pinned 2026-01 OpenAPI](https://api.criteo.com/2026-01/retailmedia/open-api-specifications.json),
  captured 2026-09-04; canonical SHA256
  8e6782adc10a3f295eff7d12329f1f766aa7c06f6018de74048645d7bdb72ab1.
  All 13 editable keys are crosschecked in tests. Native metadata.count is nullable
  and its meaning underspecified; empty-page exhaustion supplies completeness.

Current guide pages mix 2026.07 global-GET behavior with earlier account lists.
The adapter remains on exact pinned 2026.01 paths; no version upgrade is inferred.

Final candidate B: 568 files, tree 833609765f97f68d54dcb58d46affce4cb4802ac2e61d1ab8ec486a6ee202478. Compared to full-check
candidate A, all production, test and generated files are byte-identical. Changes
are docs/guides and semantically identical example formatting. Offline install and
build passed; final guidance (2 tests) and executable examples/creative guidance
(8 tests) passed, zero fail/skip. Exact file deltas and log hashes are in the machine
evidence. Subsequent documentation edits only record these verification results.
