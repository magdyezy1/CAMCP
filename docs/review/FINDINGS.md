# Findings register

Review of `Codex-branch` from `03ac8d3` (2026-09-28). Areas follow the brief (5.1 architecture … 5.9 developer
experience). Severity: **critical / high / medium / low / info**. Status: **fixed** (with the commit batch in
[PROGRESS.md](PROGRESS.md)), **planned** (on the [roadmap](ROADMAP.md)), **owner** (needs an owner decision),
**accepted** (documented limitation). Evidence cites `path:line` at `03ac8d3`; the code is written in very long
lines, so a line can hold several statements.

"Confirmed" means the scenario was reproduced against the built code (scratch probes or a red test); "traced" means
the code path was read end to end without running it.

## Money and write safety (5.2, 5.7)

| ID | Sev | Finding | Evidence | Failure scenario | Recommendation / fix | Effort | Status |
|---|---|---|---|---|---|---|---|
| F-01 | high | Numeric enum statuses bypass `allow_activation:false` and the spend confirmation | `src/google-contracts.ts:53` accepts ProtoJSON enum numbers; `src/spend-policy.ts:195` and `src/preflight.ts:171` only match strings | Confirmed: `campaigns:mutate` update `{status:2}` (ENABLED) passed shape, needed no `spend_change_confirmed`, and was allowed by a policy that forbids activation | Refuse numeric enums in reviewed Google mutations; numeric statuses need confirmation and count as activation (all gateways) | S | fixed |
| F-02 | high | Reddit `goal_value` (ad group / CBO budget, microcurrency) is not counted by the owner budget policy | `src/spend-policy.ts` `financialPath` only matches `budget|spend_cap`; `src/reddit-writes.ts:34` | Confirmed: a 10¹²-micro ad group budget passed a 200,000,000 cap | `redditPolicyAmounts` counts `goal_value` with the entity's goal type as baseline key | S | fixed |
| F-03 | high | Delivery edits of existing entities need no `spend_change_confirmed` when no field name contains budget/bid/spend | `src/preflight.ts:171` text match | Confirmed for Google tCPA/tROAS/end dates, LinkedIn `unitCost`/`runSchedule`/targeting, Meta targeting/end_time/optimization, TikTok locations/schedule, DV360 pacing | Structural, fail-closed rule for the generic campaign/ad-group-level families (`src/spend-effects.ts`) | M | fixed |
| F-04 | medium | Workspace-default absolute caps are unit-less across gateways | `src/spend-policy.ts:81-100` (`moneyUnits`) | 200,000,000 sized for Google micros ($200) is $2M on Meta (cents) and 200M currency units on TikTok/LinkedIn/Microsoft; 200 blocks Google but allows $150 on TikTok | Express caps per gateway in canonical units and currency; refuse a workspace default for a gateway without a unit mapping | M | owner |
| F-05 | medium | `amcp_campaign prepare_next` pre-filled `confirmed:true, spend_change_confirmed:true` in every `next_call` | `src/campaign-runner.ts:110` | A steered model copies the suggested call; the spend acknowledgement never reaches the user | Never pre-fill the spend flag; return `execute_requirements` and `add_after_user_approval` | S | fixed |
| F-06 | medium | Whether execute needs `spend_change_confirmed` was only known when execute failed | `src/write-review.ts:1200` prepare response | Budget edit: execute → `SPEND_CONFIRMATION_REQUIRED` → execute again (measured: 6 calls for a 10 % raise) | `execute_requirements` at prepare, from the same rules | S | fixed |
| F-07 | medium | Enhanced mode: `native_request` lets a caller pick `action` and `path` independently; families that classify by action accept any path under the account | `src/compiler.ts:149-156`, `src/reviewed-routes.ts:251` | Traced: `meta_campaign_id_update` + `POST /v25.0/act_X/assigned_users` classified as `meta_entities` (non-default mode only) | `amcp_write` refuses `native_request` | S | fixed |
| F-23 | info | `ExecutionPolicy.maxBudgetChange` is never enforced | `src/preflight.ts:110` | Looks like a control, is not | Remove or implement | S | planned |
| F-24 | info | `MIRROR_ALLOW_WRITES` is read once at start-up; no runtime pause | `server/runtime.ts:7` | Stopping writes needs a redeploy | Owner-controlled "pause all writes" document checked in `access()` | S | fixed (batch 4: owner `pause_writes` / `resume_writes`, checked at every execute and media upload, shown on the owner page) |
| F-55 | low | Snapchat `lifetime_budget_micro` is missing from the policy amount fields, so creates with it are refused under numeric limits | `src/spend-policy.ts` `nativeAmountField` | Fail-closed friction, not a bypass | Add the unit mapping (Snapchat micros) with tests | S | accepted (no pinned vendor evidence for the field; refusal is fail-closed) |
| F-57 | info | Bids are never limited by amount on any platform; only confirmation/activation rules apply | `src/spend-policy.ts` | An operator can raise a bid without a numeric ceiling | Optional per-account `max_bid_native` | M | owner |
| F-67 | low | Generic outcome check treats any non-empty `error`/`fail` key as failure | `src/write-review.ts` `writeOutcome` | Safe (false failures only), undocumented per provider | Document per provider; keep fail-safe | S | accepted |

