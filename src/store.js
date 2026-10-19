// Guarda los documentos en memoria y los persiste:
// - Si existe DATABASE_URL -> Postgres (recomendado en Render, no se borra al reiniciar)
// - Si no -> archivos JSON en DATA_DIR (en Render gratis se borran en cada deploy/reinicio)

import fs from 'node:fs/promises';
import path from 'node:path';
import { createEmptyDocument } from './doc.js';

const docs = new Map();
const dirty = new Set();
let pool = null;
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');

export async function initStore() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS lienzo_docs (
      id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await pool.query('SELECT data FROM lienzo_docs');
    for (const r of rows) docs.set(r.data.id, r.data);
    console.log(`[store] Postgres: ${docs.size} documentos cargados`);
  } else {
    await fs.mkdir(DATA_DIR, { recursive: true });
    for (const f of await fs.readdir(DATA_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(await fs.readFile(path.join(DATA_DIR, f), 'utf8'));
        docs.set(d.id, d);
      } catch (e) { console.warn('[store] archivo inválido', f); }
    }
    console.log(`[store] Archivos en ${DATA_DIR}: ${docs.size} documentos cargados`);
  }
  if (docs.size === 0) {
    const d = createEmptyDocument('Mi primer diseño');
    docs.set(d.id, d);
    markDirty(d.id);
  }
  setInterval(flush, 1500).unref();
}

export function listDocs() {
  return [...docs.values()]
    .map((d) => ({ id: d.id, name: d.name, updatedAt: d.updatedAt, nodeCount: Object.keys(d.nodes).length, firstPageId: d.nodes[d.rootId].children[0] }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getDoc(id) {
  const d = docs.get(id);
  if (!d) throw new Error(`No existe el documento ${id}. Usá list_documents para ver los ids.`);
  return d;
}

export function addDoc(name) {
  const d = createEmptyDocument(name);
  docs.set(d.id, d);
  markDirty(d.id);
  return d;
}

export async function removeDoc(id) {
  docs.delete(id);
  dirty.delete(id);
  if (pool) await pool.query('DELETE FROM lienzo_docs WHERE id=$1', [id]);
  else await fs.rm(path.join(DATA_DIR, `${id}.json`), { force: true });
}

export function markDirty(id) {
  const d = docs.get(id);
  if (d) d.updatedAt = new Date().toISOString();
  dirty.add(id);
}

let flushing = false;
export async function flush() {
  if (flushing || dirty.size === 0) return;
  flushing = true;
  const ids = [...dirty];
  dirty.clear();
  try {
    for (const id of ids) {
      const d = docs.get(id);
      if (!d) continue;
      if (pool) {
        await pool.query(
          `INSERT INTO lienzo_docs (id, data, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [id, d],
        );
      } else {
        const file = path.join(DATA_DIR, `${id}.json`);
        await fs.writeFile(file + '.tmp', JSON.stringify(d));
        await fs.rename(file + '.tmp', file);
      }
    }
  } catch (e) {
    console.error('[store] error guardando', e);
    for (const id of ids) dirty.add(id);
  } finally {
    flushing = false;
  }
}
