import type {ErrorRemedy} from './errors.js';
import {googleBusinessRemedies} from './google-business-remedies.js';
import {googleRemedies} from './google-remedies.js';
import {linkedinRemedies} from './linkedin-remedies.js';
import {metaRemedies} from './meta-remedies.js';
import {microsoftRemedies} from './microsoft-remedies.js';
import {redditRemedies} from './reddit-remedies.js';
import {snapchatRemedies} from './snapchat-remedies.js';
import {tiktokRemedies} from './tiktok-remedies.js';
import {xRemedies} from './x-remedies.js';

/**
 * A remedy a provider declares for its own refusals (ARC-04 stage C). `codes` names exact codes, and code prefixes
 * written with a trailing `*` (`X_TARGETING_*`); `when`, where present, narrows the rule by the refusal's details.
 * Within a provider's table the first rule that answers a refusal wins, so an exact code comes before a prefix that
 * would also match it.
 */
export interface ProviderRemedy {
  readonly codes: readonly string[];
  readonly when?: (details: Record<string, unknown>) => boolean;
  readonly remedy: Readonly<ErrorRemedy>;
}

/**
 * The remedy tables providers declare in their own modules (`src/<provider>-remedies.ts`), by provider ID as
 * src/provider-adapters.ts names them. A provider adds a remedy for one of its refusals to its own table; errorRemedy
 * (src/errors.ts) consults every table before its shared rules. No two providers' rules answer the same code
 * (tests/provider-remedies.test.mjs), so the order of the tables does not matter. A leaf: the tables import nothing at
 * load, so src/errors.ts, which every module imports, stays one too.
 */
export const providerRemedyTables: Readonly<Record<string, readonly ProviderRemedy[]>> = Object.freeze({
  google: googleRemedies,
  google_business: googleBusinessRemedies,
  meta: metaRemedies,
  tiktok: tiktokRemedies,
  snapchat: snapchatRemedies,
  linkedin: linkedinRemedies,
  x: xRemedies,
  microsoft: microsoftRemedies,
  reddit: redditRemedies,
});

/** True when a rule's code list names `code`: exactly, or by a prefix written with a trailing `*`. */
export function remedyNamesCode(codes: readonly string[], code: string): boolean {
  return codes.some(name => (name.endsWith('*') ? code.startsWith(name.slice(0, -1)) : code === name));
}

/** Every provider's rules, frozen, in table order. */
export const providerRemedies: readonly ProviderRemedy[] = Object.freeze(
  Object.values(providerRemedyTables).flatMap(table =>
    table.map(rule =>
      Object.freeze({...rule, codes: Object.freeze([...rule.codes]), remedy: Object.freeze({...rule.remedy})}),
    ),
  ),
);

/**
 * The remedy a provider declares for a refusal with this code and these details, as a copy the caller may change, or
 * undefined when no provider's rule answers it.
 */
export function providerRemedy(code: string, details: Record<string, unknown>): ErrorRemedy | undefined {
  for (const rule of providerRemedies)
    if (remedyNamesCode(rule.codes, code) && (!rule.when || rule.when(details))) return {...rule.remedy};
  return undefined;
}
