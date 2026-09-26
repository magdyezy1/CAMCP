# TikTok Upgraded Smart+ Instant Form lead generation ads — 2026-09-26

Base revision: `895cb29` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the "Next" note of the lead generation ad group batch in the
[2026-09-26 handoff](RESUME-HANDOFF-2026-09-26.md). Instant Form lead generation ad groups could be
created paused, but the reviewed Smart+ ad contract accepted landing pages only, so they could not
get ads.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:

- [Create an Upgraded Smart+ Lead Generation Campaign with Location as Instant Form](https://business-api.tiktok.com/portal/docs/create-an-upgraded-smart-lead-generation-campaign-with-location-as-instant-form/v1.3):
  the ad names the form in `page_list`, has no `landing_page_url_list`, and uses a dynamic CTA.
- [Get the Page ID](https://business-api.tiktok.com/portal/docs/get-the-page-id/v1.3):
  `/page/get/` lists an advertiser's pages (or a Business Center library's) by type and status,
  100 at most per page, with no page ID filter.
- [Get the fields of an Instant Form](https://business-api.tiktok.com/portal/docs/get-the-fields-of-an-instant-form/v1.3)
  was considered and not used: its documented response is empty and carries no publish status.

## Change

| Part | Behaviour |
|---|---|
| Ad destination (`src/tiktok-smart-plus-ads.ts`) | A Smart+ ad sends either one landing page (website conversion ad groups) or `page_list` with exactly one form (Instant Form lead generation ad groups), never both; lead ads take no `utm_params`. The review refuses a destination that does not match the ad group |
| Form check (`src/tiktok-instant-forms.ts`) | The review reads the advertiser's published `LEAD_GEN` pages, page 1 first and then every page it names, up to 10 pages of 100, before review and again before execution, and refuses a form it does not find; more than 1000 published forms are refused when the form is not among them |
| Review state | Each page keeps the page number, page count and each form's ID and status; signed preview links and thumbnails are left out |
| Pagination guard | Generic state reads still refuse paginated responses; the published form pages are validated first, because every page is read |
| Scope (`src/scope.ts`) | `GET /v1.3/page/get/` is authorized for the selected advertiser only, and never with a Business Center `library_id`. Before, the route was unreadable in state checks because its catalog entry does not require `advertiser_id` |
| Verification | The ad's `page_list` compares as a set of form IDs |

The action inventory does not change. Instant Form ad edits stay unqualified beyond renaming,
because the Smart+ ad edit contract still requires a landing page.

Other code: `src/write-review.ts` (the follow-up form reads and the early form validation),
`src/review-state.ts`, `src/provider-contracts.ts` (TikTok contract version 20),
`src/action-contracts.ts`. Guidance: "Instant Form lead generation ads" in the Smart+ Spark Ads
section of `Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable
inspect example.

## Tests

`tests/tiktok-smart-plus-lead-ads.test.mjs`, four tests:

1. A lead ad whose form is on the second of two pages of published forms reads both pages, shows the form as its destination, is created once and verifies, although every form read carries a new signed preview link.
2. A landing page beside the form, two forms, UTM parameters, a form in a website ad group, a landing page in a lead ad group and a form the advertiser does not have are refused before any write.
3. With more than 1000 published forms, a form not found in the ten pages read is refused after exactly ten page reads.
4. The advertiser's own page list can be read; a Business Center library read is refused before any request.

Changed test: `tests/tiktok-smart-plus-ads.test.mjs` expected the old message for a lead ad group
without an Instant Form target; it now expects the message naming both qualified ad group types.

Red/green: all four fail against a build of `895cb29` (form destinations are refused and the page
list is unreadable) and pass with this change. Local log:
`.runtime/tiktok-smart-plus-lead-ads-20260926/red-check.log`.

## Verification

- Targeted: 1366/1366 across 108 related suites, including the review-envelope, scope and Smart+
  suites.
- Guidance coverage: 252 write-path refusals across 132 modules accounted for.
- Full qualification: see
  [TIKTOK-SMART-PLUS-LEAD-ADS-VERIFICATION-2026-09-26.json](TIKTOK-SMART-PLUS-LEAD-ADS-VERIFICATION-2026-09-26.json).

Remaining rows: 929 (unchanged). Live acceptance is unverified; it needs the updated deployment,
a test advertiser with a published Instant Form and an Instant Form ad group.
