// Synthetic shared-SQLite timing counter contention; no provider, account or credential operation.
import {Store} from '../../dist/src/store.js';
import {recordServiceTiming} from '../../dist/src/service-timings.js';
const filename = process.argv[2],
  count = Number(process.argv[3]);
if (!filename || !Number.isInteger(count) || count < 1 || count > 1000)
  throw Error('Invalid synthetic worker arguments');
const store = new Store(filename, Buffer.alloc(32, 87).toString('base64'));
try {
  for (let i = 0; i < count; i++) recordServiceTiming(store, 'multiprocess-fixture', 'workspace', 25, true, 1800000);
} finally {
  store.close();
}
