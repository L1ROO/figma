// Convierte un SVG (por ejemplo, un frame exportado desde Figma) en capas editables de Lienzo.
// Todo pasa en el navegador: no usa a Claude ni gasta tokens.
//
// Para mejores resultados, en Figma: Export → SVG → en "…" desmarcá "Outline text"
// (así los textos quedan como texto) y marcá "Include 'id' attribute" (así se conservan
// los nombres de las capas).

const SKIP = new Set(['defs', 'clipPath', 'mask', 'pattern', 'linearGradient', 'radialGradient', 'filter', 'style', 'title', 'desc', 'metadata', 'symbol', 'script', 'foreignObject']);
const VECTOR = new Set(['path', 'polygon', 'polyline', 'circle', 'ellipse', 'line', 'rect', 'g', 'use']);
const r2 = (n) => Math.round(n * 100) / 100;

// Carga las fuentes que usa el SVG antes de medir los textos (así los anchos salen bien).
export async function loadSvgFonts(text, ensureFont) {
  const fams = new Set();
  for (const m of text.matchAll(/font-family(?:=|:)\s*["']?([^"';>]+)/g)) fams.add(m[1].split(',')[0].replace(/["']|&quot;/g, '').trim());
  const loads = [];
  for (const f of fams) {
    if (!f) continue;
    ensureFont(f);
    for (const w of [400, 700]) loads.push(document.fonts.load(`${w} 16px "${f}"`).catch(() => {}));
  }
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 4000))]);
}

export function importSvg(text, name = 'Importado') {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  const src = parsed.documentElement;
  if (src.localName !== 'svg' || parsed.querySelector('parsererror')) throw new Error('El archivo no es un SVG válido');

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-200000px;top:0;opacity:0;pointer-events:none;';
  const svg = document.importNode(src, true);
  const vb = svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width ? svg.viewBox.baseVal : null;
  const W = vb ? vb.width : parseFloat(svg.getAttribute('width')) || 1000;
  const H = vb ? vb.height : parseFloat(svg.getAttribute('height')) || 1000;
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  // Valores iniciales de SVG (para que no se cuelen los estilos de la página)
  svg.style.cssText = `fill:${svg.getAttribute('fill') || 'black'};stroke:${svg.getAttribute('stroke') || 'none'};stroke-width:${svg.getAttribute('stroke-width') || 1};stroke-linecap:butt;stroke-linejoin:miter;font-family:sans-serif;`;
  host.append(svg);
  document.body.append(host);

  try {
    const ctx = new Ctx(svg, W, H);
    const kids = ctx.walk(svg, { opacity: 1, shadow: null });
    const frame = { type: 'FRAME', name, x: 0, y: 0, width: r2(W), height: r2(H), fill: null, clipsContent: true, children: kids };
    // Figma envuelve todo en un grupo con el nombre del frame: lo aplanamos
    const only = kids.length === 1 ? kids[0] : null;
    if (only && only.children && Math.abs(only.width - W) < 1 && Math.abs(only.height - H) < 1 && Math.abs(only.x) < 1 && Math.abs(only.y) < 1) {
      frame.name = only.name || name;
      frame.children = only.children;
      if (only.fill) frame.fill = only.fill;
      if (only.cornerRadius) frame.cornerRadius = only.cornerRadius;
    }
    absorbBackground(frame);
    relativize(frame, 0, 0);
    return frame;
  } finally {
    host.remove();
  }
}

class Ctx {
  constructor(svg, W, H) { this.svg = svg; this.W = W; this.H = H; }

  byRef(value) {
    const m = /url\(\s*["']?#([^"')]+)["']?\s*\)/.exec(value || '');
    if (!m) return null;
    try { return this.svg.querySelector('#' + CSS.escape(m[1])); } catch { return null; }
  }

