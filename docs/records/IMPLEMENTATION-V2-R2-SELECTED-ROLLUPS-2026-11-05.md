---
status: record
tier: engineering
---

# Round 2 selected descendant rollups — 2026-11-05

Selecting ad IDs now gives requested ancestor rows totals for those selected ads, labelled **Rolled up from
selected ads**. Selecting middle-level IDs uses the corresponding child-entity rollup. A parent-only request
collects the required supporting level under the same authorized account and whole-job limits; those supporting
rows are disclosed separately and do not become requested output rows. Unsupported descendant levels and empty
provider URNs refuse at the source boundary. Provider declarations own identity aliases, including LinkedIn's
campaign-group, campaign and creative URN prefixes.

Only native child parent identities establish membership. Missing parents cannot invent an ancestor total and
keep affected coverage partial. Parent configuration status still applies to the derived row. Original parent
performance is retained only as native audit evidence; it never supplies the selected subset's metrics. Measurement
context, query fingerprint, omission flags and precision evidence come from the child read. Parent and child capture
times remain separately recorded.

Known additive measurements retain their coverage. Costs use matched spend/result populations, and currencies,
timezones, attribution and calendar periods remain separate. Mixed primary-result meanings keep distinct groups;
non-additive reach, users and frequency are not added. A derived parent is not independent provider evidence:
cross-level comparisons involving it withhold agreement/gap values with `derived_parent_population`.

Native `source_row_count` describes requested-level collection. `scope_input_row_count` describes the candidates
used for scope filtering; `derived_row_count` counts constructed ancestor rows and `supporting_row_count` describes
hidden supporting collection. These populations can differ, including when a proven parent has no native
performance row. Filtered counts therefore do not subtract derived rows from native collection counts. Source
capsules also disclose supporting levels, collection counts and their separate level results.

New v4 jobs checkpoint raw collection packets and apply scope after collection. Their server-owned scope contract
keeps previous queued v4 jobs on their recorded checkpoint behavior. A new pipeline refuses an already-filtered
retained packet before provider egress, preserving its evidence for inspection. Temporary failures in Meta's guided
read wrapper now retain retryability and allowed diagnostic facts, so supporting collection can resume without
rereading or replacing completed raw parent data. Derived rows and serialized evidence consume the existing row and
byte limits; retries do not refund earlier row consumption.

The compact/native response, web level label, shared CSV/Sheets table, Excel cells and PDF heading disclose the
rollup. Existing reports without derived rows keep their table layout. English and Arabic labels are authored;
native-speaker review remains planned for Round 4. Real Excel fixtures verify both languages without touching
an external spreadsheet. No route budget, numeric precision, architecture allowance, security assertion or tool
golden was relaxed.

Targeted native-transport and arithmetic regressions cover selected/unselected siblings, requested and supporting
levels, missing native parent performance, unknown parent identities, LinkedIn aliases/hierarchy, raw checkpoint
retries, mixed-pipeline refusal, measurement provenance, coverage, mixed meanings, currency/window separation and
row/byte limits. The subsequent [filtered qualification receipt](QUALIFICATION-V2-R2-SELECTED-ROLLUPS-2026-11-05.md)
records the passing checkpoint. This is not full B/C or Round 2 acceptance.
Automatic legacy migration, schedule/template/UI completion, remaining packages and final release gates remain.
Live provider and OAuth reads and actual Sheets exports are not permitted during development (plan principle 4); live
checks on staging are blocked: no staging (V2 plan D20); deployment to amcp.shop and Railway is deferred by the owner
(2026-11-03: "leave the live deployment for now, push to github, live deployment in a later stage").
