---
status: record
tier: engineering
---

# Capability, creative library and report delivery — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `8a78091`. Implementation: `8f4a83a`. Batch 52 advances B08, B10, B15, B22, B23 and B28. The
[implementation matrix](../review/IMPLEMENTATION-2026-10-01.md) retains the unfinished expansion scope.

## Connected workflow

Capability discovery now filters by exact workflow, account and login. It exposes dependency nodes, native action
contracts and their registered review families/evidence, and concrete draft/preflight/review/execute/verify/recover
handoffs. Recipe contracts are checked against the compiled plan. A dated account-read result expires after
15 minutes and is invalidated by changed connection metadata or credentials. Neither that observation nor recorded
OAuth scopes establishes provider objective eligibility. Missing, stale and no-longer-current evidence remain explicit.

Creative starts with a durable metadata library: search, platform/account/login/tag filters, internal names and tags,
native media IDs, original/uploaded hashes when available, transformation dimensions and retained plan usage.
Plan usage requires verified media and dependent creative/ad steps connected through actual value references;
`depends_on` alone is not usage evidence. Usage is paginated, scoped to the actor's accessible original plans and
links to those plans. Arbitrary arguments, Drive URLs, encrypted actor bindings and provider receipts are withheld.
Unknown external use and absent performance joins are labeled explicitly.

Names/tags require operator authority, explicit confirmation and the current metadata revision, with an atomic
audit record. The provider object and original upload receipt remain unchanged. Every page rechecks current access,
and cursors bind identity/session/filters. SQLite projects metadata from at most 500 candidates per library page;
the response holds at most 100. Usage pages examine at most 100 plans and return at most 20. These are application
processing bounds, not a SQL scan-cost guarantee. Expired originals remain unavailable: this adds no binary storage
retention, consent expansion or automatic upload replay. Reuse retains its fresh provider-availability check.

Client report packs generate authenticated PDF and Excel downloads in addition to HTML and print preview. A
confirmed, revisioned presentation editor saves a client brand, six-digit accent color, footer and standard/compact
layout. All source accounts must remain accessible. Download routes recheck the session, full source access and
snapshot/presentation revisions after generation. Presentation metadata follows snapshot deletion and retention.
The server keeps no generated file archive and sends `Cache-Control: no-store`.

PDF embeds its Latin/Arabic font and attaches the source-evidence JSON. Unsupported glyphs fail explicitly instead
of producing silent missing text. Excel has five formatted sheets, frozen headings, numeric formats and exact
source evidence split into ordered text chunks. Names beginning with formula characters remain literal strings;
leading-zero IDs remain text; numeric metrics remain numbers and unknown values remain blank. Summaries preserve
currency, timezone, attribution, result definition and period boundaries. Values are retained measurements, and the
workbook explains that editing raw rows does not recalculate saved summaries. No provider read or mutation occurs.

## Generation bounds and dependencies

| Bound | Value |
|---|---:|
| Workbook rows | 25,000 |
| Estimated workbook cells | 500,000 |
| Aggregate workbook string bytes | 32 MiB |
| Individual Excel cell | 32,767 characters |
| Source evidence JSON | 2 MiB |
| PDF measurement groups | 500 |
| Generated output | 20 MiB |
| Concurrent artifact jobs | Two per process; one per tenant |

Excel writes and commits rows incrementally, yields every 250 rows, disables shared-string accumulation and retains
only the bounded compressed output. A single paired synthetic measurement with 5,000 rows/two summary groups
compared the initial in-memory writer with streaming: peak RSS **351,556 KiB → 130,252 KiB**, generation
**846.43 → 655.40 ms**, output **480,337 → 648,990 bytes**. This demonstrates lower peak memory for that fixture,
not production capacity, percentile latency, multi-tenant isolation or a general speed guarantee.

Runtime additions are pinned `exceljs@4.4.0`, `pdfkit@0.20.2` and `fontkit@2.0.4`. ExcelJS's UUID dependency is
overridden to compatible `11.1.1` to avoid the older dependency advisory. Noto Sans Arabic is bundled with its SIL
Open Font License and source record. No network font fetch or remote logo embedding happens during rendering.
Primary implementation references: [ExcelJS 4.4.0 streaming writer](https://github.com/exceljs/exceljs/blob/v4.4.0/README.md#streaming-xlsx),
[PDFKit text/fonts](https://pdfkit.org/docs/text.html), [PDF attachments](https://pdfkit.org/docs/attachments.html),
[Fontkit glyph coverage](https://github.com/foliojs/fontkit), and
[Google Fonts Noto Sans Arabic](https://github.com/google/fonts/tree/main/ofl/notosansarabic).

## Evidence and remaining acceptance

Red tests established missing library/artifact actions and routes and a PDF footer defect that produced extra pages.
Green tests cover scoped metadata, 505 inaccessible candidates, identity-bound cursors, revision conflicts, verified
usage versus dependency order, native IDs, source expiry, download access revocation after generation, concurrency,
retention, literal spreadsheet values and generation limits. The real MCP SDK journey validates advertised schemas
and text/structured results across capability → asset → annotation → report presentation, with six calls, about
25.3 KB of structured results and zero provider requests. It is not external-client acceptance or measured token savings.

Browser checks used the synthetic in-memory fixture, desktop 1280×900 and mobile 390×844. Capability filters/details,
library search/annotation/usage and report branding/layout/download preparation worked without console errors.
Responsive toolbar wrapping was repaired; mobile content width remained 375 px within the 375 px viewport.
Excel was reopened with ExcelJS and openpyxl. The two-page PDF was rendered with Poppler and visually inspected,
including Arabic content. `pdfplumber` extracted Latin text correctly; this is not PDF/UA certification or universal
text-extractor compatibility. The in-app browser's download-event API timed out even though each button reported
successful preparation; HTTP download bytes, file parsing and rendering were verified separately. Browser file-save
handoff remains independently unverified. Screenshots/logs are in ignored `.runtime/continuation-20261001/`.

Release qualification is recorded in [PROGRESS.md](PROGRESS.md). Baseline
[CI106](https://github.com/magdyezy1/CAMCP/actions/runs/36832504171) succeeded on `8a78091`: host and Docker each
passed 3,109 tests without failures or skips, including required FFmpeg, container smoke, Railway and evidence upload.
Those results do not substitute for this batch's new-revision CI. No live provider, real credential, production
deployment, external notification or DNS change occurred. Reusable branding templates, scheduled file delivery,
permanent source storage, external creative use/performance joins and objective-specific eligibility remain open.
