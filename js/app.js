// Sprite Studio UI: character panel, playback, frame-by-frame inspection, exports, imports.
(function (SS) {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const h = (tag, attrs = {}, kids = []) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'text') e.textContent = v;
      else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(kids)) if (c) e.append(c);
    return e;
  };

  const DIRS = [
    { key: 'S', name: 'down', yaw: 0 }, { key: 'SE', name: 'downside', yaw: 45 }, { key: 'E', name: 'side', yaw: 90 },
    { key: 'NE', name: 'upside', yaw: 135 }, { key: 'N', name: 'up', yaw: 180 }, { key: 'NW', name: 'upside_L', yaw: -135 },
    { key: 'W', name: 'side_L', yaw: -90 }, { key: 'SW', name: 'downside_L', yaw: -45 },
  ];
  const DRAWN5 = [0, 1, 2, 3, 4];
  const COMPASS = ['NW', 'N', 'NE', 'W', '', 'E', 'SW', 'S', 'SE'];
  const CELL = { W: 64, H: 64, cx: 32, ground: 64 };
  const BG = { grey: '#6b6b6b', day: '#7d6a4c', night: '#0b0d14', magenta: '#ff00ff' };
  const STORE = 'spriteStudio.v1';

  const store = {
    get() { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch (e) { /* private window */ } },
  };
  const saved = store.get();

  const S = {
    mode: 'gen',
    cfg: saved && saved.cfg ? SS.mergeCharacter(saved.cfg) : SS.mergeCharacter(SS.PRESETS.survivor),
    anim: (saved && saved.anim) || 'walk',
    params: (saved && saved.params) || {},
    counts: (saved && saved.counts) || {},
    dur: (saved && saved.dur) || {},
    dir: (saved && saved.dir) || 0,
    cur: 0, playing: true, speed: 1, loopMode: 'auto', ping: 1, acc: 0, wait: 0,
    view: { zoom: 8, bg: 'checker', onion: false, diff: false, guides: true, grid: false, orph: false, ref: null, refAlpha: 0.5 },
    frames: [], stats: [], pairs: [], loop: 'loop',
    imp: null, vimp: null,
  };
  const persist = () => store.set({ cfg: S.cfg, anim: S.anim, params: S.params, counts: S.counts, dur: S.dur, dir: S.dir });

  // ---------- rendering with a cache ----------
  const cache = new Map();
  const cfgKey = () => JSON.stringify(S.cfg);
  const animKey = (anim) => anim + '|' + JSON.stringify(S.params[anim] || {}) + '|' + (S.counts[anim] || '');
  function renderAnim(anim, dirIdx, cfg = S.cfg) {
    const key = JSON.stringify(cfg) + '|' + animKey(anim) + '|' + dirIdx;
    if (cache.has(key)) return cache.get(key);
    const P = SS.proportions(cfg), M = SS.buildMaterials(cfg);
    const A = SS.animFrames(anim, cfg, P, S.params[anim], S.counts[anim]);
    const yaw = DIRS[dirIdx].yaw;
    const frames = A.frames.map((fr) => {
      const J = SS.solve(P, fr.pose);
      const cam = SS.toCamera(SS.buildCharacter(cfg, P, M, J, fr.pose), yaw);
      const out = SS.renderFrame(cam, M, { W: CELL.W, H: CELL.H, cx: CELL.cx, ground: CELL.ground, tilt: cfg.style.tilt, ss: 3, outline: cfg.style.outline, flash: fr.pose.flash, lightK: cfg.style.light });
      out.ms = fr.ms; out.J = J; out.yaw = yaw; out.P = P; out.pose = fr.pose;
      return out;
    });
    const res = { frames, loop: A.loop };
    cache.set(key, res);
    if (cache.size > 120) cache.delete(cache.keys().next().value);
    return res;
  }
  const withDurations = (anim, frames) => {
    const d = S.dur[anim];
    return frames.map((f, i) => Object.assign({}, f, { ms: d && d[i] ? d[i] : f.ms }));
  };

  // ---------- state -> frames ----------
  // Inspect and Video -> Sheet each keep their own imported rows
  const imp = () => (S.mode === 'video' ? S.vimp : S.imp);
  let bgJob = null;
  function refresh(keepFrame) {
    if (S.mode === 'gen') {
      const r = renderAnim(S.anim, S.dir);
      S.frames = withDurations(S.anim, r.frames);
      S.loop = r.loop;
      scheduleSync();
    } else if (imp() && imp().rows.length) {
      const I = imp(), row = I.rows[I.row];
      S.frames = row.frames.map((f) => Object.assign({ ms: I.ms }, f, { ms: f.ms || I.ms }));
      S.loop = 'loop';
    } else S.frames = [];
    if (!keepFrame || S.cur >= S.frames.length) S.cur = 0;
    analyse();
    buildStrip();
    drawAll();
    persist();
  }
  function analyse() {
    S.stats = S.frames.map((f) => SS.frameStats(f));
    S.pairs = S.frames.map((f, i) => {
      if (i === 0 && S.loop !== 'loop') return null;
      const prev = S.frames[(i - 1 + S.frames.length) % S.frames.length];
      if (S.frames.length < 2) return null;
      return Object.assign({ from: (i - 1 + S.frames.length) % S.frames.length, to: i }, SS.pairStats(prev, f));
    });
    const kindAllow = { run: 3, attack: 6, death: 60, hurt: 3, pant: 4, shamble: 2, walk: 2, idle: 1 };
    const feetAllow = { run: 3, attack: 1, death: 40, hurt: 1, idle: 0, walk: 1, pant: 0, shamble: 1 };
    const anim = S.mode === 'gen' ? S.anim : S.checkAs;
    const probs = SS.problems(S.frames, S.stats, S.pairs, { allowHeight: anim ? kindAllow[anim] : 1, allowFeet: anim ? feetAllow[anim] : 2 });
    const ul = $('#problems'); ul.innerHTML = '';
    if (!S.frames.length) ul.append(h('li', { text: 'Nothing loaded: drop a sheet, strip or atlas in the Load panel.' }));
    else if (!probs.length) ul.append(h('li', { class: 'ok', text: 'No problems: sizes, feet, noise and frame pairs are within the checker\'s limits.' }));
    probs.forEach((p) => ul.append(h('li', { class: 's' + p.sev, text: p.text })));
    const t = $('#metrics'); t.innerHTML = '';
    t.append(h('tr', {}, ['#', 'h', 'feet', 'head', 'cols', 'orph', 'ms', 'vs prev'].map((x) => h('th', { text: x }))));
    S.frames.forEach((f, i) => {
      const s = S.stats[i], p = S.pairs[i];
      const tr = h('tr', { class: i === S.cur ? 'on' : '', onclick: () => { S.cur = i; S.playing = false; syncPlay(); drawAll(); } }, [
        h('td', { text: i }), h('td', { text: s.empty ? '-' : s.height }), h('td', { text: s.empty ? '-' : s.feet }), h('td', { text: s.empty ? '-' : s.head }),
        h('td', { text: s.empty ? '-' : s.colours }), h('td', { text: s.empty ? '-' : s.orphans }), h('td', { text: f.ms }),
        h('td', { class: 'k ' + (p ? 'k-' + p.kind : ''), text: p ? `${p.kind} ${(p.sil * 100).toFixed(0)}%` : '' }),
      ]);
      t.append(tr);
    });
  }

  // background rendering of the other seven directions for the sync strip
  function scheduleSync() {
    if (bgJob) clearTimeout(bgJob);
    const todo = DIRS.map((d, i) => i).filter((i) => i !== S.dir);
    const anim = S.anim;
    const step = () => {
      if (S.mode !== 'gen' || anim !== S.anim || !todo.length) { drawSync(); return; }
      renderAnim(anim, todo.shift());
      drawSync();
      bgJob = setTimeout(step, 0);
    };
    bgJob = setTimeout(step, 30);
  }

  // ---------- drawing ----------
  const view = $('#view'), vg = view.getContext('2d');
  const tintCache = new WeakMap();
  function tinted(f, color) {
    let m = tintCache.get(f);
    if (!m) { m = {}; tintCache.set(f, m); }
    if (m[color]) return m[color];
    const c = SS.frameCanvas(f, 1);
    const g = c.getContext('2d');
    g.globalCompositeOperation = 'source-atop'; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
    m[color] = c;
    return c;
  }
  const plain = new WeakMap();
  const canvasOf = (f) => { let c = plain.get(f); if (!c) { c = SS.frameCanvas(f, 1); plain.set(f, c); } return c; };

  function paintBg(g, w, hh, z, bg) {
    if (bg === 'checker') {
      const b = Math.max(4, z * 4);
      for (let y = 0; y < hh; y += b) for (let x = 0; x < w; x += b) {
        g.fillStyle = ((x / b + y / b) & 1) ? '#3a3d42' : '#2e3135';
        g.fillRect(x, y, b, b);
      }
    } else { g.fillStyle = BG[bg]; g.fillRect(0, 0, w, hh); }
  }

  function drawView() {
    const f = S.frames[S.cur];
    const z = S.view.zoom;
    const W = f ? f.W : CELL.W, H = f ? f.H : CELL.H;
    view.width = W * z; view.height = H * z;
    vg.imageSmoothingEnabled = false;
    paintBg(vg, view.width, view.height, z, S.view.bg);
    if (!f) return;
    const n = S.frames.length;
    if (S.view.onion && n > 1) {
      const pv = S.frames[(S.cur - 1 + n) % n], nx = S.frames[(S.cur + 1) % n];
      vg.globalAlpha = 0.28; vg.drawImage(tinted(nx, '#36c1ff'), 0, 0, W * z, H * z);
      vg.globalAlpha = 0.38; vg.drawImage(tinted(pv, '#ff3b3b'), 0, 0, W * z, H * z);
      vg.globalAlpha = 1;
    }
    vg.drawImage(canvasOf(f), 0, 0, W * z, H * z);
    if (S.view.ref) {
      vg.globalAlpha = S.view.refAlpha;
      const r = S.view.ref, cx = S.mode === 'gen' ? CELL.cx : W / 2;
      vg.drawImage(r, (cx - r.width / 2) * z, (H - r.height) * z, r.width * z, r.height * z);
      vg.globalAlpha = 1;
    }
    if (S.view.diff && n > 1) {
      const pv = S.frames[(S.cur - 1 + n) % n];
      vg.fillStyle = 'rgba(255,40,40,0.62)';
      for (let i = 0; i < W * H; i++) {
        const a = f.rgba[i * 4 + 3], b = pv.rgba[i * 4 + 3];
        if (a !== b || (a && (f.rgba[i * 4] !== pv.rgba[i * 4] || f.rgba[i * 4 + 1] !== pv.rgba[i * 4 + 1] || f.rgba[i * 4 + 2] !== pv.rgba[i * 4 + 2])))
          vg.fillRect((i % W) * z, ((i / W) | 0) * z, z, z);
      }
    }
    const st = S.stats[S.cur];
    if (S.view.orph && st && !st.empty) {
      vg.strokeStyle = '#ffd400'; vg.lineWidth = Math.max(1, z / 6);
      for (let i = 0; i < W * H; i++) if (st.orphanMap[i]) vg.strokeRect((i % W) * z + 1, ((i / W) | 0) * z + 1, z - 2, z - 2);
    }
    if (S.view.grid && z >= 4) {
      vg.strokeStyle = 'rgba(255,255,255,0.07)'; vg.lineWidth = 1;
      vg.beginPath();
      for (let x = 0; x <= W; x++) { vg.moveTo(x * z + 0.5, 0); vg.lineTo(x * z + 0.5, H * z); }
      for (let y = 0; y <= H; y++) { vg.moveTo(0, y * z + 0.5); vg.lineTo(W * z, y * z + 0.5); }
      vg.stroke();
    }
    if (S.view.guides && st && !st.empty) {
      const line = (y, color, dash) => { vg.strokeStyle = color; vg.setLineDash(dash || []); vg.beginPath(); vg.moveTo(0, y); vg.lineTo(W * z, y); vg.stroke(); vg.setLineDash([]); };
      vg.lineWidth = Math.max(1, Math.round(z / 5));
      line((st.feet + 1) * z, 'rgba(79,195,217,0.9)');
      line(st.top * z, 'rgba(240,163,94,0.75)', [z, z]);
      const target = H - (S.cfg.body.height || 57);
      if (S.mode === 'gen') line(target * z, 'rgba(127,176,105,0.6)', [z / 2, z]);
      const cx = S.mode === 'gen' ? CELL.cx : W / 2;
      vg.strokeStyle = 'rgba(255,255,255,0.12)'; vg.beginPath(); vg.moveTo(cx * z, 0); vg.lineTo(cx * z, H * z); vg.stroke();
    }
    // minis at 1x and 2x on the same background
    for (const [id, s] of [['#mini1', 1], ['#mini2', 2]]) {
      const c = $(id); c.width = W * s; c.height = H * s;
      const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
      paintBg(g, c.width, c.height, s, S.view.bg);
      g.drawImage(canvasOf(f), 0, 0, W * s, H * s);
    }
    const label = S.mode === 'gen' ? `${SS.ANIMS[S.anim].label} · ${DIRS[S.dir].key} (${DIRS[S.dir].name})` : (imp() ? imp().rows[imp().row].name : '');
    $('#badge').innerHTML = `<b>${label}</b> · frame <b>${S.cur + 1}/${n}</b> · <b>${f.ms}</b> ms` + (st && !st.empty ? ` · h${st.height} head${st.head} feet${st.feet}` : '');
    $('#tinfo').innerHTML = `frame <b>${S.cur + 1}</b>/${n} · <b>${f.ms}</b> ms · cycle ${S.frames.reduce((a, b) => a + b.ms, 0)} ms`;
  }

  function buildStrip() {
    const strip = $('#strip'); strip.innerHTML = '';
    if (!S.frames.length) return;
    // crop all thumbnails to the union of the figure boxes so the strip stays compact
    let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
    S.stats.forEach((s) => { if (s.empty) return; x0 = Math.min(x0, s.bbox[0]); y0 = Math.min(y0, s.bbox[1]); x1 = Math.max(x1, s.bbox[0] + s.bbox[2]); y1 = Math.max(y1, s.bbox[1] + s.bbox[3]); });
    if (x1 < 0) { x0 = 0; y0 = 0; x1 = S.frames[0].W; y1 = S.frames[0].H; }
    x0 = Math.max(0, x0 - 2); y0 = Math.max(0, y0 - 2); x1 = Math.min(S.frames[0].W, x1 + 2); y1 = Math.min(S.frames[0].H, y1 + 2);
    const sc = Math.max(1, Math.min(3, Math.floor(84 / (y1 - y0))));
    S.frames.forEach((f, i) => {
      const c = h('canvas'); c.width = (x1 - x0) * sc; c.height = (y1 - y0) * sc;
      const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
      paintBg(g, c.width, c.height, sc, S.view.bg === 'checker' ? 'grey' : S.view.bg);
      g.drawImage(canvasOf(f), x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
      const p = S.pairs[i];
      const ms = h('input', { class: 'ms', type: 'number', value: f.ms, min: 10, max: 2000, step: 5, title: 'Frame duration (ms)' });
      ms.addEventListener('click', (e) => e.stopPropagation());
      ms.addEventListener('change', () => {
        const v = Math.max(10, Math.round(+ms.value || f.ms));
        if (S.mode === 'gen') { const d = S.dur[S.anim] || S.frames.map((x) => x.ms); d[i] = v; S.dur[S.anim] = d; }
        f.ms = v; analyse(); drawAll(); persist();
      });
      const cell = h('div', { class: 'cell' + (i === S.cur ? ' on' : ''), onclick: () => { S.cur = i; S.playing = false; syncPlay(); drawAll(); } }, [
        c, h('div', { class: 'kind ' + (p ? 'k-' + p.kind : ''), text: p ? p.kind : (i === 0 ? 'start' : '') }), ms,
      ]);
      strip.append(cell);
    });
  }
  function markStrip() {
    [...$('#strip').children].forEach((c, i) => c.classList.toggle('on', i === S.cur));
    [...$('#metrics').querySelectorAll('tr')].forEach((tr, i) => tr.classList.toggle('on', i - 1 === S.cur));
    const on = $('#strip').children[S.cur];
    if (on && S.playing === false) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function drawSync() {
    const box = $('#sync');
    if (S.mode !== 'gen') { box.innerHTML = ''; return; }
    if (box.children.length !== 8) {
      box.innerHTML = '';
      DIRS.forEach((d, i) => box.append(h('figure', { onclick: () => { S.dir = i; refresh(true); buildCompass(); } }, [h('canvas', { width: 40, height: 64 }), h('figcaption', { text: d.key })])));
    }
    DIRS.forEach((d, i) => {
      const fig = box.children[i];
      fig.classList.toggle('on', i === S.dir);
      const key = JSON.stringify(S.cfg) + '|' + animKey(S.anim) + '|' + i;
      const r = cache.get(key);
      const c = fig.querySelector('canvas'), g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      paintBg(g, c.width, c.height, 1, S.view.bg === 'checker' ? 'grey' : S.view.bg);
      if (!r) return;
      const f = r.frames[Math.min(S.cur, r.frames.length - 1)];
      g.drawImage(canvasOf(f), CELL.cx - 20, 0, 40, 64, 0, 0, 40, 64);
    });
  }

  function drawAll() { drawView(); markStrip(); drawSync(); }

  // ---------- playback ----------
  let last = performance.now();
  function tick(now) {
    const dt = Math.min(100, now - last); last = now;
    if (S.playing && S.frames.length > 1) {
      if (S.wait > 0) { S.wait -= dt; if (S.wait <= 0) { S.cur = 0; S.acc = 0; drawAll(); } }
      else {
        S.acc += dt * S.speed;
        let moved = false;
        while (S.acc >= S.frames[S.cur].ms) {
          S.acc -= S.frames[S.cur].ms;
          const mode = S.loopMode === 'auto' ? (S.loop === 'loop' ? 'loop' : 'once') : S.loopMode;
          const n = S.frames.length;
          if (mode === 'loop') S.cur = (S.cur + 1) % n;
          else if (mode === 'ping') { if (S.cur + S.ping < 0 || S.cur + S.ping >= n) S.ping = -S.ping; S.cur += S.ping; }
          else if (S.cur < n - 1) S.cur++;
          else { S.wait = S.loop === 'hold' ? 1400 : 700; S.acc = 0; break; }
          moved = true;
        }
        if (moved) drawAll();
      }
    }
    requestAnimationFrame(tick);
  }
  const syncPlay = () => { $('#play').textContent = S.playing ? '❚❚' : '▶'; };
  const step = (d) => { S.playing = false; syncPlay(); const n = S.frames.length; if (!n) return; S.cur = (S.cur + d + n) % n; drawAll(); };

  // ---------- generic controls ----------
  const get = (path) => path.split('.').reduce((o, k) => o[k], S.cfg);
  const set = (path, v) => { const ks = path.split('.'); const last = ks.pop(); ks.reduce((o, k) => o[k], S.cfg)[last] = v; };
  let pending = null;
  const changed = () => { if (pending) clearTimeout(pending); pending = setTimeout(() => { pending = null; refresh(true); }, 25); };
  const ctl = {
    select(label, path, opts) {
      const s = h('select', { onchange: () => { set(path, s.value); changed(); } }, opts.map(([v, t]) => h('option', { value: v, text: t })));
      s.value = get(path); s.dataset.path = path;
      return h('div', { class: 'row' }, [h('label', { text: label }), s, h('span')]);
    },
    color(label, path) {
      const c = h('input', { type: 'color', value: get(path), oninput: () => { set(path, c.value); changed(); } });
      c.dataset.path = path;
      return h('div', { class: 'row' }, [h('label', { text: label }), h('span', { class: 'note', text: '' }), c]);
    },
    range(label, path, min, max, stepv, fmt = (v) => v) {
      const val = h('span', { class: 'val', text: fmt(get(path)) });
      const r = h('input', { type: 'range', min, max, step: stepv, value: get(path), oninput: () => { set(path, +r.value); val.textContent = fmt(+r.value); changed(); } });
      r.dataset.path = path;
      return h('div', { class: 'row' }, [h('label', { text: label }), r, val]);
    },
    check(label, path) {
      const c = h('input', { type: 'checkbox', onchange: () => { set(path, c.checked); changed(); } });
      c.checked = !!get(path); c.dataset.path = path;
      return h('label', { class: 'check' }, [c, label]);
    },
  };
  const section = (title, kids, open) => h('details', open ? { open: true } : {}, [h('summary', { text: title }), h('div', { class: 'body' }, kids)]);

  function buildGenPanel() {
    const C = SS.CATALOG, p = $('#genPanel');
    p.innerHTML = '';
    const pct = (v) => (+v).toFixed(2);
    p.append(
      section('Body', [
        ctl.select('Body', 'body.type', C.bodyType),
        ctl.range('Height (px)', 'body.height', 48, 62, 1),
        ctl.range('Build', 'body.build', 0.85, 1.2, 0.01, pct),
        ctl.range('Shoulders', 'body.shoulders', 0.85, 1.15, 0.01, pct),
        ctl.range('Hips', 'body.hips', 0.85, 1.15, 0.01, pct),
        ctl.range('Head', 'body.head', 0.9, 1.12, 0.01, pct),
        ctl.color('Skin', 'skin'),
      ], true),
      section('Face & hair', [
        ctl.select('Hair', 'hair.style', C.hair), ctl.color('Hair colour', 'hair.color'),
        ctl.select('Facial hair', 'face.facial', C.facial), ctl.color('Eyes', 'face.eyes'),
      ], true),
      section('Top', [ctl.select('Top', 'top.type', C.top), ctl.color('Colour', 'top.color'), ctl.color('Accent', 'top.accent'), ctl.color('Under / inner', 'top.under')], true),
      section('Bottom & shoes', [
        ctl.select('Bottom', 'bottom.type', C.bottom), ctl.color('Colour', 'bottom.color'),
        ctl.select('Shoes', 'shoes.type', C.shoes), ctl.color('Shoe colour', 'shoes.color'), ctl.color('Sole', 'shoes.sole'),
      ], true),
      section('Hat & extras', [
        ctl.select('Hat', 'hat.type', C.hat), ctl.color('Hat colour', 'hat.color'),
        h('div', { class: 'grid2' }, [ctl.check('Belt', 'extras.belt'), ctl.check('Backpack', 'extras.backpack'), ctl.check('Glasses', 'extras.glasses'), ctl.check('Gloves', 'extras.gloves'), ctl.check('Scarf', 'extras.scarf')]),
        ctl.color('Belt', 'extras.beltColor'), ctl.color('Backpack', 'extras.packColor'), ctl.color('Gloves', 'extras.gloveColor'), ctl.color('Scarf', 'extras.scarfColor'),
        ctl.select('Weapon', 'weapon.type', C.weapon),
      ]),
      section('Zombie', [
        ctl.check('Zombie', 'zombie.on'), ctl.range('Decay', 'zombie.decay', 0, 1, 0.05, pct), ctl.range('Torn cloth', 'zombie.torn', 0, 1, 0.05, pct), ctl.range('Blood', 'zombie.blood', 0, 1, 0.05, pct),
      ]),
      section('Pixel style', [
        ctl.select('Outline', 'style.outline', C.outline), ctl.color('Ink', 'style.ink'),
        ctl.select('Palette', 'style.palette', C.palette),
        ctl.range('Contrast', 'style.light', 0, 1, 0.05, pct),
        ctl.range('Camera tilt', 'style.tilt', 0, 0.4, 0.02, pct),
        h('div', { class: 'note', text: 'Tilt shows the tops of heads and feet for steeper top-down cameras; feet that step toward the camera drop lower, so raise the ground in a tall cell if they clip.' }),
      ]),
    );
  }

  function buildAnimPanel() {
    const box = $('#anims'); box.innerHTML = '';
    SS.ANIM_ORDER.forEach((name) => box.append(h('button', { class: name === S.anim ? 'on' : '', text: SS.ANIMS[name].label, onclick: () => { S.anim = name; S.cur = 0; S.playing = true; syncPlay(); buildAnimPanel(); refresh(); } })));
    const A = SS.ANIMS[S.anim], pp = $('#animParams'); pp.innerHTML = '';
    const prm = S.params[S.anim] || (S.params[S.anim] = {});
    if (!A.fixed) {
      const sel = h('select', { onchange: () => { S.counts[S.anim] = +sel.value; delete S.dur[S.anim]; refresh(); } }, [4, 6, 8, 10, 12, 16].map((n) => h('option', { value: n, text: n + ' frames' })));
      sel.value = S.counts[S.anim] || A.n;
      pp.append(h('div', { class: 'row' }, [h('label', { text: 'Frames' }), sel, h('span')]));
    }
    A.params.forEach((d) => {
      const v = prm[d.key] ?? d.def;
      const val = h('span', { class: 'val', text: v });
      const r = h('input', { type: 'range', min: d.min, max: d.max, step: d.step, value: v, oninput: () => { prm[d.key] = +r.value; val.textContent = r.value; delete S.dur[S.anim]; changed(); } });
      pp.append(h('div', { class: 'row' }, [h('label', { text: d.label }), r, val]));
    });
    pp.append(h('div', { class: 'btns' }, [
      h('button', { class: 'ghost', text: 'Reset timing', onclick: () => { delete S.dur[S.anim]; refresh(true); } }),
      h('button', { class: 'ghost', text: 'Reset params', onclick: () => { S.params[S.anim] = {}; delete S.counts[S.anim]; delete S.dur[S.anim]; buildAnimPanel(); refresh(); } }),
    ]));
  }

  function buildCompass() {
    const c = $('#compass'); c.innerHTML = '';
    COMPASS.forEach((k) => {
      if (!k) { c.append(h('div', { class: 'c', text: 'face' })); return; }
      const i = DIRS.findIndex((d) => d.key === k);
      c.append(h('button', { class: i === S.dir ? 'on' : '', text: k, title: DIRS[i].name, onclick: () => { S.dir = i; buildCompass(); refresh(true); } }));
    });
  }

  // ---------- presets and randomising ----------
  const SKINS = ['#f2c3a0', '#e8b08a', '#e19968', '#c98a62', '#a8714a', '#8a5a3c', '#6b4430'];
  const HAIRC = ['#1d1714', '#2b211c', '#3b2a1e', '#553926', '#7a4a2a', '#9a6a34', '#c4a060', '#8e8a84', '#7a3a24'];
  const CLOTH = ['#595750', '#3e4a3a', '#4a5a52', '#6b5a3a', '#7d2a2a', '#2d3a55', '#22314d', '#4f4a2c', '#8a7a5a', '#c9ccc4', '#3a3d48', '#5b5639', '#9e4539', '#3d5a8c', '#5a3d62', '#2b2b30'];
  function randomise() {
    const R = Math.random, pick = (a) => a[Math.floor(R() * a.length)];
    const C = SS.CATALOG;
    const c = S.cfg;
    c.body.type = R() < 0.3 ? 'female' : 'male';
    c.body.build = +(0.92 + R() * 0.18).toFixed(2);
    c.skin = pick(SKINS);
    c.hair.style = pick(C.hair.filter(([v]) => c.body.type === 'female' ? v !== 'bald' : true))[0];
    c.hair.color = pick(HAIRC);
    c.face.facial = c.body.type === 'female' ? 'none' : pick(C.facial)[0];
    c.top.type = pick(C.top.slice(1))[0]; c.top.color = pick(CLOTH); c.top.accent = SS.mixHex(c.top.color, '#101010', 0.25 + R() * 0.2); c.top.under = pick(['#c2b49a', '#d8d4c8', '#3a3d48', '#9e4539']);
    c.bottom.type = pick(C.bottom)[0]; c.bottom.color = pick(CLOTH);
    c.shoes.type = pick(['boots', 'boots', 'sneakers']);
    c.shoes.color = pick(['#624a30', '#3e2f22', '#2b2b30', '#c7c2b4', '#5a4a3a']);
    c.hat.type = R() < 0.35 ? pick(C.hat.slice(1))[0] : 'none'; c.hat.color = pick(CLOTH);
    c.extras.backpack = R() < 0.25; c.extras.glasses = R() < 0.15; c.extras.scarf = R() < 0.12;
    c.name = 'random';
    buildGenPanel(); refresh(true);
  }

  // ---------- inspect panel ----------
  function buildInspectPanel() {
    const p = $('#inspectPanel'); p.innerHTML = '';
    const file = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    const man = h('input', { type: 'file', accept: '.json', class: 'hidden' });
    const drop = h('div', { class: 'drop', text: 'Drop a sprite sheet, strip or atlas PNG here (plus its manifest JSON if it has one), or click to choose.' });
    const cw = h('input', { type: 'number', value: 64, min: 1 }), ch = h('input', { type: 'number', value: 64, min: 1 });
    const sc = h('input', { type: 'number', value: 1, min: 1, max: 16 });
    const key = h('input', { type: 'checkbox', checked: true });
    const ms = h('input', { type: 'number', value: 100, min: 10, step: 5 });
    const rowSel = h('select', { onchange: () => { if (S.imp) { S.imp.row = +rowSel.value; guessKind(); refresh(); } } });
    const kindSel = h('select', { onchange: () => { S.checkAs = kindSel.value; refresh(true); } },
      SS.ANIM_ORDER.map((a) => h('option', { value: a, text: SS.ANIMS[a].label })));
    kindSel.value = S.checkAs = 'walk';
    // atlas rows are named like side_run: check them with that state's tolerances
    const guessKind = () => {
      const name = S.imp && S.imp.rows[S.imp.row] ? S.imp.rows[S.imp.row].name : '';
      const hit = SS.ANIM_ORDER.find((a) => name.includes(a)) || (/sprint/.test(name) ? 'run' : /trudge/.test(name) ? 'walk' : null);
      if (hit) { kindSel.value = S.checkAs = hit; }
    };
    const info = h('div', { class: 'note' });
    let img = null, data = null, manifest = null;
    const slice = () => {
      if (!data) return;
      const k = key.checked ? [255, 0, 255] : null;
      let rows;
      if (manifest && manifest.frame_layout) rows = SS.sliceAtlas(data, manifest, +sc.value || 1, k);
      else rows = SS.sliceGrid(data, +cw.value, +ch.value, +sc.value || 1, k);
      S.imp = { rows, row: 0, ms: +ms.value || 100 };
      rowSel.innerHTML = '';
      rows.forEach((r, i) => rowSel.append(h('option', { value: i, text: `${r.name} (${r.frames.length})` })));
      guessKind();
      info.textContent = `${img.width}x${img.height} px · ${rows.length} row(s)` + (manifest ? ' · from manifest' : '');
      refresh();
    };
    const take = async (files) => {
      for (const f of files) {
        if (/\.json$/i.test(f.name)) { manifest = JSON.parse(await f.text()); const c = manifest.cellWidth || (manifest.frame_layout && manifest.frame_layout.cellWidth); if (c) { cw.value = c; ch.value = manifest.cellHeight || manifest.frame_layout.cellHeight || c; } }
        else if (/^image\//.test(f.type)) {
          img = await SS.loadImageFile(f); data = SS.imageData(img);
          if (!manifest) { const g = SS.guessCells(data, key.checked ? [255, 0, 255] : null); cw.value = g.cw; ch.value = g.ch; }
        }
      }
      slice();
    };
    drop.addEventListener('click', () => file.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('hot'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('hot'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('hot'); take([...e.dataTransfer.files]); });
    file.addEventListener('change', () => take([...file.files]));
    man.addEventListener('change', () => take([...man.files]));
    // finished art from the project (needs the studio served from Desktop/AI, see README)
    const RESULTS = [
      ['Sample: side walk made with Video → Sheet (bundled)', 'samples/survivor_side_walk.png', 'samples/survivor_side_walk.json', 32, 64, 1, 63],
      ['Side walk on the UAL walk, stabilised (12 frames, even timing)', '../work/side_walk_ual/final/survivor_side_walk.png', '../work/side_walk_ual/final/survivor_side_walk.json', 32, 64, 1, 100],
      ['Side walk on the UAL walk, before stabilising', '../work/side_walk_ual/final_unstabilised/survivor_side_walk.png', null, 32, 64, 1, 100],
      ['UAL walk, 16 frames (Quaternius CC0 rig, survivor proportions)', '../work/ual/guide/ual_walk16_strip.png', null, 32, 64, 1, 83],
      ['UAL walk, 8 frames (pose guide for Codex)', '../work/ual/guide/ual_walk_strip.png', null, 32, 64, 1, 167],
      ['Side walk, locked to your drawing (take 2 + in-betweens, 10 frames)', '../work/side_walk_locked/final/survivor_side_walk.png', null, 32, 64, 1, 80],
      ['Side walk, locked, take 2 (8 frames)', '../work/side_walk_locked/final_take2_8f/survivor_side_walk.png', null, 32, 64, 1, 100],
      ['Side walk, locked, take 1', '../work/side_walk_locked/final_take1/survivor_side_walk.png', null, 32, 64, 1, 100],
      ['New side walk (stabilised Codex)', '../work/side_walk_new/final/survivor_side_walk.png', null, 32, 64, 1, 100],
      ['Codex row edit, raw', '../work/codex_row_walk/snapped/codex_walk_strip.png', null, 48, 64, 1, 100],
      ['sg8 atlas (shipped, all rows)', '../DEADFARM/web/assets/sg8/survivor.png', '../DEADFARM/web/assets/sg8/survivor.json', 160, 160, 2, 100],
    ];
    const resSel = h('select', {}, [h('option', { value: '', text: 'Project results…' }), ...RESULTS.map((r, i) => h('option', { value: i, text: r[0] }))]);
    resSel.addEventListener('change', async () => {
      const r = RESULTS[+resSel.value]; resSel.value = '';
      if (!r) return;
      try {
        const files = [];
        const png = await fetch(r[1]); if (!png.ok) throw new Error(png.status);
        files.push(new File([await png.blob()], r[1].split('/').pop(), { type: 'image/png' }));
        manifest = null;
        if (r[2]) { const j = await fetch(r[2]); files.unshift(new File([await j.blob()], 'm.json', { type: 'application/json' })); }
        sc.value = r[5]; ms.value = r[6];
        await take(files);
        if (!r[2]) { cw.value = r[3]; ch.value = r[4]; slice(); }
        if (S.view.zoom < 8) { S.view.zoom = 8; $('#zoom').value = 8; drawAll(); }
      } catch (e) { toast('Could not open it: serve Desktop/AI (see README), not just the sprite_studio folder'); }
    });
    p.append(
      section('Load', [resSel, drop, file, man, h('div', { class: 'btns' }, [h('button', { text: 'Manifest JSON…', onclick: () => man.click() }), h('button', { text: 'Clear manifest', onclick: () => { manifest = null; slice(); } })]), info], true),
      section('Slicing', [
        h('div', { class: 'row' }, [h('label', { text: 'Cell w × h' }), h('div', { class: 'btns' }, [cw, ch]), h('span')]),
        h('div', { class: 'row' }, [h('label', { text: 'Pixel scale' }), sc, h('span', { class: 'note', text: '÷' })]),
        h('label', { class: 'check' }, [key, 'Key out #FF00FF']),
        h('div', { class: 'row' }, [h('label', { text: 'Default ms' }), ms, h('span')]),
        h('button', { class: 'primary', text: 'Slice', onclick: slice }),
        h('div', { class: 'note', text: 'Pixel scale divides upscaled art back to 1x (each block takes its most common colour). A DEADFARM atlas at 2x with its JSON slices row by row with durations.' }),
      ], true),
      section('Row', [rowSel, h('div', { class: 'row' }, [h('label', { text: 'Check as' }), kindSel, h('span')]),
        h('div', { class: 'note', text: 'Sets the checker\'s tolerances: an idle may not move its feet, a run may lift them, an attack may change height.' })], true),
    );
  }

  // ---------- exports ----------
  const toast = (t) => { const e = $('#toast'); e.textContent = t; e.classList.add('on'); setTimeout(() => e.classList.remove('on'), 2600); };
  const busy = (on, t) => { $('#busy').classList.toggle('on', on); if (t) $('#busyText').textContent = t; };
  const nextFrame = () => new Promise((r) => setTimeout(r, 0));
  const cellFor = (frames) => {
    let x0 = 1e9, x1 = -1;
    frames.forEach((f) => { const s = SS.frameStats(f); if (!s.empty) { x0 = Math.min(x0, s.bbox[0]); x1 = Math.max(x1, s.bbox[0] + s.bbox[2]); } });
    const half = Math.max(CELL.cx - x0, x1 - CELL.cx);
    return half <= 16 ? 32 : half <= 24 ? 48 : 64;
  };

  function buildExportPanel() {
    const b = $('#exportBody'); b.innerHTML = '';
    const dirs = h('select', {}, [h('option', { value: '8', text: '8 directions (all rendered)' }), h('option', { value: '5', text: '5 drawn (mirror the rest in engine)' })]);
    const width = h('select', {}, [h('option', { value: 'auto', text: 'Cell: fit (32/48/64)' }), h('option', { value: '32', text: 'Cell 32x64' }), h('option', { value: '48', text: 'Cell 48x64' }), h('option', { value: '64', text: 'Cell 64x64' })]);
    const scale = h('select', {}, [1, 2, 4].map((s) => h('option', { value: s, text: s + 'x' })));
    const layers = h('input', { type: 'checkbox', checked: true }), normals = h('input', { type: 'checkbox', checked: true });
    const animChecks = SS.ANIM_ORDER.map((a) => { const c = h('input', { type: 'checkbox', checked: a !== 'shamble' || S.cfg.zombie.on }); c.dataset.anim = a; return h('label', { class: 'check' }, [c, SS.ANIMS[a].label.split(' (')[0]]); });
    b.append(
      h('div', { class: 'btns' }, [
        h('button', { text: 'Strip PNG', title: 'Current animation and direction as one row', onclick: exportStrip }),
        h('button', { text: 'GIF', title: 'Current animation at 4x on the current background', onclick: exportGif }),
        h('button', { text: 'AI guide pack', title: 'Pose, OpenPose, depth, normal and mask sheets plus prompts for Codex / ComfyUI', onclick: exportGuides }),
      ]),
      h('div', { class: 'note', text: 'Sprite sheet: every ticked animation × direction, one row each, with a manifest in the DEADFARM atlas format.' }),
      h('div', { class: 'grid2' }, animChecks),
      h('div', { class: 'row' }, [h('label', { text: 'Directions' }), dirs, h('span')]),
      h('div', { class: 'row' }, [h('label', { text: 'Cell' }), width, h('span')]),
      h('div', { class: 'row' }, [h('label', { text: 'Scale' }), scale, h('span')]),
      h('div', { class: 'grid2' }, [h('label', { class: 'check' }, [layers, 'Layer sheets']), h('label', { class: 'check' }, [normals, 'Normal map'])]),
      h('button', {
        class: 'primary', text: 'Export sprite sheet (.zip)', onclick: () => exportSheet({
          anims: animChecks.map((l) => l.querySelector('input')).filter((c) => c.checked).map((c) => c.dataset.anim),
          dirs: dirs.value === '5' ? DRAWN5 : DIRS.map((d, i) => i), width: width.value, scale: +scale.value, layers: layers.checked, normals: normals.checked,
        }),
      }),
    );
  }

  async function exportStrip() {
    if (!S.frames.length) return;
    const w = S.mode === 'gen' ? cellFor(S.frames) : S.frames[0].W;
    const { canvas } = SS.buildSheet([{ name: 'row', frames: S.frames, loop: S.loop }], { w, h: S.frames[0].H, cx: S.mode === 'gen' ? CELL.cx : S.frames[0].W / 2 }, 1);
    canvas.toBlob((bl) => SS.download(bl, `${S.cfg.name}_${S.anim}_${DIRS[S.dir].name}.png`));
  }
  function exportGif() {
    if (!S.frames.length) return;
    const sc = 4, bg = S.view.bg === 'checker' ? null : BG[S.view.bg];
    const frames = S.frames.map((f) => {
      const c = SS.frameCanvas(f, sc, bg);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      return { W: c.width, H: c.height, rgba: d.data, ms: Math.round(f.ms / S.speed) };
    });
    SS.download(SS.encodeGIF(frames), `${S.cfg.name}_${S.mode === 'gen' ? S.anim + '_' + DIRS[S.dir].name : 'import'}.gif`);
  }

  async function exportSheet(opt) {
    if (!opt.anims.length) { toast('Tick at least one animation'); return; }
    busy(true, 'Rendering…');
    const rows = [];
    let done = 0;
    const total = opt.anims.length * opt.dirs.length;
    for (const a of opt.anims) for (const d of opt.dirs) {
      const r = renderAnim(a, d);
      rows.push({ name: `${DIRS[d].name}_${a}`, anim: a, dir: DIRS[d].name, frames: withDurations(a, r.frames), loop: r.loop });
      done++; $('#busyText').textContent = `Rendering ${done}/${total}`;
      await nextFrame();
    }
    const w = opt.width === 'auto' ? Math.max(...rows.map((r) => cellFor(r.frames))) : +opt.width;
    const cell = { w, h: CELL.H, cx: CELL.cx };
    const sheet = SS.buildSheet(rows, cell, opt.scale);
    const files = [];
    sheet.manifest.character = S.cfg;
    sheet.manifest.directions = opt.dirs.length === 5 ? 'five drawn views; mirror downside, side and upside for the left-facing three' : 'all eight rendered';
    files.push({ name: `${S.cfg.name}.png`, data: await SS.canvasBytes(sheet.canvas) });
    // parts: the colours each material uses, for runtime recolours
    const M = SS.buildMaterials(S.cfg);
    const parts = {};
    M.list.forEach((m) => { parts[m.name] = { layer: m.layer, base: m.base, colors: m.ramp.map(SS.rgb2hex) }; });
    files.push({ name: `${S.cfg.name}.parts.json`, data: JSON.stringify({ parts, ink: S.cfg.style.ink }, null, 1) });
    if (opt.layers) {
      for (let li = 0; li < SS.LAYERS.length; li++) {
        const lrows = rows.map((r) => ({ name: r.name, loop: r.loop, frames: r.frames.map((f) => {
          const rgba = new Uint8ClampedArray(f.rgba);
          for (let i = 0; i < f.layer.length; i++) if (f.layer[i] !== li) rgba[i * 4 + 3] = 0;
          return { W: f.W, H: f.H, rgba, ms: f.ms };
        }) }));
        if (lrows.every((r) => r.frames.every(SS.isEmptyFrame))) continue;
        files.push({ name: `layers/${S.cfg.name}.${SS.LAYERS[li]}.png`, data: await SS.canvasBytes(SS.buildSheet(lrows, cell, opt.scale).canvas) });
      }
    }
    if (opt.normals) {
      const nrows = rows.map((r) => ({ name: r.name, loop: r.loop, frames: r.frames.map((f) => normalFrame(f)) }));
      files.push({ name: `${S.cfg.name}.normal.png`, data: await SS.canvasBytes(SS.buildSheet(nrows, cell, opt.scale).canvas) });
    }
    if (sheet.lost) sheet.manifest.warning = `${sheet.lost} pixels fell outside the ${w}px cell`;
    files.push({ name: `${S.cfg.name}.json`, data: JSON.stringify(sheet.manifest, null, 1) });
    SS.download(SS.zip(files), `${S.cfg.name}_sheet.zip`);
    busy(false);
    toast(`Exported ${rows.length} rows` + (sheet.lost ? ` · ${sheet.lost} px cropped, use a wider cell` : ''));
  }

  const FX = SS.LAYERS.indexOf('fx');
  function normalFrame(f) {
    const rgba = new Uint8ClampedArray(f.W * f.H * 4);
    for (let i = 0; i < f.W * f.H; i++) {
      if (!f.rgba[i * 4 + 3]) continue;
      // smears are motion marks, not surfaces: they face the viewer flat
      if (f.layer[i] === FX) { rgba.set([128, 128, 255, 255], i * 4); continue; }
      rgba[i * 4] = Math.round((f.nrm[i * 3] * 0.5 + 0.5) * 255);
      rgba[i * 4 + 1] = Math.round((f.nrm[i * 3 + 1] * 0.5 + 0.5) * 255);
      rgba[i * 4 + 2] = Math.round((Math.max(0, f.nrm[i * 3 + 2]) * 0.5 + 0.5) * 255);
      rgba[i * 4 + 3] = 255;
    }
    return { W: f.W, H: f.H, rgba, ms: f.ms };
  }

  // keypoints in cell pixels (COCO-18 order: nose, neck, R arm, L arm, R leg, L leg, eyes, ears)
  function keypoints(f) {
    const { J, P, yaw } = f;
    const Rv = SS.m3.ry(yaw * SS.D2R), k = S.cfg.style.tilt || 0;
    const pr = (p) => { const q = SS.m3.v(Rv, p); return { x: CELL.cx + q[0], y: CELL.ground - q[1] + k * q[2], z: q[2] }; };
    const hp = (v) => SS.v3.add(J.head, SS.m3.v(J.Rh, v));
    const facing = (v) => SS.m3.v(Rv, SS.m3.v(J.Rh, v))[2] > -0.15;
    const pts = [hp([0, -0.95, P.headR[2]]), J.neckBase, J.shoulderR, J.elbowR, J.wristR, J.shoulderL, J.elbowL, J.wristL,
      J.hipR, J.kneeR, J.ankleR, J.hipL, J.kneeL, J.ankleL, hp([-1.75, -0.15, 4.1]), hp([1.75, -0.15, 4.1]), hp([-4.2, -0.5, -0.3]), hp([4.2, -0.5, -0.3])].map(pr);
    const out = pts.map((p) => [p.x, p.y]);
    if (!facing([0, 0, 1])) out[0] = null;
    if (!facing([-0.6, 0, 0.8])) out[14] = null;
    if (!facing([0.6, 0, 0.8])) out[15] = null;
    if (!facing([-1, 0, 0])) out[16] = null;
    if (!facing([1, 0, 0])) out[17] = null;
    return out;
  }

  async function exportGuides() {
    if (S.mode !== 'gen' || !S.frames.length) { toast('Guide packs come from generated frames'); return; }
    busy(true, 'Building guide sheets…'); await nextFrame();
    const frames = S.frames, n = frames.length;
    const cw = cellFor(frames), chh = CELL.H;
    // largest block size that fits the frames on a 1536x1024 canvas (the Codex template size)
    let s = 8, cols = n, rowsN = 1;
    for (const cand of [8, 7, 6, 5, 4, 3, 2]) {
      const maxCols = Math.floor(1536 / (cw * cand)), maxRows = Math.floor(1024 / (chh * cand));
      // balanced rows (4 x 2, not 6 + 2): a model copies a full grid more faithfully than a ragged one
      if (maxCols * maxRows >= n) { s = cand; rowsN = Math.ceil(n / Math.min(n, maxCols)); cols = Math.ceil(n / rowsN); break; }
    }
    const Wc = 1536, Hc = 1024;
    const ox = Math.floor((Wc - cols * cw * s) / 2), oy = Math.floor((Hc - rowsN * chh * s) / 2);
    const mk = (bg) => { const c = h('canvas', { width: Wc, height: Hc }); const g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.fillStyle = bg; g.fillRect(0, 0, Wc, Hc); return { c, g }; };
    const sheets = { pose: mk('#ff00ff'), openpose: mk('#000000'), depth: mk('#000000'), normal: mk('#8080ff'), mask: mk('#000000') };
    const at = (i) => [ox + (i % cols) * cw * s, oy + Math.floor(i / cols) * chh * s];
    const x0 = CELL.cx - cw / 2;
    frames.forEach((f, i) => {
      const [px, py] = at(i);
      const crop = SS.cropFrame(f, cw, chh, CELL.cx);
      sheets.pose.g.drawImage(SS.frameCanvas(crop, s), px, py);
      // depth: nearer is brighter, normalised over the animation
      const dep = { W: f.W, H: f.H, rgba: new Uint8ClampedArray(f.W * f.H * 4) };
      const msk = { W: f.W, H: f.H, rgba: new Uint8ClampedArray(f.W * f.H * 4) };
      let lo = 1e9, hi = -1e9;
      for (let j = 0; j < f.W * f.H; j++) if (f.rgba[j * 4 + 3] && f.layer[j] !== FX) { lo = Math.min(lo, f.depth[j]); hi = Math.max(hi, f.depth[j]); }
      for (let j = 0; j < f.W * f.H; j++) {
        if (!f.rgba[j * 4 + 3] || f.layer[j] === FX) continue;
        const v = Math.round(60 + 195 * (f.depth[j] - lo) / Math.max(1, hi - lo));
        dep.rgba.set([v, v, v, 255], j * 4); msk.rgba.set([255, 255, 255, 255], j * 4);
      }
      sheets.depth.g.drawImage(SS.frameCanvas(SS.cropFrame(dep, cw, chh, CELL.cx), s), px, py);
      sheets.mask.g.drawImage(SS.frameCanvas(SS.cropFrame(msk, cw, chh, CELL.cx), s), px, py);
      sheets.normal.g.drawImage(SS.frameCanvas(SS.cropFrame(normalFrame(f), cw, chh, CELL.cx), s), px, py);
      const kp = keypoints(f).map((p) => (p ? [p[0] - x0, p[1]] : null));
      SS.drawOpenPose(sheets.openpose.g, kp, px, py, s);
    });
    const files = [];
    for (const [name, sh] of Object.entries(sheets)) files.push({ name: `${name}_sheet.png`, data: await SS.canvasBytes(sh.c) });
    for (let i = 0; i < n; i++) files.push({ name: `frames/${String(i).padStart(2, '0')}.png`, data: await SS.canvasBytes(SS.frameCanvas(SS.cropFrame(frames[i], cw, chh, CELL.cx), 1)) });
    const desc = describe(S.cfg);
    const dirName = DIRS[S.dir];
    const height = S.stats.filter((x) => !x.empty).map((x) => x.height);
    files.push({ name: 'prompt_codex.txt', data: codexPrompt(desc, n, s, dirName, Math.max(...height), cols, rowsN) });
    files.push({ name: 'README.txt', data: guideReadme(n, s, cw, chh, cols, rowsN, frames) });
    files.push({ name: 'layout.json', data: JSON.stringify({ blockSize: s, canvas: [Wc, Hc], origin: [ox, oy], cell: [cw * s, chh * s], columns: cols, rows: rowsN, frames: n, durations_ms: frames.map((f) => f.ms), anim: S.anim, dir: dirName.name, character: S.cfg }, null, 1) });
    SS.download(SS.zip(files), `${S.cfg.name}_${S.anim}_${dirName.name}_guides.zip`);
    busy(false);
    toast(`Guide pack: ${n} frames at ${s}x`);
  }

  function describe(c) {
    const C = SS.CATALOG, lab = (list, v) => (list.find((x) => x[0] === v) || [, v])[1].toLowerCase();
    const parts = [
      `${c.body.type === 'female' ? 'a woman' : 'a man'} with ${lab(C.hair, c.hair.style)} hair (${c.hair.color})`,
      c.face.facial !== 'none' ? lab(C.facial, c.face.facial) : null,
      c.top.type !== 'none' ? `${lab(C.top, c.top.type)} (${c.top.color})` : 'bare chest',
      `${lab(C.bottom, c.bottom.type)} (${c.bottom.color})`, `${lab(C.shoes, c.shoes.type)} (${c.shoes.color})`,
      c.hat.type !== 'none' ? lab(C.hat, c.hat.type) : null, c.extras.backpack ? 'a backpack' : null, c.extras.glasses ? 'glasses' : null,
      c.weapon.type !== 'none' ? `a ${c.weapon.type} in the right hand` : null, c.zombie.on ? 'a zombie: sickly skin, torn and bloodied clothes' : null,
    ].filter(Boolean);
    return parts.join(', ');
  }
  function codexPrompt(desc, n, s, dir, height, cols, rowsN) {
    return [
      `Edit the first image. It is a sprite sheet: ${n} frames of one character's ${SS.ANIMS[S.anim].label.toLowerCase()} animation, facing ${dir.name} (${dir.key}), laid out ${cols} x ${rowsN}, drawn as pixel art at ${s}x on a flat #FF00FF background: every ${s}x${s} block is one art pixel.`,
      `Repaint every frame as the character in the second image (your master drawing): ${desc}. Same face, hair, outfit, colours and shading style as the master.`,
      '',
      'Locks, each one absolute:',
      `- Pose lock: keep every frame's exact pose, silhouette, limb positions and place in its cell. Do not add, drop, reorder or merge frames.`,
      `- Pixel-grid lock: the same ${s}x block size everywhere, the figure about ${height} art pixels tall, the feet on the same ground line in every frame.`,
      '- Frame-copy lock: the head, torso and outfit details are identical in every frame; only what the pose moves changes.',
      '- One light from the upper left, dark outlines around the figure, no anti-aliasing against the background.',
      '- Keep the flat #FF00FF background. No ground shadow, text, frame borders or extra props.',
      '',
      'After generation: snap to the grid and the palette (charpipe snap / art/tools/pixelfix.py), then load the result in Sprite Studio > Inspect file with pixel scale ' + s + ' and check every pair.',
    ].join('\n');
  }
  function guideReadme(n, s, cw, chh, cols, rowsN, frames) {
    return [
      'Sprite Studio guide pack',
      '',
      `${n} frames, ${cw}x${chh} art px each, drawn at ${s}x on a 1536x1024 canvas (${cols} x ${rowsN}). Durations (ms): ${frames.map((f) => f.ms).join(', ')}.`,
      '',
      'pose_sheet.png      the frames as rendered, on #FF00FF: the base image for a Codex edit (prompt_codex.txt)',
      'openpose_sheet.png  COCO-18 skeletons in the same layout: ControlNet OpenPose / Qwen-Image-Edit keypoint input',
      'depth_sheet.png     nearer = brighter, per frame: ControlNet depth or Wan VACE depth control',
      'normal_sheet.png    camera-space normals (R = right, G = up, B = toward the viewer)',
      'mask_sheet.png      white silhouettes: inpaint masks and silhouette checks',
      'frames/NN.png       each frame at 1x, for a control video (Wan VACE needs 4n+1 frames: repeat the loop and trim)',
      'layout.json         block size, origin, cell size and the character settings',
      '',
      'The motion, timing and silhouettes here are deterministic: whatever a model paints over them,',
      'the poses cannot drift. Judge the painted result frame by frame in Inspect mode.',
    ].join('\n');
  }

  // ---------- wiring ----------
  function setMode(m) {
    S.mode = m;
    document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    $('#genPanel').classList.toggle('hidden', m !== 'gen');
    $('#inspectPanel').classList.toggle('hidden', m !== 'inspect');
    $('#videoPanel').classList.toggle('hidden', m !== 'video');
    $('#animBox').classList.toggle('hidden', m !== 'gen');
    refresh();
  }

  function init() {
    const pre = $('#preset');
    pre.append(h('option', { value: '', text: 'Presets…' }));
    Object.keys(SS.PRESETS).forEach((k) => pre.append(h('option', { value: k, text: k })));
    pre.addEventListener('change', () => { if (!pre.value) return; S.cfg = SS.mergeCharacter(SS.PRESETS[pre.value]); if (S.cfg.zombie.on && S.anim === 'walk') S.anim = 'shamble'; pre.value = ''; buildGenPanel(); buildAnimPanel(); buildExportPanel(); refresh(true); });
    $('#randomBtn').addEventListener('click', randomise);
    $('#saveBtn').addEventListener('click', () => SS.download(new Blob([JSON.stringify(S.cfg, null, 1)], { type: 'application/json' }), `${S.cfg.name}.character.json`));
    $('#loadBtn').addEventListener('click', () => $('#loadFile').click());
    $('#loadFile').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { S.cfg = SS.mergeCharacter(JSON.parse(await f.text())); buildGenPanel(); refresh(true); toast('Loaded ' + f.name); } catch (err) { toast('Not a character JSON'); }
    });
    document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    const zoom = $('#zoom');
    [2, 3, 4, 5, 6, 8, 10, 12].forEach((z) => zoom.append(h('option', { value: z, text: z + 'x' })));
    zoom.value = S.view.zoom;
    zoom.addEventListener('change', () => { S.view.zoom = +zoom.value; drawAll(); });
    $('#bg').addEventListener('change', (e) => { S.view.bg = e.target.value; buildStrip(); drawAll(); });
    for (const id of ['onion', 'diff', 'guides', 'grid', 'orph']) $('#' + id).addEventListener('change', (e) => { S.view[id] = e.target.checked; drawAll(); });
    $('#refBtn').addEventListener('click', () => $('#refFile').click());
    $('#refFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; S.view.ref = await SS.loadImageFile(f); drawAll(); });
    $('#refAlpha').addEventListener('input', (e) => { S.view.refAlpha = +e.target.value; drawAll(); });
    $('#play').addEventListener('click', () => { S.playing = !S.playing; S.wait = 0; syncPlay(); });
    $('#prev').addEventListener('click', () => step(-1));
    $('#next').addEventListener('click', () => step(1));
    $('#first').addEventListener('click', () => { S.playing = false; syncPlay(); S.cur = 0; drawAll(); });
    $('#last').addEventListener('click', () => { S.playing = false; syncPlay(); S.cur = Math.max(0, S.frames.length - 1); drawAll(); });
    $('#speed').addEventListener('change', (e) => { S.speed = +e.target.value; });
    $('#loopMode').addEventListener('change', (e) => { S.loopMode = e.target.value; S.wait = 0; });
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input[type=number], input[type=text], select')) return;
      if (e.key === ' ') { e.preventDefault(); S.playing = !S.playing; S.wait = 0; syncPlay(); }
      else if (e.key === 'ArrowLeft' || e.key === ',') step(-1);
      else if (e.key === 'ArrowRight' || e.key === '.') step(1);
      else if (e.key === 'Home') { S.cur = 0; S.playing = false; syncPlay(); drawAll(); }
      else if (e.key === 'End') { S.cur = S.frames.length - 1; S.playing = false; syncPlay(); drawAll(); }
      else if ((e.key === 'a' || e.key === 'd') && S.mode === 'gen') {
        // DIRS runs S, SE, E, NE ... so +1 turns the figure counter-clockwise on screen
        S.dir = (S.dir + (e.key === 'd' ? 1 : 7)) % 8; buildCompass(); refresh(true);
      } else if (e.key === 'o') { S.view.onion = !S.view.onion; $('#onion').checked = S.view.onion; drawAll(); }
      else if (e.key === 'f') { S.view.diff = !S.view.diff; $('#diff').checked = S.view.diff; drawAll(); }
    });
    buildGenPanel(); buildInspectPanel(); buildAnimPanel(); buildCompass(); buildExportPanel();
    refresh();
    requestAnimationFrame(tick);
  }

  SS.app = { S, renderAnim, refresh, DIRS, CELL, h, section, toast, busy, drawAll, setMode, paintBg };
  init();
})(window.SS);
