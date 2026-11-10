---
status: current
tier: operator
---

# Deploy AMCP on Railway with Cloudflare DNS

Repository: https://github.com/magdyezy1/CAMCP; development branch: `Work-here`.

This application runs its website, OAuth callbacks, MCP server, and report worker in one Node 24 service. SQLite and encrypted credentials require a persistent volume. Keep one replica; this release does not use a distributed database.

## Verify the tracked reports before pushing

The Docker build runs `AMCP_REQUIRE_FFMPEG=true npm run check`. Its report check compares the tracked
`.mirror/REPORTS/implementation-status.json`, `.mirror/REPORTS/compatibility-verification.json` and
`.mirror/PARITY.md` with the current generator. Missing or stale artifacts fail the build. After source or
guidance changes, run `npm run build && npm run report`, review the report diff, and commit updated artifacts
with the change. `npm run report -- --check` must pass before pushing.

For a checkout containing historical private account responses, perform build/report generation in a fresh
sanitized release candidate and copy only the changed public report artifacts back into the checkout. Confirm
that `live_read_samples` is an empty array; do not copy historical responses or alter the local private input.
Assemble a fresh candidate after that copy and run `npm run check` without regenerating reports first. Release
assembly preserves the tracked report bytes in its manifest, requires all three artifacts and refuses an
implementation report containing account samples. When hosted CI is enabled, its workflow checks freshness before the full suite and Docker build.
This keeps the candidate's report checks aligned with Railway's checkout build.

After committing the reviewed source/report artifacts, assemble a fresh candidate and run
`npm run release:verify -- .release/candidate` from the clean repository root. Its JSON proof verifies every public
file against exact unfiltered Git blobs, original manifest metadata, three report artifacts and one empty
generated sample. CI requires this step before installation/report/full/container gates and uploads its proof.
This is source verification; continue all behavioral and report freshness checks. See
[maintained source gate](records/DELIVERY-2026-10-04-RELEASE-SOURCE.md).

See the [October 3 report freshness fix](records/DELIVERY-2026-10-03-RAILWAY-REPORT.md) for the reproduced failure
and qualification. A successful source check or CI run does not by itself establish deployed service health.

## Owner-waived GitHub Actions

The owner has exhausted Actions minutes and has waived hosted CI for this delivery. No hosted
run is started, rerun or polled. In this release mode, set Wait for CI **off** for the existing
CAMCP service and verify its connected repository is magdyezy1/CAMCP and trigger branch is
Work-here. Enable the gate again when hosted Actions are explicitly restored.

