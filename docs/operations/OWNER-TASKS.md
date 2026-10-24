---
status: current
tier: operator
---

# Owner tasks and their steps

The owner guide's [what stays with you](../owner/owner-run.md) lists, in plain words, the work that needs the owner's
accounts, dashboards or decision. This page is its operator side: each task with its dates and the guide that has its
steps. The owner decides; the operator runs the technical steps.

## Soon

- **Before 15 November 2026: record the Railway settings.** Write down the health check, restart, replica, draining,
  watch-path and deploy-trigger settings shown in the Railway dashboard, and export the build log and image digest.
  Railway changes how these settings are read on 1 December 2026
  ([the settings to record](../DEPLOY-RAILWAY.md#railway-service-settings-owner-record-d1)).
- **Turn off Cloudflare's automatic Web Analytics.** The site's security policy blocks the script it injects anyway.
- **Backups.** Turn on Railway's scheduled volume backups, keep an encrypted copy outside Railway, and run one restore
  drill to learn how long a recovery takes ([restore drill](../OPERATIONS.md#restore-drill)). Keep backups for a
  limited time, for example 35 days, and keep the master key in a password manager or secret store: without it, the
  backups and the saved logins cannot be opened.
- **After the next release, set the visitor address source** so that rate limits count each visitor separately
  ([client addresses](../DEPLOY-RAILWAY.md#client-addresses-for-rate-limits)).

## After each release

- **Save spending policies again** when owner health says a cap names no currency: until then such a cap blocks budget
  and bid changes on its accounts.
- **Sync each Google Ads login once** in Connections, when the release notes ask for it.
- **Decide when to publish.** Pushing a release deploys the live site, so it happens only when the owner says so,
  after the qualification has passed.

## Regularly

- **Every 30 days:** read TikTok's developer changelog by hand, since TikTok blocks automated reads, and run the
  documentation watch over the other platforms' public pages; it lists the manual checks that are due
  ([provider lifecycle](../OPERATIONS.md#provider-lifecycle)).
- **Every 90 days:** confirm again the platform approvals the owner declared; the
  [provider access register](../PROVIDER-ACCESS.md) marks a declaration stale after 90 days.
- **Before 1 April 2027:** renew the expiry date of the site's security contact file.
- **Once, before relying on Meta caps in the account currency:** check AMCP's copy of Meta's currency table against
  Meta's Currencies page ([provider lifecycle](../OPERATIONS.md#provider-lifecycle)).

## Platform apps and approvals

- **Register each platform's app** and add its credentials to the server
  ([register provider apps](../DEPLOY-RAILWAY.md#3-register-provider-apps)). Until then, the platform's card in
  Connections says *Administrator setup required*.
- **Declare what each platform approved** for the apps, such as the Google Ads developer token level or Meta's
  advanced access, in the [provider access register](../PROVIDER-ACCESS.md). A declaration records what the owner
  holds; it never grants anything.
- **LinkedIn Media Planning and Audience Insights, and Display & Video 360** need approvals or a user profile that only
  LinkedIn and Google can grant ([provider programs](../acceptance/PROVIDER-PROGRAMS.md)).

## Live acceptance

AMCP has been tested against simulated platforms. Proving it on real accounts needs runs that only the owner can
authorize, in writing, one at a time. None has been run yet ([acceptance runbooks](../acceptance/README.md)):

- a zero-spend launch on a Google Ads test account, which serves no ads and spends nothing
  ([write acceptance](../acceptance/WRITE-ACCEPTANCE.md));
- the AI assistants the team uses, on a staging copy of AMCP ([AI-client checks](../acceptance/CLIENT-INTEROP.md));
- one delivery to a disposable Google Sheets file ([Sheets delivery](../acceptance/SHEETS-DELIVERY.md));
- read checks on accounts and properties the owner names ([read acceptance](../acceptance/READ-ACCEPTANCE.md));
- screen-reader sessions in English and Arabic, with testers the owner chooses
  ([assistive technology](../acceptance/ASSISTIVE-TECHNOLOGY.md)).

## Decisions only the owner can make

These are still open in [decisions](../DECISIONS.md):

- the license for the code;
- who runs the evaluation sessions with AI assistants, and whether an AI-client directory listing is a goal;
- whether times in the audit history, sessions and tokens show a time zone;
- which Adjust operations matter;
- whether disconnecting a Google login should also revoke AMCP at Google, after one test with disposable logins.

Sign-up stays closed: new members join by invitation. Opening sign-up on the website later needs an email provider,
and each new sign-up then waits for the owner's approval.
