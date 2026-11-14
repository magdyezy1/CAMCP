---
status: record
tier: engineering
---

# Round 2 report editor integration — 2026-11-05

The report builder writes explicit Overview v4 configurations. Each selected account has its own reporting levels,
exact string IDs, configuration statuses, activity filter and measurement options. Available levels, defaults and
option names come from the server's source declarations. Changing one account cannot overwrite another account's
scope. Unchanged platform-wide objective and native metric controls retain differing saved account choices.

New reports use v4 defaults. Legacy definitions retain their original all-status, non-delivered-only population and
provider-configured campaign attribution when edited. An unknown completeness declaration stays unknown; the editor
does not declare a window complete. An exact Meta action is optional, allowing the platform goal to choose results.
Account-free templates preserve levels and measurement defaults without retaining account or entity IDs. An
unavailable saved account retains its configuration for the server's access check.

Pulling an unchanged saved view runs that definition by ID, enabling its durable migration notice. The response gives
the current view revision, so the editor can save a later edit without conflicting with its own automatic migration.
Server-owned notice eligibility survives an equivalent fallback edit; a client-supplied migration flag cannot create
a claim. The first completed capture displays the retained notice in results and History. Later captures do not repeat
it. Retained snapshots and exports continue to use their recorded setup when the editor changes.

Source cards distinguish native rows at requested levels, supporting reads, constructed rolled-up rows, rows after
source filters and rows after objective filters. Empty results distinguish known exclusion from scope that could not
be checked. Derived parent totals are labelled as rolled up from the selected descendants. A terminal collection job
replaces a stale running label, while a completed or partial capture keeps its data state if a later delivery fails.

The delivery dialog loads its authored script and Arabic chunk only when opened, including explicit export and
delivery deep links. Navigation, identity, selection, snapshot and language changes fence delayed rendering. A dialog
refresh immediately disables old controls until the replacement handlers bind, preventing stale consent handlers
from silently discarding a click. Failed refresh closes the inactive dialog so it can be opened again.

English and Arabic controls use the existing escaped markup and design tokens. The builder loads the separate source
settings module; the report library does not acquire that eager dependency. Route budgets, security policy, consent,
provider limits and existing test oracles are unchanged. Arabic wording still needs the planned native-speaker review.

Focused local tests cover per-account preservation, scopes, defaults, templates, fallback edits, lazy-loading fences
and dialog refresh. Synthetic browser journeys exercise the real editor, HTTP routes and worker in English and Arabic
at desktop and 320-pixel mobile widths, in light and dark variants. They check selected-ad ancestor arithmetic, exact
IDs, template reuse, once-only migration notices, revision-safe edits and the existing snapshot-bound export consent
flow. Loopback HTTPS avoids external script injection observed on this machine's HTTP fixture; attempted external
requests remain blocked and fail the check. No security software is disabled.

These are local implementation checks, not full Round 2 acceptance. Fresh filtered qualification, remaining reporting
packages, components/navigation and the final browser/container/MCP/evaluation/publication gates remain. Live provider
and OAuth reads and actual Google Sheets exports are not permitted during development (plan principle 4); live checks on
staging are blocked: no staging (D20); deployment to amcp.shop and Railway is deferred by the owner (C11, 2026-11-03:
"leave the live deployment for now, push to github, live deployment in a later stage").
