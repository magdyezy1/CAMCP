# Conditional programs, repeated budget evidence and client parity

Batch 190 continues the implementation against `bf84eabc2368010b1a60932c4035d2a3906b0f5f`.
The sole checkout is CAMCP-Codes-final-branch and the sole push target is
magdyezy1/CAMCP, branch Work-here. Shopify, Salla, WooCommerce and Criteo expansion
and live acceptance are parked by the owner's latest instruction. Existing
commerce regressions remain release gates. Hosted Actions remain owner-waived.

## Conditional workflows that can actually be inspected

`src/conditional-programs.ts` registers three existing, independently classified
native-read contracts in the same capability graph used by the website and MCP:

| Workflow | Existing native read | Qualification boundary |
| --- | --- | --- |
| `program:linkedin_forecast` | `linkedin_rest_media_planning_post` | One exact account, audience, forecast metric, future period and USD budget; no campaign or saved media plan |
| `program:linkedin_audience_insights` | `linkedin_rest_targeting_audience_insights_post` | One exact account and aggregated targeting/grouping request; no audience write or member records |
| `program:dv360_advertiser` | `DV360_ADVERTISERS_GET` | One configured advertiser, with exact partner/currency/status; no line-item or report-job access inference |

Discovery includes required inputs, contracts, recorded scopes, distinct private
product/customer requirements, primary references and exact account-bound next
calls. Program requirements remain visible when no account is connected. An
ordinary account read does not become program entitlement evidence. Native
`DESCRIBE_ACTION` and operation help add `amcp_conditional_program`; captured
catalog flags and action/write classifications are preserved.

`amcp_workspace` adds `program_check`. Its default local inspection sends no
provider request. Explicit `live:true` requires the exact configured account and
login and one program's validated inputs. Caller URLs, headers, arbitrary native
actions, implicit account selection and extra request properties are refused.
Recorded scopes, actor/account access and credentials are fenced before and
after native collection. One shared budget bounds the operation to three
attempts, 1,000 rows, 2 MiB and 30 seconds. Partial, failed, malformed, truncated
and paginated evidence cannot become a successful observation.

Successful results whitelist only the supported forecast point, aggregate
audience segments or advertiser identity fields. Extra provider properties,
member-like fields, native billing data and raw upstream error bodies are not
projected. Every retained result/reference identifies its original request and
observation time. The returned entitlement remains `unverified`: one accepted
request establishes only that exact observation. No workspace qualification
document, draft, approval, job or provider mutation is saved by this workflow;
ordinary native-request audit recording retains its existing behavior.

Forecast inputs preserve exact USD micros and require positive geographic
targeting. Results must contain distinct valid budget points and the exact
requested point; AMCP never interpolates a missing point. Native bounds remain
optional and cannot contradict a value. Estimates remain directional.

Audience Insights has guided geography plus one professional attribute, the
documented grouping choices and an optional exact native-JSON editor. Switching
modes disables inactive required controls without discarding entered values.
Native omitted/suppressed audience groups stay unavailable. A reported zero
outside the supported audience range does not prove an empty audience, and the
large-audience count can be approximate. Supported segmentation count and
integer percentage fields are preserved without summing overlapping segments.
Documented positive totals below 300 and returned segments below 30 are refused,
rather than mislabeled as observations inside the supported audience range.

The website renders readable evidence, captions, row/column headers and named
keyboard-scrollable tables in English and Arabic. A result cannot cross an edited
form, account/login change, navigation generation, detached view or newer
request. Opening a handoff never initiates a provider read.

## Actual discovered-account evidence

Both configured LinkedIn accounts, `513006454` and `559535022`, return native
HTTP 403 `PROVIDER_ACCESS_DENIED` for the exact Media Planning and Audience
Insights requests. These replies explicitly have `scope_denial:false`.
Application provisioning versus member/account role has not been independently
identified; HTTP 403 is not relabeled as a missing OAuth scope.

The owner selected `559535022` for subsequent read-only acceptance. Its ordinary
account readiness read succeeds, reference
`c72a763a-8d8a-48dd-ade9-0cd687ebb362`. Its private program denials remain separate:
forecast `e69da1d7-8cea-4891-abfe-ed493f0514b7`, Audience Insights
`e1df0d27-9daa-48ab-bf8f-ee391bf8ac44`. DV360 configured-account discovery returns
zero bindings, reference `5456b050-0d4e-4b0a-93ce-3afa7e8cec47`; the owner confirms
no DV360 advertiser yet. No grant, account setting, credential, campaign, upload
or delivery destination is changed. These calls exercise the existing native
gateway, not a live acceptance run of the new `program_check` wrapper.

Primary requirements checked on 2026-10-06:

