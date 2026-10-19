// Convierte un nodo (página, frame, lo que sea) a SVG y, si está disponible, a PNG.
// Así Claude puede "ver" el diseño por MCP con get_screenshot.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageOf } from './doc.js';

const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fonts');
const FONT_FILES = ['Regular', 'Bold', 'Italic', 'BoldItalic'].map((s) => path.join(FONT_DIR, `LiberationSans-${s}.ttf`));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Si fill es un gradiente CSS, nos quedamos con el primer color (aproximación).
function solid(color) {
  if (!color) return 'none';
  const c = String(color).trim();
  if (!c.includes('gradient')) return c;
  const m = c.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)/);
  return m ? m[0] : 'none';
}

function parseShadow(s) {
  if (!s) return null;
  const color = (s.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)/) || ['rgba(0,0,0,0.25)'])[0];
  const nums = s.replace(color, '').match(/-?\d+(\.\d+)?/g) || [];
  const [dx = 0, dy = 4, blur = 8] = nums.map(Number);
  return { dx, dy, blur, color };
}

function wrapText(text, maxWidth, fontSize, bold) {
  const charW = fontSize * (bold ? 0.56 : 0.52);
  const maxChars = Math.max(1, Math.floor(maxWidth / charW));
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const test = line ? `${line} ${word}` : word;
      if (test.length > maxChars && line) { lines.push(line); line = word; } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

let defsCounter = 0;

function renderNode(doc, node, defs, images) {
  if (!node || node.visible === false) return '';
  const w = node.width || 0, h = node.height || 0;
  const tf = [`translate(${node.x || 0} ${node.y || 0})`];
  if (node.rotation) tf.push(`rotate(${node.rotation} ${w / 2} ${h / 2})`);
  let attrs = `transform="${tf.join(' ')}"`;
  if (node.opacity !== undefined && node.opacity < 1) attrs += ` opacity="${node.opacity}"`;

  const shadow = parseShadow(node.shadow);
  let filterAttr = '';
  if (shadow) {
    const fid = `s${++defsCounter}`;
    defs.push(`<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${shadow.dx}" dy="${shadow.dy}" stdDeviation="${shadow.blur / 2}" flood-color="${esc(shadow.color)}"/></filter>`);
    filterAttr = ` filter="url(#${fid})"`;
  }
  const strokeAttr = node.stroke ? ` stroke="${esc(solid(node.stroke))}" stroke-width="${node.strokeWidth || 1}"` : '';
  const r = node.cornerRadius || 0;

  switch (node.type) {
    case 'FRAME':
    case 'GROUP': {
      let inner = '';
      if (node.fill || node.stroke) inner += `<rect width="${w}" height="${h}" rx="${r}" fill="${esc(solid(node.fill))}"${strokeAttr}${filterAttr}/>`;
      let kids = (node.children || []).map((id) => renderNode(doc, doc.nodes[id], defs, images)).join('');
      if (node.clipsContent) {
        const cid = `c${++defsCounter}`;
        defs.push(`<clipPath id="${cid}"><rect width="${w}" height="${h}" rx="${r}"/></clipPath>`);
        kids = `<g clip-path="url(#${cid})">${kids}</g>`;
      }
      return `<g ${attrs}>${inner}${kids}</g>`;
    }
    case 'RECTANGLE':
      return `<g ${attrs}><rect width="${w}" height="${h}" rx="${r}" fill="${esc(solid(node.fill))}"${strokeAttr}${filterAttr}/></g>`;
    case 'ELLIPSE':
      return `<g ${attrs}><ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${esc(solid(node.fill))}"${strokeAttr}${filterAttr}/></g>`;
    case 'LINE':
      return `<g ${attrs}><line x1="0" y1="0" x2="${w}" y2="${h}" stroke="${esc(solid(node.stroke || '#000'))}" stroke-width="${node.strokeWidth || 1}" stroke-linecap="round"/></g>`;
    case 'IMAGE': {
      const href = images.get(node.src) || node.src;
      const cid = `c${++defsCounter}`;
      defs.push(`<clipPath id="${cid}"><rect width="${w}" height="${h}" rx="${r}"/></clipPath>`);
      const par = node.fit === 'contain' ? 'xMidYMid meet' : node.fit === 'fill' ? 'none' : 'xMidYMid slice';
      const img = href && href.startsWith('data:') ? `<image href="${esc(href)}" width="${w}" height="${h}" preserveAspectRatio="${par}"/>` : '';
      return `<g ${attrs}><g clip-path="url(#${cid})"${filterAttr}>${node.fill ? `<rect width="${w}" height="${h}" fill="${esc(solid(node.fill))}"/>` : ''}${img}</g>${node.stroke ? `<rect width="${w}" height="${h}" rx="${r}" fill="none"${strokeAttr}/>` : ''}</g>`;
    }
    case 'TEXT': {
      const fs = node.fontSize || 16;
      const bold = (node.fontWeight || 400) >= 600;
      const lines = wrapText(node.text || '', w || 9999, fs, bold);
      const lh = fs * (node.lineHeight || 1.3);
      const anchor = node.textAlign === 'center' ? 'middle' : node.textAlign === 'right' ? 'end' : 'start';
      const tx = anchor === 'middle' ? w / 2 : anchor === 'end' ? w : 0;
      const total = lines.length * lh;
      const offY = node.verticalAlign === 'middle' ? (h - total) / 2 : node.verticalAlign === 'bottom' ? h - total : 0;
      const tspans = lines.map((l, i) => `<tspan x="${tx}" y="${offY + i * lh + (lh - fs) / 2 + fs * 0.82}">${esc(l)}</tspan>`).join('');
      return `<g ${attrs}><text font-family="Liberation Sans, Arial, sans-serif" font-size="${fs}" font-weight="${bold ? 700 : 400}"${node.italic ? ' font-style="italic"' : ''}${node.underline ? ' text-decoration="underline"' : ''} letter-spacing="${node.letterSpacing || 0}" text-anchor="${anchor}" fill="${esc(solid(node.fill))}">${tspans}</text></g>`;
    }
    default:
      return '';
  }
}

async function prefetchImages(doc, rootId) {
  const images = new Map();
  const stack = [rootId];
  const urls = new Set();
  while (stack.length) {
    const n = doc.nodes[stack.pop()];
    if (!n) continue;
    if (n.type === 'IMAGE' && n.src && /^https?:/.test(n.src)) urls.add(n.src);
    if (n.children) stack.push(...n.children);
  }
  await Promise.all([...urls].slice(0, 30).map(async (url) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return;
      const type = res.headers.get('content-type') || 'image/png';
      const buf = Buffer.from(await res.arrayBuffer());
      images.set(url, `data:${type};base64,${buf.toString('base64')}`);
    } catch { /* imagen no disponible: se dibuja el placeholder */ }
  }));
  return images;
}

