# Launch a paused campaign through review

The guided workflows on **Campaigns** take you from a brief to a paused campaign on the platform, checked step by step.
They cover common launches on Google (Search with several bidding choices, and Performance Max), Meta, Microsoft,
Snapchat, TikTok and LinkedIn. **Capabilities** shows which of them an account can use.

Before your first launch, set your spending limits (below).

## 1. Start a plan

1. Open **Campaigns** and choose a guided workflow.
2. Choose the login and the account, then fill in the business inputs: campaign name, daily budget in the account's
   currency, bidding, goals, landing page and creative. When the account belongs to a client with a playbook, its
   naming and tracking rules apply ([your team and your clients](team.md)).
3. The preview shows the plan before anything is saved. Choose **Create paused campaign plan**. Nothing is sent to the
   platform yet.

## 2. Check what the plan needs

AMCP checks the plan against the account as it is now: the account's currency, the goals and assets the campaign
needs, and your spending policy. *Prerequisites checked: nothing blocks this plan* means you can go on; otherwise each
blocking item says what to fix. After fixing something, choose **Check prerequisites again**.

## 3. Approve the whole plan

**Approve this complete plan** shows every step with its budget, bid and status fields and the accounts it touches.
Read it, open each **Show all fields** list, tick the confirmations, and choose **Save plan approval**. The approval
covers this exact plan for 24 hours. If the plan changes, AMCP asks you to approve it again.

If your workspace requires a different approver for spending plans, another member or the owner approves it.

## 4. Run it

Choose **Run the approved plan**. AMCP runs the steps on its server, in order, and you can leave the page. For each
step it:

1. reads the account as it is now,
2. prepares a review of the exact change, which expires after 5 minutes (**Prepare again** reads the account again),
3. checks your spending policy and the account's write access,
4. sends the change once,
5. reads the platform back and compares what it found with what was expected (**Read-back evidence**).

Everything the plan creates is paused. When a step needs your attention, the run stops there and says why.

## 5. Turn it on

Turning a campaign on is a change of its own, and AMCP never does it as a side effect. Where the workflow offers an
activation plan, open it from the launch plan when you are ready: each status change is reviewed, approved and read
back on its own.

## Spending limits

Set them in **Workspace settings**, under **Account spending policy**, for each account or as a workspace default
that covers every account: the maximum budget, the maximum increase per change, the cumulative daily increase, the
maximum bid and the maximum lifetime or total budget, in the account's currency.

- **An account without a policy is unprotected.** Some changes that raise spending are refused until it has one, and
  the others go ahead with a warning. Save a workspace default first.
- **When a change goes beyond a cap**, AMCP asks for confirmation (recommended) or refuses the change, as you choose.
  Only the owner can approve going beyond a cap.
- **Allow activation after review** and **Allow deletion after review**: leave them off unless you want reviewed
  changes to turn things on or to delete them.
- The caps limit the budgets AMCP requests. They do not limit what the platform bills you.

If something goes wrong, see [when something needs attention](recovery.md).
