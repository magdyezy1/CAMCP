# Your team and your clients

## Members and roles

Invite people in **Your account → Workspace members**. An invitation works only for the email address you invite and
lasts 7 days by default. To send it again, withdraw it and send a new one. Each person has one role:

| Role | Can |
|---|---|
| Owner | Everything, including the spending policy, retention, downloads and the emergency stop |
| Admin | Manage connections and members, report, and run reviewed changes; not the owner's own settings |
| Operator | Report, export and schedule on the selected accounts, and run reviewed changes |
| Viewer | Read reports and plans; no changes, exports, downloads, schedules or invitations |

Every member can connect their own AI assistant. It never gets more than that member's role allows, and a viewer's is
read-only.

When your deployment lets people ask for access, you grant or refuse each request in **Workspace settings → Access**.
A request you never approve is erased after 30 days.

## Two-step verification

Owners and administrators of a workspace that can make changes must use two-step verification: an authenticator app,
with ten recovery codes. After a grace period, 14 days by default, they can do nothing else until it is set up. Set it
up in **Your account** first, and keep the recovery codes somewhere safe outside AMCP. As the owner you can require it
of everyone, in **Your account → Workspace security**.

A sensitive change, such as inviting a member, adding write access or creating a connector token, asks you to
**Confirm it’s you** when you signed in more than 15 minutes ago.

## Clients in one workspace

An agency keeps many clients in one workspace:

- **Clients & templates** holds an approved **playbook** for each client: its accounts, naming rules, UTM tracking
  parameters, campaign defaults and report branding. Guided plans apply the playbook's rules, and the plan preview
  shows your input beside the result.
- **Working client**, in the top bar, narrows lists and pickers to one client's accounts. It is a view filter: it hides
  accounts, and it never grants access to any.
- **Client access sets**, in **Your account**, limit an operator or a viewer, and their tokens and AI assistants, to
  one client's accounts. Owners and administrators are never limited.

## Sharing work and approvals

A plan's owner can share it with named colleagues as viewer, editor or approver. In **Workspace settings** you can also
require that a plan which changes spending or activates a launch is approved by someone other than its owner, and
choose who approves spending, cap and deletion changes: the user in the AI client (the default), a member on the AMCP
website, or a member other than the one who prepared it, or the owner.

Next: [privacy and retention](privacy.md).
