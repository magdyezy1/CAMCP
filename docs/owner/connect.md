# Connect your accounts

AMCP works only with the platforms you connect and the accounts you select. Connecting gives AMCP a login; selecting
tells it which accounts that login may be used for. Owners and administrators manage connections.

## Connect a platform

1. Open **Connections**. Each platform has a card: Google Ads, Meta, TikTok, Snapchat, LinkedIn, X, Microsoft
   Advertising, Apple Ads, Reddit, Display & Video 360, Google Analytics 4, Google Tag Manager, Google Search Console
   and Google Business Profile, plus Google Drive for creative files and Google Sheets for exports.
2. Choose **Connect**. The platform's own sign-in page opens: sign in with the user who manages your clients' accounts
   and approve the access it asks for.
3. You come back to **Connection result**, which shows what AMCP found.

A card that says *Administrator setup required* means the deployment does not have that platform's app yet
([what stays with you](owner-run.md)).

## Choose what AMCP may use

1. On the platform's card, choose **Manage**. The window lists your logins and, for each type of asset, what the
   login can reach.
2. Tick the accounts AMCP may use and choose **Save selection**, or **Save and check access**, which also reads each
   newly selected account once to confirm that it works. AMCP and AI assistants use nothing you did not select.
3. Under **Resource write access**, tick the accounts on which reviewed changes are allowed and choose
   **Save write access**. An account you leave unticked stays read-only.

**Enable read + reviewed write access for all selected resources** allows reviewed changes on every account you
select at once. Saving a selection or write access changes what AMCP may do, never anything on the platform, and every
change still needs its own review.

## Several logins

A workspace can hold several logins for one platform, for example one for each client's business manager. Choose
**+ Connect another** for each. When several logins of a platform are enabled, choose **Make default** on one, so that
AI assistants know which one to use.

## Keep connections working

- **Sync** reloads the accounts a login can reach. Use it after you gain or lose access at the platform.
- **Reauthorize** asks the platform for fresh consent and keeps the connection, its selections, saved reports and
  schedules. Do it when a card says *Reauthorization required* or lists *Declined permissions*.
- **Disconnect** removes the login's stored credentials, its account list and its selections from AMCP at once. It
  does not remove AMCP's access inside the platform: revoke that in the platform's own settings as well.

## AI assistants (optional)

**AI connectors** connects Claude, ChatGPT, Codex, Cursor or another MCP client to the same workspace, through the
browser or with a connector token. Each person connects their own assistant. What it may do is capped by that person's
role, and anyone can choose read-only access. Assistants follow the same rules as the website: they prepare reviews,
and nothing changes until a review is approved. Revoke a token or an authorized client at any time on the same page.

Next: [check that an account is ready](readiness.md).
