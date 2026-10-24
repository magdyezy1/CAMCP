---
status: record
tier: engineering
---

# Google shareable previews — implementation evidence

Status: implementation and full sanitized validation complete: 1520 main and four
capture tests passed with zero failures/skips and AMCP_REQUIRE_FFMPEG=true. This is a bounded new family, not completion of
all provider actions or live qualification.

Base: Codex-branch at 92b53b082f19ea24cc30390d743b45a12e6d660a, remote
https://github.com/magdyezy1/AMCP.git. Work is confined to the implementation
checkout; neither the parent development tree nor historical release checkout
is modified. Node 24.19.0, npm 11.17.0, Windows PowerShell.

## Confirmed gaps and corrections

1. Both native and legacy GenerateShareablePreviews failed with
   WRITE_CONTRACT_UNAVAILABLE. The two original positive tests failed before
   implementation. They now use the same explicit reviewed contract.
2. ScopeGuard treated `customers/123:generateShareablePreviews` as customer
   `123:generateShareablePreviews`. The first implementation run exposed
   ACCOUNT_SCOPE_MISMATCH. The resource scanner now recognizes the colon
   delimiter. Foreign customers, including another customer later in a malformed
   path, still fail. This is a correctness defect, not an authorization relaxation.

The intended workflow is inspect → prepare → inspect source identities/sharing
impact → execute the frozen review → open a generated link → verify or recover
the original receipt. This does not publish, activate, edit or message anyone.
Creation of a shareable capability is intentionally reviewed even though the
captured catalog labelled the RPC read-only.

## Implementation and limits

`src/google-preview-writes.ts` validates the pinned v23 native fields and oneofs,
1–25 distinct source IDs, selected customer, scopes, source/parent identities,
current statuses and eligible format categories. Native format acceptance remains
Google's decision, recorded per item. Search/Display previews are not supported.
The route, review, spending, transport and verification gates are reused.

Before preparation and execution, native GAQL queries read the selected sources
twice with complete bounded pagination. Limits: 25 pages per query, 100 logical
reads and 8 MiB total, checked against a 60-second monotonic elapsed bound. A
transport attempt still has the existing transport timeout; this bound is checked
before and after each response, not a hard cancellation of all retries at 60s.
Failed, empty, missing, repeated, foreign or inconsistent source data cannot become
a successful baseline. Row ordering and per-query telemetry are not configuration.
Destination values are hashed exactly and displayed with token/signature redaction
so secret-only changes still invalidate a review without storing the secret.

The reviewed projection is source identity, name, status, parent/channel and URL
configuration. It is **not a frozen rendering** of inherited assets, feeds or
creative content. This contract authorizes generating a preview; it does not
approve creative content or serving changes. Native UI preview URLs cannot be
embedded in iframes. Verification checks the original validated receipt and fresh
source configuration; it never fetches the URL or claims rendering/approval.

Per-item HTTP 200 failures produce an unsuccessful/partial retained outcome.
Only validated successful target links are returned in `previews.results`.
Unexpected/malformed native output is hashed and withheld from ordinary receipts;
the raw response is encrypted for recovery. Accepted hosts: ads.google.com, plus
youtube.com/www.youtube.com/tv.youtube.com for YouTube mode. New hosts require
qualification. Expiration is checked when returned; absent expiry stays unknown.

`Store.savePreviewReceipt/previewReceipt` use the existing encrypted document
mechanism and master key, with tenant/review binding and a 24-hour local retention
limit. Ordinary idempotency/audit records contain no links. Cleanup removes expired
private receipts while preserving submission claims. Replay checks the original
actor, account, current grant and scope, then decrypts the original links. It
does not regenerate. Provider/client lost responses, malformed/partial outcomes,
parallel executes and process restarts preserve the original claim. A revoked
grant during submission withholds links but does not overwrite a completed receipt
as uncertain. No SQL schema migration or runtime dependency was added.

## Evidence

Commands use synthetic accounts only. Logs under
`.runtime/contract-completion-20260924/` retain initial failures:

