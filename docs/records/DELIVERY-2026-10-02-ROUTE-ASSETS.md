---
status: record
tier: engineering
---

# Website scripts loaded by route — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `226642a`. Batch 101 extends B09/B16/B23/B24.

The initial website document now loads eight shared scripts instead of all 32 existing scripts. Landing, sign-in,
Connections, MCP connectors, activity and legal routes need no additional feature script. Campaigns fetch their
recipe and review controllers on first visit; reporting, operations, measurement, commerce, creative and account
routes load their own declared dependencies. Revisits reuse initialized scripts within the document. The shared
shell, localization, identity/security overrides, reporting helpers and test-account route filter remain available
before startup. Existing DOMContentLoaded startup ordering and server authorization remain intact.

The fixed same-origin manifest includes 25 lazy assets and their dependencies. No route/query/provider value is
inserted into a script URL. Independent script downloads are requested together with ordered classic-script
execution; settings approval wrappers additionally wait for the original owner wrapper to initialize. MFA QR
helpers wait for the vendored encoder. Shared concurrent visits reuse a single promise for each filename.
Loading only installs authored definitions and handlers; it makes no account/provider API request.

A current page shows a translated loading status while its scripts arrive. Generation, identity and pathname
checks fence both success and failure before rendering. A late load after navigation, logout/workspace reset or
a return to the same route cannot restore the old page. Download failures leave a focused page error and explicit
retry. Successful scripts are retained, so retry downloads only failed files. Runtime evaluation failures and a
20-second timeout instead require a full reload: uncertain scripts are never reinserted into the same document,
which avoids duplicate global declarations or partially installed handlers. Late events cannot reopen the settled
load. Timers and error listeners are removed when each request settles. Stylesheets, CSP and asset revalidation
are unchanged; no inline/eval execution or external CDN is introduced.

`node tools/benchmark-web-assets.mjs` reproduces independent raw/gzip/Brotli byte totals, exact source hashes,
initial assets and each route's additional files. Brotli quality 11 matches the existing server encoding. These
are JavaScript source/encoding measurements, excluding headers, CSS, fonts, locale JSON, API data and browser timing.
The comparison below uses all **33 current scripts** as the eager equivalent, including the new loader.

| Load | Scripts | Raw bytes | Gzip bytes | Brotli bytes |
| --- | ---: | ---: | ---: | ---: |
| All current scripts | 33 | 698173 | 194828 | 165224 |
| Initial / public / Connections | 8 | 218931 | 62852 | 53347 |
| First Campaigns visit | 10 | 250062 | 72509 | 61521 |
| First Reporting overview visit | 12 | 275716 | 79889 | 67645 |
| First retained Reports visit | 18 | 418982 | 117698 | 99778 |

Initial JavaScript bytes are reduced **68.64% raw** and
**67.71% Brotli** against that eager equivalent.
This is not a measured page-speed percentage. Cold feature navigation introduces asset requests; cached revisits
do not. Actual-browser startup, slow-network behavior, assistive-technology acceptance and deployed performance
remain unverified. Shared controllers still contain dormant route functions; finer splitting is possible if a
browser profile demonstrates a material benefit. This change makes no provider or multi-worker capacity claim.

Nine new tests cover initial byte bounds, fixed paths, zero public feature requests, concurrent deduplication,
retry, wrapper ordering, timeout/evaluation uncertainty, dependency inventory, cold initialization and page/error
lifetime. Six initial cases were observed red before implementation. Real source scripts initialize independently
for **19 routes × English/Arabic** in fresh VM documents; required handlers and actual MFA QR output are checked,
with an API-call trap. Existing HTTP tests additionally verify new loader and lazy-controller cache validators.
Focused checks passed **41/41**. Root regression: **3,603 tests / 3,598 passed / zero failed / five local FFmpeg
skips; 85.24 seconds**. Static checks cover **33 browser scripts / 2,766 selected Arabic messages**.
The VM and synthetic HTTP checks do not substitute for a native browser run. Evidence: `.runtime/route-assets-20261002/`.

Classic-script ordering was checked against the [HTML processing model](https://html.spec.whatwg.org/multipage/scripting.html#script-processing-model);
evaluation failure detection follows the documented [window error event](https://developer.mozilla.org/en-US/docs/Web/API/Window/error_event).

Batch 100 exact committed-source checks and Railway passed on `226642a`: **3,589 passed / zero failed / five local
FFmpeg skips; 89.27 seconds**, four capture tests, **1,545 public files + one generated empty sample**, hash
`2f782a5af3eb72c3ec80b76daa2509170e642d32cd221ad5da4e2f3bea5ac4e2`.
It was pushed only to Work-here. [CI155](https://github.com/magdyezy1/CAMCP/actions/runs/36970264019) is running.

LinkedIn conversion inspection [CI154](https://github.com/magdyezy1/CAMCP/actions/runs/36967109393) succeeded on
`145e032`: host and Docker each **3,575 passed / zero failed/skipped**, four capture tests and Railway. Job
`110713143509`, release-evidence artifact `11211400229`; both workflow status and job logs were inspected.

Native ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
Blueprint remains **13 implemented / 14 partial / 1 open**; B23 still needs real-tenant/multi-worker qualification.

Sanitized preflight `.release/route-assets-preflight-20261002` passed all stages and Railway:
**3,598 passed / zero failed / five local FFmpeg skips; 88.63 seconds**, four capture tests,
33 browser scripts, 2,766 selected Arabic messages and 267 documents. Its **1,549 public source files**
plus one generated empty sample have hash `86faa388161424752e73e79417ebed292f0def0437a48b823f290aed0fb437b7`.
Exact committed-source qualification follows before the sole Work-here push.
