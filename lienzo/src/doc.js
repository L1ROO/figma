// Modelo de documento estilo Figma.
// Un documento tiene un mapa plano de nodos. Cada nodo contenedor guarda la lista
// ordenada de ids de sus hijos (el último se dibuja arriba). Las posiciones x/y
// son relativas al padre, igual que en Figma.

// Este archivo también se usa en el navegador (/shared/doc.js), por eso no importa nada de Node.

export const CONTAINER_TYPES = new Set(['DOCUMENT', 'PAGE', 'FRAME', 'GROUP']);
export const NODE_TYPES = ['FRAME', 'GROUP', 'RECTANGLE', 'ELLIPSE', 'TEXT', 'LINE', 'IMAGE'];

// Propiedades editables y sus valores por defecto por tipo.
const BASE = { x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, visible: true, locked: false };
export const DEFAULTS = {
  FRAME: { ...BASE, fill: '#FFFFFF', stroke: null, strokeWidth: 1, cornerRadius: 0, clipsContent: true, shadow: null },
  GROUP: { ...BASE, fill: null, stroke: null, strokeWidth: 1, cornerRadius: 0, clipsContent: false, shadow: null },
  RECTANGLE: { ...BASE, fill: '#D9D9D9', stroke: null, strokeWidth: 1, cornerRadius: 0, shadow: null },
  ELLIPSE: { ...BASE, fill: '#D9D9D9', stroke: null, strokeWidth: 1, shadow: null },
  TEXT: {
    ...BASE, width: 200, height: 24, text: 'Texto', fill: '#111111', fontSize: 16,
    fontFamily: 'Inter', fontWeight: 400, lineHeight: 1.3, letterSpacing: 0,
    textAlign: 'left', verticalAlign: 'top', italic: false, underline: false,
  },
  LINE: { ...BASE, height: 0, fill: null, stroke: '#111111', strokeWidth: 2 },
  IMAGE: { ...BASE, src: '', fit: 'cover', cornerRadius: 0, fill: '#E5E5E5', stroke: null, strokeWidth: 1, shadow: null },
};

const ALLOWED_PROPS = new Set([
  'name', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'locked',
  'fill', 'stroke', 'strokeWidth', 'cornerRadius', 'clipsContent', 'shadow',
  'text', 'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing',
  'textAlign', 'verticalAlign', 'italic', 'underline', 'src', 'fit', 'link', 'transition',
  'interactions', 'fixed', 'viewportHeight',
]);

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(10));
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export function createEmptyDocument(name = 'Sin título') {
  const id = newId();
  const rootId = newId();
  const pageId = newId();
  const now = new Date().toISOString();
  return {
    id, name, createdAt: now, updatedAt: now, rootId,
    nodes: {
      [rootId]: { id: rootId, type: 'DOCUMENT', name, parentId: null, children: [pageId] },
      [pageId]: { id: pageId, type: 'PAGE', name: 'Página 1', parentId: rootId, children: [], background: '#F5F5F5' },
    },
  };
}

export function pages(doc) {
  return doc.nodes[doc.rootId].children.map((id) => doc.nodes[id]);
}

function cleanProps(props) {
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (!ALLOWED_PROPS.has(k)) continue;
    out[k] = v;
  }
  for (const k of ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'strokeWidth', 'cornerRadius', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing']) {
    if (k in out && out[k] !== null) {
      const n = Number(out[k]);
      if (!Number.isFinite(n)) delete out[k];
      else out[k] = n;
    }
  }
  if ('width' in out) out.width = Math.max(0, out.width);
  if ('height' in out) out.height = Math.max(0, out.height);
  if ('opacity' in out) out.opacity = Math.min(1, Math.max(0, out.opacity));
  if ('text' in out) out.text = String(out.text);
  if ('viewportHeight' in out && out.viewportHeight !== null) {
    const n = Number(out.viewportHeight);
    out.viewportHeight = Number.isFinite(n) && n > 0 ? n : null;
  }
  if ('fixed' in out) out.fixed = Boolean(out.fixed);
  if ('interactions' in out) out.interactions = cleanInteractions(out.interactions);
  return out;
}

