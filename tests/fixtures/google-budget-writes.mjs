// A synthetic Google Ads account for reviewed budget writes (WRT-04): campaign budgets read through googleAds:search
// and changed through campaignBudgets:mutate. Nothing leaves the process; every request is answered here.
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {saveSpendPolicy} from '../../dist/src/spend-policy.js';

export const gateway = 'google_ads_native_action',
  account = '123',
  budgetAction = 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
  budgetName = id => 'customers/' + account + '/campaignBudgets/' + id;

/**
 * `hooks.beforeWrite(body)` runs before a mutation is answered and may throw to make the response fail;
 * `hooks.duringRead()` runs once inside the next state read; `hooks.duringPermit()` once inside the next mutation's
 * transport admission wait. `respond(body)` may replace the mutation's response.
 */
export function googleBudgetFixture({tenant = 'google-budgets', role = 'admin', policy = {allowWrites: true}} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 83).toString('base64')),
    actor = {tenantId: tenant, userId: 'owner', role};
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'g',
      tenantId: tenant,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic Google Ads',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const budgets = new Map([[budgetName(1), '90000000']]),
    writes = [],
    hooks = {};
  let created = 100,
    mutationWaiting = false;
  const fetcher = async (url, init = {}) => {
    const path = new URL(String(url)).pathname,
      body = init.body ? JSON.parse(String(init.body)) : {};
    if (path.endsWith('/googleAds:search')) {
      const hook = hooks.duringRead;
      hooks.duringRead = undefined;
      if (hook) await hook();
      const query = String(body.query);
      if (/ FROM customer /.test(query + ' '))
        return Response.json({results: [{customer: {id: account, currencyCode: 'USD', timeZone: 'UTC'}}]});
      if (/ FROM campaign_budget /.test(query + ' '))
        return Response.json({
          results: [...query.matchAll(/'(customers\/[^']+)'/g)]
            .map(m => m[1])
            .filter(name => budgets.has(name))
            .map(name => ({campaignBudget: {resourceName: name, amountMicros: budgets.get(name)}})),
        });
      return Response.json({results: []});
    }
    if (path.endsWith('/campaignBudgets:mutate')) {
      writes.push(body);
      if (hooks.beforeWrite) await hooks.beforeWrite(body);
      if (hooks.respond) {
        const replaced = await hooks.respond(body);
        if (replaced) return replaced;
      }
      return Response.json({
        results: body.operations.map(op => {
          if (op.update) {
            const name = op.update.resourceName ?? op.update.resource_name;
            budgets.set(name, String(op.update.amountMicros ?? op.update.amount_micros));
            return {resourceName: name};
          }
          const name = budgetName(++created);
          budgets.set(name, String(op.create.amountMicros ?? op.create.amount_micros));
          return {resourceName: name};
        }),
      });
    }
    throw new Error('Unexpected synthetic Google request: ' + (init.method ?? 'GET') + ' ' + path);
  };
  const transport = new NativeTransport(
    fetcher,
    async () => {
      const hook = hooks.duringPermit;
      if (mutationWaiting && hook) {
        hooks.duringPermit = undefined;
        await hook();
      }
    },
    30000,
    8 * 1024 * 1024,
    0,
    1000000,
    1000000000,
  );
  const request = transport.request.bind(transport);
  transport.request = async (...args) => {
    mutationWaiting = !args[0].readOnly;
    return request(...args);
  };
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    maxBudgetChange: 0,
    requireBeforeState: true,
    ...policy,
  });
  const call = (tool, input, who = actor) => service.call(tool, input, who);
  const write = input => call('amcp_write', input);
  const update = (amount, id = 1) =>
    write({
      action: 'prepare',
      gateway,
      connection_id: 'g',
      arguments: {
        action: budgetAction,
        account_id: account,
        payload: {
          operations: [
            {update: {resourceName: budgetName(id), amountMicros: String(amount)}, updateMask: 'amount_micros'},
          ],
        },
      },
    });
  const creates = (count, amount) =>
    write({
      action: 'prepare',
      gateway,
      connection_id: 'g',
      arguments: {
        action: budgetAction,
        account_id: account,
        payload: {
          operations: Array.from({length: count}, (_, i) => ({
            create: {name: 'Synthetic ' + i, amountMicros: String(amount), deliveryMethod: 'STANDARD'},
          })),
        },
      },
    });
  const execute = (id, extra = {}) =>
    write({action: 'execute', review_id: id, confirmed: true, spend_change_confirmed: true, ...extra});
  const spendPolicy = p => saveSpendPolicy(store, actor, {gateway, account_id: account, confirmed: true, policy: p});
  const audit = () => store.audit(tenant, 10000).map(row => JSON.parse(row.event));
  const claim = key => store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(tenant, key);
  const reservations = () =>
    store.db.prepare("SELECT id FROM documents WHERE tenant_id=? AND kind='spend_reservation'").all(tenant);
  return {
    store,
    actor,
    service,
    transport,
    budgets,
    writes,
    hooks,
    call,
    write,
    update,
    creates,
    execute,
    spendPolicy,
    audit,
    claim,
    reservations,
    close: () => store.close(),
  };
}
