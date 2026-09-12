# LinkedIn and X

LinkedIn's hierarchy is account → **campaign group** → **campaign** → creative. Historical cross-platform “campaign” means LinkedIn campaign group, and “ad set” means LinkedIn campaign. Native `linkedin_native_action` preserves LinkedIn names and URNs.

Confirm the Page/organization, post author, media owner and ad-account association. A member-owned media URN cannot be silently substituted for an organization-owned creative. AMCP's media workflow requires a scoped owner and returns the provider's native URN. Poll video status and follow upload finalization before creative attachment. A dark post followed by sponsorship is a separate content/publication operation from the ad itself.

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
