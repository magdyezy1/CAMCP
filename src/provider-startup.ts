import {linkedinVersion} from './linkedin-version.js';
import {resolveMetaVersion} from './meta-version.js';
import {googleDeveloperTokenWarning} from './google-version.js';

/**
 * The provider startup checks (ARC-01 phase B, the composition root): each provider's version pin and configuration
 * warning, which server/runtime.ts runs before the store opens, in the order listed here, so that the composition root
 * names no provider. A registry like the provider hooks: no provider module imports it, and the architecture ratchet
 * (tools/architecture-map.mjs) counts it with the providers.
 */

/**
 * A provider version pin, which fails closed (PRV-02): an unreviewed or sunset version stops the process instead of
 * every later request to the provider. The composition root's refusal names the setting.
 */
export interface ProviderVersionPin {
  /** The deployment setting that pins the version. */
  readonly setting: string;
  /** Returns, or refuses the version the setting names. */
  check(): unknown;
}

/**
 * Configuration that still starts but needs the operator's attention (PRV-04): stated once, at startup, without any
 * secret's value; owner health repeats it.
 */
export interface ProviderStartupWarning {
  /** The event of the startup log line. */
  readonly event: string;
  /** The warning, or undefined while the configuration needs no attention. */
  message(): string | undefined;
}

/** The version pins, in the order the composition root checks them. */
export const providerVersionPins: readonly ProviderVersionPin[] = Object.freeze([
  // LinkedIn: an unreviewed or sunset LinkedIn-Version. Unset, the reviewed default is sent: its own sunset refuses
  // LinkedIn requests (owner health alarms 90 days ahead), never every other provider.
  Object.freeze({
    setting: 'AMCP_LINKEDIN_API_VERSION',
    check: () => process.env.AMCP_LINKEDIN_API_VERSION === undefined || linkedinVersion(),
  }),
  // Meta: a Graph API version AMCP holds no evidence for.
  Object.freeze({setting: 'AMCP_META_API_VERSION', check: () => resolveMetaVersion()}),
]);

/** The configuration warnings, in the order the composition root logs them. */
export const providerStartupWarnings: readonly ProviderStartupWarning[] = Object.freeze([
  // Google sunset developer tokens: AMCP no longer sends AMCP_GOOGLE_DEVELOPER_TOKEN, and says so while it is set.
  Object.freeze({event: 'google_developer_token_ignored', message: () => googleDeveloperTokenWarning()}),
]);
