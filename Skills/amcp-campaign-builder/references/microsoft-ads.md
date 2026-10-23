# Microsoft Advertising / Bing Ads

## Existing extension associations

Discover exact selected-account extension IDs and native types with
`GetAdExtensionsByIds`, and current memberships with `GetAdExtensionsAssociations`.
Use `amcp_write` inspect → prepare → execute for `SetAdExtensionsAssociations` or
`DeleteAdExtensionsAssociations`. Native payload fields are `AccountId`,
`AssociationType` (`Account`, `Campaign`, or `AdGroup`), and
`AdExtensionIdToEntityIdAssociations: [{AdExtensionId, EntityId}]`.
Keep IDs as strings. One review permits up to 100 unique pairs for one entity type.

Supply `ad_extension_types` outside `payload`, using native type names from
discovery (for example `SitelinkAdExtension`, `CalloutAdExtension`,
`StructuredSnippetAdExtension`). This is AMCP review metadata used to read content;
it is not a Microsoft mutation field. For ad groups also supply `campaign_id`.
Parent campaign reads currently qualify Search campaigns. Account associations
must use the selected account as `EntityId`. Call extensions are campaign-only;
location extensions cannot attach to ad groups. Other vendor eligibility and
editorial rules remain provider checks.

Preparation checks the account, exact parent, existing extension content and exact
membership. Linking may start serving under an enabled parent and respects the
owner's activation restriction; it has no paused-link substitute. Execution also
requires `spend_change_confirmed: true` for association changes. Deletion removes
the association, not the extension from the asset library. Verify the original
review with `amcp_campaign action=verify`; membership is not editorial approval or
proof of impressions. On partial errors or a lost response, reconcile that review
and read each pair; never repeat a mutation under a new key just to clear uncertainty.

## Gateway, setup and operation evidence

`amcp_tool_help` and reviewed inspect/prepare include first-party operation evidence: the REST method, URL and request fields Microsoft Learn documents for each of the 28 operations (pinned, and checked when a request is compiled), and the six pinned WSDL services as the type model. AMCP sends REST requests only; Microsoft deprecates SOAP on 2027-01-31. This is not unrestricted field support. AMCP's separately tested JSON contracts still expose 28 actions; Bulk, Billing, media and additional WSDL operations are not enabled by ingestion. Development regeneration requires Python 3.10+ with only its standard library.

Use the independent `microsoft_ads_native_action` gateway. Discover its 28 actions with LIST_ACTIONS / DESCRIBE_ACTION. This is Microsoft's v13 JSON API, not Google Ads GAQL or the Bing Webmaster API.

Setup needs a Microsoft app client ID/secret, a Microsoft Advertising developer token and consent for `https://ads.microsoft.com/msads.manage offline_access`. Register `https://amcp.shop/api/auth/microsoft/callback`. The website discovers advertiser accounts and their parent customer IDs. Select accounts before use; token access alone is not an AMCP account grant. Refresh tokens rotate and are stored encrypted.

Hierarchy: account → campaign → ad group → ad / keyword. Send `account_id` as a string and native PascalCase body fields in `payload`. AMCP injects the matching CustomerAccountId, verified CustomerId and developer-token headers. Never supply credentials or alternative scope headers in payload.

Read example: `{"action":"GetCampaignsByAccountId","account_id":"123","payload":{"CampaignType":"Search"}}`. GetCampaignsByIds accepts `CampaignIds`; GetAdGroupsByCampaignId accepts `CampaignId`; GetAdsByAdGroupId needs `AdGroupId` and native `AdTypes`.

## Search campaigns

Reviewed Add/Update/Delete supports Search campaigns, their ad groups, responsive search ads and keywords. Parent campaign reads explicitly filter Search; other campaign types need a qualified contract. All new entities require `Status: Paused`. Campaign creation needs Name plus DailyBudget/BudgetType or an existing BudgetId. Ad/keyword write reviews also take top-level `campaign_id`, so AMCP can read the exact parent ad group without an unscoped search. Use returned campaign/ad-group IDs immediately in the next review; no intervening list is necessary.

Money is **decimal account currency**, e.g. DailyBudget 50 means 50 currency units, not 50 micros. Keep bidding schemes and campaign types native; old standalone Target CPA/ROAS schemes are deprecated. Do not claim unqualified PMax, Shopping, audience, media, bulk or billing workflows from a Search test. Microsoft batch APIs can partially fail: inspect indexed PartialErrors and retained outcomes; never retry the whole batch under a new key.

## Activation and locations (owner decision P7)

Without location targets Microsoft can serve a campaign anywhere it supports, so `UpdateCampaigns` with `Status: Active` reads the campaign's location criteria (`GetCampaignCriterionsByIds`, `CriterionType: Location`, `CampaignCriterionIds: null`) and is refused with `LOCATION_CRITERIA_REQUIRED` unless one is a positive `LocationCriterion` (radius alone does not count). Add locations to a paused campaign with `AddCampaignCriterions` (`CriterionType: Targets`; rows exactly `{"Type":"BiddableCampaignCriterion","CampaignId","Criterion":{"Type":"LocationCriterion","LocationId"}}`, no bid, Status or Id; an unpaused campaign is `LOCATION_PARENT_NOT_PAUSED`); `DeleteCampaignCriterions` removes one. Location IDs come from Microsoft's geographical locations file; use locations it lists as Active (a deprecated location criterion still reads back but no longer targets) and confirm the names the `microsoft_location_criteria` activation gate lists. `amcp_campaign recipe_lookup` with `lookup_kind: "microsoft_location"` finds IDs by name or checks entered IDs in that file (read-only; `selectable: true` only for Active locations). It needs the pinned `GetGeoLocationsFileUrl` Learn page, which this release holds; without it the lookup is refused with `MICROSOFT_LOCATIONS_UNPINNED` and nothing is sent. Microsoft's default location intent (people in, searching for or viewing pages about the locations) applies. The Search recipe adds its `location_ids` in a `targets` step after the campaign; an older draft without one is refused with `RECIPE_INPUT_REQUIRED`.

## Reporting

SubmitGenerateReport accepts a native derived ReportRequest with Type, Columns, Aggregation, explicit Time and Scope exactly `{"AccountIds":["123"]}`. PollGenerateReport uses the returned ReportRequestId on the same connection/account. Pending is not complete. Add `download_report: true`, `offset: 0`, and `limit: 100` to PollGenerateReport to have AMCP download and parse a CSV/TSV ZIP. Follow next_call until has_more is false. IDs and amounts remain native strings. The original report/parsed rows are bound to the same account and connection for one day. These native query results remain native; the separate `amcp_reporting_overview` Microsoft adapter normalizes supported campaign metrics with provenance and quality metadata. Report submission is read-oriented job creation, not an advertising mutation.

## Sources

Contract sources and setup limits: [Microsoft Advertising setup](https://learn.microsoft.com/en-us/advertising/guides/get-started?view=bingads-13), [native campaign operations](https://learn.microsoft.com/en-us/advertising/campaign-management-service/addcampaigns?view=bingads-13), [asynchronous reporting](https://learn.microsoft.com/en-us/advertising/reporting-service/submitgeneratereport?view=bingads-13).
