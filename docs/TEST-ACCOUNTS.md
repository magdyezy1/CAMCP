---
status: reference
tier: operator
---

# Test accounts and platform connections

Test accounts can authorize their own configured browser OAuth platforms from Connections, follow the callback and discovery result, select accounts or properties, sync assets, add another login, choose a default, and disconnect. Google Ads also supports reauthorization in place. This applies to both shared test-password sessions and individually invited test accounts.

Since 2026-10-30 (the owner's change, for Meta's app review) they also use the test workspace's product workflows (below). A new API stays excluded until the test-account allow-list (`server/website-gates.ts`) admits it.

## Workspace and permission boundaries

- The deployment owner's connections stay in the owner workspace. Connection IDs, account IDs and OAuth progress IDs do not grant access across workspaces, even when IDs repeat.
- Everyone using the shared test password uses the same test workspace and can access its selected accounts and manage its connections. The sign-in copy states this. Use an individual account or an individually invited test account when connections must remain private to that reviewer.
- Platform consent still controls provider access. AMCP account selections and write grants remain separate, local controls. The deployment write switch, administrator role and explicit write-grant confirmation still apply.
- Test access covers the test workspace's product workflows: campaigns, creative and media uploads, reporting, previews, reviewed writes and their approvals, AI clients and connector tokens. Workspace tools, AI clients and connector tokens act with operator authority at most, never the workspace owner's: changes beyond a spending cap, owner policies and provider jobs stay refused. A new reviewer password ends the AI clients and connector tokens approved from the shared sign-in, and its approvals show "Reviewer". Owner administration and account-security changes stay excluded; a test account's pages leave out their forms, workspace switching and report-job grants. In any other workspace a test account is a viewer, and that workspace's two-step rule applies to it: as it cannot set up two-step verification, a workspace that enforces it stays closed to the account (signing in again opens its own).
- A test account's disconnect is always local. Where the owner turned on revocation at Google on disconnect (`AMCP_PROVIDER_REVOCATION`, CON-05), a test account is not offered it and a request for it is refused (`TEST_ACCOUNT_SCOPE`) before the login's token is read: everyone with the shared password manages the same logins, so one evaluator could otherwise end another's Google grant. Remove AMCP in the provider's own settings instead.
- Apple Ads uses deployment-owned API credentials rather than a user's browser OAuth login. Those credentials remain restricted to the deployment administrator workspace. Supporting a reviewer's separate Apple credentials would require a workspace credential-entry feature.
- The website shows a test account the pages its workspace includes (`testAccount` in `web/routes.js`): every product page, without the members-only Help guide. Opening another page lands on Home with "This test workspace does not include {page}."; an address the route registry does not list also lands on Home.
- Connecting still requires configured provider application credentials, a matching registered callback and provider consent/access.

## Verification

`tests/test-account-connections.test.ts` uses an in-memory encrypted store, synthetic identities and an injected provider fixture. It covers Meta connection, selection, sync, default and disconnect for both identity types, both callback paths, initiation for all 14 browser OAuth platforms, Google reauthorization, partial discovery, write controls, CSRF and origin checks, single-use state, revocation during token exchange, administrator checks and cross-workspace isolation.

`tests/user-accounts.test.ts` also starts platform authorization after the real invited-test-account setup and sign-in, and covers a test account in another workspace. `tests/test-account-scope.test.ts` retains excluded and unknown route checks, including alternate path spelling. `tests/mcp-authorization-lifecycle.test.ts` and `tests/write-approval.test.mjs` cover reviewer AI clients and approvals.

These are local/synthetic checks. They do not establish a successful live provider consent or a deployed website result. See [implementation verification](implementation/VERIFICATION.md) for the commands and release evidence.
