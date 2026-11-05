---
status: record
tier: engineering
---

# Snapchat campaign population checkpoint — 2026-11-05

The [Snapchat population implementation](IMPLEMENTATION-V2-R2-SNAPCHAT-POPULATION-2026-11-05.md) is accepted as a local
Round 2 checkpoint. Implementation commit: `75166155661308e7fb047fbcd7f1d54dcfc3fd6d`. The remaining Round 2 packages,
final publication gates, native-speaker review and owner live acceptance remain pending.

Filtered candidate `wave5-r2-snapchat-preflight-1` contained 3,329 public source files. It passed 8,426 tests in
939 selected files, with no failures, skips or cancellations, all six related freshness checks, the fast profile,
static website checks and all 58 route-size limits. The fast profile reports one existing sunset alarm; no failed
stage. No baseline, oracle, dependency or security exception was introduced.

- Source tree: `663032a302a80abffdce9515f4db1019ec51fdd27ee701ae4dedf4c5b6cc7458`.
- Runtime: `a816375a1c8e79eb0fc80631c18a9fe63e8b67bf1143d57dd51e245c68fbd295`, 2,194 files.
- English builder: 171,197 of 177,616 allowed bytes. Arabic builder: 529,699 of 601,471.
- Arabic catalog: 11,712 entries; 10,647 explicitly required messages across 37 chunks.
- All 24 named public commit inputs matched candidate bytes and passed the added-line local-path/credential scan.

Focused browser run 14 passed English and Arabic at 1280px/light and 320px/dark. Real authenticated local HTTP handlers
saved all-campaign ad-squad configurations without a scalar parent and preserved a legacy report's exact one-campaign
scope on edit. The dated native campaign-ID reference escaped provider names. Existing multi-level rollups, migration,
delivery, snapshot preservation, keyboard controls and table checks also passed. Eight pinned axe 4.14 inspections
reported no automatic violations; this is focused evidence, not full manual accessibility or assistive-technology
sign-off. Every case had zero JavaScript errors, external requests and real provider writes. Native reads and one
Sheets write per case used synthetic fixtures only.

The restricted process sandbox blocked Chromium at launch in run 13. Identical checks passed in fresh run 14 with
the required local process permission; no application code or assertion changed to accommodate that launch failure.
The restricted Git Bash startup similarly required local process permission before candidate assembly began.

Private local receipts are under `.runtime/wave5-round2/snapchat-qualification/` and
`.runtime/wave5-round2/web-source-browser-14/`. The source remained unchanged during browser qualification. Candidate
dependency junction cleanup completed and the reviewed root and rollback dependencies were preserved. No push,
Railway/deployment change, OAuth flow or live provider/Sheets request was performed.