  // Posición absoluta (en coordenadas del SVG raíz)
  geom(el) {
    const b = el.getBBox();
    const m = el.getCTM();
    if (!m) return { x: b.x, y: b.y, w: b.width, h: b.height, rotation: 0, sx: 1, sy: 1 };
    const rotation = Math.atan2(m.b, m.a) * 180 / Math.PI;
    const sx = Math.hypot(m.a, m.b), sy = Math.hypot(m.c, m.d);
    if (Math.abs(rotation) > 0.05) {
      const c = pt(m, b.x + b.width / 2, b.y + b.height / 2);
      const w = b.width * sx, h = b.height * sy;
      return { x: c.x - w / 2, y: c.y - h / 2, w, h, rotation, sx, sy };
    }
    const p = [pt(m, b.x, b.y), pt(m, b.x + b.width, b.y), pt(m, b.x, b.y + b.height), pt(m, b.x + b.width, b.y + b.height)];
    const xs = p.map((q) => q.x), ys = p.map((q) => q.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, rotation: 0, sx, sy };
  }

  paint(el, which) {
    const cs = getComputedStyle(el);
    const v = cs[which];
    if (!v || v === 'none') return null;
    if (v.startsWith('url')) {
      const ref = this.byRef(v);
      if (!ref) return null;
      if (ref.localName === 'linearGradient' || ref.localName === 'radialGradient') return { css: this.gradient(ref) };
      if (ref.localName === 'pattern') {
        const img = this.patternImage(ref);
        return img ? { image: img } : null;
      }
      return null;
    }
    const a = parseFloat(which === 'fill' ? cs.fillOpacity : cs.strokeOpacity);
    return { css: color(v, Number.isFinite(a) ? a : 1) };
  }

  gradient(g) {
    const stops = [...g.querySelectorAll('stop')].map((s) => {
      const cs = getComputedStyle(s);
      const off = parseFloat(s.getAttribute('offset') || '0');
      const pct = String(s.getAttribute('offset') || '').includes('%') ? off : off * 100;
      return `${color(cs.stopColor, parseFloat(cs.stopOpacity))} ${r2(pct)}%`;
    });
    if (!stops.length) return null;
    if (stops.length === 1) stops.push(stops[0]);
    if (g.localName === 'radialGradient') return `radial-gradient(circle, ${stops.join(', ')})`;
    const num = (a, d) => { const v = g.getAttribute(a); if (v === null) return d; return v.includes('%') ? parseFloat(v) / 100 : parseFloat(v); };
    let x1 = num('x1', 0), y1 = num('y1', 0), x2 = num('x2', 1), y2 = num('y2', 0);
    const t = g.gradientTransform?.baseVal?.consolidate?.();
    if (t) { const a = pt(t.matrix, x1, y1), b = pt(t.matrix, x2, y2); x1 = a.x; y1 = a.y; x2 = b.x; y2 = b.y; }
    const angle = ((Math.atan2(x2 - x1, -(y2 - y1)) * 180 / Math.PI) % 360 + 360) % 360;
    return `linear-gradient(${Math.round(angle)}deg, ${stops.join(', ')})`;
  }

  patternImage(p) {
    const use = p.querySelector('use');
    let img = use ? this.svg.querySelector(use.getAttribute('href') || use.getAttribute('xlink:href') || '#none') : p.querySelector('image');
    if (img && img.localName !== 'image') img = img.querySelector('image');
    return img ? img.getAttribute('href') || img.getAttribute('xlink:href') : null;
  }

