---
status: record
tier: engineering
---

# LinkedIn Message Ads and Conversation Ads content — 2026-09-27

Base revision: `268cd70` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: Message Ads and Conversation Ads need their content before a creative can reference it. The
InMail content and conversation routes were blocked writes (eight rows), so neither format could be
built through AMCP.

Contract source: [Message Ads API](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/version/message-ads-integrations)
and [Conversation Ads API](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/version/conversation-ads-integrations)
of the LinkedIn Marketing API (versions 202510 to 202609, pages updated 2026-06-24), read on
2026-09-27. Key facts:

- InMail content has account, name, sender (person or organization), subject, htmlBody,
  customFooter and one sub-content: regular (call-to-action text of at most 20 characters and a
  landing page of at most 1,024), guidedReplies (a sponsored conversation) or form. Updates change
  sender, subject, htmlBody and subContent (and name); "Once a creative goes live, you can't modify
  it further."
- A sponsored conversation belongs to an ad account; "You can't set the firstMessageContent when
  initially creating a sponsoredConversation."
- Messages form a tree: "The maximum number of SponsoredMessageContents within a conversation is
  25", references must exist, cycles are not allowed; text of at most 500 characters; 1–5 options
  with 1–35 characters and reply-type rules; lead form messages need a LEAD_GENERATION_THANK_YOU
  option and a form of the same account.

## Change

New reviewed family `linkedin_message_ads` (`src/linkedin-message-ads.ts`):

| Part | Behaviour |
|---|---|
| Request | InMail content creation and partial update; conversation creation and partial update (first message, headline); message creation (single or batch, by URN or numeric ID), partial update and batch deletion; REST.li 2.0 headers and methods only |
| Paths | Compound message URNs are fully REST.li-encoded (`src/compiler.ts`) |
| State | The ad account, the conversation with all its messages, the InMail content being updated and every lead form a message uses |
| Checks | The whole tree after the request: at most 25 messages, existing links, no cycles, lead form and reply-type rules, a first message that exists; forms and conversations of the selected ad account; guided replies only with a started conversation; unchanged updates refused |
| Safety | No spending confirmation; the impact warns that content an active creative uses reaches members |
| Receipt | 201 with the new URN, 204 for updates, and every requested ID created or deleted in batches; otherwise a failure that is never resubmitted |
| Verification | The content read again; deleted messages gone; the replaced text of thank-you options not compared |

Other code: `src/compiler.ts`, `src/scope.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/preflight.ts`, `src/reviewed-routes.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (LinkedIn contract version 10). Guidance:
"Reviewed LinkedIn Message Ads and Conversation Ads content" in
`Skills/amcp-campaign-builder/references/linkedin-x.md` and an executable inspect example.

## Tests

`tests/linkedin-message-ads.test.mjs`, five tests:

1. InMail content is created and updated once and verifies; a replay sends nothing; guided replies need a conversation with a first message.
2. A conversation is created, messages are added (single, batch and by numeric ID), the first message is set, a message is updated and one deleted, each verified.
3. Thirteen malformed requests fail before any request.
4. Foreign conversations and forms, missing links, cycles, a deleted first message, thank-you rules and unchanged updates are refused after reading, without writes; a connection without `rw_ads` is refused.
5. A creation without an ID is a failure that is never resubmitted; an ignored update is not verified; the ledger lists the eight writes in the family.

Red/green against a build of `268cd70`: all five tests fail (no reviewed family: the eight routes were blocked writes). Local log:
`.runtime/linkedin-conversation-ads-20260927/red-check.log`.

## Verification

- Targeted: 160 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,834/1,834.
- Guidance coverage: 281 write-path refusals across 158 modules accounted for.
- Full qualification: see
  [LINKEDIN-MESSAGE-ADS-VERIFICATION-2026-09-27.json](LINKEDIN-MESSAGE-ADS-VERIFICATION-2026-09-27.json).

Remaining rows: 847 (eight LinkedIn rows reviewed; LinkedIn blocked writes 113 → 105). Live
acceptance is unverified; it needs the updated deployment, an ad account with a permitted Message
Ads sender and a lead form.
