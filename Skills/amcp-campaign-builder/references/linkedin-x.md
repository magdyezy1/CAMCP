# LinkedIn and X

LinkedIn's hierarchy is account → **campaign group** → **campaign** → creative. Historical cross-platform “campaign” means LinkedIn campaign group, and “ad set” means LinkedIn campaign. Native `linkedin_native_action` preserves LinkedIn names and URNs.

Confirm the Page/organization, post author, media owner and ad-account association. A member-owned media URN cannot be silently substituted for an organization-owned creative. AMCP's media workflow requires a scoped owner and returns the provider's native URN. Poll video status and follow upload finalization before creative attachment. A dark post followed by sponsorship is a separate content/publication operation from the ad itself.

LinkedIn creatives use intendedStatus: PAUSED or DRAFT at creation; campaigns and campaign groups use status. A top-level creative status is refused. Activation through patch.$set.intendedStatus still requires spending confirmation and an owner policy that permits activation. Read the created creative by the x-restli-id response header; an empty 201 body is normal. This exact-ID verification does not need a collection finder.

POST /rest/posts now has a narrow reviewed DSC contract. Use `linkedin_rest_posts_post`, the selected account/connection, an exactly bound organization author, one AVAILABLE image/video owned by that author, and recorded `w_organization_social` plus `r_organization_social` for mandatory read-back. The media must have a provider-verified AMCP receipt in that connection/account or an exact administrator media binding. `LINKEDIN_ORGANIZATION_BINDING_REQUIRED` and `LINKEDIN_MEDIA_BINDING_REQUIRED` require those exact grants, not a broader path prefix. `LINKEDIN_MEDIA_NOT_READY` requires correcting the selected owner/asset or waiting for processing. AMCP currently qualifies matching owner/author only; it does not claim other provider combinations are impossible. Page role, app product access and live acceptance still require verification; a 403 alone does not identify a missing scope.

The normal LinkedIn connection defaults remain advertising-only. After the app has the required provider products/permissions, an administrator can configure `AMCP_LINKEDIN_SCOPES=r_ads r_ads_reporting rw_ads w_organization_social r_organization_social` and reconnect the selected identity through Connections. An environment override replaces the scope list; changing it does not upgrade an existing token. Exact organization/media AMCP bindings are a separate administrator action. Do not request or alter live grants merely to make a code test pass.

DSC is **PUBLISHED content with no feed distribution**, not a paused post. Send `visibility: PUBLIC`, `lifecycleState: PUBLISHED`, `distribution: {feedDistribution: NONE, targetEntities: [], thirdPartyDistributionChannels: []}`, `isReshareDisabledByAuthor: true`, and `adContext: {dscAdAccount: urn:li:sponsoredAccount:<selected account>, dscStatus: ACTIVE}`. Use `content.media: {id: <ready media URN>, title: <approved title>}` and approved commentary. Optional `contentLandingPage` is an HTTPS URL; `contentCallToActionLabel` must be supported. Do not send read-only `isDsc`/`dscAdType`. Inspect, prepare and execute the exact review, then call `amcp_campaign verify` before creating a PAUSED creative referencing the returned post URN. The returned header permits only an internal verification read; it does not grant resource ownership by itself. An inconclusive read never permits a second post create.

LinkedIn finder filters use REST.li syntax and restli_method: FINDER: creatives use q: criteria, while campaigns use q: search. Prefer native arrays/objects, e.g. `campaigns: ["urn:li:sponsoredCampaign:123"]` and `search: {status: {values: ["ACTIVE"]}}`. AMCP serializes structural List/record punctuation and encodes scalar leaves exactly once. Existing well-formed string expressions are accepted; literal commas/parentheses inside string leaves must be percent-encoded. `INVALID_RESTLI_QUERY` means a malformed/ambiguous expression: use typed arrays/objects. Never fall back to an unbounded unfiltered crawl. Exact-ID verification preserves the frozen `LinkedIn-Version`; the environment override applies when a new request is compiled, not halfway through a review.

Use native `targetingCriteria`; do not force an irreversible migration of an existing legacy targeting object during an unrelated edit. For conversion optimization, discover the relevant conversion and verify its campaign association. The API's version header is a supported `YYYYMM` value, not a prose version nickname. Dated limits in the supplied manual are not permanent validation constants.

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
