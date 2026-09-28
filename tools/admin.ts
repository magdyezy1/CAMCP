import {createEncryptedBackup, verifyEncryptedBackup, restoreEncryptedBackup} from '../src/backup.js';
import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorError} from '../src/errors.js';
import {guardInput} from '../src/security.js';
import {passwordHashSync} from '../server/password-hashes.js';
import type {Actor, Connection, Credentials} from '../src/types.js';
const [command, ...args] = process.argv.slice(2);
const help =
  'Usage: admin keygen | password-hash (reads the password from standard input) | init <tenant> | create-key <tenant> <user> <reader|operator|admin> | revoke-key <file> | provision <json-file> | status <tenant> | audit-verify | backup <new-encrypted-file> | backup-encrypted <new-encrypted-file> | backup-verify <encrypted-file> | backup-restore <encrypted-file> <new-sqlite-file>';
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
} else if (command === 'backup-verify' || command === 'backup-restore') {
  // Recovery must work even when MIRROR_DB is corrupt or unavailable. Never
  // bootstrap, migrate or create the configured application database here.
  try {
    if (args.length !== (command === 'backup-verify' ? 1 : 2)) throw new MirrorError('BACKUP_PATH_REQUIRED', help);
    const receipt =
      command === 'backup-verify'
        ? await verifyEncryptedBackup(args[0]!, process.env.MIRROR_MASTER_KEY)
        : await restoreEncryptedBackup(args[0]!, args[1]!, process.env.MIRROR_MASTER_KEY);
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
} else {
  const store = new Store(process.env.MIRROR_DB ?? '.runtime/mirror.sqlite', process.env.MIRROR_MASTER_KEY);
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
        const token = store.createKey({tenantId, userId, role: role as Actor['role']});
        process.stdout.write(token + '\n');
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
      case 'audit-verify':
        if (!store.verifyAudit()) throw new MirrorError('AUDIT_INTEGRITY_FAILURE', 'Audit hash chain does not verify.');
        process.stdout.write('Audit hash chain verified.\n');
        break;
      // Backups are encrypted only (owner decision, review 2026-09-28): `backup` writes the same AES-256-GCM archive as
      // `backup-encrypted`, so no command leaves a plaintext copy of report rows and lead data on disk.
      case 'backup':
      case 'backup-encrypted':
        if (!args[0] || fs.existsSync(args[0]))
          throw new MirrorError('BACKUP_PATH_REQUIRED', 'Provide a new backup filename.');
        process.stdout.write(
          JSON.stringify(await createEncryptedBackup(store, args[0], process.env.MIRROR_MASTER_KEY), null, 2) + '\n',
        );
        break;
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
