---
status: record
tier: engineering
---

# Wave 4c round 7 integration qualification of 2026-10-31

A dated record (QA-03, ACC-04, ARC-01, OWNER-REVIEWER-QA): the release gates, the extra stages of the full
qualification profile, the container-parity run, the call-replay comparison and the rendered browser qualification of
the merged tree that finishes wave 4c, kept as written. This part of wave 4c meets ARC-01's local targets (no shared
module imports a provider module, and one names a gateway, as the example in a refusal), adds the reviewer pass to the
browser qualification and hides from a test account the account controls and report-job grants it is always refused,
makes the full qualification find an installed ffprobe and accept four reviewed Search Console spellings, and moves
self-service deletion out of the shared page shell. It applies the owner's decision of 2026-10-31 that a reviewer's
approvals read Reviewer, and makes a test account a viewer outside its own test workspace, a choice the owner left to
engineering. How the browser runner works is in [local rendered website qualification](../LOCAL-BROWSER-QA.md), how
container parity works in [the deployment guide](../DEPLOY-RAILWAY.md), and the call-replay proof and the architecture
ratchet in [the architecture record](../review/ARCHITECTURE.md#9-provider-adapters); the [first wave 4c
record](QUALIFICATION-4c-2026-10-30.md) has the method this one repeats.

## Runs

| Run | Revision | Result |
| --- | --- | --- |
| Whole suite with `AMCP_PROVIDERS=criteo,woocommerce` | `ebfedb42` | Passed on a clean public candidate with FFmpeg required and eight workers: 8,386 tests, 8,385 passed, 0 failed, 1 skipped (the entrypoint test that needs a POSIX `sh`, absent from that run's PATH), 447 s. ARC-01: the suites pass with the parked providers offered and without. |
| Release gate `wave4c-r7-gate-1` | `a6826b6f` | Passed: 8,386 of 8,386 tests and 4 of 4 capture tests in 478 s, every `npm run check` stage with FFmpeg required. The public reports regenerated from the empty sample matched the tracked ones. |
| Full-profile stages on `wave4c-r7-gate-1` | `a6826b6f` | Passed, each with exit 0: the FFmpeg probe (status passed: FFmpeg n9.0.2 and ffprobe both found, QA-01), the capture core 4 of 4, the mutant catalogue 33 of 33 killed, the wire-contract sweep (71 test files; six fixture violations, each a reviewed exception with its vendor evidence: two of Tag Manager and the four Search Console spellings of PRV-05), the pinned Meta creative features, the website checks, the journey evaluation without regression, and the offline provider drift, lifecycle and sunset checks. |
| Container parity on `wave4c-r7-gate-1` | `a6826b6f` | Passed outside any Git repository, with two test workers and FFmpeg required, as Railway's Dockerfile build runs: 8,389 passed, 0 failed, 1 skipped (the entrypoint test that needs a POSIX `sh`, absent from this Windows layout; Railway's Linux build runs it), `npm run check` in 1,238 s. |
| Browser `wave4c-r7-browser-1` (`--qualification`) | `a6826b6f` | Passed 1,392 of 1,392 cases, 2026-10-31 20:30 to 21:25 UTC, 55.0 minutes against the 75-minute budget. `results.json` SHA-256 `59938e95317f7290e51335f68a03b62ec44e08945edf3bf3cafe3bfd5ca1a0a2`. |

This record's own commit changes documentation only.

## Call-replay comparison

