// Preloaded into each test process by `node tools/call-replay.mjs record` (node --test --import). It registers the loader
// hook that wraps the targets of tools/call-replay.mjs and writes every wrapped call, with its arguments and result or
// refusal, to AMCP_CALL_REPLAY_DIR when the process exits. A NativeTransport also records each request it sends (URL,
// method, headers with secret values digested, body). Recording never changes a call: arguments are encoded before
// the call, results after it, and a recorder failure is swallowed. Without AMCP_CALL_REPLAY_DIR this module does nothing.
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {encode, replayable} from './call-replay.mjs';

const directory = process.env.AMCP_CALL_REPLAY_DIR,
  root = process.env.AMCP_CALL_REPLAY_ROOT;

/** Plain-data JSON of replayable arguments (undefined kept as a marker), or undefined when they are not plain data. */
function plainJson(value) {
  let plain = true;
  const text = JSON.stringify(value, function (_key, v) {
    if (v === undefined) return {$undefined: true};
    if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') plain = false;
    if (typeof v === 'number' && !Number.isFinite(v)) plain = false;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const prototype = Object.getPrototypeOf(v);
      if (prototype !== Object.prototype && prototype !== null) plain = false;
    }
    return v;
  });
  return plain ? text : undefined;
}

if (directory && root) {
  register(new URL('./call-replay-hooks.mjs', import.meta.url), {data: {root}});
  const test = path
      .relative(root, process.argv[1] ?? 'unknown')
      .replaceAll('\\', '/')
      .replace(/[^\w.-]+/g, '_'),
    records = new Map(),
    replays = new Map(),
    replaySet = new Set(replayable);
  const add = record => {
    const text = JSON.stringify(record);
    records.set(text, (records.get(text) ?? 0) + 1);
  };
  const recorder = {
    call(id, fn, self, args) {
      let input, rawArgs;
      try {
        input = encode(args);
        if (replaySet.has(id)) rawArgs = plainJson(args);
      } catch {
        input = {$unencodable: true};
      }
      const done = outcome => {
        try {
          add({id, in: input, out: outcome});
          if (rawArgs !== undefined && !replays.has(id + '\n' + rawArgs))
            replays.set(id + '\n' + rawArgs, {id, args: rawArgs, outcome});
        } catch {}
      };
      let result;
      try {
        result = fn.apply(self, args);
      } catch (error) {
        done({throws: encode(error)});
        throw error;
      }
      if (result && typeof result.then === 'function')
        return result.then(
          value => {
            done({returns: encode(value)});
            return value;
          },
          error => {
            done({throws: encode(error)});
            throw error;
          },
        );
      done({returns: encode(result)});
      return result;
    },
    /**
     * Wraps methods on a class prototype. An instance that holds a fetcher (NativeTransport, CredentialProvider,
     * PlatformOAuth) also gets it wrapped, once per instance, so every provider request it sends is recorded.
     */
    patchClass(cls, id, methods) {
      for (const method of methods) {
        const original = cls?.prototype?.[method];
        if (typeof original !== 'function') {
          add({id: id + '.' + method, missing: true});
          continue;
        }
        if (original.__callReplay) continue;
        const wrapped = function (...args) {
          recorder.watchFetcher(this);
          return recorder.call(id + '.' + method, original, this, args);
        };
        wrapped.__callReplay = true;
        cls.prototype[method] = wrapped;
      }
    },
    watchFetcher(transport) {
      const fetcher = transport && typeof transport === 'object' ? transport.fetcher : undefined;
      if (typeof fetcher !== 'function' || fetcher.__callReplay) return;
      const watched = function (url, init = {}) {
        try {
          add({
            id: 'provider_request',
            in: encode({
              url: String(url),
              method: init.method ?? 'GET',
              headers: init.headers ?? {},
              body: init.body,
              redirect: init.redirect,
            }),
          });
        } catch {}
        return fetcher.call(this, url, init);
      };
      watched.__callReplay = true;
      transport.fetcher = watched;
    },
    missing(id) {
      add({id, missing: true});
    },
  };
  globalThis.__amcpCallReplay = recorder;
  process.on('exit', code => {
    try {
      // The process exit code says whether the test file passed; compare reports it apart from the calls.
      const lines = [
        JSON.stringify({id: '$exit', code}),
        ...[...records].map(([text, count]) => JSON.stringify({...JSON.parse(text), count})),
      ];
      fs.writeFileSync(path.join(directory, test + '.' + process.pid + '.calls.jsonl'), lines.join('\n') + '\n');
      if (replays.size)
        fs.writeFileSync(
          path.join(directory, test + '.' + process.pid + '.replay.jsonl'),
          [...replays.values()].map(r => JSON.stringify(r)).join('\n') + '\n',
        );
    } catch {}
  });
}
