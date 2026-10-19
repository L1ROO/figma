import { applyOp, toSpec, newId, CONTAINER_TYPES, absolutePosition } from '/shared/doc.js';
import { importSvg, loadSvgFonts } from '/import-svg.js';

// ============================================================
// Utilidades
// ============================================================
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round = (n) => Math.round(n * 100) / 100;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

const state = {
  token: store.get('lienzo-token') || '',
  doc: null, docId: null, pageId: null,
  selection: [],
  cam: { x: 0, y: 0, z: 1 },
  tool: 'select',
  undo: [], redo: [],
  expanded: new Set(),
  editingText: null,
  hover: null,
  guides: [],
  createPreview: null,
  marquee: null,
  spaceDown: false,
};
const clientId = newId();
const doc = () => state.doc;
const N = (id) => state.doc?.nodes[id];

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'x-access-token': state.token, ...(opts.headers || {}) } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

const mcpUrl = () => `${location.origin}/mcp${state.token ? '/' + encodeURIComponent(state.token) : ''}`;

// ============================================================
// Arranque, login y lista de diseños
// ============================================================
async function boot() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  if (cfg.needsToken) {
    const ok = state.token && (await api('/api/check').then(() => true).catch(() => false));
    if (!ok) return showLogin();
  }
  const id = new URLSearchParams(location.search).get('doc');
  if (id) openEditor(id); else showHome();
}

function showScreen(name) {
  for (const s of ['login', 'home', 'editor']) $('#' + s).hidden = s !== name;
}

function showLogin() {
  showScreen('login');
  $('#tokenInput').focus();
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    state.token = $('#tokenInput').value.trim();
    const ok = await api('/api/check').then(() => true).catch(() => false);
    if (!ok) { $('#loginError').hidden = false; return; }
    store.set('lienzo-token', state.token);
    boot();
  };
}

async function showHome() {
  showScreen('home');
  document.title = 'Lienzo';
  $('#mcpUrlHome').textContent = mcpUrl();
  const list = $('#docList');
  const docs = await api('/api/docs');
  list.innerHTML = docs.map((d) => `
    <li>
      <a href="/?doc=${d.id}">
        <div class="doc-thumb"><img loading="lazy" alt="" src="/api/docs/${d.id}/svg/${d.firstPageId}?token=${encodeURIComponent(state.token)}&v=${encodeURIComponent(d.updatedAt)}"></div>
        <div class="doc-meta">
          <div><strong>${esc(d.name)}</strong><span>${new Date(d.updatedAt).toLocaleString()}</span></div>
          <button data-del="${d.id}" title="Borrar diseño" aria-label="Borrar ${esc(d.name)}"><svg viewBox="0 0 20 20" width="16" height="16"><path d="M4 6h12M8 6V4h4v2m-6 0 1 10h6l1-10" /></svg></button>
        </div>
      </a>
    </li>`).join('') || '<p class="hint">Todavía no hay diseños. Creá el primero.</p>';
  list.onclick = async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    e.preventDefault();
    if (!confirm('¿Borrar este diseño? No se puede deshacer.')) return;
    await api('/api/docs/' + b.dataset.del, { method: 'DELETE' });
    showHome();
  };
  $('#newDocBtn').onclick = async () => {
    const name = prompt('Nombre del diseño', 'Sin título');
    if (name === null) return;
    const d = await api('/api/docs', { method: 'POST', body: JSON.stringify({ name }) });
    location.href = '/?doc=' + d.id;
  };
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard?.writeText($('#' + b.dataset.copy).textContent).then(() => toast('Copiado'));
});

// ============================================================
// Conexión en tiempo real
// ============================================================
let ws = null;
let pending = [];
let firstLoad = true;
let retry = 0;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  ws.onopen = () => {
    retry = 0;
    if (pending.length) {
      ws.send(JSON.stringify({ t: 'ops', docId: state.docId, ops: pending, origin: clientId }));
      pending = [];
    }
    ws.send(JSON.stringify({ t: 'join', docId: state.docId }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'doc') onFullDoc(msg.doc);
    else if (msg.t === 'ops') onRemoteOps(msg);
    else if (msg.t === 'error') toast(msg.message);
  };
  ws.onclose = (ev) => {
    if (ev.code === 4001) { store.set('lienzo-token', ''); location.reload(); return; }
    setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
  };
}

function send(ops) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'ops', docId: state.docId, ops, origin: clientId }));
  else pending.push(...ops);
}

function onFullDoc(d) {
  state.doc = d;
  if (!N(state.pageId) || N(state.pageId).type !== 'PAGE') state.pageId = d.nodes[d.rootId].children[0];
  pruneSelection();
  document.title = `${d.name} · Lienzo`;
  $('#docName').value = d.name;
  invalidate(...ALL);
  if (firstLoad) { firstLoad = false; requestAnimationFrame(() => zoomToFit()); }
}

let liveTimer = 0;
function onRemoteOps(msg) {
  if (msg.origin === clientId || !state.doc) return;
  for (const op of msg.ops) {
    try { applyOp(state.doc, op); } catch (e) { console.warn('op remota', e); }
  }
  if (!N(state.pageId)) state.pageId = N(state.doc.rootId).children[0];
  pruneSelection();
  $('#docName').value = state.doc.name;
  invalidate(...ALL);
  if (msg.origin === 'mcp') {
    const b = $('#liveBadge');
    b.textContent = 'Claude está editando';
    b.hidden = false;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { b.hidden = true; }, 4000);
  }
}

function pruneSelection() {
  state.selection = state.selection.filter((id) => N(id) && pageOfNode(id) === state.pageId);
}

// ============================================================
// Operaciones con deshacer / rehacer
// ============================================================
function assignIds(spec) {
  if (!spec.id) spec.id = newId();
  (spec.children || []).forEach(assignIds);
  return spec;
}

function invertOp(op) {
  const d = state.doc;
  switch (op.op) {
    case 'create': return [{ op: 'delete', id: op.node.id }];
    case 'createPage': return [{ op: 'delete', id: op.id }];
    case 'update': {
      const n = d.nodes[op.id];
      if (!n) throw new Error('El nodo ya no existe');
      const prev = {};
      for (const k of Object.keys(op.props)) prev[k] = n[k] === undefined ? null : n[k];
      return [{ op: 'update', id: op.id, props: prev }];
    }
    case 'delete': {
      const n = d.nodes[op.id];
      if (!n) throw new Error('El nodo ya no existe');
      const parent = d.nodes[n.parentId];
      return [{ op: 'create', parentId: n.parentId, index: parent.children.indexOf(op.id), node: toSpec(d, op.id) }];
    }
    case 'move': {
      const n = d.nodes[op.id];
      const parent = d.nodes[n.parentId];
      return [{ op: 'move', id: op.id, parentId: n.parentId, index: parent.children.indexOf(op.id) }];
    }
    default: return [];
  }
}

function performRaw(ops) {
  const applied = [];
  const inverse = [];
  for (const op of ops) {
    if (op.op === 'create') assignIds(op.node);
    if (op.op === 'createPage' && !op.id) op.id = newId();
    try {
      const inv = invertOp(op);
      applyOp(state.doc, op);
      applied.push(op);
      inverse.unshift(...inv);
    } catch (e) {
      toast(e.message);
      break;
    }
  }
  if (applied.length) send(applied);
  return { applied, inverse };
}

function perform(ops, { history = true } = {}) {
  const { applied, inverse } = performRaw(ops);
  if (!applied.length) return false;
  if (history) {
    state.undo.push({ ops: applied, inverse, sel: [...state.selection] });
    if (state.undo.length > 300) state.undo.shift();
    state.redo = [];
  }
  pruneSelection();
  invalidate(...ALL);
  return true;
}

function undo() {
  const e = state.undo.pop();
  if (!e) return;
  const { applied, inverse } = performRaw(e.inverse);
  state.redo.push({ ops: applied, inverse, sel: e.sel });
  state.selection = e.sel;
  pruneSelection();
  invalidate(...ALL);
}

function redo() {
  const e = state.redo.pop();
  if (!e) return;
  const { applied, inverse } = performRaw(e.inverse);
  state.undo.push({ ops: applied, inverse, sel: e.sel });
  pruneSelection();
  invalidate(...ALL);
}

// ============================================================
// Geometría
// ============================================================
function pageOfNode(id) {
  let n = N(id);
  while (n && n.type !== 'PAGE') n = N(n.parentId);
  return n?.id;
}
function absRect(id) {
  const n = N(id);
  const p = absolutePosition(state.doc, id);
  return { x: p.x, y: p.y, w: n.width || 0, h: n.height || 0 };
}
function parentOrigin(parentId) {
  const p = N(parentId);
  return !p || p.type === 'PAGE' ? { x: 0, y: 0 } : absolutePosition(state.doc, parentId);
}
function bbox(rects) {
  if (!rects.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) { x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h); }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const viewportEl = () => $('#viewport');
function toWorld(clientX, clientY) {
  const r = viewportEl().getBoundingClientRect();
  return { x: (clientX - r.left - state.cam.x) / state.cam.z, y: (clientY - r.top - state.cam.y) / state.cam.z };
}
function toScreen(x, y) {
  return { x: x * state.cam.z + state.cam.x, y: y * state.cam.z + state.cam.y };
}
function pathTo(id) {
  const p = [];
  let n = N(id);
  while (n && n.type !== 'PAGE') { p.unshift(n.id); n = N(n.parentId); }
  return p;
}
function isAncestor(ancId, id) {
  let n = N(id);
  while (n) { if (n.id === ancId) return true; n = N(n.parentId); }
  return false;
}
// Frame más profundo bajo un punto (para soltar o crear adentro)
function frameAt(wx, wy, exclude = new Set()) {
  const visit = (ids, ox, oy) => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const n = N(ids[i]);
      if (!n || exclude.has(n.id) || n.visible === false || !CONTAINER_TYPES.has(n.type)) continue;
      const ax = ox + n.x, ay = oy + n.y;
      if (wx >= ax && wx <= ax + n.width && wy >= ay && wy <= ay + n.height) {
        const deeper = visit(n.children || [], ax, ay);
        if (deeper) return deeper;
        if (n.type === 'FRAME' && !n.locked) return n.id;
      }
    }
    return null;
  };
  return visit(N(state.pageId).children, 0, 0) || state.pageId;
}

