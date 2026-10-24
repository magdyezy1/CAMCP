---
status: record
tier: engineering
---

# Packaged application release identity — 5 October 2026

Repository: magdyezy1/CAMCP. Sole working/push branch: Work-here.
Workspace: CAMCP-Codes-final-branch. Baseline: b2d55815511c2eef4d58b713fe058c1b23b57893.
Batch 174 addresses F-250/F-251. B13/B16 remain partial; the 28-package plan stays
13 implemented / 14 partial / one open. Hosted Actions remain explicitly owner-waived.

## Liveness cannot identify a release

The existing /healthz answers database/disk/offline MCP liveness, with an intentionally
fixed product version. A 200 response does not identify the backend's Git revision or its
packaged files. Public About/Arabic comparisons also cannot identify a backend image.
The new public GET /versionz separately returns a validated build summary and independently
measured application artifact summary. Matching scoped bytes return 200/matches_build;
changed artifacts return 503/payload_mismatch. Missing, malformed, linked, oversized or
otherwise unverifiable input returns 503/unavailable with one fixed diagnostic code.
The original health route, Railway probe host exemption, MCP host/auth/origin/body limits,
website routing, native operations and existing HTTP diagnostics remain intact.

npm run build compiles first, then atomically writes dist/release-identity.json. Railway's
RAILWAY_GIT_COMMIT_SHA is declared as ARG in the Docker build stage before npm run check.
Only an exact 40-hex value is retained, normalized to lowercase; absent/invalid claims are
null. This is a build-supplied source claim, not independent Git or image verification.
No revision is invented from private state, and arbitrary environment text is never emitted.
No dependency or runtime deployment setting is changed.

## Explicit measured scope

The digest includes every regular file in dist, generated, .mirror/VENDOR, web and
Skills/amcp-campaign-builder, plus package.json and docs/REPORTING-OVERVIEW.md. This includes
the entire Docker-copied dist tree, including compiled generated/tests/tools files. It
excludes its own identity record to avoid a circular hash. Sorted relative file paths and
SHA-256 digests are domain-separated into an aggregate and seven component summaries.
Only fixed component names, counts, byte totals and hashes are returned; no individual
file paths, bodies, environment, tenant/account/provider IDs, SQL data or credentials.
Private state, node_modules, entrypoint/OS binaries and Docker image/provenance are outside
this application scope. This unsigned record cannot establish authenticity if an actor
changes both artifacts and metadata, and it does not certify a coherent atomic filesystem
snapshot, provider eligibility, campaign execution, physical accessibility or tenant capacity.

Each scope root and ancestor is inspected without following symbolic links/junctions.
Only regular files/directories are accepted. Limits are 10,000 files, 256 MiB per file and
1 GiB aggregate. Streaming uses a 1 MiB buffer; descriptor identity, size and modification
metadata are checked around reads. The record reader is limited to 8 KiB and validates exact
keys, fixed component membership/order, lowercase hashes, source claims and reconciled counts.
Semantically reordered object fields remain valid; component values are compared directly.
An actual false mismatch from JSON serialization order was found and corrected before release,
with the failing evidence retained. Altered component values still refuse a matching status.

## Responsive, bounded verification

Runtime hashing runs in one worker with no inherited environment or Node preload arguments,
fixed script/root selection, bounded engine memory settings and a ten-second deadline.
Concurrent requests share a refresh; each receives an independent public response copy.
The observation is cached for ten seconds, including its scan-start timestamp. A backwards
clock refreshes it; invalid clocks produce only fixed unavailable metadata. Worker errors,
invalid/private messages, non-null runtime source claims and premature exit return no arbitrary
error text. The worker is terminated before the result resolves, including timeout paths.
These bounds do not guarantee whole-process memory limits or atomic simultaneous file observation.
The HTTP route follows existing Host validation and security/no-store headers. Request query,
body, cookie, credentials or Origin never select its artifact root or worker.

## Meaningful applied checks and preserved evidence

The initial ignored library/status/HTTP prototype passes 16 checks. The worker prototype
passes 21 checks, including a real hung worker, main event loop progress, concurrent refresh
selection, no inherited environment/preloads, private failures and premature exit. The original
wire Host fixture was corrected because Node Fetch replaces that header; the real HTTP client
now verifies the existing 403 boundary. Its first rejected fixture remains retained. A draft
async clock rewrite was corrected to the documented synchronous clock contract; its rejection
is retained. Strict TypeScript rejected an indexed path value; entry iteration corrected it
without weakening compiler settings.

