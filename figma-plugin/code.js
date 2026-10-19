// Plugin "Lienzo → Figma": crea en Figma las capas de un diseño de Lienzo con sus
// interacciones de prototipo (navegar, volver, overlays, links, scroll, después de un tiempo)
// y convierte los estilos de hover/presionar en componentes con variantes.
// Sin sintaxis moderna (?. ?? ...) para máxima compatibilidad con el sandbox de Figma.

figma.showUI(__html__, { width: 380, height: 330, themeColors: true });

figma.clientStorage.getAsync('lienzoLink').then(function (link) {
  figma.ui.postMessage({ type: 'init', link: link || '' });
});

figma.ui.onmessage = function (msg) {
  if (msg.type !== 'import') return;
  figma.clientStorage.setAsync('lienzoLink', msg.link);
  importAll(msg).then(function (r) {
    figma.ui.postMessage({ type: 'done', text: r });
    figma.notify('Diseño de Lienzo importado');
  }).catch(function (e) {
    console.error(e);
    figma.ui.postMessage({ type: 'error', message: String((e && e.message) || e) });
  });
};

function progress(t) { figma.ui.postMessage({ type: 'progress', text: t }); }

// ---------------- Colores, degradados y sombras ----------------
var NAMED = { white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff', gray: '#808080', grey: '#808080', transparent: 'rgba(0,0,0,0)' };

function parseColor(str) {
  if (!str) return null;
  var s = String(str).trim().toLowerCase();
  if (NAMED[s]) s = NAMED[s];
  var m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    var h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
    var a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255, a: a };
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    var p = m[1].split(/[\s,\/]+/).filter(Boolean).map(function (v) { return v.indexOf('%') >= 0 ? parseFloat(v) * 2.55 : parseFloat(v); });
    return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p.length > 3 ? (String(m[1]).indexOf('%') >= 0 && p[3] > 1 ? p[3] / 255 : p[3]) : 1 };
  }
  m = /^hsla?\(([^)]+)\)$/.exec(s);
  if (m) {
    var q = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
    var H = q[0] / 360, S = q[1] / 100, L = q[2] / 100;
    var f = function (n) { var k = (n + H * 12) % 12; return L - S * Math.min(L, 1 - L) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return { r: f(0), g: f(8), b: f(4), a: q.length > 3 ? q[3] : 1 };
  }
  return null;
}

// Separa por comas que no estén dentro de paréntesis
function splitTop(s) {
  var out = [], depth = 0, cur = '';
  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function gradientPaint(str) {
  var m = /^(linear|radial)-gradient\((.*)\)$/i.exec(String(str).trim());
  if (!m) return null;
  var args = splitTop(m[2]);
  var angle = 180;
  var first = args[0].toLowerCase();
  if (/deg$/.test(first)) { angle = parseFloat(first); args.shift(); }
  else if (/^to /.test(first)) { angle = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 }[first] || 180; args.shift(); }
  else if (m[1] === 'radial' && !parseColor(first.split(' ')[0])) args.shift();
  var stops = args.map(function (a, i) {
    var cm = /(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+)/i.exec(a);
    var c = parseColor(cm ? cm[1] : '#000') || { r: 0, g: 0, b: 0, a: 1 };
    var pm = /(-?[\d.]+)%/.exec(a.replace(cm ? cm[1] : '', ''));
    return { color: { r: c.r, g: c.g, b: c.b, a: c.a }, position: pm ? Math.max(0, Math.min(1, parseFloat(pm[1]) / 100)) : (args.length > 1 ? i / (args.length - 1) : 0) };
  });
  if (stops.length < 2) return null;
  if (m[1].toLowerCase() === 'radial') {
    return { type: 'GRADIENT_RADIAL', gradientStops: stops, gradientTransform: [[1, 0, 0], [0, 1, 0]] };
  }
  // Ángulo CSS (0 = hacia arriba) → transform de Figma (0 = izquierda a derecha)
  var a = (angle - 90) * Math.PI / 180;
  var cos = Math.cos(a), sin = Math.sin(a);
  return {
    type: 'GRADIENT_LINEAR', gradientStops: stops,
    gradientTransform: [[cos, sin, 0.5 - cos / 2 - sin / 2], [-sin, cos, 0.5 + sin / 2 - cos / 2]],
  };
}

function paints(value) {
  if (!value) return [];
  if (String(value).indexOf('gradient') >= 0) { var g = gradientPaint(value); return g ? [g] : []; }
  var c = parseColor(value);
  if (!c) return [];
  return [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }];
}

