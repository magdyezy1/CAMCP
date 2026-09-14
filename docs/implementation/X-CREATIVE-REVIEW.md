# X creative chain: critical review and implementation

Review date: 2026-09-14. This is a scoped follow-up to the supplied “close the X creative gap” brief, not a new claim that the entire repository or all providers are production-qualified.

## Scope and evidence

- Source: implementation-Codex-branch, on Codex-branch, remote https://github.com/magdyezy1/AMCP.git.
- Baseline: 51c08b162f09625ccc74aeee41d84aef231364a2. The remote matched before editing. Remote main was 067871481d79fc59a6cb976d8a13b62d409e283a.
- The parent development checkout and its .release/AMCP checkout are separate; neither was edited. No main/other-branch changes or deployment actions are part of this work.
- Environment: Windows/PowerShell, Node 24.19.0, npm 11.17.0, TypeScript 7.0.2. No dependency, lockfile, database schema or container runtime change.
- Read-only public documentation and WhatHead route metadata were examined. Six DESCRIBE_ACTION observations are in [x-reference-metadata.json](x-reference-metadata.json). Tool help returned generic native payload fields, not executable field validation. No advertising account was queried.
- The brief's incident reports are user-supplied observations from another account/session. They were not independently reproduced live. Its live-create and global Git-configuration instructions were not treated as permission to override the user's restrictions. Per-command repository ownership exceptions suffice.
- Local tests use disposable SQLite databases, synthetic tokens and provider responses. The test wrapper strips inherited application credentials and blocks unmocked external fetch. No credentials, production databases or unrelated personal files were read.

## What changed and why

| ID | Priority and consequence | Baseline defect / evidence | Correction and proof |
|---|---|---|---|
| X1 | P1: new X ads could not be built through review | Cards, Tweet creation/rename and library registration were catalogued but refused at reviewed execution. Generic state/outcome logic also assumed the wrong resource paths and IDs. | Qualified specific route families in src/x-creative-writes.ts:11 and src/write-review.ts:126. Account, media, card, promotable user and parent reads stay scoped to the selected login. Full synthetic Drive video → library → card → Tweet → promotion → read-back and durable-runner tests pass. |
| X2 | P1: otherwise valid uploads could not feed ads | Library attachment sent media_category, matching the brief's deprecated-parameter error; the parameter is absent from current library request documentation. | Removed only from library registration in src/media-upload.ts. Upload INIT/image category remains. Exact media-key prefix is checked and unknown library readiness remains false. Tests reject a different prefix and poll the account library without repeating writes. Live rejection/success remains unverified. |
| X3 | P1: payloads could compile and then fail or verify incorrectly | All X bodies were form-encoded, but card writes require JSON. Single-card reads/updates/deletes have a documented one-element array envelope; Tweet IDs can exceed JavaScript's safe integer range. | JSON card transport and OAuth signature handling; exact one-card object/array qualification; id_str and media_key identities; correct filtered Tweet collection reads. Unknown, empty, duplicate or wrong-parent responses are refused. |
| X4 | P1: false paused-state promise and policy bypass | Promoted Tweet creation required a PAUSED field that is not part of the documented create contract. Status-free promotion also escaped status-based activation policy inspection. | Promotion is an explicit activation action, requires spend confirmation, honors allow_activation:false and never claims to create a paused association. PUT promotion is no longer qualified. Campaign/line-item paused guards remain. |
| X5 | P1 risk mitigation: a successful edit may disrupt many ads | The brief reports cards/Tweet renames deleting referencing promotions without an error. Metadata still marks these edits non-destructive. This provider effect is reported, not independently confirmed. | Treat every card edit/delete and Tweet rename as potentially destructive. Scan per line item with pagination, fail closed when coverage is incomplete, default CREATIVE_IN_USE, freeze explicit override and affected list, recheck before dispatch, return a scoped recovery plan without replaying it. Owner deletion restrictions still apply. |
| X6 | P2: false verification failure or unsafe retry after lag | Generic read-back built unsupported single-Tweet paths and did not qualify promoted association visibility. | Exact Tweet collection reads and per-line-item promotion verification with three bounded read-only attempts. Missing associations become pending, never permission to resubmit. Four-Tweet cardinality and every association are checked. |
| C1 | P1: TikTok paused review inspected the wrong field | Official SDK AdCreateBody requires creatives; each creative owns operation_status and can default to ENABLE. AMCP required only an outer operation_status. A nested enabled creative could pass that guard. | Qualify one native creative per ad-create review; require nested DISABLE and reject the outer field. Match the single returned ad ID and compare the flattened /ad/get/ record. Negative fixtures prove no egress for enabled/missing nested status. |
| C2 | P1: LinkedIn creative creation and activation safety were inconsistent | Current creative contracts use intendedStatus, while AMCP required/inspected status. The documented paused creative was refused; activation in a REST.li patch could escape the status rule. | Correct native guard, generic ad compiler, spending confirmation and owner activation policy to intendedStatus. Header ID → exact creative read-back fixture passes; patched activation remains blocked by policy. |