Applied build and website gates pass. New tests plus original HTTP, backend locale and website
diagnostic regressions pass 40/40/0/0 in 2968.2121 ms. This covers deterministic actual build
regeneration/CLI, live and broken metadata link refusal without external writes, incomplete
scope retaining the preceding record, actual Docker ARG/build ordering, mutation detection,
bounded metadata, scoped privacy, host/health/auth behavior and JSON field-order semantics.
The old backend inventory assertion advances only from 424 to 427 for the three new sources;
all 1,288 owned reasons in 173 files, 5,460 catalog entries and 5,294 required translations
remain exact. Every other preceding test assertion and all website/browser/locale/native
source bytes remain unchanged. Full source preservation and fresh release checks follow.

Complete working-source release-identity gates pass; exact committed-source full/browser checks gate the sole push.

## Operation and remaining acceptance

After a fresh deployment built from this source, inspect https://amcp.shop/versionz. Check
status and observation time, then compare the selected artifact digest/component summaries
with a separately qualified build's record. Compare build.source_revision with the actual
expected Work-here tip; a null claim means unknown. runtime.source_revision is always null
because filesystem bytes do not independently establish a Git revision. A 404, missing or
unverifiable record is diagnostic evidence, not proof of a crash cause or source branch.
Keep /healthz as Railway's liveness check; /versionz availability must not replace it.

Existing public Arabic observations matched older bytes; a measured About insertion alone
was not changed page source. Railway project/service/environment, source/CI-gating settings,
exact deployed backend/image and the cause of that gap remain unverified pending owner context.
This scoped endpoint improves the evidence available after deployment; it does not close that
gap locally. Wrapper/dynamic Arabic, broader live provider/program acceptance, full accessibility,
Linux Docker behavior and real tenant capacity remain separate. No hosted workflows, live
advertising/settings/OAuth writes or new provider calls are performed for this batch.

Primary references: [Railway Docker build variables](https://docs.railway.com/builds/dockerfiles),
[Railway reference variables](https://docs.railway.com/variables/reference),
[Node worker lifecycle](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html), and
[Docker provenance scope](https://docs.docker.com/build/metadata/attestations/slsa-provenance).


## Complete working-source qualification

All six fresh sanitized install/build/report/freshness/default-full/Railway stages pass.
Main 4,604/4,604/0/0 in 147903.9158 ms; capture 4/4/0/0 in 83.32 ms.
Required FFmpeg runs at default concurrency with zero skips. The candidate contains 1,857 public
files and one literal empty generated sample; digest edfbcfdf72da503b440efc9249a160477751f9b21670f522da563a9dfc630e8a.
All three tracked reports regenerate identically; no report byte change is staged.

All 408 working-source journeys pass from 2026-10-05T15:03:12.969Z to 2026-10-05T15:28:46.750Z.
All 816 initial/completed semantic snapshots pass: 26951 selected exposed controls/dialogs
have names, with zero missing ARIA references or duplicate IDs. All 408 initial views expose the
original main/heading pair. Website digest 97ecc8917e16e32b8bc4fe6fbb7b0b1624562a9b4f0d9f47407309c0fcb906be.
Every earlier case identity, 1,368 workbook rows, 360 scoped controls, 160 fields, eight About views
and capture/provider/measurement/permission/form/metadata/navigation/inventory assertion remains,
including all 48 manual-only inventory recovery cases. Provider egress/writes remain zero.

Preservation verifies 1,213 prior public sources, including 424 prior backend files, all 54 website
files and 662 unaffected preceding tests. All 21 previous HTTP setup statements remain exact;
one import, one trusted option and two setup statements add the separate identity route.
Only the exact preceding backend file count advances 424 to 427. All native/Arabic/locale/browser
assertions, the complete 5,460-value catalog and three tracked reports remain unchanged.

The actual working and independently compiled sanitized application payloads both match their
build records: 1,332 files / 51,603,862 bytes, SHA-256 6f7496703543f45f415716910af7abf026629fa455f98ac1789b7dd57e693a7c.
Observed worker verification takes 515.5099 ms and 424.5648 ms respectively.
These are Windows scoped-file observations, not Linux Docker/image/source-authenticity acceptance.
Fresh exact committed-source full/browser checks qualify the sole Work-here push. Hosted workflows
are neither started nor polled. Railway/backend/image/live/program acceptance, physical assistive
acceptance, broader Arabic and whole-plan work remain separate. Counts stay 13/14/1.