  // Sombras de Figma: cadena feOffset + feGaussianBlur + feColorMatrix
  shadow(el) {
    const f = this.byRef(el.getAttribute('filter') || getComputedStyle(el).filter);
    if (!f || f.localName !== 'filter') return null;
    const list = [];
    let cur = null;
    for (const c of f.children) {
      if (c.localName === 'feOffset') {
        cur = { dx: +c.getAttribute('dx') || 0, dy: +c.getAttribute('dy') || 0, blur: 0, color: 'rgba(0,0,0,0.25)', inset: false };
        list.push(cur);
      } else if (cur && c.localName === 'feGaussianBlur') cur.blur = (+c.getAttribute('stdDeviation') || 0) * 2;
      else if (cur && c.localName === 'feComposite' && c.getAttribute('operator') === 'arithmetic') cur.inset = true;
      else if (cur && c.localName === 'feColorMatrix' && c.getAttribute('type') === 'matrix') {
        const v = (c.getAttribute('values') || '').trim().split(/[\s,]+/).map(Number);
        if (v.length === 20 && v[18] !== 127) cur.color = `rgba(${Math.round(v[4] * 255)},${Math.round(v[9] * 255)},${Math.round(v[14] * 255)},${r2(v[18])})`;
      } else if (c.localName === 'feMorphology' && cur) cur.spread = +c.getAttribute('radius') || 0;
    }
    if (!list.length) return null;
    return list.map((s) => `${s.inset ? 'inset ' : ''}${r2(s.dx)}px ${r2(s.dy)}px ${r2(s.blur)}px ${s.spread ? r2(s.spread) + 'px ' : ''}${s.color}`).join(', ');
  }

  layerName(el) {
    const id = el.getAttribute('id');
    if (!id || /^(clip|paint|filter|pattern|image|mask|path|rect|circle|g)\d/.test(id)) return null;
    return id.replace(/_(\d+)$/, '').replace(/_/g, ' ').trim() || null;
  }

  isVectorOnly(g) {
    let n = 0;
    for (const d of g.querySelectorAll('*')) {
      if (SKIP.has(d.localName) || d.closest('defs,clipPath,mask,pattern')) continue;
      if (!VECTOR.has(d.localName)) return false;
      if (d.localName === 'rect' && this.paint(d, 'fill')?.image) return false;
      if (++n > 80) return false;
    }
    return n > 0;
  }

