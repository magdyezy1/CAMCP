# CSV reference import with explicit measurement settings — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `942d957`. Batch 75 extends B18 and the English/Arabic comparison workflow.

The Reports page imports CSV/TSV aggregate references directly in the browser. UTF-8 and BOM-marked UTF-16
are decoded strictly, with a 64 KiB limit, at most 64 unique named columns and exactly one totals row. Users
choose the delimiter, decimal separator, mapped metrics and each money column's currency/hundredths/micros
scale. Exact integer arithmetic preserves large decimals and rejects excessive precision instead of rounding.
Missing selected cells stay unknown. Duplicate mappings, grouping characters, formulas, malformed quoting,
invalid encodings and multirow details/repeated totals are refused.

The preview shows normalized totals before comparison. Account, currency, timezone, dates, attribution,
conversion definition and reporting grain are explicitly declared from the source, with unchecked acknowledgements
for complete coverage and matching entities/filters. Edits invalidate the preview and those acknowledgements.
Late file reads or failures cannot repopulate a changed form or identity. The existing result sequence also fences
comparison results. Selected column names and values are escaped; original byte hashing does not upload the file.

Only mapped additive totals, selected column names, declared settings and bounded file provenance reach AMCP.
Raw bytes, unmapped values and the filename stay local. `reconcile` checks declarations against known guided or
Overview evidence, records the retained source hash and preserves exact differences. Context and file metadata
can also be supplied through MCP. `independently_verified:false` and `file_hash_verified_by_server:false` are
explicit: neither source attribution nor file bytes, entities or filters have been independently fetched/verified.
The timestamp is the import comparison time. Imported references do not become report sources for recommendations.

Eleven feature tests were observed failing before implementation; the related group passed **25/25**. Cases
include all three encodings, original-byte hashes, large decimals, currency scaling, unknowns, malformed/oversized
inputs, declared-context refusal, current-result integration and English/Arabic controller behavior. The full local
suite passed **3,348 tests; 3,343 passed, zero failed, five local FFmpeg skips; 71.91 seconds**. All transports are
synthetic; this does not establish a provider export match. Logs: `.runtime/reference-import-20261001/`.
Sanitized and exact-source qualification is recorded in [PROGRESS.md](PROGRESS.md).
Preflight `.release/reference-import-preflight-20261001` passed every check/Railway stage: **3,343 passed,
zero failed, five local FFmpeg skips; 76.17 seconds**, four capture tests, 30 browser scripts and 241 documents.
Its **1,463 public source files** plus one generated empty sample have hash
`2575a054e5d125f1fc0734c18ef39c835fac07d3cf1fa9bc71fd69645ce15518`. Exact committed-source checks follow before push.

Native ledgers remain **3,247 actions / 167 families / 1,712 native reads / 800 reviewed writes / 502 blocked writes**.
There is no new dependency, migration, provider mutation, OAuth permission, external message or deployment.
The private root sample was not read. Static/controller checks do not establish browser or assistive-technology
acceptance. Granular external exports, additional native providers/dimensions and independent conversion-window
qualification remain under B18; the blueprint matrix remains **13 implemented / 14 partial / 1 open**.

Batch 74 follow-through: exact HEAD `942d957bdb481e60426fd9efce1f3da050f8d66e` passed every check/Railway stage
in `.release/report-reconciliation-work-here-head-20261001`: **3,332 passed, zero failed, five local FFmpeg skips;
80.26 seconds**, four capture tests and byte parity for **1,458 public source files** plus one generated empty sample.
Hash: `56f9f3060ef8a0072f9550f6da01804f49e0fc390f2125a79f3f75328669de18`.
The sole branch push started [CI129](https://github.com/magdyezy1/CAMCP/actions/runs/36920411136), pending at the
latest check, as is CI128. [CI127](https://github.com/magdyezy1/CAMCP/actions/runs/36915865450) passed on `588b0b3`:
host and Docker each passed **3,319 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and
both container smokes. Job `110549549942` uploaded artifact `11190677989`.
