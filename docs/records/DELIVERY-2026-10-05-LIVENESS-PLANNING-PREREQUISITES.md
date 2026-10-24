---
status: record
tier: engineering
---

# Public liveness and LinkedIn forecast prerequisites — 5 October 2026

Repository: magdyezy1/CAMCP. Sole working/push branch: Work-here.
Workspace: CAMCP-Codes-final-branch. Baseline: 1dbce476015e54f982b44fd7164732e7cf36d36b.
Batches 176/177 address F-254/F-255 together. B08/B13/B26 remain partial and B25
remains open; the complete matrix stays 13 implemented / 14 partial / one open.
Hosted GitHub Actions remain owner-waived; local release gates remain mandatory.

## Public liveness reflects the declared state

The optional public comparison previously accepted any JSON object returned with HTTP 200
on /healthz. An actual owned-loopback probe returned {"status":"unavailable"}, yet the
three-resource comparison passed. The tool now accepts only the existing application's
up or degraded state after its original JSON-object check. It records only the fixed
reported_liveness value and refuses missing, malformed or other states with
PUBLIC_LIVENESS_STATE_INVALID. A degraded result is liveness, not complete readiness.
The HTTP app and its status/check/HTTP behavior are unchanged.

Every preceding public comparison assertion remains exact. The tool still makes only its
original three explicit credential-free GET requests, refuses redirects, observes the
original timeouts and byte ceilings, and compares actual About/Arabic bytes without
normalizing an inserted script. It does not return version/check/body/private diagnostic
fields, infer deployed backend or image identity, or run automatically in npm check.
Ten additional actual loopback cases cover up/degraded and eight refused HTTP-200 states,
with body-private canaries, fixed output and continued comparison of both static files.
The retained pre-fix prototype had 10/20 passes; the qualified isolated prototype has
20/20 passes with no failures/skips. These are owned-loopback observations, not production
liveness or Railway acceptance.

## Forecasts require an included geographic bound

The original Media Planning preflight checked only the outer targetingCriteria shape.
Six retained synthetic-service probes dispatched forecasts with empty, absent, excluded-only,
empty-array, non-string or wrong-entity included geography. Those inputs are now refused
before transport. Forecasts require an include.and clause with a non-empty or object whose
facets are locations or profileLocations and whose values are known native geographic
URN forms. A geographic-only disjunction ensures the required AND clause actually limits
location; a skills alternative in that same disjunction would remove that guarantee.
This conservative Boolean restriction is AMCP policy, not an extra restriction claimed
from LinkedIn. Other native facet semantics and live audience eligibility remain the
provider's responsibility.

