import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {googlePortfolioPage} from '../dist/src/google-portfolio.js';
import {metaPortfolioPage} from '../dist/src/meta-portfolio.js';
import {linkedinPortfolioPage} from '../dist/src/linkedin-portfolio.js';
import {snapchatPortfolioPage} from '../dist/src/snapchat-portfolio.js';
import {tiktokPortfolioPage} from '../dist/src/tiktok-portfolio.js';
import {xPortfolioPage} from '../dist/src/x-portfolio.js';
import {microsoftPortfolioPage} from '../dist/src/microsoft-portfolio.js';
import {snapchatScope} from '../dist/src/provider-grants.js';
import {microsoftScope} from '../dist/src/microsoft-native.js';

/**
 * ARC-04 stage E: the refusal contract every portfolio adapter keeps, driven through each adapter's page with a
 * synthetic gateway (the provider-specific behaviour stays covered by each provider's own portfolio test). A cursor is
 * refused with INVALID_CURSOR before any read when it was tampered with, encoded non-canonically, oversized, made for
 * another read, expired, or made under a login that has since changed; a login change during a read refuses with
 * CONNECTION_AUTHORITY_CHANGED; an adapter that relies on parent observations refuses an unobserved parent with
 * RESOURCE_SCOPE_REQUIRED before any read. The non-canonical case failed for Meta before the shared codec.
 */
const snapAccount = '10000000-0000-4000-8000-000000000000',
  snapCampaign = n => '20000000-0000-4000-8000-00000000000' + n;
const success = data => ({success: true, data: {data}});
const providers = {
  google: {
    page: googlePortfolioPage,
    gateway: 'google_ads_native_action',
    account: '1234567890',
    scopes: ['https://www.googleapis.com/auth/adwords'],
    cap: 2048,
    limit: 1,
    observesParents: false,
    respond: () => {
      const row = id => ({
        customer: {id: '1234567890', resourceName: 'customers/1234567890', currencyCode: 'USD', timeZone: 'UTC'},
        campaign: {
          id,
          resourceName: 'customers/1234567890/campaigns/' + id,
          name: 'Campaign ' + id,
          status: 'ENABLED',
          advertisingChannelType: 'SEARCH',
        },
      });
      return success({results: [row('11'), row('12')]});
    },
  },
  tiktok: {
    page: tiktokPortfolioPage,
    gateway: 'tiktok_native_action',
    account: '100',
    scopes: [],
    cap: 14000,
    limit: 1,
    observesParents: false,
    respond: input =>
      input.action === 'tiktok_advertiser_info_get'
        ? success({code: 0, data: {list: [{advertiser_id: '100', currency: 'USD', timezone: 'Etc/GMT'}]}})
        : success({
            code: 0,
            data: {
              list: [
                {
                  advertiser_id: '100',
                  campaign_id: '9007199254740993',
                  campaign_name: 'Campaign',
                  operation_status: 'ENABLE',
                  secondary_status: 'CAMPAIGN_STATUS_ENABLE',
                  budget_mode: 'BUDGET_MODE_DAY',
                  budget: 10,
                },
              ],
              page_info: {page: 1, page_size: 1, total_number: 2, total_page: 2},
            },
          }),
  },
  x: {
    page: xPortfolioPage,
    gateway: 'x_ads_native_action',
    account: 'acct1',
    scopes: [],
    cap: 20000,
    limit: 1,
    observesParents: false,
    respond: input =>
      input.action === 'x_accounts_account_id_get'
        ? success({request: {params: {account_id: 'acct1'}}, data: {id: 'acct1', deleted: false, timezone: 'UTC'}})
        : success({
            request: {params: {account_id: 'acct1'}},
            data: [{id: 'c1', deleted: false, entity_status: 'ACTIVE', name: 'Campaign', currency: 'USD'}],
            next_cursor: 'next-page-token',
          }),
  },
  meta: {
    page: metaPortfolioPage,
    gateway: 'meta_native_action',
    account: '100',
    scopes: ['ads_read'],
    cap: 24000,
    limit: 1,
    observesParents: true,
    child: {entity: 'adset', campaign_id: '99'},
    respond: input =>
      input.action === 'meta_ad_account_id_get'
        ? success({id: 'act_100', account_id: '100', currency: 'USD', timezone_name: 'UTC'})
        : success({
            data: [{id: '11', account_id: '100', name: 'Campaign', status: 'ACTIVE', effective_status: 'ACTIVE'}],
            paging: {cursors: {after: 'after-token'}, next: 'https://graph.facebook.com/next'},
          }),
  },
  linkedin: {
    page: linkedinPortfolioPage,
    gateway: 'linkedin_native_action',
    account: '100',
    scopes: ['r_ads'],
    cap: 24000,
    limit: 1,
    entity: 'campaign_group',
    observesParents: true,
    child: {entity: 'campaign', campaign_group_id: '99'},
    respond: input =>
      input.action === 'linkedin_rest_ad_accounts_ad_account_id_get'
        ? success({id: 100, currency: 'USD'})
        : success({
            elements: [{id: 11, account: 'urn:li:sponsoredAccount:100', name: 'Group', status: 'ACTIVE'}],
            metadata: {nextPageToken: 'next-page-token'},
          }),
  },
  snapchat: {
    page: snapchatPortfolioPage,
    gateway: 'snapchat_native_action',
    account: snapAccount,
    scopes: [snapchatScope],
    cap: 24000,
    limit: 50,
    observesParents: true,
    child: {entity: 'adsquad', campaign_id: snapCampaign(9)},
    respond: input =>
      input.action === 'snapchat_account_get'
        ? success({
            request_status: 'SUCCESS',
            adaccounts: [
              {sub_request_status: 'SUCCESS', adaccount: {id: snapAccount, currency: 'USD', timezone: 'UTC'}},
            ],
          })
        : success({
            request_status: 'SUCCESS',
            campaigns: [
              {
                sub_request_status: 'SUCCESS',
                campaign: {id: snapCampaign(1), ad_account_id: snapAccount, name: 'Campaign', status: 'ACTIVE'},
              },
            ],
            paging: {
              next_link:
                'https://adsapi.snapchat.com/v1/adaccounts/' +
                snapAccount +
                '/campaigns?cursor=next-page-token&limit=50&sort=created_at-desc',
            },
          }),
  },
  microsoft: {
    page: microsoftPortfolioPage,
    gateway: 'microsoft_ads_native_action',
    account: '1234',
    scopes: [microsoftScope],
    cap: 4096,
    limit: 1,
    observesParents: true,
    child: {entity: 'ad_group', campaign_id: '99'},
    respond: input =>
      input.action === 'GetAccount'
        ? success({Account: {Id: 1234, CurrencyCode: 'USD', TimeZone: 'UTC'}})
        : success({
            Campaigns: [
              {Id: 11, Name: 'One', Status: 'Active', CampaignType: 'Search'},
              {Id: 12, Name: 'Two', Status: 'Active', CampaignType: 'Search'},
            ],
          }),
  },
};

