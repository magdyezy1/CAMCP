# Deploy AMCP on Railway with Cloudflare DNS

Repository: https://github.com/magdyezy1/AMCP

This application runs its website, OAuth callbacks, MCP server, and report worker in one Node 24 service. SQLite and encrypted credentials require a persistent volume. Keep one replica; this release does not use a distributed database.

## 1. Create the service

In Railway, create a project from the AMCP GitHub repository and build the included Dockerfile. Set these service settings explicitly: health-check path `/healthz`, one replica, restart on failure, and Wait for CI enabled. Add a volume mounted at `/data` before connecting accounts. The container initializes the mount directory and then runs Node as the unprivileged `node` user.

Railway has deprecated `railway.json` configuration for new services. The file remains a legacy reference; verify settings in the dashboard instead of assuming it is applied. Existing Config as Code support ends on December 1, 2026. See [Railway's configuration notice](https://docs.railway.com/config-as-code).

Railway rejects Dockerfile `VOLUME` instructions. This image deliberately has none: create the persistent volume in Railway and set its mount path to `/data`. Set each domain's target port to the service's actual `PORT`. The existing AMCP deployment uses `8080`. Local development defaults to `4317`; that local default does not override Railway's `PORT`.

Add these service variables:

| Variable | Value |
| --- | --- |
| `PORT` | Railway's supplied port, or an explicit value such as `8080`; match the domain target port |
| `MIRROR_HOST` | `0.0.0.0` in the container; do not override this with localhost for a public Railway service |
| `MIRROR_DB` | `/data/mirror.sqlite` |
| `MIRROR_MASTER_KEY` | A new random 32-byte base64 key |
| `AMCP_ADMIN_PASSWORD` | A unique strong password, at least 16 characters |
| `AMCP_PUBLIC_ORIGIN` | Your generated Railway HTTPS origin initially; later `https://amcp.shop` |
| `MIRROR_ALLOW_WRITES` | `true` for reviewed write support; `false` for reads and dry runs only |
| `AMCP_RUN_WORKER` | `true` |

To keep the administrator password itself out of Railway, set `AMCP_ADMIN_PASSWORD_HASH` instead of `AMCP_ADMIN_PASSWORD`: run `npm run build && npm run admin -- password-hash` locally, type the password, press Enter and then Ctrl-D, and paste the printed `scrypt-v3$…` value. Hashes made before 2026-09-28 (`scrypt$…`) still work, and start-up prints a warning until they are replaced. Changing the administrator password or its hash signs out every administrator session and ends the MCP access approved from them when the new deployment starts; a server still running the old password stops accepting it at that moment. `AMCP_TEST_PASSWORD` and `AMCP_TEST_PASSWORD_HASH` work the same way for reviewer sessions.

Generate the encryption key locally using `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Put it directly in Railway variables and a password manager. Do not commit it. Preserve this key across deployments: changing it makes existing credentials unreadable. Do not copy your local test database or previously shared provider tokens into this deployment.

The app uses Railway's `PORT`. Networking → Generate Domain supplies the initial HTTPS URL. If you omit `AMCP_PUBLIC_ORIGIN`, AMCP can use Railway's `RAILWAY_PUBLIC_DOMAIN` when supplied; set an explicit origin before registering provider callbacks. Redeploy after changing variables. `/healthz` checks that the database answers and takes a write lock, that its disk has room, and that the offline help completes through a real MCP client and server in memory. It answers `status: up` (200), `degraded` (200, the disk is low) or `unavailable` (503, naming only the failed check); a result lasts ten seconds. Point an uptime monitor at it. Every refused or failed `/mcp` request writes one JSON log line (`mcp_refused` or `mcp_failed`, with status, code and origin, never the token). Inspect write readiness through the authenticated workspace health operation. Sign in and check Settings. An unconfigured provider displays “Setup needed.”

Successful HTTP startup emits one JSON `http_listening` event at `level: info` on
stdout, with the actual bound `host`/`port` and configured `public_origin`. A bind
failure emits `http_listen_failed` at `level: error` and exits nonzero. The earlier
plain startup message was sent to stderr and replaced `0.0.0.0` with
`127.0.0.1`; Railway consequently showed a healthy startup as an error. That old
message alone cannot establish either a failed listener or a localhost binding.

## 2. Connect amcp.shop

Add `amcp.shop` as a Railway custom domain. Copy Railway's actual CNAME target and TXT verification name/value into Cloudflare DNS. Use `@` for the apex CNAME and enable Cloudflare proxying. Do not invent the verification record. Railway's current Cloudflare instructions specify SSL/TLS **Full** and Universal SSL. Set `AMCP_PUBLIC_ORIGIN=https://amcp.shop` and redeploy once DNS and HTTPS work.

For `www`, use Cloudflare's documented proxied CNAME and a redirect to `https://amcp.shop`, preserving path and query string. The app has one canonical origin. Avoid rewriting OAuth query parameters. Keep account/API responses out of Cloudflare cache rules. MCP clients cannot complete browser challenges on `/mcp`, `/authorize`, `/token`, `/register`, `/revoke`, or `/.well-known/*`; configure any custom challenge rules accordingly.

References: [Railway custom domains and Cloudflare](https://docs.railway.com/networking/domains/working-with-domains), [Railway volumes](https://docs.railway.com/volumes), [Railway health checks](https://docs.railway.com/deployments/healthchecks).

### Diagnose DNS before changing application settings

`DNS_PROBE_FINISHED_NXDOMAIN` occurs during name resolution, before HTTPS or AMCP.
Compare the system resolver, independent recursive resolvers, the domain's assigned
authoritative nameservers and the parent-zone delegation. Timeouts are not
NXDOMAIN. If authoritative records work but the parent zone has no delegation,
check the registrar's domain status/contact verification and ask the registrar to
restore the delegation. Do not replace working Cloudflare records, change AMCP
authentication/host validation, or disable TLS checks to mask a DNS failure.

On Windows, read-only starting checks are:

```powershell
Resolve-DnsName amcp.shop -Type A -DnsOnly
Resolve-DnsName amcp.shop -Type A -Server 1.1.1.1 -DnsOnly
Resolve-DnsName amcp.shop -Type NS -Server 8.8.8.8 -DnsOnly
```

Use the actual current nameservers from the registrar when checking authority.
Once DNS resolves normally, verify HTTPS `/healthz`, a public policy page, and
MCP's normal unauthenticated refusal before checking signed-in workflows. A local
health check or a request routed to an authoritative address proves only that
specific path. Never pin a Cloudflare address in application code or in the hosts
file as a permanent fix. See the [September 24 incident evidence](implementation/STARTUP-DNS-2026-09-24.md).

## 3. Register provider apps

Use **AMCP** as the app name. Secrets go in Railway variables; Settings shows the exact callback and required variable names. The deployment can start with Meta only and enable other providers later.

| Provider | Callback |
| --- | --- |
| Google Ads | `https://amcp.shop/api/auth/google/callback` |
| Meta | `https://amcp.shop/api/auth/meta/callback` |
| TikTok | `https://amcp.shop/api/auth/tiktok/callback` |
| Snapchat | `https://amcp.shop/api/auth/snapchat/callback` |
| LinkedIn | `https://amcp.shop/api/auth/linkedin/callback` |
| X | `https://amcp.shop/api/auth/x/callback` |
| GA4 | `https://amcp.shop/api/auth/ga4/callback` |
| Google Tag Manager / Google tag | `https://amcp.shop/api/auth/gtm/callback` |
| Google Search Console | `https://amcp.shop/api/auth/gsc/callback` |

Apple Ads uses server-side API credentials and has no browser callback. See [measurement and Apple setup](MEASUREMENT-AND-APPLE.md) for app variables, enabled APIs, resource selection and tested MCP examples. GA4, GTM and Search Console can reuse the Google OAuth client when both dedicated client fields are unset; each still needs its own registered callback and authorization.

All use `AMCP_<PROVIDER>_CLIENT_ID` and `AMCP_<PROVIDER>_CLIENT_SECRET`, with uppercase provider names. X uses its consumer/API key and secret in these variables. Google Ads API access belongs to the Google Cloud project containing that OAuth client after the September 9, 2026 migration. `AMCP_GOOGLE_DEVELOPER_TOKEN` is optional legacy configuration; it cannot grant access to a different Cloud project. Check **Google Cloud → Google Ads API → Overview** for Explorer or higher access to production accounts. An optional manager context uses `AMCP_GOOGLE_LOGIN_CUSTOMER_ID`; synced accounts retain their verified login manager. Meta Login for Business can use `AMCP_META_CONFIG_ID`. TikTok's developer portal may provide `redirect_uri` or `redirect_url`; match it using `AMCP_TIKTOK_REDIRECT_PARAMETER`. LinkedIn API version defaults to `202605` and is configurable.

Privacy URL: `https://amcp.shop/privacy`; terms: `/terms`; deletion instructions: `/data-deletion`. These pages describe this private workspace deployment. Add your actual operator/contact details and retention commitments before applying for public distribution. Provider access approval and app review remain external requirements.

After OAuth, a login starts with no enabled accounts. Open Manage, sync ad accounts, select accounts, and Save selection. Other tabs show related asset inventory; account selections govern MCP access to account data. Syncing, selecting, changing the default, and disconnecting affect AMCP locally. Some resource-specific reads still require an account ownership observation or an explicit administrator binding.

## 4. Connect an MCP client

Open `https://amcp.shop/connectors`. For Codex browser authorization:

```sh
codex mcp add amcp --url https://amcp.shop/mcp
codex mcp login amcp
```

AMCP supports OAuth discovery, dynamic client registration with `none` or `client_secret_post`, S256 PKCE, browser consent, access-token expiry, rotating refresh tokens, and revocation. Confidential clients such as Claude receive a generated secret during registration; AMCP stores it encrypted using `MIRROR_MASTER_KEY`. Claude's `https://claude.ai/api/mcp/auth_callback` redirect is accepted under the same exact HTTPS redirect rules as other clients. For a bearer-token client, create a token on the connector page and use:

```toml
[mcp_servers.amcp]
url = "https://amcp.shop/mcp"
bearer_token_env_var = "AMCP_MCP_TOKEN"
```

Provide `AMCP_MCP_TOKEN` in the client process environment. Website tokens expire after 30 days; browser authorization issues one-hour access tokens with rotating 30-day refresh tokens. Revoke either type on the connector page. New credentials default to operator when write support is enabled; explicit reader credentials remain available. With write support enabled, select operator on the connector page and confirm access; then grant individual accounts in Connections. OAuth clients may explicitly request `mcp:write` during both registration and authorization. See [the write runbook](WRITE-OPERATIONS.md).

## Settings approved by the owner (2026-09-28)

Set these as Railway service variables; AMCP reads them at start-up. This review did not change the deployment.

| Variable | Value | Why |
|---|---|---|
| `MIRROR_FLAGS` | `{"compactSchemas":true}` | Lists each DV360 action once in `tools/list` (about 7 KB smaller); the legacy unprefixed names stay accepted. |
| `AMCP_MCP_ALLOWED_ORIGINS` | Empty, unless an MCP client that sends a browser `Origin` header must connect | `/mcp` refuses every browser origin except AMCP's own, with a JSON-RPC error that names the origin. List exact origins (for example `https://claude.ai`) only for clients you use; this loosens the origin check for them, so it is the owner's decision. |
| `AMCP_TRUSTED_PROXY_CIDRS` | The address range of Railway's edge proxy, as Railway documents it | Sign-in and OAuth rate limits then count each client separately instead of everyone together. Railway, not Cloudflare, is the immediate peer. Confirm the range against the peer address of a real request before relying on it, and list only that range. |

## Provider API versions

AMCP sends Google Ads requests at v25 and Meta requests at Graph API v26.0. Should Meta v26.0 misbehave in production,
setting `AMCP_META_API_VERSION=v25.0` and redeploying moves every Meta request back to v25.0 without a code change;
AMCP refuses to start with any other value. Google Ads has no such setting: its v25 request shapes differ from v23.

## Operations and qualification

The embedded report worker uses the same volume. Do not create a second Railway service expecting to share this volume. To run a separately supervised worker on another supported host, disable the embedded one using `AMCP_RUN_WORKER=false` and provision a shared local database deliberately.

Back up with `npm run admin -- backup /data/backup.amcp`, which writes an encrypted archive under `MIRROR_MASTER_KEY`, and check it with `npm run admin -- backup-verify /data/backup.amcp`; store backups outside the service and keep the encryption key separately. Exercise a restore before depending on the deployment. Database backups contain sensitive account data and encrypted credentials. Never commit them.

The administrator login ignores forwarded IP headers by default. Optional `AMCP_TRUSTED_PROXY_CIDRS` lists verified proxy CIDRs; AMCP walks the chain from the socket toward the client and stops at the first untrusted address. Malformed chains fall back to the socket. Specify the actual Railway ingress proxy addresses, not merely Cloudflare's public ranges: Railway is the immediate peer. Until those addresses and header sanitization are verified, leave this setting empty and expect a shared login rate-limit bucket: every sign-in and OAuth limit then counts all clients together, so a burst of failed attempts from anyone briefly blocks everyone. Setting the verified ingress CIDRs is therefore the recommended production configuration. Do not enable blanket Express proxy trust. Rotating provider secrets or losing refresh access requires reconnecting the affected provider.

Local tests validate contracts and security behavior with synthetic provider responses. They do not demonstrate every live provider workflow. Google discovery currently lists directly accessible customers, not every descendant of a manager hierarchy. Vendor approval, full production OAuth round trips, complete per-platform asset endpoint qualification, and live reporting remain deployment acceptance work. Unsupported or incomplete discovery surfaces return explicit errors. Reviewed campaign-management writes are implemented and opt-in. Their native contracts have synthetic tests, but live mutation qualification is outstanding. Special media and other unsupported write routes remain dry-run-only.
