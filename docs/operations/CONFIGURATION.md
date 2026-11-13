---
status: reference
tier: operator
---

# Configuration

The environment AMCP reads and the switches that change what it does: credentials and provider grants, credential health and disconnect, media leases, measurement and Business Profile onboarding, the production start-up checks, reviewed-write switches and the MCP surface flags. A section of the [operations runbook](../OPERATIONS.md), moved here with its text unchanged on 2026-10-24 (DOC-03).

Use environment injection from a secret manager. `.env.example` documents names; the program does not automatically load `.env` files. Set `MIRROR_MASTER_KEY` to a base64 encoding of 32 random bytes. `MIRROR_DB` defaults to `.runtime/mirror.sqlite`. Set a tenant ID for stdio or create tenant-bound API keys for HTTP. A credential connection has explicit account bindings; broad vendor token permissions never replace those bindings.

Connection credentials: Meta/TikTok/Snapchat/LinkedIn use access tokens; Google Ads access belongs to the OAuth client's Cloud project and may need loginCustomerId (developer tokens were sunset on 2026-09-09: AMCP never sends one and warns at startup and in owner health while `AMCP_GOOGLE_DEVELOPER_TOKEN` is set). X requires consumerKey, consumerSecret, accessToken and tokenSecret for OAuth 1.0a. Refresh-capable connections also need their own clientId/clientSecret/refreshToken/expiresAt. Reddit uses a bearer access token, a connection userAgent, and Basic client authentication when refreshing. Tokens are refreshed shortly before expiry for supported providers; unsupported refresh modes return a reauthorization error. App registration, granted scopes and vendor approval are prerequisites and are not performed by this CLI.

Requests are bound to the connection's login revision, not to its token bytes. The store bumps the revision when a new authorization, reauthorization, re-provisioning or direct credential replacement writes different credentials; AMCP's own token refresh keeps it. A refresh by any worker therefore never interrupts a read, discovery, review or export, while a replaced login still stops in-flight work with `CONNECTION_AUTHORITY_CHANGED` (restart with the current login; do not reconnect). Scope loss still returns `INSUFFICIENT_SCOPE`, and `REAUTHORIZATION_REQUIRED` remains for credentials that no longer work. TikTok report tasks keep their exact-token binding (`TIKTOK_REPORT_TOKEN_CHANGED`). `AMCP_AUTHORITY_FENCE=fingerprint` temporarily restores the previous byte comparison as a rollback; it will be removed one release after acceptance. The revision covers credentials only: narrowing a connection's scopes or its selected accounts does not bump it, and those changes are caught by the separate scope (ScopeGuard) and account-selection checks that every authority decision repeats.

Provider OAuth grants live in one registry, `src/provider-grants.ts` (CON-03), which lists each provider adapter's `grant` (`src/provider-adapters.ts`, ARC-01 phase B): per gateway, the scopes AMCP requests (read, plus write scopes only when reviewed writes are allowed; Reddit `adsedit` is now requested only then), the scopes read and reviewed-write enforcement require, where the granted permissions are learned and whether readiness has an exact account read. The OAuth configuration, measurement, Google Ads, Snapchat, Microsoft and Reddit write checks, readiness and capability eligibility all read it; existing logins keep the scopes they were granted. Scopes echoed by a token response are recorded exactly (TikTok's returned list verbatim). Meta's exchanges return none, so every Meta connect, ad-account sync and reauthorization reads `/me/permissions` once (after the ad-account listing succeeds) and records granted, declined and expired permissions with `checked_at` in `website_connection.grants`; the recorded scopes become the granted list, which also covers Facebook Login for Business configurations (`AMCP_META_CONFIG_ID`) that grant permissions such as `catalog_management`. A failed or unreadable permissions read never blocks connecting: it records `known:false`, and readiness reports the permission as unknown, never granted. X records only the access type AMCP requested. Recorded scopes remain a local prerequisite; the provider's own check at execution is the authority. `AMCP_CAPABILITY_GRAPH_VERSION=2` restores the version 2 capability graph placeholders as a rollback.

