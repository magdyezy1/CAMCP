---
status: record
tier: engineering
---

# Round 2 report editor qualification — 2026-11-05

Implementation `16915f8c` passed a fresh filtered public checkpoint for the v4 report
editor, retained snapshot presentation and lazy delivery. The
[implementation record](IMPLEMENTATION-V2-R2-WEBSITE-REPORTING-2026-11-05.md) describes the behavior. This accepts the
editor checkpoint; it does not complete Round 2 or its full browser/container/MCP/evaluation gates.

The candidate binds 3,324 public source files at source tree
`ef76fccec7d8f8e6dc99e3eb4a1eed0faa3d0062bc3f0f91177d9190f85e82b7` and packaged runtime
`2878073910166999ba9ebbc5ad2adb20bd5eaec7e4702a46da18afa4ce197d15`. All 29 changed public inputs
matched their frozen hashes before the named implementation commit. Added-content review found no local paths or
credential patterns. Protected/private paths were excluded before content reads; the release sample is the literal
empty fixture. This subsequent documentation receipt changes no executable input.

All **8,484 selected tests in 945 files**
passed, with zero failures, skips or cancellations. All six freshness checks, fast qualification, static web checks
and all 58 route budgets passed. English reporting is 171,353 of its
existing 177,616 Brotli-byte budget; the report library is 157,728
of 158,806. Static checks cover 45 browser scripts, 310 HTML writes and 1,147 manually escaped values without a debt
increase. The Arabic catalog has 11,710 entries and covers 10,647 required messages in 37 generated chunks. No route,
architecture, precision, collection, golden, dependency or security allowance was relaxed.

Four focused synthetic HTTPS browser cases passed in English and Arabic at 1280-pixel light and 320-pixel dark
variants, with unchanged public inputs, no JavaScript errors, no external requests and no provider mutations. They
exercise the real editor, HTTP routes and worker: exact selected-ad identity, labelled ancestor spend equal to the
selected ad's 0.200000002, account-free template reuse, preserved legacy profile/population, once-only migration notice,
and a revision-safe edit after the saved run's automatic migration. The existing snapshot-bound export consent,
synthetic Sheets append and original-tab preservation journey also passes. Both narrow source-control layouts were
visually inspected. These four cases are focused evidence, not the full browser qualification matrix.

A separate four-case pass used the unchanged hash-pinned axe-core 4.14.0 engine for eight inspections, with zero
automatic violations. Its incomplete results remain recorded: 42 distinct targets across color contrast and
label/name checks. Of these, 27 match the accepted SDK granular-reporting record; 15 are native multiple selects,
extra summary text, clipped RTL cells and another History row. Focused review checked native Home/Shift+ArrowDown/End
selection, exact retained-snapshot identity, computed text/selected-option colours, both gradient stops and intermediate
samples, and real keyboard table scrolling. The eight measured source-control focus rings are 7.06:1 in light mode
and 10.51:1 in dark mode. Minimum sampled text contrast is 4.5259:1 in light and 8.0687:1 in dark, above its applicable
threshold; native selected options also pass. Desktop/light and mobile/dark native-control screenshots were inspected
in both languages. No source change was needed. These checks dispose of this checkpoint's new uncertainties; full
browser, component/shell states and manual assistive-technology acceptance remain later gates. No incomplete result
or accessibility threshold was suppressed.

The browser journey exposed a real dialog refresh race: old controls could receive a click after their handlers
became stale. Refresh now disables those controls until replacements bind and fences snapshot/selection changes;
failure closes the inactive dialog for an explicit reopen. The journey also found that the result page omitted the
retained migration notice; it now uses the shared escaped notice renderer. A terminal collection job replaces a stale
running label while completed/partial retained data keeps its capture state. Focused regressions cover these paths.

The first filtered candidate passed all six freshness checks, fast, static and route gates but failed four tests
because three older harnesses loaded controls from the former module or expected delivery to load eagerly. The
corrected fixtures retain exact ID, localization, formula, date, revision and complete shipped-script assertions;
they additionally assert explicit v4 scope/declaration fields and deferred delivery loading once. All 30 tests in
those files passed, followed by the fresh complete related run. Application code, budgets and security requirements
were unchanged between the two candidates. Early browser fixture failures remain separate from acceptance; an invalid total-grain test against
daily provider rows was corrected without weakening the duplicate-row validator.
An additional review attempt failed at Chromium's initial screenshot before its manual checks, and the identical
fresh run passed; the failed run is retained separately as infrastructure evidence, with no application change.

On this machine plain HTTP synthetic pages received an attempted antivirus script injection, which the request
guard blocked and failed. The final focused check uses local HTTPS with task-generated loopback certificates;
external attempts still fail and security software remains enabled. No test key or private file enters the release.
Full qualification needs the same explicit local transport option before its closing run.

The remaining reporting acceptance audit, Packages D–I and final full browser/container/MCP/evaluation/docs/prepush
gates remain. Arabic copy still needs the planned native-speaker review. Meta's native Results inner shape and all
live provider/OAuth, amcp.shop, Railway, actual Sheets and deployment checks remain owner-deferred. No Round 2 push
is claimed.