function effects(shadow) {
  if (!shadow) return [];
  return splitTop(String(shadow)).map(function (part) {
    var inset = /\binset\b/.test(part);
    var cm = /(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))/i.exec(part);
    var c = parseColor(cm ? cm[1] : 'rgba(0,0,0,0.25)') || { r: 0, g: 0, b: 0, a: 0.25 };
    var nums = (part.replace(cm ? cm[1] : '', '').match(/-?[\d.]+/g) || []).map(parseFloat);
    return {
      type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW', visible: true, blendMode: 'NORMAL',
      color: { r: c.r, g: c.g, b: c.b, a: c.a },
      offset: { x: nums[0] || 0, y: nums[1] || 0 }, radius: nums[2] || 0, spread: nums[3] || 0,
    };
  });
}

// ---------------- Fuentes ----------------
var fontCache = {};
var STYLE_NAMES = {
  100: ['Thin'], 200: ['ExtraLight', 'Extra Light'], 300: ['Light'], 400: ['Regular'], 500: ['Medium'],
  600: ['SemiBold', 'Semi Bold'], 700: ['Bold'], 800: ['ExtraBold', 'Extra Bold'], 900: ['Black'],
};
async function resolveFont(family, weight, italic) {
  var w = Math.min(900, Math.max(100, Math.round((weight || 400) / 100) * 100));
  var key = family + '|' + w + '|' + (italic ? 1 : 0);
  if (fontCache[key]) return fontCache[key];
  var names = STYLE_NAMES[w].slice();
  var tries = [];
  names.forEach(function (n) {
    if (italic) tries.push(n === 'Regular' ? 'Italic' : n + ' Italic');
    tries.push(n);
  });
  tries.push('Regular');
  var fams = [family, 'Inter'];
  for (var i = 0; i < fams.length; i++) {
    for (var j = 0; j < tries.length; j++) {
      var fn = { family: fams[i], style: tries[j] };
      try { await figma.loadFontAsync(fn); fontCache[key] = fn; return fn; } catch (e) { /* probar el siguiente */ }
    }
  }
  var fallback = { family: 'Inter', style: 'Regular' };
  await figma.loadFontAsync(fallback);
  fontCache[key] = fallback;
  return fallback;
}

// ---------------- Construcción de capas ----------------
function setTransform(node, s) {
  var w = s.width || 0, h = s.height || 0, rot = (s.rotation || 0) * Math.PI / 180;
  if (!rot) { node.x = s.x || 0; node.y = s.y || 0; return; }
  var cos = Math.cos(rot), sin = Math.sin(rot);
  var cx = (s.x || 0) + w / 2, cy = (s.y || 0) + h / 2;
  node.relativeTransform = [[cos, -sin, cx - (cos * w / 2 - sin * h / 2)], [sin, cos, cy - (sin * w / 2 + cos * h / 2)]];
}

