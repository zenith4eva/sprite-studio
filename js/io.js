// Files in and out: canvases, PNG, a store-only ZIP writer, a GIF89a encoder, sprite-sheet assembly,
// guide sheets for image/video models, and slicing of imported sheets and atlases.
(function (SS) {
  'use strict';

  // ---------- canvases ----------
  SS.frameCanvas = (f, scale = 1, bg = null) => {
    const c = document.createElement('canvas');
    c.width = f.W * scale; c.height = f.H * scale;
    const g = c.getContext('2d');
    const src = document.createElement('canvas'); src.width = f.W; src.height = f.H;
    src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(f.rgba), f.W, f.H), 0, 0);
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height); }
    g.imageSmoothingEnabled = false;
    g.drawImage(src, 0, 0, c.width, c.height);
    return c;
  };
  SS.canvasBytes = (c) => new Promise((res) => c.toBlob((b) => b.arrayBuffer().then((a) => res(new Uint8Array(a))), 'image/png'));
  SS.download = (blob, name) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  // crop a frame to a cell around the character's centre line
  SS.cropFrame = (f, cw, ch, cx) => {
    const out = { W: cw, H: ch, rgba: new Uint8ClampedArray(cw * ch * 4), ms: f.ms, lost: 0 };
    const x0 = Math.round(cx - cw / 2), y0 = f.H - ch;
    for (let y = 0; y < f.H; y++) for (let x = 0; x < f.W; x++) {
      const si = (y * f.W + x) * 4;
      const tx = x - x0, ty = y - y0;
      if (tx < 0 || ty < 0 || tx >= cw || ty >= ch) { if (f.rgba[si + 3]) out.lost++; continue; }
      const di = (ty * cw + tx) * 4;
      out.rgba[di] = f.rgba[si]; out.rgba[di + 1] = f.rgba[si + 1]; out.rgba[di + 2] = f.rgba[si + 2]; out.rgba[di + 3] = f.rgba[si + 3];
    }
    return out;
  };

  // ---------- zip (store) ----------
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  SS.zip = (files) => {
    const enc = new TextEncoder(), parts = [], central = [];
    let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(12, 0x21, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(14, 0x21, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), name);
      off += 30 + name.length + data.length;
    }
    const cs = central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cs, true); end.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  };

  // ---------- gif ----------
  function lzw(index, minSize, out) {
    const clear = 1 << minSize, eoi = clear + 1;
    let size = minSize + 1, next = eoi + 1, table = new Map();
    let cur = 0, shift = 0;
    const bytes = [];
    const emit = (code) => { cur |= code << shift; shift += size; while (shift >= 8) { bytes.push(cur & 255); cur >>>= 8; shift -= 8; } };
    emit(clear);
    let ib = index[0];
    for (let i = 1; i < index.length; i++) {
      const k = index[i], key = (ib << 8) | k, code = table.get(key);
      if (code !== undefined) { ib = code; continue; }
      emit(ib);
      if (next === 4096) { emit(clear); next = eoi + 1; size = minSize + 1; table = new Map(); }
      else { if (next >= 1 << size) size++; table.set(key, next++); }
      ib = k;
    }
    emit(ib); emit(eoi);
    if (shift > 0) bytes.push(cur & 255);
    out.push(minSize);
    for (let i = 0; i < bytes.length; i += 255) { const n = Math.min(255, bytes.length - i); out.push(n); for (let j = 0; j < n; j++) out.push(bytes[i + j]); }
    out.push(0);
  }
  // frames: [{ rgba, W, H, ms }] all the same size; transparent pixels stay transparent
  SS.encodeGIF = (frames) => {
    const W = frames[0].W, H = frames[0].H;
    const map = new Map([[-1, 0]]), pal = [0];
    const shrink = (r, g, b, bits) => { const m = 255 << (8 - bits) & 255; return ((r & m) << 16) | ((g & m) << 8) | (b & m); };
    let bits = 8, idxs;
    for (;;) {
      map.clear(); map.set(-1, 0); pal.length = 1;
      idxs = frames.map((f) => {
        const ix = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) {
          const key = f.rgba[i * 4 + 3] < 128 ? -1 : shrink(f.rgba[i * 4], f.rgba[i * 4 + 1], f.rgba[i * 4 + 2], bits);
          let v = map.get(key);
          if (v === undefined) { v = pal.length; map.set(key, v); pal.push(key); }
          ix[i] = v & 255;
        }
        return ix;
      });
      if (pal.length <= 256 || bits <= 3) break;
      bits--;
    }
    let n = 1; while ((1 << (n + 1)) < pal.length) n++;
    const out = [];
    const str = (s) => { for (const ch of s) out.push(ch.charCodeAt(0)); };
    const u16 = (v) => { out.push(v & 255, (v >> 8) & 255); };
    str('GIF89a'); u16(W); u16(H); out.push(0xf0 | n, 0, 0);
    for (let i = 0; i < 1 << (n + 1); i++) { const c = pal[i] || 0; out.push((c >> 16) & 255, (c >> 8) & 255, c & 255); }
    out.push(0x21, 0xff, 11); str('NETSCAPE2.0'); out.push(3, 1); u16(0); out.push(0);
    frames.forEach((f, fi) => {
      out.push(0x21, 0xf9, 4, (2 << 2) | 1); u16(Math.max(2, Math.round(f.ms / 10))); out.push(0, 0);
      out.push(0x2c); u16(0); u16(0); u16(W); u16(H); out.push(0);
      lzw(idxs[fi], Math.max(2, n + 1), out);
    });
    out.push(0x3b);
    return new Blob([new Uint8Array(out)], { type: 'image/gif' });
  };

  // ---------- sprite sheet ----------
  // rows: [{ name, anim, dir, frames: [{ rgba, W, H, ms }], loop }]
  SS.buildSheet = (rows, cell, scale = 1) => {
    const cols = Math.max(...rows.map((r) => r.frames.length));
    const c = document.createElement('canvas');
    c.width = cols * cell.w * scale; c.height = rows.length * cell.h * scale;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
    const manifest = {
      generator: 'sprite_studio', cellWidth: cell.w * scale, cellHeight: cell.h * scale, scale, columns: cols,
      anchor: { x: (cell.w / 2) * scale, y: cell.h * scale, note: 'bottom-centre of the cell is the ground point between the feet' },
      animation: { rows: {} }, frame_layout: { sheetWidth: c.width, sheetHeight: c.height, cellWidth: cell.w * scale, cellHeight: cell.h * scale, rows: {} },
    };
    let lost = 0;
    rows.forEach((r, ri) => {
      const rects = [];
      r.frames.forEach((f, fi) => {
        const cf = SS.cropFrame(f, cell.w, cell.h, cell.cx);
        lost += cf.lost;
        g.drawImage(SS.frameCanvas(cf, scale), fi * cell.w * scale, ri * cell.h * scale);
        rects.push({ x: fi * cell.w * scale, y: ri * cell.h * scale, w: cell.w * scale, h: cell.h * scale });
      });
      const ms = r.frames.map((f) => f.ms);
      manifest.animation.rows[r.name] = { row: ri, anim: r.anim, dir: r.dir, frames: r.frames.length, durations_ms: ms, fps: +(1000 / (ms.reduce((a, b) => a + b, 0) / ms.length)).toFixed(2), loop: r.loop };
      manifest.frame_layout.rows[r.name] = rects;
    });
    return { canvas: c, manifest, lost };
  };

  // ---------- OpenPose (COCO-18) skeleton ----------
  const OP_COLORS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85]];
  const OP_LIMBS = [[1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17]];
  // pts: 18 entries of [x, y] in cell pixels (or null)
  SS.drawOpenPose = (g, pts, ox, oy, s) => {
    g.save();
    g.lineCap = 'round';
    OP_LIMBS.forEach(([a, b], i) => {
      if (!pts[a] || !pts[b]) return;
      g.strokeStyle = `rgba(${OP_COLORS[i].join(',')},0.6)`; g.lineWidth = Math.max(2, s * 0.9);
      g.beginPath(); g.moveTo(ox + pts[a][0] * s, oy + pts[a][1] * s); g.lineTo(ox + pts[b][0] * s, oy + pts[b][1] * s); g.stroke();
    });
    pts.forEach((p, i) => {
      if (!p) return;
      g.fillStyle = `rgb(${OP_COLORS[i].join(',')})`;
      g.beginPath(); g.arc(ox + p[0] * s, oy + p[1] * s, Math.max(2, s * 0.55), 0, Math.PI * 2); g.fill();
    });
    g.restore();
  };

  // ---------- import ----------
  SS.loadImageFile = (file) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img); img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
  SS.imageData = (img) => {
    const c = document.createElement('canvas'); c.width = img.naturalWidth || img.width; c.height = img.naturalHeight || img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, c.width, c.height);
  };
  // cut one rectangle out of a sheet, dividing by `scale` (each block takes its most common colour)
  SS.cutFrame = (data, rx, ry, rw, rh, scale = 1, key = null, tol = 40) => {
    const W = Math.floor(rw / scale), H = Math.floor(rh / scale);
    const rgba = new Uint8ClampedArray(W * H * 4);
    const counts = new Map();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      counts.clear();
      let best = -1, bc = 0;
      for (let by = 0; by < scale; by++) for (let bx = 0; bx < scale; bx++) {
        const sx = rx + x * scale + bx, sy = ry + y * scale + by;
        if (sx >= data.width || sy >= data.height) continue;
        const i = (sy * data.width + sx) * 4;
        let r = data.data[i], gg = data.data[i + 1], b = data.data[i + 2], a = data.data[i + 3];
        if (key && Math.abs(r - key[0]) < tol && Math.abs(gg - key[1]) < tol && Math.abs(b - key[2]) < tol) a = 0;
        const v = a < 128 ? -1 : (r << 16) | (gg << 8) | b;
        const c = (counts.get(v) || 0) + 1;
        counts.set(v, c);
        if (c > bc) { bc = c; best = v; }
      }
      const o = (y * W + x) * 4;
      if (best >= 0) { rgba[o] = (best >> 16) & 255; rgba[o + 1] = (best >> 8) & 255; rgba[o + 2] = best & 255; rgba[o + 3] = 255; }
    }
    return { W, H, rgba };
  };
  // guess the cell size of a strip or grid without a manifest: figures are separated by clear
  // columns and rows, so count the runs and divide (falls back to square cells)
  SS.guessCells = (data, key) => {
    const W = data.width, H = data.height;
    const solid = (x, y) => {
      const i = (y * W + x) * 4, d = data.data;
      if (d[i + 3] < 128) return false;
      return !(key && Math.abs(d[i] - key[0]) < 40 && Math.abs(d[i + 1] - key[1]) < 40 && Math.abs(d[i + 2] - key[2]) < 40);
    };
    const runs = (n, filled) => { let c = 0, inRun = false; for (let i = 0; i < n; i++) { const f = filled(i); if (f && !inRun) c++; inRun = f; } return c; };
    const rowsN = runs(H, (y) => { for (let x = 0; x < W; x++) if (solid(x, y)) return true; return false; });
    const ch = rowsN > 0 && H % rowsN === 0 ? H / rowsN : H;
    const colsN = runs(W, (x) => { for (let y = 0; y < Math.min(H, ch); y++) if (solid(x, y)) return true; return false; });
    let cw = colsN > 0 && W % colsN === 0 ? W / colsN : (W % ch === 0 ? ch : ch);
    return { cw, ch, cols: colsN, rows: rowsN };
  };
  const empty = (f) => { for (let i = 3; i < f.rgba.length; i += 4) if (f.rgba[i]) return false; return true; };
  SS.isEmptyFrame = empty;
  // a grid of cells -> rows of frames (trailing empty cells dropped)
  SS.sliceGrid = (data, cw, ch, scale, key) => {
    const rows = [];
    for (let ry = 0; ry + ch <= data.height; ry += ch) {
      const frames = [];
      for (let rx = 0; rx + cw <= data.width; rx += cw) frames.push(SS.cutFrame(data, rx, ry, cw, ch, scale, key));
      while (frames.length && empty(frames[frames.length - 1])) frames.pop();
      if (frames.length) rows.push({ name: 'row ' + rows.length, frames });
    }
    return rows;
  };
  // a DEADFARM / sprite-gen atlas manifest (frame_layout.rows + animation.rows durations)
  SS.sliceAtlas = (data, man, scale, key) => {
    const layout = (man.frame_layout && man.frame_layout.rows) || {};
    const anim = (man.animation && man.animation.rows) || {};
    return Object.keys(layout).map((name) => {
      const frames = layout[name].map((r, i) => {
        const f = SS.cutFrame(data, r.x, r.y, r.w, r.h, scale, key);
        const d = anim[name] && anim[name].durations_ms;
        f.ms = d ? d[i] : 100;
        return f;
      });
      return { name, frames, loop: anim[name] ? anim[name].loop : true };
    });
  };
})(window.SS);
