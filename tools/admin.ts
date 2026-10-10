import {createEncryptedBackup, verifyEncryptedBackup, restoreEncryptedBackup, restoreDrill} from '../src/backup.js';
import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorError} from '../src/errors.js';
import {guardInput} from '../src/security.js';
import {passwordHashSync} from '../server/password-hashes.js';
import {resetTwoStepOffline} from '../server/user-accounts.js';
import {adminRootRefusal, DEFAULT_DATABASE_PATH} from '../server/config.js';
import {stampVolumeMarker} from '../server/volume.js';
import path from 'node:path';
import type {Actor, Connection, Credentials} from '../src/types.js';
const argv = process.argv.slice(2),
  allowRoot = argv.includes('--allow-root');
const [command, ...args] = argv.filter(arg => arg !== '--allow-root');
const help =
  'Usage: admin [--allow-root] keygen | password-hash (reads the password from standard input) | init <tenant> | create-key <tenant> <user> <reader|operator|admin> | revoke-key <file> | mfa-reset <email> | provision <json-file> | status <tenant> | audit-verify | restamp-volume | backup <new-encrypted-file> [--allow-same-volume] [--skip-space-check] | backup-encrypted <new-encrypted-file> | backup-verify <encrypted-file> | backup-restore <encrypted-file> <new-sqlite-file> | backup-drill <encrypted-file> <new-sqlite-file> [--record <new-json-file>]';
