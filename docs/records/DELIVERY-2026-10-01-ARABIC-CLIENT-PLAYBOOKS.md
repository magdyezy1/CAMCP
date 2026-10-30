---
status: record
tier: engineering
---

# Arabic client playbooks and reviewed branding — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `ac1be5f`. Implementation: `da5e9f9`. Batch 69 extends B24 and repairs a reproduced B02 confirmation gap.

Client playbooks and report-branding controls now support Arabic. The client list, naming and tracking guidance,
account bindings, recipe defaults, native-template preview, approval and deletion controls, report presentation
settings, compatible approved profiles and download feedback use complete translated messages. Client/brand names,
footers, native templates, variable syntax, UTM values, leading-zero amounts/IDs, color values, revisions and original
download filenames remain unchanged. Technical naming, UTM and JSON inputs use LTR isolation. English and Arabic
request transcripts match for preview, save, deletion, presentation edits and approved-brand application.

**F-142 (medium):** the original client deletion callback used mutable selection after awaiting confirmation.
Switching to another client while the first client's confirmation was open could delete the second client. Old
previews and save responses could also repaint newer settings; edits did not clear approval. Original report-branding
handlers could submit after navigation/identity changes and expose late errors or replace newly selected settings.
These cases were reproduced against `ac1be5f` in an ignored original-controller harness.

Deletion now captures the original profile and revision, then checks the same selection/form/view after confirmation
before sending a request. Client changes invalidate pending previews, saves and confirmations, clear obsolete preview
content and reset approval. Approving the current settings does not clear its own checkbox. Newer previews win;
current failures remain visible. Report presentation and approved-profile saves retain the submitted revision and
consent, invalidate stale editor responses and ignore old errors. Download callbacks check current identity/view
before requesting and before opening an artifact. A save refresh cannot announce success to a different identity.
Already submitted local writes are not cancelled or repeated; a later current read retrieves their resulting state.

Nine new regression tests were observed red: eight against the original controllers and one for the final refresh
race. The related group passed **26/26**. The catalog contains **2,251 messages**, with **2,155 required source
messages**. Full-suite and sanitized/exact-HEAD evidence are recorded in [PROGRESS.md](PROGRESS.md); ignored logs
are in `.runtime/client-localization-20261001/`.
The full suite passed **3,297 tests; 3,292 passed, zero failed, five local FFmpeg skips; 77.99 seconds**.
Fresh sanitized preflight passed every check/Railway stage: **3,292 passed, zero failed, five local FFmpeg skips;
80.08 seconds**, four capture tests, 29 browser scripts and 235 documents. Its **1,445 public source files** plus
one empty sample have hash `50357ca36cf729401754063dd41ac0fb57b321f213cfa33c1e99f8ef4e215f36`.

No backend/provider contract, dependency, migration, OAuth setting, authorization policy, external message or
production deployment changed. Original snapshots keep their branding and provider data. Actual browser, keyboard
and assistive-technology acceptance remains unverified because the CUA kernel-assets path cannot initialize.
The matrix remains **13 implemented / 14 partial / 1 open**. Report-pack content, detailed evidence/allocation,
analytical explanations and the remaining blueprint work continue.

Batch 68 follow-through: exact HEAD `ac1be5fd4bc3b69fe50fc662658cc5c14e5360be` passed all check/Railway stages in
`.release/account-localization-work-here-head-20261001`: **3,283 passed, zero failed, five local FFmpeg skips;
88.49 seconds**, four capture tests and byte parity for **1,443 public source files** plus one empty sample.
Source-tree hash: `d03f3ce721135b2e1815941ddf1db855bb0802a6dcf6aac7f48eac6f74b9b820`.
Its sole branch push started [CI123](https://github.com/magdyezy1/CAMCP/actions/runs/36907141904), pending at the
latest check. [CI121](https://github.com/magdyezy1/CAMCP/actions/runs/36900882222) passed on `96da3d6`: host and
Docker each passed all **3,273 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and read/write
container smoke. Job `110499437703` uploaded artifact `11183705881`. These checks do not establish live-provider
or production acceptance.
