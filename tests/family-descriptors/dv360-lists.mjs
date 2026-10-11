// dv360_lists: POST /v4/advertisers/{advertiserId}/negativeKeywordLists/{id}/negativeKeywords:bulkEdit (Display & Video
// 360 API v4, advertisers.negativeKeywordLists.negativeKeywords.bulkEdit) adding one keyword and removing another from a
// list every line item that uses it shares. The decisive field is the list's membership in
// negativeKeywords.list: a keyword added or removed in DV360 after the review changes the list the edit produces.
import {list, notFound, scopes} from './_dv360.mjs';

const parent = '/v4/advertisers/123/negativeKeywordLists/100',
  collection = parent + '/negativeKeywords';
const keyword = value => ({
  keywordValue: value,
  name: collection.slice(4) + '/' + encodeURIComponent(value),
});

export default {
  family: 'dv360_lists',
  risk: 'activation',
  gateway: 'dv360_native_action',
  account: '123',
  connection: {scopes},
  arguments: {
    action: 'DV360_ADVERTISERS_NEGATIVE_KEYWORD_LISTS_NEGATIVE_KEYWORDS_BULK_EDIT',
    params: {advertiserId: '123', negativeKeywordListId: '100'},
    body: {createdNegativeKeywords: [{keywordValue: 'cheap flights'}], deletedNegativeKeywords: ['free trial']},
  },
  seed: () => ({
    list: {
      negativeKeywordListId: '100',
      advertiserId: '123',
      name: parent.slice(4),
      displayName: 'Brand exclusions',
    },
    keywords: [keyword('free trial'), keyword('jobs')],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path === parent) return {json: structuredClone(state.list)};
    // The reader follows up to 100 membership pages; here every page after the first names the cursor it was read
    // with again, a membership that never ends, which the reader refuses at once instead of after 100 reads.
    if (method === 'GET' && path === collection)
      return mode.paginate && url.searchParams.has('pageToken')
        ? {json: {nextPageToken: url.searchParams.get('pageToken')}}
        : list('negativeKeywords', state.keywords, mode.paginate, url);
    if (method === 'GET') return notFound();
    if (method === 'POST' && path === collection + ':bulkEdit') {
      const created = body.createdNegativeKeywords.map(k => keyword(k.keywordValue));
      state.keywords = [
        ...state.keywords.filter(k => !body.deletedNegativeKeywords.includes(k.keywordValue)),
        ...created,
      ];
      // A partial receipt: DV360 confirms none of the keywords the edit created.
      return {json: mode.partial ? {} : {negativeKeywords: created}};
    }
  },
  decisive: {change: state => state.keywords.push(keyword('discount')), field: /negativeKeywords/},
};
