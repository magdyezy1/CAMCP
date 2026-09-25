# CI runtime maintenance and exact recovery-batch verification

## Confirmed CI result

[Run #101](https://github.com/magdyezy1/AMCP/actions/runs/36114616532),
job `108005657489`, completed successfully for
`a28930443ca38afd21fc3d73048d9b61de356915` on Codex-branch. Observed through
the authenticated GitHub job UI on 2026-09-25: 21m 43s total, required-FFmpeg
suite 10m 11s, Docker build 10m 53s, read smoke four seconds, write-enabled
smoke four seconds, evidence upload complete. Read smoke explicitly reports
reporting/Sheets setup, sign-in, packaged guides, non-root volume access,
restart persistence and token revocation. No live advertising mutation was used.
This is evidence for that exact revision, not for subsequent local commits.

The annotations contained a Node 20 action-runtime deprecation warning and an
Ubuntu-latest migration notice. They were warnings, not failing tests. Prior
supplied CI failures and their fixes remain in CI-DEADLINES-2026-09-25.md.

## Change and rationale

Both existing workflows now pin the supported Ubuntu 24.04 runner family and
all four GitHub-owned actions to exact released commit SHAs. Checkout also
disables credential persistence; neither workflow needs authenticated Git after
checkout. Events, contents-read permissions, explicit npm cache, Node 24,
Python 3.12, package lock installation, FFmpeg checks, Docker smoke and artifact
paths are preserved. No production workflow or credential was added.

Exact public Git tag resolution and action.yml metadata were inspected:

| Action | Release | Commit |
|---|---|---|
| checkout | v7.0.1 | 3d3c42e5aac5ba805825da76410c181273ba90b1 |
| setup-node | v7.0.0 | 820762786026740c76f36085b0efc47a31fe5020 |
| setup-python | v7.0.0 | 5fda3b95a4ea91299a34e894583c3862153e4b97 |
| upload-artifact | v7.0.1 | 043fb46d1a93c77aae656e7c1c64a875d1fc6a0a |

All four declare Node 24. The existing inputs remain supported. setup-node v7's
removed dummy registry token does not affect this project (no registry-url input).
setup-python's removed pip-install input was not used. upload-artifact's default
archive behavior retains the existing evidence bundle. The runner family remains
patched by GitHub; this is not an assertion of bit-identical operating systems.

Primary references checked 2026-09-25:

- [Checkout release](https://github.com/actions/checkout/releases/tag/v7.0.1)
  and [pinned metadata](https://raw.githubusercontent.com/actions/checkout/3d3c42e5aac5ba805825da76410c181273ba90b1/action.yml).
- [Node setup release](https://github.com/actions/setup-node/releases/tag/v7.0.0)
  and [pinned metadata](https://raw.githubusercontent.com/actions/setup-node/820762786026740c76f36085b0efc47a31fe5020/action.yml).
- [Python setup release](https://github.com/actions/setup-python/releases/tag/v7.0.0)
  and [pinned metadata](https://raw.githubusercontent.com/actions/setup-python/5fda3b95a4ea91299a34e894583c3862153e4b97/action.yml).
- [Artifact release](https://github.com/actions/upload-artifact/releases/tag/v7.0.1)
  and [pinned metadata](https://raw.githubusercontent.com/actions/upload-artifact/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/action.yml).
- [Ubuntu 24.04 hosted image](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md).

The initial PowerShell raw-content downloads failed with local TLS authentication
errors; verification used the public web reader and successful git ls-remote tag
resolution instead. No certificate protection was disabled. Local Python/Node
YAML parsers were unavailable (ModuleNotFoundError/MODULE_NOT_FOUND); no parser
success is claimed. The small YAML diff was manually reviewed and git diff
--check passed. The next exact GitHub run is the syntax/integration gate.
There is no new application code in this maintenance commit, so the 2013-test
candidate I result remains the application baseline, not a claimed CI rerun.

Upgrade procedure: review official notes and pinned action metadata, resolve the
release tag, change both workflows together, and check the exact pushed revision
including container smoke and evidence upload. If an action regression appears,
revert only these workflow pins while retaining application receipts/data. Reusing
deprecated runtime pins is a temporary rollback, not a permanent maintenance plan.