// ============================================================
// Render del lienzo
// ============================================================
const ALL = ['world', 'overlay', 'layers', 'props', 'pages'];
const dirty = {};
let raf = 0;
function invalidate(...parts) {
  for (const p of parts) dirty[p] = true;
  if (!raf) raf = requestAnimationFrame(flushRender);
}
function flushRender() {
  raf = 0;
  if (!state.doc) return;
  if (dirty.world) renderWorld();
  if (dirty.world || dirty.overlay) { applyCamera(); renderOverlay(); renderLabels(); }
  if (dirty.pages) renderPages();
  if (dirty.layers) renderLayers();
  if (dirty.props) renderProps();
  for (const k of Object.keys(dirty)) dirty[k] = false;
}

const els = new Map();
const fontsLoaded = new Set(['Inter', 'Instrument Sans', 'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'system-ui', 'sans-serif', 'serif', 'monospace']);
function ensureFont(f) {
  if (!f || fontsLoaded.has(f)) return;
  fontsLoaded.add(f);
  const fam = encodeURIComponent(f).replace(/%20/g, '+');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${fam}:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400&display=swap`;
  link.onerror = () => { link.onerror = null; link.href = `https://fonts.googleapis.com/css2?family=${fam}&display=swap`; };
  document.head.append(link);
}

const isGradient = (v) => typeof v === 'string' && v.includes('gradient');

function nodeCss(n) {
  const c = [`left:${n.x}px`, `top:${n.y}px`, `width:${n.width}px`, `height:${n.height}px`];
  if (n.rotation) c.push(`transform:rotate(${n.rotation}deg)`);
  if (n.opacity !== undefined && n.opacity < 1) c.push(`opacity:${n.opacity}`);
  if (n.visible === false) c.push('display:none');
  const shadows = [];
  if (n.shadow) shadows.push(n.shadow);
  if (n.type === 'TEXT') {
    ensureFont(n.fontFamily);
    c.push(`font-family:"${n.fontFamily}",Inter,sans-serif`, `font-size:${n.fontSize}px`, `font-weight:${n.fontWeight}`,
      `line-height:${n.lineHeight}`, `letter-spacing:${n.letterSpacing || 0}px`, `text-align:${n.textAlign}`,
      `justify-content:${{ top: 'flex-start', middle: 'center', bottom: 'flex-end' }[n.verticalAlign] || 'flex-start'}`);
    if (n.italic) c.push('font-style:italic');
    if (n.underline) c.push('text-decoration:underline');
    if (isGradient(n.fill)) c.push(`background:${n.fill}`, '-webkit-background-clip:text', 'background-clip:text', 'color:transparent');
    else c.push(`color:${n.fill || 'transparent'}`);
  } else if (n.type !== 'LINE') {
    if (n.fill) c.push(`background:${n.fill}`);
    if (n.stroke) shadows.push(`inset 0 0 0 ${n.strokeWidth}px ${n.stroke}`);
    if (n.type === 'ELLIPSE') c.push('border-radius:50%');
    else if (n.cornerRadius) c.push(`border-radius:${n.cornerRadius}px`);
    if (n.clipsContent) c.push('overflow:hidden');
    if (n.type === 'IMAGE') {
      if (n.src) c.push(`background-image:url("${String(n.src).replace(/"/g, '%22')}")`, `background-size:${n.fit === 'contain' ? 'contain' : n.fit === 'fill' ? '100% 100%' : 'cover'}`);
      if (n.fill) c.push(`background-color:${n.fill}`);
    }
  }
  if (shadows.length) c.push(`box-shadow:${shadows.join(',')}`);
  return c.join(';');
}

function styleNode(el, n) {
  const cls = `node t-${n.type}${n.type === 'IMAGE' && !n.src ? ' empty' : ''}${state.editingText === n.id ? ' editing' : ''}`;
  if (el.className !== cls) el.className = cls;
  const css = nodeCss(n);
  if (el._css !== css) { el.style.cssText = css; el._css = css; }
  if (n.type === 'TEXT') {
    let tx = el._tx;
    if (!tx) { tx = document.createElement('div'); tx.className = 'tx'; el.prepend(tx); el._tx = tx; }
    if (state.editingText !== n.id && tx.textContent !== n.text) tx.textContent = n.text;
  } else if (n.type === 'LINE') {
    const key = `${n.width},${n.height},${n.stroke},${n.strokeWidth}`;
    if (el._line !== key) {
      el._line = key;
      el.innerHTML = `<svg width="${Math.max(1, Math.abs(n.width))}" height="${Math.max(1, Math.abs(n.height))}"><line x1="0" y1="0" x2="${n.width}" y2="${n.height}" stroke="${esc(n.stroke || '#000')}" stroke-width="${n.strokeWidth}" stroke-linecap="round" /></svg>`;
    }
  }
}

function renderWorld() {
  const page = N(state.pageId);
  viewportEl().style.background = page.background || '';
  const seen = new Set();
  syncChildren($('#world'), page.children, seen);
  for (const [id, el] of els) if (!seen.has(id)) { el.remove(); els.delete(id); }
}

function syncChildren(parentEl, ids, seen) {
  let prev = null;
  for (const id of ids) {
    const n = N(id);
    if (!n) continue;
    let el = els.get(id);
    if (!el) { el = document.createElement('div'); el.dataset.id = id; els.set(id, el); }
    seen.add(id);
    styleNode(el, n);
    const expected = prev ? prev.nextSibling : (parentEl._tx ? parentEl._tx.nextSibling : parentEl.firstChild);
    if (el.parentNode !== parentEl || el !== expected) parentEl.insertBefore(el, expected);
    if (n.children) syncChildren(el, n.children, seen);
    prev = el;
  }
}

function applyCamera() {
  const { x, y, z } = state.cam;
  $('#world').style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  $('#zoomBtn').textContent = Math.round(z * 100) + '%';
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
function renderOverlay() {
  const parts = [];
  const z = state.cam.z;
  const rectScreen = (r) => { const p = toScreen(r.x, r.y); return { x: p.x, y: p.y, w: r.w * z, h: r.h * z }; };

  if (state.hover && !state.selection.includes(state.hover) && N(state.hover)) {
    const n = N(state.hover);
    const r = rectScreen(absRect(state.hover));
    const rot = n.rotation ? ` transform="rotate(${n.rotation} ${r.x + r.w / 2} ${r.y + r.h / 2})"` : '';
    parts.push(n.type === 'ELLIPSE' ? `<ellipse class="ov-hover" cx="${r.x + r.w / 2}" cy="${r.y + r.h / 2}" rx="${r.w / 2}" ry="${r.h / 2}"${rot}/>` : `<rect class="ov-hover" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"${rot}/>`);
  }

  const sel = state.selection.filter((id) => N(id));
  for (const id of sel) {
    const n = N(id);
    const r = rectScreen(absRect(id));
    const rot = n.rotation ? ` transform="rotate(${n.rotation} ${r.x + r.w / 2} ${r.y + r.h / 2})"` : '';
    parts.push(`<rect class="ov-sel" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"${rot}/>`);
  }
  const box = bbox(sel.map(absRect));
  if (box && state.editingText === null) {
    const r = rectScreen(box);
    if (sel.length > 1) parts.push(`<rect class="ov-sel" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`);
    const single = sel.length === 1 ? N(sel[0]) : null;
    if (single && !single.rotation && !single.locked) {
      const pts = { nw: [0, 0], n: [.5, 0], ne: [1, 0], e: [1, .5], se: [1, 1], s: [.5, 1], sw: [0, 1], w: [0, .5] };
      const showEdges = r.w > 30 && r.h > 30;
      for (const h of HANDLES) {
        if (h.length === 1 && !showEdges) continue;
        const [px, py] = pts[h];
        const cursor = { nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew' }[h];
        parts.push(`<rect class="ov-handle" data-handle="${h}" x="${r.x + r.w * px - 4}" y="${r.y + r.h * py - 4}" width="8" height="8" style="cursor:${cursor}-resize"/>`);
      }
    }
  }
  if (state.marquee) {
    const r = rectScreen(state.marquee);
    parts.push(`<rect class="ov-marquee" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`);
  }
  if (state.createPreview) {
    const r = rectScreen(state.createPreview);
    parts.push(`<rect class="ov-sel" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`);
  }
  for (const g of state.guides) {
    const a = toScreen(g.x1, g.y1), b = toScreen(g.x2, g.y2);
    parts.push(`<line class="ov-guide" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`);
  }
  $('#overlay').innerHTML = parts.join('');
}

function renderLabels() {
  const page = N(state.pageId);
  const out = [];
  for (const id of page.children) {
    const n = N(id);
    if (!n || n.type !== 'FRAME' || n.visible === false) continue;
    const p = toScreen(n.x, n.y);
    out.push(`<div class="frame-label${state.selection.includes(id) ? ' selected' : ''}" data-frame="${id}" style="left:${p.x}px;top:${p.y}px;max-width:${Math.max(40, n.width * state.cam.z)}px">${esc(n.name)}</div>`);
  }
  const box = bbox(state.selection.filter((id) => N(id)).map(absRect));
  if (box && !state.editingText) {
    const p = toScreen(box.x + box.w / 2, box.y + box.h);
    out.push(`<div class="size-tag" style="left:${p.x}px;top:${p.y + 6}px">${round(box.w)} × ${round(box.h)}</div>`);
  }
  $('#labels').innerHTML = out.join('');
}

// ============================================================
// Cámara
// ============================================================
function zoomAt(sx, sy, z) {
  const nz = clamp(z, 0.02, 64);
  const wx = (sx - state.cam.x) / state.cam.z, wy = (sy - state.cam.y) / state.cam.z;
  state.cam = { x: sx - wx * nz, y: sy - wy * nz, z: nz };
  invalidate('overlay');
}
function zoomToRect(r, maxZ = 2) {
  const v = viewportEl().getBoundingClientRect();
  if (!r || r.w <= 0 && r.h <= 0) { state.cam = { x: v.width / 2, y: v.height / 2, z: 1 }; invalidate('overlay'); return; }
  const pad = 60;
  const z = clamp(Math.min((v.width - pad * 2) / Math.max(r.w, 1), (v.height - pad * 2) / Math.max(r.h, 1)), 0.02, maxZ);
  state.cam = { z, x: v.width / 2 - (r.x + r.w / 2) * z, y: v.height / 2 - (r.y + r.h / 2) * z };
  invalidate('overlay');
}
function zoomToFit() {
  zoomToRect(bbox(N(state.pageId).children.map((id) => N(id)).filter((n) => n && n.visible !== false).map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height }))), 1);
}
function zoomToSelection() {
  const b = bbox(state.selection.map(absRect));
  if (b) zoomToRect(b, 4);
}

// ============================================================
// Selección
// ============================================================
function select(ids) {
  state.selection = [...new Set(ids)].filter((id) => N(id));
  dirty.scrollLayer = true;
  for (const id of state.selection) {
    let p = N(N(id).parentId);
    while (p && p.type !== 'PAGE') { state.expanded.add(p.id); p = N(p.parentId); }
  }
  invalidate('overlay', 'layers', 'props');
}

// Qué nodo seleccionar al hacer clic sobre el nodo más profundo `deepId`.
function pickFromHit(deepId, deep) {
  let path = pathTo(deepId);
  const li = path.findIndex((id) => N(id).locked);
  if (li === 0) return null;
  if (li > 0) path = path.slice(0, li);
  if (deep) return path[path.length - 1];
  const sel = N(state.selection[0]);
  if (sel) {
    const k = path.indexOf(sel.parentId);
    if (k >= 0 && path[k + 1]) return path[k + 1];
  }
  const top = N(path[0]);
  if (top.type === 'FRAME' && path.length > 1) return path[1];
  return path[0];
}

// ============================================================
// Interacción con el puntero
// ============================================================
let drag = null;
const pointers = new Map();
const vp = viewportEl();

function hitNode(target) {
  const el = target.closest?.('.node');
  return el && $('#world').contains(el) ? el.dataset.id : null;
}

vp.addEventListener('pointerdown', (e) => {
  if (state.editingText) {
    const el = els.get(state.editingText);
    if (el && el.contains(e.target)) return;
    el?._tx?.blur();
  }
  vp.focus({ preventScroll: true });
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    if (drag?.type === 'move') for (const id of drag.ids) Object.assign(N(id), drag.orig.get(id));
    if (drag?.type === 'resize') Object.assign(N(drag.id), { x: drag.orig.x, y: drag.orig.y, width: drag.orig.w, height: drag.orig.h });
    state.guides = [];
    const [a, b] = [...pointers.values()];
    drag = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cam0: { ...state.cam } };
    state.marquee = null; state.createPreview = null;
    return;
  }
  vp.setPointerCapture(e.pointerId);
  const w = toWorld(e.clientX, e.clientY);
  const start = { sx: e.clientX, sy: e.clientY, wx: w.x, wy: w.y };

  if (e.button === 1 || state.spaceDown || state.tool === 'hand') {
    drag = { type: 'pan', ...start, cam0: { ...state.cam } };
    vp.classList.add('panning');
    return;
  }
  if (e.button !== 0) return;

  if (['FRAME', 'RECTANGLE', 'ELLIPSE', 'TEXT', 'LINE'].includes(state.tool)) {
    drag = { type: 'create', kind: state.tool, ...start, parentId: frameAt(w.x, w.y) };
    return;
  }
  if (state.tool === 'IMAGE') {
    pickImage({ x: w.x, y: w.y });
    setTool('select');
    return;
  }

  // Herramienta mover/seleccionar
  const handle = e.target.dataset?.handle;
  if (handle && state.selection.length === 1) {
    const n = N(state.selection[0]);
    drag = { type: 'resize', handle, ...start, id: n.id, orig: { x: n.x, y: n.y, w: n.width, h: n.height } };
    return;
  }

  const labelFrame = e.target.closest?.('[data-frame]')?.dataset.frame;
  const deepId = labelFrame || hitNode(e.target);
  if (!deepId) {
    if (!e.shiftKey) select([]);
    drag = { type: 'marquee', ...start, scope: state.pageId, base: e.shiftKey ? [...state.selection] : [] };
    return;
  }
  const deep = e.ctrlKey || e.metaKey;
  const cand = labelFrame || pickFromHit(deepId, deep);
  if (!cand) {
    if (!e.shiftKey) select([]);
    drag = { type: 'marquee', ...start, scope: state.pageId, base: [] };
    return;
  }
  if (e.shiftKey) {
    select(state.selection.includes(cand) ? state.selection.filter((id) => id !== cand) : [...state.selection, cand]);
    drag = { type: 'pending-move', ...start };
    return;
  }
  // Si ya hay un contenedor seleccionado que contiene el clic, se arrastra ese contenedor
  // (salvo frames de primer nivel: sus hijos se eligen directo, como en Figma)
  const selAnc = !deep && state.selection.find((id) => isAncestor(id, deepId) &&
    !(id !== deepId && N(id).type === 'FRAME' && N(id).parentId === state.pageId));
  const candNode = N(cand);
  // Frame de primer nivel con contenido: arrastrar sobre su fondo hace selección por área
  if (!selAnc && !labelFrame && cand === deepId && candNode.type === 'FRAME' && candNode.parentId === state.pageId && candNode.children.length) {
    drag = { type: 'frame-bg', ...start, frameId: cand };
    return;
  }
  if (selAnc) {
    drag = { type: 'pending-move', ...start, diveFrom: selAnc, deepId };
  } else {
    select([cand]);
    drag = { type: 'pending-move', ...start };
  }
});

