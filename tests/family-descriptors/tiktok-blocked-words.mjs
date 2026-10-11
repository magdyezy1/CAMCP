// tiktok_blocked_words: POST /v1.3/blockedword/create/ (API for Business v1.3, "Create blocked words"). An ad account
// holds at most 500 blocked words and replies carry no word IDs, so the decisive field is the account's complete
// blocked word list ("Get blocked words", `bw_content`): a list changed in TikTok after the review changes what the
// creation adds to and the 500-word limit it is measured against.
import {failed, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_blocked_words',
  risk: 'settings',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {action: 'tiktok_blockedword_create', payload: {advertiser_id: '123', blocked_words: ['scam']}},
  seed: () => ({words: ['spam', 'fake']}),
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/blockedword/create/'),
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/blockedword/list/')) {
      const page = Number(url.searchParams.get('page') ?? 1);
      // Another page: TikTok declares more pages (page_info.total_page) than one review reads.
      return ok({
        list: page === 1 ? state.words.map((w, i) => ({bw_id: String(900 + i), bw_content: w})) : [],
        page_info: {page, page_size: 500, total_number: state.words.length, total_page: mode.paginate ? 9 : 1},
      });
    }
    if (method === 'POST' && path.endsWith('/v1.3/blockedword/create/')) {
      if (mode.partial) return failed('Blocked word limit reached');
      state.words.push(...body.blocked_words);
      return ok({});
    }
  },
  decisive: {change: state => state.words.push('cheap'), field: /words/},
};
