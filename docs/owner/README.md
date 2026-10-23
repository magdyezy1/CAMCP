# AMCP owner guide

AMCP is your private advertising workspace. In one place you connect your clients' ad accounts, check that they are
ready, prepare campaigns, report results and keep a record of every change. Your team works on the website; anyone
who prefers an AI assistant, such as Claude, ChatGPT, Codex or Cursor, can connect one to the same workspace, under the
same rules.

This guide is for workspace owners at agencies and in-house teams. It uses the names you see on the website, says
what AMCP does for you, and says what stays your job. It is also available in [Arabic](ar/README.md).

## How AMCP keeps you in control

- **Nothing changes without a review.** Before AMCP changes anything on an ad platform, it reads the account as it is
  now, shows exactly what would change, including the effect on budgets and delivery, and waits for an approval.
- **New campaigns start paused.** Guided launches create everything paused. Turning a campaign on is a separate,
  reviewed step.
- **Your limits apply.** The spending caps you set for each account are checked before every change. Beyond a cap,
  AMCP asks first or refuses, as you choose, and only you, the owner, can approve going beyond it.
- **Every change is checked afterwards.** After a change, AMCP reads the platform again to confirm what happened. When
  the outcome is unclear, it says so, and it never sends the same change a second time on its own.
- **One switch stops everything.** **Workspace settings → Pause all writes** stops every change and upload until you
  resume.
- **Numbers stay honest.** Reports keep each platform's own currency, time zone and attribution, and a report with
  missing data is marked partial; AMCP never fills a gap with a guess or a zero.

## Start here

The first time, work through the pages in this order:

1. [Connect your accounts](connect.md): sign in to each platform and choose what AMCP may use.
2. [Check that an account is ready](readiness.md): what is ready, and what blocks the rest.
3. [Launch a paused campaign through review](campaigns.md): from a guided plan to a paused, verified launch.
4. [Reports and exports](results.md): build a report, schedule it, send it to Google Sheets, PDF or Excel.
5. [The measurement hub](measurement.md): check conversion tracking across your platforms, read-only.
6. [When something needs attention](recovery.md): Operations, uncertain changes and the emergency stop.
7. [Your team and your clients](team.md): members, roles, two-step verification and client playbooks.
8. [Privacy and retention](privacy.md): what AMCP keeps, for how long, and how to delete it.
9. [What stays with you](owner-run.md): the tasks only the owner can do.

## Where things stand

- **What is proven.** AMCP's changes are built and tested against simulated platforms. No change on a real account
  has been accepted yet: the owner-run acceptance checks are prepared, and running them is yours to authorize
  ([what stays with you](owner-run.md)). Treat each first change on a real account with care: keep it paused, read
  the review, and check the result.
- **Status.** The [package status](../review/PACKAGE-STATUS.md) gives each part of the product on three separate
  axes, and the [provider access register](../PROVIDER-ACCESS.md) shows, for each platform, the approvals declared
  and what live acceptance has recorded.
- **Parked.** Criteo, WooCommerce and Amazon Ads are not offered unless the deployment turns them on, and Shopify and
  Salla are not built yet. They come after the current work.
- **Decisions.** Everything you decided is recorded in [decisions](../DECISIONS.md).

## Words used in this guide

- **Workspace**: your team's space in AMCP, with its members, connections, plans and reports.
- **Login**: one sign-in to an advertising platform. A workspace can hold several logins for each platform.
- **Account**: an ad account, or a property, container or site, that a login can reach. AMCP uses only the accounts
  you select.
- **Review**: the screen that shows one exact change before it is sent. A review expires after 5 minutes; preparing it
  again reads the account again.
- **Plan**: a saved campaign plan made of steps, each reviewed on its own.

Operators and engineers start from the [documentation map](../README.md).
