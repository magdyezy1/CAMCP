---
status: record
tier: engineering
---

# Arabic connections and operating controls — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `d5e9b08`. Implementation: `c10835f`. Batch 64 extends B24 without changing provider authorization or owner policy.

## Connected workflows

Arabic now covers connection discovery, platform descriptions, resource selection, reviewed-write permission
controls, sync/authorization guidance, connection callbacks and common page errors. Platform brands, login and
resource names, exact IDs and provider diagnostics retain their original values. DV360 advertisers have a proper
display label; unknown resource kinds fall back to their original identifier rather than failing the asset manager.

MCP setup includes Arabic token instructions, consent, roles and revocation consequences. Native scope names,
callback URLs, server variable names, command examples, copied configuration and default token names stay exact.
Owner controls translate account-access review, health, spending units/caps, write pause/resume and retention
confirmation. Dynamic retention days and unit evidence use full-message interpolation. Actual request enum values,
amount units, role flags and confirmation booleans are unchanged. Existing legal text remains English with explicit
English/LTR markup. No new access, spending, deletion or legal policy is introduced.

RTL adjustments align resource tables and command search, mirror login actions/badges/metric dividers, and isolate
numeric fields. Actual visual/keyboard/assistive-technology acceptance remains unverified because CUA cannot
initialize its kernel-assets path. No browser test is claimed from these source and VM checks.

## Defects found while extending the workflow

F-138: a newly created connector token is displayed once, but the language refresh guard did not consider it
unsaved content. A red regression showed refresh could proceed without confirmation. The guard now detects the
token display and tells the user to save recovery codes or one-time tokens first. Cancelling prevents both catalog
loading and rerendering, preserving the token display.

F-139: the shipped DV360 selection kind is `advertisers`, but the display-label map lacked that key. Executing
`renderManage` against the original `d5e9b08` app reproduced a `toLowerCase` TypeError. The new label and explicit
unknown-kind fallback allow the same exact asset keys to render in both languages. This repairs the interface; it
does not add a DV360 provider contract or claim live account eligibility.

Source review also removed a technical variable suffix accidentally marked by an authoring helper. The catalog
checker now rejects technical identifier keys, with a regression, and tests require unchanged complete provider
variables. This intermediate authoring error was not pushed.

## Evidence and remaining scope

Seven connection/control tests execute the real browser controller with synthetic DOM/transport adapters. They
cover selected resources, unchecked/checked write acknowledgement, original token roles and config, OAuth consent
identity/scope/redirect, server-variable strings, unchanged legal text, owner account access, spending units and
retention confirmation. English and Arabic request transcripts must be identical. An additional localization
test protects one-time tokens. The first three feature tests and both defect regressions were observed red; the
combined localization/navigation group passed 28/28. Two isolated Google diagnostic fixtures needed the real
language module added; their existing assertions pass unchanged. The full 3,262-test rerun passed 3,257 with zero
failures and five local FFmpeg skips in 91.62 seconds. No provider, real credential or external message was used.

The catalog now contains **937 messages**, with **847 required source messages**. Coverage includes the authored
platform kind/description fields, while keeping their native names/scopes outside translation. Missing keys,
duplicates, interpolation drift and protocol/control/technical-identifier translation fail `check-web`.
Qualification and exact-HEAD release evidence are recorded in [PROGRESS.md](PROGRESS.md), with ignored logs in
`.runtime/connection-localization-20261001/`.

The matrix remains **13 implemented / 14 partial / 1 open**. B24 still includes campaign, creative, reporting and
operations translation, wider content review and RTL/keyboard acceptance. Work continues through the full blueprint.
