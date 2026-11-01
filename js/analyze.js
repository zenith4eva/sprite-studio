// Frame and pair measurements, ported from the pixel-animation skill's anim_check.py so the numbers
// in the studio match the command-line checker.
(function (SS) {
  'use strict';
  const JUMP_CUT = 0.35, DUPLICATE = 0.005, SUBPIXEL = 0.03, FRAGMENT = 5, PINHOLE = 2, ORPHANS = 0.06, HEAD_ROWS = 10, TOL = 32;
  SS.CHECK = { JUMP_CUT, DUPLICATE, SUBPIXEL, FRAGMENT, PINHOLE, ORPHANS, HEAD_ROWS, TOL };

  const mask = (f) => { const m = new Uint8Array(f.W * f.H); for (let i = 0; i < m.length; i++) m[i] = f.rgba[i * 4 + 3] > 0 ? 1 : 0; return m; };
  SS.maskOf = mask;

  function components(m, W, H, conn8, want) {
    const lab = new Int32Array(W * H).fill(-1), sizes = [], touches = [];
    const stack = [];
    for (let i = 0; i < W * H; i++) {
      if (m[i] !== want || lab[i] >= 0) continue;
      const id = sizes.length; let size = 0, edge = false;
      stack.push(i); lab[i] = id;
      while (stack.length) {
        const p = stack.pop(); size++;
        const x = p % W, y = (p / W) | 0;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (!conn8 && dx && dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const q = yy * W + xx;
          if (m[q] === want && lab[q] < 0) { lab[q] = id; stack.push(q); }
        }
      }
      sizes.push(size); touches.push(edge);
    }
    return { lab, sizes, touches };
  }

  SS.frameStats = (f) => {
    const W = f.W, H = f.H, m = mask(f), px = f.rgba;
    let top = H, bot = -1, left = W, right = -1, opaque = 0;
    const cols = new Set();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!m[i]) continue;
      opaque++;
      if (y < top) top = y; if (y > bot) bot = y; if (x < left) left = x; if (x > right) right = x;
      cols.add((px[i * 4] << 16) | (px[i * 4 + 1] << 8) | px[i * 4 + 2]);
    }
    if (!opaque) return { empty: true };
    let orphans = 0;
    const orphanMap = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!m[i]) continue;
      let same = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx;
        if (!m[j]) continue;
        if (Math.abs(px[i * 4] - px[j * 4]) <= TOL && Math.abs(px[i * 4 + 1] - px[j * 4 + 1]) <= TOL && Math.abs(px[i * 4 + 2] - px[j * 4 + 2]) <= TOL) { same = true; break; }
      }
      if (!same) { orphans++; orphanMap[i] = 1; }
    }
    const comp = components(m, W, H, true, 1);
    let body = 0;
    comp.sizes.forEach((s, i) => { if (s > comp.sizes[body]) body = i; });
    const fragments = comp.sizes.filter((s, i) => i !== body && s < FRAGMENT).length;
    const holes = components(m, W, H, false, 0);
    let pinholes = 0;
    holes.sizes.forEach((s, i) => { if (!holes.touches[i] && s <= PINHOLE) pinholes++; });
    let head = 0;
    for (let y = top; y < Math.min(top + HEAD_ROWS, H); y++) {
      let l = -1, r = -1;
      for (let x = 0; x < W; x++) if (m[y * W + x]) { if (l < 0) l = x; r = x; }
      if (l >= 0) head = Math.max(head, r - l + 1);
    }
    return { empty: false, top, feet: bot, height: bot - top + 1, head, bbox: [left, top, right - left + 1, bot - top + 1], opaque, colours: cols.size, orphans, orphanRatio: orphans / opaque, orphanMap, fragments, pinholes };
  };

  SS.pairStats = (a, b) => {
    const ma = mask(a), mb = mask(b);
    let uni = 0, xor = 0, col = 0;
    for (let i = 0; i < ma.length; i++) {
      if (ma[i] || mb[i]) uni++;
      if (ma[i] !== mb[i]) xor++;
      else if (ma[i] && (a.rgba[i * 4] !== b.rgba[i * 4] || a.rgba[i * 4 + 1] !== b.rgba[i * 4 + 1] || a.rgba[i * 4 + 2] !== b.rgba[i * 4 + 2])) col++;
    }
    uni = uni || 1;
    const sil = xor / uni, colour = col / uni;
    let kind;
    if (sil < DUPLICATE && colour < DUPLICATE) kind = 'duplicate';
    else if (sil > JUMP_CUT) kind = 'jump-cut';
    else if (sil < SUBPIXEL && colour > sil) kind = 'sub-pixel';
    else kind = 'whole-pixel';
    return { sil, colour, kind };
  };

  // the checker's problem list, most important first (size and feet, then noise, then pairs)
  SS.problems = (frames, stats, pairs, opts = {}) => {
    const out = [];
    const live = stats.filter((s) => !s.empty);
    if (!live.length) return frames.length ? [{ sev: 2, text: 'every frame is empty: check the cell size and the colour key' }] : [];
    const hs = live.map((s) => s.height), fs = live.map((s) => s.feet), hw = live.map((s) => s.head);
    const allowH = opts.allowHeight ?? 1, allowF = opts.allowFeet ?? 0;
    if (Math.max(...hs) - Math.min(...hs) > allowH) out.push({ sev: 2, text: `standing height varies ${Math.min(...hs)}-${Math.max(...hs)} px (allowed ±${allowH}): a size pop, or a crouch if this is a run or attack (then trust head width)` });
    if (Math.max(...hw) - Math.min(...hw) > 1) out.push({ sev: 3, text: `head width varies ${Math.min(...hw)}-${Math.max(...hw)} px: the head changes size between frames` });
    if (Math.max(...fs) - Math.min(...fs) > allowF) out.push({ sev: 1, text: `feet row varies ${Math.min(...fs)}-${Math.max(...fs)} (allowed ${allowF})` });
    stats.forEach((s, i) => {
      if (s.empty) return;
      if (s.orphanRatio > ORPHANS) out.push({ sev: 1, text: `frame ${i}: ${s.orphans} orphan pixels (${(s.orphanRatio * 100).toFixed(1)}%): noise, read it at 1x` });
      if (s.fragments) out.push({ sev: 1, text: `frame ${i}: ${s.fragments} loose fragment(s) under ${FRAGMENT} px` });
      if (s.pinholes) out.push({ sev: 1, text: `frame ${i}: ${s.pinholes} pinhole(s)` });
    });
    pairs.forEach((p) => {
      if (!p) return;
      if (p.kind === 'duplicate') out.push({ sev: 1, text: `frames ${p.from}->${p.to}: duplicate; drop one and hold the other in the manifest` });
      if (p.kind === 'jump-cut') out.push({ sev: 2, text: `frames ${p.from}->${p.to}: silhouette changes ${(p.sil * 100).toFixed(0)}% (jump cut): add an in-between or a smear` });
    });
    return out.sort((a, b) => b.sev - a.sev);
  };
})(window.SS);
