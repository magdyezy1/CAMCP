---
status: record
tier: engineering
---

# X audience estimation and native Google action availability

This continuation follows commit `90d5682` on `Codex-branch`. The preceding
combined release candidate D passed 1899 main and four capture tests. This record
covers later changes; those earlier totals do not validate these new changes.

## Implemented

X v12 `POST /accounts/{account_id}/audience_estimate` now executes through its
canonical action and `ESTIMATE_AUDIENCE_SIZE` alias as an independently qualified
read. Previously it was classified as a write, refused in read-only deployments,
and its transport would form-encode a request that X documents as JSON. The new
contract uses JSON, correct OAuth 1.0a signing, an exact account/connection, and
current authorization before every attempt and after responses. It creates no
campaign, targeting criterion, review or spending reservation.

The contract accepts the 30 explicitly enumerated native targeting types. It
requires a primary criterion without inventing business intent, rejects duplicate
or contradictory criteria and arbitrary fields, and bounds input to 200 criteria,
128 KiB and 25 distinct private audience/campaign references. These are AMCP
bounds, not asserted provider maxima. APP_LIST/TAP exclusions and comparison
operators remain unsupported for this estimate contract. Private audiences must
be currently targetable through the selected account; shared access is distinct
from ownership. Campaign references receive exact native reads. Followers and
own-content engagement require current FULL promotable membership, with a
five-page/1000-row bound and exact string user IDs.

Only a scoped HTTP 200 native range with safe nonnegative integer min/max is
accepted. Zero survives unchanged. Missing, inverted, partial, HTTP-200-error and
wrong-account results cannot become a successful empty/zero estimate. Reference
reads and the estimate share a 60-second monotonic deadline and 2 MiB bound;
transient retries use existing provider coordination and recheck authorization.
Response metadata explains that potential audience ranges are non-additive and
do not promise delivery, conversions, spend, approval or live eligibility.

Google's historical `UPDATE_CUSTOMIZER_ATTRIBUTE` alias is now explicitly
`provider_unsupported`. The v23 operation union supports create/remove only;
the broad service comment and update-mask field did not establish an update
operation. The new response provides the official source and a reviewed
replacement workflow. It does not disable the native mutate route or its working
create/remove aliases. Inspect returns unsupported without a fabricated request;
prepare/execution fail before credentials or provider calls. No automatic
migration/deletion is attempted.

An automated test examines all 95 captured Google legacy MUTATE aliases against
their pinned native operation descriptors. The customizer update is the sole
absent verb found by that check. This is structural validation, not proof that the
other 94 actions have complete executable reviewed contracts.

## Evidence

- Public documentation checked 2026-09-25: [X campaign reference](https://docs.x.com/x-ads-api/campaign-management/reference.md),
  [X targeting semantics](https://docs.x.com/x-ads-api/campaign-management.md),
  [X audience reference](https://docs.x.com/x-ads-api/audiences/reference.md),
  and [Google v23 customizer service](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/services/customizer_attribute_service.proto).
- Four source hashes, native X request/response examples, criterion vocabulary and
  the Google operation union are pinned in
  `tests/fixtures/audience-availability-evidence.json`. Regenerate with
  `node tools/audience-availability-evidence.mjs --source-dir <public-source-dir>`;
  `--check` verifies the exact fixture. Source bytes are public documentation, not
  captured account responses. No credentials or live accounts were accessed.
- Baseline `audience-availability-baseline.log`: **0/3 passed**. It reproduces the
  X read misclassification and generic/incorrect Google availability inventory.
- Initial build failures (TypeScript control-flow narrowing) remain recorded.
  Initial lifecycle run: **1/3 passed**; the OAuth fixture had a wrong property
  name and unsupported alias inspection needed a structured response before
  native compilation. Both were corrected without dropping assertions.
- Expanded tests: **19/19 passed**. Final selected run:
  `node --test --test-concurrency=1 tests/x-audience-estimate.test.mjs tests/provider-unavailable-actions.test.mjs tests/guide-contract-examples.test.mjs dist/tests/google-legacy.test.js dist/tests/retired-provider-actions.test.js dist/tests/google-configuration-writes.test.js dist/tests/execution-risk.test.js dist/tests/scope.test.js dist/tests/transport.test.js dist/tests/x-report-jobs.test.js`
  — **135/135 passed**, zero skipped, 24010 ms. It covers native examples/signing,
  grant/login/actor races, retry boundaries, malformed responses, private references,
  safe integer identity, limits, existing Google configuration contracts and X jobs.
- Full check of a fresh sanitized release candidate is required before shipping
  this follow-on. Its exact results and staged-code comparison go in the adjacent
  verification JSON; the selected result alone is not a release pass.

Candidate E (`.release/continuation-20260925-e`, 639 files, manifest
`48a3ac743ea5cbe3fef2ef00c28fd7bf152d8631248549f1299b43ae789fc4cf`)
ran the required-FFmpeg full suite: **1920/1922 passed**, two failed, zero skipped,
471237 ms. The catalog-template fixture omitted this new read's required native
criteria; it now supplies a valid synthetic body only for that exact route while
preserving all 2208 path/method assertions. The alias regression expected the old
generic `blocked_write` status; it now expects the exact `provider_unsupported`
status, retaining all unrelated Meta negative cases. Both pass in the subsequent
39-test selection with backup recovery tests. E remains unchanged as failure
evidence. Later check stages did not run after its main-suite failure. A new
combined candidate must validate these changes and the backup recovery follow-on.

## Full qualification

Fresh combined candidate F (`.release/continuation-20260925-f`) passes the complete
required-FFmpeg check: **1936 main tests and four capture tests, zero failures or
skips**. All generation, vendor/WSDL/feed integrity, report, website, provider,
lifecycle and action-contract stages completed. Railway compatibility also passes.
Its 641-file manifest hash is
`311b632d9a69e1932d7455439b9859958a2d12c0d240b3ca5cbe240a4921e67e`;
584 staged code/test/guidance files match that tested candidate after LF normalization.
Exact commands, runtimes and initial/final hashed logs are in
[the verification record](AUDIENCE-BACKUP-VERIFICATION-2026-09-25.json).
This qualification includes backup recovery, but excludes the later LinkedIn
explicit-resume work. No Docker, deployment or live provider qualification is claimed.

## Compatibility and remaining work

No dependency, database migration, credential change or new service. Existing
X form-based writes and JSON cards retain their wire encodings. The exact estimate
route alone receives JSON and read classification. Existing Google create/remove
reviews retain their behavior. New explicit error classification is a visible
compatibility change for clients that parsed the old generic error code.

The unresolved action inventory decreases from 985 to **984**: one X action becomes
a qualified native read; the Google alias remains in the denominator as an
unsupported provider operation. This does not complete the other action families,
451 unmapped vendor methods, deployment/restore verification, LinkedIn explicit
media resume, dashboard async-report integration or the broader review backlog.
Provider access/approvals, actual targeting eligibility and live response behavior
still require separately authorized live verification. No live claims are made.
