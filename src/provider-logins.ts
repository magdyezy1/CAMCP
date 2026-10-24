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
import {wooCommerceLogin} from './woocommerce-login.js';

/**
 * The provider login registry (ARC-01 phase B, the server discovery and OAuth configurations): each provider's steps
 * of the website's logins, its OAuth flow steps and its asset discovery (src/<provider>-login.ts), by gateway, in the
 * order of the website platforms (server/platform-oauth.ts). Only the website's server consults it
 * (server/platform-oauth.ts, server/asset-discovery.ts, server/google-reauthorization.ts, server/social-signin.ts,
 * server/platform-routes.ts), so the reviewed-write path, which loads the provider hooks (src/provider-hooks.ts), never
 * loads these steps. No provider module imports it; the architecture ratchet (tools/architecture-map.mjs) counts it
 * with the providers.
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
/** The providers whose logins are set up with a key on their own website page, not a website platform's OAuth flow. */
export const registeredKeyedLogins: readonly ProviderLogin[] = Object.freeze([wooCommerceLogin]);

const byGateway = new Map<string, ProviderLogin>();
for (const login of [...registeredProviderLogins, ...registeredKeyedLogins]) {
  // Load-time checks, like the hooks registry's: a provider's login steps are one frozen declaration of an adapter's
  // gateway, its OAuth steps name its endpoints and either both or neither of its own start and completion, and its
  // discovery has one entry point.
  if (!providerOf(login.gateway))
    throw new Error('Provider login steps name no provider adapter: ' + login.gateway + '.');
  if (byGateway.has(login.gateway)) throw new Error('Two provider login steps name ' + login.gateway + '.');
  for (const part of [login, login.oauth, login.discovery, login.renewal, login.signIn, login.keyed])
    if (part && !Object.isFrozen(part))
      throw new Error('Provider login steps of ' + login.gateway + ' are not frozen.');
  // A sign-in names its three endpoints, each an HTTPS URL.
  if (
    login.signIn &&
    [login.signIn.authorize, login.signIn.token, login.signIn.profile].some(
      url => typeof url !== 'string' || !url.startsWith('https://'),
    )
  )
    throw new Error('The sign-in of ' + login.gateway + ' needs its HTTPS authorization, token and profile endpoints.');
  // A renewal's steps are both its reads: the accounts a fresh authorization reaches, and the selected-account read.
  if (
    login.renewal &&
    (typeof login.renewal.accounts !== 'function' || typeof login.renewal.selectedAccountRead !== 'function')
  )
    throw new Error('The renewal of ' + login.gateway + ' needs its account listing and selected-account read.');
  if (registeredKeyedLogins.includes(login)) {
    // A keyed login lists its saved sources, and takes no OAuth flow, discovery, renewal or sign-in.
    if (typeof login.keyed?.sources !== 'function' || login.oauth || login.discovery || login.renewal || login.signIn)
      throw new Error('The keyed logins of ' + login.gateway + ' need their sources, and only them.');
  } else {
    if (login.keyed) throw new Error('A website platform login of ' + login.gateway + ' is not a keyed login.');
    if (!login.oauth || typeof login.oauth.authorize !== 'string' || typeof login.oauth.token !== 'string')
      throw new Error('The OAuth steps of ' + login.gateway + ' need its authorization and token endpoints.');
    if (!login.oauth.begin !== !login.oauth.complete)
      throw new Error('The OAuth steps of ' + login.gateway + ' need both or neither of begin and complete.');
    if (login.discovery && !login.discovery.kind === !login.discovery.all)
      throw new Error('The discovery of ' + login.gateway + ' needs exactly one of kind and all.');
  }
  byGateway.set(login.gateway, login);
}

/** The website login steps of a gateway's provider, or undefined for a gateway without any. */
export function providerLogin(gateway: unknown): ProviderLogin | undefined {
  return typeof gateway === 'string' ? byGateway.get(gateway) : undefined;
}