function world(name) {
  const p = providers[name],
    actor = {tenantId: 'portfolio-contract-' + name, userId: 'reader', role: 'reader'},
    store = new Store(':memory:', Buffer.alloc(32, 140).toString('base64')),
    connection = {
      id: '55555555-6666-4666-8666-666666666666',
      tenantId: actor.tenantId,
      gateway: p.gateway,
      accounts: [p.account],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic ' + name,
      scopes: p.scopes,
    };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  const calls = [];
  let during,
    logins = 0;
  const call = async (tool, input) => {
    calls.push(input.action);
    assert.equal(tool, p.gateway);
    const response = p.respond(input);
    during?.();
    return response;
  };
  const input = (extra = {}) => ({
    action: 'portfolio',
    gateway: p.gateway,
    connection_id: connection.id,
    account_id: p.account,
    requirements: {entity: p.entity ?? 'campaign'},
    limit: p.limit,
    ...extra,
  });
  const refusal = async extra => {
    try {
      await p.page(store, call, actor, input(extra));
    } catch (error) {
      return error;
    }
    assert.fail(name + ': no refusal');
  };
  return {
    p,
    actor,
    store,
    connection,
    calls,
    input,
    refusal,
    page: extra => p.page(store, call, actor, input(extra)),
    relogin: () => store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'replacement-' + ++logins}),
    setDuring: fn => (during = fn),
    close: () => store.close(),
  };
}

/**
 * The same payload under another encoding: different unused trailing bits in its last character, or a dangling sixth
 * of a byte the decoder drops. Both decode to the same bytes.
 */
