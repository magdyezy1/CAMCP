---
status: record
tier: engineering
---

# Guided Snapchat website traffic and creative dependency reviews

Batch 122. Work-here only; sole remote magdyezy1/CAMCP. Baseline 00cbe27.

Campaigns and MCP now offer a ninth guided recipe: Snapchat website traffic using an existing WEB_VIEW creative.
The brief requires the exact login/account, currency, decimal daily budget, distinct country codes, a creative
UUID, an explicit false regulated-content declaration and an offset start timestamp. An optional end must follow
the start. Regulated content requires a tailored plan. The native minimum daily ad-squad budget is 5,000,000 micros;
budget compilation preserves exact decimal values and rejects overflow or unsupported precision.

The plan has three paused native steps: an AUCTION TRAFFIC campaign, a daily-budget AUTO_BID/SWIPES ad squad with
automatic placement, and a REMOTE_WEBPAGE ad. Existing media and the creative destination are retained. Verified
predecessor receipts provide parent IDs. Each resolved mutation uses the existing frozen review, required spending
confirmation, idempotency and exact read-back. Activation is separate. Automatic bidding provides no cost guarantee.
Snapchat GET omits placement_v2; the existing native review retains its explicit verification limitation.

## Confirmed findings and safeguards

**F-197, high, S, fixed:** native ad creation read its parent squad but did not independently read its existing
creative. A baseline synthetic transport accepted an unobserved foreign creative under an owned paused parent.
Native creative replacements similarly omitted the new dependency. Server-derived bounded unique creative reads
now require current selected-account ownership, explicit matching ad_account_id and exact IDs. The original
creative's content and destination enter the native review hash; changed content/ownership prevents submission.
Website references also recheck WEB_VIEW and credential-free HTTPS syntax at actual native review, including
creative replacements. Other ad formats retain their own provider acceptance requirements.

Campaign preflight reads the selected account's complete bounded creative collection before reading the exact
existing creative. An absent/foreign owner, incomplete collection, wrong website type or invalid destination stops
the plan before creating its hierarchy. Reference-bound future creative IDs remain deferred. The inspection retains
the original destination bytes and never fetches the landing page. Confirmed ownership/fields are separate from
advertising approval, public destination availability, optimization acceptance or live performance.

**F-198, low, S, fixed:** actual Arabic phone QA measured three narrow action columns (67.25–83.48 px wide), each
119.97 px high, inside a 238 px form. Phone actions now stack across 254 px at a 375 px viewport, with 44 px targets.
English/Arabic briefs and previews preserve native IDs, budget micros and schedule offsets. Known owner-policy
notices localize without changing spending approval. Saved guided context localizes while preserving the original
plan brief and source fields separately. Broader editorial and assistive acceptance remain separate work.

## Evidence

A fresh copy of the previously qualified public 00cbe27 sources, rebuilt with the pinned dependencies and new
regressions, produced 21 failures and 15 unchanged passing controls (36 total, zero skips). The native scope cases
reproduced the dependency gap independently of the new recipe. Runtime evidence is in
`.runtime/snapchat-traffic-recipe-20261003/`; the baseline copy is separate from the original qualified candidate.

The real MCP SDK validates advertised schemas, discovers the workflow, previews without native reads, inspects
current prerequisites, saves only an unapproved paused draft and rejects revoked access. Seven calls returned
25,063 structured bytes; three synthetic provider reads, zero
external provider requests and zero advertising mutations. Native tests separately verify all three paused steps,
idempotent completion, foreign refusals, mismatched ad read-back and non-replay of an accepted ad with a lost receipt.

Actual disposable browser QA used the shipped application with an in-memory database and fake transport. Keyboard
inspection/checks worked in English/Arabic; inspection saved no plan. Saving created one draft with three pending
steps and no provider mutation. Desktop and phone document widths match their client widths (1265/1265 at 1280 px;
360/360 at 375 px). Additional Arabic widths were measured at 320/425/590/850 px. Screenshots, original destination
evidence, request counts and measurements remain in the runtime directory. A final restart loaded the shipped saved
journal changes and verified localized context in both languages, a separately expandable unchanged original brief,
one draft and three pending steps. This inspection made zero provider reads or mutations. The temporary tab,
viewport override and owned fixture are closed. This is local synthetic UI acceptance.

## Release qualification

Final focused qualification passed 129 tests, zero failures/skips, in 30.017 seconds. Full-suite correction checks
passed 36 tests, zero failures/skips, in 1.726 seconds. Two older all-recipe fixtures now supply native Snapchat
inputs/owned creative responses, and a legacy creative PATCH fixture explicitly returns its selected account.
The missing Arabic discovery description is translated and its extracted module enters the message check.
All original authority and spending assertions remain intact. Nine executable guide checks passed, including the
new machine-checked synthetic Snapchat brief, in 4.638 seconds. Sanitized local build/report
generation updated implementation-status.json to 284 source modules and 434 documented native refusals. All three
tracked public report artifacts must match generation and remain byte-identical throughout qualification. The
checkout's private live-read sample is never used; release candidates contain one generated empty sample. Native
action and reviewed-family classification remain unchanged: 3,247 actions, 167 reviewed families, 1,712 read actions,
800 reviewed writes and 502 blocked writes.

Final sanitized preflight `.release/snapchat-traffic-preflight-verified-20261003` passed install/build/early report
freshness/full check/Railway, each exit zero. Suite: 3,903 total / 3,898 passed / zero failures / five expected local
FFmpeg skips in 101.794 seconds; four capture checks 86.143 ms. Browser checks cover 33 scripts / 3,012 selected
Arabic messages; the index contains 288 documents. All three tracked public report bytes remained unchanged.
The candidate contains 1,630 public sources plus one generated empty sample; source hash
613f72386822f7b1c439d97bce302b8db9e53cedf0e95f042b438bb9d37b37e0. This preflight excludes its own subsequently
recorded paragraphs. Exact committed-source qualification follows before the sole push. Each new revision
requires its own real FFmpeg/Docker CI; provider and Railway deployment acceptance remain unverified.

The broader implementation matrix remains 13 implemented / 14 partial / one open. This batch advances B08/B15/B17/B24;
it does not complete all objectives, providers, external creative usage, real commerce/measurement acceptance,
capacity qualification or full Arabic/assistive review.

## Primary contract references

Read 2026-10-03: [campaigns](https://developers.snap.com/marketing-api/Ads-API/campaigns),
[ad squads](https://developers.snap.com/marketing-api/Ads-API/ad-squads),
[ads](https://developers.snap.com/marketing-api/Ads-API/ads) and
[creatives](https://developers.snap.com/marketing-api/Ads-API/creatives).
These establish native shape and documented behavior, not this account's provider acceptance.
