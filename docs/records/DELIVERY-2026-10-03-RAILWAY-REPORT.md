# Railway tracked report freshness

Batch 120, 2026-10-03. Repository magdyezy1/CAMCP; sole branch Work-here. Baseline afb5e8f.

The supplied Railway build log stopped at `node dist/tools/report.js --check` because the tracked
implementation status report was stale. It recorded 280 reachable modules, 430 refusal codes and 123 family
codes; the current generator records 283, 432 and 125. Local build/report generation changes exactly these
three values in `.mirror/REPORTS/implementation-status.json`. Compatibility verification and PARITY remain
byte-identical. The public report contains no live account samples.

## Confirmed finding and fix

F-192 (medium, release reliability): public release assembly excluded the tracked status reports. Their absence
was then accepted by `report --check`, so CI's sanitized candidate and Docker image did not reproduce the direct
Railway checkout build. CI174 for afb5e8f passed host/Docker suites while the supplied Railway log showed the
status report failure. This is a verified validation gap; a deployment outage or recovery was not inspected.

Release assembly now includes and requires the three public report artifacts and records their exact source
bytes in the manifest. It refuses implementation reports with nonempty or missing live_read_samples, including
malformed JSON, using messages that do not echo account data. The report check treats missing artifacts as stale
and never regenerates them. CI runs build and report freshness before the full suite. Docker's existing full
check remains in place.

## Evidence

- The release-selection regression failed against the original assembler because implementation-status.json
  was excluded. Both release-selection and public-report privacy regressions now pass.
- A fresh local sanitized candidate reproduced the supplied stale-file error with exit 1 before regeneration.
  `npm run build && npm run report` passed there; a second generation was byte-identical for all three artifacts.
- The regenerated report passed `--check`. Removing each artifact independently returned exit 1, named the
  missing file and did not rewrite it. Each file was restored unchanged after that negative check.
- Only the regenerated public implementation report was copied back. Its SHA-256 changed from
  e0255dd502d52eb9b70bf6e9e88a288ab458a831cd00c872307758eb1b4a4fd1 to
  c5ff7ef1d54af0646cd7aa2a34eeb0669aa131977b90947d3705a67b10946569.

The action/family ledger, provider routes, grants, reviewed-write boundaries and runtime application behavior
are unchanged. No provider calls, credentials, private account samples, Railway settings or DNS were accessed.
Evidence logs are retained locally under `.runtime/railway-report-20261003/`.

## Qualification

Fresh `.release/railway-report-preflight-20261003` passed install, build, report freshness, the complete check and
Railway compatibility, each with exit zero. The suite had 3,868 total / 3,863 passed / zero failed / five expected
local FFmpeg skips in 96.972 seconds; four capture checks passed in 77.574 ms. It checked 33 browser scripts,
2,986 selected Arabic messages and 286 documents. All tracked report bytes remained unchanged during validation.
The manifest includes 1,617 public source files plus one generated empty sample; source hash
09d03302b2ddc8e3ac997e4d33f9d0f4cfe7dbb27b3067c96302ecb0004d8410. This preflight precedes its own recorded
qualification paragraph; exact committed-source qualification follows before the sole push.

FFmpeg and Docker are unavailable locally. New CI must establish full FFmpeg/container acceptance for this
revision; previous CI174 acceptance applies only to the earlier candidate and did not cover tracked report drift.
Neither local checks nor CI establish Railway deployment recovery.

Follow-up recorded with batch 121: exact committed source d91cfd7 passed all five local stages while preserving
every tracked report byte (3,868 total / 3,863 pass / zero fail / five FFmpeg skips; 95.230 seconds).
[CI175](https://github.com/magdyezy1/CAMCP/actions/runs/37133836674) then passed tracked report freshness, all 3,868
tests on both host and Docker without failures or skips, four capture checks, Railway compatibility and both
synthetic container smoke modes. Host/Docker suite durations were 1008.502/1001.976 seconds. This verifies this
revision's build checks; deployment health was not inspected.
