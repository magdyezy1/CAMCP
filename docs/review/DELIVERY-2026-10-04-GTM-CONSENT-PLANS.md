# Batch 128 — guided additional-consent drafts

Only `magdyezy1/CAMCP`, branch `Work-here`, in `CAMCP-Codes-final-branch`. This continues the original
28-package roadmap. It adds an explicitly selected workflow over the existing qualified Tag Manager contract;
it does not mark the remaining roadmap complete. All test transports and accounts are synthetic.

## Result and contract boundaries

Operators can choose 1–10 original tag IDs and 1–20 literal additional-consent types in one exact
account/container/workspace, preview the additions, and save an unapproved campaign plan. No policy is chosen
automatically. Existing required types and their literal parameter keys are retained in order; new distinct
types are appended. Original tag names, parameters, triggers, sequencing, notes and paused state are preserved.
Already-required tags appear as unchanged and produce no write step. An entirely unchanged selection is refused.

The [official Tag model](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces.tags)
describes additional-consent settings and native fingerprints. The
[native update endpoint](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces.tags/update)
accepts a fingerprint precondition. These primary sources were checked on 2026-10-04. Proposed bodies are validated
against the repository's pinned Tag model; generated identity/URL/fingerprint fields are excluded from the body,
while the original resource path and native fingerprint remain explicit request arguments. Unknown future fields,
malformed native model values, ambiguous identities, inactive settings with uninterpreted type data, dynamic types,
partial resources and missing fingerprints refuse the guided draft. No new native action, family or OAuth scope is added.

The selected workspace and tags are read twice with GET_WORKSPACE/GET_TAG. Original complete object hashes and
native fingerprints must agree during observation, with current actor/account/login authority checked around every
read. Limits are 48 transport attempts including retries, 24 resource observations, 2 MiB and 60 seconds. The public
preview returns bounded tag/type metadata and source request/hash/time references; complete tag parameters and
credential signatures are omitted. Read attempts that succeed after retry count toward the same budget.

The preview is bound to actor, role, session, exact selection, private current authorization and original configuration,
with a 10-minute expiry and at most 100 unexpired retained previews per tenant. Expired previews are reclaimed on
preview creation. Saving requires the original ID/hash and explicit confirmation, rechecks current evidence, and
atomically binds the exact native steps within campaign creation. A concurrent save is refused as busy; retry of a
retained saved preview returns the original plan without another native read. An unused expired preview cannot create
a draft. Rotated credentials or changed access require a new preview; this is not new write authority.

Each changed tag becomes an independent existing UPDATE_TAG step. Before unsent native preparation and execution,
the guided argument hash, original tag configuration, current selected workspace identity and plan revision are checked
again. The native engine still freezes before-state and fingerprint, enforces ownership/write scopes/confirmation,
and verifies its receipt by fresh read-back. An earlier accepted independent tag update may change the workspace
fingerprint without invalidating the unchanged next tag. Uncertain execution retains the original native review and
idempotency key; the guided preview does not replay it or override receipt recovery.

Preview and save perform no provider mutation. Execution changes selected workspace tags only; no container version
is created or published by this workflow. Built-in consent checks, consent defaults/updates, runtime execution order,
event delivery, attribution and compliance remain unverified. Broader measurement diagnosis and repair plans remain open.

## Website, Arabic and MCP

An explicitly scoped `/measurement` workspace audit exposes the new form. Account/container inventory does not guess
a workspace. Tag selection and the literal type input begin empty; unknown settings are disabled. Native names and IDs
are escaped, original leading-zero IDs and type strings remain unchanged, and English/Arabic comma separators yield the
same native type array. The preview table shows original setting, original/proposed types, unchanged tags, source references
and expiry. Saving opens a link to the original unapproved plan. Form, selection, navigation, identity, detachment and
superseded-response guards prevent obsolete output or errors from repainting the current view.

Saved campaign review shows a translated typed proposal and retains the original plan/step prose in details. Readable
generated step descriptions require matching original scope, tag/name/type/fingerprint, consent list and generated prose;
changes to those fields fall back to their original description. The complete native request remains available for review.
This projection does not authorize or validate execution. Native identifiers, type names,
parameters and stored requests are never translated. Sixty new authored messages cover controls, proposal copy and 33
selected static refusals; native fallback diagnostics stay outside automatic translation.

