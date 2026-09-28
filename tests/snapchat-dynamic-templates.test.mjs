import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Snapchat dynamic templates (Dynamic Product Ads guide, "Dynamic Templates", checked 2026-09-27).
 */
const gateway = 'snapchat_native_action',
  registry = new Registry(),
  account = 'acct1';
const actions = {
  create: 'snapchat_adaccounts_ad_account_id_dynamic_templates_create',
  update: 'snapchat_adaccounts_ad_account_id_dynamic_templates_update',
};
const actor = {tenantId: 'snap-templates', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const url = 'https://ads-interfaces.sc-cdn.net/adformats/templates/V2/index.html';
const template = (extra = {}) => ({
  ad_account_id: account,
  name: 'Grey Seal',
  ios_url: url,
  android_url: url,
  layout: 'FILL_WIDTH',
  text_fields: ['title', 'price'],
  background_color: 'FFFFFF',
  ...extra,
});
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 66).toString('base64')),
    calls = [];
  let writes = 0,
    next = 10,
    n = 0;
  store.putConnection(
    owner,
    {
      id: '44444444-4444-4444-8444-444444444449',
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic Snap',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const templates = new Map([
    [
      'tp-1',
      template({name: 'Live template', overlay_specs: [{type: 'IMAGE', media_id: 'md-logo', position: 'TOP_LEFT'}]}),
    ],
    ['tp-2', template({name: 'Spare', layout: 'FIT', text_fields: ['', ''], background_color: '09C'})],
  ]);
  const media = [
    {id: 'md-logo', type: 'IMAGE', media_status: 'READY', name: 'Logo'},
    {id: 'md-frame', type: 'IMAGE', media_status: 'READY', name: 'Frame'},
    {id: 'md-video', type: 'VIDEO', media_status: 'READY', name: 'Clip'},
    {id: 'md-pending', type: 'IMAGE', media_status: 'PENDING_UPLOAD', name: 'Later'},
  ];
  const creatives = [
    {
      id: 'cr-1',
      name: 'DPA',
      review_status: 'APPROVED',
      dynamic_render_properties: {dynamic_template_id: 'tp-1', product_set_id: 'ps-1'},
    },
    {id: 'cr-2', name: 'Static'},
  ];
  const echo = t => ({
    ...t,
    ...(t.overlay_specs
      ? {overlay_specs: t.overlay_specs.map(o => (o.opacity === undefined ? o : {...o, opacity: Number(o.opacity)}))}
      : {}),
  });
  const wrap = (id, t) => ({
    sub_request_status: 'SUCCESS',
    dynamic_template: {id, ...echo(t), created_at: '2026-09-27T10:00:00Z', updated_at: '2026-09-27T10:00:00Z'},
  });
  const transport = new NativeTransport(
    async (raw, init = {}) => {
      const u = new URL(String(raw)),
        path = u.pathname,
        method = init.method ?? 'GET';
      calls.push(method + ' ' + path + u.search);
      const ok = body => Response.json({request_status: 'SUCCESS', request_id: 'r' + ++n, ...body});
      if (method === 'GET') {
        if (path === '/v1/adaccounts/acct1/dynamic_templates') {
          // Two pages: the cursor must be followed.
          const all = [...templates].map(([id, t]) => wrap(id, t));
          return u.searchParams.get('cursor') === 'p2'
            ? ok({dynamic_templates: all.slice(1), paging: {}})
            : ok({
                dynamic_templates: all.slice(0, 1),
                paging: {
                  next_link: 'https://adsapi.snapchat.com/v1/adaccounts/acct1/dynamic_templates?cursor=p2&limit=1000',
                },
              });
        }
        if (path === '/v1/adaccounts/acct1/media')
          return ok({
            media: media.map(m => ({sub_request_status: 'SUCCESS', media: {...m, ad_account_id: account}})),
            paging: {},
          });
        if (path === '/v1/adaccounts/acct1/creatives')
          return ok({creatives: creatives.map(creative => ({sub_request_status: 'SUCCESS', creative})), paging: {}});
        throw new Error('Unexpected ' + method + ' ' + path);
      }
      writes++;
      const body = JSON.parse(String(init.body));
      if (mode === 'error')
        return Response.json({
          request_status: 'ERROR',
          request_id: 'r' + ++n,
          dynamic_templates: body.dynamic_templates.map(() => ({sub_request_status: 'ERROR'})),
        });
      if (path === '/v1/adaccounts/acct1/dynamic_templates' && method === 'POST')
        return ok({
          dynamic_templates: body.dynamic_templates.map(t => {
            const id = 'tp-' + next++;
            if (mode !== 'ignore') templates.set(id, echo(t));
            return wrap(id, t);
          }),
        });
      if (path === '/v1/adaccounts/acct1/dynamic_templates' && method === 'PUT')
        return ok({
          dynamic_templates: body.dynamic_templates.map(({id, ...t}) => {
            if (mode !== 'ignore') templates.set(id, echo(t));
            return wrap(id, t);
          }),
        });
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
  const prepare = (action, list, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action,
          ad_account_id: account,
          params: {ad_account_id: account},
          payload: {dynamic_templates: list},
          ...extra,
        },
      },
      actor,
    );
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, templates, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('templates with overlays are created and verify after the template cursor; a template that a creative uses is updated with its usage shown; a replay sends nothing', async () => {
  const f = fixture();
  try {
    const overlays = [
      {type: 'IMAGE', media_id: 'md-logo', position: 'BOTTOM_LEFT'},
      {type: 'FRAME', media_id: 'md-frame', position: 'CENTER', opacity: '80'},
      {
        type: 'TEXT',
        text: 'Summer sale',
        position: 'TOP_RIGHT',
        opacity: 90,
        text_overlay_properties: {shape: 'PILL', shape_color: '09C', text_color: '000'},
      },
    ];
    const c = ok(
      await f.prepare(actions.create, [
        template({name: 'Seal I', overlay_specs: overlays}),
        template({
          name: 'Seal II',
          layout: 'CAROUSEL',
          text_fields: ['name'],
          preferred_image_tags: ['lifestyle'],
          preferred_video_tags: ['hand'],
        }),
      ]),
    );
    assert.equal(c.data.creative_impact.scope, 'dynamic_template');
    assert.equal(c.data.creative_impact.may_affect_serving, false);
    assert.ok(
      f.calls.some(x => x.includes('cursor=p2')),
      'the template cursor is followed',
    );
    ok(await f.execute(c));
    assert.equal(ok(await f.verify(c)).data.status, 'verified');
    assert.equal((await f.execute(c)).data.replayed, true);
    assert.equal(f.writes(), 1);
    const u = ok(
      await f.prepare(actions.update, [
        {
          id: 'tp-1',
          ...template({
            name: 'Live template',
            layout: 'FIT',
            overlay_specs: [{type: 'IMAGE', media_id: 'md-logo', position: 'TOP_RIGHT'}],
          }),
        },
      ]),
    );
    assert.equal(u.data.creative_impact.may_affect_serving, true);
    assert.equal(u.data.creative_impact.used_by[0].creatives[0].id, 'cr-1');
    ok(await f.execute(u));
    assert.equal(f.templates.get('tp-1').layout, 'FIT');
    assert.equal(ok(await f.verify(u)).data.status, 'verified');
    const r = ok(
      await f.prepare(actions.update, [
        {
          id: 'tp-2',
          ...template({name: 'Spare renamed', layout: 'FIT', text_fields: ['', ''], background_color: '09C'}),
        },
      ]),
    );
    assert.equal(r.data.creative_impact.may_affect_serving, false);
    ok(await f.execute(r));
    assert.equal(ok(await f.verify(r)).data.status, 'verified');
    assert.equal(f.writes(), 3);
  } finally {
    f.store.close();
  }
});

