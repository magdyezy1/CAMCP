# Arabic account explanations and GTM findings — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `ee57b8f`. Batch 88 extends B24/B20 without changing provider contracts or request authority.

The portfolio scope explanations for Google, Meta, LinkedIn, Snapchat and TikTok, the measurement audit meaning,
and catalog preview guidance now use selected Arabic display text. GTM findings show readable translated titles
and severity while retaining the original finding code and native path. Observation limits appear as a readable
list alongside the original expandable audit evidence. This makes the difference between a configuration read
and proof of live tracking visible in the selected language.

Fifteen exact authored explanations are checked against their source fields by the locale gate. It collects only
selected `meaning` fields, GTM audit limitations and literal finding messages. Unknown provider/user text and
legacy dynamic messages are preserved, including values that happen to match unrelated interface labels.
Dynamic duplicate-name, unresolved-trigger and missing-version findings add typed `message_localization`
metadata while retaining their existing message, code, path and severity. The UI requires the expected key,
finding code, parameter type and matching original message before formatting a translation. Native trigger IDs
remain exact. Unknown, malformed or mismatched metadata falls back to the original message. HTML escaping remains
at the rendering boundary; the original structured evidence is unchanged and remains inspectable.

Six new regression cases were observed failing before implementation, then passed. Focused **40/40** passed:
all five portfolio meanings; catalog guidance with exact native price/name; GTM static/dynamic copy; live/latest
404 metadata; unknown/legacy/malformed metadata fallback; escaped provider content; original raw evidence;
English/Arabic request parity; and selective source extraction. Existing identity, navigation, input-edit and
stale-response guards also passed. The locale gate now covers **2,626 selected messages** across 32 browser scripts.
Evidence is in `.runtime/account-explanations-20261002/`. These are local fixture/VM checks; actual browser,
independent Arabic editorial, keyboard and assistive-technology acceptance remain separate.

Batch 87 exact-source checks and Railway passed on `ee57b8f`: **3,453 passed, zero failed, five local FFmpeg skips;
76.23 seconds**, plus four capture tests. Its **1,506 public files + one generated empty sample** have source hash
`3e108454f14640522283199747a9ed55939bb4c2db5af824713370dd1fd3f96b`.
[CI142](https://github.com/magdyezy1/CAMCP/actions/runs/36948487923) was running when checked.
[CI140](https://github.com/magdyezy1/CAMCP/actions/runs/36945928154) succeeded on `20ef776`: host and Docker each
passed **3,439 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and both container smokes.
Job `110647929205` uploaded release-evidence artifact `11203171943`.

The native ledger stays **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
The blueprint remains **13 implemented / 14 partial / 1 open**. No private root samples, live ad mutations,
credentials, OAuth expansion, external delivery, dependency or production deployment were used.

Root regression: **3,464 tests / 3,459 passed / zero failed / five local FFmpeg skips; 78.35 seconds**.
Sanitized preflight `.release/account-explanations-preflight-20261002` passed every check and Railway stage:
**3,459 passed, zero failed, five local FFmpeg skips; 85.13 seconds**, four capture tests, 32 browser scripts
and 254 documents. Its **1,507 public source files** plus one generated empty sample have hash
`44cf21d9c0ad06d3b1fb83dcea089d66a5d36c2d2955c11c9a485a836dbf016d`. Exact committed-source checks follow before push.
