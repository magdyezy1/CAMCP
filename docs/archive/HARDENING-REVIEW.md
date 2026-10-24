---
status: archived
tier: engineering
---

# Railway repair and compatibility hardening

**Archived on 2026-10-22** (DOC-03, owner decision P12): kept as it was written, with links to current addresses.
For the current controls see the [threat model](../review/THREAT-MODEL.md), [OAuth hardening](../OAUTH-HARDENING.md)
and the [findings register](../review/FINDINGS.md); new hardening is recorded there, not here.

The Railway build rejected Dockerfile `VOLUME`. The image now leaves persistence to a Railway service volume mounted at `/data`. CI rejects reintroduction of that Dockerfile instruction, builds the image, and exercises the website, MCP authorization, persistent sessions, token revocation and non-root volume access. Configure `PORT=4317` and domain target port `4317`.

The external review was assessed against the implementation and captured evidence. Its abbreviated examples are not complete response fixtures. This release does not assert complete AMCP or live-provider equivalence.

| Review topic | Decision and implementation |
|---|---|
| W1: ignored envelope fields | Fixed native Meta `fields`, documented top-level native/path fields, Meta batch inputs, Snapchat reporting limits, X JSON bodies, and result projection. Every declared direct property now has a handling classification. Unsupported curated preflight/context options, LinkedIn form tunneling and unrecognized top-level inputs fail explicitly. |
| W2/W4/W6: exact platform preview envelopes, empty-body and X alias conventions | Deferred the broad format replacement. AMCP retains its existing local compiled-plan preview, including evidence and `executed:false`. The available captures support four request-routing comparisons, not full six-platform preview equivalence or successful preflight receipts. |
| W3: canonical action names | Native plans use the captured canonical name. Google legacy adapters retain their explicit legacy name and independent-design evidence. |
| W5: Snapchat account/body injection | Preserved supplied request bodies and verified the captured campaign-create body. No speculative injection of account fields into unrelated endpoints. |
| W7: introspection projection | Already correct; added service-level regression checks proving full LIST_ACTIONS and DESCRIBE_ACTION payloads survive projection options. |
| W8: fixture verification | Added sanitized captured routing fixtures and executable replay of full captured introspection payloads. Missing full preview fixtures remain zero; the test harness does not invent missing observations. |
| W9: Google legacy live mutations | Already blocked by the central policy and shipping runtime. Added a confirmed legacy mutation regression proving zero vendor calls. No flag was added to enable unverified live writes. |
| W10: measured status | Reports replay the fixtures before recording counts. Catalog size, local routing tests and live-equivalence verification remain separate. |

## Parameter behavior

Use `params` or `query` for native query fields and `payload` for native request bodies. Documented top-level native fields are supported when the captured action declares them; required path placeholders also resolve from top-level values. Conflicting aliases and malformed bags fail before credentials or vendor access. GET/HEAD requests omit empty payloads and reject nonempty payload fields rather than silently losing them.

Meta `fields` selects native Graph fields; `result_fields` shapes the MCP response. On other gateways, `fields` aliases `result_fields` unless the selected action declares a native `fields` parameter. Meta field arrays serialize as comma-separated selectors. `result_fields` accepts record fields and dotted object paths. Projection works on recognized data/list/result envelopes, after pagination and account ownership observation. It never changes native requests.

`compact` removes null, empty-string and empty-object values from records, retaining zero, false and empty arrays. `max_items` caps each result array. Failure records survive the cap, so an array containing failures can exceed the requested limit. Errors, partial-failure diagnostics, warnings, and pagination metadata remain intact. A capped response sets `truncated:true` and `response_truncated:true`; this is a response limit, not a substitute for vendor pagination. Dry-run and introspection payloads are not projected.

Curated campaign/ad-set/creative/context preflight, automatic Meta Page Access Token selection, regional Amazon routing and the DV360 validation escape hatch are not implemented. Explicit requests for unsupported behavior fail; false preflight-bypass flags leave the default safety policy in place. Supplying a Meta `page_id` as a path parameter does not imply token selection or prove access to that page.

## Evidence and limits

`npm run report` replays 33 frozen catalog pages and 20 frozen DESCRIBE_ACTION payloads across Google Ads, Meta, TikTok, Snapchat, LinkedIn and X. Four sanitized Meta/TikTok/Snapchat/X preview fixtures compare canonical action, HTTP method, resolved path, query and body. Their provenance records the source hash and account-ID substitution; headers, outer envelopes and preflight receipts are outside these comparisons. Google and LinkedIn have zero successful preview-routing fixtures in this set.

