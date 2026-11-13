---
status: reference
tier: operator
---

# Qualification records

How a build is qualified and its record kept, the provenance of generated artifacts, and the journey and MCP evaluations. A section of the [operations runbook](../OPERATIONS.md), moved here with its text unchanged on 2026-10-24 (DOC-03).

`npm run qualify` (`tools/qualify.mjs`) composes the existing commands and writes one record per tested tree to
`.runtime/qualifications/<source_tree_hash>.json`, plus one `index.jsonl` line. The record is local and never committed
(owner decision D25 in [decisions](../DECISIONS.md)); delivery notes cite its `source_tree_hash` instead of retyping counts.

- **Stages.** The deterministic freshness gates run first: TypeScript build, release identity, format check, the
  test-oracle ratchet (`check:oracles`), the `generate:*` checks (the Google bid-field and Cloudflare range checks
  included), `provenance:check` ([generated-artifact provenance](#generated-artifacts-and-catalog-provenance-arc-03)),
  `report -- --check`, `contracts:check`, `contracts:actions:check`, `docs:index:check`, the Arabic chunk check
  (`locale_chunks_check`: `node tools/locale-chunks.mjs`, read-only, about 15 seconds) and the architecture ratchet
  (`architecture:check`, [architecture](../review/ARCHITECTURE.md#8-architecture-ratchet)). The full profile then probes
  FFmpeg and ffprobe, runs the suite with
  `AMCP_REQUIRE_FFMPEG=true`, the capture tests, the mutant catalogue (`mutant_catalogue`), the wire-contract sweep, the
  Meta creative feature pin (`meta_creative_features_pinned`: it fails unless
  `tests/fixtures/meta-creative-features-sdk-v26.json` is hashed from the SDK 26.0.2 files, as pinned on 2026-10-16, so
  a transcribed allowlist cannot qualify a release; `node tools/meta-creative-features.mjs --source-dir <directory>`
  pins it again), `check:web`, the journey and MCP evaluation
  (`journey_evaluation`, below) and the provider checks. Each stage records argv, exit code, duration, output SHA-256
  and the test totals (total, pass, fail, skipped, cancelled). Any skipped test fails the run unless named with
  `--allow-skip "<test name>"`; without FFmpeg the run fails at `ffmpeg_probe` (`FFMPEG_UNAVAILABLE`).
- **Bytes.** The record holds `source_tree_hash` (equal to a release candidate's manifest for the same tree), revision,
  `worktree_clean` and `differs_from_revision`, the lockfile SHA-256, Node, npm, OS and the FFmpeg version line, the
  packaged identity from `dist/release-identity.json` and the public asset version.
- **Sunset alarms.** The `sunset_alarms` stage runs `providers:sunsets -- --alarm` offline and records the alarms; an
  alarm never fails the run (`--now <date>` checks a later date). Date-dependent output stays out of the Docker build.
- **Reuse.** `--reuse` still runs every freshness gate. A later commit whose changes lie outside the package scope and
  `tests/` (for example docs only) and whose rebuilt package digest and asset version are equal is recorded with
  `reuse_of` instead of rerunning the suites; anything else runs the full profile again.
- **Test oracles (QA-02).** A test that expects a refusal names it: `assertRefused(result, 'CODE', {writes})`
  (`tests/helpers/assert-refused.mjs`, `.ts`) also fails on `INTERNAL_ERROR` and on any provider write.
  `npm run check:oracles` (`tools/check-test-oracles.mjs`) counts code-less `success === false` assertions and
  `assert.throws`/`rejects` without a matcher per test file against `tests/fixtures/test-oracle-allowance.json`: a new
  one fails, write, auth and export test files are held at zero, and `--update` lowers counts after a burn-down
  (`tools/oracle-burndown.mjs` rewrites only sites whose observed refusal was named, never a crash).
  `tools/refusal-exits.mjs` lists every refusal on the write, export and schedule paths that leaves something paused,
  busy, uncertain or expired, each with its exit test or the reason it is terminal
  (`tests/fixtures/refusal-exits.json`). `tests/reviewed-family-conformance.test.mjs` drives each family descriptor
  (`tests/family-descriptors/`) through review, a decisive change (`STATE_CHANGED`), a paginated snapshot and a partial
  answer; families still without one are listed under a ceiling that only falls. Contract-faithful fakes
  (`tests/helpers/contract-fakes.mjs`) check a fake's requests against the pinned vendor contracts PRV-05 enforces, with
  generators for provider doubles and cursor pages; `tests/schedule-timezone-sweep.test.mjs` sweeps every IANA zone over
  2026-2027. Every reviewed write family of an active provider has a descriptor (the pending ceiling is 0). The 11
  Criteo families are lifecycle-parked exemptions (the `parked` list of
  `tests/fixtures/family-conformance-pending.json`), valid only while `parkedProviders` in `tools/provider-lifecycle.ts`
  includes criteo: once Criteo is unparked the test fails until each ships a descriptor, and the parked list can only
  shrink. A family whose state reads are single resources the vendor never pages says so (`unpaginated`), one whose own
  prerequisite refuses the changed value at execute names that refusal (`decisive.refusal`), a spend-affecting family
  (the registry asks `spendConfirmation`) is never labelled `settings`, and a second request shape a family serves runs
  the same checks as a variant (`tests/family-descriptors/variants/`). Still open from QA-02: the manual reviewer
  samples remain with the owner.
- **Risk evidence (QA-02).** Each record carries `risk_evidence` (`tools/risk-evidence.mjs`) instead of headline
  totals: every risk class of the qualification plan (R1 money and deletion to R8 website, defined with their register
  items in `tests/fixtures/risk-classes.json`) against its evidence. `fixture` is the named synthetic test files as
  `test_suite` ran them (the stage records its `failing_files`); `conformance` is the family descriptors of the class's
  risks (R1: activation, budget, destructive) with `family_conformance` counting all descriptors by risk and the
  pending ones; `mutants` is the class's catalogued mutants as `mutant_catalogue` killed them (the stage records each
  outcome); `live` names the owner-run acceptance (ACC-01 to ACC-07) and stays `owner_step`, because a record is local
  synthetic qualification. `gaps` lists each class without conformance, mutants or recorded live evidence. A stage that
  did not run reports `not_run`, never `passed`. Every catalogued mutant belongs to a class: classify a new one in
  `tests/fixtures/risk-classes.json` (`tests/risk-evidence.test.mjs` fails until it is).
- **Mutant catalogue.** `node tools/mutants.mjs [--only <id>]` copies the candidate (tracked and untracked sources and
  the built `dist/`) to `.runtime/mutants/`, applies each catalogued defect of `tests/fixtures/mutant-catalogue.json`
  to its compiled module in turn, and runs the tests named to kill it, then the critical set. Every mutant must be
  killed: a survivor or an edit that no longer applies fails the full profile. The first full run (33 mutants,
  2026-10-11) killed 22 and recorded 10 survivors and one timeout; each survivor was then given a killing test or
  replaced where the guard is redundant by design (a second check refuses the same case), and the catalogue now runs
  with all 33 killed. Add a mutant together with the test that kills it.
- **Fast gate.** `npm run check:fast` runs only the freshness gates and writes no record. `tools/pre-push.sample` runs it
  before a push; opt in with `cp tools/pre-push.sample .git/hooks/pre-push` (never installed automatically).
- **Related tests.** `npm run test:related` selects by import-graph closure, adds the tests that read a changed `web/`
  file, and every test that builds `web/` paths when it runs (in the test, a helper or fixture or a tool it imports: a
  change to any `web/` file selects it), a small critical set, prints selected and possible counts, and appends the freshness checks when `src/`,
  `server/`, `tools/`, `docs/`, `generated/`, `codegen/` or `.mirror/` change. It also selects the suites that list
  their inputs when they run (`dynamicSuites`): `tests/mutants.test.mjs` for a catalogued module or killing test,
  `tests/web-locale-chunks.test.mjs` for `web/` and backend sources, `tests/storage-boundary.test.mjs` for `src/`
  and `server/` modules, and `tests/root-independent-cli.test.mjs` for any test, `tools/`, `server/`, `src/` or
  `deploy/` file. It
  builds as `npm run build` does (`tsc`, then the release identity), so a fresh tree has `dist/release-identity.json`.
  `--direct` keeps the old literal-import selection and `--plan` prints the selection only.
- **Tests run as root.** Railway's Docker build runs `npm run check` as root, and in production the admin CLI refuses
  root unless `--allow-root` is given. Tests therefore spawn the CLI only through `tests/admin-cli.ts` (`runAdmin`,
  `execAdmin`), which always passes the flag, so each test reaches the command it checks whoever runs it.
  `tests/root-independent-cli.test.mjs` fails when a test names the CLI any other way, or when another entry point in
  `tools/`, `server/`, `deploy/` or a shared `src/` module starts reading the user ID without such a helper, and shows
  under a simulated root that the bare CLI is refused where the helper's call runs.
- **Release candidates.** `prepare-public-release` writes manifest v2 with `worktree_clean` and `differs_from_revision`;
  the verifier still reads v1 and refuses a v2 candidate assembled from a tree that differed from its revision.
  `NOTICE.md` and `.gitattributes` ship; every allow-listed file must be tracked. File and Git failures print
  `RELEASE_PATH_UNAVAILABLE` or `RELEASE_GIT_UNAVAILABLE`, never an absolute path. Point candidates at one shared npm
  cache (`npm ci --offline --prefer-offline --cache <one absolute directory>`) instead of a cache per candidate.
- **Deployed comparison.** `npm run check:public-website -- --origin https://amcp.shop --expect-record <record.json>`
  GETs `/versionz` and `/` (no credentials, no redirects), compares package SHA-256, components, lockfile component,
  source revision and asset version with the record, and appends the observation to the record file.
- **Container parity.** `npm run qualify:container` (`tools/container-parity.mjs`, ACC-04) copies the release scope
  minus `.dockerignore` to a new directory outside any Git repository, links the installed dependencies and runs
  `npm run check` there with FFmpeg required and two test workers, as Railway's Dockerfile build does;
  `-- --test <file>` runs the build and the named tests only. Its record holds counts, hashes and exit codes. It does
  not reproduce the image's root user, Node patch version or Linux: on 2026-10-18 it passed every test on Windows while
  Railway's build failed twice (the image's `node:sqlite` refused backup rate `-1`; a test met the admin CLI's root
  refusal), so only the Railway build record is Linux evidence
  ([what the deployment taught](../DEPLOY-RAILWAY.md#what-the-2026-10-18-deployment-taught)).
- **Railway build evidence.** `npm run evidence:railway` turns a build log the owner exported read-only into a
  counts-only record of the Linux check for that deployment
  ([per-release evidence](../DEPLOY-RAILWAY.md#per-release-linux-evidence-from-railway-builds)).
- **Pruning.** `node tools/qualify.mjs --prune --dry-run [--keep-last 5] [--keep-package <sha256>]` lists `.release`
  candidates that no record, deployed package or `.retain` file keeps. It deletes nothing; deletion stays a manual owner
  action after reviewing the list, and `--prune` without `--dry-run` is refused.

### Generated artifacts and catalog provenance (ARC-03)

`npm run provenance` (`tools/generated-provenance.mjs`) lists every tracked generated artifact: all of `generated/`,
the captured catalog, the action ledger, `docs/CONTRACTS.md`, the tracked report under `.mirror/REPORTS`, the
generated guides, the architecture ratchet's baseline (`docs/review/architecture-baseline.json`), the Arabic catalog
chunks (`web/locales/ar/`) and the website ratchets' baselines (`tools/web-markup-baseline.json`,
`tools/web-colour-baseline.json`, `tools/web-route-bytes-baseline.json`; `check-web` and their tests compare them), the
redirect stubs of moved documents (`docs/moved.json`), the documentation freeze's baseline
(`tools/docs-lint-baseline.json`), the status page (`docs/STATUS.md`) and the findings register's two views
(`docs/review/FINDINGS.md` and `FINDINGS-CLOSED.md`, from `docs/review/findings.json`; `npm run docs:index:check`
compares them all, DOC-03), each with its
generator, its inputs, where it records their digests and the check that fails when it is edited by hand or stale. `npm run provenance:check` is a gate of `npm run check`, `check:fast`, qualification
(`generated_provenance_check`) and `test:related`. It fails on a file in `generated/` that no artifact declares, a
declared output that is missing, a check that is not a gate of both `npm run check` and qualification, or an input
digest an artifact recorded that no longer matches, and it runs the checks that have no generator to rerun:

- **Capture evidence.** `.mirror/REPORTS/evidence-hashes.json` names a SHA-256 for each file of the original capture.
  `node tools/evidence-hashes.mjs --check` verifies the bytes of the files this tree ships under `.mirror/RAW`. The
  others are declared in `.mirror/RAW/WITHHELD.json` under the label `historical_capture_not_shipped`, in groups with a
  reason, a count and the digest of the whole set. Their digests cannot be checked from this tree, and none of those
  files ships without a privacy review (D17). `--write` recomputes the declaration's lists, counts and digest; a
  withheld file that matches no group is refused until a group with a reason names it.
- **Frozen captured catalog.** `npm run capture:check` re-derives `.mirror/CATALOG` and `.mirror/TOOLS.json` from the
  shipped capture and fails when either differs, when a shipped capture file is missing from the evidence list, or
  when the files no longer have the digest `capturedCatalogDigest` in `tools/catalog/normalize.mjs`. Only the
  operation schemas of delegated gateways come from withheld files; they are held to that digest. The catalog stays the
  frozen naming-compatibility denominator (D17), so `npm run capture:normalize` is refused while any file is withheld.
- **Registry provenance.** `generated/registry.json` records provenance format 2: each input with the digest of its
  text, the shipped capture files verified against their captured digests, and the withheld set by label, count and
  digest. It no longer presents all 197 capture digests as `source_hashes`, and `npm run generate` refuses to run while
  the evidence check fails.
- **Apple SDK evidence.** `npm run generate:apple:check` checks `generated/apple-platform-v1-models.json` offline: its
  recorded digest, the pinned SDK revision in every source, and the shape of its models and methods. Re-deriving it
  from that revision needs the public SDK files, so it is an owner-run release step with network access:
  `node tools/apple-model-evidence.mjs --fetch --sdk <empty directory> --check`. It last ran on 2026-10-17 at the
  pinned revision and found 0 problems; run it again when the pinned revision moves. No build, test or check fetches.

Routing truth is anchored apart from the captured catalog. `npm run contracts:actions` also writes
`generated/route-anchors.json` and the per-gateway [route anchor coverage](../implementation/ROUTE-ANCHOR-COVERAGE.md)
report, which `contracts:actions:check` keeps current. Each routed action names what its method and path rest on: a
pinned vendor document method (`vendor_spec`), a pinned SDK request (`sdk_method`), a dated documentation page
(`documented_url`), or the captured catalog alone (`captured_only`, with the capture file and the reason). Ledger rows,
`amcp_workspace contracts` and the Capabilities contract reference show `anchor_status` and `anchor`; operation help
and `DESCRIBE_ACTION` add `route_anchor`, and mark a native read that is not anchored with the advisory
`read_unanchored`. Anchors are evidence only: they never enable, block or reclassify an action. To anchor a route from
a documentation page you read, add the page to `tools/route-anchor-documents.json` with the exact method and path, the
URL, the date read and a note; the generator refuses an entry whose route has moved or that anchors no routed action.
The SDK evidence behind Meta's `sdk_method` anchors (`tests/fixtures/meta-sdk-changes-v26.json`, whose digest the
anchors record) re-derives like the Apple evidence, from the two SDK releases the owner downloads:
`node tools/meta-sdk-changes.mjs --from-dir <25.0.3 adobjects> --to-dir <26.0.2 adobjects> --check`. It was
regenerated on 2026-10-17 from both complete PyPI releases
([deployment record](../records/DEPLOYMENT-2026-10-18.md#the-public-documentation-pins-of-2026-10-17)).

### Journey and MCP evaluation (QA-04)

`npm run eval:mcp` (`tools/mcp-eval.mjs`) measures B15's "correct next actions with fewer unnecessary calls". It runs
locally in about half a minute with zero egress. A real MCP SDK client talks to AMCP's MCP server over an in-memory
transport. The website API runs on a loopback listener over the same store, and every provider is a synthetic
in-process fake that refuses and counts any other host.

- **Journeys** (`tests/journeys/journeys.mjs`). J1 first visit to readiness, J2 brief to reviewed outcome, J3 creative
  source to lineage, J4 evidence to recommendation, J5 snapshot export, receipt and safe retry, J6 measurement repair,
  J7 failure to resume, and J8 multi-client ownership. Each has four branches: success, failure, unavailable account
  and incomplete evidence. A run records user actions, website actions, MCP tool calls, refused and repeated refused
  calls, provider requests and mutations, response bytes, approvals, and its end state. The end state is one of
  success, a handled failure (the last response offered a next step) or a dead end.
- **B15 tasks** (`tests/journeys/b15-tasks.json`). The six blueprint jobs plus two hold-out tasks that must never be
  used to tune tool descriptions. Each task runs twice. The *reference* run is the shortest correct scripted sequence
  and proves the job can be done. The *guided* run is a client that knows only the first call and then follows the
  next calls AMCP offers. Both are measured on the four B15 measures: correct tool choice, unnecessary calls, repeated
  refused calls and handoff success (the website link opens the same object).
- **Baseline.** `tests/journeys/baseline.json` is committed. `--check` (the default, and the full qualification's
  `journey_evaluation` stage) fails when a count rises or an outcome gets worse. It also fails when response bytes,
  tool-list bytes or instruction bytes grow more than 10 % plus 512 bytes, or when the tool count changes. A guided
  run that newly reaches its goal, or a dead end that gains a next step, counts as an improvement. A failure branch
  that newly "succeeds" is a regression, because a safeguard stopped holding. `--fault strip-next-call` and `--fault
  hide-attention` apply deliberate regressions so the check can be seen to fail. `--write-baseline` is the only way
  to change the baseline, and it refuses a subset or a fault. Re-baseline deliberately after a change to the MCP
  surface, such as MCP-07, and record the earlier file's git blob and its measures beside the new ones (below).
- **What the first baseline shows.** All reference runs complete. Guided runs reach the goal for T3, T5 and H2 only.
  AMCP offers no next call from `capabilities` to the live `check` (T1), from `create` to `preflight` (T2), from a
  plan summary to its uncertain step (T4), from the media library to an asset's detail (T6), or from a failed
  export's status to `retry` with the job ID that `retry` needs (H1). These are inputs to MCP-07. The baseline was
  captured after MCP-01 merged, so it is the "before" state for MCP-07 only.
- **Re-baseline after the wave 2 merges (2026-10-11).** The first baseline is git blob
  `fbbe59e8c6d4e5b03781d5369badcad381f6587a` (`git cat-file -p fbbe59e8`), captured on the wave 2 base before
  MCP-07 and the other wave 2 packages. Against the current file only sizes and the tool count differ: 28 → 27 tools
  (CON-06 no longer offers Amazon Ads), tools/list 108,128 → 97,261 bytes (MCP-07 and MCP-10 descriptions and output
  schemas), instructions 1,446 bytes in both, and response bytes per run from −4 to +6,136 (J1's four branches grow
  about 10 % with the wave 2 readiness and attention data). No count, end state, tool choice or handoff changed, so
  guided runs still reach the goal for T3, T5 and H2 only.
- **Re-baseline after the wave 4b MCP quality pass (2026-10-22).** The earlier file is git blob
  `26242850dab19be87f60168f248e020047c29de3`. No count, end state, tool choice or handoff changed. tools/list grew
  94,467 → 95,706 bytes (operation-mode write notes, two AMCP-owned descriptions) and instructions 1,446 → 1,479
  bytes; response bytes per run grew 0 to +4,727 (J1's branches read `/api/platforms`, which lists the descriptions;
  list pages carry the paging fields). The ten evaluation-set runs E1–E10 were added (below).
- **Transcript privacy.** A sanitized transcript keeps argument keys only when they name a parameter (a plain
  identifier of at most 40 characters without a run of four digits); keys made of data, such as account IDs, names or
  metric IDs used as map keys, become `<key>`. A website path keeps route segments only and otherwise becomes
  `<path>`. `args_digest` is an HMAC under a random key of the run, so it tells repeats apart within one transcript
  and cannot be reversed by hashing guesses. While a fixture is open the global `fetch` is replaced too: only the
  loopback website passes, and any other call is refused and counted (`globalEgress`), so each run asserts zero
  egress for direct calls as well as for the synthetic providers.
- **External clients** (owner decision D14). Run the same task prompts in each must-pass client, repeated so the
  results are ranges. Turn each raw call log into a sanitized transcript locally with `--sanitize <raw.json> --output
  <new file>`, then measure the runs with `--external <runs.json>`. A transcript keeps argument shapes, result codes,
  states and sizes. It is refused if it carries argument values, provider text or bodies. Record the results with
  [the evaluation record template](../review/MCP-EVALUATION-RECORD-TEMPLATE.md).

#### MCP evaluation set and the mcp-builder LLM runner

`tests/fixtures/mcp-evaluation/evaluation.xml` holds ten questions in the mcp-builder skill's evaluation format
(`<evaluation><qa_pair><question>…</question><answer>…</answer></qa_pair>…</evaluation>`): realistic agency questions,
independent and read-only, each needing two to four calls and with one stable answer. They are asked about a
synthetic workspace (`workspace.mjs`): an outdoor-gear client with two Meta ad accounts (Meta refuses one), a Google
Ads customer and a Tag Manager container, and a bakery with one Meta ad account, plus saved report snapshots,
captured reports, campaign plans and a media library, all with fixed values and times. Every provider is an
in-process fake; other hosts and every provider write are refused and counted. The workspace serves the person who
seeded it in the reader role, so no call can change anything.

- **Answers are proven, not asserted.** `solutions.mjs` answers each question through read-only AMCP calls, starting
  from the connections as an assistant would. `tests/mcp-evaluation-set.test.mjs` runs each solution on a fresh
  workspace through a real MCP SDK client and checks that the answer equals the XML answer, that every call is
  read-only by its own hints, that the store is unchanged and that nothing left the process. The same questions are
  a suite of `node tools/mcp-eval.mjs` (`--only E4`, or `--only evaluation_set`), held to the baseline like the B15
  tasks.
- **Keep the set fixed.** Like the hold-out tasks, these questions measure the descriptions; never tune a
  description to them. Change a question only with its solution and a new baseline.
- **The LLM runner is an owner step.** The skill's `scripts/evaluation.py` sends each question to the Anthropic API,
  so it uses the owner's API key and usage. Nothing in the build, the tests or qualification runs it. The steps:
  1. `npm run build`, so `dist/` serves the fixture.
  2. Once, make a virtual environment for the runner under the ignored `.runtime/` with Python 3.10 or later and
     install the runner's packages into it (a download from PyPI). On Windows `python` may be only the Microsoft Store
     alias; the interpreter `AMCP_SCHEMA_PYTHON` names works:
     `<python> -m venv .runtime/mcp-eval-venv`, then
     `.runtime/mcp-eval-venv/Scripts/python -m pip install -r <skill-scripts>/requirements.txt`, where
     `<skill-scripts>` is the installed mcp-builder skill's `scripts` folder (PowerShell:
     `$env:USERPROFILE/.claude/skills/mcp-builder/scripts`; `bin/python` instead of `Scripts/python` outside Windows).
  3. Set the key for that shell only (PowerShell: `$env:ANTHROPIC_API_KEY = "<your key>"`). Never write it into a
     file in this repository.
  4. From the repository root, run the runner through AMCP's wrapper, with a current Claude model (the runner's
     default model may no longer be served) and a new report file under the ignored `.runtime/`:

     ```
     .runtime/mcp-eval-venv/Scripts/python tools/mcp-skill-evaluation.py --skill-scripts <skill-scripts> -- -t stdio -c node -a tests/fixtures/mcp-evaluation/server.mjs -m <model> -o .runtime/mcp-evaluation/<date>-report.md tests/fixtures/mcp-evaluation/evaluation.xml
     ```

     The runner starts `tests/fixtures/mcp-evaluation/server.mjs` itself over stdio. That server needs no database,
     key, credential or network: it serves the fixture from memory, refuses the global fetch and logs to stderr only.
  5. Measure the report: `node tools/mcp-eval.mjs --skill-report .runtime/mcp-evaluation/<date>-report.md
     --output .runtime/mcp-evaluation/<date>-record.json`. It keeps, per question, whether the answer was
     correct, the tool calls by tool and the calls beyond the reference solution's (from the baseline). It never
     keeps the answers, summaries or feedback the report holds. Repeat the run with a new report name each time,
     since a model's behaviour varies, and pass several reports separated by commas to get ranges per question.
- **Why the wrapper.** The installed runner (2026-10-17 copy) has two defects that would waste a paid run. It hands
  each tool result's content blocks, which the `mcp` package returns as pydantic models, to `json.dumps`, which
  cannot serialize them, so every tool call would reach the model as an error text. And it writes the report with
  Python's default encoding, which on Windows is a code page (cp1252 on the owner's PC) that cannot encode its check
  marks, so the run would fail after the last question. `tools/mcp-skill-evaluation.py` changes no skill file. It
  restarts itself in Python's UTF-8 mode (`-X utf8`), makes the runner's own `call_tool` return the blocks as JSON
  data, creates the report's folder, refuses a report file that already exists (`MCP_SKILL_REPORT_EXISTS`, so an
  earlier run is never overwritten), then runs `evaluation.py` unchanged with the arguments after `--`. The verifier
  test exercises it against stub runner modules, with no third-party package.

The Dockerfile base image `node:24-bookworm-slim` and the apt `ffmpeg` package are tags, not digests. Pinning the base
image by digest needs the digest from a registry the owner trusts; record it in the Dockerfile with a dated comment
and refresh it monthly or on a Node 24 security release (owner action). The Railway build evidence record names the
digest the last build resolved (`base_image.digest`), which is the value to pin (OPS-08). `/versionz` reports the observed `toolchain`
(Node version, FFmpeg first line, OS ID and version, each strictly validated or `unavailable`) and the
`public_asset_version`, and owner health reports `media_processor` (`available`, `unavailable` or `not_checked`).