Credential health is a `connection_health` document per connection, bound to its login revision and removed on disconnect. Token refresh records success (access and, for LinkedIn, login expiry), a documented grant rejection (`invalid_grant`, `invalid_token`: `reauthorization_required`, after which refresh fails fast with `REAUTHORIZATION_REQUIRED` and no token request until the login is reauthorized or an administrator chooses Retry renewal), or another failure (`refresh_failed`, bounded back-off from 30 seconds to 15 minutes). A dead login therefore costs one token-endpoint call and one `token_refresh_failed` audit row. MCP `connection_ops status` and the `amcp_workspace dashboard` `connections` section return the stored record with zero network requests. Operations lists a login whose current record is `reauthorization_required` or `refresh_failed` (or one that cannot renew itself and has ended), and a turned-off connection as deferred, to workspace administrators only as `kind:connection` (OPS-06). Every browser-OAuth platform can reauthorize in place from Connections; set `AMCP_REAUTHORIZATION_DISABLED=meta,linkedin` (or `all`) to return a platform to "Connect another" only. Credentials are replaced only after verification, so the flag is always safe to set.

Disconnect is local by default: AMCP deletes its copy of a login, and the provider grant stays until it is removed in the provider's settings. `AMCP_PROVIDER_REVOCATION=on` (owner decision D19 (4), CON-05; any other value or unset is off) adds an unchecked **Also revoke AMCP's access at Google** to the disconnect dialog of a Google login. Checked, AMCP audits `provider_revocation_requested` (with the login revision), sends the login's token once in the form body to `https://oauth2.googleapis.com/revoke`, audits `provider_revocation_result`, and disconnects only after a 200 or `invalid_token`; any other answer or a lost response keeps the login (`PROVIDER_REVOCATION_FAILED`), and so does a reauthorization that lands meanwhile (`CONNECTION_CHANGED`). A session or CSRF check that fails after Google answered (say the sign-in must be confirmed again) also keeps the login, and its error carries `details.provider_revocation` with Google’s answer; after a revocation, the retry once signed in again finds the token already invalid and disconnects. Other providers have no revocation wired, test accounts (the shared reviewer password and invited test accounts) are never offered it, and MCP disconnects stay local. Google revokes the grant of one OAuth client for a Google account as a whole, and every Google surface uses the `AMCP_GOOGLE_CLIENT_ID` client unless it names its own, so the owner answers **Q25** before turning it on:

1. With a disposable Google account, connect two Google surfaces that share the client (for example Google Ads and Sheets) in one workspace and one of them in a second workspace.
2. On a deployment with `AMCP_PROVIDER_REVOCATION=on`, disconnect one login with the revocation checked; the message says its access was revoked at Google (audit outcome `revoked`).
3. Sync each other login right away and again after an hour (an access token AMCP already holds is used until it nears its expiry, at most an hour, and Google says revocation can take time). A sync that Google refuses, or a login that then shows **Reauthorization required**, means the grant is shared as the dialog warns; record the result with Q25 and keep the flag on only if that effect is acceptable.

Media execution locks and shared byte reservations use 45-second leases renewed
every 15 seconds and at transfer boundaries. After a worker crash, wait for lease
expiry and inspect `amcp_media recovery` for the original review. Do not delete
locks or create replacement uploads. Explicit resume is available only within the
transfer window set at the claim (`AMCP_MEDIA_TRANSFER_WINDOW_MINUTES`, default 60,
never past a website upload's thirty-minute deadline; reviews claimed before this
keep their original review expiry): Google video uses its authoritative offset; LinkedIn video uses
versioned encrypted confirmed-part receipts and current `WAITING_UPLOAD` status.
Unknown PUT outcomes and attempted finalization cannot resume. Old LinkedIn
receipts without an intent marker remain unqualified. See
[media recovery evidence](../implementation/LINKEDIN-MEDIA-RECOVERY-2026-09-25.md).

