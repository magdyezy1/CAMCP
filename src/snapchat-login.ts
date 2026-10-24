import type {DiscoveryContext, ProviderLogin, WorkspaceAsset} from './provider-login.js';
import type {JsonObject} from './types.js';

/**
 * Snapchat's website login steps (ARC-01 phase B; registered in src/provider-logins.ts). Discovery: the organizations
 * the login reaches, and each one's ad accounts, public profiles, pixels, apps or catalogs. Its authorization is
 * OAuth 2.0 with the authorization code, without a step of its own.
 */
async function snapchatDiscovery(kind: string, c: DiscoveryContext): Promise<WorkspaceAsset[]> {
  const assets: WorkspaceAsset[] = [];
  const organizations = await c.pages('/v1/me/organizations', {}, d =>
    d.organizations.map((r: JsonObject) => r.organization),
  );
  for (const org of organizations) {
    const edge = kind === 'ad_accounts' ? 'adaccounts' : kind === 'profiles' ? 'public_profiles' : kind;
    const rows = await c.pages('/v1/organizations/' + encodeURIComponent(String(org.id)) + '/' + edge, {}, d =>
      d[edge].map(
        (r: JsonObject) =>
          r[
            edge === 'adaccounts'
              ? 'adaccount'
              : edge === 'public_profiles'
                ? 'public_profile'
                : edge === 'mobile_apps'
                  ? 'mobile_app'
                  : edge.replace(/s$/, '')
          ],
      ),
    );
    assets.push(...rows.map(r => c.asset(r, kind, String(org.id))));
  }
  return assets;
}

export const snapchatLogin: ProviderLogin = Object.freeze({
  gateway: 'snapchat_native_action',
  discovery: Object.freeze({kind: snapchatDiscovery}),
});
