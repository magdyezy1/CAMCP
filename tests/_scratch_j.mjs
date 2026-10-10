import {evaluationFixture, metaConnection, otherConnection} from './journeys/harness.mjs';
const f = await evaluationFixture();
const show = (label, r) => console.log(label, JSON.stringify(r).slice(0, Number(process.env.N ?? 900)));
for (const raw of process.argv.slice(2)) {
  const [tool, args] = JSON.parse(raw.replaceAll('META', metaConnection).replaceAll('OTHER', otherConnection));
  show(tool + ' ' + (args.action ?? ''), await f.call(tool, args));
}
console.log(JSON.stringify(f.transcript.map(t => [t.tool, t.action, t.success, t.code, t.state, t.bytes, t.provider_requests, t.next_call, t.next_step, t.website_path])));
await f.close();