The code keeps five-minute actor-bound reviews, request fingerprints, durable mutation claims, current account grants, deployment controls and read-back separation. New cards/Tweets are immediately usable through account-scoped provider reads; no arbitrary returned ID grants cross-account ownership.

### X allow-list before and after

Baseline X branch of assertWriteShape:

    method==='POST' && /^\/12\/accounts\/[^/]+\/(campaigns|line_items|promoted_tweets|targeting_criteria)$/.test(route)
      || ['PUT','DELETE'].includes(method) && /^\/12\/accounts\/[^/]+\/(campaigns|line_items|promoted_tweets)\/[^/]+$/.test(route)
      || method==='DELETE' && /^\/12\/accounts\/[^/]+\/targeting_criteria\/[^/]+$/.test(route)

Result:

    !!xCreativeKind(plan)
      || method==='POST' && /^\/12\/accounts\/[^/]+\/(campaigns|line_items|targeting_criteria)$/.test(route)
      || ['PUT','DELETE'].includes(method) && /^\/12\/accounts\/[^/]+\/(campaigns|line_items)\/[^/]+$/.test(route)
      || method==='DELETE' && /^\/12\/accounts\/[^/]+\/(targeting_criteria|promoted_tweets)\/[^/]+$/.test(route)

xCreativeKind accepts POST cards, singular POST tweet, POST media_library, POST promoted_tweets, PUT/DELETE cards/{id}, and PUT tweets/{id}/name. Native special upload transport, draft Tweets, media_creatives, unsupported card formats and unqualified batch routes remain refused or routed into the existing media workflow.

## Workflow and safety model

1. The client selects one connection/account and supplies business choices. A connection grants visibility; an administrator account-write grant and deployment policy separately permit writes.
2. amcp_media resolves the Drive source, freezes encrypted reviewed bytes, uploads server-side and retains the native ID. Processing or account-library registration may be a separate continuation. Clients do not relay the binary.
3. Card preparation checks account-library identity and readiness. Tweet preparation checks the exact card URI and a FULL promotable user. Tweet counters are excluded from configuration comparison. Media readiness snapshots retain identity/type/status rather than delivery URLs.
4. Promotion preparation checks the line item, parent campaign, exact Tweet and referenced card contents. Card destination or parent serving changes require a new review. Ordered components remain ordered; provider timestamps/telemetry use existing normalization.
5. Execute consumes the frozen review and rechecks authority and dependencies before the durable claim/dispatch. Lost responses remain uncertain across process restart; a new key is not a recovery strategy.
6. Verification checks saved results independently. Promotion lag yields a pending receipt and a read-only continuation. It cannot roll back or retry the mutation. Creative edits return a recovery plan grouped by line item, with at most four Tweet IDs per fresh review.

