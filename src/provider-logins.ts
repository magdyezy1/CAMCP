import type {ProviderLogin} from './provider-login.js';
import {providerOf} from './provider-adapters.js';
import {googleSheetsLogin, googleDriveLogin} from './google-files-login.js';
import {microsoftLogin} from './microsoft-login.js';
import {googleAdsLogin} from './google-ads-login.js';
import {metaLogin} from './meta-login.js';
import {tiktokLogin} from './tiktok-login.js';
import {snapchatLogin} from './snapchat-login.js';
import {linkedinLogin} from './linkedin-login.js';
import {xLogin} from './x-login.js';
import {ga4Login} from './ga4-login.js';
import {gtmLogin} from './gtm-login.js';
import {searchConsoleLogin} from './google-search-console-login.js';
import {appleLogin} from './apple-login.js';
import {dv360Login} from './dv360-login.js';
import {googleBusinessLogin} from './google-business-login.js';
import {redditLogin} from './reddit-login.js';

/**
 * The provider login registry (ARC-01 phase B, the server discovery configurations): each provider's steps of the
 * website's logins, its asset discovery (src/<provider>-login.ts), by gateway, in the order of the website platforms
 * (server/platform-oauth.ts). Only the website's server consults it (server/asset-discovery.ts), so the reviewed-write
 * path, which loads the provider hooks (src/provider-hooks.ts), never loads these steps. No provider module imports
 * it; the architecture ratchet (tools/architecture-map.mjs) counts it with the providers.
 */
export const registeredProviderLogins: readonly ProviderLogin[] = Object.freeze([
  googleSheetsLogin,
  googleDriveLogin,
  microsoftLogin,
  googleAdsLogin,
  metaLogin,
  tiktokLogin,
  snapchatLogin,
  linkedinLogin,
  xLogin,
  ga4Login,
  gtmLogin,
  searchConsoleLogin,
  appleLogin,
  dv360Login,
  googleBusinessLogin,
  redditLogin,
]);

const byGateway = new Map<string, ProviderLogin>();
for (const login of registeredProviderLogins) {
  // Load-time checks, like the hooks registry's: a provider's login steps are one frozen declaration of an adapter's
  // gateway, and its discovery has one entry point.
  if (!providerOf(login.gateway))
    throw new Error('Provider login steps name no provider adapter: ' + login.gateway + '.');
  if (byGateway.has(login.gateway)) throw new Error('Two provider login steps name ' + login.gateway + '.');
  for (const part of [login, login.discovery])
    if (part && !Object.isFrozen(part))
      throw new Error('Provider login steps of ' + login.gateway + ' are not frozen.');
  if (login.discovery && !login.discovery.kind === !login.discovery.all)
    throw new Error('The discovery of ' + login.gateway + ' needs exactly one of kind and all.');
  byGateway.set(login.gateway, login);
}

/** The website login steps of a gateway's provider, or undefined for a gateway without any. */
export function providerLogin(gateway: unknown): ProviderLogin | undefined {
  return typeof gateway === 'string' ? byGateway.get(gateway) : undefined;
}
