# When something needs attention

## Where to look

- **Home** starts with the work that needs your attention.
- **Operations** is the recovery page for campaign changes, media uploads, report runs and deliveries: what is stuck,
  uncertain or failed, and the next safe step for each.
- **Monitoring inbox** holds the read-only rules you set and the incidents they raise, each linked to its evidence.
- **Audit activity** is the workspace's history: who did what, when, and on which account.

## A change whose outcome is uncertain

Sometimes a platform does not say clearly whether a change was applied, for example after a timeout or an outage.
AMCP then marks the change as uncertain and does **not** send it again on its own: sending it twice could double a
budget or create a duplicate.

To settle it:

1. Open the item in **Operations**.
2. Choose **Check the provider (read-only)**. AMCP reads the platform again; this changes nothing.
3. If the platform holds the change, choose **Accept as applied**. It is recorded as applied and never sent again.
4. If the platform does not hold it, prepare the change again as a new review. A correction is always a new, reviewed
   change.

Each item's status line says what is known, for example *Applied and read back*, or *The change is being sent.
Refresh in a moment; never execute it twice.*

## Other common cases

- **A review expired.** Nothing was sent. Choose **Prepare again**: AMCP reads the account again and makes a new
  review.
- **A login stopped working.** Connections shows *Reauthorization required*. Reauthorize it; its selections, saved
  reports and schedules stay.
- **A Sheets delivery is unconfirmed.** Resend the same report after a short wait, or release the tab
  ([reports and exports](results.md)).
- **An uploaded file expired.** Files uploaded from your computer are kept for 30 minutes. Upload the file again and
  save a new plan.
- **A schedule paused.** A schedule pauses when the access it ran under changes. Review it, then resume it with your
  current access.

## The emergency stop

**Workspace settings → Pause all writes** stops every reviewed change and media upload in the workspace, and the
report and export jobs a platform runs for AMCP, such as a Microsoft Advertising report (or only the changes, or only
those jobs), until an owner resumes. Reads, reviews and reports that only read go on, and nothing already sent is
undone. The reason you give is shown to everyone whose change is refused.

## Getting help

**Prepare support bundle** in Operations creates a sanitized bundle of diagnostics, without tokens or secrets, that you
inspect before you download and share it. An error shows its own reference and, when the platform refused, the
platform's status and request ID: quote them when you ask for help.

Next: [your team and your clients](team.md).