Media admission reserves for each file's size, with a per-workspace share of the
operation slots, and queued uploads refused for contention before any claim are
retried by the worker until their review expires; see
[media capacity](../MEDIA-UPLOADS.md#media-capacity) for the settings and defaults.
The owner's health view lists the workspace's media refusals
(`memory_busy_refusals`, `staging_full_refusals`, `deadline_too_close_refusals`),
released unfinished uploads and measured transfers (`transfers_completed`,
`transfer_ms_total`, `transfer_bytes_total`) since the process started; the
unauthenticated `/healthz` shows none of them. Lower the reservation factor or floor
only after measuring peak Node and FFmpeg memory on the production image.

GA4, GTM and Search Console have website OAuth onboarding and explicit property/account/site selection. Google Business Profile does too (CON-06): Connections lists it on the shared Google client (or `AMCP_GBP_CLIENT_ID`/`AMCP_GBP_CLIENT_SECRET`) with `business.manage`, PKCE and offline access, but only once the owner declares that Google approved the Cloud project for the Business Profile APIs (`AMCP_GBP_API_APPROVED=true`) or sets the dedicated pair; until then the card reads setup required. A new login is saved disabled, its sync lists business accounts and their locations with the collector `sync_assets` uses (100 accounts, 500 locations each), and the owner selects `locations/<id>` (and business accounts for account-level changes). Readiness reads the exact selected location (`readMask=name,title,storeCode`) or business account. A project Google has not approved answers with a quota of 0 requests per minute (or `SERVICE_DISABLED`): AMCP refuses with `BUSINESS_PROFILE_API_NOT_APPROVED`, an owner action and no retry. Renewal uses the shared Reauthorize. Amazon Ads is not offered (owner decision, CON-06 option b): it has no website login, profile discovery or implementation modules, so `amazon_native_action` is not listed in `tools/list`, the Capability Center contract reference or the Overview's provider evidence, and a call (or `amcp_tool_help`, `amcp_write` or `amcp_workspace contracts` naming it) is refused with `GATEWAY_NOT_OFFERED` before anything is read; `AMCP_PROVIDERS=amazon` offers it again for an operator-provisioned connection. Apple Ads uses client-credentials authentication with optional automatic ES256 signing; see [measurement and Apple setup](../MEASUREMENT-AND-APPLE.md). Meta initial user tokens are exchanged for long-lived tokens. TikTok's current advertiser tokens are long-term and require reauthorization if revoked; its separate short-term user-token refresh API is not used for advertiser credentials.

Globally addressed Meta/Snapchat objects need recent ownership evidence from an account-scoped collection. Otherwise provision explicit resourceBindings with an accountId, exact pathPrefix and any required query invariants. These are administrator grants, not arbitrary caller input. GA4 connections bind property IDs; GTM binds account IDs; Search Console binds exact property URLs or sc-domain properties. Business Profile locations can be explicitly bound as `locations/<id>`.

Every entry point (HTTP, worker, stdio) reads the environment once through `server/config.ts`, which derives the public origin the same way everywhere and checks the production preconditions before the database opens: the HTTP server needs `MIRROR_MASTER_KEY` and an administrator password, and the standalone worker needs `MIRROR_MASTER_KEY`. In production the database must also lie inside a declared persistent mount (`RAILWAY_VOLUME_MOUNT_PATH` or `AMCP_DATA_MOUNT`) on a different device from the root file system; otherwise start-up logs `storage_not_persistent` and exits non-zero. `AMCP_ALLOW_EPHEMERAL_DB=true` overrides this for local and development use, and health then reports `storage: not_persistent`. A verified start logs `storage_verified` and checks the volume marker (`.amcp-volume-id` beside the database, matched by a database row): a mismatch after a restore or a volume move logs `storage_volume_changed` and shows in owner health until `npm run admin -- restamp-volume` re-stamps it deliberately. In production, admin commands that open `MIRROR_DB` are refused as root (run them as `gosu node npm run admin -- …`) unless `--allow-root` is given; see [Railway deployment](../DEPLOY-RAILWAY.md).

Set `MIRROR_ALLOW_WRITES=true` to enable `amcp_write` prepare and execute (a read-only deployment lists it with `inspect` only), grant specific accounts, and issue operator access. The review service reads provider state, freezes requests for five minutes, verifies state again before submission, and persists idempotency across restarts. Lost or partial responses are retained and must be reconciled before new submissions. There is no automatic rollback. See [write operations](../WRITE-OPERATIONS.md).

Reviewed-write execution switches, each optional and read at call time (`.env.example` lists them with their defaults): `AMCP_WRITE_NOT_SENT_RELEASE=false` records a refusal raised before the request was sent as uncertain again instead of releasing the claim; `AMCP_WRITE_REJECTED_OUTCOME=false` records a provider refusal proven non-applied (CMP-04) as uncertain again instead of rejected; `AMCP_WRITE_TARGET_LOCK=false` stops serializing executes of one target and `AMCP_WRITE_TARGET_WAIT_MS` (default 10000, at most 60000) bounds how long a second execute waits before `STATE_BUSY`; `AMCP_WRITE_GROUP_PART_SECONDS` (0-120) fixes the time each group part is given; `AMCP_PLAN_SUMMARY_HASH=false` accepts a plan approval by `plan_hash` alone; `AMCP_PROVIDER_VALIDATION` (true or false only) lets a read-only deployment run provider validation; `AMCP_PROVIDER_JOBS` (true or false only) makes provider report and export jobs their own effect, allowed in a read-only deployment and for readers on accounts granted report jobs, with `AMCP_PROVIDER_JOB_HOURLY_LIMIT` (default 1000) bounding jobs per provider account and hour (see [provider jobs](../WRITE-OPERATIONS.md#provider-report-and-export-jobs)); `AMCP_WIRE_CONTRACTS` (`shadow` by default, `enforce` or `off`; anything else stops startup) decides what a request body that differs from its pinned vendor contract does, with violations counted per gateway in owner health as `wire_contract_violations` (writes, the enforcement gate), `wire_contract_read_violations` (reads, never enforced) and `wire_contract_check_failures` (the validator itself failed; the request still went out unless it was an enforced write). See [write operations](../WRITE-OPERATIONS.md) and its [pinned vendor contracts](../WRITE-OPERATIONS.md#pinned-vendor-contracts).

`MIRROR_FLAGS` takes a JSON object of opt-in enhancements. `{"compactSchemas":true}` lists each action once in the
tool schemas: the DV360 tool otherwise lists all 173 actions twice, with and without the `DV360_` prefix, and the
flag removes about 7 KB from every `tools/list`. The unprefixed legacy names stay accepted. Without the flag the
schemas match the captured gateway schemas exactly. The owner should enable it in production (MCP-01); whether it is
on there is a dashboard setting this repository cannot observe.

Each action of the AMCP tools reads only the arguments its contract row lists (`src/first-party-contracts.ts`, MCP-07).
In this release an argument of another action is reported under `meta.argument_warnings` and the call runs as before;
`{"actionArguments":"enforce"}` refuses it with `INVALID_ARGUMENT` naming the field. Turn it on after one release of
report-only warnings; remove it to roll back.

The MCP surface is sized for an AI client's 10,000-token output warning (owner decision D14). `tools/list` carries
routing summaries of at most 2,000 characters; `amcp_tool_help {gateway}` returns each tool's whole description and
`amcp_tool_help {gateway, operation}` the part about one action. `{"compactDescriptions":false}` lists the whole
descriptions again (rollback only). `amcp_workspace capabilities` returns a paged summary by default and the dashboard
returns counts; `{"capabilitiesGraphDefault":true}` makes the whole capability graph the default again (rollback
only). `node tools/measure-tool-list.mjs` (after `npm run build`) prints the sizes, and `tests/response-budget.test.mjs`
fails when a default view, description, help call or the campaign prompt grows past its budget.

Gateway descriptions say what AMCP runs (MCP-10). Where the captured text named a tool, provider, version or behaviour
AMCP does not have (Meta, TikTok and Snapchat "named tools", DV360 reporting, Amazon, Apple v5, commerce, the
connection operations), AMCP's own text replaces it; `amcp_tool_help {gateway}` keeps the captured text under
`captured_catalog`, and the listed schemas stay byte-identical (owner decision D17). Captured operations AMCP cannot
run stay listed but annotated (`src/unavailable-operations.ts`, held equal to the contracts ledger's `unmapped` rows by
`tests/truthful-surface.test.mjs`): the nine `amcp_native_action` ones such as `generate_ad_content` answer
`WORKFLOW_UNSUPPORTED`, the four unimplemented Adjust operations, `woocommerce_store_ops` and the OAuth steps of the
GA4, Search Console and Business Profile connection operations answer `CAPABILITY_UNAVAILABLE`, before their arguments
are checked and with `details {operation, status:"unmapped", alternatives}`. Operation help and `DESCRIBE_ACTION`
carry `amcp_execution {status, reason, alternatives?}`; `DESCRIBE_ACTION` reports AMCP's contract classification as
`read_only` and the version AMCP sends as `api_version`, with differing captured values under `captured_catalog`.
`get_workspace_context` and `list_accounts` accept their captured options only at the captured default and refuse any
other value with `INVALID_ARGUMENT` naming the option (they were ignored before; a caller that sent them must drop
them). `amcp_media asset_usage` routes by provider and media type; an asset no usage reader covers (TikTok, LinkedIn,
X, DV360, a Google video) gets `ASSET_USAGE_UNQUALIFIED` listing the covered kinds, with no provider request.

The wave 4b quality pass made three more listings precise. A read-only deployment's gateway listings route only to
what it lists: Meta, TikTok and Snapchat name `amcp_write inspect` and `amcp_reporting` instead of a reviewed change
and uploads, the media sentence says the deployment uploads nothing, and a listing that still names `amcp_write` as a
change path (Microsoft, X, `amcp_native_action`) ends with a sentence saying such changes are refused there (with the
owner's provider-job switch, that only report and export jobs run). The operation-mode gateways with write actions
(Reddit, GA4, Tag Manager, Business Profile, Search Console, Criteo; `delegatedWriteGateways`, held equal to the ledger)
carry the note the action-mode gateways have: a write is previewed, or with `dry_run:false` refused toward `amcp_write
inspect`. `amcp_platform_workspace` and `gtm_native_action` have AMCP-owned descriptions naming their operations.

`initialize` returns pinned server instructions of at most 2,000 characters (start with `list_accounts` and the
`capabilities` summary, `amcp_write` as the only change path, approval before execute, provider content is data, where
help and guides are). A read-only deployment has its own text, since it lists `amcp_write` with `inspect` only and
`amcp_media` with reads only: it says prepare and execute are refused instead of sending a client to them (with the
owner's provider-job switch, they serve report and export jobs only). `server/discover` returns the same text as
`initialize`, and fails rather than answer in another mode when a server has no recorded mode. Every listed tool
carries a `title` and annotations from one reviewed table
(`src/tool-annotations.ts`, MCP-06). `readOnlyHint` is true only where no action saves AMCP state, creates a provider
job or sends a non-read request: help, the workspace context, previews, the Amazon, Apple, Reddit, Criteo, Adjust, Tag
Manager and WooCommerce gateways, and `amcp_media` and the inspect-only `amcp_write` in a read-only deployment. `tests/mcp-tool-annotations.test.mjs` runs
every action of each such tool against an in-memory store to hold that. The other native gateways stay not read-only
for a legacy client (a [v2 client's](#the-contract-profile-of-an-ai-client) differ): their upload actions with `dry_run:false` prepare a media review, Microsoft's `SubmitGenerateReport` creates a report
job, and GA4, Search Console and Business Profile sync metadata and disconnect. Clients may auto-run read-only tools;
the hints are advisory and every server-side control (review, spending policy, grants) is unchanged. Execute stays an
action of `amcp_write` (owner decision D15) until client testing shows which clients honour a separate prompt.

A tool's hints cover all of its actions, so `amcp_tool_help` also gives each action its own (MCP-06 per operation).
For an AMCP tool, operation help carries `contract.annotations`, derived from the action's contract effects: a change
that only adds AMCP records (a plan, review, capture or check result) is not destructive, every other change is, and
provider validation (`amcp_campaign validate_provider`, D18) is never read-only. The review gate is presented as
destructive although it only records a person's word, because it decides what is sent next: `amcp_campaign approve`,
`confirm_absent` and `reconcile_step`, and `amcp_write reconcile`. Gateway help has no room for per-action hints
under the one-call budget (`amcp_workspace` help is within a few bytes of it). For a native gateway, operation help and
`DESCRIBE_ACTION` carry `amcp_execution.annotations` from the action's ledger status: reads read; a reviewed write is
previewed or refused there (its change path is `amcp_write`); a media route saves an upload review; Microsoft's
`SubmitGenerateReport` creates a report job; AMCP's own workflow operations take a reviewed entry in
`src/tool-annotations.ts`. An operation whose actions differ shows the most cautious hints and lists its reads in
`read_only_actions`. `tests/mcp-operation-annotations.test.mjs` runs every action presented as read-only (about 3,400)
with read- and write-shaped arguments and fails if one saves AMCP state, sends a non-read request or creates a
provider job, or if one presented as closed-world (`openWorldHint` false) sends any request; it fails too when a
tool's own hints are less cautious than one of its actions'.

Every paged AMCP list carries the same paging fields (MCP-07): `has_more`, and while it is true the `next_cursor`
(cursor lists such as `amcp_campaign list`, `amcp_reporting list`, `amcp_media library`, operations, history and
capabilities) or `next_offset` (offset lists) that continues it, and `total` where it is known. Some lists returned
only one of the two before. The media list pages its recovery reviews apart (`recovery_has_more`,
`recovery_next_offset`); an asset's usage pages keep `usage_has_more` beside `has_more`.
`tests/mcp-pagination-metadata.test.mjs` holds every paged action to this, or names the suite that pages it.
`tests/mcp-output-schema-parity.test.mjs` calls every tool of both modes through a real MCP SDK client, which
validates `structuredContent` against the listed `outputSchema`, and checks that the text block is the same JSON,
that `isError` is set exactly on refusals, and that each refusal names its code, category, remedy, next action and
request ID. Each tool has a call that must succeed and one that must be refused; only `amcp_ad_previews`, whose
every call reads a provider, has no successful call there.

## The contract profile of an AI client

Each AI client of the MCP endpoint is served one contract profile (V2-MCP-06). A changed default is opt-in per client until
the owner confirms that nothing depends on the old behaviour (decision D26 of the wave 5 plan). `legacy` is every client's
profile today and what it keeps until its profile is set; `v2` is the opt-in. The profile is the `contract_profile` field of
the client's registration record (`src/mcp-client-profile.ts`), read at every request, so a change applies at the client's
next request and survives a token refresh. Nothing a request carries chooses it: an argument, a header, a protocol field and
the metadata a client registers with are all ignored. An API key, a connector token, stdio, the website's own calls and the
workers are always `legacy`, and so is a client identified by a metadata document, which has no record to hold a profile.
No website control sets a profile yet; round 3 adds the switch to the AI clients page. `amcp_workspace help` with
`topic:"mcp_profile"` tells a client which profile it is served and lists what `v2` changes. Permissions, reviews, spending
policy and every other safeguard are the same in both, and the `tools/list` of a legacy client is as it was.

What `v2` changes, each tested through the real HTTP stack in both protocol revisions:

- **Annotations and the media hand-off.** Meta, TikTok, Snapchat, DV360, LinkedIn, Google Ads and X Ads list
  `readOnlyHint:true`, because no call through them saves AMCP state any more: a native upload with `dry_run:false` (the
  `payload.url` actions and `amcp_native_action platform_media_upload`) saves no review and fetches no file, and is refused
  with `MEDIA_REVIEW_REQUIRED` and a `next_call` to `amcp_media prepare` for the same file. GA4, Search Console, Business
  Profile, Microsoft Ads and `amcp_native_action` keep their annotations, because one of their actions writes. The v2
  listing is 14 bytes smaller than the legacy one.
- **Response budget.** A read that returns a list is cut at a row boundary to 64 KiB of JSON, and `max_bytes` (4,096 to
  262,144) asks for another budget. A cut answer carries `meta.budget` (`truncated`, the row counts and the `next_call`
  that continues it) and a row is never cut. The continuation belongs to the AI client, the person, the workspace and the
  exact arguments, not to the access token. A call that saves or sends anything is never cut or run twice.
- **Compact lists.** A client's own read of one of the seven gateways above that lists rows leaves out the nulls, empty
  strings and empty objects of the rows; `compact:false` asks for the provider's answer, and `result_fields` and
  `max_items` work on every one of them, Google Ads included.
- **Guides in sections.** `resources/templates/list` (the 2026-07-28 revision) offers `amcp://guides/{guide}/{section}`, and
  the help topics `guides/<guide>/<section>` read the same sections. Each is at most 12,000 bytes; a longer section is
  served in parts that name each other. The whole guides, at their own addresses, are unchanged.

Separately from the profile, the 2026-07-28 revision's `server/discover` offers the deployment's own app icon in its server
information, at its public address; no other answer carries it, and a deployment without a public address offers none.

`node tools/mcp-eval.mjs --check --profile v2` runs the journeys, the tasks and the evaluation set as a `v2` client against
the committed baseline, which is the legacy profile's: see [qualification](QUALIFICATION.md#journey-and-mcp-evaluation-qa-04).