Railway's gate waits for workflow conclusions: failed workflows skip deployment, completed
skipped/neutral workflows do not block, and unfinished workflows can expire after two hours.
A commit-message skip marker is not a successful CI qualification or proof of the actual service
setting. [Railway autodeploy and CI gate documentation](https://docs.railway.com/deployments/github-autodeploys).

Require the recorded clean-commit local full suite, required FFmpeg, regenerated public reports,
freshness, exact source parity and complete browser proof before the sole push. The Dockerfile
still runs its full check; the owner waiver removes neither it nor deployment acceptance.
Verify the actual service setting and deployed revision in Railway. This checkout does not
supply authenticated Railway settings or deployed-image evidence, and the gate is not asserted
to be the cause of an observed crash.

## 1. Create the service

In Railway, create a project from the AMCP GitHub repository and build the included Dockerfile. Set these service settings explicitly: health-check path `/healthz`, one replica, restart on failure, and Wait for CI configured for the release mode described above. Add a volume mounted at `/data` before connecting accounts. The container initializes the mount directory and then runs Node as the unprivileged `node` user.

Railway has deprecated `railway.json` configuration for new services. The file remains a legacy reference; verify settings in the dashboard instead of assuming it is applied. Existing Config as Code support ends on December 1, 2026. See [Railway's configuration notice](https://docs.railway.com/config-as-code). The [service settings record](#railway-service-settings-owner-record-d1) below lists every value to mirror in the dashboard.

Railway rejects Dockerfile `VOLUME` instructions. This image deliberately has none: create the persistent volume in Railway and set its mount path to `/data`. Set each domain's target port to the service's actual `PORT`. The existing AMCP deployment uses `8080`. Local development defaults to `4317`; that local default does not override Railway's `PORT`.

In production AMCP refuses to start unless `MIRROR_DB` lies inside a declared persistent mount on a different device from the root file system: Railway's `RAILWAY_VOLUME_MOUNT_PATH` (set when a volume is attached) or an explicit `AMCP_DATA_MOUNT`. Without one it logs `storage_not_persistent` and exits, so a missing volume can no longer start a fresh, empty database on container storage that the next deploy discards. A verified start logs `storage_verified` with the mount path. **Before deploying this release, confirm in the Railway dashboard that the volume's mount path is `/data`** (with `MIRROR_DB=/data/mirror.sqlite`); a volume mounted elsewhere stops the new deployment, and Railway keeps the previous one running. `AMCP_ALLOW_EPHEMERAL_DB=true` starts without a volume for local and development use only; health then reports `storage: not_persistent`. AMCP also keeps a volume marker (`/data/.amcp-volume-id`, matched by a database row); a mismatch after a restore or volume move logs `storage_volume_changed` and shows in owner health until you run `gosu node npm run admin -- restamp-volume` deliberately. The entrypoint gives the `node` user the mount directory and the known database files (`mirror.sqlite`, its `-wal` and `-shm` sidecars and the marker), never recursively. Run admin commands over `railway ssh` as that user, `gosu node npm run admin -- <command>`: in production they are refused as root unless `--allow-root` is given for a deliberate repair.

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
| `AMCP_PROVIDER_VALIDATION` | Optional, default `false`. With writes off, `true` allows provider validation (`validate_provider`), which applies nothing but uses write permission; see [WRITE-OPERATIONS](WRITE-OPERATIONS.md#provider-validation) |
| `AMCP_PROVIDER_JOBS` | Optional, default `false`. `true` allows provider report and export jobs with writes off and for readers, on accounts granted report jobs in Connections; see [WRITE-OPERATIONS](WRITE-OPERATIONS.md#provider-report-and-export-jobs) |
| `AMCP_PROVIDERS` | Optional, unset by default. Parked providers (Amazon Ads, Criteo, WooCommerce) are not offered: absent from `tools/list` (<!-- fact:tools_writes -->25<!-- /fact --> tools with reviewed writes) and the website, and every call is refused with `GATEWAY_NOT_OFFERED`. A comma-separated list of provider IDs (`amazon,criteo,woocommerce`) offers them again; see [architecture](review/ARCHITECTURE.md#9-provider-adapters) |
| `AMCP_WIRE_CONTRACTS` | Optional, default `shadow`: pinned vendor request schemas record differences only. Keep `shadow` until 14 days show no `wire_contract_violations` (write violations) and no `wire_contract_check_failures`, then `enforce` (`wire_contract_read_violations` does not block it); see [WRITE-OPERATIONS](WRITE-OPERATIONS.md#pinned-vendor-contracts) |
| `AMCP_RUN_WORKER` | `true` |
| `AMCP_DATA_MOUNT` | Optional: `/data` when `RAILWAY_VOLUME_MOUNT_PATH` is not supplied; the start-up volume guard requires one of them |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `30`: longer than AMCP's 25-second shutdown grace (`AMCP_SHUTDOWN_GRACE_MS`), so a deploy releases read-only jobs and lets writes settle before Railway stops the container |

To keep the administrator password itself out of Railway, set `AMCP_ADMIN_PASSWORD_HASH` instead of `AMCP_ADMIN_PASSWORD`: run `npm run build && npm run admin -- password-hash` locally, type the password, press Enter and then Ctrl-D, and paste the printed `scrypt-v3$…` value. Hashes made before 2026-09-28 (`scrypt$…`) still work, and start-up prints a warning until they are replaced. Changing the administrator password or its hash signs out every administrator session and ends the MCP access approved from them when the new deployment starts; a server still running the old password stops accepting it at that moment. `AMCP_TEST_PASSWORD` and `AMCP_TEST_PASSWORD_HASH` work the same way for reviewer sessions.

The administrator password opens the "Owner sign-in" entry on `/login`. `GET /api/account/options` reports `administratorEnabled` only while that entry can work (the password is configured and the workspace has not moved to its owner email account), and `administratorListed` only until anyone holds an approved account; after that the public sign-in page leaves the entry out, and the deployment owner opens it at `https://<origin>/login?owner=1`. Keep that address with the password. Once owner migration is complete, the owner signs in with email and the entry disappears.

Generate the encryption key locally using `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Put it directly in Railway variables and a password manager. Do not commit it. Preserve this key across deployments: changing it makes existing credentials unreadable. Do not copy your local test database or previously shared provider tokens into this deployment.

The app uses Railway's `PORT`. Networking → Generate Domain supplies the initial HTTPS URL. If you omit `AMCP_PUBLIC_ORIGIN`, AMCP can use Railway's `RAILWAY_PUBLIC_DOMAIN` when supplied; set an explicit origin before registering provider callbacks. Redeploy after changing variables. `/healthz` checks that the database answers and commits one small write, that its volume has room and is persistent, that media expiry is current, and that the offline help completes through a real MCP client and server in memory. It answers `status: up` (200), `degraded` (200: write contention, low or ephemeral storage, stale media expiry, or unknown storage in production) or `unavailable` (503: a failed read or write, full storage, or MCP), naming only each check's state; a result lasts ten seconds. Railway uses it only at deploy time, so point an external uptime monitor at it every minute (see [health and diagnostics](operations/HEALTH.md#health-and-diagnostics)). Every refused or failed `/mcp` request writes one JSON log line (`mcp_refused` or `mcp_failed`, with status, code, origin and a coarse body-size class such as `1-16KiB`, never the token or the body). Inspect write readiness through the authenticated workspace health operation. Sign in and check Settings. An unconfigured provider displays “Setup needed.”

Successful HTTP startup emits one JSON `http_listening` event at `level: info` on
stdout, with the actual bound `host`/`port` and configured `public_origin`. A bind
failure emits `http_listen_failed` at `level: error` and exits nonzero. The earlier
plain startup message was sent to stderr and replaced `0.0.0.0` with
`127.0.0.1`; Railway consequently showed a healthy startup as an error. That old
message alone cannot establish either a failed listener or a localhost binding.

SQLite HTTP/worker failures include a metadata-only `database` record with `result_code`,
`primary_code` and a predefined `name`. Use the actual code to distinguish full storage,
locking, constraint, schema or I/O failures; `ERR_SQLITE_ERROR` alone is insufficient.
MCP tool failures on SQLite storage or contention return `STORAGE_FULL` or `DATABASE_BUSY` with a request ID and write one `mcp_tool_failed` line.
Actual `SQLITE_FULL` returns `STORAGE_FULL` with a capacity explanation and server reference;
it does not bypass sign-in limits or reset a password. Preserve the database and encryption
key during capacity repairs. See the [sign-in incident](records/INCIDENT-2026-10-06-SIGNIN-DATABASE.md).

## Railway service settings (owner record, D1)

`railway.json` and this table hold the same deploy gate; `node deploy/check-railway.mjs` and
`tests/railway-config.test.mjs` fail when they differ. After the Config as Code cutoff (2026-12-01) only the dashboard
applies, so before 2026-11-15 the owner copies each dashboard value into the last column with the date (OPS-05). After
the first deploy past the cutoff, check that the deployment still shows a healthcheck phase and that `/versionz`
matches, then keep `railway.json` as a reference only.

| Setting | Repository (`railway.json`) | Dashboard value (owner, dated) |
|---|---|---|
| Builder | `DOCKERFILE` (`Dockerfile`) | |
| Healthcheck path | `/healthz` | |
| Healthcheck timeout (seconds) | `120` | |
| Restart policy | `ON_FAILURE` | |
| Restart policy retries | `5` | |
| Replicas | `1` | |
| Watch paths | `**`, `!/docs/**`, `/docs/REPORTING-OVERVIEW.md` | |
| Volume mount path | dashboard only: /data | |
| RAILWAY_DEPLOYMENT_DRAINING_SECONDS | dashboard only: 30, above the 25-second shutdown grace (OPS-07) | |
| Wait for CI | dashboard only: off while hosted CI is waived | |
| Repository and trigger branch | dashboard only: magdyezy1/CAMCP, Work-here | |
| Build timeout of the plan | dashboard only | |
| Deploy cadence and downtime window | owner statement | |

**Watch paths.** Every change deploys except documentation: `docs/**` (which covers `docs/review/**`) is left out, and
`docs/REPORTING-OVERVIEW.md` is kept because the image ships it as an MCP guide. A docs-only push then neither rebuilds
nor redeploys; every redeploy of a service with a volume has a short downtime and can break pages already open in a
browser (WEB-04). Patterns
are read in order and the last match decides. `deploy/check-railway.mjs` checks that every path the Dockerfile copies,
and the source, build and test directories, still deploy. Set the same three lines as the service's watch paths in the
dashboard, since repository configuration stops applying after the cutoff. After the first docs-only push, confirm that
no new deployment appeared and `/versionz` is unchanged; if Railway deployed it anyway, list the deploying top-level
paths instead (`src`, `server`, `web`, `generated`, `tools`, `tests`, `codegen`, `deploy`, `Skills`, `.mirror`, the
root build files and `docs/REPORTING-OVERVIEW.md`). A docs-only push runs no in-build check, so run
`npm run check:fast` (the documentation index check) before pushing documentation.

**Not changed by OPS-05.** The image still copies all of `dist`, including about 3 MB of compiled tests: leaving them
out changes the packaged identity that `/versionz` and the local qualification record (QA-01) must both match, so it
waits for a change that moves both together. The build still runs the full check. No `AMCP_DOCKER_CHECK=fast` switch
was added: the in-build check is the per-release Linux evidence ([below](#per-release-linux-evidence-from-railway-builds))
and the only enforced gate while hosted CI is waived.

**Per-release record.** For each deployment, keep outside the repository:

1. The deployed revision and time, and the build evidence record with the image digest
   ([Linux evidence](#per-release-linux-evidence-from-railway-builds)).
2. The public observation after the deploy: `GET https://amcp.shop/healthz` answers `up` or `degraded`; `GET /versionz`
   answers `matches_build` with `build.source_revision` equal to the deployed revision; with a local qualification
   record, `npm run check:public-website -- --origin https://amcp.shop --expect-record <record.json>` passes.
3. The Railway build duration (record the next five deploys as the baseline) and whether the push was docs-only (then
   no deployment is expected).

## 2. Connect amcp.shop

Add `amcp.shop` as a Railway custom domain. Copy Railway's actual CNAME target and TXT verification name/value into Cloudflare DNS. Use `@` for the apex CNAME and enable Cloudflare proxying. Do not invent the verification record. Railway's current Cloudflare instructions specify SSL/TLS **Full** and Universal SSL. Set `AMCP_PUBLIC_ORIGIN=https://amcp.shop` and redeploy once DNS and HTTPS work.

For `www`, use Cloudflare's documented proxied CNAME and a redirect to `https://amcp.shop`, preserving path and query string. The app has one canonical origin. Avoid rewriting OAuth query parameters. Keep account/API responses out of Cloudflare cache rules. MCP clients cannot complete browser challenges on `/mcp`, `/authorize`, `/token`, `/register`, `/revoke`, or `/.well-known/*`; configure any custom challenge rules accordingly.

Cloudflare caching must respect AMCP's own headers. In **Caching → Configuration**, set **Browser Cache TTL** to
**Respect Existing Headers** (owner-run; not yet applied). With an override, Cloudflare rewrote the origin's
`no-cache` on unversioned `/assets/app.js`, `/assets/mark.svg` and the Arabic font to `max-age=14400`. Pages
reference only `/assets/v/<version>/…` addresses, which are `immutable`, so the setting matters for legacy links
and bookmarks. To check it after the change, a `HEAD` request on `https://amcp.shop/assets/app.js` should return
`Cache-Control: no-cache`, and the landing page's network log should show only versioned asset addresses. Also
turn off automatic Web Analytics injection (owner decision D2): the site's security policy blocks that beacon.

The beacon (OPS-05): with automatic setup on, Cloudflare inserts a `static.cloudflareinsights.com` script into every
HTML response requested with a browser `Accept` header, and the origin's `script-src 'self'` blocks it (a console error
on 19 of 19 page loads on 2026-10-08), so no analytics are collected. AMCP's security policy and privacy pages stay as
they are (D2). After the owner turns automatic setup off in the zone's Web Analytics settings in Cloudflare, check
that `GET` of `/`, `/about` and `/privacy` with `Accept: text/html` contains no `cloudflareinsights` script and that
`npm run check:public-website -- --origin https://amcp.shop` reports a raw byte match for `/about`. The checker keeps
its narrow explanation of that known insertion for one more release after the confirmation, and is then removed. If
analytics are wanted later, the CSP must allow that one host and both privacy pages must disclose it first.

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

<!-- doc-facts:oauth-platforms:begin (generated by npm run docs:index; do not edit) -->
Generated from the website platforms (`platforms` in `server/platform-oauth.ts`) and their client lookup
(`appClient` in `src/app-credentials.ts`). Replace the origin for another deployment; Settings shows each callback
of the running deployment. Every platform but Apple Ads also takes `AMCP_<STEM>_SCOPES`, which replaces its default
scopes.

| Platform | Callback | Client variables | When both are unset | Also |
|---|---|---|---|---|
| Google Sheets | `https://amcp.shop/api/auth/sheets/callback` | `AMCP_SHEETS_CLIENT_ID`, `AMCP_SHEETS_CLIENT_SECRET` | the Google client (`AMCP_GOOGLE_CLIENT_ID`) | — |
| Google Drive | `https://amcp.shop/api/auth/drive/callback` | `AMCP_DRIVE_CLIENT_ID`, `AMCP_DRIVE_CLIENT_SECRET` | the Google client (`AMCP_GOOGLE_CLIENT_ID`) | — |
| Microsoft Advertising | `https://amcp.shop/api/auth/microsoft/callback` | `AMCP_MICROSOFT_CLIENT_ID`, `AMCP_MICROSOFT_CLIENT_SECRET` | — | `AMCP_MICROSOFT_DEVELOPER_TOKEN` (required) |
| Google Ads | `https://amcp.shop/api/auth/google/callback` | `AMCP_GOOGLE_CLIENT_ID`, `AMCP_GOOGLE_CLIENT_SECRET` | — | — |
| Meta | `https://amcp.shop/api/auth/meta/callback` | `AMCP_META_CLIENT_ID`, `AMCP_META_CLIENT_SECRET` | — | — |
| TikTok | `https://amcp.shop/api/auth/tiktok/callback` | `AMCP_TIKTOK_CLIENT_ID`, `AMCP_TIKTOK_CLIENT_SECRET` | — | — |
| Snapchat | `https://amcp.shop/api/auth/snapchat/callback` | `AMCP_SNAPCHAT_CLIENT_ID`, `AMCP_SNAPCHAT_CLIENT_SECRET` | — | — |
| LinkedIn | `https://amcp.shop/api/auth/linkedin/callback` | `AMCP_LINKEDIN_CLIENT_ID`, `AMCP_LINKEDIN_CLIENT_SECRET` | — | — |
| X (Twitter) | `https://amcp.shop/api/auth/x/callback` | `AMCP_X_CLIENT_ID`, `AMCP_X_CLIENT_SECRET` | — | — |
| Google Analytics 4 | `https://amcp.shop/api/auth/ga4/callback` | `AMCP_GA4_CLIENT_ID`, `AMCP_GA4_CLIENT_SECRET` | the Google client (`AMCP_GOOGLE_CLIENT_ID`) | — |
| Google Tag Manager | `https://amcp.shop/api/auth/gtm/callback` | `AMCP_GTM_CLIENT_ID`, `AMCP_GTM_CLIENT_SECRET` | the Google client (`AMCP_GOOGLE_CLIENT_ID`) | — |
| Google Search Console | `https://amcp.shop/api/auth/gsc/callback` | `AMCP_GSC_CLIENT_ID`, `AMCP_GSC_CLIENT_SECRET` | the Google client (`AMCP_GOOGLE_CLIENT_ID`) | — |
| Apple Ads | none: server-side client credentials | `AMCP_APPLE_CLIENT_ID`, `AMCP_APPLE_CLIENT_SECRET` | — | or `AMCP_APPLE_TEAM_ID`, `AMCP_APPLE_KEY_ID` and `AMCP_APPLE_PRIVATE_KEY` instead of the secret |
| Display & Video 360 | `https://amcp.shop/api/auth/dv360/callback` | `AMCP_DV360_CLIENT_ID`, `AMCP_DV360_CLIENT_SECRET` | the Google client (`AMCP_GOOGLE_CLIENT_ID`) | — |
| Google Business Profile | `https://amcp.shop/api/auth/google_business/callback` | `AMCP_GBP_CLIENT_ID`, `AMCP_GBP_CLIENT_SECRET` | the Google client, once `AMCP_GBP_API_APPROVED=true` | — |
| Reddit | `https://amcp.shop/api/auth/reddit/callback` | `AMCP_REDDIT_CLIENT_ID`, `AMCP_REDDIT_CLIENT_SECRET` | — | `AMCP_REDDIT_USER_AGENT` (optional; a default names AMCP) |
<!-- doc-facts:oauth-platforms:end -->

Apple Ads uses server-side API credentials and has no browser callback. See [measurement and Apple setup](MEASUREMENT-AND-APPLE.md) for app variables, enabled APIs, resource selection and tested MCP examples. The platforms the table marks reuse the Google OAuth client when both of their own client fields are unset; each still needs its own registered callback and authorization.

Each platform reads `AMCP_<STEM>_CLIENT_ID` and `AMCP_<STEM>_CLIENT_SECRET` with the stem the table shows (Business Profile's is `GBP`). X uses its consumer/API key and secret in these variables. Google Ads API access belongs to the Google Cloud project containing that OAuth client after the September 9, 2026 migration. Google sunset developer tokens on 2026-09-09 and will reject the header in a future major version, so AMCP never sends `AMCP_GOOGLE_DEVELOPER_TOKEN`; while it is set, startup and owner health warn. Remove it from the Railway variables. Check **Google Cloud → Google Ads API → Overview** for Explorer or higher access to production accounts. An optional manager context uses `AMCP_GOOGLE_LOGIN_CUSTOMER_ID`; synced accounts retain their verified login manager. Meta Login for Business can use `AMCP_META_CONFIG_ID`. TikTok's developer portal may provide `redirect_uri` or `redirect_url`; match it using `AMCP_TIKTOK_REDIRECT_PARAMETER`. LinkedIn API version defaults to `202609`. `AMCP_LINKEDIN_API_VERSION` may only name a version AMCP has reviewed (`linkedinVersions` in `src/linkedin-version.ts`, now 202609 only) before its sunset; the server refuses to start with any other value (unset, the default's own sunset refuses LinkedIn requests only, never startup or other providers), and owner health (`linkedin_version`, `provider_version_alarms`) flags an override and a sunset within 90 days. Leave it unset unless rolling back to another reviewed version.

Privacy URL: `https://amcp.shop/privacy`; terms: `/terms`; deletion instructions: `/data-deletion`. All three are complete static pages in English and Arabic (`?lang=ar`), readable without a session, JavaScript or a working API, and they name `privacy@amcp.shop` as the contact. They describe this private workspace deployment. The Terms wording was drafted by engineering; on 2026-10-18 the owner approved publishing it unchanged, with the operator named as the operator of AMCP at amcp.shop, the deletion process (`web/data-deletion*.html`) and the privacy policy, and an effective date of the day of the push that published them (18 October 2026 in `web/terms*.html`) (D3). A change to the wording, the effective date or the operator's legal name and jurisdiction is an owner decision. Provider access approval and app review remain external requirements.

The public surface also answers `/robots.txt`, `/favicon.ico` and `/apple-touch-icon.png` (temporary redirects to the versioned brand-kit files) and `/.well-known/security.txt`; set `AMCP_SECURITY_CONTACT` (a `mailto:` or `https:` URI) to the security contact, which otherwise falls back to `mailto:privacy@amcp.shop` (the owner kept that fallback on 2026-10-18). Its `Expires` is the date the contact was last reviewed for (`securityTxtExpires` in `server/public-assets.ts`, or `AMCP_SECURITY_TXT_EXPIRES` as an ISO date), not a date renewed on every response; review the contact and move the date forward before it passes (owner action, D3). Unknown page addresses return a branded 404 (`web/404*.html`), unknown `/api` addresses a JSON `NOT_FOUND`, and page templates are never served under `/assets`. HSTS stays without `includeSubDomains` until the owner confirms every subdomain is HTTPS-only.

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

Provide `AMCP_MCP_TOKEN` in the client process environment. Website tokens expire after 30 days; browser authorization issues one-hour access tokens with rotating 30-day refresh tokens. A just-rotated refresh token presented again within `AMCP_MCP_REFRESH_REUSE_SECONDS` (default 60, 0 to 60) gets a fresh pair in the same connection instead of ending it; later reuse still ends the connection. Any active workspace member may connect their own AI client or create a connector token, capped by role: viewers read only, operators and above may also approve reviewed changes. Owners and administrators revoke any token or client on the connector page; a member revokes their own. New credentials default to operator when write support is enabled and the member's role allows it; the consent screen and the connector page both offer read-only access instead. With write support enabled, select operator on the connector page and confirm access; then grant individual accounts in Connections. OAuth clients may explicitly request `mcp:write` during both registration and authorization. See [the write runbook](WRITE-OPERATIONS.md).

## Settings approved by the owner (2026-09-28)

Set these as Railway service variables; AMCP reads them at start-up. This review did not change the deployment.

| Variable | Value | Why |
|---|---|---|
| `MIRROR_FLAGS` | `{"compactSchemas":true}` | Lists each DV360 action once in `tools/list` (about 7 KB smaller); the legacy unprefixed names stay accepted. |
| `AMCP_MCP_ALLOWED_ORIGINS` | Empty, unless an MCP client that sends a browser `Origin` header must connect | `/mcp` refuses every browser origin except AMCP's own, with a JSON-RPC error that names the origin. List exact origins (for example `https://claude.ai`) only for clients you use; this loosens the origin check for them, so it is the owner's decision. Recommended (2026-09-29): leave it empty and add an origin only when the refusal log shows that client's requests refused (one JSON line per refused `/mcp` request names the origin); a client that runs on a server sends no `Origin` and is unaffected. Since MCP-03 (2026-10-08) a listed origin also gets its CORS preflight answered and its exact origin on responses, so a browser client can read them. |
| `AMCP_MCP_BATCH_MAX` | Empty (`1`; owner decision D6, 2026-10-08) | `/mcp` refuses every JSON-RPC array with HTTP 400 and JSON-RPC `-32600` (`BATCH_UNSUPPORTED`) before any item runs; MCP 2025-06-18 removed batching. `2`-`10` accept that many items, and only from clients that negotiated protocol `2025-03-26`; use it only if a client you rely on still batches, as the refusal log shows. |
| `AMCP_MCP_RATE_PER_MINUTE`, `AMCP_MCP_RATE_BURST`, `AMCP_MCP_MAX_IN_FLIGHT` | Empty (60, 20 and 4; owner decision D6) | Per-actor `/mcp` limits: each OAuth connector or API key may send 60 requests a minute after a burst of 20 (a token bucket shared through the database), with at most 4 requests open at once on an instance. Beyond them the answer is HTTP 429 with `Retry-After` and a JSON-RPC error whose `data.code` is `RATE_LIMITED`. They are keyed on the credential, never the client address. Starting values: tune them from the `RATE_LIMITED` lines of the refusal log; `0` turns the rate or the in-flight cap off as a rollback. |
| `AMCP_MCP_CLIENT_METADATA` | Empty (on) | MCP-03: clients such as Claude Code and Codex may identify themselves with an HTTPS client metadata document instead of registering, so reconnecting does not add registrations. AMCP fetches the document from public addresses only, without redirects, at most 10 KB within 5 seconds, and caches it for 5 minutes to 24 hours. `off` accepts registered clients only and stops advertising `client_id_metadata_document_supported`. |
| `AMCP_MCP_CLIENT_METADATA_HOSTS` | Empty (any public host) | Optional exact host names, comma-separated, whose metadata documents are accepted, for example `claude.ai`; documents from other hosts are refused. |
| `AMCP_MCP_REGISTRATIONS_PER_ADDRESS_DAILY`, `AMCP_MCP_REGISTRATIONS_DAILY` | Empty (30 and 300) | MCP-03 phase 2: new AI-client registrations (dynamic client registration) accepted in 24 hours from one client address (IPv6: one /64, as resolved by `AMCP_CLIENT_IP_SOURCE`) and by the whole deployment. Beyond them `/register` answers 429 `too_many_requests` with `Retry-After`; clients that use a metadata document never register and are not counted. They replace the old global refusal at 1,000 registered clients. Hosted clients such as Claude.ai and ChatGPT register from their own servers, so one address can carry many people's connections: raise the per-address value if the owner health view or the `mcp_registration_limited` log line shows legitimate connections refused. At 80% of the daily limit, or of the 5,000 registered clients kept as a storage backstop, the owner health view and the log (`mcp_registration_alarm`, at most once an hour per kind, without addresses) raise an alarm. A value that is not a whole number in range (1–1,000 and 1–10,000, per address not above the daily value) is ignored with a start-up problem and the defaults apply. |
| `AMCP_MCP_MODERN_PROTOCOL` | Empty (`off`) | MCP-03 phase 3: `next` also serves MCP revision 2026-07-28 (stateless requests with `server/discover`, `Mcp-Method`/`Mcp-Name` headers) next to the earlier revisions at `/mcp/next`, for the ACC-02 client checks on staging; `on` serves both eras at `/mcp` too. Set `on` only after ACC-02 shows the clients you use connect through `/mcp/next`. `off` (or removing the variable) is the rollback, and with it a client that declares the tasks extension is answered no tasks (exports and background runs are polled as before). The standalone stdio server reads the same variable: `next` and `on` serve the revision there, `off` or empty serves the earlier ones only. Another value is ignored with a start-up problem. |
| `AMCP_MCP_REFRESH_REUSE_SECONDS` | Empty (60 seconds) | Owner decision D16 (review 2026-10-08): two tabs or a lost response may present a just-rotated MCP refresh token again; inside this window the connection continues, after it the token family ends as before. `0` restores strict rotation; AMCP refuses to start with a value outside 0–60. Each reuse is audited as `mcp_oauth_refresh_reused` and each ended connection as `mcp_oauth_family_revoked` with its reason. |
| `AMCP_CLIENT_IP_SOURCE` | `railway+cloudflare` (owner decision D5, 2026-10-08; set after the SEC-01 release) | Sign-in, email and OAuth rate limits then count each client separately instead of everyone together. Railway overwrites `X-Real-IP` with its connecting client, which is a Cloudflare edge address when Cloudflare proxies the request; AMCP then uses `CF-Connecting-IP`, and only from an address in Cloudflare's published ranges. Unset keeps the earlier behavior. See "Client addresses for rate limits" below. |
| `AMCP_TRUSTED_PROXY_CIDRS` | Empty | Railway publishes no stable proxy range, so the earlier advice to list one cannot be followed. It applies only to `AMCP_CLIENT_IP_SOURCE=xff-cidrs` and is ignored, with a start-up warning, under the Railway profiles. |

**Deployment checklist, passwords (SEC-06).** The built-in check for common passwords is a heuristic. For the NIST
SP 800-63B requirement to compare new passwords against values known to be commonly used or compromised, set
`AMCP_PASSWORD_BLOCKLIST_FILE` to a vetted public list (one password per line; only passwords of 15 or more
characters matter) on the service that serves the website. See [user accounts](USER-ACCOUNTS.md).

## Provider API versions

AMCP sends Google Ads requests at v25 and Meta requests at Graph API v26.0. Should Meta v26.0 misbehave in production,
setting `AMCP_META_API_VERSION=v25.0` and redeploying moves every Meta request back to v25.0 without a code change;
AMCP refuses to start with any other value. Google Ads has no such setting: its v25 request shapes differ from v23.

## Operations and qualification

The embedded report worker uses the same volume. Do not create a second Railway service expecting to share this volume. To run a separately supervised worker on another supported host, disable the embedded one using `AMCP_RUN_WORKER=false` and provision a shared local database deliberately.

Enable Railway's scheduled backups for the service volume; they restore to a new volume. For an off-host copy, back up with `npm run admin -- backup /tmp/amcp-backup.amcp` (outside the `/data` volume: in production a destination on the database's volume is refused), which writes an encrypted archive under `MIRROR_MASTER_KEY` and verifies it; copy it off the service, delete the local copy, and keep the encryption key separately. Check a copy with `npm run admin -- backup-verify <file>`. See [backups that complete and the restore drill](operations/ERASURE-AND-RETENTION.md#restore-drill). Exercise a restore before depending on the deployment. Database backups contain sensitive account data and encrypted credentials. Never commit them.

### Client addresses for rate limits

Every anonymous limit (password sign-in, reset and registration email, the administrator and reviewer doors, and the
OAuth `/authorize`, `/token`, `/register` and `/revoke` endpoints) is keyed on the client address, with IPv6 grouped
by /64. Behind Cloudflare and Railway the TCP peer is Railway's proxy, so without a profile every client shares one
key and a burst of failures from anyone briefly blocks everyone. `AMCP_CLIENT_IP_SOURCE` chooses where the address
comes from; start-up fails on any other value:

| Value | Address used |
|---|---|
| unset | The earlier behavior: `xff-cidrs` when `AMCP_TRUSTED_PROXY_CIDRS` is set, otherwise `socket`. |
| `socket` | The TCP peer only; every header is ignored. |
| `xff-cidrs` | `X-Forwarded-For`, walked from the socket toward the client through `AMCP_TRUSTED_PROXY_CIDRS`, stopping at the first untrusted hop. Malformed chains fall back to the socket. For hosts other than Railway. |
| `railway` | The single address in `X-Real-IP`, which Railway's edge overwrites. Use it when Cloudflare does not proxy the domain. |
| `railway+cloudflare` | As `railway`; when that address is inside Cloudflare's published ranges, the single address in `CF-Connecting-IP`. A request that reaches the `*.up.railway.app` host directly cannot choose its address with a forged `CF-Connecting-IP`. |

A missing, listed or malformed header always falls back to the next source down and finally to the socket, which is
the shared key of today, never an address the request chose. Per-account limits apply whatever the profile. Do not
enable blanket Express proxy trust. Roll back with `AMCP_CLIENT_IP_SOURCE=socket`, or `xff-cidrs` for exactly the
earlier behavior.

After setting the profile, open Settings as the deployment owner (or call `amcp_workspace` `owner` `health`): the
"Rate-limit attribution" panel and `rate_limits` field show the active key source, whether `X-Real-IP` and
`CF-Connecting-IP` arrived in the last hour, and how many distinct limit keys were used in the last hour. They never
show an address. After sign-ins from two networks the distinct count should be at least 2. A warning appears when a
proxy sends `X-Real-IP` but the configured source ignores it. Only the deployment workspace's owner sees these
deployment-wide counts.

The Cloudflare ranges are a committed snapshot (`generated/cloudflare-ranges.json`, compiled into
`server/cloudflare-ranges.ts`); builds never fetch them, and `npm run generate:cloudflare:check` verifies the module
offline. **Release checklist:** run `node tools/cloudflare-ranges.mjs --refresh`, which fetches
https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6, review the diff and commit it with the
release. The first snapshot was transcribed without network access (its `retrieved_at` is `null`), so refresh it
before relying on `railway+cloudflare`.

`/token` and `/revoke` count failed client authentication and refused grants only (50 per address per 15 minutes,
answered with OAuth-shaped `429 too_many_requests` and `Retry-After`). Successful exchanges and refreshes do not
count, so connectors behind one address keep refreshing; each registered client also has its own budget of 30
successful token responses per 15 minutes, a starting value to tune from logs.

Rotating provider secrets or losing refresh access requires reconnecting the affected provider.

Local tests validate contracts and security behavior with synthetic provider responses. They do not demonstrate every live provider workflow. Google discovery currently lists directly accessible customers, not every descendant of a manager hierarchy. Vendor approval, full production OAuth round trips, complete per-platform asset endpoint qualification, and live reporting remain deployment acceptance work. Unsupported or incomplete discovery surfaces return explicit errors. Reviewed campaign-management writes are implemented and opt-in. Their native contracts have synthetic tests, but live mutation qualification is outstanding. Special media and other unsupported write routes remain dry-run-only.

## Per-release Linux evidence from Railway builds

Railway builds the Dockerfile on Linux, and its build stage runs the full check with FFmpeg required
(`AMCP_REQUIRE_FFMPEG=true AMCP_TEST_CONCURRENCY=2 npm run check`); a failing check fails the deploy. Every deployed
revision therefore already has a Linux full-suite run behind it, and B16's Linux evidence is harvested from it for each
release (a standing per-release step under D25, with the hosted-CI waiver recorded as an acceptance amendment in
[decisions](DECISIONS.md)). This holds only while the dashboard does not override the repository build settings (D1),
and only for a build that ran the check rather than reusing it from the build cache.

1. **Export (owner, read-only).** Open the deployment's build log in the Railway dashboard and save it as a text file;
   note the image digest if the deployment view shows one. Save the public `/versionz` answer
   (`curl -sS https://amcp.shop/versionz > versionz.json`). Confirm that the service builds the repository Dockerfile
   with no custom build command.
2. **Record.** Run `tools/railway-build-evidence.mjs`, which reads only the files named and writes new files only:

   ```sh
   npm run evidence:railway -- --log build.log --commit <deployed revision> --versionz versionz.json \
     --deployed-at <time> --record <new>.json --excerpt <new>.txt
   ```

   The record holds the check step's facts (executed or cached, duration, FFmpeg required), the test totals per run,
   the build's package digest and Git claim from `release_identity_written`, the base image and image digests, the
   `/versionz` facts and SHA-256 hashes of the log and of the sanitized excerpt, never log text. Exit 0 means the check
   executed with FFmpeg required and zero failed tests and `/versionz` matches; exit 1 lists the reasons (for example
   `CHECK_STEP_CACHED`, `TESTS_FAILED`, `VERSIONZ_COMMIT_MISMATCH`).

3. **Keep.** Store the record and excerpt with the release record outside the repository (qualification records stay
   local, D25), starting with the revision deployed on 2026-10-18 (its
   [deployment record](records/DEPLOYMENT-2026-10-18.md) names it). The base image digest in the record is the value
   to pin in the Dockerfile ([operations](operations/QUALIFICATION.md#qualification-records),
   [what the 2026-10-18 deployment taught](#what-the-2026-10-18-deployment-taught)).

Before pushing a change that touches how tests find files, run them the way the container build does:
`npm run qualify:container` copies the release scope minus `.dockerignore` outside any Git repository, links the
installed dependencies and runs `npm run check` there (`-- --test tests/<name>.test.mjs` runs the build and the named
tests only). A test that passes in the checkout but needs `.git`, an ignored file or a path outside the release scope
fails there instead of in Railway's build. The build runs as root, so tests spawn the admin CLI only through
`tests/admin-cli.ts`, which passes `--allow-root` ([operations](operations/QUALIFICATION.md#qualification-records), "Tests run as
root").

Startup, sign-in, MCP, restart and revocation smoke on Linux needs a non-production Railway environment with its own
volume, synthetic connections and `MIRROR_ALLOW_WRITES=false`, never production secrets or the production volume (owner
resource R7). `deploy/smoke.mjs` runs the same checks against a locally built image on a host with Docker.

## What the 2026-10-18 deployment taught

`Work-here` was pushed on 2026-10-18, after the Windows release gate (`wave4a-gate-3`) and the Windows
container-parity run (every test passed outside Git) had passed. Railway's Linux build then failed twice, and the first
build that passed did not start (owner report, 2026-10-18; the [deployment record](records/DEPLOYMENT-2026-10-18.md)
names each revision):

| Step | What happened on Railway | Fix |
| --- | --- | --- |
| 1 | The backup tests failed: `node:sqlite` in the image refused the online-backup rate `-1`, SQLite's "all pages" value, which the Windows Node accepted | `snapshotDatabase` uses `0x7fffffff`, the largest positive 32-bit page batch, so a backup still copies the database in one step from one read snapshot |
| 2 | The same-volume backup test failed: the build runs `npm run check` as root, and the admin CLI refuses root without `--allow-root`, so the test stopped at that refusal instead of `BACKUP_SAME_VOLUME` | The test's two admin CLI calls pass `--allow-root`; in production admin commands still run as `node` (`gosu node npm run admin -- <command>`) |
| 3 | The deployment refused to start: the service variable `AMCP_LINKEDIN_API_VERSION` held a LinkedIn version AMCP has not reviewed | The owner set it to `202609`; Railway then reported the deployment of the second fix successful and active |

What follows for each push (ACC-04):

- **Parity is not Linux evidence.** Container parity on Windows (`npm run qualify:container`) copies the release scope
  outside Git and runs the same `npm run check`, so it catches a test that needs `.git`, an ignored file or a path
  outside the release scope. It cannot reproduce the image's root user, its Node patch version or its operating system.
  The Railway build log of the deployed revision is the Linux evidence: record it with `npm run evidence:railway`
  ([per-release evidence](#per-release-linux-evidence-from-railway-builds)).
- **Pin the base image (owner step).** Both `FROM node:24-bookworm-slim` stages of the Dockerfile follow a floating tag,
  so a later build can take another Node 24 patch than the one that passed. Pin both to the `base_image.digest` of the
  evidence record of the deployed revision (`FROM node:24-bookworm-slim@sha256:<digest>`), and move the pin
  deliberately when Node is upgraded (OPS-08).
- **Root in tests.** The admin CLI refuses root in production mode unless `--allow-root` is given
  (`adminRootRefusal` in `server/config.ts`), and the Docker build runs `npm run check` as root, so a test that runs
  the admin CLI for another purpose passes `--allow-root` and must give the same result as root and as another user.
  No check enforces this yet; until one does, review such tests by hand before a push.
- **Start-up settings.** Before a push, compare the service variables with the values the release accepts. Start-up
  stops on a LinkedIn or Meta version AMCP has not reviewed (`AMCP_LINKEDIN_API_VERSION`, `AMCP_META_API_VERSION`;
  the `startup_failed` line names the stage `provider_versions`), a misspelt `AMCP_WIRE_CONTRACTS`, an invalid
  `AMCP_PROVIDER_QUOTA_MODE` or `AMCP_PROVIDER_QUOTA_PROFILES`, a switch such as `MIRROR_ALLOW_WRITES` that is neither
  `true` nor `false`, a production website without `MIRROR_MASTER_KEY` or an administrator password, and a production
  database outside a verified persistent volume. A few optional values only warn (`config_problem`) and keep their
  defaults, for example `AMCP_SHUTDOWN_GRACE_MS` or a provider ID `AMCP_PROVIDERS` does not know.
  [.env.example](../.env.example) names the accepted values; after a deploy, read the start log as well as the build
  log.

## Compare public website bytes before accepting a deployment

Run the explicit bounded public comparison from the qualified checkout:

```sh
npm run check:public-website -- --origin https://amcp.shop
# or, against a local qualification record (adds /versionz and the landing page's asset version):
npm run check:public-website -- --origin https://amcp.shop --expect-record .runtime/qualifications/<hash>.json
```

The command reads only public /healthz, /about and /assets/locales/ar.json, follows no redirect
and sends no credential. It checks liveness plus exact local About/Arabic file bytes. Exit 0
passes those selected observations; exit 1 reports an observed refusal/timeout/invalid response
or static byte difference; exit 2 indicates invalid usage or unavailable local comparison.
A byte difference does not identify deployed backend Git/image or the failure cause. Use the
actual Railway service's connected repository/branch, deployment source/revision, build/runtime
logs, watch paths and environment history to resolve it. Never infer a failed Docker build or
CI-block setting from public health alone. Keep the service bound only to magdyezy1/CAMCP and
Work-here; owner-waived hosted Actions remain disabled unless the owner restores them.
See [comparison evidence and scope](records/DELIVERY-2026-10-05-CORE-CONTRACT-DIAGNOSTICS.md).

### Interpret a received HTML byte mismatch

The public comparison checks received bytes, including any response insertion or transformation.
On October 5 at 12:14 UTC the About response had one additional 367-byte fragment containing a
Cloudflare beacon script; removing that fragment left the local page byte-for-byte. The tool
correctly reports the raw difference. That alone does not mean a changed About source, failed
Docker build or different backend image. Inspect the actual difference and authenticated service
history. The separately observed Arabic asset still matches an older known locale file. Never
normalize away an unknown insertion or turn liveness/static observations into backend acceptance.
See [bounded public evidence](records/DELIVERY-2026-10-05-BROWSER-SEMANTICS.md).

## Delivery notes

The sections this guide collected from the October 2026 delivery batches are kept as written in [Deployment guide notes of the October 2026 deliveries](records/DEPLOY-RAILWAY-BATCH-NOTES-2026-10.md) since 2026-10-24 (DOC-03):

- <a id="public-packaged-release-identity--batch-174"></a>Public packaged release identity — batch 174
- <a id="wrapper-arabic-source-and-public-observation--batch-175"></a>Wrapper Arabic source and public observation — batch 175
- <a id="interpreting-public-liveness"></a>Interpreting public liveness
- <a id="batch-178--local-selected-accessibility-guard"></a>Batch 178 — local selected accessibility guard
- <a id="batch-179--original-campaignhourday-evidence"></a>Batch 179 — original campaign/hour/day evidence
- <a id="batch-180--other-listed-x-products-with-explicit-retention"></a>Batch 180 — other listed X products with explicit retention
- <a id="batches-182183--inventory-and-bounded-worker-observations"></a>Batches 182/183 — inventory and bounded worker observations
- <a id="batch-184--administrator-commerce-connections-and-final-browser-gates"></a>Batch 184 — administrator commerce connections and final browser gates
- <a id="batch-185--public-payload-and-intermediary-diagnosis"></a>Batch 185 — public payload and intermediary diagnosis
