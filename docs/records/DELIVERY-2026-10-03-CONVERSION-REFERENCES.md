# Delivery — guided conversion references and complete playbook preview

Date: 2026-10-03. Baseline: `31c2607`. Repository/branch: `magdyezy1/CAMCP`, `Work-here`.

## Delivered behavior

Client playbooks now offer a guided editor for up to 50 named text conversion references. Exact IDs and
resource names remain strings, including `9007199254740993`. Goal names are bounded to 80 characters and
references to 2,048; duplicate names, partial rows, control characters and collisions with Advanced mappings
are refused before a preview/save request. Empty newly added rows supply no mapping.

Existing structured, numeric, multiline, unusual and excess mappings remain in Advanced JSON with their
original types and values. Guided and Advanced entries are merged for the existing profile contract. The
editor never silently truncates an existing mapping set. Add/remove actions are local, clear approval and
preview, focus the adjacent/new field and cannot edit another loaded profile through an obsolete callback.

The Google Search Maximize Clicks recipe now exposes its existing `cpc_bid_ceiling` profile default. The
resolved preview displays all returned campaign defaults, a readable exact conversion-reference table and
an escaped disclosure for other mappings. Conversion references are reusable declarations: this work neither
verifies provider ownership/event delivery nor injects them into native campaign requests. Existing preflight,
current authority, revision approval and bound-account rules continue to apply.

English/Arabic labels cover the new controls and messages, UTM labels and the exact known first-party preview
explanation. Native names, request paths, unknown diagnostic explanations, decimal strings and resource IDs
are preserved. Translation does not reinterpret native fields or alter stored values.

## Browser, layout and preservation evidence

The actual local website fixture uses an in-memory database and a fake transport that refuses every provider
request. It selects a synthetic Google login/account, opens an approved profile, previews defaults and saves
then reopens revision 2. The observed purchase ID, lead resource, CPC ceiling `2.000001`, structured legacy
`id:"001"` / `value:"0012.34"`, and multiline reference all remain exact. A guided/Advanced name collision
produces the stated refusal. Keyboard Enter adds/removes a row, clears approval and focuses the correct field;
the named preview region and complex-mapping disclosure are keyboard reachable.

Desktop 1280 × 900 observations in both languages show a wider editor with the client list retained beside it.
At 390 × 844, the initial English preview widened the document to 540 px against a 375 px client width.
Scoped grid/form/fieldset minimum widths and wrapping repair this to **375/375 px** in both languages. The
conversion table fits its **297/297 px** content/scroll width. The generic native field/value table retains
contained horizontal scrolling. Arabic disclosure shows the preserved structured/multiline JSON without
changing its source. These are synthetic browser and keyboard observations; independent assistive technology,
full Arabic editorial review, deployed acceptance and live provider behavior remain separate.

Screenshots and structured evidence are retained locally under `.runtime/conversion-reference-editor-20261003/`.
The initial fixture used the wrong gateway name; correcting it to the existing `google_ads_native_action`
restored the selected connection. The final browser evidence uses that corrected fixture. No live credentials,
provider requests, ad changes or production configuration were involved.

## Regression and release evidence

Initial guided-editor red: **four failed / ten passed**. Additional regressions reproduced the missing CPC
default and incomplete resolved preview before their fixes. Final focused check: **26 passed / zero failed**.
Root full suite: **3,734 tests / 3,729 passed / zero failed / five local FFmpeg skips; 92.32 seconds**. Subsequent
cosmetic layout refinements and fixture/catalog corrections are included in the final sanitized release checks.
All **33 scripts**, **2,901 selected Arabic messages** and **3,034 catalog entries** pass their checks.
No backend/native contract, dependency or database migration was added.

Batch 110's exact committed `31c2607ea72f6538a54d2cc8bf963a025deba3d8` candidate passed install/build/report/check/Railway:
**3,721 passed / zero failed / five local FFmpeg skips; 91.17 seconds**, four capture checks, **1,577 public sources
plus one generated empty sample**, hash `7b3280f24f8cf33f70f1d1d485c23d23c4ea3107f596960d7d0166651a4fd205`.
It was pushed only to `Work-here`. [CI165](https://github.com/magdyezy1/CAMCP/actions/runs/37096591446), job
`111127667857`, passed **3,726 tests without failures or skips** on host and Docker, four capture checks, Railway
and synthetic read/write container smoke. Host/container suites took 718.39/703.05 seconds. Decoded job logs
were inspected; no downloaded-artifact inspection is claimed.

The matrix remains **13 implemented / 14 partial / one open**. B14 gains guided text references and complete
default/mapping preview; structured mappings/native templates retain Advanced JSON. B16/B24 gain actual bilingual
browser evidence without claiming external acceptance. Native classification remains **3,247 actions / 167 families /
1,712 reads / 800 reviewed writes / 502 blocked writes**. Sanitized qualification follows below when complete.


Sanitized preflight `.release/conversion-reference-editor-preflight-20261003` passed install/build/report/check/Railway: **3,734 tests / 3,729 passed / zero failed / five local FFmpeg skips; 95.51 seconds**, four capture checks, 33 scripts, 2,901 selected Arabic messages and 277 documents. **1579 public sources plus one generated empty sample** have hash `bc4160bd14a2e2d131e4974016968a9fe3ffd55856c5dff5bba2c74b40fd4dc6`. Exact committed-source qualification follows before the sole Work-here push.
