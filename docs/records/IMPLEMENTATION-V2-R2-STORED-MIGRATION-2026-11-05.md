---
status: record
tier: engineering
---

# Round 2 stored report migration — 2026-11-05

Running a stored legacy report now validates an Overview v4 sidecar while retaining its original configuration
for rollback. A hand-chosen legacy objective becomes a fallback: the platform's objective takes precedence unless
the report has a per-campaign override. Unknown legacy choices do not create a migration notice. Already queued
legacy runs and completed snapshots retain their recorded contracts and objective behavior.

The conversion preserves account bindings, explicit attribution settings, declarations, targets and custom metrics.
It removes scope IDs that the old collector ignored, selects all configuration statuses and preserves the legacy
delivery population. A legacy Meta or Snapchat campaign without an explicit attribution profile keeps the original
provider-configured request behavior, including its report-time mode. It does not silently acquire new attribution
defaults or a complete-window declaration. Provider validators prevent this preserved campaign profile from bypassing
detail requirements, including supporting detail reads. Newly requested v4 profiles keep their server defaults.

A tenant-bound `overview_objective_migration` document records the one-time numbers-changed notice for a saved view
or standalone schedule. The first nonempty completed or partial v4 capture claims it in the snapshot's transaction.
Failed and empty captures cannot consume the claim, and deleting History cannot reset it. Earlier v4 notices can seed
the durable claim without loading report rows. Comparison baselines cannot consume the current report's notice.
Manual and scheduled runs share a view's claim; a standalone schedule's
claim follows it when it gains a linked view. A pending same-origin view cannot erase an already announced schedule
claim. Different definitions and tenants retain their separate claims. Definition deletion removes its own claim;
workspace erasure and encrypted backup follow the storage registry.

Stored execution, comparison, scheduled dispatch, resume and edits use the validated configuration. Dispatch keeps
the existing occurrence/revision transaction. A failed resume rolls back sidecars and notice registration, and
schedule creation retains semantic idempotency across normalization. Existing revision, actor, source access,
destination ownership, confirmation and cancellation rules remain in force.

Templates retain account-free levels, status and delivery defaults. Explicit unversioned v4 template defaults are
preserved; switching between the legacy level alias and a levels list replaces the previous selection atomically.
The rollback projection covers template defaults as well as sources. Unrepresentable new settings retain the
existing fail-closed legacy projection. Caller-supplied rollback data never supplies account authority.

The notice reaches History, the shared CSV/Sheets table, evidence and real English/Arabic Excel and PDF artifacts.
The optional notice column is limited to new v4 snapshots, includes its header in cell limits and carries the notice
once per delivered table. Retained legacy table layouts remain unchanged. Arabic catalog and generated chunks include
the label; native-speaker review remains planned for Round 4.

Local regressions exercise actual native request shapes, every supported stored config version, retained snapshots,
queued legacy runs, manual/scheduled claims, retries, History deletion, schedule linking, edits, idempotency, failed
transactions, read-only authorization, templates and actual bilingual artifacts. This implementation record does not
assert full Round 2 acceptance. Website control/default integration, remaining reporting work, Packages D–I and final
release gates remain. Live provider and OAuth reads and actual Sheets exports are not permitted during development (plan
principle 4); live checks on staging are blocked: no staging (D20); deployment to amcp.shop and Railway is deferred by the
owner (C11, 2026-11-03: "leave the live deployment for now, push to github, live deployment in a later stage").
