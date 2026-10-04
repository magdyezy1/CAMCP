# Batch 132 — historical allocation calibration

Baseline `5195db3`. Sole checkout `CAMCP-Codes-final-branch`, repository `magdyezy1/CAMCP`, branch `Work-here`.
This advances B15/B16/B24/B26 with a read-only diagnostic and explicit website handoff. All accounts, records,
people, sessions and provider transports used for qualification are synthetic. No provider action, reviewed
family, OAuth scope, native permission or advertising mutation is introduced.

## Diagnose the assumptions before modeling

`amcp_reporting {action:"calibrate_allocation",id,ids,options}` evaluates an original retained guided daily
Google/Meta/LinkedIn campaign report or parent-bound Snapchat ad-squad report. Select 1–20 exact original IDs;
native strings, including large IDs and LinkedIn URNs, remain unchanged. It shares the allocation model's current
account access, complete source/grain/identity, currency, attribution, conversion-definition, closed account-
calendar period and freshness gates. LinkedIn retains its qualified UTC/account/request mapping; Snapchat
retains the original owned parent. A valid original source SHA-256 is required.

History must span 14–31 consecutive closed calendar days with an explicit known spend/conversion row for every
selected entity/day. Missing dates and null metrics are not zero-filled. Training windows contain 7–21 preceding
days, followed by at least seven test days. A test estimate uses only earlier training conversion/spend totals,
multiplied by the **actual held-out day's spend**. The held-out conversion count never fits its own estimate.
This conditions a retrospective diagnostic on known spend; it does not forecast future spend or delivery and
does not estimate the causal effect of changing a budget.

Every test date retains its training dates and exact totals, actual spend/conversions, conditional estimate,
observed-minus-estimated error and observed/estimated ratio. A selected minimum of 1–1,000,000 training
conversions defaults to ten. Insufficient training and zero estimates remain explicit unknown ratios, with
separate known-error/known-ratio counts. Positive conversions at zero spend can occur under delayed attribution;
the workflow does not silently invent a ratio. No test day is dropped from the displayed history.

MAE and mean error use exact rational arithmetic. The central share is explicitly chosen from 50/60/70/80/90%,
default 80%. Each entity's empirical nearest-rank boundaries use the corresponding lower/upper tail ranks.
The exact number of observed ratios inside the band remains visible; finite samples and ties can produce a
different observed share. This share is not a confidence level or future coverage guarantee. Bounds round
outward to six decimals; other metrics truncate at nine. The combined envelope uses the lowest entity low and
highest entity high, rather than blending campaigns or attribution models.

Factors are applicable only when every selected entity has at least seven known ratios, every test day's ratio
is known, and the outward-rounded factors fit the existing positive-through-ten allocation bounds. Zero/too-wide
factors remain inspectable and are not clipped. Thresholds and sample minima are explicit product/user choices,
not claims of statistical significance. The fingerprint binds the original report/scope/source/time, effective
choices and interpreted evidence; it is diagnostic provenance, not an approval or execution token.

## Website and MCP flow

The allocation panel adds an explicit historical evaluation button and original-source English/Arabic table.
It makes no automatic call on mount. Original native IDs, names and exact decimals remain escaped; unknown
provider diagnostics retain their original text. Seventeen selected first-party explanations/refusals and the
new controls gain 46 Arabic entries. The existing website script count remains 34.

Evaluation leaves factor inputs unchanged. **Use these historical factors** is a separate reversible action;
it invalidates the preceding model and its native draft callback. The historical result remains inspectable.
The operator must model again, then follow existing current native budget ownership, source binding, frozen
review, spending acknowledgement and receipt/read-back controls. Calibration creates no report, plan or saved
change. Models remain illustrative sensitivity proposals with explicitly chosen factors; applying history does
not upgrade them to statistically certified forecasts.