function beginMove(d) {
  const ids = state.selection.filter((id) => N(id) && !N(id).locked);
  if (!ids.length) return null;
  const orig = new Map(ids.map((id) => [id, { x: N(id).x, y: N(id).y }]));
  const box = bbox(ids.map(absRect));
  // Destinos para alinear (hermanos + padre)
  const parentId = N(ids[0]).parentId;
  const exclude = new Set(ids);
  const targets = [];
  for (const sid of N(parentId).children) {
    if (exclude.has(sid) || N(sid).visible === false) continue;
    targets.push(absRect(sid));
    if (targets.length > 300) break;
  }
  if (N(parentId).type !== 'PAGE') targets.push(absRect(parentId));
  return { ...d, type: 'move', ids, orig, box, targets, exclude };
}

function snapMove(d, dx, dy) {
  const th = 6 / state.cam.z;
  const b = d.box;
  let bestX = null, bestY = null;
  const xs = [b.x + dx, b.x + dx + b.w / 2, b.x + dx + b.w];
  const ys = [b.y + dy, b.y + dy + b.h / 2, b.y + dy + b.h];
  for (const t of d.targets) {
    for (const tx of [t.x, t.x + t.w / 2, t.x + t.w]) for (const x of xs) {
      const diff = tx - x;
      if (Math.abs(diff) < th && (!bestX || Math.abs(diff) < Math.abs(bestX.diff))) bestX = { diff, at: tx, t };
    }
    for (const ty of [t.y, t.y + t.h / 2, t.y + t.h]) for (const y of ys) {
      const diff = ty - y;
      if (Math.abs(diff) < th && (!bestY || Math.abs(diff) < Math.abs(bestY.diff))) bestY = { diff, at: ty, t };
    }
  }
  state.guides = [];
  if (bestX) {
    dx += bestX.diff;
    const y1 = Math.min(b.y + dy, bestX.t.y), y2 = Math.max(b.y + dy + b.h, bestX.t.y + bestX.t.h);
    state.guides.push({ x1: bestX.at, y1, x2: bestX.at, y2 });
  }
  if (bestY) {
    dy += bestY.diff;
    const x1 = Math.min(b.x + dx, bestY.t.x), x2 = Math.max(b.x + dx + b.w, bestY.t.x + bestY.t.w);
    state.guides.push({ x1, y1: bestY.at, x2, y2: bestY.at });
  }
  return { dx, dy };
}

