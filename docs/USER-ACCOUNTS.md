# User accounts and social sign-in

AMCP has individual member accounts with isolated workspaces, verified email registration, password sign-in and recovery, Google / Apple / Facebook sign-in, explicit account linking, profile editing and browser-session revocation. These use the existing persistent SQLite database and encryption key. The original deployment administrator password continues to open the original workspace.

New accounts never inherit the administrator's connected ad accounts or credentials. Each member owns their own workspace. MCP browser authorization and token creation use the member's workspace, including refresh and revocation. Server-owned Apple Ads client credentials remain restricted to the deployment administrator; Apple **Sign in** is a separate identity flow.

## Enable the login providers

Use the site's actual HTTPS `AMCP_PUBLIC_ORIGIN` and register these exact callbacks. User sign-in app settings are independent of the existing `/api/auth/:platform/callback` advertising connections.

| Provider | Callback | Server variables |
|---|---|---|
| Google | `https://amcp.shop/api/signin/google/callback` | `AMCP_SIGNIN_GOOGLE_CLIENT_ID`, `AMCP_SIGNIN_GOOGLE_CLIENT_SECRET` |
| Apple | `https://amcp.shop/api/signin/apple/callback` | `AMCP_SIGNIN_APPLE_CLIENT_ID`, `AMCP_SIGNIN_APPLE_TEAM_ID`, `AMCP_SIGNIN_APPLE_KEY_ID`, `AMCP_SIGNIN_APPLE_PRIVATE_KEY` |
| Facebook | `https://amcp.shop/api/signin/facebook/callback` | `AMCP_SIGNIN_FACEBOOK_CLIENT_ID`, `AMCP_SIGNIN_FACEBOOK_CLIENT_SECRET` |

- Google: create a Web application OAuth client, configure the consent screen, and register the callback. The request uses `openid email profile`, authorization code, S256 PKCE and nonce.
- Apple: use a Services ID associated with a primary App ID, register `amcp.shop` and the return URL, and configure a Sign in with Apple key. The server generates an ES256 client secret from the signing key. A pre-generated `AMCP_SIGNIN_APPLE_CLIENT_SECRET` is also supported and must be renewed before expiry. Apple requires the HTTPS callback; loopback HTTP does not enable this button. The callback accepts `form_post` with a separate ten-minute Secure/HttpOnly/SameSite=None browser-binding cookie. Normal AMCP sessions remain SameSite=Lax.
- Facebook: configure Facebook Login for a website and the exact valid OAuth redirect URI. The request uses `public_profile,email`; the server exchanges the code using your app credentials, then fetches the stable account ID with an app-secret proof. AMCP does not assume Facebook email is a verified recovery address. Members can add and verify their email from Account settings.

Unavailable providers are labeled and disabled on the sign-in page. Merely adding a button does not prove the provider app has been configured or approved. Complete a real round trip with each configured app before opening public registration.

## Email registration and recovery

Configure a verified sender in Resend:

```text
AMCP_EMAIL_API_KEY=<sending-scoped Resend API key>
AMCP_EMAIL_FROM=AMCP <accounts@your-verified-domain>
AMCP_ALLOW_SIGNUP=true
```

Do not put real values in Git. Registration first emails an account setup link; the member chooses their password only after following that link. This prevents an attacker from pre-registering someone else's email with a password the attacker knows. Links expire after 30 minutes, are single-use, and contain their token in the URL fragment so it is not sent in the initial HTTP request or referrer. Tokens and recovery details are encrypted in storage, indexed by token hashes. Passwords use asynchronous scrypt with bounded concurrency and a 12–128 character policy.

Resend is used only for account messages. The server sends plain-text emails with a unique idempotency key and fixed HTTPS destination. No emails are sent by the automated test suite. Without email configuration, password sign-in for existing members still works; email registration and recovery are disabled explicitly. Apple private-relay addresses require the sending domain to be configured with Apple as appropriate.

Setting `AMCP_ALLOW_SIGNUP=false` blocks new email and social accounts. Existing members can still sign in. Keep the persistent database volume: deleting it removes account and workspace state.

## Linking, recovery and sessions

- `/account` provides name/workspace editing, social account linking, verified email changes, password changes, and browser-session revocation.
- Existing social identities are identified by provider and immutable subject ID. Matching emails never automatically merge accounts. Sign in with the existing method and explicitly link another provider.
- Linking, unlinking, password changes and recovery-address changes require a recent sign-in. A user cannot remove the last usable sign-in method.
- Password reset and email changes revoke the member's existing browser sessions and MCP access. Changing a password from Account settings creates a fresh session in the current browser and revokes other access. Reauthorize MCP clients afterward.
- Social access tokens are used transiently for identity verification, not stored as advertising connections. Google and Apple ID-token signatures, issuer, audience, expiry, nonce, subject and authorized-party claims are validated using `jose` and fixed provider JWKS endpoints.
- Login attempts, email requests and social flows are rate-limited. All account mutations require the site's exact Origin; authenticated mutations also require the session CSRF token. Trusted-proxy configuration continues to govern client-address resolution.

There is no cross-workspace invitation or team-sharing system in this release. A social member account does not automatically claim or migrate the original administrator workspace. Provider app approvals, email delivery setup, and real production sign-in acceptance remain operator setup work.

## Verification

`tests/user-accounts.test.ts` covers email registration/reset, encrypted one-use challenges, all three social flows including Apple's cross-site POST, rejected identity claims, same-email collision, explicit linking, session isolation, server-owned credential boundaries, and member-scoped MCP consent/refresh/revocation. Existing MCP OAuth and advertising OAuth tests remain required.

Provider references: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Sign in with Apple](https://developer.apple.com/documentation/signinwithapplerestapi), [Facebook Login manual flow](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/), [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email), [jose](https://github.com/panva/jose).
