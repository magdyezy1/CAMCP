import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * LinkedIn Message Ads and Conversation Ads content, Marketing API "Message Ads API" and "Conversation Ads API"
 * (checked 2026-09-27).
 */
const registry = new Registry(),
  gateway = 'linkedin_native_action',
  actor = {tenantId: 'message-ads-test', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const actions = {
  inmailCreate: 'linkedin_rest_in_mail_contents_post',
  inmailUpdate: 'linkedin_rest_in_mail_contents_inmail_content_urn_post',
  conversationCreate: 'linkedin_rest_conversation_ads_post',
  conversationUpdate: 'linkedin_rest_conversation_ads_conversation_urn_post',
  messageCreate: 'linkedin_rest_conversation_ads_conversation_urn_sponsored_message_contents_post',
  messageCreateById: 'linkedin_rest_conversation_ads_conversation_ads_id_sponsored_message_contents_post',
  messageUpdate: 'linkedin_rest_conversation_ads_conversation_urn_sponsored_message_contents_message_urn_post',
  messageDelete: 'linkedin_rest_conversation_ads_conversation_urn_sponsored_message_contents_delete',
};
const acct = 'urn:li:sponsoredAccount:507',
  conv = n => 'urn:li:sponsoredConversation:' + n,
  msg = (c, n) => 'urn:li:sponsoredMessageContent:(' + conv(c) + ',' + n + ')';
const copy = x => structuredClone(x);
function fixture(o = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 101).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'li',
      tenantId: actor.tenantId,
      gateway,
      enabled: true,
      accounts: ['507'],
      writeAccounts: ['507'],
      scopes: o.scopes ?? ['rw_ads'],
      label: 'Synthetic LinkedIn',
    },
    {accessToken: 'synthetic'},
  );
  const conversations = new Map([
    [conv(900), {id: conv(900), parentAccount: acct, firstMessageContent: msg(900, 1), headlineText: 'Hello'}],
    [conv(901), {id: conv(901), parentAccount: 'urn:li:sponsoredAccount:999'}],
    [conv(902), {id: conv(902), parentAccount: acct}],
  ]);
  const messages = new Map([
    [
      msg(900, 1),
      {
        id: msg(900, 1),
        sponsoredConversation: conv(900),
        bodySource: {text: 'Hi there'},
        nextAction: {options: [{replyType: 'SIMPLE_REPLY', optionText: 'Tell me more', nextContent: msg(900, 2)}]},
      },
    ],
    [
      msg(900, 2),
      {
        id: msg(900, 2),
        sponsoredConversation: conv(900),
        bodySource: {text: 'Details'},
        nextAction: {
          options: [{replyType: 'EXTERNAL_WEBSITE', optionText: 'Visit', landingPage: 'https://example.com/offer'}],
        },
      },
    ],
    [
      msg(900, 3),
      {
        id: msg(900, 3),
        sponsoredConversation: conv(900),
        bodySource: {leadGenerationForm: 'urn:li:adForm:77'},
        nextAction: {options: [{replyType: 'LEAD_GENERATION_THANK_YOU', optionText: 'Thanks from the form'}]},
      },
    ],
  ]);
  const inmails = new Map([
    [
      'urn:li:adInMailContent:600',
      {
        id: 'urn:li:adInMailContent:600',
        account: acct,
        name: 'Launch',
        subject: 'Hello',
        sender: 'urn:li:person:abc',
        htmlBody: 'Body',
        subContent: {regular: {callToActionText: 'Learn more', callToActionLandingPageUrl: 'https://example.com'}},
      },
    ],
  ]);
  const forms = {
    77: {id: 77, account: acct, state: 'PUBLISHED'},
    78: {id: 78, account: 'urn:li:sponsoredAccount:999', state: 'PUBLISHED'},
  };
  let next = 10,
    writes = 0;
  const calls = [];
  const notFound = () => Response.json({status: 404, serviceErrorCode: 100, message: 'Not found'}, {status: 404});
  const fetcher = async (raw, init) => {
    const url = new URL(String(raw)),
      method = init?.method ?? 'GET',
      headers = new Headers(init?.headers),
      restli = headers.get('x-restli-method')?.toUpperCase();
    calls.push({method, path: url.pathname, restli});
    assert.equal(headers.get('x-restli-protocol-version'), '2.0.0');
    const seg = url.pathname.split('/').slice(1).map(decodeURIComponent);
    if (method === 'GET') {
      if (url.pathname === '/rest/adAccounts/507') return Response.json({id: 507, status: 'ACTIVE', currency: 'USD'});
      if (seg[1] === 'conversationAds' && seg.length === 3)
        return conversations.has(seg[2]) ? Response.json(conversations.get(seg[2])) : notFound();
      if (seg[1] === 'conversationAds' && seg[3] === 'sponsoredMessageContents')
        return Response.json({
          elements: [...messages.values()].filter(m => m.sponsoredConversation === seg[2]).map(copy),
          paging: {start: 0, count: 50, links: []},
        });
      if (seg[1] === 'inMailContents' && seg.length === 3)
        return inmails.has(seg[2]) ? Response.json(inmails.get(seg[2])) : notFound();
      if (seg[1] === 'leadForms') return forms[seg[2]] ? Response.json(forms[seg[2]]) : notFound();
      throw Error('Unexpected read ' + url.pathname);
    }
    writes++;
    const b = init.body ? JSON.parse(String(init.body)) : undefined;
    if (seg[1] === 'inMailContents' && seg.length === 2) {
      const id = 'urn:li:adInMailContent:' + next++;
      if (o.mode !== 'ignore') inmails.set(id, {...b, id});
      return new Response(null, {status: 201, headers: {'x-restli-id': id}});
    }
    if (seg[1] === 'inMailContents' && seg.length === 3) {
      if (o.mode !== 'ignore') Object.assign(inmails.get(seg[2]), b.patch.$set);
      return new Response(null, {status: 204});
    }
    if (seg[1] === 'conversationAds' && seg.length === 2) {
      const id = conv(next++);
      if (o.mode !== 'ignore') conversations.set(id, {...b, id});
      return new Response(null, {status: 201, headers: {'x-restli-id': id}});
    }
    if (seg[1] === 'conversationAds' && seg.length === 3) {
      if (o.mode !== 'ignore') Object.assign(conversations.get(seg[2]), b.patch.$set);
      return new Response(null, {status: 204});
    }
    const c = /^[1-9][0-9]*$/.test(seg[2]) ? conv(seg[2]) : seg[2],
      cid = c.split(':').at(-1);
    if (seg[3] === 'sponsoredMessageContents' && seg.length === 4 && method === 'POST') {
      const add = m => {
        const id = msg(cid, next++);
        if (o.mode !== 'ignore') messages.set(id, {...m, id, sponsoredConversation: c});
        return id;
      };
      if (restli === 'BATCH_CREATE') return Response.json({elements: b.elements.map(m => ({status: 201, id: add(m)}))});
      return new Response(null, {status: 201, headers: {'x-restli-id': o.mode === 'noid' ? '' : add(b)}});
    }
    if (seg[3] === 'sponsoredMessageContents' && seg.length === 5) {
      if (o.mode !== 'ignore') Object.assign(messages.get(seg[4]), b.patch.$set);
      return new Response(null, {status: 204});
    }
    if (seg[3] === 'sponsoredMessageContents' && method === 'DELETE') {
      const ids = decodeURIComponent(url.searchParams.get('ids'))
        .replace(/^List\(/, '')
        .replace(/\)$/, '')
        .split(/,(?=urn:li:sponsoredMessageContent)/);
      for (const id of ids) if (o.mode !== 'ignore') messages.delete(id);
      return Response.json({results: Object.fromEntries(ids.map(id => [id, {status: 204}])), errors: {}});
    }
    throw Error('Unexpected write ' + method + ' ' + url.pathname);
  };
  const service = new MirrorService(registry, store, new NativeTransport(fetcher), undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = args =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: {account_id: '507', ...args}}, actor);
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, conversations, messages, inmails, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
  return r;
};
const inmail = (extra = {}) => ({
  account: acct,
  name: 'Autumn offer',
  subject: 'An offer for you',
  sender: 'urn:li:person:abc',
  htmlBody: '<p>Hello</p>',
  subContent: {regular: {callToActionText: 'Get the offer', callToActionLandingPageUrl: 'https://example.com/autumn'}},
  ...extra,
});