vp.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!drag) {
    if (state.tool === 'select' && e.pointerType === 'mouse') {
      const deepId = hitNode(e.target);
      const h = deepId ? pickFromHit(deepId, e.ctrlKey || e.metaKey) : null;
      if (h !== state.hover) { state.hover = h; invalidate('overlay'); }
    }
    return;
  }
  const w = toWorld(e.clientX, e.clientY);
  const moved = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 3;

  switch (drag.type) {
    case 'pinch': {
      const [a, b] = [...pointers.values()];
      if (!b) return;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const r = vp.getBoundingClientRect();
      const z = clamp(drag.cam0.z * d / drag.d0, 0.02, 64);
      const wx = (drag.m0.x - r.left - drag.cam0.x) / drag.cam0.z;
      const wy = (drag.m0.y - r.top - drag.cam0.y) / drag.cam0.z;
      state.cam = { z, x: m.x - r.left - wx * z, y: m.y - r.top - wy * z };
      invalidate('overlay');
      return;
    }
    case 'pan':
      state.cam.x = drag.cam0.x + (e.clientX - drag.sx);
      state.cam.y = drag.cam0.y + (e.clientY - drag.sy);
      invalidate('overlay');
      return;
    case 'pending-move':
      if (!moved) return;
      drag = beginMove(drag);
      if (!drag) return;
      state.hover = null;
      // fallthrough
    case 'move': {
      let dx = w.x - drag.wx, dy = w.y - drag.wy;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      ({ dx, dy } = snapMove(drag, dx, dy));
      for (const id of drag.ids) {
        const o = drag.orig.get(id);
        N(id).x = Math.round(o.x + dx);
        N(id).y = Math.round(o.y + dy);
      }
      drag.last = { dx, dy, wx: w.x, wy: w.y };
      invalidate('world');
      return;
    }
    case 'resize': {
      const n = N(drag.id);
      const o = drag.orig;
      let dx = w.x - drag.wx, dy = w.y - drag.wy;
      let x = o.x, y = o.y, wd = o.w, ht = o.h;
      const hd = drag.handle;
      if (hd.includes('e')) wd = o.w + dx;
      if (hd.includes('w')) { wd = o.w - dx; x = o.x + dx; }
      if (hd.includes('s')) ht = o.h + dy;
      if (hd.includes('n')) { ht = o.h - dy; y = o.y + dy; }
      if (e.shiftKey && o.w && o.h) {
        const ratio = o.w / o.h;
        if (hd.length === 2) { if (Math.abs(wd / o.w) > Math.abs(ht / o.h)) ht = wd / ratio; else wd = ht * ratio; }
        else if (hd === 'e' || hd === 'w') ht = wd / ratio; else wd = ht * ratio;
        if (hd.includes('n')) y = o.y + o.h - ht;
        if (hd.includes('w')) x = o.x + o.w - wd;
      }
      if (e.altKey) { x = o.x - (wd - o.w) / 2; y = o.y - (ht - o.h) / 2; }
      if (n.type === 'LINE') { n.x = Math.round(x); n.y = Math.round(y); n.width = Math.round(wd); n.height = Math.round(ht); }
      else {
        if (wd < 0) { x += wd; wd = -wd; }
        if (ht < 0) { y += ht; ht = -ht; }
        n.x = Math.round(x); n.y = Math.round(y); n.width = Math.max(1, Math.round(wd)); n.height = Math.max(1, Math.round(ht));
      }
      drag.changed = true;
      invalidate('world');
      return;
    }
    case 'frame-bg':
      if (!moved) return;
      select([]);
      drag = { ...drag, type: 'marquee', scope: drag.frameId, base: [] };
      // fallthrough
    case 'marquee': {
      const r = { x: Math.min(drag.wx, w.x), y: Math.min(drag.wy, w.y), w: Math.abs(w.x - drag.wx), h: Math.abs(w.y - drag.wy) };
      state.marquee = r;
      const hits = N(drag.scope).children.filter((id) => { const n = N(id); return n.visible !== false && !n.locked && intersects(absRect(id), r); });
      state.selection = [...new Set([...drag.base, ...hits])];
      invalidate('overlay', 'layers', 'props');
      return;
    }
    case 'create': {
      if (!moved) return;
      let x2 = w.x, y2 = w.y;
      if (e.shiftKey && drag.kind !== 'LINE') {
        const s = Math.max(Math.abs(x2 - drag.wx), Math.abs(y2 - drag.wy));
        x2 = drag.wx + Math.sign(x2 - drag.wx || 1) * s; y2 = drag.wy + Math.sign(y2 - drag.wy || 1) * s;
      }
      drag.end = { x: x2, y: y2 };
      state.createPreview = { x: Math.min(drag.wx, x2), y: Math.min(drag.wy, y2), w: Math.abs(x2 - drag.wx), h: Math.abs(y2 - drag.wy) };
      invalidate('overlay');
    }
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  vp.classList.remove('panning');
  if (!drag) return;
  const d = drag;
  if (d.type === 'pinch') { if (pointers.size < 2) drag = null; return; }
  drag = null;
  state.guides = [];

  if (d.type === 'move') {
    const ops = [];
    const last = d.last;
    // Deshacer el preview local y aplicar operaciones reales (con historial)
    for (const id of d.ids) { const o = d.orig.get(id); N(id).x = o.x; N(id).y = o.y; }
    if (!last) return invalidate('world', 'overlay');
    const parentId = N(d.ids[0]).parentId;
    const sameParent = d.ids.every((id) => N(id).parentId === parentId);
    const exclude = new Set(d.ids);
    const parentType = N(parentId).type;
    const target = sameParent && parentType !== 'GROUP' ? frameAt(last.wx, last.wy, exclude) : null;
    if (target && target !== parentId && ![...exclude].some((id) => isAncestor(id, target))) {
      const po = parentOrigin(target);
      for (const id of d.ids) {
        const a = absolutePosition(state.doc, id);
        ops.push({ op: 'move', id, parentId: target });
        ops.push({ op: 'update', id, props: { x: Math.round(a.x + last.dx - po.x), y: Math.round(a.y + last.dy - po.y) } });
      }
    } else {
      for (const id of d.ids) { const o = d.orig.get(id); ops.push({ op: 'update', id, props: { x: Math.round(o.x + last.dx), y: Math.round(o.y + last.dy) } }); }
    }
    perform(ops);
    return;
  }
  if (d.type === 'pending-move') {
    if (d.diveFrom) {
      const path = pathTo(d.deepId);
      const i = path.indexOf(d.diveFrom);
      const next = path[i + 1];
      if (next && !N(next).locked) select([next]);
    }
    return;
  }
  if (d.type === 'frame-bg') { select([d.frameId]); return; }
  if (d.type === 'resize') {
    const n = N(d.id);
    const props = { x: n.x, y: n.y, width: n.width, height: n.height };
    Object.assign(n, { x: d.orig.x, y: d.orig.y, width: d.orig.w, height: d.orig.h });
    if (d.changed) perform([{ op: 'update', id: d.id, props }]);
    return;
  }
  if (d.type === 'marquee') { state.marquee = null; invalidate('overlay', 'layers', 'props'); return; }
  if (d.type === 'create') {
    state.createPreview = null;
    createFromDrag(d);
    return;
  }
}
vp.addEventListener('pointerup', endPointer);
vp.addEventListener('pointercancel', endPointer);
vp.addEventListener('pointerleave', () => { if (state.hover) { state.hover = null; invalidate('overlay'); } });

function createFromDrag(d) {
  const kind = d.kind;
  const po = parentOrigin(d.parentId);
  let x, y, w, h;
  if (d.end) {
    if (kind === 'LINE') { x = d.wx; y = d.wy; w = d.end.x - d.wx; h = d.end.y - d.wy; }
    else { x = Math.min(d.wx, d.end.x); y = Math.min(d.wy, d.end.y); w = Math.abs(d.end.x - d.wx); h = Math.abs(d.end.y - d.wy); }
  } else {
    const def = { FRAME: [400, 300], RECTANGLE: [100, 100], ELLIPSE: [100, 100], TEXT: [240, 22], LINE: [120, 0] }[kind];
    [w, h] = def;
    x = kind === 'TEXT' || kind === 'LINE' ? d.wx : d.wx - w / 2;
    y = kind === 'TEXT' || kind === 'LINE' ? d.wy : d.wy - h / 2;
  }
  const spec = { type: kind, x: Math.round(x - po.x), y: Math.round(y - po.y), width: Math.round(w), height: Math.round(h) };
  if (kind === 'TEXT') { spec.text = ''; spec.height = Math.max(22, spec.height); }
  if (kind === 'FRAME' && d.parentId !== state.pageId) spec.fill = '#FFFFFF';
  const op = { op: 'create', parentId: d.parentId, node: spec };
  perform([op]);
  setTool('select');
  select([spec.id]);
  if (kind === 'TEXT') requestAnimationFrame(() => { flushRender(); startTextEdit(spec.id, true); });
}

vp.addEventListener('dblclick', (e) => {
  if (state.tool !== 'select') return;
  const label = e.target.closest?.('[data-frame]');
  if (label) {
    const id = label.dataset.frame;
    const name = prompt('Nombre del frame', N(id).name);
    if (name && name.trim()) perform([{ op: 'update', id, props: { name: name.trim() } }]);
    return;
  }
  const deepId = hitNode(e.target);
  if (!deepId) return;
  const sel = state.selection[0];
  if (sel && N(sel)?.type === 'TEXT' && isAncestor(sel, deepId)) { startTextEdit(sel); return; }
  const path = pathTo(deepId);
  const i = sel ? path.indexOf(sel) : -1;
  const next = i >= 0 ? path[i + 1] : pickFromHit(deepId);
  if (!next || N(next).locked) return;
  select([next]);
  if (N(next).type === 'TEXT') startTextEdit(next);
});

vp.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const r = vp.getBoundingClientRect();
    const delta = clamp(e.deltaY, -40, 40);
    zoomAt(e.clientX - r.left, e.clientY - r.top, state.cam.z * Math.exp(-delta * 0.01));
  } else {
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    state.cam.x -= dx; state.cam.y -= dy;
    invalidate('overlay');
  }
}, { passive: false });

window.addEventListener('resize', () => invalidate('overlay'));

// ============================================================
// Edición de texto
// ============================================================
function startTextEdit(id, isNew = false) {
  const n = N(id);
  const el = els.get(id);
  if (!n || !el || n.locked) return;
  const tx = el._tx;
  state.editingText = id;
  el.classList.add('editing');
  try { tx.contentEditable = 'plaintext-only'; } catch { tx.contentEditable = 'true'; }
  if (tx.contentEditable !== 'plaintext-only') tx.contentEditable = 'true';
  tx.focus();
  const range = document.createRange();
  range.selectNodeContents(tx);
  const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  invalidate('overlay');
  const original = n.text;
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') tx.blur();
  };
  tx.addEventListener('keydown', onKey);
  tx.addEventListener('blur', () => {
    tx.removeEventListener('keydown', onKey);
    tx.contentEditable = 'false';
    el.classList.remove('editing');
    state.editingText = null;
    getSelection()?.removeAllRanges();
    const text = tx.innerText.replace(/\n$/, '');
    if (!text.trim()) {
      tx.textContent = original;
      if (isNew || !original) {
        perform([{ op: 'delete', id }], { history: !isNew });
        if (isNew) state.undo.pop();
      }
      invalidate(...ALL);
      return;
    }
    if (text !== original) {
      const props = { text };
      const hNeeded = Math.ceil(tx.offsetHeight);
      if (hNeeded > n.height) props.height = hNeeded;
      perform([{ op: 'update', id, props }]);
    }
    invalidate(...ALL);
  }, { once: true });
}

