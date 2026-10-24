import type {googleAccountDiscovery as hierarchy} from '../src/google-account-discovery.js';
import {providerLogin} from '../src/provider-logins.js';
import {googleAdsGateway} from './website-site.js';

// Google Ads' account hierarchy discovery is its provider's (src/google-account-discovery.ts, ARC-01 phase B: the server
// discovery configurations). This module keeps its public import path: the same function, as Google Ads' website login
// steps declare it for a renewal (src/google-ads-login.ts), so the website's server names no provider module.
export const googleAccountDiscovery = providerLogin(googleAdsGateway)!.renewal!.accounts as typeof hierarchy;