The usage scan is bounded to 25 pages per collection, 20,000 rows, 250 requests and a 60-second budget checked between requests. Individual transport deadlines/retries still apply. A limit refuses the edit; it does not silently omit accounts or promotions. External changes between the last read and mutation are an unavoidable remaining race without provider conditional mutation support. The fixture simulates the reported destructive behavior to test AMCP's guard, not to prove X always does it.

## Cross-platform four-stage map

“Works (fixture)” means the current local service, compiler, permissions, transport, response handling and verification were exercised with synthetic responses. It does not mean the payload's placement, media size, identity, app approval or targeting was accepted live. The image fixture is intentionally tiny and not an advertising-ready creative. Existing video upload tests cover transport/processing separately; only X received a new full video-ad chain here.

| Platform | Stage | Current action/path | Evidence and result |
|---|---|---|---|
| Google | Media | amcp_media prepare/execute/status; AssetService image mutate; resumable video upload | Works (fixture). Image asset identity feeds the ad fixture. Existing video tests cover Google-managed channel upload and a reviewed YouTube Asset continuation. |
| Google | Creative | google_ads_v23_ad_group_ad_mutate_ad_group_ads; ad.responsive_display_ad | Works (fixture), creative embedded in the ad and referencing uploaded asset resource names. No claim about every Google channel or format. |
| Google | Ad | Same AdGroupAd create with PAUSED | Works (fixture), exact ad-group parent checked. Current Cloud-project access and account eligibility unverified live. |
| Google | Verify | google_ads_v23_google_ads_search | Works (fixture), exact composite resource and fields reconcile. No new live 403 reproduced. |
| Meta | Media | amcp_media; meta_image_upload / meta_video_upload | Works (fixture), native hash/video ID retained. Existing image/video upload and processing negatives remain covered. |
| Meta | Creative | meta_creative_create / meta_ad_account_id_adcreatives_create | Works (fixture), selected Page and uploaded image hash flow into object_story_spec. No universal approval for optional enhancement fields inferred. |
| Meta | Ad | meta_ad_create / meta_ad_account_id_ads_create | Works (fixture), creative ID and adset ID feed a paused ad under the same account grant. |
| Meta | Verify | exact Graph creative/ad GET built by WriteVerifier | Works (fixture); image/creative/ad metadata compared. Actual Page/pixel/app/account grants not inspected live. |
| Snapchat | Media | amcp_media; POST media, multipart media/{id}/upload, GET media/{id} | Works (fixture), exact account and READY media ID. |
| Snapchat | Creative | snapchat_creative_create | Works (fixture), top_snap_media_id feeds a WEB_VIEW creative. Existing JSON Patch test is local; reported provider PATCH defect remains unverified. |
| Snapchat | Ad | snapchat_ad_create under adsquads/{id} | Works (fixture), creative ID feeds a PAUSED ad and exact parent is checked. Placement/SKAdNetwork constraints need objective-specific live qualification. |
| Snapchat | Verify | snapchat_creative_get / native ad GET | Works (fixture), exact scoped creative/ad responses reconcile. |
| TikTok | Media | amcp_media; file/image/ad/upload and file/video/ad/upload | Works (fixture), image ID feeds the nested creative. Existing video upload checks remain separate. |
| TikTok | Creative | tiktok_ad_create, creatives[0] | Works (fixture) for one native creative. Identity creation and Smart+ are contract gaps; no assumption that every account has a reusable identity. |
| TikTok | Ad | tiktok_ad_create | Works (fixture) with nested DISABLE and an existing synthetic identity. Flat create/outer status is now refused. Provider objective/identity/pixel/CTA approval unverified. |
| TikTok | Verify | tiktok_ad_get with one ad_ids filter | Works (fixture), returned native ad and parent match; creation response must identify exactly one ad. |
| LinkedIn | Media | amcp_media; images/videos initializeUpload, upload/finalize, status | Works (fixture), including existing organization-binding and revocation tests. No live Video API permission claim. A sponsored-account-owned asset is not proof of organization-author DSC compatibility. |
| LinkedIn | Creative/post | linkedin_rest_posts_post | **Contract gap**: WRITE_CONTRACT_UNAVAILABLE, “This route is outside the reviewed campaign-management execution contracts. Use a local dry run.” Exact result reproduced locally before provider egress. |
| LinkedIn | Ad/sponsorship | linkedin_rest_ad_accounts_ad_account_id_creatives_post | Works (fixture) for an existing authorized post reference, PAUSED intendedStatus and 201 x-restli-id. New media→new post→ad chain remains incomplete. |
| LinkedIn | Verify | linkedin_rest_ad_accounts_ad_account_id_creatives_creative_urn_get | Works (fixture) by exact header-returned URN, independent of finders. General finder encoding is still partial. |

