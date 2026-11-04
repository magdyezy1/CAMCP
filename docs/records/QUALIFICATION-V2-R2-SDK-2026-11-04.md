---
status: record
tier: engineering
---

# V2 round 2 SDK foundation qualification of 2026-11-04

V2-MCP-13 is the first, isolated package of Round 2. The owner approved the SDK v2 download with the V2 plan on
2026-11-01 and requested Round 2 on 2026-11-04. Source starts at published `bdda0cbd`, on `codex/v2-round2`.
**Qualification is in progress; no Round 2 push or live acceptance is claimed.** Live deployment and provider checks
remain explicitly deferred by the owner. Other Round 2 feature packages follow this foundation's qualification.

## Dependency scope and review

The approved npm pins remain current: server, core and client 2.4.0; Express integration 2.0.2. The official
[migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html) also requires two modules
for AMCP's existing interfaces: `@modelcontextprotocol/node` 2.1.2 for Node HTTP, and
`@modelcontextprotocol/server-legacy` 2.4.0 for its authorization server. Their inclusion is an engineering consequence
of the SDK split, explained before download, with no new product capability. All six are pinned directly; the client
is a runtime dependency because the deployment's self-check uses it.

All six tarballs matched the public registry's SHA-512 integrity, file counts and unpacked sizes. Extraction rejected
links, special files and escaping paths. Installed bytes matched every reviewed package file. They use Apache-2.0
and have no install lifecycle hooks. Installation used the lockfile with scripts disabled in a fresh dependency
folder; both earlier dependency trees are preserved for rollback. No codemod or additional skill was downloaded.
The named supply-chain and differential-review skills were unavailable, so these reviews are manual.

The only other version change is `@hono/node-server` 2.1.1 to 2.1.6, required by the Node adapter; it is MIT-licensed
and has no install hooks. The old SDK and its unused schema-conversion dependencies are removed. No v1 SDK remains
in the dependency graph. The OAuth compatibility module is explicitly deprecated upstream and retains the existing
authorization implementation; replacing that server is a separate architectural change.

Public npm advisory comparison on 2026-11-04: the original production lock reports 16 affected-package entries
(13 moderate, 2 high, 1 critical); the SDK lock reports 15 (12 moderate, 2 high, 1 critical), with no new entry.
The removed entry is the Node adapter's old static-path decoding advisory. Existing findings, including proxy-addr,
body-parser and zod, remain baseline findings for scoped applicability/remediation review before final Round 2
publication. This is an advisory comparison, not a claim that every finding is exploitable or that dependencies are
free of vulnerabilities. Raw reports and the exact lock delta are retained as local qualification evidence.

## Compatibility and implementation

- Runtime, tests, evaluation and tooling import the split packages. Low-level registrations use method strings;
  callback cancellation uses the native request context. Existing behavioral and security assertions are retained.
- Modern HTTP dispatch uses the SDK's per-request handler. AMCP keeps its strict mirrored-header errors, discovery
  metadata, private cache policy, role/authority checks, modern-protocol feature flags and request correlation.
  Stdio uses the SDK factory to serve both protocol eras.
- The SDK normalizes missing-resource errors in both eras. A narrowly scoped transport adapter preserves AMCP's
  published `-32002` for unknown guides on legacy HTTP/stdio/in-memory wires; modern replies retain `-32602`. Other errors are
  untouched. The SDK's empty cancellation response is translated to AMCP's existing connection-closed result, with
  abort and in-flight accounting preserved.
- The v2 client separately reconstructs a missing-resource exception with code `-32602` and only the URI in its
  data. The introspection test now captures the incoming in-memory reply before that conversion: the legacy wire
  still carries `-32002`, URI and guide index, while the client exception is checked independently. Existing
  unknown-prompt and allowed-platform assertions remain. No compatibility assertion was removed to absorb the change.
- The synthetic OAuth client forwards the callback's already-verified `iss` to SDK v2. Issuer checks are not
  bypassed; registration, consent, resource binding, rotation, replay protection and revocation tests remain.
- D17's frozen `amcp_tool_help` input schema remains 593 bytes, SHA-256
  `076e72c8e8e6ad452d8e72cd75e0f2c02946ee36064dc7f74929e9a07839465b`, checked through actual clients in both eras
  over HTTP and stdio. The new request-context regression was reproduced before replacing the old custom bridge.

## Verification

| Check | Result |
| --- | --- |
| Original canonical evaluation | 60 runs, passed, no regressions |
| Initial compatibility suite | 46/48; exposed legacy missing-guide normalization and a missing issuer argument in the synthetic v2 client |
| Compatibility correction and real-client tests | 53/53 after preserving the legacy wire and forwarding verified issuer |
| Native request-context and cancellation regression | Reproduced missing context; native SDK dispatch plus cancellation compatibility passes 54/54 focused tests |
| Resumed compatibility checks | 44/44 across MCP/OAuth/HTTP/stdio/help/timing, including the raw legacy guide reply and normalized v2 client exception; no skips |
| Preserved SDK 1.32.1 client | Actual HTTP and stdio clients negotiate 2025-11-25, discover 25 tools, preserve the frozen help schema and retain the original guide-error code/index; no v1 dependency added |
| Latest canonical evaluation | 60 runs, passed, no fault/regressions, 7,345 ms after the shared transport compatibility change |
| Frozen help schema | Exact fingerprint preserved on legacy/modern HTTP and stdio |
| Test oracles | Passed; no allowance changed |
| Fresh filtered candidate preflight | 190 files / 1,367 tests pass, zero failures/skips; all six freshness stages pass |
| Candidate fast/static/routes | Pass; all 58 language/route combinations remain within existing budgets |
| Tool-list bytes | Unchanged: reader 94,468 and operator 97,119 bytes, 25 tools each; zero provider requests during measurement |
| Source/dependency differential review | Manual review completed for the isolated migration; 65 test/tool files verified as exact import substitutions, remaining source and SDK API adaptations reviewed separately; existing advisory remediation remains before round publication |
| Full gate/browser/container qualification | Pending after the isolated local SDK commit; preflight is not full qualification |

The broader candidate checks use a generated literal empty live sample and the reviewed v2 dependency folder.
The original live sample and protected local prompt are never read, staged or copied. No provider/OAuth/production
request, advertising mutation or real Sheets export was performed. No budget or golden was re-recorded to absorb
these compatibility failures. Final gate results and source revision will be appended after qualification.
