// Video -> sprite sheet, the "Stop generating fake pixel art" workflow (Chong-U, 2026) applied to Wan clips:
//   anchor (pixel-snapped master)  ->  frame recovery by chroma key + bounding box (no grid crops)
//   ->  curation (pick a clean loop)  ->  pixel snap per frame (locked block size + anchor palette)
//   ->  anchoring (feet on the ground row, head matched to the first frame, manual nudges)
//   ->  normalise + pack into fixed cells with a bottom-centre pivot.
// The grid finder is a port of Sprite Fusion Pixel Snapper (MIT, Hugo Duprez): gradient profiles,
// a peak-median step, an elastic walker that cuts at the strongest edge near each step, and a
// majority vote per cell. Images are plain { W, H, rgba } objects so this also runs in Node.
(function (SS) {
  'use strict';
  const CFG = { k: 16, iters: 15, peakThr: 0.2, peakDist: 4, winRatio: 0.35, winMin: 2, strength: 0.5, minCuts: 4, fallbackSeg: 64, maxStepRatio: 1.8 };

  const img = (W, H) => ({ W, H, rgba: new Uint8ClampedArray(W * H * 4) });
  const key = (d, i) => (d[i * 4] << 16) | (d[i * 4 + 1] << 8) | d[i * 4 + 2];

  // ---------- colour ----------
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  function lab(r, g, b) {
    const R = lin(r), G = lin(g), B = lin(b);
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), y = f(0.2126 * R + 0.7152 * G + 0.0722 * B), z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  // nearest palette colour in Lab, cached per input colour
  function paletteMapper(palette) {
    const P = palette.map((c) => ({ c, l: lab((c >> 16) & 255, (c >> 8) & 255, c & 255) }));
    const cache = new Map();
    return (r, g, b) => {
      const k = (r << 16) | (g << 8) | b;
      let v = cache.get(k);
      if (v !== undefined) return v;
      const L = lab(r, g, b);
      let best = P[0].c, bd = 1e18;
      for (const p of P) { const d = (L[0] - p.l[0]) ** 2 + (L[1] - p.l[1]) ** 2 + (L[2] - p.l[2]) ** 2; if (d < bd) { bd = d; best = p.c; } }
      cache.set(k, best);
      return best;
    };
  }
  function paletteOf(f, max = 256) {
    const n = new Map();
    for (let i = 0; i < f.W * f.H; i++) if (f.rgba[i * 4 + 3] >= 128) { const k = key(f.rgba, i); n.set(k, (n.get(k) || 0) + 1); }
    return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map((e) => e[0]);
  }

  // ---------- k-means (k-means++ seeding, seeded PRNG so a frame always snaps the same way) ----------
  function kmeans(pts, k, iters, seed = 42) {
    let s = seed >>> 0;
    const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const n = pts.length / 3;
    k = Math.min(k, n);
    const C = [], dist = new Float64Array(n).fill(Infinity);
    let f = Math.floor(rnd() * n); C.push([pts[f * 3], pts[f * 3 + 1], pts[f * 3 + 2]]);
    while (C.length < k) {
      const c = C[C.length - 1]; let sum = 0;
      for (let i = 0; i < n; i++) { const d = (pts[i * 3] - c[0]) ** 2 + (pts[i * 3 + 1] - c[1]) ** 2 + (pts[i * 3 + 2] - c[2]) ** 2; if (d < dist[i]) dist[i] = d; sum += dist[i]; }
      let r = rnd() * sum, idx = 0;
      if (sum <= 0) idx = Math.floor(rnd() * n); else { for (; idx < n - 1; idx++) { r -= dist[idx]; if (r <= 0) break; } }
      C.push([pts[idx * 3], pts[idx * 3 + 1], pts[idx * 3 + 2]]);
    }
    const asg = new Int32Array(n);
    for (let it = 0; it < iters; it++) {
      const sums = C.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < n; i++) {
        let b = 0, bd = Infinity;
        for (let j = 0; j < k; j++) { const d = (pts[i * 3] - C[j][0]) ** 2 + (pts[i * 3 + 1] - C[j][1]) ** 2 + (pts[i * 3 + 2] - C[j][2]) ** 2; if (d < bd) { bd = d; b = j; } }
        asg[i] = b; sums[b][0] += pts[i * 3]; sums[b][1] += pts[i * 3 + 1]; sums[b][2] += pts[i * 3 + 2]; sums[b][3]++;
      }
      let move = 0;
      C.forEach((c, j) => { if (!sums[j][3]) return; const nc = [sums[j][0] / sums[j][3], sums[j][1] / sums[j][3], sums[j][2] / sums[j][3]]; move = Math.max(move, (nc[0] - c[0]) ** 2 + (nc[1] - c[1]) ** 2 + (nc[2] - c[2]) ** 2); C[j] = nc; });
      if (it > 0 && move < 0.01) break;
    }
    return C.map((c) => (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2]));
  }

  // every opaque pixel -> its palette colour (palette given) or k-means colour (palette learnt)
  function quantize(f, palette, k = CFG.k) {
    if (!palette) {
      const pts = [];
      const stepN = Math.max(1, Math.floor(f.W * f.H / 60000));
      for (let i = 0; i < f.W * f.H; i += stepN) if (f.rgba[i * 4 + 3]) pts.push(f.rgba[i * 4], f.rgba[i * 4 + 1], f.rgba[i * 4 + 2]);
      if (!pts.length) return { img: f, palette: [] };
      palette = kmeans(pts, k, CFG.iters);
    }
    const near = paletteMapper(palette), o = img(f.W, f.H);
    for (let i = 0; i < f.W * f.H; i++) {
      if (!f.rgba[i * 4 + 3]) continue;
      const c = near(f.rgba[i * 4], f.rgba[i * 4 + 1], f.rgba[i * 4 + 2]);
      o.rgba[i * 4] = (c >> 16) & 255; o.rgba[i * 4 + 1] = (c >> 8) & 255; o.rgba[i * 4 + 2] = c & 255; o.rgba[i * 4 + 3] = 255;
    }
    return { img: o, palette };
  }

  // ---------- Pixel Snapper grid finder ----------
  function profiles(f) {
    const { W, H, rgba: d } = f, px = new Float64Array(W), py = new Float64Array(H);
    const g = (x, y) => { const i = (y * W + x) * 4; return d[i + 3] ? 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] : 0; };
    for (let y = 0; y < H; y++) for (let x = 1; x < W - 1; x++) px[x] += Math.abs(g(x + 1, y) - g(x - 1, y));
    for (let x = 0; x < W; x++) for (let y = 1; y < H - 1; y++) py[y] += Math.abs(g(x, y + 1) - g(x, y - 1));
    return { px, py };
  }
  function estimateStep(p) {
    let mx = 0; for (const v of p) mx = Math.max(mx, v);
    if (!mx) return null;
    const thr = mx * CFG.peakThr, peaks = [];
    for (let i = 1; i < p.length - 1; i++) if (p[i] > thr && p[i] > p[i - 1] && p[i] > p[i + 1]) peaks.push(i);
    const clean = [];
    for (const q of peaks) if (!clean.length || q - clean[clean.length - 1] > CFG.peakDist - 1) clean.push(q);
    if (clean.length < 2) return null;
    const diffs = clean.slice(1).map((q, i) => q - clean[i]).sort((a, b) => a - b);
    return diffs[diffs.length >> 1];
  }
  const mean = (p) => p.reduce((a, b) => a + b, 0) / (p.length || 1);
  function walk(p, step, limit) {
    const cuts = [0], win = Math.max(step * CFG.winRatio, CFG.winMin), mv = mean(p);
    let pos = 0;
    while (pos < limit) {
      const target = pos + step;
      if (target >= limit) { cuts.push(limit); break; }
      const s = Math.max(Math.floor(target - win), Math.floor(pos + 1)), e = Math.min(Math.floor(target + win), limit);
      if (e <= s) { pos = target; continue; }
      let bv = -1, bi = s;
      for (let i = s; i < e; i++) if (p[i] > bv) { bv = p[i]; bi = i; }
      if (bv > mv * CFG.strength) { cuts.push(bi); pos = bi; } else { cuts.push(Math.floor(target)); pos = target; }
    }
    return cuts;
  }
  function sanitize(cuts, limit) {
    const s = new Set(cuts.map((c) => Math.min(c, limit)));
    s.add(0); s.add(limit);
    return [...s].sort((a, b) => a - b);
  }
  function snapUniform(p, limit, step, minReq) {
    if (limit <= 1) return [0, limit];
    let cells = Math.min(limit, Math.max(1, minReq - 1, Math.round(limit / step)));
    const cw = limit / cells, win = Math.max(cw * CFG.winRatio, CFG.winMin), mv = mean(p), cuts = [0];
    for (let i = 1; i < cells; i++) {
      const target = cw * i, prev = cuts[cuts.length - 1];
      if (prev + 1 >= limit) break;
      let s = Math.max(0, prev + 1, Math.floor(target - win)), e = Math.min(limit - 1, Math.ceil(target + win));
      if (e < s) { s = prev + 1; e = s; }
      let bi = Math.min(s, p.length - 1), bv = -1;
      for (let j = s; j <= Math.min(e, p.length - 1); j++) if (p[j] > bv) { bv = p[j]; bi = j; }
      if (bv < mv * CFG.strength) bi = Math.min(Math.max(Math.round(target), prev + 1), Math.max(limit - 1, prev + 1));
      cuts.push(bi);
    }
    return sanitize(cuts, limit);
  }
  function stabilize(p, cuts, limit, sib, sibLimit) {
    cuts = sanitize(cuts, limit);
    const minReq = Math.min(Math.max(CFG.minCuts, 2), limit + 1), cells = cuts.length - 1, sc = sib.length - 1;
    const sibGrid = sibLimit > 0 && sc >= minReq - 1 && sc > 0;
    const ratio = sibGrid && cells > 0 ? (limit / cells) / (sibLimit / sc) : 1;
    if (cuts.length >= minReq && !(ratio > CFG.maxStepRatio || ratio < 1 / CFG.maxStepRatio)) return cuts;
    const target = sibGrid ? sibLimit / sc : limit / CFG.fallbackSeg;
    return snapUniform(p, limit, target > 0 ? target : 1, minReq);
  }
  function resample(f, cols, rows) {
    const o = img(cols.length - 1, rows.length - 1), n = new Map();
    for (let yi = 0; yi < rows.length - 1; yi++) for (let xi = 0; xi < cols.length - 1; xi++) {
      n.clear();
      let best = -1, bc = 0;
      for (let y = rows[yi]; y < rows[yi + 1]; y++) for (let x = cols[xi]; x < cols[xi + 1]; x++) {
        const i = y * f.W + x, v = f.rgba[i * 4 + 3] < 128 ? -1 : key(f.rgba, i);
        const c = (n.get(v) || 0) + 1; n.set(v, c);
        if (c > bc || (c === bc && v < best)) { bc = c; best = v; }
      }
      if (best < 0) continue;
      const d = (yi * o.W + xi) * 4;
      o.rgba[d] = (best >> 16) & 255; o.rgba[d + 1] = (best >> 8) & 255; o.rgba[d + 2] = best & 255; o.rgba[d + 3] = 255;
    }
    return o;
  }
  // A rigid grid for a known block size: the step (within ±tol) and phase whose cuts land on the most
  // edge energy. Unlike the walker it cannot creep, so a 57-block figure always snaps to 57 rows.
  function fitUniform(p, limit, step, tol = 0.04) {
    let best = null;
    for (let s = step * (1 - tol); s <= step * (1 + tol) + 1e-9; s += step * 0.005) {
      for (let ph = 0; ph < s; ph += 0.25) {
        let sc = 0, n = 0;
        for (let c = ph; c < limit; c += s) { const i = Math.round(c); if (i > 0 && i < limit) { sc += p[i]; n++; } }
        if (n && (!best || sc / n > best.sc)) best = { sc: sc / n, s, ph };
      }
    }
    const cuts = [0];
    for (let c = best.ph; c < limit; c += best.s) { const i = Math.round(c); if (i > cuts[cuts.length - 1]) cuts.push(i); }
    return { cuts: sanitize(cuts, limit), step: best.s };
  }
  // opts: { pixelSize (known block size, skips the estimate), grid ('uniform' | 'walker'),
  //         palette (lock to these colours), k }
  function pixelSnap(f, opts = {}) {
    const q = quantize(f, opts.palette, opts.k);
    const { px, py } = profiles(q.img);
    if (opts.pixelSize && opts.grid !== 'walker') {
      const gx = fitUniform(px, f.W, opts.pixelSize), gy = fitUniform(py, f.H, opts.pixelSize);
      return { img: resample(q.img, gx.cuts, gy.cuts), step: (gx.step + gy.step) / 2, cols: gx.cuts, rows: gy.cuts, palette: q.palette };
    }
    let sx, sy;
    if (opts.pixelSize) sx = sy = opts.pixelSize;
    else {
      const ex = estimateStep(px), ey = estimateStep(py);
      if (ex && ey) { const r = Math.max(ex, ey) / Math.min(ex, ey); sx = sy = r > CFG.maxStepRatio ? Math.min(ex, ey) : (ex + ey) / 2; }
      else sx = sy = ex || ey || Math.max(1, Math.min(f.W, f.H) / CFG.fallbackSeg);
    }
    const rc = walk(px, sx, f.W), rr = walk(py, sy, f.H);
    let cols = stabilize(px, rc, f.W, rr, f.H), rows = stabilize(py, rr, f.H, rc, f.W);
    const cs = f.W / Math.max(1, cols.length - 1), rs = f.H / Math.max(1, rows.length - 1);
    if (Math.max(cs, rs) / Math.min(cs, rs) > CFG.maxStepRatio) {
      const t = Math.min(cs, rs);
      if (cs > t * 1.2) cols = snapUniform(px, f.W, t, CFG.minCuts);
      if (rs > t * 1.2) rows = snapUniform(py, f.H, t, CFG.minCuts);
    }
    return { img: resample(q.img, cols, rows), step: sx, cols, rows, palette: q.palette };
  }

  // ---------- chroma key + frame recovery ----------
  function borderColour(f) {
    const rs = [], gs = [], bs = [], add = (x, y) => { const i = (y * f.W + x) * 4; rs.push(f.rgba[i]); gs.push(f.rgba[i + 1]); bs.push(f.rgba[i + 2]); };
    for (let x = 0; x < f.W; x += 2) { add(x, 0); add(x, f.H - 1); }
    for (let y = 0; y < f.H; y += 2) { add(0, y); add(f.W - 1, y); }
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    return (med(rs) << 16) | (med(gs) << 8) | med(bs);
  }
  // key out the background colour; with `hue` on, anything close to the key's hue and saturated is
  // background too (kills the green fringe the video model paints around the figure)
  function chromaKey(f, o = {}) {
    const bg = o.key != null ? o.key : borderColour(f), tol = o.tol != null ? o.tol : 70;
    const br = (bg >> 16) & 255, bgg = (bg >> 8) & 255, bb = bg & 255;
    const SP = (typeof SpriteParts !== 'undefined' && SpriteParts) || (SS.Parts);
    const [bh, bs] = SP.rgb2hsl(bg);
    const out = img(f.W, f.H);
    out.rgba.set(f.rgba);
    for (let i = 0; i < f.W * f.H; i++) {
      const r = f.rgba[i * 4], g = f.rgba[i * 4 + 1], b = f.rgba[i * 4 + 2];
      let kill = Math.hypot(r - br, g - bgg, b - bb) < tol;
      if (!kill && o.hue !== false && bs > 0.35) {
        const [h, s, l] = SP.rgb2hsl((r << 16) | (g << 8) | b);
        const dh = Math.min(Math.abs(h - bh), 360 - Math.abs(h - bh));
        kill = dh < (o.hueTol || 28) && s > 0.4 && l > 0.15;
      }
      out.rgba[i * 4 + 3] = kill ? 0 : 255;
    }
    return { img: out, key: bg };
  }
  // bounding box of the character: the biggest blob plus any blob near it (a detached hand or foot)
  function figureBox(f, near = 12) {
    const W = f.W, H = f.H, lab = new Int32Array(W * H).fill(-1), blobs = [], st = [];
    for (let i = 0; i < W * H; i++) {
      if (!f.rgba[i * 4 + 3] || lab[i] >= 0) continue;
      const id = blobs.length, b = { n: 0, x0: W, y0: H, x1: -1, y1: -1 };
      lab[i] = id; st.push(i);
      while (st.length) {
        const p = st.pop(), x = p % W, y = (p / W) | 0;
        b.n++; if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const q = yy * W + xx;
          if (f.rgba[q * 4 + 3] && lab[q] < 0) { lab[q] = id; st.push(q); }
        }
      }
      blobs.push(b);
    }
    if (!blobs.length) return null;
    const main = blobs.reduce((a, b) => (b.n > a.n ? b : a));
    const box = { x0: main.x0, y0: main.y0, x1: main.x1, y1: main.y1 };
    const keep = new Set([blobs.indexOf(main)]);
    blobs.forEach((b, i) => {
      if (i === blobs.indexOf(main) || b.n < main.n * 0.004) return;
      if (b.x1 < box.x0 - near || b.x0 > box.x1 + near || b.y1 < box.y0 - near || b.y0 > box.y1 + near) return;
      keep.add(i); box.x0 = Math.min(box.x0, b.x0); box.y0 = Math.min(box.y0, b.y0); box.x1 = Math.max(box.x1, b.x1); box.y1 = Math.max(box.y1, b.y1);
    });
    const out = img(f.W, f.H);
    for (let i = 0; i < W * H; i++) if (lab[i] >= 0 && keep.has(lab[i])) out.rgba.set(f.rgba.subarray(i * 4, i * 4 + 4), i * 4);
    return { x: box.x0, y: box.y0, w: box.x1 - box.x0 + 1, h: box.y1 - box.y0 + 1, img: out };
  }
  function crop(f, x, y, w, h) {
    const o = img(w, h);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const sx = x + xx, sy = y + yy;
      if (sx < 0 || sy < 0 || sx >= f.W || sy >= f.H) continue;
      o.rgba.set(f.rgba.subarray((sy * f.W + sx) * 4, (sy * f.W + sx) * 4 + 4), (yy * w + xx) * 4);
    }
    return o;
  }
  // trim to the opaque box
  function trim(f) {
    let x0 = f.W, y0 = f.H, x1 = -1, y1 = -1;
    for (let i = 0; i < f.W * f.H; i++) if (f.rgba[i * 4 + 3]) { const x = i % f.W, y = (i / f.W) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return x1 < 0 ? img(1, 1) : crop(f, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  }

  // lone pixels that match none of their 4 neighbours take the most common neighbour colour
  // drop opaque islands under `min` px (8-connected) that sit apart from the body: snapping a
  // fast hand or a keyed fringe leaves 1-4 px crumbs that flicker on and off between frames
  function dropFragments(f, min = 5) {
    const W = f.W, H = f.H, d = f.rgba, lab = new Int32Array(W * H).fill(-1), sizes = [];
    for (let s = 0; s < W * H; s++) {
      if (!d[s * 4 + 3] || lab[s] >= 0) continue;
      const id = sizes.length, st = [s];
      let n = 0;
      lab[s] = id;
      while (st.length) {
        const i = st.pop(), x = i % W, y = (i / W) | 0;
        n++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const j = yy * W + xx;
          if (d[j * 4 + 3] && lab[j] < 0) { lab[j] = id; st.push(j); }
        }
      }
      sizes.push(n);
    }
    if (sizes.length < 2) return f;
    const body = sizes.indexOf(Math.max(...sizes));
    const o = img(W, H); o.rgba.set(d);
    for (let i = 0; i < W * H; i++) if (lab[i] >= 0 && lab[i] !== body && sizes[lab[i]] < min) o.rgba[i * 4 + 3] = 0;
    return o;
  }
  function cleanOrphans(f) {
    const o = img(f.W, f.H); o.rgba.set(f.rgba);
    const W = f.W, H = f.H, d = f.rgba;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!d[i * 4 + 3]) continue;
      const me = key(d, i), n = new Map();
      let same = false, opaqueN = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx;
        if (!d[j * 4 + 3]) continue;
        opaqueN++;
        const k = key(d, j);
        if (k === me) { same = true; break; }
        n.set(k, (n.get(k) || 0) + 1);
      }
      if (same || opaqueN < 3) continue;
      let best = me, bc = 1;
      for (const [k, c] of n) if (c > bc) { bc = c; best = k; }
      if (best !== me) { o.rgba[i * 4] = (best >> 16) & 255; o.rgba[i * 4 + 1] = (best >> 8) & 255; o.rgba[i * 4 + 2] = best & 255; }
    }
    return o;
  }

  // enclosed transparent gaps of up to `max` px (pinholes) take their most common neighbour colour
  function fillPinholes(f, max = 2) {
    const o = img(f.W, f.H); o.rgba.set(f.rgba);
    const W = f.W, H = f.H, seen = new Uint8Array(W * H);
    for (let s = 0; s < W * H; s++) {
      if (f.rgba[s * 4 + 3] || seen[s]) continue;
      const comp = [s], st = [s]; let edge = false; seen[s] = 1;
      while (st.length) {
        const p = st.pop(), x = p % W, y = (p / W) | 0;
        if (!x || !y || x === W - 1 || y === H - 1) edge = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy, q = yy * W + xx;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H || seen[q] || f.rgba[q * 4 + 3]) continue;
          seen[q] = 1; comp.push(q); st.push(q);
        }
      }
      if (edge || comp.length > max) continue;
      for (const p of comp) {
        const n = new Map();
        for (const q of [p - 1, p + 1, p - W, p + W]) if (q >= 0 && q < W * H && f.rgba[q * 4 + 3]) { const k = key(f.rgba, q); n.set(k, (n.get(k) || 0) + 1); }
        if (!n.size) continue;
        const k = [...n.entries()].sort((a, b) => b[1] - a[1])[0][0];
        o.rgba[p * 4] = (k >> 16) & 255; o.rgba[p * 4 + 1] = (k >> 8) & 255; o.rgba[p * 4 + 2] = k & 255; o.rgba[p * 4 + 3] = 255;
      }
    }
    return o;
  }

  // ---------- steps ----------
  // Step 2/4 of the video: snap the generated master to true pixels. A small image (<= 128 px) is taken
  // as already 1x pixel art.
  function snapAnchor(f, o = {}) {
    let one;
    if (Math.max(f.W, f.H) <= 128 && !o.force) one = { img: f, step: 1 };
    else {
      const k = chromaKey(f, o);
      const box = figureBox(k.img);
      const src = box ? crop(box.img, box.x - 2, box.y - 2, box.w + 4, box.h + 4) : k.img;
      one = pixelSnap(src, { pixelSize: o.pixelSize, k: o.k || 24 });
    }
    const t = trim(one.img);
    return { img: t, step: one.step, palette: paletteOf(t, 64), height: t.H, width: t.W };
  }

  // Step 6 + 8: recover one video frame (chroma key, figure box) and snap it.
  // o: { key, tol, hue, scale ('auto' | number of video px per sprite px), anchorH, palette, orphans }
  function recoverFrame(f, o = {}) {
    const k = chromaKey(f, o);
    const box = figureBox(k.img, o.near);
    if (!box) return null;
    const pad = 2;
    const src = crop(box.img, box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2);
    const scale = o.scale && o.scale !== 'auto' ? +o.scale : o.anchorH ? box.h / o.anchorH : null;
    const s = pixelSnap(src, { pixelSize: scale, palette: o.palette && o.palette.length ? o.palette : null, k: o.k });
    let one = trim(s.img);
    if (o.orphans !== false) one = trim(dropFragments(fillPinholes(cleanOrphans(one))));
    return { img: one, box, step: s.step, key: k.key };
  }

  // ---------- curation ----------
  // difference of two trimmed frames, aligned on the feet and on the best x shift. With colour on, an
  // overlapping pixel only counts as shared when its luminance is close: side-view silhouettes repeat
  // every half step, but the near and far legs are shaded differently, so this finds the full cycle.
  function silDiff(a, b, maxShift = 4, colour = false) {
    const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let best = 1;
    const H = Math.max(a.H, b.H);
    for (let s = -maxShift; s <= maxShift; s++) {
      let inter = 0, uni = 0;
      const ax = 0, bx = Math.round((a.W - b.W) / 2) + s, W = Math.max(a.W, b.W + Math.abs(bx)) + maxShift;
      for (let y = 0; y < H; y++) for (let x = -maxShift; x < W; x++) {
        const ay = y - (H - a.H), by = y - (H - b.H), xb = x - bx;
        const ia = (ay * a.W + x) * 4, ib = (by * b.W + xb) * 4;
        const pa = x >= 0 && x < a.W && ay >= 0 && a.rgba[ia + 3] ? 1 : 0;
        const pb = xb >= 0 && xb < b.W && by >= 0 && b.rgba[ib + 3] ? 1 : 0;
        uni += pa | pb;
        if (pa & pb) inter += !colour || Math.abs(lum(a.rgba, ia) - lum(b.rgba, ib)) < 24 ? 1 : 0;
      }
      if (uni) best = Math.min(best, 1 - inter / uni);
    }
    return best;
  }
  // the frame after `start` that best closes a loop back to `start` (cycle = start .. end-1)
  // A clip holds several strides, and a loop of two or three strides often matches its start a
  // little better than one stride does. Each extra frame costs `perFrame` so a near-tie goes to the
  // single stride: the sheet stays short and every direction gets about the same frame count.
  function findLoop(frames, start, minLen = 6, perFrame = 0.003) {
    let best = -1, bd = 2, bs = 9;
    const scores = [];
    for (let j = start + minLen; j < frames.length; j++) {
      const d = silDiff(frames[start], frames[j], 4, true), sc = d + perFrame * (j - start);
      scores.push([j, d]);
      if (sc < bs - 0.005) { bs = sc; bd = d; best = j; }
    }
    return { end: best, diff: bd, score: bs, scores };
  }

  // ---------- anchoring + packing ----------
  // where each frame's pivot sits: x from the head (matched to the reference frame's head) or the torso,
  // y from the feet (lowest opaque row)
  function headRows(f, n) { const o = img(f.W, Math.min(n, f.H)); o.rgba.set(f.rgba.subarray(0, o.W * o.H * 4)); return o; }
  function pivotX(f, mode, ref, refX) {
    if (mode === 'bbox') return f.W / 2;
    if (mode === 'torso') {
      let sx = 0, n = 0;
      const y0 = Math.round(f.H * 0.22), y1 = Math.round(f.H * 0.5);
      for (let y = y0; y < y1; y++) {
        let l = -1, r = -1;
        for (let x = 0; x < f.W; x++) if (f.rgba[(y * f.W + x) * 4 + 3]) { if (l < 0) l = x; r = x; }
        if (l >= 0) { sx += (l + r + 1) / 2; n++; }
      }
      return n ? sx / n : f.W / 2;
    }
    // 'head': shift that best overlays this frame's head rows on the reference's (colour-aware)
    if (!ref) return f.W / 2;
    const rows = Math.max(6, Math.round(ref.H * 0.18)), A = headRows(ref, rows), B = headRows(f, rows);
    let best = 0, bs = -1;
    for (let dx = -Math.max(A.W, B.W); dx <= Math.max(A.W, B.W); dx++) {
      let sc = 0;
      for (let y = 0; y < rows; y++) for (let x = 0; x < B.W; x++) {
        const ax = x + dx;
        if (ax < 0 || ax >= A.W) continue;
        const i = (y * B.W + x) * 4, j = (y * A.W + ax) * 4;
        if (B.rgba[i + 3] && A.rgba[j + 3]) sc += (B.rgba[i] === A.rgba[j] && B.rgba[i + 1] === A.rgba[j + 1] && B.rgba[i + 2] === A.rgba[j + 2]) ? 2 : 1;
        else if (B.rgba[i + 3] || A.rgba[j + 3]) sc -= 1;
      }
      if (sc > bs) { bs = sc; best = dx; }
    }
    return refX - best;
  }
  // Video frames drift in size: the figure walks a little toward or away from the camera, or the
  // model slowly zooms. Snapping every frame at one block size turns that into a figure that grows
  // and shrinks on the sheet, so each frame gets its own block size.
  // The clip's overall size is the median figure height over the anchor's height. The change from
  // frame to frame comes from the head's width in video px: distance changes it, but a crouch, a
  // stretch or a flight frame doesn't (a run's height swings 6% while its head holds within 2 px).
  // Both are rolling medians over `win` frames each side, which also irons out hair flicks.
  // boxes: figure boxes in video px; heads: head widths in video px (headWidth), or none to track
  // the figure height alone.
  function median(a) { const s = a.filter(Boolean).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; }
  function rolling(a, win) { return a.map((_, i) => median(a.slice(Math.max(0, i - win), i + win + 1))); }
  function blockSizes(boxes, anchorH, win = 8, heads = null) {
    const hs = boxes.map((b) => (b ? b.h : 0)), base = median(hs) / anchorH;
    if (!heads) return rolling(hs, win).map((h) => h / anchorH || base);
    const hw = rolling(heads, win), mid = median(heads);
    return hw.map((w) => (w && mid ? base * (w / mid) : base));
  }
  // the head's width in video px: the median opaque row width over the skull, the rows 7-17% of the
  // way down the figure (below a hair spike, above the ears and collar)
  function headWidth(keyed, box) {
    const f = keyed, rows = [];
    for (let y = box.y + Math.round(box.h * 0.07); y < box.y + Math.round(box.h * 0.17); y++) {
      let a = -1, b = -1;
      for (let x = box.x; x < box.x + box.w; x++) if (f.rgba[(y * f.W + x) * 4 + 3]) { if (a < 0) a = x; b = x; }
      if (a >= 0) rows.push(b - a + 1);
    }
    return median(rows);
  }
  // The master drawings outline almost their whole silhouette in a dark line; snapped video frames
  // lose stretches of it, mostly around hands and hips, where skin or denim meets the background.
  // An edge pixel of one of `parts` takes the outline colour when the same part carries on inward
  // behind it (a pixel of that part that is not itself on the edge), so a 2x2 hand keeps its colour.
  // labelsOf(f) gives each pixel's part; outline: the drawing's outline colour as [r, g, b].
  function restoreOutline(frames, labelsOf, outline, parts = ['skin', 'bottom', 'shoes']) {
    const want = new Set(parts);
    return frames.map((f) => {
      const W = f.W, H = f.H, d = f.rgba, lab = labelsOf(f), o = img(W, H);
      o.rgba.set(d);
      const op = (x, y) => x >= 0 && y >= 0 && x < W && y < H && d[(y * W + x) * 4 + 3] > 0;
      const edge = (x, y) => op(x, y) && (!op(x + 1, y) || !op(x - 1, y) || !op(x, y + 1) || !op(x, y - 1));
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!want.has(lab[i]) || !edge(x, y)) continue;
        let inner = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy;
          if (op(xx, yy) && lab[yy * W + xx] === lab[i] && !edge(xx, yy)) { inner = true; break; }
        }
        if (inner) { o.rgba[i * 4] = outline[0]; o.rgba[i * 4 + 1] = outline[1]; o.rgba[i * 4 + 2] = outline[2]; }
      }
      return Object.assign(o, { ms: f.ms, lost: f.lost, offset: f.offset });
    });
  }
  // the drawing's outline colour: the most common dark colour on its silhouette edge
  function outlineColour(f) {
    const n = new Map(), W = f.W, H = f.H, d = f.rgba;
    const op = (x, y) => x >= 0 && y >= 0 && x < W && y < H && d[(y * W + x) * 4 + 3] > 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!op(x, y) || (op(x + 1, y) && op(x - 1, y) && op(x, y + 1) && op(x, y - 1))) continue;
      const i = (y * W + x) * 4;
      if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] >= 45) continue;
      const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      n.set(k, (n.get(k) || 0) + 1);
    }
    const k = [...n.entries()].sort((a, b) => b[1] - a[1])[0];
    return k ? [(k[0] >> 16) & 255, (k[0] >> 8) & 255, k[0] & 255] : [16, 16, 18];
  }
  // How far each frame's feet sit above the clip's ground, in sprite pixels, read from the raw video
  // (Wan's camera is static, so the lowest figure bottom over the clip is the floor). Lets a run's
  // flight frames leave the ground instead of being pinned to it.
  // The floor is a rolling maximum over `win` frames either side, so a slow vertical drift in the clip
  // isn't read as flight, and lifts up to `dead` px count as touching the ground.
  // scale: one block size, or one per frame (blockSizes)
  function liftsFromVideo(boxes, scale, win = 12, dead = 1) {
    const bottoms = boxes.map((b) => (b ? b.y + b.h : 0));
    return bottoms.map((b, i) => {
      let floor = b;
      for (let j = Math.max(0, i - win); j <= Math.min(bottoms.length - 1, i + win); j++) floor = Math.max(floor, bottoms[j]);
      const l = Math.round((floor - b) / (Array.isArray(scale) ? scale[i] : scale));
      return l > dead ? l : 0;
    });
  }
  // frames: trimmed 1x frames. o: { cw, ch, mode ('head'|'torso'|'bbox'), ground (rows of margin under
  // the feet), lift: [rows above the ground] per frame, nudge: [{dx, dy}] per frame, ms }
  function pack(frames, o = {}) {
    const cw = o.cw || 32, ch = o.ch || 64, ground = o.ground || 0, mode = o.mode || 'head';
    const ref = frames[0], refX = ref ? pivotX(ref, mode === 'head' ? 'torso' : mode) : 0;
    return frames.map((f, i) => {
      const px = pivotX(f, mode, ref, refX), nd = (o.nudge && o.nudge[i]) || { dx: 0, dy: 0 };
      const lift = (o.lift && o.lift[i]) || 0;
      const ox = Math.round(cw / 2 - px) + nd.dx, oy = ch - ground - f.H - lift + nd.dy;
      const out = img(cw, ch);
      let lost = 0;
      for (let y = 0; y < f.H; y++) for (let x = 0; x < f.W; x++) {
        const s = (y * f.W + x) * 4;
        if (!f.rgba[s + 3]) continue;
        const tx = x + ox, ty = y + oy;
        if (tx < 0 || ty < 0 || tx >= cw || ty >= ch) { lost++; continue; }
        out.rgba.set(f.rgba.subarray(s, s + 4), (ty * cw + tx) * 4);
      }
      out.ms = (o.ms && o.ms[i]) || o.msAll || 100;
      out.lost = lost; out.offset = { x: ox, y: oy };
      return out;
    });
  }

  // Shading boil: each video frame's shading snaps to the palette on its own, so a shirt that hasn't
  // changed still flickers between ramp steps. Per part, find the shift that best lines the part up
  // with the previous (already stable) frame, then let every pixel whose matched pixel is the same part
  // and a near colour (Lab distance < thr) inherit that colour. Real shading changes (a bigger colour
  // step) and pixels with no match keep their own colour. Runs twice round the loop so the seam settles.
  // labelsOf(f) -> part name per pixel (SpriteParts.create(parts).labels).
  function stabiliseShading(frames, labelsOf, o = {}) {
    const thr = o.thr != null ? o.thr : 14, R = o.search != null ? o.search : 3, loop = o.loop !== false;
    const n = frames.length;
    if (n < 2) return frames;
    const out = frames.map((f) => Object.assign({}, f, { rgba: new Uint8ClampedArray(f.rgba) }));
    const labs = out.map(labelsOf);
    const lcache = new Map();
    const labOf = (d, i) => { const k = key(d, i); let v = lcache.get(k); if (!v) { v = lab(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]); lcache.set(k, v); } return v; };
    const steps = loop ? 2 * n - 1 : n - 1;
    for (let s = 1; s <= steps; s++) {
      const ci = s % n, pi = (s - 1) % n, cur = out[ci], prev = out[pi], L = labs[ci], PL = labs[pi], W = cur.W, H = cur.H;
      const byPart = new Map();
      L.forEach((p, i) => { if (p && p !== 'outline') { if (!byPart.has(p)) byPart.set(p, []); byPart.get(p).push(i); } });
      for (const [part, idx] of byPart) {
        let best = [0, 0], bs = -1;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          let sc = 0;
          for (const i of idx) {
            const x = (i % W) - dx, y = ((i / W) | 0) - dy;
            if (x >= 0 && y >= 0 && x < W && y < H && PL[y * W + x] === part) sc++;
          }
          if (sc > bs || (sc === bs && Math.abs(dx) + Math.abs(dy) < Math.abs(best[0]) + Math.abs(best[1]))) { bs = sc; best = [dx, dy]; }
        }
        for (const i of idx) {
          const x = (i % W) - best[0], y = ((i / W) | 0) - best[1];
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const j = y * W + x;
          if (PL[j] !== part || key(cur.rgba, i) === key(prev.rgba, j)) continue;
          const a = labOf(cur.rgba, i), b = labOf(prev.rgba, j);
          if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 < thr * thr) cur.rgba.set(prev.rgba.subarray(j * 4, j * 4 + 3), i * 4);
        }
      }
    }
    // a partly copied area can leave single pixels of the old shade: fold them into their neighbours
    return out.map((f) => Object.assign(dropFragments(cleanOrphans(f)), { ms: f.ms, lost: f.lost, offset: f.offset }));
  }

  // The Wan start image: the 1x anchor scaled up with nearest neighbour on a flat chroma canvas, feet
  // a fixed margin above the bottom, size a multiple of 16 (Wan needs it).
  function wanStart(anchor, o = {}) {
    const s = o.scale || 8, W = o.W || 512, H = o.H || 640, bg = o.bg != null ? o.bg : 0x00b140, margin = o.margin || 56;
    const out = img(W, H);
    for (let i = 0; i < W * H; i++) { out.rgba[i * 4] = (bg >> 16) & 255; out.rgba[i * 4 + 1] = (bg >> 8) & 255; out.rgba[i * 4 + 2] = bg & 255; out.rgba[i * 4 + 3] = 255; }
    const ox = Math.round((W - anchor.W * s) / 2), oy = H - margin - anchor.H * s;
    for (let y = 0; y < anchor.H * s; y++) for (let x = 0; x < anchor.W * s; x++) {
      const si = (((y / s) | 0) * anchor.W + ((x / s) | 0)) * 4, tx = ox + x, ty = oy + y;
      if (!anchor.rgba[si + 3] || tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      out.rgba.set(anchor.rgba.subarray(si, si + 3), (ty * W + tx) * 4);
    }
    return out;
  }

  SS.VS = { CFG, img, lab, paletteMapper, paletteOf, kmeans, quantize, profiles, estimateStep, walk, fitUniform, resample, pixelSnap, borderColour, chromaKey, figureBox, crop, trim, dropFragments, cleanOrphans, fillPinholes, snapAnchor, recoverFrame, silDiff, findLoop, pivotX, blockSizes, headWidth, restoreOutline, outlineColour, liftsFromVideo, pack, stabiliseShading, wanStart };
})(typeof window !== 'undefined' ? (window.SS = window.SS || {}) : (globalThis.SS = globalThis.SS || {}));
