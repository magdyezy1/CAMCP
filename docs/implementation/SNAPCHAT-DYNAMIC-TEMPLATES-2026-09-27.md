# Snapchat dynamic templates — 2026-09-27

Base revision: `683a2da` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: dynamic creatives name a dynamic template, but templates could not be created or changed.
Template creation and update (two rows) were blocked writes.

Contract source: the Snapchat Marketing API Dynamic Product Ads guide ("Dynamic Templates"), read on
2026-09-27. Key facts:

- `POST /v1/adaccounts/{ad_account_id}/dynamic_templates` creates templates from
  `{dynamic_templates: [...]}`; `PUT` on the same path updates them, each with its `id`. Replies
  list each template with its `sub_request_status`. No deletion is documented.
- Attributes: `ad_account_id`, `name` (up to 375 characters), `ios_url` and `android_url` (the
  guide's renderer URL), `layout` (eight values; `CAROUSEL` and `SLIDESHOW` need a collection ad),
  `text_fields` (at most two catalog fields, named per catalog vertical), `background_color` (three
  or six hexadecimal digits), `preferred_image_tags`, `preferred_video_tags` and `overlay_specs`.
- Overlays: `IMAGE`, `FRAME` (always `CENTER`) or `TEXT` (up to 34 characters), seven positions,
  opacity 75–100, and text overlay shapes `NONE`, `CIRCLE`, `PILL`, `RECTANGLE` with colours.
  Overlay media are account images (frames 1080×1920, logos 200×200, at most 2 MB).
- Dynamic creatives name a template in `dynamic_render_properties.dynamic_template_id`.

## Change

New reviewed family `snapchat_dynamic_templates` (`src/snapchat-dynamic-templates.ts`):

| Part | Behaviour |
|---|---|
| Request | 1–10 templates of the selected account with the documented fields; updates send each template in full with its `id`; no query or header overrides |
| Values | The renderer URL, layout, text field names, hexadecimal colours, tags, overlay types, positions, opacity and text overlay shapes are checked against the guide; one `FRAME` per template |
| Scope | The ad account in the path; internal reads of its templates, media and creatives |
| State | The account's templates (following cursors, up to 5000), the media the overlays name and, for updates, the account's creatives |
| Checks | Names do not repeat in the account; updated templates exist and change; overlay media exist, are images and are READY |
| Safety | No spending confirmation; an update shows the dynamic creatives that use each template and is marked as affecting serving when any do |
| Receipt | `request_status: SUCCESS` and SUCCESS with an ID for every template (the same IDs for updates); anything else is a failure never resubmitted |
| Verification | The account's templates listed again; each field sent compared, opacity as a number |

Other code: `src/scope.ts`, `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts`
and `src/provider-contracts.ts` (Snapchat contract version 14). Guidance: "Snapchat dynamic
templates" in `Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect
example.

## Tests

`tests/snapchat-dynamic-templates.test.mjs`, three tests:

1. Two templates (one with image, frame and text overlays, one carousel with preferred tags) are created after following the template cursor, and verify; a replay sends nothing; a template that a creative uses is updated with its usage shown; an unused one is renamed; both verify.
2. Sixteen malformed requests (empty list, another account, another renderer, unknown layout, three or unknown text fields, a colour with #, long overlay text, a frame off centre, an image without media, low opacity, text styling on an image, an unknown shape, duplicate names, an update without id, a creation with id) are refused before any request; unknown templates and media, video and unready media, taken names and an unchanged template are refused after reading, without writes.
3. An error reply is never resubmitted; ignored creations and updates are not verified; the ledger lists both writes in the family.

Red/green against a build of `683a2da`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/snapchat-dynamic-templates-20260927/red-check.log`.

## Verification

- Targeted: 191 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,957/1,957.
- Guidance coverage: 321 write-path refusals across 188 modules accounted for.
- Full qualification: see
  [SNAPCHAT-DYNAMIC-TEMPLATES-VERIFICATION-2026-09-27.json](SNAPCHAT-DYNAMIC-TEMPLATES-VERIFICATION-2026-09-27.json).

Remaining rows: 752 (two Snapchat rows reviewed; Snapchat blocked writes 73 → 71). Live acceptance
is unverified; it needs the updated deployment and a Snapchat ad account with a catalog.
