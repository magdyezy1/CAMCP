# AMCP

AMCP is an advertising workspace for agencies and in-house teams. A website and an MCP endpoint, for AI assistants
such as Claude, ChatGPT, Codex and Cursor, reach the same connected advertising, analytics and commerce accounts under
the same rules. Nothing changes on an advertising platform until AMCP has read the current state, shown a reviewable
before and after with its money and status effects, checked the owner's spending policy and received an explicit
approval; it then sends the change once and reads it back. Reports keep the platform's own numbers, currency, time zone
and attribution, and never invent zeros.

**Workspace owners:** start with the [owner guide](docs/owner/README.md), also in [Arabic](docs/owner/ar/README.md):
plain language, task by task, and what stays yours to do.

**Status.** The last deployment the owner reported is branch `Work-here`, deployed to amcp.shop through Railway on
2026-10-18 (its [deployment record](docs/records/DEPLOYMENT-2026-10-18.md) names the revision); later commits reach
the site with the next push the owner approves. Every part
described here is implemented in source and tested against synthetic provider fakes; no live write has been accepted
yet, and live acceptance is owner-run. [Current readiness](docs/CURRENT-READINESS.md) gives the status of each area,
the generated provider, tool and package tables, and the owner steps that remain.

At a glance, generated from the code by `npm run docs:index` (`npm run check` fails when one is stale):

- <!-- fact:reviewed_families -->173<!-- /fact --> reviewed write families and
  <!-- fact:campaign_recipes -->20<!-- /fact --> guided campaign recipes;
- <!-- fact:tools_writes -->25<!-- /fact --> MCP tools on a deployment with reviewed writes
  (<!-- fact:tools_read_only -->25<!-- /fact --> on a read-only one) and <!-- fact:mcp_guides -->13<!-- /fact --> guide
  resources for AI clients;
- <!-- fact:ledger_actions -->3,263<!-- /fact --> catalogued provider actions in the
  [action ledger](docs/implementation/ACTION-CONTRACT-COVERAGE.json), each with its contract status;
- <!-- fact:providers_active -->17<!-- /fact --> active provider adapters; <!-- fact:providers_parked -->Criteo, WooCommerce and Amazon Ads<!-- /fact -->
  are parked and not offered.

## What it does

- **Connections.** Website OAuth for <!-- fact:website_platforms -->16<!-- /fact --> platforms with your own app
  credentials (Google Ads, Meta, TikTok, Snapchat, LinkedIn, X, Microsoft Advertising, Apple Ads, Reddit, Display &
  Video 360, GA4, Google Tag Manager, Search Console, Business Profile once Google approves the project, and Google
  Drive and Sheets), several logins per provider and explicit account selection: the selected accounts are the
  boundary of every read and write. See [the deployment guide](docs/DEPLOY-RAILWAY.md#3-register-provider-apps).
- **Reviewed changes.** One change path for the website and AI clients, with owner spending policies, idempotency,
  read-back verification and recovery of uncertain writes. See [write operations](docs/WRITE-OPERATIONS.md).
- **Campaigns, media and commerce.** Guided paused launches, campaign plans with preflight and step recovery, media
  pushed to several platforms after review, and catalog comparisons. See [product workflows](docs/PRODUCT-WORKFLOWS.md)
  and [media uploads](docs/MEDIA-UPLOADS.md).
- **Reporting and measurement.** Reporting Overview across platforms and accounts with exports to CSV, Excel, PDF and
  Google Sheets, and a read-only measurement hub. See [reporting overview](docs/REPORTING-OVERVIEW.md) and
  [measurement and Apple Ads](docs/MEASUREMENT-AND-APPLE.md).
- **Teams and security.** Roles, two-step verification, clients within one workspace, revocable AI-client access and
  self-service deletion. See [user accounts](docs/USER-ACCOUNTS.md) and [OAuth hardening](docs/OAUTH-HARDENING.md).

Owner decisions are recorded in [decisions](docs/DECISIONS.md), and the [documentation map](docs/README.md) lists every
guide, runbook and record, in tiers for owners, operators and engineers; dated records are in
[docs/records](docs/records/) and superseded reviews in [docs/archive](docs/archive/).

## Run locally

Requires Node.js 24 or later.

```sh
npm ci
npm run check
npm run start:http
```

`npm run check` starts with `npm run format:check`; run `npm run format` to apply the repository's Prettier style to
`src`, `server`, `tools`, `tests`, `codegen` and `deploy` before committing.

The full test suite accepts `AMCP_TEST_CONCURRENCY` as an integer from 1 to 32. An unset value preserves Node's
local default; `npm run test:serial` remains explicitly serial. The Docker build selects two isolated test-file
workers and still runs every check with FFmpeg required. Test startup records the available CPU count and selected
worker setting; malformed settings fail before any test starts. This setting controls test execution only.

Development checks require Python 3.10+ (standard library only) for Microsoft WSDL regeneration and the test of the
MCP evaluation runner wrapper; set `AMCP_SCHEMA_PYTHON` when Python is outside PATH (on Windows `python` may be only
the Microsoft Store alias). Production does not require Python.

The default local URL is http://127.0.0.1:4317. Configure the variables in [.env.example](.env.example) in your process
environment; the server does not automatically load that file. Set an administrator password and encryption key
before signing in or connecting providers. For stdio MCP, use `npm start`.

## MCP compatibility and verification

The server keeps the captured compact-v1 baseline of <!-- fact:captured_tools -->20<!-- /fact --> tools,
<!-- fact:captured_gateways -->19<!-- /fact --> gateways and <!-- fact:captured_schemas -->112<!-- /fact --> nested
operation schemas as its compatibility denominator (owner decision D17). Baseline metadata and fixtures are normalized
to AMCP naming; the files are derived development inputs, not unmodified external transcripts. Microsoft Advertising
is a separately identified extension of <!-- fact:microsoft_actions -->31<!-- /fact --> actions. Parked providers
(Amazon Ads, Criteo and WooCommerce) are not listed unless `AMCP_PROVIDERS` names them. Provider versions and reviewed
boundaries are published in [contracts](docs/CONTRACTS.md). AMCP is an independent implementation and is not
affiliated with any advertising platform.

Reviewed advertising writes run through `amcp_write`, `amcp_campaign` and `amcp_media` when the deployment allows
them (`MIRROR_ALLOW_WRITES=true`); account write grants, the owner's write pause and per-change review stay enforced.
Captured action counts describe catalog coverage and do not prove live behaviour. Production qualification of every
provider and workflow is not complete: provider app approvals, live acceptance and the owner's manual checks are listed
in [current readiness](docs/CURRENT-READINESS.md#8-owner-steps). Private account evidence, credentials, local
databases and the original project brief are excluded from this repository.

## Deployment

Railway runs the application from the Dockerfile; Cloudflare manages DNS for **amcp.shop**. Follow
[the deployment guide](docs/DEPLOY-RAILWAY.md). The website, MCP endpoint and report worker run together in one
service with one replica and a volume at `/data`; set the health check to `/healthz` and match domain target ports to
the actual `PORT` (the existing deployment uses 8080). The Docker build runs the full `npm run check` with FFmpeg
required, so a failing check fails the deploy. Under the owner's hosted-Actions waiver, Wait for CI is off and the
recorded local qualification gates each push ([owner-waived CI](docs/DEPLOY-RAILWAY.md#owner-waived-github-actions)).
`railway.json` is a legacy reference: Railway ends config as code on 2026-12-01, so the dashboard settings are the
owner's record. Register callbacks such as **https://amcp.shop/api/auth/snapchat/callback** after the domain is live.
