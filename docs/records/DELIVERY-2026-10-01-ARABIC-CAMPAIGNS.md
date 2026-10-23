# Arabic campaign and creative workflows — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `6bda0ad`. Implementation: `f8951a0`. Batch 65 extends B24 and corrects the queued-upload display in B10/B22.

## Delivered workflow

Campaign creation now exposes Arabic field labels, explicit attribution/political-category choices, recipe
discovery, approval prompts, execution acknowledgements, amendments, read-back comparisons and clone guidance.
All five executable recipe names/descriptions are translated. Discovery searches both original and translated
names without changing workflow IDs. Lifecycle and account-read evidence copy retains the distinction between
local prerequisites and current provider acceptance.

Creative upload, Drive selection, destination selection, source inspection, resumable plans, recovery, the media
library and existing-ad preview controls now use Arabic interface copy. Upload progress and confirmations use
whole messages with checked interpolation slots. Names, tags, IDs, source hashes, user ad copy, money strings,
native units/enums, stored plan names/briefs and provider diagnostics retain their original values. Default media
names remain native values. Both per-step and whole-plan approvals start unchecked and bind the same frozen
request, original account, displayed plan hash and execution requirements in either language.

RTL styles align review/upload tables and list indentation. Money, currency, URN, ad-ID and native JSON controls
retain LTR isolation. Visual, keyboard and assistive-technology acceptance remains unverified because the CUA
kernel-assets initialization failure prevents browser use. The seven new tests execute real controllers with
synthetic DOM/transport adapters; they are not browser acceptance or live-provider evidence.

## Reproduced correction

F-140: `bindCreativePush` treated every non-processing result as uploaded, including the backend's durable queued
result. The regression against the original `6bda0ad` controller displays **Uploaded** for `{state:'queued'}`.
Queued work now retains its queued state and original-review recovery link. The test requires explicit unchecked
consent before submission, the exact source hash/account/review and identical English/Arabic request transcripts.
It proves the UI makes no additional submission to obtain a status display.

## Verification and remaining scope

The catalog contains **1,450 messages**, covering **1,349 required source messages**. Checks include authored
server-side discovery/lifecycle sentences and executable recipe definitions. A new red/green source guard prevents
translation of form defaults/types/native field names. This caught a default-value authoring hazard before delivery.
Technical placeholders, response data and native control comparisons remain outside translation.

Seven new feature/regression tests were observed red before their implementation. The combined campaign, approval,
connection and localization group passed **27/27**. The first full run exposed three isolated test fixtures that
did not load the language module; they now load the real module with the original assertions unchanged. Those
three pass, and the complete rerun passed **3,269 tests; 3,264 passed, zero failed, five local FFmpeg skips;
82.24 seconds**. Fresh sanitized qualification and exact-HEAD evidence are recorded in [PROGRESS.md](PROGRESS.md).
Ignored reproduction logs are in `.runtime/campaign-localization-20261001/`.

No backend advertising contract, permission, policy, dependency or deployment was added. The matrix remains
**13 implemented / 14 partial / 1 open**. B24 still includes advanced reporting, operations and account workflows,
wider content review and actual RTL/browser acceptance. Other blueprint packages continue beyond this increment.
