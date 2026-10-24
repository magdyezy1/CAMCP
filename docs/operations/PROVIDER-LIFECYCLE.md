---
status: reference
tier: operator
---

# Provider lifecycle

Provider API versions, their sunsets and the lifecycle checks the owner runs (owner decision P10). A section of the [operations runbook](../OPERATIONS.md), moved here with its text unchanged on 2026-10-24 (DOC-03).

- **Dated deprecations.** `src/provider-deprecations.ts` records what a provider stops accepting inside a version
  (a route, enum value, header or field), each with its effective date (UTC), primary source and the values that stay
  accepted. From the date the named module refuses the request with `PROVIDER_DEPRECATED` before any provider request,
  citing the source: X v5 recommendation reads (now `provider_unsupported`), DV360 line item and ad group
  sensitive-category and content-rating exclusions (2026-10-01; advertiser-level targeting stays provider-checked),
  DV360 YouTube video ads without a business name and logo when the advertiser has no defaults (2026-10-12), and
  Reddit report breakdowns (2026-12-08; the reporting bootstrap lists affected saved reports and schedules first). The
  Google `developer-token` header is no longer sent.
- **Sunsets.** `providers:sunsets` keys `src/provider-sunsets.ts` by provider and version and requires an entry for
  every version AMCP can be configured to send, so it works during the Meta rollback (`AMCP_META_API_VERSION=v25.0`)
  and lists each Meta version's status. `--alarm` also reports deprecations within 90 days and a `stale_check` when a
  version's recorded check is more than 45 days old; the qualification runner records these without failing.
- **Documentation watch.** `providers:lifecycle` is offline by default: it lists unbaselined sources, `stale_check`
  sources (no successful read in 45 days), parked providers (Criteo) and the manual checks with their owner and due
  day; `--strict` exits 1 on any of them. The owner runs `--live` (public documentation GETs only, no provider API
  call) on a machine they control. Each page reports `unchanged`, `changed_requires_review`, `baseline_required`,
  `unavailable` (with a reason such as `blocked_or_empty`, `http_503` or `cross_domain_redirect`) or `parked`; only a
  change, a moved final URL or an overdue manual check exits 1. Same-registrable-domain redirects are followed and the
  final URL is recorded. After review, `--live --refresh` rewrites `.mirror/VENDOR/lifecycle-pages.json` (unavailable
  pages keep their earlier baseline); inspect `git diff` before committing it. TikTok, Amazon and Adjust are manual
  checks (the TikTok portal blocks automated reads): update `last_checked` in `tools/provider-lifecycle.ts` after
  reading.
- **Meta currency offsets.** Meta caps stated in account currency convert through
  `.mirror/VENDOR/meta-currencies.json`, captured on 2026-10-11 from Meta's Marketing API Currencies page
  (`https://developers.facebook.com/docs/marketing-api/currencies`, 66 currencies; rechecked 2026-10-12,
  `rechecked_at`). Its `sha256` seals the rows (`JSON.stringify(currencies)`); the server ignores the whole capture
  when the digest, the Meta source, the date or any row fails, and Meta caps then stay native (owner health:
  `meta_currency_offsets: not_pinned`). The page is on the documentation watch, new and without a baseline until the
  next owner-run `--refresh` records one. When it reports `changed_requires_review`, read the page, update the rows,
  `captured_at` and `sha256` together, and commit them with the watch baseline. Saved account policies keep the
  offset that converted them in `native_unit`.
  The rows were read from Meta’s public documentation during implementation (`capture` describes the readings), not
  from a byte-exact page copy: `sha256` seals the rows as recorded, so it cannot prove them against the page. Before
  release the owner checks the 66 rows against Meta’s Currencies page, or records that such public documentation
  reads were allowed, and runs the documentation watch’s `--refresh` to set its baseline; until then treat the
  offsets as awaiting owner verification.
