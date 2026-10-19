// Punto único donde se aplican cambios. Lo usan tanto la web (WebSocket) como el MCP,
// así lo que Claude edita aparece en vivo en el navegador y viceversa.

import { applyOp } from './doc.js';
import { getDoc, markDirty } from './store.js';

const subscribers = new Map(); // docId -> Set<ws>

export function subscribe(docId, ws) {
  if (!subscribers.has(docId)) subscribers.set(docId, new Set());
  subscribers.get(docId).add(ws);
}

export function unsubscribe(ws) {
  for (const set of subscribers.values()) set.delete(ws);
}

export function broadcast(docId, msg, exceptWs = null) {
  const set = subscribers.get(docId);
  if (!set) return;
  const data = JSON.stringify(msg);
  for (const ws of set) if (ws !== exceptWs && ws.readyState === 1) ws.send(data);
}

// Aplica una lista de operaciones. Si una falla, se detiene y reporta el error,
// pero las anteriores quedan aplicadas (y se transmiten igual).
export function commit(docId, ops, origin = 'server') {
  const doc = getDoc(docId);
  const applied = [];
  let error = null;
  for (const op of ops) {
    try {
      applied.push(applyOp(doc, op));
    } catch (e) {
      error = e;
      break;
    }
  }
  if (applied.length) {
    markDirty(docId);
    broadcast(docId, { t: 'ops', docId, ops: applied, origin });
  }
  if (error) {
    error.applied = applied;
    throw error;
  }
  return applied;
}