// Devuelve { svg, width, height } del nodo pedido (o de toda la página).
export async function nodeToSvg(doc, nodeId) {
  const node = doc.nodes[nodeId];
  if (!node) throw new Error(`No existe el nodo ${nodeId}`);
  const images = await prefetchImages(doc, nodeId);
  const defs = [];
  let body, width, height, bg = null;

  if (node.type === 'PAGE' || node.type === 'DOCUMENT') {
    const page = node.type === 'PAGE' ? node : doc.nodes[doc.nodes[doc.rootId].children[0]];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of page.children) {
      const c = doc.nodes[id];
      if (!c || c.visible === false) continue;
      minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + c.width); maxY = Math.max(maxY, c.y + c.height);
    }
    if (minX === Infinity) { minX = 0; minY = 0; maxX = 400; maxY = 300; }
    const pad = 40;
    width = maxX - minX + pad * 2; height = maxY - minY + pad * 2;
    bg = page.background || '#F5F5F5';
    body = `<g transform="translate(${pad - minX} ${pad - minY})">${page.children.map((id) => renderNode(doc, doc.nodes[id], defs, images)).join('')}</g>`;
  } else {
    width = Math.max(1, node.width); height = Math.max(1, node.height);
    body = renderNode(doc, { ...node, x: 0, y: 0, rotation: 0 }, defs, images);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${defs.join('')}</defs>${bg ? `<rect width="100%" height="100%" fill="${esc(bg)}"/>` : ''}${body}</svg>`;
  return { svg, width, height, page: pageOf(doc, nodeId) };
}

let Resvg = null;
let resvgTried = false;
async function loadResvg() {
  if (resvgTried) return Resvg;
  resvgTried = true;
  try { ({ Resvg } = await import('@resvg/resvg-js')); } catch (e) { console.warn('[render] resvg no disponible, solo SVG'); }
  return Resvg;
}

export async function nodeToPng(doc, nodeId, scale = 1, maxSide = 1600) {
  const { svg, width, height } = await nodeToSvg(doc, nodeId);
  const R = await loadResvg();
  if (!R) return { svg, png: null, width, height };
  const s = Math.min(scale, maxSide / Math.max(width, height));
  const resvg = new R(svg, {
    fitTo: { mode: 'zoom', value: s },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Liberation Sans', sansSerifFamily: 'Liberation Sans' },
  });
  const png = resvg.render().asPng();
  return { svg, png, width: Math.round(width * s), height: Math.round(height * s) };
}