test('InMail content is created and updated once and verifies; a guided-replies content needs a conversation with a first message', async () => {
  const f = fixture();
  try {
    const c = ok(await f.prepare({action: actions.inmailCreate, payload: inmail()}));
    assert.equal(c.data.creative_impact.scope, 'inmail_content');
    assert.equal(c.data.creative_impact.may_affect_serving, false);
    ok(await f.execute(c));
    assert.equal(f.writes(), 1);
    assert.equal(ok(await f.verify(c)).data.status, 'verified');
    assert.equal((await f.execute(c)).data.replayed, true);
    assert.equal(f.writes(), 1);
    const u = ok(
      await f.prepare({
        action: actions.inmailUpdate,
        path_params: {inmail_content_urn: 'urn:li:adInMailContent:600'},
        restli_method: 'PARTIAL_UPDATE',
        payload: {patch: {$set: {subject: 'A new subject'}}},
      }),
    );
    ok(await f.execute(u));
    assert.equal(f.inmails.get('urn:li:adInMailContent:600').subject, 'A new subject');
    assert.equal(ok(await f.verify(u)).data.status, 'verified');
    ok(
      await f.prepare({
        action: actions.inmailCreate,
        payload: inmail({subContent: {guidedReplies: {sponsoredConversation: conv(900)}}}),
      }),
    );
    assert.match(
      (
        await f.prepare({
          action: actions.inmailCreate,
          payload: inmail({subContent: {guidedReplies: {sponsoredConversation: conv(902)}}}),
        })
      ).error?.message ?? '',
      /no first message/,
    );
  } finally {
    f.store.close();
  }
});