  walk(parent, ctx) {
    const out = [];
    for (const el of parent.children) {
      const tag = el.localName;
      if (SKIP.has(tag)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const opacity = ctx.opacity * (parseFloat(cs.opacity) || (cs.opacity === '0' ? 0 : 1));
      if (opacity <= 0.001) continue;
      const shadow = this.shadow(el) || null;
      const name = this.layerName(el);
      const inherited = { opacity, shadow: shadow ? { value: shadow, used: false } : ctx.shadow };

      try {
        if (tag === 'g' || tag === 'a' || tag === 'svg' || tag === 'switch') {
          out.push(...this.group(el, name, inherited));
          continue;
        }
        const spec = this.shape(el, tag, name, inherited);
        if (spec) out.push(spec);
      } catch (e) { console.warn('[importar] se omitió un elemento', el, e); }
    }
    return out;
  }

  group(el, name, ctx) {
    const box = this.geom(el);
    if (!box.w && !box.h) return [];
    // Íconos: un grupo chico hecho solo de vectores queda como una imagen SVG
    if (box.w <= 160 && box.h <= 160 && this.isVectorOnly(el)) return [this.vector(el, name || 'Ícono', ctx)];

    const clip = this.byRef(el.getAttribute('clip-path'));
    const kids = this.walk(el, ctx);
    if (clip && clip.children.length === 1 && clip.firstElementChild.localName === 'rect') {
      const cr = clip.firstElementChild;
      const m = el.getCTM();
      const x = +cr.getAttribute('x') || 0, y = +cr.getAttribute('y') || 0, w = +cr.getAttribute('width') || 0, h = +cr.getAttribute('height') || 0;
      const a = pt(m, x, y), b = pt(m, x + w, y + h);
      const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
      const whole = rect.x <= 0.5 && rect.y <= 0.5 && rect.w >= this.W - 1 && rect.h >= this.H - 1;
      if (!whole && kids.length) {
        const frame = { type: 'FRAME', name: name || 'Frame', x: r2(rect.x), y: r2(rect.y), width: r2(rect.w), height: r2(rect.h), fill: null, clipsContent: true, cornerRadius: r2(+cr.getAttribute('rx') || 0), children: kids };
        absorbBackground(frame);
        return [frame];
      }
    }
    if (name && kids.length > 1) {
      const b = boundsOf(kids);
      return [{ type: 'GROUP', name, x: b.x, y: b.y, width: b.w, height: b.h, fill: null, children: kids }];
    }
    if (name && kids.length === 1 && !kids[0].children) kids[0].name = name;
    return kids;
  }

  common(el, spec, ctx) {
    if (ctx.opacity < 0.999) spec.opacity = r2(ctx.opacity);
    if (ctx.shadow && !ctx.shadow.used && spec.type !== 'TEXT' && spec.type !== 'LINE') { spec.shadow = ctx.shadow.value; ctx.shadow.used = true; }
    return spec;
  }

  shape(el, tag, name, ctx) {
    if (tag === 'text') return this.common(el, this.text(el, name), ctx);
    if (tag === 'image') {
      const g = this.geom(el);
      const par = el.getAttribute('preserveAspectRatio') || '';
      const spec = { type: 'IMAGE', name: name || 'Imagen', x: r2(g.x), y: r2(g.y), width: r2(g.w), height: r2(g.h), rotation: r2(g.rotation), fill: null,
        src: el.getAttribute('href') || el.getAttribute('xlink:href') || '', fit: par.includes('slice') ? 'cover' : par === 'none' ? 'fill' : 'contain' };
      return this.common(el, spec, ctx);
    }
    if (tag === 'line') {
      const m = el.getCTM();
      const a = pt(m, +el.getAttribute('x1') || 0, +el.getAttribute('y1') || 0);
      const b = pt(m, +el.getAttribute('x2') || 0, +el.getAttribute('y2') || 0);
      const stroke = this.paint(el, 'stroke');
      return this.common(el, { type: 'LINE', name: name || 'Línea', x: r2(a.x), y: r2(a.y), width: r2(b.x - a.x), height: r2(b.y - a.y), stroke: stroke?.css || '#000000', strokeWidth: r2(parseFloat(getComputedStyle(el).strokeWidth) || 1) }, ctx);
    }
    if (tag === 'rect' || tag === 'circle' || tag === 'ellipse') {
      const fill = this.paint(el, 'fill');
      const stroke = this.paint(el, 'stroke');
      const g = this.geom(el);
      if (!g.w || !g.h) return null;
      if (fill?.image) {
        return this.common(el, { type: 'IMAGE', name: name || 'Imagen', x: r2(g.x), y: r2(g.y), width: r2(g.w), height: r2(g.h), rotation: r2(g.rotation), src: fill.image, fit: 'cover', fill: null, cornerRadius: r2((+el.getAttribute('rx') || 0) * g.sx) }, ctx);
      }
      const spec = { type: tag === 'rect' ? 'RECTANGLE' : 'ELLIPSE', name: name || (tag === 'rect' ? 'Rectángulo' : 'Elipse'), x: r2(g.x), y: r2(g.y), width: r2(g.w), height: r2(g.h), fill: fill?.css || null };
      if (g.rotation) spec.rotation = r2(g.rotation);
      if (tag === 'rect') {
        const rx = parseFloat(el.getAttribute('rx') || el.getAttribute('ry') || '0');
        if (rx) spec.cornerRadius = r2(rx * g.sx);
      }
      if (stroke?.css) { spec.stroke = stroke.css; spec.strokeWidth = r2((parseFloat(getComputedStyle(el).strokeWidth) || 1) * g.sx); }
      return this.common(el, spec, ctx);
    }
    // path, polygon, polyline, use… → imagen vectorial
    return this.vector(el, name, ctx);
  }

  text(el, name) {
    // Medir con la misma fuente de respaldo que usa el lienzo (sans-serif) si la fuente no está
    const fam0 = getComputedStyle(el).fontFamily;
    if (!/sans-serif|serif|monospace/.test(fam0)) el.style.fontFamily = `${fam0}, Inter, sans-serif`;
    const cs = getComputedStyle(el);
    const m = el.getCTM();
    const s = m ? Math.hypot(m.a, m.b) : 1;
    const fontSize = parseFloat(cs.fontSize) || 16;
    const anchor = cs.textAnchor;
    const raw = [];
    const tspans = el.querySelectorAll('tspan');
    if (tspans.length) {
      for (const t of tspans) {
        const y = t.y.baseVal.numberOfItems ? t.y.baseVal.getItem(0).value : null;
        const x = t.x.baseVal.numberOfItems ? t.x.baseVal.getItem(0).value : null;
        raw.push({ x, y, text: t.textContent, w: t.getComputedTextLength() });
      }
    } else {
      raw.push({ x: el.x.baseVal.numberOfItems ? el.x.baseVal.getItem(0).value : 0, y: el.y.baseVal.numberOfItems ? el.y.baseVal.getItem(0).value : 0, text: el.textContent, w: el.getComputedTextLength() });
    }
    // Unir fragmentos que están en el mismo renglón
    const lines = [];
    for (const r of raw) {
      const last = lines[lines.length - 1];
      if (last && (r.y === null || Math.abs(r.y - last.y) < 0.5)) { last.text += r.text; last.w += r.w; if (r.x !== null) last.x2 = r.x + r.w; }
      else lines.push({ x: r.x ?? 0, y: r.y ?? (last ? last.y : 0), text: r.text, w: r.w, x2: (r.x ?? 0) + r.w });
    }
    const lh = lines.length > 1 ? (lines[lines.length - 1].y - lines[0].y) / (lines.length - 1) : fontSize * 1.21;
    const lineHeight = lh / fontSize;
    // Alineación
    let align = anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left';
    if (align === 'left' && lines.length > 1) {
      const xs = lines.map((l) => l.x);
      if (Math.max(...xs) - Math.min(...xs) > 1) {
        const centers = lines.map((l) => l.x + l.w / 2);
        const rights = lines.map((l) => l.x + l.w);
        if (Math.max(...centers) - Math.min(...centers) < 2) align = 'center';
        else if (Math.max(...rights) - Math.min(...rights) < 2) align = 'right';
      }
    }
    const maxW = Math.max(...lines.map((l) => l.w));
    const width = maxW * 1.06 + 4;
    let left;
    if (align === 'center') left = (anchor === 'middle' ? lines[0].x : lines[0].x + lines[0].w / 2) - width / 2;
    else if (align === 'right') left = (anchor === 'end' ? lines[0].x : lines[0].x + lines[0].w) - width;
    else left = Math.min(...lines.map((l) => l.x));
    const top = lines[0].y - ((lh - 1.16 * fontSize) / 2 + 0.92 * fontSize);
    const p = m ? pt(m, left, top) : { x: left, y: top };
    const fill = this.paint(el, 'fill');
    const weight = parseInt(cs.fontWeight, 10) || (cs.fontWeight === 'bold' ? 700 : 400);
    const ls = parseFloat(cs.letterSpacing);
    const family = (fam0 || 'Inter').split(',')[0].replace(/["']/g, '').trim();
    const text = lines.map((l) => l.text).join('\n');
    const spec = {
      type: 'TEXT', name: name || text.slice(0, 40) || 'Texto', text,
      x: r2(p.x), y: r2(p.y), width: r2(width * s), height: r2(lh * lines.length * s),
      fontSize: r2(fontSize * s), fontFamily: family, fontWeight: weight, lineHeight: r2(lineHeight),
      textAlign: align, fill: fill?.css || '#000000',
    };
    if (Number.isFinite(ls) && ls) spec.letterSpacing = r2(ls * s);
    if (cs.fontStyle === 'italic') spec.italic = true;
    if ((cs.textDecorationLine || cs.textDecoration || '').includes('underline')) spec.underline = true;
    if (m && Math.abs(Math.atan2(m.b, m.a)) > 0.001) spec.rotation = r2(Math.atan2(m.b, m.a) * 180 / Math.PI);
    return spec;
  }

  // Cualquier forma compleja → imagen SVG recortada a su tamaño
  vector(el, name, ctx) {
    const g = this.geom(el);
    const cs = getComputedStyle(el);
    const strokeW = cs.stroke && cs.stroke !== 'none' ? parseFloat(cs.strokeWidth) || 1 : 0;
    const pad = strokeW / 2 + 1;
    const x = g.x - pad, y = g.y - pad, w = g.w + pad * 2, h = g.h + pad * 2;
    const clone = el.cloneNode(true);
    clone.removeAttribute('transform');
    clone.removeAttribute('filter');
    clone.removeAttribute('opacity');
    const m = el.getCTM();
    const parentCs = el.parentElement ? getComputedStyle(el.parentElement) : cs;
    const wrapper = `<g transform="matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})" fill="${attr(parentCs.fill)}" stroke="${attr(parentCs.stroke)}">${new XMLSerializer().serializeToString(clone)}</g>`;
    const defs = this.collectDefs(clone);
    const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${r2(w)}" height="${r2(h)}" viewBox="${r2(x)} ${r2(y)} ${r2(w)} ${r2(h)}">${defs ? `<defs>${defs}</defs>` : ''}${wrapper}</svg>`;
    const spec = { type: 'IMAGE', name: name || (el.localName === 'g' ? 'Ícono' : 'Vector'), x: r2(x), y: r2(y), width: r2(w), height: r2(h), fill: null, fit: 'fill', src: 'data:image/svg+xml;base64,' + b64(svgStr) };
    return this.common(el, spec, ctx);
  }

  collectDefs(node) {
    const seen = new Set();
    const out = [];
    const scan = (n) => {
      const html = n.outerHTML || new XMLSerializer().serializeToString(n);
      for (const mm of html.matchAll(/url\(\s*["']?#([^"')]+)["']?\s*\)|href="#([^"]+)"/g)) {
        const id = mm[1] || mm[2];
        if (seen.has(id)) continue;
        seen.add(id);
        let ref = null;
        try { ref = this.svg.querySelector('#' + CSS.escape(id)); } catch { /* id raro */ }
        if (!ref) continue;
        out.push(new XMLSerializer().serializeToString(ref));
        scan(ref);
      }
    };
    scan(node);
    return out.join('');
  }
}

function pt(m, x, y) { return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }; }

function color(c, alpha = 1) {
  const m = /rgba?\(([^)]+)\)/.exec(c || '');
  if (!m) return c;
  const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  const A = a * (Number.isFinite(alpha) ? alpha : 1);
  if (A >= 0.999) return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  return `rgba(${r},${g},${b},${r2(A)})`;
}

