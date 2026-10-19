import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { initStore, listDocs, getDoc, addDoc, removeDoc, flush } from './src/store.js';
import { subscribe, unsubscribe, commit } from './src/hub.js';
import { mountMcp } from './src/mcp.js';
import { nodeToSvg } from './src/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.ACCESS_TOKEN || '';

await initStore();

const app = express();
app.use(express.json({ limit: '25mb' }));

// --- MCP ---
const mcpPath = mountMcp(app, TOKEN);

// --- Auth para la web y la API ---
function auth(req, res, next) {
  if (!TOKEN) return next();
  const t = req.get('x-access-token') || req.query.token;
  if (t === TOKEN) return next();
  res.status(401).json({ error: 'Token incorrecto' });
}

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) => res.json({ needsToken: Boolean(TOKEN) }));
app.get('/api/check', auth, (req, res) => res.json({ ok: true, mcpPath }));

app.get('/api/docs', auth, (req, res) => res.json(listDocs()));
app.post('/api/docs', auth, (req, res) => {
  const d = addDoc(String(req.body?.name || 'Sin título'));
  res.json({ id: d.id, name: d.name });
});
app.get('/api/docs/:id', auth, (req, res) => {
  try { res.json(getDoc(req.params.id)); } catch (e) { res.status(404).json({ error: e.message }); }
});
app.delete('/api/docs/:id', auth, async (req, res) => {
  await removeDoc(req.params.id);
  res.json({ ok: true });
});
// Exportación para el plugin de Figma (el plugin corre en otro origen, por eso CORS abierto)
app.options('/api/docs/:id/export', (req, res) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'x-access-token, content-type' }).sendStatus(204);
});
app.get('/api/docs/:id/export', (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); }, auth, (req, res) => {
  try { res.json(getDoc(req.params.id)); } catch (e) { res.status(404).json({ error: e.message }); }
});
app.get('/api/docs/:id/svg/:nodeId', auth, async (req, res) => {
  try {
    const { svg } = await nodeToSvg(getDoc(req.params.id), req.params.nodeId);
    res.type('image/svg+xml').send(svg);
  } catch (e) { res.status(404).json({ error: e.message }); }
});

app.get('/shared/doc.js', (req, res) => res.type('text/javascript').sendFile(path.join(__dirname, 'src', 'doc.js')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const server = http.createServer(app);

// --- WebSocket para edición en vivo ---
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  if (TOKEN && url.searchParams.get('token') !== TOKEN) {
    ws.close(4001, 'Token incorrecto');
    return;
  }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.t === 'join') {
        unsubscribe(ws);
        subscribe(msg.docId, ws);
        ws.send(JSON.stringify({ t: 'doc', doc: getDoc(msg.docId) }));
      } else if (msg.t === 'ops') {
        commit(msg.docId, msg.ops, msg.origin || 'web');
      }
    } catch (e) {
      ws.send(JSON.stringify({ t: 'error', message: e.message }));
      // Re-sincronizar al cliente para que no quede desfasado
      try { if (msg.docId) ws.send(JSON.stringify({ t: 'doc', doc: getDoc(msg.docId) })); } catch {}
    }
  });
  ws.on('close', () => unsubscribe(ws));
});

// Mantener vivas las conexiones (Render corta conexiones inactivas)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000).unref();

server.listen(PORT, () => {
  console.log(`Lienzo escuchando en http://localhost:${PORT}`);
  console.log(`MCP en ${mcpPath}${TOKEN ? '' : '  (⚠ sin ACCESS_TOKEN: cualquiera con la URL puede editar)'}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await flush();
    process.exit(0);
  });
}

