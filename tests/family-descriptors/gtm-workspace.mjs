// gtm_workspace: POST https://tagmanager.googleapis.com/tagmanager/v2/{workspace}/bulk_update (Tag Manager API v2,
// Workspaces.bulk_update) through the delegated gtm_ops operation. A bulk update replaces each entity it names with the
// values sent; for tag 1 that replaces its `parameter` (the HTML it injects into every page it fires on), so the tag's
// current `parameter` in the workspace is the decisive field.
const workspace = 'accounts/44/containers/55/workspaces/66',
  origin = 'https://tagmanager.googleapis.com',
  prefix = '/tagmanager/v2/',
  // Each entity kind: its collection path and the key its list answer uses.
  kinds = {
    tag: ['tags', 'tag', 'tagId'],
    trigger: ['triggers', 'trigger', 'triggerId'],
    variable: ['variables', 'variable', 'variableId'],
    folder: ['folders', 'folder', 'folderId'],
    customTemplate: ['templates', 'template', 'templateId'],
    client: ['clients', 'client', 'clientId'],
    transformation: ['transformations', 'transformation', 'transformationId'],
    zone: ['zones', 'zone', 'zoneId'],
    gtagConfig: ['gtag_config', 'gtagConfig', 'gtagConfigId'],
    builtInVariable: ['built_in_variables', 'builtInVariable', 'type'],
  },
  row = (kind, id, fields = {}) => ({
    path: workspace + '/' + kinds[kind][0] + '/' + id,
    accountId: '44',
    containerId: '55',
    workspaceId: '66',
    [kinds[kind][2]]: id,
    ...fields,
  });

export default {
  family: 'gtm_workspace',
  risk: 'settings',
  gateway: 'gtm_native_action',
  account: '44',
  connection: {scopes: ['https://www.googleapis.com/auth/tagmanager.edit.containers']},
  arguments: {
    operation: 'gtm_ops',
    arguments: {
      action: 'BULK_UPDATE_WORKSPACE',
      account_id: '44',
      path: workspace,
      payload: {
        changes: [
          {
            tag: {tagId: '1', name: 'Updated local tag', type: 'html', parameter: []},
            changeStatus: 'updated',
          },
        ],
      },
    },
  },
  seed: () => ({
    workspace: {path: workspace, accountId: '44', containerId: '55', workspaceId: '66', name: 'Draft'},
    status: {workspaceChange: [], mergeConflict: []},
    rows: {
      tag: [
        row('tag', '1', {
          name: 'Local tag',
          type: 'html',
          parameter: [{type: 'template', key: 'html', value: '<b>reviewed</b>'}],
          fingerprint: 'entity-1',
        }),
      ],
      trigger: [row('trigger', '3', {name: 'Trigger', type: 'pageview', fingerprint: 'trigger-3'})],
      builtInVariable: [row('builtInVariable', 'pagePath', {name: 'Page Path'})],
    },
  }),
  paginatedCodes: ['INCOMPLETE_STATE'],
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (url.origin !== origin || !path.startsWith(prefix)) return;
    const resource = path.slice(prefix.length);
    if (method === 'GET') {
      if (resource === workspace) return {json: state.workspace};
      if (resource === workspace + '/status') return {json: structuredClone(state.status)};
      const kind = Object.keys(kinds).find(k => resource === workspace + '/' + kinds[k][0]);
      if (!kind) return;
      // Every page names the same cursor again when the provider pages a collection.
      const rows = mode.paginate && url.searchParams.has('pageToken') ? [] : (state.rows[kind] ?? []);
      return {
        json: {
          ...(rows.length ? {[kinds[kind][1]]: structuredClone(rows)} : {}),
          ...(mode.paginate ? {nextPageToken: 'synthetic-next-page'} : {}),
        },
      };
    }
    if (method === 'POST' && resource === workspace + '/bulk_update') {
      // A partial answer: Tag Manager answers without the changes it made.
      if (mode.partial) return {json: {changes: []}};
      const changes = body.changes.map(edit => {
        const kind = Object.keys(edit).find(k => k !== 'changeStatus'),
          id = edit[kind][kinds[kind][2]],
          stored = row(kind, id, {...edit[kind], fingerprint: 'stored-' + id});
        state.rows[kind] = [...(state.rows[kind] ?? []).filter(r => r[kinds[kind][2]] !== id), stored];
        return {[kind]: stored, changeStatus: edit.changeStatus};
      });
      return {json: {changes}};
    }
  },
  decisive: {
    change: state =>
      (state.rows.tag[0].parameter = [{type: 'template', key: 'html', value: '<b>edited elsewhere</b>'}]),
    field: /parameter/,
  },
};
