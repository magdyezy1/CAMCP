# Test accounts and platform connections

Test accounts can authorize their own configured browser OAuth platforms from Connections, follow the callback and discovery result, select accounts or properties, sync assets, add another login, choose a default, and disconnect. Google Ads also supports reauthorization in place. This applies to both shared test-password sessions and individually invited test accounts.

The website previously displayed Connections but its test-account API allow-list rejected authorization and all connection management. The allow-list now includes the existing connection routes and their exact supported methods. Newly introduced APIs remain excluded by default.

## Workspace and permission boundaries

- The deployment owner's connections stay in the owner workspace. Connection IDs, account IDs and OAuth progress IDs do not grant access across workspaces, even when IDs repeat.
- Everyone using the shared test password uses the same test workspace and can access its selected accounts and manage its connections. The sign-in copy states this. Use an individual account or an individually invited test account when connections must remain private to that reviewer.
- Platform consent still controls provider access. AMCP account selections and write grants remain separate, local controls. The deployment write switch, administrator role and explicit write-grant confirmation still apply.
- Test access continues to exclude campaign execution, media operations, MCP connector creation/consent, owner administration and account-security mutations. Allowing connection management does not expand those areas.
- A test account's disconnect is always local. Where the owner turned on revocation at Google on disconnect (`AMCP_PROVIDER_REVOCATION`, CON-05), a test account is not offered it and a request for it is refused (`TEST_ACCOUNT_SCOPE`) before the login's token is read: everyone with the shared password manages the same logins, so one evaluator could otherwise end another's Google grant. Remove AMCP in the provider's own settings instead.
- Apple Ads uses deployment-owned API credentials rather than a user's browser OAuth login. Those credentials remain restricted to the deployment administrator workspace. Supporting a reviewer's separate Apple credentials would require a workspace credential-entry feature.
- The website shows a test account only the pages its workspace includes (`testAccount` in `web/routes.js`): Home, Report builder, Clients & templates, Connections, Audit activity, Workspace settings and Your account. Navigation groups left empty, out-of-scope palette entries and the sidebar's AI-connectors link are hidden; opening another page lands on Home with "This test workspace does not include {page}." Clients & templates reads the recipe fields a playbook can default from the `amcp_workspace profiles` response, so it opens and saves playbooks without the campaign tool, which stays refused (`TEST_ACCOUNT_SCOPE`) — the server gate was not widened (WEB-06, owner decision D27). Saved client briefs (`amcp_workspace` `briefs`, `brief`, `save_brief`, `delete_brief`, CMP-06) are local workspace documents like playbooks and stay available to a test account; using one in a recipe needs the campaign tool, which stays refused. An address the route registry does not list also lands on Home.
- Connecting still requires configured provider application credentials, a matching registered callback and provider consent/access. This change does not configure applications, grant provider approval or deploy the branch.

## Verification

`tests/test-account-connections.test.ts` uses an in-memory encrypted store, synthetic identities and an injected provider fixture. It exercises complete Meta connection/selection/sync/default/disconnect flows for both identity types; both callback paths; initiation for all 14 browser OAuth platforms; Google reauthorization preserving the connection and saved report; partial-discovery recovery; deployment write controls; CSRF/origin protection; session-bound single-use state; revocation during token exchange; administrator checks; and cross-workspace isolation with repeated connection and account IDs.

`tests/user-accounts.test.ts` also starts platform authorization after the real invited-test-account email setup and password sign-in flow. `tests/test-account-scope.test.ts` retains excluded and unknown route checks, including alternate path spelling.

These are local/synthetic checks. They do not establish a successful live provider consent or a deployed website result. See [implementation verification](implementation/VERIFICATION.md) for the commands and release evidence.