test('a conversation is created, messages are added (also as a batch and by numeric ID), linked, updated and deleted, each verified', async () => {
  const f = fixture();
  try {
    const c = ok(
      await f.prepare({action: actions.conversationCreate, payload: {parentAccount: acct, headlineText: 'Talk to us'}}),
    );
    ok(await f.execute(c));
    assert.equal(ok(await f.verify(c)).data.status, 'verified');
    const leaf = ok(
      await f.prepare({
        action: actions.messageCreate,
        path_params: {conversation_urn: conv(902)},
        payload: {
          bodySource: {text: 'Thanks for reading'},
          nextAction: {
            options: [{replyType: 'EXTERNAL_WEBSITE', optionText: 'Open site', landingPage: 'https://example.com'}],
          },
        },
      }),
    );
    ok(await f.execute(leaf));
    assert.equal(ok(await f.verify(leaf)).data.status, 'verified');
    const leafUrn = [...f.messages.keys()].find(k => k.includes(conv(902)));
    const batch = ok(
      await f.prepare({
        action: actions.messageCreate,
        path_params: {conversation_urn: conv(902)},
        restli_method: 'BATCH_CREATE',
        payload: {
          elements: [
            {
              bodySource: {text: 'Start'},
              nextAction: {options: [{replyType: 'SIMPLE_REPLY', optionText: 'Go on', nextContent: leafUrn}]},
            },
            {bodySource: {mediaAttachment: {attachment: 'urn:li:image:C5506AQGB9eP', text: 'Look'}}},
          ],
        },
      }),
    );
    ok(await f.execute(batch));
    assert.equal(ok(await f.verify(batch)).data.status, 'verified');
    const byId = ok(
      await f.prepare({
        action: actions.messageCreateById,
        path_params: {conversation_ads_id: '902'},
        payload: {bodySource: {text: 'Another'}},
      }),
    );
    ok(await f.execute(byId));
    assert.equal(ok(await f.verify(byId)).data.status, 'verified');
    const first = ok(
      await f.prepare({
        action: actions.conversationUpdate,
        path_params: {conversation_urn: conv(902)},
        restli_method: 'PARTIAL_UPDATE',
        payload: {patch: {$set: {firstMessageContent: leafUrn}}},
      }),
    );
    ok(await f.execute(first));
    assert.equal(f.conversations.get(conv(902)).firstMessageContent, leafUrn);
    assert.equal(ok(await f.verify(first)).data.status, 'verified');
    const edit = ok(
      await f.prepare({
        action: actions.messageUpdate,
        path_params: {conversation_urn: conv(900), message_urn: msg(900, 2)},
        restli_method: 'PARTIAL_UPDATE',
        payload: {patch: {$set: {bodySource: {text: 'New details'}}}},
      }),
    );
    assert.equal(edit.data.creative_impact.may_affect_serving, true);
    ok(await f.execute(edit));
    assert.equal(f.messages.get(msg(900, 2)).bodySource.text, 'New details');
    assert.equal(ok(await f.verify(edit)).data.status, 'verified');
    const del = ok(
      await f.prepare({
        action: actions.messageDelete,
        path_params: {conversation_urn: conv(900)},
        restli_method: 'BATCH_DELETE',
        query: {ids: [msg(900, 3)]},
      }),
    );
    ok(await f.execute(del));
    assert.equal(f.messages.has(msg(900, 3)), false);
    assert.equal(ok(await f.verify(del)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('malformed content is refused before any request', async () => {
  const cases = [
    [
      'CTA over 20 characters',
      {
        action: actions.inmailCreate,
        payload: inmail({
          subContent: {regular: {callToActionText: 'x'.repeat(21), callToActionLandingPageUrl: 'https://example.com'}},
        }),
      },
    ],
    [
      'two sub-contents',
      {
        action: actions.inmailCreate,
        payload: inmail({
          subContent: {
            regular: {callToActionText: 'Go', callToActionLandingPageUrl: 'https://example.com'},
            form: {callToActionText: 'Go'},
          },
        }),
      },
    ],
    [
      'another account',
      {action: actions.inmailCreate, payload: inmail({account: 'urn:li:sponsoredAccount:999'})},
      'ACCOUNT_SCOPE_MISMATCH',
    ],
    ['member sender', {action: actions.inmailCreate, payload: inmail({sender: 'urn:li:member:1'})}],
    [
      'footer update',
      {
        action: actions.inmailUpdate,
        path_params: {inmail_content_urn: 'urn:li:adInMailContent:600'},
        restli_method: 'PARTIAL_UPDATE',
        payload: {patch: {$set: {customFooter: 'x'}}},
      },
    ],
    [
      'first message at creation',
      {action: actions.conversationCreate, payload: {parentAccount: acct, firstMessageContent: msg(900, 1)}},
    ],
    [
      'text over 500',
      {
        action: actions.messageCreate,
        path_params: {conversation_urn: conv(900)},
        payload: {bodySource: {text: 'x'.repeat(501)}},
      },
    ],
    [
      'six options',
      {
        action: actions.messageCreate,
        path_params: {conversation_urn: conv(900)},
        payload: {
          bodySource: {text: 'Hi'},
          nextAction: {
            options: Array.from({length: 6}, () => ({
              replyType: 'EXTERNAL_WEBSITE',
              optionText: 'Go',
              landingPage: 'https://example.com',
            })),
          },
        },
      },
    ],
    [
      'option text over 35',
      {
        action: actions.messageCreate,
        path_params: {conversation_urn: conv(900)},
        payload: {
          bodySource: {text: 'Hi'},
          nextAction: {
            options: [{replyType: 'EXTERNAL_WEBSITE', optionText: 'x'.repeat(36), landingPage: 'https://example.com'}],
          },
        },
      },
    ],
    [
      'website without landing page',
      {
        action: actions.messageCreate,
        path_params: {conversation_urn: conv(900)},
        payload: {bodySource: {text: 'Hi'}, nextAction: {options: [{replyType: 'EXTERNAL_WEBSITE', optionText: 'Go'}]}},
      },
    ],
    [
      'reply with landing page',
      {
        action: actions.messageCreate,
        path_params: {conversation_urn: conv(900)},
        payload: {
          bodySource: {text: 'Hi'},
          nextAction: {
            options: [
              {
                replyType: 'SIMPLE_REPLY',
                optionText: 'Go',
                nextContent: msg(900, 2),
                landingPage: 'https://example.com',
              },
            ],
          },
        },
      },
    ],
    [
      'link into another conversation',
      {
        action: actions.messageCreate,
        path_params: {conversation_urn: conv(900)},
        payload: {
          bodySource: {text: 'Hi'},
          nextAction: {options: [{replyType: 'SIMPLE_REPLY', optionText: 'Go', nextContent: msg(902, 1)}]},
        },
      },
    ],
    [
      'first message of another conversation',
      {
        action: actions.conversationUpdate,
        path_params: {conversation_urn: conv(900)},
        restli_method: 'PARTIAL_UPDATE',
        payload: {patch: {$set: {firstMessageContent: msg(902, 1)}}},
      },
    ],
  ];
  for (const [label, args, code = 'INVALID_LINKEDIN_MESSAGE_AD'] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(args);
      assert.equal(r.error?.code, code, label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
});

test('foreign conversations and forms, missing links, cycles, deleted first messages and thank-you rules are refused after reading, without writes', async () => {
  const f = fixture();
  try {
    assert.equal(
      (
        await f.prepare({
          action: actions.messageCreate,
          path_params: {conversation_urn: conv(901)},
          payload: {bodySource: {text: 'Hi'}},
        })
      ).error?.code,
      'STATE_TARGET_MISMATCH',
    );
    assert.match(
      (
        await f.prepare({
          action: actions.messageCreate,
          path_params: {conversation_urn: conv(900)},
          payload: {
            bodySource: {leadGenerationForm: 'urn:li:adForm:78'},
            nextAction: {options: [{replyType: 'LEAD_GENERATION_THANK_YOU', optionText: 'Thanks'}]},
          },
        })
      ).error?.message ?? '',
      /another ad account/,
    );
    assert.match(
      (
        await f.prepare({
          action: actions.messageCreate,
          path_params: {conversation_urn: conv(900)},
          payload: {bodySource: {leadGenerationForm: 'urn:li:adForm:77'}},
        })
      ).error?.message ?? '',
      /LEAD_GENERATION_THANK_YOU/,
    );
    assert.match(
      (
        await f.prepare({
          action: actions.messageCreate,
          path_params: {conversation_urn: conv(900)},
          payload: {
            bodySource: {text: 'Hi'},
            nextAction: {options: [{replyType: 'SIMPLE_REPLY', optionText: 'Go', nextContent: msg(900, 9)}]},
          },
        })
      ).error?.message ?? '',
      /does not have/,
    );
    assert.match(
      (
        await f.prepare({
          action: actions.messageCreate,
          path_params: {conversation_urn: conv(900)},
          payload: {
            bodySource: {text: 'Hi'},
            nextAction: {options: [{replyType: 'SIMPLE_REPLY', optionText: 'Go', nextContent: msg(900, 3)}]},
          },
        })
      ).error?.message ?? '',
      /Only LEAD_GENERATION options/,
    );
    assert.match(
      (
        await f.prepare({
          action: actions.messageUpdate,
          path_params: {conversation_urn: conv(900), message_urn: msg(900, 2)},
          restli_method: 'PARTIAL_UPDATE',
          payload: {
            patch: {
              $set: {
                nextAction: {options: [{replyType: 'SIMPLE_REPLY', optionText: 'Back', nextContent: msg(900, 1)}]},
              },
            },
          },
        })
      ).error?.message ?? '',
      /cycle/,
    );
    assert.match(
      (
        await f.prepare({
          action: actions.messageDelete,
          path_params: {conversation_urn: conv(900)},
          restli_method: 'BATCH_DELETE',
          query: {ids: [msg(900, 1)]},
        })
      ).error?.message ?? '',
      /first message/,
    );
    assert.match(
      (
        await f.prepare({
          action: actions.messageDelete,
          path_params: {conversation_urn: conv(900)},
          restli_method: 'BATCH_DELETE',
          query: {ids: [msg(900, 2)]},
        })
      ).error?.message ?? '',
      /does not have/,
    );
    assert.match(
      (
        await f.prepare({
          action: actions.conversationUpdate,
          path_params: {conversation_urn: conv(900)},
          restli_method: 'PARTIAL_UPDATE',
          payload: {patch: {$set: {headlineText: 'Hello'}}},
        })
      ).error?.message ?? '',
      /already has these values/,
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const reader = fixture({scopes: ['r_ads']});
  try {
    assert.equal(
      (await reader.prepare({action: actions.conversationCreate, payload: {parentAccount: acct}})).error?.code,
      'INSUFFICIENT_SCOPE',
    );
  } finally {
    reader.store.close();
  }
});

test('a creation without an ID is a failure that is never resubmitted, an ignored update is not verified, and the ledger lists the eight writes', async () => {
  const noid = fixture({mode: 'noid'});
  try {
    const p = ok(
      await noid.prepare({
        action: actions.messageCreate,
        path_params: {conversation_urn: conv(900)},
        payload: {bodySource: {text: 'Hi'}},
      }),
    );
    assert.equal((await noid.execute(p)).success, false);
    assert.equal((await noid.execute(p)).success, false);
    assert.equal(noid.writes(), 1);
  } finally {
    noid.store.close();
  }
  const ignored = fixture({mode: 'ignore'});
  try {
    const p = ok(
      await ignored.prepare({
        action: actions.inmailUpdate,
        path_params: {inmail_content_urn: 'urn:li:adInMailContent:600'},
        restli_method: 'PARTIAL_UPDATE',
        payload: {patch: {$set: {subject: 'Ignored'}}},
      }),
    );
    ok(await ignored.execute(p));
    assert.notEqual(ok(await ignored.verify(p)).data.status, 'verified');
  } finally {
    ignored.store.close();
  }
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'linkedin_message_ads', action);
  }
});
