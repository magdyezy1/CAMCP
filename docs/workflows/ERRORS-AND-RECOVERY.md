---
status: reference
tier: operator
---

# Errors, run stops and next actions

How AMCP reports a refusal or failure, what to do next, and the recovery guidance in both languages. Sections of the [workflow guide](../PRODUCT-WORKFLOWS.md), moved here with their text unchanged on 2026-10-24 (DOC-03).

The website presents every refusal through one layer in `web/app.js` (WEB-03). An error shows its message, what to do,
the provider's facts and AMCP's request reference as separate parts: each part on its own line in an alert, one line in
a short notice. The server writes its remedies for MCP clients as well as people; a remedy that names tool, action or
argument names, `details.*` paths or "send the call again" is replaced by the page's own wording for that code (for
example `REVIEW_EXPIRED`, `APPROVAL_REQUIRED`, `PLAN_CHANGED`, `STATE_TARGET_MISMATCH`) or, failing that, for its remedy
category, keeping a leading "Nothing was sent" and the safety facts the remedy states (a change whose outcome is not
confirmed is never sent again; a failed or incomplete read never authorizes a change). A remedy written for people is
shown as written, in the interface language. A refusal classified by the provider-error layer says who must act
(reconnect the login, the account's provider administrator, the deployment owner, wait for a rate limit). For a provider
refusal (the provider's answer, or a `PROVIDER_` code with the provider's HTTP status; not a link, Drive or AMCP status)
the page shows only allow-listed facts (owner decision D21): the HTTP status, the provider's error code and its request
ID when they are well-formed; never a provider body, message or token. The server's exact code, message and remedy stay
under **Technical details**. A few codes whose server wording is right for an MCP client but technical for a person are
always said in the page's words (design review 2026-10): `WRITE_OUTCOME_UNCERTAIN` says the provider's answer was lost,
that AMCP never sends the change again and that a read-back checks the account, without "a new idempotency key".

A campaign run says what its stop means and offers the one control that continues it, never the raw `run.stopped` code:
**Continue the run** after a pause to stay responsive or a step not sent, **Read back** while a step settles, **Correct
blocked step**, **Check the provider**, **Compare observed values** or **Open Operations** for a step that needs a
person. A stop for a spending, cap, creative-edit or (when the owner turned it on, WRT-09) deletion acknowledgement
shows that step's review on the page with its consents unchecked; executing it sends exactly that review and key. A step
that waits for a person's website approval or the owner's (WRT-09) says nothing was sent and links its approval page;
nothing continues the run before that approval. `APPROVAL_REQUIRED` and `PLAN_CHANGED` offer **Review plan approval**,
`REVIEW_EXPIRED` and `STATE_CHANGED` offer **Prepare again**. A plan approval older than 24 hours, counted on the
server's clock (from the `Date` of AMCP's responses), is no longer offered as **Run**: the page says it expired and
labels the review **Review whole plan again**. A step the person executed that did not complete is never announced as
"Saved.": the outcome says its answer was lost (uncertain) or that it did not complete (failed), and the plan's
emphasized action becomes **Read back submitted step** or **Correct blocked step**. Executing a review with an
authorization not ticked is refused beside the boxes, which are marked invalid, and the first takes focus; ticking it
clears the refusal (it was a passing toast that repeated the box's label). A review of an account without a spending
policy says so in the page's words and, for the owner, links the policy form; the server's advice names an MCP tool
and is not shown. The report builder shows a Pull or Save refusal next to its run bar,
focused and scrolled into view; a Pull with no account, or a custom range that ends before it starts, is refused there
before anything is sent. A JSON field that does not parse names the field. Owner Settings, recipe, account-approval and
media-job errors keep their remedy and request reference.

### Shared recovery guidance in your interface language

All 122 static shared recovery hints now have authored Arabic, including media/upload handling,
recipe inputs, review/idempotency, connection discovery, report tasks, owner controls and delivery.
The formatter retains the native reason, code, reference and retry metadata. Unknown text stays
literal. A 403 remains a provider access denial and does not establish a missing OAuth scope.
A translated instruction does not start a reconnect, grant access or retry an uncertain write.
See [delivery](../records/DELIVERY-2026-10-05-SHARED-RECOVERY-GUIDANCE.md) and the
[current completion walkthrough](../CURRENT-READINESS.md).

### Recovering other workspace forms

A current unhandled workspace form error now stays in a described alert inside the form, with
its original reason, recovery guidance and reference. Your settings are not reset by the shared
handler. Editing or another explicit submit clears the message; edits make no automatic provider
call. Failure responses from an obsolete identity, selection or attempt stay silent. Follow the actual
recovery guidance before continuing; an uncertain submitted write still needs its original receipt
and reconciliation. GTM audit and LinkedIn conversion settings qualify explicit read-only recovery,
while configuration remains distinct from live event delivery or historical attribution.
See [shared form feedback](../records/DELIVERY-2026-10-05-WORKSPACE-FORM-FEEDBACK.md).

LinkedIn conversion tables keep rule names and IDs in a readable column and preserve literal
native IDs, types and exact amount/currency together. Use the named scroll region to inspect all
columns; configuration values and unknown measurement claims retain their original meaning.

## Account inventory recovery language

The six supported inventory collectors and dispatcher now require Arabic for all 131 selected
AMCP-authored direct refusal/instruction sentences. Native/dynamic diagnostics and original
codes/IDs/amounts/selectors remain separate. The existing persistent described form alert retains
reason, recovery hint and reference; edit clearing makes no new read. See [account inventory diagnostic evidence](../records/DELIVERY-2026-10-05-PORTFOLIO-DIAGNOSTICS.md).

## Effective operation help and inventory read recovery

amcp_tool_help with gateway and operation now normalizes the eight original versioned Google/Meta
captured descriptions to the configured effective API version. Known uncaptured original catalog
actions expose their effective route/method/required fields and risk flags with an explicit
extended-schema-unverified qualification. Canonical action names, input schemas and native write
qualification remain separate. Unknown/nonversioned/independent help retains its previous boundary.

A malformed native inventory response now identifies provider-owned recovery: keep the original
selected account/hierarchy, retry that read once, and report the original request ID if it recurs.
Its authored Arabic hint is required by the existing locale gate. No elapsed time, edit, navigation
or help read triggers an automatic provider retry. See [operation help and inventory recovery evidence](../records/DELIVERY-2026-10-05-DISCOVERY-RECOVERY.md).