async function build(s, parent, ctx) {
  var node = null;
  var t = s.type;
  var isSvg = false;
  if (t === 'FRAME' || t === 'GROUP') {
    node = figma.createFrame();
    node.fills = paints(s.fill);
    node.clipsContent = Boolean(s.clipsContent);
  } else if (t === 'RECTANGLE') {
    node = figma.createRectangle();
    node.fills = paints(s.fill);
  } else if (t === 'ELLIPSE') {
    node = figma.createEllipse();
    node.fills = paints(s.fill);
  } else if (t === 'LINE') {
    node = figma.createLine();
  } else if (t === 'TEXT') {
    node = figma.createText();
  } else if (t === 'IMAGE') {
    if (s.svg) {
      try { node = figma.createNodeFromSvg(s.svg); isSvg = true; } catch (e) { node = null; }
    }
    if (!node) {
      node = figma.createRectangle();
      var f = paints(s.fill);
      var bytes = s.imageKey ? ctx.images[s.imageKey] : null;
      if (bytes) {
        var img = figma.createImage(bytes);
        f.push({ type: 'IMAGE', imageHash: img.hash, scaleMode: s.fit === 'contain' ? 'FIT' : 'FILL' });
      } else if (!f.length) f = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }];
      node.fills = f;
    }
  } else return null;

  parent.appendChild(node);
  node.name = s.name || t;

  if (t === 'LINE') {
    var len = Math.hypot(s.width || 0, s.height || 0) || 1;
    node.resize(len, 0);
    var ang = Math.atan2(s.height || 0, s.width || 0);
    node.relativeTransform = [[Math.cos(ang), -Math.sin(ang), s.x || 0], [Math.sin(ang), Math.cos(ang), s.y || 0]];
    node.strokes = paints(s.stroke || '#000000');
    node.strokeWeight = s.strokeWidth || 1;
    node.strokeCap = 'ROUND';
  } else if (t === 'TEXT') {
    node.fontName = await resolveFont(s.fontFamily || 'Inter', s.fontWeight, s.italic);
    node.characters = s.text || '';
    node.fontSize = s.fontSize || 16;
    node.fills = paints(s.fill || '#000000');
    node.textAlignHorizontal = { left: 'LEFT', center: 'CENTER', right: 'RIGHT' }[s.textAlign] || 'LEFT';
    node.textAlignVertical = { top: 'TOP', middle: 'CENTER', bottom: 'BOTTOM' }[s.verticalAlign] || 'TOP';
    node.lineHeight = { unit: 'PERCENT', value: (s.lineHeight || 1.3) * 100 };
    if (s.letterSpacing) node.letterSpacing = { unit: 'PIXELS', value: s.letterSpacing };
    if (s.underline) node.textDecoration = 'UNDERLINE';
    node.textAutoResize = 'NONE';
    node.resize(Math.max(1, s.width || 1), Math.max(1, s.height || 1));
    if (!s.verticalAlign || s.verticalAlign === 'top') node.textAutoResize = 'HEIGHT';
    setTransform(node, s);
  } else {
    if (!isSvg) node.resize(Math.max(0.01, s.width || 0), Math.max(0.01, s.height || 0));
    setTransform(node, s);
  }

  if (t !== 'LINE' && t !== 'TEXT' && s.stroke) {
    node.strokes = paints(s.stroke);
    node.strokeWeight = s.strokeWidth || 1;
    node.strokeAlign = 'INSIDE';
  }
  if ('cornerRadius' in node && s.cornerRadius && t !== 'ELLIPSE') node.cornerRadius = s.cornerRadius;
  if (s.shadow && 'effects' in node) node.effects = effects(s.shadow);
  if (typeof s.opacity === 'number') node.opacity = s.opacity;
  if (s.visible === false) node.visible = false;
  if (s.locked) node.locked = true;

  ctx.idMap[s.id] = node;
  ctx.built.push({ spec: s, node: node });
  ctx.count++;
  if (ctx.count % 50 === 0) progress('Creando capas… ' + ctx.count);

  if ((t === 'FRAME' || t === 'GROUP') && s.children) {
    for (var i = 0; i < s.children.length; i++) await build(s.children[i], node, ctx);
  }
  return node;
}

// ---------------- Interacciones ----------------
function transition(name, position) {
  var easing = { type: 'EASE_OUT' };
  if (!name || name === 'instant') return null;
  if (name === 'slide') return { type: 'SLIDE_IN', direction: 'LEFT', matchLayers: false, easing: easing, duration: 0.3 };
  if (name === 'slideUp') return { type: 'MOVE_IN', direction: 'TOP', matchLayers: false, easing: easing, duration: 0.3 };
  return { type: 'DISSOLVE', easing: easing, duration: 0.3 };
}

function trigger(i) {
  if (i.trigger === 'hover') return { type: 'ON_HOVER' };
  if (i.trigger === 'press') return { type: 'ON_PRESS' };
  if (i.trigger === 'delay') return { type: 'AFTER_TIMEOUT', timeout: (i.delay || 800) / 1000 };
  return { type: 'ON_CLICK' };
}

function action(i, ctx) {
  var dest = i.target ? ctx.idMap[i.target] : null;
  switch (i.action) {
    case 'navigate': return dest ? { type: 'NODE', destinationId: dest.id, navigation: 'NAVIGATE', transition: transition(i.transition), preserveScrollPosition: false } : null;
    case 'back': return { type: 'BACK' };
    case 'overlay': return dest ? { type: 'NODE', destinationId: dest.id, navigation: 'OVERLAY', transition: transition(i.transition, i.position) } : null;
    case 'swap': return dest ? { type: 'NODE', destinationId: dest.id, navigation: 'SWAP', transition: transition(i.transition, i.position) } : null;
    case 'close': return { type: 'CLOSE' };
    case 'url': return i.url ? { type: 'URL', url: /^https?:/i.test(i.url) ? i.url : 'https://' + i.url } : null;
    case 'scrollTo': return dest ? { type: 'NODE', destinationId: dest.id, navigation: 'SCROLL_TO', transition: null } : null;
    default: return null;
  }
}

