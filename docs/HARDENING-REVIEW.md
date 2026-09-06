# Railway repair and compatibility hardening

The Railway build rejected Dockerfile `VOLUME`. The image now leaves persistence to a Railway service volume mounted at `/data`. CI rejects reintroduction of that Dockerfile instruction, builds the image, and exercises the website, MCP authorization, persistent sessions, token revocation and non-root volume access. Configure `PORT=4317` and domain target port `4317`.

The external review was assessed against the implementation and captured evidence. Its abbreviated examples are not complete response fixtures. This release does not assert complete WhatHead or live-provider equivalence.

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
