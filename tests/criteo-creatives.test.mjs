import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {authorizeCriteoCreative} from '../dist/src/criteo-creatives.js';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

// Criteo is parked (ARC-01, P9): this suite exercises it, so it offers it like a
// deployment whose AMCP_PROVIDERS names it.
offerParkedProviders('criteo');

/**
 * Criteo Retail Media creatives, API 2026-07 (pinned OpenAPI document: CreateCreative, UpdateCreative, GetCreative,
 * GetCreativeTemplate, SearchAccountRetailers; checked 2026-09-29). A creative fills a retailer's template; a chosen
 * option can unlock dependent variables.
 */
const gateway = 'criteo_native_action',
  prefix = '/2026-07/retail-media',
  registry = new Registry(),
  operation = 'criteo_creative_ops';
const actor = {tenantId: 'criteo-creatives', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const scopes = ['RetailMedia_Accounts_Read', 'RetailMedia_Campaign_Read', 'RetailMedia_Campaign_Manage'];
const template = {
  name: 'Brand banner',
  creativeFormat: 'CommerceDisplaySpotlight',
  sections: [
    {
      title: 'Main',
      templateVariables: [
        {id: 'headline', type: 'Text', required: true, textVariableSpecification: {maxChars: 30}},
        {
          id: 'logo',
          type: 'Files',
          required: true,
          filesVariablesSpecification: {extensions: ['Png', 'Jpeg'], minFiles: 1, maxFile: 1},
        },
        {
          id: 'cta',
          type: 'Choice',
          required: true,
          choiceVariableSpecification: {
            minSelected: 1,
            maxSelected: 1,
            options: [
              {id: 'shop', dependentVariables: [{id: 'landing', type: 'Hyperlink', required: true}]},
              {id: 'none', dependentVariables: []},
            ],
          },
        },
        {id: 'background', type: 'Color', required: false},
      ],
    },
  ],
};
const values = (extra = []) => [
  {id: 'headline', textVariableValue: {text: 'Fresh coffee'}},
  {id: 'logo', filesVariableValue: {assetIds: ['a1b2']}},
  {id: 'cta', choiceVariableValue: {chosenOptions: ['shop']}},
  {id: 'landing', hyperlinkVariableValue: {url: 'https://grocer.example.test/coffee'}},
  {id: 'background', colorVariableValue: {color: '#1a2b3c'}},
  ...extra,
];
const creative = (extra = {}) => ({
  name: 'Coffee banner',
  retailerId: 77,
  templateId: 501,
  templateVariableValues: values(),
  ...extra,
});
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 104).toString('base64')),
    calls = [];
  let writes = 0,
    next = 3100;
  store.putConnection(
    owner,
    {
      id: 'criteo',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Criteo',
      scopes,
    },
    {accessToken: 'synthetic'},
  );
  // Criteo reads values back with the other value keys null and colours in upper case.
  const shownValues = list =>
    list.map(v => ({
      id: v.id,
      textVariableValue: null,
      choiceVariableValue: null,
      colorVariableValue: null,
      filesVariableValue: null,
      hyperlinkVariableValue: null,
      videoVariableValue: null,
      ...Object.fromEntries(
        Object.entries(v)
          .filter(([k]) => k !== 'id')
          .map(([k, x]) => [k, k === 'colorVariableValue' ? {color: x.color.toUpperCase()} : x]),
      ),
    }));
  const creatives = new Map([
    [
      '3001',
      {
        name: 'Summer',
        retailerId: 77,
        templateId: 501,
        brandId: null,
        status: 'In_Use',
        associatedLineItemIds: ['4001'],
        templateVariableValues: shownValues(values()),
      },
    ],
    ['3002', {name: 'Old', retailerId: 77, templateId: 501, status: 'Archived', templateVariableValues: []}],
  ]);
  const envelope = data => ({data, errors: [], warnings: []});
  const shown = (id, c) => envelope({id, type: 'Creative', attributes: structuredClone(c)});
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        method = init.method,
        path = u.pathname,
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({path, method});
      if (method === 'POST' && path === prefix + '/accounts/123/retailers/search') {
        const ids = body.data.attributes.retailerIdFilter;
        return Response.json({
          ...envelope(ids.filter(id => id === '77').map(id => ({id, type: 'Retailer', attributes: {name: 'Grocer'}}))),
          metadata: {totalItemsAcrossAllPages: 1},
        });
      }
      if (method === 'GET' && path === prefix + '/retailers/77/templates/501')
        return Response.json(envelope({id: '501', type: 'Template', attributes: template}));
      if (method === 'GET' && /\/retailers\/77\/templates\/\d+$/.test(path))
        return Response.json({errors: [{title: 'Not found'}]}, {status: 404});
      let m = /^\/2026-07\/retail-media\/accounts\/123\/creatives\/(\d+)$/.exec(path);
      if (method === 'GET' && m) {
        if (creatives.has(m[1])) return Response.json(shown(m[1], creatives.get(m[1])));
        return Response.json({errors: [{title: 'Not found'}]}, {status: 404});
      }
      writes++;
      if (method === 'POST' && path === prefix + '/accounts/123/creatives') {
        const id = String(next++),
          c = {
            ...body,
            brandId: body.brandId ?? null,
            status: 'Ready',
            associatedLineItemIds: [],
            templateVariableValues: shownValues(body.templateVariableValues),
          };
        creatives.set(id, c);
        return Response.json(shown(id, c), {status: 201});
      }
      if (method === 'PUT' && m) {
        const c = {
          ...creatives.get(m[1]),
          ...body,
          templateVariableValues: shownValues(body.templateVariableValues),
        };
        creatives.set(m[1], c);
        return Response.json(shown(m[1], c), {status: 201});
      }
      throw new Error('Unexpected ' + method + ' ' + path);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (action, payload, params = {}) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {operation, arguments: {action, account_id: '123', params, payload}}},
      actor,
    );
  const create = payload => prepare('CREATE_CREATIVE', payload);
  const update = (cid, payload) => prepare('UPDATE_CREATIVE', payload, {'creative-id': cid});
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, creatives, create, update, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
  return r;
};
const refused = (r, code, pattern) => {
  assert.equal(r.error?.code, code, JSON.stringify(r).slice(0, 800));
  if (pattern) assert.match(r.error.message, pattern);
};

