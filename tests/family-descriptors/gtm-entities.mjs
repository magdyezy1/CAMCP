// gtm_entities: PUT https://tagmanager.googleapis.com/tagmanager/v2/{tag path} (Tag Manager API v2, Tag.update)
// through the delegated gtm_ops operation. An update replaces the whole tag, including `firingTriggerId`, the triggers
// that decide on which pages the tag fires; the tag's current `firingTriggerId` is the decisive field. (Tag Manager
// also moves the tag's `fingerprint` on every change; AMCP sends the reviewed fingerprint so Google refuses a stale
// update as well.)
const workspace = 'accounts/44/containers/55/workspaces/66',
  tag = workspace + '/tags/7',
  origin = 'https://tagmanager.googleapis.com',
  prefix = '/tagmanager/v2/';

export default {
  family: 'gtm_entities',
  risk: 'settings',
  gateway: 'gtm_native_action',
  account: '44',
  connection: {scopes: ['https://www.googleapis.com/auth/tagmanager.edit.containers']},
  arguments: {
    operation: 'gtm_ops',
    arguments: {
      action: 'UPDATE_TAG',
      account_id: '44',
      path: tag,
      payload: {
        name: 'Purchase pixel',
        type: 'html',
        parameter: [{type: 'template', key: 'html', value: '<script>/* synthetic */</script>'}],
        firingTriggerId: ['3'],
      },
    },
  },
  seed: () => ({
    tag: {
      path: tag,
      accountId: '44',
      containerId: '55',
      workspaceId: '66',
      tagId: '7',
      name: 'Purchase pixel',
      type: 'html',
      parameter: [{type: 'template', key: 'html', value: '<script>/* synthetic */</script>'}],
      firingTriggerId: ['2'],
      fingerprint: '1700000000001',
    },
  }),
  unpaginated: 'GET /tagmanager/v2/{tag path} returns one Tag resource; Tag Manager pages only list calls',
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (url.origin !== origin || path !== prefix + tag) return;
    if (method === 'GET') return {json: state.tag};
    if (method === 'PUT') {
      // A partial answer: Tag Manager answers without the path of the tag it changed.
      if (mode.partial) return {json: {}};
      state.tag = {...state.tag, ...body, path: tag, fingerprint: String(Number(state.tag.fingerprint) + 1)};
      return {json: state.tag};
    }
  },
  decisive: {
    change: state => Object.assign(state.tag, {firingTriggerId: ['2', '9'], fingerprint: '1700000000002'}),
    field: /firingTriggerId/,
  },
};