function nonCanonical(cursor) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
    last = alphabet.indexOf(cursor.at(-1)),
    variant = cursor.length % 4 ? cursor.slice(0, -1) + alphabet[last ^ 1] : cursor + 'A';
  assert.equal(Buffer.from(variant, 'base64url').toString('base64url'), cursor, 'same bytes, different text');
  return variant;
}

for (const name of Object.keys(providers))
  test(name + ' portfolio keeps the shared cursor, login and parent refusal contract', async () => {
    const w = world(name);
    try {
      const first = await w.page();
      assert.equal(first.has_more, true, name);
      assert.equal(typeof first.next_cursor, 'string');
      const reads = w.calls.length;
      const refusedCursor = async (cursor, extra = {}) => {
        const before = w.calls.length,
          error = await w.refusal({cursor, ...extra});
        assert.equal(error.code, 'INVALID_CURSOR', name + ' ' + error.message);
        assert.equal(w.calls.length, before, name + ': no read for a refused cursor');
      };
      const decoded = JSON.parse(Buffer.from(first.next_cursor, 'base64url').toString('utf8'));
      // Tampered: one signed field changed, the signature kept.
      await refusedCursor(Buffer.from(JSON.stringify({...decoded, page: 99})).toString('base64url'));
      // The same signed payload under another encoding.
      await refusedCursor(nonCanonical(first.next_cursor));
      // Longer than the adapter seals.
      await refusedCursor(first.next_cursor + 'A'.repeat(w.p.cap));
      // Made for another read: the page size is part of the binding.
      await refusedCursor(first.next_cursor, {limit: w.p.limit + 1});
      // Expired: five minutes after it was sealed.
      const now = Date.now;
      Date.now = () => now() + 300001;
      try {
        await refusedCursor(first.next_cursor);
      } finally {
        Date.now = now;
      }
      // The login changed between pages: the cursor belongs to the old one.
      w.relogin();
      await refusedCursor(first.next_cursor);
      assert.equal(w.calls.length, reads);
      // The login changes during a read: refused once the read returns.
      w.setDuring(() => w.relogin());
      const changed = await w.refusal();
      assert.equal(changed.code, 'CONNECTION_AUTHORITY_CHANGED', name + ' ' + changed.message);
      w.setDuring(undefined);
      if (w.p.observesParents) {
        const before = w.calls.length,
          parent = await w.refusal({requirements: w.p.child});
        assert.equal(parent.code, 'RESOURCE_SCOPE_REQUIRED', name + ' ' + parent.message);
        assert.equal(w.calls.length, before, name + ': no read for an unobserved parent');
      }
    } finally {
      w.close();
    }
  });

test('the portfolio registry has one adapter per gateway, each an active provider, and dispatches by gateway', async () => {
  const {portfolioAdapters, portfolioPage} = await import('../dist/src/portfolio.js'),
    {providerOf} = await import('../dist/src/provider-adapters.js');
  const gateways = portfolioAdapters.map(a => a.gateway);
  assert.deepEqual(gateways, [...new Set(gateways)]);
  assert.deepEqual(
    [...gateways].sort(),
    Object.values(providers)
      .map(p => p.gateway)
      .sort(),
  );
  const store = new Store(':memory:', Buffer.alloc(32, 141).toString('base64')),
    actor = {tenantId: 'portfolio-registry', userId: 'reader', role: 'reader'},
    call = async () => assert.fail('no read');
  try {
    for (const adapter of portfolioAdapters) {
      assert.equal(providerOf(adapter.gateway)?.status, 'active', adapter.gateway);
      assert.ok(adapter.entities.length === 3, adapter.gateway);
      // An unknown entity is refused by the adapter of the gateway, whose message names exactly its entities.
      const error = await portfolioPage(store, call, actor, {
        gateway: adapter.gateway,
        account_id: '1',
        requirements: {entity: 'unknown'},
      }).catch(e => e);
      assert.equal(error.code, 'INVALID_ARGUMENT', adapter.gateway);
      for (const entity of adapter.entities) assert.match(error.message, new RegExp('\\b' + entity + '\\b'));
    }
    const other = await portfolioPage(store, call, actor, {gateway: 'reddit_native_action'}).catch(e => e);
    assert.equal(other.code, 'PORTFOLIO_UNQUALIFIED');
  } finally {
    store.close();
  }
});
