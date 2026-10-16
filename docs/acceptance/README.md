# Acceptance runbooks

How the owner runs each live, deployed or manual acceptance of the 2026-10-08 engineering review (ACC-01 to ACC-08)
quickly and safely, and where its result is recorded. Every harness in `tools/acceptance/` runs as a dry run by default:
it prints the plan and makes no request. Nothing here has been run live; each acceptance stays open until the owner
authorizes and runs it.

| Acceptance | Runbook | Harness | Effect when run live |
|---|---|---|---|
| ACC-01 zero-spend reviewed-write loop | [Write acceptance](WRITE-ACCEPTANCE.md) | `tools/acceptance/write-acceptance.ts` | Paused provider writes on a designated test account |
| ACC-02 AI-client interoperability | [AI-client matrix](CLIENT-INTEROP.md) | `tools/acceptance/client-interop.mjs` | OAuth registrations and MCP reads on staging only |
| ACC-03 live Sheets delivery | [Sheets delivery](SHEETS-DELIVERY.md) | `tools/acceptance/sheets-delivery.mjs` | One Sheets write to a disposable AMCP-created file |
| ACC-05 provider access and ledger | [Provider access register](../PROVIDER-ACCESS.md) | `tools/acceptance/ledger.mjs`, `tools/acceptance/provider-access.mjs` | None: local files |
| ACC-06 read-only acceptance | [Read acceptance](READ-ACCEPTANCE.md) | `tools/acceptance/read-acceptance.mjs` | Bounded provider reads on designated assets |
| ACC-07 assistive technology | [Assistive-technology checklist](ASSISTIVE-TECHNOLOGY.md) | `tools/acceptance/assistive-results.mjs` | None: synthetic data only |
| ACC-08 LinkedIn programs and DV360 | [Provider programs](PROVIDER-PROGRAMS.md) | `tools/acceptance/program-recheck.mjs` | One bounded read per program |

## Rules for every acceptance run

- **Authorization.** The owner authorizes each run in writing, naming the action, the designated account, property or
  file, and whether it is a read or a write. One authorization does not extend to a later run. The harness takes the
  authorization's reference (`authorization_ref`), never the authorization itself.
- **Explicit flags.** A harness sends nothing unless every flag its runbook names is set: `--live`, the
  authorization reference, and the SHA-256 of the exact plan file the owner approved. A missing or different flag is a
  refusal before any credential or plan is read.
- **Identity.** Record the release identity: the `/versionz` revision and package hash, the date and the API version.
  The ledger refuses a row without them.
- **What to store.** Only redacted, bounded evidence: status codes, provider request IDs, receipt and read-back
  references, response-shape fingerprints. Never tokens, cookies, HAR files, payload bodies with client data, or
  account identifiers: an account is named by an owner label (`google-test-a`), and the mapping stays in the owner's
  private evidence store. Records are written under `.runtime/acceptance/`, which is never committed.
- **Boundaries.** Stop at the authorized effect: read, local preview, remote job, write or spend. Never send test events
  or conversions without a separate authorization. Never activate a paused entity unless a separate activation is
  authorized. Acceptance runs use exactly the production safeguards; none is relaxed for a test.

## Recording a result

1. The harness writes a record (`record.json`) with `ledger_rows`: references only, each naming the provider contract
   digest and API version the run used.
2. `npm run build`, then `node tools/acceptance/ledger.mjs add <record.json>` validates the rows against the ledger
   schema and appends them to `src/acceptance-ledger.json`; an invalid row writes nothing.
3. `npm run contracts:actions` and `node tools/acceptance/provider-access.mjs` refresh the action ledger's `acceptance`
   column and the [provider access register](../PROVIDER-ACCESS.md). Commit all three.

A ledger row applies only while the provider contract keeps the same digest and version: any change to the contract
makes it `stale`, and the action is `unverified` again until a new run is recorded. An action without a row stays
`unverified`. The ledger never grants access.
