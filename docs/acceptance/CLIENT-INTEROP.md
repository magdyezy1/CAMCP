---
status: reference
tier: operator
---

# AI-client interoperability matrix

The owner-run acceptance that each must-pass AI client connects to AMCP and keeps working (ACC-02). Owner decision D14
names the must-pass clients: the Claude.ai and Claude Desktop connector, Claude Code, ChatGPT, Codex, Cursor and VS
Code. Each is connected by hand to a staging deployment and checked against the 12 checks below; the result is recorded
against the release identity. Nothing here has been run with a real client ([rules for every run](README.md)).

## What is proven locally

`tests/mcp-client-conformance.test.ts` runs a synthetic stand-in of each client profile against an in-process AMCP:
discovery through the 401 challenge, registration or a client metadata document, consent with `iss`, token exchange,
an immediate refresh, tool calls in the client's protocol era, 401 after revocation, a reconnect, and a viewer refused
writes. `node tools/acceptance/client-interop.mjs synthetic` runs it and names the checks it covers (1, 2, 4, 5, 8
and 9). These stand-ins do not certify a real client; they keep the server side from regressing.

## Staging (owner)

- A non-production deployment with its own volume, its own OAuth signing keys and a synthetic workspace: no real
  advertising account with a write grant, and writes disabled (leave `MIRROR_ALLOW_WRITES` unset). Never copy a
  production secret or volume to it. Registrations made on staging never count against production's limits.
- `AMCP_MCP_MODERN_PROTOCOL=next`, so `/mcp/next` serves MCP 2026-07-28 for the dual-era clients while `/mcp` stays
  legacy ([OAuth hardening](../OAUTH-HARDENING.md)).
- Check the staging origin before the sessions: `AMCP_INTEROP_PROBE=true node tools/acceptance/client-interop.mjs probe
  https://<staging-origin>`. It reads only the protected-resource and authorization-server metadata, the 401 challenge
  of an anonymous `initialize` and `/versionz`: no token, no registration, no consent. It refuses the production origin.

## The 12 checks, per client

| # | Check | What to record |
|---|---|---|
| 1 | Discovery through the 401 challenge | The client finds the protected-resource metadata named in `WWW-Authenticate` |
| 2 | Registration result and the registration count delta | Owner health's AI-client registrations before and after: +1 for a registering client, +0 for a metadata-document client |
| 3 | Consent content and a read-only downgrade | The consent page names the workspace and scope; granting read-only gives `mcp:read` only |
| 4 | Token exchange and `tools/list` | Time from registration to the first `tools/list` |
| 5 | A viewer is refused writes | A viewer's connection lists tools but `amcp_write` refuses |
| 6 | Operator inspect and prepare | `amcp_write inspect` and prepare work; execute only on a synthetic target |
| 7.1h | Refresh after 1 hour | The next call after the access token expired succeeds without a new consent |
| 7.24h | Refresh after 24 hours, two sessions in parallel | Both sessions keep working (the 30-60 s reuse window of D16 holds; no family revocation) |
| 7.7d | Refresh after 7 idle days | The first call after a week idle succeeds, or the client asks to reconnect |
| 8 | Revocation in both directions | Revoked in AMCP (the AI connectors page): the next call is 401; removed in the client: AMCP shows the grant ended or unused |
| 9 | The negotiated protocol version | The `Mcp-Protocol-Version` the session used (2025-11-25, 2025-06-18 or 2026-07-28) |
| 10 | Whether the client sends an Origin header | Present or absent, and AMCP's answer (an unlisted browser origin is refused) |
| 11 | An error raised before MCP starts | How the client shows a refused registration or consent (the readable `error_description`) |
| 12 | Binding to one of several workspaces | A member of two workspaces connects to the one they choose, and only its data is visible |

Evidence comes from AMCP's own logs and pages, by reference: `mcp_refused` and `mcp_protocol_unsupported` log events,
`mcp_oauth_refresh_reused`, `mcp_oauth_family_revoked`, `mcp_oauth_revoked`, `mcp_registration_limited` and
`website_mcp_token_*` events, request IDs, status codes, the redirect URI and granted scope, and owner health's
registration counts. Never record a token, an authorization code or a HAR file.

## Per client

What each client is expected to do, from the review's matrix (primary documents read 2026-10-08) and the synthetic
profiles; the session confirms or refutes it.

| Client | Registration | Redirect | Protocol era | Notes |
|---|---|---|---|---|
| Claude.ai and Claude Desktop connector | Dynamic registration | `https://claude.ai/api/mcp/auth_callback` | Legacy (`/mcp`) | Add it as a custom connector with the staging `/mcp` URL |
| Claude Code | Client metadata document | Loopback (`http://localhost:<port>/callback`) | Dual-era: try `/mcp/next` | A remove and re-add adds no registration |
| ChatGPT | Dynamic registration | Under `https://chatgpt.com/` | Legacy (`/mcp`) | Developer mode connector |
| Codex | Client metadata document | Loopback (`http://127.0.0.1:<port>/…`) | Dual-era: try `/mcp/next` | A remove and re-add adds no registration |
| Cursor | Dynamic registration | Loopback or `https://www.cursor.com/…` | Legacy (`/mcp`) | An older build that registers a `cursor://` redirect is refused (`invalid_client_metadata`): record it as a defect ticket, never loosen the redirect rule |
| VS Code | Dynamic registration (`application_type: native`) | `http://127.0.0.1:33418` or `https://vscode.dev/redirect` | Legacy (`/mcp`) | |

A failing client becomes a defect ticket. S256-only PKCE, exact redirect matching, a scope that cannot grow on refresh
and rotating refresh tokens with family revocation stay as they are: acceptance never loosens them to make a client pass.

## Recording

1. `node tools/acceptance/client-interop.mjs template > interop-<release>.json` gives the blank record: every must-pass
   client, every check `not_run`.
2. Fill in the release (`/versionz` revision and package hash of staging), the staging origin, who ran the sessions,
   each client's version, and for each check its result (`pass`, `fail`, `blocked`), the day, an evidence reference
   and, for anything but a pass, why.
3. `node tools/acceptance/client-interop.mjs check interop-<release>.json` validates it (references only, staging only)
   and prints per client how many checks passed and whether its matrix is complete.
4. Keep the record with the release's qualification record (QA-01). MCP-03 sets `AMCP_MCP_MODERN_PROTOCOL=on` only once
   every dual-era client passed check 9 on `/mcp/next`.
5. Per release, re-run the matrix for the must-pass clients the owner names. The 7-day idle refresh needs at least one
   elapsed week per client cohort.

## Remaining (not in this repository)

- A staging deployment (R7), access to each client product, and the evaluator D14 leaves to the owner.
- The owner signs off the must-pass client list and the per-release re-run rule.
