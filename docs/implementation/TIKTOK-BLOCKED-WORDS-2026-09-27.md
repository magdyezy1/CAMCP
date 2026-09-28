# TikTok ad comment blocked words — 2026-09-27

Base revision: `1ecf2a8` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: advertisers could not manage the words that hide comments on their ads. Blocked word creation,
update, deletion and export (four rows) were blocked writes. Earlier batches deferred them because
the portal pages render with JavaScript; the in-app browser now reads them.

Contract source: TikTok API for Business v1.3 "Create blocked words", "Update a blocked word",
"Delete blocked words", "Get blocked words", "Create an export task (blocked words)" and "Check the
status of an export task (blocked words)", read on 2026-09-27. Key facts:

- `POST /blockedword/create/` with `{advertiser_id, blocked_words}`; "Each ad account can have up to
  500 blocked words". `POST /blockedword/update/` with `{advertiser_id, old_word, new_word}`.
  `POST /blockedword/delete/` with `{advertiser_id, blocked_words}`: "If you attempt to delete a word
  that is not on the blocked word list, no errors will occur", and "When a blocked word is deleted,
  comments that contain this word will become public".
- `GET /blockedword/list/` pages with `page` and `page_size` (1–500) and returns `list[].bw_content`
  with `page_info`. Replies carry `code` (0 on success) and no word IDs.
- `POST /blockedword/task/create/` returns a `task_id`; `GET /blockedword/task/check/` reports
  `RUNNING`, `SUCCEED` or `FAILED`.

## Change

New reviewed family `tiktok_blocked_words` (`src/tiktok-blocked-words.ts`):

| Part | Behaviour |
|---|---|
| Request | The selected advertiser in `advertiser_id`; 1–500 distinct words of 1–30 characters (no surrounding spaces or control characters, no word twice ignoring case); an update names a different new word; an export takes optional words and `lang` (`EN`, `JA`, `ZH`); no query parameters |
| Scope | Reads use the vendor list and task-check actions, whose required `advertiser_id` the TikTok scope rule already confines |
| State | The complete blocked word list, read page by page (up to five pages of 500) |
| Checks | Words already blocked (ignoring case) and a new word already blocked are refused; words to replace or delete must be listed, since TikTok ignores unknown deletions; the list stays within 500 words |
| Safety | No spending confirmation; the review states which comments become hidden or public |
| Receipt | `code` 0 (and a `task_id` for exports); anything else is a failure never resubmitted |
| Verification | The complete list read again and compared with the expected list; an export task checked until `SUCCEED` |

Other code: `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts`
and `src/provider-contracts.ts` (TikTok contract version 23, reviewed 2026-09-27). Guidance: "TikTok
ad comment blocked words" in `Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an
executable inspect example.

## Tests

`tests/tiktok-blocked-words.test.mjs`, four tests:

1. Two words are blocked after reading all three pages of the list, a word is replaced and one unblocked; each verifies against the complete list; a replay sends nothing.
2. An export task verifies once it succeeds; a running task is not yet verified and verifies after it succeeds.
3. Eight malformed requests (another advertiser, empty lists, long or padded words, a word twice, other fields, an unchanged replacement, an unknown export language) are refused before any request; words already blocked, unknown words to replace or delete, a new word already blocked and a full list are refused after reading, without writes.
4. An error reply is never resubmitted; ignored creations, updates and deletions are not verified; the ledger lists all four writes in the family.

Red/green against a build of `1ecf2a8`: all four tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/tiktok-blocked-words-20260927/red-check.log`.

## Verification

- Targeted: 196 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,974/1,974.
- Guidance coverage: 327 write-path refusals across 193 modules accounted for.
- Full qualification: see
  [TIKTOK-BLOCKED-WORDS-VERIFICATION-2026-09-27.json](TIKTOK-BLOCKED-WORDS-VERIFICATION-2026-09-27.json).

Remaining rows: 739 (four TikTok rows reviewed; TikTok blocked writes 186 → 182). Live acceptance is
unverified; it needs the updated deployment and a TikTok advertiser.
