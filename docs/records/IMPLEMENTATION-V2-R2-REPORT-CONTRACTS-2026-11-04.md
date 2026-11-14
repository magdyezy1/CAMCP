---
status: record
tier: engineering
---

# Round 2 report contract foundation — 2026-11-04

This change prepares objective-led results and the v4 normalization boundary. It does not activate the new
collector, change legacy saved-report execution, or complete Round 2 Packages B and C. The isolated SDK v2 and
compatible dependency remediation remain separate earlier commits.

Provider sources declare result definitions and exact readers. Native costs take precedence; derived costs use
nine-place decimal arithmetic and half-even rounding. Missing metrics remain null, with known-value and paired-cost
coverage. Definitions, currencies and collection scopes stay separate; reach is non-additive. TikTok ad-group
results group only when the known goal and conversion event agree. Unknown future goals keep their native row value
without gaining an additive total. Meta's explicit action override preserves one action, with overlapping aliases
never added and the delivered omitted-action policy retained.

The v4 foundation validates several levels, the legacy single-level alias, scope IDs/statuses, delivery filters and
provider-supplied defaults. It never turns an undeclared measurement window into a declaration of completeness.
Legacy objectives become fallbacks. Exact totals and paired ratios carry coverage, and a projection omits native rows
and repeated lineage unless requested. Durable migration notices, collector wiring, source-owned option/level tables,
rollback forms, saved/scheduled execution and website integration remain in progress.

## Evidence and limits

- Synthetic field-pairing assertions: `tests/fixtures/report-result-pairings-v1.json`; no live account samples.
- Focused provider/result/v4 and existing objective/source tests: 75 passed. Localization suites: 26 passed.
- Legacy row goldens remain byte-identical. TypeScript, static browser checks and all 58 route budgets pass.
- An earlier result-reader candidate passed 7,708 related tests in 852 files and its fast gate. Its static check
  correctly rejected three untranslated Meta diagnostics. The diagnostics, their Arabic translations and result
  labels are now included. That earlier broad run predates the final alias correction and v4 foundation; it is not
  qualification of the final Round 2 runtime. The complete round closing gates remain required.
- The final committed foundation (`24ecee72`) then passed a fresh filtered candidate: 8,257 related tests in 922 files,
  zero failures/skips, all six freshness stages, fast qualification, static browser checks and all 58 route budgets.
  This candidate binds source tree `102b348cf32dcdcf9f857069ef73b388dbd0d2ffb1af64b7a8187f4c5c27b586`.
  Later uncommitted collector/worker wiring is outside this acceptance. No full browser, deployment or Round 2
  completion claim is made for the foundation.
- Localization discovery now covers four additional source modules, three additional direct Meta diagnostics and
  eight additional unique v4 wrapper refusals. Catalog counts reflect these additions; no assertion was removed.
- No new dependencies, tool/listing baselines, security exemptions, route budgets or legacy goldens were introduced.

Meta's AdsInsightsResult inner shape is still unverified. Its SDK declares a list of objects without an inner model;
this implementation does not invent one or claim native Results-column parity. Documented scalar/action mappings
remain explicitly mapped results. Reddit conversion/app/lead objectives have no generic scalar total in the pinned
report enum. X app/web conversion fields contain attribution channels. Neither is replaced with a guessed purchase
count or a sum of overlapping channels. Snapchat app-specific conversion mappings remain unpinned. Those results
stay unknown until appropriate evidence exists.

Primary references: [Snapchat goals](https://developers.snap.com/marketing-api/Ads-API/ad-squads),
[Snapchat metrics](https://developers.snap.com/marketing-api/Ads-API/measurement),
[X analytics](https://docs.x.com/x-ads-api/analytics),
[TikTok supported metrics](https://business-api.tiktok.com/portal/docs/basic-reports-supported-metrics/v1.3),
and the pinned Meta SDK/captured Reddit schema identified in the fixture. Public documentation was checked on
2026-11-04; TikTok's public metric page did not expose readable text during this session, so its earlier documented
pin remains explicitly distinguished from a fresh page extraction.

Live provider and OAuth reads and actual Sheets exports are not permitted during development (plan principle 4); live
checks on staging are blocked: no staging (V2 plan D20); deployment to amcp.shop is deferred by the owner (2026-11-03: "leave
the live deployment for now, push to github, live deployment in a later stage"). Arabic copy still requires the planned
native-speaker sign-off. Nothing in this record authorizes a live mutation or publication.
