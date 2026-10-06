# AMCP

AMCP connects an advertising workspace to Codex and other MCP clients. It includes a responsive website, platform OAuth callbacks, multiple logins, account selection, related asset inventory, and revocable MCP access.

**Deployment:** Railway runs the application; Cloudflare manages DNS for **amcp.shop**. Follow [the deployment guide](docs/DEPLOY-RAILWAY.md). The repository contains code, not an already deployed website.

**Documentation:** the [documentation map](docs/README.md) lists every guide, review and implementation record.

Provider versions, reviewed workflow boundaries and evidence are published in [contracts](docs/CONTRACTS.md). See the [September contract review](docs/implementation/PLATFORM-CONTRACTS-2026-09-18.md) for implementation decisions and validation limits. The optional [sandbox verifier](docs/SANDBOX-VERIFICATION.md) uses approved fixtures and isolated provider hosts. Development checks require Python 3.10+ (standard library only) for Microsoft WSDL regeneration; set `AMCP_SCHEMA_PYTHON` when Python is outside PATH. Production does not require Python.

## Website

- Verified owner-account migration, email/password accounts, Google / Apple / Facebook linking, authenticator MFA, recovery codes, team memberships and revocable sessions. See [user accounts setup](docs/USER-ACCOUNTS.md). Social sign-in credentials are separate from advertising OAuth credentials.
- A new ink, iris and apricot visual identity, public homepage, responsive workspace navigation, keyboard page search and guided entry points. See [identity and interface migration](docs/AMCP-IDENTITY.md).
- Commerce combines explicit source-product review with optional read-only X listed-product inspection, local search/paging and retained source/variant limits. See [catalog workflow and checks](docs/review/DELIVERY-2026-10-06-X-CATALOG-SELECTION-INVENTORY.md).
- Commerce can reconcile two bounded scans of published WooCommerce parents and all reported variable-parent children, with exact native IDs/prices and local bilingual inspection. See [inventory scope and checks](docs/review/DELIVERY-2026-10-06-WOOCOMMERCE-INVENTORY.md).
- Owner settings show bounded shared worker observations and distinguish unavailable, stale and recently observed processes from actual job delivery. See [worker health and concurrent-client checks](docs/review/DELIVERY-2026-10-06-WORKER-HEALTH.md).
- Workspace administrators can connect an existing WooCommerce Read key in Commerce, inspect its bounded read-verification receipt and explicitly remove its local connection. See [store setup, replay and removal](docs/review/DELIVERY-2026-10-06-WOOCOMMERCE-CONNECTIONS.md).
- Operations connects original runs and schedules to bounded status, confirmed recovery and workbook clock previews, editing, pause and resume. See [product workflows](docs/PRODUCT-WORKFLOWS.md).
- English/Arabic interface choice extends through report building, saved reports and delivery schedules, with native fields and user content preserved. See [reporting language coverage and limits](docs/review/DELIVERY-2026-10-01-ARABIC-REPORTING.md).