- `google-preview-baseline.log`: two failing prepare journeys, missing contract.
- `google-preview-build-first.log`: TypeScript narrowing error in the new module;
  corrected with an explicitly declared never-returning function.
- `google-preview-first.log`: root-customer RPC scope failure, then corrected.
- `google-preview-second.log`: both positive journeys pass.
- `google-preview-expanded.log`: 13 pass, two test-setup failures. The native
  tool schema rejects forged unsupported top-level controls before authorization;
  test fixtures now assert that behavior and the ordinary confirmation gate.
  Spending-policy setup now supplies its required confirmation. Assertions and
  production safeguards were not weakened.
- `google-preview-focused.log`: 50 pass across previews, generation, Google
  contracts, review state and write review.
- `google-preview-evidence-tests.log`: 24 pass including source-hashed protocol,
  account/role/scope/revocation, state conflicts, source bounds, partial failures,
  expiry, encrypted restart/replay and machine-checked guidance.
- `google-preview-delivery-tests.log`: final sanitized delivery/guide validation.

Regeneration: `npm.cmd run build`; `node dist/tools/generate-contracts.js`;
`node dist/tools/action-contracts.js`;
`node tools/google-preview-evidence.mjs --source-dir .runtime/contract-completion-20260924/google-previews --check`.
`tests/fixtures/google-preview-v23.json` pins seven protocol messages, oneofs,
route/scope and the native source SHA-256
ba404673ce08d4de5bf798e97351d1f474f776c976106df35551080755a8f4d3.
The artifact cross-checks those fields against pinned Discovery in the test suite.

Official sources accessed 2026-09-24:

- [v23 service](https://developers.google.com/google-ads/api/reference/rpc/v23/ShareablePreviewService),
  reference updated 2026-06-19; supported categories and iframe restriction.
- [Native v23 proto](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/services/shareable_preview_service.proto),
  downloaded successfully, exact native wire fields/route/scope and result oneofs.
- [Input](https://developers.google.com/google-ads/api/reference/rpc/v23/ShareablePreview),
  [result](https://developers.google.com/google-ads/api/reference/rpc/v23/ShareablePreviewResult),
  and [per-item envelope](https://developers.google.com/google-ads/api/reference/rpc/v23/ShareablePreviewOrError).
- [Asset-group fields](https://developers.google.com/google-ads/api/fields/v23/asset_group)
  and [ad-group-ad fields](https://developers.google.com/google-ads/api/fields/v23/ad_group_ad?authuser=3):
  selectable source URL/identity/status fields and attributed parent resources.

Direct HTTP downloads of the two field-reference HTML pages timed out; their
subsequent local parse failed because the files did not exist. Browser search
provided the official references. Some web cache opens also failed; the public
proto download succeeded. These are documentation-fetch failures, not live API
test results. No live credential, mutation, DNS or deployment change occurred.

## Rollout, rollback and remaining work

The full check succeeded in `.release/google-preview-20260924-a` (578 files),
source tree 309aae38f300dad026b7c202651faac837614eba93de0a77dcb8285a38418d68.
[Machine evidence](GOOGLE-PREVIEWS-VERIFICATION-2026-09-24.json) preserves exact
commands, log hashes, initial failures and final counts. Code, tests and guidance
were compared against the tested candidate before commit; later edits only record
this result. Linux/container and live qualification remain external steps. New reviews follow existing
five-minute expiry. The new encrypted document kind is additive; older binaries
will not decrypt these links and may leave their expired rows until newer cleanup
runs. Preserve complete/uncertain idempotency records during rollback. Never
regenerate previews merely because an older binary cannot display the receipt.

Inventory after this family: 3241 actions; 434 reviewed-family, 888 blocked writes,
88 unmapped, 25 unqualified reads, eight input-dependent and four retired/provider-
unsupported. Remaining CSV: 1013 rows. Native reads, local and media workflows
retain their previous counts. The count is coverage, not provider approval.
Next: TikTok/Snapchat asynchronous report/preview families and remaining Google
draft/experiment workflows, plus the broader R2–R12 handoff. Live link lifetime,
actual format eligibility, permissions, quotas, rendering and deployment still
need separately authorized provider/deployment qualification.