## Authentication, sessions, OAuth (5.2)

| ID | Sev | Finding | Evidence | Failure scenario | Recommendation / fix | Effort | Status |
|---|---|---|---|---|---|---|---|
| F-08 | high | Every sign-in/OAuth limit shares one bucket behind the proxy; SDK limiters keyed on `req.ip` regardless of `AMCP_TRUSTED_PROXY_CIDRS` | `server/web-store.ts:30`, `server/website.ts:85`, `server/user-accounts.ts:39-40`, `docs/DEPLOY-RAILWAY.md:121` | ~10 junk logins per 15 min lock everyone out; ~50 junk `/token` calls break every connector | SDK limiters keyed on the resolved address; IPv6 per /64; successes clear the person's own counter; document CIDRs as the production setting | S | fixed (config part: owner) |
| F-09 | medium | Two-step codes limited per address only | `server/account-security.ts:73` | Password holder guesses across many addresses/IPv6 | Per-person limit (5/15 min) | S | fixed |
| F-10 | medium | Workspace switch reset `signedInAt`, bypassing the 15-minute recent sign-in check | `server/account-security.ts:76`, `server/web-store.ts:103` | Stolen session → switch → change e-mail/enrol TOTP | Keep the original sign-in time | S | fixed |
| F-11 | medium | Dynamic client registration capped at 1,000 with no pruning | `server/mcp-oauth.ts:31` | ~50 h of anonymous registrations block new connectors permanently | Release grant-less clients after 24 h | S | fixed |
| F-12 | low | Global 10,000 account-challenge cap fillable anonymously (social start) | `server/user-accounts.ts:87`, `server/social-signin.ts:28` | Resets, invites, MFA tickets fail for everyone | Per-kind caps or cookie-held social state | S | fixed (batch 6: one cap per challenge kind) |
| F-13 | low | E-mail existence visible through response timing | `server/user-accounts.ts:143,149` | Account enumeration | Queue without awaiting delivery | S | fixed (batch 6: delivery starts without the response waiting for it) |
| F-14 | low | Reviewer sessions share `userId:'workspace-test'` and can sign each other out | `server/web-store.ts:113`, `server/account-routes.ts:40` | One evaluator ends others' sessions | Per-session subject or current-session-only delete | S | fixed (batch 6: a reviewer sees and ends only their own session) |
| F-15 | low | Invitations create approved accounts regardless of `AMCP_ALLOW_SIGNUP` | `server/account-security.ts:78-80` | Approval becomes transitive | Pending unless invited by the instance owner | S | owner |
| F-16 | low | Legacy admin/reviewer password: scrypt defaults (N=2¹⁴), synchronous, no MFA; env change keeps sessions | `server/web-store.ts:38,41,145` | Weaker brute-force resistance | v3 parameters, async; push owner migration | S | planned |
| F-17 | low | No HSTS/COOP/CORP; headers only on website routes | `server/http-app.ts:25`, `server/website.ts:29` | Downgrade, cross-origin leaks | Global headers (HSTS only with an HTTPS origin, no `includeSubDomains`) | S | fixed |
| F-25 | low | 8 h absolute sessions without idle timeout; no change alerts; code replay does not revoke issued tokens; grant tables unbounded | `server/web-store.ts:100`, `server/mcp-oauth.ts:58,97` | Longer exposure of a stolen session | Idle timeout, alerts, prune grants | M | partly fixed (batch 6: a replayed code revokes its tokens; expired grants are pruned. Idle timeout and change alerts remain) |