// ============================================================
// Herramientas y teclado
// ============================================================
function setTool(t) {
  state.tool = t;
  for (const b of document.querySelectorAll('#tools button')) b.classList.toggle('active', b.dataset.tool === t);
  vp.classList.toggle('tool-hand', t === 'hand');
  vp.classList.toggle('tool-create', !['select', 'hand'].includes(t));
}
$('#tools').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]');
  if (!b) return;
  if (b.dataset.tool === 'IMAGE') { pickImage(null); return; }
  setTool(b.dataset.tool);
});

const isTyping = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

document.addEventListener('keydown', (e) => {
  if ($('#editor').hidden || !state.doc) return;
  if (isTyping(e.target)) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();

  if (e.key === ' ' && !state.spaceDown) { state.spaceDown = true; vp.classList.add('panning'); e.preventDefault(); return; }
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'd') { e.preventDefault(); duplicateSelection(); return; }
  if (mod && k === 'a') { e.preventDefault(); selectAll(); return; }
  if (mod && k === 'g') { e.preventDefault(); e.shiftKey ? ungroup() : groupSelection(e.altKey ? 'FRAME' : 'GROUP'); return; }
  if (mod && (e.key === ']' || e.key === '[')) { e.preventDefault(); reorder(e.key === ']' ? 1 : -1, e.shiftKey); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); const r = vp.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, state.cam.z * 1.25); return; }
  if (mod && k === '-') { e.preventDefault(); const r = vp.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, state.cam.z / 1.25); return; }
  if (mod && k === '0') { e.preventDefault(); const r = vp.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1); return; }
  if (e.shiftKey && e.code === 'Digit1') { e.preventDefault(); zoomToFit(); return; }
  if (e.shiftKey && e.code === 'Digit2') { e.preventDefault(); zoomToSelection(); return; }
  if (e.shiftKey && k === 'h') { e.preventDefault(); toggleProp('visible'); return; }
  if (mod && e.shiftKey && k === 'l') { e.preventDefault(); toggleProp('locked'); return; }
  if (mod) return;

  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
  if (e.key === 'Escape') {
    if (state.tool !== 'select') return setTool('select');
    const first = N(state.selection[0]);
    select(first && first.parentId !== state.pageId ? [first.parentId] : []);
    return;
  }
  if (e.key === 'Enter') {
    const n = N(state.selection[0]);
    if (n?.type === 'TEXT') { e.preventDefault(); startTextEdit(n.id); }
    else if (n?.children?.length) { e.preventDefault(); select(e.shiftKey ? [n.parentId] : n.children); }
    return;
  }
  if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    const ops = state.selection.filter((id) => !N(id).locked).map((id) => ({ op: 'update', id, props: { x: N(id).x + dx, y: N(id).y + dy } }));
    if (ops.length) perform(ops);
    return;
  }
  const tools = { v: 'select', h: 'hand', f: 'FRAME', a: 'FRAME', r: 'RECTANGLE', o: 'ELLIPSE', l: 'LINE', t: 'TEXT' };
  if (tools[k] && !e.shiftKey) { setTool(tools[k]); return; }
  if (k === 'i' && !e.shiftKey) pickImage(null);
});
document.addEventListener('keyup', (e) => {
  if (e.key === ' ') { state.spaceDown = false; vp.classList.remove('panning'); }
});

// ============================================================
// Acciones
// ============================================================
function deleteSelection() {
  const ids = state.selection.filter((id) => N(id) && !N(id).locked);
  // No borrar un hijo si ya se borra el padre
  const top = ids.filter((id) => !ids.some((o) => o !== id && isAncestor(o, id)));
  if (!top.length) return;
  perform(top.map((id) => ({ op: 'delete', id })));
  select([]);
}

function selectAll() {
  const first = N(state.selection[0]);
  const parent = first ? N(first.parentId) : N(state.pageId);
  select(parent.children.filter((id) => !N(id).locked && N(id).visible !== false));
}

function duplicateSelection() {
  const ids = state.selection.filter((id) => N(id));
  if (!ids.length) return;
  const ops = ids.map((id) => {
    const n = N(id);
    const spec = toSpec(state.doc, id, false);
    const isTopFrame = n.type === 'FRAME' && n.parentId === state.pageId;
    spec.x = n.x + (isTopFrame ? n.width + 40 : 10);
    spec.y = n.y + (isTopFrame ? 0 : 10);
    const parent = N(n.parentId);
    return { op: 'create', parentId: n.parentId, index: parent.children.indexOf(id) + 1, node: spec };
  });
  perform(ops);
  select(ops.map((o) => o.node.id));
}

function toggleProp(key) {
  const nodes = state.selection.map(N).filter(Boolean);
  if (!nodes.length) return;
  const value = !nodes.every((n) => (key === 'visible' ? n.visible !== false : n.locked));
  perform(nodes.map((n) => ({ op: 'update', id: n.id, props: { [key]: value } })));
}

function sortedSiblings(ids) {
  const parent = N(N(ids[0]).parentId);
  return [...ids].sort((a, b) => parent.children.indexOf(a) - parent.children.indexOf(b));
}

function groupSelection(type = 'GROUP') {
  const ids = state.selection.filter((id) => N(id));
  if (!ids.length) return;
  const parentId = N(ids[0]).parentId;
  if (!ids.every((id) => N(id).parentId === parentId)) { toast('Para agrupar, elegí capas del mismo nivel'); return; }
  const sorted = sortedSiblings(ids);
  const rects = sorted.map((id) => { const n = N(id); return { x: n.x, y: n.y, w: n.width, h: n.height }; });
  const b = bbox(rects);
  const parent = N(parentId);
  const gid = newId();
  const ops = [{
    op: 'create', parentId, index: parent.children.indexOf(sorted[sorted.length - 1]) + 1,
    node: { id: gid, type, name: type === 'GROUP' ? 'Grupo' : 'Frame', x: b.x, y: b.y, width: b.w, height: b.h, fill: null, clipsContent: false },
  }];
  for (const id of sorted) {
    const n = N(id);
    ops.push({ op: 'move', id, parentId: gid });
    ops.push({ op: 'update', id, props: { x: n.x - b.x, y: n.y - b.y } });
  }
  perform(ops);
  select([gid]);
}

function ungroup() {
  const groups = state.selection.map(N).filter((n) => n && (n.type === 'GROUP' || n.type === 'FRAME') && n.children.length);
  if (!groups.length) return;
  const ops = [];
  const newSel = [];
  for (const g of groups) {
    const parent = N(g.parentId);
    let index = parent.children.indexOf(g.id);
    for (const cid of [...g.children]) {
      const c = N(cid);
      ops.push({ op: 'move', id: cid, parentId: g.parentId, index: index++ });
      ops.push({ op: 'update', id: cid, props: { x: c.x + g.x, y: c.y + g.y } });
      newSel.push(cid);
    }
    ops.push({ op: 'delete', id: g.id });
  }
  perform(ops);
  select(newSel);
}

function reorder(dir, toEnd) {
  const ids = state.selection.filter((id) => N(id));
  if (!ids.length) return;
  const parent = N(N(ids[0]).parentId);
  if (!ids.every((id) => N(id).parentId === parent.id)) return;
  const sorted = sortedSiblings(ids);
  const ops = [];
  const len = parent.children.length;
  const list = dir > 0 ? [...sorted].reverse() : sorted;
  list.forEach((id, i) => {
    const cur = parent.children.indexOf(id);
    const target = toEnd ? (dir > 0 ? len - 1 - i : i) : clamp(cur + dir, 0, len - 1);
    ops.push({ op: 'move', id, parentId: parent.id, index: target });
  });
  perform(ops);
}

function align(mode) {
  const ids = state.selection.filter((id) => N(id) && !N(id).locked);
  if (!ids.length) return;
  let ref;
  if (ids.length === 1) {
    const p = N(N(ids[0]).parentId);
    if (p.type === 'PAGE') return;
    ref = { x: 0, y: 0, w: p.width, h: p.height };
  } else {
    // Bbox en coordenadas del padre de cada uno (asumimos mismo padre)
    ref = bbox(ids.map((id) => { const n = N(id); return { x: n.x, y: n.y, w: n.width, h: n.height }; }));
  }
  const ops = ids.map((id) => {
    const n = N(id);
    const props = {};
    if (mode === 'left') props.x = ref.x;
    if (mode === 'hcenter') props.x = Math.round(ref.x + (ref.w - n.width) / 2);
    if (mode === 'right') props.x = ref.x + ref.w - n.width;
    if (mode === 'top') props.y = ref.y;
    if (mode === 'vcenter') props.y = Math.round(ref.y + (ref.h - n.height) / 2);
    if (mode === 'bottom') props.y = ref.y + ref.h - n.height;
    return { op: 'update', id, props };
  });
  perform(ops);
}

