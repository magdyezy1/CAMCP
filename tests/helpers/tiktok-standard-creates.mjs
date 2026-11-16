// The three standard TikTok creates (a campaign, an ad group and an ad), which no reviewed family claims, over a
// synthetic TikTok business API: the review lifecycle (MirrorService, NativeTransport, the store) with nothing sent
// outside the process. Shared by the tests of package r25-m0-t1 (T1: the advertiser row; Q14: paused creates).
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {advertiserAnswer, answer} from './tiktok-advertiser-noise.mjs';

const gateway = 'tiktok_native_action',
  key = Buffer.alloc(32, 58).toString('base64');

/** One valid create of each kind for advertiser `id`, all paused, under campaign 300 and ad group 200. */
export const standardBodies = id => ({
  campaign: {
    action: 'tiktok_campaign_create',
    payload: {
      advertiser_id: id,
      campaign_name: 'Synthetic campaign',
      objective_type: 'TRAFFIC',
      budget_mode: 'BUDGET_MODE_INFINITE',
      operation_status: 'DISABLE',
    },
  },
  adgroup: {
    action: 'tiktok_adgroup_create',
    payload: {
      advertiser_id: id,
      campaign_id: '300',
      adgroup_name: 'Synthetic ad group',
      promotion_type: 'WEBSITE',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      location_ids: ['6252001'],
      budget_mode: 'BUDGET_MODE_DAY',
      budget: 50,
      schedule_type: 'SCHEDULE_FROM_NOW',
      schedule_start_time: '2027-01-01 00:00:00',
      optimization_goal: 'CLICK',
      billing_event: 'CPC',
      bid_type: 'BID_TYPE_NO_BID',
      operation_status: 'DISABLE',
    },
  },
  ad: {
    action: 'tiktok_ad_create',
    payload: {
      advertiser_id: id,
      adgroup_id: '200',
      creatives: [
        {
          ad_name: 'Synthetic ad',
          ad_format: 'SINGLE_IMAGE',
          image_ids: ['img-1'],
          ad_text: 'Synthetic',
          call_to_action: 'LEARN_MORE',
          landing_page_url: 'https://example.test/',
          identity_type: 'CUSTOMIZED_USER',
          identity_id: '7777',
          operation_status: 'DISABLE',
        },
      ],
    },
  },
});

/**
 * A fixture over the advertiser `world` (tests/helpers/tiktok-advertiser-noise.mjs). `parents` holds the status of the
 * campaign 300 and the ad group 200 the creates sit under, which a test may change at any time; a status set to
 * undefined leaves the field out of the row TikTok returns. `sent` lists every provider write. `parentExtra(kind, n)`
 * (r25-m1-hash) adds fields to the row of the `campaign` or `adgroup` parent on its n-th read, for noise that rotates or
 * for the configuration a parent carries; none by default. `post(path, body, n)` (r25-m2-refusal) answers the n-th provider
 * write: a Response replaces TikTok's success answer, a thrown error is a response that was lost, undefined keeps the
 * success answer.
 */
export function standardCreates(
  world,
  {tenant = 'standard-creates', parentExtra = () => ({}), post = () => undefined} = {},
) {
  const actor = {tenantId: tenant, userId: 'operator', role: 'operator'},
    owner = {...actor, userId: 'owner', role: 'admin'},
    store = new Store(':memory:', key),
    connection = {
      id: 'login',
      tenantId: tenant,
      gateway,
      accounts: [world.id],
      writeAccounts: [world.id],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    parents = {campaign: 'DISABLE', adgroup: 'DISABLE'},
    parentReads = {campaign: 0, adgroup: 0},
    sent = [],
    requests = [],
    page = {page: 1, page_size: 100, total_number: 1, total_page: 1};
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  // The campaign and ad group an agent's earlier reads showed AMCP in this account.
  for (const id of ['300', '200']) store.rememberResource(connection, world.id, id);
  const transport = new NativeTransport(async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname.replace('/open_api', ''),
      method = init.method ?? 'GET';
    requests.push(method + ' ' + path);
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      sent.push({path, body});
      const own = post(path, body, sent.length);
      if (own !== undefined) return own;
      return Response.json(answer({campaign_id: '301', adgroup_id: '201', ad_ids: ['101']}));
    }
    if (path === '/v1.3/advertiser/info/') return Response.json(answer({list: [advertiserAnswer(world, url)]}));
    if (path === '/v1.3/campaign/get/')
      return Response.json(
        answer({
          list: [
            {
              campaign_id: '300',
              advertiser_id: world.id,
              operation_status: parents.campaign,
              ...parentExtra('campaign', ++parentReads.campaign),
            },
          ],
          page_info: page,
        }),
      );
    if (path === '/v1.3/adgroup/get/')
      return Response.json(
        answer({
          list: [
            {
              adgroup_id: '200',
              campaign_id: '300',
              advertiser_id: world.id,
              operation_status: parents.adgroup,
              ...parentExtra('adgroup', ++parentReads.adgroup),
            },
          ],
          page_info: page,
        }),
      );
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const call = (tool, input) => service.call(tool, input, actor);
  return {
    store,
    actor,
    owner,
    tenant,
    world,
    parents,
    sent,
    requests,
    /** The result of amcp_write prepare for create `kind`; `edit` changes the payload of the valid create. */
    prepare: (kind, edit = payload => payload) => {
      const body = standardBodies(world.id)[kind];
      return call('amcp_write', {
        action: 'prepare',
        gateway,
        connection_id: connection.id,
        arguments: {action: body.action, account_id: world.id, payload: edit(structuredClone(body.payload))},
      });
    },
    /** execute of a prepared review (its data); `flags` are the acknowledgements it carries. */
    execute: (review, flags = {spend_change_confirmed: true}) =>
      call('amcp_write', {
        action: 'execute',
        review_id: review.review_id,
        idempotency_key: review.idempotency_key ?? review.review_id,
        confirmed: true,
        ...flags,
      }),
    /** Any amcp_write call, for a write that is no create (a status or budget update of an existing object). */
    write: input => call('amcp_write', {gateway, connection_id: connection.id, ...input}),
    /** Any amcp_campaign call (r25-m2-refusal), for the steps of a plan over the same synthetic advertiser. */
    plan: input => call('amcp_campaign', input),
    /** amcp_write status of a review (r25-m2-refusal): a retained review is read back by AMCP alone. */
    status: review => call('amcp_write', {action: 'status', review_id: review.review_id}),
    /** The state of the idempotency claim of a review (pending, complete, uncertain, rejected), or undefined. */
    claimState: review =>
      store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(tenant, review.review_id)
        ?.state,
    close: () => store.close(),
  };
}
