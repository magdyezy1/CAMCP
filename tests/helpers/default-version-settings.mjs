/**
 * A side-effect module: imported before any dist module, it unsets the deployment's provider version settings in this
 * test process, so what the process loads answers with AMCP's defaults. Meta's Graph API version is read once at load
 * (src/meta-version.ts); LinkedIn's version and the Google developer token are read at each call. A golden of what the
 * providers' contracts, notes and listings say (tests/tool-surface-golden.test.mjs) then passes whatever a gate or
 * worker sets, the v25.0 rollback included (wave 4c-r7 review). Child processes inherit the unset environment.
 */
export const versionSettings = Object.freeze([
  'AMCP_META_API_VERSION',
  'AMCP_LINKEDIN_API_VERSION',
  'AMCP_GOOGLE_DEVELOPER_TOKEN',
]);
for (const name of versionSettings) delete process.env[name];