## Egress, data and secrets (5.2)

| ID | Sev | Finding | Evidence | Failure scenario | Recommendation / fix | Effort | Status |
|---|---|---|---|---|---|---|---|
| F-18 | medium | Audit rows keep full provider read responses in plaintext forever; disconnect keeps them; `admin backup` is unencrypted | `src/service.ts:171`, `src/store.ts:244-246`, `tools/admin.ts:41` | DB or backup copy exposes report rows and possibly lead PII | Store hash/row count/fields for reads; retention with tombstones; purge on disconnect; encrypted backup only | M | planned |
| F-19 | low | GCM tag length not checked | `src/security.ts:31-34` | Truncated-tag forgery (needs DB write) | `authTagLength:16`, require 16-byte tags; key id prefix for rotation | S | fixed (batch 2; key ids planned) |
| F-20 | low | `buildUrl` lets `new URL` normalise dot-segments; scope checks see the raw path | `src/transport.ts:17,30` | Defence in depth (compiler already rejects `..`/`%2e`) | Reject dot segments and require `pathname===path` | S | fixed (batch 2) |
| F-21 | low | `inspect_google_drive_media` buffers up to 128 MiB with no concurrency limit, for readers too | `src/service.ts:227` | Memory exhaustion | Semaphore + streaming hash | S | fixed (batch 4: digest while streaming, 64 bytes kept; one inspection per workspace, four per process) |
| F-22 | low | Untrusted-content label is response-wide; provider error details and `changed_fields` are unlabelled | `src/errors.ts:47`, `src/provider-validation.ts:19` | Model cannot tell server guidance from provider text | `meta.untrusted_paths`; label all provider-derived details | S | planned |

## MCP workflow (5.4)

| ID | Sev | Finding | Evidence | Recommendation | Effort | Status |
|---|---|---|---|---|---|---|
| F-26 | high | `amcp_campaign` injects `account_id` into DV360/Amazon arguments (and 53 nested ops), whose schemas forbid it: those plan steps can never prepare | `src/campaign-runner.ts:109`, `src/campaign-preflight.ts:63` | Add `account_id` only where the target schema declares it | S | fixed (batch 2) |
| F-27 | high | `REVIEW_EXPIRED` has no next step; the runner marks the step failed although nothing was submitted | `src/write-review.ts:1218`, `src/campaign-runner.ts:117` | Store original arguments; `details.next_call`; runner re-prepares on pre-submission errors | S | fixed (batch 2) |
| F-28 | medium | ~89 % of refusal sites give no details; most codes fall to a generic remedy ("prepare again") that is wrong for execute-time confirmations | `src/errors.ts:23-43` | Code-specific remedies with `next_call` | M | partly fixed (batch 2: confirmation, idempotency and expiry remedies) |
| F-29 | medium | Output bloat: `contract_evidence` (5 KB) on every inspect/prepare, `tools/list` ≈ 20 k tokens, DV360 enum listed twice, identical `outputSchema` ×27 | `src/write-review.ts`, `server/mcp.ts:13` | Opt-in `evidence:"ref"`, compact tool list flag | M | partly fixed (batch 6: opt-in `compactSchemas` lists DV360 actions once, −6.9 KB; evidence references remain) |
| F-30 | medium | Inaccurate descriptions and dead parameters (`skip_preflight`, `dv360_reporting_ops`, "named tools") | `generated/registry.json:2033` | "AMCP note" appended to descriptions | S | planned |
| F-31 | medium | Overlapping tools without guidance (three reporting surfaces, duplicated workspace ops, three media entry points) | `src/service.ts` | One "use this when" sentence per extension tool | S | planned |
| F-32 | medium | Inconsistent argument names (account key per gateway, params/payload/body, pagination, casing) | catalog schemas | Document canonical forms; aliases for `connectionId` | M | planned |
| F-33 | medium | Idempotency rule (key = review id) enforced with three different codes; key must be repeated | `src/write-review.ts:1210`, `src/media-upload.ts:201`, `src/campaign-runner.ts:113` | Default the key to `review_id`; one code | S | fixed (batch 2: key optional; mismatch codes unchanged) |
| F-34 | low | Guide line pushed execution without asking ("Do not impose extra confirmations") | `Skills/amcp-campaign-builder/SKILL.md:72` | Tie flags to `execute_requirements` and user approval | S | fixed |