`06684304`, with the merged recording targets of `tools/call-replay.mjs`, and the merged head `ebfedb42` were recorded
back to back on 2026-10-31 between 18:58 and 19:32 UTC, the base twice for the calibration, over 891 test files: the
related selection of the 137 source files this part changed, united with the five ARC-01 packages' recorded lists, less
the 29 test files it added or changed and the tool's own test. One test file, the four-worker queue test, failed in the
head's recording and in the base's second one alike ("database is locked" after a worker's five-second busy deadline,
under 19 recorded test processes at once); it passed when recorded alone on each side, and those recordings replace it
on all sides. Compared one test file at a time with the tool's own comparison, with the two builds' release identity
masked: 13,141,090 records before and 13,140,487 after, the same 56,248 provider requests on both sides, and no call
that returned before is refused after, or the reverse. In each of the 765 test files with a finding, the results and
each refusal code per function are the same before and after, apart from one `platform()` lookup whose count varies
between runs of one build. What differs, each checked: the Meta creative check that moved into the Meta creative
features module (the base has no function at the recorded address; the merged head's 74 distinct calls give the same
results through the base's own function) and eight measured times. The 153 records the calibration cannot settle are
that `platform()` count and 152 plan and preview calls paired across random preview hashes and plan IDs, which the
calibration pairs the same way. The 453,996 distinct pure calls of the base replay through the merged build with one
difference: a contract-evidence call the Data Manager test records under `AMCP_WIRE_CONTRACTS=enforce`, which the
base's build replays the same way and which matches under that setting. The later commits change documentation only,
none of the recorded modules.

## What the qualification showed

- **Scope.** 120 distinct scenarios, 70 fixture kinds and 22 presentation variants: every page in English and Arabic,
  light and dark, at 320 to 1280 pixels, and the reviewer pass, new in this run. axe-core 4.14.0 (engine SHA-256
  `20c09fe157a8a34a30e241aaa1fcdade657734f08ab379ecfbeb7d45cc46e878`), Playwright 1.62.1, Chromium headless shell
  148.0.7778.96, two fixture lanes, synthetic loopback fixtures only.
- **Reviewer pass.** An invited test account opened the 23 routes a test account may use and the Help page, at 320
  and 1280 pixels in both languages: 96 of 96 cases passed. Its navigation listed only those routes, no API response
  failed while a page loaded (Settings among them, which no longer asks for the owner's account list in a test
  account's session), and Help landed on Home. Each of the 24 routes had zero Arabic leaks.
- **WCAG.** No pinned WCAG 2.2 A/AA rule was violated at any initial, intermediate or final state in either theme.
  Left incomplete for manual review: color-contrast 2,648 and label-content-name-mismatch 2,688. The slowest inspection
  took 1.07 seconds of its 20-second deadline (`x-catalog-inventory-stale-commerce-ar-768`).
- **Focus.** All 3,878 measured focus rings reached 3:1, and no focused control lacked an indicator. The twelve
  samples of the command block on `/connectors` are again `not_focus_visible`: the eight of the empty workspace (320 and
  1280 pixels, both languages and themes) and the reviewer pass's four. The block wraps and does not scroll there, as
  the wave 4b record explains.
- **Arabic.** All six critical routes had zero leaks, and `node tools/browser-arabic-leaks.mjs --ratchet
  .runtime/wave4c-r7-browser-1/results.json` proposes no change to the recorded limits.
- **Writes.** The write journeys ended accepted, refused and uncertain four times each, with 28 synthetic writes, 0
  provider writes, 0 external provider requests and 0 unhandled rejections.
- **Tree.** `working_tree_clean` is false only because of an untracked file outside the release scope.

## Follow-ups

- Busy handling for worker processes: the four-worker queue test failed in two of the comparison's three recordings
  (on both builds), as in the first wave 4c comparison, when 19 recorded test processes contended for one store; no
  gate run failed this way. The busy deadline of worker processes, with a test that contends from several processes,
  is the place to look.
- The call-replay recorder's own summary reads a whole recording into memory, which ran out on 6 GB; it should read
  one test file at a time, as the comparison does.
- For the owner: whether reviewers should be allowed report-job access after all (the test-account gate refuses it
  today, so their pages no longer offer it), and a confirmation that Settings should not ask for the owner's account
  list in a test account's session.
- Owner-run, unchanged: the provider lifecycle's strict mode would fail, as before this part, on the TikTok
  lifecycle review that was due on 2026-10-28 and on 16 documentation sources that wait for a reviewed `--live`
  refresh; the offline check passes.
- The focus sampler could report a target that is not a keyboard stop apart from one focused without
  `:focus-visible` (wave 4b follow-up, unchanged).
- Owner-run, unchanged by this run: ARC-01's native equivalence and security sign-off, the visual sign-off of the
  design-system and WEB-07 increments, the ACC-07 keyboard, screen-reader and 200% zoom passes, an editorial review of
  the owner guide on the Help page in both languages, and the deployed checks after the next push.
