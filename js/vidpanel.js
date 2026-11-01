// Video -> Sheet panel: anchor, Wan start image, frame recovery + per-frame pixel snap, curation,
// anchoring with nudges, packing, and code-driven part customisation (js/parts.js). The pipeline maths
// is in js/vidsheet.js; this file is only the UI around it.
(function (SS) {
  'use strict';
  const A = SS.app, VS = SS.VS, SP = SS.Parts || window.SpriteParts;
  const { S, h, section, toast, busy } = A;
  const $ = (s) => document.querySelector(s);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const fromImage = (im) => { const d = SS.imageData(im); return { W: d.width, H: d.height, rgba: new Uint8ClampedArray(d.data) }; };
  const fetchImage = (url) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error(url)); im.src = url; });
  const STORE = 'spriteStudio.video.v1';
  const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE) || 'null') || {}; } catch (e) { return {}; } })();

  // project files (the studio must be served from Desktop/AI, see README)
  const ANCHORS = [
    ['Sample: survivor, side (bundled)', 'samples/survivor_side.png'],
    ['Survivor, side (DEADFARM master drawing)', '../DEADFARM/art/sg/survivor8/drawings/side_R.png'],
    ['Survivor, 3/4 front', '../DEADFARM/art/sg/survivor8/drawings/front34.png'],
    ['Survivor, front', '../DEADFARM/art/sg/survivor8/drawings/front.png'],
    ['Survivor, 3/4 back', '../DEADFARM/art/sg/survivor8/drawings/back34.png'],
    ['Survivor, back', '../DEADFARM/art/sg/survivor8/drawings/back.png'],
    ['Farmer, side', '../DEADFARM/art/charpipe/chars/farmer/views/side_R.png'],
    ['Runner, side', '../DEADFARM/art/charpipe/chars/runner/views/side_R.png'],
  ];
  const CLIPS = [
    ['Sample: Wan 2.2 walk in place (bundled, 49 frames)', 'samples/walk/f_%05d.png', 49],
    ['Wan 2.2 walk in place, seed 7 (49 frames)', '../work/wan_sheet/raw_walk_s7/wansheet_7_%05d_.png', 49],
    ['Wan 2.2 jog in place, seed 11 (49 frames)', '../work/wan_sheet/raw_run_s11/wansheet_11_%05d_.png', 49],
    ['Wan 2.2 jog, seed 11, flow in-betweens (97 frames, 32 fps)', '../work/wan_sheet/raw_run_s11_x2/f_%05d.png', 97, 0, 32],
    ...['front34', 'front', 'back34', 'back'].flatMap((v) => [
      [`Wan 2.2 walk, ${v} (49 frames)`, `../work/wan_sheet/raw_${v}_walk/f_%05d.png`, 49, 0],
      [`Wan 2.2 jog, ${v}, flow in-betweens (97 frames, 32 fps)`, `../work/wan_sheet/raw_${v}_run_x2/f_%05d.png`, 97, 0, 32],
    ]),
  ];
  const HEADS = [
    ['farmer', '../DEADFARM/art/charpipe/chars/farmer/views/side_R.png'],
    ['runner', '../DEADFARM/art/charpipe/chars/runner/views/side_R.png'],
    ['shambler', '../DEADFARM/art/charpipe/chars/shambler/views/side_R.png'],
    ['boomer', '../DEADFARM/art/charpipe/chars/boomer/views/side_R.png'],
  ];
  const DEFAULT_CODE = [
    '// Runs on the packed frames. Edit, then Apply (Ctrl+Enter). Parts come from the colour table above.',
    '// api.recolor(part, "#hex")   api.hide(part)   api.only(...parts)   api.setPart("#hex", part)',
    '// api.swapHead(heads.NAME, { dx, dy, keepHair })   api.eachFrame((f, i, t) => { t.partAt(x, y), t.head })',
    '// Parts: ' + SP.PARTS.join(', '),
    'api.recolor("top", "#56663a");      // olive shirt',
    '// api.recolor("bottom", "#4a3626");  // brown trousers',
    '// api.recolor("hair", "#b8914a");    // fair hair',
    '// api.swapHead(heads.farmer);         // a head from another character',
  ].join('\n');

  const V = {
    anchor: null, raw: [], rec: [], name: saved.name || 'survivor_side_walk',
    start: 0, end: 0, nth: 1, skip: new Set(), nudge: {},
    o: Object.assign({ fps: 16, tol: 70, hue: true, scale: 'auto', track: true, palette: true, orphans: true, mode: 'head', vert: 'feet', stab: true, headLock: true, outline: true, stabThr: 14, cw: 32, ch: 64, ground: 0, ms: 62, exportScale: 1, wanScale: 8, wanW: 512, wanH: 640 }, saved.o || {}),
    parts: saved.parts || null, code: saved.code != null ? saved.code : DEFAULT_CODE, custom: !!saved.custom, heads: {},
    packed: [], shown: [], sel: [],
  };
  const persist = () => { try { localStorage.setItem(STORE, JSON.stringify({ o: V.o, parts: V.parts, code: V.code, custom: V.custom, name: V.name })); } catch (e) { /* private window */ } };

  // ---------- pipeline ----------
  function selection() {
    const out = [];
    for (let i = V.start; i < V.end; i += Math.max(1, V.nth)) if (!V.skip.has(i) && V.rec[i]) out.push(i);
    return out;
  }
  let codeErr = '';
  function rebuild(keep = true) {
    V.sel = selection();
    V.packed = VS.pack(V.sel.map((i) => V.rec[i].img), {
      cw: V.o.cw, ch: V.o.ch, mode: V.o.mode, ground: V.o.ground, msAll: V.o.ms, nudge: V.sel.map((i) => V.nudge[i]),
      lift: V.o.vert === 'video' && V.scaleUsed ? (() => { const L = VS.liftsFromVideo(V.rec.map((r) => r && r.box), V.scales || V.scaleUsed); return V.sel.map((i) => L[i]); })() : null,
    });
    if (V.o.stab && V.parts && V.packed.length > 1) {
      const P = SP.create(V.parts);
      V.packed = VS.stabiliseShading(V.packed, (f) => P.labels(f), { thr: +V.o.stabThr || 14 });
    }
    if (V.o.headLock && V.parts && V.anchor && V.packed.length) {
      // the face is 3-4 px: snapped from video it boils (eyes drop out, hair flips side to side), so
      // every frame takes the anchor drawing's own head, fitted to where the frame's head is
      const P = SP.create(V.parts), self = SP.cutHead(V.anchor.img, V.parts);
      if (self) V.packed = P.customise(V.packed, (api) => api.swapHead(self, { fit: true })).map((f, i) => Object.assign(f, { ms: V.packed[i].ms, lost: V.packed[i].lost, offset: V.packed[i].offset }));
    }
    if (V.o.outline && V.parts && V.anchor && V.packed.length) {
      const P = SP.create(V.parts);
      V.packed = VS.restoreOutline(V.packed, (f) => P.labels(f), VS.outlineColour(V.anchor.img));
    }
    V.shown = V.packed;
    codeErr = '';
    if (V.custom && V.parts && V.packed.length) {
      try {
        const fn = new Function('api', 'heads', V.code);
        V.shown = SP.create(V.parts).customise(V.packed, (api) => fn(api, V.heads));
      } catch (e) { codeErr = String(e.message || e); }
    }
    const err = $('#vsCodeErr'); if (err) err.textContent = codeErr;
    S.vimp = V.packed.length ? { rows: [{ name: `${V.name} · ${V.sel.length} frames (from ${V.sel.map((i) => i).join(',')})`, frames: V.shown }], row: 0, ms: V.o.ms } : null;
    if (S.mode === 'video') A.refresh(keep);
    drawThumbs(); drawInfo(); persist();
  }

  async function setAnchor(im, label) {
    const a = VS.snapAnchor(fromImage(im));
    V.anchor = a;
    if (!V.parts || V.parts.anchor !== label) V.parts = { anchor: label, colours: SP.guess(a.img) };
    drawAnchor(); buildParts(); persist();
    toast(`Anchor: ${a.width}×${a.height} px, ${a.palette.length} colours` + (a.step > 1 ? `, snapped from ${a.step.toFixed(2)} px blocks` : ''));
  }

  async function recoverAll() {
    if (!V.raw.length) { toast('Load a clip first'); return; }
    busy(true, 'Recovering frames…');
    await tick();
    try {
      const o = { tol: V.o.tol, hue: V.o.hue, orphans: V.o.orphans, palette: V.o.palette && V.anchor ? V.anchor.palette : null };
      // one block size for the whole clip: the median figure height over the anchor's height, so a
      // stride that shortens the figure for a few frames doesn't change the scale
      let scale = V.o.scale;
      const auto = scale === 'auto' || !scale;
      if (auto && !V.anchor) throw new Error('Load an anchor first, or set a block size');
      const heads = [];
      const boxes = auto ? V.raw.map((f) => { const k = VS.chromaKey(f, o).img, b = VS.figureBox(k); heads.push(b ? VS.headWidth(k, b) : 0); return b; }) : null;
      if (auto) { const hs = boxes.filter(Boolean).map((b) => b.h).sort((a, b) => a - b); scale = hs[hs.length >> 1] / V.anchor.height; }
      V.scaleUsed = +scale;
      // Track size: each frame gets its own block size, scaled by the head's width over about one
      // second of frames, so a figure drifting toward or away from the camera keeps the anchor's size
      V.scales = auto && V.o.track ? VS.blockSizes(boxes, V.anchor.height, Math.max(4, Math.round(V.o.fps / 2)), heads).map((s) => s || +scale) : null;
      V.rec = [];
      for (let i = 0; i < V.raw.length; i++) {
        V.rec.push(VS.recoverFrame(V.raw[i], Object.assign({ scale: V.scales ? V.scales[i] : +scale }, o)));
        if (i % 4 === 0) { $('#busyText').textContent = `Recovering + snapping ${i + 1}/${V.raw.length}…`; await tick(); }
      }
      V.end = V.rec.length; V.skip.clear(); V.nudge = {};
      // the clip's first frames are the still anchor easing into motion: try a few starts past them
      // (10 frames at 16 fps, 20 at 32) and keep the cleanest loop of at least 10 frames
      const frames = V.rec.map((r) => r && r.img);
      let best = null;
      for (let s = 2; s <= Math.min(Math.round(10 * V.o.fps / 16), frames.length - 12); s++) {
        const L = VS.findLoop(frames, s, 10);
        if (L.end > 0 && (!best || L.score < best.score - 0.01)) best = { start: s, end: L.end, diff: L.diff, score: L.score };
      }
      if (best) { V.start = best.start; V.end = best.end; } else V.start = 0;
      V.o.ms = Math.round(1000 / V.o.fps * V.nth);
      syncInputs();
    } catch (e) { toast(String(e.message || e)); }
    busy(false);
    rebuild(false);
  }

  function findLoop(quiet) {
    const frames = V.rec.map((r) => r && r.img);
    if (frames.length < 8) return;
    const s = Math.min(V.start, frames.length - 7);
    const L = VS.findLoop(frames, s, Math.min(8, frames.length - s - 1));
    if (L.end > 0) { V.start = s; V.end = L.end; if (!quiet) toast(`Loop: frames ${s}–${L.end - 1} (${L.end - s} frames), closes with ${(L.diff * 100).toFixed(0)}% difference`); }
    V.o.ms = Math.round(1000 / V.o.fps * V.nth);
    syncInputs();
  }

  async function loadClipFiles(files) {
    const vids = files.filter((f) => /^video\//.test(f.type));
    const imgs = files.filter((f) => /^image\//.test(f.type)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    busy(true, 'Reading frames…');
    try {
      if (vids.length) V.raw = await decodeVideo(vids[0]);
      else { V.raw = []; for (const f of imgs) V.raw.push(fromImage(await SS.loadImageFile(f))); }
      V.clipName = (vids[0] || imgs[0] || {}).name || 'clip';
    } catch (e) { toast('Could not read: ' + e.message); }
    busy(false);
    drawInfo();
    await recoverAll();
  }
  async function decodeVideo(file) {
    const v = document.createElement('video');
    v.muted = true; v.src = URL.createObjectURL(file);
    await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error('unsupported video')); });
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    const out = [];
    for (let t = 0; t < v.duration - 1e-3; t += 1 / V.o.fps) {
      v.currentTime = t;
      await new Promise((r) => { v.onseeked = r; });
      g.drawImage(v, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height);
      out.push({ W: d.width, H: d.height, rgba: new Uint8ClampedArray(d.data) });
      $('#busyText').textContent = `Decoding frame ${out.length}…`;
    }
    return out;
  }

  // ---------- exports ----------
  const scaleUp = (f, s) => { if (s === 1) return f; const o = VS.img(f.W * s, f.H * s); for (let y = 0; y < o.H; y++) for (let x = 0; x < o.W; x++) o.rgba.set(f.rgba.subarray((((y / s) | 0) * f.W + ((x / s) | 0)) * 4, (((y / s) | 0) * f.W + ((x / s) | 0)) * 4 + 4), (y * o.W + x) * 4); o.ms = f.ms; return o; };
  async function exportZip() {
    if (!V.packed.length) { toast('Nothing packed yet'); return; }
    const s = +V.o.exportScale || 1, cell = { w: V.o.cw, h: V.o.ch, cx: V.o.cw / 2 };
    const files = [];
    const sheet = async (frames, name) => {
      const { canvas, manifest } = SS.buildSheet([{ name: V.name, anim: V.name, dir: 'E', frames, loop: true }], cell, s);
      manifest.anchor = { x: (V.o.cw / 2) * s, y: (V.o.ch - V.o.ground) * s, note: 'pivot: bottom-centre of the cell, the ground point under the figure' };
      manifest.source = { clip: V.clipName, frames: V.sel, blockSize: V.scales ? V.sel.map((i) => +V.scales[i].toFixed(3)) : V.scaleUsed, anchor: V.parts && V.parts.anchor, method: 'chroma key + figure box, Pixel Snapper uniform grid' + (V.scales ? ' at a per-frame block size (head width in the video: tracks size drift)' : ' at the clip block size') + ', anchor palette lock, feet + head anchoring' };
      files.push({ name: name + '.png', data: await SS.canvasBytes(canvas) }, { name: name + '.json', data: JSON.stringify(manifest, null, 1) });
    };
    await sheet(V.packed, V.name);
    if (V.parts) {
      const P = SP.create(V.parts);
      files.push({ name: V.name + '.parts.json', data: JSON.stringify(P.toJSON({ cell: { w: V.o.cw, h: V.o.ch }, pivot: { x: V.o.cw / 2, y: V.o.ch - V.o.ground }, headTrack: V.packed.map((f) => P.headBox(f)) }), null, 1) });
      const per = {};
      V.packed.forEach((f) => { const L = P.layers(f); SP.PARTS.forEach((p) => { (per[p] = per[p] || []).push(L[p] || VS.img(f.W, f.H)); }); });
      for (const p of SP.PARTS) if (per[p].some((f) => !SS.isEmptyFrame(f))) await sheet(per[p].map((f, i) => Object.assign(f, { ms: V.packed[i].ms })), `layers/${V.name}.${p}`);
      if (V.custom && !codeErr && V.shown !== V.packed) { await sheet(V.shown, V.name + '.custom'); files.push({ name: V.name + '.custom.js', data: V.code }); }
    }
    const strip = [];
    V.packed.forEach((f) => strip.push(f));
    files.push({ name: V.name + '.gif', data: new Uint8Array(await SS.encodeGIF(V.shown.map((f) => scaleUp(f, 4))).arrayBuffer()) });
    SS.download(SS.zip(files), V.name + '.zip');
    toast(`Exported ${files.length} files`);
  }
  async function exportWanStart() {
    if (!V.anchor) { toast('Load an anchor first'); return; }
    const out = VS.wanStart(V.anchor.img, { scale: +V.o.wanScale, W: +V.o.wanW, H: +V.o.wanH });
    const c = SS.frameCanvas(out, 1);
    SS.download(new Blob([await SS.canvasBytes(c)], { type: 'image/png' }), `${V.name}_wan_start.png`);
  }
  const WAN_PROMPT = 'Pixel art game sprite, side view. The same man walks in place on the spot with a steady, natural walking cycle: legs stride alternately, arms swing opposite to the legs, slight body bob. He stays centered in the frame and does not move across the screen. Static camera, flat solid green background, crisp blocky pixel art, same outfit and colors throughout.';

  // ---------- UI ----------
  const num = (k, attrs = {}) => { const e = h('input', Object.assign({ type: 'number', value: V.o[k] }, attrs)); e.addEventListener('change', () => { V.o[k] = e.value === '' ? '' : +e.value; persist(); if (attrs.re) rebuild(); }); e.dataset.k = k; return e; };
  const chk = (k, label, re) => { const e = h('input', { type: 'checkbox' }); e.checked = !!V.o[k]; e.addEventListener('change', () => { V.o[k] = e.checked; persist(); if (re) rebuild(); }); e.dataset.k = k; return h('label', { class: 'check' }, [e, label]); };
  const row = (label, el, tail) => h('div', { class: 'row' }, [h('label', { text: label }), el, tail || h('span')]);
  function syncInputs() {
    document.querySelectorAll('#videoPanel [data-k]').forEach((e) => { if (e.type === 'checkbox') e.checked = !!V.o[e.dataset.k]; else e.value = V.o[e.dataset.k]; });
    const st = $('#vsStart'), en = $('#vsEnd'), nth = $('#vsNth');
    if (st) { st.value = V.start; en.value = V.end; nth.value = V.nth; }
  }

  function build() {
    const p = $('#videoPanel'); p.innerHTML = '';
    // 1 anchor
    const aFile = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    aFile.addEventListener('change', async () => { const f = aFile.files[0]; if (f) await setAnchor(await SS.loadImageFile(f), f.name); });
    const aSel = h('select', {}, [h('option', { value: '', text: 'Project anchors…' }), ...ANCHORS.map((a, i) => h('option', { value: i, text: a[0] }))]);
    aSel.addEventListener('change', async () => { const a = ANCHORS[+aSel.value]; aSel.value = ''; if (!a) return; try { await setAnchor(await fetchImage(a[1]), a[1]); } catch (e) { toast('Serve Desktop/AI to open project files (see README)'); } });
    const prompt = h('textarea', { rows: 4, style: 'width:100%;font:11px var(--mono);background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:5px', text: WAN_PROMPT });
    p.append(section('1 · Anchor (master pixel art)', [
      aSel, h('div', { class: 'btns' }, [h('button', { text: 'Load image…', onclick: () => aFile.click() })]), aFile,
      h('canvas', { id: 'vsAnchor', style: 'image-rendering:pixelated;background:#6b6b6b;border-radius:4px;max-width:100%' }),
      h('div', { class: 'note', id: 'vsAnchorInfo', text: 'A 1x drawing is used as is. A large AI image is keyed, cut to the figure and pixel-snapped (Pixel Snapper) to true pixels. Its palette locks every video frame.' }),
      h('div', { class: 'note', text: 'Wan start image: the anchor scaled up with nearest neighbour on flat green, sized for Wan (multiples of 16).' }),
      row('Block · W × H', h('div', { class: 'btns' }, [num('wanScale', { min: 2, max: 16, style: 'width:44px' }), num('wanW', { step: 16, style: 'width:56px' }), num('wanH', { step: 16, style: 'width:56px' })])),
      h('div', { class: 'btns' }, [h('button', { text: 'Wan start PNG', onclick: exportWanStart }), h('button', { text: 'Copy prompt', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(prompt.value); toast('Prompt copied'); } })]),
      prompt,
      h('div', { class: 'note', text: 'Local run: tools/wan_gen.py (Wan 2.2 I2V A14B Q8 in ComfyUI, 512×640, 49 frames, about 4 min on an RTX 5070).' }),
    ], true));

    // 2 frames
    const cFile = h('input', { type: 'file', accept: 'video/*,image/*', multiple: true, class: 'hidden' });
    cFile.addEventListener('change', () => loadClipFiles([...cFile.files]));
    const drop = h('div', { class: 'drop', text: 'Drop a Wan clip (MP4/WebM) or its PNG frames here, or click to choose.' });
    drop.addEventListener('click', () => cFile.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('hot'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('hot'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('hot'); loadClipFiles([...e.dataTransfer.files]); });
    const cSel = h('select', {}, [h('option', { value: '', text: 'Project clips…' }), ...CLIPS.map((c, i) => h('option', { value: i, text: c[0] }))]);
    cSel.addEventListener('change', async () => {
      const c = CLIPS[+cSel.value]; cSel.value = ''; if (!c) return;
      busy(true, 'Loading frames…');
      try {
        V.raw = [];
        V.o.fps = c[4] || 16;
        for (let i = c[3] != null ? c[3] : 1; i < (c[3] != null ? c[3] : 1) + c[2]; i++) V.raw.push(fromImage(await fetchImage(c[1].replace('%05d', String(i).padStart(5, '0')))));
        V.clipName = c[1].split('/').slice(-2, -1)[0];
        V.name = /^samples\//.test(c[1]) ? 'sample_walk' : 'survivor_' + ((c[1].match(/raw_(front34|front|back34|back)_/) || [])[1] || 'side') + '_' + (/run/.test(c[1]) ? 'run' : 'walk'); $('#vsName').value = V.name;
      } catch (e) { busy(false); toast('Could not open it: serve Desktop/AI (see README)'); return; }
      busy(false);
      await recoverAll();
    });
    const scale = h('input', { type: 'text', value: V.o.scale, style: 'width:64px', title: 'auto = median figure height / anchor height' });
    scale.addEventListener('change', () => { V.o.scale = scale.value.trim() || 'auto'; persist(); });
    p.append(section('2 · Recover + snap frames', [
      cSel, drop, cFile,
      row('Video fps', num('fps', { min: 1, max: 60 })),
      row('Key tolerance', num('tol', { min: 5, max: 200 })),
      chk('hue', 'Key the background hue too (green fringe)'),
      row('Block size', scale, h('span', { class: 'note', text: 'px' })),
      chk('palette', 'Lock to the anchor palette'),
      chk('track', 'Track size drift (block size per frame)'),
      chk('orphans', 'Clean lone pixels and pinholes'),
      h('button', { class: 'primary', text: 'Recover + snap', onclick: recoverAll }),
      h('div', { class: 'note', text: 'Each frame: key the background, keep the figure\'s own blob(s) by bounding box (never a grid crop), then snap it on a rigid grid at one block size for the whole clip, colours locked to the anchor. That stops mixels coming back and keeps the size fixed.' }),
    ], true));

    // 3 curate
    const st = h('input', { type: 'number', id: 'vsStart', min: 0, value: V.start, style: 'width:52px' }), en = h('input', { type: 'number', id: 'vsEnd', min: 1, value: V.end, style: 'width:52px' });
    const nth = h('select', { id: 'vsNth' }, [1, 2, 3, 4].map((n) => h('option', { value: n, text: n === 1 ? 'every frame' : `every ${n}th` })));
    st.addEventListener('change', () => { V.start = Math.max(0, +st.value); rebuild(false); });
    en.addEventListener('change', () => { V.end = Math.min(V.rec.length, +en.value); rebuild(false); });
    nth.addEventListener('change', () => { V.nth = +nth.value; V.o.ms = Math.round(1000 / V.o.fps * V.nth); syncInputs(); rebuild(false); });
    p.append(section('3 · Curate', [
      h('div', { class: 'btns' }, [h('span', { class: 'note', text: 'from' }), st, h('span', { class: 'note', text: 'to (excl.)' }), en, nth]),
      h('div', { class: 'btns' }, [h('button', { text: 'Find loop from start', onclick: () => { findLoop(); rebuild(false); } }), h('button', { text: 'All frames', onclick: () => { V.start = 0; V.end = V.rec.length; V.skip.clear(); syncInputs(); rebuild(false); } })]),
      h('div', { id: 'vsThumbs', style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(34px,1fr));gap:3px' }),
      h('div', { class: 'note', text: 'Click a thumbnail to drop or keep that frame. Find loop looks for the later frame that best matches the start in shape and shading (the near and far legs differ in shade, so it finds the full stride, not the half).' }),
    ], true));

    // 4 anchor frames
    const mode = h('select', {}, [['head', 'Feet + head matched to frame 1'], ['torso', 'Feet + torso centre'], ['bbox', 'Feet + box centre']].map(([v, t]) => h('option', { value: v, text: t })));
    mode.value = V.o.mode;
    mode.addEventListener('change', () => { V.o.mode = mode.value; rebuild(); });
    const nudge = (dx, dy) => { const i = V.sel[S.cur]; if (i == null) return; const n = V.nudge[i] || { dx: 0, dy: 0 }; V.nudge[i] = { dx: n.dx + dx, dy: n.dy + dy }; rebuild(); };
    const vert = h('select', {}, [['feet', 'Feet on the ground row'], ['video', 'Height from the video (runs, jumps)']].map(([v, t]) => h('option', { value: v, text: t })));
    vert.value = V.o.vert;
    vert.addEventListener('change', () => { V.o.vert = vert.value; rebuild(); });
    p.append(section('4 · Anchor frames', [
      mode, vert,
      chk('stab', 'Stabilise shading (stop the boil)', true),
      chk('headLock', 'Lock the head to the anchor drawing', true),
      chk('outline', 'Restore the outline on hands, legs and shoes', true),
      row('Strength', num('stabThr', { min: 0, max: 60, re: true }), h('span', { class: 'note', text: 'ΔE' })), row('Ground margin', num('ground', { min: 0, max: 16, re: true }), h('span', { class: 'note', text: 'rows' })),
      h('div', { class: 'btns' }, [h('span', { class: 'note', text: 'Nudge frame' }), h('button', { text: '←', onclick: () => nudge(-1, 0) }), h('button', { text: '→', onclick: () => nudge(1, 0) }), h('button', { text: '↑', onclick: () => nudge(0, -1) }), h('button', { text: '↓', onclick: () => nudge(0, 1) }),
        h('button', { text: 'Reset', onclick: () => { V.nudge = {}; rebuild(); } })]),
      h('div', { class: 'note', text: 'Feet go on the ground row; x comes from the head, which barely moves in a walk, matched to the first frame. Turn on Onion (O) and nudge any frame with Shift + arrow keys. Stabilise shading lines each part up with the previous frame and keeps its colour wherever the part matches and the new colour is within the strength (Lab ΔE); bigger shading changes still come through.' }),
    ], true));

    // 5 pack + export
    const name = h('input', { type: 'text', id: 'vsName', value: V.name, style: 'width:100%' });
    name.addEventListener('change', () => { V.name = name.value.trim() || 'sprite'; rebuild(); });
    const es = h('select', {}, [1, 2, 4, 8].map((s) => h('option', { value: s, text: s + 'x' })));
    es.value = V.o.exportScale; es.addEventListener('change', () => { V.o.exportScale = +es.value; persist(); });
    p.append(section('5 · Normalise + pack', [
      row('Name', name),
      row('Cell w × h', h('div', { class: 'btns' }, [num('cw', { min: 8, re: true, style: 'width:52px' }), num('ch', { min: 8, re: true, style: 'width:52px' })])),
      row('Frame ms', num('ms', { min: 10, step: 1, re: true })),
      row('Export scale', es),
      h('button', { class: 'primary', text: 'Export sheet (.zip)', onclick: exportZip }),
      h('div', { class: 'note', text: 'Zip: sheet PNG + atlas JSON (pivot, durations, source), parts.json (colour → part, head box per frame), one layer sheet per part, the customised sheet and its script, and a 4x GIF.' }),
      h('div', { class: 'note', id: 'vsInfo' }),
    ], true));

    // 6 parts + code
    p.append(section('6 · Parts + code', [
      h('div', { id: 'vsParts', style: 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:3px 8px' }),
      h('div', { class: 'btns' }, [h('button', { text: 'Re-guess parts', onclick: () => { if (V.anchor) { V.parts.colours = SP.guess(V.anchor.img); buildParts(); rebuild(); } } }), h('button', { text: 'Show one part…', onclick: showPart })]),
      chk('_custom', 'Preview the customised frames'),
      h('textarea', { id: 'vsCode', rows: 11, spellcheck: false, style: 'width:100%;font:11px/1.45 var(--mono);background:#0d0e10;color:var(--text);border:1px solid var(--line);border-radius:5px;padding:6px' }),
      h('div', { id: 'vsCodeErr', style: 'color:var(--bad);font:11px var(--mono)' }),
      h('div', { class: 'btns' }, [h('button', { class: 'primary', text: 'Apply', onclick: applyCode }), h('button', { text: 'Reset script', onclick: () => { $('#vsCode').value = DEFAULT_CODE; applyCode(); } })]),
      h('div', { class: 'btns', id: 'vsHeads' }),
      h('div', { class: 'note', text: 'The same API ships as js/parts.js for the game: SpriteParts.create(parts.json).customise(frames, api => …) recolours, hides and swaps heads at runtime on any frame of the sheet.' }),
    ], true));
    const code = $('#vsCode'); code.value = V.code;
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applyCode(); } e.stopPropagation(); });
    const cc = p.querySelector('[data-k=_custom]'); cc.checked = V.custom;
    cc.addEventListener('change', () => { V.custom = cc.checked; rebuild(); });
    buildHeads();
    drawAnchor(); buildParts(); drawThumbs(); drawInfo();
  }

  function applyCode() { V.code = $('#vsCode').value; V.custom = true; const cc = document.querySelector('#videoPanel [data-k=_custom]'); if (cc) cc.checked = true; rebuild(); if (!codeErr) toast('Applied'); }
  function showPart() {
    const part = prompt('Show only which part? (' + SP.PARTS.join(', ') + ')', 'top');
    if (!part) return;
    $('#vsCode').value = `api.only(${part.split(',').map((x) => JSON.stringify(x.trim())).join(', ')});`;
    applyCode();
  }
  function buildHeads() {
    const box = $('#vsHeads'); if (!box) return; box.innerHTML = '';
    box.append(h('span', { class: 'note', text: 'Heads:' }));
    HEADS.forEach(([n, url]) => box.append(h('button', { text: (V.heads[n] ? '✓ ' : '') + n, title: 'Cut the head from ' + url, onclick: async () => {
      try {
        const f = fromImage(await fetchImage(url)), hd = SP.cutHead(f, { colours: SP.guess(f) });
        if (!hd) throw new Error('no head');
        V.heads[n] = hd; buildHeads(); toast(`heads.${n} ready (${hd.W}×${hd.H}); use api.swapHead(heads.${n})`);
      } catch (e) { toast('Serve Desktop/AI to open project files'); }
    } })));
    const hf = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    hf.addEventListener('change', async () => {
      const f = hf.files[0]; if (!f) return;
      const one = VS.snapAnchor(fromImage(await SS.loadImageFile(f))).img, n = f.name.replace(/\.\w+$/, '').replace(/\W+/g, '_');
      V.heads[n] = one.H > 20 ? SP.cutHead(one, { colours: SP.guess(one) }) : one;
      buildHeads(); toast(`heads.${n} ready`);
    });
    box.append(hf, h('button', { text: 'Load head PNG…', onclick: () => hf.click() }));
  }
  function buildParts() {
    const box = $('#vsParts'); if (!box) return; box.innerHTML = '';
    if (!V.parts) { box.append(h('div', { class: 'note', text: 'Load an anchor to map its colours to parts.' })); return; }
    const entries = Object.entries(V.parts.colours).sort((a, b) => SP.PARTS.indexOf(a[1]) - SP.PARTS.indexOf(b[1]) || a[0].localeCompare(b[0]));
    for (const [c, part] of entries) {
      const sel = h('select', { style: 'flex:1;min-width:0;font-size:11px;padding:1px 2px' }, SP.PARTS.map((x) => h('option', { value: x, text: x })));
      sel.value = part;
      sel.addEventListener('change', () => { V.parts.colours[c] = sel.value; rebuild(); });
      box.append(h('div', { style: 'display:flex;gap:4px;align-items:center' }, [h('i', { title: c, style: `width:14px;height:14px;flex:none;border:1px solid #000;background:${c}` }), sel]));
    }
  }
  function drawAnchor() {
    const c = $('#vsAnchor'); if (!c) return;
    if (!V.anchor) { c.width = 0; c.height = 0; return; }
    const a = V.anchor.img, s = 3;
    c.width = Math.max(a.W * s + 16, 60); c.height = a.H * s + 8;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
    g.fillStyle = '#6b6b6b'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(SS.frameCanvas(a, s), (c.width - a.W * s) / 2, 4);
    $('#vsAnchorInfo').textContent = `${V.parts ? V.parts.anchor.split('/').pop() : ''}: ${a.W}×${a.H} px, ${V.anchor.palette.length} colours` + (V.anchor.step > 1 ? `, snapped from ${V.anchor.step.toFixed(2)} px blocks` : ', used as 1x');
  }
  function drawThumbs() {
    const box = $('#vsThumbs'); if (!box) return; box.innerHTML = '';
    const sel = new Set(V.sel);
    V.rec.forEach((r, i) => {
      if (!r) return;
      const f = r.img, c = SS.frameCanvas(f, 1);
      const inRange = i >= V.start && i < V.end;
      const cell = h('div', { title: `frame ${i}${V.skip.has(i) ? ' (dropped)' : ''}`, style: `cursor:pointer;background:${sel.has(i) ? '#2a1d16' : 'var(--panel2)'};border:1px solid ${sel.has(i) ? 'var(--accent)' : 'var(--line)'};border-radius:3px;padding:2px;opacity:${inRange && !V.skip.has(i) ? 1 : 0.35};text-align:center` }, [
        Object.assign(c, { style: 'image-rendering:pixelated;width:100%;height:42px;object-fit:contain;display:block' }),
        h('div', { style: 'font:9px var(--mono);color:var(--dim)', text: i }),
      ]);
      cell.addEventListener('click', () => { if (V.skip.has(i)) V.skip.delete(i); else V.skip.add(i); rebuild(false); });
      box.append(cell);
    });
  }
  function drawInfo() {
    const e = $('#vsInfo'); if (!e) return;
    const lost = V.packed.reduce((a, f) => a + (f.lost || 0), 0);
    e.textContent = V.rec.length ? `${V.rec.length} frames recovered at ${V.scales ? Math.min(...V.scales).toFixed(2) + '–' + Math.max(...V.scales).toFixed(2) : (V.scaleUsed || 0).toFixed(2)} px per pixel · ${V.sel.length} in the cycle · ${V.sel.length * V.o.ms} ms` + (lost ? ` · ${lost} px fell outside the cell: widen it` : '') : (V.raw.length ? `${V.raw.length} frames loaded` : 'No clip loaded.');
  }

  // Shift + arrows nudge the current frame (plain arrows still step)
  document.addEventListener('keydown', (e) => {
    if (S.mode !== 'video' || !e.shiftKey || !/^Arrow/.test(e.key) || e.target.matches('input, textarea, select')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    const i = V.sel[S.cur]; if (i == null) return;
    const n = V.nudge[i] || { dx: 0, dy: 0 }; V.nudge[i] = { dx: n.dx + d[0], dy: n.dy + d[1] };
    S.playing = false; rebuild();
  }, true);

  build();
  SS.video = { V, rebuild, recoverAll, setAnchor, findLoop, exportZip, fetchImage, fromImage };
})(window.SS);
