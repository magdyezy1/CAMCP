# Check that an account is ready

Before you plan anything on an account, check that AMCP can work with it: the login still works, the platform granted
the permissions AMCP needs, and the account has what a campaign needs.

## On Home

**Home** opens with the work that needs your attention, then **Account readiness**:

- The summary counts the accounts that are ready, blocked and still to check.
- **Accounts and their readiness** lists each selected account, whether reviewed changes are enabled on it, and when it
  was last checked.
- **Check account** reads the account from the platform now, read-only, and records the result. Open
  **Prerequisites** to see each check and why it passed or failed.

A result shows when it was taken, and a later check can differ. Check again before an important launch.

## What a blocked account usually needs

- **Reauthorize the login**: the platform no longer accepts it, or a permission was declined. Connections then shows
  *Reauthorization required* or *Declined permissions*.
- **Select the account** in Connections, and allow reviewed changes on it if you plan to change it.
- **Fix it at the platform**: for example a suspended account, missing billing, no conversion goal, or a page or
  identity the campaign needs. AMCP names what is missing; it never invents a value to get around it.

## What each account can do

**Capabilities** shows, for an account you choose, which guided workflows and reports it can use and what each one
still needs. On Home, **Technical details** under *Capabilities and evidence* keeps the exact tool names and evidence
states for whoever needs them.

The badge *Implemented, not live-verified* means what it says: AMCP has built and tested the feature, and it has not
been verified on a real account yet ([where things stand](README.md#where-things-stand)).

Next: [launch a paused campaign through review](campaigns.md).
