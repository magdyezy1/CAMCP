# LinkedIn and X

## X audience planning estimates

Use `x_ads_native_action` action `ESTIMATE_AUDIENCE_SIZE` (canonical
`x_accounts_account_id_audience_estimate_post`) with the exact `account_id`,
selected `connection_id`, and `payload.targeting_criteria`. This is a JSON POST
read, available to readers and deployments where advertising writes are disabled.
Set `dry_run: true` to inspect locally; `dry_run: false` retrieves the estimate.
It does not create targeting, campaigns, reviews or spending reservations.

Supply the user's intended native criteria. X requires a primary criterion:
followers, custom audiences, interests, keywords or TV. A location alone does
not satisfy this endpoint. Discover native values or ask for the missing business
choice; never add an invented keyword merely to obtain a number. Criteria accept
`targeting_type`, string `targeting_value` and optional `operator_type` (`EQ`/`NE`).
Do not include `line_item_id`, method overrides or `paginate`. AMCP bounds each
request to 200 criteria, 128 KiB and 25 distinct custom-audience/campaign references.
APP_LIST/TAP exclusions and comparison operators remain unqualified for estimates.

AMCP checks custom-audience targetability and campaign identity through the
selected account. Followers/own-content engagement must identify a currently
FULL promotable user; public lookalike-follower IDs remain distinct. These reads
use the same selected login and stop if authorization changes. Shared audiences
accessible in this account are not relabeled as owned. Never relay private user
lists or download data to perform the estimate.

