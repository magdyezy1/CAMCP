# OAuth compatibility and hardening decisions

## Claude remote MCP

AMCP accepts dynamic registration with `token_endpoint_auth_method=none` or `client_secret_post`. The authorization-server metadata advertises both methods. Confidential registrations receive a fresh 256-bit random client secret, returned in the no-store registration response and stored with AES-256-GCM encryption bound to the client ID and workspace. Keep `MIRROR_MASTER_KEY` stable across deploys and back it up separately. Client secrets are non-expiring (`client_secret_expires_at=0`); access and refresh tokens retain their existing expiry and revocation behavior.

Both client types require S256 PKCE. Exact HTTPS redirect matching, the limited loopback-port exception, resource validation, scope restrictions, administrator consent, CSRF checks, one-use codes, refresh rotation and replay-family revocation remain enforced. Confidential token exchange, refresh and revocation require the registered secret. Public clients cannot inject a client secret. Basic and other unadvertised authentication methods are rejected. Authentication checks use constant-time secret comparison and retain a pre-authentication rate limit.

The HTTP test uses Claude's actual callback shape, `https://claude.ai/api/mcp/auth_callback`, and exercises registration through authenticated MCP tool access. It also covers invalid secrets, redirect/PKCE/resource/scope failures, encrypted persistence after restart and refresh replay. This is a protocol integration test with synthetic credentials; a real Claude-account round trip remains an external acceptance check after deployment. Dynamic registration behavior follows [RFC 7591](https://www.rfc-editor.org/rfc/rfc7591).

## Reviewer suggestions

| Suggestion | Decision and implementation |
| --- | --- |
| Trusted reverse proxies | Implemented as opt-in `AMCP_TRUSTED_PROXY_CIDRS`, used for website login and OAuth authentication rate-limit attribution. Default remains socket-only. Walk right to left and stop at the nearest untrusted hop; reject malformed or excessive chains. IPv4, IPv6 and mapped IPv4 are normalized. No blanket `trust proxy=true` setting. |
| Nested SQLite transactions | Implemented depth-based savepoints. Caught inner failures roll back only their work; an outer failure rolls back released inner work too. Callbacks must be synchronous. |
| TikTok refresh rotation | Not added to the current advertiser flow. TikTok documents `/oauth2/access_token/` as long-term and deprecates `/oauth2/refresh_token/`. Its short-term TikTok-account flow uses separate `tt_user` endpoints. Applying that refresh mechanism to advertiser tokens would be incorrect. Revoked/unsupported expired advertiser credentials require reauthorization. |
| Meta long-lived tokens | Implemented after initial code redemption using `fb_exchange_token`. The returned token and actual provider expiry are retained; the server does not invent a 60-day lifetime. Invalid exchange results fail explicitly. A separately documented incompatible token type can opt out with `AMCP_META_LONG_LIVED_TOKEN=false`. |
| Hardcoded script paths | The Windows runtime launcher already uses `$PSScriptRoot`. Removed the fixed workstation root from the publication helper and replaced bootstrap's fixed specification path with a CLI argument or `AMCP_SPEC_FILE`. Publication was not executed as part of this change. |

Proxy operators must verify that trusted ingress servers overwrite or correctly append forwarding headers, and must limit CIDRs to actual trusted peers. The algorithm follows the trust-chain principle in [Express's proxy guidance](https://expressjs.com/en/guide/behind-proxies/). Do not blindly trust private address space, arbitrary hop counts, or all sources. Global Express host/protocol trust remains disabled.

TikTok references: [v1.3 changes and deprecated refresh endpoint](https://business-api.tiktok.com/gateway/docs/index?doc_id=1740579480076290&language=ENGLISH), [short-term token flow](https://business-api.tiktok.com/gateway/docs/index?doc_id=1833997638479041&language=ENGLISH), [short-term refresh](https://business-api.tiktok.com/gateway/docs/index?doc_id=1833997679342594&language=ENGLISH). Meta reference: [long-lived user access tokens](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/).

## Validation boundary

Run `npm run check`. Tests cover local protocol and database behavior with synthetic upstream responses. They do not establish approved provider applications, working production credentials, a completed live OAuth round trip, or the unresolved deployment volume attachment. No advertising objects were changed by these tests.
