// Customisable parts for palette-locked sprites: every colour belongs to one part (skin, hair, top...),
// so code can recolour, hide or swap parts on any frame. Works in the studio, in a game (browser) and in
// Node: frames are plain { W, H, rgba } objects, and parts.json from the studio's export is the map.
//
//   const P = SpriteParts.create(partsJson);           // { colours: { '#rrggbb': 'top', ... }, ... }
//   const out = P.customise(frames, (api) => {
//     api.recolor('top', '#7a3b2a');                    // shirt
//     api.recolor('hair', '#c9a15a');
//     api.hide('gear');
//     api.swapHead(headFrame, { dx: 0, dy: 0 });         // a 1x { W, H, rgba } head, bottom-centre on the neck
//     api.swapHead(headFrame, { fit: true });            // ...placed where it best covers the frame's own head
//     api.eachFrame((f, i, t) => { ... t.partAt(x, y) ... });
//   });
(function (root, factory) {
  const SP = factory();
  if (typeof module === 'object' && module.exports) module.exports = SP;
  root.SpriteParts = SP;
  if (root.SS) root.SS.Parts = SP;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const PARTS = ['outline', 'skin', 'eyes', 'hair', 'hat', 'top', 'bottom', 'shoes', 'gear', 'other'];
  const HEAD_PARTS = new Set(['skin', 'eyes', 'hair', 'hat', 'outline']);

  const hex = (n) => '#' + n.toString(16).padStart(6, '0');
  const unhex = (s) => parseInt(String(s).replace('#', ''), 16);
  const keyAt = (f, i) => (f.rgba[i * 4] << 16) | (f.rgba[i * 4 + 1] << 8) | f.rgba[i * 4 + 2];
  const clone = (f) => Object.assign({}, f, { rgba: new Uint8ClampedArray(f.rgba) });

  function rgb2hsl(c) {
    const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hsl2rgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
    if (!s) { const v = Math.round(l * 255); return (v << 16) | (v << 8) | v; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return (Math.round(f(h + 1 / 3) * 255) << 16) | (Math.round(f(h) * 255) << 8) | Math.round(f(h - 1 / 3) * 255);
  }

  // Guess which part each colour of a 1x drawing belongs to, from where it sits on the figure and its hue.
  // It is a starting point: the studio lets you correct it, and parts.json stores the result.
  function guess(f) {
    let top = f.H, bot = -1;
    for (let i = 0; i < f.W * f.H; i++) if (f.rgba[i * 4 + 3]) { const y = (i / f.W) | 0; top = Math.min(top, y); bot = Math.max(bot, y); }
    const hgt = Math.max(1, bot - top + 1), st = new Map();
    for (let i = 0; i < f.W * f.H; i++) {
      if (!f.rgba[i * 4 + 3]) continue;
      const k = keyAt(f, i), y = ((i / f.W) | 0) - top;
      const s = st.get(k) || { n: 0, y: 0, ys: [] };
      s.n++; s.y += y / hgt; s.ys.push(y / hgt); st.set(k, s);
    }
    const out = {};
    let darkest = null, dl = 9;
    for (const [k, s] of st) { const l = rgb2hsl(k)[2]; if (l < dl) { dl = l; darkest = k; } }
    // each colour goes to the band holding most of its pixels: head (top 17%), top, bottom, shoes (last 8%)
    const band = (y) => (y < 0.17 ? 'hair' : y < 0.47 ? 'top' : y < 0.56 ? 'gear' : y < 0.88 ? 'bottom' : 'shoes');
    for (const [k, s] of st) {
      const [hh, ss, ll] = rgb2hsl(k);
      const spread = Math.max(...s.ys) - Math.min(...s.ys);
      const votes = {};
      s.ys.forEach((y) => { const b = band(y); votes[b] = (votes[b] || 0) + 1; });
      const where = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0];
      let p;
      if (k === darkest || (ll < 0.14 && spread > 0.6)) p = 'outline';
      else if (hh >= 8 && hh <= 40 && ss > 0.3 && ll > 0.45 && ll < 0.85) p = 'skin';
      // the waist band holds the belt; a colour mostly there that is not cloth-coloured is gear
      else p = where === 'gear' && ss < 0.3 ? (s.y / s.n < 0.5 ? 'top' : 'bottom') : where;
      out[hex(k)] = p;
    }
    return out;
  }

  function create(json) {
    const colours = {};
    for (const [c, p] of Object.entries((json && json.colours) || json || {})) colours[unhex(c)] = p;
    const partOf = (k) => colours[k] || 'other';

    // the head's box on one frame: from the top of the figure down to the first row where the top
    // (shirt) starts, across the head-part pixels in those rows
    function headBox(f) {
      let top = -1;
      for (let y = 0; y < f.H && top < 0; y++) for (let x = 0; x < f.W; x++) if (f.rgba[(y * f.W + x) * 4 + 3]) { top = y; break; }
      if (top < 0) return null;
      let feet = top;
      for (let i = 0; i < f.W * f.H; i++) if (f.rgba[i * 4 + 3]) feet = Math.max(feet, (i / f.W) | 0);
      const minHead = Math.round((feet - top + 1) * 0.12);
      let bottom = top, x0 = f.W, x1 = -1;
      for (let y = top; y < f.H; y++) {
        let shirt = 0, head = 0, n = 0;
        for (let x = 0; x < f.W; x++) {
          const i = y * f.W + x;
          if (!f.rgba[i * 4 + 3]) continue;
          n++;
          const p = partOf(keyAt(f, i));
          if (p === 'top') shirt++;
          else if (HEAD_PARTS.has(p)) head++;
        }
        // the neck: the first row, below a plausible head height, that is mostly shirt
        if (shirt >= Math.max(2, n * 0.3) && y > top + minHead) break;
        if (!n) continue;
        bottom = y;
        for (let x = 0; x < f.W; x++) if (f.rgba[(y * f.W + x) * 4 + 3]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
        if (y - top > 24) break;
      }
      if (x1 < 0) return null;
      return { x: x0, y: top, w: x1 - x0 + 1, h: bottom - top + 1, cx: (x0 + x1 + 1) / 2, neck: bottom + 1, feet };
    }

    // The part of every pixel. Colours alone are not enough on video frames (hair snaps to browns the
    // drawing also uses on the belt and shoes), so position decides between them: above the neck only
    // head parts exist, and a head colour below the neck is gear, or shoes near the feet.
    function labels(f, box = headBox(f)) {
      const out = new Array(f.W * f.H).fill(null);
      for (let i = 0; i < f.W * f.H; i++) {
        if (!f.rgba[i * 4 + 3]) continue;
        let p = partOf(keyAt(f, i));
        const y = (i / f.W) | 0;
        if (box && y < box.neck) { if (!HEAD_PARTS.has(p)) p = 'hair'; }
        else if (box && (p === 'hair' || p === 'eyes' || p === 'hat')) p = y >= box.feet - Math.round((box.feet - box.y) * 0.1) ? 'shoes' : 'gear';
        out[i] = p;
      }
      return out;
    }

    // transparent pixels with 3+ opaque 4-neighbours take their most common neighbour colour
    function fillHoles(f, y0, y1) {
      const src = new Uint8ClampedArray(f.rgba);
      for (let y = Math.max(1, y0); y < Math.min(f.H - 1, y1); y++) for (let x = 1; x < f.W - 1; x++) {
        const i = y * f.W + x;
        if (src[i * 4 + 3]) continue;
        const n = new Map(); let m = 0;
        for (const j of [i - 1, i + 1, i - f.W, i + f.W]) if (src[j * 4 + 3]) { m++; const k = (src[j * 4] << 16) | (src[j * 4 + 1] << 8) | src[j * 4 + 2]; n.set(k, (n.get(k) || 0) + 1); }
        if (m < 3) continue;
        const k = [...n.entries()].sort((a, b) => b[1] - a[1])[0][0];
        f.rgba[i * 4] = (k >> 16) & 255; f.rgba[i * 4 + 1] = (k >> 8) & 255; f.rgba[i * 4 + 2] = k & 255; f.rgba[i * 4 + 3] = 255;
      }
    }

    // colour -> recoloured colour for one part. It keeps the ramp: hue shifts and lightness steps stay
    // relative to the part's mean colour, which moves to the target.
    function recolorTable(part, target) {
      const ks = Object.keys(colours).map(Number).filter((k) => colours[k] === part);
      if (!ks.length) return null;
      const hs = ks.map(rgb2hsl);
      // hue is circular: average it as a vector, weighted by saturation so greys don't pull it
      let hx = 0, hy = 0;
      hs.forEach((c) => { hx += Math.cos(c[0] * Math.PI / 180) * c[1]; hy += Math.sin(c[0] * Math.PI / 180) * c[1]; });
      const mean = [Math.atan2(hy, hx) * 180 / Math.PI, hs.reduce((a, c) => a + c[1], 0) / hs.length, hs.reduce((a, c) => a + c[2], 0) / hs.length];
      const t = rgb2hsl(unhex(target)), cache = new Map();
      return (k) => {
        let v = cache.get(k);
        if (v === undefined) {
          const [h, s, l] = rgb2hsl(k), ns = mean[1] > 0.02 ? s * (t[1] / mean[1]) : t[1];
          let dh = ((h - mean[0] + 540) % 360) - 180;
          dh = Math.max(-20, Math.min(20, dh));
          v = hsl2rgb(t[0] + dh * 0.6, ns, l + (t[2] - mean[2]));
          cache.set(k, v);
        }
        return v;
      };
    }

    function customise(frames, script) {
      const ops = [];
      const api = {
        parts: PARTS,
        recolor: (part, target) => { const m = recolorTable(part, target); if (m) ops.push({ t: 'map', part, m }); return api; },
        hide: (part) => { ops.push({ t: 'hide', part }); return api; },
        only: (...parts) => { ops.push({ t: 'only', parts: new Set(parts) }); return api; },
        swapHead: (head, o = {}) => { if (head) ops.push({ t: 'head', head, dx: o.dx || 0, dy: o.dy || 0, keepHair: !!o.keepHair, fit: !!o.fit }); return api; },
        setPart: (colour, part) => { colours[unhex(colour)] = part; return api; },
        eachFrame: (fn) => { ops.push({ t: 'fn', fn }); return api; },
      };
      if (typeof script === 'function') script(api);
      const prevFit = new Map();
      return frames.map((f0, fi) => {
        const f = clone(f0);
        const box = headBox(f0), lab = labels(f0, box);
        for (const op of ops) {
          if (op.t === 'map') {
            for (let i = 0; i < f.W * f.H; i++) {
              const k0 = keyAt(f0, i);
              if (!f.rgba[i * 4 + 3] || lab[i] !== op.part || keyAt(f, i) !== k0) continue;
              const v = op.m(k0);
              f.rgba[i * 4] = (v >> 16) & 255; f.rgba[i * 4 + 1] = (v >> 8) & 255; f.rgba[i * 4 + 2] = v & 255;
            }
          } else if (op.t === 'hide' || op.t === 'only') {
            for (let i = 0; i < f.W * f.H; i++) {
              const p = lab[i];
              if (op.t === 'hide' ? p === op.part : !op.parts.has(p)) f.rgba[i * 4 + 3] = 0;
            }
          } else if (op.t === 'head' && box) {
            for (let y = box.y; y < box.neck; y++) for (let x = 0; x < f.W; x++) {
              const i = y * f.W + x;
              if (f0.rgba[i * 4 + 3] && !(op.keepHair && lab[i] === 'hair')) f.rgba[i * 4 + 3] = 0;
            }
            const hd = op.head;
            let ox = Math.round(box.cx - hd.W / 2) + op.dx, oy = box.neck - hd.H + op.dy;
            if (op.fit) {
              // place the head where it best covers the frame's own head (IoU of opaque pixels above the
              // neck), within 3 px across and 2 px up or down; keep last frame's offset unless another is
              // clearly better, so the head follows the bob and sway without 1 px jitter
              const own = (x, y) => x >= 0 && y >= 0 && x < f0.W && y < box.neck && f0.rgba[(y * f0.W + x) * 4 + 3] > 0;
              let ownN = 0;
              for (let y = box.y; y < box.neck; y++) for (let x = 0; x < f0.W; x++) if (own(x, y)) ownN++;
              const score = (dx, dy) => {
                let both = 0, hn = 0;
                for (let y = 0; y < hd.H; y++) for (let x = 0; x < hd.W; x++) if (hd.rgba[(y * hd.W + x) * 4 + 3]) { hn++; if (own(ox + dx + x, oy + dy + y)) both++; }
                return both / (hn + ownN - both || 1);
              };
              let best = { dx: 0, dy: 0, s: -1 };
              for (let dy = -2; dy <= 2; dy++) for (let dx = -3; dx <= 3; dx++) { const sc = score(dx, dy); if (sc > best.s) best = { dx, dy, s: sc }; }
              const prev = prevFit.get(op);
              if (prev) { const ps = score(prev.rx - ox, prev.ry - oy); if (ps >= best.s - 0.04) best = { dx: prev.rx - ox, dy: prev.ry - oy, s: ps }; }
              ox += best.dx; oy += best.dy;
              prevFit.set(op, { rx: ox, ry: oy });
            }
            for (let y = 0; y < hd.H; y++) for (let x = 0; x < hd.W; x++) {
              const s = (y * hd.W + x) * 4, tx = ox + x, ty = oy + y;
              if (!hd.rgba[s + 3] || tx < 0 || ty < 0 || tx >= f.W || ty >= f.H) continue;
              const d = (ty * f.W + tx) * 4;
              f.rgba[d] = hd.rgba[s]; f.rgba[d + 1] = hd.rgba[s + 1]; f.rgba[d + 2] = hd.rgba[s + 2]; f.rgba[d + 3] = 255;
            }
            // a head placed higher than the old one (or a shorter one) leaves the old neck rows bare: below
            // the new head's lowest pixel in each column, give the frame back its own neck and collar (only
            // near the jaw line, so the old head's wider hair doesn't come back beside the new one)
            const lo = new Array(f.W).fill(oy + hd.H - 1);
            for (let x = 0; x < hd.W; x++) for (let y = hd.H - 1; y >= 0; y--) if (hd.rgba[(y * hd.W + x) * 4 + 3]) { if (ox + x >= 0 && ox + x < f.W) lo[ox + x] = oy + y; break; }
            for (let y = box.y; y < box.neck; y++) for (let x = 0; x < f.W; x++) {
              const i = y * f.W + x;
              if (y > lo[x] && y >= oy + hd.H - 2 && f0.rgba[i * 4 + 3] && !f.rgba[i * 4 + 3]) f.rgba.set(f0.rgba.subarray(i * 4, i * 4 + 4), i * 4);
            }
            // close holes left where the old head was wider than the new one
            fillHoles(f, Math.min(box.y, oy), box.neck + 1);
          } else if (op.t === 'fn') {
            op.fn(f, fi, { source: f0, head: box, partAt: (x, y) => (x < 0 || y < 0 || x >= f.W || y >= f.H) ? null : lab[y * f.W + x], hex, unhex });
          }
        }
        return f;
      });
    }

    // one frame per part, for per-layer sheets (stacking every layer gives back the frame)
    function layers(f) {
      const out = {}, lab = labels(f);
      for (let i = 0; i < f.W * f.H; i++) {
        if (!f.rgba[i * 4 + 3]) continue;
        const p = lab[i];
        if (!out[p]) out[p] = { W: f.W, H: f.H, rgba: new Uint8ClampedArray(f.W * f.H * 4), ms: f.ms };
        out[p].rgba.set(f.rgba.subarray(i * 4, i * 4 + 4), i * 4);
      }
      return out;
    }

    const toJSON = (extra = {}) => Object.assign({ format: 'sprite_studio.parts/1', parts: PARTS, colours: Object.fromEntries(Object.entries(colours).map(([k, v]) => [hex(+k), v])) }, extra);
    return { colours, partOf, headBox, labels, customise, layers, recolorTable, fillHoles, toJSON };
  }

  // a head cut from a 1x frame (for swapping heads between characters)
  function cutHead(f, partsJson) {
    const P = create(partsJson), b = P.headBox(f);
    if (!b) return null;
    const hd = { W: b.w, H: b.neck - b.y, rgba: new Uint8ClampedArray(b.w * (b.neck - b.y) * 4) };
    for (let y = 0; y < hd.H; y++) for (let x = 0; x < hd.W; x++) {
      const i = (b.y + y) * f.W + b.x + x;
      if (f.rgba[i * 4 + 3]) hd.rgba.set(f.rgba.subarray(i * 4, i * 4 + 4), (y * hd.W + x) * 4);
    }
    return hd;
  }

  return { PARTS, HEAD_PARTS, guess, create, cutHead, rgb2hsl, hsl2rgb, hex, unhex };
});
