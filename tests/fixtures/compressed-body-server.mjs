// Isolated Express process: a late decoder error must never terminate the application under test.
import express from 'express';
import {listenForFetch} from '../../dist/tests/http-listener.js';
const app = express();
app.use(express.json({limit: '4mb'}));
app.post('/immediate', (req, res) => res.json({received: req.body.message}));
app.post('/probe', (req, res) => {
  process.send({event: 'parsed', body: req.body});
  const finish = () => res.json({received: req.body.message});
  if (req.complete) finish();
  else req.once('end', finish);
});
app.get('/health', (_req, res) => res.json({alive: true}));
// The tests reach it through fetch (its health check), so an OS-chosen port that Fetch forbids is released and asked again
// (tests/http-listener.ts). The parent sends nothing before it hears ready, so the message handler is in place by then.
const server = await listenForFetch(app);
process.on('message', message => {
  if (message !== 'stop') return;
  server.close(() => process.disconnect());
  server.closeAllConnections();
});
process.send({event: 'ready', port: server.address().port});
