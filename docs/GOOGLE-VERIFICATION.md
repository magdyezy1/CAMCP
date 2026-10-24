---
status: reference
tier: operator
---

# Google verification: reporting and privacy evidence

This document describes implemented behavior and the evidence still needed for verification. It does not assert that Google approved the app, that production reporting succeeded, or that a new demonstration video or reviewer account exists.

## Analytics least-privilege justification

The GA4 connection requests only `https://www.googleapis.com/auth/analytics.readonly`. Google Ads and other services have separate connection flows. Social sign-in is also separate. Declaring a scope in Cloud Console is not proof that a particular token was granted that scope.

| User-facing feature | Implementation | Why Analytics access is needed |
| --- | --- | --- |
| Connections → Google Analytics 4 → Manage → property selection | `server/asset-discovery.ts`: Admin API `accountSummaries.list` | Show authorized property IDs and names so users can select the correct property. |
| Report currency and timezone | `src/report-native.ts`: Admin API `properties.get` | Interpret the report in the selected property's own reporting context. |
| Reporting overview → Pull campaign report | `src/report-native.ts`: Data API `properties.runReport` | Read sessions, total users, key events and total revenue for session campaign ID/name and the selected dates. |
| Additional native and custom metrics | `src/report-native.ts`, `src/report-metrics.ts`, `src/reporting-overview.ts` | Request supported extra metrics and calculate formulas from report values inside AMCP. |
| Saved reports, CSV, optional Sheets exports and schedules | `src/reporting-overview.ts`, `src/google-sheets.ts`, `web/reporting-overview.js` | Retain and deliver the user-requested report; Sheets authorization is separate from Analytics authorization. |

Analytics `runReport` and `accountSummaries.list` accept `analytics.readonly` or the broader `analytics` permission. AMCP uses the read-only option. Sign-in identity scopes and `adwords` do not grant access to Analytics reports. Property selection provides an additional application boundary; it does not narrow the Google-issued scope itself. The GA4 connection does not grant Analytics configuration write/delete access.

The overview currently requests at most 10 GA4 metrics per request and stops at 10,000 rows, failing explicitly if the result exceeds that bound. Google quotas, data thresholding, property permissions, and compatible metric combinations also apply. Do not describe this as unlimited reporting or promise that broader OAuth scopes increase data volume.

## Privacy disclosures and implementation evidence

`/privacy` serves `web/privacy.html` directly, with no login, cookie, redirect, API call or JavaScript requirement. It retains the existing policy URL and links to the homepage, terms and deletion instructions. `web/app.js` lets privacy links use normal browser navigation. The website and container smoke tests exercise this route.

| Disclosure | Code evidence / operational boundary |
| --- | --- |
| HTTPS for the public service and Google requests | `server/web-store.ts` requires an HTTPS public origin except loopback development; OAuth and Google API endpoints use HTTPS. Edge TLS remains an operator responsibility. |
| Encrypted OAuth credentials | `src/security.ts` uses AES-256-GCM with authenticated connection/workspace context; `src/store.ts` encrypts stored connection credentials. The master key comes from server configuration. |
| Password hashes and session protection | `server/user-accounts.ts` uses salted scrypt; `server/web-store.ts` sets Secure/HttpOnly/SameSite cookies for HTTPS, expires sessions and checks origin/CSRF. |
| Scoped access and secret reduction | Workspace membership, selected resource grants, actor checks, and `src/security.ts` redaction protect access and normal diagnostic output. |
| Report storage | Saved report documents and audit payloads are database records, not individually encrypted by SecretBox. Do not claim all data is encrypted at rest or that disk encryption was verified. |
| Disconnect and retention | The disconnect route deletes connection credentials, local asset inventory/selections and resource ownership. Historical reports/audit records and external exports can remain. No general age-based purge or guaranteed backup deletion deadline is implemented. |

Before changing public policy language, confirm that the operating service continues to follow its disclosures, including service providers, restricted human access, Limited Use, no generalized-model training with Google user data, and no sale or advertising targeting use of that data. The code review does not certify hosting configuration, staff procedures, or backup practices.

## Required demonstration and review account

1. Follow the verification email's instructions to isolate unverified scopes from general production traffic. Preserve the requested publishing status. This change does not create staging infrastructure or switch provider availability.
2. Use an active dedicated AMCP review account and only authorized test/demo property data. Do not share your master administrator password, personal Google login, or production client credentials. Ensure the dedicated account can sign in without phone, payment, or other review blockers; do not disable authentication for the application.
3. Record the app URL, login, Connections → Google Analytics 4 → Connect and the complete Google consent screen. Show the app name/client identity and expand all requested permissions so they are readable.
4. Select an actual GA4 property, save the selection, open Reporting overview and choose a date range containing real data. Pull a populated report and show the property, dates, campaign rows and metrics.
5. Show one additional native metric and one custom formula, save the report view and reopen it. Compare with the source Analytics property using matching dates and dimensions. Explain any attribution or thresholding differences; do not substitute fabricated production data.
6. Show CSV download. If Sheets scopes are part of the submitted review, demonstrate the separate Sheets consent, paste/select the destination, export and open the resulting Sheet. Show the saved schedule and an actual completed run. A schedule merely being saved does not prove delivery.
7. Demonstrate all Google Ads features and other scopes included in the actual verification submission as well. If a submitted permission permits writes, follow the review team's source-account-impact requirement using explicitly authorized test changes. An Analytics read-only report does not change the source property.
8. Ensure requested scopes, app configuration and Cloud Console submission match. Do not hide additional enabled permissions from the reviewer. If a feature is excluded from this review, separate its unverified consent flow as instructed by Google.
9. Provide the working video link, dedicated review credentials through Google's review channel and the exact navigation above. Keep credentials out of GitHub, this document, videos and logs. Use only a property/workspace the reviewer is authorized to see.
10. Verify the updated public policy is reachable, save/resubmit the actual Cloud Console changes, then reply to Google's existing email thread. A Git push does not itself complete the video, account setup, deployment or resubmission.

## API access is a separate investigation

Google Ads Explorer supports production accounts and ordinary reporting within its daily operation limits. OAuth scope verification does not grant higher Ads operation quotas, increase GA4 reporting quotas, or fix an account permission issue automatically. Describe a persistent `AUTHORIZATION_ERROR` as an observed failure, not proof that Explorer excludes production accounts. Submit higher-volume access requests through the Google Ads access-level process.

## Official references

- [Google's privacy-policy findings, including sensitive-data protection](https://support.google.com/cloud/answer/13806988?hl=en)
- [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)
- [Analytics Data API runReport and accepted scopes](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport)
- [Analytics Admin API accountSummaries.list and accepted scopes](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/accountSummaries/list)
- [Demonstration video requirements](https://support.google.com/cloud/answer/13804565?hl=en)
- [Google Ads access levels](https://developers.google.com/google-ads/api/docs/api-policy/access-levels)
