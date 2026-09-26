# AMCP implementation handoff — 2026-09-26

The user asked to fix the Snapchat workflow defects found in live AMCP use on
2026-09-25, follow the [2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md) procedures,
and push only to CAMCP. That batch is finished. The user then asked to apply the
2026-09-25 ticket list, all of it that can be implemented locally. P1 campaign
blockers come first, starting with Snapchat. Deployment, live-login and
customer-data/PII tickets stay outside that request (see the boundaries below).

## Checkout and operating boundaries (changed)

- Worktree: `C:/Users/abdom/Downloads/CLaude workspace`, a copy of the Codex-branch
  checkout. The user asked that no other folder be used; the earlier worktrees
  (`Downloads/implementation-Codex-branch`, `AMCP Final With Claude recos - Copy/…`)
  are not to be read or edited.
- Push only to `https://github.com/magdyezy1/CAMCP` (remote `camcp`), branch
  `Codex-branch`. The `origin` (magdyezy1/AMCP) push URL is disabled in this checkout.
  Do not push to AMCP or any other remote. CAMCP is private.
- All other boundaries from the 2026-09-25 handoff still apply: no reading
  `.mirror/RESULTS/live-read-samples.json`, credentials, `.env` secrets or live
  databases; no live advertising mutations, credential/grant changes, deployment,
  Railway or DNS changes; qualification only in a fresh sanitized candidate.
- Customer-data work (lead reports and webhooks, customer-list and offline uploads)
  needs its own consent, retention and recipient policies. It is not part of the local
  ticket work.
- Git: pass `safe.directory` to the release assembler through `GIT_CONFIG_COUNT`,
  `GIT_CONFIG_KEY_0=safe.directory` and `GIT_CONFIG_VALUE_0=<worktree>` rather than
  changing global configuration. System Python on PATH (standard library only) serves
  `AMCP_SCHEMA_PYTHON`; FFmpeg 9.0.2 and the npm cache are under this worktree's `.runtime/`.

## Finished batch — Snapchat workflow defects

[Implementation](SNAPCHAT-WORKFLOW-2026-09-26.md) and
[qualification](SNAPCHAT-WORKFLOW-VERIFICATION-2026-09-26.json).

Fixed: plan currency for Snapchat (and TikTok/Reddit) preflight; ad squad
`placement_v2` verified from the write acknowledgment; ownership renewed by parent
reads that name the owning account; independent plan steps no longer stall behind an
inconclusive read-back; early `SNAPCHAT_PIXEL_NOT_OWNED`; Snapchat `result_fields`
envelopes; execute accepts the review's own gateway/connection; specific plan-step
errors. Tests: `tests/snapchat-workflow-fixes.test.mjs` (10, red before / green after).

Not changed, with reasons in the implementation record: BUG-7
(`get_creatives_by_ids` body), a Snapchat recipe, a `reconcile_step` verification
bypass, and nested-update PUT handling of the write-only `placement_v2`.

Fresh candidate `.release/snapchat-workflow-20260926-a` (664 files, source hash
`3a533427aea8b7696082a6d51fc492b56087be90ce5ea2b75645fca83425d64e`) passes
**2062 main and four capture tests**, no failures/skips, with FFmpeg required, every
generated/contract/provider gate and the Railway check. Staged code, tests and guidance
match the candidate (LF-normalized); see the qualification record for hashes.

## Finished batch — Snapchat lead generation forms

[Implementation](SNAPCHAT-LEAD-FORMS-2026-09-26.md) and
[qualification](SNAPCHAT-LEAD-FORMS-VERIFICATION-2026-09-26.json).

The three captured form create actions now use the reviewed Snapchat family:

- Documented-field validation before any request (`INVALID_SNAPCHAT_LEAD_FORM`).
- Banner-media ownership read.
- A `LEAD_GENERATION` creative reads its form before review and execution.
- Strict receipts.
- Read-back that ignores provider-added `is_required`/`strategy_type`.

Lead reports and webhooks stay unqualified (personal data).

Tests: `tests/snapchat-lead-forms.test.mjs` (8, red on `d88f1e0` / green after).
Remaining rows: 976 (3 fewer); Snapchat blocked writes 95.

## CI and live evidence

The push to CAMCP was the first commit there. Its GitHub Actions run must be checked by
exact SHA (Actions may need enabling on the new repository). This checkout has no
GitHub CLI and CAMCP is private, so the runs for `d88f1e0` and later commits were not
read from here. Nothing is claimed green from the local result alone. Live acceptance is unverified: the fixes reach the AMCP
connector only after its deployment is updated from this code (not authorized here).
Afterwards, re-run the Snapchat clone as one plan with `expected_currency` set and
confirm BUG-1 to BUG-6 live.

## Remaining inventory

3241 captured actions; 461 in reviewed write families. **976 remaining rows** are in
[REMAINING-ACTIONS-2026-09-26.csv](REMAINING-ACTIONS-2026-09-26.csv), derived from the
coverage ledger with the same status filter as the 2026-09-25 file:

| Category | Rows |
|---|---:|
| blocked_write | 861 |
| unmapped | 79 |
| unqualified_read | 23 |
| adapter_requires_input | 8 |
| provider_unsupported | 5 |

Blocked writes by platform: TikTok 219, Meta 136, LinkedIn 119, Google Ads 108,
Snapchat 95, X 67, DV360 62, Criteo 43, Business Profile 12. The ticket list in the
2026-09-25 handoff remains the backlog, plus these Snapchat follow-ups:

| Priority | Task | Acceptance |
|---|---|---|
| P1 | Deploy this build where the AMCP connector runs (separately authorized) | Live clone as one plan: currency passes, ad squads verify, no ownership race |
| P2 | Snapchat PUT semantics for write-only `placement_v2` | Live evidence of PUT with/without the field before changing preservation rules |
| P3 | `get_creatives_by_ids` request body | Provider documentation or a captured successful request |
| P3 | Snapchat campaign recipe | Qualified inputs for currency, budget, pixel and media; paused entities only |
| P2 | Creative PUT/PATCH reads of referenced forms and media | A changed `lead_generation_form_id`/`top_snap_media_id` is ownership-read without breaking the per-creative state layout those contracts verify |
| P2 | Live lead form acceptance (after deployment) | One paused account-owned test form and `LEAD_GENERATION` creative verify live |
