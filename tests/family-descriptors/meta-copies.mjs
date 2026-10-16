// meta_copies: POST /{ad_set_id}/copies with deep_copy (Meta Marketing API v26.0, Ad Campaign copies), which copies the
// ad set PAUSED into another campaign "with its children" (the ads). A deep copy duplicates whatever ads the ad set
// holds when Meta runs it, so the decisive field is the source's list of ads: an ad added in Meta after the review
// would be copied without the owner having seen it.
import {decode, unsupported, v} from './_meta.mjs';

const account = '123';
const node = (state, id, fields) =>
  Object.fromEntries(fields.filter(f => state.nodes[id][f] !== undefined).map(f => [f, state.nodes[id][f]]));

export default {
  family: 'meta_copies',
  risk: 'activation',
  gateway: 'meta_native_action',
  account,
  connection: {scopes: ['ads_management']},
  owned: ['200', '101'],
  request: {
    action: 'meta_ad_set_id_copies_copy',
    path_params: {ad_set_id: '200'},
    payload: {status_option: 'PAUSED', deep_copy: true, campaign_id: '101'},
  },
  // An ad set under a campaign budget (no budget of its own), two ads, and the paused target campaign.
  seed: () => ({
    next: 1000,
    nodes: {
      101: {id: '101', account_id: account, name: 'Target', status: 'PAUSED', objective: 'OUTCOME_LEADS'},
      200: {
        id: '200',
        account_id: account,
        campaign_id: '100',
        name: 'Riyadh',
        status: 'ACTIVE',
        optimization_goal: 'LEAD_GENERATION',
      },
      300: {id: '300', account_id: account, campaign_id: '100', adset_id: '200', name: 'Video A', status: 'ACTIVE'},
      301: {id: '301', account_id: account, campaign_id: '100', adset_id: '200', name: 'Video B', status: 'ACTIVE'},
    },
  }),
  isWrite: ({method}) => method === 'POST',
  provider({method, path, url, body, state, mode}) {
    const fields = (url.searchParams.get('fields') ?? '').split(',');
    let m;
    if (method === 'GET' && (m = /^\/v26\.0\/(\d+)\/ads$/.exec(path)))
      return {
        json: {
          data: Object.keys(state.nodes)
            .filter(id => state.nodes[id].adset_id === m[1] && !state.nodes[id].copied)
            .map(id => node(state, id, fields)),
          // Another page: Meta names paging.next beside the ads it returned.
          paging: {
            cursors: {before: 'b', after: 'a'},
            ...(mode.paginate ? {next: 'https://graph.facebook.com' + path} : {}),
          },
        },
      };
    if (method === 'GET' && (m = /^\/v26\.0\/(\d+)$/.exec(path)) && state.nodes[m[1]])
      return {json: node(state, m[1], fields)};
    if (method === 'POST' && path === v + '/200/copies') {
      // A partial answer: Meta answers without the copied ad set's ID.
      if (mode.partial) return {json: {}};
      const b = decode(body),
        copy = (row, extra) => {
          const id = String(state.next++);
          state.nodes[id] = {...row, ...extra, id, status: b.status_option, name: row.name + ' - Copy', copied: true};
          return id;
        };
      const id = copy(state.nodes[200], {campaign_id: b.campaign_id}),
        ads = Object.values(state.nodes).filter(r => r.adset_id === '200' && !r.copied);
      return {
        json: {
          copied_adset_id: id,
          ad_object_ids: [
            {ad_object_type: 'ad_set', source_id: '200', copied_id: id},
            ...ads.map(ad => ({
              ad_object_type: 'ad',
              source_id: ad.id,
              copied_id: copy(ad, {adset_id: id, campaign_id: b.campaign_id}),
            })),
          ],
        },
      };
    }
    return unsupported();
  },
  decisive: {
    change: state =>
      (state.nodes[302] = {
        id: '302',
        account_id: account,
        campaign_id: '100',
        adset_id: '200',
        name: 'Video C',
        status: 'ACTIVE',
      }),
    field: /data/,
  },
};
