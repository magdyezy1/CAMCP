import {adGroup, campaign} from '../../dist/tests/helpers/google-write-fake.js';

/**
 * A group of keyword creates on the synthetic Google of customer 123 (r25-field3-errors, the second re-review: the group that a crash leaves half applied).
 * The fake reads a keyword create back, so a part of it that was sent settles as applied (a search theme it cannot read back settles as failed).
 */
export const AD_GROUP = adGroup(100),
  keywordAction = 'ad_group_criterion_mutate_ad_group_criteria',
  /** The first keyword of `keywords()` as it appears in a request body (the closing quote ends the number: keyword 0, not keyword 10). */
  firstKeyword = 'synthetic keyword 0"',
  keywordWorld = () => ({
    campaigns: {[campaign(9)]: {status: 'PAUSED', channel: 'SEARCH'}},
    adGroups: {[AD_GROUP]: {status: 'PAUSED', campaign: campaign(9)}},
  }),
  keywords = n =>
    Array.from({length: n}, (_, i) => ({
      create: {ad_group: AD_GROUP, keyword: {text: 'synthetic keyword ' + i, match_type: 'BROAD'}},
    })),
  /** How many requests that reached the synthetic provider hold this text. */
  writesHolding = (x, text) => x.log.filter(r => r.kind === 'write' && JSON.stringify(r.body).includes(text)).length;