// Interacciones de prototipo:
// { trigger: tap|hover|press|delay, delay (ms), action: navigate|back|overlay|swap|close|url|scrollTo|style,
//   target (id), url, transition: instant|dissolve|slide|slideUp, position: center|top|bottom|left|right,
//   dim (bool), closeOnOutside (bool), style: { fill, stroke, opacity, shadow, ... } }
export const TRIGGERS = ['tap', 'hover', 'press', 'delay'];
export const ACTIONS = ['navigate', 'back', 'overlay', 'swap', 'close', 'url', 'scrollTo', 'style'];
export const TRANSITIONS = ['instant', 'dissolve', 'slide', 'slideUp'];
const STYLE_KEYS = ['fill', 'stroke', 'strokeWidth', 'opacity', 'shadow', 'cornerRadius', 'text', 'fontWeight', 'width', 'height', 'x', 'y'];

function cleanInteractions(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const it of list.slice(0, 20)) {
    if (!it || typeof it !== 'object') continue;
    const trigger = TRIGGERS.includes(it.trigger) ? it.trigger : 'tap';
    const action = ACTIONS.includes(it.action) ? it.action : 'navigate';
    const ix = { trigger, action };
    if (trigger === 'delay') ix.delay = Math.max(0, Number(it.delay) || 800);
    if (['navigate', 'overlay', 'swap', 'scrollTo'].includes(action) && it.target) ix.target = String(it.target);
    if (action === 'url') ix.url = String(it.url || '');
    if (['navigate', 'back', 'overlay', 'swap'].includes(action)) ix.transition = TRANSITIONS.includes(it.transition) ? it.transition : 'dissolve';
    if (action === 'overlay' || action === 'swap') {
      ix.position = ['center', 'top', 'bottom', 'left', 'right'].includes(it.position) ? it.position : 'center';
      ix.dim = it.dim !== false;
      ix.closeOnOutside = it.closeOnOutside !== false;
    }
    if (action === 'style') {
      ix.style = {};
      for (const k of STYLE_KEYS) if (it.style && k in it.style) ix.style[k] = it.style[k];
    }
    out.push(ix);
  }
  return out.length ? out : null;
}

// Interacciones de un nodo, incluyendo el formato viejo (link/transition).
export function interactionsOf(node) {
  const list = Array.isArray(node?.interactions) ? [...node.interactions] : [];
  if (node?.link && !list.some((i) => i.trigger === 'tap')) {
    list.unshift(node.link === 'back'
      ? { trigger: 'tap', action: 'back', transition: node.transition || 'dissolve' }
      : { trigger: 'tap', action: 'navigate', target: node.link, transition: node.transition || 'dissolve' });
  }
  return list;
}

function assertContainer(doc, parentId) {
  const parent = doc.nodes[parentId];
  if (!parent) throw new Error(`No existe el nodo padre ${parentId}`);
  if (!CONTAINER_TYPES.has(parent.type) || parent.type === 'DOCUMENT') {
    throw new Error(`El nodo ${parentId} (${parent.type}) no puede tener hijos. Usá una PAGE, FRAME o GROUP.`);
  }
  return parent;
}

function isDescendant(doc, nodeId, maybeAncestorId) {
  let cur = doc.nodes[nodeId];
  while (cur) {
    if (cur.id === maybeAncestorId) return true;
    cur = cur.parentId ? doc.nodes[cur.parentId] : null;
  }
  return false;
}

// Crea un nodo (y sus hijos anidados) a partir de una especificación:
// { type, name?, id?, ...props, children?: [spec] }
export function createFromSpec(doc, spec, parentId, index) {
  const type = String(spec.type || '').toUpperCase();
  if (!NODE_TYPES.includes(type)) throw new Error(`Tipo inválido "${spec.type}". Usá: ${NODE_TYPES.join(', ')}`);
  const parent = assertContainer(doc, parentId);
  let id = spec.id && typeof spec.id === 'string' && !doc.nodes[spec.id] ? spec.id : newId();
  const node = {
    id, type, parentId,
    name: spec.name || defaultName(doc, type),
    ...DEFAULTS[type],
    ...cleanProps(spec),
  };
  if (CONTAINER_TYPES.has(type)) node.children = [];
  doc.nodes[id] = node;
  const i = index === undefined || index === null ? parent.children.length : Math.max(0, Math.min(parent.children.length, index));
  parent.children.splice(i, 0, id);
  const created = [id];
  if (Array.isArray(spec.children) && CONTAINER_TYPES.has(type)) {
    for (const child of spec.children) created.push(...createFromSpec(doc, child, id));
  }
  return created;
}

function defaultName(doc, type) {
  const base = { FRAME: 'Frame', GROUP: 'Grupo', RECTANGLE: 'Rectángulo', ELLIPSE: 'Elipse', TEXT: 'Texto', LINE: 'Línea', IMAGE: 'Imagen' }[type];
  let n = 1;
  for (const node of Object.values(doc.nodes)) if (node.type === type) n++;
  return `${base} ${n}`;
}