// Copiar / pegar (funciona entre pestañas y documentos)
const CLIP_MARK = 'lienzo/nodes:';
document.addEventListener('copy', (e) => {
  if ($('#editor').hidden || isTyping(e.target) || !state.selection.length) return;
  const specs = state.selection.filter((id) => N(id)).map((id) => {
    const s = toSpec(state.doc, id, false);
    const a = absolutePosition(state.doc, id);
    return { spec: s, parentId: N(id).parentId, abs: a };
  });
  e.clipboardData.setData('text/plain', CLIP_MARK + JSON.stringify(specs));
  e.preventDefault();
});
document.addEventListener('cut', (e) => {
  if ($('#editor').hidden || isTyping(e.target) || !state.selection.length) return;
  const specs = state.selection.map((id) => ({ spec: toSpec(state.doc, id, false), parentId: N(id).parentId, abs: absolutePosition(state.doc, id) }));
  e.clipboardData.setData('text/plain', CLIP_MARK + JSON.stringify(specs));
  e.preventDefault();
  deleteSelection();
});
document.addEventListener('paste', async (e) => {
  if ($('#editor').hidden || isTyping(e.target) || !state.doc) return;
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/') && !isSvgFile(f));
  if (file) { e.preventDefault(); placeImageFile(file, null); return; }
  const text = e.clipboardData?.getData('text/plain') || '';
  e.preventDefault();
  const sel = N(state.selection[0]);
  const intoFrame = sel && sel.type === 'FRAME' && state.selection.length === 1 ? sel.id : null;
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) { importSvgText(text, 'Pegado'); return; }
  const svgFile = [...(e.clipboardData?.files || [])].find(isSvgFile);
  if (svgFile) { importSvgFile(svgFile); return; }
  if (text.startsWith(CLIP_MARK)) {
    let items;
    try { items = JSON.parse(text.slice(CLIP_MARK.length)); } catch { return; }
    const ops = items.map((it) => {
      let parentId = intoFrame || (N(it.parentId) && pageOfNode(it.parentId) === state.pageId ? it.parentId : state.pageId);
      const po = parentOrigin(parentId);
      const spec = it.spec;
      spec.x = Math.round(it.abs.x - po.x + (parentId === it.parentId ? 16 : 0));
      spec.y = Math.round(it.abs.y - po.y + (parentId === it.parentId ? 16 : 0));
      if (intoFrame) { spec.x = Math.max(0, Math.min(spec.x, N(intoFrame).width - spec.width)); spec.y = Math.max(0, Math.min(spec.y, N(intoFrame).height - spec.height)); }
      return { op: 'create', parentId, node: spec };
    });
    perform(ops);
    select(ops.map((o) => o.node.id));
  } else if (text.trim()) {
    const c = viewCenter();
    const parentId = intoFrame || frameAt(c.x, c.y);
    const po = parentOrigin(parentId);
    const op = { op: 'create', parentId, node: { type: 'TEXT', text, x: Math.round(c.x - po.x - 120), y: Math.round(c.y - po.y), width: 240, height: 22 } };
    perform([op]);
    select([op.node.id]);
  }
});

function viewCenter() {
  const r = vp.getBoundingClientRect();
  return toWorld(r.left + r.width / 2, r.top + r.height / 2);
}

// Imágenes: elegir archivo, pegar o arrastrar al lienzo
let imageTarget = null;
let replaceTarget = null;
function pickImage(at, replaceId = null) {
  imageTarget = at;
  replaceTarget = replaceId;
  $('#fileInput').value = '';
  $('#fileInput').click();
}
$('#fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (replaceTarget && N(replaceTarget)) {
    const id = replaceTarget;
    replaceTarget = null;
    try {
      const { data } = await fileToDataUrl(f);
      perform([{ op: 'update', id, props: { src: data } }]);
    } catch { toast('No se pudo leer esa imagen'); }
    return;
  }
  placeImageFile(f, imageTarget);
});
vp.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
vp.addEventListener('drop', (e) => {
  const files = [...e.dataTransfer.files];
  const svgs = files.filter(isSvgFile);
  if (svgs.length && !e.shiftKey) { e.preventDefault(); svgs.forEach((f) => importSvgFile(f)); return; }
  const f = files.find((x) => x.type.startsWith('image/'));
  if (!f) return;
  e.preventDefault();
  placeImageFile(f, toWorld(e.clientX, e.clientY));
});

// ============================================================
// Importar SVG (por ejemplo, frames exportados desde Figma) como capas editables
// ============================================================
const isSvgFile = (f) => f.type === 'image/svg+xml' || /\.svg$/i.test(f.name);

async function importSvgFile(file) {
  importSvgText(await file.text(), file.name.replace(/\.svg$/i, ''));
}

async function importSvgText(text, name = 'Importado') {
  let frame;
  try {
    toast('Importando…', 1500);
    await loadSvgFonts(text, ensureFont);
    frame = importSvg(text, name);
  } catch (err) {
    toast(err.message || 'No se pudo leer el SVG');
    return;
  }
  // Ubicarlo a la derecha de lo que ya hay en la página
  const page = N(state.pageId);
  const b = bbox(page.children.map(N).filter(Boolean).map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height })));
  frame.x = b ? Math.round(b.x + b.w + 100) : 0;
  frame.y = b ? Math.round(b.y) : 0;
  const op = { op: 'create', parentId: state.pageId, node: frame };
  if (perform([op])) {
    select([frame.id]);
    zoomToSelection();
    let count = 0;
    const walk = (n) => { count++; (n.children || []).forEach(walk); };
    walk(frame);
    toast(`Importado: ${count} capas`);
  }
}
$('#importBtn').addEventListener('click', () => $('#svgInput').click());
$('#svgInput').addEventListener('change', (e) => {
  for (const f of e.target.files) importSvgFile(f);
  e.target.value = '';
});

async function fileToDataUrl(file, maxSide = 1600) {
  const url = URL.createObjectURL(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  let { naturalWidth: w, naturalHeight: h } = img;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  let data;
  if (scale === 1 && file.size < 400_000 && file.type !== 'image/heic') {
    data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
  } else {
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    data = c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.86);
    if (data.length > 2_500_000) data = c.toDataURL('image/jpeg', 0.8);
  }
  URL.revokeObjectURL(url);
  return { data, w, h };
}

async function placeImageFile(file, at) {
  try {
    toast('Subiendo imagen…', 1200);
    const { data, w, h } = await fileToDataUrl(file);
    const s = Math.min(1, 600 / Math.max(w, h));
    const width = Math.round(w * s), height = Math.round(h * s);
    const p = at || viewCenter();
    const parentId = frameAt(p.x, p.y);
    const po = parentOrigin(parentId);
    const op = { op: 'create', parentId, node: { type: 'IMAGE', name: file.name.replace(/\.[^.]+$/, '') || 'Imagen', src: data, x: Math.round(p.x - po.x - width / 2), y: Math.round(p.y - po.y - height / 2), width, height } };
    perform([op]);
    select([op.node.id]);
  } catch {
    toast('No se pudo leer esa imagen');
  }
}

// ============================================================
// Panel izquierdo: páginas y capas
// ============================================================
function renderPages() {
  const list = $('#pageList');
  if (list.querySelector('input')) return;
  const pages = N(state.doc.rootId).children.map(N);
  list.innerHTML = pages.map((p) => `<li data-page="${p.id}" class="${p.id === state.pageId ? 'active' : ''}">${esc(p.name)}</li>`).join('');
}
$('#pageList').addEventListener('click', (e) => {
  const li = e.target.closest('[data-page]');
  if (!li || li.dataset.page === state.pageId) return;
  state.pageId = li.dataset.page;
  state.selection = [];
  invalidate(...ALL);
  requestAnimationFrame(zoomToFit);
});
$('#pageList').addEventListener('dblclick', (e) => {
  const li = e.target.closest('[data-page]');
  if (li) renameInline(li, li.dataset.page);
});
$('#pageList').addEventListener('contextmenu', (e) => {
  const li = e.target.closest('[data-page]');
  if (!li) return;
  e.preventDefault();
  if (N(state.doc.rootId).children.length <= 1) { toast('El diseño necesita al menos una página'); return; }
  if (!confirm(`¿Borrar la página "${N(li.dataset.page).name}"?`)) return;
  perform([{ op: 'delete', id: li.dataset.page }], { history: false });
  state.pageId = N(state.doc.rootId).children[0];
  invalidate(...ALL);
});
$('#addPageBtn').addEventListener('click', () => {
  const op = { op: 'createPage', id: newId(), name: `Página ${N(state.doc.rootId).children.length + 1}` };
  perform([op]);
  state.pageId = op.id;
  state.selection = [];
  invalidate(...ALL);
});

function renameInline(el, id) {
  const n = N(id);
  const input = document.createElement('input');
  input.value = n.name;
  const old = el.innerHTML;
  const nameSpan = el.querySelector('.layer-name');
  const host = nameSpan || el;
  const prev = host.innerHTML;
  host.innerHTML = '';
  host.append(input);
  input.focus(); input.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (save && v && v !== n.name) perform([{ op: 'update', id, props: { name: v } }]);
    else { host.innerHTML = prev; if (!nameSpan) el.innerHTML = old; }
    invalidate(...ALL);
  };
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
}

const ICONS = {
  FRAME: '<path d="M5 2v12M11 2v12M2 5h12M2 11h12"/>',
  GROUP: '<rect x="2.5" y="2.5" width="11" height="11" rx="1" stroke-dasharray="2 2"/>',
  RECTANGLE: '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/>',
  ELLIPSE: '<circle cx="8" cy="8" r="5.5"/>',
  TEXT: '<path d="M3.5 4.5v-1h9v1M8 3.5v9M6 12.5h4"/>',
  LINE: '<path d="M3 13 13 3"/>',
  IMAGE: '<rect x="2.5" y="3" width="11" height="10" rx="1"/><path d="m3 12 3.5-3.5 2.5 2.5 1.5-1.5 2.5 2.5"/>',
};
const EYE = '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>';
const EYE_OFF = '<path d="M2 2l12 12M6.5 4C7 3.6 7.5 3.5 8 3.5c4 0 6.5 4.5 6.5 4.5s-.7 1.3-2 2.6M10 12.2c-.6.2-1.3.3-2 .3-4 0-6.5-4.5-6.5-4.5s.8-1.5 2.3-2.8"/>';
const LOCK = '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>';
const UNLOCK = '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1"/>';

