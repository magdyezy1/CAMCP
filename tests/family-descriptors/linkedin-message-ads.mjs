// linkedin_message_ads: POST /rest/conversationAds/{conversation}/sponsoredMessageContents/{message} PARTIAL_UPDATE
// {patch: {$set: {bodySource}}} (LinkedIn Conversation Ads API, li-lms-2026-09). Members of an active Conversation Ad
// see the change at once, and the update replaces the message's text, so the decisive field is the message's current
// `bodySource`: a text changed in Campaign Manager after the review would be silently overwritten.
import {account, empty, restliError} from './_linkedin.mjs';

const conv = 'urn:li:sponsoredConversation:900',
  msg = n => 'urn:li:sponsoredMessageContent:(' + conv + ',' + n + ')';

export default {
  family: 'linkedin_message_ads',
  risk: 'activation',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {scopes: ['rw_ads']},
  request: {
    action: 'linkedin_rest_conversation_ads_conversation_urn_sponsored_message_contents_message_urn_post',
    restli_method: 'PARTIAL_UPDATE',
    path_params: {conversation_urn: conv, message_urn: msg(2)},
    payload: {patch: {$set: {bodySource: {text: 'Details of the autumn offer'}}}},
  },
  seed: () => ({
    conversation: {id: conv, parentAccount: account, firstMessageContent: msg(1), headlineText: 'Hello'},
    messages: [
      {
        id: msg(1),
        sponsoredConversation: conv,
        bodySource: {text: 'Hi there'},
        nextAction: {options: [{replyType: 'SIMPLE_REPLY', optionText: 'Tell me more', nextContent: msg(2)}]},
      },
      {
        id: msg(2),
        sponsoredConversation: conv,
        bodySource: {text: 'Details'},
        nextAction: {
          options: [{replyType: 'EXTERNAL_WEBSITE', optionText: 'Visit', landingPage: 'https://example.com/offer'}],
        },
      },
    ],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    const seg = path.split('/').slice(1).map(decodeURIComponent);
    if (method === 'GET') {
      if (path === '/rest/adAccounts/507') return {json: {id: 507, status: 'ACTIVE', currency: 'SAR'}};
      if (seg[1] === 'conversationAds' && seg[2] === conv && seg.length === 3)
        return {json: structuredClone(state.conversation)};
      // The conversation's messages. Another page: LinkedIn counts more messages than the page lists.
      if (seg[1] === 'conversationAds' && seg[2] === conv && seg[3] === 'sponsoredMessageContents')
        return {
          json: {
            elements: structuredClone(state.messages),
            paging: {start: 0, count: 50, links: [], ...(mode.paginate ? {total: state.messages.length + 1} : {})},
          },
        };
      return restliError(404, 'Not found');
    }
    if (method === 'POST' && seg[3] === 'sponsoredMessageContents' && seg[4] === msg(2)) {
      // A failed answer: LinkedIn refuses the change.
      // An uncertain answer: LinkedIn fails with a 5xx, and the change may or may not have applied.
      if (mode.uncertain) return restliError(503, 'Service unavailable');
      if (mode.partial) return restliError(400, 'Content of a live creative cannot change');
      Object.assign(state.messages[1], body.patch.$set);
      return empty();
    }
  },
  partialCodes: ['UPSTREAM_ERROR', 'WRITE_PARTIAL_OR_FAILED', 'WRITE_OUTCOME_UNCERTAIN'],
  // A 5xx is reported as the provider error (never safe to retry); its replay is WRITE_OUTCOME_UNCERTAIN.
  uncertainCodes: ['UPSTREAM_ERROR', 'WRITE_OUTCOME_UNCERTAIN'],
  decisive: {
    change: state => (state.messages[1].bodySource = {text: 'Details, updated in Campaign Manager'}),
    field: /bodySource/,
  },
};