test('a creative is created from the retailer template and read back, colours compared in any case', async () => {
  const f = fixture();
  try {
    const p = ok(await f.create(creative()));
    const impact = p.data.creative_impact;
    assert.deepEqual(impact.template, {id: '501', name: 'Brand banner', format: 'CommerceDisplaySpotlight'});
    assert.match(impact.note, /no read of an asset/);
    assert.equal(impact.may_affect_serving, false);
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    refused(await f.create(creative({retailerId: 88})), 'STATE_TARGET_MISMATCH');
    refused(await f.create(creative({templateId: 999})), 'STATE_NOT_FOUND');
  } finally {
    f.store.close();
  }
});

test('values follow the template: variables, types, lengths, required and dependent variables, options and files', async () => {
  const f = fixture();
  try {
    const without = id => values().filter(v => v.id !== id);
    const cases = [
      [values([{id: 'subtitle', textVariableValue: {text: 'x'}}]), /no variable subtitle/],
      [[...without('headline'), {id: 'headline', colorVariableValue: {color: '#fff'}}], /Text variable/],
      [[...without('headline'), {id: 'headline', textVariableValue: {text: 'x'.repeat(31)}}], /at most 30 characters/],
      [without('logo'), /requires logo/],
      [[...without('cta'), {id: 'cta', choiceVariableValue: {chosenOptions: ['none']}}], /depends on option shop/],
      [[...without('cta'), {id: 'cta', choiceVariableValue: {chosenOptions: ['later']}}], /no option later/],
      [
        [...without('cta'), {id: 'cta', choiceVariableValue: {chosenOptions: ['shop', 'none']}}],
        /takes 1 to 1 options/,
      ],
      [[...without('logo'), {id: 'logo', filesVariableValue: {assetIds: ['a1', 'a2']}}], /takes 1 to 1 files/],
      [without('landing'), /requires landing/],
    ];
    for (const [list, pattern] of cases)
      refused(await f.create(creative({templateVariableValues: list})), 'INVALID_CRITEO_CREATIVE', pattern);
    ok(
      await f.create(
        creative({
          templateVariableValues: [
            ...without('cta').filter(v => v.id !== 'landing'),
            {id: 'cta', choiceVariableValue: {chosenOptions: ['none']}},
          ],
        }),
      ),
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('shapes are refused before any request', async () => {
  const f = fixture();
  try {
    for (const payload of [
      creative({id: '3100'}),
      creative({name: ''}),
      creative({retailerId: '77'}),
      creative({
        templateVariableValues: [{id: 'x', textVariableValue: {text: 'a'}, colorVariableValue: {color: '#fff'}}],
      }),
      creative({
        templateVariableValues: [{id: 'landing', hyperlinkVariableValue: {url: 'http://grocer.example.test'}}],
      }),
      creative({templateVariableValues: [{id: 'background', colorVariableValue: {color: 'blue'}}]}),
      creative({
        templateVariableValues: [
          {id: 'headline', textVariableValue: {text: 'a'}},
          {id: 'headline', textVariableValue: {text: 'b'}},
        ],
      }),
    ])
      assert.equal((await f.create(payload)).success, false, JSON.stringify(payload).slice(0, 160));
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});

test('an update sends the whole creative, names the line items using it, and keeps its retailer and template', async () => {
  const f = fixture();
  try {
    const next = values().map(v =>
      v.id === 'headline' ? {id: 'headline', textVariableValue: {text: 'Autumn roast'}} : v,
    );
    const p = ok(await f.update('3001', creative({name: 'Autumn', templateVariableValues: next})));
    const impact = p.data.creative_impact;
    assert.deepEqual(impact.line_items, ['4001']);
    assert.equal(impact.may_affect_serving, true);
    assert.equal(impact.before.name, 'Summer');
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    refused(
      await f.update('3001', creative({name: 'Autumn', templateVariableValues: next})),
      'INVALID_CRITEO_CREATIVE',
      /already has these values/,
    );
    refused(await f.update('3002', creative()), 'INVALID_CRITEO_CREATIVE', /Archived/);
    refused(await f.update('3999', creative()), 'STATE_NOT_FOUND');
  } finally {
    f.store.close();
  }
});

test('only the tagged template read is allowed outside the account; the ledger lists both writes', () => {
  const plan = {
    gateway,
    action: 'AMCP_CRITEO_CREATIVE_READ',
    accountId: '123',
    method: 'GET',
    readOnly: true,
    query: {},
  };
  assert.equal(
    authorizeCriteoCreative(
      {...plan, path: prefix + '/retailers/77/templates/501', criteoTemplatePage: {retailer: '77', template: '501'}},
      {},
      '123',
    ),
    true,
  );
  assert.throws(
    () =>
      authorizeCriteoCreative(
        {...plan, path: prefix + '/retailers/88/templates/501', criteoTemplatePage: {retailer: '77', template: '501'}},
        {},
        '123',
      ),
    /Unqualified internal template read/,
  );
  assert.equal(authorizeCriteoCreative({...plan, path: prefix + '/retailers/77/templates/501'}, {}, '123'), false);
  assert.deepEqual(
    actionContracts(registry)
      .filter(r => r.family === 'criteo_creatives')
      .map(r => r.action)
      .sort(),
    ['CREATE_CREATIVE', 'UPDATE_CREATIVE'],
  );
});
