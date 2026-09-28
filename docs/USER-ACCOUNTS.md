# AMCP accounts and workspace access

People sign in with a verified email/password or an explicitly linked Google, Apple or Facebook identity. A person can belong to multiple workspaces. Connections, selected accounts and reports belong to the workspace.

## Claim the existing administrator workspace

1. Configure the email sender below. Keep the existing database and master encryption key.
2. Sign in through the administrator entry using the existing AMCP_ADMIN_PASSWORD or hash.
3. In Account settings, choose the owner-account migration. Enter your name, an unused email address and the existing administrator password.
4. Open the emailed verification link in the same browser and choose a password of 15–128 characters.
5. Use the ordinary email/password form afterward. Migration attaches your owner identity to the existing workspace and preserves its connections, grants and reports. The legacy administrator password stops opening that workspace. Existing MCP clients must reauthorize and old administrator schedules must be explicitly resumed under the owner account.

AMCP does not generate a universal owner email or password. Migration is single-use, browser-bound and requires verified email; it cannot silently take over an existing member identity. Keep an encrypted backup and its master key before production upgrades.

## Email registration and recovery

Configure a verified sender in Resend, outside Git:

```text
AMCP_PUBLIC_ORIGIN=https://amcp.shop
AMCP_EMAIL_API_KEY=<sending-scoped Resend key>
AMCP_EMAIL_FROM=AMCP <accounts@your-verified-domain>
AMCP_ALLOW_SIGNUP=true
AMCP_RUN_WORKER=true
```

Verify the sender domain using Resend's exact DNS records. Registration follows name/email → email link → choose password → workspace. Existing members can reset a password or change their verified recovery address. Verification can be resent; expired links have a fresh-start path. Public screens show available choices; owner Settings holds infrastructure diagnostics.

Messages enter an encrypted SQLite outbox before delivery. Delivery starts at once, but the response does not wait for it, so the time a registration or reset takes does not show whether the address has an account. Transient failures retry with an idempotency key, bounded timeout and worker lease. Single-use links expire after 30 minutes; retries do not extend them. Sent/expired queue payloads are cleared. Keep a worker running and the database persistent. Existing password sign-in continues without email configuration; registration and recovery require it.

Passwords use asynchronous scrypt (N=32768, r=8, p=3), bounded memory and at most four concurrent hashes. Existing supported hashes upgrade on successful login. Run `node dist/tools/password-benchmark.js` on the production-sized host. A local benchmark is not a capacity guarantee.

## Social sign-in

These credentials are separate from advertising OAuth:

| Provider | Exact callback | Variables |
|---|---|---|
| Google | https://amcp.shop/api/signin/google/callback | AMCP_SIGNIN_GOOGLE_CLIENT_ID, AMCP_SIGNIN_GOOGLE_CLIENT_SECRET |
| Apple | https://amcp.shop/api/signin/apple/callback | AMCP_SIGNIN_APPLE_CLIENT_ID, AMCP_SIGNIN_APPLE_TEAM_ID, AMCP_SIGNIN_APPLE_KEY_ID, AMCP_SIGNIN_APPLE_PRIVATE_KEY |
| Facebook | https://amcp.shop/api/signin/facebook/callback | AMCP_SIGNIN_FACEBOOK_CLIENT_ID, AMCP_SIGNIN_FACEBOOK_CLIENT_SECRET |

Google uses a Web OAuth client. Apple uses a Services ID, registered HTTPS return URL and Sign in with Apple key; an externally maintained AMCP_SIGNIN_APPLE_CLIENT_SECRET can replace the signing-key configuration. Facebook needs Facebook Login and the exact valid redirect URI. Only configured providers appear publicly; configuration does not prove provider approval.

Sign in first, then link additional identities from Account settings. Matching emails never merge accounts. Linking preserves the active shared workspace. Provider subject IDs identify accounts; Google/Apple signatures, issuer, audience, nonce and expiry are checked. Facebook email is not assumed to be a verified recovery address. Social identity tokens are not stored as advertising connections.

## MFA, memberships and revocation

Account settings provides authenticator-app TOTP and ten one-use recovery codes. Store recovery codes privately outside AMCP. Copy the authenticator secret into your app; QR scanning is not required. MFA applies to both password and social sign-in once enabled. Password reset does not remove MFA. Passkeys are not included.

| Role | Access |
|---|---|
| Owner | Workspace administration, memberships, owner-only spending/retention controls and reviewed operations |
| Admin | Connections, permitted membership administration, reports and reviewed operations; cannot replace the owner or change owner-only policies |
| Operator | Selected-account reporting, reviewed operations, exports and schedules |
| Viewer | Read access; no writes, exports, invites or schedules |

Invitations expire after 30 minutes and are bound to the invited email. Existing users accept while signed in as that identity; new users verify the invitation and choose a password. The inviter's current permission is checked again at acceptance. The owner cannot be demoted/removed through member editing.

Password/email security changes, MFA changes and membership changes revoke the relevant browser/MCP access. Each of them — a password change or reset, an email change (sent to the previous address), two-step verification turned on or off, a recovery code used, a sign-in method added or removed — also emails a security notice through the outbox. A browser session ends after 2 hours without a request, within its 8-hour limit. Jobs recheck membership and credential/account version before requests. Revoked schedules pause; reauthorize explicitly. Recent sign-in, exact Origin and CSRF remain required for sensitive changes. Existing advertising and MCP OAuth redirect, PKCE, scope and resource controls remain in force.

## Production acceptance

Automated tests use synthetic identities and mail transport. Verify real inbox delivery, resend/recovery, a second browser, restart persistence, each configured social provider, owner migration on a backup copy, MFA/recovery and membership revocation before public registration. Credentials and provider approvals remain deployment setup work.

References: [OWASP authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Sign in with Apple](https://developer.apple.com/documentation/signinwithapplerestapi), [Facebook Login](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/), [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).
