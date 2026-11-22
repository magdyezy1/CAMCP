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
// R25 ar-lazy, R25 ar-answers: an answer that carries a sentence of a lazy chunk (`providers`, the providers' refusals, or
// `answers`, what only an error shows) waits for both (web/route-assets.js: uiEnsureAnswerChunks) through the same bounded,
// coalesced read as every other chunk, and when they cannot load shows one fixed Arabic sentence in place of the English message.
const shellMessages = JSON.parse(fs.readFileSync('web/locales/ar/shell.json', 'utf8')),
  fallbackKey = 'The details of this message could not be loaded. Try again.',
  lazySentence = 'A refusal sentence only the providers chunk has.',
  remedySentence = 'A remedy only the answers chunk has.',
  chunkBody = url =>
    JSON.stringify(url.endsWith('/answers.json') ? {[remedySentence]: 'علاج فقط'} : {[lazySentence]: 'جملة رفض'});
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
  // A refusal whose message is a providers sentence and whose next step is an answers sentence.
  f.context.refused = () => ({success: false, error: {code: 'X', message: lazySentence, next_action: remedySentence}});
  return f;
}
test('an answer waits for both lazy chunks through the read a prefetch started, and each chunk is fetched once', async () => {
  const respond = new Map(),
    f = answerFixture(url => new Promise(resolve => respond.set(url.split('/').pop(), resolve)));
  f.context.answer = f.context.refused();
  const prefetch = f.run("uiCatalog('ar', 'providers')"),
    waiting = f.run('uiEnsureAnswerChunks(answer)');
  // The prefetch's read of `providers` is joined; only `answers` is a new request.
  assert.deepEqual(
    f.requests.map(request => request.url),
    ['/assets/locales/ar/providers.json', '/assets/locales/ar/answers.json'],
  );
  for (const [file, resolve] of respond) resolve(new Response(chunkBody('/' + file)));
  await Promise.all([prefetch, waiting]);
  assert.equal(f.requests.length, 2, 'the answer and the prefetch share the request for providers');
  assert.equal(f.run('uiText(answer.error.message)'), 'جملة رفض');
  assert.equal(f.run('uiText(answer.error.next_action)'), 'علاج فقط');
  assert.equal(f.run("uiLoadedChunks.has('ar:providers') && uiLoadedChunks.has('ar:answers')"), true);
  assert.equal(
    f.run("uiCatalogChunks.has('providers') && uiCatalogChunks.has('answers')"),
    true,
    'a later language change loads them too',
  );
  assert.equal(f.timers.size, 0);
  // A later answer asks for nothing.
  f.context.later = f.context.refused();
  await f.run('uiEnsureAnswerChunks(later)');
  assert.equal(f.requests.length, 2);
});
test('when the lazy chunks cannot load, the answer shows one Arabic sentence, never the English message, and a retry loads them', async () => {
  const f = answerFixture(() => new Promise(() => {}), 20);
  f.context.answer = f.context.refused();
  f.context.fine = {
    success: true,
    data: {groups: [{diagnostics: [{code: 'X', message: lazySentence, provider: {message: 'Native'}}]}]},
  };
  const start = performance.now();
  await f.run('uiEnsureAnswerChunks(answer)');
  assert.ok(performance.now() - start < 1000, 'the 15 second bound, here shortened, ends the wait');
  assert.deepEqual(f.delays, [15000, 15000], 'each read is bounded at 15 seconds like every chunk');
  // Each read ends at its own bound, and the wait when the last of them has; a moment more for the timers of the VM to be gone.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(
    f.requests.map(request => request.args.signal.aborted),
    [true, true],
  );
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
  // The failed reads are not cached: once both have ended, the next answer fetches the chunks again and shows their Arabic.
  await new Promise(resolve => setTimeout(resolve, 100));
  f.setFetcher(async url => new Response(chunkBody(url)));
  f.context.later = f.context.refused();
  await f.run('uiEnsureAnswerChunks(later)');
  assert.equal(f.run('uiText(later.error.message)'), 'جملة رفض');
  assert.equal(f.run('uiText(later.error.next_action)'), 'علاج فقط');
});
test('one lazy chunk that never arrives ends the wait at its own 15 second bound, whichever it is; the chunk that arrived stays, and a retry fetches only the other', async () => {
  for (const [hung, fine] of [
    ['answers.json', 'providers.json'],
    ['providers.json', 'answers.json'],
  ]) {
    const f = answerFixture(
      url => (url.endsWith(hung) ? new Promise(() => {}) : Promise.resolve(new Response(chunkBody(url)))),
      20,
    );
    f.context.answer = f.context.refused();
    await f.run('uiEnsureAnswerChunks(answer)');
    // Lead review S3-1: each chunk is settled on its own, and a field gives way only when its own sentence is not loaded. The refusal's
    // message is a providers sentence and its next step an answers sentence.
    assert.equal(
      f.run('uiLoadedChunks.has("ar:' + fine.replace('.json', '') + '")'),
      true,
      fine + ' arrived and is kept',
    );
    if (hung === 'answers.json') {
      assert.equal(f.run('uiText(answer.error.message)'), 'جملة رفض', 'the message arrived');
      assert.equal(f.context.answer.error.next_action, shellMessages[fallbackKey], 'the next step gives way');
    } else {
      assert.equal(f.context.answer.error.message, shellMessages[fallbackKey], 'the message gives way');
      assert.equal(f.run('uiText(answer.error.next_action)'), 'علاج فقط', 'the next step arrived');
    }
    assert.equal(f.context.answer.error.server_message, lazySentence, 'the server’s exact text is kept');
    assert.equal(f.context.answer.error.server_next_action, remedySentence);
    assert.equal(f.run('uiChunksReady(answerLocaleChunks)'), false);
    assert.equal(f.timers.size, 0);
    const before = f.requests.length;
    f.setFetcher(async url => new Response(chunkBody(url)));
    f.context.later = f.context.refused();
    await f.run('uiEnsureAnswerChunks(later)');
    assert.deepEqual(
      f.requests.slice(before).map(request => request.url),
      ['/assets/locales/ar/' + hung],
      'the chunk that arrived is not fetched again',
    );
    assert.equal(f.run('uiText(later.error.message)'), 'جملة رفض', fine + ' stayed in the catalogue');
    assert.equal(f.run('uiText(later.error.next_action)'), 'علاج فقط');
  }
});
test('an answer gives way field by field: a message whose own sentence is loaded stays, and only a remedy or next step that is not loaded is replaced', () => {
  // Lead review S3-1. The error-shaped objects of an answer, each with the sentences that are loaded (L) and those that are not (U).
  const f = answerFixture(() => new Promise(() => {})),
    fixed = shellMessages[fallbackKey],
    [L1, L2, U1, U2] = ['Loaded one.', 'Loaded two.', 'Unloaded one.', 'Unloaded two.'];
  f.context.catalog = new Map([...Object.entries(shellMessages), [L1, 'محمّلة ١'], [L2, 'محمّلة ٢']]);
  f.run("uiUseMessages('ar', catalog, ['shell'])");
  const gives = input => {
    f.context.answer = {success: false, error: structuredClone(input)};
    f.run('uiAnswerWithoutUnloaded(answer)');
    const {server_message, server_next_action, ...error} = JSON.parse(JSON.stringify(f.context.answer.error));
    return {error, server_message, server_next_action};
  };
  const provider = {message: 'Native text'};
  for (const [name, input, expected] of [
    [
      'message loaded, next step not',
      {code: 'X', message: L1, next_action: U1},
      {code: 'X', message: L1, next_action: fixed},
    ],
    [
      'message not loaded, next step loaded',
      {code: 'X', message: U1, next_action: L2},
      {code: 'X', message: fixed, next_action: L2},
    ],
    [
      'neither loaded: the sentence once, as the message',
      {code: 'X', message: U1, next_action: U2},
      {code: 'X', message: fixed},
    ],
    [
      'both loaded: nothing changes',
      {code: 'X', message: L1, next_action: L2},
      {code: 'X', message: L1, next_action: L2},
    ],
    [
      'message loaded, remedy action not',
      {code: 'X', message: L1, remedy: {category: 'r', action: U1}},
      {code: 'X', message: L1, remedy: {category: 'r'}, next_action: fixed},
    ],
    [
      'message and next step loaded, remedy action not: the loaded next step stays',
      {code: 'X', message: L1, next_action: L2, remedy: {category: 'r', action: U1}},
      {code: 'X', message: L1, next_action: L2, remedy: {category: 'r'}},
    ],
    [
      'message loaded, details next step not',
      {code: 'X', message: L1, details: {next_action: U1, field: 'f'}},
      {code: 'X', message: L1, details: {field: 'f'}, next_action: fixed},
    ],
    [
      'template loaded: the rendered message stays with its template',
      {code: 'X', message: 'Rendered with 5', message_localization: {key: L1, values: {n: 5}}, next_action: U1},
      {code: 'X', message: 'Rendered with 5', message_localization: {key: L1, values: {n: 5}}, next_action: fixed},
    ],
    [
      'template not loaded: the message gives way and takes its template with it',
      {code: 'X', message: 'Rendered with 5', message_localization: {key: U1, values: {n: 5}}, next_action: U2},
      {code: 'X', message: fixed},
    ],
    [
      'a provider’s own message with its explanation loaded: the explanation stays, the next step gives way',
      {code: 'X', message: 'Native text', provider, message_localization: {key: L1}, next_action: U1},
      {code: 'X', message: 'Native text', provider, message_localization: {key: L1}, next_action: fixed},
    ],
    [
      'a provider’s own message with its explanation not loaded: the sentence is the explanation',
      {code: 'X', message: 'Native text', provider, message_localization: {key: U1}},
      {code: 'X', message: fixed, provider, next_action: fixed},
    ],
    ['no message, next step not loaded', {code: 'X', next_action: U1}, {code: 'X', next_action: fixed}],
    ['no message, template not loaded', {code: 'X', message_localization: {key: U1}}, {code: 'X', next_action: fixed}],
    [
      'an object with no code or remedy: its message is no sentence the page reads, so it stays',
      {message: 'Dynamic text', details: {next_action: U1}},
      {message: 'Dynamic text', details: {}, next_action: fixed},
    ],
    ['the base of a split message', {base: U1, suffix: 'a suffix'}, {}],
  ]) {
    assert.deepEqual(gives(input).error, expected, name);
  }
  // Technical details: what gave way is kept, as it was sent.
  const kept = gives({code: 'X', message: L1, remedy: {category: 'r', action: U1}});
  assert.equal(kept.server_next_action, U1);
  assert.equal(gives({code: 'X', message: U1, next_action: L2}).server_message, U1);
  // An answer whose sentences are all loaded is left exactly as it was.
  assert.equal(gives({code: 'X', message: L1, next_action: L2}).server_message, undefined);
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
test('after a deploy a successful answer is kept whole, with the fixed sentence, and only an error answer throws for the reload', async () => {
  // Lead review S3-3: the second argument says the answer succeeded; the next asset load offers the reload anyway.
  const f = answerFixture(async () => new Response('ASSET_VERSION_CHANGED', {status: 409}));
  f.context.fine = {success: true, data: {saved: true, groups: [{diagnostics: [{code: 'X', message: lazySentence}]}]}};
  await f.run('uiEnsureAnswerChunks(fine, true)');
  const diagnostic = f.context.fine.data.groups[0].diagnostics[0];
  assert.equal(f.context.fine.data.saved, true);
  assert.equal(diagnostic.message, shellMessages[fallbackKey]);
  assert.equal(diagnostic.server_message, lazySentence);
  f.context.answer = f.context.refused();
  await assert.rejects(f.run('uiEnsureAnswerChunks(answer)'), error => error.code === 'PAGE_ASSET_RELOAD_REQUIRED');
  await assert.rejects(
    f.run('uiEnsureAnswerChunks(answer, false)'),
    error => error.code === 'PAGE_ASSET_RELOAD_REQUIRED',
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
