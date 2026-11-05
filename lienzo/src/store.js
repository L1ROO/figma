// Guarda los documentos en memoria y los persiste:
// - Si existe DATABASE_URL -> Postgres (recomendado en Render, no se borra al reiniciar)
// - Si no -> archivos JSON en DATA_DIR (en Render gratis se borran en cada deploy/reinicio)

import fs from 'node:fs/promises';
import path from 'node:path';
import { createEmptyDocument } from './doc.js';

const docs = new Map();
const dirty = new Set();
const kv = new Map();        // datos chicos: cuentas, sesiones, configuración
const dirtyKv = new Set();
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
    await pool.query('CREATE TABLE IF NOT EXISTS lienzo_kv (k TEXT PRIMARY KEY, v JSONB NOT NULL)');
    const { rows } = await pool.query('SELECT data FROM lienzo_docs');
    for (const r of rows) docs.set(r.data.id, r.data);
    const kvRows = await pool.query('SELECT k, v FROM lienzo_kv');
    for (const r of kvRows.rows) kv.set(r.k, r.v);
    console.log(`[store] Postgres: ${docs.size} documentos cargados`);
  } else {
    await fs.mkdir(DATA_DIR, { recursive: true });
    for (const f of await fs.readdir(DATA_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(await fs.readFile(path.join(DATA_DIR, f), 'utf8'));
        if (f.startsWith('_')) kv.set(f.slice(1, -5), d);
        else docs.set(d.id, d);
      } catch (e) { console.warn('[store] archivo inválido', f); }
    }
    console.log(`[store] Archivos en ${DATA_DIR}: ${docs.size} documentos cargados`);
  }
  setInterval(flush, 1500).unref();
}

export function listDocs(ownerId) {
  return [...docs.values()]
    .filter((d) => d.ownerId === ownerId)
    .map((d) => ({ id: d.id, name: d.name, updatedAt: d.updatedAt, nodeCount: Object.keys(d.nodes).length, firstPageId: d.nodes[d.rootId].children[0] }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// Si se pasa ownerId, solo devuelve el documento si es de esa cuenta
export function getDoc(id, ownerId) {
  const d = docs.get(id);
  if (!d || (ownerId !== undefined && d.ownerId !== ownerId)) throw new Error(`No existe el documento ${id}. Usá list_documents para ver los ids.`);
  return d;
}

export function addDoc(name, ownerId) {
  const d = createEmptyDocument(name);
  d.ownerId = ownerId;
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

// Los diseños creados antes de que existieran las cuentas pasan a la primera cuenta
export function claimOrphanDocs(ownerId) {
  let n = 0;
  for (const d of docs.values()) {
    if (!d.ownerId) { d.ownerId = ownerId; dirty.add(d.id); n++; }
  }
  return n;
}

export function kvGet(key, fallback) {
  return kv.has(key) ? kv.get(key) : fallback;
}

export function kvSet(key, value) {
  kv.set(key, value);
  dirtyKv.add(key);
}

export function markDirty(id) {
  const d = docs.get(id);
  if (d) d.updatedAt = new Date().toISOString();
  dirty.add(id);
}

let flushing = false;
export async function flush() {
  if (flushing || (dirty.size === 0 && dirtyKv.size === 0)) return;
  flushing = true;
  const ids = [...dirty];
  dirty.clear();
  const keys = [...dirtyKv];
  dirtyKv.clear();
  try {
    for (const k of keys) {
      if (pool) {
        await pool.query('INSERT INTO lienzo_kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [k, JSON.stringify(kv.get(k))]);
      } else {
        const file = path.join(DATA_DIR, `_${k}.json`);
        await fs.writeFile(file + '.tmp', JSON.stringify(kv.get(k)));
        await fs.rename(file + '.tmp', file);
      }
    }
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
    for (const k of keys) dirtyKv.add(k);
  } finally {
    flushing = false;
  }
}
