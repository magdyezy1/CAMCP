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
[maintained source gate](review/DELIVERY-2026-10-04-RELEASE-SOURCE.md).

See the [October 3 report freshness fix](review/DELIVERY-2026-10-03-RAILWAY-REPORT.md) for the reproduced failure
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

Railway has deprecated `railway.json` configuration for new services. The file remains a legacy reference; verify settings in the dashboard instead of assuming it is applied. Existing Config as Code support ends on December 1, 2026. See [Railway's configuration notice](https://docs.railway.com/config-as-code).

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
| `AMCP_RUN_WORKER` | `true` |
| `AMCP_DATA_MOUNT` | Optional: `/data` when `RAILWAY_VOLUME_MOUNT_PATH` is not supplied; the start-up volume guard requires one of them |

To keep the administrator password itself out of Railway, set `AMCP_ADMIN_PASSWORD_HASH` instead of `AMCP_ADMIN_PASSWORD`: run `npm run build && npm run admin -- password-hash` locally, type the password, press Enter and then Ctrl-D, and paste the printed `scrypt-v3$…` value. Hashes made before 2026-09-28 (`scrypt$…`) still work, and start-up prints a warning until they are replaced. Changing the administrator password or its hash signs out every administrator session and ends the MCP access approved from them when the new deployment starts; a server still running the old password stops accepting it at that moment. `AMCP_TEST_PASSWORD` and `AMCP_TEST_PASSWORD_HASH` work the same way for reviewer sessions.

Generate the encryption key locally using `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Put it directly in Railway variables and a password manager. Do not commit it. Preserve this key across deployments: changing it makes existing credentials unreadable. Do not copy your local test database or previously shared provider tokens into this deployment.

The app uses Railway's `PORT`. Networking → Generate Domain supplies the initial HTTPS URL. If you omit `AMCP_PUBLIC_ORIGIN`, AMCP can use Railway's `RAILWAY_PUBLIC_DOMAIN` when supplied; set an explicit origin before registering provider callbacks. Redeploy after changing variables. `/healthz` checks that the database answers and commits one small write, that its volume has room and is persistent, that media expiry is current, and that the offline help completes through a real MCP client and server in memory. It answers `status: up` (200), `degraded` (200: write contention, low or ephemeral storage, stale media expiry, or unknown storage in production) or `unavailable` (503: a failed read or write, full storage, or MCP), naming only each check's state; a result lasts ten seconds. Railway uses it only at deploy time, so point an external uptime monitor at it every minute (see [health and diagnostics](OPERATIONS.md#health-and-diagnostics)). Every refused or failed `/mcp` request writes one JSON log line (`mcp_refused` or `mcp_failed`, with status, code and origin, never the token). Inspect write readiness through the authenticated workspace health operation. Sign in and check Settings. An unconfigured provider displays “Setup needed.”

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
key during capacity repairs. See the [sign-in incident](review/INCIDENT-2026-10-06-SIGNIN-DATABASE.md).

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

All use `AMCP_<PROVIDER>_CLIENT_ID` and `AMCP_<PROVIDER>_CLIENT_SECRET`, with uppercase provider names. X uses its consumer/API key and secret in these variables. Google Ads API access belongs to the Google Cloud project containing that OAuth client after the September 9, 2026 migration. `AMCP_GOOGLE_DEVELOPER_TOKEN` is optional legacy configuration; it cannot grant access to a different Cloud project. Check **Google Cloud → Google Ads API → Overview** for Explorer or higher access to production accounts. An optional manager context uses `AMCP_GOOGLE_LOGIN_CUSTOMER_ID`; synced accounts retain their verified login manager. Meta Login for Business can use `AMCP_META_CONFIG_ID`. TikTok's developer portal may provide `redirect_uri` or `redirect_url`; match it using `AMCP_TIKTOK_REDIRECT_PARAMETER`. LinkedIn API version defaults to `202609` and is configurable with `AMCP_LINKEDIN_API_VERSION`.

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
| `AMCP_MCP_ALLOWED_ORIGINS` | Empty, unless an MCP client that sends a browser `Origin` header must connect | `/mcp` refuses every browser origin except AMCP's own, with a JSON-RPC error that names the origin. List exact origins (for example `https://claude.ai`) only for clients you use; this loosens the origin check for them, so it is the owner's decision. Recommended (2026-09-29): leave it empty and add an origin only when the refusal log shows that client's requests refused (one JSON line per refused `/mcp` request names the origin); a client that runs on a server sends no `Origin` and is unaffected. |
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

## Compare public website bytes before accepting a deployment

Run the explicit bounded public comparison from the qualified checkout:

```sh
npm run check:public-website -- --origin https://amcp.shop
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
See [comparison evidence and scope](review/DELIVERY-2026-10-05-CORE-CONTRACT-DIAGNOSTICS.md).

### Interpret a received HTML byte mismatch

The public comparison checks received bytes, including any response insertion or transformation.
On October 5 at 12:14 UTC the About response had one additional 367-byte fragment containing a
Cloudflare beacon script; removing that fragment left the local page byte-for-byte. The tool
correctly reports the raw difference. That alone does not mean a changed About source, failed
Docker build or different backend image. Inspect the actual difference and authenticated service
history. The separately observed Arabic asset still matches an older known locale file. Never
normalize away an unknown insertion or turn liveness/static observations into backend acceptance.
See [bounded public evidence](review/DELIVERY-2026-10-05-BROWSER-SEMANTICS.md).

## Public packaged release identity — batch 174

GET /versionz adds an independent application-artifact observation beside the original /healthz.
npm run build writes a bounded atomic public build record after compilation. The build-stage
ARG RAILWAY_GIT_COMMIT_SHA allows Railway's exact triggering commit claim to be retained;
absent/invalid values are null. No deployment/source/CI-gating setting is changed here.
After deployment, compare the reported source claim with the expected Work-here tip and compare
its measured digest/component counts with a separately qualified packaged build. Matching
selected bytes return 200; mismatch/unavailable returns 503 with bounded public metadata.
The scan-start observation is cached for ten seconds, and hashing runs in a coalesced, bounded,
credential-free worker. This covers the fixed application artifact scope, excluding private
state, dependencies, entrypoint/OS binaries and image/provenance. It is unsigned, and a matching
response does not certify source authenticity, atomic snapshot consistency or provider execution.
Keep Railway healthcheckPath at /healthz. See [scope, checks and remaining evidence](review/DELIVERY-2026-10-05-RELEASE-IDENTITY.md).
Railway project/service/branch, exact deployed backend/image and the earlier Arabic gap remain
unverified; a missing route or record alone does not explain a deployment failure.

## Wrapper Arabic source and public observation — batch 175

The current Arabic catalog has 8,056 entries, 1,253,212 UTF-8 bytes. The source locale gate,
browser catalog transport and explicit public Arabic comparison share a 2,097,152-byte ceiling.
The public command still reads only /healthz, /about and /assets/locales/ar.json and does not
identify deployed backend/image from static bytes. On 5 October at 16:47:09.206Z, one bounded
credential-free normal-TLS GET /versionz returned 404; its body was not read. This establishes
only route unavailability at that observation, not a deployment cause or Git/image identity.
The Railway project/service/environment and recent deployment evidence remain unavailable
through the current tools. Hosted Actions remain owner-waived; local release gates remain
mandatory. See [local ownership/loading qualification](review/DELIVERY-2026-10-05-BACKEND-WRAPPER-LOCALIZATION.md).

## Interpreting public liveness

The optional three-resource public comparison accepts HTTP 200 plus the application's
up/degraded state. It records only reported_liveness, not returned version/check/body fields.
Missing, malformed or other states refuse with PUBLIC_LIVENESS_STATE_INVALID. Degraded is
liveness, not complete readiness. The original health route/HTTP behavior, fixed GET routes,
credential omission, redirect refusal and raw About/Arabic comparisons remain unchanged.
See [local state regressions](review/DELIVERY-2026-10-05-LIVENESS-PLANNING-PREREQUISITES.md).
A successful bounded public comparison does not establish deployed Git/image or native
provider/program acceptance. The owner waived hosted Actions; fresh complete local
build/report/freshness/default-full/required-FFmpeg and clean-source checks continue.

## Batch 178 — local selected accessibility guard

The selected browser accessibility engine is an optional hash-pinned local test asset. It adds
no application dependency or Railway download. The original Docker/health configuration stays
exact. Fresh sanitized build/report/freshness, complete default required-FFmpeg suites and
exact clean-source parity remain the push gate; owner-waived Actions are not started or polled.
The browser run with the optional engine qualifies only its owned local Chromium views.
Deployed source/image, Railway branch/settings and live acceptance remain separate.
Working-source full/report and focused changed-state checks pass; exact clean committed full/browser checks remain the sole push gate.

## Batch 179 — original campaign/hour/day evidence

The separate Google hourly preset preserves original hour 0–23/date/account timezone and full
campaign resources, with explicit zero, complete-count/page/source checks and no inferred
missing-hour activity or UTC/DST conversion. Retained search preserves full totals and every-row
EN/AR Excel delivery. The hourly grain cannot qualify schedule, bid, budget or exclusion changes.
The current-parent prototype passes 82 focused tests and 24 actual served EN/AR capture/current-
error/stale-response journeys; all 576 original workbook rows and preceding 8,057 Arabic values
remain. Nine new messages are authored. The maintained runner retains all 408 old cases and adds
24 hourly cases, totaling 432 with 864 initial/final semantic and optional selected-rule snapshots.
Fresh sanitized full/report and exact clean-head/browser gates still qualify the integrated
source before its sole push; prototype passes cannot stand in for those checks. B18/B27/B15/
B16/B24 remain partial, the matrix remains 13/14/1, and hosted Actions stays unused. See
[scope, primary research and checks](review/DELIVERY-2026-10-06-GOOGLE-HOUR-EVIDENCE.md).

## Batch 180 — other listed X products with explicit retention

An opt-in read-only inspection extends the existing complete bounded X catalog comparison,
retaining exact native IDs, supported price strings, original group evidence and source lineage.
Two full scans must agree on every displayed supported observation; malformed policy, unsupported
destination and other workspace actions refuse before reads/artifacts. The local searchable
fifty-row-page EN/AR view keeps other listed products retained and outside drafts/removals.
Full-store absence, complete variants and point-in-time reconciliation remain unverified.
The isolated formatted-source prototype passes 75 focused checks and 24 served browser cases
with 400 synthetic GETs, 2,904 original other-product observations, zero mutations/egress,
48 semantic/pinned selected-rule snapshots and all manual evidence retained. All 8,066 earlier
Arabic values remain; 25 are added. Fresh integrated full/report/source/browser gates follow.
B21/B15/B16/B24 remain partial, B25 open; the matrix remains 13/14/1 and Actions remains unused.
See [contract, workflow and qualification](review/DELIVERY-2026-10-06-X-CATALOG-SELECTION-INVENTORY.md).

## Batches 182/183 — inventory and bounded worker observations

The new published WooCommerce inventory mode makes fixed authenticated reads only and retains
absent products. Owner health/support return bounded, sanitized shared process observations;
Settings explain those limits separately from queue and provider delivery. Neither feature changes
Docker configuration, account grants, worker concurrency or provider mutation authority.
Fresh sanitized build/report/freshness, default full required-FFmpeg checks and exact clean-source
verification precede the sole Work-here push. Hosted Actions remain owner-waived. The expanded
maintained browser runner contains 488 cases, retaining all previous journeys and adding eight
worker-health cases. Earlier prototype/working-source passes do not establish this final run,
deployed source/image or live store/client eligibility.
[Inventory qualification](review/DELIVERY-2026-10-06-WOOCOMMERCE-INVENTORY.md),
[worker health and concurrent client qualification](review/DELIVERY-2026-10-06-WORKER-HEALTH.md).

## Batch 184 — administrator commerce connections and final browser gates

WooCommerce source setup requires configured encryption before any credential-bearing request.
Only current workspace administrators can submit it; the source grants read access and generic
write controls refuse it. Local removal performs no provider request. Hosted Actions stay waived.
The maintained browser now has 512 cases. Previous 487/488 browser and 4,849/4,851 main-suite
results are retained failures; corrected current-source full checks, report freshness and exact
source verification must pass before publication. The Windows Railway configuration check does
not establish a Linux image build or the currently deployed revision.
[Workflow, corrections and acceptance boundaries](review/DELIVERY-2026-10-06-WOOCOMMERCE-CONNECTIONS.md).

## Batch 185 — public payload and intermediary diagnosis

The public version endpoint can distinguish the build's Git claim from its independently measured
packaged runtime digest. The October 6 pre-push observation identifies f14305d, with matching
build/runtime payloads. Raw About bytes can differ solely because Cloudflare injects its analytics
script. The maintained checker explains a strict known insertion while preserving the failed raw
byte result and every original hash. This does not establish dashboard settings or change CSP.
No Docker/Podman/Linux runtime or functioning browser-control session is available on this host.
Fresh final-source checks and a post-push public revision/payload read remain required; hosted
Actions stay unused. [Actual observations and limits](review/DELIVERY-2026-10-06-RELEASE-ACCEPTANCE.md).