function attr(v) { return String(v || 'none').replace(/"/g, "'"); }

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function boundsOf(specs) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const s of specs) { x1 = Math.min(x1, s.x); y1 = Math.min(y1, s.y); x2 = Math.max(x2, s.x + Math.abs(s.width)); y2 = Math.max(y2, s.y + Math.abs(s.height)); }
  return { x: r2(x1), y: r2(y1), w: r2(x2 - x1), h: r2(y2 - y1) };
}

// Si el primer hijo es un rectángulo que ocupa todo el frame, pasa a ser el fondo del frame.
function absorbBackground(frame) {
  const first = frame.children[0];
  if (!first || first.type !== 'RECTANGLE' || first.rotation) return;
  const near = (a, b) => Math.abs(a - b) < 1;
  if (near(first.x, frame.x) && near(first.y, frame.y) && near(first.width, frame.width) && near(first.height, frame.height)) {
    frame.fill = first.fill;
    if (first.cornerRadius) frame.cornerRadius = first.cornerRadius;
    if (first.stroke) { frame.stroke = first.stroke; frame.strokeWidth = first.strokeWidth; }
    if (first.shadow) frame.shadow = first.shadow;
    frame.children.shift();
  }
}

// Pasa de coordenadas absolutas a relativas al padre (como las guarda Lienzo).
function relativize(node, px, py) {
  const ax = node.x, ay = node.y;
  node.x = r2(ax - px);
  node.y = r2(ay - py);
  for (const c of node.children || []) relativize(c, ax, ay);
}
