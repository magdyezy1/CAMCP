# LinkedIn conversion configuration workflow — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `a636898`. Batch 99 extends B15/B20/B24 with a read-only product workflow.

Measurement now offers an English/Arabic LinkedIn conversion-settings view. Select a current login/account and
read its configured rules, enabled state, native type, attribution model, post-click/post-view days and configured
conversion value. Exact IDs and decimal strings are preserved. Omitted native settings remain unknown; the view
does not silently apply provider defaults. Search rule names/IDs/types locally and page 50 rows at a time without
another provider request. Native text is escaped and mixed-direction IDs/values keep their original order.
Input, identity or navigation changes invalidate pending results and old callbacks; malformed or duplicate
projected rows never render as valid configuration. Keyboard focus moves to the result or page status.

MCP exposes `amcp_workspace {action:measurement_conversions,gateway:linkedin_native_action,account_id,connection_id}`.
Its website handoff contains the exact login/account and preselects only a currently available match, with no
automatic read. Duplicate or unavailable link scope is refused. Conversion links do not overwrite GTM audit scope.
This action requires an existing `r_ads` or `rw_ads` permission; it creates no new grant or write contract.

Collection verifies exact native account identity/currency before and after bounded account-filtered GET pages.
Current actor, selected account/login, credentials and sorted scopes are checked around each await. The limits
are 1,000 rules, 25 pages, 30 native requests, 8 MiB and 60 seconds. Full pages without a total require a terminal
probe. Count presence/total, offsets, next-link account/route/page size and duplicate IDs must remain consistent.
The original scoped request is rebuilt for each page; provider links are not followed. Every account/page read
keeps a source request/hash/time reference. No partial table is returned after changed access or incomplete data.
An explicitly empty completed collection is valid. The result spans several reads, not a point-in-time snapshot.

The native account finder now qualifies this exact collection shape through ScopeGuard. Unknown shapes still
need their existing ownership/provisioning authority. A regression preserves explicitly administrator-provisioned
reads outside the new shortcut. Single/global conversion objects and advertising mutations gain no authority.

Source fields and account finder were checked against official [Conversion Tracking](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversion-tracking?view=li-lms-2026-09),
[account reads](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-accounts?view=li-lms-2026-09)
and [offset pagination](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/pagination), using the
repository's current 202609 request version. The read projection accepts observed 0–365-day windows without
expanding the existing reviewed-write subset. It withholds URL rules, pixel HTML, callbacks, campaign membership
and unrelated billing fields. Configured conversion value is a rule setting, not advertising spend or observed revenue.

Event delivery, deduplication, runtime consent and historical report attribution remain unverified. Current rule
settings do not establish what settings applied to earlier report dates. The workflow sends no test event,
changes no rule, saves no snapshot and performs no automatic campaign association. Existing reviewed conversion
create/update/link contracts remain separate and retain their native review/read-back controls.

Fifteen new tests include nine backend cases, five website cases and one real-SDK journey. Five backend and four
website cases were observed red before initial implementation; three more review regressions were observed red
before fixing the provisioning fallback, continuation page-size check and UI projection validation. Tests preserve
the final exact rule at 1,000 rows and refuse 1,001, changing totals, duplicate identities, malformed values and
revoked authority. Focused conversion/scope/UI checks passed **106/106**. The SDK journey passed **four schema-validated
calls / 6,970 structured response bytes / six synthetic native GETs / zero mutations**; refused wrong-account and
revoked-key calls added no egress. Its exact scoped website link and empty collection also passed.

Root regression: **3,575 tests / 3,570 passed / zero failed / five local FFmpeg skips; 89.35 seconds**.
Static checks cover 32 browser scripts and 2,724 selected Arabic messages. Evidence: `.runtime/linkedin-conversion-evidence-20261002/`.
Synthetic transport, VM and SDK checks do not establish actual-browser, assistive-technology, live-provider or deployed acceptance.

Batch 98 exact committed-source checks and Railway passed on `a636898`: **3,555 passed / zero failed / five local
FFmpeg skips; 88.67 seconds**, four capture tests, **1,538 public files + one generated empty sample**; source hash
`7dce807cbdb98dddc92759d4ae77fb0b5e974db230ccba0ca44524e96ed96712`.
It was pushed only to Work-here. [CI153](https://github.com/magdyezy1/CAMCP/actions/runs/36965119798) and retained-row
search [CI152](https://github.com/magdyezy1/CAMCP/actions/runs/36963993287) were still running when checked.

Meta integrity [CI151](https://github.com/magdyezy1/CAMCP/actions/runs/36962798743) succeeded on `68ae066`: host
and Docker each **3,539 passed / zero failed/skipped**, required FFmpeg, four capture tests, Railway and both container
smokes; job `110699952228`, release-evidence artifact `11209213758`.

Native ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
Blueprint remains **13 implemented / 14 partial / 1 open**. This adds usable configuration inspection without
claiming historical attribution, live event qualification or completion of the other measurement/provider packages.

Sanitized preflight `.release/linkedin-conversion-evidence-preflight-20261002` passed all stages and Railway:
**3,570 passed / zero failed / five local FFmpeg skips; 89.62 seconds**, four capture tests,
32 browser scripts, 2,724 selected Arabic messages and 265 documents. Its **1,541 public source files**
plus one generated empty sample have hash `09f9ca5c8734c2e39d593a64a55458836e3141ab992e3f0550d891ab8d3d0e51`.
Exact committed-source qualification follows before the sole Work-here push.
