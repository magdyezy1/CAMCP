// linkedin_insight_tag_domains: POST /rest/insightTagDomains?ids=List(...) BATCH_PARTIAL_UPDATE {entities: {key: {patch:
// {$set: {blocked}}}}} (LinkedIn Conversion Tracking, li-lms-2026-09) blocking two domains of the account's Insight Tag.
// Blocking "may impact associated conversions, website audiences and website professional demographics", and the update
// overwrites each domain's `blocked`, so that is the decisive field: a domain blocked in Campaign Manager after the
// review makes the family's own prerequisite refuse the batch as the state is read again at execute.
import {account} from './_linkedin.mjs';

const key = name => '(account:' + account + ',domainName:' + name + ')',
  names = ['shop.example.com', 'www.example.com'];

export default {
  family: 'linkedin_insight_tag_domains',
  risk: 'settings',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {scopes: ['rw_ads']},
  request: {
    action: 'linkedin_rest_insight_tag_domains_post',
    restli_method: 'BATCH_PARTIAL_UPDATE',
    query: {ids: names.map(key)},
    payload: {entities: Object.fromEntries(names.map(n => [key(n), {patch: {$set: {blocked: true}}}]))},
  },
  seed: () => ({domains: {'www.example.com': false, 'shop.example.com': false, 'old.example.net': true}}),
  unpaginated:
    'the account is read by ID, and the Insight Tag, permission and domain finders are filtered to the one tag of the ' +
    'account, its permission and one domain name each',
  isWrite: ({method}) => method === 'POST',
  provider({method, path, url, body, state, mode}) {
    if (method === 'GET') {
      if (path === '/rest/adAccounts/507') return {json: {id: 507, status: 'ACTIVE', currency: 'SAR'}};
      if (path === '/rest/insightTags')
        return {json: {elements: [{id: 100, sponsoredAccounts: [account]}], paging: {count: 10, start: 0, links: []}}};
      if (path === '/rest/insightTagsPermission')
        return {
          json: {
            elements: [{insightTag: 'urn:li:insightTag:100', accessRole: 'FULL'}],
            paging: {count: 10, start: 0, links: []},
          },
        };
      if (path === '/rest/insightTagDomains') {
        const name = url.searchParams.get('domainName');
        return {
          json: {
            elements:
              name in state.domains
                ? [{domainName: name, blocked: state.domains[name], insightTag: 'urn:tscp:insightTag:100'}]
                : [],
            paging: {count: 10, start: 0, links: []},
          },
        };
      }
      return undefined;
    }
    if (method === 'POST' && path === '/rest/insightTagDomains') {
      const entries = Object.entries(body.entities),
        name = k => /domainName:([^)]+)\)$/.exec(decodeURIComponent(k))[1];
      // A partial answer: LinkedIn blocks the first domain and refuses the second.
      if (mode.partial) {
        state.domains[name(entries[0][0])] = entries[0][1].patch.$set.blocked;
        return {
          json: {results: {[entries[0][0]]: {status: 204}}, errors: {[entries[1][0]]: {status: 403, message: 'No'}}},
        };
      }
      for (const [k, v] of entries) state.domains[name(k)] = v.patch.$set.blocked;
      return {json: {results: Object.fromEntries(entries.map(([k]) => [k, {status: 204}])), errors: {}}};
    }
  },
  decisive: {
    change: state => (state.domains['shop.example.com'] = true),
    field: /blocked/,
    refusal: {code: 'INVALID_LINKEDIN_INSIGHT_DOMAIN', message: /Domain shop\.example\.com is already blocked/},
  },
};
