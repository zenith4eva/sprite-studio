// Ray-cast renderer: camera-space primitives -> one pixel-art frame.
// Each pixel is supersampled; the silhouette is a majority vote (binary alpha, never blended into a
// background it will not have), materials are a majority vote, and shading is the subsample average
// snapped into the material's ramp, so fractional motion steps colours before it moves pixels.
(function (SS) {
  'use strict';

  // ---------- ray / primitive intersection (camera space; rd normalised) ----------
  // Inigo Quilez's rounded-cone intersector, run in the cone's unit space
  function iRoundCone(ox, oy, oz, dx, dy, dz, L, ra, rb, out) {
    // pa = (0,0,0), pb = (0,L,0)
    const rr = ra - rb;
    const m0 = L * L;
    const m1 = L * oy;
    const m2 = L * dy;
    const m3 = dx * ox + dy * oy + dz * oz;
    const m5 = ox * ox + oy * oy + oz * oz;
    const obx = ox, oby = oy - L, obz = oz;
    const m6 = obx * dx + oby * dy + obz * dz;
    const m7 = obx * obx + oby * oby + obz * obz;
    const d2 = m0 - rr * rr;
    const k2 = d2 - m2 * m2;
    const k1 = d2 * m3 - m1 * m2 + m2 * rr * ra;
    const k0 = d2 * m5 - m1 * m1 + m1 * rr * ra * 2 - m0 * ra * ra;
    const h = k1 * k1 - k0 * k2;
    if (h < 0) return false;
    let t = (-Math.sqrt(h) - k1) / k2;
    const y = m1 - ra * rr + t * m2;
    if (y > 0 && y < d2) {
      const px = ox + t * dx, py = oy + t * dy, pz = oz + t * dz;
      let nx = d2 * px, ny = d2 * py - L * y, nz = d2 * pz;
      const nl = Math.hypot(nx, ny, nz) || 1;
      out.t = t; out.nx = nx / nl; out.ny = ny / nl; out.nz = nz / nl; out.px = px; out.py = py; out.pz = pz;
      return true;
    }
    const h1 = m3 * m3 - m5 + ra * ra;
    const h2 = m6 * m6 - m7 + rb * rb;
    if (h1 < 0 && h2 < 0) return false;
    let best = 1e20, cap = 0;
    if (h1 > 0) { t = -m3 - Math.sqrt(h1); best = t; cap = 1; }
    if (h2 > 0) { t = -m6 - Math.sqrt(h2); if (t < best) { best = t; cap = 2; } }
    const px = ox + best * dx, py = oy + best * dy, pz = oz + best * dz;
    if (cap === 1) { out.nx = px / ra; out.ny = py / ra; out.nz = pz / ra; }
    else { out.nx = px / rb; out.ny = (py - L) / rb; out.nz = pz / rb; }
    out.t = best; out.px = px; out.py = py; out.pz = pz;
    return true;
  }
  SS._iRoundCone = iRoundCone;

  const H = { t: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0 };

  // returns hit t (along the unit ray) or -1; fills hit.* with camera-space normal and local point
  function intersect(pr, ox, oy, oz, dx, dy, dz, hit) {
    const R = pr.R;
    if (pr.type === 0) {
      const qx = ox - pr.c[0], qy = oy - pr.c[1], qz = oz - pr.c[2];
      const lx = (R[0] * qx + R[3] * qy + R[6] * qz) / pr.r[0];
      const ly = (R[1] * qx + R[4] * qy + R[7] * qz) / pr.r[1];
      const lz = (R[2] * qx + R[5] * qy + R[8] * qz) / pr.r[2];
      const ex = (R[0] * dx + R[3] * dy + R[6] * dz) / pr.r[0];
      const ey = (R[1] * dx + R[4] * dy + R[7] * dz) / pr.r[1];
      const ez = (R[2] * dx + R[5] * dy + R[8] * dz) / pr.r[2];
      const a = ex * ex + ey * ey + ez * ez, b = lx * ex + ly * ey + lz * ez, c = lx * lx + ly * ly + lz * lz - 1;
      const h = b * b - a * c;
      if (h < 0) return -1;
      const sq = Math.sqrt(h);
      for (let pass = 0; pass < 2; pass++) {
        const t = (pass === 0 ? -b - sq : -b + sq) / a;
        const ux = lx + t * ex, uy = ly + t * ey, uz = lz + t * ez;
        const X = ux * pr.r[0], Y = uy * pr.r[1], Z = uz * pr.r[2];
        if (pr.clip && !pr.clip([X, Y, Z])) { if (pr.clip && pass === 0) continue; return -1; }
        let nx = ux / pr.r[0], ny = uy / pr.r[1], nz = uz / pr.r[2];
        let wx = R[0] * nx + R[1] * ny + R[2] * nz, wy = R[3] * nx + R[4] * ny + R[5] * nz, wz = R[6] * nx + R[7] * ny + R[8] * nz;
        const nl = Math.hypot(wx, wy, wz) || 1;
        wx /= nl; wy /= nl; wz /= nl;
        hit.inner = pass === 1;
        if (pass === 1) { wx = -wx; wy = -wy; wz = -wz; }
        hit.nx = wx; hit.ny = wy; hit.nz = wz;
        hit.lx = X; hit.ly = Y; hit.lz = Z; hit.s = 0; hit.ang = 0; hit.r = 1;
        // surface coordinates in pixels of arc: longitude around the vertical axis, latitude up the meridian
        hit.tu = Math.atan2(ux, uz) * (pr.r[0] + pr.r[2]) * 0.5;
        hit.tv = Math.asin(SS.clamp(uy, -1, 1)) * pr.r[1];
        return t;
      }
      return -1;
    }
    // round cone: local frame with Y along the axis, X and Z scaled to make it circular
    const qx = ox - pr.a[0], qy = oy - pr.a[1], qz = oz - pr.a[2];
    const lox = (R[0] * qx + R[3] * qy + R[6] * qz) / pr.sx;
    const loy = R[1] * qx + R[4] * qy + R[7] * qz;
    const loz = (R[2] * qx + R[5] * qy + R[8] * qz) / pr.sz;
    let ldx = (R[0] * dx + R[3] * dy + R[6] * dz) / pr.sx;
    let ldy = R[1] * dx + R[4] * dy + R[7] * dz;
    let ldz = (R[2] * dx + R[5] * dy + R[8] * dz) / pr.sz;
    const m = Math.hypot(ldx, ldy, ldz);
    ldx /= m; ldy /= m; ldz /= m;
    if (!iRoundCone(lox, loy, loz, ldx, ldy, ldz, pr.L, pr.ra, pr.rb, H)) return -1;
    // clipped cones (a shirt hem) simply let the ray through to whatever is inside them
    if (pr.clip && !pr.clip([H.px * pr.sx, H.py, H.pz * pr.sz])) return -1;
    const nx = H.nx / pr.sx, ny = H.ny, nz = H.nz / pr.sz;
    let wx = R[0] * nx + R[1] * ny + R[2] * nz, wy = R[3] * nx + R[4] * ny + R[5] * nz, wz = R[6] * nx + R[7] * ny + R[8] * nz;
    const nl = Math.hypot(wx, wy, wz) || 1;
    hit.nx = wx / nl; hit.ny = wy / nl; hit.nz = wz / nl;
    hit.inner = false;
    hit.s = SS.clamp(H.py / (pr.L || 1), 0, 1);
    hit.ang = Math.atan2(H.px, H.pz);
    hit.r = SS.lerp(pr.ra, pr.rb, hit.s);
    hit.lx = H.px * pr.sx; hit.ly = H.py; hit.lz = H.pz * pr.sz;
    // surface coordinates in pixels: arc around the axis, distance along it (caps run past 0 and L)
    hit.tu = hit.ang * hit.r;
    hit.tv = H.py;
    return H.t / m;
  }

  // ---------- frame render ----------
  // opts: { W, H, cx, ground, tilt, ss, light: [x,y,z], outline, ink: [r,g,b], flash }
  SS.renderFrame = (cam, M, opts) => {
    const W = opts.W, Hh = opts.H, S = opts.ss || 3, N = W * Hh;
    const k = opts.tilt || 0;
    const dl = Math.hypot(0, k, 1);
    const dx = 0, dy = -k / dl, dz = -1 / dl;
    const ZF = 200;
    const prims = cam.prims;
    // object ids
    const objIds = new Map();
    const objOf = prims.map((p) => { if (!objIds.has(p.obj)) objIds.set(p.obj, objIds.size); return objIds.get(p.obj); });
    const smearObj = objIds.has('smear') ? objIds.get('smear') : -1;
    // screen-space bounds per primitive
    const bounds = prims.map((p) => {
      let c, r;
      if (p.type === 0) { c = p.c; r = Math.max(p.r[0], p.r[1], p.r[2]); }
      else { c = SS.v3.lerp(p.a, p.b, 0.5); r = (p.L || 0) / 2 + Math.max(p.ra, p.rb) * Math.max(p.sx, p.sz); }
      const X = opts.cx + c[0], Y = opts.ground - c[1] + k * c[2];
      return [X - r - 1, X + r + 1, Y - r * (1 + k) - 1, Y + r * (1 + k) + 1];
    });
    const rows = [];
    for (let y = 0; y < Hh; y++) {
      const list = [];
      for (let i = 0; i < prims.length; i++) if (bounds[i][2] <= y + 1 && bounds[i][3] >= y) list.push(i);
      rows.push(list);
    }
    const L = SS.v3.norm(opts.light || [-0.55, 0.62, 0.56]);
    const S2 = S * S;
    const mat = new Int16Array(N).fill(-1), obj = new Int16Array(N).fill(-1);
    const shade = new Float32Array(N), depth = new Float32Array(N).fill(-1e9);
    const nrm = new Float32Array(N * 3), inner = new Uint8Array(N);
    const hit = { nx: 0, ny: 0, nz: 0, lx: 0, ly: 0, lz: 0, s: 0, ang: 0, r: 1, inner: false };
    const sm = new Int16Array(S2), so = new Int16Array(S2), sv = new Float32Array(S2), sz = new Float32Array(S2);
    const sn = new Float32Array(S2 * 3), sIn = new Uint8Array(S2);
    // which surface point each pixel shows (primitive + its surface coordinates): paint transfer reads these
    const tprim = new Int16Array(N).fill(-1), tu = new Float32Array(N), tv = new Float32Array(N);
    const sp = new Int16Array(S2), stu = new Float32Array(S2), stv = new Float32Array(S2), sIdx = new Uint8Array(S2);
    const centre = (S - 1) / 2;
    const info = { s: 0, ang: 0, r: 1, lx: 0, lz: 0 };
    for (let py = 0; py < Hh; py++) {
      const list = rows[py];
      if (!list.length) continue;
      for (let px = 0; px < W; px++) {
        let cnt = 0;
        for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
          const X = px + (sx + 0.5) / S, Y = py + (sy + 0.5) / S;
          const ox = X - opts.cx, oy = opts.ground - Y + k * ZF, oz = ZF;
          let bestT = 1e20, best = -1, bnx = 0, bny = 0, bnz = 0, bl = null, bin = false;
          let bs = 0, ba = 0, br = 1, btu = 0, btv = 0;
          for (let li = 0; li < list.length; li++) {
            const i = list[li], b = bounds[i];
            if (X < b[0] || X > b[1]) continue;
            const t = intersect(prims[i], ox, oy, oz, dx, dy, dz, hit);
            if (t > 0 && t < bestT) {
              bestT = t; best = i; bnx = hit.nx; bny = hit.ny; bnz = hit.nz; bin = hit.inner;
              bl = [hit.lx, hit.ly, hit.lz]; bs = hit.s; ba = hit.ang; br = hit.r; btu = hit.tu; btv = hit.tv;
            }
          }
          if (best < 0) continue;
          const pr = prims[best];
          let m = pr.mat;
          if (pr.matFn) {
            let lp = bl;
            if (pr.mframe) {
              const wx = ox + bestT * dx - pr.mframe.o[0], wy = oy + bestT * dy - pr.mframe.o[1], wz = oz + bestT * dz - pr.mframe.o[2];
              const R = pr.mframe.R;
              lp = [R[0] * wx + R[3] * wy + R[6] * wz, R[1] * wx + R[4] * wy + R[7] * wz, R[2] * wx + R[5] * wy + R[8] * wz];
            }
            info.s = bs; info.ang = ba; info.r = br; info.lx = bl[0]; info.lz = bl[2];
            m = pr.matFn(lp, info);
          }
          const lam = bnx * L[0] + bny * L[1] + bnz * L[2];
          sm[cnt] = m; so[cnt] = objOf[best]; sv[cnt] = lam; sz[cnt] = oz + bestT * dz;
          sn[cnt * 3] = bnx; sn[cnt * 3 + 1] = bny; sn[cnt * 3 + 2] = bnz; sIn[cnt] = bin ? 1 : 0;
          sp[cnt] = best; stu[cnt] = btu; stv[cnt] = btv; sIdx[cnt] = sy * S + sx;
          cnt++;
        }
        // thin parts (fingers, hair tufts) survive at 4 of 9
        if (cnt * 9 < S2 * 4) continue;
        // majority material (ties go to the nearer surface)
        let bm = -1, bc = 0, bz = -1e9;
        for (let i = 0; i < cnt; i++) {
          let c = 0, zmax = -1e9;
          for (let j = 0; j < cnt; j++) if (sm[j] === sm[i]) { c++; if (sz[j] > zmax) zmax = sz[j]; }
          if (c > bc || (c === bc && zmax > bz)) { bc = c; bm = sm[i]; bz = zmax; }
        }
        // majority object among that material's samples
        let bo = -1, boc = 0;
        for (let i = 0; i < cnt; i++) {
          if (sm[i] !== bm) continue;
          let c = 0;
          for (let j = 0; j < cnt; j++) if (sm[j] === bm && so[j] === so[i]) c++;
          if (c > boc) { boc = c; bo = so[i]; }
        }
        let v = 0, nx = 0, ny = 0, nz = 0, zz = -1e9, n = 0, inn = 0;
        for (let i = 0; i < cnt; i++) {
          if (sm[i] !== bm) continue;
          v += sv[i]; nx += sn[i * 3]; ny += sn[i * 3 + 1]; nz += sn[i * 3 + 2]; n++;
          if (so[i] === bo && sz[i] > zz) zz = sz[i];
          inn += sIn[i];
        }
        const idx = py * W + px;
        mat[idx] = bm; obj[idx] = bo; shade[idx] = v / n; depth[idx] = zz;
        // the surface point under the pixel: the winning part's sample nearest the pixel centre
        let rep = -1, rd = 1e9;
        for (let i = 0; i < cnt; i++) {
          if (sm[i] !== bm || so[i] !== bo) continue;
          const ddx = (sIdx[i] % S) - centre, ddy = Math.floor(sIdx[i] / S) - centre, d = ddx * ddx + ddy * ddy;
          if (d < rd) { rd = d; rep = i; }
        }
        if (rep >= 0) { tprim[idx] = sp[rep]; tu[idx] = stu[rep]; tv[idx] = stv[rep]; }
        const l = Math.hypot(nx, ny, nz) || 1;
        nrm[idx * 3] = nx / l; nrm[idx * 3 + 1] = ny / l; nrm[idx * 3 + 2] = nz / l;
        inner[idx] = inn * 2 > n ? 1 : 0;
      }
    }

    // ---------- shade into ramp indices 1..4 ----------
    // a surface facing the viewer gets the picked colour; facing the light, the lights; turned away, the shadow
    const ramp = new Int8Array(N).fill(-1);
    const lk = opts.lightK == null ? 0.55 : opts.lightK;
    const tShadow = 0.2 - 0.14 * lk, tLight = 0.7 - 0.08 * lk, tHigh = 0.93 - 0.05 * lk;
    for (let i = 0; i < N; i++) {
      if (mat[i] < 0) continue;
      let v = shade[i];
      if (inner[i]) v -= 0.65;
      let r = v < tShadow ? 1 : v < tLight ? 2 : v < tHigh ? 3 : 4;
      if (mat[i] === M.index.smear) r = v < -0.2 ? 3 : 4;
      ramp[i] = r;
    }

    // ---------- cast shadows: an occluder above-left and in front darkens a pixel by one shade ----------
    const tmp = Int8Array.from(ramp);
    for (let y = 1; y < Hh; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mat[i] < 0 || obj[i] === smearObj) continue;
      let shadow = false;
      for (const [ddx, ddy] of [[0, -1], [-1, -1], [0, -2]]) {
        const xx = x + ddx, yy = y + ddy;
        if (xx < 0 || yy < 0) continue;
        const j = yy * W + xx;
        if (mat[j] < 0 || obj[j] === obj[i] || obj[j] === smearObj) continue;
        if (depth[j] > depth[i] + 0.9) { shadow = true; break; }
      }
      if (shadow) tmp[i] = Math.max(1, ramp[i] - 1);
    }
    ramp.set(tmp);

    // ---------- clean-up: lone shade pixels join their neighbours (same material) ----------
    for (let pass = 0; pass < 2; pass++) {
      const cp = Int8Array.from(ramp);
      for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (mat[i] < 0) continue;
        const counts = [0, 0, 0, 0, 0];
        let same = 0, nb = 0;
        for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + ddx, yy = y + ddy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= Hh) continue;
          const j = yy * W + xx;
          if (mat[j] !== mat[i]) continue;
          nb++;
          counts[ramp[j]]++;
          if (ramp[j] === ramp[i]) same++;
        }
        if (nb >= 3 && same === 0) {
          let bi = ramp[i], bc = 0;
          for (let r = 1; r <= 4; r++) if (counts[r] > bc) { bc = counts[r]; bi = r; }
          cp[i] = bi;
        }
      }
      ramp.set(cp);
    }
    // lone material pixels (one pixel of a material inside another) take the surrounding material
    for (let y = 1; y < Hh - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (mat[i] < 0 || mat[i] === M.index.eye) continue;
      const n4 = [i - 1, i + 1, i - W, i + W];
      if (n4.some((j) => mat[j] < 0 || mat[j] === mat[i])) continue;
      const m0 = mat[n4[0]];
      if (n4.every((j) => mat[j] === m0)) { mat[i] = m0; ramp[i] = ramp[n4[0]]; obj[i] = obj[n4[0]]; }
    }
    // pinholes: a transparent pixel walled in on four sides is filled from its neighbours
    for (let y = 1; y < Hh - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (mat[i] >= 0) continue;
      const n4 = [i - 1, i + 1, i - W, i + W];
      if (n4.every((j) => mat[j] >= 0)) { const j = n4[2]; mat[i] = mat[j]; ramp[i] = Math.max(1, ramp[j] - 1); obj[i] = obj[j]; depth[i] = depth[j]; }
    }

    // ---------- lines ----------
    // 0 = fill, 1 = interior line (the nearer part's dark shade), 2 = lit-side outline, 3 = shadow-side outline
    const line = new Uint8Array(N);
    const mode = opts.outline || 'selout';
    const isFig = (x, y) => x >= 0 && y >= 0 && x < W && y < Hh && mat[y * W + x] >= 0;
    if (mode !== 'none') {
      for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (mat[i] < 0) continue;
        const emptyL = !isFig(x - 1, y), emptyU = !isFig(x, y - 1), emptyR = !isFig(x + 1, y), emptyD = !isFig(x, y + 1);
        if (obj[i] === smearObj) continue;
        if (emptyL || emptyU || emptyR || emptyD) {
          // a part only two pixels across keeps its lit pixel as fill, or it turns solid ink
          const thinH = emptyL && !emptyR && !isFig(x + 2, y), thinV = emptyU && !emptyD && !isFig(x, y + 2);
          if ((thinH && !emptyU && !emptyD) || (thinV && !emptyL && !emptyR)) continue;
          line[i] = (emptyR || emptyD) ? 3 : 2;
          continue;
        }
        // interior: this pixel is in front of a neighbouring part; keep at least one fill pixel behind it
        for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const j = (y + ddy) * W + (x + ddx);
          if (obj[j] === obj[i] || obj[j] === smearObj) continue;
          if (depth[i] - depth[j] < 1.6) continue;
          const bx = x - ddx, by = y - ddy;
          if (!isFig(bx, by) || obj[by * W + bx] !== obj[i]) continue;
          line[i] = 1;
          break;
        }
      }
    }

    // ---------- decals ----------
    const decal = new Int16Array(N).fill(-1), decalShade = new Int8Array(N);
    for (const d of cam.decals) {
      const X = opts.cx + d.p[0], Y = opts.ground - d.p[1] + k * d.p[2];
      const x = Math.floor(X), y = Math.floor(Y);
      if (x < 0 || y < 0 || x >= W || y >= Hh) continue;
      const i = y * W + x;
      if (mat[i] < 0 || obj[i] !== objIds.get(d.obj)) continue;
      if (Math.abs(depth[i] - d.p[2]) > (d.kind === 'eye' ? 2.2 : 1.3)) continue;  // eyes sit in their sockets, below the face plane
      if (line[i] >= 2 && d.kind !== 'eye') continue;
      decal[i] = d.mat; decalShade[i] = d.shade;
    }

    // ---------- compose ----------
    const rgba = new Uint8ClampedArray(N * 4);
    const layer = new Uint8Array(N).fill(255);
    const ink = M.ink;
    const L2I = {}; SS.LAYERS.forEach((l, i) => { L2I[l] = i; });
    for (let i = 0; i < N; i++) {
      if (mat[i] < 0) continue;
      const mm = M.list[decal[i] >= 0 ? decal[i] : mat[i]];
      let c;
      if (decal[i] >= 0) c = mm.ramp[decalShade[i]];
      else if (line[i] === 3 || (line[i] === 2 && mode === 'ink')) c = mode === 'soft' ? mm.ramp[0] : ink;
      else if (line[i] === 2) c = mode === 'soft' ? mm.ramp[0] : mm.ramp[0];
      else if (line[i] === 1) c = mm.ramp[mm.name === 'skin' || mm.name === 'stubble' ? 1 : 0];  // the darkest skin shade reads as a red seam
      else c = mm.ramp[ramp[i]];
      if (opts.flash && line[i] < 2) c = [255, 250, 238];
      rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2]; rgba[i * 4 + 3] = 255;
      layer[i] = L2I[M.list[mat[i]].layer];
    }
    return { W, H: Hh, rgba, layer, mat, obj, depth, nrm, line, tprim, tu, tv, objNames: [...objIds.keys()] };
  };
})(window.SS);
