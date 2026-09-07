# AMCP

AMCP connects an advertising workspace to Codex and other MCP clients. It includes a responsive website, platform OAuth callbacks, multiple logins, account selection, related asset inventory, and revocable MCP access.

**Deployment:** Railway runs the application; Cloudflare manages DNS for **amcp.shop**. Follow [the deployment guide](docs/DEPLOY-RAILWAY.md). The repository contains code, not an already deployed website.

## Website

- Connections: Google Ads, Meta, TikTok, Snapchat, LinkedIn, X, GA4, Google Tag Manager / Google tag, Search Console, and Apple Ads; each provider uses your own app credentials. See [measurement and Apple setup](docs/MEASUREMENT-AND-APPLE.md).
- Multiple encrypted logins per provider, default login, synchronization, searchable account selection, and local disconnect.
- Asset tabs show related inventory. Selected ad accounts, GA4 properties, Tag Manager accounts and Search Console sites are the enforced MCP access boundaries; some standalone resources need explicit ownership bindings.
- OAuth completion page with authorization, credential exchange, and asset sync results.
- MCP connector page with browser authorization, Codex/Cursor configurations, reader/operator access, expiring bearer tokens, and revocation.
- Reviewed campaign mutations with five-minute state snapshots, explicit confirmation, account grants, and persistent duplicate-submission protection.
- Evidence-linked campaign audits and deterministic optimization suggestions with explicit unknown coverage.
- Session authentication, CSRF protection, encrypted OAuth state, PKCE where supported, and activity records. Claude-compatible dynamic registration supports encrypted client secrets with client_secret_post alongside public clients. See [OAuth and hardening decisions](docs/OAUTH-HARDENING.md).

## Run locally

Requires Node.js 24 or later.

```sh
npm ci
npm run check
npm run start:http
```

The default local URL is http://127.0.0.1:4317. Configure the variables in [.env.example](.env.example) in your process environment; the server does not automatically load that file. Set an administrator password and encryption key before signing in or connecting providers. For stdio MCP, use `npm start`.

## MCP compatibility and verification

The server preserves a captured compact-v1 compatibility surface with 20 tools, 19 gateways, and 112 nested operation schemas. Generated route metadata and official vendor contracts are included for reproducible checks. AMCP is an independent implementation; it is not affiliated with WhatHead or any advertising platform.

This release supports reads, local dry runs, and opt-in **reviewed advertising writes** through the AMCP extension tool. Existing credentials stay read-only until an administrator grants write accounts and issues operator access. See [write setup and supported contracts](docs/WRITE-OPERATIONS.md). OAuth, tenant isolation, account grants, native request compilation, credential refresh, reporting jobs, and MCP transports have automated tests. Captured action counts describe catalog coverage and do not prove live behavior.

Full production qualification of every provider and workflow is **not complete**. Provider app approval, production OAuth round trips, complete asset discovery coverage, special media transports, and some delegated workflows remain outstanding. See [deployment acceptance limits](docs/DEPLOY-RAILWAY.md#operations-and-qualification) and run `npm run report` for the current implementation inventory. Private account evidence, credentials, local databases, and the original project brief are excluded from this public repository.

The [hardening review](docs/HARDENING-REVIEW.md) records parameter behavior, measured fixture checks, and suggestions deferred for insufficient evidence.

## Deployment files

Use the Dockerfile and set Railway's health check to `/healthz`, one replica, and Wait for CI in service settings. `railway.json` is a legacy reference; new Railway services cannot opt into deprecated Config as Code. Attach a volume at `/data` and match domain target ports to the actual `PORT` (the existing AMCP deployment uses 8080). The website, MCP endpoint, and report worker run together. Register callbacks such as **https://amcp.shop/api/auth/snapchat/callback** after the domain is live.