test('malformed templates are refused before any request; unknown templates and media, video or unready media, taken names and unchanged values after reading', async () => {
  const cases = [
    ['empty list', []],
    ['another account', [template({ad_account_id: 'acct2'})]],
    ['another renderer', [template({ios_url: 'https://example.com/render.html'})]],
    ['unknown layout', [template({layout: 'GRID'})]],
    ['three text fields', [template({text_fields: ['title', 'price', 'brand']})]],
    ['unknown text field', [template({text_fields: ['sku']})]],
    ['colour with #', [template({background_color: '#FFFFFF'})]],
    ['long overlay text', [template({overlay_specs: [{type: 'TEXT', text: 'x'.repeat(35), position: 'TOP_LEFT'}]})]],
    ['frame off centre', [template({overlay_specs: [{type: 'FRAME', media_id: 'md-frame', position: 'TOP_LEFT'}]})]],
    ['image without media', [template({overlay_specs: [{type: 'IMAGE', position: 'TOP_LEFT'}]})]],
    [
      'low opacity',
      [template({overlay_specs: [{type: 'IMAGE', media_id: 'md-logo', position: 'TOP_LEFT', opacity: 50}]})],
    ],
    [
      'text style on an image',
      [
        template({
          overlay_specs: [
            {
              type: 'IMAGE',
              media_id: 'md-logo',
              position: 'TOP_LEFT',
              text_overlay_properties: {shape: 'NONE', text_color: '000'},
            },
          ],
        }),
      ],
    ],
    [
      'unknown shape',
      [
        template({
          overlay_specs: [
            {
              type: 'TEXT',
              text: 'Hi',
              position: 'TOP_LEFT',
              text_overlay_properties: {shape: 'STAR', text_color: '000'},
            },
          ],
        }),
      ],
    ],
    ['duplicate names', [template({name: 'Twin'}), template({name: 'twin'})]],
    ['update without id', [template()], actions.update],
    ['creation with id', [{id: 'tp-1', ...template()}]],
  ];
  for (const [label, list, action] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(action ?? actions.create, list);
      assert.equal(r.error?.code, 'INVALID_SNAPCHAT_DYNAMIC_TEMPLATE', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    assert.equal((await f.prepare(actions.update, [{id: 'tp-9', ...template()}])).error?.code, 'STATE_NOT_FOUND');
    assert.equal(
      (
        await f.prepare(actions.create, [
          template({overlay_specs: [{type: 'IMAGE', media_id: 'md-9', position: 'TOP_LEFT'}]}),
        ])
      ).error?.code,
      'STATE_NOT_FOUND',
    );
    assert.equal(
      (
        await f.prepare(actions.create, [
          template({overlay_specs: [{type: 'IMAGE', media_id: 'md-video', position: 'TOP_LEFT'}]}),
        ])
      ).error?.code,
      'INVALID_SNAPCHAT_DYNAMIC_TEMPLATE',
    );
    assert.equal(
      (
        await f.prepare(actions.create, [
          template({overlay_specs: [{type: 'IMAGE', media_id: 'md-pending', position: 'TOP_LEFT'}]}),
        ])
      ).error?.code,
      'INVALID_SNAPCHAT_DYNAMIC_TEMPLATE',
    );
    assert.equal((await f.prepare(actions.create, [template({name: 'SPARE'})])).error?.code, 'CONFIGURATION_EXISTS');
    assert.equal(
      (
        await f.prepare(actions.update, [
          {
            id: 'tp-2',
            ...template({name: 'Live template', layout: 'FIT', text_fields: ['', ''], background_color: '09C'}),
          },
        ])
      ).error?.code,
      'CONFIGURATION_EXISTS',
    );
    assert.equal(
      (
        await f.prepare(actions.update, [
          {id: 'tp-2', ...template({name: 'Spare', layout: 'FIT', text_fields: ['', ''], background_color: '09C'})},
        ])
      ).error?.code,
      'INVALID_SNAPCHAT_DYNAMIC_TEMPLATE',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('an error reply is never resubmitted, ignored writes are not verified, and the ledger lists both writes', async () => {
  const e = fixture('error');
  try {
    const p = ok(await e.prepare(actions.create, [template()]));
    assert.equal((await e.execute(p)).success, false);
    assert.equal((await e.execute(p)).success, false);
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const g = fixture('ignore');
  try {
    for (const p of [
      ok(await g.prepare(actions.create, [template()])),
      ok(
        await g.prepare(actions.update, [
          {id: 'tp-2', ...template({name: 'Spare two', layout: 'FIT', text_fields: ['', ''], background_color: '09C'})},
        ]),
      ),
    ]) {
      ok(await g.execute(p));
      assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
    }
  } finally {
    g.store.close();
  }
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'snapchat_dynamic_templates', action);
  }
});