export function updateNode(doc, id, props) {
  const node = doc.nodes[id];
  if (!node) throw new Error(`No existe el nodo ${id}`);
  if (node.type === 'DOCUMENT') {
    if (props.name) { node.name = String(props.name); doc.name = node.name; }
    return node;
  }
  if (node.type === 'PAGE') {
    if (props.name) node.name = String(props.name);
    if (props.background !== undefined) node.background = props.background;
    return node;
  }
  Object.assign(node, cleanProps(props));
  return node;
}

export function deleteNode(doc, id) {
  const node = doc.nodes[id];
  if (!node) return false;
  if (node.type === 'DOCUMENT') throw new Error('No se puede borrar el documento desde acá');
  if (node.type === 'PAGE' && pages(doc).length <= 1) throw new Error('El documento necesita al menos una página');
  const parent = doc.nodes[node.parentId];
  if (parent) parent.children = parent.children.filter((c) => c !== id);
  const stack = [id];
  while (stack.length) {
    const cur = doc.nodes[stack.pop()];
    if (!cur) continue;
    if (cur.children) stack.push(...cur.children);
    delete doc.nodes[cur.id];
  }
  return true;
}

export function moveNode(doc, id, parentId, index) {
  const node = doc.nodes[id];
  if (!node) throw new Error(`No existe el nodo ${id}`);
  if (node.type === 'PAGE' || node.type === 'DOCUMENT') throw new Error('Las páginas no se mueven con move');
  const newParent = assertContainer(doc, parentId);
  if (isDescendant(doc, parentId, id)) throw new Error('No se puede mover un nodo dentro de sí mismo');
  const oldParent = doc.nodes[node.parentId];
  oldParent.children = oldParent.children.filter((c) => c !== id);
  const i = index === undefined || index === null ? newParent.children.length : Math.max(0, Math.min(newParent.children.length, index));
  newParent.children.splice(i, 0, id);
  node.parentId = parentId;
  return node;
}

// Snapshot anidado (con ids) para duplicar, deshacer o exportar.
export function toSpec(doc, id, keepIds = true) {
  const node = doc.nodes[id];
  const { parentId, children, ...rest } = node;
  const spec = { ...rest };
  if (!keepIds) delete spec.id;
  if (children) spec.children = children.map((c) => toSpec(doc, c, keepIds));
  return spec;
}

export function absolutePosition(doc, id) {
  let x = 0, y = 0;
  let cur = doc.nodes[id];
  while (cur && cur.type !== 'PAGE' && cur.type !== 'DOCUMENT') {
    x += cur.x || 0; y += cur.y || 0;
    cur = doc.nodes[cur.parentId];
  }
  return { x, y };
}

export function pageOf(doc, id) {
  let cur = doc.nodes[id];
  while (cur && cur.type !== 'PAGE') cur = doc.nodes[cur.parentId];
  return cur || null;
}

// Aplica una operación del protocolo compartido (web y MCP).
// Devuelve la operación "normalizada" que se reenvía al resto de los clientes.
export function applyOp(doc, op) {
  switch (op.op) {
    case 'create': {
      const ids = createFromSpec(doc, op.node, op.parentId, op.index);
      return { op: 'create', parentId: op.parentId, index: doc.nodes[op.parentId].children.indexOf(ids[0]), node: toSpec(doc, ids[0]) };
    }
    case 'update': {
      updateNode(doc, op.id, op.props || {});
      const n = doc.nodes[op.id];
      const props = {};
      for (const k of Object.keys(op.props || {})) if (k in n) props[k] = n[k];
      return { op: 'update', id: op.id, props };
    }
    case 'delete':
      deleteNode(doc, op.id);
      return { op: 'delete', id: op.id };
    case 'move':
      moveNode(doc, op.id, op.parentId, op.index);
      return { op: 'move', id: op.id, parentId: op.parentId, index: doc.nodes[op.parentId].children.indexOf(op.id) };
    case 'createPage': {
      const id = op.id && !doc.nodes[op.id] ? op.id : newId();
      doc.nodes[id] = { id, type: 'PAGE', name: op.name || `Página ${pages(doc).length + 1}`, parentId: doc.rootId, children: [], background: '#F5F5F5' };
      doc.nodes[doc.rootId].children.push(id);
      return { op: 'createPage', id, name: doc.nodes[id].name };
    }
    default:
      throw new Error(`Operación desconocida: ${op.op}`);
  }
}
