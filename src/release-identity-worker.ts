import {isMainThread, parentPort, workerData} from 'node:worker_threads';
import {packagedIdentity} from './release-identity.js';
if (!isMainThread && parentPort) {
  try {
    parentPort.postMessage(packagedIdentity(workerData.root));
  } catch {
    parentPort.postMessage(null);
  }
}
