---
status: record
tier: engineering
---

# Measurement task navigation and preserved inspection state — 5 October 2026

Repository: magdyezy1/CAMCP. Sole working/push branch: Work-here.
Workspace: CAMCP-Codes-final-branch. Baseline: d21e303ba1c8b98d77e22ee6ba4dad9b1c4123cd.
Batch 167 addresses F-237 and F-238. B15/B16/B20/B24 remain partial; the whole-plan matrix remains
13 implemented / 14 partial / one open. Hosted Actions are waived by the owner.

## Observed reachability

Eight actual served, owned synthetic baseline pages have four stacked inspection forms and no
task-specific heading IDs or section links. LinkedIn settings begin at these document offsets:

| Width | English LinkedIn top | Arabic LinkedIn top |
| ----- | -------------------- | ------------------ |
| 320   | 3,505 px             | 3,879 px           |
| 375   | 3,238 px             | 3,656 px           |
| 768   | 2,754 px             | 3,179 px           |
| 1280  | 2,687 px             | 3,077 px           |

The measurement page is 3,963 px high in English and 4,346 px in Arabic at 320 px. This is an
observed local usability improvement, not a claim that the original page violates a WCAG criterion.
Baseline collection makes no provider request and saves no report, draft or review.

## Delivered flow

A uniquely named Measurement task navigation lists the four original inspections. Ordinary
activation focuses and scrolls to its heading while preserving the current document, URL,
history, all form entries, feedback and results. Every inspection has a return link to the task
heading. Existing reporting, profile-mapping and capability links remain available in a native
Related measurement workflows disclosure, closed initially to keep inspection choices prominent.

| Inspection | Exact fragment |
| ---------- | -------------- |
| Google Tag Manager configuration audit | #measurement-section-gtm |
| Recent GA4 events | #measurement-section-events |
| Inspect a specific GA4 test identifier | #measurement-section-identity |
| LinkedIn conversion settings | #measurement-section-conversions |
| Task choices | #measurement-task-heading |

Five exact known fragments receive initial heading focus after the original forms and handoff
selection are bound. Unknown/malformed fragments do not select a target. Original query validation
still decides whether an account/test/audit scope can be preselected. Query-only MCP handoffs are
unchanged; the task navigation is available on the resulting page. No provider read starts from a
fragment or task jump. Modified clicks retain normal browser behavior.

Captured navigation/identity generations and connected navigation/link/heading fences keep departed
callbacks from focusing another view. A changed href, another target/download intent, a prevented
event, a modified click or a different current target is not intercepted. Section changes do not
invalidate a pending original read or clear its valid result. Edits, current-account checks, original
native failure recovery and stale-response refusal retain their existing separate rules.

The four new Arabic messages are authored labels/help. All 4,090 previous catalog values remain;
the catalog reaches 4,094 entries and the required literal interface set reaches 3,886. Native IDs,
dates, protocol values, method/ownership codes, exact decimals and unknown measurement states retain
their original representation.

## Layout and research

The named links wrap within their container, retain at least 44 px interaction targets, and use
the current iris/paper identity. Scoped normal/hover colors keep label contrast above the unrounded
4.5:1 threshold. Focus rings are 3 px. The focused heading remains below a sticky/fixed mobile
header, with scoped scroll margins and no change to global scrolling or route behavior.