const rootRefusal = adminRootRefusal({
  production: process.env.NODE_ENV === 'production',
  uid: process.getuid?.(),
  allowRoot,
});
if (command === 'keygen') {
  process.stdout.write(randomBytes(32).toString('base64') + '\n');
} else if (!command || command === 'help') {
  process.stdout.write(help + '\n');
} else if (command === 'password-hash') {
  // For AMCP_ADMIN_PASSWORD_HASH or AMCP_TEST_PASSWORD_HASH. Standard input keeps the password out of the shell
  // history and the process list.
  const password = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  if (password.length < 16 || password.length > 1024) {
    process.stderr.write('Use a password of 16 characters or more (at most 1024).\n');
    process.exitCode = 1;
  } else process.stdout.write(passwordHashSync(password) + '\n');
} else if (command === 'backup-verify' || command === 'backup-restore' || command === 'backup-drill') {
  // Recovery must work even when MIRROR_DB is corrupt or unavailable. Never
  // bootstrap, migrate or create the configured application database here.
  try {
    // backup-drill takes an optional `--record <new-json-file>` that keeps the drill record (OPS-04).
    const at = command === 'backup-drill' ? args.indexOf('--record') : -1,
      record = at >= 0 ? args[at + 1] : undefined,
      paths = at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args;
    if (
      paths.length !== (command === 'backup-verify' ? 1 : 2) ||
      (at >= 0 && (!record || record.startsWith('--') || fs.existsSync(record)))
    )
      throw new MirrorError('BACKUP_PATH_REQUIRED', help);
    const receipt =
      command === 'backup-verify'
        ? await verifyEncryptedBackup(paths[0]!, process.env.MIRROR_MASTER_KEY)
        : command === 'backup-restore'
          ? await restoreEncryptedBackup(paths[0]!, paths[1]!, process.env.MIRROR_MASTER_KEY)
          : await restoreDrill(paths[0]!, paths[1]!, process.env.MIRROR_MASTER_KEY);
    if (record) fs.writeFileSync(record, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(
      (e instanceof MirrorError
        ? e.code + ': ' + e.message
        : 'BACKUP_RECOVERY_FAILED: The backup could not be read or restored. Check its path, key and filesystem permissions.') +
        '\n',
    );
    process.exitCode = 1;
  }
} else if (rootRefusal) {
  // Commands below open MIRROR_DB; as root they could leave files the server cannot open (OPS-03).
  process.stderr.write('ADMIN_ROOT_REFUSED: ' + rootRefusal + '\n');
  process.exitCode = 1;
} else {
  const database = process.env.MIRROR_DB || DEFAULT_DATABASE_PATH,
    store = new Store(database, process.env.MIRROR_MASTER_KEY);
  try {
    switch (command) {
      case 'init':
        if (!args[0]) throw Error(help);
        store.ensureTenant(args[0]);
        process.stdout.write('Tenant initialized.\n');
        break;
      case 'create-key': {
        const [tenantId, userId, role] = args;
        if (!tenantId || !userId || !['reader', 'operator', 'admin'].includes(role ?? '')) throw Error(help);
        // Service-owned (SEC-06): a member's password, email or two-step change never revokes it. Owner health lists it.
        const token = store.createServiceKey({tenantId, userId, role: role as Actor['role']});
        process.stdout.write(token + '\n');
        break;
      }
      case 'mfa-reset': {
        // The instance owner's reset of a member who lost their authenticator and recovery codes (SEC-06).
        if (!args[0] || args.length !== 1) throw Error(help);
        const result = resetTwoStepOffline(store, args[0]);
        process.stdout.write(
          JSON.stringify(
            {
              ...result,
              next_step:
                'Two-step verification is off and every session, connector token and AI-client connection of this person ended. Tell them to sign in and set it up again.',
            },
            null,
            2,
          ) + '\n',
        );
        break;
      }
      case 'revoke-key':
        if (!args[0]) throw Error(help);
        store.revokeKey(fs.readFileSync(args[0], 'utf8').trim());
        process.stdout.write('Key revoked.\n');
        break;
      case 'provision': {
        if (!args[0]) throw Error(help);
        const data = JSON.parse(fs.readFileSync(args[0], 'utf8')) as {connection: Connection; credentials: Credentials};
        guardInput(data);
        const c = data.connection;
        if (
          !c ||
          typeof c.id !== 'string' ||
          !c.id ||
          typeof c.tenantId !== 'string' ||
          !c.tenantId ||
          !Array.isArray(c.scopes) ||
          typeof c.enabled !== 'boolean' ||
          typeof c.label !== 'string' ||
          !new Registry().tools.has(c.gateway)
        )
          throw new MirrorError('INVALID_CONNECTION', 'Provide a complete connection with an observed gateway name.');
        if (!data.credentials || typeof data.credentials !== 'object' || !Object.values(data.credentials).some(Boolean))
          throw new MirrorError('INVALID_CREDENTIALS', 'Provide credentials for your own vendor app.');
        store.putConnection({tenantId: c.tenantId, userId: 'local-administrator', role: 'admin'}, c, data.credentials);
        store.appendAudit(c.tenantId, 'admin/provision', {
          event: 'connection_provisioned',
          connection_id: c.id,
          gateway: c.gateway,
          accounts: c.accounts,
        });
        process.stdout.write('Encrypted connection provisioned.\n');
        break;
      }
      case 'status':
        if (!args[0]) throw Error(help);
        process.stdout.write(
          JSON.stringify(
            {tenant: args[0], connections: store.listConnections(args[0]), audit_chain_valid: store.verifyAudit()},
            null,
            2,
          ) + '\n',
        );
        break;
      case 'restamp-volume':
        // After a deliberate restore or volume move: one new marker in the data directory and the database.
        if (database === ':memory:') throw Error(help);
        stampVolumeMarker(store, path.dirname(path.resolve(database)));
        process.stdout.write('Volume marker stamped.\n');
        break;
      case 'audit-verify':
        if (!store.verifyAudit()) throw new MirrorError('AUDIT_INTEGRITY_FAILURE', 'Audit hash chain does not verify.');
        process.stdout.write('Audit hash chain verified.\n');
        break;
      // Backups are encrypted only (owner decision, review 2026-09-28): `backup` writes the same AES-256-GCM archive as
      // `backup-encrypted`, so no command leaves a plaintext copy of report rows and lead data on disk.
      case 'backup':
      case 'backup-encrypted': {
        // In production a destination on MIRROR_DB's volume is refused unless --allow-same-volume; --skip-space-check
        // overrides the free-space estimate (OPS-04, docs/OPERATIONS.md).
        const flags = ['--allow-same-volume', '--skip-space-check'],
          files = args.filter(a => !flags.includes(a));
        if (files.length !== 1 || files[0]!.startsWith('--') || fs.existsSync(files[0]!))
          throw new MirrorError('BACKUP_PATH_REQUIRED', 'Provide a new backup filename.');
        process.stdout.write(
          JSON.stringify(
            await createEncryptedBackup(store, files[0]!, process.env.MIRROR_MASTER_KEY, {
              allowSameVolume: args.includes('--allow-same-volume'),
              skipSpaceCheck: args.includes('--skip-space-check'),
            }),
            null,
            2,
          ) + '\n',
        );
        break;
      }
      default:
        throw Error(help);
    }
  } catch (e) {
    process.stderr.write(
      (e instanceof MirrorError ? e.code + ': ' + e.message : e instanceof Error ? e.message : 'Command failed.') +
        '\n',
    );
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
