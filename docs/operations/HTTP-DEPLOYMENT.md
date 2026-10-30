---
status: reference
tier: operator
---

# HTTP deployment and service keys

Binding the HTTP server, service keys, AI-client registration and what the hosted workflow covers. A section of the [operations runbook](../OPERATIONS.md), moved here with its text unchanged on 2026-10-24 (DOC-03).

## HTTP deployment

Default bind is loopback. External bind requires MIRROR_PUBLIC_ORIGIN as an HTTPS origin and a TLS reverse proxy. The service validates Host and Origin, authenticates bearer tokens, limits JSON bodies to 4 MiB, and supports stateless POST requests. Provision a distinct mirror key per operator with an appropriate role. Keys expire after 30 days by default; provision replacements and revoke old keys with `npm run admin -- revoke-key <protected-token-file>`. A key from `npm run admin -- create-key` is service-owned (SEC-06): no member's password, email or two-step change ends it, unlike the connector tokens and AI-client access the administrator door issued, which the owner account's security changes still end. The owner's health view (`service_keys`) lists every live service key of the workspace by label, role and expiry, including older server keys created before this rule; the owner's security notice says how many connector tokens and AI-client connections a change ended. `npm run admin -- mfa-reset <email>` is the instance owner's offline reset of a member who lost their authenticator and recovery codes: it turns two-step verification off and ends that person's sessions, connector tokens and AI-client connections (audited as `account_mfa_reset`); confirm the person's identity outside AMCP first ([MFA support runbook](../USER-ACCOUNTS.md#required-two-step-verification-and-recovery)).

Claude remote clients can dynamically register with `client_secret_post`; public clients retain `none`. Both require S256 PKCE and consent by an active workspace member, capped by that member's role (viewers grant read only). Client secrets are encrypted at rest and must accompany token, refresh and revocation requests. Optional trusted proxy CIDRs affect rate-limit attribution only. See [OAuth hardening](../OAUTH-HARDENING.md) for configuration and regression coverage.

The maintained GitHub workflow defines Docker builds and synthetic read-only/write-enabled startup, volume ownership, authentication, MCP access, restart-persistence and revocation checks. Hosted Actions are waived at the owner’s direction after exhausted minutes; no new run is started or treated as passed. Fresh exact-source/default-full/required-FFmpeg/report checks continue locally; current Linux/Docker and deployed acceptance require actual host evidence, which each Railway build supplies through its in-build check ([per-release Linux evidence](../DEPLOY-RAILWAY.md#per-release-linux-evidence-from-railway-builds), ACC-04). This does not qualify the TLS proxy, multi-host load, provider authorization, or recovery under production traffic. SQLite/WAL remains a single-host storage choice.
