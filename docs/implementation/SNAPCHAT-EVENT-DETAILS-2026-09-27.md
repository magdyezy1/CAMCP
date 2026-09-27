# Snapchat event details — 2026-09-27

Base revision: `140396f` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: Reminder creatives promote event details, but event details could not be created or deleted.
Creation and deletion (two rows) were blocked writes.

Contract source: the Snapchat Marketing API "Event Details" and "Creatives" (Reminder creatives)
references, read on 2026-09-27. Key facts:

- `POST /v1/adaccounts/{ad_account_id}/event_details` creates event details from
  `{event_details: [{event_name, event_time_zone, event_start_time, ad_account_id}]}`; the entity
  "is immutable once created". `event_name` has at most 300 characters; `event_time_zone` is
  optional and only for display, from a listed set; `event_start_time` is an ISO date with optional
  hour, minutes and seconds, in UTC unless offset (the reply returns it converted to UTC).
- `GET` on the same path lists them; `DELETE /v1/event_details/{id}` deletes one ("there is no way
  to reinstate a deleted entity"; make sure no active Reminder creative uses it). The deletion
  reply's `request_status` is lower case in the guide.
- Reminder creatives name the entity in `reminder_properties.event_details_id` (the guide's example
  writes `event_detail_id`).

## Change

New reviewed family `snapchat_event_details` (`src/snapchat-event-details.ts`):

| Part | Behaviour |
|---|---|
| Request | Creation: 1–10 events of the selected account with a name, a start and an optional listed time zone; deletion: the event details in the path only; no query or header overrides |
| Start | Parsed as a UTC instant (offsets such as the guide's `-04:00:00` applied); it must lie in the future and within three years, since the entity cannot be edited |
| Scope | The ad account; internal reads of its event details and creatives |
| State | The account's event details (following cursors, up to 5000) and, for deletions, its creatives |
| Checks | The same name and start are not created twice; deletions need event details of the account that no creative promotes (`EVENT_DETAILS_IN_USE`, both field spellings) |
| Safety | No spending confirmation; deletions count under owner deletion policies |
| Receipt | `request_status: SUCCESS` (any case) and, for creations, SUCCESS with an ID for every event; anything else is a failure never resubmitted |
| Verification | The account's event details listed again: name, start instant and any time zone sent compared, or the deleted ones gone |

Other code: `src/scope.ts`, `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts`
and `src/provider-contracts.ts` (Snapchat contract version 15). Guidance: "Snapchat event details"
in `Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect example
(a deletion, which stays valid as dates pass).

## Tests

`tests/snapchat-event-details.test.mjs`, four tests:

1. Start times: the guide's offset example, dates with or without time and returned UTC stamps parse to the same instants; impossible dates and other formats do not.
2. Two events (one with a time zone and an offset start, one without a zone) are created after following the list cursor, and verify; a replay sends nothing; an unused event is deleted and verifies gone; an owner deletion rule refuses deletions but not creations.
3. Ten malformed requests (empty list, eleven events, another account, long names, unknown zones, past, far or unreadable starts, other fields, the same event twice) are refused before any request; a taken event, an unknown one and ones that creatives promote (both field spellings) are refused after reading, without writes.
4. An error reply is never resubmitted; ignored creations and deletions are not verified; the ledger lists both writes in the family.

Red/green against a build of `140396f`: the test file fails to load, because `dist/src/snapchat-event-details.js` does not exist at that revision (ERR_MODULE_NOT_FOUND). Local log:
`.runtime/snapchat-event-details-20260927/red-check.log`.

## Verification

- Targeted: 192 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,961/1,961.
- Guidance coverage: 323 write-path refusals across 189 modules accounted for.
- Full qualification: see
  [SNAPCHAT-EVENT-DETAILS-VERIFICATION-2026-09-27.json](SNAPCHAT-EVENT-DETAILS-VERIFICATION-2026-09-27.json).

Remaining rows: 750 (two Snapchat rows reviewed; Snapchat blocked writes 71 → 69). Live acceptance
is unverified; it needs the updated deployment and a Snapchat ad account.