The machine-readable counts are written to `.mirror/REPORTS/compatibility-verification.json` and included in the implementation status report. Full preview-envelope equivalence and live-equivalence counts remain zero. Automated checks use local mocks or frozen evidence and make no advertising-platform writes. Production OAuth acceptance and full platform/workflow qualification remain outstanding.

## Security and reliability review (2026-09-28)

A second review covered the threat model, the controls reached through MCP, the website and the engineering
workflow. Its records are in `docs/review/`: [findings](../review/FINDINGS.md) with severity and status,
[threat model](../review/THREAT-MODEL.md), [MCP read/write calibration](../review/MCP-SECURITY-CALIBRATION.md),
[accessibility](../review/ACCESSIBILITY.md) and the [progress log](../records/PROGRESS.md) with each batch's evidence and
qualification. Every behavioural change came with a test that failed before it and passed after, and each batch was qualified
with `npm run check` and `deploy/check-railway.mjs` in a fresh sanitized release candidate.

| Area | Decision and implementation |
| --- | --- |
| Spending and activation | Numeric statuses count as activation for owner policies and spend confirmation (F-01); Reddit `goal_value` is counted by budget policies (F-02); delivery edits of existing entities need `spend_change_confirmed` by structure, not by field-name text (F-03). |
| Who confirms a spend change | `amcp_campaign` no longer pre-fills `spend_change_confirmed` or `confirmed` (F-05); `prepare` announces every acknowledgement execute will need in `execute_requirements` (F-06). |
| Request integrity | Enhanced-mode `native_request` is refused in `amcp_write`, since it lets a caller choose action and path independently (F-07); dot segments are rejected before scope checks (F-20); GCM tag length is checked (F-19). |
| Emergency stop | The owner can pause and resume every reviewed write at runtime with a reason (`pause_writes`, F-24); reads, reviews and verification continue. |
| Sign-in and MCP OAuth | Rate limits attributed to the resolved client address, with trusted proxies set by the operator (F-08); two-step codes limited per person (F-09); recent sign-in kept across workspace switches (F-10); client registrations pruned (F-11); per-kind challenge caps (F-12); email flows that do not wait on delivery (F-13); reviewer sessions scoped to themselves (F-14); HSTS/COOP/CORP everywhere (F-17); code replay revokes its tokens and expired grants are pruned (F-25, part); idle sign-out after two hours and security-change emails (F-25); the administrator and reviewer passwords use the account-password scrypt parameters, are checked off the event loop, and a new one ends the sessions and MCP access issued under the old (F-16). Details in [OAuth hardening](../OAUTH-HARDENING.md). |
| Authenticated `/mcp` (SEC-02, review 2026-10-08) | One POST could carry a JSON-RPC batch of tens of thousands of `tools/list` calls (a 40-item array returned about 5.7 MB), and nothing limited a key's rate or concurrency. JSON-RPC arrays are now refused with HTTP 400 and `-32600` (`BATCH_UNSUPPORTED`) before any item runs (`AMCP_MCP_BATCH_MAX`, default 1; up to 10 items for protocol 2025-03-26 only if the owner allows it). Each actor (an OAuth connector or API key, never an address) gets 60 requests a minute after a burst of 20 through a token bucket shared in SQLite, and 4 requests in flight per instance; beyond them, HTTP 429 with `Retry-After` and `data.code: RATE_LIMITED`. Refusal log lines add a coarse body-size class. Owner decision D6; tests: `tests/mcp-request-limits.test.mjs`. |
| Provider content | Reads are audited by size, hash and row counts instead of content (F-18, part); `meta.untrusted_paths` names where provider text can appear (F-22); Drive inspection is streamed and bounded (F-21). |
| Refusals | Expired reviews return the re-prepare call (F-27); campaign plans pass `account_id` only where declared (F-26); most refusal codes name their own next step (F-28); `RESOURCE_SCOPE_REQUIRED` names the ownership read (F-70, part). |
| Structure | 57 reviewed write families are declared once and reached through a typed registry, proven equivalent by replaying 40,624 recorded calls (F-59, F-60, part); Prettier formatting proven by syntax-tree equality (F-62). |

The owner's decisions of 2026-09-28 are applied (caps that ask rather than fail, confirmation by field name, idle
sign-out and security emails, encrypted-only backups and purge on disconnect, pending invitations, the QR encoder,
Google Ads v25 and Meta v26.0); [the owner summary](SUMMARY.md) lists them with what remains. Still open: the
LinkedIn and Criteo version moves (their documentation is outside this environment's network policy), the remaining
registry work, and the items [the roadmap](../review/ROADMAP.md) lists.