Additional reproduced local refusals:

- tiktok_identity_create: WRITE_CONTRACT_UNAVAILABLE, “This route is outside the reviewed campaign-management execution contracts. Use a local dry run.”
- New TikTok flat ad-create body: WRITE_CONTRACT_UNAVAILABLE, “Reviewed TikTok ad creation requires exactly one native creatives record per review. Put the ad fields and operation_status inside that record.”
- Missing organization resource binding: RESOURCE_SCOPE_REQUIRED, “Resource ownership is not established. Read its account-scoped collection first, or have an administrator provision an exact resource binding.” Existing media tests cover refusal and revocation. This is not the same as a provider 403.
- Missing account write grant: WRITE_ACCOUNT_FORBIDDEN. Shared grant tests cover campaign/creative/media paths; no live reviewer grant was inspected or changed here.

## Decisions on the supplied brief

| Claim or proposed action | Decision |
|---|---|
| Add route regexes to close the chain | Applied with companion state, payload, transport, response and verification contracts. Regex changes alone were insufficient. |
| Use card_type: VIDEO_WEBSITE | Not accepted by this qualified payload. Current card creation documents components; AMCP derives format through those components and rejects unqualified extra fields. |
| Drop media_category | Applied only at account-library registration. Upload categories are retained and tested. |
| Every edit deletes referencing ads and re-promotion is idempotent with the same IDs | Treat destructive risk conservatively, but do not promise the consequence or recovery identity universally. Recovery needs fresh reads and separately reviewed promotions. |
| X accepts four Tweet IDs | Four is AMCP's conservative review limit. Current X documentation permits up to 50; this is an explicit local limit, not a vendor assertion. |
| Per-line-item verification | Applied, bounded and read-only, with pending visibility rather than automatic mutation retry. |
| TikTok must always be flat; always include pixel_id | Rejected as a universal rule. Official native SDK uses creatives, and Smart+ documents a different nested shape. Tracking requirements depend on objective. Corrected the proven nested-status flaw. |
| LinkedIn's status guard is the model | Correct principle, wrong creative field. intendedStatus is now used consistently. |
| LinkedIn owner override is impossible | Existing exact resource bindings already support this media path. New DSC publication still needs a separate account↔organization↔post authorization contract. The docs demonstrate organization ownership; sponsored-account ownership compatibility is not established here. |
| A LinkedIn 403 uniquely proves missing Video API permission | Not established. App product access, granted scope, organization role and account relationship can each matter. No permission changes performed. |
| LinkedIn finder is broken for strings, arrays and encoded strings | Array input demonstrably becomes JSON in buildUrl, not a REST.li List. Raw strings survive one URL encoding locally; actual provider interpretation still needs a protocol-specific fixture and live confirmation. Exact-ID read-back avoids the finder. No unbounded-list workaround added. |
| Google needs a developer-token access application | Outdated as universal current advice: official documentation says developer tokens were sunset on 2026-09-09 and access is associated with OAuth Cloud projects. Do not infer today's root cause from an old error string. Existing repo guidance already reflects this. |
| Snapchat PATCH is globally broken; replace it with PUT | Not established. Current official docs still describe PATCH. Kept existing route and regression coverage. |
| Meta targeting_optimization / standard_enhancements always fail | Unverified for the current endpoint/version/account. Public documentation fetches were unavailable; no blanket stripping or invented replacement was added. These optional-field claims remain a qualification item. |
| Ignore known flaky tests and add global safe.directory | Not adopted. Preserve initial failures, diagnose current evidence, and use only the exact per-command repository exception. |
| Live creates/cross-connector asset reuse prove completion | Still required for live qualification, but not authorized by the user's existing restrictions. They remain explicitly unperformed. |

