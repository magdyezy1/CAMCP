---
status: record
tier: engineering
---

# Administrator WooCommerce source setup and local removal

Batch 184 adds the missing administrator path between a merchant's existing WooCommerce Read key
and AMCP's selected-product, variation and published-inventory readers. The authorized source is
magdyezy1/CAMCP, branch Work-here, in CAMCP-Codes-final-branch. All setup/removal qualification
uses owned synthetic stores. No real account, store, OAuth binding, report destination or key changes.

## Operator workflow

Open Commerce as a workspace owner or administrator. In Store connections, enter a plain label,
the exact public HTTPS origin and an existing Consumer Key/Consumer Secret whose merchant-side
permission is Read. Both credential controls hide their values and clear immediately on submit.
Explicitly confirm the Read permission. Setup submits once; a repeated in-flight click has no effect.
The form does not cache credentials for retry.

AMCP reads the store currency, one published-product page and the currency again. A successful
result records current product access, unchanged currency and the provider-reported published
product count. An empty published collection is valid evidence. The page explains that native key
permission is operator-recorded, rather than independently inferred from successful GETs.
This does not qualify a full inventory, future access, variants or a catalog destination.

The connection grants only AMCP read access. Its account identifier is an explicit AMCP origin
binding, not a native WooCommerce store ID. The key and setup replay proof are encrypted.
Use Refresh store list to load the new binding into Commerce; review the confirmation because
refresh clears unsaved entries. Setup never selects a store or automatically reads its products.
The persistent refresh action also permits inspecting a connection after an interrupted reply.

Local removal requires selecting the specific connection, checking the removal acknowledgement
and accepting a second confirmation whose initial focus is Cancel. It removes the local AMCP
connection, encrypted credential/proof and related retained local report data. It sends no native
request and changes neither the WooCommerce store nor its native key. Refresh the list explicitly
before another source operation. Viewer, operator and evaluator sessions cannot set up or remove
stores. Generic asset sync, discovery and write-access routes refuse commerce sources.

The official [WooCommerce REST API setup](https://woocommerce.com/document/woocommerce-rest-api/)
documents merchant-side Read/Write/Read-Write permissions and WordPress-user linkage.
[HTTPS authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication)
documents the Consumer Key/Consumer Secret Basic-authentication pair. These sources were checked
on 6 October 2026. This workflow uses an existing key; the synthetic qualification creates no
merchant-side key or user.

## Contract and limits

The website accepts exactly seven setup fields and a lowercase UUIDv4 request ID. Unknown fields,
client-supplied account/tenant headers, write grants, malformed origins or credential values are
refused. Store origins use the existing public-DNS-checked HTTPS transport with fixed native GET
paths, normal TLS verification, no redirects and no arbitrary user-provided path or method.

All three reads share 256 KiB and a twenty-second monotonic deadline. Native IDs, JSON/UTF-8,
content length, reported page counts and the currency-setting identity are validated. Unexpected
status, compression, redirect, malformed body, page inconsistency or changed currency refuses
without saving a connection. Native failure bodies and credentials never enter diagnostics or audit.
Missing encryption is a deployment setup error, returned before native credential egress.

Shared SQLite admission allows one setup per workspace and four total slots, with fifty configured
WooCommerce sources per workspace. Current authority, request cancellation and lease ownership are
rechecked through network/chunk processing and atomic persistence. A withdrawn request cancels its
body and cannot save. Connection, encrypted replay proof and audit entry commit together.

An explicitly re-entered identical request can return its original saved receipt and original
verification time with zero new native requests. Replaced credentials, changed grants, disabled
connections, missing proof or a changed request conflict rather than overwrite. A local removal
tombstone prevents an old request from recreating the connection. Setup does not change defaults,
account write policies, provider mutation contracts, destination bindings or schemas.

## Interface, localization and retained failures

Current form, request order, role, session reference, identity key and navigation generation bind
each result. Obsolete setup/removal/refresh results and errors stay silent. Receipts use a strict
public projection; native origins/currencies and source identifiers remain literal and escaped.
Credential failure retains its localized reason/code/reference until an edit or explicit retry.

Forty-six new Arabic pairs preserve all 8,144 earlier values, for 8,190 total entries. The narrow
gate requires 8,018 messages. Maintained source discovery now measures 431 TypeScript files,
175 qualified direct-reason files/1,299 reasons and 168 wrapper files/2,625 reasons. The source
tests update the measured inventory counts while preserving their ownership, native-field and
example assertions. Editorial and physical assistive-technology acceptance remain separate.

The first focused run retained a missing-encryption status mismatch; its corrected run passes all
251 focused cases with zero skips. Real-browser qualification also caught object bodies being
passed to the existing Fetch API helper. Setup/removal now send serialized JSON, and the shared
UI fixture refuses unserialized bodies. The first browser attempt is retained as incomplete; the
second completed 32 cases with 24 failures because its removal wait incorrectly expected a closed
details form to be visible. The corrected helper waits for attachment, then opens the details
before using it. Intercepted delayed responses now settle before interception cleanup, and any
interception failure remains an assertion failure.

The preceding clean a36621c source had 4,849/4,851 main tests pass: two localization inventory
counts were stale. Its maintained browser completed 487/488 cases, with an Arabic Settings
keyboard-table timeout after the earlier table check had already moved to a scroll boundary.
These are retained failures, not substituted passes. The shared keyboard helper now establishes
a deterministic starting scroll position, proves keyboard movement and restores the original
horizontal/vertical position. It retains all caption, region-name and keyboard-access assertions.

Final publication requires a fresh sanitized build/report/freshness/default full check with
required FFmpeg, the Railway configuration check, exact committed-source verification and all
512 maintained rendered cases. The expanded browser suite retains every earlier journey and adds
24 bilingual setup/rejection/obsolete-response cases. Selected automated semantic/WCAG checks
retain manual/incomplete evidence; they do not certify full accessibility or deployed acceptance.
Hosted Actions stay unused under the owner's exhausted-minutes instruction.

B21 now includes local administrator store setup/removal, but live selected-store acceptance,
additional destination/source scopes and independently qualified absence/destructive policies
remain separate. B15/B16/B24 also remain partial. The 28-package matrix remains 13 implemented,
14 partial and one conditional-program package open; external evidence is not invented to close it.
