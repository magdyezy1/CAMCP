# LinkedIn saved-audience template contracts — 2026-09-25

Base revision: `5ea83ed2b5eddda004e464625a28f82f502b517b`, isolated
`implementation-Codex-branch` checkout, branch `Codex-branch`.
The user requested finishing this in-progress batch and handing off; no further
provider family is started by this checkpoint. No live provider calls or changes,
credentials, permissions, production deployment, main-branch edits or force pushes.

## Implemented behavior

Four previously blocked captured routes now share `linkedin_audience_templates`:

| Operation | Captured action | Native request |
|---|---|---|
| Create | linkedin_rest_ad_target_templates_post | POST /rest/adTargetTemplates |
| Partial edit | linkedin_rest_ad_target_templates_template_id_post | POST /rest/adTargetTemplates/{template_id}, PARTIAL_UPDATE |
| Delete one | linkedin_rest_ad_target_templates_template_id_delete | DELETE /rest/adTargetTemplates/{template_id} |
| Delete batch | linkedin_rest_ad_target_templates_delete | DELETE /rest/adTargetTemplates?ids=List(...) |

`src/linkedin-audience-templates.ts` owns input, scope, dependency collection,
configuration projection, receipt and final-state contracts. Integration is through
the existing reviewed-route gate, ScopeGuard, write review/verifier, transport
deadline, impact report and action/provider descriptors. No database migration,
new service, generic route bypass or new live advertising permission is introduced.

Creation uses the selected account and native audience definition. An edit changes
only name, description or the complete targetingCriteria using patch.$set. Deletion
supports one or 1–25 exact IDs. The request and version remain frozen in the review.
Saving/deleting these reusable definitions does not alter a campaign's targeting,
activate delivery or spend money. Existing owner deletion policy still applies.

The selected account and complete sorted template collection are read twice before
preparation, execution and verification. Actual account identity and every template
owner are checked. Incoming private segment references are read by exact ID and
must belong explicitly to the selected account, have a compatible type, and be
READY or ARCHIVED. Missing ownership never becomes a persistent access grant.
The current actor, selected login, account/write grants and scopes are checked on
each request attempt and after return. No private audience member lists are read.

Native audit timestamps and approximateMemberCount do not participate in the
configuration comparison. Boolean AND groups and facet-value arrays are sets;
unknown arrays stay ordered and unknown fields/versionTag remain protected.
Changed-field diagnostics identify real configuration paths without exposing values.
Complete collection comparison deliberately includes sibling templates, so a
concurrent unrelated saved-template edit can require another unsubmitted review.

Creation accepts a native 201/empty body and a new numeric x-restli-id. Single edit
and delete require 204/empty body. Batch deletion requires exactly one 204 result
per requested ID and no native errors. Unknown/partial/lost outcomes retain the
original durable claim. Concurrent callers and SQLite reopen do not resend.
Accepted receipts persist even if a grant is withdrawn before delivery to the
caller. Final verification checks complete membership, requested values, untouched
siblings and account/segment dependencies. A receipt alone never grants ownership.
Verification is fresh rather than returning a recent cached success for this family.

## Bounds, compatibility and unresolved live evidence

AMCP bounds: 25 include groups, 100 values per facet, 500 values/64 KiB total,
25 private references, 25 deletes, 1000 templates, 20 pages per pass, 100 requests,
8 MiB aggregate state and 60 seconds under a monotonic deadline. Shared native
transport response bounds continue to apply. A full collection at capacity cannot
create an extra object it would be unable to verify.

Known REST.li paging start/count/links are required; optional totals reconcile with
actual membership. Zero-count empty terminal pages are valid. Unknown/contradictory
paging, missing rows, repeated IDs, errors inside 200, changed totals, foreign
resources or limit overruns stop the review. Provider paging URLs are never fetched;
the reader advances only the fixed account finder. Self/prev/next link relations are
recognized. Two equal complete reads reduce races but cannot eliminate external
edits between the last read and provider mutation; no provider conditional write
primitive is claimed.

Only documented native facets with qualified URN grammar are accepted. The saved
definition contract does not certify minimum audience size, combinations accepted
by every campaign objective, account role, app products, quota or current provider
approval. Shared/ownerless private segments, account transfers, nested partial
patches and unknown facets remain unqualified. Contact-versus-company matching
subtypes are not proven by the current segment read; matching-segment/behavior AND
combinations are conservatively rejected. This is an AMCP limit, not a statement
that every such combination is forbidden by the provider.

The pinned 202605 template page's simplified finder example omits paging metadata
and contains inconsistent owner IDs. The generic REST.li protocol establishes
paging shape; the live template finder must still be observed under authorized
read-only access. Missing paging is rejected rather than inferred complete. The
contract and all evidence remain **live-unverified**.

