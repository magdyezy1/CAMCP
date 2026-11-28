/**
 * What a provider has been seen to do to a create that the request did not ask for (R2.5 r25-fr-verify, the owner's friction B1): it ignores the status the create
 * sends. These are findings, never documentation: Google's own pages on this are MISSING, so every sentence says "has been seen" and none says "documented".
 *
 * Google Ads asset links (campaign, ad group, customer and asset group links): in the owner's round 1 (23-24 Nov 2026; .runtime/wave5-claude/field/
 * amcp-issues-and-friction.md, B1) 48 image links were created PAUSED, Google switched them on, and they were live about 6 minutes before the mismatch was
 * flagged; AMCP had accepted the status and answered "succeeded". The entry is scoped to image roles, which is all the evidence there is: widen it when
 * another role is seen.
 *
 * An entry is used three ways, always by its code:
 *   - the review of such a create warns before execute: the family's `impact.known_behaviour` names the code, and the review copies its `note` into one reason
 *     the agent and the person approving on the website read;
 *   - the read-back settles exactly this difference at its first read (`VerificationRead.known`), as a mismatch that carries the code, instead of after a second
 *     round;
 *   - under the owner's activation switch (allow_activation false) the create is refused before anything is sent, since Google would serve it (src/spend-policy.ts).
 */
export interface KnownBehaviour {
  /** The field in a read-back, as `differing` names it. */
  field: string;
  /** What the create sent for it, and what a read shows once the provider has changed it. */
  sent: string;
  reads: string;
  /** What the review's reasons and the read-back's block say. */
  note: string;
  /** What the owner's activation switch refuses with: a sentence of its own. */
  refusal: string;
}
export const knownBehaviours: Readonly<Record<string, KnownBehaviour>> = Object.freeze({
  GOOGLE_ASSET_LINK_PAUSED_SWITCHED_ON: {
    field: '/status',
    sent: 'PAUSED',
    reads: 'ENABLED',
    note: 'Google has been seen to switch on a new asset link that was sent PAUSED, so it may serve. The read-back after execute shows its status.',
    refusal:
      'The owner policy forbids activation, and Google has been seen to switch on a new asset link that was sent PAUSED, so this link may serve. Nothing was sent. Ask the workspace owner to allow activation.',
  },
});
