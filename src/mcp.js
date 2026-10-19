// Servidor MCP (Streamable HTTP, sin estado). Claude se conecta a /mcp/<ACCESS_TOKEN>.
// Las herramientas están pensadas para gastar pocos tokens: el árbol se devuelve
// como texto compacto y se pueden crear pantallas enteras en una sola llamada.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { DEFAULTS, NODE_TYPES, pages, toSpec, absolutePosition, newId } from './doc.js';
import { listDocs, getDoc, addDoc } from './store.js';
import { commit } from './hub.js';
import { nodeToPng } from './render.js';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });

const r1 = (n) => Math.round(n * 10) / 10;

// Una línea por nodo, mostrando solo lo que difiere de los valores por defecto.
function describe(node) {
  const parts = [`${node.type} "${node.name}" [${node.id}]`];
  if (node.type === 'PAGE') {
    parts.push(`bg=${node.background}`);
    return parts.join(' ');
  }
  parts.push(`${r1(node.x)},${r1(node.y)} ${r1(node.width)}×${r1(node.height)}`);
  const def = DEFAULTS[node.type] || {};
  const skip = new Set(['id', 'type', 'name', 'parentId', 'children', 'x', 'y', 'width', 'height', 'text']);
  for (const [k, v] of Object.entries(node)) {
    if (skip.has(k) || v === def[k]) continue;
    if (k === 'src') { parts.push(`src=${String(v).startsWith('data:') ? '(imagen embebida)' : v}`); continue; }
    parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  if (node.type === 'TEXT') {
    const t = node.text.length > 120 ? node.text.slice(0, 117) + '…' : node.text;
    parts.push(JSON.stringify(t));
  }
  return parts.join(' ');
}

// Versión compacta de un nodo para devolver a Claude: sin valores por defecto
// y sin imágenes embebidas (que gastan miles de tokens).
function compact(node, extra = {}) {
  const def = DEFAULTS[node.type] || {};
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'children' || k === 'parentId') continue;
    if (k !== 'id' && k !== 'type' && k !== 'name' && v === def[k]) continue;
    out[k] = k === 'src' && typeof v === 'string' && v.startsWith('data:') ? `(imagen embebida, ${Math.round(v.length / 1024)} KB)` : v;
  }
  if (node.children) out.childCount = node.children.length;
  return { ...out, ...extra };
}

function stripImages(spec) {
  if (typeof spec.src === 'string' && spec.src.startsWith('data:')) spec.src = '(imagen embebida)';
  (spec.children || []).forEach(stripImages);
  return spec;
}

function idList(doc, id, out = []) {
  const n = doc.nodes[id];
  out.push(`${n.name} [${n.id}]`);
  for (const c of n.children || []) idList(doc, c, out);
  return out;
}

function tree(doc, id, depth, maxDepth, lines) {
  const node = doc.nodes[id];
  if (!node) return;
  lines.push(`${'  '.repeat(depth)}${describe(node)}`);
  if (!node.children?.length) return;
  if (depth >= maxDepth) {
    lines.push(`${'  '.repeat(depth + 1)}… ${node.children.length} hijos (pedí este nodo con mayor maxDepth)`);
    return;
  }
  for (const c of node.children) tree(doc, c, depth + 1, maxDepth, lines);
}

const nodeSpecDoc = `Cada nodo: { type: ${NODE_TYPES.join('|')}, name?, x?, y?, width?, height?, ...props, children?: [nodos] }.
Las coordenadas x/y son RELATIVAS al padre. children solo en FRAME/GROUP.
Props comunes: rotation, opacity(0-1), visible, locked, fill (color CSS o gradiente CSS, ej "#fff", "linear-gradient(...)"), stroke, strokeWidth, cornerRadius, shadow (CSS box-shadow, ej "0 4px 12px rgba(0,0,0,.15)").
FRAME/GROUP: clipsContent. TEXT: text, fontSize, fontFamily, fontWeight(100-900), lineHeight(multiplicador), letterSpacing, textAlign(left|center|right), verticalAlign(top|middle|bottom), italic, underline (el color del texto es fill).
IMAGE: src (URL https o data:), fit(cover|contain|fill). LINE: va de (0,0) a (width,height), usa stroke/strokeWidth.`;