W3C describes in-page bypass links as useful structural navigation; its bypass-block criterion
does not require this extra mechanism on every individual page.
[W3C bypass-block explanation](https://www.w3.org/WAI/WCAG22/Understanding/bypass-blocks.html).
Different navigation landmarks should have distinct accessible names.
[W3C navigation landmark guidance](https://www.w3.org/WAI/ARIA/apg/patterns/landmarks/examples/navigation.html).
Normal and hover text retain the same readability threshold; resolved foreground/background
colors are measured rather than antialiased screenshot pixels.
[W3C minimum text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
These selected checks do not establish full WCAG or assistive-technology acceptance.

## Focused evidence and maintained browser expansion

Six new regressions exercise the actual controller with real synthetic native conversion reads:
both languages preserve pending/current results, local search and every form draft, with only the
original three native GETs. Other vectors exercise modifier/download/href/identity/view/detachment
fences, old callbacks after a new render, exact known fragments and original handoff selection.
All 77 focused navigation, original account-localization, metadata and shared-feedback cases pass
with zero failures, cancellations or skips in 1,341.2634 ms.

Sixteen new maintained served journeys extend all preceding 344 to 360:
eight local task journeys and eight exact-fragment handoffs, in English/Arabic at
320/375/768/1280 px. Each local journey preserves fifteen form fields through ten task jumps and
ten returns, including a held successful native response and its completed metadata search.
Only explicit original-scope submission makes three fixed synthetic GETs. Each linked journey
checks five exact known fragments and two ignored malformed/unknown fragments with zero reads.
The new helper is included in browser evidence by its own source hash.

The isolated final overlay preview passes all sixteen cases: eighty task jumps, eighty returns,
120 distinct retained form fields, forty valid fragment focuses, sixteen ignored fragments,
sixty-four normal/hover contrast checks and twenty-four synthetic GETs. No provider egress,
mutation, event sender, automatic read/retry, retained report, plan or review is introduced.
This preview does not replace complete maintained working and clean-HEAD release qualification.

## Rejected preliminary evidence

Preliminary preview failures remain in ignored local evidence. The harness first misidentified
the native summary role, included the sidebar in a disclosure-link count, omitted the original
API-version scope field and expected an object rather than the actual literal measurement state.
It also removed a still-running response interceptor too early, permitting a duplicate synthetic
backend read. The handler now finishes before interception is removed; the strict three-read
assertion remains. Functional checks initially missed the heading beneath the mobile header;
visual inspection exposed it, and final viewport/obstruction checks retain the corrected spacing.
Normal/hover label contrast receives separate checks before integration.

The first focused unit run timed out two new cases: a strict comparison of objects from different
JavaScript contexts failed before signaling its wait point. Exact serialized request comparison
now belongs inside the rejection bridge. The original 15-second timeout remains; the corrected
fresh run passes all 77 cases. These are rejected harness/draft records, not production provider
incidents, qualifying receipts or evidence of a native retry.

## Release boundaries

All original provider collectors, authorization, reviewed-write/receipt/idempotency, storage,
worker/lease, spending, catalog, reporting and MCP sources remain unchanged. Original measurement
submit and response logic remain separate from the new navigation helper. No global router,
grant, credential, external destination or deployment setting is edited.

A fresh sanitized candidate must run offline install, build, report regeneration, report freshness,
the default full suite with required FFmpeg and zero skips, and the Railway configuration check.
The complete 360-case working browser suite follows. Only after recording those measurements and
committing the exact source do a fresh committed candidate, complete full checks, exact Git-file
verification and clean-head 360-case browser proof qualify the sole guarded Work-here push.
Regenerated identical tracked reports remain unchanged; no private sample is copied into release
evidence. The tip carries the owner-directed skip-CI marker.

About Us remains implemented and its eight rendered cases remain in the complete selection.
Linux/Docker and deployed/live acceptance, other clients/browsers/physical devices, full Arabic
editorial/assistive acceptance, event-level consent/deduplication/attribution and broader provider
formats remain separate. No incomplete package is closed by this interface improvement.

## Deployment runbook alignment

F-238 also updates the README, Railway deployment guide and current completion walkthrough to
match the owner-waived hosted CI mode, with current primary Railway workflow-conclusion semantics.
The existing service must use the sole CAMCP/Work-here binding and release-appropriate gate;
Docker checks and exact committed local evidence remain required. No Railway setting is changed
or claimed verified and no actual crash cause is inferred. See the
[owner-waived CI instructions](../DEPLOY-RAILWAY.md#owner-waived-github-actions).

## Complete working-source qualification

All six fresh sanitized install/build/regenerated-report/freshness/default-full/Railway stages
pass. Main 4,513/4,513/0/0 in 137.572 seconds; capture 4/4/0/0 in
83.5309 ms. Required FFmpeg runs with zero skips at default concurrency.
The candidate contains 1,825 public files and one literal empty generated sample; digest
61c4829a91a3cd4e7c659db96fc23603a1231415cd49ca4f26c1d215af7f6431. All three tracked public reports regenerate identically.
This working candidate precedes final qualification notes and the deployment runbook correction;
the complete final committed candidate is assembled and requalified separately before pushing.
All 429 tracked backend/deployment files, 51 other website files, 60 other tools and 4,090 prior
Arabic pairs retain their Git bytes/values. Forty original controller functions and the original
GTM submit callback retain their exact source. Arabic is 3,886 required / 4,094 catalog.

All 360 actual served cases pass from 2026-10-05T06:13:56.653Z through 2026-10-05T06:33:44.704Z,
website digest ea139fa451bd43f8e35ad456430b30d9d2972204dd87900e46415a1ea79e4454. Every preceding 344 journey remains,
including all 1,368 workbook rows, 360 scoped controls, 160 labeled fields, eight About Us cases,
and original capture/provider/measurement/form/metadata current/obsolete/recovery assertions.
The sixteen new journeys preserve 120 distinct form fields through eighty task jumps and eighty
returns, check forty exact fragment focuses and sixteen ignored fragments, and retain sixty-four
normal/hover contrast checks. The eight local journeys use only twenty-four fixed synthetic GETs
from explicit original-scope submissions; navigation retains the pending response, completed
result and local metadata search. All other navigation/fragment journeys make no automatic read.
No external provider request, effect, retained report, plan, review or retry occurs.
Actual Arabic 320-pixel and English 1280-pixel navigation screenshots are visually inspected;
the separate maintained geometry assertions check focus clearance below the mobile header.
Selected synthetic/layout checks do not supply live, Linux/Docker, physical-device or full
Arabic editorial/assistive acceptance. Connected tool-help metadata exposes thirteen current
curated guides and the public reporting bootstrap schema only; no provider read, deployment
revision or account eligibility is attested by that metadata response.

F-238 aligns the deployment runbook with the owner-waived hosted CI mode. No Railway dashboard
setting is changed or claimed verified, and no actual deployment crash cause is inferred.
Rejected preliminary artifacts remain separate. Exact committed full/clean-head checks follow
before the sole guarded Work-here push. Hosted Actions remain waived; B15/B16/B20/B24 and the
13 implemented / 14 partial / one open whole-plan counts remain unchanged.

## Exact committed qualification and sole remote receipt

Code commit 49b6154769494bd9becbd84276ab69cb2c1f36e1; documentation tip 17477a8d492766788c0891c3439d75b932c6b80f.
Fresh Git-source proof verifies all 1,825 public files, one literal empty sample and three tracked
reports. Source digest 91964a3d41ef62ce8bc0cfdf1f5cb1410c638de2d934febcbb6027e8c68b1402; website digest ea139fa451bd43f8e35ad456430b30d9d2972204dd87900e46415a1ea79e4454.
All six fresh committed stages pass. Main 4,513/4,513/0/0 in 138.717 seconds; capture 4/4/0/0 in
72.5177 ms, required FFmpeg/default concurrency and zero skips. The complete clean-head browser
passes all 360 cases from 2026-10-05T06:40:39.325Z through 2026-10-05T07:00:19.306Z.
All preceding 344 and sixteen new navigation journeys retain the documented source/state/value,
reflow/contrast, retained-row/control/field/About and no-effect assertions. All three public reports
regenerate identically. The sole guarded Work-here push advances d21e303 to 17477a8; actual
remote tip is verified at 2026-10-05T07:04:20.321Z. The checkout is clean at that receipt.
Hosted Actions remain waived and unpolled; Linux/Docker/live/deployed/assistive acceptance and the
13 implemented / 14 partial / one open plan remain separate.
