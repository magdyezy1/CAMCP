# Personal data in advertising writes: policy

**Status: approved by the owner on 2026-09-30** ("Approved"), as drafted on 2026-09-29: the seven rules, the order
below, and removals by an operator as recommended. Each platform opens as its own reviewed family that meets every
rule, in the approved order. This is not legal advice: the privacy-law section needs confirmation by counsel for each
country served.

## What it covers

Writes that send data about identifiable people to an ad platform:

- **Customer lists:** Meta customer-file custom audiences, Google Customer Match, TikTok customer files, Snapchat SAM,
  LinkedIn contact and company lists, X tailored audiences.
- **Conversions:** offline, server, click and call conversions, and enhanced conversions.

Reading aggregated reports is not covered. Neither is lead retrieval, which stays blocked.

## Rules

1. **Hash in memory, before anything leaves AMCP.**
   - Emails and phone numbers are normalized as each platform documents (trimmed, lower case, E.164 phones), then
     hashed with SHA-256. Google Ads v25: "Hashed email address using SHA-256 hash function after normalization".
     Meta's Business SDK 26.0.2 trims, lower-cases and SHA-256-hashes customer-file values the same way.
   - Hashing happens in the server process while the request is built. The file is never written to disk, the media
     store or any scratch area.
   - Pre-hashed input is accepted only if every value is a 64-character lowercase hex string.
   - A value that is neither valid plain text nor valid hash is refused and counted, never sent.
2. **Store nothing about the people, raw or hashed. Counts only.**
   - Nothing about the people goes to the database, logs, audit trail, reviews, receipts, verification records,
     support bundles or error details.
   - A review keeps only the counts (rows, valid, refused by reason, duplicates removed) and one SHA-256 digest of the
     sorted hashed batch.
   - At execution the file is supplied again, hashed again in memory, and must produce the same digest. A different
     file is refused.
   - Platform error replies are redacted before they are kept, since a platform may echo a value back.
3. **Owner-only, off by default per account.**
   - Only the workspace owner can turn personal-data writes on, one ad account at a time. Every account starts off.
   - Every upload needs the owner's approval at execution. An operator may prepare one but not run it.
   - Turning an account off takes effect at once, including for reviews already prepared.
4. **Consent, and the platform's own terms.**
   - At each upload, the uploader confirms in plain words that the people in the list agreed to their data being used
     for advertising on that platform, or that another lawful basis applies under the law named in section 6.
   - The uploader also confirms that the platform's customer-list terms were accepted in the platform itself.
   - AMCP never accepts terms. Where a platform exposes acceptance, AMCP reads it and refuses without it. For example,
     Meta's ad account `tos_accepted` map (SDK 26.0.2).
   - Google's per-upload `consent` (`adUserData`, `adPersonalization`: GRANTED or DENIED) is required and shown in the
     review, never defaulted.
5. **A simple way to remove people.**
   - Every list family ships with its removal in the same batch: Meta `DELETE /{custom_audience_id}/users`, and Google
     `remove` or `removeAll` operations, "only supported for Customer Match".
   - A removal follows the same rules: hashed in memory, counts only.
   - The review names the list and the number of people removed.
   - Conversions cannot be recalled once a platform has used them; the review says so before the upload.
6. **The privacy law of the people in the list.**
   - The uploader names the countries of the people in the list, and the review shows the law that applies.
   - **Saudi Arabia (KSA audiences):** the Personal Data Protection Law (PDPL), supervised by SDAIA.
     - The uploader confirms consent for marketing use, or another basis the PDPL allows.
     - The uploader also confirms that sending the data to a platform outside the Kingdom meets the PDPL's rules for
       transfers abroad.
     - The uploader confirms that people who withdraw consent are removed under rule 5.
   - **UAE:** Federal Decree-Law 45 of 2021 on personal data. **EEA and UK:** GDPR and UK GDPR, with Google's EU user
     consent fields set from real consent.
   - **Anywhere else:** the uploader names the law. A list with no country named is refused.
7. **Bounds and verification.**
   - One upload holds at most the platform's documented batch size, or 10,000 rows, whichever is smaller.
   - An upload goes only to a list or conversion action of the selected account, read first.
   - Verification uses the platform's own counts (received, matched or refused, approximate size), never the people.
   - A list must meet the platform's minimum audience size before it can be used for targeting, as each platform
     documents.

## What the owner approved (2026-09-30)

- The seven rules above, as the condition for opening any personal-data family.
- The order: Meta customer lists and Google Customer Match first (removal included), then conversions.
- Whether the operator may also run a removal, since removal only reduces data held. Recommendation: yes, with the
  owner's approval still needed to add people.

## Implementation (batch 43, 2026-09-30)

- **Foundation** (`src/personal-data.ts`, `src/personal-data-access.ts`, the seam in `src/write-review.ts`):
  - People travel as `people` beside the reviewed request, never inside its arguments. They are normalized and hashed
    in memory, and the review keeps only the counts and the digest.
  - Execution takes the people again and refuses a different batch.
  - The error audit keeps only the number of rows. The arguments of a request that carries people are scrubbed.
  - A platform's reply and errors are scrubbed of hashes and e-mail addresses before they are kept or returned.
  - The owner's switch is `amcp_workspace enable_personal_data` / `disable_personal_data`, one ad account at a time.
  - Adding people needs the workspace owner at execution. The owner may execute a review a member prepared; this is
    the only review another actor may execute.
- **Meta customer lists** (`meta_customer_lists`):
  - Actions: an empty list is created (subtype CUSTOM), and people are added and removed, up to 10,000 per request.
  - Meta's `tos_accepted` and the list are read first.
  - Verification uses Meta's counts and the list's size and `delivery_status`.
  - Replacing a whole list stays blocked.
- **Google Customer Match: blocked; the owner decides.**
  - Since April 1, 2026, Google refuses Customer Match requests to OfflineUserDataJobService and UserDataService from
    projects that sent none between October 1, 2025 and March 31, 2026 (`CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE`,
    Google Ads API deprecations, read 2026-09-30). AMCP sent none.
  - Google's replacement, the Data Manager API, needs a new OAuth scope (`datamanager`).
  - Each Data Manager upload states `termsOfService.customerMatchTermsOfServiceStatus`, "the caller's decision to
    accept or reject" the Customer Match terms. Rule 4 says AMCP never accepts terms on its own.
  - Opening Google therefore needs two owner decisions: the new scope, and whether the uploader's confirmation of
    Google's terms may be sent as that field.
- **Conversions** come next in the approved order; none is open yet.

