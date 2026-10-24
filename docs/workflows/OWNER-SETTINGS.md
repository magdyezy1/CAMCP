---
status: reference
tier: operator
---

# Owner settings and workspace health

The owner's Settings sections and the tool timings of workspace health. Sections of the [workflow guide](../PRODUCT-WORKFLOWS.md), moved here with their text unchanged on 2026-10-24 (DOC-03).

### Tool timings in workspace health

Owners/administrators can open Settings or use the existing MCP health action to inspect completed tool
attempts in the current 15-minute interval. The bilingual named table separates fixed tool groups, success/error
response counts, means, approximate median/p95 buckets and omitted measurements. It scrolls inside the page
and supports keyboard access. A successful response may contain a blocked/pending/failed workflow. Handler
time excludes timing storage and response delivery; it does not measure end-to-end network latency.
Current in-flight calls appear in a later health refresh. Empty intervals and unavailable evidence stay explicit.
See [operating details](../operations/OPERATING-CONTROLS.md#owner-tool-timings) and [delivery evidence](../records/DELIVERY-2026-10-03-TOOL-TIMINGS.md).

### Owner Settings sections

An owner's Settings open with a sub-navigation (WEB-08): **Safety** first (Pause all writes, the account spending
policy and workspace default, executions over a cap and review friction), then **Access** (the instance owner's list of
who can use AMCP), **Health**, **Retention** (report snapshots and file downloads) and **Account** (platform setup).
Each link moves to its section. The command palette (Ctrl+K) offers owners **Pause all writes**, which only opens that
control; pausing still asks for confirmation and a reason. In the access list the owner's own row shows **You** and no
actions, because AMCP never changes the caller's own access; every other row keeps its controls.
