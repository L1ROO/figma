// Modo "Presentar": muestra un frame como si fuera la app y ejecuta las interacciones
// de prototipo (tocar, hover, presionar, después de un tiempo; navegar, overlays, links, scroll, estilos).

import { interactionsOf } from '/shared/doc.js';

let player = null;

export function startPlayer({ N, nodeCss, startId, onExit, onNavigate }) {
  stopPlayer();
  const root = document.createElement('div');
  root.className = 'player';
  root.innerHTML = `
    <div class="player-bar">
      <button class="player-btn" data-act="restart" title="Volver al inicio (R)">Reiniciar</button>
      <span class="player-title"></span>
      <button class="player-btn" data-act="close" title="Salir (Esc)">Salir</button>
    </div>
    <div class="player-stage"><div class="player-screen"></div></div>`;
  document.body.append(root);
  const stage = root.querySelector('.player-stage');
  const screen = root.querySelector('.player-screen');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const P = player = { root, history: [startId], current: startId, startId, overlays: [], timers: [], styled: new Map(), scale: 1 };

  // ---------- Construcción del DOM de una pantalla ----------
  function build(n, { skipFixed = false } = {}) {
    const el = document.createElement('div');
    el.className = `node t-${n.type}`;
    el.style.cssText = nodeCss(n);
    el.dataset.id = n.id;
    const ix = interactionsOf(n);
    if (ix.some((i) => i.trigger === 'tap' || i.trigger === 'press')) { el.dataset.tap = '1'; el.style.cursor = 'pointer'; }
    if (n.type === 'TEXT') {
      const tx = document.createElement('div');
      tx.className = 'tx';
      tx.textContent = n.text;
      el.append(tx);
    } else if (n.type === 'LINE') {
      el.innerHTML = `<svg width="${Math.max(1, Math.abs(n.width))}" height="${Math.max(1, Math.abs(n.height))}" style="overflow:visible"><line x1="0" y1="0" x2="${n.width}" y2="${n.height}" stroke="${n.stroke || '#000'}" stroke-width="${n.strokeWidth}" stroke-linecap="round" /></svg>`;
    }
    for (const c of n.children || []) {
      const cn = N(c);
      if (!cn || (skipFixed && cn.fixed)) continue;
      el.append(build(cn));
    }
    // Hover y presionar
    for (const i of ix) {
      if (i.trigger === 'hover') {
        el.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') run(i, n, el, 'enter'); });
        el.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') run(i, n, el, 'leave'); });
      }
      if (i.trigger === 'press') {
        el.addEventListener('pointerdown', () => run(i, n, el, 'enter'));
        const up = () => run(i, n, el, 'leave');
        el.addEventListener('pointerup', up);
        el.addEventListener('pointerleave', up);
      }
    }
    return el;
  }

  // Una pantalla completa: contenido con scroll + capa de elementos fijos
  function buildScreen(f) {
    const vh = viewportH(f);
    const device = document.createElement('div');
    device.className = 'player-device';
    device.style.width = f.width + 'px';
    device.style.height = vh + 'px';
    const scroller = document.createElement('div');
    scroller.className = 'player-scroll';
    scroller.style.overflowY = f.height > vh + 0.5 ? 'auto' : 'hidden';
    const body = build({ ...f, x: 0, y: 0, rotation: 0, shadow: null }, { skipFixed: true });
    body.style.left = '0'; body.style.top = '0';
    scroller.append(body);
    device.append(scroller);
    const fixedLayer = document.createElement('div');
    fixedLayer.className = 'player-fixed';
    for (const c of f.children || []) { const cn = N(c); if (cn?.fixed && cn.visible !== false) fixedLayer.append(build(cn)); }
    device.append(fixedLayer);
    const overlayLayer = document.createElement('div');
    overlayLayer.className = 'player-overlays';
    device.append(overlayLayer);
    device._scroller = scroller;
    device._overlays = overlayLayer;
    return device;
  }

  function isLongPage(f) { return f.width >= 1000 || f.height / f.width > 2.6; }
  function fitScale(f) {
    const pad = window.innerWidth < 600 ? 16 : 32;
    const vw = stage.clientWidth - pad, vh = stage.clientHeight - pad;
    let s = Math.min(1, vw / f.width);
    const h = f.viewportHeight || f.height;
    if (!isLongPage(f) || f.viewportHeight) s = Math.min(s, vh / Math.min(h, f.height));
    return s;
  }
  function viewportH(f) {
    if (f.viewportHeight && f.viewportHeight < f.height) return f.viewportHeight;
    if (isLongPage(f)) {
      const pad = window.innerWidth < 600 ? 16 : 32;
      const s = Math.min(1, (stage.clientWidth - pad) / f.width);
      return Math.min(f.height, (stage.clientHeight - pad) / s);
    }
    return f.height;
  }
  function layout() {
    const f = N(P.current);
    const dev = screen.querySelector('.player-device:last-child');
    if (!f || !dev) return;
    const s = fitScale(f);
    P.scale = s;
    const vh = viewportH(f);
    dev.style.height = vh + 'px';
    screen.style.width = f.width * s + 'px';
    screen.style.height = vh * s + 'px';
    for (const d of screen.querySelectorAll('.player-device')) d.style.transform = `scale(${s})`;
  }

  // ---------- Navegación ----------
  function show(transition = 'instant', back = false) {
    const f = N(P.current);
    if (!f) { exit(); return; }
    clearTimers();
    P.overlays = [];
    P.styled.clear();
    root.querySelector('.player-title').textContent = f.name;
    const dev = buildScreen(f);
    const old = screen.querySelector('.player-device');
    screen.append(dev);
    layout();
    scheduleDelays(f, dev);
    if (!old) return;
    animateIn(dev, transition, back).then(() => old.remove());
  }

  function animateIn(el, transition, back = false, kind = 'screen') {
    if (reduced || transition === 'instant') return Promise.resolve();
    let kf;
    if (transition === 'slide') kf = [{ translate: back ? '-100% 0' : '100% 0' }, { translate: '0 0' }];
    else if (transition === 'slideUp') kf = [{ translate: '0 100%' }, { translate: '0 0' }];
    else kf = [{ opacity: 0 }, { opacity: 1 }];
    if (kind === 'overlay' && transition === 'slide') kf = [{ translate: '100% 0' }, { translate: '0 0' }];
    return el.animate(kf, { duration: 280, easing: 'cubic-bezier(.2,.7,.2,1)' }).finished.catch(() => {});
  }

  function navigate(target, transition) {
    if (!N(target) || target === P.current) return;
    P.history.push(target);
    P.current = target;
    show(transition);
    onNavigate?.(P.current);
  }
  function back(transition) {
    if (P.overlays.length) { closeOverlay(); return; }
    if (P.history.length < 2) return;
    P.history.pop();
    P.current = P.history[P.history.length - 1];
    show(transition, true);
    onNavigate?.(P.current);
  }

  // ---------- Overlays ----------
  function device() { return screen.querySelector('.player-device:last-child'); }

  function openOverlay(i, replace = false) {
    const f = N(i.target);
    if (!f) return;
    if (replace && P.overlays.length) closeOverlay(true);
    const host = device()._overlays;
    const wrap = document.createElement('div');
    wrap.className = 'player-overlay' + (i.dim ? ' dim' : '');
    const box = build({ ...f, x: 0, y: 0, rotation: 0 });
    box.classList.add('overlay-box');
    const cur = N(P.current);
    const W = cur.width, H = viewportH(cur);
    const pos = i.position || 'center';
    const x = pos === 'left' ? 0 : pos === 'right' ? W - f.width : (W - f.width) / 2;
    const y = pos === 'top' ? 0 : pos === 'bottom' ? H - f.height : pos === 'center' ? (H - f.height) / 2 : (H - f.height) / 2;
    box.style.left = x + 'px';
    box.style.top = y + 'px';
    wrap.append(box);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap && i.closeOnOutside !== false) closeOverlay();
    });
    host.append(wrap);
    P.overlays.push({ wrap, id: f.id });
    const tr = i.transition === 'slide' && (pos === 'bottom') ? 'slideUp' : i.transition;
    if (i.dim && !reduced) wrap.animate([{ backgroundColor: 'rgba(0,0,0,0)' }, { backgroundColor: 'rgba(0,0,0,.45)' }], { duration: 200 });
    animateIn(box, tr, false, 'overlay');
    scheduleDelays(f, box);
  }
  function closeOverlay(instant = false) {
    const o = P.overlays.pop();
    if (!o) return;
    if (instant || reduced) { o.wrap.remove(); return; }
    o.wrap.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160 }).finished.then(() => o.wrap.remove(), () => o.wrap.remove());
  }

  // ---------- Estilos temporales (hover / presionar) ----------
  function applyStyle(n, el, style, on) {
    const base = N(n.id) || n;
    const props = on ? { ...base, ...style } : base;
    // Conservar posición relativa (el nodo raíz de una pantalla se dibuja en 0,0)
    const css = nodeCss({ ...props, x: on && 'x' in style ? style.x : (el.style.left ? parseFloat(el.style.left) : base.x), y: on && 'y' in style ? style.y : (el.style.top ? parseFloat(el.style.top) : base.y) });
    el.style.cssText = css + (el.dataset.tap ? ';cursor:pointer' : '');
    if (base.type === 'TEXT' && el.firstElementChild) el.firstElementChild.textContent = props.text;
    if (!reduced) el.style.transition = 'background .15s, box-shadow .15s, opacity .15s, color .15s';
  }

  // ---------- Ejecutar una interacción ----------
  function run(i, n, el, phase = 'enter') {
    if (i.action === 'style') {
      if (i.trigger === 'tap') {
        const on = !P.styled.get(el);
        P.styled.set(el, on);
        applyStyle(n, el, i.style || {}, on);
      } else applyStyle(n, el, i.style || {}, phase === 'enter');
      return;
    }
    if (phase === 'leave') {
      // Hover con overlay: al salir se cierra (como "while hovering" en Figma)
      if (i.trigger === 'hover' && i.action === 'overlay') closeOverlay();
      return;
    }
    switch (i.action) {
      case 'navigate': P.overlays.length && closeAllOverlays(); navigate(i.target, i.transition); break;
      case 'back': back(i.transition); break;
      case 'overlay': openOverlay(i); break;
      case 'swap': openOverlay(i, true); break;
      case 'close': closeOverlay(); break;
      case 'url': if (i.url) window.open(/^https?:/i.test(i.url) ? i.url : 'https://' + i.url, '_blank', 'noopener'); break;
      case 'scrollTo': {
        const t = N(i.target);
        const sc = device()?._scroller;
        if (!t || !sc) break;
        let y = 0, cur = t;
        while (cur && cur.id !== P.current) { y += cur.y || 0; cur = N(cur.parentId); }
        sc.scrollTo({ top: y, behavior: reduced ? 'auto' : 'smooth' });
        break;
      }
    }
  }
  function closeAllOverlays() { while (P.overlays.length) closeOverlay(true); }

  function scheduleDelays(f, container) {
    const visit = (n) => {
      if (!n) return;
      for (const i of interactionsOf(n)) {
        if (i.trigger !== 'delay') continue;
        const el = n.id === f.id ? container : container.querySelector(`[data-id="${CSS.escape(n.id)}"]`);
        P.timers.push(setTimeout(() => run(i, n, el || container), i.delay || 800));
      }
      (n.children || []).forEach((c) => visit(N(c)));
    };
    visit(f);
  }
  function clearTimers() { P.timers.forEach(clearTimeout); P.timers = []; }

  function hint() {
    for (const h of screen.querySelectorAll('[data-tap]')) {
      h.classList.remove('hotspot');
      void h.offsetWidth;
      h.classList.add('hotspot');
    }
  }

  // Toques: se busca la capa más profunda con interacción de "tocar"
  screen.addEventListener('click', (e) => {
    let el = e.target.closest('[data-id]');
    while (el && screen.contains(el)) {
      const n = N(el.dataset.id);
      const taps = n ? interactionsOf(n).filter((i) => i.trigger === 'tap') : [];
      if (taps.length) { taps.forEach((i) => run(i, n, el)); return; }
      el = el.parentElement?.closest('[data-id]');
    }
    if (!e.target.closest('.player-overlay') || e.target.closest('.overlay-box')) hint();
  });

  function exit() { stopPlayer(); onExit?.(); }
  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') exit();
    if (act === 'restart') { P.history = [P.startId]; P.current = P.startId; show('dissolve'); onNavigate?.(P.current); }
  });
  const onKey = (e) => {
    if (e.key === 'Escape') { if (P.overlays.length) closeOverlay(); else exit(); }
    if (e.key === 'r' || e.key === 'R') root.querySelector('[data-act=restart]').click();
    if (e.key === 'Backspace' || e.key === 'ArrowLeft') back('slide');
  };
  const onResize = () => layout();
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  P.cleanup = () => { clearTimers(); document.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); };
  P.refresh = () => {
    if (!N(P.current)) { exit(); return; }
    const sc = device()?._scroller?.scrollTop || 0;
    screen.innerHTML = '';
    show('instant');
    const d = device();
    if (d) d._scroller.scrollTop = sc;
  };
  show('instant');
}

export function refreshPlayer() { player?.refresh(); }
export function playerOpen() { return Boolean(player); }

export function stopPlayer() {
  if (!player) return;
  player.cleanup?.();
  player.root.remove();
  player = null;
}