function renderLayers() {
  const tree = $('#layerTree');
  if (tree.querySelector('input')) return;
  const rows = [];
  const walk = (ids, depth) => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const n = N(ids[i]);
      if (!n) continue;
      const hasKids = n.children?.length > 0;
      const open = state.expanded.has(n.id);
      rows.push(`<li class="layer-row${state.selection.includes(n.id) ? ' selected' : ''}${n.visible === false ? ' hidden-node' : ''}" data-id="${n.id}" draggable="true" style="padding-left:${6 + depth * 14}px">
        <button class="twisty${hasKids ? '' : ' empty'}${open ? ' open' : ''}" data-twisty tabindex="-1" aria-label="Expandir"><svg viewBox="0 0 10 10"><path d="M3 2l4 3-4 3"/></svg></button>
        <svg class="layer-icon" viewBox="0 0 16 16">${ICONS[n.type] || ''}</svg>
        <span class="layer-name">${esc(n.name)}</span>
        <button class="row-btn${n.locked ? ' on' : ''}" data-lock title="Bloquear" tabindex="-1"><svg viewBox="0 0 16 16">${n.locked ? LOCK : UNLOCK}</svg></button>
        <button class="row-btn${n.visible === false ? ' on' : ''}" data-eye title="Mostrar / ocultar" tabindex="-1"><svg viewBox="0 0 16 16">${n.visible === false ? EYE_OFF : EYE}</svg></button>
      </li>`);
      if (hasKids && open) walk(n.children, depth + 1);
    }
  };
  walk(N(state.pageId).children, 0);
  tree.innerHTML = rows.join('') || '<li class="hint" style="padding:4px 12px">Página vacía. Elegí una herramienta arriba y dibujá en el lienzo.</li>';
  const selRow = tree.querySelector('.layer-row.selected');
  if (selRow && dirty.scrollLayer) selRow.scrollIntoView({ block: 'nearest' });
}

$('#layerTree').addEventListener('click', (e) => {
  const row = e.target.closest('.layer-row');
  if (!row) return;
  const id = row.dataset.id;
  const n = N(id);
  if (e.target.closest('[data-twisty]')) {
    state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
    invalidate('layers');
    return;
  }
  if (e.target.closest('[data-eye]')) { perform([{ op: 'update', id, props: { visible: n.visible === false } }]); return; }
  if (e.target.closest('[data-lock]')) { perform([{ op: 'update', id, props: { locked: !n.locked } }]); return; }
  if (e.shiftKey || e.metaKey || e.ctrlKey) select(state.selection.includes(id) ? state.selection.filter((x) => x !== id) : [...state.selection, id]);
  else select([id]);
});
$('#layerTree').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.layer-row');
  if (row && !e.target.closest('button')) renameInline(row, row.dataset.id);
});
$('#layerTree').addEventListener('pointerover', (e) => {
  const row = e.target.closest('.layer-row');
  const id = row?.dataset.id || null;
  if (id !== state.hover) { state.hover = id; invalidate('overlay'); }
});
$('#layerTree').addEventListener('pointerleave', () => { state.hover = null; invalidate('overlay'); });

// Arrastrar capas para reordenar o meter dentro de frames
let layerDrag = null;
$('#layerTree').addEventListener('dragstart', (e) => {
  const row = e.target.closest('.layer-row');
  if (!row) return;
  const id = row.dataset.id;
  layerDrag = state.selection.includes(id) ? state.selection.filter((x) => N(x)) : [id];
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
});
function dropPosition(e, row) {
  const r = row.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  const n = N(row.dataset.id);
  const container = n.type === 'FRAME' || n.type === 'GROUP';
  if (container && y > 0.3 && y < 0.7) return 'inside';
  return y < 0.5 ? 'before' : 'after';
}
$('#layerTree').addEventListener('dragover', (e) => {
  const row = e.target.closest('.layer-row');
  if (!row || !layerDrag) return;
  e.preventDefault();
  for (const r of $('#layerTree').querySelectorAll('.drop-before,.drop-after,.drop-inside')) r.classList.remove('drop-before', 'drop-after', 'drop-inside');
  row.classList.add('drop-' + dropPosition(e, row));
});
$('#layerTree').addEventListener('dragend', () => { layerDrag = null; invalidate('layers'); });
$('#layerTree').addEventListener('drop', (e) => {
  const row = e.target.closest('.layer-row');
  if (!row || !layerDrag) return;
  e.preventDefault();
  const targetId = row.dataset.id;
  const pos = dropPosition(e, row);
  const ids = layerDrag.filter((id) => id !== targetId && !isAncestor(id, targetId));
  layerDrag = null;
  if (!ids.length) return invalidate('layers');
  const t = N(targetId);
  let parentId, index;
  if (pos === 'inside') { parentId = targetId; index = t.children.length; state.expanded.add(targetId); }
  else {
    parentId = t.parentId;
    const idx = N(parentId).children.indexOf(targetId);
    // La lista se muestra al revés: "arriba" = índice mayor
    index = pos === 'before' ? idx + 1 : idx;
  }
  const ops = [];
  const po = parentOrigin(parentId);
  for (const id of ids.reverse()) {
    const n = N(id);
    const abs = absolutePosition(state.doc, id);
    let insertAt = index;
    if (n.parentId === parentId && N(parentId).children.indexOf(id) < index) insertAt -= 1;
    ops.push({ op: 'move', id, parentId, index: insertAt });
    if (n.parentId !== parentId) ops.push({ op: 'update', id, props: { x: Math.round(abs.x - po.x), y: Math.round(abs.y - po.y) } });
  }
  perform(ops);
});

// ============================================================
// Panel derecho: propiedades
// ============================================================
const MIXED = Symbol('mixed');
const FONTS = ['Inter', 'Roboto', 'Poppins', 'Montserrat', 'Open Sans', 'Lato', 'Nunito', 'DM Sans', 'Manrope', 'Plus Jakarta Sans', 'Space Grotesk', 'Outfit', 'Sora', 'Rubik', 'Work Sans', 'Playfair Display', 'Merriweather', 'Lora', 'DM Serif Display', 'Fraunces', 'Bebas Neue', 'Oswald', 'JetBrains Mono', 'Space Mono'];

const colorCtx = document.createElement('canvas').getContext('2d');
function toHex(c) {
  if (!c) return '#000000';
  let s = String(c);
  if (s.includes('gradient')) s = (s.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)/) || ['#000'])[0];
  colorCtx.fillStyle = '#000';
  colorCtx.fillStyle = s;
  const v = colorCtx.fillStyle;
  if (v.startsWith('#')) return v;
  const m = v.match(/\d+(\.\d+)?/g);
  return m ? '#' + m.slice(0, 3).map((x) => (+x).toString(16).padStart(2, '0')).join('') : '#000000';
}

function common(nodes, key) {
  const v = nodes[0][key];
  return nodes.every((n) => n[key] === v) ? v : MIXED;
}
const shown = (v) => (v === MIXED || v === undefined || v === null ? '' : typeof v === 'number' ? round(v) : v);

function numField(label, key, v, title = '') {
  return `<label class="field" title="${esc(title || label)}"><span>${label}</span><input data-key="${key}" data-kind="num" inputmode="decimal" value="${esc(shown(v))}" placeholder="${v === MIXED ? 'Mixto' : ''}"></label>`;
}
function colorField(key, v, label = '') {
  const raw = v === MIXED ? '' : v || '';
  return `<div class="field">${label ? `<span>${label}</span>` : ''}<input type="color" data-key="${key}" data-kind="colorpick" value="${toHex(raw)}" aria-label="Elegir color"><input data-key="${key}" data-kind="color" value="${esc(raw)}" placeholder="${v === MIXED ? 'Mixto' : 'Ninguno'}" aria-label="Color"></div>`;
}
const segBtn = (key, value, cur, label) => `<button type="button" class="${cur === value ? 'on' : ''}" data-set="${key}" data-value="${value}" title="${label}">${label}</button>`;
const alignIcon = { left: '<path d="M3 2v12M6 5h7M6 10h4"/>', hcenter: '<path d="M8 2v12M4 5h8M5.5 10h5"/>', right: '<path d="M13 2v12M3 5h7M6 10h4"/>', top: '<path d="M2 3h12M5 6v7M10 6v4"/>', vcenter: '<path d="M2 8h12M5 4v8M10 5.5v5"/>', bottom: '<path d="M2 13h12M5 3v7M10 6v4"/>' };