The [official Media Planning reference](https://learn.microsoft.com/en-us/linkedin/marketing/media-planning/media-planning-api)
requires geographic criteria and a sufficiently large audience. The [targeting-facet reference](https://learn.microsoft.com/en-us/linkedin/shared/references/v2/ads/targeting-criteria-facet-urns?view=li-lms-2026-09)
distinguishes locations from profileLocations. References were rechecked on 5 October 2026.
The local guard cannot verify the provider's minimum audience of 300 or app/account
eligibility. It does not claim to calibrate a forecast or make estimates guaranteed.

Only the forecast call enables this prerequisite; the original Audience Insights input
scope stays unchanged. All three existing forecast actions retain the same read-only POST
route, account, request fields, currency/date/budget checks, authorization and notices.
No scope, write approval or persisted media-plan operation is added. The native request
is neither rewritten nor inferred. The new reason has one manually authored Arabic pair
that preserves targetingCriteria, locations, profileLocations and Media Planning; every
preceding 8,056 key/value pair remains exact. The catalog has 8,057 entries. The maintained
owned-wrapper inventory gains only that reason, 2,624 to 2,625; all preceding selectors
and native formatter assertions remain.

Ten appended production-service cases preserve all four preceding planning tests. They
exercise six invalid prerequisites, both geographic facets across five existing native
URN forms and all three forecast actions (30 exact synthetic native payloads), mixed-OR
refusal, and unchanged Audience Insights without a geographic prerequisite. The earlier
ignored prototype passes 14/14 without failures/skips, but used a type-stripped preflight
wrapper. Fresh production tsc/service/full qualification below is required; that prototype
alone is not represented as integrated or provider acceptance.

## Private programs remain distinct

Forecast estimates on /rest/mediaPlanning create and save nothing. [Persisted Media Plans](https://learn.microsoft.com/en-us/linkedin/marketing/media-planning/media-plan?view=li-lms-2026-08)
use /rest/mediaPlans and the separately approved rw_media_plans permission. [Streaming
and predictive matched audiences](https://learn.microsoft.com/en-us/linkedin/marketing/matched-audiences/matched-audiences)
require their own approved product and rw_dmp_segments. Existing withheld writes stay
withheld; ordinary Ads authorization is not presented as these program grants. Their
current contracts, customer entitlement and separately allowed account acceptance must
all be qualified before expanding B25. No new OAuth consent or live mutation occurs.

## Qualification and preservation

Working-source checks pass; exact clean committed source/full/browser checks remain the sole push gate.
The full rendered browser run is selected once at the final clean committed source, after
the working-source service/unit gates. Its original observations are not relabelled from
a preceding revision; no pre-commit source is represented as clean-head browser evidence.
The original 408 browser journeys, 816 semantic snapshots, native read counts, manual-only
recovery and zero provider egress/writes remain mandatory. Complete fresh sanitized
install/build/report/freshness/default-full/Railway gates run with required FFmpeg, zero
skips and original concurrency. Source manifests include only public files plus the literal
empty generated sample. All three tracked reports must match the exact generated bytes.
Commit/push allowlists and exact clean-head source/browser proof gate the sole Work-here push.

Actual deployed Git/image, Railway service/branch/Wait-for-CI settings, Linux Docker,
provider/program grants, full Arabic editorial/visual/physical assistive acceptance and
broader remaining plan work are distinct evidence states. The previously observed missing
public /versionz and older Arabic bytes are not retested without actionable deployment
information and are not attributed to a deployment layer from static observations.

## Complete working-source qualification

All six fresh sanitized install/build/report/freshness/default-full/Railway stages pass.
Main 4,659/4,659/0/0 in 126864.2962 ms; capture 4/4/0/0 in 83.366 ms.
Required FFmpeg runs with unchanged default concurrency and zero skips. The exact public
candidate has 1,861 source files and one literal empty generated sample; digest
2a86d3ae32673257cbc2e18bc3d299541c86a2f2916befa756040e30b39e38f5. All three tracked reports regenerate identically.
The actual integrated focused run has 59/59 passes, zero failures/skips, including the
production-service geography prerequisite and 30 unchanged synthetic native forecast payloads.
Arabic covers 7,891 selected reasons with zero gaps, 8,057 entries / 1253491 UTF-8 bytes.

Preservation verifies 1844 preceding public files, including 426 unchanged backend TypeScript
files, 53 unchanged website files and 666 unchanged prior test files. Both original public and
planning test sources are byte-exact prefixes of their extended files. Only the exact new
reason/catalog inventory counts change in preceding locale tests; all 8,056 previous values
and native routes/actions/accounts/authorization/notices remain. The runtime health endpoint
and all browser runner, fixture, helper, manual recovery and native assertions remain exact.

Actual independently compiled working/sanitized selected payloads match both build records:
1,332 files / 52026624 bytes, SHA-256 ac4d85aa0bf57ae52ff048c98cd9a173aff58f35da4d29d1bd4b3cb5f6fb3111.
Workers complete in 656.4527 / 284.6885 ms.
This is selected Windows application-file evidence, not a Linux Docker/image/source-authenticity claim.
One fresh complete 408-case browser run is required at the final clean committed source.
Every preceding journey, 816 semantic snapshots and zero provider egress/writes remain
mandatory. A preceding browser result does not qualify the changed catalog and is not relabelled.
Fresh exact committed-source full/parity/browser checks gate the sole Work-here push.
Hosted Actions are neither started nor polled. Wider deployment, provider/program, physical
assistive, Arabic and whole-plan acceptance remain separate; counts stay 13/14/1.