function buildServer() {
  const server = new McpServer({ name: 'lienzo', version: '1.1.0' }, {
    instructions: `Lienzo es un editor de diseño tipo Figma. Para gastar pocos tokens y terminar rápido:
- Mirá la estructura UNA vez con get_document (usá nodeId y maxDepth para ver solo lo necesario) y reutilizá los ids.
- Creá pantallas enteras en una sola llamada a create_nodes con hijos anidados, en vez de muchas llamadas chicas.
- Para cambios repetidos (misma fuente, color, ancho en muchas capas) usá bulk_update en vez de listar ids.
- Pedí get_screenshot solo al final o cuando sea imprescindible, y con scale bajo (0.5).
- Si el usuario quiere traer un diseño de Figma, no lo copies capa por capa: decile que exporte el frame como SVG desde Figma (desmarcando "Outline text") y lo arrastre a Lienzo o use el botón Importar. Es instantáneo y no gasta tokens. Después podés ajustar lo que haga falta.`,
  });

  server.registerTool('list_documents', {
    title: 'Listar documentos',
    description: 'Lista los documentos (archivos de diseño) con su id.',
    inputSchema: {},
  }, async () => {
    const docs = listDocs();
    if (!docs.length) return text('No hay documentos.');
    return text(docs.map((d) => `${d.name} [${d.id}] — ${d.nodeCount} nodos, editado ${d.updatedAt}`).join('\n'));
  });

  server.registerTool('create_document', {
    title: 'Crear documento',
    description: 'Crea un documento nuevo con una página vacía.',
    inputSchema: { name: z.string() },
  }, async ({ name }) => {
    const d = addDoc(name);
    const page = pages(d)[0];
    return text(`Documento creado: ${d.name} [${d.id}]\nPágina: ${page.name} [${page.id}]`);
  });

  server.registerTool('get_document', {
    title: 'Ver estructura',
    description: 'Devuelve el árbol de capas como texto compacto (una línea por nodo, solo props distintas de las por defecto). Empezá por acá. Usá nodeId para ver solo una parte y maxDepth para limitar profundidad.',
    inputSchema: {
      documentId: z.string(),
      nodeId: z.string().optional().describe('Página o nodo raíz a mostrar. Si falta, muestra todas las páginas.'),
      maxDepth: z.number().int().min(0).max(50).optional().describe('Por defecto 8'),
    },
  }, async ({ documentId, nodeId, maxDepth = 8 }) => {
    try {
      const doc = getDoc(documentId);
      const lines = [`Documento "${doc.name}" [${doc.id}]`];
      const roots = nodeId ? [nodeId] : doc.nodes[doc.rootId].children;
      for (const id of roots) {
        if (!doc.nodes[id]) throw new Error(`No existe el nodo ${id}`);
        tree(doc, id, 0, maxDepth, lines);
      }
      return text(lines.join('\n'));
    } catch (e) { return fail(e); }
  });

  server.registerTool('get_nodes', {
    title: 'Ver nodos en detalle',
    description: 'Propiedades de los nodos pedidos (solo las distintas de las por defecto) y su posición absoluta.',
    inputSchema: { documentId: z.string(), nodeIds: z.array(z.string()).min(1) },
  }, async ({ documentId, nodeIds }) => {
    try {
      const doc = getDoc(documentId);
      const out = nodeIds.map((id) => {
        const n = doc.nodes[id];
        if (!n) return { id, error: 'no existe' };
        return compact(n, { absolute: absolutePosition(doc, id) });
      });
      return text(JSON.stringify(out));
    } catch (e) { return fail(e); }
  });

  server.registerTool('find_nodes', {
    title: 'Buscar nodos',
    description: 'Busca nodos por nombre o texto (sin distinguir mayúsculas), opcionalmente filtrando por tipo.',
    inputSchema: { documentId: z.string(), query: z.string().optional(), type: z.enum(NODE_TYPES).optional(), limit: z.number().int().optional() },
  }, async ({ documentId, query = '', type, limit = 50 }) => {
    try {
      const doc = getDoc(documentId);
      const q = query.toLowerCase();
      const hits = Object.values(doc.nodes).filter((n) =>
        (!type || n.type === type) && n.type !== 'DOCUMENT' &&
        (!q || n.name?.toLowerCase().includes(q) || n.text?.toLowerCase().includes(q)));
      return text(hits.slice(0, limit).map(describe).join('\n') || 'Sin resultados.');
    } catch (e) { return fail(e); }
  });

  server.registerTool('create_nodes', {
    title: 'Crear nodos',
    description: `Crea uno o varios nodos (con hijos anidados) dentro de parentId (una PAGE, FRAME o GROUP). Ideal para armar una pantalla entera en una sola llamada.\n${nodeSpecDoc}`,
    inputSchema: {
      documentId: z.string(),
      parentId: z.string().describe('Id de la página o frame donde crear'),
      index: z.number().int().optional().describe('Posición entre los hermanos (por defecto arriba de todo)'),
      nodes: z.array(z.record(z.string(), z.any())).min(1),
    },
  }, async ({ documentId, parentId, index, nodes }) => {
    try {
      const ops = nodes.map((node, i) => ({ op: 'create', parentId, index: index === undefined ? undefined : index + i, node }));
      const applied = commit(documentId, ops, 'mcp');
      const doc = getDoc(documentId);
      const ids = applied.flatMap((a) => idList(doc, a.node.id));
      return text(`Creados ${ids.length} nodos: ${ids.join(', ')}`);
    } catch (e) { return fail(e); }
  });

  server.registerTool('update_nodes', {
    title: 'Editar nodos',
    description: 'Cambia propiedades de uno o varios nodos en una llamada. Ej: [{ "id": "abc", "fill": "#000", "text": "Hola" }]. Mismas props que create_nodes. Páginas: name, background. Documento: name (usando el id del nodo DOCUMENT).',
    inputSchema: { documentId: z.string(), updates: z.array(z.object({ id: z.string() }).passthrough()).min(1) },
  }, async ({ documentId, updates }) => {
    try {
      const applied = commit(documentId, updates.map(({ id, ...props }) => ({ op: 'update', id, props })), 'mcp');
      return text(`Actualizados ${applied.length} nodo(s).`);
    } catch (e) { return fail(e); }
  });

  server.registerTool('bulk_update', {
    title: 'Editar en lote por filtro',
    description: 'Cambia muchas capas a la vez sin listar ids. Filtra por tipo, nombre o propiedades actuales dentro de un nodo (o todo el documento). Ej: cambiar todas las fuentes "Cardo" por "Inter": where { fontFamily: "Cardo" }, set { fontFamily: "Inter" }. scale multiplica valores numéricos actuales (ej { width: 1.1 }).',
    inputSchema: {
      documentId: z.string(),
      withinId: z.string().optional().describe('Solo dentro de este nodo/página'),
      type: z.enum(NODE_TYPES).optional(),
      nameContains: z.string().optional(),
      where: z.record(z.string(), z.any()).optional().describe('Propiedades que tienen que coincidir exactamente'),
      set: z.record(z.string(), z.any()).optional(),
      scale: z.record(z.string(), z.number()).optional(),
    },
  }, async ({ documentId, withinId, type, nameContains, where = {}, set = {}, scale = {} }) => {
    try {
      const doc = getDoc(documentId);
      const ids = [];
      const visit = (id) => {
        const n = doc.nodes[id];
        if (!n) return;
        if (n.type !== 'DOCUMENT' && n.type !== 'PAGE' && (!type || n.type === type) &&
          (!nameContains || n.name.toLowerCase().includes(nameContains.toLowerCase())) &&
          Object.entries(where).every(([k, v]) => n[k] === v)) ids.push(id);
        (n.children || []).forEach(visit);
      };
      visit(withinId || doc.rootId);
      if (withinId) ids.splice(ids.indexOf(withinId), ids.includes(withinId) ? 1 : 0);
      const ops = ids.map((id) => {
        const props = { ...set };
        for (const [k, f] of Object.entries(scale)) if (typeof doc.nodes[id][k] === 'number') props[k] = Math.round(doc.nodes[id][k] * f * 100) / 100;
        return { op: 'update', id, props };
      });
      if (ops.length) commit(documentId, ops, 'mcp');
      return text(`Actualizadas ${ops.length} capas.`);
    } catch (e) { return fail(e); }
  });

  server.registerTool('delete_nodes', {
    title: 'Borrar nodos',
    description: 'Borra nodos (y todo lo que tengan adentro). También sirve para páginas.',
    inputSchema: { documentId: z.string(), nodeIds: z.array(z.string()).min(1) },
  }, async ({ documentId, nodeIds }) => {
    try {
      const applied = commit(documentId, nodeIds.map((id) => ({ op: 'delete', id })), 'mcp');
      return text(`Borrados ${applied.length} nodo(s).`);
    } catch (e) { return fail(e); }
  });

  server.registerTool('move_nodes', {
    title: 'Mover / reordenar nodos',
    description: 'Mueve nodos a otro padre o cambia su orden (index 0 = abajo de todo). Si keepPosition es true, conserva la posición visual en pantalla recalculando x/y.',
    inputSchema: {
      documentId: z.string(),
      moves: z.array(z.object({ id: z.string(), parentId: z.string(), index: z.number().int().optional(), keepPosition: z.boolean().optional() })).min(1),
    },
  }, async ({ documentId, moves }) => {
    try {
      const doc = getDoc(documentId);
      const ops = [];
      for (const m of moves) {
        ops.push({ op: 'move', id: m.id, parentId: m.parentId, index: m.index });
        if (m.keepPosition && doc.nodes[m.id]) {
          const abs = absolutePosition(doc, m.id);
          const pAbs = doc.nodes[m.parentId]?.type === 'PAGE' ? { x: 0, y: 0 } : absolutePosition(doc, m.parentId);
          ops.push({ op: 'update', id: m.id, props: { x: abs.x - pAbs.x, y: abs.y - pAbs.y } });
        }
      }
      commit(documentId, ops, 'mcp');
      return text(`Movidos ${moves.length} nodo(s).`);
    } catch (e) { return fail(e); }
  });

  server.registerTool('duplicate_nodes', {
    title: 'Duplicar nodos',
    description: 'Duplica nodos con todos sus hijos. Por defecto la copia queda al lado (+offsetX). Podés mandarla a otro padre.',
    inputSchema: {
      documentId: z.string(),
      nodeIds: z.array(z.string()).min(1),
      offsetX: z.number().optional(), offsetY: z.number().optional(),
      parentId: z.string().optional(),
    },
  }, async ({ documentId, nodeIds, offsetX, offsetY = 0, parentId }) => {
    try {
      const doc = getDoc(documentId);
      const ops = nodeIds.map((id) => {
        const n = doc.nodes[id];
        if (!n) throw new Error(`No existe el nodo ${id}`);
        const spec = toSpec(doc, id, false);
        spec.x = (n.x || 0) + (offsetX ?? (n.width || 0) + 40);
        spec.y = (n.y || 0) + offsetY;
        spec.name = `${n.name} copia`;
        return { op: 'create', parentId: parentId || n.parentId, node: spec };
      });
      const applied = commit(documentId, ops, 'mcp');
      return text(applied.map((a) => `${a.node.name} [${a.node.id}]`).join('\n'));
    } catch (e) { return fail(e); }
  });

  server.registerTool('create_page', {
    title: 'Crear página',
    description: 'Agrega una página nueva al documento.',
    inputSchema: { documentId: z.string(), name: z.string() },
  }, async ({ documentId, name }) => {
    try {
      const [a] = commit(documentId, [{ op: 'createPage', id: newId(), name }], 'mcp');
      return text(`Página creada: ${a.name} [${a.id}]`);
    } catch (e) { return fail(e); }
  });

  server.registerTool('get_screenshot', {
    title: 'Captura',
    description: 'Imagen PNG de una página o frame. Cada captura gasta bastantes tokens: usala solo para revisar al final. (Gradientes aproximados a color sólido, tipografía genérica.)',
    inputSchema: {
      documentId: z.string(),
      nodeId: z.string().describe('Id de página o frame'),
      scale: z.number().min(0.1).max(3).optional().describe('Por defecto 0.5 (alcanza para revisar y gasta menos)'),
      maxSide: z.number().int().min(200).max(2000).optional().describe('Lado máximo en px, por defecto 1000'),
    },
  }, async ({ documentId, nodeId, scale = 0.5, maxSide = 1000 }) => {
    try {
      const doc = getDoc(documentId);
      const { png, svg, width, height } = await nodeToPng(doc, nodeId, scale, maxSide);
      if (!png) return text(`No se pudo generar PNG; SVG:\n${svg}`);
      return {
        content: [
          { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: `${width}×${height}px` },
        ],
      };
    } catch (e) { return fail(e); }
  });

  server.registerTool('export_node_json', {
    title: 'Exportar JSON',
    description: 'Devuelve el nodo con sus hijos como especificación anidada. Para copiarlo a otro lado es más barato usar duplicate_nodes con parentId.',
    inputSchema: { documentId: z.string(), nodeId: z.string(), includeImages: z.boolean().optional().describe('Incluir imágenes embebidas (muy pesado). Por defecto no.') },
  }, async ({ documentId, nodeId, includeImages = false }) => {
    try {
      const doc = getDoc(documentId);
      if (!doc.nodes[nodeId]) throw new Error(`No existe el nodo ${nodeId}`);
      const spec = toSpec(doc, nodeId, false);
      return text(JSON.stringify(includeImages ? spec : stripImages(spec)));
    } catch (e) { return fail(e); }
  });

  return server;
}

export function mountMcp(app, token) {
  const path = token ? '/mcp/:token' : '/mcp';
  const guard = (req, res, next) => {
    if (token && req.params.token !== token) return res.status(404).json({ error: 'No encontrado' });
    next();
  };
  app.post(path, guard, async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp]', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Error interno' }, id: null });
    }
  });
  const notAllowed = (req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Método no permitido' }, id: null });
  app.get(path, guard, notAllowed);
  app.delete(path, guard, notAllowed);
  return token ? '/mcp/<ACCESS_TOKEN>' : '/mcp';
}

