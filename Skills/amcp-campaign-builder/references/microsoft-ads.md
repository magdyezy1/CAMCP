# Microsoft Advertising / Bing Ads

Use the independent `microsoft_ads_native_action` gateway. Discover its 24 actions with LIST_ACTIONS / DESCRIBE_ACTION. This is Microsoft's v13 JSON API, not Google Ads GAQL or the Bing Webmaster API.

Setup needs a Microsoft app client ID/secret, a Microsoft Advertising developer token and consent for `https://ads.microsoft.com/msads.manage offline_access`. Register `https://amcp.shop/api/auth/microsoft/callback`. The website discovers advertiser accounts and their parent customer IDs. Select accounts before use; token access alone is not an AMCP account grant. Refresh tokens rotate and are stored encrypted.

Hierarchy: account → campaign → ad group → ad / keyword. Send `account_id` as a string and native PascalCase body fields in `payload`. AMCP injects the matching CustomerAccountId, verified CustomerId and developer-token headers. Never supply credentials or alternative scope headers in payload.

Read example: `{"action":"GetCampaignsByAccountId","account_id":"123","payload":{"CampaignType":"Search"}}`. GetCampaignsByIds accepts `CampaignIds`; GetAdGroupsByCampaignId accepts `CampaignId`; GetAdsByAdGroupId needs `AdGroupId` and native `AdTypes`.

Reviewed Add/Update/Delete supports Search campaigns, their ad groups, responsive search ads and keywords. Parent campaign reads explicitly filter Search; other campaign types need a qualified contract. All new entities require `Status: Paused`. Campaign creation needs Name plus DailyBudget/BudgetType or an existing BudgetId. Ad/keyword write reviews also take top-level `campaign_id`, so AMCP can read the exact parent ad group without an unscoped search. Use returned campaign/ad-group IDs immediately in the next review; no intervening list is necessary.

Money is **decimal account currency**, e.g. DailyBudget 50 means 50 currency units, not 50 micros. Keep bidding schemes and campaign types native; old standalone Target CPA/ROAS schemes are deprecated. Do not claim unqualified PMax, Shopping, audience, media, bulk or billing workflows from a Search test. Microsoft batch APIs can partially fail: inspect indexed PartialErrors and retained outcomes; never retry the whole batch under a new key.

Reporting: SubmitGenerateReport accepts a native derived ReportRequest with Type, Columns, Aggregation, explicit Time and Scope exactly `{"AccountIds":["123"]}`. PollGenerateReport uses the returned ReportRequestId on the same connection/account. Pending is not complete. Success returns a provider download URL; AMCP does not parse the ZIP into a normalized cross-platform report. Report submission is read-oriented job creation, not an advertising mutation.

Contract sources and setup limits: [Microsoft Advertising setup](https://learn.microsoft.com/en-us/advertising/guides/get-started?view=bingads-13), [native campaign operations](https://learn.microsoft.com/en-us/advertising/campaign-management-service/addcampaigns?view=bingads-13), [asynchronous reporting](https://learn.microsoft.com/en-us/advertising/reporting-service/submitgeneratereport?view=bingads-13).