- [LinkedIn Media Planning](https://learn.microsoft.com/en-us/linkedin/marketing/media-planning/media-planning-api?view=li-lms-2026-09): private application product, account/member access, no additional forecast OAuth scope, eligible geographic audience, future bounded period and USD minimum.
- [LinkedIn Audience Insights](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/audience-insights-api?view=li-lms-2026-09): separate private application product, access role, targeting requirements, suppression/range and grouping semantics.
- [Saved LinkedIn media plans](https://learn.microsoft.com/en-us/linkedin/marketing/media-planning/media-plan?view=li-lms-2026-09): a different persisted workflow and permission; not created here.
- [DV360 access](https://developers.google.com/display-video/api/guides/getting-started/overview) and [advertiser read](https://developers.google.com/display-video/api/reference/rest/v4/advertisers/get): user/customer access and OAuth scope are separate.
- [Bid Manager](https://developers.google.com/bid-manager): separate reporting service/scope. Creating or running native queries is not authorized by the current read-only account instruction.

## Repeated selected-budget observations

The extracted `src/google-allocation-budgets.ts` repeats the complete selected
Google campaign/budget read under one collection budget before a proposal can
be retained. Both observations must have the exact selected cardinality,
campaign/budget resource identities, currency/timezone, daily mode, dedicated
ownership, safe exact micros and supported native state. An in-flight supported
state change refuses the preview. Row order alone is not a change. The operation
is bounded to ten attempts, 100 collected rows, 2 MiB and 60 seconds.

Snapchat now repeats every selected ad-squad budget in addition to its existing
parent/account brackets. Current daily-mode, lifetime/shared-mode refusal,
ownership, exact native minimum, collection ceilings and original connection
guards remain. LinkedIn's existing repeated independent-budget/group/account
checks remain unchanged. Native prepare/execute retain the original spending,
approval and accepted-receipt recovery rules. Two consistent sequential reads
do not establish an atomic snapshot or qualify another budget provider.

## MCP discovery and Arabic policy parity

The server previously returned raw general help in JSON text while its structured
result wrapped that help in `{success:true,data:...}`. It now uses one presented
envelope for both. Existing successful/error envelopes retain their shape;
general discovery clients now read `data.surface`. The HTTP health probe checks
the same envelope and exact serialized parity. Real HTTP and in-memory SDK
regressions preserve bearer/origin/body limits, current key revocation and health
privacy. Clients caching older tool enums must refresh their definitions or
reconnect before using the new `program_check` action; existing captured native
actions remain independently discoverable.

The owned Terms/Data deletion pages and authentication legal links now follow
the active English/Arabic language and direction. Both deployment write modes
retain the same authorization/policy distinctions. Capability prerequisite,
lifecycle, contract-status, evidence-column and all 26 exact AMCP-authored
contract explanation messages are inventoried and translated. Unknown or mixed
native text remains literal. Required API identifiers, units, hashes, enum
values and request bodies are never translated.

All 8,240 preceding Arabic pairs are preserved; 249 entries are added. That batch
catalog has 8,489 entries, with 8,310 required authored messages and no
locale problems. The maintained backend inventories contain 435 source files,
1,304 selected direct reasons and 2,635 qualified wrapper reasons. Original
field/quantity/example preservation checks remain mandatory.

## Qualification and pending release gates

The first fresh public-only candidate completes 5,058 main tests with 5,050
passes and eight retained failures. They reproduce stale help-envelope, legal
language, inventory-count and repeated-budget expectations, plus an unanchored
`sku` scan that can match random encrypted bytes. The corrected privacy test
still refuses raw credential/native markers and actual SKU/permalink JSON keys;
it does not treat arbitrary ciphertext substrings as plaintext fields.

All 155 related HTTP/SDK/localization/allocation/privacy checks pass after those
repairs, with zero failures, cancellations or skips. The program SDK journey
uses nine tool calls, 63,738 structured response bytes, one synthetic native
read and no provider writes. Earlier 12-case program prototypes pass their
original guided/native result, stale response, keyboard, reflow and selected
automated accessibility assertions. Prototypes are not the complete release.

At batch 190 preflight, the maintained full browser suite had 584 cases: all preceding 560 plus 24
conditional-program success/denied/stale cases. It retains the existing actual
served API assertions, English/Arabic at 320/375/768/1280 pixels, semantic and
pinned selected A/AA inspections, and explicit incomplete/manual evidence.
Fresh public-only full checks, generated report freshness, Railway compatibility,
complete browser results and final committed-source/payload verification remain
required before the sole authorized push. No full WCAG, physical assistive,
Linux host/image or positive private-program entitlement result is inferred.

The [15-package acceptance audit](../archive/COMPLETION-2026-10-07.md) separates code,
external acceptance, provider expansion and parked work. B25 advances from Open
to Partial because three concrete program workflows and positive/refusal local
contracts now exist; successful live entitlement remains blocked. The other
partial rows are not relabeled complete merely to reduce a count. The current
matrix is 13 implemented / 15 partial / zero open.

## Completed preflight and final frozen-source continuation

The repaired second fresh public-only candidate passes all 5,058 main tests and
four capture tests with zero failures, cancellations or skips. Offline install,
build, report regeneration/freshness, every default-check stage, required FFmpeg
and Railway compatibility all exit zero. It includes 1,932 public source files
plus one generated empty sample; manifest hash
`554848daa7662e600e68c3456770c6bc12b78849bfcb600c501efe187ebd6080`.
The index contains 357 documents. All three public reports regenerate
byte-identically, without reading private root environment/report inputs.

The first full browser attempt retains 268 passing cases and no failures before
an explicit interruption. Its Arabic file used CRLF while committed Git uses
LF, so it is incomplete proof and is not presented as a completed release run.
Normalization preserves all 8,489 parsed values and every earlier 8,240 pair.
The final boundary review also verifies the documented audience minimums against
the primary reference and adds eight total/segment boundary cases in one test.
All 15 program/UI/real-SDK checks pass, including schema/text parity, exact
handoffs and zero native mutations. This later sample uses nine tool calls,
63,740 structured bytes and one synthetic native read. The earlier byte count
is retained as its own measured sample, not a constant performance guarantee.

The original rendered gate selected 584 cases. Batch 191 expands the maintained
matrix to 1,184 with light/dark coverage and native-detail immediate export.
Final clean committed-source full/report/FFmpeg and that complete expanded
qualification remain the publication gate for these later changes. Public
pre-release health independently reports database/disk/MCP up and exact healthy
`bf84eab` packaged source; anonymous `/api/session` is HTTP 200. A mistyped
`/api/auth/session` diagnostic returns 404 and is not an application login
failure. Neither public probe submits a form/password or changes an account.

## Completed October 7 qualification

The fresh public-only v8 candidate on exact source `5723ee6080419abd3b2fa549971776a940a19b28`
passes **5,077 main tests and four capture tests**, with zero failures,
cancellations or skips and required FFmpeg. Offline installation, compilation,
report regeneration/freshness, every default-check stage and Railway
compatibility exit zero. The candidate has 1,941 public sources plus one
generated literal empty sample and no environment file. Its manifest SHA-256 is
`6fb9435659c5b12ae33654cf37132def1fd6a85dfb45d8c840ee5c5f71e9e483`.
All three generated public reports are byte-identical to committed Git.

The complete maintained browser run on clean source
`78637435df81d8237f107c4b3e2994b0fe85555d` passes **1,184 of 1,184 cases**:
592 in each language and appearance, with 340 at 320px, 252 at 375px,
252 at 768px and 340 at 1280px. All sixty populated fixtures use every width;
selected empty authentication/workspace baselines use narrow/wide layouts.
It started at `2026-10-07T01:03:04.978Z` and finished at
`2026-10-07T02:02:05.697Z`. The actual runner, fixture, website and
hash-pinned axe-core 4.14.0 sources match the frozen record. Sixty-one fixture
lifetimes retain their actual tenant identities; shared tenant identities never
overlap, and at most two fixtures are active. An initial proof-summary check
incorrectly expected equal counts at all widths; the original maintained matrix
and its 1,184 passes remain unchanged, and that failed assertion is retained
separately. All sixteen detailed-report
journeys preserve the original Sheets tab, create no schedule, preserve inputs
on appearance changes and explain the exact purchase action mapping.

The preceding complete browser run retains 1,183 passes and one failure:
independent fixture stores reused one tenant identity, so the existing tenant
report-generation budget correctly returned HTTP 429. Qualification now
serializes those fixture lifetimes by their actual tenant identity. The
production one-per-tenant/two-per-process generation limits, cases and
assertions are unchanged. The separate 32-case shared-tenant prototype passes
before the complete rerun. The earlier four measurement-disclosure target-size
failures and original preflight failures remain separate historical evidence.

The fresh v9 source/report/format/web/docs/Railway gates also pass on the
browser revision; its manifest SHA-256 is
`a480368195155c5f2a0c7bd5fbf3bb24211baa0f8606cce42a956edb2c14ec29`.
All 1,941 actual public source files match it. Its packaged application is
byte-identical to the full-suite candidate: 1,354 files / 52,393,204 bytes,
SHA-256
`c89e86cdf121cfb402c2046de52fe00b59fa5816a70c4a94d44ab32063322338`.
The full suite and browser remain bound to their respective actual revisions;
neither is represented as running on a later documentation-only commit.

The completed browser/retention proof is
`final-browser-retention-qualification-v2.json`, SHA-256
`4a1aee6f3b4dad8207fffcb06ba5b03dbf52c4d5de98dcf4cc283b7be5fecc7e`. Qualification records are retained locally under
`.runtime/completion-20261007/`; they contain no production upload or native
mutation. Root `.env` and the private root live-read sample remain unread.
Hosted Actions are neither run nor queried. The subsequent documentation-only
release must independently pass fresh public-source/report freshness and
packaged identity verification before the sole Work-here push.

These results qualify isolated Windows services, synthetic provider/Sheets
fixtures and selected automated accessibility checks. They do not certify live
Sheets delivery, native writes, private-program entitlement, a Linux/container
image digest, production load, every external MCP client or complete manual and
physical-assistive accessibility. Deployment observations remain separate from
the earlier healthy `bf84eab` pre-release snapshot.

Selected LinkedIn 559535022 still has the previously recorded ordinary-account
read and separate private-program 403 denials. No positive private entitlement
is inferred from local success or other report reads. No DV360 advertiser is
configured. The owner-authorized account-read boundary and parked four commerce
providers remain unchanged.