Present `audience_size.min`–`max` as an estimated potential audience range. Preserve
zero; missing, malformed or incomplete responses are errors. Do not sum overlapping
estimates, substitute a midpoint as fact, or turn the range into promised reach,
impressions, conversions, spend or policy approval. Authorization/targetability
errors need their stated repair; transient read retries are bounded automatically.
See [X v12 reference](https://docs.x.com/x-ads-api/campaign-management/reference#post-accounts-account-id-audience-estimate), checked 2026-09-25.

LinkedIn's `organizationalEntityCreateShareAuthorizations` GET can check a
specific company/member/account tuple before a video dark post. Discover the
action and native composite-key parameter; retain the selected sponsored-account
URN. It requires recorded `rw_ads` and an administrator binding for that exact
decoded path. A successful HTTP read may contain `com.linkedin.sharingauth.Denied`:
this is a negative permission result, not permission to publish. Do not equate
read access, AMCP grants, Page identity or another member's authorization.

LinkedIn's hierarchy is account → **campaign group** → **campaign** → creative. Historical cross-platform “campaign” means LinkedIn campaign group, and “ad set” means LinkedIn campaign. Native `linkedin_native_action` preserves LinkedIn names and URNs.

Confirm the Page/organization, post author, media owner and ad-account association. A member-owned media URN cannot be silently substituted for an organization-owned creative. AMCP's media workflow requires a scoped owner and returns the provider's native URN. Poll video status and follow upload finalization before creative attachment. A dark post followed by sponsorship is a separate content/publication operation from the ad itself.

LinkedIn creatives use intendedStatus: PAUSED or DRAFT at creation; campaigns and campaign groups use status. A top-level creative status is refused. Activation through patch.$set.intendedStatus still requires spending confirmation and an owner policy that permits activation. Read the created creative by the x-restli-id response header; an empty 201 body is normal. This exact-ID verification does not need a collection finder.

POST /rest/posts now has a narrow reviewed DSC contract. Use `linkedin_rest_posts_post`, the selected account/connection, an exactly bound organization author, one AVAILABLE image/video owned by that author, and recorded `w_organization_social` plus `r_organization_social` for mandatory read-back. The media must have a provider-verified AMCP receipt in that connection/account or an exact administrator media binding. `LINKEDIN_ORGANIZATION_BINDING_REQUIRED` and `LINKEDIN_MEDIA_BINDING_REQUIRED` require those exact grants, not a broader path prefix. `LINKEDIN_MEDIA_NOT_READY` requires correcting the selected owner/asset or waiting for processing. AMCP currently qualifies matching owner/author only; it does not claim other provider combinations are impossible. Page role, app product access and live acceptance still require verification; a 403 alone does not identify a missing scope.

The normal LinkedIn connection defaults remain advertising-only. After the app has the required provider products/permissions, an administrator can configure `AMCP_LINKEDIN_SCOPES=r_ads r_ads_reporting rw_ads w_organization_social r_organization_social` and reconnect the selected identity through Connections. An environment override replaces the scope list; changing it does not upgrade an existing token. Exact organization/media AMCP bindings are a separate administrator action. Do not request or alter live grants merely to make a code test pass.

DSC is **PUBLISHED content with no feed distribution**, not a paused post. Send `visibility: PUBLIC`, `lifecycleState: PUBLISHED`, `distribution: {feedDistribution: NONE, targetEntities: [], thirdPartyDistributionChannels: []}`, `isReshareDisabledByAuthor: true`, and `adContext: {dscAdAccount: urn:li:sponsoredAccount:<selected account>, dscStatus: ACTIVE}`. Use `content.media: {id: <ready media URN>, title: <approved title>}` and approved commentary. Optional `contentLandingPage` is an HTTPS URL; `contentCallToActionLabel` must be supported. Do not send read-only `isDsc`/`dscAdType`. Inspect, prepare and execute the exact review, then call `amcp_campaign verify` before creating a PAUSED creative referencing the returned post URN. The returned header permits only an internal verification read; it does not grant resource ownership by itself. An inconclusive read never permits a second post create.

LinkedIn finder filters use REST.li syntax and restli_method: FINDER: creatives use q: criteria, while campaigns use q: search. Prefer native arrays/objects, e.g. `campaigns: ["urn:li:sponsoredCampaign:123"]` and `search: {status: {values: ["ACTIVE"]}}`. AMCP serializes structural List/record punctuation and encodes scalar leaves exactly once. Existing well-formed string expressions are accepted; literal commas/parentheses inside string leaves must be percent-encoded. `INVALID_RESTLI_QUERY` means a malformed/ambiguous expression: use typed arrays/objects. Never fall back to an unbounded unfiltered crawl. Exact-ID verification preserves the frozen `LinkedIn-Version`; the environment override applies when a new request is compiled, not halfway through a review.

Use native `targetingCriteria`; do not force an irreversible migration of an existing legacy targeting object during an unrelated edit. For conversion optimization, discover the relevant conversion and verify its campaign association. The API's version header is a supported `YYYYMM` value, not a prose version nickname. Dated limits in the supplied manual are not permanent validation constants.

## Reviewed LinkedIn campaign conversion associations

Conversion reads return two different collections: `campaigns` contains campaign
URNs, while `associatedCampaigns` contains association records with campaign and
conversion URNs. Do not treat the records as strings. AMCP compares membership
semantically and excludes association/callback timestamps, while retaining unknown
configuration. A rule's callback time is tracking telemetry, not an edit.

`CONVERSION_STATE_UNVERIFIED` means the provider returned malformed, duplicate,
foreign or inconsistent campaign membership or a malformed URL-expression shape.
Stop the write and inspect current account-scoped conversion data. Do not replace
missing membership with an empty list. Correct the data/contract and prepare a
fresh review; retain any already submitted claim. `CONVERSION_RULE_STATE_UNVERIFIED`
also covers failed/incomplete reads, missing Insight Tags and review bounds.

Use `linkedin_rest_campaign_conversions_campaign_conversion_id_put` to associate
an existing conversion with a selected campaign. Pass `path_params.campaign_conversion_id`
as `(campaign:urn:li:sponsoredCampaign:<id>,conversion:urn:lla:llaPartnerConversion:<id>)`
and the same two URNs as `payload.campaign` and `payload.conversion`. AMCP encodes
each scalar once. The longer `campaign_campaign_urn_conversion_conversion_urn_put`
alias is also qualified. Remove an association with the matching `_delete` action
and no payload. These actions do not create a conversion rule or install tracking.

For multiple pairs use `linkedin_rest_campaign_conversions_put` or `_delete` with
`query.ids` as a native array of `{campaign, conversion}` objects. PUT requires
`payload.entities`, keyed by each unescaped tuple with the matching pair as its
value, and `restli_method: BATCH_UPDATE` when explicitly supplied. DELETE uses no
payload and `BATCH_DELETE`. Limits are 25 distinct pairs and 1000 complete current
associations. Larger scopes need separate reviews; never truncate discovery.

Keep the exact selected connection/account. Preparation verifies both resources
under that account and reads every association page. Writes require `rw_ads`;
read-back requires `r_ads` or `rw_ads`. The provider's account role and app approval
remain separate checks. Confirm the rule, attribution and campaign objective with
the user when ambiguous. Never infer a purchase rule from its name alone. Review
the effect on conversion optimization, then execute with `confirmed: true` and
`spend_change_confirmed: true`; owner activation/deletion controls still apply.

Call `amcp_campaign verify` using the original review. Removal is proven by a
complete membership read, never a 404. Incomplete state, per-key errors and lost
responses require reconciliation; keep the original claim and do not repeat the
batch. The contract does not certify an installed Insight Tag, event receipt,
attribution accuracy, auction delivery or current provider approval.

## Reviewed LinkedIn conversion rules

Use `linkedin_rest_conversions_post` with `restli_method: CREATE`, the selected
`account_id`, `query.account: urn:li:sponsoredAccount:<id>` and native payload.
Creation requires a user-supplied `name` and conversion `type`, and an existing
Insight Tag on the selected account. `enabled: false` stages a disabled rule;
omission uses the provider's enabled default and must be reviewed accordingly.
Supply the exact account in the query or each created body. `BATCH_CREATE` uses
`payload.elements` (1–25 rules per AMCP review; provider maximum is 100).

Update through `linkedin_rest_conversions_conversion_id_post`, exact
`path_params.conversion_id`, `query.account`, `restli_method: PARTIAL_UPDATE` and
`payload: {patch: {$set: {name: "Approved name"}}}`. Batch updates use the collection
action with `BATCH_PARTIAL_UPDATE`, `query.ids: ["id1", "id2"]` and an exact
`payload.entities` map of IDs to `{patch: {$set: ...}}`. Use 1–25 distinct IDs;
every ID must belong to the selected account. No account transfers, method
tunneling, arbitrary nested patches or caller-supplied state are permitted.

Qualified fields are name, type, enabled, attributionType, both attribution
windows, value, valueType and urlMatchRuleExpression. Windows are 1, 7 or 30 days;
the model is LAST_TOUCH_BY_CAMPAIGN or LAST_TOUCH_BY_CONVERSION. Decide these from
the measurement brief, not a conversion's name. Type is ADD_TO_CART, DOWNLOAD,
INSTALL, KEY_PAGE_VIEW, LEAD, PURCHASE, SIGN_UP or OTHER. `value.amount` is a decimal
string in account currency, and represents conversion value, not advertising
spend. FIXED requires a value; DYNAMIC and NO_VALUE follow the native contract.

URL expressions are an OR array of AND arrays of `{matchType, matchValue}` terms.
Use EXACT, STARTS_WITH or CONTAINS with literal match text, not regular expressions.
Updates replace the entire expression; include every intended term. AMCP supports
25 OR groups/100 terms and preserves semantic grouping. It compares equivalent
OR/AND ordering and decimal representations without ignoring real rule edits.
Omitting the expression at creation selects event-specific tracking. A rule alone
does not install a website tag, inject markup or prove event collection.

All current conversion records are read for creation. Updates read each selected
rule and every associated campaign, including budgets and delivery status. Current
scope/grants are checked before every provider call. Enabling new rules or changing
existing rules requires spending-impact confirmation and an owner policy that
permits activation; a disabled unassociated create can obey an activation ban.
Verification reads the exact created IDs and expected settings; receipt IDs alone
grant no resource ownership. A new rule can enter a subsequent association review
through fresh account-scoped discovery. Partial batches and lost receipts retain
their original idempotency claim across retries/restarts. Never repeat an uncertain
creation or silently recreate a rule whose read-back disagrees.

Bounds: 1000 rules in a complete collection, 25 pages, 50 affected campaigns,
80 reads, 4 MiB per response, 8 MiB total and 60 seconds. Automatic association
(`autoAssociationType`), direct campaign-array edits, conversion event ingestion,
Insight Tag creation/sharing and tag installation remain separate unqualified
payloads/workflows. Associate chosen campaigns through the reviewed link contract.
Unsubmitted reviews from before the corrected state projection may need a fresh
prepare; never clear a submitted claim as part of this upgrade.

Sources: [LinkedIn conversion tracking, version 202605](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversion-tracking?view=li-lms-2026-05)
and [REST.li protocol](https://linkedin.github.io/rest.li/spec/protocol), checked
2026-09-19. Local tests qualify the exact contract. Provider role/product access,
native acceptance, installed tracking and attribution outcomes need live evidence.

X's hierarchy is account → campaign (budget/funding) → line item (objective, bidding, placements) → promoted Tweet/media creative. Use `x_ads_native_action`. Monetary fields ending `_local_micro` use account currency × 1,000,000. Read an existing funding instrument rather than inventing one or assuming a CREATE_FUNDING_INSTRUMENT catalog entry provisions credit.

## X targeting is a separate resource, not a line-item field

X has **no** `targeting` field on a line item or any other entity. Targeting lives in its own
`targeting_criteria` resource, and each criterion is a separate record referencing its line item:

- Create one criterion per reviewed write: `POST /12/accounts/{account_id}/targeting_criteria`.
  Remove one with `DELETE /12/accounts/{account_id}/targeting_criteria/{id}`. There is no
  qualified batch route — a batch payload is refused, so a campaign needing thirty criteria is
  thirty reviewed writes.
- **The parent line item must be PAUSED** before targeting is written, or the write fails with
  `TARGETING_PARENT_NOT_PAUSED`. Pause the line item, apply every criterion, read the applied
  set back, then resume. Do not rely on partial application being atomic.
- Putting a `targeting` key in an X entity payload is refused with `UNSUPPORTED_FIELD`. Do not
  invent one, and do not translate another platform's targeting object into an X entity body.
  The error names the separate resource to use.
- X has no campaign copy or duplicate endpoint. Duplicating a campaign means composing the
  chain yourself — campaign, line item, promoted Tweet, then each targeting criterion — and
  verifying each step by reading it back.

Discover placements for the objective/product pair and inspect existing line-item objectives before adding another. Creating underlying Tweet content and promoting it are separate operations with separate visibility consequences. Media upload success alone does not imply the Tweet/card/creative is ready or that its write route is qualified by AMCP. Follow native media-processing and account-library continuations.

## Reviewed X image/video website ads (contract revision 2026-09-14)

Use one explicit connection_id and account throughout. Inspect each route locally, then prepare and execute its returned review with the same idempotency key. Preparation checks real account/resource access; metadata or an inspect result alone cannot prove readiness.

1. Import the Drive file with amcp_media prepare; execute the reviewed upload, then check status. If processing finishes without library registration, follow prepare_library and execute that separate review. Registration sends media_key, name and file_name; **no media_category**. The upload protocol still needs its own media category. Keep the complete media_key including its prefix; wait for account-library TRANSCODE_COMPLETED.
2. Prepare x_accounts_account_id_cards_post with the payload below. Preserve component order. Use a headline of at most 70 characters and a name of at most 80. Omit card_type; the format is derived. This contract qualifies single image/video website cards; carousel, app, poll and conversation formats need separate qualification. X cards use JSON, unlike other form-encoded X writes.
3. Discover x_accounts_account_id_promotable_users_get; ask only if the business identity is ambiguous. Prepare x_accounts_account_id_tweet_post with as_user_id, text, card_uri, nullcast: true and optional name. Select a FULL promotable user; retweets-only permission is insufficient. Use the card response's URI and the Tweet response's **string id_str**, never a rounded numeric ID. Tweet text is conservatively limited to 280 code points by this contract; provider-specific weighting still applies.
4. Prepare x_accounts_account_id_promoted_tweets_post with line_item_id and tweet_ids. The latter is a comma-separated string, limited to **four per AMCP review**; X documentation permits a larger batch. Promotion creates an ACTIVE association and can serve immediately under an active parent. It has no qualified pause/update route. Do not send entity_status: PAUSED or promise it prevents delivery. Keeping the nullcast Tweet unpromoted stages the ad. Execution needs confirmed: true and spend_change_confirmed: true; owner activation policies apply even when the payload contains no status.
5. Use amcp_campaign verify with the original review_id. Verification reads promoted_tweets with exactly one line_item_ids value, checks every promotion/Tweet/parent tuple, and performs up to three read-only visibility attempts. A pending result (X_PROMOTION_NOT_VISIBLE) is not a failed mutation or permission to submit again. Follow its read-only continuation. Serving approval, delivery and conversion measurement need separate checks.

Example card payload, with symbolic values that must be replaced by actual reviewed business inputs and returned media identity:

    {"name":"User-approved card name","components":[
      {"type":"MEDIA","media_key":"13_<returned media ID>"},
      {"type":"DETAILS","title":"User-approved headline",
       "destination":{"type":"WEBSITE","url":"https://user-approved.example/"}}
    ]}

The same new-build chain can be represented as explicit amcp_campaign dependency steps. Bind media#/media_key, card#/data/data/card_uri, and tweet#/data/data/id_str using $ref and declared predecessors. Preflight placeholders check syntax only; execution resolves only verified predecessor results. A pending upload may require a separate library continuation. This is not a business-input X recipe or permission to invent funding, targeting, text, dates or spend.

### Editing a creative already in use

x_accounts_account_id_cards_card_id_put, x_accounts_account_id_cards_card_id_delete and x_accounts_account_id_tweets_tweet_id_name_put check referencing promotions before preparation and again before execution. Name-only edits are included. An in-use edit fails with CREATIVE_IN_USE, affected promotion IDs, line items, Tweet IDs and a recovery plan. The destructive provider behavior is a reported incident, not a guarantee that every account behaves identically.

Default recovery is to create a new card/Tweet and review replacement promotions. If the user explicitly accepts the existing creative edit, prepare through amcp_write with creative_edit_confirmed: true, review the complete affected list, then repeat that flag at execute. CREATIVE_EDIT_CONFIRMATION_REQUIRED means the frozen destructive acknowledgement was not repeated. The flag cannot be added to an already-prepared ordinary review. New usage or changed content triggers a fresh review. An owner policy forbidding deletion also forbids these potentially destructive edits. Use amcp_write directly for this override; campaign execute_next does not expose it.

X_CREATIVE_STATE_UNVERIFIED means dependency/usage coverage could not be proven, and the override does not bypass it. X_CREATIVE_DISCOVERY_LIMIT means the bounded scan exceeded 25 pages per collection, 20,000 rows, 250 requests or the between-request 60-second budget. Follow provider cooldowns; do not hide missing pages. Large accounts may require a scoped discovery design before edits can be allowed safely.

After an allowed edit, read each affected line item. The returned recovery plan prepares fresh promotions only for associations confirmed missing. It never executes them, guarantees original IDs, or assumes provider idempotence. An uncertain write must retain its original review/key across retries and restarts. Do not re-promote everything automatically. The guard cannot prevent an external actor changing X after AMCP's last read; minimize that interval and coordinate concurrent edits.

### X unpublished drafts and requested device previews

The four captured draft routes now use `amcp_write`: create, update, hard delete
and device preview. Select an explicit connection UUID, Ads account and current
FULL promotable author; discover these before asking the user to supply IDs.
Creation saves unpublished content. Explicit `nullcast` records its intended
publication mode; it does not publish or promote the draft. Publishing, scheduling
and promotion remain separate actions. Reusing a draft never implies approval
of its copy or permission to send it.

Use `x_accounts_account_id_draft_tweets_post` with `as_user_id`, `nullcast` and
text or `media_keys`. The latter is a comma-separated native string: up to four
images, one GIF or one video already registered and processed in this account.
A discovered `card_uri` can accompany text. The qualified format does not combine
a card with direct media. Continue the existing server-side Drive import/library
workflow for new media; do not ask the LLM to download or relay bytes.

Use `x_accounts_account_id_draft_tweets_draft_tweet_id_put` for explicit changes.
An empty `card_uri` or `media_keys` clears that attachment; omitted fields stay.
Preserve image order. Author changes and scheduling fields are refused. Delete
through `x_accounts_account_id_draft_tweets_draft_tweet_id_delete` only after
reviewing the saved content; removal is permanent and respects owner deletion
controls. It does not delete previously published copies.

`x_accounts_account_id_draft_tweets_preview_draft_tweet_id_post` sends device
notifications. Only prepare/execute it when the user requests that preview.
Read-back labels provider acceptance separately from notification delivery and
rendering, which cannot be checked. Never automatically resend after an uncertain
response. Do not represent the preview as an ordinary read.

`INVALID_X_DRAFT` means the supplied shape, attachment combination or local input
bound is invalid. Correct it before a new prepare. `X_DRAFT_STATE_UNVERIFIED`
means the author, draft, dependency or complete collection could not be verified;
use scoped discovery or reconnect as indicated by the underlying access error.
`X_DRAFT_DISCOVERY_LIMIT` means the bounded scan exceeded capacity; narrow the
selected author or retry reads after provider cooldowns. No flag bypasses these
checks. Local limits: 1000 drafts per author, 25 pages per collection, 64 reads,
4 MiB per response, 8 MiB total and 60 seconds of monotonic elapsed time.
Draft text has an 8192-code-point local payload bound; X still validates weighted
Tweet length and URLs. That bound is not a publishable text-length allowance.
Names have an 80-character bound. IDs must remain exact strings.

Verification checks saved configuration or complete author-scoped absence after
deletion; a 404 alone is insufficient. Errors and lost responses retain durable
claims. Use the original review/key to inspect the outcome, then read current
state before reviewing a correction. Native eligibility and actual device
rendering remain unverified live. Contract source checked 2026-09-19:
[X v12 creative reference](https://docs.x.com/x-ads-api/creatives/reference) and
[response envelopes](https://docs.x.com/x-ads-api/fundamentals/error-codes-and-responses).

### X asynchronous analytics jobs

Use `amcp_write` with `x_stats_jobs_accounts_account_id_post` to prepare,
review and execute one report job. Select the original connection and account,
discover the entity IDs, and supply native `params`: entity, entity_ids,
metric_groups, placement, granularity, start_time and end_time. Do not invent
objectives, geography IDs or dates. This consumes report quota without changing
advertising configuration. AMCP still requires operator access, an account write
grant and deployment write permission for submission.

Poll `x_stats_jobs_accounts_account_id_get` with `params.job_ids` containing
the returned exact `id_str`. Keep IDs as strings. A successful status read is
not a complete report. On that same GET, `download_report: true` retrieves one
original job's gzip output on the server. Use `offset` and `limit` (1–100) to
page its validated entity/segment rows; do not use field projection, compaction
or generic pagination. The client never needs to download a private result URL.

AMCP checks the current account, original app/user login and reviewed definition
before and after transfer. The six-hour encrypted result cache still requires a
fresh authorized status read. It preserves native time series and explicit nulls.
A missing requested entity leaves `report.complete: false`; do not present it
as zero activity. Follow `report.next_call` until `has_more` is false and inspect
`source_complete` separately. Spend remains account-currency micros.

Local limits are 8 MiB compressed, 32 MiB expanded, 25,000 segment rows, one million
metric cells and 512 KiB per returned page. Narrow a report that exceeds them;
never truncate silently. The shared two-slot download limit can require a later
read. A single oversized row requires a narrower date/metric definition.

Retain the original review/key/job ID across restarts, failures and reconnects.
Unknown submissions are not resent automatically and retain a local quota slot;
known terminal jobs release their slot when observed. AMCP does not infer that an
unseen job completed. A new review requires explicit intent. Failed, cancelled
or expired jobs cannot supply successful output. The captured cancellation action
remains unqualified; do not use raw routes to bypass that boundary. This native
workflow is separate from the dashboard's existing synchronous X report source.

Native reference checked 2026-09-25:
`X_REPORT_LOGIN_CHANGED` requires the original app/user identity; reconnecting a
different login does not transfer job ownership. `X_REPORT_STATE_UNVERIFIED` or
`X_REPORT_DOWNLOAD_INVALID` means the status, identity or downloaded content
could not be verified: inspect that error and retry only the original read when
appropriate. `X_REPORT_DOWNLOAD_BUSY` requires waiting for the existing lease.
`X_REPORT_FAILED`, `X_REPORT_CANCELLED` and `X_REPORT_EXPIRED` require an explicit
decision about a new report; do not silently substitute an empty result.

[X analytics](https://docs.x.com/x-ads-api/analytics). Query parameters, end-exclusive
UTC whole-hour dates, account-midnight DAY boundaries, native metric compatibility
and historical entity reporting follow that contract. The current placements are
ALL_ON_TWITTER, SPOTLIGHT and TREND. Segmented values may not reconcile to totals;
recent values, attribution and billing adjustments remain estimates. These
contracts have synthetic tests; account-specific native acceptance is unverified.
