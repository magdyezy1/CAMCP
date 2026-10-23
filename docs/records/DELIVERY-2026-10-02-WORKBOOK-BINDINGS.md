# Scoped workbook setup and reviewed local names — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `d03fc32`. Batch 77 extends B13/B15 and repairs F-149.

Operations now links to Workbook setup: search saved associations, filter by exact spreadsheet ID, follow pages,
inspect the original record and open its linked queries. The English/Arabic UI and MCP show current local scope
without implying that Google Sheets access was verified. Stored URLs, private preferences and query configurations
are not projected. No external spreadsheet call is made. List names longer than 160 characters are visibly shortened;
detail names beyond 2,000 characters are explicitly omitted. IDs remain exact.

Every linked query must be currently accessible, including its provider/account/login. Empty associations remain
creator/admin-only. Each list call scans at most 50 records and returns a continuation even after an empty filtered
page. The existing maximum of 500 linked queries is preserved; details show the first 100 with total/truncation.
Readers inspect; operators review and confirm a local name in 1–120 single-line characters. The transaction rechecks
a version covering the association and all query revisions, changes only its name/update metadata and writes a
bounded audit event. Existing IDs, preferences, query definitions, schedules, report runs and job counts are unchanged.

Website edits invalidate previews and pending confirmation. Async results/errors belong to the original view and
identity. Inspection also exposed F-149 in the shared page loader: identity changes alone did not suppress old
responses. A red regression preceded the route/request/identity/DOM guard and the early obsolete-handler check.
This is controller evidence, not proof of a deployed cross-user incident or browser acceptance.

Twelve new tests cover scoped discovery, current linked access, creator/admin-only empty setup, reader restrictions,
oversized legacy records, exact versions, no hidden settings, malformed inputs, English/Arabic submission parity,
edited/departed views and the real-SDK handoff. Six backend tests and the shared-identity regression were observed
red; three controller tests initially failed because their module did not exist. The focused group passed **40/40**.
The synthetic real-SDK discovery/inspect/preview/save journey used **4 calls, 5,115 structured response bytes and
zero provider requests**. Full/sanitized qualification is recorded below and in [PROGRESS.md](PROGRESS.md).
Logs: `.runtime/workbook-bindings-20261002/`.

Native ledgers remain **3,247 actions / 167 families / 1,712 native reads / 800 reviewed writes / 502 blocked writes**.
The blueprint remains **13 implemented / 14 partial / 1 open**. Binding rebinding/retirement, complete audit telemetry
and historical opaque-scope adapters remain under B13. No new dependency, migration, provider mutation, OAuth
expansion, external message, production deployment or private-root-sample read is introduced.

Batch 76 follow-through: exact HEAD `d03fc3218bcdbf23280a83935c2e02f9501c502b` passed every check/Railway stage
in `.release/artifact-localization-work-here-head-20261001`: **3,352 passed, zero failed, five local FFmpeg skips;
79.45 seconds**, four capture tests and byte parity for **1,469 public source files** plus one generated empty sample.
Hash: `d382897bf948cc68a21ea02dd5398de262f00a94e27c35cf8f56a95c4e0d682b`.
The sole branch push started [CI131](https://github.com/magdyezy1/CAMCP/actions/runs/36926690036), pending at the
latest check. [CI129](https://github.com/magdyezy1/CAMCP/actions/runs/36920411136) and
[CI130](https://github.com/magdyezy1/CAMCP/actions/runs/36923344150) passed on `942d957` and `1281bd9`:
host and Docker each passed **3,337** and **3,348** tests respectively, zero failures/skips, required FFmpeg,
four capture tests, Railway and both container smokes. Jobs `110564751560`/`110574508886` uploaded artifacts
`11194630390`/`11194491223`.

Final root suite: **3,369 tests; 3,364 passed, zero failed, five local FFmpeg skips; 74.33 seconds**.
Sanitized and exact committed-source qualification follows before push.

Sanitized preflight `.release/workbook-bindings-preflight-20261002` passed every check/Railway stage:
**3,364 passed, zero failed, five local FFmpeg skips; 76.62 seconds**, four capture tests, 31 browser scripts
and 243 documents. Its **1,474 public source files** plus one generated empty sample have hash
`f74ffeabc2c1e57908522da451e6731c2844d855d1d46f95f9fba8bb307cca76`. Exact committed-source checks follow before push.
