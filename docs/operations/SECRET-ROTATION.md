---
status: current
tier: operator
---

# Secret rotation

Rotate the platform app secrets, the master key and the other keys AMCP holds. A section of the [operations runbook](../OPERATIONS.md), moved here with its text unchanged on 2026-10-24 (DOC-03).

**App secrets (`AMCP_<PLATFORM>_CLIENT_SECRET`, `AMCP_MICROSOFT_DEVELOPER_TOKEN`, `AMCP_APPLE_*`).** A saved login keeps
its own tokens and the client ID it was authorized with; the client secret, developer token and Apple signing key of
that client are read from the environment whenever the login is used (SEC-07). To rotate one, create the new secret
at the provider, set it in Railway (both services), redeploy, then revoke the old secret at the provider: no login
needs reconnecting. Logins saved before this change still hold a copy; the environment's value is used instead, and
the copy is dropped at the login's next token renewal, reauthorization or `admin rekey`. Changing the client ID itself
is a new OAuth app: logins of the earlier app keep renewing with the copy of its secret they still hold and show
`client_changed` until reauthorized; a login with no copy left asks for reauthorization without contacting the
provider. `AMCP_APP_SECRETS=copy` is the rollback lever: logins written afterwards carry the copies again, which a
release from before this change needs; set it and let logins renew before rolling back. A Google Ads login customer is
not an app secret: each login keeps its own (provisioned per login, or recorded per account by a website login's sync,
CON-05), and `AMCP_GOOGLE_LOGIN_CUSTOMER_ID` is never injected into, or stripped from, a saved login.

**Master key (`MIRROR_MASTER_KEY`).** It seals every stored secret (logins, two-step secrets, AI-client secrets, staged
and retained media, report files, job authority, e-mail links) and, through a derived key, the backups. To rotate it:

1. Generate a new key (`npm run admin -- keygen`). In Railway, on both services, set `MIRROR_MASTER_KEY_PREVIOUS` to
   the current key and `MIRROR_MASTER_KEY` to the new one, and redeploy. Every value keeps opening (with either key)
   and new values are sealed with the new key. Website sessions, AI-client access and known-device cookies stay.
2. On the service, run `npm run admin -- rekey`. It re-seals every stored value that still opens only with the
   previous key under the new one (media chunks one per transaction, other tables in pages), drops copies of app
   secrets the environment supplies, and appends `secrets_rekeyed` to each workspace's audit. The report gives counts
   per table and the keys by fingerprint (`key_ids`), never the keys. Exit code 2 means something still needs the
   previous key; `unreadable` values open with no configured key and are left untouched.
3. Run `npm run admin -- rekey --dry-run` until it reports `complete` (writes during step 2 by an older process are
   caught here), take a new backup, then remove `MIRROR_MASTER_KEY_PREVIOUS` and redeploy.

Keep the replaced key in the secret manager while older backups are kept: verifying or restoring one needs it in
`MIRROR_MASTER_KEY_PREVIOUS`, and `rekey` on the restored copy moves it to the current key. Backups are written in the
v2 format, whose key is derived from the master key (HKDF) and named in the archive header; v1 archives (the master
key itself) are still read. `AMCP_BACKUP_FORMAT=v1` keeps writing v1 for a release that cannot read v2. Without the
previous key, a rotation looks to the website like an administrator password change from the environment: door
sessions, the AI-client access and connector tokens approved from them end.
