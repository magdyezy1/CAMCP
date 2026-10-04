# Batch 139 — maintained committed-source release verification

Release source verification is now a repository command, `npm run release:verify -- .release/candidate`.
It replaces reliance on copying local verification helpers with a maintained, tested command and a required
GitHub Actions step before installation, report checks, full tests and Docker. It verifies source bytes; report
freshness, required FFmpeg, Railway/image checks, synthetic smoke and the preceding exact-source CI remain
separate gates. The command performs no Git mutation, report regeneration, provider call or deployment.

## Exact manifest, Git blobs and sanitized sample

Run the command from the clean repository root after committing the reviewed code and documentation. Select
a candidate inside that checkout's `.release` directory. The candidate must retain its original version-one
manifest, actual current HEAD/branch and source-tree hash. Every allowed public file in HEAD must appear once,
with no omitted, extra or repeated source. Files must be regular files under their declared candidate path;
traversal, links, unsupported Git objects and private paths are refused before their contents are read.

Each file's exact captured bytes must match its manifest SHA-256/length and original committed Git blob.
The same captured buffer is bound directly to the blob identity, followed by an independent batch
`git hash-object --no-filters` check and a final HEAD/branch/clean-source check. Git input filters cannot turn
different bytes or line endings into a passing source claim. The
[official Git reference](https://git-scm.com/docs/git-hash-object), checked 2026-10-04, documents the raw-byte
behavior and omission of attribute/end-of-line filters. SHA-1 and SHA-256 Git object formats are supported.

The three tracked public report files must be present and equal to their committed blobs. The implementation
report must retain an empty `live_read_samples` array. Exactly one generated input is permitted: the candidate's
synthetic `.mirror/RESULTS/live-read-samples.json`, with literal `[]` plus LF, three bytes total. No private root
sample is read or modified. Manifest parsing is bounded to 8 MiB/20,000 entries, 256 MiB per file and 1 GiB of
declared file bytes. Unsafe or malformed metadata is refused without echoing its contents.

Successful stdout is one JSON proof containing revision, actual branch, source-tree hash, public source count,
one empty generated sample and three matched reports. CI saves `release-source.json` beside its manifest and
uploads it with the existing release evidence. Detached CI checkouts retain their actual empty Git branch;
the exact workflow revision identifies their source. Failed verification stops subsequent qualification.

The Docker build stage now installs Git for real owned-fixture tests. The verifier is a source/release command;
the running website and advertising providers do not invoke it. Git optional index writes are disabled during
verification. A successful proof does not establish app behavior, freshness, deployed health or live acceptance.

## Qualification and continuing scope

The original CLI feature baseline was **1/0/1/0, 618.429 ms** because no maintained command existed. Six new
real-Git fixture tests plus the two existing assembly tests passed **8/8/0/0, 8.268 seconds**, including the
typed-SHA metadata case. They exercise exact source/reports and spaces/Arabic paths, a CRC-consistent
CRLF candidate that Git's normal filter would normalize, omitted/duplicate/private/traversing/malformed
metadata, revision/branch/hash mismatch, dirty source, altered candidate bytes, report samples, wrong generated
inputs and linked candidate directories. Synthetic repositories remain in owned ignored workspace fixtures
and are checked before cleanup. They have no remote, provider credentials or push operation.

Local formatting and Railway Dockerfile compatibility passed. Fresh full gates and exact committed-source
verification follow below. Local Docker/FFmpeg remain unavailable; actual Linux/container qualification belongs
to the exact subsequent CI revision. This change improves B16 without changing 3,247 native actions, 167 families,
800 reviewed writes or the 13 implemented / 14 partial / one open roadmap states. Work continues through the
remaining product and provider qualification scope.

## Batch 139 sanitized release preflight

Fresh offline install/build/early tracked-report freshness/full check/Railway gates passed, each exit zero.
Main suite **4,175 total / 4,170 passes / no failures / five expected local FFmpeg skips, 129.682 seconds**;
capture **4/4/0/0, 78.616 ms**. Website: 34 scripts and 3,376 selected Arabic messages; documentation
index: 305 documents. Manifest: 1,717 public source files plus one generated empty sample; source hash
`844adb49175ed903ed6ae32a80c0835418d1f0737c24ba4396538efac15c66c2`. All three public reports regenerated unchanged after sanitized build and retained
their bytes throughout qualification. The private root sample was not read. These paragraphs and CI193 records
follow preflight; a fresh candidate at the final committed revision is verified with the maintained command and
passes every gate before the sole Work-here push. Local Docker/FFmpeg, actual browser/assistive, deployed and
live-provider qualification remain separate.