Changed selection, settings, evidence age, route, identity or detached source view fences pending results and
application callbacks. Repeated application is fenced. The MCP response supplies the original report website
link and inspect state, with no automatic application/mutation hint. Retained native rows/requests/private
fixture markers are not copied wholesale into this result.

## Research and qualification

Method checked 2026-10-04 against the authors' primary material:
[rolling-origin time-series evaluation](https://otexts.com/fpp3/tscv.html) and
[out-of-sample errors and MAE](https://otexts.com/fpp3/accuracy.html).
These support chronological evaluation and error interpretation; they do not establish an advertising budget
response, a universal minimum sample or confidence coverage for these empirical bands.

Two baseline regressions failed on the absent action (`Unknown reporting action`, 537.123 ms). Fourteen backend
checks qualify chronological ordering, independent hand-calculated errors, exact large/fractional values,
zero/unknown/too-wide factors, malformed/duplicate/missing dates, limits, stale/open periods, current key/tenant/
account authority, genuine synthetic LinkedIn capture and exact other-provider/parent identities. The maximum
20-entity/31-day workload has 480 bounded test rows and remains below 600 KiB. Default and explicit equivalent
choices yield the same fingerprint. Old allocation/native-plan regressions qualify the shared gate refactor.

Five UI checks cover explicit reader-compatible evaluation/application, escaping, both languages, unknown
factors and pending-result/application races. An additional full allocation-panel integration check verifies
that applying history disables the preceding native handoff. Authenticated loopback HTTP uses a real synthetic
viewer membership/session, CSRF and no-store responses; revoked sessions withhold the diagnostic. The real MCP
reader validates advertised schema/text parity, inspects history, explicitly models, then rejects revoked access
with zero native requests. Initial Arabic rendering correctly failed before the new translations were authored;
this development failure is not a production finding.

Final focused and sanitized full release evidence is recorded below after completion. Native totals remain
**3,247 actions / 167 families / 800 reviewed writes**. Package totals remain **13 implemented / 14 partial /
one open**. New actual browser/keyboard/assistive, external-client, real tenant/provider/deployed qualification,
multi-day calibrated forecasting and remaining provider budget bindings remain separate. Work continues
through the original roadmap.

Final focused set passed **119/119/0/0 in 11.739 seconds**. Calibration SDK: **3 tool calls / 10,907 structured
bytes / zero provider requests or mutations**. Website checks cover 34 shipped scripts and 3,315 selected Arabic
messages. Fresh sanitized report/full release/exact-commit qualification follows before the sole Work-here push.
The browser tool's Windows kernel-path failure in this session leaves new actual visual/keyboard/assistive
observations unqualified; deterministic DOM tests and older browser observations do not replace them.

## Sanitized release preflight

Fresh offline install, build, early tracked-report freshness, full check and Railway configuration gates passed,
each exit zero. Main suite: **4,086 tests / 4,081 passes / no failures / five expected local FFmpeg skips,
99.762 seconds**. Capture suite: **four passes / no failures or skips, 74.629 ms**. Index: 298 documents.
The manifest contains **1,678 public source files plus one generated empty sample**, source hash
`ce356d67a2c36cf7e5a6adab77133937987dce226cb15d45d39751a25d70d47b`. All three tracked public report
artifacts regenerated unchanged and stayed byte-identical during qualification. The private root sample was
never read. These final evidence paragraphs follow preflight; exact committed-source parity and full gates
precede the sole Work-here push. Current-revision Linux/Docker/FFmpeg CI is still required.

The preceding exact `5195db3` source is now verified by [CI186](https://github.com/magdyezy1/CAMCP/actions/runs/37176121309),
with 4,064 passes and no failures/skips on both Linux host and Docker, required FFmpeg, early report freshness,
Railway/image checks and both synthetic smoke modes. A separate unauthenticated public health read returned
HTTP 200 and `status:up` on 2026-10-04. It exposes no revision; liveness does not qualify the deployed commit or
authenticated/native workflows. No production/machine settings, credentials or permissions changed.
