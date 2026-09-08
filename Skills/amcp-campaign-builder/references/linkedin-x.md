# LinkedIn and X

LinkedIn's hierarchy is account → **campaign group** → **campaign** → creative. Historical cross-platform “campaign” means LinkedIn campaign group, and “ad set” means LinkedIn campaign. Native `linkedin_native_action` preserves LinkedIn names and URNs.

Confirm the Page/organization, post author, media owner and ad-account association. A member-owned media URN cannot be silently substituted for an organization-owned creative. AMCP's media workflow requires a scoped owner and returns the provider's native URN. Poll video status and follow upload finalization before creative attachment. A dark post followed by sponsorship is a separate content/publication operation from the ad itself.

Use native `targetingCriteria`; do not force an irreversible migration of an existing legacy targeting object during an unrelated edit. For conversion optimization, discover the relevant conversion and verify its campaign association. The API's version header is a supported `YYYYMM` value, not a prose version nickname. Dated limits in the supplied manual are not permanent validation constants.

X's hierarchy is account → campaign (budget/funding) → line item (objective, bidding, placements, targeting) → promoted Tweet/media creative. Use `x_ads_native_action`. Monetary fields ending `_local_micro` use account currency × 1,000,000. Read an existing funding instrument rather than inventing one or assuming a CREATE_FUNDING_INSTRUMENT catalog entry provisions credit.

Discover placements for the objective/product pair and inspect existing line-item objectives before adding another. Creating underlying Tweet content and promoting it are separate operations with separate visibility consequences. Media upload success alone does not imply the Tweet/card/creative is ready or that its write route is qualified by AMCP. Follow native media-processing and account-library continuations.
