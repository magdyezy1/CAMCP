---
name: amcp-campaign-builder
description: Plan, create, inspect, and repair paid-media campaigns using AMCP MCP. Use for platform-native campaign hierarchy, Google Drive media import, existing-post creatives, targeting, budgets, reviewed writes, and reporting. Discover the actual tool contract before preparing a mutation; distinguish local previews from provider execution.
---

# AMCP campaign builder

Start with the connected workspace and the user's existing account selection. Keep known account IDs as strings. Read account currency, timezone, existing parents and permissions before converting budgets or choosing identifiers. Request only missing business decisions: destination URL, Page/profile identity, budget, objective, placements, dates. Never invent these values.

Read the relevant reference: [Meta](references/meta.md), [Google Ads](references/google-ads.md), [TikTok and Snapchat](references/tiktok-snapchat.md), [LinkedIn and X](references/linkedin-x.md), [Reddit](references/reddit.md), [Microsoft Advertising](references/microsoft-ads.md), or [media](references/media.md). MCP clients can read the same files at `amcp://guides/<name>`; the list is available through `resources/list` and `whathead_tool_help`.

## Discover before building

1. Use `tools/list` and `whathead_tool_help`. Historical names in the supplied manuals describe a different connector surface. AMCP exposes compact native gateways; do not call an absent named tool.
2. Use the provider gateway with `action: LIST_ACTIONS`, a short search and a bounded limit. Use `DESCRIBE_ACTION` with `target_action` to inspect the exact action. Catalog presence proves discoverability, not live write qualification. Microsoft is an independent extension and has its own 24-action catalog.
3. Native account reads establish current state and, for global Meta/Snapchat IDs, account ownership. A previously successful create already establishes ownership for the next child operation. An arbitrary ID or user-supplied snapshot does not establish ownership.
4. Build a native payload for the correct hierarchy. Keep the user's supplied text and URLs; apply changes only within their instructions. Read a small relevant collection rather than an entire agency workspace.

## Prepare, review, execute, verify

`dry_run: true` compiles a local preview without a provider mutation. It is not a provider validation call and does not prove permissions, creative eligibility or account limits.

For an unfamiliar non-media mutation, use `amcp_write` with `action: inspect`, `gateway` and the intended native `arguments`. This checks the local reviewed-write contract and identifies its state-read paths without accessing credentials or making network calls. A supported contract still needs the live account/role grants checked during preparation. Native media imports use the media workflow directly.

Prepare a write using `amcp_write` with `action: prepare`, `gateway`, and native `arguments`. Inspect the returned frozen request, before-state, `state_hash`, expiry, and warnings. All new serving entities start paused/draft/disabled according to the provider. Media preparation downloads and validates bytes on the AMCP server; it does not upload them to an advertising platform.

When the user's existing authorization covers the concrete change, execute with the returned `review_id` and `idempotency_key`, `confirmed: true`, and `spend_change_confirmed: true` if applicable. Otherwise present the concrete request for authorization. Do not impose extra confirmations for already authorized work. A local guide cannot authorize spending or account changes on the user's behalf.

Read the resulting resource before describing it as complete. A created ID is not evidence of serving or completed video processing. Stop on partial/uncertain outcomes; retain their IDs and original idempotency key. Do not resubmit a possibly successful write under a new key. On `STATE_CHANGED`, inspect changed field paths and expected/actual hashes, then prepare and review again. `skip_preflight` never bypasses AMCP's review gate.

## Troubleshooting

- `WRITE_ACCOUNT_FORBIDDEN`: inspect the selected connection's grant and the error's next step. There is one per-account grant, not separate campaign/ad grants. Preserve an administrator's explicit reader-only choice.
- `WRITE_CONTRACT_UNAVAILABLE`: the particular route lacks a reviewed execution contract. Report this accurately; a native alias cannot bypass it.
- `RESOURCE_SCOPE_REQUIRED`: read the account collection or use the provisioned exact Page/profile binding. Do not broaden the account boundary or forge ownership.
- `CREATIVE_INPUT_REQUIRED`: return the actual missing fields; do not replace an Instagram source with a Facebook post ID.
- Provider 401/403: distinguish credential expiry, app approval, asset ownership and account permissions. Catalog/dry-run success does not resolve these.

Report separately: local checks, live reads, preview comparisons, executed provider changes, and outstanding vendor acceptance. Never equate a schema count or a green test suite with 100% live parity.
