import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { initStore, listDocs, getDoc, addDoc, removeDoc, flush } from './src/store.js';
import { subscribe, unsubscribe, commit } from './src/hub.js';
import { mountMcp } from './src/mcp.js';
import { nodeToSvg } from './src/render.js';
import {
  initAccounts, signup, login, logout, accountFromSession, accountFromMcpKey,
  regenerateMcpKey, isBlocked, registerFailure, AuthError,
} from './src/accounts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

await initStore();
initAccounts();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));

// --- MCP (una URL por cuenta) ---
mountMcp(app, accountFromMcpKey);

// --- Cuentas ---
function sessionToken(req) {
  return req.get('x-session') || req.query.s || '';
}
function auth(req, res, next) {
  const a = accountFromSession(sessionToken(req));
  if (!a) return res.status(401).json({ error: 'Sesión vencida. Volvé a entrar.' });
  req.account = a;
  next();
}
async function authRoute(fn, req, res) {
  if (isBlocked(req.ip)) return res.status(429).json({ error: 'Demasiados intentos fallidos. Esperá 15 minutos.' });
  try {
    res.json(await fn(String(req.body?.password ?? '')));
  } catch (e) {
    if (e instanceof AuthError) { registerFailure(req.ip); return res.status(400).json({ error: e.message }); }
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
}
app.post('/api/signup', (req, res) => authRoute(signup, req, res));
app.post('/api/login', (req, res) => authRoute(login, req, res));
app.post('/api/logout', (req, res) => { logout(sessionToken(req)); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ mcpKey: req.account.mcpKey }));
app.post('/api/me/mcp-key', auth, (req, res) => res.json({ mcpKey: regenerateMcpKey(req.account.id) }));

app.get('/health', (req, res) => res.json({ ok: true }));

// --- Diseños (siempre de la cuenta que pide) ---
app.get('/api/docs', auth, (req, res) => res.json(listDocs(req.account.id)));
app.post('/api/docs', auth, (req, res) => {
  const d = addDoc(String(req.body?.name || 'Sin título'), req.account.id);
  res.json({ id: d.id, name: d.name });
});
app.get('/api/docs/:id', auth, (req, res) => {
  try { res.json(getDoc(req.params.id, req.account.id)); } catch (e) { res.status(404).json({ error: e.message }); }
});
app.delete('/api/docs/:id', auth, async (req, res) => {
  try { getDoc(req.params.id, req.account.id); } catch (e) { return res.status(404).json({ error: e.message }); }
  await removeDoc(req.params.id);
  res.json({ ok: true });
});
app.get('/api/docs/:id/svg/:nodeId', auth, async (req, res) => {
  try {
    const { svg } = await nodeToSvg(getDoc(req.params.id, req.account.id), req.params.nodeId);
    res.type('image/svg+xml').send(svg);
  } catch (e) { res.status(404).json({ error: e.message }); }
});

// Exportación para el plugin de Figma: usa la clave MCP de la cuenta (no vence) y CORS abierto,
// porque el plugin corre en otro origen.
app.get('/api/export/:key/:id', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const a = accountFromMcpKey(req.params.key);
  if (!a) return res.status(401).json({ error: 'Link inválido' });
  try { res.json(getDoc(req.params.id, a.id)); } catch (e) { res.status(404).json({ error: e.message }); }
});

app.get('/shared/doc.js', (req, res) => res.type('text/javascript').sendFile(path.join(__dirname, 'src', 'doc.js')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const server = http.createServer(app);

// --- WebSocket para edición en vivo ---
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const account = accountFromSession(url.searchParams.get('s'));
  if (!account) {
    ws.close(4001, 'Sesión vencida');
    return;
  }
  const owner = account.id;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.t === 'join') {
        const d = getDoc(msg.docId, owner);
        unsubscribe(ws);
        subscribe(msg.docId, ws);
        ws.send(JSON.stringify({ t: 'doc', doc: d }));
      } else if (msg.t === 'ops') {
        commit(msg.docId, msg.ops, msg.origin || 'web', owner);
      }
    } catch (e) {
      ws.send(JSON.stringify({ t: 'error', message: e.message, notFound: /No existe el documento/.test(e.message) }));
      // Re-sincronizar al cliente para que no quede desfasado
      try { if (msg.docId) ws.send(JSON.stringify({ t: 'doc', doc: getDoc(msg.docId, owner) })); } catch {}
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
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await flush();
    process.exit(0);
  });
}
