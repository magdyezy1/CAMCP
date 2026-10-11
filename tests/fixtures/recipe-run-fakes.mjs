// Synthetic provider APIs for recipe run-to-read-back fixtures (ACC-01): each keeps what was written and reads it back
// by exact ID the way the provider does, so the real campaign runner, reviews, receipts and verification run end to end
// with no network. `lose` names a collection whose first write is applied but whose response is lost (a thrown fetch),
// the case a reviewed write must treat as uncertain and never send again.
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

const policy = {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0};
const lost = () => Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNRESET'}});

/** Meta Graph API v26.0 for the three website recipes: account, Page, pixel and image reads, and the four creates. */
export function metaGraphFake(options = {}) {
  const objects = new Map(),
    writes = [],
    reads = [];
  let next = 9000;
  const decode = body =>
    Object.fromEntries(
      [...new URLSearchParams(String(body ?? ''))].map(([k, v]) => [
        k,
        /^[[{]/.test(v) || v === 'true' || v === 'false' ? JSON.parse(v) : v,
      ]),
    );
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      path = u.pathname;
    if (init?.method === 'POST') {
      const collection = path.split('/').pop(),
        body = decode(init.body),
        id = String(next++);
      writes.push({collection, body});
      // Graph reads an ad's creative back as {id}.
      if (body.creative?.creative_id) body.creative = {id: body.creative.creative_id};
      objects.set(id, {id, ...body});
      if (options.lose === collection && !options.lost) {
        options.lost = true;
        throw lost();
      }
      return Response.json({id});
    }
    reads.push(path);
    if (path.endsWith('/adspixels')) return Response.json({data: [{id: options.pixel ?? '456'}]});
    if (path.endsWith('/promote_pages')) return Response.json({data: [{id: options.page ?? '123'}]});
    if (path.endsWith('/adimages'))
      return Response.json({data: [{hash: options.image ?? 'abcdef123456', account_id: '100'}]});
    const id = path.split('/').pop(),
      fields = (u.searchParams.get('fields') ?? '').split(',').filter(Boolean);
    if (objects.has(id)) {
      const o = {
        ...objects.get(id),
        account_id: '100',
        effective_status: objects.get(id).status === 'ACTIVE' ? 'CAMPAIGN_PAUSED' : objects.get(id).status,
      };
      return Response.json(Object.fromEntries(Object.entries(o).filter(([k]) => k === 'id' || fields.includes(k))));
    }
    return Response.json({id: 'act_100', account_id: '100', currency: 'USD', timezone_name: 'UTC', account_status: 1});
  });
  return {objects, writes, reads, transport};
}

/**
 * Microsoft Advertising Campaign Management v13 REST, as the PRV-03 fixture in tests/microsoft.test.ts: it keeps what
 * was written and returns it by exact ID; GetAdsByIds needs AdTypes.
 */
export function microsoftFake(options = {}) {
  const records = new Map(),
    writes = [];
  let next = 100;
  const transport = new NativeTransport(async (url, init) => {
    const path = new URL(String(url)).pathname,
      body = JSON.parse(String(init?.body ?? '{}'));
    if (path.endsWith('/Account/Query'))
      return Response.json({Account: {Id: '123', ParentCustomerId: '456', CurrencyCode: 'USD'}});
    const kind = /\/CampaignManagement\/v13\/(Campaigns|AdGroups|Ads|Keywords)(?:\/QueryByIds)?$/.exec(path)?.[1];
    if (!kind) throw Error('unexpected Microsoft path ' + path);
    if (path.endsWith('/QueryByIds')) {
      if (kind === 'Ads' && !Array.isArray(body.AdTypes))
        return Response.json({Errors: [{Code: 1, Message: 'AdTypes required'}]}, {status: 400});
      const asked = String(body.ReturnAdditionalFields ?? '').split(',');
      return Response.json({
        [kind]: body[kind.slice(0, -1) + 'Ids'].map(Id => {
          const r = structuredClone(records.get(kind + ':' + Id));
          if (!r) return null;
          if (!asked.includes('AdScheduleUseSearcherTimeZone')) delete r.AdScheduleUseSearcherTimeZone;
          if (r.BiddingScheme?.Type === 'MaxConversionsBiddingScheme' && !asked.includes('TargetCpaInMaxConversion'))
            delete r.BiddingScheme.TargetCpa;
          return r;
        }),
      });
    }
    writes.push({kind, method: String(init?.method), body});
    if (init?.method !== 'POST') throw Error('the recipe only creates');
    const ids = body[kind].map(r => {
      const Id = String(next++);
      records.set(kind + ':' + Id, {...structuredClone(r), Id});
      return Id;
    });
    if (options.lose === kind && !options.lost) {
      options.lost = true;
      throw lost();
    }
    return Response.json({[kind.slice(0, -1) + 'Ids']: ids, PartialErrors: null});
  });
  return {records, writes, transport};
}

/** A workspace with one login on `gateway`, the real service over `transport`, and the campaign tool. */
export function recipeWorkspace(t, gateway, transport, extra = {}) {
  const actor = {tenantId: 'recipe-run-' + gateway, userId: 'operator', role: 'operator'},
    admin = {...actor, role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 57).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    admin,
    {
      id: extra.connection_id ?? 'login',
      tenantId: actor.tenantId,
      gateway,
      accounts: [extra.account_id ?? '100'],
      writeAccounts: [extra.account_id ?? '100'],
      enabled: true,
      label: 'Synthetic',
      scopes: extra.scopes ?? [],
      ...(extra.connection ?? {}),
    },
    extra.credentials ?? {accessToken: 'synthetic'},
  );
  const service = new MirrorService(new Registry(), store, transport, undefined, policy);
  return {actor, store, service, call: input => service.call('amcp_campaign', input, actor)};
}
