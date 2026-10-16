# Sheets delivery acceptance on a disposable spreadsheet

The owner-run acceptance of Google Sheets delivery (ACC-03): one bounded export and three hourly scheduled deliveries
to a disposable spreadsheet that AMCP creates under `drive.file`, on the deployed revision. Until it runs, every Sheets
claim rests on fetch stubs (`node tools/acceptance/sheets-delivery.mjs synthetic` runs those suites). Nothing here has
been run live ([rules for every run](README.md)).

## Before the run (owner)

1. Authorize it in writing: one bounded export plus three hourly scheduled occurrences to a disposable AMCP-created
   spreadsheet (owner decision R3), with a reference such as `owner-auth-2026-10-21-sheets`. Record it in the provider
   access register (`sheets` → `disposable_spreadsheet`).
2. Connect a Google Sheets login in Connections that grants `drive.file`. The last recorded check found Sheets
   disconnected.
3. Choose a synthetic-safe report: an owned account with no client data, or a public test property. The file lives in
   the owner's Drive, so it must hold no client data.
4. Read Google's current Sheets API usage limits on the day of the run and note the per-user per-minute figure; the
   review's 60 requests per minute per user is not assumed. AMCP keeps its own project budget below 300 per minute.
5. `node tools/acceptance/sheets-delivery.mjs template > sheets-<date>.json` gives the blank evidence record. Name the
   spreadsheet by an owner label (`sheets-disposable-a`); its ID and URL stay in the owner's private evidence store.

## The run (deployed revision)

| Step | Do | Pass when |
|---|---|---|
| 1. `create_bind` | In Reporting → Sheets & schedules, create a new spreadsheet with AMCP (an administrator confirms), and bind a report tab | AMCP created the file under `drive.file`; it is never a client file |
| 2. `export` | Export one complete snapshot to the tab | The delivery receipt exists; note its write and read request counts and elapsed time (Activity and the receipt) |
| 3. `typed_cells` | Open the tab | A text value such as `=1+1` stayed text, metric columns are number cells, and the tab's delivery marker equals the snapshot's fingerprint (`marker_sha256`) |
| 4. `replay` | Export the same snapshot again | AMCP returns the historical receipt and writes nothing (`writes: 0`) |
| 5. `schedule` | Create an hourly schedule to the same tab; wait for three occurrences | Three deliveries, each with its receipt, request count and time |
| 6. `deselect` | Remove the spreadsheet from the login's selected files, then export | AMCP refuses before writing; record the refusal's code |
| 7. `revoke` | Revoke the Sheets login at Google, then export | AMCP answers `REAUTHORIZATION_REQUIRED` |
| 8. `request_counts` | From the receipts and Activity | The most requests in any one minute stays within the per-user limit you read |
| 9. `forced_timeout` | Only if you choose to: force a client-side timeout on one export | The delivery stays `uncertain`, is reconciled by its marker and resent once after the 10-minute settle window (owner decision D11); otherwise record `skipped` with the reason. The lost-response drills stay local in `tests/sheets-authority.test.mjs` |

Then the owner confirms by hand that the tab content is right (`manual.tab_content_confirmed`) and that every other tab
of the file is untouched (`manual.other_tabs_untouched`), and deletes the disposable file in Drive
(`manual.file_deleted_after`). Store sanitized receipts only, under `.runtime/`, never cell values.

## Recording

`node tools/acceptance/sheets-delivery.mjs check sheets-<date>.json --out sheets-<date>-rows.json` validates the
record and, when every required step passed and the owner confirmed both tabs, writes two acceptance ledger rows (the
export and the scheduled delivery) that carry receipt references and the marker digest only. Then
`node tools/acceptance/ledger.mjs add sheets-<date>-rows.json` and `node tools/acceptance/provider-access.mjs`. A
failed step makes the run `refused` and records no row; fix the defect it found before running again. The measured
requests and elapsed time per export and per occurrence become the reference for client deliveries.

## Remaining (not in this repository)

- The owner's authorization (R3), a connected Sheets login and the deployed run itself.
- The owner's manual confirmation of the tabs and the deletion of the disposable file.