function interactionsOf(s) {
  var list = Array.isArray(s.interactions) ? s.interactions.slice() : [];
  var hasTap = list.some(function (i) { return i.trigger === 'tap'; });
  if (s.link && !hasTap) {
    list.unshift(s.link === 'back' ? { trigger: 'tap', action: 'back', transition: s.transition } : { trigger: 'tap', action: 'navigate', target: s.link, transition: s.transition });
  }
  return list;
}

async function setReactions(node, reactions) {
  if (!reactions.length) return;
  if (node.setReactionsAsync) await node.setReactionsAsync(reactions);
  else node.reactions = reactions;
}

function applyStyle(node, style) {
  if ('fill' in style && 'fills' in node) node.fills = paints(style.fill);
  if ('stroke' in style && 'strokes' in node) { node.strokes = paints(style.stroke); if (!node.strokeWeight) node.strokeWeight = 1; }
  if ('strokeWidth' in style && 'strokeWeight' in node) node.strokeWeight = style.strokeWidth;
  if ('opacity' in style) node.opacity = style.opacity;
  if ('shadow' in style && 'effects' in node) node.effects = effects(style.shadow);
  if ('cornerRadius' in style && 'cornerRadius' in node) node.cornerRadius = style.cornerRadius;
  if ('text' in style && node.type === 'TEXT') node.characters = String(style.text);
}

// Hover / presionar / tocar con cambio de estilo → componente con 2 variantes + CHANGE_TO
async function makeVariants(entry, styleIx, otherReactions, ctx) {
  var node = entry.node;
  var parent = node.parent;
  var index = parent.children.indexOf(node);
  var rt = node.relativeTransform;
  var origName = node.name;
  var label = { hover: 'Hover', press: 'Presionado', tap: 'Activo' }[styleIx.trigger] || 'Activo';

  var def = figma.createComponentFromNode(node);
  def.name = 'Estado=Por defecto';
  var alt = def.clone();
  alt.name = 'Estado=' + label;
  applyStyle(alt, styleIx.style || {});

  var page = figma.currentPage;
  page.appendChild(def);
  page.appendChild(alt);
  var set = figma.combineAsVariants([def, alt], page);
  set.name = origName;
  def.x = 16; def.y = 16;
  alt.x = def.width + 48; alt.y = 16;
  set.resizeWithoutConstraints(def.width + alt.width + 64, Math.max(def.height, alt.height) + 32);
  set.x = ctx.compX;
  set.y = ctx.compY;
  ctx.compY += set.height + 60;

  var inst = def.createInstance();
  parent.insertChild(Math.min(index, parent.children.length), inst);
  inst.relativeTransform = rt;
  inst.name = origName;
  ctx.idMap[entry.spec.id] = inst;

  var t = trigger(styleIx);
  var change = function (to) { return { trigger: t, actions: [{ type: 'NODE', destinationId: to.id, navigation: 'CHANGE_TO', transition: { type: 'SMART_ANIMATE', easing: { type: 'EASE_OUT' }, duration: 0.15 } }] }; };
  var defReactions = otherReactions.concat([change(alt)]);
  var altReactions = otherReactions.slice();
  if (styleIx.trigger === 'tap') altReactions.push(change(def));
  await setReactions(def, defReactions);
  await setReactions(alt, altReactions);
  ctx.variants++;
}

