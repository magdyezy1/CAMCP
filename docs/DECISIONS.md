---
status: reference
tier: operator
---

# Decisions

The maintained record of owner decisions and of what happened to earlier recommendations (DOC-02). Each row names the
date, the decision, its outcome (accepted or approved, declined or deferred), what would reopen it, and the canonical
ID it governs. A decision changes only the stage it names: it never marks a package complete. Package status is
reported on three axes in [package status](review/PACKAGE-STATUS.md). Settled decisions, such as the declined
out-of-band spend approval, are recorded rather than reopened.

Canonical IDs: `D`, `R` and `P` are the owner questions of the 2026-10-08 engineering review; three-letter IDs
(`OPS-04`) are its register items; `B01`–`B32` are packages.

## October 2026: delivery instructions

How the review's items are delivered, as the owner instructed. These govern the work, not product behaviour.

| Date | Instruction | Outcome | Revisit trigger | Governs |
|---|---|---|---|---|
| 2026-10-24 | Consolidate the documentation ("consolidating the docs ... DO IT") and keep the documentation and help for members ("DOCS AND HELP ARE MEMBERS ONLY, FINISH IT") | Accepted (DOC-03). **Help:** the owner guide, in English with its Arabic translation, is the website's Help page (`/help`) for signed-in members only: no public page, robots or sitemap entry; the workspace footer and the command palette link it. **Documentation:** every page says its status and tier in its front matter; the [index](README.md), the [status page](STATUS.md) and the [findings register](review/FINDINGS.md) are generated; the operations runbook and the workflow guide are task pages ([operations](operations/), [workflows](workflows/)), and their delivery history is in dated [records](records/). **Engineering approach, not an owner decision**, recorded so the owner can revisit it: the review's budget of about 25,000 words applies to the current pages of the owner and operator tiers (24,011 words on 2026-10-24); the guides read on demand (the engineering tier, and the owner and operator references such as the workflow and task detail) are status `reference`, with their own size report, whose total `tools/docs-lint.mjs` records (133,656 words on 2026-10-24) and lets only fall unless an increase is recorded with its reason; the duplicate-line share stays under 5% | The owner wants another audience, budget or split (for example the operator references inside the budget), or the Help page public | DOC-03, P12, B09 |
| 2026-10-22 | Complete wave 4b | Accepted: the wave 4b packages (MCP quality, design review, design system, current-state documentation DOC-01, owner guide DOC-03) are implemented and merged into `Work-here` with their review fixes, and on 2026-10-24 the release gate, container parity and the rendered browser qualification passed ([qualification record](records/QUALIFICATION-4b-2026-10-24.md)). DOC-03's remaining items (documentation size, a front-matter index, Home card copy and the Help link, whose hosting and publication the owner has not chosen) stay open in package status; the next push waits for the owner's approval | The owner names another scope or push point | D25, B16, DOC-01, DOC-03 |
| 2026-10-18 | Finish wave 4a, push to git and pause; start wave 4b only when the owner confirms | Accepted: wave 4a (ARC-01 phase B, ARC-04 stages C, D and F, WEB-07) was integrated and gated, and `Work-here` was pushed at `5db67a71` on 2026-10-18. Before that push the owner approved the legal pages and the security contact (D3) and confirmed the Railway volume mount. Railway's Linux build then failed twice and was fixed (`998d711a`, `cb338f68`); the next deployment refused to start because of `AMCP_LINKEDIN_API_VERSION`, which the owner then set to `202609`, and the deployment of `cb338f68` is active (owner report) | The owner confirms wave 4b (done 2026-10-22) | D3, D25, B16, ACC-04 |
| 2026-10-17 | Continue through the wave 3b integration and wave 4 (documentation), then push to git | Accepted: the push to `Work-here` follows wave 4 and its gate, instead of one push after all waves as planned on 2026-10-09. Commits stay local until then, and package branches are never pushed; the push point changed on 2026-10-18 | The owner names another point to push | D25, B16 |
| 2026-10-10 | Upgrade the bundled MCP SDK from 1.30.0 to 1.32.1 | Accepted and applied ([OAuth hardening](OAUTH-HARDENING.md)) | An SDK v2 dependency is proposed | MCP-03 |
| 2026-10-09 | Implement every review item with the recommended option of each decision; parked providers last; provider accounts stay read-only; commits stay local until one final push | Accepted (D1–D27 below; P1–P12 approved on 2026-10-11); the push point changed on 2026-10-17 | — | D1–D27, PRK-01, PRK-02, ACC-01 |

## 2026-10-13: Zoho CRM scope

The owner set the scope of a Zoho CRM source on 2026-10-13. Zoho CRM is not one of the review's register items; it is
planned with the parked providers (wave 5).

| Decision | Outcome | Implementation | Revisit trigger | Governs |
|---|---|---|---|---|
| Zoho CRM scope | Accepted: CRM to ads only. AMCP reads Zoho CRM leads, contacts and deals read-only, to build offline conversion uploads and customer-list audiences, and sends what it builds to Meta, Google, TikTok, LinkedIn or Snapchat only through the existing reviewed write engine (review, spending policy, idempotency and read-back unchanged). Nothing is written to Zoho. Leads and contacts are personal data, so their reads and uploads follow the [personal-data policy](review/PERSONAL-DATA-POLICY.md) (P4). | Not started: planned for wave 5 with the parked providers (Zoho OAuth with its data-center domains, bounded paginated reads of leads, contacts and deals, mapped to offline conversion events and customer-list audiences of existing reviewed families) | The owner wants AMCP to write to Zoho (for example a lead status), or another CRM | The Zoho CRM source (wave 5), SEC-04 |

## 2026-10-11: product direction P1–P12

The owner approved the product-direction choices P1–P12 of the review handoff on 2026-10-11 (P8 as the multi-provider
measurement hub, P3 designed to GDPR and the KSA PDPL, every other proposal as written), after instructing on
2026-10-09 that every review item be implemented with the recommended options. Where the handoff gave a
recommendation it is the choice; where it gave none, the choice implements the fuller scope and keeps every existing
safeguard. None is pending. Each row records the direction; its Implementation cell says where the code stands, and a
part not built yet is named there as work, not as an open decision. The owner may revise any of them.