function renderProps() {
  const el = $('#props');
  const key = state.selection.join(',') + '|' + state.pageId;
  if (el.contains(document.activeElement) && el._key === key && document.activeElement.tagName !== 'BUTTON') return;
  el._key = key;
  const nodes = state.selection.map(N).filter(Boolean);
  if (!nodes.length) { el.innerHTML = pagePanel(); return; }

  const types = new Set(nodes.map((n) => n.type));
  const only = types.size === 1 ? nodes[0].type : null;
  const v = (k) => common(nodes, k);
  const html = [];

  html.push(`<div class="prop-group"><h4>${nodes.length > 1 ? `${nodes.length} capas` : esc(nodes[0].name)}</h4>
    <div class="grid3" style="grid-template-columns:repeat(6,1fr)">${Object.keys(alignIcon).map((a) => `<button class="icon-btn small" data-align="${a}" title="Alinear ${a}" style="width:100%"><svg viewBox="0 0 16 16">${alignIcon[a]}</svg></button>`).join('')}</div>
  </div>`);

  html.push(`<div class="prop-group">
    <div class="grid2">${numField('X', 'x', v('x'))}${numField('Y', 'y', v('y'))}${numField('W', 'width', v('width'), 'Ancho')}${numField('H', 'height', v('height'), 'Alto')}</div>
    <div class="grid2">${numField('↻', 'rotation', v('rotation'), 'Rotación (grados)')}${only !== 'ELLIPSE' && only !== 'LINE' && only !== 'TEXT' ? numField('◜', 'cornerRadius', v('cornerRadius'), 'Radio de esquinas') : ''}</div>
    ${only === 'FRAME' || only === 'GROUP' ? `<label class="check"><input type="checkbox" data-key="clipsContent" data-kind="bool" ${v('clipsContent') === true ? 'checked' : ''}> Recortar contenido</label>` : ''}
  </div>`);

  html.push(`<div class="prop-group"><h4>Capa</h4>
    <label class="field" title="Opacidad"><span>Opacidad</span><input data-key="opacity" data-kind="pct" value="${v('opacity') === MIXED ? '' : Math.round(v('opacity') * 100)}" placeholder="${v('opacity') === MIXED ? 'Mixto' : ''}"><span>%</span></label>
  </div>`);

  if (only === 'TEXT') {
    const n = nodes[0];
    html.push(`<div class="prop-group"><h4>Texto</h4>
      ${nodes.length === 1 ? `<textarea class="textarea" data-key="text" data-kind="text" aria-label="Contenido">${esc(n.text)}</textarea>` : ''}
      <label class="field"><span>Fuente</span><input data-key="fontFamily" data-kind="str" list="fontList" value="${esc(shown(v('fontFamily')))}"></label>
      <datalist id="fontList">${FONTS.map((f) => `<option value="${f}">`).join('')}</datalist>
      <div class="grid2">${numField('Tam', 'fontSize', v('fontSize'), 'Tamaño')}
        <label class="field" title="Peso"><span>Peso</span><select data-key="fontWeight" data-kind="numsel">${[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => `<option ${v('fontWeight') === w ? 'selected' : ''}>${w}</option>`).join('')}</select></label>
        ${numField('Alto', 'lineHeight', v('lineHeight'), 'Interlineado (multiplicador)')}${numField('Esp', 'letterSpacing', v('letterSpacing'), 'Espaciado entre letras (px)')}</div>
      <div class="seg">${segBtn('textAlign', 'left', v('textAlign'), 'Izq')}${segBtn('textAlign', 'center', v('textAlign'), 'Centro')}${segBtn('textAlign', 'right', v('textAlign'), 'Der')}</div>
      <div class="seg">${segBtn('verticalAlign', 'top', v('verticalAlign'), 'Arriba')}${segBtn('verticalAlign', 'middle', v('verticalAlign'), 'Medio')}${segBtn('verticalAlign', 'bottom', v('verticalAlign'), 'Abajo')}</div>
      <div class="grid2"><label class="check"><input type="checkbox" data-key="italic" data-kind="bool" ${v('italic') === true ? 'checked' : ''}> Cursiva</label><label class="check"><input type="checkbox" data-key="underline" data-kind="bool" ${v('underline') === true ? 'checked' : ''}> Subrayado</label></div>
    </div>`);
  }

  if (only === 'IMAGE' && nodes.length === 1) {
    const n = nodes[0];
    html.push(`<div class="prop-group"><h4>Imagen</h4>
      <label class="field"><span>URL</span><input data-key="src" data-kind="str" value="${n.src.startsWith('data:') ? '' : esc(n.src)}" placeholder="${n.src.startsWith('data:') ? 'Imagen subida' : 'https://…'}"></label>
      <div class="seg">${segBtn('fit', 'cover', n.fit, 'Cubrir')}${segBtn('fit', 'contain', n.fit, 'Contener')}${segBtn('fit', 'fill', n.fit, 'Estirar')}</div>
      <button class="btn" data-action="replace-image">Reemplazar imagen…</button>
    </div>`);
  }

  if (only !== 'LINE') {
    const f = v('fill');
    html.push(`<div class="prop-group"><h4>${only === 'TEXT' ? 'Color del texto' : 'Relleno'} ${f ? `<button class="add-link" data-action="clear" data-prop="fill" title="Quitar">−</button>` : `<button class="add-link" data-action="add" data-prop="fill" title="Agregar">+</button>`}</h4>
      ${f !== null && f !== undefined ? colorField('fill', f) : ''}</div>`);
  }
  if (only !== 'TEXT') {
    const s = v('stroke');
    html.push(`<div class="prop-group"><h4>Borde ${s ? `<button class="add-link" data-action="clear" data-prop="stroke" title="Quitar">−</button>` : `<button class="add-link" data-action="add" data-prop="stroke" title="Agregar">+</button>`}</h4>
      ${s ? `${colorField('stroke', s)}${numField('Grosor', 'strokeWidth', v('strokeWidth'))}` : ''}</div>`);
  }
  if (only !== 'LINE' && only !== 'TEXT') {
    const sh = v('shadow');
    html.push(`<div class="prop-group"><h4>Sombra ${sh ? `<button class="add-link" data-action="clear" data-prop="shadow" title="Quitar">−</button>` : `<button class="add-link" data-action="add" data-prop="shadow" title="Agregar">+</button>`}</h4>
      ${sh ? `<label class="field" title="Formato CSS: x y desenfoque color"><input data-key="shadow" data-kind="str" value="${esc(shown(sh))}"></label>` : ''}</div>`);
  }
  html.push(`<div class="prop-group"><p class="hint">Doble clic para entrar en un grupo · Ctrl/⌘+clic selecciona directo · Shift+1 ajusta a pantalla</p></div>`);
  el.innerHTML = html.join('');
}

function pagePanel() {
  const p = N(state.pageId);
  return `<div class="prop-group"><h4>Página</h4>
      ${colorField('background', p.background, 'Fondo')}
    </div>
    <div class="prop-group"><h4>Traer diseños de Figma</h4>
      <p class="hint">En Figma seleccioná el frame → Export → SVG. En los tres puntos desmarcá "Outline text" y marcá "Include id attribute". Después arrastrá el archivo acá o tocá Importar. No usa a Claude.</p>
    </div>
    <div class="prop-group"><h4>Conectar Claude</h4>
      <p class="hint">Pegá esta URL como conector personalizado en Claude. Lo que Claude cambie aparece acá en vivo.</p>
      <div class="copy-row"><code id="mcpUrlEditor">${esc(mcpUrl())}</code><button class="btn" data-copy="mcpUrlEditor">Copiar</button></div>
      <p class="hint">Id de este diseño: <code>${esc(state.docId)}</code></p>
    </div>
    <div class="prop-group"><h4>Atajos</h4>
      <dl class="kbd-list">
        <dt>V</dt><dd>Mover</dd><dt>F</dt><dd>Frame</dd><dt>R / O / L</dt><dd>Rectángulo / elipse / línea</dd>
        <dt>T</dt><dd>Texto</dd><dt>I</dt><dd>Imagen</dd><dt>Espacio</dt><dd>Mover el lienzo</dd>
        <dt>Ctrl+G</dt><dd>Agrupar (Shift: desagrupar)</dd><dt>Ctrl+D</dt><dd>Duplicar</dd>
        <dt>Ctrl+] / [</dt><dd>Traer adelante / atrás</dd><dt>Shift+H</dt><dd>Ocultar</dd>
        <dt>Ctrl+Z</dt><dd>Deshacer</dd>
      </dl>
    </div>`;
}

function targetIds() {
  return state.selection.length ? state.selection.filter((id) => N(id)) : [state.pageId];
}

function evalNum(s) {
  s = String(s).trim().replace(',', '.');
  if (!s) return null;
  if (!/^[\d+\-*/.() ]+$/.test(s)) return null;
  try { const v = Function(`"use strict";return (${s})`)(); return Number.isFinite(v) ? v : null; } catch { return null; }
}

// Vista previa local mientras se arrastra el selector de color
const previewOrig = new Map();
function previewProp(key, value) {
  for (const id of targetIds()) {
    const n = N(id);
    if (!previewOrig.has(id)) previewOrig.set(id, { [key]: n[key] });
    n[key] = value;
  }
  invalidate('world', 'overlay');
}
function commitProp(key, value) {
  for (const [id, o] of previewOrig) if (N(id)) Object.assign(N(id), o);
  previewOrig.clear();
  const ops = targetIds().map((id) => ({ op: 'update', id, props: { [key]: value } }));
  perform(ops);
}

$('#props').addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.kind === 'colorpick') {
    previewProp(t.dataset.key, t.value);
    const txt = t.parentElement.querySelector('[data-kind=color]');
    if (txt) txt.value = t.value;
  }
});
$('#props').addEventListener('change', (e) => {
  const t = e.target;
  const key = t.dataset.key;
  if (!key) return;
  let v;
  switch (t.dataset.kind) {
    case 'num': v = evalNum(t.value); if (v === null) return invalidate('props'); break;
    case 'pct': v = evalNum(t.value); if (v === null) return; v = clamp(v / 100, 0, 1); break;
    case 'numsel': v = Number(t.value); break;
    case 'bool': v = t.checked; break;
    case 'color': v = t.value.trim() || null; break;
    case 'colorpick': v = t.value; break;
    default: v = t.value;
  }
  commitProp(key, v);
  if (t.tagName !== 'TEXTAREA') t.blur?.();
});
$('#props').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur();
  if (e.key === 'Escape') { e.target.blur(); invalidate('props'); }
  // Flechas arriba/abajo en campos numéricos
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.target.dataset?.kind === 'num') {
    e.preventDefault();
    const cur = evalNum(e.target.value) ?? 0;
    e.target.value = round(cur + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
    commitProp(e.target.dataset.key, Number(e.target.value));
  }
});
$('#props').addEventListener('focusout', () => setTimeout(() => {
  if (!$('#props').contains(document.activeElement)) invalidate('props');
}, 0));
$('#props').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.align) return align(b.dataset.align);
  if (b.dataset.set) return commitProp(b.dataset.set, b.dataset.value);
  const prop = b.dataset.prop;
  if (b.dataset.action === 'clear') return commitProp(prop, null);
  if (b.dataset.action === 'add') {
    const def = { fill: N(state.selection[0])?.type === 'TEXT' ? '#111111' : '#D9D9D9', stroke: '#111111', shadow: '0 4px 12px rgba(0,0,0,0.15)' }[prop];
    return commitProp(prop, def);
  }
  if (b.dataset.action === 'replace-image') pickImage(null, state.selection[0]);
});

// ============================================================
// Barra superior
// ============================================================
$('#docName').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (v) perform([{ op: 'update', id: state.doc.rootId, props: { name: v } }]);
  document.title = `${v} · Lienzo`;
  e.target.blur();
});
$('#docName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('#zoomBtn').addEventListener('click', zoomToFit);
$('#exportBtn').addEventListener('click', async () => {
  const id = state.selection.length === 1 ? state.selection[0] : state.pageId;
  const res = await fetch(`/api/docs/${state.docId}/svg/${id}`, { headers: { 'x-access-token': state.token } });
  if (!res.ok) return toast('No se pudo exportar');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${N(id).name || 'diseño'}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

// ============================================================
// Abrir el editor
// ============================================================
function openEditor(id) {
  showScreen('editor');
  state.docId = id;
  setTool('select');
  connect();
}

boot().catch((e) => { console.error(e); toast('No se pudo cargar: ' + e.message); });
