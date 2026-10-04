import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
export const gateway = 'gtm_native_action',
  path = 'accounts/44/containers/55/workspaces/66';
export const needed = (...types) => ({
  consentStatus: 'needed',
  consentType: {type: 'list', list: types.map(value => ({type: 'template', value}))},
});
export function gtmConsentFixture(t, role = 'operator', allowUpdates = false) {
  const store = new Store(':memory:', Buffer.alloc(32, 125).toString('base64')),
    identity = {tenantId: 'synthetic-consent-drafts', userId: 'operator', role},
    key = store.createKey(identity),
    actor = store.authenticate(key),
    connection = {
      id: '12500000-0000-4000-8000-000000000001',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['44'],
      writeAccounts: ['44'],
      enabled: true,
      label: 'Synthetic',
      scopes: [
        'https://www.googleapis.com/auth/tagmanager.readonly',
        'https://www.googleapis.com/auth/tagmanager.edit.containers',
      ],
    },
    workspace = {
      path,
      accountId: '44',
      containerId: '55',
      workspaceId: '66',
      name: 'Workspace العربية',
      fingerprint: 'workspace-original',
    },
    tags = new Map(
      ['001', '002'].map(id => [
        id,
        {
          path: path + '/tags/' + id,
          accountId: '44',
          containerId: '55',
          workspaceId: '66',
          tagId: id,
          name: 'Original <tag> العربية ' + id,
          type: 'html',
          fingerprint: 'tag-original-' + id,
          paused: true,
          firingTriggerId: ['7'],
          parameter: [{type: 'template', key: 'html', value: 'PRIVATE-SYNTHETIC-SCRIPT'}],
          notes: 'Original notes',
          ...(id === '002' ? {consentSettings: needed('analytics_storage')} : {}),
        },
      ]),
    ),
    requests = [];
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  t.after(() => store.close());
  let hook;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const p = new URL(url).pathname.replace('/tagmanager/v2/', '');
      requests.push({path: p, method: init.method});
      await hook?.(p, requests.length);
      if (allowUpdates && init.method === 'PUT') {
        const id = p.split('/').at(-1),
          old = tags.get(id);
        if (!old || p !== old.path) return Response.json({}, {status: 404});
        if (new URL(url).searchParams.get('fingerprint') !== old.fingerprint)
          return Response.json({error: {message: 'Synthetic stale fingerprint'}}, {status: 412});
        tags.set(id, {...old, ...JSON.parse(init.body), fingerprint: 'updated-' + old.fingerprint});
        workspace.fingerprint = 'workspace-after-' + id;
        return Response.json(tags.get(id));
      }
      if (init.method !== 'GET') throw Error('Synthetic provider mutations forbidden');
      if (p === path) return Response.json(workspace);
      const id = p.split('/').at(-1);
      if (p === path + '/tags/' + id && tags.has(id)) return Response.json(tags.get(id));
      return Response.json({error: {message: 'Synthetic missing resource'}}, {status: 404});
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const requirements = {
    container_id: '55',
    workspace_id: '66',
    tag_ids: ['001', '002'],
    required_types: ['ad_storage'],
  };
  return {
    store,
    actor,
    key,
    connection,
    workspace,
    tags,
    service,
    requirements,
    requests,
    hook: fn => {
      hook = fn;
    },
    call: (input = {}, caller = actor) =>
      service.call(
        'amcp_workspace',
        {
          action: 'preview_consent_plan',
          gateway,
          connection_id: connection.id,
          account_id: '44',
          requirements,
          ...input,
        },
        caller,
      ),
    create: (p, changes = {}, caller = actor) =>
      service.call(
        'amcp_workspace',
        {
          action: 'create_consent_plan',
          preview_id: p.preview_id,
          preview_hash: p.preview_hash,
          confirmed: true,
          ...changes,
        },
        caller,
      ),
  };
}
