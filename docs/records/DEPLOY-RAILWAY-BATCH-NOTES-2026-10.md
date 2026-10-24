---
status: record
tier: operator
---

# Deployment guide notes of the October 2026 deliveries

A dated record (DOC-03): the sections the [deployment guide](../DEPLOY-RAILWAY.md) collected from the October 2026 delivery batches 174 to 185, from the public release identity to the public payload diagnosis, moved here on 2026-10-24 and kept as written.

## Public packaged release identity — batch 174

GET /versionz adds an independent application-artifact observation beside the original /healthz.
npm run build writes a bounded atomic public build record after compilation. The build-stage
ARG RAILWAY_GIT_COMMIT_SHA allows Railway's exact triggering commit claim to be retained;
absent/invalid values are null. No deployment/source/CI-gating setting is changed here.
After deployment, compare the reported source claim with the expected Work-here tip and compare
its measured digest/component counts with a separately qualified packaged build. Matching
selected bytes return 200; mismatch/unavailable returns 503 with bounded public metadata.
The scan-start observation is cached for ten seconds, and hashing runs in a coalesced, bounded,
credential-free worker. This covers the fixed application artifact scope, excluding private
state, dependencies, entrypoint/OS binaries and image/provenance. It is unsigned, and a matching
response does not certify source authenticity, atomic snapshot consistency or provider execution.
Keep Railway healthcheckPath at /healthz. See [scope, checks and remaining evidence](DELIVERY-2026-10-05-RELEASE-IDENTITY.md).
Identity schema 2 (QA-01) adds `package-lock.json` as a component (the image copies the committed lockfile) and
hashes compiled tests as their own `dist/tests` component, so a test-only change leaves the runtime `dist` component
equal; schema 1 records stay readable but never match a schema 2 runtime. `/versionz` also reports `toolchain` (Node
version, first FFmpeg version line, OS ID and version, each strictly validated or `unavailable`) and
`public_asset_version`. Compare a deployment with a local qualification record using
`npm run check:public-website -- --origin https://amcp.shop --expect-record <record.json>` ([operations](../operations/QUALIFICATION.md#qualification-records)).
Railway project/service/branch, exact deployed backend/image and the earlier Arabic gap remain
unverified; a missing route or record alone does not explain a deployment failure.

## Wrapper Arabic source and public observation — batch 175

The current Arabic catalog has 8,056 entries, 1,253,212 UTF-8 bytes. The source locale gate,
browser catalog transport and explicit public Arabic comparison share a 2,097,152-byte ceiling.
The public command still reads only /healthz, /about and /assets/locales/ar.json and does not
identify deployed backend/image from static bytes. On 5 October at 16:47:09.206Z, one bounded
credential-free normal-TLS GET /versionz returned 404; its body was not read. This establishes
only route unavailability at that observation, not a deployment cause or Git/image identity.
The Railway project/service/environment and recent deployment evidence remain unavailable
through the current tools. Hosted Actions remain owner-waived; local release gates remain
mandatory. See [local ownership/loading qualification](DELIVERY-2026-10-05-BACKEND-WRAPPER-LOCALIZATION.md).

## Interpreting public liveness

The optional three-resource public comparison accepts HTTP 200 plus the application's
up/degraded state. It records only reported_liveness, not returned version/check/body fields.
Missing, malformed or other states refuse with PUBLIC_LIVENESS_STATE_INVALID. Degraded is
liveness, not complete readiness. The original health route/HTTP behavior, fixed GET routes,
credential omission, redirect refusal and raw About/Arabic comparisons remain unchanged.
See [local state regressions](DELIVERY-2026-10-05-LIVENESS-PLANNING-PREREQUISITES.md).
A successful bounded public comparison does not establish deployed Git/image or native
provider/program acceptance. The owner waived hosted Actions; fresh complete local
build/report/freshness/default-full/required-FFmpeg and clean-source checks continue.

## Batch 178 — local selected accessibility guard

The selected browser accessibility engine is an optional hash-pinned local test asset. It adds
no application dependency or Railway download. The original Docker/health configuration stays
exact. Fresh sanitized build/report/freshness, complete default required-FFmpeg suites and
exact clean-source parity remain the push gate; owner-waived Actions are not started or polled.
The browser run with the optional engine qualifies only its owned local Chromium views.
Deployed source/image, Railway branch/settings and live acceptance remain separate.
Working-source full/report and focused changed-state checks pass; exact clean committed full/browser checks remain the sole push gate.

## Batch 179 — original campaign/hour/day evidence

The separate Google hourly preset preserves original hour 0–23/date/account timezone and full
campaign resources, with explicit zero, complete-count/page/source checks and no inferred
missing-hour activity or UTC/DST conversion. Retained search preserves full totals and every-row
EN/AR Excel delivery. The hourly grain cannot qualify schedule, bid, budget or exclusion changes.
The current-parent prototype passes 82 focused tests and 24 actual served EN/AR capture/current-
error/stale-response journeys; all 576 original workbook rows and preceding 8,057 Arabic values
remain. Nine new messages are authored. The maintained runner retains all 408 old cases and adds
24 hourly cases, totaling 432 with 864 initial/final semantic and optional selected-rule snapshots.
Fresh sanitized full/report and exact clean-head/browser gates still qualify the integrated
source before its sole push; prototype passes cannot stand in for those checks. B18/B27/B15/
B16/B24 remained partial and hosted Actions unused ([package status](../review/PACKAGE-STATUS.md) is current). See
[scope, primary research and checks](DELIVERY-2026-10-06-GOOGLE-HOUR-EVIDENCE.md).

## Batch 180 — other listed X products with explicit retention

An opt-in read-only inspection extends the existing complete bounded X catalog comparison,
retaining exact native IDs, supported price strings, original group evidence and source lineage.
Two full scans must agree on every displayed supported observation; malformed policy, unsupported
destination and other workspace actions refuse before reads/artifacts. The local searchable
fifty-row-page EN/AR view keeps other listed products retained and outside drafts/removals.
Full-store absence, complete variants and point-in-time reconciliation remain unverified.
The isolated formatted-source prototype passes 75 focused checks and 24 served browser cases
with 400 synthetic GETs, 2,904 original other-product observations, zero mutations/egress,
48 semantic/pinned selected-rule snapshots and all manual evidence retained. All 8,066 earlier
Arabic values remain; 25 are added. Fresh integrated full/report/source/browser gates follow.
B21/B15/B16/B24 remained partial and Actions unused ([package status](../review/PACKAGE-STATUS.md) is current).
See [contract, workflow and qualification](DELIVERY-2026-10-06-X-CATALOG-SELECTION-INVENTORY.md).

## Batches 182/183 — inventory and bounded worker observations

The new published WooCommerce inventory mode makes fixed authenticated reads only and retains
absent products. Owner health/support return bounded, sanitized shared process observations;
Settings explain those limits separately from queue and provider delivery. Neither feature changes
Docker configuration, account grants, worker concurrency or provider mutation authority.
Fresh sanitized build/report/freshness, default full required-FFmpeg checks and exact clean-source
verification precede the sole Work-here push. Hosted Actions remain owner-waived. The expanded
maintained browser runner contains 488 cases, retaining all previous journeys and adding eight
worker-health cases. Earlier prototype/working-source passes do not establish this final run,
deployed source/image or live store/client eligibility.
[Inventory qualification](DELIVERY-2026-10-06-WOOCOMMERCE-INVENTORY.md),
[worker health and concurrent client qualification](DELIVERY-2026-10-06-WORKER-HEALTH.md).

## Batch 184 — administrator commerce connections and final browser gates

WooCommerce source setup requires configured encryption before any credential-bearing request.
Only current workspace administrators can submit it; the source grants read access and generic
write controls refuse it. Local removal performs no provider request. Hosted Actions stay waived.
The maintained browser now has 512 cases. Previous 487/488 browser and 4,849/4,851 main-suite
results are retained failures; corrected current-source full checks, report freshness and exact
source verification must pass before publication. The Windows Railway configuration check does
not establish a Linux image build or the currently deployed revision.
[Workflow, corrections and acceptance boundaries](DELIVERY-2026-10-06-WOOCOMMERCE-CONNECTIONS.md).

## Batch 185 — public payload and intermediary diagnosis

The public version endpoint can distinguish the build's Git claim from its independently measured
packaged runtime digest. The October 6 pre-push observation identifies f14305d, with matching
build/runtime payloads. Raw About bytes can differ solely because Cloudflare injects its analytics
script. The maintained checker explains a strict known insertion while preserving the failed raw
byte result and every original hash. This does not establish dashboard settings or change CSP.
No Docker/Podman/Linux runtime or functioning browser-control session is available on this host.
Fresh final-source checks and a post-push public revision/payload read remain required; hosted
Actions stay unused. [Actual observations and limits](DELIVERY-2026-10-06-RELEASE-ACCEPTANCE.md).
