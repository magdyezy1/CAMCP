# Wave 4b integration qualification of 2026-10-24

A dated record (QA-03, ACC-04, DOC-03): the release gate, the container-parity run and the rendered browser
qualification of the merged wave 4b tree, kept as written. Wave 4b is the MCP quality, design review, design system,
current-state documentation (DOC-01) and owner guide (DOC-03) work the owner confirmed on 2026-10-22. How the browser
runner works is in [local rendered website qualification](../LOCAL-BROWSER-QA.md); how container parity works is in
[the deployment guide](../DEPLOY-RAILWAY.md).

## Runs

| Run | Revision | Result |
| --- | --- | --- |
| Release gate `wave4b-gate-1` | `b2ea6264` | Passed: 8,021 of 8,021 tests and 4 of 4 capture tests in 435 s, every `npm run check` stage with FFmpeg required. The public reports regenerated from the empty sample matched the tracked ones. |
| Container parity on `wave4b-gate-1` | `b2ea6264` | Passed outside any Git repository, with two test workers and FFmpeg required, as Railway's Dockerfile build runs: 8,024 passed, 0 failed, 1 skipped (the entrypoint test that needs a POSIX `sh`, absent from this Windows layout; Railway's Linux build runs it), in 1,138 s. |
| Browser `wave4b-browser-1` | `b2ea6264` | Not a result: Chromium's page target crashed about 22 minutes in, when the integration agent's session ended. Every case it had finished had passed. |
| Browser `wave4b-browser-2` (`--qualification`) | `b2ea6264` | Passed 1,280 of 1,280 cases on its first complete run, 2026-10-24 08:28 to 09:19 UTC, 50.87 minutes against the 75-minute budget. `results.json` SHA-256 `16fb6f14dfb2b67a6f51a66949b359bfbd5a4db618fb5466ee5797b6f11ee394`. |

## What the qualification showed

- **Scope.** 95 distinct scenarios, 69 fixture kinds and 22 presentation variants: every page in English and Arabic,
  light and dark, at 320 to 1280 pixels, with the design system's radius, elevation and type tokens, the dark layer
  that both design packages changed, and the design review's fixes. axe-core 4.14.0 (engine SHA-256
  `20c09fe157a8a34a30e241aaa1fcdade657734f08ab379ecfbeb7d45cc46e878`), Playwright 1.62.1, Chromium headless shell
  148.0.7778.96, two fixture lanes, synthetic loopback fixtures only.
- **WCAG.** No pinned WCAG 2.2 A/AA rule was violated at any initial, intermediate or final state in either theme.
  Left incomplete for manual review: color-contrast 2,498 and label-content-name-mismatch 2,464. The slowest
  inspection took 0.87 seconds of its 20-second deadline (`conversion-metadata-invalid-measurement-ar-768`).
- **Focus.** All 3,582 measured focus rings reached 3:1, and no focused control lacked an indicator. Eight samples of
  the scroll-region target the design review added (the command block on `/connectors`, at 320 and 1280 pixels in
  both languages and themes) were not measured: that block wraps (`white-space: pre-wrap`) and does not scroll there,
  so Chromium does not make it a keyboard stop, the runner's focus call does not take, and the sample is reported as
  `not_focus_visible` rather than measured. The catch-all `:focus-visible` ring applies if it ever scrolls.
- **Arabic.** All six critical routes had zero leaks. The run measured `/settings` and its `spend-policy-edit` and
  `worker-health` states at zero (the limits were 3, 2 and 2, before WEB-05 translated the owner Settings sentences), so
  `node tools/browser-arabic-leaks.mjs --ratchet .runtime/wave4b-browser-2/results.json --write` lowered those three
  limits to zero; no other limit changed.
- **Writes.** The write journeys ended accepted, refused and uncertain four times each, with 28 synthetic writes, 0
  provider writes, 0 external provider requests and 0 unhandled rejections.
- **Tree.** `working_tree_clean` is false only because of an untracked file outside the release scope.

## Follow-ups

- The focus sampler could record whether its focus call took and report a target that is not a keyboard stop
  separately from one that is focused without `:focus-visible`, so a future scroll region that scrolls but shows no
  keyboard ring cannot hide among the unmeasured samples.
- Owner-run, unchanged by this run: the visual sign-off of the colour and design-system changes (B16, listed in
  [the design review](DESIGN-REVIEW-2026-10.md) and [the design system](../DESIGN-SYSTEM.md)), the ACC-07 keyboard,
  screen-reader and 200% zoom passes, and the deployed checks after the next push.
