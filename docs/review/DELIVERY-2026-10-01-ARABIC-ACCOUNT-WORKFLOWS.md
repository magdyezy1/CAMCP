# Arabic account workflows and current-form isolation — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `680fac7`. Implementation: `89ee05f`. Batch 68 extends B24 and closes a reproduced B02 workflow gap.

The Google/Meta portfolio, GTM configuration audit and reviewed Meta product-import controls now use Arabic
display copy. Portfolio navigation retains native campaign/ad-group/ad-set/ad identities and continuation tokens;
money remains in its original integer/micros units. Native money field names are displayed exactly rather than
prettified. Currency, statuses, provider evidence, CSV column names, precise values, URLs and user names remain
original data. The import plan's default name and create-only choice are unchanged. Technical input fields use LTR
isolation; this increment changes no provider contracts, backend access policy or media/product eligibility.

**F-141:** the original `680fac7` measurement/product controllers could render a late result or error after a new
route, identity or form selection. A slow product-file read could still send its preview after identity change;
an obsolete preview could save a local plan, and its late save could navigate the newer page. Five scenario tests
were reproduced against the original controller saved in an ignored baseline harness. The controllers now bind
each attempt to the rendered form, result node, navigation/identity generations and a monotonically increasing
sequence. Input/change events and new submissions invalidate previous previews. Current errors still propagate;
stale responses/errors disappear, obsolete plan handlers send nothing, and departed saves cannot redirect.
Import settings are captured before asynchronous file reading, preventing mixed old-file/new-form requests.

Eight new tests were observed red across the baseline and language checks. They cover successful and rejected
late reads, local file delays, obsolete save handlers, latest-response ordering, current errors and English/Arabic
request equality. Exact account/configuration IDs, CSV decimal strings, the upsert boolean, portfolio hierarchy,
native money above JavaScript's safe integer range and original cursors are preserved. Two existing isolated
fixtures now load the real language module with their assertions intact. The related group passed **23/23**.
The catalog contains **2,184 messages**, with **2,088 required source messages**.
The complete suite passed **3,288 tests: 3,283 passed, zero failed, five local FFmpeg skips; 73.76 seconds**.
Fresh sanitized preflight passed all check/Railway stages: **3,283 passed, zero failed, five local FFmpeg skips;
78.81 seconds**, four capture tests, 29 browser scripts and 234 documents. The 1,443 public source files plus one
generated empty sample have hash `d068fd2125801fb4b3559ba57f7f55c6961d01e9deba51f60de2c9c107b9ba51`.

Full suite and sanitized/exact-HEAD evidence are recorded in [PROGRESS.md](PROGRESS.md). Ignored diagnostic logs
are in `.runtime/account-localization-20261001/`. Browser/keyboard/assistive-technology acceptance remains
unverified because CUA cannot initialize its kernel-assets path. The matrix remains **13 implemented / 14 partial /
1 open**; client/report-pack, detailed evidence/allocation and analytical explanation translation still continue.

Batch 67 follow-through: exact HEAD `680fac7c3e98bee216b8a3476574a8fc9e020b5d` qualified in
`.release/reporting-localization-work-here-head-20261001`: **3,275 passed, zero failed, five local FFmpeg skips;
76.94 seconds**, four capture tests and all check/Railway stages. Its **1,441 public source files** matched HEAD
bytes plus one generated empty sample; source-tree hash
`3fd6a1d1e943d64d0eef705db8cda04f328b0283011cdfc51c000a088e3e5b62`. The first full run correctly refused a
corrupt backup but failed its staging-folder cleanup assertion; the unchanged 14-test backup group and then full
release rerun passed. This transient cleanup result is recorded, not described as a repaired backup defect.
The sole branch push started [CI122](https://github.com/magdyezy1/CAMCP/actions/runs/36904291286), pending at this
record's latest check. These local checks do not certify production or live provider behavior.
