# Deployment of 2026-10-18

A dated record (DOC-01, DOC-03): the revisions that reached amcp.shop on 2026-10-18, and the commits that recorded the
public documentation pins it shipped. Current pages say what is true now and link this record for the revisions,
since the documentation freeze keeps commit references off them; the next deployment gets a record of its own beside
this one. Kept as written.

## Revisions

| Step | Revision | What happened |
| --- | --- | --- |
| Previous deployment | `60ec2cc` | The revision amcp.shop ran before 2026-10-18, and the one the engineering review of 2026-10-08 examined. |
| Push | `5db67a71` | `Work-here` was pushed on 2026-10-18 with waves 1 to 4a of that review, the MCP SDK upgrade to 1.32.1, the public documentation pins below and the owner-approved legal pages (D3), after the Windows release gate (`wave4a-gate-3`) and the Windows container-parity run (every test passed outside Git) had passed. |
| First build fix | `998d711a` | Railway's Linux build failed: `node:sqlite` in the image refused the online-backup rate `-1`, SQLite's "all pages" value, which the Windows Node accepted. `snapshotDatabase` uses `0x7fffffff`, the largest positive 32-bit page batch, so a backup still copies the database in one step from one read snapshot. |
| Second build fix | `cb338f68` | The build failed again: it runs `npm run check` as root, and the admin CLI refuses root without `--allow-root`, so the same-volume backup test stopped at that refusal instead of `BACKUP_SAME_VOLUME`. The test's two admin CLI calls pass `--allow-root`; in production admin commands still run as `node`. |
| Start | `cb338f68` | The deployment refused to start: the service variable `AMCP_LINKEDIN_API_VERSION` held a LinkedIn version AMCP has not reviewed. The owner set it to `202609`, and Railway reported the deployment of `cb338f68` successful and active (owner report, 2026-10-18). |

The deployed revision is `cb338f68`. Its Railway build log is not yet recorded: the owner exports it, records it with
`npm run evidence:railway -- --log build.log --commit cb338f68 ...`, saves `/versionz` and checks that it names
`cb338f68`, and pins both `node:24-bookworm-slim` stages of the Dockerfile to the base image digest that evidence
record shows ([per-release Linux evidence](../DEPLOY-RAILWAY.md#per-release-linux-evidence-from-railway-builds)). The
lessons for the next push are in
[what the 2026-10-18 deployment taught](../DEPLOY-RAILWAY.md#what-the-2026-10-18-deployment-taught).

## The public documentation pins of 2026-10-17

The public, unauthenticated reads that earlier waves had left to the owner, completed on 2026-10-17 and deployed with
this push ([current readiness](../CURRENT-READINESS.md#5-recorded-on-2026-10-17-public-documentation-pins)):

| Pin | Recorded in | What it changed |
| --- | --- | --- |
| Microsoft Learn, `GetGeoLocationsFileUrl` and its `CompressionType` | `1e03807b` | The page shows that `Zip` is reserved for future use, so the location lookup requests `GZip`, and the Microsoft Search recipe's lookup by name is on (CMP-03). |
| TikTok Pixel Event Stats: the SDK specification and API reference of `tiktok/tiktok-business-api-sdk` at its commit `f809c396` | `9c42d9f0` | The statistics read is sent only as this pin documents it (MSR-03); `.mirror/VENDOR/tiktok-pixel-event-stats.json` holds the pin. |
| Meta Business SDK v25.0.3 to v26.0.2 change evidence | `90023a25` | Regenerated from both complete PyPI releases (`tests/fixtures/meta-sdk-changes-v26.json`). |