## Review coverage of this delta

| Material | Method and limit |
|---|---|
| src/x-creative-writes.ts | Manual route-to-result review; public X docs; positive, negative, race, restart, partial-response and ordered-state fixtures. |
| src/write-review.ts, src/write-verification.ts | Manual touched-path review across prepare/execute/claim/read-back; existing write tests plus new platform chains. Untouched provider families were not re-audited line by line. |
| src/transport.ts, src/media-upload.ts | Manual changed transport/library/status logic; real serializer/signature functions with synthetic fetch; existing seven-platform media tests. No live binary upload. |
| src/execution-risk.ts, src/preflight.ts, src/spend-policy.ts | Manual financial guard integration; activation, deletion, missing confirmation and current-grant negatives. |
| src/workflows.ts, src/campaign-preflight.ts | Manual affected aliases/dependency placeholders; generic workflow regression and durable X chain. |
| src/provider-contracts.ts | Manual capability-boundary update, version/date/test pointers; live qualification remains unverified. |
| tests/x-creative-writes.test.ts, tests/creative-chain-audit.test.ts, tests/media-upload.test.ts | Manually reviewed fixtures; executed through actual service/compiler/transport/SQLite where applicable. Focused helpers also cover response and pagination negatives. Fixtures cannot prove actual provider delivery. |
| Skills/amcp-campaign-builder/references/{linkedin-x,tiktok-snapchat,media,workspace}.md; examples/contracts.json | Manually updated guidance and recovery steps; inspect examples mechanically validate without egress. Historical first-party manuals and captured descriptions were not rewritten. |
| .mirror/CATALOG, .mirror/RAW, generated, vendor captures/codegen | Existing generation, integrity and drift gates run mechanically; no manual claim over every captured line. Metadata snapshot added only under docs/implementation. |
| package/lockfiles, CI, release assembly | Read to establish runtime/check/release assumptions; no dependency or workflow change. Fresh release assembly verifies copied hashes. |
| Other application/auth/reporting/web modules | Existing regression suite only in this pass. No new browser, production identity or deployment audit claimed. |

## Remaining work, acceptance criteria and rollout

