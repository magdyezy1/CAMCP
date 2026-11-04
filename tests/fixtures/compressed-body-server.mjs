// Isolated Express process: a late decoder error must never terminate the application under test.
import express from 'express';
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
const server = app.listen(0, '127.0.0.1', () => process.send({event: 'ready', port: server.address().port}));
process.on('message', message => {
  if (message !== 'stop') return;
  server.close(() => process.disconnect());
  server.closeAllConnections();
});