The advertised workspace schema exposes preview/save, and compact campaign results expose selected scope/source metadata
without the private authorization signature or repeated full tag bodies. The real MCP SDK journey checks advertised input
schemas, text/structured parity, preview, draft save, compact inspection and revoked access: **four calls / 7,251 structured
bytes / 12 synthetic native GETs / zero provider mutations**. This is a synthetic client journey, not external acceptance.

## Verification

Twenty-one guided backend tests cover unchanged selections, literal union/key preservation, strict model/body bounds,
original identity and fingerprints, expiry/cap cleanup, actor/session/grants/credential rotation, changed observation,
concurrent save/idempotency, direct campaign binding, changed preparation/execution, retry accounting, independent accepted
updates with native read-back and original uncertain review recovery. Five new UI checks cover bilingual exact wire values,
original campaign review, invalid selections, current-view races, superseded/mismatched previews and bounded authored error
localization. Existing native measurement, GTM, campaign approval/amendment/views, localization, dispatch authority and MCP
journeys also pass: **262 focused tests / zero failures/skips / 8.290 seconds** before the final delimiter-only improvement.
Final verification of that improvement and sanitized release qualification follow below.

All 34 browser scripts pass syntax/CSP/assets/token/confirmation checks; the catalog covers **3,148 selected messages**.
Browser automation was retried and again failed before initialization because its kernel-assets path is missing. No actual
visual, keyboard, assistive-technology or deployed acceptance is claimed for this batch. Synthetic provider writes occur only
in the explicit native execution fixture; preview, save and the SDK/website draft journeys perform GETs only.

## Previous exact-source release evidence

Batch 127 HEAD `c5b44c8c5649a053a412ca16e166343e92daf06b` passed offline install/build/early report freshness/full check/Railway,
each exit zero: **3,990 total / 3,985 passed / zero failures / five expected local FFmpeg skips in 92.672 seconds**, plus
four capture checks in 68.195 ms. All 1,648 public source files matched Git HEAD without filters plus one generated empty
sample. Source hash: `1a58d98c08acc16e5a83433a7a7f9990a19b0507d1799a3e5b4f5c47b1183188`. Three tracked public report files
remained byte-identical. No root private sample, credential or live database was read.

[CI182](https://github.com/magdyezy1/CAMCP/actions/runs/37164684278) passed for that exact revision and source hash:
**3,990/3,990 host and Docker tests / zero failures/skips**, in **524.408/526.049 seconds**. Four capture checks passed
in each environment in 54.972/54.829 ms. Both main suites recorded two CPUs/two workers. Required FFmpeg, early report
freshness, Railway compatibility, Docker image build and both synthetic container smoke modes passed. This confirms batch
127's release checks; the new revision still requires its own exact-source qualification and CI.

The native ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
B15/B16/B20/B24 advance within the stated scope; the package matrix remains **13 implemented / 14 partial / one open**.

Final sanitized preflight passed offline install/build/early report freshness/full check/Railway, each exit zero:
**4,017 total / 4,012 passed / zero failures / five expected local FFmpeg skips in 93.672 seconds**, plus four capture
checks in 70.320 ms. All 34 scripts / 3,148 selected Arabic messages / 294 documents passed their checks. The final
English/Arabic delimiter change passed five UI checks in 1.074 seconds and is included in this full preflight. The initial
preflight found a new help-description ordering regression; restoring the established usage introduction resolved it,
and the description/SDK checks and full fresh candidate now pass. No failed candidate was pushed.

Fresh sanitized build/report regeneration confirmed all three tracked public artifacts byte-identical; qualification
preserved them. 1654 public source files plus one generated empty sample, source hash
`a4e450a7f8f3dd2d23ab9b84623a242b7dc554b5e6ed3d64f5d871acfc5f7a6a`. This preflight precedes these final evidence paragraphs; exact committed-source
qualification follows before the sole Work-here push. The new revision requires its own Linux/FFmpeg/Docker CI.
Visual/keyboard/assistive, live/deployed and the remaining original packages remain separate.