1. **Release this delta on Codex-branch (P1, small).** Run full source and assembled-candidate checks, preserve originals of failed runs, review the diff, push only the requested branch. Run existing Linux/FFmpeg/container CI. No DB migration. Clients need updated native TikTok ad bodies and LinkedIn creative status; prepared reviews using obsolete shapes must be prepared again. Do not roll back an uncertain write into an older unsafe retry path; retain receipts and reconcile before any redeploy.
2. **Qualify real X delivery (P1 external gate, medium).** Requires explicit live mutation authorization, selected account/login, app approval, approved business inputs, spend cap and operator coordination. Execute one image and one video through both synchronous and pending processing, read each stage, and test account-library availability from a separately authorized session. Measure stage latency, error class and verified association count. Verify edit protection on disposable creatives only. Do not use existing live ads to reproduce destruction.
3. **DSC post contract and organization authority (P2, medium/large).** Add a narrowly modeled sponsored-account↔organization relationship, post-author/media-owner binding, native Posts create/read-back, publication acknowledgement, exact returned post ID and stale-grant checks. Do not merely widen /rest/adAccounts. Dependencies: product decisions on who can publish and official role/permission proof. Acceptance: wrong organization/account/owner and revoked access fail before egress; authorized media→post→paused creative works with 201/header receipts and lost-response recovery. Keep the existing-post path compatible; gate the new route independently.
4. **TikTok identities and richer ad families (P2, medium).** Separate authorized identity reuse, custom identity creation, Spark and Smart+ capabilities. Add only documented objective-specific schemas and native media/CTA/music prerequisites. Acceptance: no invented IDs; missing authorization produces an actionable requirement; every creative's serving status is checked. Multi-create support needs per-record response association and partial-failure recovery, not just a larger array limit.
5. **REST.li finder codec (P2, medium).** Add a typed List/record representation for the exact supported finders in compiler/transport, with URI escaping at the right nesting level, correct q/FINDER headers and cursor handling. Preserve existing scalar queries. Test colon/comma/parenthesis/Unicode, empty filters, compound searches, pagination and wrong-account URNs against official examples. Acceptance: no double encoding or JSON arrays on these query fields, and bounded live read-only reconciliation when separately authorized. Exact-ID verification remains the fallback, not an unbounded account scan.
6. **Large-account X editing and workflow UX (P2, medium).** The current complete scan intentionally stops at its bound. Consider persisted, actor-bound usage discovery pages with freshness evidence and a final recheck, only if real account sizes demonstrate need. Preserve fail-closed behavior and explicitly surface incomplete coverage. Add a guided X business-input recipe and campaign-runner creative-override UX only with review of the affected set; the current override is amcp_write-only. Measure missing-input round trips and successful verified runs before adding services or infrastructure.
7. **Live provider/format matrix (P2 external gate, medium).** Google OAuth Cloud-project access, LinkedIn product/scopes/organization relationships, Meta enhancement deprecations, Snapchat PATCH/placements, and TikTok identity/music/tracking remain qualification tasks. Record endpoint, version, grant, sanitized response, and exact read-back; HTTP 403 alone is not a diagnosis. No access application or permission change was submitted.

The smallest demonstrated corrections were preferred over framework, database or queue changes. Working CSV, reporting, OAuth, scheduling and earlier test-account connection support are preserved by existing regression tests; they were not redesigned.

## Official references

Checked 2026-09-14. Source documentation is contract evidence, not evidence of this deployment's access or successful delivery.

- [X creative reference, Ads API v12](https://docs.x.com/x-ads-api/creatives/reference): card JSON, ordered components, response envelopes, Tweet fields and media library.
- [X creative lifecycle](https://docs.x.com/x-ads-api/creatives): references, IDs, nullcast and promotion.
- [X campaign management, Ads API v12](https://docs.x.com/x-ads-api/campaign-management/reference): promotion create/delete, no PUT, batch limit and per-line-item filters.
- [LinkedIn creatives, 2026-06](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-creatives?view=li-lms-2026-06): intendedStatus, header IDs and criteria finder.
- [LinkedIn campaigns, 2026-07](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns?view=li-lms-2026-07): search records and cursor pagination.
- [LinkedIn Videos API, 2026-05](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-05), [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-01), [account access controls](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/account-access-controls?view=li-lms-2026-01): organization ownership, DSC and roles. Runtime remains 202605; newer documentation was used to check claims, not silently change headers.
- [TikTok official SDK AdCreateBody](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/AdCreateBody.md), [AdcreateCreatives](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/AdcreateCreatives.md): nested creatives and per-creative status. SDK main is mutable; record a pinned upstream version when adding automated schema drift for this family.
- [TikTok Smart+](https://business-api.tiktok.com/gateway/docs/index?doc_id=1855007163018689): separate nested creative configuration.
- [Google developer-token sunset](https://developers.google.com/google-ads/api/docs/api-policy/developer-token), [deprecations](https://developers.google.com/google-ads/api/docs/deprecations): access model after 2026-09-09.
- [Snapchat creative API](https://developers.snap.com/marketing-api/Ads-API/creatives): current PATCH contract.

Exact current commands, failures, final results and candidate hashes are recorded in [X-CREATIVE-VERIFICATION.md](X-CREATIVE-VERIFICATION.md). Live qualification remains unverified.
