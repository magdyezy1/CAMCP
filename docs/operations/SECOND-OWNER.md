---
status: reference
tier: operator
---

# A second owner by e-mail address (`AMCP_ADMIN_EMAIL`)

The owner's request of 2026-11-21: one verified sign-in becomes an owner of the AMCP workspace beside the AMCP owner. [Accounts and workspace access](../USER-ACCOUNTS.md) and the [Railway variable table](../DEPLOY-RAILWAY.md) link here.

## The variable

`AMCP_ADMIN_EMAIL` holds one e-mail address, trimmed and compared without case. The match is exact: no list, wildcard or domain, and `admin+tag@…` is another address. A value that is not exactly one address stops the website and the worker at start, with a message that does not print it. Unset or blank changes nothing. Set it after owner setup: before it, the grant makes this person the first owner who has an account, beside the administrator password sign-in, and notices go to them.

## What it grants

When a person signs in whose account has that address, and the address is verified, they get an active owner membership of the AMCP workspace (`AMCP_TENANT_ID`). The AMCP owner keeps everything; both are the AMCP owner and use every owner-only control. A test or disabled account never gets the role, and a pending account is approved. Someone who already holds a role keeps a higher one and is raised from a lower one; the AMCP owner is never changed.

An address is verified when it entered the account through an e-mail link (registration, an address change, an invitation, owner setup) or a Google or Apple token whose claim says so. Facebook gives no address. With two-step verification the role waits for the code, and `AMCP_REQUIRE_MFA` covers the second owner like any owner, with its grace period.

The grant is recorded in a `member_grant` document (`granted_by`; `granted_from`, the role held before, with a client access set; and `approved_by_grant` when the sign-in approved a waiting account) and audited as `admin_email_owner_granted` with the user ID and never the address. A second sign-in changes nothing.

## The two owners

Notices still go to `AMCP_OWNER_EMAIL`, or else the earliest owner (a role chosen by hand before one the variable granted). Neither owner can demote, remove, revoke or reset the other from the website: member editing, account access and the two-step reset refuse an owner (`OWNER_REQUIRED`). Erasure and self-service deletion refuse both owners; the re-application of an erasure receipt on a restored copy still erases. The operator resets an owner's two-step verification on the server (`admin mfa-reset`), and ends a second owner's role by removing the variable.

## Ending the role

Remove the variable, or name another address, and the next start returns the person to the role they held before the grant (with their client access set), or ends their membership if they held none. Their sessions, connector tokens and AI clients of the AMCP workspace stop, and the audit row is `admin_email_owner_revoked`. The role also ends when the account's address changes, or the account is disabled or becomes a test account, and a grant an older process wrote ends at that person's next request or, for an owner-level AI client or connector token, at its next call. A role given by hand is never touched.

A grant an older process wrote can exist only where processes overlap a deployment, which the supported single replica with a volume never does: the old process stops before the new one starts. Where they do overlap, a background job that an owner-level credential started is not reconciled: it keeps its owner authority until that person's next website request or call (which revokes the credential, so the job's check then fails) or the next start, and a second owner's operator and reader credentials last as long, at their own level.

The approval ends with the role when the grant gave it. An account that was waiting for approval is waiting again (`approval_restored` in the audit row): its sessions, tokens and AI clients in every workspace stop, and the owner decides as for any request. An account that was approved before the grant stays approved.

The record is a `member_grant` document: there is no schema change. An older release ignores it and cannot end a grant. To roll back, remove the variable, let the current release restart (its start-up pass ends the grant), and only then roll back.

## If a second owner must be cut off

The website cannot do it, because neither owner can change the other's access. Remove the variable and redeploy: the role, sessions, connector tokens and AI clients of that workspace end at the start. What the second owner did while an owner stays: accounts approved, administrators invited, policy changes and disconnections. Afterwards review Members, Accounts and AI clients.

## Registration while sign-up is closed

With `AMCP_ALLOW_SIGNUP=false`, registration stays open for exactly that address, by e-mail link only, so e-mail delivery must be configured. The public pages still say sign-up is closed, so the person registers through `POST /api/account/register`. Any other address gets the usual closed answer, and a social first sign-in stays closed.

Every request is counted first, whatever the address, against five a network and five an address in 15 minutes. A network over its budget gets 429 for every address alike, so the configured address cannot be found by guessing without limit; an address over its own is answered as before, with no link sent. Within the budget it is still the one address not refused as closed.

## AI clients and connector tokens

An owner of the AMCP workspace, in it, can give an AI client or connector token owner access (owner decision of 2026-11-21, replacing the operator cap of D16 for them only). That is everything an owner can do through AMCP's tools, including spending, retention and approval settings; a tricked AI could change those safety settings.

The consent screen offers Owner last and never preselected. Choosing it shows a confirmation that names the app and its return host, and the server refuses owner access without it (`OWNER_ACCESS_CONFIRMATION_REQUIRED`); the token form has its own checkbox, which the server also checks. Administrators, operators, viewers and the owners of other workspaces keep the cap. Minting needs the recent sign-in, and a two-step session where the workspace requires one for owner authority; owner access is never limited to a client. It is audited as `ai_client_owner_access_granted` or `connector_token_owner_access_granted`. Credentials made before keep their access until reauthorized, and an owner-level one stops (`MEMBERSHIP_REVOKED`) when its person stops being an owner.

Where the workspace requires two-step verification for owner authority, the proof is asked when an owner-level connection is made. It is not checked again on each call of the connection's 30 days, because a bearer credential carries no website session.
