import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {JsonObject} from './types.js';

const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const invalid = (): never => {
  throw new MirrorError(
    'CONVERSION_STATE_UNVERIFIED',
    'The conversion resource contains malformed or inconsistent campaign membership.',
  );
};
const campaign = (v: unknown): v is string =>
  typeof v === 'string' && /^urn:li:sponsoredCampaign:[1-9][0-9]{0,19}$/.test(v);

/** Provider-documented conversion configuration; callback times describe tracking
 * observations, not changes to a conversion rule. Unknown fields stay protected.
 * associatedCampaigns is a set of association records, while campaigns is URNs.
 * See LinkedIn Insight Tag Conversion Tracking, API 202605, checked 2026-09-19. */
export function linkedinConversionConfiguration(row: JsonObject): JsonObject {
  const {lastCallbackAt, latestFirstPartyCallbackAt, ...out} = row;
  if (object(out.value) && typeof out.value.amount === 'string' && /^\d+(?:\.\d+)?$/.test(out.value.amount))
    out.value = {
      ...out.value,
      amount: out.value.amount
        .replace(/^0+(?=\d)/, '')
        .replace(/(\.\d*?)0+$/, '$1')
        .replace(/\.$/, ''),
    };
  if (out.urlMatchRuleExpression !== undefined) {
    const value = out.urlMatchRuleExpression;
    if (
      !Array.isArray(value) ||
      value.some(
        v =>
          !Array.isArray(v) ||
          v.some(x => !object(x) || typeof x.matchType !== 'string' || typeof x.matchValue !== 'string'),
      )
    )
      invalid();
    out.urlMatchRuleExpression = (value as JsonObject[][])
      .map(v => [...v].sort((a, b) => stable(a).localeCompare(stable(b), 'en')))
      .sort((a, b) => stable(a).localeCompare(stable(b), 'en'));
  }
  if (out.campaigns !== undefined) {
    if (
      !Array.isArray(out.campaigns) ||
      out.campaigns.some((v: unknown) => !campaign(v)) ||
      new Set(out.campaigns).size !== out.campaigns.length
    )
      invalid();
    out.campaigns = [...out.campaigns].sort();
  }
  if (out.associatedCampaigns !== undefined) {
    if (!Array.isArray(out.associatedCampaigns)) invalid();
    const seen = new Set<string>();
    out.associatedCampaigns = out.associatedCampaigns
      .map((value: unknown) => {
        if (
          !object(value) ||
          !campaign(value.campaign) ||
          value.conversion !== 'urn:lla:llaPartnerConversion:' + row.id ||
          seen.has(value.campaign) ||
          value.error !== undefined ||
          value.errors !== undefined
        )
          invalid();
        const {associatedAt, ...config} = value as JsonObject;
        seen.add(config.campaign);
        return config;
      })
      .sort((a: JsonObject, b: JsonObject) => stable(a).localeCompare(stable(b), 'en'));
    if (
      out.campaigns !== undefined &&
      (out.campaigns.length !== seen.size || out.campaigns.some((id: string) => !seen.has(id)))
    )
      invalid();
  }
  return out;
}
