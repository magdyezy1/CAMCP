# Google all-or-nothing builds — 2026-09-29

The owner's item 5 asked for "one review for a whole build, all or nothing". Batch 29 gave a plan one approval
(`approve`, `run`) but not atomicity: a failed step left the earlier ones in place. Decision 1 of 2026-09-29 ("do what
you think is the best way forward") accepted the recommendation to add Google's multi-resource mutate as its own
reviewed family.

## Contract

`POST /v25/customers/{id}/googleAds:mutate` (GoogleAdsService.Mutate, pinned in `.mirror/VENDOR/google-ads-v25.json`).
The pinned description: with `partialFailure` false, "all operations will be carried out in one transaction if and
only if they are all valid"; a resource created with a temporary name (a negative number where the server allocates
the ID) can be reused by later operations of the same request; each temporary number must be unique; a temporary name
must be created before it is used. The response lists one `MutateOperationResponse` per operation, in order, each with
the result field of its type (`campaignBudgetResult`, `campaignResult`, …).

## What AMCP accepts (`src/google-atomic-builds.ts`, family `google_atomic_builds`)

- `mutate_operations`: 1–1,000 creates of `campaign_budget_operation`, `campaign_operation`,
  `campaign_criterion_operation`, `ad_group_operation`, `ad_group_criterion_operation` and `ad_group_ad_operation`.
  Updates, removals and other types are reviewed on their own; `partial_failure` must be false or omitted;
  `validate_only` and `response_content_type` are refused.
- Temporary names only on budgets, campaigns and ad groups, only in `resource_name`, and only in the parent fields
  (`campaign_budget`, `campaign`, `ad_group`) of later operations. Every other resource name stays in the customer.
- Each operation is checked as the one-operation request of its own service (`assertWriteShape`: a new campaign
  starts PAUSED; the targeting family's criterion rules), with temporary names standing in as positive IDs for those
  checks only. Refusals name `mutate_operations[i]`.

## Review, execution and read-back

- Prepare reads the customer (currency, time zone) and every existing parent a build names; execute reads them again.
- The paused-parent rules of each service apply to the build's own records: an ad group may start ENABLED under the
  build's PAUSED campaign, a keyword or ad under its ad group or campaign; under an existing serving campaign they
  start PAUSED (`PARENT_SERVING`).
- Execution always needs `spend_change_confirmed`. An owner policy with `allow_activation: false` refuses a build that
  starts anything ENABLED; the budgets it creates count against the owner's budget caps (`policyAmounts`).
- The outcome requires one result per operation, of its type, in this customer. A refused or lost response is never
  resubmitted.
- Verification reads every created resource by the name Google returned and compares the fields sent, temporary
  names replaced by the real ones (`amcp_campaign verify` or the plan's read-back).

## Plans

`amcp_campaign clone` of a Google Search campaign composes its steps into one `build` step by default
(`composeGoogleBuild`, in `src/google-atomic-builds.ts` since CMP-04): `changes` apply to the named steps first, each
referenced step's resource gets a temporary name, and each `$ref` becomes that name. `atomic: false` keeps the separate
steps. Since CMP-04 the Google Search recipes compile the same way (`business.atomic: false` keeps one step per
resource type), and a build Google refuses outright is recorded as `rejected` rather than uncertain.

## Evidence

`tests/google-atomic-builds.test.ts` (red with the family unregistered, 5 of 5; green after): a nine-resource Search
build as one review, one request and nine verified read-backs, no spend acknowledgement refused, a replay sending
nothing; a build Google refuses leaving nothing and never resent; an ad group under an existing serving campaign
refused after reading it, accepted PAUSED, and a new ENABLED campaign refused naming its operation; ten malformed
builds refused before any request; an activation-forbidding policy and a budget cap below the new budget both
refusing. `tests/campaign-clone.test.ts`: a Google clone composed into one build with a change and a drop applied
first, then approved once and run as one request with all eleven resources verified.

Not verified against a live account.
