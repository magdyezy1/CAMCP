---
status: record
tier: engineering
---

# Wave 4c integration qualification of 2026-10-30

A dated record (QA-03, ACC-04, ARC-01, DOC-03): the release gates, the container-parity run, the call-replay
comparison and the rendered browser qualification of the merged wave 4c tree, kept as written. Wave 4c is the
documentation consolidation with the members-only Help page (DOC-03) and the ARC-01 and ARC-04 work left after wave 4a,
which the owner instructed on 2026-10-24. How the browser runner works is in [local rendered website
qualification](../LOCAL-BROWSER-QA.md), how container parity works in [the deployment guide](../DEPLOY-RAILWAY.md), and
the call-replay proof and the architecture ratchet in [the architecture record](../review/ARCHITECTURE.md#9-provider-adapters).

## Runs

| Run | Revision | Result |
| --- | --- | --- |
| Whole suite with `AMCP_PROVIDERS=criteo,woocommerce` | `a503f2f6` | Passed 8,279 of 8,279 tests in 390 s on a clean public candidate, after `a503f2f6` made ten tests state the offering they count (ARC-01: the suites pass with the parked providers offered and without). |
| Release gate `wave4c-gate-1` | `4ecee507` | Passed: 8,279 of 8,279 tests and 4 of 4 capture tests in 424 s, every `npm run check` stage with FFmpeg required. The public reports regenerated from the empty sample matched the tracked ones. |
| Container parity on `wave4c-gate-1` | `4ecee507` | Passed outside any Git repository, with two test workers and FFmpeg required, as Railway's Dockerfile build runs: 8,282 passed, 0 failed, 1 skipped (the entrypoint test that needs a POSIX `sh`, absent from this Windows layout; Railway's Linux build runs it), `npm run check` in 1,117 s. |
| Browser `wave4c-browser-1` (`--qualification`) | `4ecee507` | Failed 8 of 1,296 cases, 2026-10-30 07:22 to 08:13 UTC: the Help page at 320 and 375 pixels, in both languages and themes, scrolled sideways (520 CSS pixels of 320 and 375) because the owner guide's two tables took a data table's minimum width. `results.json` SHA-256 `08231333ca534656e15ff57930a99a1c467cdedcdf9ef396972dd2a9eb3905b6`. |
| Release gate `wave4c-gate-2` | `4bd55002` | Passed after the fix (`4bd55002`: the guide's tables reflow): 8,280 of 8,280 tests and 4 of 4 capture tests in 418 s, every stage, no report difference. |
| Browser `wave4c-browser-2` (`--qualification`) | `4bd55002` | Passed 1,296 of 1,296 cases, 2026-10-30 08:32 to 09:23 UTC, 51.0 minutes against the 75-minute budget. `results.json` SHA-256 `3dc60d1ed891617a056b256719f65cabd56e089d0b456edbb635253ada1d7707`. |

## Call-replay comparison

`de754838`, with the merged recording targets of `tools/call-replay.mjs` (91 modules), and the merged head `26786f73`
were recorded back to back on 2026-10-30 between 06:08 and 06:29 UTC, the base twice for the calibration, over 814 test
files: the related selection of the 343 source modules wave 4c changed, united with the five packages' recorded lists,
less the test files wave 4c added or changed and the tool's own test. With the packages' recorded moves set aside,
4,476,349 records before and 4,476,747 after, compared one test file at a time with the tool's own comparison: no call
that returned before is refused after, or the reverse, and the 130,911 distinct pure calls of the base replay through
the merged build with no difference. The moves, each checked: the catalog compiler's 1,098,255 extra account
normalizations (and four that the moved snapshot steps no longer make, with identical snapshot plans); the functions
that moved to modules the base does not have; the offline-upload rehearsal fact now on the conversion families; Reddit's
page step (each of the base's 621 Reddit page steps is a Reddit step record with the same plan, response and result);
the 27 breakdown values the base's Meta breakdown key read; and three measured times or clock-derived digests. The 54
records the calibration cannot settle are two `platform()` lookups whose number varies between runs of one build and 52
plan and capture calls paired across random preview hashes, whose results and refusals per action are the same in all
three recordings. The later commits change tests, documentation and one stylesheet rule, none of the recorded modules.

## What the qualification showed

- **Scope.** 96 distinct scenarios (the Help page is the new one), 69 fixture kinds and 22 presentation variants: every
  page in English and Arabic, light and dark, at 320 to 1280 pixels, and the members-only Help page signed in at 320,
  375, 768 and 1280 pixels in both languages and themes. axe-core 4.14.0 (engine SHA-256
  `20c09fe157a8a34a30e241aaa1fcdade657734f08ab379ecfbeb7d45cc46e878`), Playwright 1.62.1, Chromium headless shell
  148.0.7778.96, two fixture lanes, synthetic loopback fixtures only.
- **Reflow.** The first run's eight failures were one cause: below 720 pixels a review table keeps 30rem, and each cell
  10rem, the minimum width of a data table that sits in a scrolling region, and the owner guide's two two-column tables
  (the roles, and the retention periods) sit in the page itself. `.help-guide .review-table` and its cells now take no
  minimum width, so the tables reflow; every other review table keeps its minimums, and the rule adds 13 Brotli bytes to
  each page, within every route-bytes baseline. In the second run the Help page's width equals the viewport at every
  width, in every case.
- **WCAG.** No pinned WCAG 2.2 A/AA rule was violated at any initial, intermediate or final state in either theme.
  Left incomplete for manual review: color-contrast 2,530 and label-content-name-mismatch 2,496. The slowest inspection
  took 0.68 seconds of its 20-second deadline (`conversion-metadata-owned-measurement-en-768-dark`).
- **Focus.** All 3,602 measured focus rings reached 3:1, and no focused control lacked an indicator. The eight
  samples of the command block on `/connectors` (320 and 1280 pixels, both languages and themes) are again
  `not_focus_visible`: the block wraps and does not scroll there, as the wave 4b record explains.
- **Arabic.** All six critical routes had zero leaks, and the Help page had zero in every case:
  `node tools/browser-arabic-leaks.mjs --ratchet .runtime/wave4c-browser-2/results.json --write` recorded its limit at
  zero, the only change it proposed.
- **Writes.** The write journeys ended accepted, refused and uncertain four times each, with 28 synthetic writes, 0
  provider writes, 0 external provider requests and 0 unhandled rejections.
- **Tree.** `working_tree_clean` is false only because of an untracked file outside the release scope.

## Follow-ups

- ARC-01's local target is not met: 34 shared modules still name a gateway (target 20 or fewer) and 53
  shared-to-provider imports remain (target 30 or fewer); [package status](../review/PACKAGE-STATUS.md) names what is
  left.
- The focus sampler could report a target that is not a keyboard stop apart from one focused without
  `:focus-visible` (wave 4b follow-up, unchanged).
- Owner-run, unchanged by this run: the visual sign-off of the design-system increment, the ACC-07 keyboard,
  screen-reader and 200% zoom passes, an editorial review of the owner guide on the Help page in both languages, and the
  deployed checks after the next push, the Help link for members among them.