| ID | Decision | Outcome | Implementation | Governs |
|---|---|---|---|---|
| P1 | Agency isolation and teamwork | Approved: many clients per workspace. Start with the non-authorizing working-client filter, then optional authorizing client access sets. Spending plans may require a distinct approver through the opt-in approval mode (off by default). Members see colleagues' plans and stuck uploads read-only (handover). | Built: the working client, a view filter that grants nothing, and client access sets, inert until an administrator creates one (SEC-08); `approval_mode: distinct_approver` and the plan policy `require_distinct_approver`, both off by default (WRT-09, CMP-05); a plan's owner shares it with named colleagues as viewer, editor or approver, and administrators see every plan (CMP-05). Not built yet: a read-only view of colleagues' plans and unfinished uploads for members nobody shared them with | SEC-08, CMP-05, WRT-09 |
| P2 | Account security | Approved: two-step verification is mandatory for owners and administrators of write-enabled workspaces; invitations last 7 days; the app-reviewer workspace lifecycle is treated first. | Built: the two-step baseline (`AMCP_REQUIRE_MFA=admins`, the default) and the shared reviewer workspace's logins removed 7 days after they were connected, or at once when the reviewer password changes (SEC-06). Since wave 3b invitations last 7 days by default (before, 72 hours); the owner may set 1 to 168 hours | SEC-06 |
| P3 | Retention and erasure | Approved: design to GDPR and the KSA PDPL. Sign-ups never approved are purged after 30 days and revoked accounts' personal data after 90 days; reports follow a retention per document kind (ARC-02); self-service account deletion is offered. Residual copies (WAL, volume snapshots, older backups) are covered by application retention plus backup expiry and key rotation, documented as such, not promised as instant cryptographic erasure. | Built in waves 2 and 3 (SEC-07, below): the 30- and 90-day defaults, a 365-day default for the report records of workspaces without their own period (that value chosen during implementation), and self-service deletion with an erasure receipt. Since wave 3b the retention declared per document kind drives the sweeps (ARC-02, [document kinds](DOCUMENT-KINDS.md)) | SEC-07, ARC-02, OPS-02, WEB-02 |
| P4 | Personal data and viewer files | Approved: TikTok lead reads are personal data; viewer report downloads stay off by default (an owner opt-in); provider no-execution rehearsals that transmit hashed personal data are reviewed like executions; a user-scoped `amcp_test_id` GA4 dimension is allowed only on properties explicitly marked as test properties. | Built: lead reads are refused before any provider request (SEC-04), the owner's viewer download switch is off by default (SEC-05), and only an owner-marked test property takes the dimension (MSR-04). No provider rehearsal is sent today: `amcp_write inspect` builds it as a local dry run (MSR-03 E); under this rule, sending one needs a review like an execution | SEC-04, SEC-05, MSR-03, MSR-04 |
| P5 | Review and approval | Approved: an opt-in `destructive_confirmed` tier; only the owner may execute an over-cap review under `confirm`; the 5-minute review window stays; caps carry a currency, and a legacy cap on an account in another currency blocks until it is saved again. | Built: the window (WRT-05), the opt-in tier (`require_destructive_confirmation`, off by default; WRT-09) and currency caps (WRT-07). Since wave 3b only the owner executes beyond a cap, always on (`CAP_OVERRIDE_OWNER_REQUIRED`; before, the opt-in `cap_override_owner_only`), and caps in account currency that name no currency refuse every budget or bid change on the accounts they govern until the owner saves them again (`POLICY_CURRENCY_UNSET`: AMCP cannot tell which currency such a cap meant; before, a warning; `AMCP_LEGACY_CURRENCY_CAPS=warn` is a rollback only), except a request that only lowers budgets from their current amounts (D7: decreases are always allowed) | WRT-05, WRT-07, WRT-08, WRT-09 |
| P6 | Reporting semantics | Approved: proposals (1) to (5) as written in the handoff: rolling windows per source in the account time zone; declared-incomplete detail sources keep a snapshot partial and hold its recommendations; GA4 `(not set)` and Search Console top rows are scope limits; Meta actions omitted from delivered rows count as zero with `provider_omitted`; Microsoft totals in the account time zone. | Built in waves 1 and 2, with proposals (6) to (8) (RPT-02, RPT-03, RPT-04, DEC-01, EXP-04; below) | RPT-02, RPT-04, DEC-01, EXP-03 |
| P7 | Campaign and provider roadmap | Approved: the Microsoft Search pack is draft only and activation is refused without a positive location criterion; UTM parameters by default, provider tracking-suffix fields where the provider supports them, and conventions can be made mandatory per client; the next guided packs are TikTok traffic and conversions, LinkedIn lead generation and Google Performance Max where contracts allow (CMP-07). | Built: the activation refusal (`LOCATION_CRITERIA_REQUIRED`), and since the location-criterion family shipped the pack takes `location_ids`, so it is no longer draft only (CMP-03); playbook UTM rules applied by default, with a recorded per-plan opt-out (CMP-06); the four packs ([demand record](#campaign-pack-demand-record-cmp-07-p7-prv-06)). Not built yet: provider tracking-suffix fields, and conventions a client's playbook makes mandatory | CMP-03, CMP-06, CMP-07, PRV-06 |
| P8 | Measurement scope | Approved: Measurement becomes the multi-provider conversion-health hub: the Meta dataset and pixel, Search Console and Adjust, plus Snapchat and TikTok adapters, all read-only, with no test events. | Built in wave 3 (MSR-03, below): read-only adapters for Meta pixels and datasets, Snapchat pixels, TikTok pixel configuration, Search Console and Adjust beside Google Ads and GA4. TikTok pixel activity waits for a native read that pins its response (ACC-06) | MSR-02, MSR-03, B20 |
| P9 | Commerce and parked visibility | Approved: populated Meta destination-only attributes put the item in the review set as `unknown`; parked providers are gated by a lifecycle status on Commerce, in navigation, `tools/list` and the family registry; `amazon_native_action` is marked parked (unimplemented) by that status; explicit removal of listed X products stays allowed only with explicit intent. | Built: since wave 3b a Meta product whose only differences are such attributes is `unknown` and in the review set (before, a note on a matching product; COM-02); removal of listed X products only by an explicit selection with a typed count and `allow_deletion` (COM-02 B); Amazon Ads is not offered (CON-06). Since wave 3b the provider adapter registry gates parked providers by their lifecycle status (Criteo and WooCommerce `owner_parked`, Amazon Ads `unimplemented`; ARC-01, below) | COM-01, COM-02, ARC-01, CON-06 |
| P10 | Provider lifecycle ownership | Approved: the workspace owner owns the manual TikTok lifecycle check, monthly; LinkedIn keeps a reviewed version window and per-call `api_version` stays only within it; the Meta v25.0 rollback gets a monitored deadline once Meta publishes its expiry; lifecycle alarms run locally in the qualification runner. | Built (PRV-02, PRV-04): the TikTok check is due to the workspace owner every 30 days; a LinkedIn version outside the reviewed table is refused; the Meta deadline waits on Meta's published date | PRV-02, PRV-04 |
| P11 | Architecture end state | Approved: in-repo registries only, no per-provider packages; ledger family `files` paths may change for directory moves; a retention period per document kind as ARC-02 defines it; `docs/review/ARCHITECTURE.md` becomes partly generated. | Built in waves 3b and 4a: in-repo registries only (provider adapters and hooks, document kinds, portfolio adapters, report sources and jobs, provider remedies, website routes, reviewed families) and no directory moves, so the ledger's family `files` paths are unchanged; [architecture](review/ARCHITECTURE.md) is partly generated (its ratchet table and family count) | ARC-01, ARC-02, ARC-04 |
| P12 | Documentation audience | Approved: the primary audience is workspace owners at agencies and in-house teams; owner documentation is bilingual (English first, then the Arabic translation); the delivery records move to `docs/records/` and `docs/archive/` with links preserved; signed-in visitors to `/` go to `/dashboard`. | Built in wave 4b (DOC-03): the [owner guide](owner/README.md) in English with its complete [Arabic translation](owner/ar/README.md); the [documentation map](README.md) in tiers for owners, operators and engineers; the delivery, incident and progress records in `docs/records/` and superseded reviews in `docs/archive/`, each old address keeping a redirect stub ([moves](moved.json)) and every relative link checked by `npm run docs:index:check`; a signed-in visitor to `/` gets a 302 to `/dashboard`, and the shell opens Home in place of the landing page | DOC-03, WEB-06 |

### Release notes for the push after wave 4

The approved choices wave 3b applies (P2, P5 and P9) change behaviour for existing workspaces and MCP clients, and the
release notes must call them out beside the P3 defaults (below):

- **Invitations last 7 days (P2).** New invitations expire after 7 days instead of 72 hours. Invitations already sent
  keep their expiry, and a workspace whose owner saved Workspace security before keeps the lifetime saved then (the
  form showed 72 hours) until the owner saves another.
- **Only the owner goes beyond a spending cap (P5).** Under `enforcement: confirm`, another member's execute of a
  review beyond a cap is refused with `CAP_OVERRIDE_OWNER_REQUIRED` before anything is sent: the owner executes it,
  or approves that exact review on the website first. `cap_override_owner_only: false` is refused, and a value stored
  before is no longer read. The rule has no setting: rolling it back means deploying the previous release image.
- **Caps without a currency block money changes (P5).** Until the owner saves a spending policy again with its
  currency, caps in account currency that name none refuse every budget or bid change on the accounts they govern
  (`POLICY_CURRENCY_UNSET`, 409); pausing and renaming are unaffected, and lowering a budget from its current amount
  still runs (D7: decreases are always allowed). Owner health lists such caps (`blocks: true`),
  so owners should save those policies again when the release is deployed. `AMCP_LEGACY_CURRENCY_CAPS=warn` restores
  the earlier comparison as a rollback only.
- **Meta catalog products with destination-only values need review (P9).** A Meta product that matches every supplied
  field but holds values the import does not send (a sale price, staging visibility, inventory) is `unknown` and is
  among the products a "Save only products needing review" draft saves; its native review warns about those values.
- **Criteo and WooCommerce are no longer offered by default (P9).** The provider adapter registry parks them (ARC-01),
  as it parks Amazon Ads: `tools/list` lists 25 tools instead of 27; contracts, capabilities and the Capability Center
  leave them out; Commerce hides the WooCommerce store panels and product source. A call naming
  `criteo_native_action` or `commerce_native_action` is refused with `GATEWAY_NOT_OFFERED` before anything is read or
  sent. Their audit history stays readable, and an administrator can still remove a stored WooCommerce store
  connection. A deployment that still uses them names them in `AMCP_PROVIDERS` (`AMCP_PROVIDERS=criteo,woocommerce`).

## 2026-10-09: engineering review decisions D1–D27

The owner chose the recommended option for every decision in section 1 of the review handoff. Where a decision needs
dashboard or provider access (Railway, Cloudflare, backups), it is accepted here and stays an owner action; the code,
configuration and documentation are prepared in the repository. Where a decision offers a choice without a
recommendation, that part is recorded as **pending owner**.

| ID | Decision | Outcome (recommended option) | Applied | Revisit trigger | Governs |
|---|---|---|---|---|---|
| D1 | Railway settings and build evidence | Accepted. Record the healthcheck path and timeout, restart policy and retries, replicas, draining seconds, watch paths, Wait-for-CI and trigger branch; confirm the dashboard does not override `railway.json`; export the build log and image digest for `60ec2cc`; state the build timeout, deploy cadence and downtime window. | Owner action (read-only dashboard), before 2026-11-15. Since the 2026-10-18 deployment the build log and digest to export are those of `cb338f68`, and the digest also pins the Dockerfile's base image ([deployment lessons](DEPLOY-RAILWAY.md#what-the-2026-10-18-deployment-taught)) | Railway's Config-as-Code cutoff, 2026-12-01 | OPS-05, ACC-04, OPS-07, QA-01 |
| D2 | Cloudflare analytics beacon | Accepted: disable automatic Web Analytics injection. | Owner action in Cloudflare; the CSP stays unchanged | Analytics wanted: allow the beacon in the CSP and disclose it in both privacy pages first | OPS-05, WEB-04, WEB-02 |
| D3 | Product audience, registration and legal identity | Accepted (a): AMCP is a private agency tool, so registration closes and the calls to action become "Request access / Sign in". The owner supplies the operator legal identity, jurisdiction, effective date, Terms wording and security contact. On 2026-10-18, before the push that publishes them, the owner approved the engineering-drafted Terms wording unchanged (the operator is named as the operator of AMCP at amcp.shop), the privacy and data-deletion pages, and an effective date of the day of that push (18 October 2026 in `web/terms*.html`); `security.txt` keeps the `mailto:privacy@amcp.shop` fallback (`AMCP_SECURITY_CONTACT` unset) and an `Expires` of 2027-04-01 (`AMCP_SECURITY_TXT_EXPIRES`). | WEB-02 code; the identity is owner-supplied | Public sign-up wanted: configure a transactional email provider | WEB-02, SEC-05, DOC-03, SEC-06, SEC-08 |
| D4 | Backups and restore | Accepted: enable Railway scheduled volume backups, keep an off-host copy, and run one restore drill with a measured recovery time. | OPS-04: single-step backups, space and volume preflight, `backup-drill`, the restore-drill runbook in [operations](operations/ERASURE-AND-RETENTION.md#restore-drill). Enabling backups and the drill are owner actions. | Each storage or release change | OPS-04, SEC-07, OPS-01 |
| D5 | Client-address profile for rate limits | Accepted: after release set `AMCP_CLIENT_IP_SOURCE=railway+cloudflare`; the source ships with the `socket` default. | SEC-01; the variable is an owner deployment change | Railway or Cloudflare topology change | SEC-01, SEC-03 |
| D6 | `/mcp` batches and per-key limits | Accepted: reject JSON-RPC arrays (`AMCP_MCP_BATCH_MAX=1`); start at 60 requests/min, burst 20, 4 in flight per actor, tunable from `RATE_LIMITED` counts. | SEC-02 | `RATE_LIMITED` counts from real clients | SEC-02 |
| D7 | What owner spending caps count | Accepted: count lifetime `spend_cap` (Meta, Reddit) and custom-period totals against an optional `max_total_budget_native`, and always allow decreases. | WRT-01 Stage C | A provider adds another total-budget form | WRT-01, WRT-07 |
| D8 | How far the deletion switch reaches | Accepted: `allow_deletion:false` also governs feed-driven deletion, evaluated against the current feed state; no extra TikTok DELETE confirmation flag. | WRT-02 Stage C | A new deletion path | WRT-02, WRT-05 |
| D9 | Spend-policy saves from AI clients | Accepted: `expected_revision` is optional for MCP callers, with a warning when omitted; the website always sends it. | WRT-03 | MCP clients send it consistently | WRT-03 |
| D10 | Rounding of fractional provider values | Accepted: nine decimal places, round half to even, recorded in evidence. | RPT-01, DEC-01 | A provider documents more precision | RPT-01, DEC-01 |
| D11 | Unconfirmed Google Sheets deliveries | Accepted: resend the identical batch only after a settle window of at least 10 minutes, plus an audited "release tab" action; never publish an older snapshot over a newer one, export to a new tab instead. Whether the resend runs automatically or after operator confirmation has no recommendation: pending owner. Implemented default (wave 1, recorded 2026-10-10): the export job resends the identical batch of the same report automatically after the settle window (audited as `authorized_by: settle_window`); `AMCP_SHEETS_AUTO_RESEND=off` makes it operator-confirmed only. | EXP-01 step 3, EXP-03, ACC-03 | ACC-03 live delivery results | EXP-01, EXP-03, ACC-03 |
| D12 | Release of claims after early refusals | Accepted: refusals provably raised before any provider request release the idempotency claim and the daily spend reservation; for CMP-04, a `rejected` outcome releases the reservation only for families with a declared non-applied proof. | WRT-04, CMP-04 | A family without non-applied proof | WRT-04, CMP-04 |
| D13 | Daylight-saving gaps | Accepted: shift a nonexistent local time forward to the first valid time. | EXP-02 (the codifying test is rewritten there) | — | EXP-02 |
| D14 | Must-pass AI clients and response budget | Accepted: the must-pass clients are the Claude.ai/Desktop connector, Claude Code, ChatGPT, Codex, Cursor and VS Code; default views are designed under the 10k-token warning (15 KB summary capabilities, a 25,000-character dashboard). Who runs the evaluation sessions: pending owner. | MCP-01, ACC-02, QA-04 | A client changes its budget | MCP-01, ACC-02, QA-04, MCP-03 |
| D15 | Listing goals and tool shape | Accepted: decide on a directory listing first (pending owner); keep one write tool until ACC-02 shows which clients honor the prompt; in read-only deployments list `amcp_write` with `inspect` only. | MCP-06, MCP-09 | A listing requirement or ACC-02 results | MCP-06, MCP-09 |
| D16 | AI-client authorization and identity | Accepted: (1) a 30–60 s refresh-token reuse window with family revocation; (2) operators and viewers connect their own AI clients, scope capped by role; (3) keep the recorded write-by-default consent once a read-only choice exists; (4) person-scoped uploads, originals, plans and variants follow the person across the website and their AI clients. | MCP-08, MCP-02, MED-03 | — | MCP-08, MCP-02, MED-03 |
| D17 | Captured-catalog parity | Accepted: keep the captured schema byte-identical, route first-party help through special cases, keep the captured catalog frozen as the compatibility denominator, declare withheld raw captures as withheld, and annotate unmapped captured operations `CAPABILITY_UNAVAILABLE` rather than hiding them. Which Adjust operations become optional stretch: pending owner. | MCP-05, MCP-10, ARC-03 | — | MCP-05, MCP-10, ARC-03 |
| D18 | Effects allowed in read-only mode | Accepted: `validate_provider` runs only through an explicit owner opt-in, audited before send; provider report and export jobs become a quota-bounded `provider_job` effect under an owner switch; no provider-side report jobs under read-only acceptance until RPT-06 lands. Wave 3 implemented RPT-06: `AMCP_PROVIDER_JOBS` (default `false`) and per-account report-job grants. | WRT-06, RPT-06, ACC-06 | RPT-06 lands | WRT-06, RPT-06, ACC-06 |
| D19 | Provider login lifecycle | Accepted: (1) a renewal by a different provider identity is refused where the identity is available; (2) every write-grant change needs confirmation and audit; (3) the pre-checked "read + reviewed write" selection on new connections is intended (recorded decision); (4) offer provider-side revocation on disconnect as an option, after checking the effect on other Google logins sharing the OAuth client; (5) request Reddit `adsedit` only when writes are enabled. | CON-02, CON-05; (4) ships off behind `AMCP_PROVIDER_REVOCATION` (Google logins, an unchecked choice in the disconnect dialog) until the owner answers Q25 with disposable logins ([operations](operations/CONFIGURATION.md#configuration)) | Q25 answered | CON-02, CON-05 |
| D20 | Conditional-program observations | Accepted: retain them as timestamped "not a grant" records with a time-to-live, purged on disconnect. | CON-04 | — | CON-04, ACC-05, ACC-08 |
| D21 | Error detail on the website | Accepted: show the sanitized provider status and request ID, never tokens or bodies. | WEB-03, PRV-02 | — | WEB-03, PRV-02 |
| D22 | Operations attention feed | Accepted: include uncertain standalone writes, failed monitor emails and reauthorization-required connections. | OPS-06 | — | OPS-06 |
| D23 | Media timing and capacity | Accepted: (1) release an idle website upload earlier than 30 minutes, never later; (2) saved plans may reference 30-minute uploads only with a visible deadline; (3) a per-tenant share of global media capacity (for example at most 4 of 8 slots) after retry-on-contention; (4) Drive imports are frozen copies and show "Drive access since revoked"; (5) planned push rows may re-bind to an identical re-upload (same SHA-256). | MED-01, MED-02, MED-03, MED-05 | Measured media contention | MED-01, MED-02, MED-03, MED-05 |
| D24 | SQLite secure delete | Accepted: keep `secure_delete=ON` and fix the amplification another way. | OPS-01, OPS-02 | — | OPS-01, OPS-02 |
| D25 | Package closure and release records | Accepted: (1) the three-axis status (source, native/live, manual); (2) open-ended remainders become finite packages B29+ or optional stretch; (3) a disposition for each dropped commitment (below); (4) B16 stays a standing per-release gate, with the hosted-CI waiver recorded as an acceptance amendment; (5) B20 raw tracing moves to the conditional package B32. For QA-01: pruning ad hoc `.release` candidates is approved as owner-run from a dry-run list; `NOTICE.md` and `.gitattributes` ship; qualification records stay local. The license has no recommendation: pending owner (no license file until chosen). | DOC-02: [package status](review/PACKAGE-STATUS.md) from `review/package-status.json`, this record; QA-01 records and prune dry-run | Owner disagrees with a count or disposition | DOC-02, DOC-01, QA-01 |
| D26 | Test tooling | Accepted: the browser fixture may accept its own synthetic mutations; an architecture ratchet that blocks only regressions joins `npm run check`. Dev-only property/mutation dependencies versus hand-rolled equivalents, and the qualification runtime budget: pending owner. Implemented defaults (wave 2, recorded 2026-10-11): hand-rolled equivalents, no new dependency (`tools/mutants.mjs`, the IANA zone and decimal sweeps, QA-02); the browser fixture accepts only its own declared synthetic mutations (QA-03); the qualification runtime budget is a proposed 75 minutes, `AMCP_QA_RUNTIME_BUDGET_MINUTES` sets another (QA-03). The architecture ratchet is in `npm run check` and the fast gate since wave 3b (`architecture:check`, ARC-01 phase A and ARC-04 stage A): import cycles and provider coupling may only fall. | QA-02, QA-03, ARC-04 | — | QA-02, QA-03, ARC-04 |
| D27 | Arabic presentation and page names | Accepted: keep Latin digits and one date style per context; keep the partial-Arabic label until B24 acceptance passes; generate the canonical page names from one registry. Whether audit, session and token times show a time zone, which name set is canonical (navigation labels or page titles), and fixing or removing the test-account Clients & templates tab: pending owner. Implemented defaults (wave 2, recorded 2026-10-11): `web/routes.js` makes the navigation labels canonical, with former names as palette aliases in English and Arabic, and Clients & templates is fixed for test accounts (it opens and saves playbooks from the `amcp_workspace profiles` response) (WEB-06). The time-zone question stays open. | WEB-05, WEB-06, DOC-03 | B24 acceptance | WEB-05, WEB-06, DOC-03 |

Also applied on 2026-10-09 (P10, provider lifecycle): the lifecycle alarms run locally inside the qualification
runner (PRV-04), and the Meta v25.0 rollback has its own sunset entry to be dated once Meta publishes the Marketing
API end. The TikTok manual check is the workspace owner's, every 30 days, as P10 (approved on 2026-10-11) names it.

Also applied on 2026-10-09 (P4, personal data, its recommended part first): reads that return submitted leads (the
TikTok lead reads) are personal data and are refused before any provider request (SEC-04,
[personal-data policy](review/PERSONAL-DATA-POLICY.md)). SEC-05 enforces the documented role matrix with an owner
Settings switch for viewer report downloads that is off by default, which P4 as approved on 2026-10-11 keeps (an owner
opt-in). Under the same approval a provider no-execution rehearsal that transmits hashed personal data is reviewed like
an execution; none is sent today. The user-scoped `amcp_test_id` GA4 dimension is applied under MSR-04 below
(owner-marked test properties only).

Also applied on 2026-10-12 (MSR-04, P4's user-scoped dimension question as approved on 2026-10-11): a user-scoped
`amcp_test_id` GA4 custom dimension is used only on a property the workspace owner explicitly marks as a test property
(`amcp_workspace save_ga4_test_property`, owner only, audited, nothing changes in GA4). Only then does
`measurement_event_identity` accept `mode:"realtime_user_scope"`; unmarking refuses it at once. The owner registers the
dimension in GA4 themselves, and the value persists on the synthetic test user. Marking stays MCP-only, like the
personal-data switch.

Also applied on 2026-10-13 (PRV-07, accepted under the owner's instruction to implement every ticket; chosen during
implementation, owner may revise): the optional native reads ship read-only and bounded. Google Ads change history
never requests `user_email` (omitted rather than hashed, so no person is identifiable), and the website shows it on
Live portfolio. Reddit account history drops member IDs, usernames, e-mails and full names before any response
leaves the service and refuses `member_ids` filters. Apple's change history is not added, because the pinned SDK has
no model to project the people out. Apple app lookup and eligibility are planning reads the campaign guide uses
before a campaign is prepared; the reviewed campaign write does not freeze them as state, because the pinned SDK has
no eligibility response model to verify. The organic/paid overlap is MCP-only, labelled approximate and feeds only
the existing reviewed keyword and negative-keyword paths (paid rows name their `search_term_view` ids). The Reddit Conversions API stays a later, separate step under
the personal-data policy; the Apple legacy-origin and `orgId` cleanup stays with PRV-04's dated table.

Also applied on 2026-10-10 (CON-06, the Business Profile and Amazon Ads parts of P9, with the review's proposed
defaults; P9 as approved on 2026-10-11 keeps Amazon Ads parked): Business Profile is a website platform for workspace
owners, shipped behind `AMCP_GBP_API_APPROVED=true` (or a dedicated `AMCP_GBP_CLIENT_ID`/`AMCP_GBP_CLIENT_SECRET`)
because Google's approval of the Cloud project for the Business Profile APIs (R4) is not declared. Amazon Ads takes
option (b): `amazon_native_action` is not offered (not in `tools/list`, the Capability Center or the Overview; a call
is refused with `GATEWAY_NOT_OFFERED` before anything is read) until a Login with Amazon onboarding exists;
`AMCP_PROVIDERS=amazon` reverses it for an operator-provisioned connection. Building that onboarding (option (a)) is
what would unpark it.

Also applied on 2026-10-11 (OPS-08, chosen during implementation; the owner may revise): owner health's provider
quota view shows, beside a workspace's own counts, the deployment-wide daily request, refusal and 429 counts of each
shared provider app (hashed issuer) that workspace used. Every workspace owner therefore sees aggregate activity of
other workspaces on AMCP-owned apps: counts per day only, never a workspace, account or person. Restricting the
totals to the deployment administrator is the alternative if that aggregate is considered sensitive. Pinning the
`node:24-bookworm-slim` base image by digest (OPS-08 step 1) is a deferred owner step: the digest to pin is the
`base_image.digest` of the first Railway build evidence record (ACC-04, `docs/DEPLOY-RAILWAY.md`).

Also applied on 2026-10-11 (SEC-06 and SEC-07, P2 and P3 as approved that day): the default two-step baseline
(`AMCP_REQUIRE_MFA=admins`) covers owners and administrators of write-enabled workspaces only (a connection grants
write access), with the grace period counted from when a workspace was first seen write-enabled; `everyone` stays the
stricter explicit choice. Sign-ups never approved are erased after 30 days by default (`AMCP_PENDING_ACCOUNT_DAYS`;
`off` keeps them), except a pending account that holds a membership in another workspace. Since wave 3b invitations
last 7 days by default (P2; before, 72 hours).

P3 as approved on 2026-10-11 (design to GDPR and the KSA PDPL), applied in wave 3: revoked accounts are erased 90 days
after revocation by default (`AMCP_REVOKED_ACCOUNT_DAYS`, `off` keeps them; before, they were kept unless set); report
records follow a retention per document kind with a deployment default of 365 days for workspaces whose owner saved no
period (`AMCP_REPORT_RETENTION_DAYS`, `off` keeps them; the 365-day value was chosen during implementation and the owner
may revise it; the kinds move to ARC-02's registry later); people delete their own account in Account, with the typed
confirmation, "Confirm it's you" and an erasure receipt, refused for a sole owner whose workspace others use
(`AMCP_ACCOUNT_SELF_DELETION=off` is the rollback). Residual copies (the write-ahead log until the next checkpoint,
volume snapshots and older backups) are covered by application retention, backup expiry, erasure re-application and
master-key rotation, and are documented that way, not promised as instant cryptographic erasure. The release notes
must call out both account defaults, since the first sweep after deploy erases pending sign-ups older than 30 days and
accounts revoked more than 90 days ago, and the report default, since the first cleanup deletes finished report
records older than 365 days in workspaces without their own period. Erasure keeps the single global audit chain: an erased account's audit rows become
tombstones that `verifyAudit` accepts only with a matching `account_erased` receipt (SEC-07 S4(b) alternative). The
per-tenant HMAC-keyed audit chains S4(b) proposed were not built: they would need a migration of every existing chain
and a key per workspace, while tombstones keep the existing chain verifiable and erase the personal data it held.

Remaining fallback (CON-05, recorded 2026-10-11): a website Google Ads login saved before manager routes were recorded
has no route map, so its requests still use the login customer copied into it at that earlier connect (the
deployment-wide `AMCP_GOOGLE_LOGIN_CUSTOMER_ID` of that time). The next sync of the login records a route for every
account and ends the fallback; after the release, sync each existing Google Ads login once in Connections. A login with
a route map refuses an unmapped account with `GOOGLE_LOGIN_CUSTOMER_UNMAPPED`, and an operator-provisioned login keeps
its own login customer (it is never replaced from the environment).

MCP-03, recorded 2026-10-11: `AMCP_MCP_MODERN_PROTOCOL` stays `off` by default. `next` serves MCP 2026-07-28 at
`/mcp/next` for the ACC-02 client checks; `on` waits for that ACC-02 evidence (each must-pass client connects through
`/mcp/next`). `server/mcp-modern.ts` frames 2026-07-28 by hand and is interim: it is to be replaced by the SDK's v2
`createMcpHandler` once a v2 dependency is approved ([OAuth hardening](OAUTH-HARDENING.md), "Still open"). Accepted
residual: the per-address registration key is one IPv6 /64, so a sender with many addresses can hold the daily
registration limit for up to a day; metadata-document clients and existing connections are unaffected
([threat model](review/THREAT-MODEL.md), T9). OAuth `error_description` sentences from `/authorize`, `/register`,
`/token` and `/revoke` (including the two registration-limit sentences) are protocol output for OAuth clients and
stay English, as the existing OAuth descriptions are; no AMCP page displays them, and an AI client that shows one shows
it as received.

Also applied in waves 1 to 3b (first recorded 2026-10-11 at the wave 2 gate): the parts of P5, P6, P7 and P9 that the
code cites as owner decisions, as approved on 2026-10-11 ([P1–P12](#2026-10-11-product-direction-p1p12)) or, where
the approval names nothing, the review's recommended or the ticket's proposed option:

- **P5.** The 5-minute review window stays until the friction baseline is read (WRT-05). A spending cap may carry an
  ISO currency: a cap in another currency than the account's is `POLICY_CURRENCY_MISMATCH` (asked under `confirm`,
  refused under `block`, never converted) (WRT-07). A cap saved without one was compared as before while the owner
  was warned (`POLICY_CURRENCY_UNSET`) until wave 3b; as P5 approves, it now refuses every budget or bid change on
  the accounts it governs until the owner saves it again with its currency, except lowering a budget from its current
  amount (D7: decreases are always allowed). A negative-only Google targeting create
  needs no spend acknowledgement, and removing an exclusion counts as activation (`AMCP_GOOGLE_NARROWING_EXEMPT=false`
  restores the prompt; WRT-07). Standalone `amcp_write` reviews are retained work with a status read and read-only
  reconciliation (WRT-08). Wave 3 (WRT-09) built P5's approval controls: the opt-in `destructive_confirmed` tier
  (`require_destructive_confirmation`, off by default) and `approval_mode` (`assistant_ack` by default,
  `website_approval`, `distinct_approver`). Owner-only execution beyond a cap, opt-in in wave 3
  (`cap_override_owner_only`), is always on since wave 3b, as P5 approves: the owner executes such a review or approves
  it on the website first, and the acknowledgement `cap_override_confirmed` is still needed. Under `distinct_approver`
  each plan step or review that changes spending needs another member's (or the owner's) approval on the website, and
  a review prepared through a door sign-in or a key approved from one needs the owner's (AMCP cannot tell its person
  apart); this serves P1's distinct approver for spending plans, beside the CMP-05 plan policy
  `require_distinct_approver`. Each approval setting applies as the stricter of the account's own policy and the
  workspace default.
- **P6.** Proposals (1) to (8): rolling windows can resolve per source in the account time zone (opt-in
  `date_range.source_timezone: "account"`), declared-incomplete detail sources keep a snapshot partial and hold its
  recommendations, and GA4 `(not set)` and Search Console top-row coverage are scope limits (RPT-02); recommendations
  are frozen with an as-of label (DEC-01); a Meta action absent from a delivered row counts as 0 with
  `provider_omitted`, and Microsoft totals use the account time zone (RPT-04); daily collection uses natively segmented
  requests (RPT-03); schedule times show the delivery time zone first, then the viewer's (EXP-04). An open snapshot is
  addressable with `?report_id=` under the same authorization as any load (RPT-05). Workbook schedules converge into
  Overview (the review's recommendation, chosen during implementation; owner may revise): each moves only by an explicit,
  reversible move that keeps its saved query, and a query without an exact Overview equivalent stays local (EXP-04
  phase 2). P6's further questions (whether a Sheets destination belongs to a report or a client, whether complete-only
  gates a manual export, after how many failures a schedule pauses, the decision-grade metric set, causal experiments)
  are outside the approved proposals: what is built stays as documented, and no decision-grade metric set or causal
  experiment is built. Applied in wave 3 with the review's proposed options (RPT-07, DEC-02): Overview period
  comparison against the previous equal window or a retained snapshot, matched on platform, account, currency, time
  zone, result definition, attribution, level and grain, with exact deltas (nine places, half to even), recomputed
  ratios and reach/frequency only for single days; and the DEC-02 outcome window, the plan's reference length from the
  first account-local day after its last verified budget step, captured only after it has closed, observational and
  never a causal claim.
- **P7.** Activation of a Microsoft campaign without a positive location criterion is refused with
  `LOCATION_CRITERIA_REQUIRED` (CMP-03). The "Draft only" label applied until the location-criterion family shipped
  (`microsoft_location_targets`): the Microsoft Search pack now takes `location_ids` and targets them on the paused
  campaign, and the refusal reads the campaign's location criteria instead of refusing every activation. Its premise,
  that a campaign created through the API targets every location until it has location criteria, is pinned from
  Microsoft's targeting guide (docs/MICROSOFT-ADS.md). As approved on 2026-10-11, UTM parameters are the default, with
  provider tracking-suffix fields where the provider supports them and conventions a client may make mandatory: client
  playbooks apply their UTM rules by default (CMP-06), while the tracking-suffix fields and mandatory conventions are
  not built yet. The next packs P7 names are built (the
  [campaign pack demand record](#campaign-pack-demand-record-cmp-07-p7-prv-06)), and the PRV-06 order follows the
  review's recommendation (the Reddit pixel check first).
- **P9.** Waves 1 to 3 kept a Meta product's populated destination-only attributes as notes (`unsent_fields`, COM-01).
  Since owner decision P9 of 2026-10-11 (applied in wave 3b) Meta uses the `review` policy of COM-03's destination
  registry: a product whose only differences are such attributes is `unknown` and enters the review set; X and
  Snapchat keep the note. The Business Profile and Amazon Ads parts are recorded above, the lifecycle status of parked
  providers below.

P8 (approved on 2026-10-11, applied in wave 3): Measurement is the multi-provider conversion-health hub. The
measurement ledger adds read-only Meta pixel/dataset, Snapchat pixel, TikTok pixel configuration (its activity waits
for a native read that pins the response), Search Console and Adjust adapters beside Google Ads and GA4; Meta pixel
ownership is learned from the ad account's pixel list, and no test event, Conversions API call or validate request is
sent (MSR-03, [product workflows](PRODUCT-WORKFLOWS.md)).

Also implemented in wave 3 (COM-02, the remaining parts of P9): as P9 approves, listed X products outside the supplied
source are removable only by explicit intent, an individual selection by native key from an inspection, bound to that
listing's hash, with a typed count (`confirmed_count`), the owner's `allow_deletion` policy and read-back, while
grouped, unknown and unlisted keys are refused and nothing is selected because a source lacks it (COM-02 B). P9's
approval names neither of the next two, so each is COM-02's proposed option, built under the owner's instruction to
implement every ticket: a read-only Snapchat item comparison, two agreeing scans with exact decimals that name what
to fix in the feed, saving nothing (COM-02 D); and a non-destructive retirement ("out of stock" or "discontinued"
through the reviewed update) in place of a Meta delete contract, which never creates a product: a comparison blocks
it and each retirement step's native review refuses it with `CATALOG_RETIRE_ABSENT` (COM-02 B). Bounded X variant
group expansion stays behind `AMCP_X_CATALOG_GROUP_EXPANSION=qualified`, off by default (the block stays and names
the grouped records) until the R2(7) native read qualifies it (COM-02 E).

Also implemented in wave 3b (ARC-01, the lifecycle part of P9, the review's recommendation): parked providers are gated
by their lifecycle status in the provider adapter registry (`src/provider-adapters.ts`). Criteo and WooCommerce are
`parked` with the reason `owner_parked` (PRK-01, PRK-02), Amazon Ads with `unimplemented` (above). Unless the
deployment's `AMCP_PROVIDERS` names a parked provider, its gateway is absent from `tools/list` (25 tools by default),
contracts, capabilities and the Capability Center; its reviewed families stay registered by design (the ledger keeps
every family; the listings filter them by their gateway's status) but are not listed; any call that names it is refused
with `GATEWAY_NOT_OFFERED` before its arguments are read, except a local read of its retained audit history
(`amcp_workspace history`), which sends nothing; `ScopeGuard` refuses every request to it before credentials are
fetched, so a review prepared while it was offered cannot execute after it is parked, and `NativeTransport` sends
nothing to it whichever caller built the request. Commerce hides the WooCommerce store panels and product source; an
administrator can still remove a stored store connection. Shopify and Salla have no gateway, connection or module to
gate. Their code keeps compiling and their suites run with the provider named in `AMCP_PROVIDERS`
([architecture](review/ARCHITECTURE.md#9-provider-adapters)).

Also implemented on 2026-10-13 (SEC-08, P1's isolation model as approved on 2026-10-11: many clients per workspace).
The non-authorizing working-client filter comes first, as P1 directs: the website's working client is a view filter
(top bar, `?client=`, `profile_id` on the list actions) that never grants anything. The optional authorizing client
access sets P1 names next are SEC-08 phase 2(a), a mechanism that is inert until an administrator creates a set:
client access sets limit members, connector tokens and AI clients to one client's accounts, enforced where accounts
are resolved and refused with `ACCOUNT_SCOPE_RESTRICTED`
([clients in one workspace](USER-ACCOUNTS.md#clients-in-one-workspace-working-client-and-client-access-sets)). No
set exists unless an administrator creates one, so nothing existing changes. Chosen during implementation (the owner
may revise): only viewer and operator access can be limited, never owners or administrators; a removed set reaches
nothing rather than the whole workspace; a limited credential gets no Facebook Page suggestions, since a Page belongs
to a login rather than an account. Owner-created additional workspaces (SEC-08 phase 2(b)) are not built: P1 keeps
many clients in one workspace. P1's other parts are outside SEC-08: the distinct approver is WRT-09's opt-in approval
mode (off by default), and the read-only handover of colleagues' plans and stuck uploads is team-handoff work
(CMP-05: plans are shared with named colleagues; a read-only view for every member is not built yet).

The review's resource and authorization requests R1–R8 (test accounts, named reads, a disposable Sheets destination,
declared provider approvals, LinkedIn programs and DV360, reviewers, a staging environment, the workload profile) are
owner actions, not decisions, and remain open. Each register item that needs one of them stays at the stage the
review names, and live acceptance stays read-only until R1 is answered. The [acceptance runbooks](acceptance/README.md)
(ACC-01 to ACC-08) prepare each of them, and none has been run. The product-direction questions P1–P12 were approved
on 2026-10-11 ([above](#2026-10-11-product-direction-p1p12)).

### Campaign pack demand record (CMP-07, P7, PRV-06)

First recorded 2026-10-12 during implementation, when the packs below were implementer defaults under CMP-07's stated
default for unclear demand (TikTok website traffic, then TikTok conversions). P7 as approved on 2026-10-11 names the
next packs: TikTok traffic and conversions, LinkedIn lead generation and Google Performance Max where contracts allow.
No client demand evidence or per-client usage data is recorded yet: the measurable outcome (plans per recipe per
month, launch checks per launch) starts at zero, and further packs are chosen from client demand (CMP-07, optional
stretch).

| Choice (P7, approved 2026-10-11) | Applied as | Revisit trigger |
|---|---|---|
| Next guided packs: TikTok website traffic and website purchases (the purchases pack is a manual campaign, not the Smart+ of CMP-07's default) | `tiktok_website_traffic` and `tiktok_website_conversions` (manual campaigns, existing post as a Spark Ad, campaign created `DISABLE`) | Plans per recipe after a quarter; a client asks for Smart+ |
| LinkedIn lead generation (built as CMP-07 optional stretch before the approval named it) | `linkedin_lead_generation` (paused group, campaign and sponsored-post creative with an existing lead form) | Plans per recipe after a quarter; a client names another LinkedIn objective |
| Google Performance Max before Demand Gen (Performance Max where contracts allow) | A reviewed all-or-nothing PMax build with locally checked asset minimums; serving diagnostics first (read-only) | Google changes the asset minimums, or a client asks for Demand Gen |
| Post-launch check and serving diagnostics (CMP-07's named items) | `amcp_reporting launch_check` for guided Meta and Snapchat launches (Google keeps its campaign audit workflow); read-only `serving_diagnostics` for Google | Owner asks for scheduled checks |
| PRV-06 order (the review's recommendation: the Reddit pixel check first; the rest in the ticket's proposed order) | Reddit conversion-pixel check first, then Snapchat ad-squad targeting, TikTok comment hide/unhide and Meta Advantage+ creative feature choices (the Meta feature allowlist pinned from the hashed SDK 26.0.2 files on 2026-10-16) | The owner declines a sub-item (closed as declined) |

## October 2026: earlier owner decisions

| Date | Decision | Outcome | Revisit trigger | Governs |
|---|---|---|---|---|
| 2026-10 | Hosted GitHub Actions waived after the Actions minutes ran out; local qualification continues | Accepted (recorded as a B16 acceptance amendment under D25) | Actions minutes restored | B16, ACC-04 |
| 2026-10 | Shopify, Salla, WooCommerce and Criteo expansion and live acceptance parked ([completion audit](archive/COMPLETION-2026-10-07.md)) | Deferred (parked); the 2026-10-09 instruction schedules the parked providers last ([delivery instructions](#october-2026-delivery-instructions)) | The owner unparks a store platform or Criteo | PRK-01, PRK-02 |
| 2026-10 | Live acceptance is read-only: no changes to real advertising accounts | Accepted | Test accounts are designated (R1) | ACC-01, ACC-06 |

## September 2026 decisions

Answered by the owner on 2026-09-28, and "do what is best" on 2026-09-29 (moved from the
[September summary](archive/SUMMARY.md#decisions)).

| Date | Decision | Outcome | Where it stands |
|---|---|---|---|
| 2026-09-28 | Unit-aware spending caps, a bid ceiling, a policy when an account is first connected (F-04, F-57) | Accepted: a cap asks or informs, not fails | Batch 11: `enforcement: confirm` by default, `cap_override_confirmed`, per-platform caps, `max_bid_native` |
| 2026-09-28 | Out-of-band approval for spend and activation | Declined | Not implemented; WRT-09 keeps an optional mode |
| 2026-09-28 | Spend confirmation on field names only | Accepted | Batch 11 |
| 2026-09-28 | Idle timeout and security-change emails (F-25) | Accepted | Batch 11 |
| 2026-09-28 | Encrypted-only backups and purge on disconnect (F-18) | Accepted | Batch 11 |
| 2026-09-28 | Provider upgrades: Google Ads v25, then LinkedIn and Meta, then Criteo (F-49 to F-53) | Accepted | Google Ads v25 (batch 14), Meta v26.0 (batch 15), LinkedIn 202609 and Criteo 2026-07 (batch 32) |
| 2026-09-28 | Invitations while sign-up is closed (F-15) | Accepted: keep them pending | Batch 11 |
| 2026-09-28 | A vendored QR encoder for two-step setup | Accepted | Batch 11 |
| 2026-09-28 | Production settings `MIRROR_FLAGS` and `AMCP_TRUSTED_PROXY_CIDRS` | Accepted | Documented; setting them is a Railway action |
| 2026-09-29 | AMCP runs the ownership read itself when the provider's record states the owning account | Accepted | Batch 30 (F-70) |
| 2026-09-29 | All-or-nothing builds through Google's multi-resource mutate | Accepted | Batch 30 (F-108) |
| 2026-09-29 | Paused parents on Snapchat, Meta and TikTok | Accepted | Batch 30 (F-107) |
| 2026-09-29 | `allow_activation: false` still refuses ENABLED children under a paused parent | Accepted (kept) | The refusal says to keep the entity paused or ask the owner |
| 2026-09-29 | List `https://claude.ai` in `AMCP_MCP_ALLOWED_ORIGINS` (F-88) | Deferred | Added only when the refusal log shows it refused |
| 2026-09-29 | A documented provider validation refusal after submission counts as "not applied" | Accepted where the contract proves it | A refused all-or-nothing Google build is amended under a new key (F-109) |
| 2026-09-29 | Who sees `health`, and the mismatch acceptance design (Snapchat S7, S5) | Accepted as built | — |

## Dispositions of earlier recommendations

Every item of the [October review](archive/REVIEW-2026-10-01.md) sections 5 and 6.13 and of the
[UX audit](archive/UX-2026-10-01.md) section 3, and each commitment D25 lists as dropped, has one row.
Recorded 2026-10-09 under D25.

| Source | Recommendation | Disposition | Governs | Revisit trigger |
|---|---|---|---|---|
| Review §5 | Spending-policy changes during admission | Deferred: investigation not run; it belongs with whole-group preflight and same-target serialization | WRT-04 | WRT-04 lands |
| Review §5 | Conversion identifiers in errors (identifier-error matrix: GCLID, GBRAID, WBRAID, transaction and event IDs, phones) | Accepted and run on 2026-10-10 as `tests/identifier-error-matrix.test.mjs`: a provider error echoing them reached the caller and the audit chain; echoes of sent click, transaction and event IDs and E.164 phones are now scrubbed ([personal-data policy](review/PERSONAL-DATA-POLICY.md)) | B01 | A new family that sends identifiers unhashed |
| Review §5 | Malformed successful report responses | Accepted: pinned response contracts per route | PRV-05 | PRV-05 lands |
| Review §5 | Request budgets across calendar periods | Implemented (B11 whole-job request, time and row budgets) | B11 | — |
| Review §5 | Generic report-job retries | Accepted: replay-safe retries in the job runner | OPS-07 | OPS-07 lands |
| Review §5 | Provenance after resumed native collection | Implemented (B11: "resumed lineage is enforced" is its blueprint property) | B11 | A resumed collection's evidence is questioned |
| Review §5 | Health-check concurrency | Accepted: health and diagnostics fidelity | OPS-02 | OPS-02 lands |
| Review §5 | SQLite contention | Accepted: measured scaling; worker health under contention is already documented | OPS-08 | R8 workload answers |
| Review §5 | Sheets response recovery | Accepted | EXP-01 | ACC-03 |
| Review §5 | Current accessibility on the current branch | Accepted | WEB-01, ACC-07 | Each release (B16 gate) |
| Review §6.13 | Visible change preview | Implemented (B05) | B05 | — |
| Review §6.13 | Account readiness checklist | Partly implemented (capability prerequisites); truthful readiness remains | CON-03 | CON-03 lands |
| Review §6.13 | Plan simulator | Partly implemented (B08 current-brief prerequisites); a multi-problem simulator is optional stretch | B08 | Client demand |
| Review §6.13 | Integrated analysis and persistent monitors | Implemented (B19) | B19 | — |
| Review §6.13 | Creative QA workspace | Partly implemented (per-target eligibility and variants, B10); pipeline fidelity remains | MED-04 | MED-04 lands |
| Review §6.13 | Recovery center | Implemented in B13, with the withheld-record count added under DOC-02 | B13 | The production withheld count is not zero |
| Review §6.13 | Client templates and naming checks | Implemented (B14); applying playbook defaults to recipe plans remains | CMP-06 | CMP-06 lands |
| Review §6.13 | Owner-run acceptance kit | Deferred: replaced by owner-authorized zero-spend live acceptance on designated test accounts | ACC-01 | R1 test accounts designated |
| Review §6.13 | Refusal analytics | Deferred: needs the owner's answer on metadata-only counters (R8 question 4) | QA-04 | R8 answered |
| Review §6.13 | Full Arabic UI and theme support | Theme implemented (batch 191); Arabic partial | WEB-05, B24 | B24 acceptance |
| UX §3 | Account readiness and capability evidence | Implemented (capability center, B08); truthful readiness remains | CON-03 | CON-03 lands |
| UX §3 | Whole-plan review and execution | Implemented (B06) | B06 | — |
| UX §3 | Clone an existing campaign | Implemented (B07) | B07 | — |
| UX §3 | Correct a blocked unsubmitted step | Implemented (B07); the website hides it for preflight-blocked plans | CMP-02 | CMP-02 lands |
| UX §3 | Accept observed read-back state | Implemented (B07) | B07 | — |
| UX §3 | Cap acknowledgement under confirm policy | Implemented (F-135, B05) | B05 | — |
| UX §3 | Media inspection, asynchronous execution and durable job progress | Implemented (B04, B10) | B10 | — |
| UX §3 | Media receipt history | Implemented (B10 cursor-bound library paging) | B10 | — |
| UX §3 | Reports/templates/schedules | Implemented (B11, B12) | B11, B12 | — |
| UX §3 | Client profile deletion | Implemented | B14 | — |
| UX §3 | Per-account personal-data control on the website | Deferred: stays MCP-only (`enable_personal_data`, owner only). P4 as approved on 2026-10-11 settles the classification (TikTok lead reads are personal data) and names no website switch | P4 | The owner asks for the switch on the website |
| UX §3 | Support bundle | Implemented (Operations) | B13 | — |
| D25 list | Success-measure baselines (blueprint) | Implemented locally: step and call baselines in the journey harness (`tests/journeys/baseline.json`, checked by `tools/mcp-eval.mjs`) | QA-04 | MCP-07 lands (re-baseline) |
| D25 list | B10's integrated cross-provider usage view | Replaced by per-asset provider readers (Meta, Google image, Snapchat); further adapters are optional stretch | B10, MED-04 | Client demand |
| D25 list | B13's "complete audit telemetry" | Replaced by a finite list: withheld workbook records by reason (owner health) and feed and job failure counts by code | B13, OPS-02 | — |
| D25 list | B15's "measured" fewer unnecessary calls | Partly implemented: measured by the journey and MCP evaluation harness; the local baseline exists, external-client sessions (D14) remain | QA-04, ACC-02 | External sessions recorded |
| D25 list | Separate concise entry points for owners, engineers and MCP clients | Implemented (DOC-03): the bilingual [owner guide](owner/README.md) and the documentation map in tiers for owners, operators and engineers; MCP clients keep their guide resources | DOC-03 | The owner guide drifts from the website (`tests/owner-guide.test.mjs`) |