- Whole-campaign preflight, business-input recipes, safe failed-step recovery, owner spending policies, resumable media transfer and encrypted restore-verified backups. See [recommendations and limits](docs/RECOMMENDATIONS-IMPLEMENTED.md).
- Reporting Overview: multiple platforms/accounts/objectives, native/custom metrics, source evidence, advisory scale/pull-back decisions, CSV, Google Sheets and scheduled exports. See [reporting setup](docs/REPORTING-OVERVIEW.md).
- Campaign plans with verified dependencies, account readiness, private Drive and reviewed media variants, automatic write read-back, source-linked reporting, evidence-based suggestions, reusable client profiles and a capability dashboard. See [workspace operations](docs/WORKSPACE-OPERATIONS.md).
- Scheduled client PDF/Excel packs with frozen branding, encrypted local storage and per-format recovery. See [file delivery](docs/REPORTING-OVERVIEW.md#scheduled-pdf-and-excel-files).

- Connections: Google Ads, Meta, TikTok, Snapchat, LinkedIn, X, Microsoft Advertising, GA4, Google Tag Manager / Google tag, Search Console, and Apple Ads, plus separate Google Drive media and Google Sheets export connections; each provider uses your own app credentials. See [measurement and Apple setup](docs/MEASUREMENT-AND-APPLE.md).
- Microsoft Advertising v13: 24 native actions, account discovery, 12 reviewed Search mutation routes and account-bound server CSV/TSV report download/parsing. See [Microsoft setup and limits](docs/MICROSOFT-ADS.md).
- MCP clients can load ten campaign/reporting guides through resources/list and the amcp_build_campaign prompt. amcp_write inspect checks local write support without network calls. See the [fresh capability review](docs/CAPABILITY-REVIEW-2026-09-08.md).
- Multiple encrypted logins per provider, default login, synchronization, searchable account selection, and local disconnect.
- Asset tabs show related inventory. Selected ad accounts, GA4 properties, Tag Manager accounts and Search Console sites are the enforced MCP access boundaries; some standalone resources need explicit ownership bindings.
- OAuth completion page with authorization, credential exchange, and asset sync results.
- MCP connector page with browser authorization, Codex/Cursor configurations, reader/operator access, expiring bearer tokens, and revocation.
- Reviewed campaign mutations with five-minute state snapshots, explicit confirmation, account grants, and persistent duplicate-submission protection.
- Configuration-only state guards ignore delivery telemetry and normalize unordered scalar arrays; failures identify changed fields and state hashes. Created Meta/Snapchat/Reddit resources immediately receive account ownership bindings.
- Google Drive links work through native media actions, platform_media_upload and amcp_media, with a shared amcp_write review. The server transfers images and videos to Meta, TikTok, Snapchat, Google Ads, LinkedIn, X and DV360; MCP clients never download the file. Meta and Snapchat creative creation is supported. See [formats, limits and examples](docs/MEDIA-UPLOADS.md).
- Reviewed Google keyword/targeting/shared-exclusion-list mutations and Reddit classic campaigns, ad groups, existing-post ads and saved targeting audiences.
- Evidence-linked campaign audits and deterministic optimization suggestions with explicit unknown coverage.
- Session authentication, CSRF protection, encrypted OAuth state, PKCE where supported, and activity records. Claude-compatible dynamic registration supports encrypted client secrets with client_secret_post alongside public clients. See [OAuth and hardening decisions](docs/OAUTH-HARDENING.md).

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
local default; `npm run test:serial` remains explicitly serial. CI and the Docker build select two isolated test-file
workers and still run every check with FFmpeg required. Test startup records the available CPU count and selected
worker setting; malformed settings fail before any test starts. This setting controls test execution only.

The default local URL is http://127.0.0.1:4317. Configure the variables in [.env.example](.env.example) in your process environment; the server does not automatically load that file. Set an administrator password and encryption key before signing in or connecting providers. For stdio MCP, use `npm start`.

## MCP compatibility and verification

The server maintains a compact-v1 baseline with 20 tools, 19 gateways, and 112 nested operation schemas. Baseline metadata and fixtures are normalized to AMCP naming; the files are derived development inputs, not unmodified external transcripts. Microsoft Advertising is a separately identified extension. Generated route metadata and official vendor contracts are included for reproducible checks. AMCP is an independent implementation and is not affiliated with any advertising platform.

This release supports reads, local dry runs, and **reviewed advertising writes** through amcp_write and amcp_media. Advertising connections and OAuth clients default to read + reviewed write access; explicit read-only choices and existing grants are preserved. The deployment write kill switch, account boundaries and per-change review remain enforced. See [write setup and supported contracts](docs/WRITE-OPERATIONS.md). OAuth, tenant isolation, account grants, native request compilation, credential refresh, reporting jobs, and MCP transports have automated tests. Captured action counts describe catalog coverage and do not prove live behavior.

Full production qualification of every provider and workflow is **not complete**. Provider app approval, production OAuth round trips, complete asset discovery coverage, special media transports, and some delegated workflows remain outstanding. See [deployment acceptance limits](docs/DEPLOY-RAILWAY.md#operations-and-qualification) and run `npm run report` for the current implementation inventory. Private account evidence, credentials, local databases, and the original project brief are excluded from this public repository.

The [hardening review](docs/HARDENING-REVIEW.md) records parameter behavior, measured fixture checks, and suggestions deferred for insufficient evidence.

## Deployment files

Use the Dockerfile and set Railway's health check to `/healthz`, one replica, and the CI gate appropriate to the release mode. With the owner's current hosted-Actions waiver, set Wait for CI off and require the recorded clean-commit local qualification and Docker full check; restore the gate when Actions are explicitly restored. See [owner-waived CI deployment mode](docs/DEPLOY-RAILWAY.md#owner-waived-github-actions). `railway.json` is a legacy reference; new Railway services cannot opt into deprecated Config as Code. Attach a volume at `/data` and match domain target ports to the actual `PORT` (the existing AMCP deployment uses 8080). The website, MCP endpoint, and report worker run together. Register callbacks such as **https://amcp.shop/api/auth/snapchat/callback** after the domain is live.
