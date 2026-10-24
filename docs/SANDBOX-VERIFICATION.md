---
status: current
tier: operator
---

# Opt-in isolated sandbox verification

The ordinary checks use synthetic fixtures. `npm run test:sandbox` skips before reading a fixture or credentials unless `AMCP_LIVE_SANDBOX=true`. No live sandbox call was made during this implementation.

The runner accepts X and Microsoft's implemented JSON write families. It follows the real AMCP campaign runner, review, grant, snapshot, idempotency and exact read-back paths. A dedicated transport maps only their approved API origins to isolated sandbox hosts before authentication/signing. A second egress guard rejects production hosts, external media/social hosts, redirects and DELETE. The normal server continues using production transport; a client cannot select this sandbox mode.

Prepare a non-secret JSON fixture with `gateway`, `account_id`, optional Microsoft `customer_id`, and 1–20 explicit campaign-runner `steps`. Every step must have `kind: write`, the same gateway/account, `connection_id: sandbox`, and native `arguments`. Normal `$ref` dependencies are supported. Use existing sandbox funding, media-library items, promotable identity and paused parents where needed; do not invent them. Example:

```json
{
  "gateway": "x_ads_native_action",
  "account_id": "REPLACE_WITH_SANDBOX_ACCOUNT",
  "steps": [{
    "id": "campaign", "kind": "write",
    "gateway": "x_ads_native_action",
    "account_id": "REPLACE_WITH_SANDBOX_ACCOUNT",
    "connection_id": "sandbox", "depends_on": [],
    "arguments": {
      "action": "x_accounts_account_id_campaigns_post",
      "payload": {
        "name": "Approved sandbox fixture",
        "entity_status": "PAUSED",
        "funding_instrument_id": "REPLACE_WITH_SANDBOX_FUNDING_ID"
      }
    }
  }]
}
```

After an operator approves the concrete fixture, configure these **environment variables through a secret-safe mechanism**, never in committed files or command-line values:

- `AMCP_LIVE_SANDBOX=true`.
- `AMCP_SANDBOX_FIXTURE_SHA256`: SHA-256 of the exact approved file bytes.
- `AMCP_SANDBOX_RUN_ID`: stable identifier for this logical run; reuse after interruption.
- `AMCP_SANDBOX_STORAGE_KEY`: a 32-byte base64 encryption key retained for recovery.
- `AMCP_SANDBOX_CREDENTIALS_JSON`: sandbox credentials using AMCP's connection credential fields. X needs consumerKey, consumerSecret, accessToken and tokenSecret; Microsoft needs accessToken and developerToken, with customer_id supplied by the fixture.

Run `npm run build`, then `npm run test:sandbox -- path/to/approved-fixture.json`. State persists in `.runtime/sandbox/<run-id>/state.sqlite`; credentials are encrypted, while synthetic fixture metadata is ordinary SQLite data. Preserve the directory, storage key and run ID. An incomplete result is a failed check, not permission to delete/reset the account or use a new key. Output reports status and the fixture digest without provider bodies or credentials.

Nightly live runs require a separately provisioned, persistent runner and approved fixtures/credentials. This change does not enable an automatic live job. The weekly **public** provider-maintenance workflow uses no credentials and makes no account changes. GitHub schedules only run from the default branch; changes pushed solely to Codex-branch remain available for manual execution and review.

Coverage limits:

- X campaign objects are non-serving in its [sandbox](https://docs.x.com/x-ads-api/fundamentals/sandbox). Its separate byte-upload services have no qualified sandbox mapping in AMCP, so this runner blocks the upload step. Full media → creative → ad fixture tests remain synthetic; a live creative chain can start with operator-provisioned library media.
- Microsoft has [separate service addresses](https://learn.microsoft.com/en-us/advertising/guides/web-service-addresses?view=bingads-13). Search hierarchy writes are implemented; AMCP media import is not.
- Google and TikTok use test-account/token boundaries that cannot be established by changing a hostname. They are deliberately not enabled by this runner. For Google, the ACC-01 write acceptance harness (`tools/acceptance/write-acceptance.ts`, [write acceptance](acceptance/WRITE-ACCEPTANCE.md)) keeps the production hosts and instead proves the selected account is a test account from Google's own `customer.test_account` before any mutation, with the same recovery rules. TikTok has no such proof yet.
- `SANDBOX_ROUTE_UNQUALIFIED` is a boundary failure. Add a documented and tested isolated route; never fall back to production. `tests/read-acceptance-interim.test.mjs` proves it for TikTok: sandbox mode refuses before any URL exists, sends nothing, and this runner's egress guard refuses both TikTok's production host and the unconfirmed sandbox host. A TikTok sandbox route waits for the owner to confirm a sandbox advertiser in the signed-in portal ([read acceptance](acceptance/READ-ACCEPTANCE.md#tiktok-sandbox)).