Existing contracts and public schemas retain their names. Old unsubmitted reviews
for these routes did not exist because the family was blocked. Rolling back the
additive family gates blocks new attempts but must retain completed/uncertain
review claims and receipts. Never clear idempotency or blindly resubmit during
rollback. Revert the matching guidance/descriptors/generated inventory with code.

## Evidence and qualification

The new module, service fixture/tests, examples and modified integration paths
were manually reviewed. Generated contract/coverage files were regenerated and
mechanically checked; this batch does not claim a new line-by-line audit of every
repository file. Published first-party documentation supplied contract evidence,
not proof of native account acceptance.

Thirty-nine new tests exercise all four operations through the service, exact wire
body/headers, Unicode and large IDs, state projection/conflicts, paging/limits,
private segments, scope withdrawal, original-login binding, frozen reviews,
confirmation/deletion policy, receipt failures, ignored/extra effects, concurrent
execution, SQLite reopen and executable guidance. Every provider response is a
synthetic fixture. Existing LinkedIn conversion/media/creative and shared review,
spend, transport and guidance tests supply compatibility coverage.

Initial results remain visible under `.runtime/contract-completion-20260924/`:

- `linkedin-templates-baseline.log`: both initial lifecycle tests failed with
  WRITE_CONTRACT_UNAVAILABLE against the pre-change implementation. The wrapper
  returned its trailing Get-Content status, not the test status; use the log's
  failing counts rather than treating that wrapper exit as a passing baseline.
- `linkedin-templates-build.log`: an initial TypeScript narrowing error for the
  batch result, corrected by retaining the narrowed response in a local variable.
- `linkedin-templates-core.log`: both core lifecycle tests passed.
- `linkedin-templates-adversarial-1.log`: 37/38 passed; the added empty-collection
  test found the zero-count pagination rejection. The parser was corrected;
  `linkedin-templates-adversarial-2.log` passed all 38 with no skipped tests.
- `linkedin-templates-focused-final.log`: 224/225 passed. The unchanged guidance
  completeness assertion found that the new family was missing from the central
  inspect-example index. The example was added; assertions were not weakened.
- `linkedin-templates-guidance-final.log`: all 47 affected tests passed, including
  all 39 template tests and the central guide family-completeness tests.

Fresh candidate `.release/continuation-20260925-j` passed `AMCP_REQUIRE_FFMPEG=true
npm.cmd run check`: **2052 main and four capture tests**, zero failures/skips;
main-test duration 453960 ms. Clean offline npm ci installed 107 packages; the
Railway Dockerfile compatibility check passed. The candidate has 662 files,
source-tree hash `9985375a9389fe3c59245c5e224aceb0853b368730c4683151f1fa774f5c867d`,
base revision `5ea83ed2b5eddda004e464625a28f82f502b517b`, Node 24.19.0/npm 11.17.0
on Windows and FFmpeg 9.0.2. The exact commands, log hashes, retained initial
failures and LF-normalized staged-source comparison are recorded in
[verification](LINKEDIN-TEMPLATES-VERIFICATION-2026-09-25.json).
All generation, schema, capture, report, web, provider-integrity/lifecycle and
contract/action checks completed. Native provider and deployed acceptance remain
unverified. Exact Linux/container CI for the new batch is a separate post-push gate;
older candidate I/CI results do not replace it.

Public source provenance lives in `tests/fixtures/linkedin-audience-template-evidence.json`.
Anonymous TLS-validated retrieval returned HTTP 200, 73,382 HTML bytes, SHA-256
`c1a08091359f0e08bdab66925d8f7c2533a87762296b75c470b66a2eb458a17f`.
No private responses or credentials were captured. Sources checked 2026-09-25:

- [Saved audience templates, version 202605](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/saved-audience-templates?view=li-lms-2026-05), updated 2026-06-24: native routes, request fields and receipts.
- [REST.li protocol](https://linkedin.github.io/rest.li/spec/protocol#collection-metadata): native collection metadata and batch protocol.
- [Targeting grammar](https://learn.microsoft.com/en-us/linkedin/shared/references/v2/ads/targeting-criteria?view=li-lms-2026-05): native Boolean structure.
- [Facet reference](https://learn.microsoft.com/en-us/linkedin/shared/references/v2/ads/targeting-criteria-facet-urns?view=li-lms-2026-05): native facet URNs and restrictions.
- [Ad segments](https://learn.microsoft.com/en-us/linkedin/marketing/matched-audiences/adsegments?view=li-lms-2026-05), updated 2026-08-17: account/type/readiness and approximate count distinction.

The regenerated captured inventory has 458 reviewed-family actions and **979
remaining rows**: 864 blocked writes, 79 unmapped, 23 unqualified reads, eight
input-dependent adapters and five provider-unsupported. The independent 451
unmapped methods in the 1208-method pinned-vendor inventory overlap and must not
be added to the captured count. Neither denominator covers every provider API.
