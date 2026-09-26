# Snapchat planning reads — 2026-09-26

Base revision: `1140286` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: two Snapchat planning requests (audience insights and reach and frequency forecasting) use
POST and are named "create" in the captured catalog, so AMCP classified them as blocked writes.
They only estimate. Media buyers use them to size audiences and plan reach and frequency
bookings before creating ad squads.

Contract source, read in the rendered Snap for Developers documentation on 2026-09-26:
[Audience Insights](https://developers.snap.com/marketing-api/Ads-API/audience-insights)
(`POST /v1/adaccounts/{id}/targeting_insights` with `base_spec` and `targeting_spec`, optional
`dimension_category`) and the [Reach and Frequency Guide](https://developers.snap.com/marketing-api/Ads-API/reach-and-frequency)
("Create a Forecasting Request": `POST /v1/adaccounts/{id}/reserved_forecasting` with the ad squad's
placement, targeting, `REACH_AND_FREQUENCY` delivery, dates, type and goal, and frequency caps;
bookings between 12 hours and 365 days ahead; `VIDEO_VIEWS` for Snap Ads and `USES` for Lenses).

## Change

`src/snapchat-planning-reads.ts` validates both requests during compilation and marks a valid
request read-only. The Snapchat POST read allowlist in `src/execution-risk.ts` names both
routes. They run through the normal native read path with the account scope checks, and never
through `amcp_write`.

| Request | Accepted |
|---|---|
| Audience insights | Exactly `base_spec` and `targeting_spec` objects; the only query parameter is `dimension_category` (demo, geo, device, interest, engagement or aggregated) |
| Forecast | Only the documented ad squad attributes; `placement_v2`, `targeting` and `cap_and_exclusion_config` objects; `REACH_AND_FREQUENCY`; ISO-8601 date-times starting 12 hours to 365 days ahead, with a later end; `type` `SNAP_ADS` or `LENS` with its goal |
| Both | The selected ad account; no header overrides; at most 64 KiB; `INVALID_SNAPCHAT_PLANNING_READ` otherwise, before any request |

The action ledger now classifies both routes as native reads (two Snapchat rows leave the
remaining list). Guidance: "Snapchat planning reads" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md`. Snapchat contract version 7.

## Tests

`tests/snapchat-planning-reads.test.mjs`, four tests:

1. A reader runs audience insights on a read-only deployment: one POST with the specs and dimension category, and Snapchat's estimate returned unchanged.
2. A forecast runs as a read, and its dry-run preview is marked read-only without a request.
3. Eleven malformed requests fail with `INVALID_SNAPCHAT_PLANNING_READ` before any request: missing base spec, extra field, unknown dimension, auction delivery, start within 12 hours, start beyond a year, end before start, a Lens with video views, an unknown attribute, no frequency cap and a date without time. Another ad account fails with `CONNECTION_REQUIRED`.
4. The action ledger classifies both routes as native reads.

Changed test: `tests/compiler.test.ts` compiles every catalog action with placeholder arguments.
Like the X audience estimate before them, the two planning routes now validate their body during
compilation, so the test supplies a valid body for each.

Red/green: all four fail against a build of `1140286` (the routes were blocked writes) and pass
with this change. Local log: `.runtime/snapchat-planning-reads-20260926/red-check.log`.

## Verification

- Targeted: 126 related suites (including compiler, parameter, catalog, every Snapchat and the X
  estimate suites), 1,538/1,538. The first run failed only the compiler test described above.
- Guidance coverage: 257 write-path refusals across 137 modules accounted for.
- Full qualification: see
  [SNAPCHAT-PLANNING-READS-VERIFICATION-2026-09-26.json](SNAPCHAT-PLANNING-READS-VERIFICATION-2026-09-26.json).

Remaining rows: 913 (two Snapchat rows are now native reads; Snapchat blocked writes 91 → 89).
Live acceptance is unverified; it needs the updated deployment and a Snapchat ad account.
