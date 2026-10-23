# Tag Manager consent evidence and scoped audit handoff — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `ea4ae99`. Batch 94 extends B15/B20/B24 and repairs a reproduced backup-cleanup failure (F-155).

A scoped Tag Manager workspace audit now includes a readable per-tag additional-consent inventory, using the
existing authorized configuration reads. It distinguishes native `notSet`, `notNeeded`, `needed` and unknown
interpretation, reports explicit/defaulted settings separately, and preserves tag IDs, names, native types and
literal required consent type names. Omitted paused status stays unknown. The English/Arabic website offers
setting filters, local text search and 50-row paging across up to 1,000 tags, with accessible table markup and
page status. Controls stop repainting after audit edits, navigation, identity changes or detached results.

The projection is bounded to 4 MiB of selected metadata and at most 20 literal consent types of 100 characters
per tag. These are application interpretation limits, not asserted provider limits. Variable expressions, duplicate
names, malformed/empty required lists, unknown enum values and other encodings remain unknown and produce an
explicit finding. Arbitrary tag parameters/HTML and notes are omitted from the selected projection. Existing raw
resource access and redaction remain independent. Workspace identity/fingerprint and a digest of the selected
projection retain context; this digest is not the hash of an original native HTTP response.

The API enums and additional-check semantics follow the official
[Tag resource](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces.tags)
and [consent overview](https://support.google.com/tagmanager/answer/10718549?hl=en-gb), checked 2 October.
Literal list decoding uses the published [Parameter model](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/Parameter).
The Tag description calls the list entries STRING, while Parameter exposes template text; this adapter accepts
only bounded literal template values and leaves other encodings unknown. Native account acceptance remains unverified.
Additional settings do not establish built-in checks, consent defaults/updates, runtime order or event delivery;
all five checks explicitly stay unverified. An unset or no-additional setting is not labeled a consent failure or
success. These are workspace observations, not a published-version snapshot or compliance verdict. No repairs,
publications, test events or new retained consent snapshot are created.

The first-party `measurement_audit` response now has a typed record kind and explicit scope. Its MCP outcome links
to `/measurement` with the exact login/account/container/workspace. The website only preselects a currently
available exact account; repeated parameters, invalid IDs, missing parents or withdrawn bindings leave it
unselected. Opening the link does not automatically read or mutate anything; the operator requests fresh evidence.
A real-SDK synthetic journey completed three schema-validated calls, **4,977 structured response bytes** in the
recorded run and **22 native GETs**, zero provider mutations. Wrong-account and revoked-session calls add no egress.

Ten new consent/handoff cases were observed red before implementation. Focused **124/124** passed, including
current scopes, omitted private canaries, native/Arabic parity, paging/search/filtering, malformed evidence,
1,000-tag bounds, departed controls and the SDK handoff. Static checks cover **32 browser scripts / 2,685 selected
Arabic messages**. VM/static/native-fixture evidence is not actual-browser, assistive-technology or provider acceptance.

Full regression exposed a recurring Windows staging-directory EPERM replacing the original invalid-audit error.
F-155 changes backup cleanup to six bounded asynchronous attempts, yielding up to 750 ms of retry backoff and
rechecking the named staging path before each removal. Permanent failure reports `BACKUP_CLEANUP_FAILED`, the
exact private staging directory, original verification error code and whether the operation completed. A published
restore remains intact; callers can distinguish that outcome before retrying. Cleanup failures are never silently
ignored. The actual OS lock holder was not identified, so this does not claim to eliminate every Windows lock.
Two injected cleanup cases were observed red; **17/17 backup tests** now pass, including post-publication failure.
The first root failure is retained at `.runtime/gtm-consent-20261002/root-tests-cleanup-failure.log`.
After repair, root regression passed **3,521 tests / 3,516 passed / zero failed / five local FFmpeg skips; 74.37 seconds**.
Evidence: `.runtime/gtm-consent-20261002/`.

Batch 93 exact committed-source checks and Railway passed on `ea4ae99`: **3,503 passed / zero failed / five local
FFmpeg skips; 79.90 seconds**, four capture tests, **1,524 public files + one generated empty sample**;
source hash `94b45406b86a5cac318408c424ad0a8a82f23919dbb4ddb75ed2b088f030ae7c`.
[CI148](https://github.com/magdyezy1/CAMCP/actions/runs/36957813743) and
[CI147](https://github.com/magdyezy1/CAMCP/actions/runs/36956104150) were running when checked.
TikTok completeness [CI146](https://github.com/magdyezy1/CAMCP/actions/runs/36954874286) succeeded on `e9c8116`:
host/Docker each **3,492 passed / zero failed/skipped**, required FFmpeg, four capture tests, Railway and both
container smokes; job `110675508136`, artifact `11206985108`.

The native ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
The blueprint remains **13 implemented / 14 partial / 1 open**. Runtime measurement, reviewed repair workflows,
provider qualification and broader accessibility remain tracked separately.

Sanitized preflight `.release/gtm-consent-preflight-20261002` passed every check and Railway stage:
**3,516 passed / zero failed / five local FFmpeg skips; 77.75 seconds**, four capture tests, 32 browser scripts
and 260 documents. Its **1,528 public source files** plus one generated empty sample have hash
`a097b3292097f7a52374812a9e6f0f7c50567ca09d454d033e8423f523d9066d`. Exact committed-source checks follow before push.
