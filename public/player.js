// Modo "Presentar": muestra un frame como si fuera la app y sigue las conexiones
// (prop `link` de cada capa) al tocar botones.

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

  player = { root, history: [startId], current: startId, startId };

  function build(n) {
    const el = document.createElement('div');
    el.className = `node t-${n.type}`;
    el.style.cssText = nodeCss(n);
    if (n.link) { el.dataset.link = n.link; el.dataset.transition = n.transition || 'dissolve'; el.style.cursor = 'pointer'; }
    if (n.type === 'TEXT') {
      const tx = document.createElement('div');
      tx.className = 'tx';
      tx.textContent = n.text;
      el.append(tx);
    } else if (n.type === 'LINE') {
      el.innerHTML = `<svg width="${Math.max(1, Math.abs(n.width))}" height="${Math.max(1, Math.abs(n.height))}" style="overflow:visible"><line x1="0" y1="0" x2="${n.width}" y2="${n.height}" stroke="${n.stroke || '#000'}" stroke-width="${n.strokeWidth}" stroke-linecap="round" /></svg>`;
    }
    for (const c of n.children || []) { const cn = N(c); if (cn) el.append(build(cn)); }
    return el;
  }

  function layout() {
    const f = N(player.current);
    const content = screen.firstElementChild;
    if (!f || !content) return;
    const pad = window.innerWidth < 600 ? 16 : 32;
    const vw = stage.clientWidth - pad, vh = stage.clientHeight - pad;
    let s = Math.min(1, vw / f.width);
    // Páginas largas (landing, web) se recorren con scroll; pantallas de app se ven enteras
    const longPage = f.width >= 1000 || f.height / f.width > 2.6;
    if (!longPage && f.height * s > vh) s = Math.min(s, vh / f.height);
    screen.style.width = f.width * s + 'px';
    screen.style.height = f.height * s + 'px';
    content.style.transform = `scale(${s})`;
  }

  function render(transition = 'instant', back = false) {
    const f = N(player.current);
    if (!f) { exit(); return; }
    root.querySelector('.player-title').textContent = f.name;
    const el = build({ ...f, x: 0, y: 0, rotation: 0 });
    el.style.transformOrigin = '0 0';
    el.style.left = '0';
    el.style.top = '0';
    const old = screen.firstElementChild;
    screen.append(el);
    layout();
    stage.scrollTop = 0;
    if (!old) return;
    if (reduced || transition === 'instant') { old.remove(); return; }
    const kf = transition === 'slide'
      ? [{ translate: back ? '-100% 0' : '100% 0' }, { translate: '0 0' }]
      : [{ opacity: 0 }, { opacity: 1 }];
    el.animate(kf, { duration: 280, easing: 'cubic-bezier(.2,.7,.2,1)' }).finished.then(() => old.remove(), () => old.remove());
  }

  function go(target, transition) {
    if (target === 'back') {
      if (player.history.length < 2) return;
      player.history.pop();
      player.current = player.history[player.history.length - 1];
      render(transition, true);
    } else if (N(target)) {
      player.history.push(target);
      player.current = target;
      render(transition);
    } else return;
    onNavigate?.(player.current);
  }

  function hint() {
    for (const h of screen.querySelectorAll('[data-link]')) {
      h.classList.remove('hotspot');
      void h.offsetWidth;
      h.classList.add('hotspot');
    }
  }

  screen.addEventListener('click', (e) => {
    const hit = e.target.closest('[data-link]');
    if (!hit) { hint(); return; }
    go(hit.dataset.link, hit.dataset.transition);
  });

  function exit() { stopPlayer(); onExit?.(); }
  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') exit();
    if (act === 'restart') { player.history = [player.startId]; player.current = player.startId; render('dissolve'); onNavigate?.(player.current); }
  });
  const onKey = (e) => {
    if (e.key === 'Escape') exit();
    if (e.key === 'r' || e.key === 'R') root.querySelector('[data-act=restart]').click();
    if (e.key === 'Backspace' || e.key === 'ArrowLeft') go('back', 'slide');
  };
  const onResize = () => layout();
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  player.cleanup = () => { document.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); };
  player.refresh = () => {
    if (!N(player.current)) { exit(); return; }
    screen.innerHTML = '';
    render('instant');
  };
  render('instant');
}

export function refreshPlayer() { player?.refresh(); }
export function playerOpen() { return Boolean(player); }

export function stopPlayer() {
  if (!player) return;
  player.cleanup?.();
  player.root.remove();
  player = null;
}
