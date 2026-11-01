// Sprite Studio core: math, hashing, colour (OKLab), hue-shifted ramps and palettes.
// Classic script (no modules) so index.html also works when opened straight from disk.
window.SS = window.SS || {};
(function (SS) {
  'use strict';

  const D2R = Math.PI / 180;
  SS.D2R = D2R;
  SS.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  SS.lerp = (a, b, t) => a + (b - a) * t;
  SS.smoothstep = (a, b, x) => { const t = SS.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  SS.fract = (x) => x - Math.floor(x);
  // triangle wave in 0..1 that rises over `up` of the period and falls over the rest
  SS.tri = (u, up = 0.5) => { u = SS.fract(u); return u < up ? u / up : 1 - (u - up) / (1 - up); };

  // ---------- vectors (plain arrays) ----------
  SS.v3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    mad: (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
    dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  };

  // ---------- 3x3 matrices, row-major; columns are the frame's x, y, z axes ----------
  const m3 = SS.m3 = {
    I: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
    mul: (a, b) => {
      const r = new Array(9);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
        r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
      return r;
    },
    v: (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]],
    rx: (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; },
    ry: (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; },
    rz: (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; },
    col: (m, i) => [m[i], m[3 + i], m[6 + i]],
    fromCols: (x, y, z) => [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]],
    // degrees: yaw about Y, then pitch about X (positive leans +Y toward +Z), then roll about Z
    ypr: (yaw, pitch, roll) => m3.mul(m3.ry(yaw * D2R), m3.mul(m3.rx(pitch * D2R), m3.rz(roll * D2R))),
    // a frame whose Y axis is `y` and whose Z axis is as close as possible to `zHint`
    frameY: (y, zHint) => {
      const Y = SS.v3.norm(y);
      let X = SS.v3.cross(Y, zHint);
      if (SS.v3.len(X) < 1e-4) X = SS.v3.cross(Y, [1, 0, 0]);
      X = SS.v3.norm(X);
      const Z = SS.v3.cross(X, Y);
      return m3.fromCols(X, Y, Z);
    },
  };

  // ---------- hashing (stable per surface cell, so torn cloth never boils) ----------
  SS.hash3 = (a, b, c) => {
    let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  SS.rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x6d2b79f5 | 0; s ^= s >>> 13; return ((s >>> 0) % 1e9) / 1e9; }; };

  // ---------- colour ----------
  SS.hex2rgb = (h) => {
    h = String(h).replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  SS.rgb2hex = (c) => '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1);
  const s2l = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const l2s = (c) => { const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055; return Math.round(SS.clamp(v, 0, 1) * 255); };
  SS.rgb2lab = (rgb) => {
    const r = s2l(rgb[0]), g = s2l(rgb[1]), b = s2l(rgb[2]);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  SS.lab2rgb = (lab) => {
    const l_ = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
    const m_ = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
    const s_ = lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2];
    const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    return [l2s(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      l2s(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      l2s(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
  };
  SS.labDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  SS.mixHex = (a, b, t) => { const A = SS.hex2rgb(a), B = SS.hex2rgb(b); return SS.rgb2hex([0, 1, 2].map((i) => Math.round(SS.lerp(A[i], B[i], t)))); };

  // OKLab hue angles in degrees: shadows lean to blue-violet, lights to yellow. Warm colours reach the
  // cool side through red and magenta, never through green (a grey or a skin tone must not go olive).
  const COOL = 285, WARM = 95;
  const shiftHue = (hDeg, dark, amt) => {
    let h = ((hDeg % 360) + 360) % 360, dir;
    if (dark) dir = h <= 150 || h > COOL ? -1 : 1;
    else dir = h > WARM && h <= 275 ? -1 : 1;
    const target = dark ? COOL : WARM;
    let d = ((target - h) * dir + 360) % 360;   // distance to the target along the chosen direction
    return h + dir * Math.min(amt, d);
  };

  // Five shades, dark to light, with the picked colour as index 2; index 0 is for lines and
  // selective outlines. Hue shifts toward cool in the shadows and warm in the lights, and chroma
  // holds up in the lights so hair and cloth do not go grey.
  SS.makeRamp = (hex, opts = {}) => {
    const lab = SS.rgb2lab(SS.hex2rgb(hex));
    const L0 = lab[0], C0 = Math.hypot(lab[1], lab[2]), h0 = Math.atan2(lab[2], lab[1]) / D2R;
    const step = opts.step ?? 0.08, hue = opts.hue ?? 9;
    const offs = opts.offs ?? [-2.7, -1, 0, 1, 1.85];
    const grey = SS.clamp(C0 / 0.04, 0, 1);       // near-grey colours take a lighter tint
    return offs.map((d) => {
      const L = SS.clamp(L0 + d * step * (d < 0 ? 1 : 0.92), 0.1, 0.97);
      let C = C0 * (d < 0 ? 1 + 0.06 * -d : 1 - 0.05 * d);
      C = Math.max(C, 0.005 * Math.abs(d));
      if (L < 0.22) C *= L / 0.22;
      const h = d === 0 ? h0 : shiftHue(h0, d < 0, hue * Math.abs(d) * (0.5 + 0.5 * grey));
      return SS.lab2rgb([L, C * Math.cos(h * D2R), C * Math.sin(h * D2R)]);
    });
  };

  // ---------- palettes ----------
  SS.PALETTES = {
    resurrect64: ('2e222f 3e3546 625565 966c6c ab947a 694f62 7f708a 9babb2 c7dcd0 ffffff 6e2727 b33831 ea4f36 f57d4a ae2334 e83b3b ' +
      'fb6b1d f79617 f9c22b 7a3045 9e4539 cd683d e6904e fbb954 4c3e24 676633 a2a947 d5e04b fbff86 165a4c 239063 1ebc73 ' +
      '91db69 cddf6c 313638 374e4a 547e64 92a984 b2ba90 0b5e65 0b8a8f 0eaf9b 30e1b9 8ff8e2 323353 484a77 4d65b4 4d9be6 ' +
      '8fd3ff 45293f 6b3e75 905ea9 a884f3 eaaded 753c54 a24b6f cf657f ed8099 831c5d c32454 f04f78 f68181 fca790 fdcbb0')
      .split(' ').map((h) => SS.hex2rgb(h)),
  };
  // the project's master palette: Resurrect 64 plus the survivor drawing's own greys, browns and navies
  // (charpipe accepts each character's colours the same way, so neutral cloth does not snap to green)
  SS.PALETTES.deadfarm = SS.PALETTES.resurrect64.concat(('1e130c 241608 3f2d1e 4f3421 553926 5f3c17 a67951 e19968 dfa772 ' +
    '353331 3c3d3c 50473d 565550 595750 5c5751 655a4d 624a30 2a2927 d4c7a3 0b1019 0c111b 1d2b44 212f49 273b5a 383b42')
    .split(' ').map((h) => SS.hex2rgb(h)));
  const palLab = new Map();
  SS.nearestInPalette = (rgb, pal) => {
    let labs = palLab.get(pal);
    if (!labs) { labs = pal.map(SS.rgb2lab); palLab.set(pal, labs); }
    const L = SS.rgb2lab(rgb);
    let best = 0, bd = 1e9;
    for (let i = 0; i < labs.length; i++) { const d = SS.labDist(L, labs[i]); if (d < bd) { bd = d; best = i; } }
    return pal[best];
  };
  // snap a ramp into a palette, keeping neighbouring shades distinct where the palette allows
  SS.snapRamp = (ramp, pal) => {
    const out = ramp.map((c) => SS.nearestInPalette(c, pal));
    for (let i = 1; i < out.length; i++) {
      if (out[i].join() !== out[i - 1].join()) continue;
      const L = SS.rgb2lab(ramp[i]);
      let best = null, bd = 1e9;
      for (const p of pal) {
        if (out.some((o) => o.join() === p.join())) continue;
        const pl = SS.rgb2lab(p);
        if (pl[0] <= SS.rgb2lab(out[i - 1])[0]) continue;
        const d = SS.labDist(L, pl);
        if (d < bd) { bd = d; best = p; }
      }
      if (best && bd < 0.12) out[i] = best;
    }
    return out;
  };
})(window.SS);
