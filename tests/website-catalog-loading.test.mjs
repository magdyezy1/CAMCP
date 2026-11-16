import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createContext, Script} from 'node:vm';
import {listenForFetch} from '../dist/tests/http-listener.js';
const source = fs.readFileSync('web/localization.js', 'utf8');
// WEB-07: the browser downloads the catalog in chunks of at most 1 MiB each (tools/locale-chunks.mjs), the first being
// the shell's; the whole catalog is no longer one download.
const maximum = 1048576;
function fixture(fetcher = () => new Promise(() => {}), deadlineMs, monotonic = performance) {
  const requests = [],
    notices = [],
    delays = [],
    timers = new Set(),
    signals = [];
  class ObservedController extends AbortController {
    constructor() {
      super();
      const state = {active: 0, maximum: 0},
        signal = this.signal,
        add = signal.addEventListener.bind(signal),
        remove = signal.removeEventListener.bind(signal);
      signals.push(state);
      signal.addEventListener = (type, listener, options) => {
        if (type === 'abort') {
          state.active++;
          state.maximum = Math.max(state.maximum, state.active);
        }
        return add(type, listener, options);
      };
      signal.removeEventListener = (type, listener, options) => {
        if (type === 'abort') state.active--;
        return remove(type, listener, options);
      };
    }
  }
  let handler = fetcher;
  const context = createContext({
    document: {
      documentElement: {lang: 'en', dir: 'ltr'},
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
    },
    localStorage: {getItem: () => null, setItem() {}},
    navigationGeneration: 1,
    identityGeneration: 1,
    fetch: (url, args) => {
      requests.push({url, args});
      return handler(url, args);
    },
    TextDecoder,
    AbortController: ObservedController,
    Intl,
    Date,
    performance: monotonic,
    setTimeout: (callback, delay) => {
      delays.push(delay);
      const timer = setTimeout(callback, deadlineMs ?? delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout: timer => {
      timers.delete(timer);
      clearTimeout(timer);
    },
    render: async () => {},
    toast: value => notices.push(value),
    confirmAction: async () => true,
  });
  new Script(source).runInContext(context);
  return {
    context,
    requests,
    notices,
    delays,
    timers,
    signals,
    run: code => new Script(code).runInContext(context),
    setFetcher: value => (handler = value),
  };
}
function streamBytes(bytes, size = 32768) {
  let offset = 0,
    cancelled = 0,
    pulls = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        pulls++;
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + size, bytes.length);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
      cancel() {
        cancelled++;
      },
    },
    {highWaterMark: 0},
  );
  return {body, response: new Response(body), cancelled: () => cancelled, pulls: () => pulls};
}
function originalFetch(request) {
  assert.equal(request.url, '/assets/locales/ar/shell.json');
  assert.equal(request.args.credentials, 'same-origin');
  assert.equal(request.args.cache, 'no-cache');
  assert.equal(request.args.redirect, 'error');
  assert.deepEqual(Object.keys(request.args).sort(), ['cache', 'credentials', 'redirect', 'signal']);
  assert.ok(request.args.signal instanceof AbortSignal);
}
test('bounded reader loads the actual Arabic shell chunk across split UTF-8 bytes', async () => {
  const data = JSON.parse(fs.readFileSync('web/locales/ar/shell.json', 'utf8')),
    bytes = Buffer.from(JSON.stringify(data)),
    s = streamBytes(bytes, 113),
    f = fixture(async () => s.response);
  const result = await f.run("uiCatalog('ar')");
  assert.equal(result.size, Object.keys(data).length);
  for (const [key, value] of Object.entries(data)) assert.equal(result.get(key), value);
  assert.equal(s.body.locked, false);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.delays, [15000]);
  originalFetch(f.requests[0]);
  assert.ok(s.pulls() >= Math.ceil(bytes.length / 113));
  assert.equal(f.signals[0].maximum, 1);
  assert.equal(f.signals[0].active, 0);
});
test('exact decompressed-byte boundary is accepted and the next byte is refused before parsing', async () => {
  for (const excess of [0, 1]) {
    const empty = JSON.stringify({Boundary: ''}),
      text = JSON.stringify({Boundary: 'a'.repeat(maximum - Buffer.byteLength(empty) + excess)}),
      bytes = Buffer.from(text),
      s = streamBytes(bytes),
      f = fixture(async () => s.response);
    assert.equal(bytes.length, maximum + excess);
    if (excess) await assert.rejects(f.run("uiCatalog('ar')"), /Language catalog too large/);
    else assert.equal((await f.run("uiCatalog('ar')")).get('Boundary').length, maximum - Buffer.byteLength(empty));
    assert.equal(s.body.locked, false);
    assert.equal(f.requests[0].args.signal.aborted, true);
    assert.equal(f.timers.size, 0);
  }
});
test('size is limited in received bytes rather than decoded characters and an overflowing stream is cancelled', async () => {
  const text = JSON.stringify({Boundary: '中'.repeat(700000)}),
    bytes = Buffer.from(text),
    s = streamBytes(bytes),
    f = fixture(async () => s.response);
  assert.ok(text.length < 1048576 && bytes.length > maximum);
  await assert.rejects(f.run("uiCatalog('ar')"), /Language catalog too large/);
  assert.equal(s.cancelled(), 1);
  assert.equal(s.body.locked, false);
  assert.equal(f.timers.size, 0);
});
test('invalid and truncated UTF-8 cannot become replacement-character translations', async () => {
  for (const bytes of [
    Buffer.concat([Buffer.from('{"Hello":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]),
    Buffer.from([0x7b, 0x22, 0x48, 0x22, 0x3a, 0x22, 0xd8]),
  ]) {
    const s = streamBytes(bytes, 1),
      f = fixture(async () => s.response);
    await assert.rejects(f.run("uiCatalog('ar')"));
    assert.equal(s.body.locked, false);
    assert.equal(f.timers.size, 0);
  }
});
test('malformed JSON, HTML, non-string messages and placeholder drift retain the current view and fixed notice', async () => {
  for (const body of [
    'PRIVATE-JSON',
    'null',
    '[]',
    '{"Hello":"<img src=PRIVATE>"}',
    '{"Hello":false}',
    '{"Hello":"  "}',
    '{"Hello {name}":"مرحبًا {token}"}',
  ]) {
    const f = fixture(async () => new Response(body));
    assert.equal(await f.run("changeUILocale('ar')"), false);
    assert.equal(f.context.document.documentElement.lang, 'en');
    assert.deepEqual(f.notices, ['The language could not be loaded. Your current view is unchanged.']);
    assert.doesNotMatch(JSON.stringify(f.notices), /PRIVATE|token|SyntaxError|TypeError/);
    assert.equal(f.timers.size, 0);
  }
});
for (const phase of ['header', 'body'])
  test('catalog ' + phase + ' deadline bounds even an uncooperative synthetic source and cleanup', async () => {
    let cancelled = 0,
      body;
    if (phase === 'body')
      body = new ReadableStream(
        {
          pull: () => new Promise(() => {}),
          cancel: () => {
            cancelled++;
            return new Promise(() => {});
          },
        },
        {highWaterMark: 0},
      );
    const f = fixture(() => (phase === 'body' ? Promise.resolve(new Response(body)) : new Promise(() => {})), 20),
      start = performance.now();
    await assert.rejects(f.run("uiCatalog('ar')"), /Language catalog unavailable/);
    assert.ok(performance.now() - start < 1000);
    assert.equal(f.requests[0].args.signal.aborted, true);
    assert.equal(f.timers.size, 0);
    if (body) {
      assert.equal(cancelled, 1);
      assert.equal(body.locked, false);
    }
  });
test('unbounded empty chunks hit a finite consecutive-empty limit and cannot bypass the byte limit', async () => {
  let pulls = 0,
    cancelled = 0;
  const body = new ReadableStream(
      {
        pull: controller => {
          pulls++;
          controller.enqueue(new Uint8Array());
        },
        cancel: () => {
          cancelled++;
        },
      },
      {highWaterMark: 0},
    ),
    f = fixture(async () => new Response(body));
  await assert.rejects(f.run("uiCatalog('ar')"), /Language catalog too large/);
  assert.equal(pulls, 65);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  assert.equal(f.timers.size, 0);
});
test('pending catalog reads coalesce, success is cached, and a failed read permits an explicit fresh attempt', async () => {
  let respond;
  const f = fixture(() => new Promise(resolve => (respond = resolve))),
    first = f.run("uiCatalog('ar')"),
    second = f.run("uiCatalog('ar')");
  assert.equal(f.requests.length, 1);
  respond(new Response('{"Home":"الرئيسية"}'));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(await f.run("uiCatalog('ar')"), a);
  assert.equal(f.requests.length, 1);
  const retry = fixture(async () => new Response('PRIVATE-INVALID'));
  await assert.rejects(retry.run("uiCatalog('ar')"));
  retry.setFetcher(async () => new Response('{"Home":"الرئيسية"}'));
  assert.equal((await retry.run("uiCatalog('ar')")).get('Home'), 'الرئيسية');
  assert.equal(retry.requests.length, 2);
  assert.equal(retry.timers.size, 0);
});
test('HTTP refusal cancels its unread body and unsupported languages do not fetch or expose private content', async () => {
  let cancelled = 0,
    pulls = 0;
  const body = new ReadableStream(
      {
        pull: controller => {
          pulls++;
          controller.enqueue(Buffer.from('PRIVATE-REFUSAL'));
        },
        cancel: () => {
          cancelled++;
        },
      },
      {highWaterMark: 0},
    ),
    f = fixture(async () => new Response(body, {status: 503}));
  await assert.rejects(f.run("uiCatalog('ar')"), /Language catalog unavailable/);
  assert.equal(cancelled, 1);
  assert.equal(pulls, 0);
  assert.equal(body.locked, false);
  assert.equal(f.requests[0].args.signal.aborted, true);
  originalFetch(f.requests[0]);
  assert.equal((await f.run("uiCatalog('en')")).size, 0);
  await assert.rejects(f.run("uiCatalog('https://PRIVATE.invalid')"), /Unsupported interface language/);
  assert.equal(f.requests.length, 1);
});
for (const holdBody of [false, true])
  test(
    'actual owned-loopback ' + (holdBody ? 'body' : 'header') + ' timeout aborts the native fetch and retains English',
    async () => {
      const requests = [],
        timers = [];
      const listener = await listenForFetch((req, res) => {
        requests.push(req);
        if (holdBody) {
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.write('{"Home":"');
        }
        timers.push(setTimeout(() => res.end(holdBody ? 'الرئيسية"}' : '{}'), 5000));
      });
      try {
        const origin = 'http://127.0.0.1:' + listener.address().port;
        const f = fixture((url, args) => fetch(origin + url, args), 100);
        assert.equal(await f.run("changeUILocale('ar')"), false);
        assert.equal(f.context.document.documentElement.lang, 'en');
        assert.deepEqual(f.notices, ['The language could not be loaded. Your current view is unchanged.']);
        assert.equal(f.requests[0].args.signal.aborted, true);
        assert.equal(f.timers.size, 0);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].method, 'GET');
        assert.equal(requests[0].url, '/assets/locales/ar/shell.json');
        assert.equal(requests[0].headers.authorization, undefined);
        assert.equal(requests[0].headers.cookie, undefined);
      } finally {
        timers.forEach(clearTimeout);
        listener.closeAllConnections();
        await new Promise((resolve, reject) => listener.close(error => (error ? reject(error) : resolve())));
      }
    },
  );

test('monotonic deadline bounds immediate chunks when the event-loop timer has not fired', async () => {
  let clock = 0,
    cancelled = 0,
    pulls = 0;
  const body = new ReadableStream(
    {
      pull: controller => {
        pulls++;
        clock = 15001;
        controller.enqueue(Buffer.from('{"Home":"'));
      },
      cancel: () => {
        cancelled++;
      },
    },
    {highWaterMark: 0},
  );
  const f = fixture(async () => new Response(body), undefined, {now: () => clock});
  assert.equal(await f.run("changeUILocale('ar')"), false);
  assert.equal(pulls, 1);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  assert.equal(f.context.document.documentElement.lang, 'en');
  assert.deepEqual(f.notices, ['The language could not be loaded. Your current view is unchanged.']);
  assert.equal(f.timers.size, 0);
  assert.equal(f.signals[0].maximum, 1);
  assert.equal(f.signals[0].active, 0);
});
// R25 ar-lazy: an answer that carries a refusal sentence waits for the `providers` chunk (web/route-assets.js:
// uiEnsureAnswerChunks) through the same bounded, coalesced read as every other chunk, and when it cannot load shows one
// fixed Arabic sentence in place of the English message.
const shellMessages = JSON.parse(fs.readFileSync('web/locales/ar/shell.json', 'utf8')),
  fallbackKey = 'The details of this message could not be loaded. Try again.',
  lazySentence = 'A refusal sentence only the providers chunk has.';
function answerFixture(fetcher, deadlineMs) {
  const f = fixture(fetcher, deadlineMs);
  Object.assign(f.context, {
    URL,
    location: {href: 'https://amcp.invalid/', origin: 'https://amcp.invalid', pathname: '/'},
    window: {addEventListener() {}, removeEventListener() {}},
  });
  for (const file of ['routes.js', 'route-assets.js'])
    new Script(fs.readFileSync('web/' + file, 'utf8')).runInContext(f.context);
  f.context.shell = new Map(Object.entries(shellMessages));
  f.run("uiUseMessages('ar', shell, ['shell'])");
  f.context.refused = () => ({success: false, error: {code: 'X', message: lazySentence, next_action: lazySentence}});
  return f;
}
test('an answer waits for the providers chunk through the read a prefetch started, and the chunk is fetched once', async () => {
  let respond;
  const f = answerFixture(() => new Promise(resolve => (respond = resolve)));
  f.context.answer = f.context.refused();
  const prefetch = f.run("uiCatalog('ar', 'providers')"),
    waiting = f.run('uiEnsureAnswerChunks(answer)');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, '/assets/locales/ar/providers.json');
  respond(new Response(JSON.stringify({[lazySentence]: 'جملة رفض'})));
  await Promise.all([prefetch, waiting]);
  assert.equal(f.requests.length, 1, 'the answer and the prefetch share one request');
  assert.equal(f.run('uiText(answer.error.message)'), 'جملة رفض');
  assert.equal(f.run("uiLoadedChunks.has('ar:providers')"), true);
  assert.equal(f.run("uiCatalogChunks.has('providers')"), true, 'a later language change loads it too');
  assert.equal(f.timers.size, 0);
});
test('when the providers chunk cannot load, the answer shows one Arabic sentence, never the English message, and a retry loads it', async () => {
  const f = answerFixture(() => new Promise(() => {}), 20);
  f.context.answer = f.context.refused();
  f.context.fine = {
    success: true,
    data: {groups: [{diagnostics: [{code: 'X', message: lazySentence, provider: {message: 'Native'}}]}]},
  };
  const start = performance.now();
  await f.run('uiEnsureAnswerChunks(answer)');
  assert.ok(performance.now() - start < 1000, 'the 15 second bound, here shortened, ends the wait');
  assert.deepEqual(f.delays, [15000], 'the read is bounded at 15 seconds like every chunk');
  assert.equal(f.requests[0].args.signal.aborted, true);
  assert.equal(f.timers.size, 0);
  const sentence = shellMessages[fallbackKey];
  assert.match(sentence, /[؀-ۿ]/u);
  assert.equal(f.context.answer.error.message, sentence);
  assert.equal(f.context.answer.error.next_action, undefined, 'the same sentence is not said twice');
  assert.equal(f.run('uiText(answer.error.message)'), sentence);
  // A 200 answer is not turned into an error: its data is kept and its diagnostic says the same sentence.
  f.setFetcher(() => new Promise(() => {}));
  await f.run('uiEnsureAnswerChunks(fine)');
  const diagnostic = f.context.fine.data.groups[0].diagnostics[0];
  assert.equal(diagnostic.message, sentence);
  assert.equal(diagnostic.provider.message, 'Native', 'a provider’s own message stays as it was');
  assert.equal(f.run('uiOwnedError(fine.data.groups[0].diagnostics[0]).message'), 'Native');
  assert.equal(f.run('uiOwnedError(fine.data.groups[0].diagnostics[0]).nextAction'), sentence);
  // The failed read is not cached: the next answer fetches the chunk again and shows its Arabic.
  f.setFetcher(async () => new Response(JSON.stringify({[lazySentence]: 'جملة رفض'})));
  f.context.later = f.context.refused();
  await f.run('uiEnsureAnswerChunks(later)');
  assert.equal(f.run('uiText(later.error.message)'), 'جملة رفض');
});
test('after a deploy the providers chunk answers 409 and only a reload can help', async () => {
  const f = answerFixture(async () => new Response('ASSET_VERSION_CHANGED', {status: 409}));
  f.context.answer = f.context.refused();
  await assert.rejects(f.run('uiEnsureAnswerChunks(answer)'), error => error.code === 'PAGE_ASSET_RELOAD_REQUIRED');
  assert.equal(
    f.context.answer.error.message,
    lazySentence,
    'the answer is left as it was: the page offers the reload',
  );
});
test('positive chunks reset the consecutive-empty bound without reducing the byte or time bound', async () => {
  const bytes = Buffer.from('{"Home":"الرئيسية"}');
  let offset = 0,
    empty = 0,
    pulls = 0;
  const body = new ReadableStream(
    {
      pull: controller => {
        pulls++;
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        if (empty++ < 64) {
          controller.enqueue(new Uint8Array());
          return;
        }
        empty = 0;
        controller.enqueue(bytes.subarray(offset, ++offset));
      },
    },
    {highWaterMark: 0},
  );
  const f = fixture(async () => new Response(body));
  assert.equal((await f.run("uiCatalog('ar')")).get('Home'), 'الرئيسية');
  assert.ok(pulls > 64);
  assert.equal(body.locked, false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.signals[0].maximum, 1);
  assert.equal(f.signals[0].active, 0);
});