// ---------------- Importación ----------------
async function importAll(msg) {
  var page = figma.currentPage;
  var ctx = { idMap: {}, built: [], images: msg.images || {}, count: 0, variants: 0, skipped: 0, compX: 0, compY: 0 };

  // Ubicar debajo de lo que ya haya en la página
  var startY = 0, startX = 0;
  if (page.children.length) {
    var maxY = -Infinity, minX = Infinity;
    page.children.forEach(function (c) { maxY = Math.max(maxY, c.y + c.height); minX = Math.min(minX, c.x); });
    startY = maxY + 400; startX = minX;
  }

  var tops = [];
  var y = startY;
  var maxRight = startX;
  for (var p = 0; p < msg.pages.length; p++) {
    var lp = msg.pages[p];
    var kids = lp.children || [];
    if (!kids.length) continue;
    var minx = Infinity, miny = Infinity, maxy = -Infinity;
    kids.forEach(function (k) { minx = Math.min(minx, k.x); miny = Math.min(miny, k.y); maxy = Math.max(maxy, k.y + k.height); });
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      var shifted = Object.assign({}, k, { x: k.x - minx + startX, y: k.y - miny + y });
      var n = await build(shifted, page, ctx);
      if (n) { tops.push({ spec: k, node: n }); maxRight = Math.max(maxRight, n.x + n.width); }
    }
    y += (maxy - miny) + 400;
  }
  ctx.compX = maxRight + 300;
  ctx.compY = startY;

  // Scroll y elementos fijos en pantallas
  tops.forEach(function (t) {
    var s = t.spec, f = t.node;
    if (f.type !== 'FRAME') return;
    var fixed = (s.children || []).filter(function (c) { return c.fixed; });
    if (s.viewportHeight && s.viewportHeight < s.height) {
      f.clipsContent = true;
      f.resizeWithoutConstraints(f.width, s.viewportHeight);
      f.overflowDirection = 'VERTICAL';
    }
    if (fixed.length) {
      var ok = true;
      fixed.forEach(function (c) {
        var n = ctx.idMap[c.id];
        if (!n) return;
        try { n.scrollBehavior = 'FIXED'; } catch (e) { ok = false; }
      });
      if (!ok) {
        // Método viejo: los fijos tienen que ser los últimos hijos
        fixed.forEach(function (c) { var n = ctx.idMap[c.id]; if (n) f.appendChild(n); });
        try { f.numberOfFixedChildren = fixed.length; } catch (e) { /* sin soporte */ }
      }
    }
  });

  // Interacciones (de adentro hacia afuera, para que los componentes anidados funcionen)
  progress('Armando el prototipo…');
  var topIds = {};
  tops.forEach(function (t) { topIds[t.spec.id] = t.node; });
  var withIx = ctx.built.filter(function (e) { return interactionsOf(e.spec).length; }).reverse();
  for (var w = 0; w < withIx.length; w++) {
    var e = withIx[w];
    var list = interactionsOf(e.spec);
    var reactions = [];
    var styleIx = null;
    for (var q = 0; q < list.length; q++) {
      var it = list[q];
      if (it.action === 'style') { if (!styleIx) styleIx = it; continue; }
      var a = action(it, ctx);
      if (!a) { ctx.skipped++; continue; }
      if (it.trigger === 'delay' && !topIds[e.spec.id]) {
        // En Figma "después de un tiempo" solo va en pantallas: se pasa a la pantalla que lo contiene
        var holder = e.node;
        while (holder.parent && holder.parent.type !== 'PAGE') holder = holder.parent;
        try { await setReactions(holder, (holder.reactions || []).concat([{ trigger: trigger(it), actions: [a] }])); } catch (err) { ctx.skipped++; }
        continue;
      }
      reactions.push({ trigger: trigger(it), actions: [a] });
    }
    try {
      if (styleIx && !topIds[e.spec.id] && e.node.type !== 'COMPONENT' && !insideComponent(e.node)) await makeVariants(e, styleIx, reactions, ctx);
      else { if (styleIx) ctx.skipped++; await setReactions(e.node, reactions); }
    } catch (err) {
      console.warn('Interacción omitida en', e.spec.name, err);
      ctx.skipped++;
      try { await setReactions(e.node, reactions); } catch (err2) { /* nada */ }
    }
  }

  // Punto de inicio del prototipo
  var firstFrame = null;
  tops.forEach(function (t) { if (!firstFrame && t.node.type === 'FRAME') firstFrame = t.node; });
  if (firstFrame) {
    try {
      var flows = (page.flowStartingPoints || []).slice();
      flows.push({ nodeId: firstFrame.id, name: msg.name || 'Lienzo' });
      page.flowStartingPoints = flows;
    } catch (err) { /* sin soporte */ }
  }

  var nodes = tops.map(function (t) { return t.node; });
  page.selection = nodes;
  figma.viewport.scrollAndZoomIntoView(nodes);

  var txt = 'Listo: ' + ctx.count + ' capas';
  if (ctx.variants) txt += ', ' + ctx.variants + ' componentes con estados (hover/presionar)';
  if (ctx.skipped) txt += '. ' + ctx.skipped + ' interacciones no se pudieron pasar.';
  txt += '\nAbrí el prototipo con el botón ▶ de arriba a la derecha.';
  return txt;
}

function insideComponent(n) {
  var p = n.parent;
  while (p && p.type !== 'PAGE') {
    if (p.type === 'COMPONENT' || p.type === 'COMPONENT_SET' || p.type === 'INSTANCE') return true;
    p = p.parent;
  }
  return false;
}