## Website (5.3)

| ID | Sev | Finding | Evidence | Recommendation | Effort | Status |
|---|---|---|---|---|---|---|
| F-35 | high | Errors only as a 6-second toast; dead-end pages; internal messages shown | `web/app.js:6,75,89` | Page-level error state with cause, retry and way back (`role=alert`) | M | fixed (batch 3) |
| F-36 | high | Destructive actions without confirmation (token/client revoke, revoke all writes, unlink sign-in, cancel plan, remove member, retention, snapshot export) | `web/app.js:110,116-117`, `web/identity.js:48`, `web/workspace.js:32`, `web/account-security.js:26` | One `confirmAction` on the styled dialog | S–M | fixed (batch 3) |
| F-37 | high | Focus ring 2.78:1 and control borders ~1.3:1 fail WCAG 1.4.11; command input has no focus style | `web/identity.css` | `--iris-700` ring, `--line-strong` borders | S | fixed (batch 3) |
| F-38 | high | Text contrast/size failures on every workspace page (subtitles 3.76, footer 3.37, kbd 2.42, 10 px notes) | `web/identity.css`, `web/app.css`, `web/reporting.css` | `--text-muted #6c697b`, 12 px minimum | S | partly fixed (batch 3: 271 → 60 low-contrast texts) |
| F-39 | high | Re-renders drop keyboard focus; `#content` is `aria-live` so every route change is read aloud | `web/index.html:4` | Focus `h1` on navigation, restore focus keys, one live region | M | fixed (batch 3: live region removed; batch 6: every action returns focus to its control or the page heading) |
| F-40 | medium | Design tokens drift from `docs/AMCP-IDENTITY.md`; `--green` holds purple; old green theme still loaded; 523 hard-coded colours | `web/app.css`, `web/identity.css` | One `tokens.css` | M | planned |
| F-41 | medium | MFA setup shows only the raw secret (no QR), no copy/download for recovery codes | `web/account-security.js:24` | Three-step setup | S–M | partly fixed (batch 6: numbered steps, open-in-authenticator link from the server's `otpauth://` URI, grouped copyable key, copy and download of recovery codes; a QR code needs a vendored encoder) |
| F-42 | medium | Team members: role and removal share one select; invite success styled as error | `web/account-approvals.js:72` | Separate remove action, feedback | M | fixed (batch 6: "Save role" and a confirmed "Remove"; success messages as notices) |
| F-43 | medium | Heading order, unnamed dialogs, no `aria-current`, wrong breadcrumb for unknown routes | `web/app.js:12` | Semantics fixes | S | partly fixed (batch 3: dialog names, aria-current, titles) |
| F-44 | medium | Overflow at 320–360 px; closed sidebar casts a shadow | `web/identity.css` | `min-width:0`, `overflow-wrap`, shadow on open only | S | fixed (batch 3) |
| F-45 | medium | No compression; `Cache-Control: no-store` on static assets | `server/http-app.ts:25` | `no-cache` + ETag for `/assets`, compression | S | partly fixed (batch 3: assets revalidate; compression planned) |
| F-46 | medium | Back/Forward bypasses the test-account navigation scoping (popstate bound to the original `render`) | `web/app.js:125`, `web/account-scope.js:6` | `addEventListener('popstate',()=>render())` | S | fixed (batch 3) |
| F-47 | low | No RTL support; fixed `en-GB` formats | `web/reporting-overview.js:37` | `dir`, logical properties, `Intl` with user locale | M–L | planned |
| F-48 | low | `tools/check-web.mjs` only runs `node --check` | `tools/check-web.mjs` | CSP/innerHTML/token lints, Playwright + axe smoke | M | fixed (batch 3) |

## Platform contracts (5.5)

| ID | Sev | Finding | Evidence | Recommendation | Effort | Status |
|---|---|---|---|---|---|---|
| F-49 | high | Google Ads v23 sunsets 2027-02 (recorded); v25 is current (developer blog, snippet) | `src/contract-evidence.ts` | Plan the v23→v25 migration now; add a dated sunset alarm | L | owner |
| F-50 | medium | Microsoft SOAP fully deprecated 2027-01-31; pinned evidence is SOAP WSDL for a JSON transport | `src/microsoft-native.ts`, `.mirror/VENDOR/microsoft-*-v13.json` | Pin REST evidence | M | planned |
| F-51 | medium | Criteo 2026-01 end of life ≈ Jan 2027 (inferred from the 12-month policy); 2026-07 changes reporting | `src/provider-contracts.ts` | Migration plan | L | owner |
| F-52 | medium | Meta v26.0 released 2026-07-29; v25.0 end date unverified | `/v25.0/` paths | Verify on the versions page; plan upgrade | M | owner |
| F-53 | medium | LinkedIn runtime pins 202605 while 12 modules cite li-lms-2026-09; `workspace.ts:24` and `report-native.ts:42` hard-code the header | `src/linkedin-version.ts`, `src/workspace.ts:24`, `src/report-native.ts:42` | One constant via `linkedinVersion()`; move to 202609 after review | S/M | partly fixed (batch 2: one source; version bump is owner) |
| F-54 | low | `CONTRACTS.md` still advertises Reddit lead forms after the 2026-09-21 creation sunset | `docs/CONTRACTS.md` | Regenerate scope text from dated sunsets | S | fixed (batch 5: scope text states the withdrawal and the 2026-09-30 pause of existing lead-form ads) |
| F-56 | medium | Drift detection gaps: DV360 has no digest; weekly job fails every week and only uploads an artifact; no sunset registry | `.github/workflows/provider-drift.yml`, `tools/provider-lifecycle.ts` | Digests for every envelope; sunset registry with 90-day alarm; issue on change | M | planned |
| F-58 | info | Ledger re-triage: 5 conservative candidates (Google customer labels, Meta advideo delete, TikTok portfolio delete, X stats job delete, Snapchat multipart reclassification) and 19 LinkedIn legacy routes to reclassify | `docs/implementation/ACTION-CONTRACT-COVERAGE.csv` | Implement to the family standard after P2 | M each | planned |
| F-71 | medium | Reports put each platform's "conversions" in one column although it is a different measure on every platform (Google `metrics.conversions`, LinkedIn `externalWebsiteConversions`, GA4 `keyEvents`, Meta and Snapchat by objective, none on Reddit and X); nothing in the view or the exports said so | `src/report-native.ts` `normalizeNativeRow` | Show the native source of every metric per platform, kept equal to the code by a test | S | fixed (batch 4: `metricSources`, reporting view, evidence download) |
| F-72 | low | Only Google Ads and Microsoft pinned documents carry `document_sha256`; the other 15 can change on disk unnoticed | `.mirror/VENDOR/*.json` | Seal every pinned document | S | fixed (batch 5: all 22 sealed; the vendor tools and a test require the seal) |

## Architecture, performance, developer experience (5.1, 5.6, 5.9)

| ID | Sev | Finding | Evidence | Recommendation | Effort | Status |
|---|---|---|---|---|---|---|
| F-59 | medium | Family wiring through ~14 order-sensitive chains in 10 files; ~10 string-anchored edits per new family | see [ARCHITECTURE.md §5](ARCHITECTURE.md#5-family-wiring-why-adding-one-is-expensive) | Typed `ReviewedFamily` registry; kinds proven disjoint (105 of 113 predicates exercised over 3,071 ledger routes, 0 overlaps) | L | partly fixed (batches 4 and 6: 57 families registered, 1,044 wiring lines removed) |
| F-60 | medium | 83-level nested reader chains, duplicated in review and verification | `src/write-review.ts`, `src/write-verification.ts` | Reader pipeline composed from the registry | M | partly fixed (57 readers composed by `readThroughFamilies`; chains 83 → 26 and 80 → 23 levels) |
| F-61 | medium | 15+ near-identical guarded-reader wrappers with subtly different credential checks | `src/write-review.ts` `state()` | One `guardedReader({credentialBinding})` helper | M | planned |
| F-62 | medium | No formatter or linter; 1,872 lines over 300 characters; 3.65 MB `src/` in 31,750 lines (100,847 at 120 columns) | repository | Prettier at 120 columns, module by module, proven neutral by formatted-`dist` equality | L | planned |
| F-63 | low | Generic spend text match exempts 80 families by name | `src/preflight.ts:171` | Registry `spend` declaration | M | partly fixed (51 exemptions declared by their families; 32 named remain) |
| F-64 | info | Cold start 1.1 s, RSS 197 MB, 18 MB generated JSON parsed at start | [ARCHITECTURE.md §7](ARCHITECTURE.md#7-measured-baseline-2026-09-28-linux-container-node-24210) | Lazy route indexes | M | planned |
| F-65 | medium | Tests run with `--test-concurrency=1`; the suite is parallel-safe | `package.json` `test` | Measured 2,668 tests in 357 s at concurrency 8 vs 1,416 s serial (serial run under load); default to parallel | S | fixed (batch 2) |
| F-66 | low | Temp-directory cleanup flaky on Windows in several tests; one test leaked its directory | `tests/deployment-smoke.test.ts:42`, `tests/operations-recovery.test.mjs`, `tests/google-upload-restart.test.mjs`, `tests/google-preview-writes.test.ts` | Use the existing `removeTestDirectory` helper everywhere | S | fixed |
| F-68 | low | No related-suites runner; handoff docs append-only; no architecture doc | `docs/implementation/` | `npm run test:related`, docs index | M | partly fixed (batch 2: `npm run test:related`) |
| F-70 | low | Resource ownership bindings last at most 5 minutes, like reviews, so an expired review usually also needs the ownership read again | `src/store.ts:232-233` | Expiry recovery takes two extra calls | Name the ownership read in `RESOURCE_SCOPE_REQUIRED` (F-28) or refresh the binding from the target's own account field | S | partly fixed (batch 5: the refusal names the ownership reads; bindings still last five minutes) |
| F-69 | low | `npm run report` rewrites two tracked files (`.mirror/PARITY.md`, `.mirror/REPORTS/implementation-status.json`), which are stale at `HEAD` | `tools/report.ts` | Commit on change or write to an ignored path | S | fixed (batch 5: regenerated; `npm run check` runs `report --check`) |

## Controls verified correct (not re-audit targets)

Session cookie (`__Host-`, HttpOnly, Secure, SameSite=Lax, 256-bit, hashed, rotated on every sign-in step, deleted on
logout); CSRF token plus `Origin` on every mutation; CSP without inline sources; proxy-chain resolution; user password
hashing (scrypt N=32768, r=8, p=3, dummy hash for unknown e-mails); TOTP with replay block and sealed secret; hashed
single-use recovery codes; platform OAuth state bound to the session with S256 PKCE where supported; social sign-in
ID-token validation (issuer, audience, nonce, `azp`, expiry, age); MCP authorization server (S256 only, exact
redirects, resource check, admin consent, one-use codes, refresh rotation with family revocation, sealed client
secrets); bearer tokens (~244 bits, hashed, expiring, revocable, rechecked per call); tenant filtering on every store
accessor; egress (`redirect:'error'`, origin allowlists, pinned DNS for report downloads, 8 MB cap, 30 s timeouts,
retries for reads only); injection controls (path encoding, REST.li re-serialisation, GAQL from validated resource
names, CSV/Sheets formula prefixing); FFmpeg (`shell:false`, protocol whitelist, size/time caps); encrypted,
restore-verified backups (`src/backup.ts`); exact decimal policy arithmetic; the review → execute invariants listed in
[ARCHITECTURE.md §4](ARCHITECTURE.md#4-reviewed-write-lifecycle).
