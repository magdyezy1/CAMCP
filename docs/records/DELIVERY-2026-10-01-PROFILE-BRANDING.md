---
status: record
tier: engineering
---

# Reusable approved client report branding — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `04d414d`. Implementation: `8b18bb6`. Batch 54 advances B14, B15 and B28 without creating a second
client-template store.

## Workflow

Clients & templates now accepts optional report branding in the existing approved client profile. Brand name,
accent color, footer and standard/compact PDF layout use the report pack's existing bounded validator. Turning
branding off leaves the profile available for its other workflows. Saving still requires explicit approval and
the current revision. Existing naming, tracking, campaign defaults and account bindings retain their behavior.

From a finished report pack, **Use approved client branding** lists compatible approved profiles, presents readable
labels and requires an explicit selection and confirmation. It copies an exact profile revision to the selected
snapshot. The website shows which profile/revision supplied the copy, and downloads use that retained style.
Subsequent edits or deletion of the reusable profile never silently change older report packs. Manual presentation
edits clear copied-profile provenance. Report rows, measurement definitions and source hashes are unchanged.

## Contracts and authority

`amcp_workspace save_profile` accepts optional `profile.report_presentation`; `preview_profile` includes its
normalized values. The new `amcp_reporting_overview presentation_profiles` action requires the report `id` and
optional `offset`/`limit` (1–100). It projects only name, revision, approval and branding fields, checking at most
100 candidate profiles per call. Campaign templates and complete profile documents are not returned. Follow
`next_offset` even after an empty filtered page. Offset pages are a current listing, not an immutable history.

`apply_profile_presentation` requires `id`, `profile_id`, `profile_revision`, `presentation_revision` and
`confirmed:true`. The transaction rechecks the approved profile revision and the snapshot's presentation revision
before saving and auditing. Current actor and report-source access are checked for choices, application and downloads.
Every report source must match an exact gateway/account/login in a nonempty profile binding list. Empty bindings
impose no additional profile restriction and do not grant report access. Reader roles cannot apply or save branding.
No advertising permission, provider request or external delivery is involved.

## Validation and remaining scope

Red-to-green regressions cover explicit confirmation, writer roles, both revision conflicts, normalized native
account IDs, mismatched logins and multi-account sources, revocation, approval, malformed styles, bounded metadata
pagination, nonretroactive edits/deletion and manual provenance reset. Browser-response tests additionally cover
navigation and identity changes before and during report rendering; the refreshed report title receives focus.
The real MCP SDK journey follows discovery → creative metadata → profile approval → branding choices → application,
validating advertised schemas and text/structured envelopes in nine calls, approximately 30.2 KB of structured
responses and zero provider requests. This is synthetic transport qualification, not external-client acceptance.

Synthetic browser acceptance created and approved a bound client profile, previewed and applied its exact revision,
and verified the retained brand, compact layout selection and revision label. Desktop and 390×844 mobile content
stayed within the viewport, with no observed console warning/error. Logs and screenshots are retained in ignored
`.runtime/profile-branding-20261001/`. Full release qualification is recorded in [PROGRESS.md](PROGRESS.md).

The matrix remains **11 implemented / 15 partial / 2 open**. B28's reusable branding portion is delivered;
scheduled file-delivery destinations remain unfinished. This adds no dependency, migration, OAuth scope or native
write family. No real credential, live provider acceptance, external notification, deployment or DNS change occurred.
